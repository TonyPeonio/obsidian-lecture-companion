import { type App, Modal, Notice } from "obsidian";
import type { RankedSlide } from "./core/match";

/** Lets the user confirm which decks belong to a lecture. Resolves with the chosen decks, or null when dismissed. */
export class SlidePickerModal extends Modal {
	private resolve?: (picked: RankedSlide[] | null) => void;
	private checks = new Map<number, HTMLInputElement>();

	constructor(
		app: App,
		private course: string,
		private date: string,
		private ranked: RankedSlide[],
		private hasTranscript: boolean,
		/** When given, the picker offers "Attach and stop asking": attaches the selection and calls this to switch matching to automatic. */
		private onAutoAccept?: () => Promise<void>,
	) {
		super(app);
	}

	ask(): Promise<RankedSlide[] | null> {
		this.open();
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	onOpen(): void {
		this.titleEl.setText(`Slides for ${this.course} — ${this.date}`);
		this.modalEl.addClass("lc-picker-modal");
		this.contentEl.createEl("p", {
			cls: "lc-picker-hint",
			text: this.hasTranscript
				? "Ranked by how much each file's text overlaps the transcript, and whether it looks like a deck rather than a worksheet. The best match is checked; tick another only if the lecture used two decks."
				: "No transcript yet, so these are ranked only by how much they look like a deck. Check the deck for this lecture.",
		});
		if (this.onAutoAccept) {
			this.contentEl.createEl("p", {
				cls: "lc-picker-hint",
				text: "Usually right? Attach and stop asking also switches Match slides to the lecture to Automatic: from then on the best match is attached without this dialog whenever one deck clearly wins.",
			});
		}
		const list = this.contentEl.createDiv({ cls: "lc-picker-list" });
		for (const r of this.ranked) {
			const row = list.createEl("label", { cls: "lc-picker-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = r.selected;
			this.checks.set(r.id, cb);
			const body = row.createDiv({ cls: "lc-picker-body" });
			body.createDiv({ cls: "lc-picker-name", text: r.name });
			const meta: string[] = [];
			if (r.moduleName) meta.push(r.moduleName);
			meta.push(...r.reasons);
			body.createDiv({ cls: "lc-picker-meta", text: meta.join(" · ") });
			const bar = row.createEl("progress", { cls: "lc-picker-score", attr: { max: "1" } });
			bar.value = Math.min(1, r.similarity);
			bar.title = `${Math.round(r.similarity * 100)}% transcript match`;
		}
		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		const attach = buttons.createEl("button", { text: "Attach selected", cls: "mod-cta" });
		attach.addEventListener("click", () => this.finish(this.selected()));
		if (this.onAutoAccept) {
			const auto = buttons.createEl("button", { text: "Attach and stop asking" });
			auto.addEventListener("click", () => {
				auto.disabled = true;
				void this.onAutoAccept?.()
					.then(() => new Notice("Slides are now attached automatically when one deck clearly wins. Change this under Settings → Canvas → Match slides to the lecture.", 8000))
					.catch((err: unknown) => new Notice(`Could not save the setting: ${(err as Error).message}`, 8000))
					.finally(() => this.finish(this.selected()));
			});
		}
		buttons.createEl("button", { text: "Select all" }).addEventListener("click", () => this.checks.forEach((c) => (c.checked = true)));
		buttons.createEl("button", { text: "None" }).addEventListener("click", () => this.checks.forEach((c) => (c.checked = false)));
		buttons.createEl("button", { text: "Skip" }).addEventListener("click", () => this.finish(null));
	}

	onClose(): void {
		this.resolve?.(null);
		this.resolve = undefined;
		this.contentEl.empty();
	}

	private selected(): RankedSlide[] {
		return this.ranked.filter((r) => this.checks.get(r.id)?.checked);
	}

	private finish(picked: RankedSlide[] | null): void {
		this.resolve?.(picked);
		this.resolve = undefined;
		this.close();
	}
}
