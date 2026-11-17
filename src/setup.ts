// First-run setup checklist: each requirement with its live status and a button that fixes it,
// models recommended for this computer, a sample lecture to see results at once, and an optional
// one-question survey that only opens a pre-filled GitHub discussion (no network call of its own).

import { type App, Modal, setIcon } from "obsidian";
import { findModel, formatBytes, isModelInstalled } from "./core/whisper/models";
import { installHint, locateWhisperServer } from "./core/whisper/locate";
import { nodeDownloadDeps, nodeLocateDeps } from "./node/deps";
import { REPO_URL } from "./core/report";
import { LMS_LABELS } from "./core/lms";
import { downloadWhisperModel, installWhisperWindows, machineRecommendation } from "./whisper-setup";
import { LcNotice as Notice } from "./report-modal";
import { t } from "./i18n";
import type LectureCompanionPlugin from "./main";

type State = "ok" | "missing" | "optional" | "checking";

interface RowEls {
	icon: HTMLElement;
	status: HTMLElement;
	actions: HTMLElement;
}

/** The survey answer as a pre-filled GitHub Discussions link (the user posts it, or not). */
export function surveyUrl(answer: string): string {
	const title = `Using Lecture Companion for: ${answer}`;
	const body = `I'll use Lecture Companion for: **${answer}**\n\n<!-- Anything else you'd like to share: what you study, what would make it more useful. -->`;
	return `${REPO_URL}/discussions/new?category=general&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export class SetupModal extends Modal {
	private rows = new Map<string, RowEls>();
	private abort = new AbortController();
	private closed = false;

	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("lc-setup-modal");
		this.titleEl.setText(t("setup.title"));
		const c = this.contentEl;
		c.createEl("p", { cls: "setting-item-description", text: t("setup.intro") });
		const rec = c.createDiv({ cls: "lc-setup-rec", attr: { "aria-live": "polite" } });
		rec.setText(`${t("setup.recommended")}: ${t("setup.checking")}`);
		void machineRecommendation().then(({ hw, rec: r }) => {
			rec.empty();
			rec.createEl("strong", { text: `${t("setup.recommended")}: ` });
			rec.appendText(`Whisper ${r.whisperModel}, chat model ${r.chatModel}. ${r.build} (${hw.cpuCores} cores, ${Math.round(hw.ramGb)} GB RAM${hw.gpu.name ? `, ${hw.gpu.name}` : hw.gpu.vendor === "apple" ? ", Apple silicon" : ""})`);
		});
		const list = c.createEl("ul", { cls: "lc-setup-list", attr: { role: "list" } });
		for (const [id, label] of [
			["whisper", t("setup.whisper")],
			["model", t("setup.model")],
			["chat", t("setup.chatServer")],
			["chatModel", t("setup.chatModel")],
			["lms", t("setup.lms")],
			["sample", t("setup.sample")],
		] as const) {
			const li = list.createEl("li", { cls: "lc-setup-row" });
			const icon = li.createSpan({ cls: "lc-setup-icon", attr: { "aria-hidden": "true" } });
			const body = li.createDiv({ cls: "lc-setup-body" });
			body.createDiv({ cls: "lc-setup-label", text: label });
			const status = body.createDiv({ cls: "lc-setup-status", attr: { "aria-live": "polite" } });
			const actions = li.createDiv({ cls: "lc-setup-actions" });
			this.rows.set(id, { icon, status, actions });
		}
		if (!this.plugin.settings.surveyDone) this.renderSurvey(c);
		const buttons = c.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: t("setup.openSettings") }).addEventListener("click", () => {
			this.close();
			this.plugin.openSettings();
		});
		const done = buttons.createEl("button", { text: t("setup.done"), cls: "mod-cta" });
		done.addEventListener("click", () => this.close());
		void this.refresh();
	}

	onClose(): void {
		this.closed = true;
		this.abort.abort();
		this.contentEl.empty();
	}

	private set(id: string, state: State, text: string, actions: { label: string; cta?: boolean; run: (btn: HTMLButtonElement) => unknown }[] = []): void {
		const row = this.rows.get(id);
		if (!row || this.closed) return;
		row.icon.empty();
		setIcon(row.icon, state === "ok" ? "check-circle" : state === "missing" ? "alert-circle" : state === "checking" ? "loader" : "circle-dashed");
		row.icon.className = `lc-setup-icon lc-setup-${state}`;
		row.status.setText(text);
		row.actions.empty();
		for (const a of actions) {
			const btn = row.actions.createEl("button", { text: a.label, cls: a.cta ? "mod-cta" : "" });
			btn.addEventListener("click", () => void a.run(btn));
		}
	}

	async refresh(): Promise<void> {
		for (const id of this.rows.keys()) if (id !== "sample") this.set(id, "checking", t("setup.checking"));
		this.set("sample", "optional", t("setup.sampleDesc"), [{ label: t("setup.trySample"), run: () => { this.close(); void this.plugin.createSample(); } }]);
		this.checkLms();
		await Promise.all([this.checkWhisper(), this.checkModel(), this.checkChat()]);
	}

	private async checkWhisper(): Promise<void> {
		const s = this.plugin.settings;
		if (s.remoteWhisperUrl) return this.set("whisper", "ok", `Remote whisper-server: ${s.remoteWhisperUrl}`);
		const found = await locateWhisperServer(s.whisperBinaryPath, nodeLocateDeps());
		if (found) return this.set("whisper", "ok", t("setup.whisperFound", { path: found }));
		const hint = installHint(process.platform);
		const { hw } = await machineRecommendation();
		const actions: { label: string; cta?: boolean; run: () => unknown }[] = [];
		if (process.platform === "win32") {
			const nvidia = hw.gpu.vendor === "nvidia";
			actions.push({ label: nvidia ? t("setup.installGpu") : t("setup.installCpu"), cta: true, run: () => installWhisperWindows(this.plugin, nvidia ? "cuda" : "cpu") });
		} else if (hint.command) {
			const command = hint.command;
			actions.push({ label: t("setup.copyBrew").replace("brew install whisper-cpp", command), cta: true, run: async () => {
				await navigator.clipboard.writeText(command);
				new Notice(`Copied: ${command}. Paste it into Terminal.`);
			} });
		}
		actions.push({ label: t("setup.guide"), run: () => window.open(hint.guideUrl) }, { label: t("setup.detect"), run: () => this.checkWhisper() });
		this.set("whisper", "missing", `${t("setup.whisperMissing")} ${hint.text}`, actions);
	}

	private async checkModel(): Promise<void> {
		const s = this.plugin.settings;
		if (s.remoteWhisperUrl) return this.set("model", "ok", "The remote server has its own model.");
		const entry = findModel(s.whisperModel);
		const { rec } = await machineRecommendation();
		const useRec = rec.whisperModel !== s.whisperModel ? [{ label: t("setup.use", { model: rec.whisperModel }), run: async () => {
			s.whisperModel = rec.whisperModel;
			await this.plugin.saveSettings();
			this.plugin.server.stop();
			await this.checkModel();
		} }] : [];
		if (!entry) return this.set("model", "missing", `Unknown model "${s.whisperModel}".`, useRec);
		if (await isModelInstalled(this.plugin.modelsDir, entry, nodeDownloadDeps())) return this.set("model", "ok", t("setup.modelInstalled", { model: entry.id }), useRec);
		this.set("model", "missing", t("setup.modelMissing", { model: entry.id, size: formatBytes(entry.bytes) }), [
			{
				label: `${t("setup.download")} (${formatBytes(entry.bytes)})`,
				cta: true,
				run: async (btn: HTMLButtonElement) => {
					btn.disabled = true;
					const status = this.rows.get("model")?.status;
					const ok = await downloadWhisperModel(this.plugin, entry, (_f, text) => status?.setText(text), this.abort.signal, false);
					if (ok) await this.checkModel();
					else btn.disabled = false;
				},
			},
			...useRec,
		]);
	}

	private async checkChat(): Promise<void> {
		const s = this.plugin.settings;
		const ollama = s.llmProvider === "ollama";
		const client = this.plugin.llm();
		const name = ollama ? "Ollama" : "The OpenAI-compatible server";
		try {
			await Promise.race([client.version(), new Promise((_, reject) => window.setTimeout(() => reject(new Error("timed out")), 4000))]);
		} catch {
			this.set("chat", "missing", t("setup.chatUnreachable", { name, url: client.baseUrl }), [
				...(ollama ? [{ label: t("setup.getOllama"), cta: true, run: () => window.open("https://ollama.com/download") }] : []),
				{ label: t("setup.retry"), run: () => this.checkChat() },
			]);
			this.set("chatModel", "missing", "Needs the chat model server first.");
			return;
		}
		this.set("chat", "ok", t("setup.chatReachable", { name: ollama ? "Ollama" : "The server", url: client.baseUrl }));
		const model = this.plugin.chatModel();
		const models = await client.listModels().catch(() => []);
		const { rec } = await machineRecommendation();
		const useRec = ollama && rec.chatModel !== model ? [{ label: t("setup.use", { model: rec.chatModel }), run: async () => {
			s.ollamaModel = rec.chatModel;
			await this.plugin.saveSettings();
			await this.checkChat();
		} }] : [];
		if (!model) return this.set("chatModel", "missing", t("setup.chatModelNone"), [{ label: t("setup.openSettings"), run: () => this.plugin.openSettings() }]);
		if (models.some((m) => m.name === model || m.name === `${model}:latest`)) return this.set("chatModel", "ok", t("setup.chatModelOk", { model }), useRec);
		this.set("chatModel", "missing", t("setup.chatModelMissing", { model }), [
			...(ollama
				? [{
						label: t("setup.pull", { model }),
						cta: true,
						run: async (btn: HTMLButtonElement) => {
							btn.disabled = true;
							const status = this.rows.get("chatModel")?.status;
							try {
								await this.plugin.ollama.pull(model, (st, f) => status?.setText(t("setup.pulling", { model, status: f >= 0 ? `${Math.round(f * 100)}%` : st })), this.abort.signal);
								new Notice(`${model} downloaded.`);
								await this.checkChat();
							} catch (err) {
								if (!(err instanceof Error && err.name === "AbortError")) status?.setText(`Download failed: ${(err as Error).message}`);
								btn.disabled = false;
							}
						},
					}]
				: []),
			...useRec,
		]);
	}

	private checkLms(): void {
		const lms = this.plugin.lms();
		if (lms.configured) this.set("lms", "ok", t("setup.lmsOk", { lms: LMS_LABELS[lms.kind] }));
		else this.set("lms", "optional", t("setup.lmsNone"), [{ label: t("setup.openSettings"), run: () => { this.close(); this.plugin.openSettings(); } }]);
	}

	private renderSurvey(c: HTMLElement): void {
		const box = c.createDiv({ cls: "lc-survey", attr: { role: "group", "aria-label": t("survey.question") } });
		box.createDiv({ cls: "lc-survey-q", text: t("survey.question") });
		const row = box.createDiv({ cls: "lc-survey-options" });
		const finish = async (answer?: string): Promise<void> => {
			this.plugin.settings.surveyDone = true;
			await this.plugin.saveSettings();
			box.remove();
			if (answer) window.open(surveyUrl(answer));
		};
		for (const key of ["survey.lectures", "survey.online", "survey.meetings", "survey.other"] as const) {
			row.createEl("button", { text: t(key) }).addEventListener("click", () => void finish(t(key)));
		}
		row.createEl("button", { text: t("survey.skip"), cls: "mod-muted" }).addEventListener("click", () => void finish());
		box.createDiv({ cls: "setting-item-description", text: t("survey.note") });
	}
}
