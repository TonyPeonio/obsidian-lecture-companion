// Converting notes taken by hand into lecture notes: the text goes under "My notes", the deck
// is matched against it, and the summary is written from notes + slide text.

import { type App, Modal, Notice, TFile, TFolder } from "obsidian";
import { detectDate, extractTodos, isLectureNote, renderLectureNote, SECTION_MY_NOTES, SECTION_SLIDES, stripFrontmatter, toISODate } from "./core/notes";
import type LectureCompanionPlugin from "./main";
import { cleanTranscript } from "./session";
import type { NoteTarget } from "./vault";

export interface ImportOptions {
	course: string;
	date: string;
	/** The student's notes (markdown). */
	text: string;
	/** Source note, when the import comes from a file; upgraded in place when it already sits at the lecture path. */
	sourcePath?: string;
	matchSlides: "ask" | "auto" | "off";
	summarize: boolean;
}

export interface ImportResult {
	target: NoteTarget;
	created: boolean;
	slides: boolean;
	summarized: boolean;
	/** Tasks moved to the course TODO list. */
	todos: number;
}

export async function importNotesAsLecture(plugin: LectureCompanionPlugin, opts: ImportOptions): Promise<ImportResult> {
	const course = opts.course.trim();
	if (!course) throw new Error("Choose a course");
	// Task lines go to the course note's TODO list instead of staying in the day's notes.
	const { remaining, todos } = extractTodos(opts.text.trim());
	const notes = remaining || (todos.length ? "_Only tasks; see the course TODO list._" : "");
	if (!notes) throw new Error("The note is empty");
	await plugin.learnCourseAlias(course);

	const perLecture = plugin.settings.noteMode === "per-lecture";
	const target = plugin.noteTargetFor(course, opts.date);
	const inPlace = opts.sourcePath !== undefined && opts.sourcePath === target.path;
	let created = false;
	if (perLecture) {
		if (inPlace) {
			// Upgrade the existing file: keep its text, add the layout around it.
			const existing = await plugin.vault.read(target.path);
			if (!isLectureNote(existing)) {
				const split = extractTodos(stripFrontmatter(existing));
				todos.push(...split.todos);
				await plugin.vault.write(target.path, renderLectureNote({ course, date: opts.date, myNotes: split.remaining }));
				created = true;
			}
		} else {
			created = await plugin.vault.createIfMissing(target.path, renderLectureNote({ course, date: opts.date, myNotes: notes }));
			if (!created) await plugin.vault.writeSection(target, SECTION_MY_NOTES, notes, "append");
		}
		await plugin.ensureCourseLink(course, opts.date, target.path);
	} else {
		await plugin.ensureLectureNote(course, opts.date);
		await plugin.vault.writeSection(target, SECTION_MY_NOTES, notes, "append");
	}

	const todosAdded = await plugin.addCourseTodos(course, todos);

	let slides = false;
	if (opts.matchSlides !== "off" && plugin.canvas.configured) {
		const before = cleanTranscript((await plugin.vault.readSection(target, SECTION_SLIDES)) ?? "", false);
		if (!before) {
			await plugin.matchSlides(course, opts.date, target, notes, opts.matchSlides);
			slides = !!cleanTranscript((await plugin.vault.readSection(target, SECTION_SLIDES)) ?? "", false);
		} else {
			slides = true;
		}
	}

	let summarized = false;
	if (opts.summarize) {
		await plugin.session.summarize(target, { course, date: opts.date });
		summarized = true;
	}
	return { target, created, slides, summarized, todos: todosAdded };
}

/** Notes in a folder that are not lecture notes yet, with the date each file name implies. */
export async function listImportableNotes(plugin: LectureCompanionPlugin, folder: TFolder): Promise<{ file: TFile; date: string | null }[]> {
	const out: { file: TFile; date: string | null }[] = [];
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		const md = await plugin.app.vault.cachedRead(child);
		if (isLectureNote(md)) continue;
		if (!stripFrontmatter(md).trim()) continue;
		const date = detectDate(child.basename) ?? detectDate(md.slice(0, 400)) ?? null;
		out.push({ file: child, date });
	}
	return out.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
}

export interface ImportChoice {
	course: string;
	date: string;
	matchSlides: "ask" | "auto" | "off";
	summarize: boolean;
}

/** Asks for course and date (and what to run) before importing. */
export class ImportModal extends Modal {
	private resolve?: (choice: ImportChoice | null) => void;

	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
		private heading: string,
		private defaults: Partial<ImportChoice>,
		/** Hide the date field (batch import takes dates from file names). */
		private withDate = true,
	) {
		super(app);
	}

	ask(): Promise<ImportChoice | null> {
		this.open();
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.titleEl.setText(this.heading);
		const form = this.contentEl.createDiv({ cls: "lc-import-form" });

		form.createEl("label", { text: "Course" });
		const course = form.createEl("input", { attr: { list: "lc-import-courses", placeholder: "Course", spellcheck: "false" } });
		const list = form.createEl("datalist", { attr: { id: "lc-import-courses" } });
		for (const name of this.plugin.courseNames()) list.createEl("option", { attr: { value: name } });
		course.value = this.defaults.course ?? "";

		let date: HTMLInputElement | undefined;
		if (this.withDate) {
			form.createEl("label", { text: "Lecture date" });
			date = form.createEl("input", { type: "date" });
			date.value = this.defaults.date ?? toISODate();
		}

		form.createEl("label", { text: "Slides" });
		const slides = form.createEl("select");
		for (const [v, label] of [
			["ask", "Match against my notes and ask"],
			["auto", "Match automatically"],
			["off", "Do not look for slides"],
		] as const) {
			slides.createEl("option", { text: label, attr: { value: v } });
		}
		slides.value = this.defaults.matchSlides ?? this.plugin.settings.slideMatching;

		form.createEl("label", { text: "Summary" });
		const summarizeLabel = form.createEl("label", { cls: "lc-import-check" });
		const summarize = summarizeLabel.createEl("input", { type: "checkbox" });
		summarize.checked = this.defaults.summarize ?? true;
		summarizeLabel.appendText(" Write a summary from my notes and the slides (Ollama)");

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const ok = buttons.createEl("button", { text: "Import", cls: "mod-cta" });
		ok.addEventListener("click", () => {
			if (!course.value.trim()) {
				new Notice("Choose a course.");
				course.focus();
				return;
			}
			this.finish({
				course: course.value.trim(),
				date: date?.value || this.defaults.date || toISODate(),
				matchSlides: slides.value === "auto" ? "auto" : slides.value === "off" ? "off" : "ask",
				summarize: summarize.checked,
			});
		});
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(null));
		window.setTimeout(() => course.focus(), 0);
	}

	onClose(): void {
		this.resolve?.(null);
		this.resolve = undefined;
		this.contentEl.empty();
	}

	private finish(choice: ImportChoice | null): void {
		this.resolve?.(choice);
		this.resolve = undefined;
		this.close();
	}
}
