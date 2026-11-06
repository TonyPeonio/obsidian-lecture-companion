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
	/** Notes the student wrote (imported lectures). */
	myNotes?: string;
	/** A meeting (work, club) gets the `meeting` tag and no Slides section. Default: lecture. */
	kind?: NoteKind;
}

export type NoteKind = "lecture" | "meeting";

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

/** True when a note already has the lecture layout (frontmatter tag or the four sections). */
export function isLectureNote(markdown: string): boolean {
	const fm = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
	if (/^\s*-\s*(?:lecture|meeting)\s*$/m.test(fm)) return true;
	const lines = markdown.split("\n");
	return !!(findSection(lines, SECTION_TRANSCRIPT) && findSection(lines, SECTION_SUMMARY) && findSection(lines, SECTION_MY_NOTES));
}

/** First date in a file name or text: 2026-11-05, 2026_11_05, 20261105, 11-05-2026, 11/5/26, "Nov 5 2026", "5 November 2026". */
export function detectDate(text: string, now: Date = new Date()): string | null {
	const iso = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/.exec(text);
	if (iso && valid(+iso[1], +iso[2], +iso[3])) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const us = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/.exec(text);
	if (us) {
		const y = us[3].length === 2 ? 2000 + +us[3] : +us[3];
		if (valid(y, +us[1], +us[2])) return `${y}-${pad(+us[1])}-${pad(+us[2])}`;
	}
	const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
	const named = /(?:(\d{1,2})(?:st|nd|rd|th)?\s+)?\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})?(?:st|nd|rd|th)?,?\s*(\d{4})?/i.exec(text);
	if (named) {
		const m = months.indexOf(named[2].toLowerCase().slice(0, 3)) + 1;
		const d = +(named[1] ?? named[3] ?? "0");
		const y = named[4] ? +named[4] : now.getFullYear();
		if (d && valid(y, m, d)) return `${y}-${pad(m)}-${pad(d)}`;
	}
	return null;
}

