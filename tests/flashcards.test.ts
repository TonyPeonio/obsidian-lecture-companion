import { describe, expect, it, vi } from "vitest";
import {
	buildFlashcardMessages,
	cardText,
	extractReviewQuestions,
	generateFlashcards,
	pairFlashcards,
	parseFlashcardAnswers,
	renderFlashcards,
	SECTION_FLASHCARDS,
} from "../src/core/flashcards";
import { sectionBody, upsertSection } from "../src/core/notes";
import type { ChatRequest, OllamaClient } from "../src/core/ollama";

const summary = `### In one sentence
Merge sort and quick sort.
### Key points
- Merge sort splits the array [0:09]
### Questions to review
1. Why does the merge step make merge sort $n \\log n$? [0:21]
2.  When does **quick sort** take quadratic time? [1:02]
- Why can no comparison sort beat n log n? [2:20]`;

describe("review questions", () => {
	it("reads numbered and bulleted questions without timestamps or emphasis", () => {
		expect(extractReviewQuestions(summary)).toEqual([
			"Why does the merge step make merge sort $n \\log n$?",
			"When does quick sort take quadratic time?",
			"Why can no comparison sort beat n log n?",
		]);
		expect(extractReviewQuestions("### Key points\n- a")).toEqual([]);
		expect(extractReviewQuestions("### Questions to review\n_None._")).toEqual([]);
	});

	it("keeps card text on one line without the :: separator", () => {
		expect(cardText("  **Term**::  see [[Note|the note]]  [12:03] ")).toBe("Term: see the note");
		expect(cardText("a ::: b")).toBe("a : b");
	});
});

describe("model messages and reply parsing", () => {
	it("puts transcript, slides and numbered questions in the user message and the rules in the system prompt", () => {
		const msgs = buildFlashcardMessages({ course: "CS101", date: "2026-10-12", summary, transcript: "**[0:00]** t", slideText: "s" }, ["Q one?", "Q two?"], 8192);
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[0]?.content).toContain("Not covered");
		expect(msgs[0]?.content).toContain("<number>. <answer>");
		expect(msgs[1]?.content).toBe("Course: CS101\nDate: 2026-10-12\n\n## Slide text\n\ns\n\n## Transcript\n\n**[0:00]** t\n\n## Questions\n\n1. Q one?\n2. Q two?");
	});

	it("parses the numbering styles small models produce, with continuation lines", () => {
		const reply = "<think>let me see</think>\n1. Because the merge step is linear, so T(n) = 2T(n/2) + n solves to n log n.\n**2.** When the pivot is always the smallest element,\n   so the partitions are maximally unbalanced.\nA3: Not covered.\n4) Extra answer";
		const answers = parseFlashcardAnswers(reply);
		expect(answers.get(1)).toBe("Because the merge step is linear, so T(n) = 2T(n/2) + n solves to n log n.");
		expect(answers.get(2)).toBe("When the pivot is always the smallest element, so the partitions are maximally unbalanced.");
		expect(answers.get(3)).toBe("Not covered.");
		expect(answers.get(4)).toBe("Extra answer");
		expect(parseFlashcardAnswers("Answer 1 - yes\nQuestion 2: no").get(2)).toBe("no");
	});

	it("drops questions the model could not answer and strips markdown from both sides", () => {
		const cards = pairFlashcards(["**Q1**?", "Q2?", "Q3?"], new Map([[1, "An answer [0:21]"], [2, "not covered by the lecture"], [3, ""]]));
		expect(cards).toEqual([{ question: "Q1?", answer: "An answer" }]);
	});
});

describe("rendering", () => {
	it("writes the tag line and one Question::Answer per line", () => {
		const body = renderFlashcards([
			{ question: "Why is RMSD insufficient?", answer: "Matching only two atoms gives a tiny RMSD, so the alignment length matters too." },
			{ question: "What does DALI compare?", answer: "Distance matrices of alpha-carbon distances." },
		]);
		expect(body).toBe("#flashcards\n\nWhy is RMSD insufficient?::Matching only two atoms gives a tiny RMSD, so the alignment length matters too.\nWhat does DALI compare?::Distance matrices of alpha-carbon distances.");
		expect(renderFlashcards([])).toBe("");
	});

	it("is idempotent in the note: a re-run replaces the section instead of duplicating cards", () => {
		const note = "---\ntags:\n  - lecture\n---\n\n## Summary\n\ns\n\n## Transcript\n\nt\n\n## My notes\n\nmine\n";
		const first = upsertSection(note, SECTION_FLASHCARDS, renderFlashcards([{ question: "Q?", answer: "A." }]), "replace");
		expect(first).toContain("## Flashcards\n\n#flashcards\n\nQ?::A.\n");
		const second = upsertSection(first, SECTION_FLASHCARDS, renderFlashcards([{ question: "Q?", answer: "A." }, { question: "R?", answer: "B." }]), "replace");
		expect(second.match(/## Flashcards/g)?.length).toBe(1);
		expect(second.match(/Q\?::A\./g)?.length).toBe(1);
		expect(sectionBody(second, SECTION_FLASHCARDS)).toBe("#flashcards\n\nQ?::A.\nR?::B.");
		expect(sectionBody(second, "My notes")).toBe("mine");
	});
});

describe("generateFlashcards", () => {
	it("makes one call with temperature 0.2 and thinking off, and pairs the reply with the questions", async () => {
		const chat = vi.fn(async (req: ChatRequest) => {
			expect(req.messages[1]?.content).toContain("1. Why does the merge step make merge sort $n \\log n$?");
			return "1. The merge step is linear, so the recurrence solves to n log n.\n2. When the pivot is always the smallest element.\n3. Not covered";
		});
		const client = { chat } as unknown as OllamaClient;
		const cards = await generateFlashcards(client, { model: "qwen3.5:9b", numCtx: 32768, temperature: 0.2 }, { course: "c", date: "d", summary, transcript: "**[0:00]** t" });
		expect(chat).toHaveBeenCalledTimes(1);
		expect(chat.mock.calls[0]?.[0]).toMatchObject({ model: "qwen3.5:9b", think: false, options: { temperature: 0.2, num_ctx: 32768 } });
		expect(cards).toEqual([
			{ question: "Why does the merge step make merge sort $n \\log n$?", answer: "The merge step is linear, so the recurrence solves to n log n." },
			{ question: "When does quick sort take quadratic time?", answer: "When the pivot is always the smallest element." },
		]);
	});

	it("skips the model when there are no questions or no transcript", async () => {
		const chat = vi.fn(async () => "1. x");
		const client = { chat } as unknown as OllamaClient;
		expect(await generateFlashcards(client, { model: "m", numCtx: 8192, temperature: 0.2 }, { course: "c", date: "d", summary: "### Key points\n- a", transcript: "t" })).toEqual([]);
		expect(await generateFlashcards(client, { model: "m", numCtx: 8192, temperature: 0.2 }, { course: "c", date: "d", summary, transcript: "  " })).toEqual([]);
		expect(chat).not.toHaveBeenCalled();
	});
});
