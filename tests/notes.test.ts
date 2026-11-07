import { describe, expect, it } from "vitest";
import {
	addLectureLink,
	courseNotePath,
	detectDate,
	migrateCourseIndex,
	oneLineSummary,
	setLectureLinkSummary,
	addTodos,
	ensureTodoSection,
	extractTodos,
	replaceAttachmentRefs,
	isLectureNote,
	stripFrontmatter,
	dateHeading,
	findSection,
	formatTimestamp,
	lectureNotePath,
	nestedSectionBody,
	renderLectureNote,
	safeFileName,
	sectionBody,
	slidesToMarkdown,
	startOfDay,
	toISODate,
	transcriptToMarkdown,
	upsertNestedSection,
	upsertSection,
} from "../src/core/notes";
import { buildSummaryMessages, fitToContext, stripThinkTags } from "../src/core/summarize";
import { addCourseAlias, addMeeting, courseNoteOverride, DEFAULT_SETTINGS, hiddenCourseIds, meetingList, parseCourseNotes, parseKeyValueLines, setCourseAlias, setCourseHidden, vaultCourseName, visibleCourses } from "../src/settings";

describe("one-sentence summaries in the course note", () => {
	it("takes the In one sentence section, else the first key point or overview sentence", () => {
		expect(oneLineSummary("### In one sentence\nClustering, density estimation and PCA as ways to find structure without labels.\n\n### Key points\n- k-means [12:03]")).toBe(
			"Clustering, density estimation and PCA as ways to find structure without labels.",
		);
		expect(oneLineSummary("### Key points\n- **Unsupervised learning** finds patterns in [[Unlabeled data|unlabeled data]] [03:15]\n- second")).toBe("Unsupervised learning finds patterns in unlabeled data");
		expect(oneLineSummary("### Overview\nWe planned the robot. Budget is open.\n\n### Discussion\n- x")).toBe("We planned the robot.");
		expect(oneLineSummary("_No summary yet._")).toBeNull();
	});

	it("writes the sentence after the day's link and replaces an older one", () => {
		const link = "[[Courses/ML/2026-08-24|2026-08-24 lecture]]";
		let md = addLectureLink("", "2026-08-24", link);
		md = addLectureLink(md, "2026-08-26", "[[Courses/ML/2026-08-26|2026-08-26 lecture]]");
		md = setLectureLinkSummary(md, link, "Course logistics and what machine learning is.");
		expect(md).toContain(`- ${link} — Course logistics and what machine learning is.`);
		md = setLectureLinkSummary(md, link, "Updated.");
		expect(md).toContain(`- ${link} — Updated.`);
		expect(md).not.toContain("Course logistics");
		expect(md).toContain("- [[Courses/ML/2026-08-26|2026-08-26 lecture]]\n");
		expect(addLectureLink(md, "2026-08-24", link)).toBe(md);
	});
});

describe("meetings", () => {
	it("renders a meeting note with the meeting tag and no Slides section", () => {
		const md = renderLectureNote({ course: "Robotics Club", date: "2026-11-06", kind: "meeting" });
		expect(md).toContain("  - meeting");
		expect(md).not.toContain("  - lecture");
		expect(md).not.toContain("## Slides");
		expect(md).toContain("## Summary");
		expect(md).toContain("## Transcript");
		expect(isLectureNote(md)).toBe(true);
		expect(renderLectureNote({ course: "c", date: "2026-11-06" })).toContain("## Slides");
	});

	it("lists meetings under a Meetings heading in the series note", () => {
		const md = addLectureLink("", "2026-11-06", "[[Meetings/Club/2026-11-06|2026-11-06 meeting]]", "## Meetings");
		expect(md).toContain("## Meetings");
		expect(md).not.toContain("## Lectures");
		expect(md).toContain("### 2026-11-06");
	});

	it("uses the meeting prompt with an Action items checklist", () => {
		const msgs = buildSummaryMessages({ course: "Robotics Club", date: "2026-11-06", transcript: "t", kind: "meeting" }, 8192);
		expect(msgs[0]?.content).toContain("### Action items");
		expect(msgs[0]?.content).toContain("### Decisions");
		expect(msgs[0]?.content).not.toContain("### Questions to review");
		expect(msgs[1]?.content).toContain("Meeting: Robotics Club");
		const lecture = buildSummaryMessages({ course: "CS101", date: "d", transcript: "t" }, 8192);
		expect(lecture[0]?.content).toContain("### Questions to review");
		expect(lecture[0]?.content).not.toContain("### Action items");
	});

	it("pulls action items out of a meeting summary as todos", () => {
		const summary = "### Overview\nWe met.\n\n### Decisions\n- Use Rust\n\n### Action items\n- [ ] **Sam** — order parts (Friday)\n- [ ] book the room\n\n### Open questions\n- budget?";
		expect(extractTodos(sectionBody(summary, "Action items") ?? "").todos).toEqual(["- [ ] **Sam** — order parts (Friday)", "- [ ] book the room"]);
	});

	it("keeps a case-insensitive meeting list", () => {
		const s = { ...DEFAULT_SETTINGS };
		expect(addMeeting(s, " Robotics Club ")).toBe(true);
		expect(addMeeting(s, "robotics club")).toBe(false);
		expect(addMeeting(s, "1:1 with Sam")).toBe(true);
		expect(meetingList(s)).toEqual(["Robotics Club", "1:1 with Sam"]);
	});
});

