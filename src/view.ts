import { type App, ItemView, MarkdownRenderer, Modal, setIcon, type WorkspaceLeaf } from "obsidian";
import { LcNotice as Notice } from "./report-modal";
import type { TranscriptSegment } from "./core/audio/pipeline";
import { formatTimestamp, SECTION_MY_NOTES, toISODate } from "./core/notes";
import { MARK_LABELS } from "./core/transcript";
import { decodeAudioFile } from "./recorder";
import type LectureCompanionPlugin from "./main";
import type { ServerState } from "./core/whisper/server";
import { locateWhisperServer } from "./core/whisper/locate";
import { nodeLocateDeps } from "./node/deps";
import { t } from "./i18n";

export const VIEW_TYPE = "lecture-companion-view";

export class LectureView extends ItemView {
	private courseInput!: HTMLInputElement;
	private courseList!: HTMLDataListElement;
	private dateInput!: HTMLInputElement;
	private meetingBox!: HTMLInputElement;
	/** The user ticked or unticked the Meeting box themselves, so typing no longer resets it. */
	private meetingTouched = false;
	private recordBtn!: HTMLButtonElement;
	private pauseBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private newBtn!: HTMLButtonElement;
	private fileBtn!: HTMLButtonElement;
	private pasteBtn!: HTMLButtonElement;
	private noteBtn!: HTMLButtonElement;
	private urlBtn!: HTMLButtonElement;
	private pullBtn!: HTMLButtonElement;
	private setupHint!: HTMLElement;
	private importantBtn!: HTMLButtonElement;
	private confusingBtn!: HTMLButtonElement;
	private catchUpBtn!: HTMLButtonElement;
	private catchUpEl!: HTMLElement;
	private catchUpBody!: HTMLElement;
	private catchUpAbort?: AbortController;
	private catchUpText = "";
	private renderedMarks = 0;
	private fileInput!: HTMLInputElement;
	private serverPill!: HTMLElement;
	private levelMeter!: HTMLProgressElement;
	private progressBar!: HTMLProgressElement;
	private progressText!: HTMLElement;
	private statusText!: HTMLElement;
	private errorEl!: HTMLElement;
	private transcriptEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private unsubscribe: (() => void)[] = [];
	private renderedSegments = 0;
	private summaryStreaming = "";

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LectureCompanionPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Lecture Companion";
	}

	getIcon(): string {
		return "mic";
	}

	onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("lc-root");

		// Toolbar
		const bar = root.createDiv({ cls: "lc-toolbar" });
		this.courseInput = bar.createEl("input", { cls: "lc-course", attr: { list: "lc-course-list", placeholder: t("panel.coursePlaceholder"), spellcheck: "false", "aria-label": t("panel.courseLabel") } });
		this.courseList = bar.createEl("datalist", { attr: { id: "lc-course-list" } });
		this.dateInput = bar.createEl("input", { cls: "lc-date", type: "date", attr: { "aria-label": t("panel.dateLabel") } });
		this.dateInput.value = toISODate();
		const meetingLabel = bar.createEl("label", { cls: "lc-meeting", attr: { "aria-label": t("panel.meetingHint") } });
		this.meetingBox = meetingLabel.createEl("input", { type: "checkbox" });
		meetingLabel.appendText(t("panel.meeting"));
		this.courseInput.addEventListener("input", () => this.syncMeeting());
		this.meetingBox.addEventListener("change", () => {
			this.meetingTouched = true;
			this.syncMeeting();
		});

		const buttons = bar.createDiv({ cls: "lc-buttons", attr: { role: "toolbar", "aria-label": t("panel.title") } });
		this.recordBtn = iconButton(buttons, "mic", t("panel.record"), () => void this.startRecording());
		this.recordBtn.addClass("mod-cta");
		this.pauseBtn = iconButton(buttons, "pause", t("panel.pause"), () => this.togglePause());
		this.stopBtn = iconButton(buttons, "square", t("panel.stop"), () => void this.stopRecording());
		this.importantBtn = iconButton(buttons, "star", t("panel.important"), () => this.plugin.markMoment("important"));
		this.confusingBtn = iconButton(buttons, "help-circle", t("panel.confusing"), () => this.plugin.markMoment("confusing"));
		this.catchUpBtn = iconButton(buttons, "history", t("panel.catchUp"), () => void this.catchUp());
		this.newBtn = iconButton(buttons, "file-plus", t("panel.new"), () => this.newRecording());
		this.fileInput = root.createEl("input", { type: "file", cls: "lc-file-input", attr: { accept: "audio/*,video/*,.webm,.m4a,.mp3,.wav,.ogg,.opus,.flac,.aac,.mp4" } });
		this.fileInput.addEventListener("change", () => void this.transcribeChosenFile());
		this.fileBtn = iconButton(buttons, "file-audio", t("panel.file"), () => this.pickAudioFile());
		this.urlBtn = iconButton(buttons, "link", t("panel.url"), () => this.pickUrl());
		this.pasteBtn = iconButton(buttons, "clipboard-paste", t("panel.paste"), () => void this.pasteNotes());
		this.noteBtn = iconButton(buttons, "file-input", t("panel.importNote"), () => void this.plugin.importActiveNote());
		this.pullBtn = iconButton(buttons, "download", t("panel.pull"), () => void this.pullSlides());
		iconButton(buttons, "sparkles", t("panel.summarize"), () => void this.summarize());
		iconButton(buttons, "file-text", t("panel.openNote"), () => void this.openNote());
		iconButton(buttons, "message-circle", t("panel.ask"), () => this.askAboutLecture());

		// Status
		const status = root.createDiv({ cls: "lc-status" });
		this.serverPill = status.createSpan({ cls: "lc-pill" });
		this.statusText = status.createSpan({ cls: "lc-status-text" });
		const meterRow = root.createDiv({ cls: "lc-meter-row" });
		meterRow.createSpan({ text: t("panel.audio"), cls: "lc-label" });
		this.levelMeter = meterRow.createEl("progress", { cls: "lc-level", attr: { max: "1", value: "0", "aria-label": t("panel.audioLevel") } });
		const progressRow = root.createDiv({ cls: "lc-progress-row" });
		this.progressBar = progressRow.createEl("progress", { cls: "lc-progress", attr: { max: "1", value: "0", "aria-label": t("panel.progress") } });
		this.progressText = progressRow.createSpan({ cls: "lc-progress-text", attr: { "aria-live": "polite" } });
		this.errorEl = root.createDiv({ cls: "lc-error", attr: { role: "alert" } });
		this.setupHint = root.createDiv({ cls: "lc-setup-hint is-hidden" });
		this.setupHint.createSpan({ text: t("panel.setupHint") });
		const hintButtons = this.setupHint.createDiv({ cls: "lc-buttons" });
		hintButtons.createEl("button", { text: t("panel.setupButton"), cls: "mod-cta" }).addEventListener("click", () => this.plugin.openSetup());
		hintButtons.createEl("button", { text: t("setup.trySample") }).addEventListener("click", () => void this.plugin.createSample());
		void this.checkSetup();

		// Catch-up box (hidden until used)
		this.catchUpEl = root.createDiv({ cls: "lc-catchup is-hidden" });
		const catchUpHead = this.catchUpEl.createDiv({ cls: "lc-catchup-head" });
		catchUpHead.createSpan({ text: t("panel.catchUpTitle"), cls: "lc-label" });
		const catchUpActions = catchUpHead.createDiv({ cls: "lc-buttons" });
		iconButton(catchUpActions, "file-plus-2", t("panel.catchUpAdd"), () => void this.addCatchUpToNotes());
		iconButton(catchUpActions, "x", t("panel.close"), () => this.closeCatchUp());
		this.catchUpBody = this.catchUpEl.createDiv({ cls: "lc-catchup-body markdown-rendered", attr: { "aria-live": "polite" } });

		// Transcript + summary
		const body = root.createDiv({ cls: "lc-body" });
		body.createEl("h5", { text: t("panel.transcript"), cls: "lc-heading" });
		this.transcriptEl = body.createDiv({ cls: "lc-transcript", attr: { role: "log", "aria-label": t("panel.transcript"), tabindex: "0" } });
		body.createEl("h5", { text: t("panel.summary"), cls: "lc-heading" });
		this.summaryEl = body.createDiv({ cls: "lc-summary markdown-rendered", attr: { "aria-label": t("panel.summary"), tabindex: "0" } });

		const session = this.plugin.session;
		this.unsubscribe.push(
			session.subscribe(() => {
				this.render();
				this.appendMarks();
			}),
			session.onSegments((segs) => this.appendSegments(segs)),
			session.onSummaryDelta((delta) => this.appendSummary(delta)),
			this.plugin.onServerState(() => this.render()),
		);
		this.refreshCourses();
		this.rebuildTranscript();
		this.render();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		for (const u of this.unsubscribe) u();
		this.unsubscribe = [];
		return Promise.resolve();
	}

	/** Pre-fills the course picker (used by commands). */
	setCourse(course: string): void {
		this.courseInput.value = course;
	}

	refreshCourses(): void {
		this.courseList.empty();
		for (const name of this.plugin.courseNames()) this.courseList.createEl("option", { attr: { value: name } });
		if (!this.courseInput.value && this.plugin.session.course) this.courseInput.value = this.plugin.session.course;
		this.syncMeeting();
	}

	/** A name already known as a meeting ticks (and locks) the box; otherwise it follows the user's choice. */
	private syncMeeting(): void {
		const known = this.plugin.isMeeting(this.courseInput.value);
		if (known) this.meetingBox.checked = true;
		else if (!this.meetingTouched) this.meetingBox.checked = false;
		this.meetingBox.disabled = known || this.plugin.session.isLive;
	}

	/** Records a ticked Meeting box in settings before the note is created. */
	private async applyMeeting(course: string): Promise<void> {
		if (this.meetingBox.checked) await this.plugin.markMeeting(course);
	}

	private async startRecording(): Promise<void> {
		const session = this.plugin.session;
		if (session.isBusy) return;
		const course = this.courseInput.value.trim();
		if (!course) {
			new Notice("Type or choose a course first.");
			this.courseInput.focus();
			return;
		}
		this.rebuildTranscript();
		try {
			await this.applyMeeting(course);
			await session.start(course, this.dateInput.value || toISODate());
		} catch (err) {
			new Notice(`Could not start: ${(err as Error).message}`, 8000);
		}
	}

	/** Fills in the course and date and starts recording (the class-time prompt's Record button). */
	async recordFor(course: string, date: string): Promise<void> {
		if (this.plugin.session.isBusy) return;
		if (this.plugin.session.status === "done" || this.plugin.session.status === "error") this.plugin.session.reset();
		this.courseInput.value = course;
		this.dateInput.value = date;
		this.meetingTouched = false;
		this.syncMeeting();
		await this.startRecording();
	}

	/** "Catch me up": streams a short summary of the last N minutes into the panel. */
	async catchUp(): Promise<void> {
		const session = this.plugin.session;
		if (session.status !== "recording" && session.status !== "paused") {
			new Notice("Catch-up works while recording.");
			return;
		}
		this.catchUpAbort?.abort();
		const abort = new AbortController();
		this.catchUpAbort = abort;
		const minutes = Math.max(1, this.plugin.settings.catchUpMinutes);
		this.catchUpText = "";
		this.catchUpEl.removeClass("is-hidden");
		this.catchUpBody.setText(`Summarizing the last ${minutes} min…`);
		try {
			let streamed = "";
			const text = await session.catchUp(
				minutes,
				(delta) => {
					streamed += delta;
					this.catchUpBody.setText(streamed);
				},
				abort.signal,
			);
			if (abort.signal.aborted) return;
			this.catchUpText = `**Catch-up at ${formatTimestamp(session.recordedSec)}** (last ${minutes} min)\n\n${text}`;
			this.catchUpBody.empty();
			await MarkdownRenderer.render(this.app, text, this.catchUpBody, session.target?.path ?? "", this);
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") return;
			this.catchUpBody.setText(`Catch-up failed: ${(err as Error).message}`);
		}
	}

	private closeCatchUp(): void {
		this.catchUpAbort?.abort();
		this.catchUpAbort = undefined;
		this.catchUpEl.addClass("is-hidden");
		this.catchUpBody.empty();
		this.catchUpText = "";
	}

	private async addCatchUpToNotes(): Promise<void> {
		const target = this.plugin.session.target;
		if (!target || !this.catchUpText) {
			new Notice("Nothing to add yet.");
			return;
		}
		await this.plugin.vault.writeSection(target, SECTION_MY_NOTES, this.catchUpText, "append");
		new Notice("Catch-up added to My notes.");
		this.closeCatchUp();
	}

	private askAboutLecture(): void {
		const session = this.plugin.session;
		const target = session.target ?? this.plugin.noteTargetFor(this.courseInput.value.trim(), this.dateInput.value || toISODate());
		if (!this.plugin.vault.exists(target.path)) {
			new Notice(`No lecture note at ${target.path} yet.`);
			return;
		}
		this.plugin.askAboutLecture(target.path);
	}

	/** Shows the setup hint while whisper.cpp is missing (and no remote server is set). */
	async checkSetup(): Promise<void> {
		const s = this.plugin.settings;
		const ok = !!s.remoteWhisperUrl || !!(await locateWhisperServer(s.whisperBinaryPath, nodeLocateDeps()).catch(() => null));
		this.setupHint.toggleClass("is-hidden", ok);
	}

	/** Asks for a link to a media file, downloads it and transcribes it like a picked file. */
	pickUrl(): void {
		if (this.plugin.session.isBusy) {
			new Notice("Wait for the current session to finish.");
			return;
		}
		new UrlModal(this.app, (url) => void this.transcribeUrl(url)).open();
	}

	private async transcribeUrl(url: string): Promise<void> {
		const course = this.courseInput.value.trim();
		if (!course) {
			new Notice("Type or choose a course first.");
			this.courseInput.focus();
			return;
		}
		const notice = new Notice("…", 0);
		try {
			const media = await this.plugin.downloadMedia(url, (m) => notice.setMessage(m));
			notice.setMessage(`Decoding ${media.name}…`);
			await this.applyMeeting(course);
			const pcm = await decodeAudioFile(media.bytes);
			notice.hide();
			this.rebuildTranscript();
			const target = await this.plugin.session.transcribeAudio(course, this.dateInput.value || toISODate(), pcm, media);
			if (target) new Notice(`Note written: ${target.path}`);
		} catch (err) {
			notice.hide();
			new Notice(`Could not transcribe the link: ${(err as Error).message}`, 10_000);
		}
	}

	/** Opens the OS file picker for an existing recording (used by the panel button and the command). */
	pickAudioFile(): void {
		if (this.plugin.session.isBusy) {
			new Notice("Wait for the current session to finish.");
			return;
		}
		this.fileInput.value = "";
		this.fileInput.click();
	}

	private async transcribeChosenFile(): Promise<void> {
		const file = this.fileInput.files?.[0];
		if (!file) return;
		const course = this.courseInput.value.trim();
		if (!course) {
			new Notice("Type or choose a course first.");
			this.courseInput.focus();
			return;
		}
		this.rebuildTranscript();
		const notice = new Notice(`Decoding ${file.name}…`, 0);
		try {
			await this.applyMeeting(course);
			const bytes = await file.arrayBuffer();
			const pcm = await decodeAudioFile(bytes);
			notice.hide();
			const target = await this.plugin.session.transcribeAudio(course, this.dateInput.value || toISODate(), pcm, { name: file.name, bytes });
			if (target) new Notice(`Note written: ${target.path}`);
		} catch (err) {
			notice.hide();
			new Notice(`Could not transcribe ${file.name}: ${(err as Error).message}`, 10_000);
		}
	}

	/** Paste box for notes that exist only as text (another app, an old file, a chat export). */
	private async pasteNotes(): Promise<void> {
		if (this.plugin.session.isBusy) {
			new Notice("Wait for the current session to finish.");
			return;
		}
		const text = await new PasteModal(this.app).ask();
		if (!text) return;
		await this.plugin.importText(text, {
			sourceName: "pasted notes",
			course: this.courseInput.value.trim(),
			date: this.dateInput.value || toISODate(),
		});
	}

	/** Clears the finished session so the panel is ready for the next class. The note is already written. */
	private newRecording(): void {
		const session = this.plugin.session;
		if (session.isBusy) return;
		session.reset();
		this.courseInput.value = "";
		this.dateInput.value = toISODate();
		this.meetingTouched = false;
		this.syncMeeting();
		this.rebuildTranscript();
		this.render();
		this.courseInput.focus();
	}

	private togglePause(): void {
		const session = this.plugin.session;
		if (session.status === "recording") session.pause();
		else if (session.status === "paused") session.resume();
	}

	private async stopRecording(): Promise<void> {
		try {
			const target = await this.plugin.session.stop();
			if (target) new Notice(`Lecture note written: ${target.path}`);
		} catch (err) {
			new Notice(`Stop failed: ${(err as Error).message}`, 8000);
		}
	}

	private async pullSlides(): Promise<void> {
		const course = this.courseInput.value.trim();
		await this.plugin.pullSlidesCommand(this.dateInput.value || toISODate(), course || undefined);
	}

	private async summarize(): Promise<void> {
		const session = this.plugin.session;
		if (session.status === "summarizing") {
			session.cancelSummary();
			return;
		}
		if (session.isLive) {
			new Notice("Stop the recording first.");
			return;
		}
		const target = session.target ?? this.plugin.noteTargetFor(this.courseInput.value.trim(), this.dateInput.value || toISODate());
		if (!this.plugin.vault.exists(target.path)) {
			new Notice(`No lecture note at ${target.path} yet.`);
			return;
		}
		this.summaryStreaming = "";
		this.summaryEl.empty();
		try {
			await session.summarize(target);
			await this.renderSummary(session.summary);
		} catch (err) {
			if (!(err instanceof Error && err.name === "AbortError")) new Notice(`Summary failed: ${(err as Error).message}`, 8000);
		}
	}

	private async openNote(): Promise<void> {
		const target = this.plugin.session.target ?? this.plugin.noteTargetFor(this.courseInput.value.trim(), this.dateInput.value || toISODate());
		if (!this.plugin.vault.exists(target.path)) {
			new Notice(`No lecture note at ${target.path} yet.`);
			return;
		}
		await this.plugin.vault.open(target.path);
	}

	private render(): void {
		const session = this.plugin.session;
		const server: ServerState = this.plugin.server.state;
		const live = session.isLive;

		this.recordBtn.toggleClass("is-hidden", live || session.status === "summarizing");
		this.newBtn.toggleClass("is-hidden", !(session.status === "done" || session.status === "error"));
		this.fileBtn.toggleClass("is-hidden", live || session.status === "summarizing");
		this.pasteBtn.toggleClass("is-hidden", live || session.status === "summarizing");
		this.noteBtn.toggleClass("is-hidden", live || session.status === "summarizing");
		this.urlBtn.toggleClass("is-hidden", live || session.status === "summarizing");
		// Without a course site there is nothing to pull: the button goes away instead of nagging.
		this.pullBtn.toggleClass("is-hidden", !this.plugin.lms().configured);
		this.pauseBtn.toggleClass("is-hidden", !(session.status === "recording" || session.status === "paused"));
		const capturing = session.status === "recording" || session.status === "paused";
		this.importantBtn.toggleClass("is-hidden", !capturing);
		this.confusingBtn.toggleClass("is-hidden", !capturing);
		this.catchUpBtn.toggleClass("is-hidden", !capturing);
		this.stopBtn.toggleClass("is-hidden", !(session.status === "recording" || session.status === "paused"));
		setIcon(this.pauseBtn, session.status === "paused" ? "play" : "pause");
		this.pauseBtn.setAttribute("aria-label", session.status === "paused" ? t("panel.resume") : t("panel.pause"));
		this.courseInput.disabled = live;
		this.dateInput.disabled = live;
		this.syncMeeting();

		this.serverPill.setText(serverLabel(server));
		this.serverPill.className = `lc-pill lc-pill-${server.status}`;
		this.serverPill.setAttribute("aria-label", server.message ?? server.baseUrl ?? "");

		this.statusText.setText(statusLabel(session.status, session.course, session.date));
		this.levelMeter.value = Math.min(1, session.level * 4);

		const p = session.progress;
		const recorded = Math.max(p.recordedSec, session.recordedSec);
		this.progressBar.value = recorded > 0 ? Math.min(1, p.transcribedSec / recorded) : 0;
		if (recorded > 0) {
			const lag = Math.max(0, recorded - p.transcribedSec);
			const bits = [`transcribed ${formatTimestamp(p.transcribedSec)} of ${formatTimestamp(recorded)}`];
			if (lag >= 1) bits.push(`${Math.round(lag)} s behind`);
			if (p.queued > 0) bits.push(`${p.queued} queued`);
			this.progressText.setText(bits.join(" · "));
			this.progressBar.toggleClass("lc-lagging", lag > 60);
		} else {
			this.progressText.setText("");
		}
		this.errorEl.setText(session.error ?? "");
		this.errorEl.toggleClass("is-hidden", !session.error);
	}

	private rebuildTranscript(): void {
		this.transcriptEl.empty();
		this.renderedSegments = 0;
		this.renderedMarks = 0;
		this.appendSegments(this.plugin.session.segments);
		this.appendMarks();
		this.summaryEl.empty();
		this.summaryStreaming = "";
		if (this.plugin.session.summary) void this.renderSummary(this.plugin.session.summary);
	}

	private appendSegments(segments: TranscriptSegment[]): void {
		for (const seg of segments) {
			const p = this.transcriptEl.createEl("p", { cls: "lc-segment" });
			p.createSpan({ cls: "lc-ts", text: formatTimestamp(seg.start) });
			p.appendText(` ${seg.text}`);
			this.renderedSegments++;
		}
		if (this.renderedSegments === 0) {
			this.transcriptEl.createEl("p", { cls: "lc-placeholder", text: t("panel.transcriptPlaceholder") });
		} else {
			this.transcriptEl.querySelector(".lc-placeholder")?.remove();
		}
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	/** Shows marks set since the last render as lines in the live transcript. */
	private appendMarks(): void {
		const marks = this.plugin.session.marks;
		if (marks.length < this.renderedMarks) this.renderedMarks = 0;
		for (const m of marks.slice(this.renderedMarks)) {
			const p = this.transcriptEl.createEl("p", { cls: `lc-segment lc-mark lc-mark-${m.kind}` });
			p.createSpan({ cls: "lc-ts", text: formatTimestamp(m.at) });
			p.appendText(` ${MARK_LABELS[m.kind]}`);
			this.transcriptEl.querySelector(".lc-placeholder")?.remove();
			this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
		}
		this.renderedMarks = marks.length;
	}

	private appendSummary(delta: string): void {
		this.summaryStreaming += delta;
		this.summaryEl.setText(this.summaryStreaming);
		this.summaryEl.scrollTop = this.summaryEl.scrollHeight;
	}

	private async renderSummary(markdown: string): Promise<void> {
		this.summaryEl.empty();
		if (!markdown.trim()) return;
		await MarkdownRenderer.render(this.app, markdown, this.summaryEl, this.plugin.session.target?.path ?? "", this);
	}
}

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
	const btn = parent.createEl("button", { cls: "lc-btn clickable-icon", attr: { "aria-label": label } });
	setIcon(btn, icon);
	btn.addEventListener("click", onClick);
	return btn;
}

