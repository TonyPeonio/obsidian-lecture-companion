import { describe, expect, it } from "vitest";
import { cleanTranscript } from "../src/session";

describe("cleanTranscript", () => {
	const section = ["![[CSCI578 2026-11-05 1718.webm]]", "", "_Nothing was transcribed._", "", "**[0:00]** Real words.", "", "", "_No transcript yet._"].join("\n");

	it("drops placeholders, keeps embeds for the note", () => {
		expect(cleanTranscript(section, true)).toBe("![[CSCI578 2026-11-05 1718.webm]]\n\n**[0:00]** Real words.");
	});

	it("drops embeds too for model input, and reports empty sections as empty", () => {
		expect(cleanTranscript(section, false)).toBe("**[0:00]** Real words.");
		expect(cleanTranscript("![[rec.webm]]\n\n_Nothing was transcribed._", false)).toBe("");
		expect(cleanTranscript("_No slides yet._", false)).toBe("");
		expect(cleanTranscript("", true)).toBe("");
	});
});
