// A short course vocabulary for whisper's `prompt`. Whisper conditions on the prompt text, so
// names and terms it has "seen" there are spelled right far more often ("Kullback-Leibler",
// "Dijkstra", the professor's name). whisper.cpp keeps at most n_text_ctx/2 = 224 prompt tokens
// and drops the *start* when it is longer, so the vocabulary goes first, stays small (≤ 80 words),
// and the transcript tail (which keeps sentences coherent across chunks) goes last.

import { sectionBody } from "./notes";

/** Upper bound on vocabulary words in the prompt (≈ 120–160 tokens), leaving room for the tail. */
export const MAX_VOCAB_WORDS = 80;
/** Characters of the transcript tail kept after the vocabulary. */
export const PROMPT_TAIL_CHARS = 200;

const COMMON = new Set(
	(
		"the a an and or of to in on for with is are was were be been being this that these those it its as at by from into than then there here we you they he she our your their his her not no yes do does did have has had will would can could should may might must shall about over under more most less least very also just only so such which what when where who whom whose why how all any some each other another both either neither every many much few lot lots one two three four five six seven eight nine ten first second third last next new old same different " +
		"page slide slides lecture lectures today week chapter section example examples figure table note notes summary overview introduction intro outline agenda question questions answer answers review recap homework assignment exam quiz due reading readings course class professor student students university " +
		"using used use uses make makes made take takes given give gives get gets let lets see show shows find found way ways thing things part parts case cases point points time times number numbers value values result results data set sets type types form forms term terms called also well good great important main key basic simple general different following based within without between because however therefore thus hence where while each must like"
	).split(" "),
);

/**
 * Distinctive terms from slide text: acronyms, CamelCase and hyphenated words, words with digits,
 * capitalised words that are not just sentence starts, and frequent long words. Returns them
 * best first, each once (case-insensitive).
 */
export function distinctiveTerms(text: string, max = MAX_VOCAB_WORDS): string[] {
	const counts = new Map<string, { term: string; score: number; seen: number }>();
	const lines = text
		.split("\n")
		.map((l) => l.replace(/^>\s?/, "").trim())
		.filter((l) => l && !/^--- (?:Page|Slide) \d+ ---$/.test(l) && !/^\[!/.test(l));
	for (const line of lines) {
		const words = line.split(/[^\p{L}\p{N}+#'’-]+/u).filter(Boolean);
		words.forEach((raw, i) => {
			const word = raw.replace(/^['’-]+|['’-]+$/g, "");
			if (word.length < 3 || /^\d+$/.test(word)) return;
			const lower = word.toLowerCase();
			if (COMMON.has(lower)) return;
			let weight = 0;
			if (/^[A-Z]{2,6}s?$/.test(word)) weight = 3; // acronym
			else if (/[a-z][A-Z]/.test(word) || /\p{L}-\p{L}/u.test(word) || /\p{L}\d|\d\p{L}/u.test(word)) weight = 3;
			else if (/^\p{Lu}/u.test(word) && i > 0) weight = 2; // capitalised mid-sentence: a name
			else if (word.length >= 8) weight = 1;
			else if (word.length >= 6) weight = 0.5;
			if (weight === 0) return;
			const entry = counts.get(lower);
			if (entry) {
				entry.score += weight;
				entry.seen++;
				// Prefer the capitalised spelling of a name seen in both forms.
				if (/^\p{Lu}/u.test(word) && !/^\p{Lu}/u.test(entry.term)) entry.term = word;
			} else {
				counts.set(lower, { term: word, score: weight, seen: 1 });
			}
		});
	}
	return [...counts.values()]
		.filter((e) => e.score >= 2 || e.seen >= 2)
		.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
		.slice(0, max)
		.map((e) => e.term);
}

/** The bold terms of a summary's "Terms and definitions" section (`**term** — definition`). */
export function definedTerms(summary: string): string[] {
	const body = sectionBody(summary, "Terms and definitions");
	if (!body) return [];
	const out: string[] = [];
	for (const line of body.split("\n")) {
		const m = /^\s*[-*+]\s+\*\*([^*]{2,60})\*\*/.exec(line);
		const term = m?.[1]?.trim();
		if (term) out.push(term);
	}
	return out;
}

export interface VocabularyInput {
	/** Course name, professor or other names that must be spelled right. */
	names?: string[];
	/** Terms defined in earlier lectures' summaries (most recent first). */
	defined?: string[];
	/** Slide text of the matched or most recent deck. */
	slideText?: string;
}

/**
 * Merges names, defined terms and distinctive slide terms into one list of at most `maxWords`
 * words in total (multi-word terms count each word). Order: names, slide terms, defined terms.
 */
export function buildVocabulary(input: VocabularyInput, maxWords = MAX_VOCAB_WORDS): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let words = 0;
	const add = (term: string): void => {
		const t = term.replace(/\s+/g, " ").trim();
		const key = t.toLowerCase();
		if (!t || seen.has(key) || t.length > 60) return;
		const n = t.split(" ").length;
		if (words + n > maxWords) return;
		seen.add(key);
		out.push(t);
		words += n;
	};
	for (const n of input.names ?? []) add(n);
	const slide = input.slideText ? distinctiveTerms(input.slideText) : [];
	const defined = input.defined ?? [];
	// Interleave slide and defined terms so neither crowds the other out.
	for (let i = 0; i < Math.max(slide.length, defined.length); i++) {
		if (slide[i]) add(slide[i] ?? "");
		if (defined[i]) add(defined[i] ?? "");
	}
	return out;
}

/**
 * Words from the "Extra vocabulary" setting that apply to `course`: lines `Course = a, b, c`
 * (course compared case-insensitively) and lines without `=`, which apply to every course.
 */
export function extraVocabulary(setting: string, course: string): string[] {
	const out: string[] = [];
	const want = course.trim().toLowerCase();
	for (const raw of setting.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.indexOf("=");
		if (idx > 0 && line.slice(0, idx).trim().toLowerCase() !== want) continue;
		out.push(...(idx > 0 ? line.slice(idx + 1) : line).split(",").map((w) => w.trim()).filter(Boolean));
	}
	return out;
}

/** The `prompt` for one whisper request: vocabulary first (dropped first if over budget), then the transcript tail. */
export function composeWhisperPrompt(vocab: string[], tail?: string, tailChars = PROMPT_TAIL_CHARS): string | undefined {
	const t = (tail ?? "").slice(-tailChars).trim();
	const v = vocab.length ? `Glossary: ${vocab.join(", ")}.` : "";
	const prompt = [v, t].filter(Boolean).join(" ");
	return prompt || undefined;
}
