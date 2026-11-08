// Minimal Ollama chat client: streaming via fetch, with a non-streaming fallback through an
// injected request (the plugin passes Obsidian's `requestUrl`, which bypasses CORS but cannot stream).
//
// Ollama's rules worth remembering: `/api/version` and `/api/tags` are GET-only (POST answers 405);
// a model that is not pulled answers 404 `model 'x' not found`; `think` on a model without the
// thinking capability answers 400 `... does not support thinking`.

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ModelInfo {
	name: string;
	size: number;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	options?: { num_ctx?: number; temperature?: number };
	keep_alive?: string;
	/** Reasoning on/off for thinking models; leave undefined for the model's default. */
	think?: boolean;
	signal?: AbortSignal;
	onDelta?(content: string): void;
}

export class OllamaError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "OllamaError";
	}
}

/** Non-streaming transport used when `fetch` cannot reach Ollama (CORS, mixed content). */
export type FallbackRequest = (url: string, method: "GET" | "POST", body?: string) => Promise<{ status: number; text: string }>;
type FetchLike = typeof fetch;

export class OllamaClient {
	constructor(
		private getBaseUrl: () => string,
		private fetchImpl: FetchLike = (...args) => fetch(...args),
		private fallback?: FallbackRequest,
	) {}

	get baseUrl(): string {
		return this.getBaseUrl().trim().replace(/\/+$/, "");
	}

	async version(): Promise<string> {
		const res = await this.getJson("/api/version");
		return typeof res.version === "string" ? res.version : "unknown";
	}

	async listModels(): Promise<ModelInfo[]> {
		const res = await this.getJson("/api/tags");
		const models = Array.isArray(res.models) ? (res.models as Record<string, unknown>[]) : [];
		return models.map((m) => ({ name: String(m.name), size: Number(m.size ?? 0) }));
	}

	/** Streams the reply through `onDelta`; resolves with the full text. */
	async chat(req: ChatRequest): Promise<string> {
		const body: Record<string, unknown> = {
			model: req.model,
			messages: req.messages,
			stream: true,
			options: req.options ?? {},
		};
		if (req.keep_alive) body.keep_alive = req.keep_alive;
		if (req.think !== undefined) body.think = req.think;
		try {
			return await this.send(body, req);
		} catch (err) {
			// A model without the thinking capability rejects `think`; the answer is the same without it.
			if (err instanceof OllamaError && err.status === 400 && body.think !== undefined && /thinking/i.test(err.message)) {
				delete body.think;
				return await this.send(body, req);
			}
			throw this.describe(err, req.model);
		}
	}

	private async send(body: Record<string, unknown>, req: ChatRequest): Promise<string> {
		const url = `${this.baseUrl}/api/chat`;
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...body, stream: true }),
				signal: req.signal,
			});
		} catch (err) {
			if (req.signal?.aborted) throw err;
			if (!this.fallback) throw this.unreachable(err);
			const r = await this.fallback(url, "POST", JSON.stringify({ ...body, stream: false }));
			if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
			const json = parseJson(r.text);
			if (typeof json.error === "string") throw new OllamaError(json.error);
			const raw = ((json.message ?? {}) as Record<string, unknown>).content;
			const content = typeof raw === "string" ? raw : "";
			if (content) req.onDelta?.(content);
			return content;
		}
		if (!response.ok) throw new OllamaError(extractError(await response.text(), response.status), response.status);
		if (!response.body) throw new OllamaError("Ollama returned an empty response body");
		let text = "";
		for await (const chunk of ndjson(response.body, req.signal)) {
			if (chunk.error) throw new OllamaError(typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error));
			const m = (chunk.message ?? {}) as Record<string, unknown>;
			if (typeof m.content === "string" && m.content.length > 0) {
				text += m.content;
				req.onDelta?.(m.content);
			}
		}
		return text;
	}

	private async getJson(path: string): Promise<Record<string, unknown>> {
		const url = `${this.baseUrl}${path}`;
		try {
			const res = await this.fetchImpl(url, { method: "GET" });
			if (!res.ok) throw new OllamaError(extractError(await res.text(), res.status), res.status);
			return (await res.json()) as Record<string, unknown>;
		} catch (err) {
			if (err instanceof OllamaError) throw err;
			if (!this.fallback) throw this.unreachable(err);
			const r = await this.fallback(url, "GET");
			if (r.status >= 400) throw new OllamaError(extractError(r.text, r.status), r.status);
			return parseJson(r.text);
		}
	}

	private unreachable(err: unknown): OllamaError {
		return new OllamaError(`Cannot reach Ollama at ${this.baseUrl}. Is it running? Start it with \`ollama serve\`. (${(err as Error).message})`);
	}

	/** Adds the fixing command to the errors a user can act on. */
	private describe(err: unknown, model: string): unknown {
		if (!(err instanceof OllamaError)) return err;
		if (err.status === 404 || /\bnot found\b/i.test(err.message)) {
			return new OllamaError(`Model "${model}" is not installed on Ollama at ${this.baseUrl}. Run: ollama pull ${model}`, err.status ?? 404);
		}
		return err;
	}
}

function parseJson(text: string): Record<string, unknown> {
	try {
		const json = JSON.parse(text) as unknown;
		return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
	} catch {
		throw new OllamaError(`Ollama returned something that is not JSON: ${text.trim().slice(0, 120)}`);
	}
}

function extractError(text: string, status: number): string {
	try {
		const json = JSON.parse(text) as Record<string, unknown> | null;
		if (json && typeof json.error === "string") return json.error;
	} catch {
		// not JSON
	}
	return text.trim() ? `${status}: ${text.trim().slice(0, 300)}` : `Ollama returned HTTP ${status}`;
}

export async function* ndjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			if (signal?.aborted) {
				await reader.cancel();
				throw new DOMException("Aborted", "AbortError");
			}
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line) yield JSON.parse(line) as Record<string, unknown>;
			}
		}
		const rest = buffer.trim();
		if (rest) yield JSON.parse(rest) as Record<string, unknown>;
	} finally {
		reader.releaseLock();
	}
}
