import { Modal, Notice, Platform, Plugin, requestUrl, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { describePull, pullSlides } from "./canvas-pull";
import { CanvasClient, resolveCourse, type CanvasCourse } from "./core/canvas";
import type { HttpRequest } from "./core/http";
import { courseNotePath, dateHeading, lectureNotePath, renderLectureNote, toISODate } from "./core/notes";
import { OllamaClient } from "./core/ollama";
import { locateWhisperServer } from "./core/whisper/locate";
import { findModel, modelPath, VAD_MODEL } from "./core/whisper/models";
import { WhisperServerManager, type ServerConfig, type ServerState } from "./core/whisper/server";
import { cpuCount, nodeLocateDeps, nodeServerDeps } from "./node/deps";
import { LectureSession } from "./session";
import { courseNoteOverride, DEFAULT_SETTINGS, manualCourseList, type LectureCompanionSettings } from "./settings";
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
	modelsDir = "";
	private courses: CanvasCourse[] = [];
	private serverListeners = new Set<(state: ServerState) => void>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.vault = new VaultIO(this.app);
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
			threads: s.threads > 0 ? s.threads : cpuCount(),
			language: s.language,
			vadModelPath: s.useVad ? modelPath(this.modelsDir, VAD_MODEL) : undefined,
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
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	// -------------------------------------------------------------------- notes

	noteTargetFor(course: string, date: string): NoteTarget {
		const s = this.settings;
		if (s.noteMode === "per-course-section") {
			const canvasCourse = this.courses.find((c) => c.name === course);
			const override = courseNoteOverride(s, canvasCourse ?? { name: course });
			return { path: override ?? courseNotePath(s.courseFolder, course), parentHeading: dateHeading(s.dateHeading, date) };
		}
		return { path: lectureNotePath(s.courseFolder, course, date) };
	}

	/** Creates the lecture note skeleton (and the course note link) when missing. */
	async ensureLectureNote(course: string, date: string): Promise<NoteTarget> {
		const target = this.noteTargetFor(course, date);
		if (target.parentHeading) {
			await this.vault.createIfMissing(target.path, `# ${course}\n`);
			return target;
		}
		const created = await this.vault.createIfMissing(target.path, renderLectureNote({ course, date }));
		if (created) {
			const coursePath = courseNotePath(this.settings.courseFolder, course);
			const link = `[[${target.path.replace(/\.md$/, "")}|${date} lecture]]`;
			await this.vault.writeSection({ path: coursePath, parentHeading: dateHeading(this.settings.dateHeading, date) }, "Lectures", `- ${link}`, "append", `# ${course}\n`);
		}
		return target;
	}

	private targetForExistingNote(path: string): NoteTarget {
		// A per-course note gets today's date section; a per-lecture note is used as-is.
		if (this.settings.noteMode === "per-course-section" || !/\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) {
			return { path, parentHeading: dateHeading(this.settings.dateHeading, toISODate()) };
		}
		return { path };
	}

	// ------------------------------------------------------------------- canvas

	async pullSlidesCommand(date: string, courseQuery?: string): Promise<void> {
		if (!this.canvas.configured) {
			new Notice("Set the Canvas URL and access token in settings first.");
			return;
		}
		const notice = new Notice("Pulling slides from Canvas…", 0);
		try {
			let course: CanvasCourse | undefined;
			if (courseQuery) {
				if (this.courses.length === 0) await this.refreshCourses();
				course = resolveCourse(this.courses, courseQuery) ?? undefined;
				if (!course) {
					notice.hide();
					new Notice(`No active Canvas course matches "${courseQuery}".`);
					return;
				}
			}
			const results = await pullSlides(this, { date, course, onStatus: (m) => notice.setMessage(m) });
			this.settings.lastCanvasPull = toISODate();
			await this.saveSettings();
			notice.hide();
			new Notice(describePull(results), 8000);
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
