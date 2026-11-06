// Markdown shaping for lecture notes: paths, section upserts, transcript and slide rendering.
// Pure string functions; the plugin layer does the vault I/O.

import type { TranscriptSegment } from "./audio/pipeline";

export interface SlideAttachment {
	/** Vault path of the downloaded file. */
	vaultPath: string;
	title: string;
	/** Extracted text, when the format allowed it. */
	text?: string;
	/** Where it came from, e.g. "Canvas · Module 4". */
	source?: string;
}

export interface LectureNoteInput {
	course: string;
	/** YYYY-MM-DD */
	date: string;
	title?: string;
	slides?: SlideAttachment[];
	transcript?: TranscriptSegment[];
	summary?: string;
	/** Vault path of the saved audio, if kept. */
	audioPath?: string;
}

export const SECTION_SLIDES = "Slides";
export const SECTION_SUMMARY = "Summary";
export const SECTION_TRANSCRIPT = "Transcript";
export const SECTION_MY_NOTES = "My notes";

/** Local calendar date as YYYY-MM-DD. */
export function toISODate(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Start of the local day for an ISO date (YYYY-MM-DD). */
export function startOfDay(iso: string): Date {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

export function addDays(d: Date, days: number): Date {
	const out = new Date(d);
	out.setDate(out.getDate() + days);
	return out;
}

export function formatTimestamp(sec: number): string {
	const s = Math.max(0, Math.floor(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Characters that are illegal or awkward in vault file names. */
export function safeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^[\s.-]+|[\s.-]+$/g, "")
		.slice(0, 120) || "untitled";
}

export function dateHeading(template: string, date: string): string {
	const t = template.includes("{{date}}") ? template.replace(/\{\{date\}\}/g, date) : `${template.trim()} ${date}`;
	return t.trim();
}

export function lectureNotePath(folder: string, course: string, date: string): string {
	return `${trimSlashes(folder)}/${safeFileName(course)}/${date}.md`;
}

export function courseNotePath(folder: string, course: string): string {
	return `${trimSlashes(folder)}/${safeFileName(course)}.md`;
}

function trimSlashes(p: string): string {
	return p.replace(/^\/+|\/+$/g, "");
}

/**
 * Groups segments into paragraphs (new paragraph after a pause of `gapSec` or ~700 chars) and
 * prefixes each with its start time, so a line in the summary can point back into the lecture.
 */
export function transcriptToMarkdown(segments: TranscriptSegment[], gapSec = 2.5, maxChars = 700): string {
	const paragraphs: { start: number; text: string }[] = [];
	let current: { start: number; end: number; text: string } | null = null;
	for (const seg of segments) {
		const text = seg.text.trim();
		if (!text) continue;
		const startsNew = !current || seg.start - current.end > gapSec || current.text.length + text.length > maxChars;
		if (startsNew) {
			if (current) paragraphs.push({ start: current.start, text: current.text });
			current = { start: seg.start, end: seg.end, text };
		} else if (current) {
			current.text += (needsSpace(current.text, text) ? " " : "") + text;
			current.end = seg.end;
		}
	}
	if (current) paragraphs.push({ start: current.start, text: current.text });
	return paragraphs.map((p) => `**[${formatTimestamp(p.start)}]** ${p.text}`).join("\n\n");
}

function needsSpace(a: string, b: string): boolean {
	return !/\s$/.test(a) && !/^[,.;:!?)]/.test(b);
}

/** Embed + link for each slide file, with the extracted text in a folded callout. */
export function slidesToMarkdown(slides: SlideAttachment[]): string {
	return slides
		.map((s) => {
			const name = s.vaultPath.split("/").pop() ?? s.vaultPath;
			const lines = [`![[${name}]]`, `[[${name}|${s.title}]]${s.source ? ` — ${s.source}` : ""}`];
			if (s.text && s.text.trim()) {
				lines.push("", `> [!note]- Slide text: ${s.title}`);
				for (const l of s.text.trim().split("\n")) lines.push(`> ${l}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

export function renderLectureNote(input: LectureNoteInput): string {
	const title = input.title?.trim() || `${input.course} — ${input.date}`;
	const fm = [
		"---",
		`course: "${input.course.replace(/"/g, '\\"')}"`,
		`date: ${input.date}`,
		"tags:",
		"  - lecture",
	];
	if (input.audioPath) fm.push(`audio: "[[${input.audioPath.split("/").pop() ?? input.audioPath}]]"`);
	fm.push("---");
	const sections = [
		`# ${title}`,
		"",
		`## ${SECTION_SLIDES}`,
		"",
		input.slides?.length ? slidesToMarkdown(input.slides) : "_No slides yet._",
		"",
		`## ${SECTION_SUMMARY}`,
		"",
		input.summary?.trim() || "_No summary yet._",
		"",
		`## ${SECTION_TRANSCRIPT}`,
		"",
		input.transcript?.length ? transcriptToMarkdown(input.transcript) : "_No transcript yet._",
		"",
		`## ${SECTION_MY_NOTES}`,
		"",
		"",
	];
	return `${fm.join("\n")}\n\n${sections.join("\n")}`;
}

export interface SectionRange {
	/** Index of the heading line. */
	headingLine: number;
	level: number;
	/** First line after the heading. */
	bodyStart: number;
	/** Exclusive end: next heading of the same or higher level, or EOF. */
	bodyEnd: number;
}

function headingText(line: string): { level: number; text: string } | null {
	const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
	return m ? { level: m[1]?.length ?? 1, text: (m[2] ?? "").trim() } : null;
}

function normalizeHeading(h: string): string {
	return h.replace(/^#+\s*/, "").trim().toLowerCase();
}

/** Finds a heading by text (case-insensitive, with or without leading `#`s), skipping code fences. */
export function findSection(lines: string[], heading: string): SectionRange | null {
	const want = normalizeHeading(heading);
	let inFence = false;
	let found: { line: number; level: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const h = headingText(line);
		if (!h) continue;
		if (!found) {
			if (h.text.toLowerCase() === want) found = { line: i, level: h.level };
			continue;
		}
		if (h.level <= found.level) {
			return { headingLine: found.line, level: found.level, bodyStart: found.line + 1, bodyEnd: i };
		}
	}
	if (!found) return null;
	return { headingLine: found.line, level: found.level, bodyStart: found.line + 1, bodyEnd: lines.length };
}

/**
 * Appends to or replaces the body of a section. When the heading is missing it is appended at
 * the end of the note. Placeholder bodies (`_No … yet._`) are replaced even in append mode.
 */
export function upsertSection(markdown: string, heading: string, body: string, mode: "append" | "replace" = "append"): string {
	const lines = markdown.split("\n");
	const headingLine = heading.trim().startsWith("#") ? heading.trim() : `## ${heading.trim()}`;
	const range = findSection(lines, heading);
	const newBody = body.replace(/\s+$/, "");
	if (!range) {
		const trimmed = markdown.replace(/\s+$/, "");
		return `${trimmed ? `${trimmed}\n\n` : ""}${headingLine}\n\n${newBody}\n`;
	}
	const existing = lines.slice(range.bodyStart, range.bodyEnd).join("\n").replace(/^\s+|\s+$/g, "");
	const placeholder = /^_[^_\n]*_$/.test(existing);
	let bodyLines: string[];
	if (mode === "replace" || !existing || placeholder) {
		bodyLines = ["", ...newBody.split("\n"), ""];
	} else {
		bodyLines = ["", ...existing.split("\n"), "", ...newBody.split("\n"), ""];
	}
	const before = lines.slice(0, range.bodyStart);
	const after = lines.slice(range.bodyEnd);
	return [...before, ...bodyLines, ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Body text of a section (without the heading), or null. */
export function sectionBody(markdown: string, heading: string): string | null {
	const lines = markdown.split("\n");
	const range = findSection(lines, heading);
	if (!range) return null;
	return lines.slice(range.bodyStart, range.bodyEnd).join("\n").trim();
}

/**
 * Upserts `childHeading` inside the body of `parentHeading` (used for the per-course-note
 * layout: `## 2026-11-05` → `### Transcript`). Creates the parent at the end when missing.
 * The child heading is written one level deeper than the parent.
 */
export function upsertNestedSection(
	markdown: string,
	parentHeading: string,
	childHeading: string,
	body: string,
	mode: "append" | "replace" = "append",
): string {
	let lines = markdown.split("\n");
	let parent = findSection(lines, parentHeading);
	if (!parent) {
		const withParent = upsertSection(markdown, parentHeading, "");
		lines = withParent.split("\n");
		parent = findSection(lines, parentHeading);
		if (!parent) return withParent;
	}
	const childLevel = Math.min(6, parent.level + 1);
	const childLine = `${"#".repeat(childLevel)} ${childHeading.replace(/^#+\s*/, "").trim()}`;
	const inner = lines.slice(parent.bodyStart, parent.bodyEnd).join("\n");
	const updated = upsertSection(inner, childLine, body, mode);
	const before = lines.slice(0, parent.bodyStart);
	const after = lines.slice(parent.bodyEnd);
	return [...before, ...updated.replace(/\s+$/, "").split("\n"), "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function nestedSectionBody(markdown: string, parentHeading: string, childHeading: string): string | null {
	const lines = markdown.split("\n");
	const parent = findSection(lines, parentHeading);
	if (!parent) return null;
	return sectionBody(lines.slice(parent.bodyStart, parent.bodyEnd).join("\n"), childHeading);
}
