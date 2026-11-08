import { readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
	checkCitation,
	checkSummary,
	cleanSentence,
	contentWords,
	extractCitations,
	lectureSectionsOf,
	parseTimestamp,
	parseTranscriptLines,
	sharesContentWord,
	wordsMatch,
} from "../src/core/faithfulness";
import { isLectureNote, transcriptToMarkdown, upsertNestedSection } from "../src/core/notes";

const transcript = transcriptToMarkdown([
	{ start: 0, end: 5, text: "Today we start sorting." },
	{ start: 9, end: 18, text: "Merge sort splits the array in half and merges the sorted halves." },
	{ start: 62, end: 75, text: "In the worst case quick sort degrades to n squared." },
	{ start: 3725, end: 3730, text: "Homework is due Friday." },
]);

describe("timestamps and transcript lines", () => {
	it("parses m:ss and h:mm:ss, rejects other text", () => {
		expect(parseTimestamp("[0:09]")).toBe(9);
		expect(parseTimestamp("12:03")).toBe(723);
		expect(parseTimestamp("[1:02:05]")).toBe(3725);
		expect(parseTimestamp("[Slide 3]")).toBeNull();
		expect(parseTimestamp("1:2")).toBeNull();
	});

	it("reads the plugin's own transcript paragraphs", () => {
		const lines = parseTranscriptLines(transcript);
		expect(lines.map((l) => l.sec)).toEqual([0, 9, 62, 3725]);
		expect(lines[1]?.text).toBe("Merge sort splits the array in half and merges the sorted halves.");
		expect(parseTranscriptLines("![[rec.webm]]\n\n_Nothing was transcribed._")).toEqual([]);
		expect(parseTranscriptLines("[0:30] bare marker")).toEqual([{ sec: 30, text: "bare marker" }]);
	});
});

describe("citations in a summary", () => {
	it("finds every [m:ss] with its sentence, skipping headings", () => {
		const summary = "### Key points\n- Merge sort splits the array [0:09]\n- Two things said together [0:00] [1:02]\n### Questions to review\n1. Why n squared? [1:02]";
		const cites = extractCitations(summary);
		expect(cites.map((c) => [c.sec, c.sentence])).toEqual([
			[9, "Merge sort splits the array"],
			[0, "Two things said together"],
			[62, "Two things said together"],
			[62, "Why n squared?"],
		]);
	});

	it("ignores [Slide n] references and lines without timestamps", () => {
		expect(extractCitations("- From the slides only [Slide 4]\n- No citation here")).toEqual([]);
	});

	it("borrows the previous line when the cited line has no content words", () => {
		const summary = "- **Recurrence**:\n  - $T(n) = 2T(n/2) + n$ [0:21]";
		expect(extractCitations(summary)[0]?.sentence).toBe("Recurrence:");
	});

	it("strips markdown, math and list markers from the sentence", () => {
		expect(cleanSentence("1.  **Pivot** — see [[Quick sort|quick sort]] and `code` $x^2$ [0:48]")).toBe("Pivot — see quick sort and code");
		expect(cleanSentence("- [ ] **Sam** — order parts [0:01]")).toBe("Sam — order parts");
	});
});

describe("content words", () => {
	it("drops stopwords and summary framing words, keeps terms and numbers", () => {
		expect([...contentWords("The lecture introduces the concept of NP-completeness at n=30")]).toEqual(["concept", "np", "completeness", "30"]);
		expect(contentWords("It is the one that was").size).toBe(0);
	});

	it("matches inflections but not unrelated prefixes", () => {
		expect(wordsMatch("reduction", "reductions")).toBe(true);
		expect(wordsMatch("align", "aligned")).toBe(true);
		expect(wordsMatch("sort", "sorting")).toBe(true);
		expect(wordsMatch("sort", "sortable")).toBe(false);
		expect(wordsMatch("cat", "cats")).toBe(false);
		expect(wordsMatch("vertex", "vertices")).toBe(false);
	});

	it("shares a word across a sentence and a transcript line", () => {
		expect(sharesContentWord("Quick sort degrades to quadratic time", "In the worst case quick sort degrades to n squared.")).toBe(true);
		expect(sharesContentWord("The lecture introduces NP-completeness", "For each clause we create three new vertices.")).toBe(false);
	});
});

