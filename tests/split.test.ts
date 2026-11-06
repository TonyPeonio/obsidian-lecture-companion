import { describe, expect, it } from "vitest";
import { groupEntriesByDate, isEntryHeader, splitEntries } from "../src/core/split";

const sample = `[Course Website](https://example.edu/csci370)
Lecture 1 - 8.24.26
Course Goals:

* Practice agile/scrum development
* Act as "consultants" doing work for a client

Lecture 2 - 8.26.26

* Recommending books
* Bookclub reflection 🛫 2026-08-26 📅 2026-08-30 ✅ 2026-08-27
This lecture emphasizes that effective teamwork is a rare but powerful competitive advantage.

Meeting with Caleb - 8.28.26
Meeting Overview
The meeting served as an introductory session with the course advisor.

Lecture 3 - 8/31/2026
As a shopper, I want to see relevant results.

Lecture 10/5/2026

* Software Quality Report 📅 2026-10-06 ✅ 2026-10-06

Lecture Summary: Course Introduction & Agile/Scrum Fundamentals
Course Objectives:
CSCI 370 is designed to train students in agile/scrum development.

Meeting Summary: Course Advisor Introduction (8/28/26)
Introductory session with course advisor Caleb.
`;

describe("isEntryHeader", () => {
	it("accepts lecture/meeting headers and bare dates, rejects bullets, tasks and prose", () => {
		expect(isEntryHeader("Lecture 1 - 8.24.26")).toBe(true);
		expect(isEntryHeader("## Lecture 4 - 9/4/2026")).toBe(true);
		expect(isEntryHeader("Meeting with Caleb - 8.28.26")).toBe(true);
		expect(isEntryHeader("Lecture 10/5/2026")).toBe(true);
		expect(isEntryHeader("2026-09-11 exam review")).toBe(true);
		expect(isEntryHeader("Lecture Summary: Course Introduction & Agile/Scrum Fundamentals")).toBe(true);
		expect(isEntryHeader("* Bookclub reflection 🛫 2026-08-26 📅 2026-08-30 ✅ 2026-08-27")).toBe(false);
		expect(isEntryHeader("- Research NNUE 📅 2026-09-06")).toBe(false);
		expect(isEntryHeader("Course Goals:")).toBe(false);
		expect(isEntryHeader("This lecture emphasizes that effective teamwork is a rare but powerful competitive advantage in software engineering.")).toBe(false);
		expect(isEntryHeader("Meeting Overview")).toBe(false);
		expect(isEntryHeader("Lecture notes")).toBe(false);
		expect(isEntryHeader("Lecture 7")).toBe(true);
		expect(isEntryHeader("Week 3: trees")).toBe(true);
	});
});

describe("splitEntries", () => {
	it("splits at headers, dates them and keeps the preamble separate", () => {
		const entries = splitEntries(sample);
		expect(entries.map((e) => [e.title, e.date, e.inherited])).toEqual([
			["(before the first entry)", null, false],
			["Lecture 1 - 8.24.26", "2026-08-24", false],
			["Lecture 2 - 8.26.26", "2026-08-26", false],
			["Meeting with Caleb - 8.28.26", "2026-08-28", false],
			["Lecture 3 - 8/31/2026", "2026-08-31", false],
			["Lecture 10/5/2026", "2026-10-05", false],
			["Lecture Summary: Course Introduction & Agile/Scrum Fundamentals", "2026-10-05", true],
			["Meeting Summary: Course Advisor Introduction (8/28/26)", "2026-08-28", false],
		]);
		expect(entries[0]?.preamble).toBe(true);
		expect(entries[3]?.text).toBe("Meeting Overview\nThe meeting served as an introductory session with the course advisor.");
		expect(entries[0]?.text).toBe("[Course Website](https://example.edu/csci370)");
		expect(entries[1]?.text).toBe('Course Goals:\n\n* Practice agile/scrum development\n* Act as "consultants" doing work for a client');
		expect(entries[2]?.text).toContain("Bookclub reflection");
		expect(entries[5]?.text).toBe("* Software Quality Report 📅 2026-10-06 ✅ 2026-10-06");
	});

	it("groups entries that share a date, in date order, skipping undated and excluded ones", () => {
		const entries = splitEntries(sample);
		const groups = groupEntriesByDate(entries, (e) => !e.title.startsWith("Lecture 3") && !e.inherited);
		expect(groups.map((g) => g.date)).toEqual(["2026-08-24", "2026-08-26", "2026-08-28", "2026-10-05"]);
		const meeting = groups.find((g) => g.date === "2026-08-28");
		expect(meeting?.text.startsWith("### Meeting with Caleb - 8.28.26\n\nMeeting Overview")).toBe(true);
		expect(meeting?.text).toContain("### Meeting Summary: Course Advisor Introduction (8/28/26)");
	});

	it("handles frontmatter and a note with no headers", () => {
		const entries = splitEntries("---\ntags: [x]\n---\njust prose\nmore prose");
		expect(entries).toEqual([{ title: "(before the first entry)", date: null, text: "just prose\nmore prose", startLine: 0, endLine: 1, preamble: true, inherited: false }]);
	});
});
