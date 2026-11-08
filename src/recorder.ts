// Audio capture in the renderer: the microphone, the computer's own output (a Zoom, Teams or
// YouTube lecture) through Chromium's desktop capture, or both mixed. An AudioWorklet delivers
// 16 kHz mono PCM frames for transcription while a MediaRecorder keeps a compact Opus copy.

import { Platform } from "obsidian";
import { resample, rms } from "./core/audio/wav";
import { microphoneConstraints, pickScreenSource, systemAudioConstraints, systemAudioUnavailable, type AudioSource, type DesktopPlatform, type DesktopSource } from "./core/audio/sources";

export const TARGET_RATE = 16000;

export function desktopPlatform(): DesktopPlatform {
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	if (Platform.isLinux) return "linux";
	return "other";
}

export interface RecorderCallbacks {
	onFrame(pcm: Float32Array): void;
	onLevel(level: number): void;
	/** A source went away (microphone unplugged, OS revoked access, screen capture ended). */
	onLost?(reason: string): void;
}

export interface RecorderOptions {
	source: AudioSource;
	/** Microphone device id; "" = system default. Used by "microphone" and "both". */
	deviceId: string;
	keepAudio: boolean;
	platform: DesktopPlatform;
}

// Runs inside the AudioWorklet global scope; batches ~100 ms of samples per message.
const WORKLET_SOURCE = `
class LectureCapture extends AudioWorkletProcessor {
	constructor() { super(); this.buf = []; this.n = 0; }
	process(inputs) {
		const ch = inputs[0] && inputs[0][0];
		if (ch && ch.length) {
			this.buf.push(ch.slice());
			this.n += ch.length;
			if (this.n >= 1600) {
				const out = new Float32Array(this.n);
				let o = 0;
				for (const b of this.buf) { out.set(b, o); o += b.length; }
				this.port.postMessage(out, [out.buffer]);
				this.buf = []; this.n = 0;
			}
		}
		return true;
	}
}
registerProcessor("lecture-capture", LectureCapture);
`;

export interface AudioInput {
	id: string;
	label: string;
}

interface DesktopCapturer {
	getSources(options: { types: string[]; thumbnailSize?: { width: number; height: number }; fetchWindowIcons?: boolean }): Promise<DesktopSource[]>;
}

/** Electron's desktop capturer through Obsidian's remote module; undefined when not exposed. */
export function desktopCapturer(): DesktopCapturer | undefined {
	try {
		const req = (window as unknown as { require?: (name: string) => unknown }).require;
		const electron = req?.("electron") as { remote?: { desktopCapturer?: DesktopCapturer } } | undefined;
		const dc = electron?.remote?.desktopCapturer;
		return dc && typeof dc.getSources === "function" ? dc : undefined;
	} catch {
		return undefined;
	}
}

export class MicRecorder {
	private streams: MediaStream[] = [];
	private ctx?: AudioContext;
	private node?: AudioWorkletNode;
	private processor?: ScriptProcessorNode;
	private sources: MediaStreamAudioSourceNode[] = [];
	private mix?: GainNode;
	private recordDest?: MediaStreamAudioDestinationNode;
	private mediaRecorder?: MediaRecorder;
	private blobs: Blob[] = [];
	private workletUrl?: string;
	paused = false;

	static async listInputs(): Promise<AudioInput[]> {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices
			.filter((d) => d.kind === "audioinput")
			.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
	}

	get active(): boolean {
		return this.streams.length > 0;
	}

