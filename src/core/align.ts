// Transcript ↔ slide alignment: which slide was on screen while each transcript paragraph was
// spoken. Each paragraph is compared with every page's text (TF-IDF cosine), then a Viterbi pass
// picks one page per paragraph that maximises similarity while charging for moving between pages
// (a little for moving forward, a lot for going back), so the order stays mostly monotonic. Where
// the slide changes, the paragraph gets a page link: ` · [[deck.pdf#page=12|slide 12]]`.

import { tfidfSimilarities, tokenize } from "./match";
import { parseTranscript, SLIDE_LINK_TAIL } from "./transcript";

export interface SlidePage {
	/** File name as embedded in the Slides section, e.g. `Lecture 5.pdf`. */
	deck: string;
	page: number;
	text: string;
}

/**
 * Pages of the decks in a Slides section: each `![[deck.pdf]]` embed followed by its folded
 * "Slide text" callout, whose `--- Page N ---` (PDF) or `--- Slide N ---` (PowerPoint) lines
 * separate the pages. Decks without extracted text have no pages.
 */
export function parseSlidePages(slidesSection: string): SlidePage[] {
	const pages: SlidePage[] = [];
	let deck: string | null = null;
	let current: SlidePage | null = null;
	for (const raw of slidesSection.split("\n")) {
		const line = raw.trim();
		const embed = /^!\[\[([^\]|#]+\.(?:pdf|pptx|ppt))(?:[|#][^\]]*)?\]\]$/i.exec(line);
		if (embed) {
			if (current) pages.push(current);
			current = null;
			deck = (embed[1] ?? "").trim();
			continue;
		}
		if (!line.startsWith(">") || !deck) continue;
		const body = line.replace(/^>\s?/, "");
		const marker = /^--- (?:Page|Slide) (\d+) ---$/.exec(body.trim());
		if (marker) {
			if (current) pages.push(current);
			current = { deck, page: Number(marker[1]), text: "" };
			continue;
		}
		if (current && body.trim() && !/^\[!/.test(body)) current.text += `${current.text ? "\n" : ""}${body.trim()}`;
	}
	if (current) pages.push(current);
	return pages.filter((p) => tokenize(p.text).length > 0);
}

export interface AlignOptions {
	/** Cost of moving to the next page. */
	forwardCost: number;
	/** Extra cost per page skipped when moving forward. */
	skipCost: number;
	/** Cost of going back to an earlier page (lecturers do, but rarely). */
	backwardCost: number;
	/** A paragraph must be at least this similar to its page for a link to be added. */
	minSimilarity: number;
}

export const DEFAULT_ALIGN: AlignOptions = { forwardCost: 0.02, skipCost: 0.004, backwardCost: 0.25, minSimilarity: 0.08 };

/**
 * One page index per paragraph (into `pages`), or -1 for all paragraphs when there are no pages.
 * `similarity[i]` is paragraph i's TF-IDF cosine with its chosen page.
 */
export function alignParagraphs(paragraphs: string[], pages: SlidePage[], opts: Partial<AlignOptions> = {}): { page: number[]; similarity: number[] } {
	const o = { ...DEFAULT_ALIGN, ...opts };
	const K = pages.length;
	const P = paragraphs.length;
	if (K === 0 || P === 0) return { page: paragraphs.map(() => -1), similarity: paragraphs.map(() => 0) };
	const texts = pages.map((p) => p.text);
	const sim = paragraphs.map((p) => tfidfSimilarities(p, texts));
	const trans = (j: number, k: number): number => (j === k ? 0 : k > j ? o.forwardCost + o.skipCost * (k - j - 1) : o.backwardCost);
	let score = sim[0]?.map((s, k) => s - o.skipCost * k) ?? [];
	const back: number[][] = [];
	for (let i = 1; i < P; i++) {
		const row = sim[i] ?? [];
		const next = new Array<number>(K);
		const from = new Array<number>(K);
		for (let k = 0; k < K; k++) {
			let best = -Infinity;
			let arg = k;
			for (let j = 0; j < K; j++) {
				const v = (score[j] ?? -Infinity) - trans(j, k);
				if (v > best || (v === best && j === k)) {
					best = v;
					arg = j;
				}
			}
			next[k] = best + (row[k] ?? 0);
			from[k] = arg;
		}
		back.push(from);
		score = next;
	}
	let k = score.reduce((bi, v, i, arr) => (v > (arr[bi] ?? -Infinity) ? i : bi), 0);
	const page = new Array<number>(P);
	for (let i = P - 1; i >= 0; i--) {
		page[i] = k;
		if (i > 0) k = back[i - 1]?.[k] ?? k;
	}
	return { page, similarity: page.map((pk, i) => sim[i]?.[pk] ?? 0) };
}

/** Link to one page: `[[deck.pdf#page=12|slide 12]]` (a PowerPoint file cannot open at a page, so it links the file). */
export function slideLink(p: SlidePage): string {
	return /\.pdf$/i.test(p.deck) ? `[[${p.deck}#page=${p.page}|slide ${p.page}]]` : `[[${p.deck}|slide ${p.page}]]`;
}

/**
 * Adds a slide link to each transcript paragraph where the slide changes, replacing links from
 * an earlier run. Paragraphs too unlike any slide keep the current slide and get no link. Mark
 * lines are left alone. Returns the new section and how many links it holds.
 */
export function alignTranscriptToSlides(transcriptSection: string, slidesSection: string, opts: Partial<AlignOptions> = {}): { text: string; links: number } {
	const minSim = opts.minSimilarity ?? DEFAULT_ALIGN.minSimilarity;
	const lines = transcriptSection.split("\n").map((l) => l.replace(/\s+$/, "").replace(SLIDE_LINK_TAIL, ""));
	const pages = parseSlidePages(slidesSection);
	const paragraphs = parseTranscript(transcriptSection).filter((p) => !p.mark);
	if (pages.length === 0 || paragraphs.length === 0) return { text: lines.join("\n"), links: 0 };
	const { page, similarity } = alignParagraphs(paragraphs.map((p) => p.text), pages, opts);
	let current = -1;
	let links = 0;
	paragraphs.forEach((p, i) => {
		const k = page[i] ?? -1;
		if (k < 0 || (similarity[i] ?? 0) < minSim || k === current) return;
		current = k;
		const target = pages[k];
		if (!target) return;
		lines[p.line] = `${lines[p.line] ?? ""} · ${slideLink(target)}`;
		links++;
	});
	return { text: lines.join("\n"), links };
}