describe("paths and formatting", () => {
	it("sanitizes names and builds paths", () => {
		expect(safeFileName('CS 101: Intro/Advanced? "Yes" [x] #1')).toBe("CS 101- Intro-Advanced- -Yes- -x- -1");
		expect(lectureNotePath("/Courses/", "CS101", "2026-11-05")).toBe("Courses/CS101/2026-11-05.md");
		expect(courseNotePath("Courses", "Math: 2")).toBe("Courses/Math- 2.md");
		expect(dateHeading("## {{date}}", "2026-11-05")).toBe("## 2026-11-05");
		expect(dateHeading("## Lecture", "2026-11-05")).toBe("## Lecture 2026-11-05");
	});

	it("timestamps and dates", () => {
		expect(formatTimestamp(0)).toBe("0:00");
		expect(formatTimestamp(754.9)).toBe("12:34");
		expect(formatTimestamp(3661)).toBe("1:01:01");
		expect(toISODate(new Date(2026, 10, 5, 23, 59))).toBe("2026-11-05");
		expect(startOfDay("2026-11-05").getHours()).toBe(0);
		expect(toISODate(startOfDay("2026-11-05"))).toBe("2026-11-05");
	});
});

describe("transcript and slides markdown", () => {
	it("groups segments into timestamped paragraphs at pauses", () => {
		const md = transcriptToMarkdown([
			{ start: 0, end: 2, text: "Hello," },
			{ start: 2.1, end: 4, text: "welcome." },
			{ start: 9, end: 12, text: "New topic." },
		]);
		expect(md).toBe("**[0:00]** Hello, welcome.\n\n**[0:09]** New topic.");
	});

	it("renders embeds, links and folded slide text", () => {
		const md = slidesToMarkdown([{ vaultPath: "Courses/CS101/attachments/Week 3.pdf", title: "Week 3", text: "--- Page 1 ---\nIntro", source: "Canvas · Module 4" }]);
		expect(md).toBe("![[Week 3.pdf]]\n[[Week 3.pdf|Week 3]] — Canvas · Module 4\n\n> [!note]- Slide text: Week 3\n> --- Page 1 ---\n> Intro");
	});

	it("renders a full lecture note skeleton", () => {
		const md = renderLectureNote({ course: "CS101", date: "2026-11-05", audioPath: "a/b/rec.webm" });
		expect(md.startsWith('---\ncourse: "CS101"\ndate: 2026-11-05\ntags:\n  - lecture\naudio: "[[rec.webm]]"\n---\n\n## Slides\n\n_No slides yet._\n\n## Summary')).toBe(true);
		expect(md).not.toContain("\n# ");
		expect(sectionBody(md, "Transcript")).toBe("_No transcript yet._");
		expect(sectionBody(md, "My notes")).toBe("");
	});
});

