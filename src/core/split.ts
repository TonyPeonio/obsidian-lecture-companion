// Splits a running class note ("Lecture 1 - 8.24.26 … Lecture 2 - 8.26.26 … Meeting with
// Caleb - 8.28.26 …") into one entry per header so each day becomes its own lecture note.

import { detectDate } from "./notes";

export interface NoteEntry {
	/** The header line, without markdown heading marks. */
	title: string;
	/** YYYY-MM-DD when the header carries a date. */
	date: string | null;
	/** Body lines below the header (trimmed), without the header itself. */
	text: string;
	/** 0-based line numbers in the source. */
	startLine: number;
	endLine: number;
	/** Text before the first header. */
	preamble: boolean;
	/** The header had no date, so the previous entry's date was assumed (same day, continued). */
	inherited: boolean;
}

const KEYWORD = /^(lecture|lec|lect|class|session|meeting|week|day|seminar|lab|recitation|discussion|tutorial|workshop|office hours?)\b/i;

/** True for a line that starts a new entry. */
export function isEntryHeader(line: string): boolean {
	const t = line.trim();
	if (!t || t.length > 110) return false;
	if (/^([-*+]|\d+[.)])\s/.test(t)) return false; // list item
	if (/^(>|\||```|~~~|!\[|\[\[)/.test(t)) return false;
	if (/[📅🛫✅⏳➕]/u.test(t)) return false; // task metadata
	const plain = t.replace(/^#{1,6}\s+/, "").replace(/[*_`]+/g, "").trim();
	if (!plain) return false;
	const words = plain.split(/\s+/).length;
	if (words > 14) return false;
	// A keyword alone ("Meeting Overview") is a section title inside an entry; a header also
	// carries a number, a date or a separator ("Lecture 3", "Lecture Summary: …", "Meeting - 8/28").
	if (KEYWORD.test(plain)) return /\d/.test(plain) || /[:\-–—|]/.test(plain) || detectDate(plain) !== null;
	// A short line that is mostly a date ("8/28/26", "2026-09-11 — exam review").
	return detectDate(plain) !== null && words <= 8 && !/[.!?]$/.test(plain);
}

export function splitEntries(markdown: string, now: Date = new Date()): NoteEntry[] {
	const lines = markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").split("\n");
	const entries: NoteEntry[] = [];
	let current: NoteEntry | null = null;
	let buffer: string[] = [];
	let inFence = false;
	let lastDate: string | null = null;
	const flush = (endLine: number): void => {
		const text = buffer.join("\n").trim();
		if (current) {
			current.text = text;
			current.endLine = endLine;
			if (current.preamble ? text.length > 0 : true) entries.push(current);
		}
		buffer = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (!inFence && isEntryHeader(line)) {
			flush(i - 1);
			const title = line.trim().replace(/^#{1,6}\s+/, "").replace(/[*_`]+/g, "").trim();
			const own = detectDate(title, now);
			current = { title, date: own ?? lastDate, text: "", startLine: i, endLine: i, preamble: false, inherited: own === null && lastDate !== null };
			if (own) lastDate = own;
			continue;
		}
		if (!current) current = { title: "(before the first entry)", date: null, text: "", startLine: 0, endLine: 0, preamble: true, inherited: false };
		buffer.push(line);
	}
	flush(lines.length - 1);
	return entries;
}

/** Entries grouped by date, in source order; undated and excluded entries are left out. */
export function groupEntriesByDate(entries: NoteEntry[], include: (e: NoteEntry) => boolean = () => true): { date: string; title: string; text: string }[] {
	const groups = new Map<string, { date: string; title: string; text: string }>();
	for (const e of entries) {
		if (!e.date || !include(e)) continue;
		const block = `### ${e.title}\n\n${e.text}`.trim();
		const g = groups.get(e.date);
		if (g) {
			g.text += `\n\n${block}`;
		} else {
			groups.set(e.date, { date: e.date, title: e.title, text: block });
		}
	}
	return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}
