// Local Vault Agent reads a conventions note (AGENT.md) on every message. When that note exists,
// Lecture Companion appends one block, between markers, describing the lecture note shape, so the
// agent can answer "what did the professor say about X, and when" by quoting a Transcript
// paragraph with its timestamp and linking the note.
//
// The lines that do not depend on settings are mirrored in Local Vault Agent's benchmark vault
// generator (scripts/make-vault.mjs, "lecture-companion" block); keep the two in step.

import type { NoteMode } from "../settings";

export const MARK_START = "<!-- lecture-companion:start -->";
export const MARK_END = "<!-- lecture-companion:end -->";

export interface BridgeOptions {
	courseFolder: string;
	noteMode: NoteMode;
	/** Heading template of the per-course-section layout, e.g. `## {{date}}`. */
	dateHeading: string;
	meetingFolder: string;
}

/** The settings-independent part of the block: section shape and how to answer from it. */
export const SHARED_LINES: readonly string[] = [
	"- `Summary` has `In one sentence`, `Key points`, `Terms and definitions`, `Worked examples and formulas`, `Announcements and deadlines` and `Questions to review` (one heading level below it); every bullet ends with the `[mm:ss]` of the transcript paragraph it came from.",
	"- `Transcript` is speech-to-text, one paragraph per pause, each starting with `**[m:ss]**` (minutes:seconds into the recording). It is what the professor literally said; names and terms may be misspelled.",
	"- To answer \"what did the professor say about X, and when\": find the lecture (search the Transcript sections; a passage search returns the paragraph), quote the transcript paragraph that says it, give its `[m:ss]` timestamp, and link the note with a wikilink. A Summary bullet's `[mm:ss]` points at the same paragraph, so a Summary hit gives the time too.",
];

export function conventionsBlock(opts: BridgeOptions): string {
	const folder = trim(opts.courseFolder) || "Courses";
	const meetings = trim(opts.meetingFolder) || "Meetings";
	const heading = (opts.dateHeading.includes("{{date}}") ? opts.dateHeading.replace("{{date}}", "YYYY-MM-DD") : `${opts.dateHeading.trim()} YYYY-MM-DD`).trim();
	const layout =
		opts.noteMode === "per-course-section"
			? [
					`- \`${folder}/<course>.md\` holds one \`${heading}\` section per lecture; under it, one level deeper: \`Slides\` (deck embeds and \`[[deck|title]]\` links, slide text in a folded callout), \`Summary\`, \`Transcript\`, \`My notes\` and, when enabled, \`Flashcards\`.`,
				]
			: [
					`- \`${folder}/<course>/YYYY-MM-DD.md\` is one lecture. Frontmatter: \`course\`, \`date\`, \`tags: [lecture]\`, and \`audio\` (the recording) and \`title\` when known. Sections, in order: \`## Slides\` (deck embeds and \`[[deck|title]]\` links, slide text in a folded callout), \`## Summary\`, \`## Transcript\`, \`## My notes\` and, when enabled, \`## Flashcards\`.`,
					`- \`${folder}/<course>.md\` is the course note: \`## Lectures\` → \`### YYYY-MM-DD\` → a link to that day's lecture note followed by a one-sentence summary, and a \`## TODO\` list. Use it to find which date covered a topic.`,
				];
	return [
		MARK_START,
		"## Lecture notes (Lecture Companion)",
		...layout,
		...SHARED_LINES,
		`- Meeting series (\`${meetings}/<series>/YYYY-MM-DD.md\`, \`tags: [meeting]\`) have the same shape without Slides; their Summary has \`Decisions\`, \`Action items\` and \`Open questions\` instead of the lecture headings.`,
		MARK_END,
	].join("\n");
}

/**
 * Inserts the block once; an existing block is replaced in place when its text changed and left
 * alone otherwise. Returns the new text and whether anything changed.
 */
export function upsertConventions(agentMd: string, block: string): { text: string; changed: boolean } {
	const start = agentMd.indexOf(MARK_START);
	const end = agentMd.indexOf(MARK_END);
	if (start >= 0 && end > start) {
		const current = agentMd.slice(start, end + MARK_END.length);
		if (current === block) return { text: agentMd, changed: false };
		return { text: agentMd.slice(0, start) + block + agentMd.slice(end + MARK_END.length), changed: true };
	}
	const trimmed = agentMd.replace(/\s+$/, "");
	return { text: `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`, changed: true };
}

function trim(p: string): string {
	return p.replace(/^\/+|\/+$/g, "");
}
