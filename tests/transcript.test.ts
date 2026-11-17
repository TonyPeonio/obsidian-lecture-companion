import { describe, expect, it } from "vitest";
import { audioLinkOfNote, findTimestamps, groupParagraphs, hasMarks, hasQuestions, isQuestionTurn, markLine, markOfLine, parseTimestamp, parseTranscript, recentText, renderTranscript, type Paragraph } from "../src/core/transcript";
import { transcriptToMarkdown } from "../src/core/notes";

const seg = (start: number, end: number, text: string) => ({ start, end, text });

describe("timestamps", () => {
	it("parses m:ss, mm:ss and h:mm:ss", () => {
		expect(parseTimestamp("0:07")).toBe(7);
		expect(parseTimestamp("12:34")).toBe(754);
		expect(parseTimestamp("1:02:03")).toBe(3723);
		expect(parseTimestamp("1:75")).toBeNull();
		expect(parseTimestamp("abc")).toBeNull();
	});

	it("finds transcript markers and summary citations, not links or checkboxes", () => {
		const line = "**[1:05]** text, see [12:30] and [1:02:03]. Not [[note]] or [x] or [0:12](http://x) or [[0:12]].";
		expect(findTimestamps(line).map((m) => m.seconds)).toEqual([65, 750, 3723]);
		const first = findTimestamps(line)[0];
		expect(line.slice(first?.from, first?.to)).toBe("[1:05]");
	});

	it("finds the recording from frontmatter, else the first audio embed", () => {
		expect(audioLinkOfNote('---\ncourse: X\naudio: "[[ML 2026-11-05 1000.webm]]"\n---\n![[other.mp3]]')).toBe("ML 2026-11-05 1000.webm");
		expect(audioLinkOfNote("---\ncourse: X\n---\n## Slides\n![[deck.pdf]]\n## Transcript\n![[ML 2026-11-05 1000.webm]]\n**[0:00]** hi")).toBe("ML 2026-11-05 1000.webm");
		expect(audioLinkOfNote("![[deck.pdf]] no audio")).toBeNull();
	});
});

describe("marks", () => {
	it("round-trips a mark line", () => {
		const line = markLine({ at: 125, kind: "important" });
		expect(line).toBe("**[2:05]** ⭐ Important");
		expect(markOfLine(line)).toBe("important");
		expect(markOfLine("**[2:05]** ❓ Confusing")).toBe("confusing");
		expect(markOfLine("**[2:05]** ⭐ Important stuff said here")).toBeNull();
	});

	it("places marks after the paragraph being spoken", () => {
		const segments = [seg(0, 5, "First idea."), seg(10, 15, "Second idea."), seg(20, 25, "Third idea.")];
		const md = renderTranscript(segments, { marks: [{ at: 12, kind: "important" }, { at: 30, kind: "confusing" }] });
		expect(md).toBe("**[0:00]** First idea.\n\n**[0:10]** Second idea.\n\n**[0:12]** ⭐ Important\n\n**[0:20]** Third idea.\n\n**[0:30]** ❓ Confusing");
		expect(hasMarks(md)).toBe(true);
		expect(hasMarks("**[0:00]** ⭐ Important ideas follow")).toBe(false);
	});

	it("renders like transcriptToMarkdown when there are no marks or questions", () => {
		const segments = [seg(0, 2, "Hello"), seg(2.5, 4, "world."), seg(10, 12, "Is this a question for everyone here?"), seg(15, 18, "Yes.")];
		expect(renderTranscript(segments)).toBe(transcriptToMarkdown(segments));
	});
});

describe("questions from class", () => {
	const p = (text: string, gapBefore = 4): Paragraph => ({ start: 0, end: 1, text, gapBefore });
	const next = p("The answer is that the kernel must be positive semi-definite.");

	it("marks a short turn ending in ? after a pause, followed by an answer", () => {
		expect(isQuestionTurn(p("Does the kernel have to be symmetric?"), next)).toBe(true);
	});

	it("is conservative", () => {
		expect(isQuestionTurn(p("Does the kernel have to be symmetric?"), undefined)).toBe(false); // no answer
		expect(isQuestionTurn(p("Does the kernel have to be symmetric?", 1), next)).toBe(false); // no pause: mid-monologue
		expect(isQuestionTurn(p("Why?"), next)).toBe(false); // too short
		expect(isQuestionTurn(p("Any questions so far about the kernel trick?"), next)).toBe(false);
		expect(isQuestionTurn(p("Okay, does that make sense to everyone?"), next)).toBe(false);
		expect(isQuestionTurn(p("Is that clear to everyone in the back?"), next)).toBe(false);
		expect(isQuestionTurn(p("The kernel is symmetric."), next)).toBe(false);
		expect(isQuestionTurn(p(`${"word ".repeat(50)}?`), next)).toBe(false); // a long monologue ending in ?
	});

	it("prefixes detected questions with **Q:** in the rendered transcript", () => {
		const segments = [seg(0, 20, "Today we cover kernels and the kernel trick in detail."), seg(24, 27, "Does the kernel have to be symmetric?"), seg(30, 40, "Yes, it must be symmetric and positive semi-definite.")];
		const md = renderTranscript(segments, { markQuestions: true });
		expect(md).toContain("**[0:24]** **Q:** Does the kernel have to be symmetric?");
		expect(md).toContain("**[0:00]** Today we cover");
		expect(hasQuestions(md)).toBe(true);
	});
});

describe("parseTranscript", () => {
	it("returns paragraphs with seconds, flags marks and questions, strips slide links", () => {
		const section = [
			"![[ML 2026-11-05 1000.webm]]",
			"",
			"**[0:00]** Welcome back. · [[deck.pdf#page=1|slide 1]]",
			"",
			"**[1:05]** **Q:** What is a kernel?",
			"",
			"**[1:10]** ⭐ Important",
			"",
			"**[1:02:03]** Late paragraph",
			"continued here",
			"_placeholder_",
		].join("\n");
		const parsed = parseTranscript(section);
		expect(parsed.map((p) => [p.start, p.text, p.mark ?? null, p.question ?? false])).toEqual([
			[0, "Welcome back.", null, false],
			[65, "What is a kernel?", null, true],
			[70, "⭐ Important", "important", false],
			[3723, "Late paragraph continued here", null, false],
		]);
		expect(parsed[0]?.line).toBe(2);
	});
});

describe("groupParagraphs / recentText", () => {
	it("records the pause before each paragraph", () => {
		const paras = groupParagraphs([seg(0, 2, "a"), seg(2.2, 3, "b"), seg(8, 9, "c")]);
		expect(paras.map((p) => [p.text, p.gapBefore])).toEqual([
			["a b", Infinity],
			["c", 5],
		]);
	});

	it("keeps only the last N minutes", () => {
		const segments = [seg(0, 10, "old"), seg(400, 410, "recent"), seg(590, 600, "latest")];
		expect(recentText(segments, 600, 5)).toBe("recent latest");
	});
});
