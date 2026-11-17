// "Machine Learning starts in 2 min. Record?" A check every 30 s against the weekly schedule
// from settings and today's Canvas calendar events. It only asks: recording starts when the user
// clicks Record.

import { type App, Modal } from "obsidian";
import { classesFromCanvas, dueReminders, occurrenceKey, occurrencesOn, parseWeeklySchedule, startsIn, type ClassOccurrence } from "./core/schedule";
import { toISODate } from "./core/notes";
import { vaultCourseName } from "./settings";
import type LectureCompanionPlugin from "./main";

const CANVAS_REFRESH_MS = 3 * 60 * 60_000;

export class ClassReminders {
	private shown = new Set<string>();
	private canvasClasses: ClassOccurrence[] = [];
	private canvasFetchedAt = 0;
	private canvasFetchedFor = "";
	private fetching = false;

	constructor(private plugin: LectureCompanionPlugin) {}

	register(): void {
		this.plugin.registerInterval(window.setInterval(() => void this.tick(), 30_000));
		this.plugin.app.workspace.onLayoutReady(() => window.setTimeout(() => void this.tick(), 5_000));
	}

	/** Today's classes from both sources (Canvas events fetched at most every 3 hours). */
	async todaysClasses(now = new Date()): Promise<ClassOccurrence[]> {
		const s = this.plugin.settings;
		const out = occurrencesOn(parseWeeklySchedule(s.classSchedule).classes, now);
		const lms = this.plugin.lms();
		if (s.classRemindersCanvas && lms.configured && lms.calendarEvents) {
			const today = toISODate(now);
			// A new day fetches again (after a failure, at most every 10 minutes); the same day every 3 hours.
			const age = Date.now() - this.canvasFetchedAt;
			const stale = this.canvasFetchedFor !== today ? age > 10 * 60_000 : age > CANVAS_REFRESH_MS;
			if (!this.fetching && stale) {
				this.fetching = true;
				try {
					if (this.plugin.courses.length === 0) await this.plugin.refreshCourses();
					const byCode = new Map(this.plugin.courses.map((c) => [`course_${c.id}`, vaultCourseName(s, c)]));
					const events = await lms.calendarEvents([...this.plugin.courses.map((c) => c.id)], today, today);
					this.canvasClasses = classesFromCanvas(events, (code) => byCode.get(code));
					this.canvasFetchedFor = today;
				} catch {
					// offline or Canvas down: keep the last list, try again later
				} finally {
					this.canvasFetchedAt = Date.now();
					this.fetching = false;
				}
			}
			out.push(...this.canvasClasses);
		}
		return out;
	}

	private async tick(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.classReminders || this.plugin.session.isBusy) return;
		const now = new Date();
		const due = dueReminders(await this.todaysClasses(now), now, Math.max(1, s.reminderLeadMinutes), this.shown);
		const first = due[0];
		if (!first) return;
		for (const o of due) this.shown.add(occurrenceKey(o));
		new RecordPromptModal(this.plugin.app, first, now, () => void this.plugin.recordNow(first.course)).open();
	}
}

class RecordPromptModal extends Modal {
	constructor(
		app: App,
		private occurrence: ClassOccurrence,
		private now: Date,
		private onRecord: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(`${this.occurrence.course} ${startsIn(this.occurrence, this.now)}. Record?`);
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `From ${this.occurrence.source === "canvas" ? "the Canvas calendar" : "your class schedule"}. Record starts the lecture note for ${this.occurrence.course}, ${toISODate(this.occurrence.start)}.`,
		});
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		row.createEl("button", { text: "Record", cls: "mod-cta" }).addEventListener("click", () => {
			this.close();
			this.onRecord();
		});
		row.createEl("button", { text: "Dismiss" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
