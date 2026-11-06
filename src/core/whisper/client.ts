import type { TranscribeResult, TranscriptSegment } from "../audio/pipeline";
import { buildMultipart, type HttpRequest } from "../http";

export class WhisperError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "WhisperError";
	}
}

export interface WhisperRequestOptions {
	prompt?: string;
	language?: string;
	temperature?: number;
}

/**
 * One request to whisper.cpp's `whisper-server` (`POST /inference`). The server accepts WAV
 * only unless built with ffmpeg, so callers always send 16 kHz mono PCM WAV.
 */
export async function transcribeWav(
	http: HttpRequest,
	baseUrl: string,
	wav: ArrayBuffer,
	opts: WhisperRequestOptions = {},
): Promise<TranscribeResult> {
	const fields: Record<string, string> = {
		temperature: String(opts.temperature ?? 0),
		temperature_inc: "0.2",
		response_format: "verbose_json",
	};
	if (opts.prompt) fields.prompt = opts.prompt;
	if (opts.language) fields.language = opts.language;
	const { body, contentType } = buildMultipart(fields, {
		name: "file",
		filename: "audio.wav",
		type: "audio/wav",
		data: wav,
	});
	let res;
	try {
		res = await http({ url: `${baseUrl.replace(/\/+$/, "")}/inference`, method: "POST", body, contentType });
	} catch (err) {
		throw new WhisperError(`Cannot reach whisper-server at ${baseUrl}: ${(err as Error).message}`);
	}
	if (res.status !== 200) {
		throw new WhisperError(`whisper-server returned HTTP ${res.status}: ${res.text.slice(0, 300)}`, res.status);
	}
	return parseWhisperResponse(res.text);
}

/** Parses `json` or `verbose_json` output. Tolerates missing segments (plain `json` format). */
export function parseWhisperResponse(text: string): TranscribeResult {
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new WhisperError(`whisper-server returned a non-JSON response: ${text.slice(0, 200)}`);
	}
	if (typeof json.error === "string" && json.error) throw new WhisperError(json.error);
	const segments: TranscriptSegment[] = [];
	if (Array.isArray(json.segments)) {
		for (const raw of json.segments as Record<string, unknown>[]) {
			const segText = typeof raw.text === "string" ? raw.text : "";
			if (!segText.trim()) continue;
			segments.push({ start: toNumber(raw.start), end: toNumber(raw.end), text: segText });
		}
	}
	const full = typeof json.text === "string" ? json.text : segments.map((s) => s.text).join("");
	return { text: full, segments };
}

function toNumber(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
		// whisper.cpp can emit "00:00:01,500" style timestamps in some formats.
		const m = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(v);
		if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
	}
	return 0;
}