describe("sections", () => {
	const note = ["# Title", "", "## Slides", "", "old slide", "", "## Transcript", "", "```", "## not a heading", "```", "words", "", "### Sub", "", "deep", "", "## My notes", "", "mine"].join("\n");

	it("finds sections, skipping fences and including sub-sections", () => {
		const lines = note.split("\n");
		expect(findSection(lines, "slides")).toEqual({ headingLine: 2, level: 2, bodyStart: 3, bodyEnd: 6 });
		expect(findSection(lines, "## Transcript")?.bodyEnd).toBe(17);
		expect(findSection(lines, "Nope")).toBeNull();
		expect(sectionBody(note, "Transcript")).toBe("```\n## not a heading\n```\nwords\n\n### Sub\n\ndeep");
	});

	it("appends, replaces placeholders and creates missing sections", () => {
		const appended = upsertSection(note, "Slides", "new slide");
		expect(sectionBody(appended, "Slides")).toBe("old slide\n\nnew slide");
		expect(sectionBody(appended, "My notes")).toBe("mine");
		const replaced = upsertSection(note, "Transcript", "fresh", "replace");
		expect(sectionBody(replaced, "Transcript")).toBe("fresh");
		expect(replaced).toContain("## My notes\n\nmine");
		const created = upsertSection("# T\n\ntext\n", "Summary", "sum");
		expect(created).toBe("# T\n\ntext\n\n## Summary\n\nsum\n");
		const placeholder = upsertSection("## Slides\n\n_No slides yet._\n", "Slides", "![[a.pdf]]");
		expect(sectionBody(placeholder, "Slides")).toBe("![[a.pdf]]");
		expect(upsertSection("", "A", "b")).toBe("## A\n\nb\n");
	});

	it("upserts nested sections under a date heading", () => {
		let md = "# CS101\n";
		md = upsertNestedSection(md, "## 2026-11-04", "Transcript", "yesterday", "replace");
		md = upsertNestedSection(md, "## 2026-11-05", "Transcript", "today", "replace");
		md = upsertNestedSection(md, "## 2026-11-05", "Transcript", "more", "append");
		md = upsertNestedSection(md, "## 2026-11-05", "Slides", "![[x.pdf]]");
		expect(nestedSectionBody(md, "## 2026-11-04", "Transcript")).toBe("yesterday");
		expect(nestedSectionBody(md, "## 2026-11-05", "Transcript")).toBe("today\n\nmore");
		expect(nestedSectionBody(md, "## 2026-11-05", "Slides")).toBe("![[x.pdf]]");
		expect(md).toContain("### Transcript");
		expect(md.indexOf("## 2026-11-04")).toBeLessThan(md.indexOf("## 2026-11-05"));
		expect(nestedSectionBody(md, "## 2026-11-06", "Transcript")).toBeNull();
	});
});

describe("import helpers", () => {
	it("detects dates in file names and text", () => {
		expect(detectDate("2026-11-05")).toBe("2026-11-05");
		expect(detectDate("Lecture notes 2026_11_05 bio")).toBe("2026-11-05");
		expect(detectDate("20261105 algorithms")).toBe("2026-11-05");
		expect(detectDate("11-05-2026 class")).toBe("2026-11-05");
		expect(detectDate("11/5/26")).toBe("2026-11-05");
		expect(detectDate("Nov 5 2026")).toBe("2026-11-05");
		expect(detectDate("November 5th, 2026")).toBe("2026-11-05");
		expect(detectDate("5 Nov 2026")).toBe("2026-11-05");
		expect(detectDate("Oct 14", new Date(2026, 0, 1))).toBe("2026-10-14");
		expect(detectDate("Sorting algorithms")).toBeNull();
		expect(detectDate("CSCI578 week 3")).toBeNull();
	});

	it("recognises lecture notes and strips frontmatter", () => {
		expect(isLectureNote(renderLectureNote({ course: "c", date: "2026-11-05" }))).toBe(true);
		expect(isLectureNote("---\ntags:\n  - lecture\n---\nx")).toBe(true);
		expect(isLectureNote("# Just notes\n\n- a\n- b")).toBe(false);
		expect(stripFrontmatter("---\na: 1\n---\nbody\n")).toBe("body\n");
		expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
		const md = renderLectureNote({ course: "c", date: "2026-11-05", myNotes: "- my bullet" });
		expect(sectionBody(md, "My notes")).toBe("- my bullet");
	});
});

describe("course index", () => {
	it("adds links under ## Lectures / ### date, once", () => {
		let md = addLectureLink("", "2026-08-24", "[[Courses/X/2026-08-24|2026-08-24 lecture]]");
		md = addLectureLink(md, "2026-08-26", "[[Courses/X/2026-08-26|2026-08-26 lecture]]");
		md = addLectureLink(md, "2026-08-26", "[[Courses/X/2026-08-26|2026-08-26 lecture]]");
		expect(md).toBe("## Lectures\n\n### 2026-08-24\n\n- [[Courses/X/2026-08-24|2026-08-24 lecture]]\n\n### 2026-08-26\n\n- [[Courses/X/2026-08-26|2026-08-26 lecture]]\n");
	});

	it("migrates the old per-date layout but keeps date sections with other content", () => {
		const old = "## 2026-08-26\n### Lectures\n\n- [[Courses/X/2026-08-26|2026-08-26 lecture]]\n\n## 2026-08-24\n### Lectures\n\n- [[Courses/X/2026-08-24|2026-08-24 lecture]]\n\n## 2026-09-01\n### Lectures\n\n- [[Courses/X/2026-09-01|2026-09-01 lecture]]\n\nMy own remark about this day.\n";
		const md = migrateCourseIndex(old);
		expect(md).toBe("## 2026-09-01\n### Lectures\n\n- [[Courses/X/2026-09-01|2026-09-01 lecture]]\n\nMy own remark about this day.\n\n## Lectures\n\n### 2026-08-24\n\n- [[Courses/X/2026-08-24|2026-08-24 lecture]]\n\n### 2026-08-26\n\n- [[Courses/X/2026-08-26|2026-08-26 lecture]]\n");
		expect(migrateCourseIndex(md)).toBe(md);
		expect(migrateCourseIndex("")).toBe("");
	});
});

