import { describe, expect, it, vi } from "vitest";
import { OllamaClient, OllamaError, type FallbackRequest } from "../src/core/ollama";
import { summarizeLecture } from "../src/core/summarize";

type Call = { url: string; method: string; body?: Record<string, unknown> };

function ndjsonResponse(lines: Record<string, unknown>[]): Response {
	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const l of lines) controller.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A fake Ollama: GET-only on /api/version and /api/tags (405 otherwise, like the real one), scripted /api/chat. */
function fakeOllama(chat: (body: Record<string, unknown>, nth: number) => Response, calls: Call[] = []) {
	let n = 0;
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ url, method, body });
		if (url.endsWith("/api/version")) return method === "GET" ? json(200, { version: "0.12.3" }) : new Response("", { status: 405 });
		if (url.endsWith("/api/tags")) return method === "GET" ? json(200, { models: [{ name: "qwen3.5:9b", size: 6_000_000_000 }] }) : new Response("", { status: 405 });
		if (url.endsWith("/api/chat")) return chat(body ?? {}, n++);
		return new Response("not found", { status: 404 });
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const unreachable = async (): Promise<Response> => {
	throw new TypeError("Failed to fetch");
};

describe("OllamaClient: version and tags", () => {
	it("uses GET for /api/version and /api/tags (POST is 405 on Ollama)", async () => {
		const { fetchImpl, calls } = fakeOllama(() => json(500, {}));
		const client = new OllamaClient(() => "http://localhost:11434/", fetchImpl);
		expect(await client.version()).toBe("0.12.3");
		expect(await client.listModels()).toEqual([{ name: "qwen3.5:9b", size: 6_000_000_000 }]);
		expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
			["GET", "http://localhost:11434/api/version", undefined],
			["GET", "http://localhost:11434/api/tags", undefined],
		]);
	});

	it("falls back to the injected request with GET when fetch cannot connect", async () => {
		const fallback = vi.fn<FallbackRequest>(async (url, method) => ({ status: 200, text: url.endsWith("version") ? '{"version":"0.12.3"}' : '{"models":[{"name":"m","size":1}]}' }));
		const client = new OllamaClient(() => "http://box:11434", unreachable as typeof fetch, fallback);
		expect(await client.version()).toBe("0.12.3");
		expect(await client.listModels()).toEqual([{ name: "m", size: 1 }]);
		expect(fallback.mock.calls).toEqual([
			["http://box:11434/api/version", "GET"],
			["http://box:11434/api/tags", "GET"],
		]);
	});

	it("says how to start Ollama when nothing answers and there is no fallback", async () => {
		const client = new OllamaClient(() => "http://localhost:11434", unreachable as typeof fetch);
		await expect(client.version()).rejects.toThrow(/Cannot reach Ollama at http:\/\/localhost:11434.*ollama serve/);
	});
});

