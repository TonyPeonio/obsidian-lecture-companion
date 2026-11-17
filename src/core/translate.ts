// "Translate the transcript": a copy of the transcript in another language, paragraph by
// paragraph with the same timestamps, written under its own heading next to the original (so the
// two can be read side by side and the timestamps still play the recording). Pure helpers; the
// plugin sends each chunk to the chat model.

import type { ChatMessage } from "./ollama";
import { formatTimestamp } from "./notes";
import type { ParsedParagraph } from "./transcript";

export function translatedHeading(language: string): string {
	return `Transcript (${language.trim() || "English"})`;
}

/** Paragraphs as `**[m:ss]** text` lines, grouped into chunks of at most `maxChars` (never splitting a paragraph). */
export function translationChunks(paragraphs: ParsedParagraph[], maxChars = 3000): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let size = 0;
	for (const p of paragraphs) {
		if (p.mark) continue;
		const line = `**[${formatTimestamp(p.start)}]** ${p.question ? "**Q:** " : ""}${p.text}`;
		if (size + line.length > maxChars && current.length) {
			chunks.push(current.join("\n\n"));
			current = [];
			size = 0;
		}
		current.push(line);
		size += line.length + 2;
	}
	if (current.length) chunks.push(current.join("\n\n"));
	return chunks;
}

export function buildTranslateMessages(language: string, chunk: string): ChatMessage[] {
	return [
		{
			role: "system",
			content: `Translate lecture transcript paragraphs into ${language}. Each paragraph starts with a timestamp like **[12:34]**: keep every timestamp exactly as it is, at the start of its paragraph, one paragraph per timestamp, in the same order, separated by blank lines. Keep a **Q:** marker where there is one. Translate faithfully; keep technical terms, names, formulas and code as they are when there is no standard translation. Output only the translated paragraphs.`,
		},
		{ role: "user", content: chunk },
	];
}

/**
 * The model's output reduced to `**[m:ss]** text` paragraphs. A paragraph whose timestamp the
 * model dropped is attached to the one before it; nothing before the first timestamp is kept.
 */
export function cleanTranslation(output: string): string {
	const paras: string[] = [];
	for (const raw of output.replace(/<think>[\s\S]*?<\/think>/g, "").split(/\n\s*\n/)) {
		const text = raw.replace(/\s+/g, " ").trim();
		if (!text) continue;
		if (/^\*\*\[\d{1,3}:\d{2}(?::\d{2})?\]\*\*/.test(text)) paras.push(text);
		else if (paras.length) paras[paras.length - 1] += ` ${text}`;
	}
	return paras.join("\n\n");
}