describe("summaries", () => {
	it("fits transcript and slides to the context window", () => {
		const long = "x".repeat(100_000);
		const fitted = fitToContext({ course: "c", date: "d", transcript: long, slideText: long }, 8192);
		expect(fitted.truncated).toBe(true);
		expect(fitted.transcript.length + fitted.slideText.length).toBeLessThan(8192 * 3.2);
		expect(fitted.transcript.endsWith("(… transcript truncated here)")).toBe(true);
		const small = fitToContext({ course: "c", date: "d", transcript: "short" }, 8192);
		expect(small).toEqual({ transcript: "short", slideText: "", truncated: false });
	});

	it("builds system + user messages", () => {
		const msgs = buildSummaryMessages({ course: "CS101", date: "2026-11-05", transcript: "t", slideText: "s", extraInstructions: "German" }, 32768);
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[1]?.content).toBe("Course: CS101\nDate: 2026-11-05\n\n## Slide text\n\ns\n\n## Transcript\n\nt\n\n## Additional instructions from the student\n\nGerman");
		expect(stripThinkTags("<think>hmm</think>\n### Key points")).toBe("### Key points");
	});

	it("adapts the prompt to notes instead of a transcript", () => {
		const notes = buildSummaryMessages({ course: "c", date: "d", transcript: "- terse bullet", source: "notes" }, 8192);
		expect(notes[0]?.content).toContain("notes a student typed");
		expect(notes[0]?.content).not.toContain("[mm:ss]");
		expect(notes[1]?.content).toContain("## Student's notes");
		const transcript = buildSummaryMessages({ course: "c", date: "d", transcript: "t" }, 8192);
		expect(transcript[0]?.content).toContain("[mm:ss]");
		expect(transcript[1]?.content).toContain("## Transcript");
	});
});

describe("settings helpers", () => {
	it("parses course note overrides", () => {
		expect(parseCourseNotes("# comment\n12345 = Courses/CS101\nLinear Algebra=Math/LA.md\nbad line\n")).toEqual([
			{ key: "12345", path: "Courses/CS101.md" },
			{ key: "linear algebra", path: "Math/LA.md" },
		]);
		const s = { ...DEFAULT_SETTINGS, courseNotes: "12345 = A.md\ncs101 = B.md" };
		expect(courseNoteOverride(s, { id: 12345, name: "X" })).toBe("A.md");
		expect(courseNoteOverride(s, { name: "Intro", courseCode: "CS101" })).toBe("B.md");
		expect(courseNoteOverride(s, { name: "Other" })).toBeUndefined();
	});

	it("maps Canvas courses to the names used in the vault", () => {
		const canvas = { id: 777, name: "Fall 2026 BIOINFORMATICS (CSCI-578-A, CSCI-478-A, BIOL-510-A)", courseCode: "CSCI-578-A" };
		const s = { ...DEFAULT_SETTINGS };
		expect(vaultCourseName(s, canvas)).toBe(canvas.name);
		expect(vaultCourseName(s, { id: 1, name: "No Code" })).toBe("No Code");
		expect(addCourseAlias(s, canvas, canvas.name)).toBe(false);
		expect(addCourseAlias(s, canvas, canvas.name.toLowerCase())).toBe(false);
		expect(addCourseAlias(s, canvas, "CSCI578")).toBe(true);
		expect(s.courseAliases).toBe("777 = CSCI578");
		expect(addCourseAlias(s, canvas, "Other")).toBe(false);
		expect(vaultCourseName(s, canvas)).toBe("CSCI578");
		// The course code is a real preference: notes typed as "CSCI-578-A" must keep filing there.
		const byCode = { ...DEFAULT_SETTINGS, courseAliases: "" };
		expect(addCourseAlias(byCode, canvas, "csci-578-a")).toBe(true);
		expect(vaultCourseName(byCode, canvas)).toBe("csci-578-a");
		expect(parseKeyValueLines("# c\nA = b\nbad\n = x\n")).toEqual([{ key: "a", value: "b" }]);
	});
});

