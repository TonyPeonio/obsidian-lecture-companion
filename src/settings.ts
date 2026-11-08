export type NoteMode = "per-lecture" | "per-course-section";
export type ThinkingMode = "auto" | "on" | "off";
/** ask = show the picker; auto = attach without asking when the match is clear; always = attach the top match without asking; off = never match. */
export type SlideMatching = "ask" | "auto" | "always" | "off";

/** Normalizes a dropdown value (or anything from settings data) to a slide-matching mode; unknown values mean "ask". */
export function parseSlideMatching(v: unknown): SlideMatching {
	return v === "auto" || v === "always" || v === "off" ? v : "ask";
}

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
	/** Convert downloaded .pptx decks to PDF (needs PowerPoint or LibreOffice) so Obsidian shows them inline. */
	convertPptxToPdf: boolean;
	/** Keep the original .pptx next to the PDF. */
	keepPptx: boolean;
	/** One per line: `canvas course id, name or code = name used in the vault`. Learned automatically from the course picker. */
	courseAliases: string;
	/** Canvas course ids, one per line, left out of the course list, matching and the daily pull (courses you are enrolled in but never record). */
	hiddenCourses: string;
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
	/** After the summary, answer its review questions from the transcript and write a `## Flashcards` section (Spaced Repetition `Question::Answer` lines). One extra model call per lecture. */
	flashcards: boolean;
	// Notes
	noteMode: NoteMode;
	/** Course names typed by hand (one per line) for the picker when Canvas is not configured. */
	manualCourses: string;
	// Meetings
	/** Meeting series (work, club, 1:1s), one name per line: never looked up in Canvas, filed under `meetingFolder`, summarized as meetings. */
	meetings: string;
	meetingFolder: string;
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
	convertPptxToPdf: true,
	keepPptx: false,
	courseAliases: "",
	hiddenCourses: "",
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
	flashcards: false,
	noteMode: "per-lecture",
	manualCourses: "",
	meetings: "",
	meetingFolder: "Meetings",
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
	// Typing Canvas's own full name carries no preference; anything else (a short name, the course code) is worth remembering.
	if (!wanted || wanted.toLowerCase() === course.name.toLowerCase()) return false;
	if (parseKeyValueLines(settings.courseAliases).some((e) => keys.includes(e.key))) return false;
	const line = `${course.id} = ${wanted}`;
	settings.courseAliases = settings.courseAliases.trim() ? `${settings.courseAliases.trim()}\n${line}` : line;
	return true;
}

/** Sets (or clears, when `alias` is empty or equals Canvas's own full name) the vault name for a course. */
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
	if (wanted && wanted.toLowerCase() !== course.name.toLowerCase()) kept.push(`${course.id} = ${wanted}`);
	settings.courseAliases = kept.join("\n");
}

/** Canvas ids of the courses the user hid. */
export function hiddenCourseIds(settings: LectureCompanionSettings): Set<number> {
	const ids = new Set<number>();
	for (const raw of settings.hiddenCourses.split("\n")) {
		const n = Number(raw.trim());
		if (raw.trim() && Number.isInteger(n)) ids.add(n);
	}
	return ids;
}

/** Hides or shows a Canvas course. Returns true when settings changed. */
export function setCourseHidden(settings: LectureCompanionSettings, id: number, hidden: boolean): boolean {
	const ids = hiddenCourseIds(settings);
	if (hidden === ids.has(id)) return false;
	if (hidden) ids.add(id);
	else ids.delete(id);
	settings.hiddenCourses = [...ids].sort((a, b) => a - b).join("\n");
	return true;
}

/** The courses that are not hidden, in the given order. */
export function visibleCourses<T extends { id: number }>(settings: LectureCompanionSettings, courses: T[]): T[] {
	const hidden = hiddenCourseIds(settings);
	return courses.filter((c) => !hidden.has(c.id));
}

export function manualCourseList(settings: LectureCompanionSettings): string[] {
	return settings.manualCourses
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Meeting series names from settings (trimmed, non-empty). */
export function meetingList(settings: LectureCompanionSettings): string[] {
	return settings.meetings
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Adds a meeting series to the list unless it is already there (case-insensitive). Returns true when settings changed. */
export function addMeeting(settings: LectureCompanionSettings, name: string): boolean {
	const wanted = name.trim();
	if (!wanted || meetingList(settings).some((m) => m.toLowerCase() === wanted.toLowerCase())) return false;
	settings.meetings = settings.meetings.trim() ? `${settings.meetings.trim()}\n${wanted}` : wanted;
	return true;
}
