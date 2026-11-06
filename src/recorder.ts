// Microphone capture in the renderer: an AudioWorklet delivers 16 kHz mono PCM frames for
// transcription while a MediaRecorder keeps a compact Opus copy of the lecture.

import { resample, rms } from "./core/audio/wav";

export const TARGET_RATE = 16000;

export interface RecorderCallbacks {
	onFrame(pcm: Float32Array): void;
	onLevel(level: number): void;
	/** The microphone went away (unplugged, device sleep, OS revoked access). */
	onLost?(reason: string): void;
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

export class MicRecorder {
	private stream?: MediaStream;
	private ctx?: AudioContext;
	private node?: AudioWorkletNode;
	private processor?: ScriptProcessorNode;
	private source?: MediaStreamAudioSourceNode;
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
		return this.stream !== undefined;
	}

	async start(deviceId: string, keepAudio: boolean, cb: RecorderCallbacks): Promise<void> {
		if (this.stream) throw new Error("Already recording");
		const constraints: MediaStreamConstraints = {
			audio: {
				deviceId: deviceId ? { exact: deviceId } : undefined,
				channelCount: 1,
				echoCancellation: false,
				noiseSuppression: true,
				autoGainControl: true,
			},
		};
		this.stream = await navigator.mediaDevices.getUserMedia(constraints);
		for (const track of this.stream.getAudioTracks()) {
			track.addEventListener("ended", () => cb.onLost?.("the microphone stopped (device removed or access revoked)"));
		}
		let ctx: AudioContext;
		try {
			ctx = new AudioContext({ sampleRate: TARGET_RATE });
		} catch {
			ctx = new AudioContext();
		}
		this.ctx = ctx;
		this.source = ctx.createMediaStreamSource(this.stream);
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
			this.node = new AudioWorkletNode(ctx, "lecture-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
			this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => deliver(ev.data);
			this.source.connect(this.node);
		} catch {
			// Blob-URL worklets can be blocked by a content security policy; fall back to the
			// deprecated-but-universal ScriptProcessorNode.
			const processor = ctx.createScriptProcessor(4096, 1, 1);
			processor.onaudioprocess = (e) => deliver(e.inputBuffer.getChannelData(0).slice());
			this.source.connect(processor);
			processor.connect(ctx.destination);
			this.processor = processor;
		}
		if (ctx.state === "suspended") await ctx.resume();

		if (keepAudio && typeof MediaRecorder !== "undefined") {
			const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m));
			this.mediaRecorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
			this.blobs = [];
			this.mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) this.blobs.push(e.data);
			};
			this.mediaRecorder.start(5000);
		}
	}

	pause(): void {
		if (!this.stream || this.paused) return;
		this.paused = true;
		if (this.mediaRecorder?.state === "recording") this.mediaRecorder.pause();
	}

	resume(): void {
		if (!this.stream || !this.paused) return;
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
		this.source?.disconnect();
		this.node = undefined;
		this.processor = undefined;
		this.source = undefined;
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = undefined;
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
