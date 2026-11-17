import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { alignTranscriptToSlides } from "../src/core/align";
import { sectionBody } from "../src/core/notes";
import { buildSummaryMessages, transcriptHints } from "../src/core/summarize";
import { parseTranscript } from "../src/core/transcript";

const BASE = { course: "ML", date: "2026-11-05" };

describe("summary prompt: marks and questions from class", () => {
	it("always offers a Questions from class section", () => {
		const [system] = buildSummaryMessages({ ...BASE, transcript: "**[0:00]** hello" }, 8192);
		expect(system?.content).toContain("### Questions from class");
	});

	it("explains marks only when the transcript has them", () => {
		expect(transcriptHints("**[0:00]** plain")).toBe("");
		const marked = "**[0:00]** The ELBO bounds the likelihood.\n\n**[0:20]** ⭐ Important\n\n**[0:30]** Reparameterization.\n\n**[0:40]** ❓ Confusing";
		const [system] = buildSummaryMessages({ ...BASE, transcript: marked }, 8192);
		expect(system?.content).toContain("Give the material around an Important mark priority");
		expect(system?.content).toContain("Explain the material around a Confusing mark more thoroughly");
		expect(system?.content).not.toContain("**Q:**");
	});

	it("explains **Q:** paragraphs only when present", () => {
		const t = "**[0:00]** Lecture.\n\n**[0:10]** **Q:** Is it symmetric?\n\n**[0:15]** Yes.";
		expect(transcriptHints(t)).toContain('start with "**Q:**"');
		const [system] = buildSummaryMessages({ ...BASE, transcript: t }, 8192);
		expect(system?.content).toContain("Questions from class with the lecturer's answer");
	});

	it("does not add transcript hints when summarizing the student's notes", () => {
		const [system] = buildSummaryMessages({ ...BASE, transcript: "**[0:20]** ⭐ Important", source: "notes" }, 8192);
		expect(system?.content).not.toContain("Important mark");
	});
});

describe("alignment on a fixture lecture note", () => {
	it("links without changing the transcript text", () => {
		const md = readFileSync(join(__dirname, "fixtures/notes/Algorithms/2026-10-12.md"), "utf8").replace(/\r\n/g, "\n");
		const transcript = sectionBody(md, "Transcript") ?? "";
		const slides = sectionBody(md, "Slides") ?? "";
		const { text } = alignTranscriptToSlides(transcript, slides);
		expect(parseTranscript(text).map((p) => p.text)).toEqual(parseTranscript(transcript).map((p) => p.text));
	});
});
