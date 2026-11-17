// Exam review notes: one note that gathers a course's lectures in a date range: each lecture's
// one-sentence summary and key points, every term defined, and every review question, each with a
// link back to its lecture. Optionally an overview written by the model goes on top. Pure.

import type { ChatMessage } from "./ollama";
import { oneLineSummary, sectionBody } from "./notes";
import { languageInstruction } from "./summarize";

export interface ReviewLecture {
	/** Vault path of the lecture note. */
	path: string;
	date: string;
	/** The lecture's Summary section. */
	summary: string;
}

export interface ReviewInput {
	course: string;
	from: string;
	to: string;
	lectures: ReviewLecture[];
	overview?: string;
}

/** `<folder>/<course>/Review <from>–<to>.md` (the course folder, as `courseDir`). */
export function reviewNotePath(courseDir: string, from: string, to: string): string {
	return `${courseDir.replace(/\/+$/, "")}/Review ${from}–${to}.md`;
}

/** Lectures whose date is within [from, to] (inclusive, ISO dates; empty bounds are open). */
export function lecturesInRange<T extends { date: string }>(lectures: T[], from: string, to: string): T[] {
	return lectures.filter((l) => (!from || l.date >= from) && (!to || l.date <= to)).sort((a, b) => a.date.localeCompare(b.date));
}

/** Bullet lines of a summary subsection, without `[mm:ss]` citations (they point into the lecture's own recording). */
export function sectionBullets(summary: string, heading: string): string[] {
	const body = sectionBody(summary, heading);
	if (!body) return [];
	return body
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^[-*+]\s+/.test(l) && !/^_[^_]*_$/.test(l))
		.map((l) => l.replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, "").replace(/\s*\[\d{1,3}:\d{2}(?::\d{2})?\]/g, "").trim())
		.filter(Boolean);
}

function link(path: string, label: string): string {
	return `[[${path.replace(/\.md$/, "")}|${label}]]`;
}

/** The review note's markdown. */
export function buildReviewNote(input: ReviewInput): string {
	const lines: string[] = [
		"---",
		`course: "${input.course.replace(/"/g, '\\"')}"`,
		`from: ${input.from}`,
		`to: ${input.to}`,
		"tags:",
		"  - review",
		"---",
		"",
	];
	if (input.overview?.trim()) lines.push("## Overview", "", input.overview.trim(), "");
	lines.push("## Lectures", "");
	const terms: { term: string; def: string; refs: string[] }[] = [];
	const questions: string[] = [];
	const classQuestions: string[] = [];
	if (input.lectures.length === 0) lines.push("_No lectures in this range._", "");
	for (const l of input.lectures) {
		const ref = link(l.path, l.date);
		lines.push(`### ${ref}`, "");
		const sentence = oneLineSummary(l.summary);
		if (sentence) lines.push(sentence, "");
		const points = sectionBullets(l.summary, "Key points");
		if (points.length) lines.push(...points.map((p) => `- ${p}`), "");
		if (!sentence && !points.length) lines.push("_Not summarized yet._", "");
		for (const t of sectionBullets(l.summary, "Terms and definitions")) {
			const m = /^\*\*([^*]+)\*\*\s*[—–:-]+\s*(.*)$/.exec(t);
			const term = (m?.[1] ?? t).trim();
			const def = (m?.[2] ?? "").trim();
			const existing = terms.find((x) => x.term.toLowerCase() === term.toLowerCase());
			if (existing) {
				if (!existing.refs.includes(ref)) existing.refs.push(ref);
				if (!existing.def && def) existing.def = def;
			} else terms.push({ term, def, refs: [ref] });
		}
		for (const q of sectionBullets(l.summary, "Questions to review")) questions.push(`- ${q} (${ref})`);
		for (const q of sectionBullets(l.summary, "Questions from class")) classQuestions.push(`- ${q} (${ref})`);
	}
	if (terms.length) {
		lines.push("## Terms and definitions", "");
		for (const t of terms.sort((a, b) => a.term.localeCompare(b.term))) lines.push(`- **${t.term}**${t.def ? ` — ${t.def}` : ""} (${t.refs.join(", ")})`);
		lines.push("");
	}
	if (questions.length) lines.push("## Questions to review", "", ...questions, "");
	if (classQuestions.length) lines.push("## Questions from class", "", ...classQuestions, "");
	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Prompt for the overview at the top of a review note: from the lectures' summaries only. */
export function buildReviewOverviewMessages(input: Omit<ReviewInput, "overview">, maxChars = 24_000, language?: string): ChatMessage[] {
	const parts: string[] = [`Course: ${input.course}`, `Lectures from ${input.from} to ${input.to}`, ""];
	for (const l of input.lectures) {
		const s = [oneLineSummary(l.summary) ?? "", ...sectionBullets(l.summary, "Key points").map((p) => `- ${p}`)].filter(Boolean).join("\n");
		if (s) parts.push(`## ${l.date}`, s, "");
	}
	let user = parts.join("\n");
	if (user.length > maxChars) user = `${user.slice(0, maxChars)}\n(… truncated)`;
	return [
		{
			role: "system",
			content:
				`You help a student review for an exam. From the lecture summaries given, write an overview of what this part of the course covered: 1 short paragraph on the big picture and how the lectures connect, then 4 to 8 bullets naming the main themes a student should master, in course order. Use only what is in the summaries. Markdown, sentence case, no title, no timestamps.${language?.trim() ? ` ${languageInstruction(language)}` : ""}`,
		},
		{ role: "user", content: user },
	];
}
