import { type App, Modal, Notice } from "obsidian";
import type { NoteEntry } from "./core/split";
import type LectureCompanionPlugin from "./main";

export interface SplitChoice {
	course: string;
	matchSlides: "ask" | "auto" | "off";
	summarize: boolean;
	/** Entries with their (possibly edited) dates; only included ones. */
	entries: NoteEntry[];
}

/** Preview of a note split into entries; each row has an include box and an editable date. */
export class SplitModal extends Modal {
	private resolve?: (choice: SplitChoice | null | "single") => void;

	constructor(
		app: App,
		private plugin: LectureCompanionPlugin,
		private sourceName: string,
		private entries: NoteEntry[],
		private defaults: { course: string },
	) {
		super(app);
	}

	ask(): Promise<SplitChoice | null | "single"> {
		this.open();
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.modalEl.addClass("lc-split-modal");
		const dated = this.entries.filter((e) => e.date && !e.inherited).length;
		this.titleEl.setText(`Split "${this.sourceName}" into ${dated} lecture${dated === 1 ? "" : "s"}`);
		this.contentEl.createEl("p", {
			cls: "lc-picker-hint",
			text: "One lecture note per date; entries on the same day are merged. Entries whose header has no date assume the previous entry's date — fix the date or untick them. Text before the first header is skipped unless you tick it and give it a date.",
		});

		const form = this.contentEl.createDiv({ cls: "lc-import-form" });
		form.createEl("label", { text: "Course" });
		const course = form.createEl("input", { attr: { list: "lc-split-courses", placeholder: "Course", spellcheck: "false" } });
		const list = form.createEl("datalist", { attr: { id: "lc-split-courses" } });
		for (const name of this.plugin.courseNames()) list.createEl("option", { attr: { value: name } });
		course.value = this.defaults.course;
		form.createEl("label", { text: "Slides" });
		const slides = form.createEl("select");
		for (const [v, label] of [
			["auto", "Match automatically (recommended for many entries)"],
			["ask", "Match and ask for each lecture"],
			["off", "Do not look for slides"],
		] as const) {
			slides.createEl("option", { text: label, attr: { value: v } });
		}
		slides.value = "auto";
		form.createEl("label", { text: "Summary" });
		const sumLabel = form.createEl("label", { cls: "lc-import-check" });
		const summarize = sumLabel.createEl("input", { type: "checkbox" });
		summarize.checked = true;
		sumLabel.appendText(" Write a summary for each lecture (Ollama)");

		const table = this.contentEl.createDiv({ cls: "lc-split-list" });
		const rows: { entry: NoteEntry; include: HTMLInputElement; date: HTMLInputElement }[] = [];
		for (const e of this.entries) {
			const row = table.createDiv({ cls: "lc-split-row" });
			const include = row.createEl("input", { type: "checkbox" });
			include.checked = !e.preamble && e.date !== null;
			const body = row.createDiv({ cls: "lc-picker-body" });
			body.createDiv({ cls: "lc-picker-name", text: e.title });
			const meta: string[] = [`${e.text.length.toLocaleString()} characters`];
			if (e.preamble) meta.push("before the first header");
			if (e.inherited) meta.push("no date in header: assumed same day as the entry above");
			if (!e.date && !e.preamble) meta.push("no date found");
			body.createDiv({ cls: "lc-picker-meta", text: meta.join(" · ") });
			const date = row.createEl("input", { type: "date", cls: "lc-split-date" });
			date.value = e.date ?? "";
			date.addEventListener("change", () => {
				if (date.value) include.checked = true;
			});
			rows.push({ entry: e, include, date });
		}

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const ok = buttons.createEl("button", { text: "Import lectures", cls: "mod-cta" });
		ok.addEventListener("click", () => {
			if (!course.value.trim()) {
				new Notice("Choose a course.");
				course.focus();
				return;
			}
			const chosen: NoteEntry[] = [];
			for (const r of rows) {
				if (!r.include.checked) continue;
				if (!r.date.value) {
					new Notice(`"${r.entry.title}" is ticked but has no date.`);
					r.date.focus();
					return;
				}
				chosen.push({ ...r.entry, date: r.date.value, inherited: false });
			}
			if (chosen.length === 0) {
				new Notice("Nothing is ticked.");
				return;
			}
			this.finish({
				course: course.value.trim(),
				matchSlides: slides.value === "ask" ? "ask" : slides.value === "off" ? "off" : "auto",
				summarize: summarize.checked,
				entries: chosen,
			});
		});
		buttons.createEl("button", { text: "Import as one lecture instead" }).addEventListener("click", () => this.finish("single"));
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.finish(null));
	}

	onClose(): void {
		this.resolve?.(null);
		this.resolve = undefined;
		this.contentEl.empty();
	}

	private finish(choice: SplitChoice | null | "single"): void {
		this.resolve?.(choice);
		this.resolve = undefined;
		this.close();
	}
}
