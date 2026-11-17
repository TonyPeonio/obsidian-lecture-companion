// Transcript markdown beyond the basic `**[m:ss]** text` paragraphs: timestamps that can be
// clicked, marks the student set while recording (⭐ important, ❓ confusing), questions from
// class (`**Q:**`), and parsing the section back into paragraphs. Pure string functions.

import type { TranscriptSegment } from "./audio/pipeline";
import { formatTimestamp, stripFrontmatter } from "./notes";

// ------------------------------------------------------------------ timestamps

/** `m:ss`, `mm:ss` or `h:mm:ss` → seconds; null when it is not a time. */
export function parseTimestamp(text: string): number | null {
	const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
	if (!m) return null;
	const a = Number(m[1]);
	const b = Number(m[2]);
	const c = m[3] === undefined ? null : Number(m[3]);
	if (b >= 60 || (c !== null && c >= 60)) return null;
	return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
}

export interface TimestampMatch {
	/** Offset of the `[` in the text. */
	from: number;
	/** Offset just after the `]`. */
	to: number;
	seconds: number;
}

/**
 * `[m:ss]` / `[mm:ss]` / `[h:mm:ss]` in a line of text: transcript markers (inside `**…**`)
 * and summary citations. Wikilinks (`[[…]]`), markdown links (`[0:12](…)`) and checkboxes are
 * not timestamps.
 */
export function findTimestamps(text: string): TimestampMatch[] {
	const out: TimestampMatch[] = [];
	const re = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const from = m.index;
		const to = from + m[0].length;
		if (text[from - 1] === "[" || text[to] === "]" || text[to] === "(") continue;
		const seconds = parseTimestamp(m[1] ?? "");
		if (seconds !== null) out.push({ from, to, seconds });
	}
	return out;
}

const AUDIO_EXT = /\.(?:webm|ogg|oga|opus|m4a|mp3|wav|flac|aac|mp4|3gp)$/i;

/** The note's recording: frontmatter `audio:` (a wikilink or a path), else the first audio embed. Returns the link text (name or path). */
export function audioLinkOfNote(markdown: string): string | null {
	const fm = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
	const fromFm = /^audio:\s*"?(?:\[\[)?([^\]"|\n]+?)(?:\|[^\]]*)?(?:\]\])?"?\s*$/m.exec(fm)?.[1]?.trim();
	if (fromFm) return fromFm;
	for (const m of stripFrontmatter(markdown).matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
		const link = (m[1] ?? "").trim();
		if (AUDIO_EXT.test(link)) return link;
	}
	return null;
}

// ----------------------------------------------------------------------- marks

export type MarkKind = "important" | "confusing";

export interface TranscriptMark {
	/** Seconds into the recording when the student pressed the button. */
	at: number;
	kind: MarkKind;
}

export const MARK_LABELS: Record<MarkKind, string> = {
	important: "⭐ Important",
	confusing: "❓ Confusing",
};

export function markLine(mark: TranscriptMark): string {
	return `**[${formatTimestamp(mark.at)}]** ${MARK_LABELS[mark.kind]}`;
}

/** The mark kind of a transcript line written by `markLine`, else null. */
export function markOfLine(line: string): MarkKind | null {
	const m = /^\*\*\[[\d:]+\]\*\*\s+(⭐ Important|❓ Confusing)\s*$/u.exec(line.trim());
	if (!m) return null;
	return m[1]?.startsWith("⭐") ? "important" : "confusing";
}

// ------------------------------------------------------------------ paragraphs

export interface Paragraph {
	start: number;
	end: number;
	text: string;
	/** Seconds of silence before it (Infinity for the first). */
	gapBefore: number;
}

/** Same grouping as `transcriptToMarkdown`: a new paragraph after a pause of `gapSec` or at ~`maxChars`. */
export function groupParagraphs(segments: TranscriptSegment[], gapSec = 2.5, maxChars = 700): Paragraph[] {
	const out: Paragraph[] = [];
	let current: Paragraph | null = null;
	for (const seg of segments) {
		const text = seg.text.trim();
		if (!text) continue;
		const gap: number = current ? seg.start - current.end : Infinity;
		if (!current || gap > gapSec || current.text.length + text.length > maxChars) {
			if (current) out.push(current);
			current = { start: seg.start, end: seg.end, text, gapBefore: gap };
		} else {
			current.text += (!/\s$/.test(current.text) && !/^[,.;:!?)]/.test(text) ? " " : "") + text;
			current.end = seg.end;
		}
	}
	if (current) out.push(current);
	return out;
}

