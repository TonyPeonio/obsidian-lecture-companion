import { Modal, normalizePath, Platform, Plugin, requestUrl, TFile, TFolder, type App, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { LcNotice as Notice } from "./report-modal";
import { describePull, pullSlides } from "./canvas-pull";
import { conventionsBlock, upsertConventions } from "./core/agent-bridge";
import { CanvasClient, resolveCourse, type CanvasCourse } from "./core/canvas";
import type { HttpRequest } from "./core/http";
import { alignTranscriptToSlides } from "./core/align";
import { buildReviewNote, buildReviewOverviewMessages, lecturesInRange, reviewNotePath } from "./core/review";
import { buildVocabulary, definedTerms, extraVocabulary } from "./core/vocab";
import { stripThinkTags } from "./core/summarize";
import { LectureIndex, createApi, type LectureCompanionApi } from "./api";
import { ClassReminders } from "./reminders";
import { TimestampLinks } from "./timestamps";
import type { MarkKind } from "./core/transcript";
import { addLectureLink, addTodos, courseNotePath, formatTimestamp, renamedAttachment, sectionBody, ensureTodoSection, retargetLinks, extractTodos, replaceAttachmentRefs, SECTION_MY_NOTES, dateHeading, detectDate, lectureNotePath, migrateCourseIndex, oneLineSummary, renderLectureNote, safeFileName, SECTION_SLIDES, SECTION_SUMMARY, setLectureLinkSummary, SECTION_TRANSCRIPT, stripFrontmatter, toISODate, type NoteKind } from "./core/notes";
import { ImportModal, importNotesAsLecture, listImportableNotes } from "./import";
import { groupEntriesByDate, splitEntries } from "./core/split";
import { SplitModal, type SplitChoice } from "./split-modal";
import { SlideMatcher } from "./slide-matcher";
import { OllamaClient, type ChatClient } from "./core/ollama";
import { OpenAiClient } from "./core/openai";
import { MoodleClient } from "./core/moodle";
import { NoLms, type CourseFilesProvider } from "./core/lms";
import { ReportModal, setReporter } from "./report-modal";
import { SetupModal } from "./setup";
import { t } from "./i18n";
import { backupPlan, backupStamp, backupsToPrune } from "./core/backup";
import { isHttpUrl, isMediaResponse, mediaFileName } from "./core/media";
import { buildTranslateMessages, cleanTranslation, translatedHeading, translationChunks } from "./core/translate";
import { parseTranscript } from "./core/transcript";
import { SAMPLE_COURSE, SAMPLE_DECK, sampleLectureNote, samplePdf } from "./core/sample";
import { locateWhisperServer } from "./core/whisper/locate";
import { findModel, modelPath, VAD_MODEL } from "./core/whisper/models";
import { parseExtraArgs, WhisperServerManager, type ServerConfig, type ServerState } from "./core/whisper/server";
import { defaultThreads, nodeLocateDeps, nodeServerDeps } from "./node/deps";
import { convertPptxToPdf, findPptxConverter, type PptxConverter } from "./node/convert";
import { cleanTranscript, LectureSession } from "./session";
import { migrateSettings, addCourseAlias, addMeeting, courseNoteOverride, DEFAULT_SETTINGS, manualCourseList, meetingList, renameCourseInSettings, setCourseAlias, vaultCourseName, type LectureCompanionSettings, type SlideMatching, setCourseHidden, visibleCourses } from "./settings";
import { LectureCompanionSettingTab } from "./settings-tab";
import { VaultIO, type NoteTarget } from "./vault";
import { LectureView, VIEW_TYPE } from "./view";

export default class LectureCompanionPlugin extends Plugin {
	settings: LectureCompanionSettings = { ...DEFAULT_SETTINGS };
	vault!: VaultIO;
	http!: HttpRequest;
	server!: WhisperServerManager;
	canvasClient!: CanvasClient;
	moodle!: MoodleClient;
	private noLms = new NoLms();
	ollama!: OllamaClient;
	openai!: OpenAiClient;
	session!: LectureSession;
	matcher!: SlideMatcher;
	modelsDir = "";
	private converterPromise?: Promise<PptxConverter | null>;
	/** Active Canvas courses minus the hidden ones, loaded on demand (`refreshCourses`). Everything else works from this list. */
	courses: CanvasCourse[] = [];
	/** Every active Canvas course, hidden ones included (for the settings tab). */
	allCourses: CanvasCourse[] = [];
	private serverListeners = new Set<(state: ServerState) => void>();
	lectureIndex!: LectureIndex;
	reminders!: ClassReminders;
	/** Public API for other plugins (Local Vault Agent): see api.ts and the README. */
	api!: LectureCompanionApi;

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
		this.canvasClient = new CanvasClient(
			() => this.settings.canvasUrl,
			() => this.settings.canvasToken,
			this.http,
		);
		this.ollama = new OllamaClient(
			() => this.settings.ollamaUrl,
			// Streaming summaries need fetch (requestUrl cannot stream); requestUrl below is the fallback.
			(input, init) => window.fetch(input, init),
			async (url, method, body) => {
				const res = await requestUrl({ url, method, body, contentType: body === undefined ? undefined : "application/json", throw: false });
				return { status: res.status, text: res.text };
			},
		);
		this.moodle = new MoodleClient(
			() => this.settings.moodleUrl,
			() => this.settings.moodleToken,
			this.http,
		);
		this.openai = new OpenAiClient(
			() => this.settings.openaiUrl,
			() => this.settings.openaiKey,
			(input, init) => window.fetch(input, init),
			async (url, method, body, headers) => {
				const res = await requestUrl({ url, method, body, headers, contentType: body === undefined ? undefined : "application/json", throw: false });
				return { status: res.status, text: res.text };
			},
		);
		setReporter((summary) => new ReportModal(this.app, this, summary).open());
		this.session = new LectureSession(this);
		this.matcher = new SlideMatcher(this);
		this.lectureIndex = new LectureIndex(this);
		this.lectureIndex.register();
		this.api = createApi(this, this.lectureIndex);
		new TimestampLinks(this).register();
		this.reminders = new ClassReminders(this);
		this.reminders.register();

		this.registerView(VIEW_TYPE, (leaf) => new LectureView(leaf, this));
		this.addRibbonIcon("mic", "Lecture Companion", () => void this.activateView());
		this.addSettingTab(new LectureCompanionSettingTab(this.app, this));

		this.addCommand({ id: "open-panel", name: t("cmd.openPanel"), callback: () => void this.activateView() });
		this.addCommand({
			id: "start-recording",
			name: t("cmd.startRecording"),
			checkCallback: (checking) => {
				if (this.session.isBusy) return false;
				if (!checking) void this.activateView(true);
				return true;
			},
		});
		this.addCommand({
			id: "pause-resume-recording",
			name: t("cmd.pauseResume"),
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
			name: t("cmd.stop"),
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
			name: t("cmd.transcribeFile"),
			checkCallback: (checking) => {
				if (this.session.isBusy) return false;
				if (!checking) void this.activateView().then((view) => view?.pickAudioFile());
				return true;
			},
		});
		this.addCommand({
			id: "pull-canvas-slides",
			name: t("cmd.pullToday"),
			callback: () => void this.pullSlidesCommand(toISODate()),
		});
		this.addCommand({
			id: "pull-canvas-slides-for-date",
			name: t("cmd.pullDate"),
			callback: () => {
				new DateModal(this.app, (date) => void this.pullSlidesCommand(date)).open();
			},
		});
		this.addCommand({
			id: "import-note",
			name: t("cmd.importNote"),
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
			name: t("cmd.splitNote"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) void this.importActiveNote(undefined, true);
				return true;
			},
		});
		this.addCommand({
			id: "import-folder",
			name: t("cmd.importFolder"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || this.session.isBusy) return false;
				if (!checking) void this.importFolder();
				return true;
			},
		});
		this.addCommand({
			id: "rename-course",
			name: t("cmd.renameCourse"),
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				const current = active ? this.courseOfPath(active.path) : "";
				new RenameCourseModal(this.app, this, current, (from, to) => {
					this.renameCourse(from, to).then(
						(r) => new Notice(`Renamed "${from}" to "${to}": ${r.moved ? "folder and course note moved, " : ""}${r.notes} note${r.notes === 1 ? "" : "s"} updated${r.attachments ? `, ${r.attachments} recording${r.attachments === 1 ? "" : "s"} renamed` : ""}.`, 8000),
						(err: Error) => new Notice(`Rename failed: ${err.message}`, 10_000),
					);
				}).open();
			},
		});
		this.addCommand({
			id: "rebuild-course-index",
			name: t("cmd.rebuildIndex"),
			callback: async () => {
				await this.moveCourseNotesIntoFolders();
				const courses = this.vault.coursesInFolder(this.settings.courseFolder).filter((c) => !this.isMeeting(c));
				const meetings = this.meetingFolderSeparate() ? this.vault.coursesInFolder(this.settings.meetingFolder) : [];
				let total = 0;
				for (const c of [...courses, ...meetings]) total += await this.rebuildCourseIndex(c);
				new Notice(`Course notes updated for ${courses.length} course${courses.length === 1 ? "" : "s"}${meetings.length ? ` and ${meetings.length} meeting series` : ""} (${total} notes linked).`);
			},
		});
		this.addCommand({
			id: "move-todos",
			name: t("cmd.moveTodos"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md") return false;
				if (!checking) void this.moveTodosFromNote(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "convert-pptx-in-note",
			name: t("cmd.convertPptx"),
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
			name: t("cmd.chooseSlides"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) void this.chooseSlidesForNote(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "summarize-lecture-note",
			name: t("cmd.summarize"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) {
					const target = this.targetForExistingNote(file.path);
					this.session.summarize(target).then(
						(text) => (text ? new Notice("Summary written.") : undefined),
						(err: Error) => new Notice(`Summary failed: ${err.message}`, 8000),
					);
					void this.activateView();
				}
				return true;
			},
		});
		for (const kind of ["important", "confusing"] as MarkKind[]) {
			this.addCommand({
				id: `mark-${kind}`,
				name: kind === "important" ? t("cmd.markImportant") : t("cmd.markConfusing"),
				checkCallback: (checking) => {
					const s = this.session.status;
					if (s !== "recording" && s !== "paused") return false;
					if (!checking) this.markMoment(kind);
					return true;
				},
			});
		}
		this.addCommand({
			id: "catch-up",
			name: t("cmd.catchUp"),
			checkCallback: (checking) => {
				const s = this.session.status;
				if (s !== "recording" && s !== "paused") return false;
				if (!checking) void this.activateView().then((view) => view?.catchUp());
				return true;
			},
		});
		this.addCommand({
			id: "align-slides",
			name: t("cmd.alignSlides"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) void this.alignSlidesInNote(this.targetForExistingNote(file.path), true).catch((err: Error) => new Notice(`Linking failed: ${err.message}`, 8000));
				return true;
			},
		});
		this.addCommand({
			id: "review-note",
			name: t("cmd.reviewNote"),
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				new ReviewModal(this.app, this, active ? this.courseOfPath(active.path) : "", (choice) => {
					const notice = new Notice("Writing the review note…", 0);
					this.makeReviewNote(choice.course, choice.from, choice.to, choice.overview).then(
						(r) => {
							notice.hide();
							new Notice(`Review note written: ${r.path} (${r.lectures} lecture${r.lectures === 1 ? "" : "s"}).`, 8000);
							void this.vault.open(r.path);
						},
						(err: Error) => {
							notice.hide();
							new Notice(`Review note failed: ${err.message}`, 10_000);
						},
					);
				}).open();
			},
		});
		this.addCommand({
			id: "ask-about-lecture",
			name: t("cmd.askLva"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const path = file instanceof TFile && file.extension === "md" ? file.path : this.session.target?.path;
				if (!path) return false;
				if (!checking) this.askAboutLecture(path);
				return true;
			},
		});
		this.addCommand({ id: "report-problem", name: t("cmd.report"), callback: () => this.openReport() });
		this.addCommand({ id: "setup-checklist", name: t("cmd.setup"), callback: () => this.openSetup() });
		this.addCommand({ id: "try-sample", name: t("cmd.sample"), callback: () => void this.createSample() });
		this.addCommand({ id: "open-backups", name: t("cmd.restoreBackup"), callback: () => void this.revealBackups() });
		this.addCommand({
			id: "transcribe-url",
			name: t("cmd.transcribeUrl"),
			checkCallback: (checking) => {
				if (this.session.isBusy) return false;
				if (!checking) void this.activateView().then((view) => view?.pickUrl());
				return true;
			},
		});
		this.addCommand({
			id: "translate-transcript",
			name: t("cmd.translate"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!(file instanceof TFile) || file.extension !== "md" || this.session.isBusy) return false;
				if (!checking) {
					const notice = new Notice(`Translating to ${this.settings.translateLanguage || "English"}…`, 0);
					this.translateTranscript(this.targetForExistingNote(file.path), (m) => notice.setMessage(m)).then(
						() => notice.hide(),
						(err: Error) => {
							notice.hide();
							new Notice(`Translation failed: ${err.message}`, 10_000);
						},
					);
				}
				return true;
			},
		});
		this.addCommand({ id: "start-whisper-server", name: t("cmd.startServer"), callback: () => void this.startServer().catch((e: Error) => new Notice(e.message, 8000)) });
		this.addCommand({ id: "stop-whisper-server", name: t("cmd.stopServer"), callback: () => this.server.stop() });
		this.addCommand({ id: "agent-conventions", name: t("cmd.agentConventions"), callback: () => void this.syncAgentConventions(true) });

		this.app.workspace.onLayoutReady(() => {
			// One-time move of old course notes into their folders; it runs before the daily pull,
			// which would otherwise create the new course note first and leave the old one behind.
			const moved = this.settings.courseNotesInFolders ? Promise.resolve() : this.migrateCourseNotes();
			void this.syncAgentConventions(false);
			if (this.lms().configured) {
				void this.refreshCourses().catch(() => undefined);
				if (this.settings.autoPullDaily && this.settings.lastCanvasPull !== toISODate()) {
					void moved.then(() => this.pullSlidesCommand(toISODate()));
				}
			}
		});
	}

	onunload(): void {
		setReporter(undefined);
		void this.session.dispose();
		this.server.stop();
	}

	/** Appends the conventions block to AGENT.md when the setting is on and the note exists. */
	async syncAgentConventions(verbose: boolean): Promise<void> {
		if (!this.settings.agentBridge && !verbose) return;
		const file = this.vault.file("AGENT.md");
		if (!file) {
			if (verbose) new Notice("No AGENT.md in the vault root. Create one with Local Vault Agent (Settings → Conventions note → Create) first.", 8000);
			return;
		}
		const block = conventionsBlock({
			courseFolder: this.settings.courseFolder,
			noteMode: this.settings.noteMode,
			dateHeading: this.settings.dateHeading,
			meetingFolder: this.settings.meetingFolder,
		});
		let changed = false;
		try {
			await this.app.vault.process(file, (md) => {
				const res = upsertConventions(md, block);
				changed = res.changed;
				return res.text;
			});
		} catch (err) {
			if (verbose) new Notice(`Could not update AGENT.md: ${(err as Error).message}`, 8000);
			return;
		}
		if (verbose) new Notice(changed ? "Lecture conventions written to AGENT.md." : "AGENT.md already has the current lecture conventions.");
	}

	// ----------------------------------------------------------------- settings

	async loadSettings(): Promise<void> {
		this.settings = migrateSettings((await this.loadData()) as Partial<LectureCompanionSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** The course site slides come from (Canvas, Moodle, or none). */
	lms(): CourseFilesProvider {
		switch (this.settings.lms) {
			case "canvas":
				return this.canvasClient;
			case "moodle":
				return this.moodle;
			default:
				return this.noLms;
		}
	}

	/** The chat server for summaries, flashcards, catch-up, review notes and translation. */
	llm(): ChatClient {
		return this.settings.llmProvider === "openai" ? this.openai : this.ollama;
	}

	/** The chat model of the selected provider. */
	chatModel(): string {
		return this.settings.llmProvider === "openai" ? this.settings.openaiModel.trim() : this.settings.ollamaModel;
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
		this.allCourses = await this.lms().listCourses();
		this.applyHiddenCourses();
		return this.courses;
	}

	/** Hides a Canvas course from the course list, matching and the daily pull (or shows it again). */
	async setCourseHidden(id: number, hidden: boolean): Promise<void> {
		if (!setCourseHidden(this.settings, id, hidden)) return;
		await this.saveSettings();
		this.applyHiddenCourses();
	}

	private applyHiddenCourses(): void {
		this.courses = visibleCourses(this.settings, this.allCourses);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof LectureView) view.refreshCourses();
		}
	}

	/** Names for the course box: Canvas courses under their vault name (alias), typed courses, existing folders and meeting series. */
	courseNames(): string[] {
		const names = new Set<string>();
		for (const c of this.courses) names.add(vaultCourseName(this.settings, c));
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

	// ----------------------------------------------------------- moving notes

	/** The course a vault path belongs to: the first folder under the course or meeting folder. */
	courseOfPath(path: string): string {
		for (const root of [this.settings.courseFolder, this.settings.meetingFolder]) {
			const prefix = `${normalizePath(root)}/`;
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length).split("/");
			return rest.length > 1 ? (rest[0] ?? "") : (rest[0] ?? "").replace(/\.md$/, "");
		}
		return "";
	}

	/** Markdown files that link to any of `paths` (by resolved link), so their links can be fixed after a move. */
	private linkersOf(paths: string[]): string[] {
		const wanted = new Set(paths);
		const out: string[] = [];
		for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
			if (Object.keys(targets).some((t) => wanted.has(t))) out.push(source);
		}
		return out;
	}

	/**
	 * Waits (up to `timeoutMs`) until Obsidian has resolved the links of every note, so
	 * {@link linkersOf} sees all of them. Right after startup the index is still being built, and
	 * its first "resolved" event can come before every note is in it.
	 */
	private async waitForLinkIndex(timeoutMs = 30_000): Promise<void> {
		const started = Date.now();
		const ready = () => this.app.vault.getMarkdownFiles().every((f) => this.app.metadataCache.resolvedLinks[f.path] !== undefined);
		while (!ready() && Date.now() - started < timeoutMs) await new Promise((r) => window.setTimeout(r, 200));
	}

	/** Notes whose text links to one of `paths` by its full vault path (`[[path`, `](path`): found without the link index. */
	private async pathLinkersOf(paths: string[]): Promise<string[]> {
		const needles = paths.flatMap((p) => {
			const s = p.replace(/\.md$/, "");
			return [`[[${s}`, `](${s}`, `](<${s}`, `](${encodeURI(s)}`];
		});
		const out: string[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const md = await this.app.vault.cachedRead(file);
			if (needles.some((n) => md.includes(n))) out.push(file.path);
		}
		return out;
	}

	/**
	 * Moves a note or folder and keeps links pointing at it. Obsidian rewrites links itself when
	 * "Automatically update internal links" is on; otherwise (and as a safety net) the links in
	 * every note that pointed at a moved note are rewritten here. A rename that only changes
	 * letter case goes through a temporary name, since Windows and macOS see both names as one.
	 */
	private async moveWithLinks(item: TAbstractFile, to: string): Promise<void> {
		const dest = normalizePath(to);
		if (item.path === dest) return;
		const notes = item instanceof TFolder ? this.notesUnder(item) : item instanceof TFile && item.extension === "md" ? [item.path] : [];
		const renames = notes.map((p) => ({ from: p, to: dest + p.slice(item.path.length) }));
		// Links found by the index (any form) plus links by full path found in the text, so a link
		// is fixed even if the index has not caught up yet.
		const linkers = [...new Set([...this.linkersOf(notes), ...(await this.pathLinkersOf(notes))])];
		await this.vault.ensureFolder(dest.split("/").slice(0, -1).join("/"));
		if (item.path.toLowerCase() === dest.toLowerCase()) {
			await this.renameQuietly(item, `${dest}.renaming-${Date.now()}`);
		}
		await this.renameQuietly(item, dest);
		const moved = new Map(renames.map((r) => [r.from, r.to]));
		for (const source of linkers) {
			const file = this.vault.file(moved.get(source) ?? source);
			if (!file) continue;
			await this.app.vault.process(file, (md) => renames.reduce((text, r) => retargetLinks(text, r.from.replace(/\.md$/, ""), r.to.replace(/\.md$/, "")), md));
		}
	}

	/**
	 * Renames a file or folder without stopping for a dialog. With Obsidian's "Automatically update
	 * internal links" on, Obsidian renames it and rewrites every link itself. With it off (Obsidian's
	 * default), `fileManager.renameFile` stops and asks "Update links?" and waits for a click, which
	 * would stall a bulk move; the file is renamed directly instead and the caller rewrites links.
	 */
	private async renameQuietly(item: TAbstractFile, dest: string): Promise<void> {
		const autoUpdate = (this.app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("alwaysUpdateLinks") === true;
		if (autoUpdate) await this.app.fileManager.renameFile(item, dest);
		else await this.app.vault.rename(item, dest);
	}

	private notesUnder(folder: TFolder): string[] {
		const out: string[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) out.push(...this.notesUnder(child));
			else if (child instanceof TFile && child.extension === "md") out.push(child.path);
		}
		return out;
	}

	/** Startup: moves the old course notes once (it waits for Obsidian's link index itself). */
	private async migrateCourseNotes(): Promise<void> {
		try {
			const moved = await this.moveCourseNotesIntoFolders();
			this.settings.courseNotesInFolders = true;
			await this.saveSettings();
			if (moved > 0) new Notice(`Lecture Companion moved ${moved} course note${moved === 1 ? "" : "s"} into ${moved === 1 ? "its course folder" : "their course folders"} (links kept).`, 10_000);
		} catch (err) {
			new Notice(`Could not move course notes into their folders: ${(err as Error).message}`, 10_000);
		}
	}

	/**
	 * Moves course notes from before 0.1.19 (`<folder>/<course>.md`, next to the course folder)
	 * into the folder (`<folder>/<course>/<course>.md`). Only notes that have a course folder
	 * beside them, or that carry the plugin's Lectures/Meetings list, are moved; any other note at
	 * the top of the course folder is left alone. Returns how many were moved.
	 */
	async moveCourseNotesIntoFolders(): Promise<number> {
		const roots = [this.settings.courseFolder, ...(this.meetingFolderSeparate() ? [this.settings.meetingFolder] : [])];
		const moves: { file: TFile; dest: string }[] = [];
		for (const root of roots) {
			const folder = this.app.vault.getAbstractFileByPath(normalizePath(root));
			if (!(folder instanceof TFolder)) continue;
			for (const child of [...folder.children]) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const sibling = folder.children.some((c) => c instanceof TFolder && c.name === child.basename);
				const ours = sibling || /^##\s+(Lectures|Meetings)\s*$/m.test(await this.app.vault.cachedRead(child));
				if (!ours) continue;
				const dest = `${folder.path}/${child.basename}/${child.basename}.md`;
				if (this.vault.file(dest)) continue;
				moves.push({ file: child, dest });
			}
		}
		if (moves.length === 0) return 0;
		await this.waitForLinkIndex();
		const paths = moves.map((m) => m.file.path);
		await this.backupNotes([...paths, ...this.linkersOf(paths)], "move course notes");
		for (const m of moves) await this.moveWithLinks(m.file, m.dest);
		return moves.length;
	}

	/**
	 * "Rename a course": renames the course folder and its course note, sets `course:` in its
	 * notes, rewrites links to them, and updates the settings that name the course (a Canvas
	 * alias is added or changed, so new lectures and slide pulls use the new name).
	 */
	async renameCourse(fromName: string, toName: string): Promise<{ moved: boolean; notes: number; attachments: number }> {
		const from = fromName.trim();
		const to = toName.trim();
		if (!from || !to) throw new Error("Both names are needed.");
		if (safeFileName(to) !== to.replace(/\s+/g, " ")) throw new Error(`"${to}" has characters a file name cannot hold (\\ / : * ? " < > | # ^ [ ]).`);
		if (this.session.isBusy && this.session.course.toLowerCase() === from.toLowerCase()) throw new Error("Stop the recording of this course first.");
		await this.waitForLinkIndex();
		await this.moveCourseNotesIntoFolders();
		const root = normalizePath(this.folderFor(from));
		const oldDir = `${root}/${safeFileName(from)}`;
		const newDir = `${root}/${safeFileName(to)}`;
		const folder = this.app.vault.getAbstractFileByPath(oldDir);
		if (oldDir.toLowerCase() !== newDir.toLowerCase() && this.app.vault.getAbstractFileByPath(newDir)) throw new Error(`${newDir} already exists.`);
		if (folder instanceof TFolder) {
			const inside = this.notesUnder(folder);
			await this.backupNotes([...inside, ...this.linkersOf(inside)], `rename ${from}`);
		}
		// Settings first, so isMeeting/folderFor/vault names follow the new name from here on.
		// The Canvas course must be known to save the new name for it; otherwise the next slide pull
		// would file lectures under Canvas's own title again.
		if (this.lms().configured && this.courses.length === 0) await this.refreshCourses().catch(() => undefined);
		const canvasCourse = this.canvasCourseFor(from);
		const aliased = renameCourseInSettings(this.settings, from, to);
		if (!aliased && canvasCourse) setCourseAlias(this.settings, canvasCourse, to);
		await this.saveSettings();
		let notes = 0;
		if (folder instanceof TFolder) {
			const note = this.vault.file(`${oldDir}/${safeFileName(from)}.md`);
			if (note) await this.moveWithLinks(note, `${oldDir}/${safeFileName(to)}.md`);
			await this.moveWithLinks(folder, newDir);
			const renamed = this.app.vault.getAbstractFileByPath(newDir);
			if (renamed instanceof TFolder) {
				for (const path of this.notesUnder(renamed)) {
					const file = this.vault.file(path);
					if (!file) continue;
					let changed = false;
					await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
						if (typeof fm.course === "string" && fm.course.trim().toLowerCase() === from.toLowerCase()) {
							fm.course = to;
							changed = true;
						}
					});
					if (changed) notes++;
				}
			}
		}
		const attachments = await this.renameCourseAttachments(from, to, newDir);
		if (this.session.course.toLowerCase() === from.toLowerCase() && !this.session.isBusy) this.session.reset();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view instanceof LectureView) leaf.view.refreshCourses();
		return { moved: folder instanceof TFolder, notes, attachments };
	}

	/**
	 * Renames the course's recordings (and any other attachment named after the course, e.g.
	 * `<course> <date> <time>.webm`) and points the embeds and links in its notes at the new names.
	 * Looks in the course folder and at every file its notes embed or link (so recordings kept in
	 * Obsidian's own attachment folder are found too). An existing file of the new name is left alone.
	 */
	private async renameCourseAttachments(from: string, to: string, courseDir: string): Promise<number> {
		const dir = this.app.vault.getAbstractFileByPath(courseDir);
		if (!(dir instanceof TFolder)) return 0;
		const notes = this.notesUnder(dir);
		const candidates = new Map<string, TFile>();
		const walk = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
				else if (child instanceof TFile && child.extension !== "md") candidates.set(child.path, child);
			}
		};
		walk(dir);
		for (const path of notes) {
			const file = this.vault.file(path);
			const cache = file ? this.app.metadataCache.getFileCache(file) : null;
			for (const ref of [...(cache?.embeds ?? []), ...(cache?.links ?? [])]) {
				const dest = this.app.metadataCache.getFirstLinkpathDest(ref.link.split("#")[0] ?? "", path);
				if (dest && dest.extension !== "md") candidates.set(dest.path, dest);
			}
		}
		const renamed: { oldName: string; newName: string; oldPath: string }[] = [];
		for (const file of candidates.values()) {
			const newName = renamedAttachment(file.name, from, to);
			if (!newName) continue;
			const dest = normalizePath(`${file.parent?.path ?? ""}/${newName}`);
			if (this.app.vault.getAbstractFileByPath(dest)) continue;
			const oldPath = file.path;
			const oldName = file.name;
			await this.renameQuietly(file, dest);
			renamed.push({ oldName, newName, oldPath });
		}
		if (renamed.length === 0) return 0;
		// Obsidian rewrites links itself when "Automatically update internal links" is on; this is the
		// fallback (and a no-op when it already happened). Notes elsewhere that link the files are fixed too.
		const linkers = new Set([...notes, ...this.linkersOf(renamed.map((r) => r.oldPath))]);
		for (const path of linkers) {
			const file = this.vault.file(path);
			if (!file) continue;
			await this.app.vault.process(file, (md) => renamed.reduce((text, r) => replaceAttachmentRefs(text, r.oldName, r.newName), md));
		}
		return renamed.length;
	}

	// -------------------------------------------------------------------- notes

	noteTargetFor(course: string, date: string): NoteTarget {
		const s = this.settings;
		if (s.noteMode === "per-course-section") {
			const canvasCourse = this.canvasCourseFor(course);
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

	targetForExistingNote(path: string): NoteTarget {
		// A per-course note gets today's date section; a per-lecture note is used as-is.
		if (this.settings.noteMode === "per-course-section" || !/\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) {
			return { path, parentHeading: dateHeading(this.settings.dateHeading, toISODate()) };
		}
		return { path };
	}

	// ------------------------------------------------------------------ 0.2.0

	/**
	 * Words whisper should spell right in this course: the course name and code, its teachers
	 * (Canvas), the extra words from settings, distinctive terms from this lecture's slides (else
	 * the most recent lecture that has slide text), and terms defined in recent summaries.
	 */
	async courseVocabulary(course: string, target: NoteTarget): Promise<string[]> {
		const names = [course];
		const canvasCourse = this.isMeeting(course) ? undefined : this.canvasCourseFor(course);
		if (canvasCourse) names.push(canvasCourse.courseCode, ...(canvasCourse.teachers ?? []));
		names.push(...extraVocabulary(this.settings.vocabularyExtra, course));
		const earlier = this.vault
			.lectureNotePaths(this.folderFor(course), course)
			.filter((p) => /\/\d{4}-\d{2}-\d{2}\.md$/.test(p) && p !== target.path)
			.sort()
			.reverse();
		let slideText = cleanTranscript((await this.vault.readSection(target, SECTION_SLIDES)) ?? "", false);
		const defined: string[] = [];
		for (const [i, path] of earlier.slice(0, 8).entries()) {
			const md = await this.vault.read(path).catch(() => "");
			if (!/^>/m.test(slideText) && i < 3) slideText = cleanTranscript(sectionBody(md, SECTION_SLIDES) ?? "", false);
			defined.push(...definedTerms(sectionBody(md, SECTION_SUMMARY) ?? ""));
		}
		// Only the extracted slide text (the folded callout), not the deck links and Canvas labels.
		const calloutText = slideText.split("\n").filter((l) => l.startsWith(">")).join("\n");
		return buildVocabulary({ names: names.filter(Boolean), defined, slideText: calloutText });
	}

	/** Adds slide links to the note's transcript paragraphs (see core/align). Returns how many. */
	async alignSlidesInNote(target: NoteTarget, verbose: boolean): Promise<number> {
		const transcript = (await this.vault.readSection(target, SECTION_TRANSCRIPT)) ?? "";
		const slides = (await this.vault.readSection(target, SECTION_SLIDES)) ?? "";
		if (!/--- (?:Page|Slide) \d+ ---/.test(slides)) {
			if (verbose) new Notice("No slide text in this note's Slides section to link to (attach a PDF or PowerPoint deck first).", 8000);
			return 0;
		}
		const { text, links } = alignTranscriptToSlides(transcript, slides);
		if (text.trim() !== transcript.trim()) await this.vault.writeSection(target, SECTION_TRANSCRIPT, text, "replace");
		if (verbose) new Notice(links ? `${links} transcript paragraph${links === 1 ? "" : "s"} linked to the slide being discussed.` : "No paragraph matched a slide closely enough to link.", 6000);
		return links;
	}

	/** Puts a ⭐ / ❓ mark in the live transcript (command and panel button). */
	markMoment(kind: MarkKind): void {
		const mark = this.session.mark(kind);
		if (mark) new Notice(`${kind === "important" ? "⭐ Marked important" : "❓ Marked confusing"} at ${formatTimestamp(mark.at)}`, 2500);
	}

	/** The class-time prompt's Record button: opens the panel with the course and today's date, and starts. */
	async recordNow(course: string): Promise<void> {
		if (this.session.isBusy) {
			new Notice("A recording is already running.");
			return;
		}
		const view = await this.activateView();
		if (!view) return;
		await view.recordFor(course, toISODate());
	}

	/** "Ask about this lecture": opens Local Vault Agent's chat about the note, when it is installed. */
	askAboutLecture(path: string): void {
		const lva = this.localVaultAgentApi();
		if (typeof lva?.openChatAbout !== "function") {
			new Notice("Asking about a lecture needs the Local Vault Agent plugin (installed and enabled).", 8000);
			return;
		}
		try {
			void Promise.resolve(lva.openChatAbout(path)).catch((err: Error) => new Notice(`Local Vault Agent: ${err.message}`, 8000));
		} catch (err) {
			new Notice(`Local Vault Agent: ${(err as Error).message}`, 8000);
		}
	}

	/** Local Vault Agent's API object, when that plugin is installed and enabled. */
	localVaultAgentApi(): LocalVaultAgentApi | undefined {
		const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, { api?: unknown } | undefined> } }).plugins?.plugins;
		const api = plugins?.["local-vault-agent"]?.api;
		return api && typeof api === "object" ? api : undefined;
	}

	/** Writes `<course folder>/Review <from>–<to>.md` from the lectures' summaries (and an optional model-written overview). */
	async makeReviewNote(course: string, from: string, to: string, overview: boolean): Promise<{ path: string; lectures: number }> {
		const name = course.trim();
		if (!name) throw new Error("Choose a course.");
		const listed = lecturesInRange(this.lectureIndex.list(name), from, to);
		const lectures: { path: string; date: string; summary: string }[] = [];
		for (const l of listed) {
			const md = await this.vault.read(l.path).catch(() => "");
			lectures.push({ path: l.path, date: l.date, summary: sectionBody(md, SECTION_SUMMARY) ?? "" });
		}
		if (lectures.length === 0) throw new Error(`No lecture notes of ${name} between ${from || "the start"} and ${to || "today"}.`);
		const input = { course: name, from: from || (lectures[0]?.date ?? ""), to: to || toISODate(), lectures };
		let text: string | undefined;
		if (overview) {
			const s = this.settings;
			text = stripThinkTags(
				await this.llm().chat({ model: this.chatModel(), messages: buildReviewOverviewMessages(input, undefined, s.summaryLanguage), options: { num_ctx: s.numCtx, temperature: 0.3 }, keep_alive: "10m", think: false }),
			).trim();
		}
		const path = reviewNotePath(`${normalizePath(this.folderFor(name))}/${safeFileName(name)}`, input.from, input.to);
		await this.vault.write(path, buildReviewNote({ ...input, overview: text }));
		return { path, lectures: lectures.length };
	}

	// ------------------------------------------------------------------ 0.3.0

	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	/** "Canvas" or "Moodle", for messages. */
	lmsName(): string {
		return this.settings.lms === "moodle" ? "Moodle" : this.settings.lms === "canvas" ? "Canvas" : "the course site";
	}

	openSetup(): void {
		new SetupModal(this.app, this).open();
	}

	openReport(summary?: string): void {
		new ReportModal(this.app, this, summary).open();
	}

	/** Vault-relative folder of the plugin's backups. */
	private backupRoot(): string {
		return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/backups`;
	}

	/**
	 * Copies notes into the plugin's backups folder before a bulk move or rename, keeping the
	 * newest backups only. A failure stops the operation: nothing is moved without a copy.
	 */
	async backupNotes(paths: string[], reason: string): Promise<string | null> {
		const files = [...new Set(paths)].filter((p) => this.vault.file(p));
		if (files.length === 0) return null;
		const adapter = this.app.vault.adapter;
		const plan = backupPlan(files, this.backupRoot(), backupStamp(), reason);
		for (const c of plan.copies) {
			const dir = c.to.split("/").slice(0, -1).join("/");
			if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(c.to, await this.vault.read(c.from));
		}
		try {
			const listed = await adapter.list(this.backupRoot());
			for (const name of backupsToPrune(listed.folders.map((f) => f.split("/").pop() ?? f))) await adapter.rmdir(`${this.backupRoot()}/${name}`, true);
		} catch {
			// pruning is best effort
		}
		new Notice(t("notice.backup", { count: files.length, s: files.length === 1 ? "" : "s", folder: plan.folder }), 6000);
		return plan.folder;
	}

	/** Shows the backups folder in the system file manager (desktop). */
	async revealBackups(): Promise<void> {
		const root = this.backupRoot();
		if (!(await this.app.vault.adapter.exists(root))) {
			new Notice("No backups yet: they are made before course notes are moved or a course is renamed.");
			return;
		}
		const full = `${this.vault.pluginDir(this.manifest.id, this.manifest.dir)}/backups`;
		const shell = (window.require?.("electron") as { shell?: { openPath(p: string): Promise<string> } } | undefined)?.shell;
		if (shell) await shell.openPath(full);
		else new Notice(`Backups are in ${root}`, 10_000);
	}

	/** "Try a sample": a lecture note with transcript, slides (a small generated PDF) and summary, no setup needed. */
	async createSample(): Promise<void> {
		const date = toISODate();
		const path = lectureNotePath(this.settings.courseFolder, SAMPLE_COURSE, date);
		const deckPath = normalizePath(`${this.settings.courseFolder}/${SAMPLE_COURSE}/attachments/${SAMPLE_DECK}`);
		if (!this.vault.file(deckPath)) await this.vault.createBinary(deckPath, new TextEncoder().encode(samplePdf()).buffer);
		if (!this.vault.file(path)) await this.vault.write(path, sampleLectureNote(date));
		await this.ensureCourseLink(SAMPLE_COURSE, date, path);
		await this.alignSlidesInNote({ path }, false).catch(() => 0);
		await this.vault.open(path);
		// A real summary when a chat model answers; the hand-written example otherwise.
		const ready = await Promise.race([this.llm().version().then(() => true, () => false), new Promise<boolean>((r) => window.setTimeout(() => r(false), 2500))]);
		if (ready && !this.session.isBusy) {
			new Notice(t("notice.sampleSummarizing"), 6000);
			await this.session.summarize({ path }, { course: SAMPLE_COURSE, date }).catch(() => undefined);
		} else new Notice(t("notice.sampleWritten", { path }), 6000);
	}

	/** Downloads a media file from a direct link (no streaming-site extraction) for transcription. */
	async downloadMedia(url: string, onStatus?: (m: string) => void): Promise<{ name: string; bytes: ArrayBuffer }> {
		if (!isHttpUrl(url)) throw new Error(t("notice.urlBad"));
		const name = mediaFileName(url);
		onStatus?.(t("notice.urlDownloading", { name }));
		const res = await requestUrl({ url: url.trim(), method: "GET", throw: false });
		if (res.status < 200 || res.status >= 300) throw new Error(`The link answered HTTP ${res.status}.`);
		const type = Object.entries(res.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
		if (!isMediaResponse(type, url)) throw new Error(t("notice.urlNotMedia", { type: type || "an unknown type" }));
		return { name: mediaFileName(url, type), bytes: res.arrayBuffer };
	}

	/** "Translate the transcript": the transcript in another language, same timestamps, under its own heading. */
	async translateTranscript(target: NoteTarget, onStatus?: (m: string) => void): Promise<void> {
		const section = (await this.vault.readSection(target, SECTION_TRANSCRIPT)) ?? "";
		const chunks = translationChunks(parseTranscript(section));
		if (chunks.length === 0) throw new Error(t("notice.noTranscript"));
		const language = this.settings.translateLanguage.trim() || "English";
		const out: string[] = [];
		for (const [i, chunk] of chunks.entries()) {
			onStatus?.(`Translating to ${language}: part ${i + 1} of ${chunks.length}…`);
			const text = await this.llm().chat({ model: this.chatModel(), messages: buildTranslateMessages(language, chunk), options: { num_ctx: this.settings.numCtx, temperature: 0.1 }, keep_alive: "10m", think: false });
			out.push(cleanTranslation(stripThinkTags(text)));
		}
		const heading = translatedHeading(language);
		await this.vault.writeSection(target, heading, out.filter(Boolean).join("\n\n"), "replace");
		new Notice(t("notice.translated", { heading }), 6000);
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
		if (!this.lms().configured || this.isMeeting(typed)) return;
		if (this.courses.length === 0) await this.refreshCourses().catch(() => undefined);
		const course = this.canvasCourseFor(typed);
		if (course && addCourseAlias(this.settings, course, typed)) await this.saveSettings();
	}

	/** Called by the session after the transcript is written and before the summary. */
	async matchSlidesForSession(course: string, date: string, target: NoteTarget, transcript: string): Promise<void> {
		if (this.settings.slideMatching === "off") return;
		await this.matchSlides(course, date, target, transcript, this.settings.slideMatching);
	}

	/**
	 * Matches a deck against `text` (transcript or the student's notes) when the Slides section is still empty.
	 * `mode` is what the caller or dialog chose, but "Always" in settings overrides it, so a long import stops
	 * asking the moment the setting changes (the picker's "Always take the best match" button sets it mid-run).
	 */
	async matchSlides(course: string, date: string, target: NoteTarget, text: string, requested: Exclude<SlideMatching, "off">): Promise<void> {
		if (!this.lms().configured || this.isMeeting(course)) return;
		const mode: Exclude<SlideMatching, "off"> = this.settings.slideMatching === "always" ? "always" : requested;
		const existing = cleanTranscript((await this.vault.readSection(target, SECTION_SLIDES)) ?? "", false);
		if (existing) return; // slides already chosen for this lecture
		if (this.courses.length === 0) await this.refreshCourses();
		const canvasCourse = this.canvasCourseFor(course);
		if (!canvasCourse) {
			new Notice(`No course on ${this.lmsName()} matches "${course}"; slides not matched. Add a course name under Settings → Course files if the names differ.`, 8000);
			return;
		}
		const notice = new Notice("Matching slides to the lecture…", 0);
		try {
			const result = await this.matcher.run({ canvasCourse, course, date, target, transcript: text, windowOnly: false, mode, replace: false, offerAutoAccept: true, onStatus: (m) => notice.setMessage(m) });
			notice.hide();
			if (result.attached.length) new Notice(`Attached: ${result.attached.join(", ")}`, 6000);
			else if (!result.skipped && result.candidates === 0) new Notice(`No slide files found in that ${this.lmsName()} course.`, 6000);
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
			{ course: this.courseNames().find((c) => c === folder.name) ?? "", matchSlides: this.settings.slideMatching },
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
		if (!this.lms().configured) {
			new Notice("No course site is set up (optional): choose Canvas or Moodle under Settings → Course files to download slides. Recording and summaries work without it.", 8000);
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
			new Notice(`"${course}" is a meeting series, so it has no course-site slides. Remove it from the meeting list in settings if it is a course.`, 8000);
			return;
		}
		await this.learnCourseAlias(course);
		const canvasCourse = this.canvasCourseFor(course);
		if (!canvasCourse) {
			new Notice(`No course on ${this.lmsName()} matches "${course}". Add a course name under Settings → Course files (course id = ${course}).`, 8000);
			return;
		}
		const transcript = (await this.vault.readSection(target, SECTION_TRANSCRIPT)) ?? "";
		const notice = new Notice("Reading the course's slide decks…", 0);
		try {
			const result = await this.matcher.run({ canvasCourse, course, date, target, transcript, windowOnly: false, mode: "ask", replace: true, onStatus: (m) => notice.setMessage(m) });
			notice.hide();
			if (result.skipped) return;
			if (this.settings.alignSlides && result.attached.length) await this.alignSlidesInNote(target, false).catch(() => 0);
			new Notice(result.attached.length ? `Slides replaced: ${result.attached.join(", ")}. Run "Summarize this lecture note" to refresh the summary.` : "Slides section cleared.", 8000);
			for (const e of result.errors) new Notice(e, 8000);
		} catch (err) {
			notice.hide();
			new Notice(`Choosing slides failed: ${(err as Error).message}`, 8000);
		}
	}

	async pullSlidesCommand(date: string, courseQuery?: string): Promise<void> {
		if (!this.lms().configured) {
			new Notice("No course site is set up (optional): choose Canvas or Moodle under Settings → Course files to download slides. Recording and summaries work without it.", 8000);
			return;
		}
		const notice = new Notice(`Pulling slides from ${this.lmsName()}…`, 0);
		try {
			if (this.courses.length === 0) await this.refreshCourses();
			let courses = this.courses;
			if (courseQuery && this.isMeeting(courseQuery)) {
				notice.hide();
				new Notice(`"${courseQuery}" is a meeting series; there are no course-site slides to pull. Clear the course box to pull for every course.`, 8000);
				return;
			}
			if (courseQuery) {
				const course = this.canvasCourseFor(courseQuery);
				if (!course) {
					notice.hide();
					new Notice(`No active ${this.lmsName()} course matches "${courseQuery}".`);
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
			new Notice(`Slide pull from ${this.lmsName()} failed: ${(err as Error).message}`, 8000);
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
		if (!this.settings.setupShown) {
			this.settings.setupShown = true;
			await this.saveSettings();
			this.openSetup();
		}
		if (view && focusRecord) view.containerEl.querySelector<HTMLInputElement>(".lc-course")?.focus();
		return view;
	}
}

interface LocalVaultAgentApi {
	openChatAbout?: (path: string) => unknown;
	ollama?: () => { url: string; model: string };
}

/** "Make a review note": course, date range, and whether the model writes an overview. */
class ReviewModal extends Modal {
	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
		private current: string,
		private onChoose: (choice: { course: string; from: string; to: string; overview: boolean }) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Make a review note");
		const form = this.contentEl.createDiv({ cls: "lc-import-form" });
		form.createEl("label", { text: "Course" });
		const course = form.createEl("input", { attr: { list: "lc-review-courses", placeholder: "Course", spellcheck: "false" } });
		const list = form.createEl("datalist", { attr: { id: "lc-review-courses" } });
		for (const name of this.plugin.courseNames()) list.createEl("option", { attr: { value: name } });
		course.value = this.current;
		form.createEl("label", { text: "Since" });
		const from = form.createEl("input", { type: "date" });
		from.value = toISODate(new Date(Date.now() - 28 * 86_400_000));
		form.createEl("label", { text: "Until" });
		const to = form.createEl("input", { type: "date" });
		to.value = toISODate();
		const overviewLabel = form.createEl("label", { cls: "lc-meeting" });
		const overview = overviewLabel.createEl("input", { type: "checkbox" });
		overview.checked = true;
		overviewLabel.appendText(" Overview written by the model (Ollama)");
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Writes Review <since>–<until>.md in the course folder: each lecture's one-sentence summary and key points, every term and definition, and the review questions, with links back to the lectures. Clear Since to start at the first lecture.",
		});
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Write review note", cls: "mod-cta" }).addEventListener("click", () => {
			if (!course.value.trim()) {
				new Notice("Choose a course.");
				return;
			}
			this.close();
			this.onChoose({ course: course.value.trim(), from: from.value, to: to.value, overview: overview.checked });
		});
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Asks for the course to rename and its new name. */
class RenameCourseModal extends Modal {
	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
		private current: string,
		private onRename: (from: string, to: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Rename a course");
		const form = this.contentEl.createDiv({ cls: "lc-import-form" });
		form.createEl("label", { text: "Course" });
		const from = form.createEl("input", { attr: { list: "lc-rename-courses", placeholder: "Current name", spellcheck: "false" } });
		const list = form.createEl("datalist", { attr: { id: "lc-rename-courses" } });
		for (const name of this.plugin.courseNames()) list.createEl("option", { attr: { value: name } });
		from.value = this.current;
		form.createEl("label", { text: "New name" });
		const to = form.createEl("input", { attr: { placeholder: "e.g. Advanced Software Engineering", spellcheck: "false" } });
		to.value = this.current;
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Renames the course folder and its course note, sets course: in its notes, keeps links working, and remembers the new name for the course-site course so new lectures and slide pulls use it.",
		});
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const ok = buttons.createEl("button", { text: "Rename", cls: "mod-cta" });
		const submit = () => {
			if (!from.value.trim() || !to.value.trim() || from.value.trim() === to.value.trim()) {
				new Notice("Choose a course and type a different new name.");
				return;
			}
			this.close();
			this.onRename(from.value.trim(), to.value.trim());
		};
		ok.addEventListener("click", submit);
		to.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		window.setTimeout(() => (this.current ? to.select() : from.focus()), 0);
	}

	onClose(): void {
		this.contentEl.empty();
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
