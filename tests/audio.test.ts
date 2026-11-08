import { describe, expect, it } from "vitest";
import { Chunker } from "../src/core/audio/chunker";
import { isNoiseMarker, MIN_AUDIO_SEC, normalizeSegments, padToMinimum, TranscriptionPipeline, type TranscribeResult } from "../src/core/audio/pipeline";
import { concatFloat32, encodeWav, resample, rms } from "../src/core/audio/wav";

const RATE = 16000;

function tone(seconds: number, amplitude = 0.3): Float32Array {
	const out = new Float32Array(Math.round(seconds * RATE));
	for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
	return out;
}

function silence(seconds: number): Float32Array {
	return new Float32Array(Math.round(seconds * RATE));
}

/** Feeds audio in 100 ms frames like the worklet does. */
function feed(chunker: Chunker, pcm: Float32Array) {
	const out = [];
	const frame = RATE / 10;
	for (let i = 0; i < pcm.length; i += frame) out.push(...chunker.push(pcm.subarray(i, Math.min(pcm.length, i + frame))));
	return out;
}

describe("wav", () => {
	it("encodes a valid 16-bit mono header", () => {
		const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), RATE);
		const view = new DataView(buf);
		expect(buf.byteLength).toBe(44 + 10);
		expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe("RIFF");
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(RATE);
		expect(view.getUint16(34, true)).toBe(16);
		expect(view.getUint32(40, true)).toBe(10);
		expect(view.getInt16(44, true)).toBe(0);
		expect(view.getInt16(50, true)).toBe(0x7fff);
		expect(view.getInt16(52, true)).toBe(-0x8000);
	});

	it("resamples by ratio", () => {
		const out = resample(tone(1), 48000, 16000);
		expect(out.length).toBe(Math.round((1 * RATE) / 3));
		expect(resample(tone(0.1), RATE, RATE).length).toBe(1600);
	});

	it("rms and concat", () => {
		expect(rms(silence(0.1))).toBe(0);
		expect(rms(tone(0.1, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 1);
		expect(concatFloat32([new Float32Array([1]), new Float32Array([2, 3])])).toEqual(new Float32Array([1, 2, 3]));
	});
});

describe("Chunker", () => {
	it("cuts at a pause after the minimum length", () => {
		const chunker = new Chunker({ minChunkSec: 4, maxChunkSec: 20, silenceCutMs: 700 });
		const chunks = feed(chunker, concatFloat32([tone(5), silence(1), tone(2)]));
		expect(chunks.length).toBe(1);
		expect(chunks[0]?.startSec).toBe(0);
		expect(chunks[0]?.endSec).toBeCloseTo(5.7, 0);
		expect(chunks[0]?.silent).toBe(false);
		expect(chunker.bufferedSec).toBeCloseTo(2.3, 0);
		expect(chunker.recordedSec).toBeCloseTo(8, 5);
	});

	it("forces a cut at the maximum length and marks silent chunks", () => {
		const chunker = new Chunker({ minChunkSec: 4, maxChunkSec: 10, silenceCutMs: 700 });
		const chunks = feed(chunker, concatFloat32([tone(25), silence(12)]));
		// 25 s of tone → cuts at 10, 20; tone 20-25 + 0.7 s pause → cut; pure silence waits for the 10 s max
		expect(chunks.map((c) => [Math.round(c.startSec), Math.round(c.endSec), c.silent])).toEqual([
			[0, 10, false],
			[10, 20, false],
			[20, 26, false],
			[26, 36, true],
		]);
		const last = chunker.flush();
		expect(last?.silent).toBe(true);
		expect(chunker.flush()).toBeNull();
	});
});

describe("normalizeSegments", () => {
	const chunk = { pcm: new Float32Array(0), startSec: 100, endSec: 110, silent: false };

	it("offsets timestamps and drops noise markers", () => {
		const res: TranscribeResult = {
			text: "",
			segments: [
				{ start: 0, end: 2.5, text: " Hello there. " },
				{ start: 2.5, end: 4, text: "[BLANK_AUDIO]" },
				{ start: 4, end: 99, text: "(music)" },
				{ start: 4, end: 99, text: "Overrun." },
			],
		};
		expect(normalizeSegments(res, chunk)).toEqual([
			{ start: 100, end: 102.5, text: "Hello there." },
			{ start: 104, end: 110, text: "Overrun." },
		]);
	});

	it("falls back to plain text spanning the chunk", () => {
		expect(normalizeSegments({ text: " just text ", segments: [] }, chunk)).toEqual([{ start: 100, end: 110, text: "just text" }]);
		expect(normalizeSegments({ text: "   ", segments: [] }, chunk)).toEqual([]);
	});

	it("recognises noise markers", () => {
		expect(isNoiseMarker("[BLANK_AUDIO]")).toBe(true);
		expect(isNoiseMarker("♪")).toBe(true);
		expect(isNoiseMarker("...")).toBe(true);
		expect(isNoiseMarker("[inaudible] but then words")).toBe(false);
		expect(isNoiseMarker("Real sentence.")).toBe(false);
	});
});

