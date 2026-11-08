// Flashcards from a summary's review questions: one extra model call answers them from the
// transcript, and the cards are written as `Question::Answer` lines (the Spaced Repetition
// plugin's single-line format). Pure functions plus one thin call through the Ollama client.

import { sectionBody } from "./notes";
import type { ChatMessage, OllamaClient } from "./ollama";
import { fitToContext, stripThinkTags, type SummaryConfig } from "./summarize";

export const SECTION_FLASHCARDS = "Flashcards";
/** Tag the Spaced Repetition plugin looks for by default; written at the top of the section. */
export const FLASHCARDS_TAG = "#flashcards";
/** The model's reply for a question the material does not answer; such questions get no card. */
export const NOT_COVERED = "Not covered";

export interface Flashcard {
	question: string;
	answer: string;
}

export interface FlashcardInput {
	course: string;
	date: string;
	/** The summary the review questions come from. */
	summary: string;
	/** Markdown transcript (or the student's notes) to ground the answers in. */
	transcript: string;
	slideText?: string;
}

/** The questions under "Questions to review": numbered or bulleted lines, timestamps and emphasis removed. */
export function extractReviewQuestions(summary: string): string[] {
	const body = sectionBody(summary, "Questions to review") ?? "";
	const out: string[] = [];
	for (const raw of body.split("\n")) {
		const m = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/.exec(raw);
		const q = m ? cardText(m[1] ?? "") : "";
		if (q && !/^_[^_]*_$/.test(q)) out.push(q);
	}
	return out;
}

/** One line of card text: no timestamps, emphasis or links, no `::` (the card separator), single spaces. */
export function cardText(text: string): string {
	return text
		.replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "")
		.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
		.replace(/\*\*|__|`/g, "")
		.replace(/:{2,}/g, ":")
		.replace(/\s+/g, " ")
		.trim();
}

function systemPrompt(): string {
	return `You write flashcard answers for a student's own review.
You are given the transcript of a lecture (speech recognition output, so names and terms may be misspelled; use the slide text to correct them), the slide text when available, and numbered review questions.
Answer each question in one or two plain sentences (at most 40 words) using only what the transcript or slides say. Do not add anything that is not in them. Write in sentence case, in the language of the lecture, without markdown, bullets, quotes or timestamps.
If the transcript and slides do not answer a question, answer exactly: ${NOT_COVERED}
Output exactly one line per question, in the form "<number>. <answer>", in the same order, and nothing else.`;
}

export function buildFlashcardMessages(input: FlashcardInput, questions: string[], numCtx: number): ChatMessage[] {
	const fitted = fitToContext({ course: input.course, date: input.date, transcript: input.transcript, slideText: input.slideText }, numCtx);
	const parts = [`Course: ${input.course}`, `Date: ${input.date}`];
	if (fitted.slideText) parts.push("", "## Slide text", "", fitted.slideText);
	parts.push("", "## Transcript", "", fitted.transcript, "", "## Questions", "", ...questions.map((q, i) => `${i + 1}. ${q}`));
	return [
		{ role: "system", content: systemPrompt() },
		{ role: "user", content: parts.join("\n") },
	];
}

/**
 * Numbered answers out of the model's reply: `1. …`, `1) …`, `**1.** …`, `A1: …`, `Answer 1: …`;
 * text on the lines after a number belongs to that answer. Returns answers by question number.
 */
export function parseFlashcardAnswers(reply: string): Map<number, string> {
	const out = new Map<number, string>();
	let current: number | null = null;
	for (const raw of stripThinkTags(reply).split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const m = /^(?:\*\*)?(?:(?:Q|A|Answer|Question)\s*)?(\d{1,3})(?:\*\*)?\s*[.):\-–—]\s*(?:\*\*)?\s*(.*)$/i.exec(line);
		if (m) {
			current = Number(m[1]);
			out.set(current, cardText(m[2] ?? ""));
			continue;
		}
		if (current !== null && !/^#{1,6}\s/.test(line)) {
			const prev = out.get(current) ?? "";
			out.set(current, cardText(`${prev} ${line}`));
		}
	}
	return out;
}

/** Pairs questions with their answers; questions the model could not answer get no card. */
export function pairFlashcards(questions: string[], answers: Map<number, string>): Flashcard[] {
	const cards: Flashcard[] = [];
	questions.forEach((question, i) => {
		const answer = answers.get(i + 1)?.trim() ?? "";
		if (!answer || new RegExp(`^${NOT_COVERED}\\b`, "i").test(answer)) return;
		cards.push({ question: cardText(question), answer: cardText(answer) });
	});
	return cards;
}

/** The `## Flashcards` body: the tag line, then one `Question::Answer` per line. */
export function renderFlashcards(cards: Flashcard[]): string {
	if (cards.length === 0) return "";
	return [FLASHCARDS_TAG, "", ...cards.map((c) => `${cardText(c.question)}::${cardText(c.answer)}`)].join("\n");
}

/**
 * One model call (temperature 0.2, thinking off) that answers the summary's review questions
 * from the transcript. Empty when the summary has no questions or none could be answered.
 */
export async function generateFlashcards(client: OllamaClient, cfg: SummaryConfig, input: FlashcardInput, signal?: AbortSignal): Promise<Flashcard[]> {
	const questions = extractReviewQuestions(input.summary);
	if (questions.length === 0 || !input.transcript.trim()) return [];
	const reply = await client.chat({
		model: cfg.model,
		messages: buildFlashcardMessages(input, questions, cfg.numCtx),
		options: { num_ctx: cfg.numCtx, temperature: 0.2 },
		keep_alive: "10m",
		think: false,
		signal,
	});
	return pairFlashcards(questions, parseFlashcardAnswers(reply));
}
