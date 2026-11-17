import { describe, expect, it } from "vitest";
import { chatMemoryGb, recommendModels, type HardwareInfo } from "../src/core/hardware";
import { SAMPLE_COURSE, sampleLectureNote, samplePages, samplePdf, SAMPLE_DECK } from "../src/core/sample";
import { backupPlan, backupStamp, backupsToPrune } from "../src/core/backup";
import { buildTranslateMessages, cleanTranslation, translatedHeading, translationChunks } from "../src/core/translate";
import { isHttpUrl, isMediaResponse, mediaFileName } from "../src/core/media";
import { translate } from "../src/i18n";
import { EN } from "../src/i18n-en";
import { alignTranscriptToSlides } from "../src/core/align";
import { sectionBody } from "../src/core/notes";
import { parseTranscript } from "../src/core/transcript";
import { buildSummaryMessages, languageInstruction } from "../src/core/summarize";
import { surveyUrl } from "../src/setup";
import { WHISPER_MODELS } from "../src/core/whisper/models";

const base: HardwareInfo = { platform: "win32", arch: "x64", cpuCores: 8, ramGb: 16, gpu: { vendor: "none" } };

describe("model recommendations", () => {
	it("uses the GPU when there is one", () => {
		const r = recommendModels({ ...base, gpu: { vendor: "nvidia", name: "RTX 4070", vramGb: 12 } });
		expect(r.whisperModel).toBe("large-v3-turbo");
		expect(r.build).toMatch(/CUDA/);
		expect(r.chatModel).toBe("qwen3.5:9b");
	});

	it("steers Apple silicon to Metal and counts unified memory", () => {
		const r = recommendModels({ platform: "darwin", arch: "arm64", cpuCores: 8, ramGb: 8, gpu: { vendor: "apple" } });
		expect(r.build).toMatch(/Homebrew.*Metal/);
		expect(r.whisperModel).toBe("large-v3-turbo-q8_0");
		expect(chatMemoryGb({ platform: "darwin", arch: "arm64", cpuCores: 8, ramGb: 8, gpu: { vendor: "apple" } })).toBeCloseTo(4.8);
		expect(r.chatModel).toBe("qwen3.5:2b");
		expect(recommendModels({ platform: "darwin", arch: "arm64", cpuCores: 10, ramGb: 64, gpu: { vendor: "apple" } }).chatModel).toBe("qwen3.5:27b");
	});

	it("scales with CPU cores without a GPU", () => {
		expect(recommendModels(base).whisperModel).toBe("large-v3-turbo");
		expect(recommendModels({ ...base, cpuCores: 6 }).whisperModel).toBe("large-v3-turbo-q8_0");
		expect(recommendModels({ ...base, cpuCores: 4 }).whisperModel).toBe("large-v3-turbo-q5_0");
		expect(recommendModels({ ...base, cpuCores: 2, ramGb: 8 }).whisperModel).toBe("small-q8_0");
		expect(recommendModels({ ...base, ramGb: 12 }).chatModel).toBe("qwen3.5:4b");
	});

	it("only recommends Whisper models the plugin can download", () => {
		const ids = new Set(WHISPER_MODELS.map((m) => m.id));
		for (const cores of [1, 4, 6, 8]) expect(ids.has(recommendModels({ ...base, cpuCores: cores }).whisperModel)).toBe(true);
		expect(ids.has(recommendModels({ platform: "darwin", arch: "arm64", cpuCores: 8, ramGb: 8, gpu: { vendor: "apple" } }).whisperModel)).toBe(true);
	});
});

describe("sample lecture", () => {
	it("is a complete lecture note with transcript, slides and summary", () => {
		const md = sampleLectureNote("2026-11-17");
		expect(md).toContain(`course: "${SAMPLE_COURSE}"`);
		expect(md).toContain(`![[${SAMPLE_DECK}]]`);
		const transcript = sectionBody(md, "Transcript") ?? "";
		const paras = parseTranscript(transcript);
		expect(paras.filter((p) => p.mark)).toHaveLength(2);
		expect(paras.filter((p) => p.question)).toHaveLength(1);
		expect(sectionBody(md, "In one sentence")).toMatch(/Binary search/);
		const { links } = alignTranscriptToSlides(transcript, sectionBody(md, "Slides") ?? "");
		expect(links).toBeGreaterThanOrEqual(4);
	});

	it("builds a structurally valid PDF with one page per slide", () => {
		const pdf = samplePdf();
		expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
		expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
		expect(pdf).toContain(`/Count ${samplePages().length}`);
		// every xref offset points at its object
		const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
		expect(pdf.slice(xrefAt, xrefAt + 4)).toBe("xref");
		const offsets = [...pdf.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
		offsets.forEach((off, i) => expect(pdf.slice(off).startsWith(`${i + 1} 0 obj`)).toBe(true));
		// stream lengths are right
		for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
			const start = (m.index ?? 0) + m[0].length;
			expect(pdf.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe("\nendstream");
		}
		expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(pdf)).toBe(false);
	});
});

