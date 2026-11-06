export type NoteMode = "per-lecture" | "per-course-section";
export type ThinkingMode = "auto" | "on" | "off";
/** ask = show the picker; auto = attach without asking when the match is clear; off = never match. */
export type SlideMatching = "ask" | "auto" | "off";

export interface LectureCompanionSettings {
	// Whisper
	whisperBinaryPath: string;
	whisperModel: string;
	/** 0 = all logical CPUs. */
	threads: number;
	language: string;
	/** When set, use this whisper-server instead of spawning one. */
	remoteWhisperUrl: string;
	idleUnloadMinutes: number;
	useVad: boolean;
	/** Extra command-line arguments for whisper-server, e.g. "-fa" on a GPU build. */
	extraServerArgs: string;
	// Recording
	keepAudio: boolean;
	/**
	 * Where recordings and downloaded slides go. `{{notefolder}}` = the lecture note's folder.
	 * Empty = Obsidian's own "Default location for new attachments".
	 */
	attachmentFolder: string;
	chunkSeconds: number;
	silenceCutMs: number;
	inputDeviceId: string;
	/** Stop automatically after this long. 0 = never. */
	maxRecordingMinutes: number;
	/** Stop automatically after this long without any speech. 0 = never. */
	autoStopSilenceMinutes: number;
	// Canvas
	canvasUrl: string;
	canvasToken: string;
	/** "Today's" slides include files changed in the last N days (1 = today only). */
	lookbackDays: number;
	slideMatching: SlideMatching;
	/** One per line: `canvas course id, name or code = name used in the vault`. Learned automatically from the course picker. */
	courseAliases: string;
	courseFolder: string;
	/** One per line: `course id or name = path/to/note.md` */
	courseNotes: string;
	dateHeading: string;
	autoPullDaily: boolean;
	lastCanvasPull: string;
	// Summaries
	ollamaUrl: string;
	ollamaModel: string;
	summarizeOnStop: boolean;
	numCtx: number;
	thinking: ThinkingMode;
	summaryInstructions: string;
	// Notes
	noteMode: NoteMode;
	/** Course names typed by hand (one per line) for the picker when Canvas is not configured. */
	manualCourses: string;
}

export const DEFAULT_SETTINGS: LectureCompanionSettings = {
	whisperBinaryPath: "",
	whisperModel: "large-v3-turbo",
	threads: 0,
	language: "en",
	remoteWhisperUrl: "",
	idleUnloadMinutes: 10,
	useVad: false,
	extraServerArgs: "",
	keepAudio: true,
	attachmentFolder: "{{notefolder}}/attachments",
	chunkSeconds: 20,
	silenceCutMs: 700,
	inputDeviceId: "",
	maxRecordingMinutes: 180,
	autoStopSilenceMinutes: 15,
	canvasUrl: "",
	canvasToken: "",
	lookbackDays: 1,
	slideMatching: "ask",
	courseAliases: "",
	courseFolder: "Courses",
	courseNotes: "",
	dateHeading: "## {{date}}",
	autoPullDaily: false,
	lastCanvasPull: "",
	ollamaUrl: "http://localhost:11434",
	ollamaModel: "qwen3.5:9b",
	summarizeOnStop: true,
	numCtx: 32768,
	thinking: "off",
	summaryInstructions: "",
	noteMode: "per-lecture",
	manualCourses: "",
};

/** Parses the `key = path` overrides. Keys are matched case-insensitively against course id, name and code. */
export function parseCourseNotes(text: string): { key: string; path: string }[] {
	const out: { key: string; path: string }[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		let path = line.slice(idx + 1).trim();
		if (!key || !path) continue;
		if (!path.toLowerCase().endsWith(".md")) path += ".md";
		out.push({ key, path: path.replace(/^\/+/, "") });
	}
	return out;
}

export function courseNoteOverride(
	settings: LectureCompanionSettings,
	course: { id?: number; name: string; courseCode?: string },
): string | undefined {
	const keys = [course.id !== undefined ? String(course.id) : "", course.name, course.courseCode ?? ""]
		.filter(Boolean)
		.map((k) => k.toLowerCase());
	for (const entry of parseCourseNotes(settings.courseNotes)) {
		if (keys.includes(entry.key)) return entry.path;
	}
	return undefined;
}

/** `key = value` lines; keys lower-cased. Shared by the alias and note-override settings. */
export function parseKeyValueLines(text: string): { key: string; value: string }[] {
	const out: { key: string; value: string }[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf("=");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (key && value) out.push({ key, value });
	}
	return out;
}

/** The name notes use for a Canvas course: an alias if one is set, else Canvas's full course name. */
export function vaultCourseName(settings: LectureCompanionSettings, course: { id: number; name: string; courseCode?: string }): string {
	const keys = [String(course.id), course.name, course.courseCode ?? ""].filter(Boolean).map((k) => k.toLowerCase());
	for (const entry of parseKeyValueLines(settings.courseAliases)) {
		if (keys.includes(entry.key)) return entry.value;
	}
	return course.name;
}

/** Adds `id = alias` unless the course already has an alias. Returns true when settings changed. */
export function addCourseAlias(settings: LectureCompanionSettings, course: { id: number; name: string; courseCode?: string }, alias: string): boolean {
	const keys = [String(course.id), course.name, course.courseCode ?? ""].filter(Boolean).map((k) => k.toLowerCase());
	const wanted = alias.trim();
	// Typing Canvas's own name or code carries no preference; only a different name is worth remembering.
	if (!wanted || keys.includes(wanted.toLowerCase())) return false;
	if (parseKeyValueLines(settings.courseAliases).some((e) => keys.includes(e.key))) return false;
	const line = `${course.id} = ${wanted}`;
	settings.courseAliases = settings.courseAliases.trim() ? `${settings.courseAliases.trim()}\n${line}` : line;
	return true;
}

/** Sets (or clears, when `alias` is empty or equals Canvas's own name/code) the vault name for a course. */
export function setCourseAlias(settings: LectureCompanionSettings, course: { id: number; name: string; courseCode?: string }, alias: string): void {
	const keys = [String(course.id), course.name, course.courseCode ?? ""].filter(Boolean).map((k) => k.toLowerCase());
	const kept = settings.courseAliases
		.split("\n")
		.filter((line) => {
			const parsed = parseKeyValueLines(line)[0];
			return !parsed || !keys.includes(parsed.key);
		})
		.filter((line) => line.trim().length > 0);
	const wanted = alias.trim();
	if (wanted && !keys.includes(wanted.toLowerCase())) kept.push(`${course.id} = ${wanted}`);
	settings.courseAliases = kept.join("\n");
}

export function manualCourseList(settings: LectureCompanionSettings): string[] {
	return settings.manualCourses
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}
