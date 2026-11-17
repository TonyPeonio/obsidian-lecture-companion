// Class times, for the "Machine Learning starts in 2 min. Record?" reminder. Two sources: a weekly
// schedule typed in settings (`Machine Learning = Mon Wed Fri 10:00-10:50`) and Canvas calendar
// events. Pure functions; the plugin polls and shows the prompt (it never starts recording itself).

export interface WeeklyClass {
	course: string;
	/** 0 = Sunday … 6 = Saturday. */
	days: number[];
	/** Minutes after midnight. */
	start: number;
	end: number;
}

export interface ClassOccurrence {
	course: string;
	start: Date;
	end?: Date;
	source: "schedule" | "canvas";
}

const DAY_NAMES: Record<string, number> = { su: 0, sun: 0, sunday: 0, m: 1, mo: 1, mon: 1, monday: 1, tu: 2, tue: 2, tues: 2, tuesday: 2, w: 3, we: 3, wed: 3, wednesday: 3, th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4, f: 5, fr: 5, fri: 5, friday: 5, sa: 6, sat: 6, saturday: 6 };

/** "10:00", "9:30am", "2pm", "14:05" → minutes after midnight. */
export function parseClock(text: string): number | null {
	const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(text.trim());
	if (!m) return null;
	let h = Number(m[1]);
	const min = m[2] ? Number(m[2]) : 0;
	const ampm = m[3]?.toLowerCase().replace(/\./g, "");
	if (min >= 60 || h > 23 || (!m[2] && !ampm)) return null;
	if (ampm) {
		if (h < 1 || h > 12) return null;
		if (ampm === "pm" && h !== 12) h += 12;
		if (ampm === "am" && h === 12) h = 0;
	}
	return h * 60 + min;
}

/** Day tokens: "Mon Wed Fri", "Mon,Wed", "MWF", "TTh", "Tue/Thu". */
function parseDays(text: string): number[] | null {
	const days = new Set<number>();
	for (const token of text.toLowerCase().split(/[\s,/&+]+/).filter(Boolean)) {
		if (token in DAY_NAMES) {
			days.add(DAY_NAMES[token] ?? 0);
			continue;
		}
		// Compact letters: MWF, TTh, TR (R = Thursday), MTWRF.
		const compact = /^(?:m|t|w|r|f|th|s|su|sa|u)+$/.test(token) ? token.match(/th|su|sa|[mtwrfsu]/g) : null;
		if (!compact) return null;
		for (const c of compact) {
			const d = ({ m: 1, t: 2, w: 3, r: 4, th: 4, f: 5, s: 6, sa: 6, su: 0, u: 0 } as Record<string, number>)[c];
			if (d === undefined) return null;
			days.add(d);
		}
	}
	return days.size ? [...days].sort((a, b) => a - b) : null;
}

/**
 * One class per line: `Course name = days start-end` (end optional), e.g.
 * `Machine Learning = Mon Wed Fri 10:00-10:50`, `Algorithms = TTh 2pm-3:15pm`. Lines that do not
 * parse are returned in `errors` (and `#` comments are skipped).
 */
export function parseWeeklySchedule(text: string): { classes: WeeklyClass[]; errors: string[] } {
	const classes: WeeklyClass[] = [];
	const errors: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const idx = line.lastIndexOf("=");
		const course = idx > 0 ? line.slice(0, idx).trim() : "";
		const rest = idx > 0 ? line.slice(idx + 1).trim() : "";
		const m = /^(.*?)\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)(?:\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?))?$/i.exec(rest);
		const days = m ? parseDays(m[1] ?? "") : null;
		let start = m ? parseClock(m[2] ?? "") : null;
		let end = m?.[3] ? parseClock(m[3]) : null;
		// "2-3:15pm": the start borrows the end's am/pm.
		if (m && start === null && m[3]) {
			const suffix = /([ap]\.?m\.?)$/i.exec(m[3])?.[1];
			if (suffix) start = parseClock(`${m[2] ?? ""}${suffix}`);
		}
		if (!course || !days || start === null) {
			errors.push(line);
			continue;
		}
		if (end === null || end <= start) end = start + 50;
		classes.push({ course, days, start, end });
	}
	return { classes, errors };
}

/** Occurrences of the weekly classes on the local day of `day`. */
export function occurrencesOn(classes: WeeklyClass[], day: Date): ClassOccurrence[] {
	const out: ClassOccurrence[] = [];
	for (const c of classes) {
		if (!c.days.includes(day.getDay())) continue;
		const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(c.start / 60), c.start % 60);
		const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(c.end / 60), c.end % 60);
		out.push({ course: c.course, start, end, source: "schedule" });
	}
	return out;
}

export interface CanvasEventLike {
	title: string;
	startAt: string;
	endAt?: string;
	allDay?: boolean;
	contextCode: string;
}

/**
 * Canvas calendar events that look like class meetings: timed (not all-day), 20 minutes to
 * 4 hours long, in a course the plugin knows (`courseFor` maps `course_123` to the vault name).
 */
export function classesFromCanvas(events: CanvasEventLike[], courseFor: (contextCode: string) => string | undefined): ClassOccurrence[] {
	const out: ClassOccurrence[] = [];
	for (const e of events) {
		if (e.allDay) continue;
		const start = new Date(e.startAt);
		const end = e.endAt ? new Date(e.endAt) : undefined;
		if (Number.isNaN(start.getTime())) continue;
		if (end) {
			const minutes = (end.getTime() - start.getTime()) / 60_000;
			if (minutes < 20 || minutes > 240) continue;
		}
		const course = courseFor(e.contextCode);
		if (course) out.push({ course, start, end, source: "canvas" });
	}
	return out;
}

export function occurrenceKey(o: ClassOccurrence): string {
	return `${o.course.toLowerCase()}@${o.start.toISOString()}`;
}

/**
 * Classes to remind about now: starting within the next `leadMinutes` (or started less than
 * 5 minutes ago), not yet shown. The same course at the same minute from both sources counts once.
 */
export function dueReminders(occurrences: ClassOccurrence[], now: Date, leadMinutes: number, shown: Set<string>): ClassOccurrence[] {
	const out: ClassOccurrence[] = [];
	const seen = new Set<string>();
	for (const o of [...occurrences].sort((a, b) => a.start.getTime() - b.start.getTime())) {
		const key = occurrenceKey(o);
		const minutesAway = (o.start.getTime() - now.getTime()) / 60_000;
		if (minutesAway > leadMinutes || minutesAway < -5) continue;
		if (shown.has(key) || seen.has(key)) continue;
		seen.add(key);
		out.push(o);
	}
	return out;
}

/** "starts in 2 min", "starts now", "started 3 min ago". */
export function startsIn(o: ClassOccurrence, now: Date): string {
	const min = Math.round((o.start.getTime() - now.getTime()) / 60_000);
	if (min > 0) return `starts in ${min} min`;
	if (min === 0) return "starts now";
	return `started ${-min} min ago`;
}
