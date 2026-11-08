// Summary faithfulness: does every `[mm:ss]` a summary cites point at a transcript paragraph
// that exists (within a window) and talks about the same thing (shares a content word)?
// Pure string functions, shared by `scripts/check-summaries.ts` and the unit tests.

import { findSection } from "./notes";

export interface TranscriptLine {
	/** Start time in seconds, from the `**[m:ss]**` marker. */
	sec: number;
	text: string;
}

export interface Citation {
	/** The `[m:ss]` as written. */
	raw: string;
	sec: number;
	/** The summary sentence (line) the citation belongs to, markdown and timestamps removed. */
	sentence: string;
}

export type CitationVerdict = "ok" | "no-transcript-line-in-window" | "no-shared-word";

export interface CitationResult {
	citation: Citation;
	supported: boolean;
	verdict: CitationVerdict;
	/** The transcript line that supports the citation, or the nearest one in the window. */
	line?: TranscriptLine;
}

export interface SummaryCheck {
	citations: number;
	supported: number;
	/** supported / citations, or null when there is nothing to check. */
	precision: number | null;
	results: CitationResult[];
}

/** Default half-width of the window around a cited time, in seconds. */
export const DEFAULT_WINDOW_SEC = 20;

const TIMESTAMP = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;

/** `[m:ss]` or `[h:mm:ss]` → seconds; null when the text is not a timestamp. */
export function parseTimestamp(raw: string): number | null {
	const m = /^\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?$/.exec(raw.trim());
	if (!m) return null;
	const a = Number(m[1]);
	const b = Number(m[2]);
	const c = m[3] === undefined ? null : Number(m[3]);
	return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
}

/** Paragraphs of a Transcript section: lines that start with `**[m:ss]**` (or a bare `[m:ss]`). */
export function parseTranscriptLines(transcript: string): TranscriptLine[] {
	const out: TranscriptLine[] = [];
	for (const raw of transcript.split("\n")) {
		const m = /^\s*(?:\*\*)?\[(\d{1,2}:\d{2}(?::\d{2})?)\](?:\*\*)?\s*(.*)$/.exec(raw);
		if (!m) continue;
		const sec = parseTimestamp(m[1] ?? "");
		if (sec === null) continue;
		out.push({ sec, text: (m[2] ?? "").trim() });
	}
	return out;
}

/**
 * Every `[m:ss]` in a summary, with the sentence it belongs to. Headings are skipped. A line
 * that holds nothing but the citation (or no content words) borrows the previous text line, so
 * a citation under a multi-line bullet still has something to compare against.
 */
