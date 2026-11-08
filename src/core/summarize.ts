import { tfidfSimilarities } from "./match";
import type { ChatMessage, OllamaClient } from "./ollama";

/**
 * A transcript with less speech than this is not summarized: with 20 seconds of speech and
 * twenty pages of slide text the model summarizes the slides and the summary stops being a
 * record of the lecture. Both limits must be met; seconds are estimated from the paragraph
 * markers (see `transcriptLength`).
 */
export const MIN_TRANSCRIPT_SEC = 45;
export const MIN_TRANSCRIPT_CHARS = 300;
/**
 * Slide text handed to the model is capped at max(SLIDE_TEXT_FLOOR_CHARS, SLIDE_TEXT_RATIO ×
 * transcript characters), keeping the slides whose terms overlap the transcript, so the slides
 * support the transcript instead of replacing it. Not applied when summarizing the student's
 * own notes, where the slides are the fuller source.
 */
export const SLIDE_TEXT_FLOOR_CHARS = 3000;
export const SLIDE_TEXT_RATIO = 3;
/** Speaking rate used to estimate how long the last transcript paragraph lasted (chars per second). */
const CHARS_PER_SECOND = 15;

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
	const faithful =
		source === "notes"
			? "Do not invent content that is not in the notes or the slides."
			: "The transcript is the only source of what was taught: include nothing that was not said in it. Use the slide text only to spell names and terms correctly and to state precisely what the lecturer was explaining; do not summarize slides the lecturer did not discuss. A short transcript gets a short summary.";
	const timestamps =
		source === "notes"
			? ""
			: `
Every bullet, definition, example, announcement and question ends with the timestamp of the transcript paragraph it comes from, in the form [mm:ss], copied exactly from that paragraph's marker. Never invent, round or interpolate a timestamp, and never cite slides.`;
	return `You summarize university lectures for a student's own notes.
${given}
Write in markdown, in the language of the lecture, in sentence case (capitalize only the first word of a sentence, bullet or term, and proper nouns). Do not add a title or front matter.
${faithful}${timestamps}
Output exactly these sections:
### In one sentence
One plain sentence (at most 25 words, no timestamp) saying what this lecture covered.
### Key points
5 to 12 bullets covering what was taught, in lecture order (fewer when the transcript is short).
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
	const timestamps =
		source === "notes"
			? ""
			: `
Every discussion bullet, decision, action item and open question ends with the timestamp of the transcript paragraph it comes from, in the form [mm:ss], copied exactly from that paragraph's marker. Never invent, round or interpolate a timestamp.`;
	const material = source === "notes" ? "the notes" : "the transcript";
	return `You summarize meetings (work, clubs, project teams) for one attendee's own notes.
${given}
Write in markdown, in the language of the meeting, in sentence case (capitalize only the first word of a sentence or bullet, and proper nouns). Include nothing that is not in ${material}. Do not add a title or front matter.${timestamps}
Output exactly these sections:
### In one sentence
One plain sentence (at most 25 words, no timestamp) saying what this meeting was about and its main outcome.
### Overview
2 to 4 sentences: what the meeting was for and where things stand now.
### Discussion
4 to 10 bullets on the topics discussed, in order.
### Decisions
Bullets for what was agreed or decided. Omit the section if nothing was decided.
### Action items
One checkbox per task someone agreed to do, in the form "- [ ] **Owner** — task (due date if one was said)". Leave out the owner when it is not clear who. Omit the section if there are none.
### Open questions
Things left unresolved or to follow up on. Omit the section if there are none.`;
}

/**
 * How much speech a markdown transcript holds: characters of spoken text (markers and audio
 * embeds removed) and an estimate of seconds, the last paragraph's start plus its length at
 * `CHARS_PER_SECOND` (paragraph markers give start times only).
 */
export function transcriptLength(transcript: string): { seconds: number; chars: number } {
	let chars = 0;
	let lastStart = 0;
	let lastChars = 0;
	for (const raw of transcript.split("\n")) {
		const line = raw.trim();
		if (!line || /^!\[\[[^\]]*\]\]$/.test(line) || /^_[^_]*_$/.test(line)) continue;
		const m = /^(?:\*\*)?\[(\d{1,2}):(\d{2})(?::(\d{2}))?\](?:\*\*)?\s*(.*)$/.exec(line);
		const text = m ? (m[4] ?? "") : line;
		if (m) {
			const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
			lastStart = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
			lastChars = 0;
		}
		chars += text.length;
		lastChars += text.length;
	}
	return { seconds: lastStart + lastChars / CHARS_PER_SECOND, chars };
}

/** Why a transcript is too short to summarize (see MIN_TRANSCRIPT_SEC), or null when it is long enough. */
export function tooShortToSummarize(transcript: string): string | null {
	const { seconds, chars } = transcriptLength(transcript);
	if (seconds >= MIN_TRANSCRIPT_SEC && chars >= MIN_TRANSCRIPT_CHARS) return null;
	return `Transcript too short to summarize (${Math.round(seconds)} s); slides alone would be summarized instead.`;
}

/**
 * Caps slide text at `maxChars`, keeping whole slides (`--- Page n ---` / `--- Slide n ---`
 * blocks, else paragraphs) in order of TF-IDF overlap with the transcript, then restoring
 * document order. Returns the text unchanged when it fits.
 */
export function capSlideText(slideText: string, transcript: string, maxChars: number): string {
	const text = slideText.trim();
	if (text.length <= maxChars) return text;
	const blocks = text.split(/\n(?=--- (?:Page|Slide) \d+ ---)/).flatMap((b) => (b.includes("--- ") ? [b] : b.split(/\n{2,}/))).map((b) => b.trim()).filter(Boolean);
	const scores = tfidfSimilarities(transcript, blocks);
	const order = blocks.map((_, i) => i).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
	const keep = new Set<number>();
	let used = 0;
	for (const i of order) {
		const len = (blocks[i] ?? "").length + 1;
		if (used + len > maxChars) continue;
		keep.add(i);
		used += len;
	}
	const kept = blocks.filter((_, i) => keep.has(i));
	return `${kept.join("\n")}${kept.length < blocks.length ? `\n(… ${blocks.length - kept.length} slides without overlap with the transcript left out)` : ""}`;
}

/**
 * Rough budget so transcript + slides fit the context window (4 chars ≈ 1 token, with headroom).
 * For a transcript (not notes) the slide text is first capped relative to the transcript (SLIDE_TEXT_RATIO).
 */
export function fitToContext(input: SummaryInput, numCtx: number): { transcript: string; slideText: string; truncated: boolean } {
	const budgetChars = Math.max(4000, Math.floor(numCtx * 3.2) - 2500);
	let slideText = input.slideText?.trim() ?? "";
	let transcript = input.transcript.trim();
	let truncated = false;
	if (input.source !== "notes" && slideText) {
		const capped = capSlideText(slideText, transcript, Math.max(SLIDE_TEXT_FLOOR_CHARS, SLIDE_TEXT_RATIO * transcript.length));
		if (capped !== slideText) truncated = true;
		slideText = capped;
	}
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
