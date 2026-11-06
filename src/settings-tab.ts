import { type App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { downloadModel, findModel, formatBytes, isModelInstalled, modelUrl, VAD_MODEL, WHISPER_MODELS, type ModelEntry } from "./core/whisper/models";
import { installHint, locateWhisperServer } from "./core/whisper/locate";
import type LectureCompanionPlugin from "./main";
import { MicRecorder } from "./recorder";
import { DEFAULT_SETTINGS, setCourseAlias, vaultCourseName } from "./settings";
import { INSTALL_SCRIPT_WINDOWS, installerArgs, type WhisperBuild } from "./core/whisper/installer";
import { cpuCount, defaultThreads, detectGpu, nodeDownloadDeps, nodeLocateDeps, runWindowsInstaller } from "./node/deps";

export class LectureCompanionSettingTab extends PluginSettingTab {
	private downloading?: AbortController;

	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = (): Promise<void> => this.plugin.saveSettings();

		// ---------------------------------------------------------------- Whisper
		new Setting(containerEl).setName("Whisper (transcription)").setHeading();

		const hint = installHint(process.platform);
		const binarySetting = new Setting(containerEl)
			.setName("whisper-server binary")
			.setDesc("Leave empty to auto-detect (%LOCALAPPDATA%\\whisper.cpp, PATH, Scoop, Homebrew, ~/whisper.cpp). Use the installer below if it is not found.")
			.addText((t) =>
				t.setPlaceholder("auto-detect").setValue(s.whisperBinaryPath).onChange(async (v) => {
					s.whisperBinaryPath = v.trim();
					await save();
				}),
			)
			.addButton((b) =>
				b.setButtonText("Detect").onClick(async () => {
					const found = await locateWhisperServer(s.whisperBinaryPath, nodeLocateDeps());
					detectResult.setText(found ? `Found: ${found}` : "Not found. Install whisper.cpp (below), then try again.");
					detectResult.toggleClass("lc-ok", !!found);
				}),
			);
		const detectResult = binarySetting.descEl.createDiv({ cls: "lc-setting-result" });
		void locateWhisperServer(s.whisperBinaryPath, nodeLocateDeps()).then((found) => {
			detectResult.setText(found ? `Found: ${found}` : "Not found yet.");
			detectResult.toggleClass("lc-ok", !!found);
		});

		const install = new Setting(containerEl).setName("Install whisper.cpp").setDesc("");
		install.descEl.createDiv({ text: hint.text });
		const gpuLine = install.descEl.createDiv({ cls: "lc-setting-result", text: "Checking for a GPU…" });
		void detectGpu().then((gpu) => {
			if (gpu.vendor === "nvidia") {
				gpuLine.setText(`NVIDIA GPU detected${gpu.name ? ` (${gpu.name})` : ""}. Use the GPU build: it transcribes 10× faster than the CPU build and keeps up with any model.`);
				gpuLine.addClass("lc-ok");
			} else if (gpu.vendor === "apple") {
				gpuLine.setText("Apple silicon: the Homebrew build already uses the GPU (Metal).");
			} else {
				gpuLine.setText("No NVIDIA GPU detected: the CPU build is the right one.");
			}
			if (process.platform === "win32") {
				const nvidia = gpu.vendor === "nvidia";
				install.addButton((b) => {
					b.setButtonText(nvidia ? "Install GPU build" : "Install CPU build").setCta().onClick(() => void this.runInstaller(nvidia ? "cuda" : "cpu", detectResult));
				});
				install.addButton((b) => {
					b.setButtonText(nvidia ? "Install CPU build instead" : "Install GPU build (NVIDIA only)").onClick(() => void this.runInstaller(nvidia ? "cpu" : "cuda", detectResult));
				});
			}
			install.addButton((b) => b.setButtonText("Install guide").onClick(() => window.open(hint.guideUrl)));
			if (hint.command && process.platform !== "win32") {
				const command = hint.command;
				install.addButton((b) =>
					b.setButtonText(`Copy "${command}"`).setTooltip(hint.commandNote ?? "").onClick(async () => {
						await navigator.clipboard.writeText(command);
						new Notice(`Copied: ${command}${hint.commandNote ? ` (${hint.commandNote})` : ""}`);
					}),
				);
			}
		});

		const modelSetting = new Setting(containerEl)
			.setName("Model")
			.setDesc("Downloaded once from huggingface.co (ggerganov/whisper.cpp) into the plugin folder and verified by SHA-256.");
		modelSetting.addDropdown((d) => {
			d.selectEl.addClass("lc-model-select");
			for (const m of WHISPER_MODELS) d.addOption(m.id, `${m.id} (${formatBytes(m.bytes)})`);
			d.setValue(s.whisperModel).onChange(async (v) => {
				s.whisperModel = v;
				await save();
				this.plugin.server.stop();
				await refreshModelStatus();
			});
		});
		const modelStatus = modelSetting.descEl.createDiv({ cls: "lc-setting-result" });
		const modelProgress = modelSetting.descEl.createEl("progress", { cls: "lc-download is-hidden", attr: { max: "1", value: "0" } });
		modelSetting.addButton((b) => {
			b.setButtonText("Download model").onClick(() => void this.downloadCurrentModel(modelStatus, modelProgress, b.buttonEl, refreshModelStatus));
		});
		const refreshModelStatus = async (): Promise<void> => {
			const entry = findModel(s.whisperModel);
			if (!entry) {
				modelStatus.setText("Unknown model id.");
				return;
			}
			const installed = await isModelInstalled(this.plugin.modelsDir, entry, nodeDownloadDeps());
			modelStatus.setText(`${entry.note}. ${installed ? "Installed." : `Not downloaded yet (${formatBytes(entry.bytes)}).`}`);
			modelStatus.toggleClass("lc-ok", installed);
		};
		void refreshModelStatus();

		new Setting(containerEl)
			.setName("Threads")
			.setDesc(`CPU threads for whisper-server. 0 = one per physical core (${defaultThreads()} here; ${cpuCount()} logical CPUs). More than the physical core count is usually slower, not faster.`)
			.addText((t) =>
				t.setValue(String(s.threads)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.threads = Number.isFinite(n) && n >= 0 ? n : 0;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Extra whisper-server arguments")
			.setDesc('Advanced. Appended to the command line, e.g. "-fa" (flash attention) on a CUDA build, or "-p 2".')
			.addText((t) =>
				t.setPlaceholder("-fa").setValue(s.extraServerArgs).onChange(async (v) => {
					s.extraServerArgs = v.trim();
					await save();
					this.plugin.server.stop();
				}),
			);

		new Setting(containerEl)
			.setName("Language")
			.setDesc('Two-letter code ("en", "de", …) or "auto".')
			.addText((t) =>
				t.setValue(s.language).onChange(async (v) => {
					s.language = v.trim() || "en";
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Voice activity detection")
			.setDesc("Lets whisper-server skip silence inside each chunk (needs the small Silero VAD model, downloaded on first use).")
			.addToggle((t) =>
				t.setValue(s.useVad).onChange(async (v) => {
					s.useVad = v;
					await save();
					if (v && !(await isModelInstalled(this.plugin.modelsDir, VAD_MODEL, nodeDownloadDeps()))) {
						await this.downloadEntry(VAD_MODEL, modelStatus, modelProgress, undefined);
					}
					this.plugin.server.stop();
				}),
			);

		new Setting(containerEl)
			.setName("Stop server when idle")
			.setDesc("Minutes without a request after which the local whisper-server is stopped to free RAM. 0 keeps it running.")
			.addText((t) =>
				t.setValue(String(s.idleUnloadMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.idleUnloadMinutes = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.idleUnloadMinutes;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Remote whisper-server URL")
			.setDesc("Optional. Use an existing whisper.cpp server (e.g. on another PC over Tailscale, or Docker) instead of starting one here.")
			.addText((t) =>
				t.setPlaceholder("http://100.x.y.z:8080").setValue(s.remoteWhisperUrl).onChange(async (v) => {
					s.remoteWhisperUrl = v.trim();
					await save();
					this.plugin.server.stop();
				}),
			);

		const serverSetting = new Setting(containerEl).setName("Server").setDesc("");
		const serverStatus = serverSetting.descEl.createDiv({ cls: "lc-setting-result" });
		const renderServer = (): void => {
			const st = this.plugin.server.state;
			serverStatus.setText(`${st.status}${st.baseUrl ? ` · ${st.baseUrl}` : ""}${st.message ? ` · ${st.message}` : ""}`);
			serverStatus.toggleClass("lc-ok", st.status === "ready" || st.status === "remote");
		};
		renderServer();
		const unsubServer = this.plugin.onServerState(renderServer);
		this.plugin.register(unsubServer);
		serverSetting
			.addButton((b) =>
				b.setButtonText("Start").onClick(async () => {
					try {
						await this.plugin.startServer();
						new Notice("whisper-server is ready.");
					} catch (err) {
						new Notice((err as Error).message, 8000);
					}
				}),
			)
			.addButton((b) => b.setButtonText("Stop").onClick(() => this.plugin.server.stop()))
			.addButton((b) =>
				b.setButtonText("Show log").onClick(() => {
					new LogModal(this.app, this.plugin.server.stderrTail.join("\n") || "(no output yet)").open();
				}),
			);

		// -------------------------------------------------------------- Recording
		new Setting(containerEl).setName("Recording").setHeading();

		const micSetting = new Setting(containerEl).setName("Microphone").setDesc("Which input to record. Default uses the system default device.");
		micSetting.addDropdown((d) => {
			d.addOption("", "System default");
			d.setValue(s.inputDeviceId);
			void MicRecorder.listInputs().then((inputs) => {
				for (const i of inputs) if (i.id) d.addOption(i.id, i.label);
				d.setValue(s.inputDeviceId);
			});
			d.onChange(async (v) => {
				s.inputDeviceId = v;
				await save();
			});
		});

		new Setting(containerEl)
			.setName("Keep the audio")
			.setDesc("Save an Opus recording next to the note (about 20 MB per hour) and embed it in the transcript.")
			.addToggle((t) =>
				t.setValue(s.keepAudio).onChange(async (v) => {
					s.keepAudio = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Attachment folder")
			.setDesc("Where recordings and downloaded slides are saved. {{notefolder}} is the lecture note's folder, so the default keeps each course's files in Courses/<course>/attachments. Leave empty to use Obsidian's own attachment setting.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.attachmentFolder).setValue(s.attachmentFolder).onChange(async (v) => {
					s.attachmentFolder = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Stop automatically after (minutes)")
			.setDesc("Hard limit on one recording, for the day you forget to press stop. Sleeping the laptop also stops and finishes the recording. 0 = no limit.")
			.addText((t) =>
				t.setValue(String(s.maxRecordingMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.maxRecordingMinutes = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.maxRecordingMinutes;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Stop after silence (minutes)")
			.setDesc("Stop when nobody has spoken for this long. Set it longer than the quiet stretches in your classes (group work, exercises). 0 = never.")
			.addText((t) =>
				t.setValue(String(s.autoStopSilenceMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.autoStopSilenceMinutes = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.autoStopSilenceMinutes;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Maximum chunk length (seconds)")
			.setDesc("Audio is sent to Whisper at pauses, but never later than this. Shorter = text appears sooner, slightly less context per chunk.")
			.addSlider((sl) =>
				sl.setLimits(5, 60, 1).setValue(s.chunkSeconds).onChange(async (v) => {
					s.chunkSeconds = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Pause length that ends a chunk (ms)")
			.addSlider((sl) =>
				sl.setLimits(300, 2000, 50).setValue(s.silenceCutMs).onChange(async (v) => {
					s.silenceCutMs = v;
					await save();
				}),
			);

		// ----------------------------------------------------------------- Notes
		new Setting(containerEl).setName("Notes").setHeading();

		new Setting(containerEl)
			.setName("Course folder")
			.setDesc("Lecture notes go to <folder>/<course>/<date>.md; the course note <folder>/<course>.md links to them.")
			.addText((t) =>
				t.setValue(s.courseFolder).onChange(async (v) => {
					s.courseFolder = v.trim().replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.courseFolder;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Layout")
			.setDesc("One note per lecture (recommended: transcripts are long), or everything under a date heading inside the course note.")
			.addDropdown((d) =>
				d
					.addOption("per-lecture", "One note per lecture")
					.addOption("per-course-section", "Sections in the course note")
					.setValue(s.noteMode)
					.onChange(async (v) => {
						s.noteMode = v === "per-course-section" ? "per-course-section" : "per-lecture";
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Date heading")
			.setDesc("Heading used in the course note for each day. {{date}} becomes YYYY-MM-DD.")
			.addText((t) =>
				t.setValue(s.dateHeading).onChange(async (v) => {
					s.dateHeading = v.trim() || DEFAULT_SETTINGS.dateHeading;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Courses (manual list)")
			.setDesc("One per line, for the course picker when Canvas is not configured. Canvas courses and existing folders are added automatically.")
			.addTextArea((t) =>
				t.setValue(s.manualCourses).onChange(async (v) => {
					s.manualCourses = v;
					await save();
				}),
			);

		// ---------------------------------------------------------------- Canvas
		new Setting(containerEl).setName("Canvas LMS (slides)").setHeading();

		new Setting(containerEl)
			.setName("Canvas URL")
			.setDesc("Your school's Canvas address, e.g. https://school.instructure.com")
			.addText((t) =>
				t.setPlaceholder("https://school.instructure.com").setValue(s.canvasUrl).onChange(async (v) => {
					s.canvasUrl = v.trim().replace(/\/+$/, "");
					await save();
				}),
			);

		const tokenSetting = new Setting(containerEl)
			.setName("Access token")
			.setDesc("Canvas → Account → Settings → Approved Integrations → New Access Token. Stored in this plugin's data.json inside your vault.");
		tokenSetting.addText((t) => {
			t.inputEl.type = "password";
			t.setValue(s.canvasToken).onChange(async (v) => {
				s.canvasToken = v.trim();
				await save();
			});
		});
		const canvasResult = tokenSetting.descEl.createDiv({ cls: "lc-setting-result" });
		tokenSetting.addButton((b) =>
			b.setButtonText("Test").onClick(async () => {
				try {
					const me = await this.plugin.canvas.self();
					const courses = await this.plugin.refreshCourses();
					canvasResult.setText(`Signed in as ${me.name}. ${courses.length} active course${courses.length === 1 ? "" : "s"}: ${courses.map((c) => c.name).join(", ")}`);
					canvasResult.addClass("lc-ok");
					this.display();
				} catch (err) {
					canvasResult.setText((err as Error).message);
					canvasResult.removeClass("lc-ok");
				}
			}),
		);

		new Setting(containerEl)
			.setName("Course note overrides")
			.setDesc("Optional, one per line: `course id or name = Folder/Note.md`. Used with the \"sections in the course note\" layout.")
			.addTextArea((t) =>
				t.setPlaceholder("12345 = Courses/CS101.md").setValue(s.courseNotes).onChange(async (v) => {
					s.courseNotes = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Match slides to the lecture")
			.setDesc("When a recording stops, rank the course's files by overlap with the transcript and by how much they look like a deck (worksheets and syllabi rank low). Ask: show the picker. Auto: attach without asking when one deck clearly wins. Off: never.")
			.addDropdown((d) =>
				d
					.addOption("ask", "Ask (show the picker)")
					.addOption("auto", "Automatic when the match is clear")
					.addOption("off", "Off")
					.setValue(s.slideMatching)
					.onChange(async (v) => {
						s.slideMatching = v === "auto" ? "auto" : v === "off" ? "off" : "ask";
						await save();
					}),
			);

		const convertSetting = new Setting(containerEl)
			.setName("Convert PowerPoint decks to PDF")
			.setDesc("Obsidian shows PDFs inline but can only link a .pptx. Uses PowerPoint (Windows) or LibreOffice if installed; text is still extracted from the original.")
			.addToggle((t) =>
				t.setValue(s.convertPptxToPdf).onChange(async (v) => {
					s.convertPptxToPdf = v;
					await save();
				}),
			);
		const convertStatus = convertSetting.descEl.createDiv({ cls: "lc-setting-result" });
		void this.plugin.pptxConverter().then((c) => {
			convertStatus.setText(c ? `Converter: ${c.kind === "powerpoint" ? "PowerPoint" : "LibreOffice"} (${c.path})` : "No converter found: install LibreOffice (free) or PowerPoint, then restart Obsidian. Decks stay as .pptx until then.");
			convertStatus.toggleClass("lc-ok", !!c);
		});

		new Setting(containerEl)
			.setName("Keep the original .pptx")
			.setDesc("Also save the PowerPoint file next to the PDF.")
			.addToggle((t) =>
				t.setValue(s.keepPptx).onChange(async (v) => {
					s.keepPptx = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Course names in the vault")
			.setDesc("Notes are filed under these names (Courses/<name>/…). By default a course uses its full Canvas title; type a shorter name here, e.g. CSCI578. Whatever you type in the panel's course box is remembered here automatically.")
			.addButton((b) =>
				b.setButtonText("Load courses").onClick(async () => {
					try {
						await this.plugin.refreshCourses();
						renderAliasRows();
					} catch (err) {
						new Notice((err as Error).message, 8000);
					}
				}),
			);
		const aliasRows = containerEl.createDiv({ cls: "lc-alias-rows" });
		const renderAliasRows = (): void => {
			aliasRows.empty();
			const courses = this.plugin.courses;
			if (courses.length === 0) {
				aliasRows.createDiv({ cls: "lc-setting-result", text: s.canvasUrl && s.canvasToken ? 'Click "Load courses" to list your Canvas courses.' : "Set the Canvas URL and token first." });
				return;
			}
			for (const course of courses) {
				const row = new Setting(aliasRows).setName(course.name).setDesc(`${course.courseCode}${course.term ? ` · ${course.term}` : ""} · Canvas id ${course.id}`);
				row.settingEl.addClass("lc-alias-row");
				row.addText((t) => {
					const current = vaultCourseName(s, course);
					t.setPlaceholder(course.name).setValue(current === course.name ? "" : current).onChange(async (v) => {
						setCourseAlias(s, course, v);
						await save();
					});
				});
			}
		};
		renderAliasRows();
		if (s.canvasUrl && s.canvasToken && this.plugin.courses.length === 0) {
			void this.plugin.refreshCourses().then(renderAliasRows).catch(() => undefined);
		}

		new Setting(containerEl)
			.setName("Course names (raw list)")
			.setDesc("The same mapping as text, one per line: `canvas id, code or name = name in the vault`. Edit only if you need a key other than the id.")
			.addTextArea((t) =>
				t.setPlaceholder("12345 = CSCI578").setValue(s.courseAliases).onChange(async (v) => {
					s.courseAliases = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Look back (days)")
			.setDesc("\"Today's\" slides include files changed in the last N days, so decks posted the evening before are picked up. 1 = the chosen day only.")
			.addText((t) =>
				t.setValue(String(s.lookbackDays)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.lookbackDays = Number.isFinite(n) && n >= 1 ? n : DEFAULT_SETTINGS.lookbackDays;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Pull slides automatically once a day")
			.setDesc("When Obsidian starts, fetch today's new PDF/PPTX files from every active course.")
			.addToggle((t) =>
				t.setValue(s.autoPullDaily).onChange(async (v) => {
					s.autoPullDaily = v;
					await save();
				}),
			);

		// ------------------------------------------------------------- Summaries
		new Setting(containerEl).setName("Summaries (Ollama)").setHeading();

		const urlSetting = new Setting(containerEl)
			.setName("Ollama URL")
			.setDesc("Local or over your network, e.g. http://localhost:11434 or a Tailscale address.")
			.addText((t) =>
				t.setPlaceholder(DEFAULT_SETTINGS.ollamaUrl).setValue(s.ollamaUrl).onChange(async (v) => {
					s.ollamaUrl = v.trim() || DEFAULT_SETTINGS.ollamaUrl;
					await save();
				}),
			);
		const ollamaResult = urlSetting.descEl.createDiv({ cls: "lc-setting-result" });
		urlSetting.addButton((b) =>
			b.setButtonText("Test").onClick(async () => {
				try {
					const version = await this.plugin.ollama.version();
					const models = await this.plugin.ollama.listModels();
					ollamaResult.setText(`Ollama ${version} · ${models.length} models: ${models.map((m) => m.name).join(", ")}`);
					ollamaResult.addClass("lc-ok");
				} catch (err) {
					ollamaResult.setText((err as Error).message);
					ollamaResult.removeClass("lc-ok");
				}
			}),
		);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Any chat model you have pulled. Lectures are long; a model with a 32k+ context works best.")
			.addText((t) =>
				t.setValue(s.ollamaModel).onChange(async (v) => {
					s.ollamaModel = v.trim() || DEFAULT_SETTINGS.ollamaModel;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Context window (num_ctx)")
			.setDesc("Tokens the model may read. A one-hour lecture is roughly 10–12k tokens of transcript.")
			.addText((t) =>
				t.setValue(String(s.numCtx)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.numCtx = Number.isFinite(n) && n >= 2048 ? n : DEFAULT_SETTINGS.numCtx;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Thinking")
			.setDesc("For reasoning models (Qwen3, DeepSeek-R1). Off is faster and fine for summaries.")
			.addDropdown((d) =>
				d
					.addOption("off", "Off")
					.addOption("auto", "Model default")
					.addOption("on", "On")
					.setValue(s.thinking)
					.onChange(async (v) => {
						s.thinking = v === "on" ? "on" : v === "auto" ? "auto" : "off";
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Summarize when recording stops")
			.addToggle((t) =>
				t.setValue(s.summarizeOnStop).onChange(async (v) => {
					s.summarizeOnStop = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Extra summary instructions")
			.setDesc("Appended to the summary prompt, e.g. \"Always list formulas\" or \"Write in German\".")
			.addTextArea((t) =>
				t.setValue(s.summaryInstructions).onChange(async (v) => {
					s.summaryInstructions = v;
					await save();
				}),
			);
	}

	/**
	 * Runs the bundled installer script in a visible PowerShell window. The plugin itself never
	 * downloads or writes an executable: the user starts the script, watches it, and can close
	 * it; it fetches the official whisper.cpp release and verifies its checksum.
	 */
	private async runInstaller(build: WhisperBuild, detectResult: HTMLElement): Promise<void> {
		const asset = build === "cuda" ? "whisper-bin-win-cuda-12.4.0-x64.zip (650 MB; needs an NVIDIA driver from 2024 or later)" : "whisper-bin-x64.zip (9 MB)";
		const ok = await new ConfirmModal(
			this.app,
			build === "cuda" ? "Install whisper.cpp (GPU build)" : "Install whisper.cpp (CPU build)",
			[
				"A PowerShell window will open and run the installer script that ships with this plugin.",
				`It downloads ${asset} from github.com/ggml-org/whisper.cpp (release b5454), verifies its SHA-256, and unpacks it to %LOCALAPPDATA%\\whisper.cpp.`,
				"Nothing is installed system-wide and no administrator rights are needed. Close the window when it prints \"Installed\", then click Detect.",
			].join("\n"),
			"Open installer",
		).ask();
		if (!ok) return;
		try {
			const dir = this.plugin.vault.pluginDir(this.plugin.manifest.id, this.plugin.manifest.dir);
			const scriptPath = await runWindowsInstaller(dir, INSTALL_SCRIPT_WINDOWS, (p) => installerArgs(p, build));
			if (build === "cuda" && !this.plugin.settings.extraServerArgs.includes("-fa")) {
				this.plugin.settings.extraServerArgs = `${this.plugin.settings.extraServerArgs} -fa`.trim();
			}
			this.plugin.settings.whisperBinaryPath = "";
			await this.plugin.saveSettings();
			this.plugin.server.stop();
			detectResult.setText(`Installer started (${scriptPath}). When it finishes, click Detect.`);
			detectResult.removeClass("lc-ok");
			new Notice("The installer is running in a PowerShell window. Click Detect when it says Installed.", 10_000);
		} catch (err) {
			new Notice(`Could not start the installer: ${(err as Error).message}`, 10_000);
		}
	}

	private async downloadCurrentModel(status: HTMLElement, progress: HTMLProgressElement, button: HTMLButtonElement, done: () => Promise<void>): Promise<void> {
		const entry = findModel(this.plugin.settings.whisperModel);
		if (!entry) return;
		if (this.downloading) {
			this.downloading.abort();
			return;
		}
		const ok = await new ConfirmModal(
			this.app,
			"Download Whisper model",
			`This downloads ${entry.file} (${formatBytes(entry.bytes)}) from\n${modelUrl(entry)}\ninto the plugin folder and verifies its SHA-256. Continue?`,
		).ask();
		if (!ok) return;
		button.setText("Cancel");
		await this.downloadEntry(entry, status, progress, button);
		button.setText("Download model");
		await done();
	}

	private async downloadEntry(entry: ModelEntry, status: HTMLElement, progress: HTMLProgressElement, button: HTMLButtonElement | undefined): Promise<void> {
		this.downloading = new AbortController();
		progress.removeClass("is-hidden");
		progress.value = 0;
		try {
			await downloadModel(
				this.plugin.modelsDir,
				entry,
				nodeDownloadDeps(),
				(received, total) => {
					progress.value = total > 0 ? received / total : 0;
					status.setText(`Downloading ${entry.file}: ${formatBytes(received)} of ${formatBytes(total || entry.bytes)}`);
				},
				this.downloading.signal,
			);
			status.setText(`Installed: ${entry.file}`);
			status.addClass("lc-ok");
			new Notice(`${entry.file} downloaded and verified.`);
		} catch (err) {
			const cancelled = err instanceof Error && err.name === "AbortError";
			status.setText(cancelled ? "Download cancelled." : `Download failed: ${(err as Error).message}`);
			status.removeClass("lc-ok");
		} finally {
			progress.addClass("is-hidden");
			this.downloading = undefined;
			button?.setText("Download model");
		}
	}
}

class ConfirmModal extends Modal {
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
		const no = row.createEl("button", { text: "Cancel" });
		no.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.resolve?.(false);
		this.resolve = undefined;
		this.contentEl.empty();
	}
}

class LogModal extends Modal {
	constructor(
		app: App,
		private text: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("whisper-server output");
		this.contentEl.createEl("pre", { text: this.text, cls: "lc-log" });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
