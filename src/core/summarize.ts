import type { ChatMessage, OllamaClient } from "./ollama";

export interface SummaryInput {
	course: string;
	date: string;
	/** Markdown transcript with [mm:ss] markers, or the student's own notes (see `source`). */
	transcript: string;
	slideText?: string;
	extraInstructions?: string;
	/** What `transcript` is: speech-to-text output (default) or notes the student typed in class. */
	source?: "transcript" | "notes";
	/** A meeting (work, club) is summarized as decisions and action items instead of course material. */
	kind?: "lecture" | "meeting";
}

export interface SummaryConfig {
	model: string;
	numCtx: number;
	temperature: number;
	think?: boolean;
}

function systemPrompt(source: "transcript" | "notes"): string {
	const given =
		source === "notes"
			? "You are given the notes a student typed during the lecture (terse, with abbreviations and gaps; expand abbreviations when the meaning is clear) and, when available, the text of the slides."
			: "You are given a transcript (speech recognition output, so names and terms may be misspelled; use the slide text to correct them) and, when available, the text of the slides.";
	const timestamps = source === "notes" ? "" : " Where a bullet comes from a specific moment, end it with the transcript timestamp in the form [mm:ss].";
	const material = source === "notes" ? "the notes or slides" : "the transcript or slides";
	return `You summarize university lectures for a student's own notes.
${given}
Write in markdown, in the language of the lecture. Do not invent content that is not in ${material}. Do not add a title or front matter.
Output exactly these sections:
### Key points
5 to 12 bullets covering what was taught, in lecture order.${timestamps}
### Terms and definitions
Bullets of "**term** — definition" for concepts introduced or defined. Omit the section if there are none.
### Worked examples and formulas
Bullets for any examples, derivations or formulas (use LaTeX between $ signs for math). Omit the section if there are none.
### Announcements and deadlines
Anything about homework, exams, readings or logistics. Omit the section if there are none.
### Questions to review
2 to 5 questions a student should be able to answer after this lecture.`;
}

function meetingPrompt(source: "transcript" | "notes"): string {
	const given =
		source === "notes"
			? "You are given the notes someone typed during the meeting (terse, with abbreviations and gaps; expand abbreviations when the meaning is clear)."
			: "You are given a transcript of the meeting (speech recognition output, so names and terms may be misspelled, and speakers are not labelled; attribute something to a person only when the transcript makes it clear who).";
	const timestamps = source === "notes" ? "" : " Where a bullet comes from a specific moment, end it with the transcript timestamp in the form [mm:ss].";
	const material = source === "notes" ? "the notes" : "the transcript";
	return `You summarize meetings (work, clubs, project teams) for one attendee's own notes.
${given}
Write in markdown, in the language of the meeting. Do not invent content that is not in ${material}. Do not add a title or front matter.
Output exactly these sections:
### Overview
2 to 4 sentences: what the meeting was for and where things stand now.
### Discussion
4 to 10 bullets on the topics discussed, in order.${timestamps}
### Decisions
Bullets for what was agreed or decided. Omit the section if nothing was decided.
### Action items
One checkbox per task someone agreed to do, in the form "- [ ] **Owner** — task (due date if one was said)". Leave out the owner when it is not clear who. Omit the section if there are none.
### Open questions
Things left unresolved or to follow up on. Omit the section if there are none.`;
}

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
	const meeting = input.kind === "meeting";
	const parts = [meeting ? `Meeting: ${input.course}` : `Course: ${input.course}`, `Date: ${input.date}`];
	if (fitted.slideText) parts.push("", "## Slide text", "", fitted.slideText);
	parts.push("", input.source === "notes" ? (meeting ? "## Notes" : "## Student's notes") : "## Transcript", "", fitted.transcript);
	if (input.extraInstructions?.trim()) parts.push("", meeting ? "## Additional instructions" : "## Additional instructions from the student", "", input.extraInstructions.trim());
	const source = input.source ?? "transcript";
	return [
		{ role: "system", content: meeting ? meetingPrompt(source) : systemPrompt(source) },
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