function valid(y: number, m: number, d: number): boolean {
	return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Body of a note without its frontmatter. */
export function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
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

/** No H1: Obsidian shows the file name as the inline title, so a heading would repeat it. */
export function renderLectureNote(input: LectureNoteInput): string {
	const meeting = input.kind === "meeting";
	const fm = [
		"---",
		`course: "${input.course.replace(/"/g, '\\"')}"`,
		`date: ${input.date}`,
		"tags:",
		meeting ? "  - meeting" : "  - lecture",
	];
	if (input.audioPath) fm.push(`audio: "[[${input.audioPath.split("/").pop() ?? input.audioPath}]]"`);
	if (input.title?.trim()) fm.push(`title: "${input.title.trim().replace(/"/g, '\\"')}"`);
	fm.push("---");
	const slides = meeting ? [] : [`## ${SECTION_SLIDES}`, "", input.slides?.length ? slidesToMarkdown(input.slides) : "_No slides yet._", ""];
	const sections = [
		...slides,
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
		input.myNotes?.trim() ?? "",
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

/**
 * Finds a heading by text (case-insensitive), skipping code fences. Written with leading `#`s
 * ("## Lectures") the level must match too; without them any level matches.
 */
export function findSection(lines: string[], heading: string): SectionRange | null {
	const want = normalizeHeading(heading);
	const wantLevel = /^(#{1,6})\s/.exec(heading.trim())?.[1]?.length;
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
			if (h.text.toLowerCase() === want && (wantLevel === undefined || h.level === wantLevel)) found = { line: i, level: h.level };
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
	// Blank line after the parent heading, then the (updated) body, then a blank line before what follows.
	return [...before, "", ...updated.replace(/^\s+|\s+$/g, "").split("\n"), "", ...after].join("\n").replace(/\n{3,}/g, "\n\n");
}

export function nestedSectionBody(markdown: string, parentHeading: string, childHeading: string): string | null {
	const lines = markdown.split("\n");
	const parent = findSection(lines, parentHeading);
	if (!parent) return null;
	return sectionBody(lines.slice(parent.bodyStart, parent.bodyEnd).join("\n"), childHeading);
}

/**
 * Course-note layout: one `## Lectures` section with a `### YYYY-MM-DD` subheading per day.
 * Adds the link unless it is already there.
 */
export function addLectureLink(markdown: string, date: string, link: string, listHeading = "## Lectures"): string {
	if (markdown.includes(link)) return markdown;
	return upsertNestedSection(markdown, listHeading, date, `- ${link}`, "append");
}

/**
 * One sentence for the course note, from a written summary: its "In one sentence" section, else
 * (summaries written before that section existed) the first Key point or the Overview's first
 * sentence. Timestamps, markdown emphasis and links are dropped; null when nothing usable.
 */
export function oneLineSummary(summary: string): string | null {
	const pick = (heading: string, firstSentence = false): string | null => {
		const body = sectionBody(summary, heading);
		if (!body) return null;
		const line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !/^_[^_]*_$/.test(l));
		if (!line) return null;
		let text = line.replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, "");
		if (firstSentence) text = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
		return text;
	};
	const raw = pick("In one sentence") ?? pick("Key points") ?? pick("Overview", true);
	if (!raw) return null;
	const clean = raw
		.replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "")
		.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
		.replace(/\*\*|__|`/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!clean) return null;
	return clean.length > 240 ? `${clean.slice(0, 237).replace(/\s+\S*$/, "")}…` : clean;
}

/** Puts ` — sentence` after the lecture link in the course note's list (replacing an earlier one). Unchanged when the link is not there. */
export function setLectureLinkSummary(markdown: string, link: string, sentence: string): string {
	const one = sentence.replace(/\s+/g, " ").trim();
	return markdown
		.split("\n")
		.map((line) => {
			const at = line.indexOf(link);
			if (at < 0 || !/^\s*[-*+]\s+$/.test(line.slice(0, at))) return line;
			return `${line.slice(0, at)}${link}${one ? ` — ${one}` : ""}`;
		})
		.join("\n");
}

/**
 * Converts the pre-0.1.6 layout (`## <date>` → `### Lectures` → links) to the Lectures-first layout.
 * A date section is removed only when it holds nothing but that lecture list, so notes the user
 * added under a date are kept.
 */
export function migrateCourseIndex(markdown: string): string {
	const lines = markdown.split("\n");
	const links: { date: string; link: string }[] = [];
	const keep: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const m = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
		if (!m) {
			keep.push(line);
			i++;
			continue;
		}
		// Collect the section body up to the next ## heading.
		let j = i + 1;
		while (j < lines.length && !/^##\s/.test(lines[j] ?? "")) j++;
		const body = lines.slice(i + 1, j);
		const nonEmpty = body.map((l) => l.trim()).filter((l) => l.length > 0);
		const onlyLectures = nonEmpty.length > 0 && nonEmpty[0] === "### Lectures" && nonEmpty.slice(1).every((l) => /^-\s*\[\[.*\]\]\s*$/.test(l));
		if (onlyLectures) {
			for (const l of nonEmpty.slice(1)) links.push({ date: m[1] ?? "", link: l.replace(/^-\s*/, "") });
			i = j;
		} else {
			keep.push(...lines.slice(i, j));
			i = j;
		}
	}
	let out = keep.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	for (const { date, link } of links.sort((a, b) => a.date.localeCompare(b.date))) out = addLectureLink(out, date, link);
	out = out.replace(/\s+$/, "");
	return out ? `${out}\n` : "";
}

/** Points every `[[old]]` / `![[old]]` / `[[old|label]]` reference at `next` (file names, not paths). */
export function replaceAttachmentRefs(markdown: string, oldName: string, newName: string): string {
	const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return markdown.replace(new RegExp(`\\[\\[(?:[^\\]|]*/)?${esc}(\\||\\]\\])`, "g"), (_m, tail: string) => `[[${newName}${tail}`);
}

export const SECTION_TODO = "TODO";
const TASK_MARKERS = /[📅🛫✅⏳🔁➕⏫🔼🔽🔺⏬❌]/u;

/**
 * Pulls task lines out of notes: `- [ ] …` / `- [x] …` checkboxes and bullets carrying
 * Tasks-plugin markers (📅 due, 🛫 start, ✅ done, …). Returns the notes without them and the
 * tasks normalised to checkbox items (✅ or [x] → checked), metadata kept.
 */
export function extractTodos(markdown: string): { remaining: string; todos: string[] } {
	const todos: string[] = [];
	const kept: string[] = [];
	for (const line of markdown.split("\n")) {
		const m = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
		const body = m?.[3]?.trim() ?? "";
		const isCheckbox = m?.[2] !== undefined;
		const isTask = !!m && body.length > 0 && (isCheckbox || TASK_MARKERS.test(body));
		if (!isTask) {
			kept.push(line);
			continue;
		}
		const done = m[2]?.toLowerCase() === "x" || /✅/u.test(body);
		todos.push(`- [${done ? "x" : " "}] ${body}`);
	}
	return { remaining: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), todos };
}

/** Appends tasks to the `## TODO` section (created at the end when missing), skipping ones already there. */
export function addTodos(markdown: string, todos: string[]): string {
	const existing = sectionBody(markdown, `## ${SECTION_TODO}`) ?? "";
	const have = new Set(existing.split("\n").map((l) => l.replace(/^-\s*\[[ xX]\]\s*/, "").trim()).filter(Boolean));
	const fresh = todos.filter((t) => !have.has(t.replace(/^-\s*\[[ xX]\]\s*/, "").trim()));
	if (fresh.length === 0) return ensureTodoSection(markdown);
	// Replace rather than append so the list stays one contiguous block (no blank line between items).
	const merged = [...existing.split("\n").filter((l) => l.trim().length > 0), ...fresh];
	return upsertSection(markdown, `## ${SECTION_TODO}`, merged.join("\n"), "replace");
}

/** Makes sure the course note ends with a `## TODO` section. */
export function ensureTodoSection(markdown: string): string {
	if (findSection(markdown.split("\n"), `## ${SECTION_TODO}`)) return markdown;
	return upsertSection(markdown, `## ${SECTION_TODO}`, "");
}