describe("checking citations against the transcript", () => {
	const lines = parseTranscriptLines(transcript);

	it("supports a citation with a matching line inside the window", () => {
		const r = checkCitation({ raw: "[0:15]", sec: 15, sentence: "Merge sort merges sorted halves" }, lines, 20);
		expect(r.supported).toBe(true);
		expect(r.line?.sec).toBe(9);
	});

	it("rejects a citation with no transcript line within ±20 s", () => {
		const r = checkCitation({ raw: "[2:15]", sec: 135, sentence: "Quick sort degrades" }, lines, 20);
		expect(r).toMatchObject({ supported: false, verdict: "no-transcript-line-in-window" });
		expect(r.line).toBeUndefined();
	});

	it("rejects a citation whose nearby line talks about something else", () => {
		const r = checkCitation({ raw: "[0:02]", sec: 2, sentence: "The lecture introduces NP-completeness and reductions" }, lines, 20);
		expect(r).toMatchObject({ supported: false, verdict: "no-shared-word" });
		expect(r.line?.sec).toBe(0);
	});

	it("prefers the candidate that shares a word over the nearest one", () => {
		const r = checkCitation({ raw: "[0:05]", sec: 5, sentence: "merge sort halves" }, lines, 20);
		expect(r.line?.sec).toBe(9);
	});

	it("scores a summary: a fabricated timeline against a 20-second transcript is caught", () => {
		const fabricated = "### Key points\n- The lecture introduces NP-completeness [0:02]\n- Reductions preserve answers [0:28]\n- Clause gadget: three vertices in a triangle [2:00]";
		const result = checkSummary(fabricated, "**[0:00]** For each clause, we create three new vertices, one for each literal, connected in a triangle.");
		expect(result.citations).toBe(3);
		expect(result.supported).toBe(0);
		expect(result.results.map((r) => r.verdict)).toEqual(["no-shared-word", "no-transcript-line-in-window", "no-transcript-line-in-window"]);
		expect(checkSummary("- nothing cited", transcript).precision).toBeNull();
	});
});

describe("finding Summary and Transcript in a note", () => {
	it("handles the per-lecture layout", () => {
		const md = "---\ntags:\n  - lecture\n---\n\n## Slides\n\n_No slides yet._\n\n## Summary\n\n- a [0:00]\n\n## Transcript\n\n**[0:00]** a\n\n## My notes\n\n";
		expect(lectureSectionsOf(md)).toEqual([{ scope: "", summary: "- a [0:00]", transcript: "**[0:00]** a" }]);
	});

	it("handles the per-course layout with one pair per date, transcript first", () => {
		let md = upsertNestedSection("", "## 2026-11-05", "Transcript", "**[0:00]** first day", "replace");
		md = upsertNestedSection(md, "## 2026-11-05", "Summary", "- first [0:00]", "replace");
		md = upsertNestedSection(md, "## 2026-11-06", "Transcript", "**[0:00]** second day", "replace");
		md = upsertNestedSection(md, "## 2026-11-06", "Summary", "- second [0:00]", "replace");
		expect(lectureSectionsOf(md)).toEqual([
			{ scope: "2026-11-05", summary: "- first [0:00]", transcript: "**[0:00]** first day" },
			{ scope: "2026-11-06", summary: "- second [0:00]", transcript: "**[0:00]** second day" },
		]);
	});

	it("returns nothing when a summary has no transcript sibling", () => {
		expect(lectureSectionsOf("## Summary\n\ntext\n\n## My notes\n")).toEqual([]);
	});
});

describe("synthetic fixture notes", () => {
	const root = path.join(__dirname, "fixtures", "notes");
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const full = path.join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (name.endsWith(".md")) files.push(full);
		}
	};
	walk(root);

	it("are two lecture notes whose summaries cite the transcript at 100%", () => {
		expect(files.length).toBe(2);
		for (const file of files) {
			const md = readFileSync(file, "utf8");
			expect(isLectureNote(md)).toBe(true);
			const sections = lectureSectionsOf(md);
			expect(sections.length).toBe(1);
			const result = checkSummary(sections[0]?.summary ?? "", sections[0]?.transcript ?? "");
			expect(result.citations).toBeGreaterThanOrEqual(10);
			expect(result.precision).toBe(1);
		}
	});
});
