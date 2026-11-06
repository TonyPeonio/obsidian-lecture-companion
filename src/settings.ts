export type NoteMode = "per-lecture" | "per-course-section";
export type ThinkingMode = "auto" | "on" | "off";

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
	// Recording
	keepAudio: boolean;
	chunkSeconds: number;
	silenceCutMs: number;
	inputDeviceId: string;
	// Canvas
	canvasUrl: string;
	canvasToken: string;
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
	keepAudio: true,
	chunkSeconds: 20,
	silenceCutMs: 700,
	inputDeviceId: "",
	canvasUrl: "",
	canvasToken: "",
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

export function manualCourseList(settings: LectureCompanionSettings): string[] {
	return settings.manualCourses
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}
