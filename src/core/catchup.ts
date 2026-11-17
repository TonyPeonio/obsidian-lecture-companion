// "Catch me up": a few bullets on the last minutes of a lecture that is still being recorded,
// for the moment your attention drifted. Shown in the panel, not written to the note.

import type { ChatMessage } from "./ollama";
import { languageInstruction } from "./summarize";

export function buildCatchUpMessages(course: string, minutes: number, recentText: string, language?: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: `A student is sitting in a lecture and lost track for a moment. You are given the live transcript of the last ${minutes} minutes (speech recognition, so terms may be misspelled). Tell them what they missed so they can follow again: 2 to 5 short bullets in the order it was said, then one line starting "Right now:" saying what the lecturer is talking about at the moment. Use only what is in the transcript. Markdown, no title, no preamble.${language?.trim() ? ` ${languageInstruction(language)}` : ""}`,
		},
		{ role: "user", content: `Course: ${course}\n\nTranscript of the last ${minutes} minutes:\n\n${recentText}` },
	];
}
