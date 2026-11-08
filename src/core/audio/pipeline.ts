import type { AudioChunk } from "./chunker";
import { encodeWav } from "./wav";

/**
 * whisper.cpp refuses audio shorter than one second ("input is too short"), and the chunk flushed
 * when a recording stops can be a fraction of a second. Such a chunk is padded with trailing
 * silence to this length before it is sent.
 */
export const MIN_AUDIO_SEC = 1.2;

export function padToMinimum(pcm: Float32Array, sampleRate: number, minSec = MIN_AUDIO_SEC): Float32Array {
	const need = Math.ceil(minSec * sampleRate);
	if (pcm.length >= need) return pcm;
	const out = new Float32Array(need);
	out.set(pcm);
	return out;
}

export interface TranscriptSegment {
	/** Seconds from the start of the recording. */
	start: number;
	end: number;
	text: string;
}

export interface TranscribeResult {
	text: string;
	/** Timestamps relative to the audio that was sent. */
	segments: TranscriptSegment[];
}

export type TranscribeFn = (wav: ArrayBuffer, opts: { prompt?: string }) => Promise<TranscribeResult>;

export interface PipelineProgress {
	recordedSec: number;
	transcribedSec: number;
	/** Chunks waiting (not counting the one in flight). */
	queued: number;
	busy: boolean;
}

export interface PipelineCallbacks {
	onSegments?(segments: TranscriptSegment[]): void;
	onProgress?(progress: PipelineProgress): void;
	onError?(error: Error, chunk: AudioChunk): void;
}

export interface PipelineOptions {
	sampleRate: number;
	/** Tail of the accepted transcript passed as `prompt` so chunk boundaries stay coherent. */
	promptChars: number;
	/** Retries per chunk on transport errors. */
	retries: number;
}

const DEFAULT_OPTIONS: PipelineOptions = { sampleRate: 16000, promptChars: 200, retries: 1 };

/**
 * Feeds chunks to Whisper one at a time (whisper-server serialises inference anyway), stitches
 * timestamps back onto the recording's timeline, and reports progress as it goes. Pure: the
 * transcription call and all I/O are injected.
 */
export class TranscriptionPipeline {
	readonly segments: TranscriptSegment[] = [];
	private queue: AudioChunk[] = [];
	private busy = false;
	private recordedSec = 0;
	private transcribedSec = 0;
	private stopped = false;
	private idleWaiters: (() => void)[] = [];
	private readonly opts: PipelineOptions;

	constructor(
		private transcribe: TranscribeFn,
		private cb: PipelineCallbacks = {},
		opts: Partial<PipelineOptions> = {},
	) {
		this.opts = { ...DEFAULT_OPTIONS, ...opts };
	}

	get progress(): PipelineProgress {
		return {
			recordedSec: this.recordedSec,
			transcribedSec: this.transcribedSec,
			queued: this.queue.length,
			busy: this.busy,
		};
	}

	/** Seconds the transcript lags behind the recording. */
	get lagSec(): number {
		return Math.max(0, this.recordedSec - this.transcribedSec);
	}

	enqueue(chunk: AudioChunk): void {
		if (this.stopped) return;
		this.queue.push(chunk);
		this.recordedSec = Math.max(this.recordedSec, chunk.endSec);
		this.emitProgress();
		void this.pump();
	}

	/** Lets the UI show "recorded" ahead of the chunk boundary. */
	setRecorded(sec: number): void {
		if (sec > this.recordedSec) {
			this.recordedSec = sec;
			this.emitProgress();
		}
	}

	/** Plain text of everything transcribed so far. */
	text(): string {
		return this.segments
			.map((s) => s.text.trim())
			.filter((t) => t.length > 0)
			.join(" ");
	}

	/** Resolves once every queued chunk has been processed. */
	drain(): Promise<void> {
		if (!this.busy && this.queue.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	/** Drops queued chunks; the in-flight request finishes on its own. */
	stop(): void {
		this.stopped = true;
		this.queue = [];
		this.emitProgress();
	}

	private async pump(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			let next: AudioChunk | undefined;
			while ((next = this.queue.shift()) !== undefined) {
				await this.process(next);
			}
		} finally {
			this.busy = false;
			this.emitProgress();
			const waiters = this.idleWaiters.splice(0);
			for (const w of waiters) w();
		}
	}

	private async process(chunk: AudioChunk): Promise<void> {
		if (!chunk.silent) {
			const wav = encodeWav(padToMinimum(chunk.pcm, this.opts.sampleRate), this.opts.sampleRate);
			const tail = this.text().slice(-this.opts.promptChars);
			const prompt = tail.length > 0 ? tail : undefined;
			let attempt = 0;
			for (;;) {
				try {
					const result = await this.transcribe(wav, { prompt });
					const segs = normalizeSegments(result, chunk);
					if (segs.length > 0) {
						this.segments.push(...segs);
						this.cb.onSegments?.(segs);
					}
					break;
				} catch (err) {
					if (attempt++ >= this.opts.retries || this.stopped) {
						this.cb.onError?.(err instanceof Error ? err : new Error(String(err)), chunk);
						break;
					}
				}
			}
		}
		this.transcribedSec = Math.max(this.transcribedSec, chunk.endSec);
		this.emitProgress();
	}

	private emitProgress(): void {
		this.cb.onProgress?.(this.progress);
	}
}

/** Shifts chunk-relative timestamps onto the recording timeline and drops Whisper's noise markers. */
export function normalizeSegments(result: TranscribeResult, chunk: AudioChunk): TranscriptSegment[] {
	const duration = chunk.endSec - chunk.startSec;
	const raw =
		result.segments.length > 0
			? result.segments
			: result.text.trim().length > 0
				? [{ start: 0, end: duration, text: result.text }]
				: [];
	const out: TranscriptSegment[] = [];
	for (const s of raw) {
		const text = s.text.trim();
		if (!text || isNoiseMarker(text)) continue;
		const start = clamp(Number.isFinite(s.start) ? s.start : 0, 0, duration);
		const end = clamp(Number.isFinite(s.end) ? s.end : duration, start, duration);
		out.push({ start: chunk.startSec + start, end: chunk.startSec + end, text });
	}
	return out;
}

/** Whisper emits things like "[BLANK_AUDIO]", "(music)" or "♪" for non-speech; they are not transcript. */
export function isNoiseMarker(text: string): boolean {
	const t = text.trim();
	if (/^[[(][^\])]*[\])]$/.test(t)) return true;
	if (/^[\s.♪♫*-]*$/.test(t)) return true;
	return false;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}
