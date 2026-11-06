// Which slide deck goes with this lecture? Rank a course's files by how much their text
// overlaps the transcript (TF-IDF cosine) and by how much they look like a deck rather than a
// worksheet or syllabus. Upload dates play no part. Pure functions; the plugin gathers
// candidates and shows the picker.

export interface SlideCandidate {
	id: number;
	name: string;
	/** Extracted text; empty when the deck is image-only or extraction failed. */
	text: string;
	moduleName?: string;
	/** Text of the Canvas page link that points at the file ("slides"), when it was found on a page. */
	linkText?: string;
	/** ISO timestamp of the last change in Canvas. */
	updatedAt: string;
}

export interface RankedSlide extends SlideCandidate {
	/** similarity + 0.1 × slideLikeness; higher is better. */
	score: number;
	/** 0..1 TF-IDF cosine between the deck's text and the transcript. */
	similarity: number;
	/** -1 (clearly not a deck: worksheet, syllabus…) to +1 (clearly a deck). */
	slideLikeness: number;
	/** Human-readable reasons shown in the picker. */
	reasons: string[];
	/** Pre-checked in the picker. */
	selected: boolean;
}

export interface RankOptions {
	/** Deck names already attached to earlier lectures of this course (shown as a label only). */
	previousNames: string[];
}

