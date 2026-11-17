// "Report a problem": a reviewable, editable GitHub issue body. Also the plugin's Notice, which
// records every message in the in-memory log and gives failures a "Report" link.

import { apiVersion, type App, Modal, Notice, Platform } from "obsidian";
import { buildReport, issueUrl, LogBuffer, looksLikeError, redact, type RedactOptions } from "./core/report";
import type LectureCompanionPlugin from "./main";

/** The plugin's log (one per Obsidian window); filled by LcNotice and `logError`. */
export const pluginLog = new LogBuffer();
let reporter: ((summary?: string) => void) | undefined;

/** Set by the plugin on load so a notice's Report link can open the report dialog. */
export function setReporter(fn: ((summary?: string) => void) | undefined): void {
	reporter = fn;
}

export function logError(message: string): void {
	pluginLog.add("error", message);
}

/** A Notice that is logged and, when it reports a failure, carries a "Report" link. */
export class LcNotice extends Notice {
	constructor(message: string | DocumentFragment, duration?: number) {
		super(message, duration);
		const text = typeof message === "string" ? message : (message.textContent ?? "");
		const error = looksLikeError(text);
		pluginLog.add(error ? "error" : "info", text);
		if (error && reporter) {
			const open = reporter;
			const link = this.messageEl.createEl("a", { text: "Report", cls: "lc-report-link", attr: { href: "#", "aria-label": "Report this problem on GitHub (you review the report first)" } });
			link.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.hide();
				open(text);
			});
		}
	}
}

/** Settings that help diagnose a problem; the Canvas/Moodle token and API keys are never included. */
function diagnosticSettings(plugin: LectureCompanionPlugin): Record<string, unknown> {
	const s = plugin.settings;
	return {
		whisperModel: s.whisperModel,
		threads: s.threads,
		language: s.language,
		useVad: s.useVad,
		extraServerArgs: s.extraServerArgs,
		remoteWhisperUrl: s.remoteWhisperUrl ? "(set)" : "",
		whisperBinaryPath: s.whisperBinaryPath,
		audioSource: s.audioSource,
		keepAudio: s.keepAudio,
		chunkSeconds: s.chunkSeconds,
		silenceCutMs: s.silenceCutMs,
		attachmentFolder: s.attachmentFolder,
		lms: s.lms,
		lmsUrl: s.lms === "canvas" ? s.canvasUrl : s.moodleUrl,
		lmsToken: (s.lms === "canvas" ? s.canvasToken : s.moodleToken) ? "(set)" : "(empty)",
		slideMatching: s.slideMatching,
		noteMode: s.noteMode,
		courseFolder: s.courseFolder,
		llmProvider: s.llmProvider,
		llmUrl: s.llmProvider === "ollama" ? s.ollamaUrl : s.openaiUrl,
		model: s.llmProvider === "ollama" ? s.ollamaModel : s.openaiModel,
		numCtx: s.numCtx,
		thinking: s.thinking,
		summarizeOnStop: s.summarizeOnStop,
		summaryLanguage: s.summaryLanguage,
		flashcards: s.flashcards,
		alignSlides: s.alignSlides,
		detectQuestions: s.detectQuestions,
		classReminders: s.classReminders,
	};
}

export function redactionFor(plugin: LectureCompanionPlugin): RedactOptions {
	const adapter = plugin.app.vault.adapter as { getBasePath?: () => string };
	let homeDir: string | undefined;
	try {
		homeDir = (window.require?.("os") as { homedir?: () => string } | undefined)?.homedir?.();
	} catch {
		homeDir = undefined;
	}
	const s = plugin.settings;
	return { vaultPath: adapter.getBasePath?.(), homeDir, secrets: [s.canvasToken, s.moodleToken, s.openaiKey].filter(Boolean) };
}

async function statusLines(plugin: LectureCompanionPlugin): Promise<string[]> {
	const st = plugin.server.state;
	const lines = [`whisper-server: ${st.status}${st.message ? ` (${st.message})` : ""}`, `Recording session: ${plugin.session.status}${plugin.session.error ? ` (${plugin.session.error})` : ""}`];
	try {
		const models = await withTimeout(plugin.llm().listModels(), 3000);
		const model = plugin.chatModel();
		lines.push(`${plugin.settings.llmProvider === "ollama" ? "Ollama" : "OpenAI-compatible server"}: reachable, ${models.length} models, "${model}" ${models.some((m) => m.name === model || m.name === `${model}:latest`) ? "installed" : "NOT installed"}`);
	} catch (err) {
		lines.push(`Chat model server: not reachable (${(err as Error).message})`);
	}
	lines.push(`Course files: ${plugin.lms().configured ? plugin.settings.lms : "not configured"}`);
	return lines;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([p, new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error("timed out")), ms))]);
}

export class ReportModal extends Modal {
	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
		private summary?: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("lc-report-modal");
		this.titleEl.setText("Report a problem");
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "This is the report that would go into a new GitHub issue. Nothing is sent automatically: read it, remove anything you do not want to share, add what happened at the top, then copy it or open GitHub. Tokens, API keys, query strings and your vault and home paths have already been removed.",
		});
		const titleInput = this.contentEl.createEl("input", { cls: "lc-report-title", attr: { type: "text", "aria-label": "Issue title", placeholder: "Short title" } });
		titleInput.value = this.summary ? `Problem: ${this.summary.slice(0, 80)}` : "";
		const area = this.contentEl.createEl("textarea", { cls: "lc-report-body", attr: { "aria-label": "Report (editable)", spellcheck: "false" } });
		area.value = "Collecting status…";
		const p = this.plugin;
		const red = redactionFor(p);
		area.value = buildReport(
			{
				pluginVersion: p.manifest.version,
				obsidianVersion: apiVersion,
				platform: `${Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "other"} (${typeof process !== "undefined" ? `${process.platform} ${process.arch}` : "unknown"})`,
				settings: diagnosticSettings(p),
				status: await statusLines(p),
				log: pluginLog.recent(50),
				serverLog: p.server.stderrTail,
				description: this.summary ? `I saw: "${this.summary}"\n\n<!-- What were you doing when it happened? -->` : undefined,
			},
			red,
		);
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Copy" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(redact(area.value, red)).then(() => new Notice("Report copied."));
		});
		buttons.createEl("button", { text: "Open on GitHub", cls: "mod-cta" }).addEventListener("click", () => {
			const body = redact(area.value, red);
			const { url, complete } = issueUrl(titleInput.value.trim() || "Problem report", body);
			const go = () => window.open(url);
			if (complete) go();
			else void navigator.clipboard.writeText(body).then(() => {
				new Notice("The report is long, so it was copied: paste it into the issue.", 8000);
				go();
			});
		});
		buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