/** Things the lecturer says to the room that end in "?" but are not questions from class. */
const RHETORICAL = /^(?:(?:so|and|okay|ok|alright|all right|now|well)[,\s]+)*(?:any (?:more |other |further )?questions|questions|(?:does|did) (?:that|this|it|everyone|everybody|anyone|anybody) (?:make sense|get (?:it|that))|(?:is|was) (?:that|this|everyone|everybody) (?:clear|okay|ok|good|with me)|(?:are )?(?:we|you|y'all) (?:all )?(?:good|okay|ok|with me|following)|who knows|anyone|anybody|everyone|everybody|what else)\b/i;

/**
 * Conservative "someone in the room asked a question" test: a short paragraph (3–45 words)
 * that ends in "?", started after a real pause (so it is its own turn, not the middle of the
 * lecturer's monologue), is not a stock check-in ("Any questions?", "Does that make sense?"),
 * and is followed by another paragraph (the answer). Speakers are not identified: a question the
 * lecturer puts to the class can be marked too.
 */
export function isQuestionTurn(p: Paragraph, next: Paragraph | undefined, gapSec = 2.5): boolean {
	const text = p.text.trim();
	if (!next || !text.endsWith("?")) return false;
	if (p.gapBefore !== Infinity && p.gapBefore <= gapSec) return false;
	const words = text.split(/\s+/).length;
	if (words < 3 || words > 45) return false;
	if (RHETORICAL.test(text)) return false;
	return true;
}

export const QUESTION_PREFIX = "**Q:**";

export interface RenderOptions {
	marks?: TranscriptMark[];
	/** Prefix questions from class with `**Q:**` (see `isQuestionTurn`). */
	markQuestions?: boolean;
	gapSec?: number;
	maxChars?: number;
}

/**
 * Transcript markdown with marks and questions: paragraphs as `**[m:ss]** text`, a question
 * from class as `**[m:ss]** **Q:** text`, and each mark on its own line after the paragraph
 * that was being spoken when it was set (`**[m:ss]** ⭐ Important`).
 */
export function renderTranscript(segments: TranscriptSegment[], opts: RenderOptions = {}): string {
	const gapSec = opts.gapSec ?? 2.5;
	const paragraphs = groupParagraphs(segments, gapSec, opts.maxChars ?? 700);
	const marks = [...(opts.marks ?? [])].sort((a, b) => a.at - b.at);
	const blocks: string[] = [];
	let mi = 0;
	paragraphs.forEach((p, i) => {
		// Marks set before this paragraph started belong after the previous one.
		while (mi < marks.length && (marks[mi]?.at ?? 0) < p.start && blocks.length > 0) blocks.push(markLine(marks[mi++]));
		const q = opts.markQuestions && isQuestionTurn(p, paragraphs[i + 1], gapSec);
		blocks.push(`**[${formatTimestamp(p.start)}]** ${q ? `${QUESTION_PREFIX} ` : ""}${p.text}`);
	});
	while (mi < marks.length) blocks.push(markLine(marks[mi++]));
	return blocks.join("\n\n");
}

/** A slide link added by transcript ↔ slide alignment at the end of a paragraph. */
export const SLIDE_LINK_TAIL = / · \[\[[^\]|]+\|slide \d+\]\]$/;

export interface ParsedParagraph {
	start: number;
	text: string;
	/** Set on mark lines (`⭐ Important`, `❓ Confusing`). */
	mark?: MarkKind;
	/** The paragraph was marked as a question from class. */
	question?: boolean;
	/** Index of the line in the section body. */
	line: number;
}

/**
 * Paragraphs of a Transcript section: every line starting with `**[m:ss]**`, with the marker,
 * the `**Q:**` prefix and an alignment slide link removed from `text`. Lines that continue a
 * paragraph (no marker) are joined to it; embeds and placeholders are skipped.
 */
export function parseTranscript(section: string): ParsedParagraph[] {
	const out: ParsedParagraph[] = [];
	section.split("\n").forEach((raw, line) => {
		const t = raw.trim();
		if (!t || /^!\[\[[^\]]*\]\]$/.test(t) || /^_[^_]*_$/.test(t)) return;
		const m = /^\*\*\[([\d:]+)\]\*\*\s*(.*)$/.exec(t);
		const seconds = m ? parseTimestamp(m[1] ?? "") : null;
		if (!m || seconds === null) {
			const last = out[out.length - 1];
			if (last && !last.mark && !t.startsWith("#")) last.text = `${last.text} ${t.replace(SLIDE_LINK_TAIL, "")}`.trim();
			return;
		}
		const mark = markOfLine(t);
		if (mark) {
			out.push({ start: seconds, text: MARK_LABELS[mark], mark, line });
			return;
		}
		let text = (m[2] ?? "").replace(SLIDE_LINK_TAIL, "");
		const question = text.startsWith(QUESTION_PREFIX);
		if (question) text = text.slice(QUESTION_PREFIX.length).trim();
		out.push({ start: seconds, text, ...(question ? { question } : {}), line });
	});
	return out;
}

/** True when a transcript holds student marks. */
export function hasMarks(transcript: string): boolean {
	return transcript.split("\n").some((l) => markOfLine(l) !== null);
}

/** True when a transcript holds `**Q:**` questions from class. */
export function hasQuestions(transcript: string): boolean {
	return /^\*\*\[[\d:]+\]\*\*\s+\*\*Q:\*\*/m.test(transcript);
}

/** Plain text of the last `minutes` of a live transcript (segments on the recording timeline). */
export function recentText(segments: TranscriptSegment[], nowSec: number, minutes: number): string {
	const since = nowSec - minutes * 60;
	return segments
		.filter((s) => s.end >= since)
		.map((s) => s.text.trim())
		.filter(Boolean)
		.join(" ");
}
