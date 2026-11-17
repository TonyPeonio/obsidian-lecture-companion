import { describe, expect, it } from "vitest";
import { buildReport, issueUrl, LogBuffer, looksLikeError, MAX_ISSUE_URL, redact, redactUrl, REPO_URL } from "../src/core/report";
import { migrateSettings, DEFAULT_SETTINGS } from "../src/settings";

describe("LogBuffer", () => {
	it("keeps the most recent entries", () => {
		const log = new LogBuffer(3);
		for (let i = 0; i < 5; i++) log.add("info", `m${i}`, i);
		expect(log.recent(10).map((e) => e.message)).toEqual(["m2", "m3", "m4"]);
		expect(log.recent(2).map((e) => e.message)).toEqual(["m3", "m4"]);
		log.add("error", "   ");
		expect(log.recent(10)).toHaveLength(3);
	});
});

describe("looksLikeError", () => {
	it("spots failure notices", () => {
		expect(looksLikeError("Summary failed: model not found")).toBe(true);
		expect(looksLikeError("Could not start: no microphone")).toBe(true);
		expect(looksLikeError("Lecture note written: Courses/ML/2026-11-05.md")).toBe(false);
	});
});

describe("redact", () => {
	it("removes secrets, personal paths, query strings and token-like strings", () => {
		const text = [
			"token 7~AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 used",
			"opened C:\\Users\\Tony\\Documents\\Vault\\Courses\\ML\\note.md",
			"also c:/users/tony/Documents/Vault/x and C:\\Users\\Tony\\AppData\\whisper",
			"GET https://school.instructure.com/api/v1/courses?access_token=secret123456789&per_page=50",
			"Authorization: Bearer abcdefghijklmnop",
			"key sk-abcdefghijklmnopqrstuv",
			"my secret is hunter2hunter2",
		].join("\n");
		const out = redact(text, { vaultPath: "C:\\Users\\Tony\\Documents\\Vault", homeDir: "C:\\Users\\Tony", secrets: ["hunter2hunter2"] });
		expect(out).not.toMatch(/AbCdEfGh|secret123|abcdefghijklmnop|sk-abc|hunter2|Tony/);
		expect(out).toContain("<vault>\\Courses\\ML\\note.md");
		expect(out).toContain("<vault>/x");
		expect(out).toContain("~\\AppData\\whisper");
		expect(out).toContain("https://school.instructure.com/api/v1/courses?…");
	});

	it("keeps hosts and paths of URLs", () => {
		expect(redactUrl("http://127.0.0.1:11434/api/chat?x=1#y")).toBe("http://127.0.0.1:11434/api/chat?…");
		expect(redactUrl("http://localhost:11434")).toBe("http://localhost:11434");
	});
});

describe("buildReport / issueUrl", () => {
	const input = {
		pluginVersion: "0.3.0",
		obsidianVersion: "1.13.2",
		platform: "Windows (win32 x64)",
		settings: { whisperModel: "large-v3-turbo", lmsUrl: "https://school.example/?token=abc12345678", lmsToken: "(set)" },
		status: ["whisper-server: ready", "Ollama: reachable"],
		log: [{ time: new Date(2026, 0, 1, 9, 5, 7).getTime(), level: "error" as const, message: "Summary failed: boom at C:\\Users\\Tony\\x" }],
		serverLog: ["whisper_init: loaded"],
	};

	it("builds a redacted issue body with environment, status, settings and log", () => {
		const body = buildReport(input, { homeDir: "C:\\Users\\Tony" });
		expect(body).toContain("- Lecture Companion 0.3.0");
		expect(body).toContain("- Obsidian 1.13.2");
		expect(body).toContain("- whisper-server: ready");
		expect(body).toContain('whisperModel: "large-v3-turbo"');
		expect(body).toContain("09:05:07 error Summary failed: boom at ~\\x");
		expect(body).toContain("whisper_init: loaded");
		expect(body).not.toContain("abc12345678");
		expect(body).toContain("### What happened");
	});

	it("puts the body in the URL when it fits, else asks to paste", () => {
		const small = issueUrl("Title", "body text");
		expect(small.complete).toBe(true);
		expect(small.url.startsWith(`${REPO_URL}/issues/new?title=Title&body=body%20text`)).toBe(true);
		const big = issueUrl("Title", "x".repeat(MAX_ISSUE_URL));
		expect(big.complete).toBe(false);
		expect(big.url.length).toBeLessThan(MAX_ISSUE_URL);
		expect(decodeURIComponent(big.url)).toContain("paste it here");
	});
});

describe("migrateSettings", () => {
	it("fills defaults for a new install (no course site, checklist not shown)", () => {
		const s = migrateSettings(null);
		expect(s.lms).toBe("none");
		expect(s.setupShown).toBe(false);
		expect(s.llmProvider).toBe("ollama");
	});

	it("keeps Canvas for users who had it configured, and skips the checklist", () => {
		const s = migrateSettings({ canvasUrl: "https://x.instructure.com", canvasToken: "t", whisperBinaryPath: "" });
		expect(s.lms).toBe("canvas");
		expect(s.setupShown).toBe(true);
		expect(migrateSettings({ whisperBinaryPath: "" }).lms).toBe("none");
	});

	it("leaves an explicit choice alone", () => {
		expect(migrateSettings({ ...DEFAULT_SETTINGS, lms: "moodle", canvasUrl: "u", canvasToken: "t" }).lms).toBe("moodle");
	});
});
