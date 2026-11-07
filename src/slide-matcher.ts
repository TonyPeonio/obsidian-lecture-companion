// Picks the deck(s) for a lecture from the course's Canvas files: gathers candidates (with a
// text cache so decks are downloaded once), ranks them against the transcript, asks the user
// unless the match is clear, then attaches the chosen files to the note.

import { loadPdfJs, Notice } from "obsidian";
import type { CanvasCourse, CanvasFile } from "./core/canvas";
import { extractSlideText, slideKind } from "./core/extract";
import type { PdfJsLike } from "./core/extract/pdf";
import { isConfident, rankSlides, type RankedSlide, type SlideCandidate } from "./core/match";
import { addDays, safeFileName, SECTION_SLIDES, slidesToMarkdown, startOfDay, type SlideAttachment } from "./core/notes";
import type LectureCompanionPlugin from "./main";
import { cleanTranscript } from "./session";
import type { NoteTarget } from "./vault";
import { SlidePickerModal } from "./slide-picker";

const MAX_CANDIDATES = 120;
const CACHE_LIMIT = 600;

interface CacheEntry {
	updatedAt: string;
	name: string;
	text: string;
}

interface SlideCache {
	version: 1;
	entries: Record<string, CacheEntry>;
}

export interface MatchRequest {
	canvasCourse: CanvasCourse;
	/** Name used for notes (alias), for the picker title. */
	course: string;
	date: string;
	target: NoteTarget;
	/** Transcript markdown; empty when matching before a recording. */
	transcript: string;
	/** Only files changed in the look-back window (the dated pull) instead of the whole course. */
	windowOnly: boolean;
	/** "ask" shows the picker; "auto" skips it when the top match is clear (or, without a transcript, attaches the pre-selected ones). */
	mode: "ask" | "auto";
	/** Replace the Slides section instead of appending to it. */
	replace: boolean;
	/** Offer "Attach and stop asking" in the picker, which switches the slide-matching setting to "auto". */
	offerAutoAccept?: boolean;
	onStatus?(message: string): void;
}

export interface MatchResult {
	attached: string[];
	candidates: number;
	skipped: boolean;
	errors: string[];
}

export class SlideMatcher {
	private cache?: SlideCache;

	constructor(private plugin: LectureCompanionPlugin) {}

	async run(req: MatchRequest): Promise<MatchResult> {
		const result: MatchResult = { attached: [], candidates: 0, skipped: false, errors: [] };
		const { candidates, files } = await this.gather(req);
		result.candidates = candidates.length;
		if (candidates.length === 0) return result;

		const previousNames = await this.previousDeckNames(req.course, req.target.path);
		const transcript = cleanTranscript(req.transcript, false);
		const ranked = rankSlides(transcript, candidates, { previousNames });
		const hasTranscript = transcript.length > 0;

		let chosen: RankedSlide[];
		if (req.mode === "auto" && (hasTranscript ? isConfident(ranked) : true)) {
			chosen = hasTranscript ? ranked.slice(0, 1) : ranked.filter((r) => r.selected);
		} else {
			const onAutoAccept = req.offerAutoAccept
				? async () => {
						this.plugin.settings.slideMatching = "auto";
						await this.plugin.saveSettings();
					}
				: undefined;
			const picked = await new SlidePickerModal(this.plugin.app, req.course, req.date, ranked, hasTranscript, onAutoAccept).ask();
			if (!picked) {
				result.skipped = true;
				return result;
			}
			chosen = picked;
		}
		if (chosen.length === 0) return result;

		const existing = req.replace ? "" : ((await this.plugin.vault.readSection(req.target, SECTION_SLIDES)) ?? "");
		const attachments: SlideAttachment[] = [];
		for (const r of chosen) {
			const file = files.get(r.id);
			if (!file) continue;
			const safeName = safeFileName(file.displayName || file.filename);
			if (existing.includes(`[[${safeName}`) || existing.includes(`[[${safeName.replace(/\.pptx$/i, ".pdf")}`)) continue;
			req.onStatus?.(`Downloading ${file.displayName}…`);
			try {
				const { bytes } = await this.plugin.canvas.download(file);
				const saved = await this.plugin.saveDeck(bytes, safeName, req.target.path);
				if (saved.note) result.errors.push(`${file.displayName}: ${saved.note}`);
				attachments.push({
					vaultPath: saved.vaultPath,
					title: file.displayName,
					text: r.text || undefined,
					source: file.moduleName ? `Canvas · ${file.moduleName}` : "Canvas · Files",
				});
				result.attached.push(file.displayName);
			} catch (err) {
				result.errors.push(`${file.displayName}: ${(err as Error).message}`);
			}
		}
		if (attachments.length > 0 || req.replace) {
			await this.plugin.vault.writeSection(req.target, SECTION_SLIDES, attachments.length ? slidesToMarkdown(attachments) : "_No slides yet._", req.replace ? "replace" : "append");
		}
		return result;
	}

