import { browser, expect } from "@wdio/globals";

/** The plugin instance (plugin ids are camel-cased by wdio-obsidian-service). */
type Lc = { renameCourse(from: string, to: string): Promise<unknown>; settings: Record<string, unknown> };

async function exists(path: string): Promise<boolean> {
	return browser.executeObsidian(({ app }, p) => app.vault.getAbstractFileByPath(p) !== null, path);
}

async function read(path: string): Promise<string> {
	return browser.executeObsidian(({ app }, p) => app.vault.adapter.read(p), path);
}

async function backups(): Promise<string[]> {
	return browser.executeObsidian(async ({ app }) => {
		const root = `${app.vault.configDir}/plugins/lecture-companion/backups`;
		return (await app.vault.adapter.exists(root)) ? (await app.vault.adapter.list(root)).folders : [];
	});
}

describe("Lecture Companion in Obsidian", function () {
	beforeEach(async function () {
		await browser.reloadObsidian({ vault: "./e2e/vault" });
		// Close anything Obsidian shows on a fresh start, so clicks reach the note.
		await browser.execute(() => document.querySelectorAll<HTMLElement>(".modal-close-button").forEach((b) => b.click()));
	});

	it("moves a course note from before 0.1.19 into its folder on first start, keeping links, after a backup", async function () {
		await browser.waitUntil(() => exists("Courses/Bio/Bio.md"), { timeout: 30_000, timeoutMsg: "course note was not moved" });
		expect(await exists("Courses/Bio.md")).toBe(false);
		// Links are fixed right after the move.
		await browser.waitUntil(async () => (await read("Courses/Bio/2026-10-14.md")).includes("[[Courses/Bio/Bio|Bio]]"), { timeout: 15_000, timeoutMsg: "link to the moved course note was not updated" });
		const made = await backups();
		expect(made.length).toBeGreaterThan(0);
	});

	it("renames a course, its course note, recording and links", async function () {
		await browser.waitUntil(() => exists("Courses/Bio/Bio.md"), { timeout: 30_000 });
		await browser.executeObsidian(async ({ plugins }) => {
			await (plugins as unknown as { lectureCompanion: Lc }).lectureCompanion.renameCourse("ML Old", "Machine Learning");
		});
		expect(await exists("Courses/Machine Learning/Machine Learning.md")).toBe(true);
		expect(await exists("Courses/Machine Learning/attachments/Machine Learning 2026-10-01 1000.wav")).toBe(true);
		expect(await exists("Courses/ML Old")).toBe(false);
		const note = await read("Courses/Machine Learning/2026-10-01.md");
		expect(note).toContain('course: Machine Learning');
		expect(note).toContain("Machine Learning 2026-10-01 1000.wav");
		expect(note).not.toContain("ML Old 2026-10-01");
		const inbox = await read("Inbox/links.md");
		expect(inbox).not.toContain("ML Old");
		expect((await backups()).some((f) => f.includes("rename ML Old"))).toBe(true);
	});

	it("plays the recording from a clicked transcript timestamp", async function () {
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath("Courses/ML Old/2026-10-01.md");
			if (!(file instanceof obsidian.TFile)) throw new Error("note missing");
			await app.workspace.getLeaf(true).openFile(file, { state: { mode: "preview" } });
		});
		const stamp = await browser.$("//span[contains(@class,'lc-timestamp') and text()='[0:02]']");
		await stamp.waitForExist({ timeout: 20_000 });
		await stamp.click();
		await browser.waitUntil(
			async () =>
				browser.execute(() => Array.from(document.querySelectorAll("audio")).some((a) => a.currentTime >= 1.5)),
			{ timeout: 15_000, timeoutMsg: "no audio element was moved to 0:02" },
		);
	});

	it("creates the sample lecture without any setup", async function () {
		await browser.executeObsidianCommand("lecture-companion:try-sample");
		const today = await browser.executeObsidian(({ obsidian }) => obsidian.moment().format("YYYY-MM-DD"));
		const path = `Courses/Sample course/${today}.md`;
		await browser.waitUntil(() => exists(path), { timeout: 20_000 });
		expect(await exists("Courses/Sample course/attachments/Binary search slides.pdf")).toBe(true);
		await browser.waitUntil(async () => (await read(path)).includes("#page=2|slide 2]]"), { timeout: 20_000, timeoutMsg: "slide links missing" });
		expect(await read("Courses/Sample course/Sample course.md")).toContain(today);
	});

	it("imports a note as a lecture", async function () {
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath("Inbox/class-notes.md");
			if (!(file instanceof obsidian.TFile)) throw new Error("note missing");
			await app.workspace.getLeaf(true).openFile(file);
		});
		await browser.executeObsidianCommand("lecture-companion:import-note");
		const modal = await browser.$(".modal .lc-import-form");
		await modal.waitForExist({ timeout: 10_000 });
		await browser.execute(() => {
			const form = document.querySelector(".modal .lc-import-form");
			if (!form) throw new Error("no form");
			const course = form.querySelector<HTMLInputElement>("input[list]");
			const date = form.querySelector<HTMLInputElement>("input[type=date]");
			const slides = form.querySelector<HTMLSelectElement>("select");
			const summarize = form.querySelector<HTMLInputElement>(".lc-import-check input");
			if (course) course.value = "Algorithms";
			if (date) date.value = "2026-11-02";
			if (slides) slides.value = "off";
			if (summarize) summarize.checked = false;
		});
		await (await browser.$("//div[contains(@class,'modal')]//button[text()='Import']")).click();
		await browser.waitUntil(() => exists("Courses/Algorithms/2026-11-02.md"), { timeout: 20_000 });
		const note = await read("Courses/Algorithms/2026-11-02.md");
		expect(note).toContain("Hash tables map keys to buckets");
		expect(note).toContain("## My notes");
	});
});