describe("TranscriptionPipeline", () => {
	it("processes chunks in order with prompt carry-over and progress", async () => {
		const calls: { prompt?: string; bytes: number }[] = [];
		const progress: number[] = [];
		const pipeline = new TranscriptionPipeline(
			async (wav, { prompt }) => {
				calls.push({ prompt, bytes: wav.byteLength });
				await new Promise((r) => setTimeout(r, 5));
				return { text: `chunk ${calls.length} text.`, segments: [] };
			},
			{ onProgress: (p) => progress.push(p.transcribedSec) },
			{ promptChars: 12 },
		);
		pipeline.enqueue({ pcm: tone(1), startSec: 0, endSec: 1, silent: false });
		pipeline.enqueue({ pcm: tone(1), startSec: 1, endSec: 2, silent: true });
		pipeline.enqueue({ pcm: tone(1), startSec: 2, endSec: 3, silent: false });
		expect(pipeline.progress.queued).toBeGreaterThanOrEqual(1);
		await pipeline.drain();
		expect(calls.length).toBe(2); // silent chunk skipped
		expect(calls[0]?.prompt).toBeUndefined();
		expect(calls[0]?.bytes).toBe(44 + RATE * 2);
		expect(calls[1]?.prompt).toBe("hunk 1 text.");
		expect(pipeline.segments.map((s) => [s.start, s.end, s.text])).toEqual([
			[0, 1, "chunk 1 text."],
			[2, 3, "chunk 2 text."],
		]);
		expect(pipeline.progress).toEqual({ recordedSec: 3, transcribedSec: 3, queued: 0, busy: false });
		expect(progress[progress.length - 1]).toBe(3);
		expect(pipeline.lagSec).toBe(0);
	});

	it("retries once then reports the error and moves on", async () => {
		let attempts = 0;
		const errors: string[] = [];
		const pipeline = new TranscriptionPipeline(
			async () => {
				attempts++;
				throw new Error("boom");
			},
			{ onError: (e) => errors.push(e.message) },
			{ retries: 1 },
		);
		pipeline.enqueue({ pcm: tone(0.5), startSec: 0, endSec: 0.5, silent: false });
		await pipeline.drain();
		expect(attempts).toBe(2);
		expect(errors).toEqual(["boom"]);
		expect(pipeline.progress.transcribedSec).toBe(0.5);
	});

	it("pads a chunk shorter than whisper's one-second minimum with silence, and keeps its timeline", async () => {
		const bytes: number[] = [];
		const pipeline = new TranscriptionPipeline(async (wav) => {
			bytes.push(wav.byteLength);
			return { text: "bye.", segments: [{ start: 0, end: 0.4, text: "bye." }] };
		});
		pipeline.enqueue({ pcm: tone(0.4), startSec: 30, endSec: 30.4, silent: false });
		pipeline.enqueue({ pcm: tone(2), startSec: 30.4, endSec: 32.4, silent: false });
		await pipeline.drain();
		expect(bytes[0]).toBe(44 + Math.ceil(MIN_AUDIO_SEC * RATE) * 2);
		expect(bytes[1]).toBe(44 + 2 * RATE * 2);
		expect(pipeline.segments[0]).toMatchObject({ start: 30, end: 30.4, text: "bye." });
		expect(padToMinimum(tone(3), RATE)).toHaveLength(3 * RATE);
		const padded = padToMinimum(new Float32Array([0.5, 0.5]), 10, 1);
		expect(Array.from(padded)).toEqual([0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0]);
	});

	it("drain resolves immediately when idle and setRecorded raises lag", () => {
		const pipeline = new TranscriptionPipeline(async () => ({ text: "", segments: [] }));
		pipeline.setRecorded(12);
		expect(pipeline.lagSec).toBe(12);
		return expect(pipeline.drain()).resolves.toBeUndefined();
	});
});
