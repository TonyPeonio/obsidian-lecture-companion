import { describe, expect, it } from "vitest";
import { isConfident, rankSlides, sequenceNumber, tfidfSimilarities, tokenize } from "../src/core/match";

const transcript = `**[0:00]** Today we continue with sorting. Merge sort splits the array, recursion on each half, then the merge step runs in linear time.
**[2:10]** Quick sort chooses a pivot; the partition step is where the work happens. Worst case quadratic, average n log n.
**[6:40]** Compare the recurrence relations for merge sort and quick sort; the master theorem gives both.`;

const decks = [
	{ id: 1, name: "Lecture 11 - Sorting I.pdf", text: "Sorting algorithms. Merge sort: divide, recursion, merge step linear time. Quick sort: pivot, partition, average case n log n, worst case quadratic. Recurrence relations, master theorem.", updatedAt: "2026-09-01T10:00:00Z" },
	{ id: 2, name: "Lecture 12 - Hashing.pdf", text: "Hash tables, hash functions, collisions, chaining, open addressing, load factor, amortized resizing.", updatedAt: "2026-09-01T10:00:00Z" },
	{ id: 3, name: "Lecture 10 - Recursion.pdf", text: "Recursion basics, call stack, base case, recurrence relations, towers of hanoi, master theorem.", updatedAt: "2026-09-01T10:00:00Z" },
	{ id: 4, name: "Syllabus.pdf", text: "Office hours, grading policy, late days, academic integrity, exam dates.", updatedAt: "2026-11-05T08:00:00Z" },
	{ id: 5, name: "Lab 3 scans.pdf", text: "", updatedAt: "2026-11-04T08:00:00Z" },
];

describe("tokenize / similarity", () => {
	it("drops stop words, timestamps and short tokens", () => {
		expect(tokenize("**[1:02]** The merge-sort of C++ is O(n) and 12 fast")).toEqual(["merge", "sort", "c++", "fast"]);
	});

	it("scores the matching deck far above the others", () => {
		const sims = tfidfSimilarities(transcript, decks.map((d) => d.text));
		expect(sims[0]).toBeGreaterThan(0.3);
		expect(sims[0]).toBeGreaterThan((sims[2] ?? 0) * 1.5);
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
		expect(sequenceNumber("CS101 Lecture 4.pdf")).toBe(4);
		expect(sequenceNumber("Syllabus 2026.pdf")).toBeNull();
		expect(sequenceNumber("Syllabus.pdf")).toBeNull();
	});
});

describe("rankSlides", () => {
	it("puts the transcript match first and pre-selects only clear matches", () => {
		const ranked = rankSlides(transcript, decks, { previousNames: ["Lecture 10 - Recursion.pdf"], lectureDate: "2026-11-05" });
		expect(ranked[0]?.id).toBe(1);
		expect(ranked[0]?.selected).toBe(true);
		expect(ranked[0]?.reasons[0]).toMatch(/% match with transcript/);
		expect(ranked[0]?.reasons).toContain("next in series (#11)");
		expect(ranked.filter((r) => r.selected).map((r) => r.id)).toEqual([1]);
		const syllabus = ranked.find((r) => r.id === 4);
		expect(syllabus?.recencyBonus).toBe(0.1);
		expect(syllabus?.selected).toBe(false);
		expect(ranked.find((r) => r.id === 5)?.reasons).toContain("no text in file");
		expect(isConfident(ranked)).toBe(true);
	});

	it("prefers the deck that was actually taught even when it was used before", () => {
		const ranked = rankSlides(transcript, decks, { previousNames: ["Lecture 11 - Sorting I.pdf"], lectureDate: "2026-11-05" });
		expect(ranked[0]?.id).toBe(1);
		expect(ranked[0]?.reasons).toContain("used in an earlier lecture");
		expect(ranked.find((r) => r.id === 2)?.reasons).toContain("next in series (#12)");
	});

	it("falls back to sequence and recency without a transcript", () => {
		const ranked = rankSlides("", decks, { previousNames: ["Lecture 11 - Sorting I.pdf"], lectureDate: "2026-11-05" });
		expect(ranked[0]?.id).toBe(2); // next in series beats recency alone
		expect(ranked.filter((r) => r.selected).map((r) => r.id).sort()).toEqual([2, 4, 5]);
		expect(isConfident(ranked)).toBe(false);
	});

	it("handles an empty pool", () => {
		expect(rankSlides(transcript, [], { previousNames: [], lectureDate: "2026-11-05" })).toEqual([]);
		expect(isConfident([])).toBe(false);
	});
});
