// Canvas LMS REST client (https://canvas.instructure.com/doc/api/). Only what the plugin needs:
// who am I, my courses, recent files (from the Files area and from Modules), and downloads.

import { header, type HttpRequest } from "./http";

export interface CanvasCourse {
	id: number;
	name: string;
	courseCode: string;
	term?: string;
}

export interface CanvasFile {
	id: number;
	displayName: string;
	filename: string;
	contentType: string;
	size: number;
	updatedAt: string;
	createdAt: string;
	/** Download URL; carries a `verifier` token so no auth header is needed (or allowed). */
	url: string;
	locked: boolean;
	/** Where it was found. Module items carry the module name for context. */
	source: "files" | "modules";
	moduleName?: string;
}

export class CanvasError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "CanvasError";
	}
}

export const SLIDE_CONTENT_TYPES = [
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.ms-powerpoint",
];

export interface ListFilesOptions {
	/** Inclusive lower bound on the file's last change. */
	since?: Date;
	/** Exclusive upper bound. */
	until?: Date;
	search?: string;
	contentTypes?: string[];
	includeModules?: boolean;
}

type Json = Record<string, unknown>;

export class CanvasClient {
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

	async self(): Promise<{ id: number; name: string }> {
		const me = await this.getOne("/api/v1/users/self");
		return { id: Number(me.id), name: str(me.name) || str(me.short_name) };
	}

	async listCourses(): Promise<CanvasCourse[]> {
		const rows = await this.getAll("/api/v1/courses", { enrollment_state: "active", "include[]": "term", per_page: "50" });
		return rows
			.filter((c) => typeof c.name === "string" && !c.access_restricted_by_date)
			.map((c) => ({
				id: Number(c.id),
				name: String(c.name),
				courseCode: typeof c.course_code === "string" ? c.course_code : "",
				term: typeof (c.term as Json | undefined)?.name === "string" ? String((c.term as Json).name) : undefined,
			}));
	}

	/** Files in the course's Files area, newest first, optionally merged with files attached to Modules. */
	async listFiles(courseId: number, opts: ListFilesOptions = {}): Promise<CanvasFile[]> {
		const params: Record<string, string | string[]> = { sort: "updated_at", order: "desc", per_page: "50" };
		const types = opts.contentTypes ?? SLIDE_CONTENT_TYPES;
		if (types.length) params["content_types[]"] = types;
		if (opts.search) params.search_term = opts.search;
		const byId = new Map<number, CanvasFile>();
		let filesError: CanvasError | undefined;
		try {
			for (const row of await this.getAll(`/api/v1/courses/${courseId}/files`, params)) {
				const f = toFile(row, "files");
				if (f) byId.set(f.id, f);
			}
		} catch (err) {
			// Many courses hide the Files tab from students (401/403). Files attached to Modules
			// are still reachable individually, so fall through to those.
			if (err instanceof CanvasError && (err.status === 401 || err.status === 403 || err.status === 404) && (opts.includeModules ?? true)) {
				filesError = err;
			} else {
				throw err;
			}
		}
		if (opts.includeModules ?? true) {
			let items: { fileId: number; moduleName: string; title: string }[];
			try {
				items = await this.listModuleFileItems(courseId);
			} catch (err) {
				if (filesError) throw new CanvasError(`Neither the Files area nor Modules are accessible for this course (${filesError.message}; ${(err as Error).message})`, filesError.status);
				throw err;
			}
			for (const item of items) {
				const existing = byId.get(item.fileId);
				if (existing) {
					existing.moduleName = existing.moduleName ?? item.moduleName;
					continue;
				}
				try {
					const row = await this.getOne(`/api/v1/courses/${courseId}/files/${item.fileId}`);
					const f = toFile(row, "modules");
					if (f && (types.length === 0 || types.includes(f.contentType))) {
						f.moduleName = item.moduleName;
						byId.set(f.id, f);
					}
				} catch (err) {
					if (!(err instanceof CanvasError) || (err.status !== 401 && err.status !== 403 && err.status !== 404)) throw err;
				}
			}
		}
		let files = [...byId.values()];
		if (opts.since || opts.until) {
			files = files.filter((f) => {
				const t = lastChange(f);
				if (opts.since && t < opts.since.getTime()) return false;
				if (opts.until && t >= opts.until.getTime()) return false;
				return true;
			});
		}
		return files.sort((a, b) => lastChange(b) - lastChange(a));
	}

	async listModuleFileItems(courseId: number): Promise<{ fileId: number; moduleName: string; title: string }[]> {
		const modules = await this.getAll(`/api/v1/courses/${courseId}/modules`, { "include[]": "items", per_page: "50" });
		const out: { fileId: number; moduleName: string; title: string }[] = [];
		for (const mod of modules) {
			const moduleName = typeof mod.name === "string" ? mod.name : "";
			let items = Array.isArray(mod.items) ? (mod.items as Json[]) : null;
			if (items === null && typeof mod.items_url === "string") {
				// Canvas omits `items` for large modules; fetch them explicitly.
				items = await this.getAll(mod.items_url, { per_page: "50" });
			}
			for (const item of items ?? []) {
				if (item.type === "File" && item.content_id !== undefined) {
					out.push({ fileId: Number(item.content_id), moduleName, title: typeof item.title === "string" ? item.title : "" });
				}
			}
		}
		return out;
	}

	async getFile(fileId: number): Promise<CanvasFile> {
		const f = toFile(await this.getOne(`/api/v1/files/${fileId}`), "files");
		if (!f) throw new CanvasError(`File ${fileId} has an unexpected shape`);
		return f;
	}

