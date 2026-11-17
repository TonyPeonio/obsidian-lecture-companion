import { describe, expect, it } from "vitest";
import { alignParagraphs, alignTranscriptToSlides, parseSlidePages, slideLink } from "../src/core/align";
import { slidesToMarkdown } from "../src/core/notes";
import { parseTranscript } from "../src/core/transcript";

const DECK_TEXT = [
	"--- Page 1 ---\nIntroduction to sorting algorithms\nwhy order matters",
	"--- Page 2 ---\nBubble sort\nswap adjacent elements repeatedly until sorted",
	"--- Page 3 ---\nMerge sort\ndivide the array, sort halves, merge sorted halves",
	"--- Page 4 ---\nQuicksort\npivot partition recursion",
	"--- Page 5 ---\nComplexity comparison\nbubble quadratic merge quicksort logarithmic",
].join("\n\n");

const SLIDES = slidesToMarkdown([{ vaultPath: "Courses/Algo/attachments/Sorting.pdf", title: "Sorting", text: DECK_TEXT, source: "Canvas · Week 3" }]);

describe("parseSlidePages", () => {
	it("reads the pages from the Slides section's callout", () => {
		const pages = parseSlidePages(SLIDES);
		expect(pages.map((p) => [p.deck, p.page])).toEqual([
			["Sorting.pdf", 1],
			["Sorting.pdf", 2],
			["Sorting.pdf", 3],
			["Sorting.pdf", 4],
			["Sorting.pdf", 5],
		]);
		expect(pages[1]?.text).toBe("Bubble sort\nswap adjacent elements repeatedly until sorted");
	});

	it("handles PowerPoint slide markers and several decks", () => {
		const two = slidesToMarkdown([
			{ vaultPath: "a/One.pptx", title: "One", text: "--- Slide 1 ---\nGraphs vertices edges" },
			{ vaultPath: "a/Two.pdf", title: "Two", text: "--- Page 1 ---\nTrees roots leaves" },
		]);
		expect(parseSlidePages(two).map((p) => `${p.deck}#${p.page}`)).toEqual(["One.pptx#1", "Two.pdf#1"]);
		expect(parseSlidePages("![[deck.pdf]]\n_no text_")).toEqual([]);
	});

	it("links PDF pages and PowerPoint files", () => {
		expect(slideLink({ deck: "Sorting.pdf", page: 3, text: "" })).toBe("[[Sorting.pdf#page=3|slide 3]]");
		expect(slideLink({ deck: "One.pptx", page: 2, text: "" })).toBe("[[One.pptx|slide 2]]");
	});
});

describe("alignParagraphs", () => {
	const pages = parseSlidePages(SLIDES);

	it("follows the lecture through the deck", () => {
		const paras = [
			"Today we talk about sorting algorithms and why order matters.",
			"Bubble sort swaps adjacent elements, again and again.",
			"So bubble sort repeatedly swaps until everything is sorted.",
			"Merge sort divides the array and merges the sorted halves.",
			"Quicksort picks a pivot and does a partition, then recursion.",
		];
		expect(alignParagraphs(paras, pages).page).toEqual([0, 1, 1, 2, 3]);
	});

	it("does not jump back for one paragraph that mentions an earlier slide", () => {
		const paras = [
			"Merge sort divides the array and merges sorted halves.",
			"Unlike bubble sort, merge sort sorts the halves then merges.",
			"Quicksort chooses a pivot, partition, recursion.",
		];
		const { page } = alignParagraphs(paras, pages);
		expect(page).toEqual([2, 2, 3]);
	});

	it("returns -1 without pages", () => {
		expect(alignParagraphs(["x"], []).page).toEqual([-1]);
	});
});

describe("alignTranscriptToSlides", () => {
	const transcript = [
		"![[Algo 2026-10-12 1000.webm]]",
		"",
		"**[0:00]** Today we talk about sorting algorithms and why order matters.",
		"",
		"**[1:00]** Bubble sort swaps adjacent elements again and again.",
		"",
		"**[2:00]** Bubble sort repeatedly swaps until sorted.",
		"",
		"**[2:30]** ⭐ Important",
		"",
		"**[3:00]** Let me get some water first.",
		"",
		"**[4:00]** Merge sort divides the array and merges sorted halves.",
	].join("\n");

	it("adds a link where the slide changes, not on unrelated paragraphs or marks", () => {
		const { text, links } = alignTranscriptToSlides(transcript, SLIDES);
		expect(links).toBe(3);
		expect(text).toContain("**[0:00]** Today we talk about sorting algorithms and why order matters. · [[Sorting.pdf#page=1|slide 1]]");
		expect(text).toContain("**[1:00]** Bubble sort swaps adjacent elements again and again. · [[Sorting.pdf#page=2|slide 2]]");
		expect(text).toContain("**[2:00]** Bubble sort repeatedly swaps until sorted.\n");
		expect(text).toContain("**[2:30]** ⭐ Important\n");
		expect(text).toContain("**[3:00]** Let me get some water first.\n");
		expect(text).toContain("· [[Sorting.pdf#page=3|slide 3]]");
		expect(text.startsWith("![[Algo 2026-10-12 1000.webm]]")).toBe(true);
	});

	it("is idempotent and keeps the paragraphs parseable", () => {
		const once = alignTranscriptToSlides(transcript, SLIDES).text;
		expect(alignTranscriptToSlides(once, SLIDES).text).toBe(once);
		expect(parseTranscript(once).map((p) => p.text)).toEqual(parseTranscript(transcript).map((p) => p.text));
	});

	it("changes nothing without slide text", () => {
		expect(alignTranscriptToSlides(transcript, "![[Sorting.pdf]]")).toEqual({ text: transcript, links: 0 });
	});
});
