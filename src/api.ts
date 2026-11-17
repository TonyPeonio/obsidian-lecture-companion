// The plugin's public API, `app.plugins.plugins["lecture-companion"].api`, used by Local Vault
// Agent (and anything else): list courses and lectures, read a transcript as timed paragraphs,
// transcribe audio with the plugin's whisper-server, and read the Ollama settings.

import { normalizePath, TFile } from "obsidian";
import { oneLineSummary, safeFileName, sectionBody, SECTION_SUMMARY, SECTION_TRANSCRIPT } from "./core/notes";
import { parseTranscript } from "./core/transcript";
import { transcribeWav } from "./core/whisper/client";
import type LectureCompanionPlugin from "./main";

export interface LectureInfo {
	path: string;
	course: string;
	/** YYYY-MM-DD */
	date: string;
	kind: "lecture" | "meeting";
	/** The one-sentence summary from the note's Summary section, or null when not summarized (or not read yet). */
	sentence: string | null;
}

export interface LectureCompanionApi {
	version: 1;
	courses(): string[];
	lectures(course?: string): LectureInfo[];
	transcript(path: string): Promise<{ start: number; text: string }[]>;
	transcribe(wav16kMono: ArrayBuffer): Promise<string>;
	ollama(): { url: string; model: string };
}

const DATED = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Per-lecture notes (`<course folder>/<course>/YYYY-MM-DD.md`, and the same under the meeting
 * folder) found synchronously from the vault's file list and metadata cache. One-sentence
 * summaries need the file contents, so they are cached and refreshed when a note changes.
 */
export class LectureIndex {
	private sentences = new Map<string, { mtime: number; sentence: string | null }>();
	private pending = new Set<string>();

	constructor(private plugin: LectureCompanionPlugin) {}

	register(): void {
		const { vault } = this.plugin.app;
		this.plugin.registerEvent(vault.on("modify", (f) => f instanceof TFile && this.isLecture(f) && this.refresh(f)));
		this.plugin.registerEvent(vault.on("delete", (f) => this.sentences.delete(f.path)));
		this.plugin.registerEvent(vault.on("rename", (f, old) => {
			this.sentences.delete(old);
			if (f instanceof TFile && this.isLecture(f)) this.refresh(f);
		}));
		this.plugin.app.workspace.onLayoutReady(() => {
			for (const f of this.files()) this.refresh(f);
		});
	}

	private roots(): string[] {
		const s = this.plugin.settings;
		return [...new Set([s.courseFolder, s.meetingFolder].map((r) => normalizePath(r)))];
	}

	private isLecture(f: TFile): boolean {
		if (!DATED.test(f.name)) return false;
		const parent = f.parent;
		return !!parent?.parent && this.roots().includes(parent.parent.path);
	}

	private files(): TFile[] {
		return this.plugin.app.vault.getMarkdownFiles().filter((f) => this.isLecture(f));
	}

	private refresh(f: TFile): void {
		const known = this.sentences.get(f.path);
		if ((known && known.mtime === f.stat.mtime) || this.pending.has(f.path)) return;
		this.pending.add(f.path);
		void this.plugin.app.vault
			.cachedRead(f)
			.then((md) => {
				const summary = sectionBody(md, SECTION_SUMMARY) ?? "";
				this.sentences.set(f.path, { mtime: f.stat.mtime, sentence: oneLineSummary(summary) });
			})
			.catch(() => undefined)
			.finally(() => this.pending.delete(f.path));
	}

	/** Lecture and meeting notes, oldest first, optionally of one course (case-insensitive; the folder name works too). */
	list(course?: string): LectureInfo[] {
		const want = course?.trim().toLowerCase();
		const out: LectureInfo[] = [];
		for (const f of this.files()) {
			const fm = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter;
			const folder = f.parent?.name ?? "";
			const name = typeof fm?.course === "string" && fm.course.trim() ? fm.course.trim() : folder;
			if (want && name.toLowerCase() !== want && folder.toLowerCase() !== safeFileName(want).toLowerCase()) continue;
			const tags: unknown = fm?.tags;
			const tagged = Array.isArray(tags) ? tags.map(String) : typeof tags === "string" ? [tags] : [];
			const meeting = tagged.includes("meeting") || this.plugin.isMeeting(name);
			const cached = this.sentences.get(f.path);
			if (!cached || cached.mtime !== f.stat.mtime) this.refresh(f);
			out.push({ path: f.path, course: name, date: DATED.exec(f.name)?.[1] ?? "", kind: meeting ? "meeting" : "lecture", sentence: cached?.sentence ?? null });
		}
		return out.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path));
	}
}

export function createApi(plugin: LectureCompanionPlugin, index: LectureIndex): LectureCompanionApi {
	return {
		version: 1,
		courses: () => plugin.courseNames(),
		lectures: (course?: string) => index.list(course),
		async transcript(path: string) {
			const file = plugin.app.vault.getAbstractFileByPath(normalizePath(path));
			if (!(file instanceof TFile)) throw new Error(`Note not found: ${path}`);
			const md = await plugin.app.vault.cachedRead(file);
			return parseTranscript(sectionBody(md, SECTION_TRANSCRIPT) ?? "")
				.filter((p) => !p.mark && p.text.trim())
				.map((p) => ({ start: p.start, text: p.text }));
		},
		async transcribe(wav16kMono: ArrayBuffer) {
			const baseUrl = await plugin.startServer();
			const language = plugin.settings.language === "auto" ? undefined : plugin.settings.language;
			const result = await transcribeWav(plugin.http, baseUrl, wav16kMono, { language });
			plugin.server.touch();
			return result.text.replace(/\s+/g, " ").trim();
		},
		ollama: () => ({ url: plugin.settings.ollamaUrl, model: plugin.settings.ollamaModel }),
	};
}
