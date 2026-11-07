import { Modal, Notice, Platform, Plugin, requestUrl, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { describePull, pullSlides } from "./canvas-pull";
import { CanvasClient, resolveCourse, type CanvasCourse } from "./core/canvas";
import type { HttpRequest } from "./core/http";
import { addLectureLink, addTodos, courseNotePath, ensureTodoSection, extractTodos, replaceAttachmentRefs, SECTION_MY_NOTES, dateHeading, detectDate, lectureNotePath, migrateCourseIndex, oneLineSummary, renderLectureNote, safeFileName, SECTION_SLIDES, SECTION_SUMMARY, setLectureLinkSummary, SECTION_TRANSCRIPT, stripFrontmatter, toISODate, type NoteKind } from "./core/notes";
import { ImportModal, importNotesAsLecture, listImportableNotes } from "./import";
import { groupEntriesByDate, splitEntries } from "./core/split";
import { SplitModal, type SplitChoice } from "./split-modal";
import { SlideMatcher } from "./slide-matcher";
import { OllamaClient } from "./core/ollama";
import { locateWhisperServer } from "./core/whisper/locate";
import { findModel, modelPath, VAD_MODEL } from "./core/whisper/models";
import { parseExtraArgs, WhisperServerManager, type ServerConfig, type ServerState } from "./core/whisper/server";
import { defaultThreads, nodeLocateDeps, nodeServerDeps } from "./node/deps";
import { convertPptxToPdf, findPptxConverter, type PptxConverter } from "./node/convert";
import { cleanTranscript, LectureSession } from "./session";
import { addCourseAlias, addMeeting, courseNoteOverride, DEFAULT_SETTINGS, manualCourseList, meetingList, vaultCourseName, type LectureCompanionSettings } from "./settings";
import { LectureCompanionSettingTab } from "./settings-tab";
import { VaultIO, type NoteTarget } from "./vault";
import { LectureView, VIEW_TYPE } from "./view";

export default class LectureCompanionPlugin extends Plugin {
	settings: LectureCompanionSettings = { ...DEFAULT_SETTINGS };
	vault!: VaultIO;
	http!: HttpRequest;
	server!: WhisperServerManager;
	canvas!: CanvasClient;
	ollama!: OllamaClient;
	session!: LectureSession;
	matcher!: SlideMatcher;
	modelsDir = "";
	private converterPromise?: Promise<PptxConverter | null>;
	/** Active Canvas courses, loaded on demand (`refreshCourses`). */
	courses: CanvasCourse[] = [];
	private serverListeners = new Set<(state: ServerState) => void>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.vault = new VaultIO(this.app, () => this.settings.attachmentFolder);
		this.modelsDir = `${this.vault.pluginDir(this.manifest.id, this.manifest.dir)}/models`;

		this.http = async (opts) => {
			const res = await requestUrl({
				url: opts.url,
				method: opts.method ?? "GET",
				headers: opts.headers,
				body: opts.body,
				contentType: opts.contentType,
				throw: false,
			});
			return { status: res.status, headers: res.headers, text: res.text, arrayBuffer: res.arrayBuffer };
		};

		this.server = new WhisperServerManager(
			nodeServerDeps(),
			() => this.serverConfigSync(),
			(state) => this.serverListeners.forEach((l) => l(state)),
		);
		this.canvas = new CanvasClient(
			() => this.settings.canvasUrl,
			() => this.settings.canvasToken,
			this.http,
		);
		this.ollama = new OllamaClient(
			() => this.settings.ollamaUrl,
			(input, init) => fetch(input, init),
			async (url, body) => {
				const res = await requestUrl({ url, method: "POST", body: body || undefined, contentType: "application/json", throw: false });
				return { status: res.status, text: res.text };
			},
		);
		this.session = new LectureSession(this);
		this.matcher = new SlideMatcher(this);

		this.registerView(VIEW_TYPE, (leaf) => new LectureView(leaf, this));
		this.addRibbonIcon("mic", "Lecture Companion", () => void this.activateView());
		this.addSettingTab(new LectureCompanionSettingTab(this.app, this));

		this.addCommand({ id: "open-panel", name: "Open panel", callback: () => void this.activateView() });
		this.addCommand({
			id: "start-recording",
			name: "Start recording",
			checkCallback: (checking) => {
				if (this.session.isBusy) return false;
				if (!checking) void this.activateView(true);
				return true;
			},
		});
		this.addCommand({
			id: "pause-resume-recording",
			name: "Pause or resume recording",
			checkCallback: (checking) => {
				const s = this.session.status;
				if (s !== "recording" && s !== "paused") return false;
				if (!checking) {
					if (s === "recording") this.session.pause();
					else this.session.resume();
				}
				return true;
			},
		});
		this.addCommand({
			id: "stop-recording",
			name: "Stop recording and write the note",
			checkCallback: (checking) => {
				const s = this.session.status;
				if (s !== "recording" && s !== "paused") return false;
				if (!checking) {
					this.session.stop().then(
						(target) => target && new Notice(`Lecture note written: ${target.path}`),
						(err: Error) => new Notice(`Stop failed: ${err.message}`, 8000),
					);
				}
				return true;
			},
		});
		this.addCommand({
			id: "transcribe-audio-file",
			name: "Transcribe an audio file",
			checkCallback: (checking) => {
				if (this.session.isBusy) return false;
				if (!checking) void this.activateView().then((view) => view?.pickAudioFile());
				return true;
			},
		});
		this.addCommand({
			id: "pull-canvas-slides",
			name: "Pull today's Canvas slides",
			callback: () => void this.pullSlidesCommand(toISODate()),
		});
		this.addCommand({
			id: "pull-canvas-slides-for-date",
			name: "Pull Canvas slides for a date…",
			callback: () => {
				new DateModal(this.app, (date) => void this.pullSlidesCommand(date)).open();
			},
		});
		this.addCommand({
			id: "import-note",
			name: "Import this note as a lecture (my notes → slides + summary)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) {
					const editor = this.app.workspace.activeEditor?.editor;
					void this.importActiveNote(editor?.getSelection() || undefined);
				}
				return true;
			},
		});
		this.addCommand({
			id: "split-note",
			name: "Split this note into lectures (one per date)",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) void this.importActiveNote(undefined, true);
				return true;
			},
		});
		this.addCommand({
			id: "import-folder",
			name: "Import all notes in this folder as lectures",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || this.session.isBusy) return false;
				if (!checking) void this.importFolder();
				return true;
			},
		});
		this.addCommand({
			id: "rebuild-course-index",
			name: "Rebuild course note links (list every lecture note under its date)",
			callback: async () => {
				const courses = this.vault.coursesInFolder(this.settings.courseFolder).filter((c) => !this.isMeeting(c));
				const meetings = this.meetingFolderSeparate() ? this.vault.coursesInFolder(this.settings.meetingFolder) : [];
				let total = 0;
				for (const c of [...courses, ...meetings]) total += await this.rebuildCourseIndex(c);
				new Notice(`Course notes updated for ${courses.length} course${courses.length === 1 ? "" : "s"}${meetings.length ? ` and ${meetings.length} meeting series` : ""} (${total} notes linked).`);
			},
		});
		this.addCommand({
			id: "move-todos",
			name: "Move tasks from this note to the course TODO list",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) void this.moveTodosFromNote(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "convert-pptx-in-note",
			name: "Convert PowerPoint decks in this note to PDF",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) {
					const notice = new Notice("Converting…", 0);
					this.convertPptxInNote(file.path).then(
						(r) => {
							notice.hide();
							new Notice(`${r.converted} deck${r.converted === 1 ? "" : "s"} converted to PDF.${r.errors.length ? ` ${r.errors.join("; ")}` : ""}`, 8000);
						},
						(err: Error) => {
							notice.hide();
							new Notice(err.message, 8000);
						},
					);
				}
				return true;
			},
		});
		this.addCommand({
			id: "choose-slides",
			name: "Choose slides for this lecture note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) void this.chooseSlidesForNote(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "summarize-lecture-note",
			name: "Summarize this lecture note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) {
					const target = this.targetForExistingNote(file.path);
					this.session.summarize(target).then(
						() => new Notice("Summary written."),
						(err: Error) => new Notice(`Summary failed: ${err.message}`, 8000),
					);
					void this.activateView();
				}
				return true;
			},
		});
		this.addCommand({ id: "start-whisper-server", name: "Start whisper-server", callback: () => void this.startServer().catch((e: Error) => new Notice(e.message, 8000)) });
		this.addCommand({ id: "stop-whisper-server", name: "Stop whisper-server", callback: () => this.server.stop() });

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.canvasUrl && this.settings.canvasToken) {
				void this.refreshCourses().catch(() => undefined);
				if (this.settings.autoPullDaily && this.settings.lastCanvasPull !== toISODate()) {
					void this.pullSlidesCommand(toISODate());
				}
			}
		});
	}

	onunload(): void {
		void this.session.dispose();
		this.server.stop();
	}

	// ----------------------------------------------------------------- settings

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<LectureCompanionSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onServerState(fn: (state: ServerState) => void): () => void {
		this.serverListeners.add(fn);
		return () => this.serverListeners.delete(fn);
	}

	/** Server config is read synchronously by the manager; the binary lookup is cached by `prepareServer`. */
	private cachedBinary = "";
	private serverConfigSync(): ServerConfig {
		const s = this.settings;
		const model = findModel(s.whisperModel);
		return {
			binary: s.whisperBinaryPath.trim() || this.cachedBinary,
			modelPath: model ? modelPath(this.modelsDir, model) : "",
			threads: s.threads > 0 ? s.threads : defaultThreads(),
			language: s.language,
			vadModelPath: s.useVad ? modelPath(this.modelsDir, VAD_MODEL) : undefined,
			extraArgs: parseExtraArgs(s.extraServerArgs),
			remoteUrl: s.remoteWhisperUrl || undefined,
			idleUnloadMs: s.idleUnloadMinutes * 60_000,
		};
	}

	/** Resolves the binary (async) and then starts or reuses the server. Use this instead of `server.ensureRunning()` directly. */
	async startServer(): Promise<string> {
		if (!this.settings.remoteWhisperUrl && !this.server.isRunning) {
			this.cachedBinary = (await locateWhisperServer(this.settings.whisperBinaryPath, nodeLocateDeps())) ?? "";
		}
		return this.server.ensureRunning();
	}

	// ------------------------------------------------------------------ courses

	async refreshCourses(): Promise<CanvasCourse[]> {
		this.courses = await this.canvas.listCourses();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof LectureView) view.refreshCourses();
		}
		return this.courses;
	}

	courseNames(): string[] {
		const names = new Set<string>();
		for (const c of this.courses) names.add(c.name);
		for (const c of manualCourseList(this.settings)) names.add(c);
		for (const c of this.vault.coursesInFolder(this.settings.courseFolder)) names.add(c);
		for (const m of meetingList(this.settings)) names.add(m);
		if (this.meetingFolderSeparate()) for (const m of this.vault.coursesInFolder(this.settings.meetingFolder)) names.add(m);
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	// ----------------------------------------------------------------- meetings

	/** False when the meeting folder is set to the course folder (then only the list marks meetings). */
	private meetingFolderSeparate(): boolean {
		return this.settings.meetingFolder.trim().toLowerCase() !== this.settings.courseFolder.trim().toLowerCase();
	}

	/** A meeting series (work, club, 1:1): listed in settings, or already filed under the meeting folder. Never looked up in Canvas. */
	isMeeting(name: string): boolean {
		const wanted = name.trim().toLowerCase();
		if (!wanted) return false;
		if (meetingList(this.settings).some((m) => m.toLowerCase() === wanted)) return true;
		if (!this.meetingFolderSeparate()) return false;
		const file = safeFileName(name).toLowerCase();
		return this.vault.coursesInFolder(this.settings.meetingFolder).some((m) => m.toLowerCase() === wanted || m.toLowerCase() === file);
	}

	noteKind(name: string): NoteKind {
		return this.isMeeting(name) ? "meeting" : "lecture";
	}

	/** Root folder for a course or meeting series. */
	folderFor(name: string): string {
		return this.isMeeting(name) ? this.settings.meetingFolder : this.settings.courseFolder;
	}

	/** Adds a name to the meeting list (from the panel's or import dialog's "Meeting" box). */
	async markMeeting(name: string): Promise<void> {
		if (this.isMeeting(name)) return;
		if (addMeeting(this.settings, name)) await this.saveSettings();
	}

	/** The course or meeting series a note belongs to: frontmatter `course:`, else its folder (or its own name for a series note at the top). */
	async seriesOfNote(path: string): Promise<string> {
		const md = await this.vault.read(path).catch(() => "");
		const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
		const fromFm = /^course:\s*"?(.*?)"?\s*$/m.exec(fm)?.[1]?.trim();
		if (fromFm) return fromFm;
		const parts = path.split("/");
		const parent = parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
		const roots = [this.settings.courseFolder, this.settings.meetingFolder].map((f) => f.split("/").pop()?.toLowerCase());
		if (!parent || roots.includes(parent.toLowerCase())) return (parts[parts.length - 1] ?? "").replace(/\.md$/, "");
		return parent;
	}

	// -------------------------------------------------------------------- notes

	noteTargetFor(course: string, date: string): NoteTarget {
		const s = this.settings;
		if (s.noteMode === "per-course-section") {
			const canvasCourse = this.courses.find((c) => c.name === course);
			const override = courseNoteOverride(s, canvasCourse ?? { name: course });
			return { path: override ?? courseNotePath(this.folderFor(course), course), parentHeading: dateHeading(s.dateHeading, date) };
		}
		return { path: lectureNotePath(this.folderFor(course), course, date) };
	}

	/** Creates the lecture note skeleton (and the course note link) when missing. `course` is the vault name (alias). */
	async ensureLectureNote(course: string, date: string): Promise<NoteTarget> {
		const target = this.noteTargetFor(course, date);
		// Course notes carry no H1 either: the file name is the title.
		if (target.parentHeading) {
			await this.vault.createIfMissing(target.path, "");
			return target;
		}
		await this.vault.createIfMissing(target.path, renderLectureNote({ course, date, kind: this.noteKind(course) }));
		await this.ensureCourseLink(course, date, target.path);
		return target;
	}

	/** Makes sure the course note (`Courses/<course>.md`) lists this lecture under `## Lectures` → `### <date>` (`## Meetings` for a meeting series). Idempotent. */
	async ensureCourseLink(course: string, date: string, lecturePath: string, summary?: string): Promise<void> {
		const meeting = this.isMeeting(course);
		const coursePath = courseNotePath(this.folderFor(course), course);
		const link = `[[${lecturePath.replace(/\.md$/, "")}|${date} ${meeting ? "meeting" : "lecture"}]]`;
		// The day's one-sentence summary goes after the link, so the course note reads as an outline.
		const sentence = summary ? oneLineSummary(summary) : null;
		const f = this.vault.file(coursePath) ?? (await this.vault.write(coursePath, ""));
		await this.app.vault.process(f, (md) => {
			const out = ensureTodoSection(addLectureLink(md, date, link, meeting ? "## Meetings" : "## Lectures"));
			return sentence ? setLectureLinkSummary(out, link, sentence) : out;
		});
	}

	/** Moves task lines into the course note's `## TODO` section. Returns how many were added. */
	async addCourseTodos(course: string, todos: string[]): Promise<number> {
		if (todos.length === 0) return 0;
		const coursePath = courseNotePath(this.folderFor(course), course);
		const f = this.vault.file(coursePath) ?? (await this.vault.write(coursePath, ""));
		let added = 0;
		await this.app.vault.process(f, (md) => {
			const out = addTodos(md, todos);
			added = (out.match(/^- \[[ xX]\]/gm)?.length ?? 0) - (md.match(/^- \[[ xX]\]/gm)?.length ?? 0);
			return out;
		});
		return Math.max(0, added);
	}

	/** "Move tasks from this note to the course TODO": pulls task lines out of the open note's My notes section. */
	async moveTodosFromNote(path: string): Promise<void> {
		const course = await this.seriesOfNote(path);
		if (!course) {
			new Notice("Cannot tell which course this note belongs to (no course in frontmatter or folder).");
			return;
		}
		const target: NoteTarget = { path };
		const notes = (await this.vault.readSection(target, SECTION_MY_NOTES)) ?? "";
		const { remaining, todos } = extractTodos(notes);
		if (todos.length === 0) {
			new Notice("No task lines found under My notes.");
			return;
		}
		await this.vault.writeSection(target, SECTION_MY_NOTES, remaining, "replace");
		const added = await this.addCourseTodos(course, todos);
		new Notice(`${todos.length} task${todos.length === 1 ? "" : "s"} moved to ${courseNotePath(this.folderFor(course), course)} (${added} new).`);
	}

	/** Rebuilds the course note's lecture list from the notes on disk (and converts the old per-date layout). */
	async rebuildCourseIndex(course: string): Promise<number> {
		const coursePath = courseNotePath(this.folderFor(course), course);
		const existing = this.vault.file(coursePath);
		if (existing && !this.isMeeting(course)) await this.app.vault.process(existing, (md) => migrateCourseIndex(md));
		const paths = this.vault.lectureNotePaths(this.folderFor(course), course).filter((p) => /\/\d{4}-\d{2}-\d{2}\.md$/.test(p)).sort();
		for (const p of paths) {
			const date = /(\d{4}-\d{2}-\d{2})\.md$/.exec(p)?.[1];
			if (!date) continue;
			const summary = (await this.vault.readSection({ path: p }, SECTION_SUMMARY)) ?? "";
			await this.ensureCourseLink(course, date, p, summary);
		}
		return paths.length;
	}

	private targetForExistingNote(path: string): NoteTarget {
		// A per-course note gets today's date section; a per-lecture note is used as-is.
		if (this.settings.noteMode === "per-course-section" || !/\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) {
			return { path, parentHeading: dateHeading(this.settings.dateHeading, toISODate()) };
		}
		return { path };
	}

	// ------------------------------------------------------------------- canvas

	/** PowerPoint or LibreOffice, looked up once per session. */
	pptxConverter(): Promise<PptxConverter | null> {
		this.converterPromise ??= findPptxConverter();
		return this.converterPromise;
	}

	/**
	 * Saves a downloaded deck into the attachment folder; a .pptx becomes a PDF when a converter is
	 * available and the setting is on (the original is kept only if asked). Returns the vault path to embed.
	 */
	async saveDeck(bytes: ArrayBuffer, fileName: string, forNotePath: string): Promise<{ vaultPath: string; converted: boolean; note?: string }> {
		const isPptx = /\.pptx$/i.test(fileName);
		if (isPptx && this.settings.convertPptxToPdf) {
			const converter = await this.pptxConverter();
			if (converter) {
				try {
					const pdf = await convertPptxToPdf(converter, bytes, fileName);
					const pdfPath = await this.vault.attachmentPath(fileName.replace(/\.pptx$/i, ".pdf"), forNotePath);
					await this.vault.createBinary(pdfPath, pdf);
					if (this.settings.keepPptx) await this.vault.createBinary(await this.vault.attachmentPath(fileName, forNotePath), bytes);
					return { vaultPath: pdfPath, converted: true };
				} catch (err) {
					const vaultPath = await this.vault.attachmentPath(fileName, forNotePath);
					await this.vault.createBinary(vaultPath, bytes);
					return { vaultPath, converted: false, note: `PDF conversion failed (${(err as Error).message}); kept the .pptx` };
				}
			}
		}
		const vaultPath = await this.vault.attachmentPath(fileName, forNotePath);
		await this.vault.createBinary(vaultPath, bytes);
		return { vaultPath, converted: false };
	}

	/** Converts every .pptx embedded in a note to PDF and repoints the links. Returns how many were converted. */
	async convertPptxInNote(path: string): Promise<{ converted: number; errors: string[] }> {
		const converter = await this.pptxConverter();
		if (!converter) throw new Error("No converter found: install PowerPoint or LibreOffice.");
		const md = await this.vault.read(path);
		const names = [...new Set([...md.matchAll(/\[\[(?:[^\]|]*\/)?([^\]|/]+\.pptx)(?:\||\]\])/gi)].map((m) => m[1] ?? "").filter(Boolean))];
		let converted = 0;
		const errors: string[] = [];
		for (const name of names) {
			const file = this.app.metadataCache.getFirstLinkpathDest(name, path);
			if (!file) {
				errors.push(`${name}: file not found`);
				continue;
			}
			try {
				const bytes = await this.app.vault.readBinary(file);
				const pdf = await convertPptxToPdf(converter, bytes, file.name);
				const pdfPath = await this.vault.attachmentPath(file.basename + ".pdf", path);
				await this.vault.createBinary(pdfPath, pdf);
				const pdfName = pdfPath.split("/").pop() ?? pdfPath;
				const target = this.vault.file(path);
				if (target) await this.app.vault.process(target, (text) => replaceAttachmentRefs(text, file.name, pdfName));
				if (!this.settings.keepPptx) await this.app.fileManager.trashFile(file);
				converted++;
			} catch (err) {
				errors.push(`${name}: ${(err as Error).message}`);
			}
		}
		return { converted, errors };
	}

	/** The Canvas course behind a name typed in the picker or stored in a note (alias first, then fuzzy). */
	canvasCourseFor(name: string): CanvasCourse | undefined {
		const wanted = name.trim().toLowerCase();
		if (!wanted) return undefined;
		return this.courses.find((c) => vaultCourseName(this.settings, c).toLowerCase() === wanted) ?? resolveCourse(this.courses, name) ?? undefined;
	}

	/** Remembers "typed name → Canvas course" so pulls use the same note name the user chose. */
	async learnCourseAlias(typed: string): Promise<void> {
		if (!this.canvas.configured || this.isMeeting(typed)) return;
		if (this.courses.length === 0) await this.refreshCourses().catch(() => undefined);
		const course = this.canvasCourseFor(typed);
		if (course && addCourseAlias(this.settings, course, typed)) await this.saveSettings();
	}

	/** Called by the session after the transcript is written and before the summary. */
	async matchSlidesForSession(course: string, date: string, target: NoteTarget, transcript: string): Promise<void> {
		if (this.settings.slideMatching === "off") return;
		await this.matchSlides(course, date, target, transcript, this.settings.slideMatching);
	}

	/** Matches a deck against `text` (transcript or the student's notes) when the Slides section is still empty. */
	async matchSlides(course: string, date: string, target: NoteTarget, text: string, mode: "ask" | "auto"): Promise<void> {
		if (!this.canvas.configured || this.isMeeting(course)) return;
		const existing = cleanTranscript((await this.vault.readSection(target, SECTION_SLIDES)) ?? "", false);
		if (existing) return; // slides already chosen for this lecture
		if (this.courses.length === 0) await this.refreshCourses();
		const canvasCourse = this.canvasCourseFor(course);
		if (!canvasCourse) {
			new Notice(`No Canvas course matches "${course}"; slides not matched. Add an alias in settings if the names differ.`, 8000);
			return;
		}
		const notice = new Notice("Matching slides to the lecture…", 0);
		try {
			const result = await this.matcher.run({ canvasCourse, course, date, target, transcript: text, windowOnly: false, mode, replace: false, offerAutoAccept: true, onStatus: (m) => notice.setMessage(m) });
			notice.hide();
			if (result.attached.length) new Notice(`Attached: ${result.attached.join(", ")}`, 6000);
			else if (!result.skipped && result.candidates === 0) new Notice("No slide files found in that Canvas course.", 6000);
			for (const e of result.errors) new Notice(e, 8000);
		} catch (err) {
			notice.hide();
			throw err;
		}
	}

	/** "Import this note as a lecture": the open note (or selection) becomes My notes of a lecture note. A note holding several dated entries is offered for splitting. */
	async importActiveNote(selection?: string, forceSplit = false): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const md = await this.app.vault.cachedRead(file);
		const text = selection?.trim() || stripFrontmatter(md);
		const parts = file.path.split("/");
		const folderName = parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
		await this.importText(text, {
			sourceName: file.basename,
			sourcePath: selection ? undefined : file.path,
			course: this.courseNames().find((c) => c === folderName) ?? "",
			date: detectDate(file.basename) ?? detectDate(md.slice(0, 400)) ?? toISODate(new Date(file.stat.ctime)),
			forceSplit,
		});
	}

	/** Shared by the open-note import and the panel's paste box. */
	async importText(text: string, opts: { sourceName: string; sourcePath?: string; course: string; date: string; forceSplit?: boolean }): Promise<void> {
		if (!text.trim()) {
			new Notice("There is no text to import.");
			return;
		}
		const entries = splitEntries(text);
		const datedEntries = entries.filter((e) => e.date && !e.inherited).length;
		if (opts.forceSplit || datedEntries >= 2) {
			const choice = await new SplitModal(this.app, this, opts.sourceName, entries, { course: opts.course }).ask();
			if (choice === null) return;
			if (choice !== "single") {
				await this.importSplit(choice);
				return;
			}
		}
		const choice = await new ImportModal(this.app, this, `Import "${opts.sourceName}" as a lecture`, { course: opts.course, date: opts.date }).ask();
		if (!choice) return;
		const notice = new Notice("Importing…", 0);
		try {
			const result = await importNotesAsLecture(this, { ...choice, text, sourcePath: opts.sourcePath });
			notice.hide();
			new Notice(`${result.created ? "Created" : "Updated"} ${result.target.path}${result.summarized ? " with a summary" : ""}.`, 8000);
			await this.vault.open(result.target.path);
		} catch (err) {
			notice.hide();
			new Notice(`Import failed: ${(err as Error).message}`, 10_000);
		}
	}

	/** Imports the entries of a split note, one lecture per date (same-day entries merged). */
	private async importSplit(choice: SplitChoice): Promise<void> {
		const groups = groupEntriesByDate(choice.entries);
		const notice = new Notice("Importing…", 0);
		let done = 0;
		const failures: string[] = [];
		for (const g of groups) {
			notice.setMessage(`Importing ${g.date} (${done + 1}/${groups.length})…`);
			try {
				await importNotesAsLecture(this, { course: choice.course, date: g.date, text: g.text, matchSlides: choice.matchSlides, summarize: choice.summarize, meeting: choice.meeting });
				done++;
			} catch (err) {
				failures.push(`${g.date}: ${(err as Error).message}`);
			}
		}
		notice.hide();
		new Notice(`Imported ${done} of ${groups.length} ${this.isMeeting(choice.course) ? "meetings" : "lectures"} into ${this.folderFor(choice.course)}/${choice.course}.${failures.length ? ` Failed: ${failures.join("; ")}` : ""}`, 12_000);
	}

	/** "Import all notes in this folder": every non-lecture note in the active note's folder, one course, dates from file names. */
	async importFolder(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const folder = file?.parent;
		if (!folder) {
			new Notice("Open a note inside the folder you want to import.");
			return;
		}
		const notes = await listImportableNotes(this, folder);
		if (notes.length === 0) {
			new Notice("No importable notes here (notes that are already lectures are skipped).");
			return;
		}
		const undated = notes.filter((n) => !n.date);
		const choice = await new ImportModal(
			this.app,
			this,
			`Import ${notes.length} note${notes.length === 1 ? "" : "s"} from "${folder.name}"${undated.length ? ` (${undated.length} without a date in the name will use the file's creation date)` : ""}`,
			{ course: this.courseNames().find((c) => c === folder.name) ?? "", matchSlides: "auto" },
			false,
		).ask();
		if (!choice) return;
		const notice = new Notice("Importing…", 0);
		let done = 0;
		const failures: string[] = [];
		for (const n of notes) {
			const date = n.date ?? toISODate(new Date(n.file.stat.ctime));
			notice.setMessage(`Importing ${n.file.basename} (${done + 1}/${notes.length})…`);
			try {
				const md = await this.app.vault.cachedRead(n.file);
				await importNotesAsLecture(this, { ...choice, date, text: stripFrontmatter(md), sourcePath: n.file.path });
				done++;
			} catch (err) {
				failures.push(`${n.file.basename}: ${(err as Error).message}`);
			}
		}
		notice.hide();
		new Notice(`Imported ${done} of ${notes.length} notes into ${this.folderFor(choice.course)}/${choice.course}.${failures.length ? ` Failed: ${failures.join("; ")}` : ""}`, 12_000);
	}

	/** "Choose slides for this lecture note": re-pick from the whole course and replace the Slides section. */
	async chooseSlidesForNote(path: string): Promise<void> {
		if (!this.canvas.configured) {
			new Notice("Set the Canvas URL and access token in settings first.");
			return;
		}
		const md = await this.vault.read(path);
		const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
		const courseFromFm = /^course:\s*"?(.*?)"?\s*$/m.exec(fm)?.[1]?.trim();
		const parts = path.split("/");
		const course = courseFromFm || (parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "");
		const date = /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(fm)?.[1] ?? /(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1] ?? toISODate();
		const target = this.targetForExistingNote(path);
		if (this.isMeeting(course)) {
			new Notice(`"${course}" is a meeting series, so it has no Canvas slides. Remove it from the meeting list in settings if it is a course.`, 8000);
			return;
		}
		await this.learnCourseAlias(course);
		const canvasCourse = this.canvasCourseFor(course);
		if (!canvasCourse) {
			new Notice(`No Canvas course matches "${course}". Add an alias in settings (Canvas id = ${course}).`, 8000);
			return;
		}
		const transcript = (await this.vault.readSection(target, SECTION_TRANSCRIPT)) ?? "";
		const notice = new Notice("Reading the course's slide decks…", 0);
		try {
			const result = await this.matcher.run({ canvasCourse, course, date, target, transcript, windowOnly: false, mode: "ask", replace: true, onStatus: (m) => notice.setMessage(m) });
			notice.hide();
			if (result.skipped) return;
			new Notice(result.attached.length ? `Slides replaced: ${result.attached.join(", ")}. Run "Summarize this lecture note" to refresh the summary.` : "Slides section cleared.", 8000);
			for (const e of result.errors) new Notice(e, 8000);
		} catch (err) {
			notice.hide();
			new Notice(`Choosing slides failed: ${(err as Error).message}`, 8000);
		}
	}

	async pullSlidesCommand(date: string, courseQuery?: string): Promise<void> {
		if (!this.canvas.configured) {
			new Notice("Set the Canvas URL and access token in settings first.");
			return;
		}
		const notice = new Notice("Pulling slides from Canvas…", 0);
		try {
			if (this.courses.length === 0) await this.refreshCourses();
			let courses = this.courses;
			if (courseQuery && this.isMeeting(courseQuery)) {
				notice.hide();
				new Notice(`"${courseQuery}" is a meeting series; there are no Canvas slides to pull. Clear the course box to pull for every course.`, 8000);
				return;
			}
			if (courseQuery) {
				const course = this.canvasCourseFor(courseQuery);
				if (!course) {
					notice.hide();
					new Notice(`No active Canvas course matches "${courseQuery}".`);
					return;
				}
				courses = [course];
			}
			if (this.settings.slideMatching === "off") {
				const results = await pullSlides(this, { date, course: courseQuery ? courses[0] : undefined, onStatus: (m) => notice.setMessage(m) });
				notice.hide();
				new Notice(describePull(results), 8000);
			} else {
				const attached: string[] = [];
				const errors: string[] = [];
				for (const canvasCourse of courses) {
					const course = vaultCourseName(this.settings, canvasCourse);
					notice.setMessage(`Checking ${course}…`);
					// Only create a lecture note when the window actually holds files.
					const probe = await this.matcher.candidateCount(canvasCourse, date, true);
					if (probe === 0) continue;
					const target = await this.ensureLectureNote(course, date);
					const transcript = (await this.vault.readSection(target, SECTION_TRANSCRIPT)) ?? "";
					const result = await this.matcher.run({ canvasCourse, course, date, target, transcript, windowOnly: true, mode: this.settings.slideMatching, replace: false, offerAutoAccept: true, onStatus: (m) => notice.setMessage(m) });
					attached.push(...result.attached.map((n) => `${n} (${course})`));
					errors.push(...result.errors);
				}
				notice.hide();
				new Notice(attached.length ? `Attached ${attached.length}: ${attached.join(", ")}` : "No new slide files in that window.", 8000);
				for (const e of errors) new Notice(e, 8000);
			}
			this.settings.lastCanvasPull = toISODate();
			await this.saveSettings();
		} catch (err) {
			notice.hide();
			new Notice(`Canvas pull failed: ${(err as Error).message}`, 8000);
		}
	}

	// --------------------------------------------------------------------- view

	async activateView(focusRecord = false): Promise<LectureView | null> {
		if (!Platform.isDesktopApp) return null;
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return null;
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
		const view = leaf.view instanceof LectureView ? leaf.view : null;
		if (view && focusRecord) view.containerEl.querySelector<HTMLInputElement>(".lc-course")?.focus();
		return view;
	}
}

class DateModal extends Modal {
	constructor(
		app: App,
		private onPick: (date: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Pull Canvas slides for which date?");
		const input = this.contentEl.createEl("input", { type: "date" });
		input.value = toISODate();
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const ok = row.createEl("button", { text: "Pull", cls: "mod-cta" });
		ok.addEventListener("click", () => {
			if (input.value) this.onPick(input.value);
			this.close();
		});
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
