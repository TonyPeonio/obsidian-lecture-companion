// End-to-end check against a real whisper-server: starts it through the same manager the
// plugin uses, streams a WAV fixture through the chunker and pipeline exactly like the mic
// path, and asserts on the transcript. Runs under Node (Windows or Linux).
//
//   WHISPER_SERVER=<path to whisper-server[.exe]> WHISPER_MODEL=<path to ggml-*.bin> npm run e2e
//
import { readFileSync } from "fs";
import * as http from "http";
import * as path from "path";
import { Chunker } from "../src/core/audio/chunker";
import { TranscriptionPipeline } from "../src/core/audio/pipeline";
import type { HttpRequest } from "../src/core/http";
import { transcriptToMarkdown } from "../src/core/notes";
import { transcribeWav } from "../src/core/whisper/client";
import { WhisperServerManager } from "../src/core/whisper/server";
import { nodeServerDeps, defaultThreads } from "../src/node/deps";

const binary = process.env.WHISPER_SERVER ?? "";
const model = process.env.WHISPER_MODEL ?? "";
const fixture = process.env.FIXTURE ?? path.join(__dirname, "..", "tests", "fixtures", "lecture.wav");

function fail(msg: string): never {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

function readWav(path: string): { pcm: Float32Array; rate: number } {
	const buf = readFileSync(path);
	if (buf.toString("ascii", 0, 4) !== "RIFF") fail("fixture is not a WAV file");
	const channels = buf.readUInt16LE(22);
	const rate = buf.readUInt32LE(24);
	const bits = buf.readUInt16LE(34);
	let offset = 12;
	while (offset < buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		if (id === "data") {
			const samples = size / (bits / 8) / channels;
			const pcm = new Float32Array(samples);
			for (let i = 0; i < samples; i++) pcm[i] = buf.readInt16LE(offset + 8 + i * channels * 2) / 0x8000;
			return { pcm, rate };
		}
		offset += 8 + size;
	}
	fail("WAV has no data chunk");
}

const nodeHttp: HttpRequest = (opts) =>
	new Promise((resolve, reject) => {
		const req = http.request(opts.url, { method: opts.method ?? "GET", headers: { ...(opts.headers ?? {}), ...(opts.contentType ? { "Content-Type": opts.contentType } : {}) } }, (res) => {
			const parts: Buffer[] = [];
			res.on("data", (d: Buffer) => parts.push(d));
			res.on("end", () => {
				const body = Buffer.concat(parts);
				const headers: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
				resolve({ status: res.statusCode ?? 0, headers, text: body.toString("utf8"), arrayBuffer: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer });
			});
		});
		req.on("error", reject);
		if (opts.body !== undefined) req.write(typeof opts.body === "string" ? opts.body : Buffer.from(opts.body));
		req.end();
	});

async function main(): Promise<void> {
	if (!binary || !model) fail("set WHISPER_SERVER and WHISPER_MODEL");
	const { pcm, rate } = readWav(fixture);
	if (rate !== 16000) fail(`fixture must be 16 kHz, got ${rate}`);
	console.log(`fixture: ${(pcm.length / rate).toFixed(1)} s of audio`);

	const manager = new WhisperServerManager(
		{ ...nodeServerDeps(), timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) } },
		() => ({ binary, modelPath: model, threads: defaultThreads(), language: "en", idleUnloadMs: 0, startupTimeoutMs: 180_000 }),
		(s) => console.log(`server: ${s.status}${s.message ? ` (${s.message})` : ""}${s.baseUrl ? ` ${s.baseUrl}` : ""}`),
	);
	const t0 = Date.now();
	const baseUrl = await manager.ensureRunning();
	console.log(`server ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

	const chunker = new Chunker({ maxChunkSec: 8 });
	let requests = 0;
	const pipeline = new TranscriptionPipeline(
		async (wav, { prompt }) => {
			requests++;
			const t = Date.now();
			const r = await transcribeWav(nodeHttp, baseUrl, wav, { prompt, language: "en" });
			console.log(`  chunk ${requests}: ${((wav.byteLength - 44) / 32000).toFixed(1)} s audio → ${((Date.now() - t) / 1000).toFixed(1)} s, ${r.segments.length} segments${prompt ? ` (prompt: …${prompt.slice(-30)})` : ""}`);
			return r;
		},
		{
			onSegments: (segs) => segs.forEach((s) => console.log(`  [${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`)),
			onError: (err) => fail(`chunk failed: ${err.message}`),
		},
	);
	const frame = 1600;
	for (let i = 0; i < pcm.length; i += frame) for (const c of chunker.push(pcm.subarray(i, Math.min(pcm.length, i + frame)))) pipeline.enqueue(c);
	const last = chunker.flush();
	if (last) pipeline.enqueue(last);
	await pipeline.drain();
	manager.stop();

	const text = pipeline.text().toLowerCase();
	console.log("\ntranscript:\n" + transcriptToMarkdown(pipeline.segments) + "\n");
	const expected = ["sorting", "merge sort", "quick sort", "friday"];
	const missing = expected.filter((w) => !text.includes(w));
	if (missing.length) fail(`transcript is missing: ${missing.join(", ")}`);
	if (requests < 2) fail(`expected the fixture to be split into several chunks, got ${requests}`);
	console.log(`PASS: ${requests} requests, ${pipeline.segments.length} segments, all expected phrases present`);
	process.exit(0);
}

main().catch((err: Error) => fail(err.message));
