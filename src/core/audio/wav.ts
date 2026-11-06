// Pure PCM helpers: WAV encoding, resampling and buffer joins. No DOM, no Node.

/** Encodes mono float samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
	const dataBytes = pcm.length * 2;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);
	let offset = 44;
	for (let i = 0; i < pcm.length; i++, offset += 2) {
		const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
		view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
	}
	return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Linear-interpolation resampler; good enough for speech going into Whisper. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || input.length === 0) return input;
	const ratio = fromRate / toRate;
	const outLength = Math.max(1, Math.round(input.length / ratio));
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = input[idx] ?? 0;
		const b = input[idx + 1] ?? a;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

export function concatFloat32(parts: Float32Array[]): Float32Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Float32Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** Averages N channels into one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
	const first = channels[0];
	if (channels.length === 1 && first) return first;
	const length = first?.length ?? 0;
	const out = new Float32Array(length);
	for (const ch of channels) {
		for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0) / channels.length;
	}
	return out;
}

export function rms(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		const s = samples[i] ?? 0;
		sum += s * s;
	}
	return Math.sqrt(sum / samples.length);
}
