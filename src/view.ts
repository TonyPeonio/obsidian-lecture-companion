import { ItemView, MarkdownRenderer, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { TranscriptSegment } from "./core/audio/pipeline";
import { formatTimestamp, toISODate } from "./core/notes";
import { decodeAudioFile } from "./recorder";
import type LectureCompanionPlugin from "./main";
import type { ServerState } from "./core/whisper/server";

export const VIEW_TYPE = "lecture-companion-view";

export class LectureView extends ItemView {
	private courseInput!: HTMLInputElement;
	private courseList!: HTMLDataListElement;
	private dateInput!: HTMLInputElement;
	private recordBtn!: HTMLButtonElement;
	private pauseBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private newBtn!: HTMLButtonElement;
	private fileBtn!: HTMLButtonElement;
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
		this.courseInput = bar.createEl("input", { cls: "lc-course", attr: { list: "lc-course-list", placeholder: "Course", spellcheck: "false" } });
		this.courseList = bar.createEl("datalist", { attr: { id: "lc-course-list" } });
		this.dateInput = bar.createEl("input", { cls: "lc-date", type: "date" });
		this.dateInput.value = toISODate();

		const buttons = bar.createDiv({ cls: "lc-buttons" });
		this.recordBtn = iconButton(buttons, "mic", "Start recording", () => void this.startRecording());
		this.recordBtn.addClass("mod-cta");
		this.pauseBtn = iconButton(buttons, "pause", "Pause", () => this.togglePause());
		this.stopBtn = iconButton(buttons, "square", "Stop and write the note", () => void this.stopRecording());
		this.newBtn = iconButton(buttons, "file-plus", "New recording (clear the panel for the next class)", () => this.newRecording());
		this.fileInput = root.createEl("input", { type: "file", cls: "lc-file-input", attr: { accept: "audio/*,video/*,.webm,.m4a,.mp3,.wav,.ogg,.opus,.flac,.aac,.mp4" } });
		this.fileInput.addEventListener("change", () => void this.transcribeChosenFile());
		this.fileBtn = iconButton(buttons, "file-audio", "Transcribe an audio file (a recording you already have)", () => this.pickAudioFile());
		iconButton(buttons, "download", "Pull slides from Canvas for this date", () => void this.pullSlides());
		iconButton(buttons, "sparkles", "Summarize", () => void this.summarize());
		iconButton(buttons, "file-text", "Open lecture note", () => void this.openNote());

		// Status
		const status = root.createDiv({ cls: "lc-status" });
		this.serverPill = status.createSpan({ cls: "lc-pill" });
		this.statusText = status.createSpan({ cls: "lc-status-text" });
		const meterRow = root.createDiv({ cls: "lc-meter-row" });
		meterRow.createSpan({ text: "Mic", cls: "lc-label" });
		this.levelMeter = meterRow.createEl("progress", { cls: "lc-level", attr: { max: "1", value: "0" } });
		const progressRow = root.createDiv({ cls: "lc-progress-row" });
		this.progressBar = progressRow.createEl("progress", { cls: "lc-progress", attr: { max: "1", value: "0" } });
		this.progressText = progressRow.createSpan({ cls: "lc-progress-text" });
		this.errorEl = root.createDiv({ cls: "lc-error" });

		// Transcript + summary
		const body = root.createDiv({ cls: "lc-body" });
		body.createEl("h5", { text: "Transcript", cls: "lc-heading" });
		this.transcriptEl = body.createDiv({ cls: "lc-transcript" });
		body.createEl("h5", { text: "Summary", cls: "lc-heading" });
		this.summaryEl = body.createDiv({ cls: "lc-summary markdown-rendered" });

		const session = this.plugin.session;
		this.unsubscribe.push(
			session.subscribe(() => this.render()),
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
			await session.start(course, this.dateInput.value || toISODate());
		} catch (err) {
			new Notice(`Could not start: ${(err as Error).message}`, 8000);
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
			const bytes = await file.arrayBuffer();
			const pcm = await decodeAudioFile(bytes);
			notice.hide();
			const target = await this.plugin.session.transcribeAudio(course, this.dateInput.value || toISODate(), pcm, { name: file.name, bytes });
			if (target) new Notice(`Lecture note written: ${target.path}`);
		} catch (err) {
			notice.hide();
			new Notice(`Could not transcribe ${file.name}: ${(err as Error).message}`, 10_000);
		}
	}

	/** Clears the finished session so the panel is ready for the next class. The note is already written. */
	private newRecording(): void {
		const session = this.plugin.session;
		if (session.isBusy) return;
		session.reset();
		this.courseInput.value = "";
		this.dateInput.value = toISODate();
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
			if (!(err instanceof DOMException && err.name === "AbortError")) new Notice(`Summary failed: ${(err as Error).message}`, 8000);
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
		this.pauseBtn.toggleClass("is-hidden", !(session.status === "recording" || session.status === "paused"));
		this.stopBtn.toggleClass("is-hidden", !(session.status === "recording" || session.status === "paused"));
		setIcon(this.pauseBtn, session.status === "paused" ? "play" : "pause");
		this.pauseBtn.setAttribute("aria-label", session.status === "paused" ? "Resume" : "Pause");
		this.courseInput.disabled = live;
		this.dateInput.disabled = live;

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
		this.appendSegments(this.plugin.session.segments);
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
			this.transcriptEl.createEl("p", { cls: "lc-placeholder", text: "The transcript appears here while you record." });
		} else {
			this.transcriptEl.querySelector(".lc-placeholder")?.remove();
		}
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
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
	const btn = parent.createEl("button", { cls: "lc-btn clickable-icon", attr: { "aria-label": label, title: label } });
	setIcon(btn, icon);
	btn.addEventListener("click", onClick);
	return btn;
}

function serverLabel(s: ServerState): string {
	switch (s.status) {
		case "ready":
			return "Whisper ready";
		case "starting":
			return "Loading model…";
		case "remote":
			return "Whisper (remote)";
		case "error":
			return "Whisper error";
		default:
			return "Whisper stopped";
	}
}

function statusLabel(status: string, course: string, date: string): string {
	const where = course ? ` · ${course} ${date}` : "";
	switch (status) {
		case "starting":
			return `Starting${where}`;
		case "recording":
			return `Recording${where}`;
		case "paused":
			return `Paused${where}`;
		case "transcribing":
			return `Transcribing file${where}`;
		case "finishing":
			return `Finishing transcript${where}`;
		case "matching":
			return `Matching slides${where}`;
		case "summarizing":
			return `Summarizing${where}`;
		case "done":
			return `Done${where}`;
		case "error":
			return `Error${where}`;
		default:
			return "Ready";
	}
}
