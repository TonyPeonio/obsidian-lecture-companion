import { describe, expect, it } from "vitest";
import { classesFromCanvas, dueReminders, occurrenceKey, occurrencesOn, parseClock, parseWeeklySchedule, startsIn } from "../src/core/schedule";

describe("parseClock", () => {
	it("reads 24-hour and am/pm times", () => {
		expect(parseClock("10:00")).toBe(600);
		expect(parseClock("9:30am")).toBe(570);
		expect(parseClock("2pm")).toBe(840);
		expect(parseClock("12:15 pm")).toBe(735);
		expect(parseClock("12am")).toBe(0);
		expect(parseClock("25:00")).toBeNull();
		expect(parseClock("10")).toBeNull();
	});
});

describe("parseWeeklySchedule", () => {
	it("reads day names, compact days and ranges", () => {
		const { classes, errors } = parseWeeklySchedule(
			["# my classes", "Machine Learning = Mon Wed Fri 10:00-10:50", "Algorithms = TTh 2pm-3:15pm", "Lab = W 14:00", "Seminar = Tue/Thu 2-3:15pm", "Broken line", "X = Funday 10:00"].join("\n"),
		);
		expect(classes).toEqual([
			{ course: "Machine Learning", days: [1, 3, 5], start: 600, end: 650 },
			{ course: "Algorithms", days: [2, 4], start: 840, end: 915 },
			{ course: "Lab", days: [3], start: 840, end: 890 },
			{ course: "Seminar", days: [2, 4], start: 840, end: 915 },
		]);
		expect(errors).toEqual(["Broken line", "X = Funday 10:00"]);
	});

	it("handles MWF and R for Thursday", () => {
		expect(parseWeeklySchedule("A = MWF 9:00-9:50").classes[0]?.days).toEqual([1, 3, 5]);
		expect(parseWeeklySchedule("B = TR 9:00").classes[0]?.days).toEqual([2, 4]);
	});
});

describe("reminders", () => {
	const wednesday = new Date(2026, 10, 18, 9, 58); // Wed 18 Nov 2026, 09:58
	const { classes } = parseWeeklySchedule("Machine Learning = Mon Wed Fri 10:00-10:50\nAlgorithms = TTh 14:00-15:15");

	it("lists the day's classes", () => {
		const today = occurrencesOn(classes, wednesday);
		expect(today).toHaveLength(1);
		expect(today[0]?.course).toBe("Machine Learning");
		expect(today[0]?.start.getHours()).toBe(10);
	});

	it("is due a couple of minutes before, once", () => {
		const today = occurrencesOn(classes, wednesday);
		const shown = new Set<string>();
		const due = dueReminders(today, wednesday, 2, shown);
		expect(due.map((o) => o.course)).toEqual(["Machine Learning"]);
		expect(startsIn(due[0]!, wednesday)).toBe("starts in 2 min");
		for (const o of due) shown.add(occurrenceKey(o));
		expect(dueReminders(today, wednesday, 2, shown)).toEqual([]);
		// too early
		expect(dueReminders(today, new Date(2026, 10, 18, 9, 50), 2, new Set())).toEqual([]);
		// a few minutes late still asks; much later does not
		expect(dueReminders(today, new Date(2026, 10, 18, 10, 3), 2, new Set())).toHaveLength(1);
		expect(dueReminders(today, new Date(2026, 10, 18, 10, 20), 2, new Set())).toEqual([]);
	});

	it("counts the same class from schedule and Canvas once", () => {
		const fromCanvas = classesFromCanvas(
			[
				{ title: "ML lecture", startAt: new Date(2026, 10, 18, 10, 0).toISOString(), endAt: new Date(2026, 10, 18, 10, 50).toISOString(), contextCode: "course_7" },
				{ title: "Exam day", startAt: new Date(2026, 10, 18, 0, 0).toISOString(), allDay: true, contextCode: "course_7" },
				{ title: "Office hours marathon", startAt: new Date(2026, 10, 18, 9, 0).toISOString(), endAt: new Date(2026, 10, 18, 17, 0).toISOString(), contextCode: "course_7" },
				{ title: "Other course", startAt: new Date(2026, 10, 18, 10, 0).toISOString(), endAt: new Date(2026, 10, 18, 11, 0).toISOString(), contextCode: "course_99" },
			],
			(code) => (code === "course_7" ? "Machine Learning" : undefined),
		);
		expect(fromCanvas).toHaveLength(1);
		const due = dueReminders([...occurrencesOn(classes, wednesday), ...fromCanvas], wednesday, 2, new Set());
		expect(due).toHaveLength(1);
	});
});