	async start(options: RecorderOptions, cb: RecorderCallbacks): Promise<void> {
		if (this.streams.length) throw new Error("Already recording");
		const wantMic = options.source !== "system";
		const wantSystem = options.source !== "microphone";
		try {
			if (wantSystem) {
				const system = await openSystemAudio(options.platform);
				this.streams.push(system);
				for (const track of system.getAudioTracks()) track.addEventListener("ended", () => cb.onLost?.("the computer's audio capture stopped (screen capture ended or access revoked)"));
			}
			if (wantMic) {
				const mic = await navigator.mediaDevices.getUserMedia(microphoneConstraints(options.deviceId));
				this.streams.push(mic);
				for (const track of mic.getAudioTracks()) track.addEventListener("ended", () => cb.onLost?.("the microphone stopped (device removed or access revoked)"));
			}
		} catch (err) {
			this.releaseStreams();
			throw err;
		}

		let ctx: AudioContext;
		try {
			ctx = new AudioContext({ sampleRate: TARGET_RATE });
		} catch {
			ctx = new AudioContext();
		}
		this.ctx = ctx;
		const mix = ctx.createGain();
		mix.gain.value = 1;
		this.mix = mix;
		for (const stream of this.streams) {
			const audioOnly = new MediaStream(stream.getAudioTracks());
			const source = ctx.createMediaStreamSource(audioOnly);
			source.connect(mix);
			this.sources.push(source);
		}
		const rate = ctx.sampleRate;
		const deliver = (frame: Float32Array): void => {
			if (this.paused) return;
			const pcm = rate === TARGET_RATE ? frame : resample(frame, rate, TARGET_RATE);
			cb.onLevel(rms(pcm));
			cb.onFrame(pcm);
		};
		try {
			this.workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
			await ctx.audioWorklet.addModule(this.workletUrl);
			this.node = new AudioWorkletNode(ctx, "lecture-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
			this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => deliver(ev.data);
			mix.connect(this.node);
		} catch {
			// Blob-URL worklets can be blocked by a content security policy; fall back to the
			// deprecated-but-universal ScriptProcessorNode.
			const processor = ctx.createScriptProcessor(4096, 1, 1);
			processor.onaudioprocess = (e) => deliver(e.inputBuffer.getChannelData(0).slice());
			mix.connect(processor);
			processor.connect(ctx.destination);
			this.processor = processor;
		}
		if (ctx.state === "suspended") await ctx.resume();

		if (options.keepAudio && typeof MediaRecorder !== "undefined") {
			// One source: record its audio track as is. Two: record the mix.
			let toRecord: MediaStream;
			const only = this.streams[0];
			if (this.streams.length === 1 && only) toRecord = new MediaStream(only.getAudioTracks());
			else {
				this.recordDest = ctx.createMediaStreamDestination();
				mix.connect(this.recordDest);
				toRecord = this.recordDest.stream;
			}
			const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m));
			this.mediaRecorder = new MediaRecorder(toRecord, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
			this.blobs = [];
			this.mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) this.blobs.push(e.data);
			};
			this.mediaRecorder.start(5000);
		}
	}

	pause(): void {
		if (!this.streams.length || this.paused) return;
		this.paused = true;
		if (this.mediaRecorder?.state === "recording") this.mediaRecorder.pause();
	}

	resume(): void {
		if (!this.streams.length || !this.paused) return;
		this.paused = false;
		if (this.mediaRecorder?.state === "paused") this.mediaRecorder.resume();
	}

	/** Stops capture; resolves with the Opus recording (null when not kept). */
	async stop(): Promise<{ blob: Blob; extension: string } | null> {
		const recorder = this.mediaRecorder;
		let result: { blob: Blob; extension: string } | null = null;
		if (recorder && recorder.state !== "inactive") {
			await new Promise<void>((resolve) => {
				recorder.onstop = () => resolve();
				recorder.stop();
			});
		}
		if (recorder && this.blobs.length > 0) {
			const type = recorder.mimeType || "audio/webm";
			result = { blob: new Blob(this.blobs, { type }), extension: type.includes("ogg") ? "ogg" : "webm" };
		}
		this.mediaRecorder = undefined;
		this.blobs = [];
		this.node?.port.close();
		this.node?.disconnect();
		this.processor?.disconnect();
		for (const s of this.sources) s.disconnect();
		this.mix?.disconnect();
		this.recordDest?.disconnect();
		this.node = undefined;
		this.processor = undefined;
		this.sources = [];
		this.mix = undefined;
		this.recordDest = undefined;
		this.releaseStreams();
		if (this.ctx) {
			await this.ctx.close().catch(() => undefined);
			this.ctx = undefined;
		}
		if (this.workletUrl) {
			URL.revokeObjectURL(this.workletUrl);
			this.workletUrl = undefined;
		}
		this.paused = false;
		return result;
	}

	private releaseStreams(): void {
		for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
		this.streams = [];
	}
}

/**
 * The computer's output as a MediaStream (plus a throwaway 1×1 video track Chromium insists on).
 * Throws with an explanation when the platform or the Obsidian build cannot provide it.
 */
async function openSystemAudio(platform: DesktopPlatform): Promise<MediaStream> {
	const dc = desktopCapturer();
	const why = systemAudioUnavailable(platform, dc !== undefined);
	if (why || !dc) throw new Error(why ?? "System audio capture is not available.");
	const sources = await dc.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
	const screen = pickScreenSource(sources);
	if (!screen) throw new Error("No screen was offered for capture, so the computer's audio cannot be recorded.");
	const stream = await navigator.mediaDevices.getUserMedia(systemAudioConstraints(screen.id));
	if (stream.getAudioTracks().length === 0) {
		for (const track of stream.getTracks()) track.stop();
		throw new Error("The screen capture came back with no audio track.");
	}
	return stream;
}

/** Decodes any audio file Chromium understands (mp3, m4a, webm, wav, ogg) into 16 kHz mono PCM. */
export async function decodeAudioFile(data: ArrayBuffer): Promise<Float32Array> {
	const ctx = new AudioContext();
	try {
		const buffer = await ctx.decodeAudioData(data.slice(0));
		const channels: Float32Array[] = [];
		for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
		let mono: Float32Array;
		const first = channels[0];
		if (channels.length === 1 && first) mono = first;
		else {
			mono = new Float32Array(buffer.length);
			for (const ch of channels) for (let i = 0; i < buffer.length; i++) mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0) / channels.length;
		}
		return resample(mono, buffer.sampleRate, TARGET_RATE);
	} finally {
		await ctx.close().catch(() => undefined);
	}
}
