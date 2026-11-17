// Settings. Every row is declared once (name, description, how to render its controls) and used
// two ways: Obsidian 1.13+ reads them through getSettingDefinitions(), which also makes every
// setting findable in the settings search; older versions get the same rows from display().

import { type App, Modal, PluginSettingTab, requireApiVersion, Setting, type SettingDefinitionItem } from "obsidian";
import { LcNotice as Notice } from "./report-modal";
import { findModel, formatBytes, isModelInstalled, VAD_MODEL, WHISPER_MODELS } from "./core/whisper/models";
import { installHint, locateWhisperServer } from "./core/whisper/locate";
import type LectureCompanionPlugin from "./main";
import { desktopCapturer, desktopPlatform, MicRecorder } from "./recorder";
import { AUDIO_SOURCE_LABELS, AUDIO_SOURCES, parseAudioSource, systemAudioUnavailable } from "./core/audio/sources";
import { DEFAULT_SETTINGS, setCourseAlias, vaultCourseName, parseSlideMatching, hiddenCourseIds, type LectureCompanionSettings } from "./settings";
import { parseWeeklySchedule } from "./core/schedule";
import { LMS_LABELS, parseLms } from "./core/lms";
import { cpuCount, defaultThreads, detectGpu, nodeDownloadDeps, nodeLocateDeps } from "./node/deps";
import { downloadWhisperModel, installWhisperWindows, machineRecommendation } from "./whisper-setup";
import { t, type MessageKey } from "./i18n";

interface Row {
	name: string;
	desc?: string;
	visible?: () => boolean;
	/** Adds the controls; may return a cleanup function. */
	render: (setting: Setting) => unknown;
}

interface Section {
	heading: MessageKey;
	rows: Row[];
	visible?: () => boolean;
}

type NumberKey = { [K in keyof LectureCompanionSettings]: LectureCompanionSettings[K] extends number ? K : never }[keyof LectureCompanionSettings];
type BoolKey = { [K in keyof LectureCompanionSettings]: LectureCompanionSettings[K] extends boolean ? K : never }[keyof LectureCompanionSettings];
/** Keys of plain string settings (not the ones restricted to a few values). */
type StringKey = { [K in keyof LectureCompanionSettings]: string extends LectureCompanionSettings[K] ? K : never }[keyof LectureCompanionSettings];

