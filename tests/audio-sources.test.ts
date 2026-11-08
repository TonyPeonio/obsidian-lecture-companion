import { describe, expect, it } from "vitest";
import { AUDIO_SOURCE_LABELS, explainCaptureError, microphoneConstraints, parseAudioSource, pickScreenSource, systemAudioConstraints, systemAudioUnavailable } from "../src/core/audio/sources";

describe("audio sources", () => {
	it("parses the setting and falls back to the microphone", () => {
		expect(parseAudioSource("system")).toBe("system");
		expect(parseAudioSource("both")).toBe("both");
		expect(parseAudioSource("speakers")).toBe("microphone");
		expect(parseAudioSource(undefined)).toBe("microphone");
		expect(Object.keys(AUDIO_SOURCE_LABELS)).toEqual(["microphone", "system", "both"]);
	});

	it("builds microphone constraints with or without a device", () => {
		expect(microphoneConstraints("")).toEqual({ audio: { deviceId: undefined, channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
		expect((microphoneConstraints("abc").audio as MediaTrackConstraints).deviceId).toEqual({ exact: "abc" });
	});

	it("builds Chromium desktop-capture constraints with a throwaway 1x1 video track", () => {
		const c = systemAudioConstraints("screen:0:0") as unknown as { audio: { mandatory: Record<string, unknown> }; video: { mandatory: Record<string, unknown> } };
		expect(c.audio.mandatory).toEqual({ chromeMediaSource: "desktop" });
		expect(c.video.mandatory).toEqual({ chromeMediaSource: "desktop", chromeMediaSourceId: "screen:0:0", maxWidth: 1, maxHeight: 1, maxFrameRate: 1 });
	});

	it("prefers a whole-screen source", () => {
		expect(pickScreenSource([{ id: "window:12:0", name: "Zoom Meeting" }, { id: "screen:0:0", name: "Entire screen" }])?.id).toBe("screen:0:0");
		expect(pickScreenSource([{ id: "window:12:0", name: "Zoom Meeting" }])?.id).toBe("window:12:0");
		expect(pickScreenSource([])).toBeUndefined();
	});

	it("says why system audio is unavailable on macOS or without the desktop capturer", () => {
		expect(systemAudioUnavailable("macos", true)).toMatch(/BlackHole/);
		expect(systemAudioUnavailable("windows", false)).toMatch(/Stereo Mix/);
		expect(systemAudioUnavailable("linux", false)).toMatch(/monitor device/);
		expect(systemAudioUnavailable("windows", true)).toBeUndefined();
		expect(systemAudioUnavailable("linux", true)).toBeUndefined();
	});

	it("explains capture errors by source", () => {
		const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
		expect(explainCaptureError(denied, "microphone", "windows")).toMatch(/Microphone access was refused.*allow desktop apps/);
		expect(explainCaptureError(denied, "system", "windows")).toMatch(/Screen and audio capture was refused/);
		expect(explainCaptureError(Object.assign(new Error("Requested device not found"), { name: "NotFoundError" }), "microphone", "windows")).toMatch(/System default/);
		expect(explainCaptureError(new Error("The screen capture came back with no audio track."), "system", "windows")).toMatch(/Stereo Mix/);
		expect(explainCaptureError(new Error("The screen capture came back with no audio track."), "both", "linux")).toMatch(/monitor device/);
		expect(explainCaptureError(new Error("boom"), "microphone", "windows")).toBe("Could not start: boom");
	});
});
