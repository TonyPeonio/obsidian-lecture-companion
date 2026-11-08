// Where the audio comes from: the microphone, what the computer is playing (a Zoom, Teams or
// YouTube lecture), or both mixed. Pure helpers; the renderer-only capture lives in recorder.ts.

export type AudioSource = "microphone" | "system" | "both";

export const AUDIO_SOURCES: AudioSource[] = ["microphone", "system", "both"];

export const AUDIO_SOURCE_LABELS: Record<AudioSource, string> = {
	microphone: "Microphone",
	system: "This computer's audio (Zoom, Teams, YouTube)",
	both: "Both: microphone and this computer's audio",
};

export function parseAudioSource(value: unknown): AudioSource {
	return typeof value === "string" && (AUDIO_SOURCES as string[]).includes(value) ? (value as AudioSource) : "microphone";
}

export type DesktopPlatform = "windows" | "macos" | "linux" | "other";

/** A screen or window the desktop capturer offers; only `id` and `name` are used. */
export interface DesktopSource {
	id: string;
	name: string;
}

/** getUserMedia constraints for the microphone (system default when `deviceId` is empty). */
export function microphoneConstraints(deviceId: string): MediaStreamConstraints {
	return {
		audio: {
			deviceId: deviceId ? { exact: deviceId } : undefined,
			channelCount: 1,
			echoCancellation: false,
			noiseSuppression: true,
			autoGainControl: true,
		},
	};
}

/**
 * Chromium's desktop-capture constraints: the audio track is the computer's output ("what you
 * hear"), which Chromium only hands out together with a screen video track, so a 1×1 pixel,
 * one-frame-per-second video is requested and ignored.
 */
export function systemAudioConstraints(sourceId: string): MediaStreamConstraints {
	return {
		audio: { mandatory: { chromeMediaSource: "desktop" } },
		video: {
			mandatory: {
				chromeMediaSource: "desktop",
				chromeMediaSourceId: sourceId,
				maxWidth: 1,
				maxHeight: 1,
				maxFrameRate: 1,
			},
		},
	} as unknown as MediaStreamConstraints;
}

/** The whole-screen source (its audio is the whole system's), the first one when several screens. */
export function pickScreenSource(sources: DesktopSource[]): DesktopSource | undefined {
	return sources.find((s) => s.id.startsWith("screen:")) ?? sources.find((s) => /entire screen|^screen\b/i.test(s.name)) ?? sources[0];
}

/**
 * Why "this computer's audio" cannot be captured here, or undefined when it can be attempted.
 * macOS never exposes system audio to Chromium; Obsidian builds without the remote module have
 * no desktop capturer.
 */
export function systemAudioUnavailable(platform: DesktopPlatform, hasDesktopCapturer: boolean): string | undefined {
	if (platform === "macos") {
		return (
			"macOS does not let apps record what the computer plays. Install a free virtual audio device such as BlackHole, " +
			"set it as the output (or in a Multi-Output Device with your speakers), pick it under Microphone, and set the audio source back to Microphone."
		);
	}
	if (!hasDesktopCapturer) {
		return (
			"This Obsidian build does not expose the desktop capturer the plugin needs. On Windows, enable Stereo Mix in Sound settings " +
			"(or install VB-Cable) and pick it under Microphone; on Linux, pick the PulseAudio or PipeWire monitor device under Microphone."
		);
	}
	return undefined;
}

/** A sentence for the Notice when capture fails, naming the source that failed and the usual fix. */
export function explainCaptureError(err: unknown, source: AudioSource, platform: DesktopPlatform): string {
	const msg = err instanceof Error ? err.message : String(err);
	const name = err instanceof Error ? err.name : "";
	if (/NotAllowed|Permission denied|permission/i.test(name + " " + msg)) {
		if (source === "system") return `Screen and audio capture was refused: ${msg}. Windows: Settings → Privacy & security → let desktop apps access the screen; or pick a loopback device under Microphone.`;
		return `Microphone access was refused: ${msg}. Windows: Settings → Privacy & security → Microphone → allow desktop apps. macOS: System Settings → Privacy & Security → Microphone → Obsidian.`;
	}
	if (/NotFound|Requested device not found|OverconstrainedError/i.test(name + " " + msg)) {
		return `The selected microphone was not found: ${msg}. Settings → Recording → Microphone → System default.`;
	}
	if (source !== "microphone" && /no audio track/i.test(msg)) {
		return platform === "linux"
			? `${msg} On Linux, pick the PulseAudio or PipeWire monitor device under Microphone instead.`
			: `${msg} Make sure something is playing and that the output device is not exclusive-mode; or pick Stereo Mix under Microphone.`;
	}
	return `Could not start: ${msg}`;
}
