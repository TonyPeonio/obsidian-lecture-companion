import { describe, expect, it } from "vitest";
import { isConfident, rankSlides, sequenceNumber, slideLikeness, tfidfSimilarities, tokenize } from "../src/core/match";

const transcript = `**[0:00]** Today we continue with sorting. Merge sort splits the array, recursion on each half, then the merge step runs in linear time.
**[2:10]** Quick sort chooses a pivot; the partition step is where the work happens. Worst case quadratic, average n log n.
**[6:40]** Compare the recurrence relations for merge sort and quick sort; the master theorem gives both.`;

const deckText = (n: number, topic: string): string =>
	Array.from({ length: n }, (_, i) => `--- Page ${i + 1} ---\n${topic} ${i + 1}\nkey point\nanother short bullet`).join("\n\n");

const decks = [
	{ id: 1, name: "Lecture 11 - Sorting I.pdf", text: `${deckText(20, "Sorting")}\nMerge sort: divide, recursion, merge step linear time. Quick sort: pivot, partition, average case n log n, worst case quadratic. Recurrence relations, master theorem.`, updatedAt: "2026-09-01T10:00:00Z" },
	{ id: 2, name: "Lecture 12 - Hashing.pdf", text: `${deckText(20, "Hashing")}\nHash tables, hash functions, collisions, chaining, open addressing, load factor, amortized resizing.`, updatedAt: "2026-11-05T10:00:00Z" },
	{ id: 3, name: "HW4 sorting worksheet.pdf", text: "Problem 1. Trace merge sort on the array below and state the recurrence relation. Problem 2. Partition the array with quick sort using the last element as pivot; give the worst case. Problem 3. Apply the master theorem to the recurrence.", updatedAt: "2026-11-05T08:00:00Z" },
	{ id: 4, name: "Syllabus.pdf", text: "Office hours, grading policy, late days, academic integrity, exam dates.", updatedAt: "2026-11-05T08:00:00Z" },
	{ id: 5, name: "Lab 3 scans.pdf", text: "", updatedAt: "2026-11-04T08:00:00Z" },
];

describe("tokenize / similarity", () => {
	it("drops stop words, timestamps and short tokens", () => {
		expect(tokenize("**[1:02]** The merge-sort of C++ is O(n) and 12 fast")).toEqual(["merge", "sort", "c++", "fast"]);
	});

	it("scores matching text far above unrelated text", () => {
		const sims = tfidfSimilarities(transcript, decks.map((d) => d.text));
		expect(sims[0]).toBeGreaterThan(0.2);
		expect(sims[1]).toBeLessThan(0.1);
		expect(sims[4]).toBe(0);
		expect(tfidfSimilarities("", ["x"])).toEqual([0]);
	});
});

describe("sequenceNumber", () => {
	it("reads series numbers in common naming styles", () => {
		expect(sequenceNumber("Lecture 12 - Hashing.pdf")).toBe(12);
		expect(sequenceNumber("L07_sorting.pptx")).toBe(7);
		expect(sequenceNumber("Week 5 slides.pdf")).toBe(5);
		expect(sequenceNumber("ch3-trees.pdf")).toBe(3);
		expect(sequenceNumber("12 - Sorting.pdf")).toBe(12);
		expect(sequenceNumber("Syllabus.pdf")).toBeNull();
	});
});

describe("slideLikeness", () => {
	it("uses unambiguous name words and the file type", () => {
		expect(slideLikeness("Lecture 12 - Hashing.pdf", "")).toBe(1);
		expect(slideLikeness("TranscriptomeAnalysis_Part6_tSNE.pptx", "")).toBe(1);
		expect(slideLikeness("anything.pptx", "")).toBe(1);
		// A page that links the file as "slides" vouches for it, whatever the file is called.
		expect(slideLikeness("unsupervised.pdf", "dense text ".repeat(400), "slides")).toBe(1);
		expect(slideLikeness("unsupervised.pdf", "dense text ".repeat(400), "homework solutions")).toBeLessThan(1);
		expect(slideLikeness("HW4 sorting worksheet.pdf", deckText(20, "x"))).toBe(-1);
		expect(slideLikeness("Syllabus.pdf", "")).toBe(-1);
		expect(slideLikeness("Problem Set 3 solutions.pdf", "")).toBe(-1);
	});

	it("falls back to page structure for neutral names", () => {
		expect(slideLikeness("tsne.pdf", deckText(24, "tSNE"))).toBeGreaterThanOrEqual(0.5);
		const paper = Array.from({ length: 12 }, (_, i) => `--- Page ${i + 1} ---\n${"A long paragraph of dense prose that runs well past sixty characters per line, as journal articles do. ".repeat(20)}`).join("\n\n");
		expect(slideLikeness("smith2024.pdf", paper)).toBeLessThanOrEqual(-0.5);
		expect(slideLikeness("scan.pdf", "")).toBe(0);
	});
});

describe("rankSlides", () => {
	it("ranks the matching deck above a worksheet on the same topic and pre-selects only it", () => {
		const ranked = rankSlides(transcript, decks, { previousNames: ["Lecture 10 - Recursion.pdf"] });
		expect(ranked[0]?.id).toBe(1);
		expect(ranked[0]?.selected).toBe(true);
		expect(ranked[0]?.reasons).toContain("looks like a deck");
		expect(ranked[0]?.reasons).toContain("#11 in its series");
		expect(ranked.filter((r) => r.selected).map((r) => r.id)).toEqual([1]);
		const worksheet = ranked.find((r) => r.id === 3);
		expect(worksheet?.slideLikeness).toBe(-1);
		expect(worksheet?.reasons).toContain("does not look like a deck");
		expect(worksheet?.similarity).toBeGreaterThan(0.1); // same vocabulary, still outranked
		expect(ranked.find((r) => r.id === 5)?.reasons).toContain("no text in file");
		// Recency plays no part: the freshly changed hashing deck stays below.
		expect(ranked.findIndex((r) => r.id === 2)).toBeGreaterThan(0);
		expect(isConfident(ranked)).toBe(true);
	});

	it("labels decks used before without changing their rank", () => {
		const ranked = rankSlides(transcript, decks, { previousNames: ["Lecture 11 - Sorting I.pdf"] });
		expect(ranked[0]?.id).toBe(1);
		expect(ranked[0]?.reasons).toContain("used in an earlier lecture");
	});

	it("ranks by deck-likeness alone without a transcript and selects the top deck only", () => {
		const ranked = rankSlides("", decks, { previousNames: [] });
		expect(ranked.slice(0, 2).map((r) => r.id).sort()).toEqual([1, 2]);
		expect(ranked.filter((r) => r.selected).length).toBe(1);
		expect(ranked[ranked.length - 1]?.id).toBeOneOf([3, 4]);
		expect(isConfident(ranked)).toBe(false);
	});

	it("pre-selects nothing when nothing looks like a deck and there is no transcript", () => {
		const ranked = rankSlides("", [decks[3] as (typeof decks)[number], decks[4] as (typeof decks)[number]], { previousNames: [] });
		expect(ranked.some((r) => r.selected)).toBe(false);
		expect(rankSlides(transcript, [], { previousNames: [] })).toEqual([]);
		expect(isConfident([])).toBe(false);
	});
});
