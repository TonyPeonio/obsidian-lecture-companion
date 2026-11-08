import { describe, expect, it } from "vitest";
import { conventionsBlock, MARK_END, MARK_START, SHARED_LINES, upsertConventions } from "../src/core/agent-bridge";

describe("AGENT.md bridge", () => {
	const block = conventionsBlock({ courseFolder: "Courses", noteMode: "per-lecture", dateHeading: "## {{date}}", meetingFolder: "Meetings" });

	it("describes the lecture note shape between the markers", () => {
		expect(block.startsWith(MARK_START)).toBe(true);
		expect(block.endsWith(MARK_END)).toBe(true);
		expect(block).toContain("`Courses/<course>/YYYY-MM-DD.md` is one lecture");
		expect(block).toContain("`## Slides`");
		expect(block).toContain("`## Summary`, `## Transcript`, `## My notes`");
		expect(block).toContain("`Courses/<course>.md` is the course note");
		expect(block).toContain("**[m:ss]**");
		expect(block).toContain("what did the professor say about X, and when");
		expect(block).toContain("`Meetings/<series>/YYYY-MM-DD.md`");
		for (const line of SHARED_LINES) expect(block).toContain(line);
		expect(block).not.toContain("holds one `## YYYY-MM-DD` section");
	});

	it("follows the folder, layout and date heading settings", () => {
		const sections = conventionsBlock({ courseFolder: "/School/", noteMode: "per-course-section", dateHeading: "## {{date}}", meetingFolder: "/Work/Meetings" });
		expect(sections).toContain("`School/<course>.md` holds one `## YYYY-MM-DD` section per lecture");
		expect(sections).toContain("`Work/Meetings/<series>/YYYY-MM-DD.md`");
		expect(sections).not.toContain("`School/<course>/YYYY-MM-DD.md`");
		expect(conventionsBlock({ courseFolder: "School", noteMode: "per-course-section", dateHeading: "## Lecture", meetingFolder: "Meetings" })).toContain("`## Lecture YYYY-MM-DD` section");
		expect(conventionsBlock({ courseFolder: "", noteMode: "per-lecture", dateHeading: "## {{date}}", meetingFolder: "" })).toContain("`Courses/<course>/YYYY-MM-DD.md`");
	});

	it("appends once and is idempotent", () => {
		const agent = "# Vault conventions\n\n## Folders\n- `Daily/` — one note per day.\n";
		const first = upsertConventions(agent, block);
		expect(first.changed).toBe(true);
		expect(first.text).toBe(`${agent.trimEnd()}\n\n${block}\n`);
		const second = upsertConventions(first.text, block);
		expect(second.changed).toBe(false);
		expect(second.text).toBe(first.text);
		expect(first.text.split(MARK_START).length).toBe(2);
	});

	it("replaces an older block in place, keeping the text around it", () => {
		const old = `# Conventions\n\n${MARK_START}\nold text\n${MARK_END}\n\n<!-- meeting-companion:start -->\nmeetings\n<!-- meeting-companion:end -->\n`;
		const res = upsertConventions(old, block);
		expect(res.changed).toBe(true);
		expect(res.text).toBe(`# Conventions\n\n${block}\n\n<!-- meeting-companion:start -->\nmeetings\n<!-- meeting-companion:end -->\n`);
		expect(res.text).not.toContain("old text");
		expect(upsertConventions("", block)).toEqual({ text: `${block}\n`, changed: true });
	});
});
