// Where course slide files come from. Canvas and Moodle are supported; "none" turns the whole
// course-files feature off (recording, transcription and summaries work without it).
//
// Not supported yet, on purpose: Brightspace (D2L) and Blackboard Learn only accept OAuth apps
// registered by the school's administrator (no personal access tokens), and Google Classroom needs
// a Google OAuth client. A plugin cannot ship those credentials, and a pasted short-lived OAuth
// token would stop working within the hour.

import type { CanvasCourse, CanvasFile, ListFilesOptions } from "./canvas";

export type LmsKind = "none" | "canvas" | "moodle";

export const LMS_LABELS: Record<LmsKind, string> = {
	none: "None (no course site)",
	canvas: "Canvas LMS",
	moodle: "Moodle",
};

export function parseLms(v: unknown): LmsKind {
	return v === "canvas" || v === "moodle" ? v : "none";
}

/** A course on the course site. Same shape for every LMS (named after Canvas, which came first). */
export type LmsCourse = CanvasCourse;
/** A file in a course. `url` is downloaded by the provider that listed it. */
export type LmsFile = CanvasFile;

export interface CalendarEvent {
	title: string;
	startAt: string;
	endAt?: string;
	allDay: boolean;
	contextCode: string;
}

export interface CourseFilesProvider {
	readonly kind: LmsKind;
	/** URL and token are set. */
	readonly configured: boolean;
	/** The signed-in user (the settings tab's Test button). */
	self(): Promise<{ id: number; name: string }>;
	listCourses(): Promise<LmsCourse[]>;
	listFiles(courseId: number, opts?: ListFilesOptions): Promise<LmsFile[]>;
	download(file: LmsFile): Promise<{ bytes: ArrayBuffer; contentType: string }>;
	/** Class meetings from the course calendar, where the LMS has an API for it. `contextCode` is `course_<id>`. */
	calendarEvents?(courseIds: number[], startDate: string, endDate: string): Promise<CalendarEvent[]>;
}

const NO_LMS = "No course site is set up. Choose Canvas or Moodle under Settings → Course files, or keep using the plugin without slides.";

/** The provider when no course site is set up: never configured, every call explains what to do. */
export class NoLms implements CourseFilesProvider {
	readonly kind = "none" as const;
	readonly configured = false;
	self(): Promise<{ id: number; name: string }> {
		return Promise.reject(new Error(NO_LMS));
	}
	listCourses(): Promise<LmsCourse[]> {
		return Promise.reject(new Error(NO_LMS));
	}
	listFiles(): Promise<LmsFile[]> {
		return Promise.reject(new Error(NO_LMS));
	}
	download(): Promise<{ bytes: ArrayBuffer; contentType: string }> {
		return Promise.reject(new Error(NO_LMS));
	}
}

const SLIDE_EXT = /\.(?:pdf|pptx|ppt)$/i;

/** True for PDF and PowerPoint files (by MIME type or extension). */
export function isSlideFile(name: string, contentType: string): boolean {
	return SLIDE_EXT.test(name) || /pdf|presentation|powerpoint/i.test(contentType);
}
