import type { ChatMessage, OllamaClient } from "./ollama";

export interface SummaryInput {
	course: string;
	date: string;
	/** Markdown transcript with [mm:ss] markers, or plain text. */
	transcript: string;
	slideText?: string;
	extraInstructions?: string;
}

export interface SummaryConfig {
	model: string;
	numCtx: number;
	temperature: number;
	think?: boolean;
}

const SYSTEM_PROMPT = `You summarize university lectures for a student's own notes.
You are given a transcript (speech recognition output, so names and terms may be misspelled; use the slide text to correct them) and, when available, the text of the slides.
Write in markdown, in the language of the lecture. Do not invent content that is not in the transcript or slides. Do not add a title or front matter.
Output exactly these sections:
### Key points
5 to 12 bullets covering what was taught, in lecture order. Where a bullet comes from a specific moment, end it with the transcript timestamp in the form [mm:ss].
### Terms and definitions
Bullets of "**term** — definition" for concepts introduced or defined. Omit the section if there are none.
### Worked examples and formulas
Bullets for any examples, derivations or formulas (use LaTeX between $ signs for math). Omit the section if there are none.
### Announcements and deadlines
Anything about homework, exams, readings or logistics. Omit the section if there are none.
### Questions to review
2 to 5 questions a student should be able to answer after this lecture.`;

/** Rough budget so transcript + slides fit the context window (4 chars ≈ 1 token, with headroom). */
export function fitToContext(input: SummaryInput, numCtx: number): { transcript: string; slideText: string; truncated: boolean } {
	const budgetChars = Math.max(4000, Math.floor(numCtx * 3.2) - 2500);
	let slideText = input.slideText?.trim() ?? "";
	let transcript = input.transcript.trim();
	let truncated = false;
	const slideBudget = Math.min(slideText.length, Math.floor(budgetChars * 0.3));
	if (slideText.length > slideBudget) {
		slideText = `${slideText.slice(0, slideBudget)}\n(… slide text truncated)`;
		truncated = true;
	}
	const transcriptBudget = budgetChars - slideText.length;
	if (transcript.length > transcriptBudget) {
		transcript = `${transcript.slice(0, transcriptBudget)}\n(… transcript truncated here)`;
		truncated = true;
	}
	return { transcript, slideText, truncated };
}

export function buildSummaryMessages(input: SummaryInput, numCtx: number): ChatMessage[] {
	const fitted = fitToContext(input, numCtx);
	const parts = [`Course: ${input.course}`, `Date: ${input.date}`];
	if (fitted.slideText) parts.push("", "## Slide text", "", fitted.slideText);
	parts.push("", "## Transcript", "", fitted.transcript);
	if (input.extraInstructions?.trim()) parts.push("", "## Additional instructions from the student", "", input.extraInstructions.trim());
	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: parts.join("\n") },
	];
}

export async function summarizeLecture(
	client: OllamaClient,
	cfg: SummaryConfig,
	input: SummaryInput,
	onDelta?: (text: string) => void,
	signal?: AbortSignal,
): Promise<string> {
	if (!input.transcript.trim() && !input.slideText?.trim()) return "";
	const text = await client.chat({
		model: cfg.model,
		messages: buildSummaryMessages(input, cfg.numCtx),
		options: { num_ctx: cfg.numCtx, temperature: cfg.temperature },
		keep_alive: "10m",
		think: cfg.think,
		signal,
		onDelta,
	});
	return stripThinkTags(text).trim();
}

/** Some models leak <think>…</think> into content when thinking is not separated. */
export function stripThinkTags(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
}
