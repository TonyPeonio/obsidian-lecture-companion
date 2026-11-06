// Which slide deck goes with this lecture? Rank a course's decks by how much their text
// overlaps the transcript (TF-IDF cosine), with small priors for "next in the series" and
// recency. Pure functions; the plugin gathers candidates and shows the picker.

export interface SlideCandidate {
	id: number;
	name: string;
	/** Extracted text; empty when the deck is image-only or extraction failed. */
	text: string;
	moduleName?: string;
	/** ISO timestamp of the last change in Canvas. */
	updatedAt: string;
}

export interface RankedSlide extends SlideCandidate {
	/** 0..1-ish; higher is better. */
	score: number;
	similarity: number;
	sequenceBonus: number;
	recencyBonus: number;
	/** Human-readable reasons shown in the picker. */
	reasons: string[];
	/** Pre-checked in the picker. */
	selected: boolean;
}

export interface RankOptions {
	/** Deck names already attached to earlier lectures of this course (for the sequence prior). */
	previousNames: string[];
	/** YYYY-MM-DD of the lecture, for the recency prior. */
	lectureDate: string;
	/** Days around the lecture date that count as "recent". */
	recentDays?: number;
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

function daysBetween(iso: string, date: string): number | null {
	const t = Date.parse(iso);
	const d = Date.parse(`${date}T12:00:00`);
	if (!Number.isFinite(t) || !Number.isFinite(d)) return null;
	return Math.abs(t - d) / 86_400_000;
}

export function rankSlides(transcript: string, candidates: SlideCandidate[], opts: RankOptions): RankedSlide[] {
	const sims = tfidfSimilarities(transcript, candidates.map((c) => c.text));
	const prevNumbers = opts.previousNames.map(sequenceNumber).filter((n): n is number => n !== null);
	const nextInSeries = prevNumbers.length ? Math.max(...prevNumbers) + 1 : null;
	const previous = new Set(opts.previousNames.map((n) => n.toLowerCase()));
	const recentDays = opts.recentDays ?? 3;
	const hasTranscript = tokenize(transcript).length >= 20;

	const ranked: RankedSlide[] = candidates.map((c, i) => {
		const reasons: string[] = [];
		const similarity = sims[i] ?? 0;
		if (!c.text.trim()) reasons.push("no text in file");
		else if (hasTranscript) reasons.push(`${Math.round(similarity * 100)}% match with transcript`);
		let sequenceBonus = 0;
		const n = sequenceNumber(c.name);
		if (n !== null && nextInSeries !== null) {
			if (n === nextInSeries) {
				sequenceBonus = 0.15;
				reasons.push(`next in series (#${n})`);
			} else if (n > nextInSeries && n <= nextInSeries + 2) {
				sequenceBonus = 0.05;
			}
		}
		if (previous.has(c.name.toLowerCase())) reasons.push("used in an earlier lecture");
		let recencyBonus = 0;
		const age = daysBetween(c.updatedAt, opts.lectureDate);
		if (age !== null && age <= recentDays) {
			recencyBonus = 0.1;
			reasons.push(age < 1 ? "changed that day" : `changed ${Math.round(age)} day${Math.round(age) === 1 ? "" : "s"} from the lecture`);
		}
		return { ...c, similarity, sequenceBonus, recencyBonus, score: similarity + sequenceBonus + recencyBonus, reasons, selected: false };
	});

	ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	const best = ranked[0];
	if (best) {
		if (hasTranscript) {
			// Pre-select decks that are clearly in play; never more than three.
			const floor = Math.max(0.12, best.similarity * 0.6);
			let count = 0;
			for (const r of ranked) {
				if (r.similarity >= floor && count < 3 && (r.similarity > 0 || r === best)) {
					r.selected = true;
					count++;
				}
			}
			if (count === 0) best.selected = best.score > 0;
		} else {
			for (const r of ranked) r.selected = r.sequenceBonus >= 0.15 || r.recencyBonus > 0;
			if (!ranked.some((r) => r.selected)) best.selected = true;
		}
	}
	return ranked;
}

/** True when the top candidate stands out enough to attach without asking. */
export function isConfident(ranked: RankedSlide[]): boolean {
	const [a, b] = ranked;
	if (!a || a.similarity < 0.25) return false;
	if (!b) return true;
	return a.similarity >= b.similarity * 1.5 || a.similarity - b.similarity >= 0.2;
}