export class LectureCompanionSettingTab extends PluginSettingTab {
	private downloading?: AbortController;

	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
	) {
		super(app, plugin);
	}

	private get s(): LectureCompanionSettings {
		return this.plugin.settings;
	}

	private save = (): Promise<void> => this.plugin.saveSettings();

	/** Re-evaluates which rows are visible (a dropdown changed what applies). */
	private refreshRows(): void {
		if (requireApiVersion("1.13.0")) this.refreshDomState();
		else this.display();
	}

	/** Re-renders everything (new data to show, e.g. after loading courses). */
	private rerender(): void {
		if (requireApiVersion("1.13.0")) this.update();
		else this.display();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((sec) => ({
			type: "group" as const,
			heading: t(sec.heading),
			visible: sec.visible,
			items: sec.rows.map((r) => ({
				name: r.name,
				desc: r.desc,
				visible: r.visible,
				render: (setting: Setting) => {
					setting.setName(r.name);
					if (r.desc) setting.setDesc(r.desc);
					const cleanup = r.render(setting);
					return typeof cleanup === "function" ? (cleanup as () => void) : undefined;
				},
			})),
		}));
	}

	/** For Obsidian before 1.13 (and as the declarative API's fallback). */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const sec of this.sections()) {
			if (sec.visible && !sec.visible()) continue;
			new Setting(containerEl).setName(t(sec.heading)).setHeading();
			for (const r of sec.rows) {
				if (r.visible && !r.visible()) continue;
				const setting = new Setting(containerEl).setName(r.name);
				if (r.desc) setting.setDesc(r.desc);
				r.render(setting);
			}
		}
	}

	// ------------------------------------------------------------- helpers

	private text(key: StringKey, opts: { placeholder?: string; trim?: boolean; fallback?: string; after?: () => void } = {}): (st: Setting) => void {
		return (st) =>
			st.addText((c) =>
				c.setPlaceholder(opts.placeholder ?? "").setValue(this.s[key]).onChange(async (v) => {
					const value = opts.trim === false ? v : v.trim();
					this.s[key] = value || (opts.fallback ?? "");
					await this.save();
					opts.after?.();
				}),
			);
	}

	private area(key: StringKey, placeholder = "", after?: () => void): (st: Setting) => void {
		return (st) =>
			st.addTextArea((c) =>
				c.setPlaceholder(placeholder).setValue(this.s[key]).onChange(async (v) => {
					this.s[key] = v;
					await this.save();
					after?.();
				}),
			);
	}

	private toggle(key: BoolKey, after?: (v: boolean) => void | Promise<void>): (st: Setting) => void {
		return (st) =>
			st.addToggle((c) =>
				c.setValue(this.s[key]).onChange(async (v) => {
					this.s[key] = v;
					await this.save();
					await after?.(v);
				}),
			);
	}

	private number(key: NumberKey, min: number, after?: () => void): (st: Setting) => void {
		return (st) =>
			st.addText((c) => {
				c.inputEl.type = "number";
				c.inputEl.min = String(min);
				c.setValue(String(this.s[key])).onChange(async (v) => {
					const n = parseInt(v, 10);
					this.s[key] = Number.isFinite(n) && n >= min ? n : DEFAULT_SETTINGS[key];
					await this.save();
					after?.();
				});
			});
	}

	private result(st: Setting): HTMLElement {
		return st.descEl.createDiv({ cls: "lc-setting-result", attr: { "aria-live": "polite" } });
	}

	// ------------------------------------------------------------ sections

	private sections(): Section[] {
		const s = this.s;
		const lmsOn = () => s.lms !== "none";
		const ollama = () => s.llmProvider === "ollama";
		return [
			{ heading: "h.help", rows: this.helpRows() },
			{ heading: "h.whisper", rows: this.whisperRows() },
			{
				heading: "h.recording",
				rows: [
					{
						name: "Audio source",
						desc: "Microphone for a lecture in the room. \"This computer's audio\" records what the computer plays (a Zoom or Teams lecture, a YouTube video) without a microphone; \"Both\" mixes the two for a hybrid class.",
						render: (st) => {
							const note = st.descEl.createDiv({ cls: "lc-setting-note" });
							const describe = (): void => {
								const source = parseAudioSource(s.audioSource);
								const why = source === "microphone" ? undefined : systemAudioUnavailable(desktopPlatform(), desktopCapturer() !== undefined);
								note.setText(why ?? (source === "microphone" ? "" : "Mute notification sounds while recording: everything the computer plays is transcribed."));
							};
							st.addDropdown((d) => {
								for (const key of AUDIO_SOURCES) d.addOption(key, AUDIO_SOURCE_LABELS[key]);
								d.setValue(parseAudioSource(s.audioSource)).onChange(async (v) => {
									s.audioSource = parseAudioSource(v);
									describe();
									await this.save();
								});
							});
							describe();
						},
					},
					{
						name: "Microphone",
						desc: "Which input to record for the Microphone and Both sources. A loopback device (Stereo Mix, VB-Cable, BlackHole, a PulseAudio monitor) listed here records the computer's output on any platform.",
						render: (st) =>
							st.addDropdown((d) => {
								d.addOption("", "System default").setValue(s.inputDeviceId);
								void MicRecorder.listInputs().then((inputs) => {
									for (const i of inputs) if (i.id) d.addOption(i.id, i.label);
									d.setValue(s.inputDeviceId);
								});
								d.onChange(async (v) => {
									s.inputDeviceId = v;
									await this.save();
								});
							}),
					},
					{ name: "Keep the audio", desc: "Save an Opus recording next to the note (about 20 MB per hour) and embed it in the transcript; click a timestamp to play from there.", render: this.toggle("keepAudio") },
					{
						name: "Attachment folder",
						desc: "Where recordings and downloaded slides are saved. {{notefolder}} is the lecture note's folder, so the default keeps each course's files in Courses/<course>/attachments. Leave empty to use Obsidian's own attachment setting.",
						render: this.text("attachmentFolder", { placeholder: DEFAULT_SETTINGS.attachmentFolder }),
					},
					{ name: "Stop automatically after (minutes)", desc: "Hard limit on one recording, for the day you forget to press stop. Sleeping the laptop also stops and finishes the recording. 0 = no limit.", render: this.number("maxRecordingMinutes", 0) },
					{ name: "Stop after silence (minutes)", desc: "Stop when nobody has spoken for this long. Set it longer than the quiet stretches in your classes (group work, exercises). 0 = never.", render: this.number("autoStopSilenceMinutes", 0) },
					{
						name: "Mark questions from class",
						desc: "Prefix short turns that end in a question mark and come after a pause with **Q:** in the transcript, and list them under Questions from class in the summary. Speakers are not identified: a question the lecturer asks the room can be marked too, and a question that runs straight into the answer is missed.",
						render: this.toggle("detectQuestions"),
					},
					{ name: "Catch me up (minutes)", desc: "The panel's Catch me up button summarizes this many minutes of the live transcript. Shown in the panel only; Add to My notes keeps it.", render: this.number("catchUpMinutes", 1) },
					{
						name: "Maximum chunk length (seconds)",
						desc: "Audio is sent to Whisper at pauses, but never later than this. Shorter = text appears sooner, slightly less context per chunk.",
						render: (st) =>
							st.addSlider((sl) =>
								sl.setLimits(5, 60, 1).setValue(s.chunkSeconds).onChange(async (v) => {
									s.chunkSeconds = v;
									await this.save();
								}),
							),
					},
					{
						name: "Pause length that ends a chunk (ms)",
						render: (st) =>
							st.addSlider((sl) =>
								sl.setLimits(300, 2000, 50).setValue(s.silenceCutMs).onChange(async (v) => {
									s.silenceCutMs = v;
									await this.save();
								}),
							),
					},
				],
			},
			{
				heading: "h.reminders",
				rows: [
					{ name: "Ask to record when a class starts", desc: "A couple of minutes before a class: \"Machine Learning starts in 2 min. Record?\" Record opens the panel with the course and today's date and starts; nothing is ever recorded without that click.", render: this.toggle("classReminders") },
					{
						name: "Weekly class schedule",
						desc: "One class per line: `Course = days start-end`, e.g. `Machine Learning = Mon Wed Fri 10:00-10:50` or `Algorithms = TTh 2pm-3:15pm`. Use the course's name in the vault.",
						render: (st) => {
							const out = this.result(st);
							const describe = (): void => {
								const parsed = parseWeeklySchedule(s.classSchedule);
								out.setText(parsed.errors.length ? `Not understood: ${parsed.errors.join(" · ")}` : parsed.classes.length ? `${parsed.classes.length} class${parsed.classes.length === 1 ? "" : "es"}.` : "");
								out.toggleClass("lc-ok", parsed.errors.length === 0 && parsed.classes.length > 0);
							};
							this.area("classSchedule", "Machine Learning = Mon Wed Fri 10:00-10:50", describe)(st);
							describe();
						},
					},
					{
						name: "Use the course calendar",
						desc: "Also take class times from your courses' Canvas calendar events (timed events of 20 minutes to 4 hours). Many courses do not put class meetings there; the weekly schedule works without a course site.",
						visible: () => s.lms === "canvas",
						render: this.toggle("classRemindersCanvas"),
					},
					{ name: "Ask this many minutes before", render: this.number("reminderLeadMinutes", 1) },
				],
			},
			{
				heading: "h.notes",
				rows: [
					{ name: "Course folder", desc: "Lecture notes go to <folder>/<course>/<date>.md; the course note <folder>/<course>/<course>.md, in the same folder, links to them.", render: this.text("courseFolder", { fallback: DEFAULT_SETTINGS.courseFolder }) },
					{
						name: "Layout",
						desc: "One note per lecture (recommended: transcripts are long), or everything under a date heading inside the course note.",
						render: (st) =>
							st.addDropdown((d) =>
								d
									.addOption("per-lecture", "One note per lecture")
									.addOption("per-course-section", "Sections in the course note")
									.setValue(s.noteMode)
									.onChange(async (v) => {
										s.noteMode = v === "per-course-section" ? "per-course-section" : "per-lecture";
										await this.save();
									}),
							),
					},
					{ name: "Date heading", desc: "Heading used in the course note for each day. {{date}} becomes YYYY-MM-DD.", render: this.text("dateHeading", { fallback: DEFAULT_SETTINGS.dateHeading }) },
					{ name: "Courses (manual list)", desc: "One per line, for the course picker. Course-site courses and existing folders are added automatically; without a course site, this list is your course picker.", render: this.area("manualCourses") },
					{
						name: "Tell Local Vault Agent about lecture notes",
						desc: "When AGENT.md exists in the vault root, append a short block (between markers, once) describing the lecture note shape so the agent can answer \"what did the professor say about X, and when\" with the transcript timestamp and a link.",
						render: (st) => {
							this.toggle("agentBridge", async (v) => {
								if (v) await this.plugin.syncAgentConventions(true);
							})(st);
							st.addButton((b) => b.setButtonText("Update now").onClick(() => void this.plugin.syncAgentConventions(true)));
						},
					},
				],
			},
			{
				heading: "h.meetings",
				rows: [
					{ name: "Meeting folder", desc: "Work, club and other meetings go to <folder>/<name>/<date>.md, with a series note <folder>/<name>/<name>.md that lists them and keeps the TODO list.", render: this.text("meetingFolder", { fallback: DEFAULT_SETTINGS.meetingFolder }) },
					{
						name: "Meeting series",
						desc: "One name per line. These are never looked up on the course site; the summary lists decisions and action items, and action items are added to the series TODO list. Ticking Meeting in the panel adds a name here.",
						render: this.area("meetings"),
					},
				],
			},
			{ heading: "h.lms", rows: this.lmsRows(lmsOn) },
			{ heading: "h.summaries", rows: this.summaryRows(ollama) },
			{
				heading: "h.languages",
				rows: [
					{ name: "Summary language", desc: "Language of summaries, flashcards, catch-ups and review notes. Empty = the language of the lecture. Write it out, e.g. English, Deutsch, Español.", render: this.text("summaryLanguage", { placeholder: "Same as the lecture" }) },
					{ name: "Translate transcripts to", desc: "Target language of the command \"Translate the transcript of this note\", which adds a translated copy of the transcript (same timestamps) under its own heading, using the chat model.", render: this.text("translateLanguage", { placeholder: "English", fallback: "English" }) },
					{ name: "Interface language", desc: "The plugin follows Obsidian's language. Only English is translated so far; contributions are welcome (see i18n-en.ts in the repository).", render: () => undefined },
				],
			},
		];
	}

	private helpRows(): Row[] {
		return [
			{
				name: "Setup checklist",
				desc: "What is installed and what is missing, with a button to fix each, and models recommended for this computer.",
				render: (st) => {
					st.addButton((b) => b.setButtonText(t("cmd.setup")).setCta().onClick(() => this.plugin.openSetup()));
					st.addButton((b) => b.setButtonText(t("setup.trySample")).onClick(() => void this.plugin.createSample()));
				},
			},
			{
				name: "Report a problem",
				desc: "Opens a report you review and edit (versions, status, settings without secrets, recent errors), then copy or open as a GitHub issue. Nothing is sent automatically.",
				render: (st) => st.addButton((b) => b.setButtonText("Report a problem").onClick(() => this.plugin.openReport())),
			},
		];
	}

	private whisperRows(): Row[] {
		const s = this.s;
		const hint = installHint(process.platform);
		let detectResult: HTMLElement | undefined;
		const detect = async (): Promise<void> => {
			const found = await locateWhisperServer(s.whisperBinaryPath, nodeLocateDeps());
			detectResult?.setText(found ? `Found: ${found}` : "Not found. Install whisper.cpp (below), then try again.");
			detectResult?.toggleClass("lc-ok", !!found);
		};
		return [
			{
				name: "whisper-server binary",
				desc: "Leave empty to auto-detect (%LOCALAPPDATA%\\whisper.cpp, PATH, Scoop, Homebrew, ~/whisper.cpp). Use the installer below if it is not found.",
				render: (st) => {
					detectResult = this.result(st);
					this.text("whisperBinaryPath", { placeholder: "auto-detect" })(st);
					st.addButton((b) => b.setButtonText("Detect").onClick(() => void detect()));
					void detect();
				},
			},
			{
				name: "Install whisper.cpp",
				desc: hint.text,
				render: (st) => {
					const gpuLine = this.result(st);
					gpuLine.setText("Checking for a GPU…");
					void detectGpu().then((gpu) => {
						if (gpu.vendor === "nvidia") {
							gpuLine.setText(`NVIDIA GPU detected${gpu.name ? ` (${gpu.name}${gpu.vramGb ? `, ${Math.round(gpu.vramGb)} GB` : ""})` : ""}. Use the GPU build: it transcribes 10× faster than the CPU build and keeps up with any model.`);
							gpuLine.addClass("lc-ok");
						} else if (gpu.vendor === "apple") {
							gpuLine.setText("Apple silicon: the Homebrew build (brew install whisper-cpp) uses the GPU through Metal. Nothing else to set.");
							gpuLine.addClass("lc-ok");
						} else gpuLine.setText("No NVIDIA GPU detected: the CPU build is the right one.");
						if (process.platform === "win32") {
							const nvidia = gpu.vendor === "nvidia";
							st.addButton((b) => b.setButtonText(nvidia ? "Install GPU build" : "Install CPU build").setCta().onClick(() => void installWhisperWindows(this.plugin, nvidia ? "cuda" : "cpu")));
							st.addButton((b) => b.setButtonText(nvidia ? "Install CPU build instead" : "Install GPU build (NVIDIA only)").onClick(() => void installWhisperWindows(this.plugin, nvidia ? "cpu" : "cuda")));
						}
						st.addButton((b) => b.setButtonText("Install guide").onClick(() => window.open(hint.guideUrl)));
						if (hint.command && process.platform !== "win32") {
							const command = hint.command;
							st.addButton((b) =>
								b.setButtonText(`Copy "${command}"`).onClick(async () => {
									await navigator.clipboard.writeText(command);
									new Notice(`Copied: ${command}${hint.commandNote ? ` (${hint.commandNote})` : ""}`);
								}),
							);
						}
					});
				},
			},
			{
				name: "Model",
				desc: "Downloaded once from huggingface.co (ggerganov/whisper.cpp) into the plugin folder and verified by SHA-256.",
				render: (st) => {
					const status = this.result(st);
					const recommended = this.result(st);
					const progress = st.descEl.createEl("progress", { cls: "lc-download is-hidden", attr: { max: "1", value: "0", "aria-label": "Download progress" } });
					const refresh = async (): Promise<void> => {
						const entry = findModel(s.whisperModel);
						if (!entry) return void status.setText("Unknown model id.");
						const installed = await isModelInstalled(this.plugin.modelsDir, entry, nodeDownloadDeps());
						status.setText(`${entry.note}. ${installed ? "Installed." : `Not downloaded yet (${formatBytes(entry.bytes)}).`}`);
						status.toggleClass("lc-ok", installed);
					};
					st.addDropdown((d) => {
						d.selectEl.addClass("lc-model-select");
						for (const m of WHISPER_MODELS) d.addOption(m.id, `${m.id} (${formatBytes(m.bytes)})`);
						d.setValue(s.whisperModel).onChange(async (v) => {
							s.whisperModel = v;
							await this.save();
							this.plugin.server.stop();
							await refresh();
						});
					});
					st.addButton((b) => {
						b.setButtonText("Download model").onClick(async () => {
							if (this.downloading) return this.downloading.abort();
							const entry = findModel(s.whisperModel);
							if (!entry) return;
							this.downloading = new AbortController();
							b.setButtonText("Cancel");
							progress.removeClass("is-hidden");
							await downloadWhisperModel(this.plugin, entry, (f, text) => {
								progress.value = f;
								status.setText(text);
							}, this.downloading.signal);
							this.downloading = undefined;
							progress.addClass("is-hidden");
							b.setButtonText("Download model");
							await refresh();
						});
					});
					void machineRecommendation().then(({ rec }) => recommended.setText(`Recommended for this computer: ${rec.whisperModel}. ${rec.whisperWhy}`));
					void refresh();
				},
			},
			{ name: "Threads", desc: `CPU threads for whisper-server. 0 = one per physical core (${defaultThreads()} here; ${cpuCount()} logical CPUs). More than the physical core count is usually slower, not faster.`, render: this.number("threads", 0) },
			{ name: "Extra whisper-server arguments", desc: 'Advanced. Appended to the command line, e.g. "-fa" (flash attention) on a CUDA build, or "-p 2".', render: this.text("extraServerArgs", { placeholder: "-fa", after: () => this.plugin.server.stop() }) },
			{ name: "Language", desc: 'Two-letter code ("en", "de", …) or "auto".', render: this.text("language", { fallback: "en" }) },
			{
				name: "Course vocabulary",
				desc: "Tell Whisper the words of the course before each chunk: the course name and code, its teachers, distinctive terms from this lecture's slides (else the last lecture's) and terms defined in recent summaries. Names and jargon are spelled right more often. At most 80 words, so the transcript's last sentence still fits Whisper's prompt.",
				render: this.toggle("whisperVocabulary"),
			},
			{ name: "Extra vocabulary", desc: "Words Whisper keeps getting wrong, one line per course: `Machine Learning = Prof. Nguyen, Kullback-Leibler, softmax`. A line without = applies to every course.", render: this.area("vocabularyExtra", "Machine Learning = Prof. Nguyen, Kullback-Leibler") },
			{
				name: "Voice activity detection",
				desc: "Lets whisper-server skip silence inside each chunk (needs the small Silero VAD model, downloaded on first use).",
				render: this.toggle("useVad", async (v) => {
					if (v && !(await isModelInstalled(this.plugin.modelsDir, VAD_MODEL, nodeDownloadDeps()))) await downloadWhisperModel(this.plugin, VAD_MODEL, () => undefined, undefined, false);
					this.plugin.server.stop();
				}),
			},
			{ name: "Stop server when idle", desc: "Minutes without a request after which the local whisper-server is stopped to free RAM. 0 keeps it running.", render: this.number("idleUnloadMinutes", 0) },
			{ name: "Remote whisper-server URL", desc: "Optional. Use an existing whisper.cpp server (e.g. on another PC over Tailscale, or Docker) instead of starting one here.", render: this.text("remoteWhisperUrl", { placeholder: "http://100.x.y.z:8080", after: () => this.plugin.server.stop() }) },
			{
				name: "Server",
				render: (st) => {
					const out = this.result(st);
					const render = (): void => {
						const state = this.plugin.server.state;
						out.setText(`${state.status}${state.baseUrl ? ` · ${state.baseUrl}` : ""}${state.message ? ` · ${state.message}` : ""}`);
						out.toggleClass("lc-ok", state.status === "ready" || state.status === "remote");
					};
					render();
					const unsub = this.plugin.onServerState(render);
					st.addButton((b) =>
						b.setButtonText("Start").onClick(async () => {
							try {
								await this.plugin.startServer();
								new Notice("whisper-server is ready.");
							} catch (err) {
								new Notice((err as Error).message, 8000);
							}
						}),
					);
					st.addButton((b) => b.setButtonText("Stop").onClick(() => this.plugin.server.stop()));
					st.addButton((b) => b.setButtonText("Show log").onClick(() => new LogModal(this.app, this.plugin.server.stderrTail.join("\n") || "(no output yet)").open()));
					return () => void unsub();
				},
			},
		];
	}

	private lmsRows(lmsOn: () => boolean): Row[] {
		const s = this.s;
		const test = (st: Setting): void => {
			const out = this.result(st);
			st.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					try {
						const me = await this.plugin.lms().self();
						const courses = await this.plugin.refreshCourses();
						out.setText(`Signed in as ${me.name}. ${courses.length} active course${courses.length === 1 ? "" : "s"}: ${courses.map((c) => c.name).join(", ")}`);
						out.addClass("lc-ok");
					} catch (err) {
						out.setText((err as Error).message);
						out.removeClass("lc-ok");
					}
				}),
			);
		};
		const password = (key: "canvasToken" | "moodleToken") => (st: Setting) =>
			st.addText((c) => {
				c.inputEl.type = "password";
				c.setValue(s[key]).onChange(async (v) => {
					s[key] = v.trim();
					await this.save();
				});
			});
		return [
			{
				name: "Course site",
				desc: "Optional. Lecture Companion records, transcribes and summarizes without one; a course site adds automatic slide downloads and matching. Brightspace (D2L), Blackboard and Google Classroom are not supported yet: they only allow apps registered by your school (or Google), not personal tokens.",
				render: (st) =>
					st.addDropdown((d) => {
						for (const [k, label] of Object.entries(LMS_LABELS)) d.addOption(k, label);
						d.setValue(s.lms).onChange(async (v) => {
							s.lms = parseLms(v);
							this.plugin.courses = [];
							this.plugin.allCourses = [];
							await this.save();
							this.refreshRows();
						});
					}),
			},
			{ name: "Canvas URL", desc: "Your school's Canvas address, e.g. https://school.instructure.com", visible: () => s.lms === "canvas", render: this.text("canvasUrl", { placeholder: "https://school.instructure.com" }) },
			{
				name: "Canvas access token",
				desc: "Canvas → Account → Settings → Approved Integrations → New Access Token. Stored in this plugin's data.json inside your vault.",
				visible: () => s.lms === "canvas",
				render: (st) => {
					password("canvasToken")(st);
					test(st);
				},
			},
			{ name: "Moodle URL", desc: "Your school's Moodle address, e.g. https://moodle.school.edu", visible: () => s.lms === "moodle", render: this.text("moodleUrl", { placeholder: "https://moodle.school.edu" }) },
			{
				name: "Moodle token",
				desc: "Moodle → your profile → Preferences → Security keys: copy the key of the \"Moodle mobile web service\" (it exists when your school allows the Moodle app). If there is no such page, ask your Moodle administrator for a web service token. Read-only use: site info, your courses, course contents.",
				visible: () => s.lms === "moodle",
				render: (st) => {
					password("moodleToken")(st);
					test(st);
				},
			},
			{
				name: "Match slides to the lecture",
				desc: "When a recording stops, rank the course's files by overlap with the transcript and by how much they look like a deck. Ask: show the picker. Auto: attach without asking when one deck clearly wins. Always: attach the top-ranked deck. Off: never.",
				visible: lmsOn,
				render: (st) =>
					st.addDropdown((d) =>
						d
							.addOption("ask", "Ask (show the picker)")
							.addOption("auto", "Automatic when the match is clear")
							.addOption("always", "Always take the best match")
							.addOption("off", "Off")
							.setValue(s.slideMatching)
							.onChange(async (v) => {
								s.slideMatching = parseSlideMatching(v);
								await this.save();
							}),
					),
			},
			{
				name: "Link the transcript to the slides",
				desc: "After a deck is attached, compare each transcript paragraph with each slide page and add a link like [[deck.pdf#page=12|slide 12]] where the slide changes. Works with decks you attach yourself too (command \"Link transcript paragraphs to slides in this note\").",
				render: this.toggle("alignSlides"),
			},
			{
				name: "Convert PowerPoint decks to PDF",
				desc: "Obsidian shows PDFs inline but can only link a .pptx. Uses PowerPoint (Windows) or LibreOffice if installed; text is still extracted from the original.",
				render: (st) => {
					const out = this.result(st);
					this.toggle("convertPptxToPdf")(st);
					void this.plugin.pptxConverter().then((c) => {
						out.setText(c ? `Converter: ${c.kind === "powerpoint" ? "PowerPoint" : "LibreOffice"} (${c.path})` : "No converter found: install LibreOffice (free) or PowerPoint, then restart Obsidian. Decks stay as .pptx until then.");
						out.toggleClass("lc-ok", !!c);
					});
				},
			},
			{ name: "Keep the original .pptx", desc: "Also save the PowerPoint file next to the PDF.", render: this.toggle("keepPptx") },
			{
				name: "Course names in the vault",
				desc: "Notes are filed under these names (Courses/<name>/…). By default a course uses its full title on the course site; type a shorter name here. Whatever you type in the panel's course box is remembered automatically. The eye button hides a course you never record.",
				visible: lmsOn,
				render: (st) => {
					const rows = createDiv({ cls: "lc-alias-rows" });
					st.settingEl.insertAdjacentElement("afterend", rows);
					const renderRows = (): void => {
						rows.empty();
						const courses = this.plugin.allCourses;
						if (courses.length === 0) {
							rows.createDiv({ cls: "lc-setting-result", text: this.plugin.lms().configured ? 'Click "Load courses" to list your courses.' : "Set the course site's URL and token first." });
							return;
						}
						const hidden = hiddenCourseIds(s);
						for (const course of courses) {
							const isHidden = hidden.has(course.id);
							const row = new Setting(rows).setName(course.name).setDesc(`${course.courseCode}${course.term ? ` · ${course.term}` : ""} · id ${course.id}${isHidden ? " · hidden" : ""}`);
							row.settingEl.addClass("lc-alias-row");
							if (isHidden) row.settingEl.addClass("lc-alias-row-hidden");
							row.addText((c) => {
								const current = vaultCourseName(s, course);
								c.setPlaceholder(course.name)
									.setValue(current === course.name ? "" : current)
									.setDisabled(isHidden)
									.onChange(async (v) => {
										setCourseAlias(s, course, v);
										await this.save();
									});
							});
							row.addExtraButton((b) =>
								b
									.setIcon(isHidden ? "eye" : "eye-off")
									.setTooltip(isHidden ? "Show this course again" : "Hide this course from the course list, matching and the daily pull")
									.onClick(async () => {
										await this.plugin.setCourseHidden(course.id, !isHidden);
										renderRows();
									}),
							);
						}
					};
					st.addButton((b) =>
						b.setButtonText("Load courses").onClick(async () => {
							try {
								await this.plugin.refreshCourses();
								renderRows();
							} catch (err) {
								new Notice((err as Error).message, 8000);
							}
						}),
					);
					renderRows();
					if (this.plugin.lms().configured && this.plugin.allCourses.length === 0) void this.plugin.refreshCourses().then(renderRows).catch(() => undefined);
					return () => rows.remove();
				},
			},
			{ name: "Course names (raw list)", desc: "The same mapping as text, one per line: `course id, code or name = name in the vault`.", visible: lmsOn, render: this.area("courseAliases", "12345 = CSCI578") },
			{ name: "Course note overrides", desc: "Optional, one per line: `course id or name = Folder/Note.md`. Used with the \"sections in the course note\" layout.", visible: lmsOn, render: this.area("courseNotes", "12345 = Courses/CS101.md") },
			{ name: "Look back (days)", desc: "\"Today's\" slides include files changed in the last N days, so decks posted the evening before are picked up. 1 = the chosen day only.", visible: lmsOn, render: this.number("lookbackDays", 1) },
			{ name: "Pull slides automatically once a day", desc: "When Obsidian starts, fetch today's new PDF/PPTX files from every active course.", visible: lmsOn, render: this.toggle("autoPullDaily") },
		];
	}

	private summaryRows(ollama: () => boolean): Row[] {
		const s = this.s;
		const testRow = (st: Setting): void => {
			const out = this.result(st);
			st.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					try {
						const client = this.plugin.llm();
						const version = await client.version();
						const models = await client.listModels();
						out.setText(`${ollama() ? `Ollama ${version}` : version} · ${models.length} models: ${models.map((m) => m.name).join(", ")}`);
						out.addClass("lc-ok");
					} catch (err) {
						out.setText((err as Error).message);
						out.removeClass("lc-ok");
					}
				}),
			);
		};
		const lva = this.plugin.localVaultAgentApi();
		return [
			{
				name: "Chat model server",
				desc: "Ollama (default), or any OpenAI-compatible server: LM Studio, llama.cpp's llama-server, Jan, vLLM, LocalAI. Both run on your machine or your network.",
				render: (st) =>
					st.addDropdown((d) =>
						d
							.addOption("ollama", "Ollama")
							.addOption("openai", "OpenAI-compatible (LM Studio, llama.cpp, Jan, vLLM)")
							.setValue(s.llmProvider)
							.onChange(async (v) => {
								s.llmProvider = v === "openai" ? "openai" : "ollama";
								await this.save();
								this.refreshRows();
							}),
					),
			},
			{
				name: "Ollama URL",
				desc: "Local or over your network, e.g. http://localhost:11434 or a Tailscale address.",
				visible: ollama,
				render: (st) => {
					this.text("ollamaUrl", { placeholder: DEFAULT_SETTINGS.ollamaUrl, fallback: DEFAULT_SETTINGS.ollamaUrl })(st);
					testRow(st);
				},
			},
			{
				name: "Use Local Vault Agent's Ollama settings",
				desc: "Copy the Ollama URL and model from Local Vault Agent, so both plugins use the same server and model.",
				visible: () => ollama() && typeof lva?.ollama === "function",
				render: (st) =>
					st.addButton((b) =>
						b.setButtonText("Use Local Vault Agent's Ollama settings").onClick(async () => {
							try {
								const got = lva?.ollama?.();
								if (got?.url) s.ollamaUrl = got.url.trim();
								if (got?.model) s.ollamaModel = got.model.trim();
								await this.save();
								new Notice(`Ollama: ${s.ollamaUrl} · ${s.ollamaModel}`);
								this.rerender();
							} catch (err) {
								new Notice(`Could not read Local Vault Agent's settings: ${(err as Error).message}`, 8000);
							}
						}),
					),
			},
			{
				name: "Model",
				desc: "Any chat model you have pulled. Lectures are long; a model with a 32k+ context works best.",
				visible: ollama,
				render: (st) => {
					const rec = this.result(st);
					this.text("ollamaModel", { fallback: DEFAULT_SETTINGS.ollamaModel })(st);
					void machineRecommendation().then(({ rec: r }) => rec.setText(`Recommended for this computer: ${r.chatModel}. ${r.chatWhy}`));
				},
			},
			{
				name: "Server URL",
				desc: "The OpenAI-compatible server's address: LM Studio http://localhost:1234, llama-server http://localhost:8080, Jan http://localhost:1337, vLLM http://localhost:8000 (with or without /v1).",
				visible: () => !ollama(),
				render: (st) => {
					this.text("openaiUrl", { placeholder: "http://localhost:1234", fallback: "http://localhost:1234" })(st);
					testRow(st);
				},
			},
			{ name: "Model name", desc: "As the server lists it (press Test above to see the names).", visible: () => !ollama(), render: this.text("openaiModel", { placeholder: "qwen3.5-9b-instruct" }) },
			{
				name: "API key",
				desc: "Only if your server requires one (local servers usually do not). Stored in data.json; never included in problem reports.",
				visible: () => !ollama(),
				render: (st) =>
					st.addText((c) => {
						c.inputEl.type = "password";
						c.setValue(s.openaiKey).onChange(async (v) => {
							s.openaiKey = v.trim();
							await this.save();
						});
					}),
			},
			{ name: "Context window (num_ctx)", desc: "Tokens the model may read (Ollama). A one-hour lecture is roughly 10–12k tokens of transcript. For an OpenAI-compatible server, set the context length when you load the model there.", render: this.number("numCtx", 2048) },
			{
				name: "Thinking",
				desc: "For reasoning models (Qwen3, DeepSeek-R1) on Ollama. Off is faster and fine for summaries.",
				visible: ollama,
				render: (st) =>
					st.addDropdown((d) =>
						d
							.addOption("off", "Off")
							.addOption("auto", "Model default")
							.addOption("on", "On")
							.setValue(s.thinking)
							.onChange(async (v) => {
								s.thinking = v === "on" ? "on" : v === "auto" ? "auto" : "off";
								await this.save();
							}),
					),
			},
			{ name: "Summarize when recording stops", render: this.toggle("summarizeOnStop") },
			{
				name: "Flashcards for Spaced Repetition",
				desc: "After the summary, answer its review questions from the transcript (one more model call) and write a Flashcards section of Question::Answer lines, tagged #flashcards, for the Spaced Repetition plugin.",
				render: this.toggle("flashcards"),
			},
			{ name: "Extra summary instructions", desc: "Appended to the summary prompt, e.g. \"Always list formulas\".", render: this.area("summaryInstructions") },
		];
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
