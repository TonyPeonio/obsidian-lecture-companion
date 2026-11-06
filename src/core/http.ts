// Transport abstraction so core modules never import `obsidian`. The plugin wires this to
// `requestUrl` (CORS-free, follows redirects); tests use an in-memory fake.

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	arrayBuffer: ArrayBuffer;
}

export interface HttpRequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}

export type HttpRequest = (opts: HttpRequestOptions) => Promise<HttpResponse>;

/** Case-insensitive header lookup. */
export function header(headers: Record<string, string>, name: string): string | undefined {
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === want) return v;
	}
	return undefined;
}

export interface MultipartFile {
	name: string;
	filename: string;
	type: string;
	data: ArrayBuffer;
}

/** Builds a multipart/form-data body by hand; `requestUrl` has no FormData support. */
export function buildMultipart(
	fields: Record<string, string>,
	file?: MultipartFile,
): { body: ArrayBuffer; contentType: string } {
	const boundary = `----LectureCompanion${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
	const enc = new TextEncoder();
	const parts: Uint8Array[] = [];
	for (const [name, value] of Object.entries(fields)) {
		parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
	}
	if (file) {
		parts.push(
			enc.encode(
				`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
			),
		);
		parts.push(new Uint8Array(file.data));
		parts.push(enc.encode("\r\n"));
	}
	parts.push(enc.encode(`--${boundary}--\r\n`));
	const total = parts.reduce((n, p) => n + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.byteLength;
	}
	return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