describe("OllamaClient: chat", () => {
	it("streams deltas, sends think and options, resolves with the full text", async () => {
		const { fetchImpl, calls } = fakeOllama(() =>
			ndjsonResponse([
				{ message: { role: "assistant", content: "Hello" }, done: false },
				{ message: { role: "assistant", content: " world" }, done: false },
				{ message: { role: "assistant", content: "" }, done: true },
			]),
		);
		const client = new OllamaClient(() => "http://localhost:11434", fetchImpl);
		const deltas: string[] = [];
		const text = await client.chat({ model: "qwen3.5:9b", messages: [{ role: "user", content: "hi" }], think: false, options: { temperature: 0.2, num_ctx: 8192 }, keep_alive: "10m", onDelta: (d) => deltas.push(d) });
		expect(text).toBe("Hello world");
		expect(deltas).toEqual(["Hello", " world"]);
		expect(calls[0]?.body).toEqual({ model: "qwen3.5:9b", messages: [{ role: "user", content: "hi" }], stream: true, options: { temperature: 0.2, num_ctx: 8192 }, keep_alive: "10m", think: false });
	});

	it("leaves think out of the request when it is undefined", async () => {
		const { fetchImpl, calls } = fakeOllama(() => ndjsonResponse([{ message: { content: "ok" }, done: true }]));
		await new OllamaClient(() => "http://localhost:11434", fetchImpl).chat({ model: "m", messages: [] });
		expect(calls[0]?.body).not.toHaveProperty("think");
	});

	it("uses the non-streaming fallback when fetch fails, with stream:false and one delta", async () => {
		const fallback = vi.fn<FallbackRequest>(async () => ({ status: 200, text: JSON.stringify({ message: { role: "assistant", content: "### Key points\n- a" }, done: true }) }));
		const client = new OllamaClient(() => "http://localhost:11434", unreachable as typeof fetch, fallback);
		const deltas: string[] = [];
		const text = await client.chat({ model: "m", messages: [{ role: "user", content: "x" }], think: false, onDelta: (d) => deltas.push(d) });
		expect(text).toBe("### Key points\n- a");
		expect(deltas).toEqual([text]);
		const [url, method, body] = fallback.mock.calls[0] ?? [];
		expect([url, method]).toEqual(["http://localhost:11434/api/chat", "POST"]);
		expect(JSON.parse(body ?? "{}")).toMatchObject({ stream: false, think: false, model: "m" });
	});

	it("names the model and the pull command when Ollama answers 404", async () => {
		const { fetchImpl } = fakeOllama(() => json(404, { error: "model 'qwen3.5:9b' not found" }));
		const client = new OllamaClient(() => "http://localhost:11434", fetchImpl);
		const err = await client.chat({ model: "qwen3.5:9b", messages: [] }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(OllamaError);
		expect((err as OllamaError).status).toBe(404);
		expect((err as Error).message).toBe('Model "qwen3.5:9b" is not installed on Ollama at http://localhost:11434. Run: ollama pull qwen3.5:9b');
	});

	it("also adds the pull command on the fallback path", async () => {
		const fallback: FallbackRequest = async () => ({ status: 404, text: JSON.stringify({ error: "model 'llama3' not found" }) });
		const client = new OllamaClient(() => "http://localhost:11434", unreachable as typeof fetch, fallback);
		await expect(client.chat({ model: "llama3", messages: [] })).rejects.toThrow("Run: ollama pull llama3");
	});

	it("retries without think when the model does not support thinking", async () => {
		const { fetchImpl, calls } = fakeOllama((body, nth) => (nth === 0 && "think" in body ? json(400, { error: '"gemma3:4b" does not support thinking' }) : ndjsonResponse([{ message: { content: "fine" }, done: true }])));
		const client = new OllamaClient(() => "http://localhost:11434", fetchImpl);
		expect(await client.chat({ model: "gemma3:4b", messages: [], think: false })).toBe("fine");
		expect(calls.length).toBe(2);
		expect(calls[0]?.body).toHaveProperty("think", false);
		expect(calls[1]?.body).not.toHaveProperty("think");
	});

	it("surfaces other 400s and in-stream errors as OllamaError", async () => {
		const bad = fakeOllama(() => json(400, { error: "invalid options" }));
		await expect(new OllamaClient(() => "http://localhost:11434", bad.fetchImpl).chat({ model: "m", messages: [], think: false })).rejects.toThrow("invalid options");
		const mid = fakeOllama(() => ndjsonResponse([{ message: { content: "par" }, done: false }, { error: "out of memory" }]));
		await expect(new OllamaClient(() => "http://localhost:11434", mid.fetchImpl).chat({ model: "m", messages: [] })).rejects.toThrow("out of memory");
	});

	it("does not fall back when the request was aborted", async () => {
		const fallback = vi.fn<FallbackRequest>(async () => ({ status: 200, text: "{}" }));
		const controller = new AbortController();
		controller.abort();
		const aborting = async (): Promise<Response> => {
			throw new DOMException("Aborted", "AbortError");
		};
		const client = new OllamaClient(() => "http://localhost:11434", aborting as typeof fetch, fallback);
		await expect(client.chat({ model: "m", messages: [], signal: controller.signal })).rejects.toThrow("Aborted");
		expect(fallback).not.toHaveBeenCalled();
	});
});

describe("summarizeLecture", () => {
	it("passes the thinking choice, temperature and context to the client and strips leaked think tags", async () => {
		const chat = vi.fn(async (req: { think?: boolean; options?: Record<string, unknown>; keep_alive?: string }) => "<think>hmm</think>\n### Key points\n- a [0:00]");
		const client = { chat } as unknown as OllamaClient;
		const text = await summarizeLecture(client, { model: "qwen3.5:9b", numCtx: 32768, temperature: 0.2, think: false }, { course: "c", date: "d", transcript: "**[0:00]** a" });
		expect(text).toBe("### Key points\n- a [0:00]");
		expect(chat.mock.calls[0]?.[0]).toMatchObject({ think: false, options: { temperature: 0.2, num_ctx: 32768 }, keep_alive: "10m" });
		const auto = vi.fn(async () => "x");
		await summarizeLecture({ chat: auto } as unknown as OllamaClient, { model: "m", numCtx: 8192, temperature: 0.2 }, { course: "c", date: "d", transcript: "t" });
		expect(((auto.mock.calls[0] as unknown[] | undefined)?.[0] as { think?: boolean }).think).toBeUndefined();
	});
});