export function extractCitations(summary: string): Citation[] {
	const out: Citation[] = [];
	let previous = "";
	for (const raw of summary.split("\n")) {
		if (/^\s*#{1,6}\s/.test(raw)) continue;
		const matches = [...raw.matchAll(TIMESTAMP)];
		const sentence = cleanSentence(raw);
		if (matches.length === 0) {
			if (sentence) previous = sentence;
			continue;
		}
		const text = contentWords(sentence).size > 0 ? sentence : previous;
		for (const m of matches) {
			const sec = parseTimestamp(m[0]);
			if (sec !== null) out.push({ raw: m[0], sec, sentence: text });
		}
		if (sentence) previous = sentence;
	}
	return out;
}

/** Strips list markers, timestamps, emphasis, links and inline code; collapses whitespace. */
export function cleanSentence(line: string): string {
	return line
		.replace(TIMESTAMP, " ")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
		.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\$[^$]*\$/g, " ")
		.replace(/\*\*|__|`|~~/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Function words plus the framing words summaries use that a lecturer never says ("the lecture introduces…"). */
export const STOPWORDS: ReadonlySet<string> = new Set(
	(
		"a an the and or but nor so yet if then else than as of at by for from in into on onto to with without within about above across after against along among around before behind below beneath beside between beyond during except inside like near off out outside over past since through throughout toward towards under until up upon via " +
		"i me my we us our you your he him his she her it its they them their this that these those who whom whose which what when where why how here there " +
		"is am are was were be been being have has had having do does did doing done will would shall should can could may might must ought need dare used " +
		"not no yes nor neither either both each every all any some few many much more most other another such same own only very too also just even still already again ever never always often sometimes once " +
		"one two three first second third next last new old same different several " +
		"get gets got getting make makes made making go goes went going come comes came coming take takes took taking give gives gave giving put puts say says said saying see sees saw seen let lets " +
		"because while although though whether unless however therefore thus hence moreover furthermore instead otherwise rather quite really simply basically actually " +
		"lecture lectures lecturer instructor professor class session course students student today discussed discusses discussing covers covered covering introduces introduced introducing explains explained explaining describes described describing defines defined defining notes noted mentions mentioned mentioning states stated stating emphasizes emphasized emphasised presents presented presenting shows shown showed demonstrates demonstrated illustrates illustrated reviews reviewed outlines outlined highlights highlighted begins began ends ended concludes concluded continues continued " +
		"example examples point points key important main also"
	).split(/\s+/),
);

/** Lower-cased words of at least two letters or digits that are not stopwords. */
export function contentWords(text: string): Set<string> {
	const out = new Set<string>();
	for (const token of text.toLowerCase().replace(/['’]s\b/g, "").split(/[^\p{L}\p{N}]+/u)) {
		if (token.length < 2 || STOPWORDS.has(token)) continue;
		out.add(token);
	}
	return out;
}

/** Same word, or one is the other plus a short suffix (reduction/reductions, align/aligned). */
export function wordsMatch(a: string, b: string): boolean {
	if (a === b) return true;
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	return short.length >= 4 && long.length - short.length <= 3 && long.startsWith(short);
}

export function sharesContentWord(a: string, b: string): boolean {
	const wa = contentWords(a);
	const wb = contentWords(b);
	for (const x of wa) for (const y of wb) if (wordsMatch(x, y)) return true;
	return false;
}

/**
 * A citation is supported when a transcript line starts within `windowSec` of the cited time
 * and shares a content word with the summary sentence. Among several candidate lines the one
 * that shares a word wins; otherwise the nearest is reported.
 */
export function checkCitation(citation: Citation, lines: TranscriptLine[], windowSec = DEFAULT_WINDOW_SEC): CitationResult {
	const candidates = lines.filter((l) => Math.abs(l.sec - citation.sec) <= windowSec).sort((a, b) => Math.abs(a.sec - citation.sec) - Math.abs(b.sec - citation.sec));
	if (candidates.length === 0) return { citation, supported: false, verdict: "no-transcript-line-in-window" };
	const hit = candidates.find((l) => sharesContentWord(citation.sentence, l.text));
	if (hit) return { citation, supported: true, verdict: "ok", line: hit };
	return { citation, supported: false, verdict: "no-shared-word", line: candidates[0] };
}

export function checkSummary(summary: string, transcript: string, windowSec = DEFAULT_WINDOW_SEC): SummaryCheck {
	const lines = parseTranscriptLines(transcript);
	const results = extractCitations(summary).map((c) => checkCitation(c, lines, windowSec));
	const supported = results.filter((r) => r.supported).length;
	return { citations: results.length, supported, precision: results.length ? supported / results.length : null, results };
}

export interface LectureSections {
	/** Heading that scopes the pair: the date heading in a per-course note, or "" for a per-lecture note. */
	scope: string;
	summary: string;
	transcript: string;
}

interface Heading {
	line: number;
	level: number;
	text: string;
}

function headings(lines: string[]): Heading[] {
	const out: Heading[] = [];
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (m) out.push({ line: i, level: m[1]?.length ?? 1, text: (m[2] ?? "").trim() });
	}
	return out;
}

/**
 * Every Summary/Transcript pair in a note. Handles the per-lecture layout (`## Summary`,
 * `## Transcript`) and the per-course layout (`## <date>` → `### Transcript`, `### Summary`);
 * the Transcript must be a sibling of the Summary under the same parent heading.
 */
export function lectureSectionsOf(markdown: string): LectureSections[] {
	const lines = markdown.split("\n");
	const hs = headings(lines);
	const bodyOf = (idx: number): string => {
		const h = hs[idx];
		if (!h) return "";
		let end = lines.length;
		for (let j = idx + 1; j < hs.length; j++) {
			const next = hs[j];
			if (next && next.level <= h.level) {
				end = next.line;
				break;
			}
		}
		return lines
			.slice(h.line + 1, end)
			.join("\n")
			.trim();
	};
	const sibling = (idx: number, text: string): number => {
		const h = hs[idx];
		if (!h) return -1;
		for (const dir of [1, -1]) {
			for (let j = idx + dir; j >= 0 && j < hs.length; j += dir) {
				const other = hs[j];
				if (!other || other.level < h.level) break;
				if (other.level === h.level && other.text.toLowerCase() === text) return j;
			}
		}
		return -1;
	};
	const out: LectureSections[] = [];
	for (let i = 0; i < hs.length; i++) {
		const h = hs[i];
		if (!h || h.text.toLowerCase() !== "summary") continue;
		const t = sibling(i, "transcript");
		if (t < 0) continue;
		let scope = "";
		for (let j = i - 1; j >= 0; j--) {
			const p = hs[j];
			if (p && p.level < h.level) {
				scope = p.text;
				break;
			}
		}
		out.push({ scope, summary: bodyOf(i), transcript: bodyOf(t) });
	}
	// A note with the plain layout but nothing found above (e.g. odd heading levels) still gets one try.
	if (out.length === 0) {
		const s = findSection(lines, "Summary");
		const t = findSection(lines, "Transcript");
		if (s && t) out.push({ scope: "", summary: lines.slice(s.bodyStart, s.bodyEnd).join("\n").trim(), transcript: lines.slice(t.bodyStart, t.bodyEnd).join("\n").trim() });
	}
	return out;
}
