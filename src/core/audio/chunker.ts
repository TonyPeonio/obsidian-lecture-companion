import { concatFloat32, rms } from "./wav";

/** A slice of the recording ready to be transcribed. `silent` chunks are skipped but still count as progress. */
export interface AudioChunk {
	pcm: Float32Array;
	startSec: number;
	endSec: number;
	silent: boolean;
}

export interface ChunkerOptions {
	sampleRate: number;
	/** Never cut before this many seconds, even at a pause. */
	minChunkSec: number;
	/** Always cut at this length, even mid-sentence. */
	maxChunkSec: number;
	/** A pause at least this long (after minChunkSec) ends a chunk. */
	silenceCutMs: number;
	/** RMS below which a frame counts as silence. */
	silenceRms: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
	sampleRate: 16000,
	minChunkSec: 4,
	maxChunkSec: 20,
	silenceCutMs: 700,
	silenceRms: 0.01,
};

/**
 * Accumulates PCM frames and cuts them into chunks at natural pauses so each request to
 * Whisper ends on a sentence boundary when possible. Pure and synchronous.
 */
export class Chunker {
	private frames: Float32Array[] = [];
	private buffered = 0;
	private trailingSilence = 0;
	private peak = 0;
	private chunkStart = 0;
	private total = 0;
	readonly opts: ChunkerOptions;

	constructor(opts: Partial<ChunkerOptions> = {}) {
		this.opts = { ...DEFAULT_CHUNKER_OPTIONS, ...opts };
	}

	/** Seconds of audio pushed so far. */
	get recordedSec(): number {
		return this.total / this.opts.sampleRate;
	}

	/** Seconds currently buffered and not yet cut. */
	get bufferedSec(): number {
		return this.buffered / this.opts.sampleRate;
	}

	push(frame: Float32Array): AudioChunk[] {
		if (frame.length === 0) return [];
		this.frames.push(frame);
		this.buffered += frame.length;
		this.total += frame.length;
		const level = rms(frame);
		if (level < this.opts.silenceRms) this.trailingSilence += frame.length;
		else this.trailingSilence = 0;
		if (level > this.peak) this.peak = level;

		const bufferedSec = this.buffered / this.opts.sampleRate;
		const silenceMs = (this.trailingSilence / this.opts.sampleRate) * 1000;
		const hasSpeech = this.peak >= this.opts.silenceRms;
		// Cut at a pause only when the buffer holds speech; pure silence waits for the max length.
		if (bufferedSec >= this.opts.maxChunkSec || (hasSpeech && bufferedSec >= this.opts.minChunkSec && silenceMs >= this.opts.silenceCutMs)) {
			return [this.cut()];
		}
		return [];
	}

	/** Emits whatever is buffered (end of recording). */
	flush(): AudioChunk | null {
		if (this.buffered === 0) return null;
		return this.cut();
	}

	private cut(): AudioChunk {
		const pcm = concatFloat32(this.frames);
		const chunk: AudioChunk = {
			pcm,
			startSec: this.chunkStart / this.opts.sampleRate,
			endSec: (this.chunkStart + this.buffered) / this.opts.sampleRate,
			silent: this.peak < this.opts.silenceRms,
		};
		this.chunkStart += this.buffered;
		this.frames = [];
		this.buffered = 0;
		this.trailingSilence = 0;
		this.peak = 0;
		return chunk;
	}
}
