// Chat client for OpenAI-compatible servers: LM Studio, llama.cpp's llama-server, Jan, vLLM,
// LocalAI… (`POST /v1/chat/completions` with server-sent events). Same shape as OllamaClient so
// the rest of the plugin does not care which one it talks to. Streaming uses the injected fetch;
// when fetch cannot reach the server (CORS), the non-streaming fallback (requestUrl) is used.

import type { ChatClient, ChatRequest, FallbackRequest, ModelInfo } from "./ollama";

export class OpenAiError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "OpenAiError";
	}
}

/** `http://host:1234`, `http://host:1234/` and `http://host:1234/v1` all mean `http://host:1234/v1`. */
export function openAiBase(url: string): string {
	const u = url.trim().replace(/\/+$/, "");
	return /\/v\d+$/.test(u) ? u : `${u}/v1`;
}

export class OpenAiClient implements ChatClient {
	constructor(
		private getBaseUrl: () => string,
		private getApiKey: () => string,
		private fetchImpl: typeof fetch,
		private fallback?: (url: string, method: "GET" | "POST", body?: string, headers?: Record<string, string>) => ReturnType<FallbackRequest>,
	) {}

	get baseUrl(): string {
		return openAiBase(this.getBaseUrl());
	}

	private headers(): Record<string, string> {
		const key = this.getApiKey().trim();
		return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
	}

	async version(): Promise<string> {
		await this.listModels();
		return "OpenAI-compatible";
	}

	async listModels(): Promise<ModelInfo[]> {
		const url = `${this.baseUrl}/models`;
		let status: number;
		let text: string;
		try {
			const res = await this.fetchImpl(url, { method: "GET", headers: this.headers() });
			status = res.status;
			text = await res.text();
		} catch (err) {
			if (!this.fallback) throw this.unreachable(err);
			({ status, text } = await this.fallback(url, "GET", undefined, this.headers()));
		}
		if (status >= 400) throw new OpenAiError(errorText(text, status), status);
		const json = parse(text);
		const data = Array.isArray(json.data) ? (json.data as Record<string, unknown>[]) : [];
		return data.map((m) => ({ name: typeof m.id === "string" ? m.id : "", size: 0 })).filter((m) => m.name);
	}

	async chat(req: ChatRequest): Promise<string> {
		const url = `${this.baseUrl}/chat/completions`;
		const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
		if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
		let response: Response;
		try {
			response = await this.fetchImpl(url, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal });
		} catch (err) {
			if (req.signal?.aborted) throw err;
			if (!this.fallback) throw this.unreachable(err);
			const r = await this.fallback(url, "POST", JSON.stringify({ ...body, stream: false }), this.headers());
			if (r.status >= 400) throw new OpenAiError(errorText(r.text, r.status), r.status);
			const content = messageContent(parse(r.text));
			if (content) req.onDelta?.(content);
			return content;
		}
		if (!response.ok) throw new OpenAiError(errorText(await response.text(), response.status), response.status);
		if (!response.body) throw new OpenAiError("The server returned an empty response body");
		let text = "";
		for await (const event of sse(response.body, req.signal)) {
			if (event === "[DONE]") break;
			const json = parse(event);
			if (json.error) throw new OpenAiError(errorText(JSON.stringify(json), 500));
			const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as Record<string, unknown> | undefined;
			const delta = (choice?.delta ?? {}) as Record<string, unknown>;
			if (typeof delta.content === "string" && delta.content) {
				text += delta.content;
				req.onDelta?.(delta.content);
			}
		}
		return text;
	}

	private unreachable(err: unknown): OpenAiError {
		return new OpenAiError(`Cannot reach the OpenAI-compatible server at ${this.baseUrl}. Is it running, with its local server started? (${(err as Error).message})`);
	}
}

function parse(text: string): Record<string, unknown> {
	try {
		const json = JSON.parse(text) as unknown;
		return json && typeof json === "object" ? (json as Record<string, unknown>) : {};
	} catch {
		throw new OpenAiError(`The server returned something that is not JSON: ${text.trim().slice(0, 120)}`);
	}
}

function messageContent(json: Record<string, unknown>): string {
	const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as Record<string, unknown> | undefined;
	const content = ((choice?.message ?? {}) as Record<string, unknown>).content;
	return typeof content === "string" ? content : "";
}

function errorText(text: string, status: number): string {
	try {
		const json = JSON.parse(text) as Record<string, unknown>;
		const err = json.error;
		if (typeof err === "string") return err;
		if (err && typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") return String((err as Record<string, unknown>).message);
	} catch {
		// not JSON
	}
	return text.trim() ? `${status}: ${text.trim().slice(0, 300)}` : `HTTP ${status}`;
}

/** The `data:` payloads of a server-sent-event stream. */
export async function* sse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
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
				const line = buffer.slice(0, idx).replace(/\r$/, "");
				buffer = buffer.slice(idx + 1);
				if (line.startsWith("data:")) yield line.slice(5).trim();
			}
		}
		const rest = buffer.trim();
		if (rest.startsWith("data:")) yield rest.slice(5).trim();
	} finally {
		reader.releaseLock();
	}
}
