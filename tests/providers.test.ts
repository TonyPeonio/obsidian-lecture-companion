import { describe, expect, it } from "vitest";
import { MoodleClient, moodleFiles } from "../src/core/moodle";
import { openAiBase, OpenAiClient, sse } from "../src/core/openai";
import { isSlideFile, NoLms, parseLms } from "../src/core/lms";
import type { HttpRequest, HttpRequestOptions } from "../src/core/http";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(c) {
			for (const ch of chunks) c.enqueue(enc.encode(ch));
			c.close();
		},
	});
}

describe("OpenAI-compatible client", () => {
	it("normalizes the base URL", () => {
		expect(openAiBase("http://localhost:1234")).toBe("http://localhost:1234/v1");
		expect(openAiBase("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
	});

	it("streams chat completions over SSE and sends the key", async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			seen.push({ url, init });
			return new Response(stream(['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n', '\ndata: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n', "data: [DONE]\n\n"]), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new OpenAiClient(() => "http://box:1234", () => "k123", fetchImpl);
		const deltas: string[] = [];
		const text = await client.chat({ model: "qwen", messages: [{ role: "user", content: "hi" }], options: { temperature: 0.2, num_ctx: 8192 }, onDelta: (d) => deltas.push(d) });
		expect(text).toBe("Hello");
		expect(deltas).toEqual(["Hel", "lo"]);
		expect(seen[0]?.url).toBe("http://box:1234/v1/chat/completions");
		const body = JSON.parse(String(seen[0]?.init?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({ model: "qwen", stream: true, temperature: 0.2 });
		expect(body.num_ctx).toBeUndefined();
		expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer k123");
	});

	it("falls back to a non-streaming request when fetch fails", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("Failed to fetch");
		}) as unknown as typeof fetch;
		const calls: string[] = [];
		const client = new OpenAiClient(() => "http://box:1234", () => "", fetchImpl, async (url, method, body) => {
			calls.push(`${method} ${url} ${body ?? ""}`);
			return url.endsWith("/models") ? { status: 200, text: '{"data":[{"id":"m1"},{"id":"m2"}]}' } : { status: 200, text: '{"choices":[{"message":{"content":"whole answer"}}]}' };
		});
		expect(await client.listModels()).toEqual([{ name: "m1", size: 0 }, { name: "m2", size: 0 }]);
		expect(await client.chat({ model: "m1", messages: [] })).toBe("whole answer");
		expect(calls[1]).toContain('"stream":false');
	});

	it("reports server errors", async () => {
		const fetchImpl = (async () => new Response('{"error":{"message":"model not loaded"}}', { status: 400 })) as unknown as typeof fetch;
		await expect(new OpenAiClient(() => "http://x", () => "", fetchImpl).chat({ model: "m", messages: [] })).rejects.toThrow("model not loaded");
	});

	it("parses SSE data lines", async () => {
		const out: string[] = [];
		for await (const d of sse(stream(["event: x\ndata: a\n", "data: b"]))) out.push(d);
		expect(out).toEqual(["a", "b"]);
	});
});

const CONTENTS = [
	{
		name: "Week 1",
		modules: [
			{ id: 11, name: "Lecture 1 slides", modname: "resource", contents: [{ type: "file", filename: "L1 Intro.pdf", fileurl: "https://m.test/webservice/pluginfile.php/5/mod_resource/content/1/L1%20Intro.pdf?forcedownload=1", timemodified: 1_760_000_000, mimetype: "application/pdf", filesize: 1000 }] },
			{ id: 12, name: "Homework", modname: "assign" },
			{ id: 13, name: "Readings", modname: "folder", contents: [{ type: "file", filename: "notes.docx", fileurl: "u", timemodified: 1, mimetype: "application/msword" }, { type: "file", filename: "L2.pptx", fileurl: "https://m.test/f/L2.pptx", timemodified: 1_770_000_000, mimetype: "" }] },
			{ id: 14, name: "Link", modname: "url", contents: [{ type: "url", filename: "x", fileurl: "https://example.com" }] },
		],
	},
];

function fakeMoodle(routes: Record<string, unknown>) {
	const seen: HttpRequestOptions[] = [];
	const http: HttpRequest = async (opts) => {
		seen.push(opts);
		const fn = /wsfunction=([^&]+)/.exec(opts.url)?.[1] ?? "";
		const body = routes[fn] ?? routes[opts.url.split("?")[0] ?? ""];
		if (body === undefined) return { status: 404, headers: {}, text: "nope", arrayBuffer: new ArrayBuffer(0) };
		if (body instanceof ArrayBuffer) return { status: 200, headers: { "Content-Type": "application/pdf" }, text: "", arrayBuffer: body };
		return { status: 200, headers: {}, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0) };
	};
	return { client: new MoodleClient(() => "https://m.test/", () => "tok", http), seen };
}