const STOP = new Set(
	"the a an and or of to in on for with is are was were be been being this that these those it its as at by from into than then there here we you they he she i our your their his her not no yes do does did have has had will would can could should may might must shall about over under more most less least very also just only so such which what when where who whom whose why how all any some each other another both either neither every many much few lot lots one two three first second last new old same different".split(
		" ",
	),
);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/\*\*\[[\d:]+\]\*\*/g, " ") // transcript timestamps
		.split(/[^a-z0-9+#]+/)
		.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

function termCounts(tokens: string[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
	return m;
}

/** Cosine similarity between TF-IDF vectors built over `docs` (the transcript is doc 0). */
export function tfidfSimilarities(query: string, docs: string[]): number[] {
	const qTokens = tokenize(query);
	const docTokens = docs.map(tokenize);
	if (qTokens.length === 0) return docs.map(() => 0);
	const all = [qTokens, ...docTokens];
	const df = new Map<string, number>();
	for (const tokens of all) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
	const n = all.length;
	const idf = (t: string): number => Math.log(1 + n / (df.get(t) ?? 1));
	const vector = (tokens: string[]): Map<string, number> => {
		const v = new Map<string, number>();
		for (const [t, c] of termCounts(tokens)) v.set(t, (1 + Math.log(c)) * idf(t));
		return v;
	};
	const q = vector(qTokens);
	const qNorm = Math.sqrt([...q.values()].reduce((s, x) => s + x * x, 0));
	return docTokens.map((tokens) => {
		if (tokens.length === 0) return 0;
		const d = vector(tokens);
		let dot = 0;
		for (const [t, w] of d) dot += w * (q.get(t) ?? 0);
		const dNorm = Math.sqrt([...d.values()].reduce((s, x) => s + x * x, 0));
		return qNorm && dNorm ? dot / (qNorm * dNorm) : 0;
	});
}

/**
 * The number that orders a deck in its series: "Lecture 12", "L12", "Week 5", "Ch 7",
 * "12 - Sorting", "slides_12.pdf". Prefers a number that follows a series word; otherwise
 * the first number in the name. Years and 4+ digit numbers are ignored.
 */
export function sequenceNumber(name: string): number | null {
	const base = name.replace(/\.[a-z0-9]+$/i, "");
	const keyed = /(?:lecture|lec|lect|class|session|week|wk|chapter|ch|chap|module|mod|unit|part|topic|day|l|w|m|u)\s*[-_ #.]*\s*(\d{1,3})(?!\d)/i.exec(base);
	if (keyed) return Number(keyed[1]);
	const any = /(?<![\d.])(\d{1,3})(?![\d.])/.exec(base);
	return any ? Number(any[1]) : null;
}

const DECK_WORDS = /\b(slides?|slideshow|deck|lecture|lec|lect|lesson|class|session|week|wk|chapter|chap|ch|module|unit|part|topic|presentation|intro(?:duction)?|overview|notes)\b|\bl\d{1,2}\b/i;
const NOT_DECK_WORDS = /\b(homework|hw|assignment|assign|worksheet|exercise|exercises|lab|labs|quiz|quizzes|exam|midterm|final|test|syllabus|rubric|solution|solutions|answers?|key|schedule|calendar|problem\s*set|pset|ps\d|project|proposal|report|paper|article|reading|readings|textbook|handout|form|template|grading|policy|submission|instructions)\b/i;

/**
 * How much a file looks like a lecture deck, from -1 (worksheet, syllabus, paper) to +1.
 * Name words decide when they are unambiguous; otherwise the PDF page structure does:
 * decks have many pages with little text per page and short lines.
 */
export function slideLikeness(name: string, text: string, linkText = ""): number {
	const base = name.replace(/\.[a-z0-9]+$/i, "");
	const ext = name.toLowerCase().split(".").pop() ?? "";
	// The page saying "slides" next to the link is as good a sign as the file name saying it.
	if (linkText && DECK_WORDS.test(linkText) && !NOT_DECK_WORDS.test(linkText)) return 1;
	const positive = DECK_WORDS.test(base);
	const negative = NOT_DECK_WORDS.test(base);
	if (negative && !positive) return -1;
	if (ext === "pptx" || ext === "ppt") return 1;
	if (positive && !negative) return 1;
	const pages = text.split(/^--- Page \d+ ---$/m).filter((p) => p.trim().length > 0);
	if (pages.length === 0) return positive ? 0.5 : 0;
	const lines = text.split("\n").filter((l) => l.trim().length > 0 && !/^--- Page/.test(l));
	const charsPerPage = text.length / pages.length;
	const shortLines = lines.length ? lines.filter((l) => l.length <= 60).length / lines.length : 0;
	let score = 0;
	score += pages.length >= 8 ? 0.3 : pages.length >= 4 ? 0.1 : -0.2;
	score += charsPerPage <= 700 ? 0.4 : charsPerPage <= 1500 ? 0 : -0.6;
	score += shortLines >= 0.7 ? 0.3 : shortLines >= 0.5 ? 0 : -0.3;
	return Math.max(-1, Math.min(1, score));
}

export function rankSlides(transcript: string, candidates: SlideCandidate[], opts: RankOptions): RankedSlide[] {
	const sims = tfidfSimilarities(transcript, candidates.map((c) => c.text));
	const previous = new Set(opts.previousNames.map((n) => n.toLowerCase()));
	const hasTranscript = tokenize(transcript).length >= 20;

	const ranked: RankedSlide[] = candidates.map((c, i) => {
		const reasons: string[] = [];
		const similarity = sims[i] ?? 0;
		if (!c.text.trim()) reasons.push("no text in file");
		else if (hasTranscript) reasons.push(`${Math.round(similarity * 100)}% match with transcript`);
		const likeness = slideLikeness(c.name, c.text, c.linkText);
		if (c.linkText) reasons.push(`linked as “${c.linkText}”`);
		if (likeness <= -0.5) reasons.push("does not look like a deck");
		else if (likeness >= 0.5) reasons.push("looks like a deck");
		if (previous.has(c.name.toLowerCase())) reasons.push("used in an earlier lecture");
		const n = sequenceNumber(c.name);
		if (n !== null && likeness > 0) reasons.push(`#${n} in its series`);
		return { ...c, similarity, slideLikeness: likeness, score: similarity + 0.1 * likeness, reasons, selected: false };
	});

	ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	// A lecture almost always has exactly one deck: pre-select only the top candidate, and only
	// when something recommends it (a text match, or deck-likeness when there is no transcript).
	const best = ranked[0];
	if (best && (hasTranscript ? best.similarity > 0 : best.slideLikeness > 0)) best.selected = true;
	return ranked;
}

/** True when the top candidate stands out enough to attach without asking (automatic mode). */
export function isConfident(ranked: RankedSlide[]): boolean {
	const [a, b] = ranked;
	if (!a || a.similarity < 0.2 || !a.selected) return false;
	if (!b) return true;
	return a.score >= b.score * 1.5 || a.score - b.score >= 0.15;
}