function serverLabel(s: ServerState): string {
	switch (s.status) {
		case "ready":
			return t("server.ready");
		case "starting":
			return t("server.starting");
		case "remote":
			return t("server.remote");
		case "error":
			return t("server.error");
		default:
			return t("server.stopped");
	}
}

const STATUS_KEYS = { starting: "status.starting", recording: "status.recording", paused: "status.paused", transcribing: "status.transcribing", finishing: "status.finishing", matching: "status.matching", summarizing: "status.summarizing", done: "status.done", error: "status.error" } as const;

function statusLabel(status: string, course: string, date: string): string {
	const key = STATUS_KEYS[status as keyof typeof STATUS_KEYS];
	if (!key) return t("status.ready");
	return `${t(key)}${course ? ` · ${course} ${date}` : ""}`;
}

class PasteModal extends Modal {
	private resolve?: (text: string | null) => void;

	constructor(app: App) {
		super(app);
	}

	ask(): Promise<string | null> {
		this.open();
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.modalEl.addClass("lc-paste-modal");
		this.titleEl.setText("Paste your notes");
		this.contentEl.createEl("p", {
			cls: "lc-picker-hint",
			text: "Paste the notes for one lecture, or a whole run of dated entries (\"Lecture 2 - 8.26.26 …\"): several dates open the split preview. Next you choose the course and date, then the deck is matched and a summary written from the notes.",
		});
		const area = this.contentEl.createEl("textarea", { cls: "lc-paste-area", attr: { placeholder: "Paste here…", spellcheck: "false" } });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const ok = buttons.createEl("button", { text: "Continue", cls: "mod-cta" });
		ok.addEventListener("click", () => {
			if (!area.value.trim()) {
				new Notice("Nothing pasted yet.");
				return;
			}
			this.finish(area.value);
		});
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(null));
		window.setTimeout(() => area.focus(), 0);
	}

	onClose(): void {
		this.resolve?.(null);
		this.resolve = undefined;
		this.contentEl.empty();
	}

	private finish(text: string | null): void {
		this.resolve?.(text);
		this.resolve = undefined;
		this.close();
	}
}

class UrlModal extends Modal {
	constructor(
		app: App,
		private onUrl: (url: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(t("cmd.transcribeUrl"));
		this.contentEl.createEl("p", {
			cls: "lc-picker-hint",
			text: "Paste a direct link to an audio or video file: a lecture-capture download link, a podcast episode, an .mp4 or .mp3 on a course page. Pages that only play video in the browser (YouTube, most lecture-capture players) do not give such a link; download the recording there and use Transcribe an audio file, or record the computer's audio while it plays. Uses the course and date in the panel.",
		});
		const input = this.contentEl.createEl("input", { type: "url", cls: "lc-url-input", attr: { placeholder: "https://…/lecture.mp4", "aria-label": "Link to an audio or video file", spellcheck: "false" } });
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const go = () => {
			const url = input.value.trim();
			if (!url) return;
			this.close();
			this.onUrl(url);
		};
		buttons.createEl("button", { text: "Download and transcribe", cls: "mod-cta" }).addEventListener("click", go);
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") go();
		});
		window.setTimeout(() => input.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
