import { describe, expect, it } from "vitest";
import { CanvasClient, CanvasError, nextLink, resolveCourse } from "../src/core/canvas";
import type { HttpRequest, HttpRequestOptions } from "../src/core/http";

function fakeCanvas() {
	const seen: HttpRequestOptions[] = [];
	const routes = new Map<string, { status?: number; body: unknown; headers?: Record<string, string> }>();
	const http: HttpRequest = async (opts) => {
		seen.push(opts);
		const key = opts.url.replace(/^https:\/\/school\.test/, "");
		const route = routes.get(key) ?? routes.get(opts.url);
		if (!route) return { status: 404, headers: {}, text: JSON.stringify({ errors: [{ message: "not found: " + key }] }), arrayBuffer: new ArrayBuffer(0) };
		const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
		return { status: route.status ?? 200, headers: route.headers ?? {}, text, arrayBuffer: route.body instanceof ArrayBuffer ? route.body : new ArrayBuffer(0) };
	};
	const client = new CanvasClient(() => "https://school.test/", () => "tok", http);
	return { client, routes, seen };
}

describe("CanvasClient", () => {
	it("sends the bearer token and strips the XSSI prefix", async () => {
		const { client, routes, seen } = fakeCanvas();
		routes.set("/api/v1/users/self", { body: 'while(1);{"id":7,"name":"Tony"}' });
		expect(await client.self()).toEqual({ id: 7, name: "Tony" });
		expect(seen[0]?.headers?.Authorization).toBe("Bearer tok");
	});

	it("follows Link pagination for courses and skips restricted ones", async () => {
		const { client, routes } = fakeCanvas();
		routes.set("/api/v1/courses?enrollment_state=active&include%5B%5D=term&per_page=50", {
			body: [{ id: 1, name: "CS101", course_code: "CS-101", term: { name: "Fall" } }, { id: 2, access_restricted_by_date: true }],
			headers: { Link: '<https://school.test/api/v1/courses?page=2>; rel="next", <https://school.test/api/v1/courses?page=1>; rel="first"' },
		});
		routes.set("/api/v1/courses?page=2", { body: [{ id: 3, name: "Math 2" }] });
		expect(await client.listCourses()).toEqual([
			{ id: 1, name: "CS101", courseCode: "CS-101", term: "Fall" },
			{ id: 3, name: "Math 2", courseCode: "", term: undefined },
		]);
	});

	it("merges Files and Module items, filters by date and type, newest first", async () => {
		const { client, routes } = fakeCanvas();
		const files = "/api/v1/courses/1/files?sort=updated_at&order=desc&per_page=50&content_types%5B%5D=application%2Fpdf&content_types%5B%5D=application%2Fvnd.openxmlformats-officedocument.presentationml.presentation&content_types%5B%5D=application%2Fvnd.ms-powerpoint";
		routes.set(files, {
			body: [
				{ id: 10, display_name: "Week 3.pdf", filename: "week3.pdf", "content-type": "application/pdf", size: 5, updated_at: "2026-11-05T15:00:00Z", created_at: "2026-11-01T00:00:00Z", url: "https://school.test/files/10/download?verifier=abc" },
				{ id: 11, display_name: "Old.pdf", filename: "old.pdf", "content-type": "application/pdf", size: 5, updated_at: "2026-10-01T15:00:00Z", created_at: "2026-10-01T00:00:00Z", url: "" },
			],
		});
		routes.set("/api/v1/courses/1/modules?include%5B%5D=items&per_page=50", {
			body: [{ name: "Module 4", items: [{ type: "File", content_id: 12 }, { type: "File", content_id: 10 }, { type: "Page", content_id: 99 }] }],
		});
		routes.set("/api/v1/courses/1/files/12", {
			body: { id: 12, display_name: "Deck.pptx", filename: "deck.pptx", "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 9, updated_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T09:00:00Z", url: "https://x/deck?verifier=1" },
		});
		const since = new Date("2026-11-05T00:00:00Z");
		const until = new Date("2026-11-06T00:00:00Z");
		const result = await client.listFiles(1, { since, until });
		expect(result.map((f) => [f.id, f.source, f.moduleName])).toEqual([
			[10, "files", "Module 4"],
			[12, "modules", "Module 4"],
		]);
	});

	it("downloads without the bearer header and reports lock/404", async () => {
		const { client, routes, seen } = fakeCanvas();
		const bytes = new Uint8Array([1, 2, 3]).buffer;
		routes.set("https://cdn.test/f?verifier=1", { body: bytes, headers: { "Content-Type": "application/pdf; charset=binary" } });
		const file = { id: 1, displayName: "a.pdf", filename: "a.pdf", contentType: "x", size: 3, updatedAt: "", createdAt: "", url: "https://cdn.test/f?verifier=1", locked: false, source: "files" as const };
		const dl = await client.download(file);
		expect(dl.contentType).toBe("application/pdf");
		expect(new Uint8Array(dl.bytes)).toEqual(new Uint8Array([1, 2, 3]));
		expect(seen[seen.length - 1]?.headers).toBeUndefined();
		await expect(client.download({ ...file, locked: true })).rejects.toThrow(/locked/);
		await expect(client.download({ ...file, url: "" })).rejects.toThrow(/no download URL/);
		await expect(client.getFile(999)).rejects.toThrow(CanvasError);
	});

	it("explains auth failures", async () => {
		const { client, routes } = fakeCanvas();
		routes.set("/api/v1/users/self", { status: 401, body: { errors: [{ message: "Invalid access token." }] } });
		await expect(client.self()).rejects.toThrow(/rejected the access token \(401\)\. Invalid access token\./);
		const unconfigured = new CanvasClient(() => "", () => "", async () => ({ status: 200, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) }));
		expect(unconfigured.configured).toBe(false);
		await expect(unconfigured.self()).rejects.toThrow(/Canvas URL is not set/);
	});
});

describe("helpers", () => {
	const courses = [
		{ id: 1, name: "Introduction to Computer Science", courseCode: "CS101" },
		{ id: 2, name: "Linear Algebra", courseCode: "MATH221" },
	];

	it("resolveCourse by id, code, substring and tokens", () => {
		expect(resolveCourse(courses, "2")?.name).toBe("Linear Algebra");
		expect(resolveCourse(courses, "cs101")?.id).toBe(1);
		expect(resolveCourse(courses, "algebra")?.id).toBe(2);
		expect(resolveCourse(courses, "computer science intro")?.id).toBe(1);
		expect(resolveCourse(courses, "chemistry")).toBeNull();
	});

	it("nextLink", () => {
		expect(nextLink('<https://a/b?page=2>; rel="next",<https://a/b?page=5>; rel="last"')).toBe("https://a/b?page=2");
		expect(nextLink('<https://a/b?page=1>; rel="first"')).toBeUndefined();
		expect(nextLink(undefined)).toBeUndefined();
	});
});