describe("setCourseAlias", () => {
	it("adds, replaces and clears a course's alias without touching others", () => {
		const s = { ...DEFAULT_SETTINGS, courseAliases: "111 = Algo\n777 = Old" };
		const bio = { id: 777, name: "Fall 2026 BIOINFORMATICS", courseCode: "CSCI-578-A" };
		setCourseAlias(s, bio, "CSCI578");
		expect(s.courseAliases).toBe("111 = Algo\n777 = CSCI578");
		expect(vaultCourseName(s, bio)).toBe("CSCI578");
		setCourseAlias(s, bio, "");
		expect(s.courseAliases).toBe("111 = Algo");
		expect(vaultCourseName(s, bio)).toBe(bio.name);
		setCourseAlias(s, bio, "csci-578-a");
		expect(s.courseAliases).toBe("111 = Algo\n777 = csci-578-a");
		setCourseAlias(s, bio, "fall 2026 bioinformatics");
		expect(s.courseAliases).toBe("111 = Algo");
	});
});

describe("hidden courses", () => {
	it("hides and shows courses by Canvas id and filters a course list", () => {
		const s = { ...DEFAULT_SETTINGS, hiddenCourses: "" };
		const courses = [
			{ id: 1, name: "Intro CS", courseCode: "CS101" },
			{ id: 2, name: "Department shell", courseCode: "DEPT" },
		];
		expect(setCourseHidden(s, 2, true)).toBe(true);
		expect(setCourseHidden(s, 2, true)).toBe(false);
		expect([...hiddenCourseIds(s)]).toEqual([2]);
		expect(visibleCourses(s, courses).map((c) => c.id)).toEqual([1]);
		expect(setCourseHidden(s, 1, true)).toBe(true);
		expect(s.hiddenCourses).toBe("1\n2");
		expect(setCourseHidden(s, 2, false)).toBe(true);
		expect(visibleCourses(s, courses).map((c) => c.id)).toEqual([2]);
		expect(hiddenCourseIds({ ...s, hiddenCourses: " 7 \nabc\n\n8" }).size).toBe(2);
	});
});

describe("replaceAttachmentRefs", () => {
	it("repoints embeds, links and aliased links by file name", () => {
		const md = "![[Deck.pptx]]\n[[Deck.pptx|Deck]] — Canvas\n[[Courses/X/attachments/Deck.pptx]]\n![[Other.pptx]]";
		expect(replaceAttachmentRefs(md, "Deck.pptx", "Deck.pdf")).toBe("![[Deck.pdf]]\n[[Deck.pdf|Deck]] — Canvas\n[[Deck.pdf]]\n![[Other.pptx]]");
	});
});

describe("todos", () => {
	const notes = "Course Goals:\n\n* Practice agile\n* Bookclub reflection 🛫 2026-08-26 📅 2026-08-30 ✅ 2026-08-27\n* Elevator Pitch Slide 🛫 2026-08-26 📅 2026-09-02\n- [ ] read chapter 3\n- [x] set up Trello\n\nMore prose.";

	it("extracts checkbox and Tasks-plugin lines, normalised, and keeps the rest", () => {
		const { remaining, todos } = extractTodos(notes);
		expect(todos).toEqual([
			"- [x] Bookclub reflection 🛫 2026-08-26 📅 2026-08-30 ✅ 2026-08-27",
			"- [ ] Elevator Pitch Slide 🛫 2026-08-26 📅 2026-09-02",
			"- [ ] read chapter 3",
			"- [x] set up Trello",
		]);
		expect(remaining).toBe("Course Goals:\n\n* Practice agile\n\nMore prose.");
		expect(extractTodos("no tasks here").todos).toEqual([]);
	});

	it("appends to the course TODO section without duplicates and ensures the section exists", () => {
		let md = addLectureLink("", "2026-08-24", "[[Courses/X/2026-08-24|2026-08-24 lecture]]");
		md = ensureTodoSection(md);
		expect(md).toBe("## Lectures\n\n### 2026-08-24\n\n- [[Courses/X/2026-08-24|2026-08-24 lecture]]\n\n## TODO\n\n\n");
		md = addTodos(md, ["- [ ] Test1", "- [x] done thing"]);
		expect(sectionBody(md, "TODO")).toBe("- [ ] Test1\n- [x] done thing");
		md = addTodos(md, ["- [ ] Test1", "- [ ] Test2"]);
		expect(sectionBody(md, "TODO")).toBe("- [ ] Test1\n- [x] done thing\n- [ ] Test2");
		expect(ensureTodoSection(md)).toBe(md);
	});
});
