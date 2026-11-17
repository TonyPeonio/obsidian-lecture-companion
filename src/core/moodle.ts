// Moodle course files through its web services (REST, JSON). The user creates a personal token
// under Preferences → Security keys (the "Moodle mobile web service" token works when the site
// allows the mobile app), or the site admin issues one. Uses only read-only functions:
// core_webservice_get_site_info, core_enrol_get_users_courses, core_course_get_contents.

import { header, type HttpRequest } from "./http";
import type { CanvasFile, ListFilesOptions } from "./canvas";
import { isSlideFile, type CourseFilesProvider, type LmsCourse, type LmsFile } from "./lms";

export class MoodleError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "MoodleError";
	}
}

type Json = Record<string, unknown>;

function str(v: unknown): string {
	return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

export class MoodleClient implements CourseFilesProvider {
	readonly kind = "moodle" as const;
	private userId?: number;

	constructor(
		private getBaseUrl: () => string,
		private getToken: () => string,
		private http: HttpRequest,
	) {}

	get baseUrl(): string {
		return this.getBaseUrl().trim().replace(/\/+$/, "");
	}

	get configured(): boolean {
		return this.baseUrl.length > 0 && this.getToken().trim().length > 0;
	}

	private async call(fn: string, params: Record<string, string | number> = {}): Promise<unknown> {
		if (!this.baseUrl) throw new MoodleError("Moodle URL is not set.");
		const token = this.getToken().trim();
		if (!token) throw new MoodleError("Moodle token is not set.");
		const qs = [`wstoken=${encodeURIComponent(token)}`, `wsfunction=${encodeURIComponent(fn)}`, "moodlewsrestformat=json", ...Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)];
		let res;
		try {
			res = await this.http({ url: `${this.baseUrl}/webservice/rest/server.php?${qs.join("&")}`, method: "GET" });
		} catch (err) {
			throw new MoodleError(`Cannot reach Moodle at ${this.baseUrl}: ${(err as Error).message}`);
		}
		if (res.status >= 400) throw new MoodleError(`Moodle returned HTTP ${res.status}`, res.status);
		let json: unknown;
		try {
			json = JSON.parse(res.text);
		} catch {
			throw new MoodleError(`Moodle returned something that is not JSON (is the URL the site's address, and are web services enabled?): ${res.text.slice(0, 120)}`);
		}
		if (json && typeof json === "object" && !Array.isArray(json) && typeof (json as Json).exception === "string") {
			const e = json as Json;
			const code = typeof e.errorcode === "string" ? e.errorcode : "";
			const hint = code === "invalidtoken" ? " Check the token (Preferences → Security keys)." : code === "accessexception" ? " The token's service does not allow this function; use the Moodle mobile web service token." : "";
			throw new MoodleError(`${typeof e.message === "string" ? e.message : code || "Moodle error"}.${hint}`);
		}
		return json;
	}

	async self(): Promise<{ id: number; name: string }> {
		const info = (await this.call("core_webservice_get_site_info")) as Json;
		this.userId = Number(info.userid);
		return { id: this.userId, name: typeof info.fullname === "string" ? info.fullname : str(info.username) };
	}

	async listCourses(): Promise<LmsCourse[]> {
		if (this.userId === undefined) await this.self();
		const rows = (await this.call("core_enrol_get_users_courses", { userid: this.userId ?? 0 })) as Json[];
		const now = Date.now() / 1000;
		return (Array.isArray(rows) ? rows : [])
			.filter((c) => c.visible !== 0 && !(Number(c.enddate) > 0 && Number(c.enddate) < now - 30 * 86400))
			.map((c) => ({ id: Number(c.id), name: str(c.fullname) || str(c.shortname) || str(c.id), courseCode: typeof c.shortname === "string" ? c.shortname : "" }));
	}

	/** PDF and PowerPoint files in the course's resources and folders, newest first. */
	async listFiles(courseId: number, opts: ListFilesOptions = {}): Promise<LmsFile[]> {
		const sections = (await this.call("core_course_get_contents", { courseid: courseId })) as Json[];
		return moodleFiles(Array.isArray(sections) ? sections : [], opts);
	}

	/** Moodle's file URLs need the token as a query parameter (it is never stored in the note). */
	async download(file: LmsFile): Promise<{ bytes: ArrayBuffer; contentType: string }> {
		const url = `${file.url}${file.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.getToken().trim())}`;
		const res = await this.http({ url, method: "GET" });
		if (res.status < 200 || res.status >= 300) throw new MoodleError(`Download of "${file.displayName}" failed with HTTP ${res.status}`, res.status);
		const ct = header(res.headers, "content-type") ?? file.contentType;
		if (/json/i.test(ct)) throw new MoodleError(`Moodle refused the download of "${file.displayName}" (${res.text.slice(0, 120)})`);
		return { bytes: res.arrayBuffer, contentType: ct.split(";")[0]?.trim() || file.contentType };
	}
}

/** Files from a `core_course_get_contents` answer: slide files only, filtered by change date, newest first. */
export function moodleFiles(sections: Json[], opts: ListFilesOptions = {}): CanvasFile[] {
	const out: CanvasFile[] = [];
	for (const section of sections) {
		const sectionName = typeof section.name === "string" ? section.name : "";
		const modules = Array.isArray(section.modules) ? (section.modules as Json[]) : [];
		for (const mod of modules) {
			const contents = Array.isArray(mod.contents) ? (mod.contents as Json[]) : [];
			contents.forEach((c, i) => {
				if (c.type !== "file") return;
				const filename = str(c.filename);
				const contentType = typeof c.mimetype === "string" ? c.mimetype : "";
				if (!isSlideFile(filename, contentType)) return;
				const modified = Number(c.timemodified ?? c.timecreated ?? 0) * 1000;
				if (opts.since && modified < opts.since.getTime()) return;
				if (opts.until && modified >= opts.until.getTime()) return;
				out.push({
					// One module can hold several files (a folder): module id × 1000 + index keeps ids unique and stable.
					id: Number(mod.id) * 1000 + i,
					displayName: filename,
					filename,
					contentType,
					size: Number(c.filesize ?? 0),
					updatedAt: new Date(modified).toISOString(),
					createdAt: new Date(Number(c.timecreated ?? c.timemodified ?? 0) * 1000).toISOString(),
					url: str(c.fileurl),
					locked: false,
					source: "modules",
					moduleName: sectionName || undefined,
					linkText: typeof mod.name === "string" ? mod.name : undefined,
				});
			});
		}
	}
	return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
