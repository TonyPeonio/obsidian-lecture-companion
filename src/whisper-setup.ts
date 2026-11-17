// Installing whisper.cpp and downloading models, shared by the settings tab and the setup checklist.

import { type App, Modal } from "obsidian";
import { downloadModel, formatBytes, modelUrl, type ModelEntry } from "./core/whisper/models";
import { INSTALL_SCRIPT_WINDOWS, installerArgs, type WhisperBuild } from "./core/whisper/installer";
import { nodeDownloadDeps, runWindowsInstaller } from "./node/deps";
import { recommendModels, type HardwareInfo, type Recommendation } from "./core/hardware";
import { defaultThreads, detectGpu, ramGb } from "./node/deps";
import { LcNotice as Notice } from "./report-modal";
import type LectureCompanionPlugin from "./main";

/**
 * Runs the bundled installer script in a visible PowerShell window. The plugin itself never
 * downloads or writes an executable: the user starts the script, watches it, and can close it;
 * it fetches the official whisper.cpp release and verifies its checksum. Returns true when started.
 */
export async function installWhisperWindows(plugin: LectureCompanionPlugin, build: WhisperBuild): Promise<boolean> {
	const asset = build === "cuda" ? "whisper-bin-win-cuda-12.4.0-x64.zip (650 MB; needs an NVIDIA driver from 2024 or later)" : "whisper-bin-x64.zip (9 MB)";
	const ok = await new ConfirmModal(
		plugin.app,
		build === "cuda" ? "Install whisper.cpp (GPU build)" : "Install whisper.cpp (CPU build)",
		[
			"A PowerShell window will open and run the installer script that ships with this plugin.",
			`It downloads ${asset} from github.com/ggml-org/whisper.cpp (release b5454), verifies its SHA-256, and unpacks it to %LOCALAPPDATA%\\whisper.cpp.`,
			"Nothing is installed system-wide and no administrator rights are needed. Close the window when it prints \"Installed\", then click Detect.",
		].join("\n"),
		"Open installer",
	).ask();
	if (!ok) return false;
	try {
		const dir = plugin.vault.pluginDir(plugin.manifest.id, plugin.manifest.dir);
		await runWindowsInstaller(dir, INSTALL_SCRIPT_WINDOWS, (p) => installerArgs(p, build));
		if (build === "cuda" && !plugin.settings.extraServerArgs.includes("-fa")) plugin.settings.extraServerArgs = `${plugin.settings.extraServerArgs} -fa`.trim();
		plugin.settings.whisperBinaryPath = "";
		await plugin.saveSettings();
		plugin.server.stop();
		new Notice("The installer is running in a PowerShell window. Click Detect when it says Installed.", 10_000);
		return true;
	} catch (err) {
		new Notice(`Could not start the installer: ${(err as Error).message}`, 10_000);
		return false;
	}
}

/** Asks, then downloads and verifies a model; `onProgress` gets 0..1. Resolves true when installed. */
export async function downloadWhisperModel(plugin: LectureCompanionPlugin, entry: ModelEntry, onProgress: (fraction: number, text: string) => void, signal?: AbortSignal, confirm = true): Promise<boolean> {
	if (confirm) {
		const ok = await new ConfirmModal(plugin.app, "Download Whisper model", `This downloads ${entry.file} (${formatBytes(entry.bytes)}) from\n${modelUrl(entry)}\ninto the plugin folder and verifies its SHA-256. Continue?`).ask();
		if (!ok) return false;
	}
	try {
		await downloadModel(plugin.modelsDir, entry, nodeDownloadDeps(), (received, total) => onProgress(total > 0 ? received / total : 0, `Downloading ${entry.file}: ${formatBytes(received)} of ${formatBytes(total || entry.bytes)}`), signal);
		new Notice(`${entry.file} downloaded and verified.`);
		return true;
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") return false;
		new Notice(`Download failed: ${(err as Error).message}`, 8000);
		return false;
	}
}

let cached: Promise<{ hw: HardwareInfo; rec: Recommendation }> | undefined;

/** This computer's hardware and the models suggested for it (looked up once per session). */
export function machineRecommendation(): Promise<{ hw: HardwareInfo; rec: Recommendation }> {
	cached ??= detectGpu().then((gpu) => {
		const hw: HardwareInfo = { platform: process.platform, arch: process.arch, cpuCores: defaultThreads(), ramGb: ramGb(), gpu };
		return { hw, rec: recommendModels(hw) };
	});
	return cached;
}

export class ConfirmModal extends Modal {
	private resolve?: (ok: boolean) => void;

	constructor(
		app: App,
		private heading: string,
		private message: string,
		private okLabel = "Download",
	) {
		super(app);
	}

	ask(): Promise<boolean> {
		this.open();
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		for (const line of this.message.split("\n")) this.contentEl.createEl("p", { text: line });
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const yes = row.createEl("button", { text: this.okLabel, cls: "mod-cta" });
		yes.addEventListener("click", () => {
			this.resolve?.(true);
			this.resolve = undefined;
			this.close();
		});
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		window.setTimeout(() => yes.focus(), 0);
	}

	onClose(): void {
		this.resolve?.(false);
		this.resolve = undefined;
		this.contentEl.empty();
	}
}