	/** Slide files of a course, newest first: the whole course, or only the look-back window around `date`. */
	async listFiles(canvasCourse: CanvasCourse, date: string, windowOnly: boolean): Promise<CanvasFile[]> {
		if (!windowOnly) return (await this.plugin.canvas.listFiles(canvasCourse.id, {})).slice(0, MAX_CANDIDATES);
		const until = addDays(startOfDay(date), 1);
		const since = addDays(until, -Math.max(1, this.plugin.settings.lookbackDays));
		return (await this.plugin.canvas.listFiles(canvasCourse.id, { since, until })).slice(0, MAX_CANDIDATES);
	}

	async candidateCount(canvasCourse: CanvasCourse, date: string, windowOnly: boolean): Promise<number> {
		return (await this.listFiles(canvasCourse, date, windowOnly)).length;
	}

	/** Resolves the candidates' text, downloading only what the cache lacks. */
	private async gather(req: MatchRequest): Promise<{ candidates: SlideCandidate[]; files: Map<number, CanvasFile> }> {
		const list = await this.listFiles(req.canvasCourse, req.date, req.windowOnly);
		const cache = await this.loadCache();
		const files = new Map<number, CanvasFile>();
		const candidates: SlideCandidate[] = [];
		let dirty = false;
		for (const file of list) {
			files.set(file.id, file);
			const key = String(file.id);
			const hit = cache.entries[key];
			let text: string;
			if (hit && hit.updatedAt === file.updatedAt) {
				text = hit.text;
			} else {
				req.onStatus?.(`Reading ${file.displayName}…`);
				text = await this.extract(file);
				cache.entries[key] = { updatedAt: file.updatedAt, name: file.displayName, text };
				dirty = true;
			}
			candidates.push({ id: file.id, name: file.displayName, text, moduleName: file.moduleName, linkText: file.linkText, updatedAt: file.updatedAt });
		}
		if (dirty) await this.saveCache(cache);
		return { candidates, files };
	}

	private async extract(file: CanvasFile): Promise<string> {
		if (slideKind(file.displayName, file.contentType) === "other") return "";
		try {
			const { bytes, contentType } = await this.plugin.canvas.download(file);
			return (await extractSlideText(file.displayName, bytes, { loadPdfJs: () => loadPdfJs() as Promise<PdfJsLike> }, contentType)) ?? "";
		} catch (err) {
			new Notice(`Could not read ${file.displayName}: ${(err as Error).message}`, 6000);
			return "";
		}
	}

	/** Deck names already embedded in this course's other lecture notes. */
	private async previousDeckNames(course: string, exceptPath: string): Promise<string[]> {
		const names = new Set<string>();
		for (const path of this.plugin.vault.lectureNotePaths(this.plugin.folderFor(course), course)) {
			if (path === exceptPath) continue;
			let md: string;
			try {
				md = await this.plugin.vault.read(path);
			} catch {
				continue;
			}
			for (const m of md.matchAll(/!\[\[([^\]|]+\.(?:pdf|pptx|ppt))\]\]/gi)) {
				const name = m[1]?.split("/").pop();
				if (name) names.add(name);
			}
		}
		return [...names];
	}

	private cachePath(): string {
		return `${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/slide-cache.json`;
	}

	private async loadCache(): Promise<SlideCache> {
		if (this.cache) return this.cache;
		const adapter = this.plugin.app.vault.adapter;
		const path = this.cachePath();
		try {
			if (await adapter.exists(path)) {
				const parsed = JSON.parse(await adapter.read(path)) as Partial<SlideCache>;
				if (parsed.version === 1 && parsed.entries) {
					this.cache = { version: 1, entries: parsed.entries };
					return this.cache;
				}
			}
		} catch {
			// corrupt cache: start over
		}
		this.cache = { version: 1, entries: {} };
		return this.cache;
	}

	private async saveCache(cache: SlideCache): Promise<void> {
		const keys = Object.keys(cache.entries);
		if (keys.length > CACHE_LIMIT) {
			for (const k of keys.slice(0, keys.length - CACHE_LIMIT)) delete cache.entries[k];
		}
		await this.plugin.app.vault.adapter.write(this.cachePath(), JSON.stringify(cache));
	}
}