describe("Moodle client", () => {
	it("lists courses of the token's user", async () => {
		const now = Date.now() / 1000;
		const { client, seen } = fakeMoodle({
			core_webservice_get_site_info: { userid: 3, fullname: "Tony P" },
			core_enrol_get_users_courses: [
				{ id: 5, fullname: "Machine Learning", shortname: "CS229", visible: 1, enddate: now + 1e6 },
				{ id: 6, fullname: "Old course", shortname: "OLD", visible: 1, enddate: now - 1e8 },
				{ id: 7, fullname: "Hidden", shortname: "H", visible: 0 },
			],
		});
		expect(await client.self()).toEqual({ id: 3, name: "Tony P" });
		expect(await client.listCourses()).toEqual([{ id: 5, name: "Machine Learning", courseCode: "CS229" }]);
		expect(seen[1]?.url).toBe("https://m.test/webservice/rest/server.php?wstoken=tok&wsfunction=core_enrol_get_users_courses&moodlewsrestformat=json&userid=3");
	});

	it("lists slide files from resources and folders, newest first, within the window", () => {
		const files = moodleFiles(CONTENTS);
		expect(files.map((f) => [f.id, f.displayName, f.moduleName, f.linkText])).toEqual([
			[13001, "L2.pptx", "Week 1", "Readings"],
			[11000, "L1 Intro.pdf", "Week 1", "Lecture 1 slides"],
		]);
		const windowed = moodleFiles(CONTENTS, { since: new Date(1_765_000_000_000), until: new Date(1_775_000_000_000) });
		expect(windowed.map((f) => f.displayName)).toEqual(["L2.pptx"]);
	});

	it("downloads with the token as a query parameter", async () => {
		const { client, seen } = fakeMoodle({ core_course_get_contents: CONTENTS, "https://m.test/webservice/pluginfile.php/5/mod_resource/content/1/L1%20Intro.pdf": new ArrayBuffer(4) });
		const files = await client.listFiles(5);
		const pdf = files.find((f) => f.displayName === "L1 Intro.pdf");
		const res = await client.download(pdf!);
		expect(res.bytes.byteLength).toBe(4);
		expect(seen[1]?.url).toBe("https://m.test/webservice/pluginfile.php/5/mod_resource/content/1/L1%20Intro.pdf?forcedownload=1&token=tok");
	});

	it("explains Moodle errors", async () => {
		const { client } = fakeMoodle({ core_webservice_get_site_info: { exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token - token not found" } });
		await expect(client.self()).rejects.toThrow(/Invalid token.*Security keys/);
		const unset = new MoodleClient(() => "", () => "", async () => ({ status: 200, headers: {}, text: "", arrayBuffer: new ArrayBuffer(0) }));
		expect(unset.configured).toBe(false);
	});
});

describe("lms helpers", () => {
	it("parses the setting and recognises slide files", async () => {
		expect(parseLms("moodle")).toBe("moodle");
		expect(parseLms("blackboard")).toBe("none");
		expect(isSlideFile("a.PDF", "")).toBe(true);
		expect(isSlideFile("a", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(true);
		expect(isSlideFile("a.docx", "application/msword")).toBe(false);
		const none = new NoLms();
		expect(none.configured).toBe(false);
		await expect(none.listCourses()).rejects.toThrow(/No course site/);
	});
});
