// Interrupting a recording or a transcription at any point must not lose or duplicate audio or
// text: every sample ends up in exactly one chunk, every chunk is transcribed exactly once and in
// order, and what was written to the note before a crash is a prefix of the final transcript.

import { describe, expect, it } from "vitest";
import { Chunker } from "../src/core/audio/chunker";
import { TranscriptionPipeline, type TranscriptSegment } from "../src/core/audio/pipeline";
import { parseTranscript, renderTranscript } from "../src/core/transcript";

const RATE = 16000;

/** Deterministic pseudo-random numbers (mulberry32). */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Speech-like audio: bursts of tone separated by pauses of random length. */
function lecture(seconds: number, rand: () => number): Float32Array {
	const out = new Float32Array(Math.round(seconds * RATE));
	let i = 0;
	while (i < out.length) {
		const talk = Math.round((1 + rand() * 6) * RATE);
		for (let j = 0; j < talk && i < out.length; j++, i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE);
		i += Math.round(rand() * 1.5 * RATE);
	}
	return out;
}

describe("chunker: stopping at any point loses no audio", () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`seed ${seed}`, () => {
			const rand = rng(seed);
			const pcm = lecture(40 + rand() * 60, rand);
			const stopAt = Math.floor(rand() * pcm.length);
			const chunker = new Chunker({ maxChunkSec: 5 + Math.floor(rand() * 20), silenceCutMs: 300 + Math.floor(rand() * 1000) });
			const chunks = [];
			// Frames of varying size, as the audio thread delivers them.
			for (let i = 0; i < stopAt; ) {
				const n = Math.min(stopAt - i, 400 + Math.floor(rand() * 3000));
				chunks.push(...chunker.push(pcm.subarray(i, i + n)));
				i += n;
			}
			const last = chunker.flush();
			if (last) chunks.push(last);
			expect(chunker.flush()).toBeNull();
			const total = chunks.reduce((s, c) => s + c.pcm.length, 0);
			expect(total).toBe(stopAt);
			for (let k = 1; k < chunks.length; k++) expect(chunks[k]?.startSec).toBeCloseTo(chunks[k - 1]?.endSec ?? -1, 6);
			if (chunks.length) expect(chunks[chunks.length - 1]?.endSec).toBeCloseTo(stopAt / RATE, 6);
			// Every sample is the original one, in order.
			let offset = 0;
			for (const c of chunks) {
				expect(Array.from(c.pcm.subarray(0, 5))).toEqual(Array.from(pcm.subarray(offset, offset + Math.min(5, c.pcm.length))));
				offset += c.pcm.length;
			}
		});
	}
});

describe("pipeline: every chunk is transcribed once, in order, whatever the timing", () => {
	for (const seed of [11, 12, 13, 14, 15]) {
		it(`seed ${seed}`, async () => {
			const rand = rng(seed);
			let n = 0;
			let lastFailed = false;
			const pipeline = new TranscriptionPipeline(
				async () => {
					await new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
					// A transport error now and then (never twice in a row): the retry must not duplicate or drop the chunk.
					if (!lastFailed && rand() < 0.2) {
						lastFailed = true;
						throw new Error("connection reset");
					}
					lastFailed = false;
					const id = n++;
					return { text: "", segments: [{ start: 0, end: 1, text: `chunk-${id}` }] };
				},
				{},
				{ sampleRate: RATE, retries: 1 },
			);
			const expected: number[] = [];
			let t = 0;
			for (let k = 0; k < 25; k++) {
				const len = 1 + Math.floor(rand() * 5);
				pipeline.enqueue({ pcm: new Float32Array(len * RATE), startSec: t, endSec: t + len, silent: false });
				expected.push(t);
				t += len;
				// Stop/drain at arbitrary moments in between (like stop() racing with new frames).
				if (rand() < 0.3) await pipeline.drain();
			}
			await pipeline.drain();
			expect(pipeline.segments.map((s) => s.start)).toEqual(expected);
			expect(pipeline.progress.transcribedSec).toBe(t);
			expect(new Set(pipeline.segments.map((s) => s.text)).size).toBe(expected.length);
		});
	}
});

describe("partial writes are prefixes of the final transcript", () => {
	it("text written every minute is never taken back", () => {
		const rand = rng(99);
		const segments: TranscriptSegment[] = [];
		let at = 0;
		for (let i = 0; i < 120; i++) {
			const len = 1 + rand() * 6;
			const words = Array.from({ length: 3 + Math.floor(rand() * 12) }, (_, k) => `w${i}_${k}`).join(" ");
			segments.push({ start: at, end: at + len, text: rand() < 0.1 ? `${words}?` : `${words}.` });
			at += len + (rand() < 0.3 ? 3 : 0.2);
		}
		const full = parseTranscript(renderTranscript(segments, { markQuestions: true })).map((p) => p.text).join(" ");
		for (let cut = 1; cut < segments.length; cut += 7) {
			const partial = parseTranscript(renderTranscript(segments.slice(0, cut), { markQuestions: true })).map((p) => p.text).join(" ");
			expect(full.startsWith(partial)).toBe(true);
		}
	});
});