	/**
	 * Downloads a file. Canvas's `url` carries a `verifier` query token and redirects to signed
	 * storage, which rejects requests that also carry a bearer header, so none is sent.
	 */
	async download(file: CanvasFile): Promise<{ bytes: ArrayBuffer; contentType: string }> {
		if (!file.url) throw new CanvasError(`"${file.displayName}" has no download URL (it may be locked).`);
		if (file.locked) throw new CanvasError(`"${file.displayName}" is locked for students.`);
		const res = await this.http({ url: file.url, method: "GET" });
		if (res.status < 200 || res.status >= 300) {
			throw new CanvasError(`Download of "${file.displayName}" failed with HTTP ${res.status}`, res.status);
		}
		const ct = header(res.headers, "content-type") ?? file.contentType;
		return { bytes: res.arrayBuffer, contentType: ct.split(";")[0]?.trim() ?? file.contentType };
	}

	private async getOne(path: string, params: Record<string, string | string[]> = {}): Promise<Json> {
		const res = await this.request(this.url(path, params));
		return parseJson(res.text, res.status) as Json;
	}

	/** Follows `Link: rel="next"` pagination (capped to stay polite). */
	private async getAll(path: string, params: Record<string, string | string[]> = {}, maxPages = 20): Promise<Json[]> {
		let url: string | undefined = this.url(path, params);
		const out: Json[] = [];
		for (let page = 0; url && page < maxPages; page++) {
			const res = await this.request(url);
			const body = parseJson(res.text, res.status);
			if (!Array.isArray(body)) throw new CanvasError(`Expected a list from ${path}`);
			out.push(...(body as Json[]));
			url = nextLink(header(res.headers, "link"));
		}
		return out;
	}

	private async request(url: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
		const token = this.getToken().trim();
		if (!this.baseUrl) throw new CanvasError("Canvas URL is not set.");
		if (!token) throw new CanvasError("Canvas access token is not set.");
		let res;
		try {
			res = await this.http({ url, method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
		} catch (err) {
			throw new CanvasError(`Cannot reach Canvas at ${this.baseUrl}: ${(err as Error).message}`);
		}
		if (res.status >= 400) throw new CanvasError(describeError(res.status, res.text), res.status);
		return res;
	}

	private url(pathOrUrl: string, params: Record<string, string | string[]>): string {
		const base = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
		const qs: string[] = [];
		for (const [k, v] of Object.entries(params)) {
			for (const value of Array.isArray(v) ? v : [v]) qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
		}
		if (qs.length === 0) return base;
		return base + (base.includes("?") ? "&" : "?") + qs.join("&");
	}
}

/** Fuzzy course lookup: numeric id, exact name/code, then substring or token overlap. */
export function resolveCourse(courses: CanvasCourse[], query: string): CanvasCourse | null {
	const q = query.trim().toLowerCase();
	if (!q) return null;
	if (/^\d+$/.test(q)) return courses.find((c) => String(c.id) === q) ?? null;
	const exact = courses.find((c) => c.name.toLowerCase() === q || c.courseCode.toLowerCase() === q);
	if (exact) return exact;
	const sub = courses.filter((c) => c.name.toLowerCase().includes(q) || c.courseCode.toLowerCase().includes(q));
	if (sub.length === 1) return sub[0] ?? null;
	const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);
	let best: { course: CanvasCourse; score: number } | null = null;
	for (const c of courses) {
		const hay = `${c.name} ${c.courseCode}`.toLowerCase();
		const score = tokens.filter((t) => hay.includes(t)).length;
		if (score > 0 && (!best || score > best.score)) best = { course: c, score };
	}
	return best?.course ?? sub[0] ?? null;
}

export function nextLink(linkHeader: string | undefined): string | undefined {
	if (!linkHeader) return undefined;
	for (const part of linkHeader.split(",")) {
		const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
		if (m) return m[1];
	}
	return undefined;
}

function toFile(row: Json, source: CanvasFile["source"]): CanvasFile | null {
	if (row.id === undefined) return null;
	const id = Number(row.id);
	return {
		id,
		displayName: str(row.display_name) || str(row.filename) || String(id),
		filename: str(row.filename) || str(row.display_name) || String(id),
		contentType: str(row["content-type"]) || str(row.content_type),
		size: Number(row.size ?? 0),
		updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
		createdAt: typeof row.created_at === "string" ? row.created_at : "",
		url: typeof row.url === "string" ? row.url : "",
		locked: row.locked_for_user === true,
		source,
	};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function lastChange(f: CanvasFile): number {
	const u = Date.parse(f.updatedAt);
	const c = Date.parse(f.createdAt);
	return Math.max(Number.isFinite(u) ? u : 0, Number.isFinite(c) ? c : 0);
}

function parseJson(text: string, status: number): unknown {
	try {
		return JSON.parse(text.replace(/^while\(1\);/, ""));
	} catch {
		throw new CanvasError(`Canvas returned a non-JSON response (HTTP ${status}): ${text.slice(0, 200)}`, status);
	}
}

function describeError(status: number, text: string): string {
	let detail = "";
	try {
		const json = JSON.parse(text.replace(/^while\(1\);/, "")) as Json;
		const errors = json.errors;
		if (Array.isArray(errors) && typeof (errors[0] as Json | undefined)?.message === "string") detail = String((errors[0] as Json).message);
		else if (typeof json.message === "string") detail = json.message;
	} catch {
		detail = text.slice(0, 200);
	}
	if (status === 401) return `Canvas rejected the access token (401). ${detail}`.trim();
	if (status === 403) return `Canvas refused the request (403): ${detail || "no permission"}`;
	if (status === 404) return `Canvas: not found (404). Check the Canvas URL and that you are enrolled. ${detail}`.trim();
	return `Canvas returned HTTP ${status}: ${detail}`;
}