describe("backups", () => {
	it("plans copies under a stamped folder and prunes old ones", () => {
		const stamp = backupStamp(new Date(2026, 10, 17, 9, 5, 3));
		expect(stamp).toBe("2026-11-17 090503");
		const plan = backupPlan(["Courses/ML/ML.md", "Courses/ML/2026-10-01.md", "Courses/ML/ML.md"], ".obsidian/plugins/lecture-companion/backups/", stamp, "rename ML: old?");
		expect(plan.folder).toBe(".obsidian/plugins/lecture-companion/backups/2026-11-17 090503 rename ML- old-");
		expect(plan.copies).toEqual([
			{ from: "Courses/ML/ML.md", to: `${plan.folder}/Courses/ML/ML.md` },
			{ from: "Courses/ML/2026-10-01.md", to: `${plan.folder}/Courses/ML/2026-10-01.md` },
		]);
		const names = Array.from({ length: 13 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")} 100000 x`);
		expect(backupsToPrune([...names, "notes"], 10)).toEqual(names.slice(0, 3));
		expect(backupsToPrune(names.slice(0, 4), 10)).toEqual([]);
	});
});

describe("transcript translation", () => {
	const section = "**[0:00]** Hello there.\n\n**[0:30]** ⭐ Important\n\n**[1:00]** **Q:** Why?\n\n**[1:05]** Because.";
	it("chunks paragraphs without marks and keeps timestamps", () => {
		const chunks = translationChunks(parseTranscript(section));
		expect(chunks).toEqual(["**[0:00]** Hello there.\n\n**[1:00]** **Q:** Why?\n\n**[1:05]** Because."]);
		expect(translationChunks(parseTranscript(section), 40)).toHaveLength(3);
		expect(buildTranslateMessages("Deutsch", chunks[0] ?? "")[0]?.content).toContain("into Deutsch");
		expect(translatedHeading("Español")).toBe("Transcript (Español)");
	});

	it("cleans the model's output", () => {
		expect(cleanTranslation("Here you go:\n\n**[0:00]** Hallo.\n\nfortgesetzt\n\n**[1:00]** **Q:** Warum?")).toBe("**[0:00]** Hallo. fortgesetzt\n\n**[1:00]** **Q:** Warum?");
	});
});

describe("media links", () => {
	it("accepts http(s) links to audio and video", () => {
		expect(isHttpUrl("https://x.edu/a.mp4")).toBe(true);
		expect(isHttpUrl("file:///c/a.mp4")).toBe(false);
		expect(isHttpUrl("not a url")).toBe(false);
		expect(isMediaResponse("audio/mpeg", "https://x/a")).toBe(true);
		expect(isMediaResponse("video/mp4; charset=binary", "https://x/a")).toBe(true);
		expect(isMediaResponse("application/octet-stream", "https://x/lecture%201.m4a?sig=1")).toBe(true);
		expect(isMediaResponse("application/octet-stream", "https://x/download?id=1")).toBe(false);
		expect(isMediaResponse("text/html", "https://x/a.mp4")).toBe(false);
	});

	it("names the file from the URL and type", () => {
		expect(mediaFileName("https://x.edu/media/Lecture%205.mp4?token=abc")).toBe("Lecture 5.mp4");
		expect(mediaFileName("https://x.edu/download", "audio/mpeg")).toBe("download.mp3");
		expect(mediaFileName("https://x.edu/", "")).toBe("recording.mp4");
	});
});

describe("i18n", () => {
	it("falls back to English and fills placeholders", () => {
		expect(translate("en", "setup.pull", { model: "qwen3.5:9b" })).toBe("Download qwen3.5:9b");
		expect(translate("xx", "panel.record")).toBe(EN["panel.record"]);
		expect(translate("en", "setup.use", {})).toBe("Use {model}");
	});
});

describe("summary language", () => {
	it("adds the instruction only when a language is set", () => {
		expect(languageInstruction("")).toBe("");
		expect(languageInstruction("Deutsch")).toMatch(/^Write your whole answer in Deutsch/);
		const [sys] = buildSummaryMessages({ course: "C", date: "d", transcript: "**[0:00]** hi", language: "Español" }, 8192);
		expect(sys?.content).toContain("Write your whole answer in Español");
	});
});

describe("survey", () => {
	it("only builds a link (nothing is sent)", () => {
		const url = surveyUrl("Meetings");
		expect(url.startsWith("https://github.com/TonyPeonio/obsidian-lecture-companion/discussions/new?")).toBe(true);
		expect(decodeURIComponent(url)).toContain("**Meetings**");
	});
});
