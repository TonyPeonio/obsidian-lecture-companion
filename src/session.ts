// One lecture: microphone → chunker → whisper pipeline → note, then an optional summary.
// Owned by the plugin so the sidebar view can close and reopen without losing the session.

import { Notice } from "obsidian";
import { Chunker } from "./core/audio/chunker";
import { TranscriptionPipeline, type PipelineProgress, type TranscriptSegment } from "./core/audio/pipeline";
import { safeFileName, SECTION_SLIDES, SECTION_SUMMARY, SECTION_TRANSCRIPT, toISODate, transcriptToMarkdown } from "./core/notes";
import { summarizeLecture } from "./core/summarize";
import { transcribeWav } from "./core/whisper/client";
import type LectureCompanionPlugin from "./main";
import { MicRecorder, TARGET_RATE } from "./recorder";
import type { NoteTarget } from "./vault";

export type SessionStatus = "idle" | "starting" | "recording" | "paused" | "finishing" | "matching" | "summarizing" | "done" | "error";

const EMPTY_PROGRESS: PipelineProgress = { recordedSec: 0, transcribedSec: 0, queued: 0, busy: false };

export class LectureSession {
	status: SessionStatus = "idle";
	course = "";
	date = "";
	target?: NoteTarget;
	level = 0;
	error?: string;
	summary = "";
	audioPath?: string;
	readonly segments: TranscriptSegment[] = [];

	/** Why the last recording stopped on its own, if it did. */
	autoStopReason?: string;

	private recorder = new MicRecorder();
	private chunker?: Chunker;
	private pipeline?: TranscriptionPipeline;
	private flushTimer?: number;
	private levelTimer?: number;
	private watchdogTimer?: number;
	private levelDirty = false;
	/** Transcript already in the note from an earlier recording of the same lecture. */
	private priorTranscript = "";
	private lastTick = 0;
	private lastSpeechAt = 0;
	private stopping = false;
	private summaryAbort?: AbortController;
	private listeners = new Set<() => void>();
	private segmentListeners = new Set<(segments: TranscriptSegment[]) => void>();
	private summaryListeners = new Set<(delta: string) => void>();

	constructor(private plugin: LectureCompanionPlugin) {}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	onSegments(fn: (segments: TranscriptSegment[]) => void): () => void {
		this.segmentListeners.add(fn);
		return () => this.segmentListeners.delete(fn);
	}

	onSummaryDelta(fn: (delta: string) => void): () => void {
		this.summaryListeners.add(fn);
		return () => this.summaryListeners.delete(fn);
	}

	get progress(): PipelineProgress {
		return this.pipeline?.progress ?? EMPTY_PROGRESS;
	}

	get lagSec(): number {
		return this.pipeline?.lagSec ?? 0;
	}

	get recordedSec(): number {
		return this.chunker?.recordedSec ?? 0;
	}

	get isLive(): boolean {
		return this.status === "recording" || this.status === "paused" || this.status === "starting" || this.status === "finishing" || this.status === "matching";
	}

	get isBusy(): boolean {
		return this.isLive || this.status === "summarizing";
	}

	/** Clears a finished or failed session so a new one can start. */
	reset(): void {
		if (this.isBusy) return;
		this.status = "idle";
		this.course = "";
		this.date = "";
		this.target = undefined;
		this.error = undefined;
		this.summary = "";
		this.audioPath = undefined;
		this.autoStopReason = undefined;
		this.priorTranscript = "";
		this.segments.length = 0;
		this.chunker = undefined;
		this.pipeline = undefined;
		this.emit();
	}

	async start(course: string, date = toISODate()): Promise<void> {
		if (this.isBusy) throw new Error("A session is already running");
		const name = course.trim();
		if (!name) throw new Error("Choose a course first");
		this.reset();
		this.course = name;
		this.date = date;
		this.status = "starting";
		this.error = undefined;
		this.emit();
		try {
			await this.plugin.startServer();
			await this.plugin.learnCourseAlias(name);
			this.target = await this.plugin.ensureLectureNote(name, date);
			// A second recording of the same lecture appends instead of wiping the first.
			this.priorTranscript = cleanTranscript((await this.plugin.vault.readSection(this.target, SECTION_TRANSCRIPT)) ?? "", true);
			const settings = this.plugin.settings;
			this.pipeline = new TranscriptionPipeline(
				async (wav, { prompt }) => {
					const baseUrl = await this.plugin.server.ensureRunning();
					const result = await transcribeWav(this.plugin.http, baseUrl, wav, {
						prompt,
						language: settings.language === "auto" ? undefined : settings.language,
					});
					this.plugin.server.touch();
					return result;
				},
				{
					onSegments: (segs) => {
						this.segments.push(...segs);
						for (const l of this.segmentListeners) l(segs);
					},
					onProgress: () => this.emit(),
					onError: (err) => {
						this.error = `A chunk could not be transcribed: ${err.message}`;
						this.emit();
					},
				},
				{ sampleRate: TARGET_RATE },
			);
			this.chunker = new Chunker({
				sampleRate: TARGET_RATE,
				maxChunkSec: Math.max(5, settings.chunkSeconds),
				silenceCutMs: Math.max(200, settings.silenceCutMs),
			});
			await this.recorder.start(settings.inputDeviceId, settings.keepAudio, {
				onFrame: (pcm) => {
					const chunker = this.chunker;
					const pipeline = this.pipeline;
					if (!chunker || !pipeline) return;
					for (const chunk of chunker.push(pcm)) pipeline.enqueue(chunk);
					pipeline.setRecorded(chunker.recordedSec);
				},
				onLevel: (level) => {
					this.level = level;
					this.levelDirty = true;
					if (level >= 0.01 && this.status === "recording") this.lastSpeechAt = Date.now();
				},
				onLost: (reason) => void this.autoStop(reason),
			});
			this.status = "recording";
			this.emit();
			this.levelTimer = window.setInterval(() => {
				if (this.levelDirty) {
					this.levelDirty = false;
					this.emit();
				}
			}, 100);
			this.flushTimer = window.setInterval(() => void this.flushPartial(), 60_000);
			this.lastTick = Date.now();
			this.lastSpeechAt = Date.now();
			this.watchdogTimer = window.setInterval(() => this.watchdog(), 5_000);
		} catch (err) {
			await this.recorder.stop().catch(() => null);
			this.clearTimers();
			this.status = "error";
			this.error = (err as Error).message;
			this.emit();
			throw err;
		}
	}

	pause(): void {
		if (this.status !== "recording") return;
		this.recorder.pause();
		this.status = "paused";
		this.emit();
	}

	resume(): void {
		if (this.status !== "paused") return;
		this.recorder.resume();
		this.status = "recording";
		this.emit();
	}

	/**
	 * Safety net for forgotten recordings: the laptop went to sleep (wall clock jumped), the
	 * recording hit the maximum length, or nobody has spoken for a long time.
	 */
	private watchdog(): void {
		const now = Date.now();
		const gap = now - this.lastTick;
		this.lastTick = now;
		if (this.status !== "recording" && this.status !== "paused") return;
		if (gap > 30_000) {
			void this.autoStop(`the computer was asleep for ${Math.round(gap / 60_000)} min`);
			return;
		}
		const s = this.plugin.settings;
		if (s.maxRecordingMinutes > 0 && this.recordedSec >= s.maxRecordingMinutes * 60) {
			void this.autoStop(`the ${s.maxRecordingMinutes}-minute maximum was reached`);
			return;
		}
		if (s.autoStopSilenceMinutes > 0 && this.status === "recording" && now - this.lastSpeechAt > s.autoStopSilenceMinutes * 60_000) {
			void this.autoStop(`no speech for ${s.autoStopSilenceMinutes} min`);
		}
	}

	private async autoStop(reason: string): Promise<void> {
		if (this.stopping || (this.status !== "recording" && this.status !== "paused")) return;
		this.autoStopReason = reason;
		new Notice(`Lecture Companion stopped recording: ${reason}. Writing the note…`, 10_000);
		try {
			const target = await this.stop();
			if (target) new Notice(`Lecture note written: ${target.path}`);
		} catch (err) {
			new Notice(`Auto-stop failed: ${(err as Error).message}`, 10_000);
		}
	}

	/** Stops recording, waits for the transcript to catch up, writes the note, optionally summarizes. */
	async stop(): Promise<NoteTarget | undefined> {
		if (this.status !== "recording" && this.status !== "paused") return this.target;
		this.stopping = true;
		this.status = "finishing";
		this.clearTimers();
		this.emit();
		try {
			const audio = await this.recorder.stop();
			const last = this.chunker?.flush();
			if (last && this.pipeline) this.pipeline.enqueue(last);
			await this.pipeline?.drain();
			if (audio && this.target) {
				const stamp = new Date().toTimeString().slice(0, 5).replace(":", "");
				const name = `${safeFileName(this.course)} ${this.date} ${stamp}.${audio.extension}`;
				const path = await this.plugin.vault.attachmentPath(name, this.target.path);
				await this.plugin.vault.createBinary(path, await audio.blob.arrayBuffer());
				this.audioPath = path;
			}
			await this.writeTranscript();
			this.level = 0;
			if (this.segments.length > 0 && this.target) {
				this.status = "matching";
				this.emit();
				try {
					await this.plugin.matchSlidesForSession(this.course, this.date, this.target, transcriptToMarkdown(this.segments));
				} catch (err) {
					new Notice(`Slide matching failed: ${(err as Error).message}`, 8000);
				}
			}
			if (this.plugin.settings.summarizeOnStop && this.segments.length > 0) {
				await this.summarize();
			}
			this.status = "done";
			this.emit();
		} catch (err) {
			this.status = "error";
			this.error = (err as Error).message;
			this.emit();
			throw err;
		} finally {
			this.stopping = false;
		}
		return this.target;
	}

	/** Summarizes the current session's transcript (or the target note's sections) into the Summary section. */
	async summarize(target: NoteTarget | undefined = this.target): Promise<string> {
		if (!target) throw new Error("No lecture note to summarize");
		// `stop()` calls this while "finishing"; only an active capture must be stopped first.
		if (this.status === "recording" || this.status === "paused" || this.status === "starting") throw new Error("Stop the recording first");
		this.status = "summarizing";
		this.summary = "";
		this.error = undefined;
		this.emit();
		this.summaryAbort = new AbortController();
		try {
			// Prefer the note (it holds earlier recordings too); fall back to the live segments.
			const fromNote = cleanTranscript((await this.plugin.vault.readSection(target, SECTION_TRANSCRIPT)) ?? "", false);
			const transcript = fromNote || (this.segments.length > 0 ? transcriptToMarkdown(this.segments) : "");
			const slideText = cleanTranscript((await this.plugin.vault.readSection(target, SECTION_SLIDES)) ?? "", false);
			if (!transcript.trim()) {
				throw new Error("The transcript is empty, so there is nothing to summarize. Record the lecture (or paste a transcript into the Transcript section) first.");
			}
			const settings = this.plugin.settings;
			const text = await summarizeLecture(
				this.plugin.ollama,
				{
					model: settings.ollamaModel,
					numCtx: settings.numCtx,
					temperature: 0.2,
					think: settings.thinking === "auto" ? undefined : settings.thinking === "on",
				},
				{
					course: this.course || target.path,
					date: this.date || toISODate(),
					transcript,
					slideText: slideText || undefined,
					extraInstructions: settings.summaryInstructions,
				},
				(delta) => {
					this.summary += delta;
					for (const l of this.summaryListeners) l(delta);
				},
				this.summaryAbort.signal,
			);
			this.summary = text;
			await this.plugin.vault.writeSection(target, SECTION_SUMMARY, text || "_The model returned an empty summary._", "replace");
			this.status = "done";
			this.emit();
			return text;
		} catch (err) {
			const aborted = err instanceof DOMException && err.name === "AbortError";
			this.status = aborted ? "done" : "error";
			if (!aborted) this.error = `Summary failed: ${(err as Error).message}`;
			this.emit();
			throw err;
		} finally {
			this.summaryAbort = undefined;
		}
	}

	cancelSummary(): void {
		this.summaryAbort?.abort();
	}

	/** Called by the plugin on unload. */
	async dispose(): Promise<void> {
		this.clearTimers();
		this.pipeline?.stop();
		this.cancelSummary();
		if (this.recorder.active) {
			await this.recorder.stop().catch(() => null);
			if (this.segments.length > 0) await this.writeTranscript().catch(() => undefined);
		}
	}

	private async flushPartial(): Promise<void> {
		if (this.segments.length === 0 || !this.target) return;
		await this.writeTranscript().catch(() => undefined);
	}

	private async writeTranscript(): Promise<void> {
		if (!this.target) return;
		const lines: string[] = [];
		if (this.priorTranscript) lines.push(this.priorTranscript, "");
		if (this.audioPath) lines.push(`![[${this.audioPath.split("/").pop() ?? this.audioPath}]]`, "");
		if (this.segments.length > 0) lines.push(transcriptToMarkdown(this.segments));
		else if (!this.priorTranscript) lines.push("_Nothing was transcribed._");
		await this.plugin.vault.writeSection(this.target, SECTION_TRANSCRIPT, lines.join("\n"), "replace");
	}

	private clearTimers(): void {
		if (this.flushTimer !== undefined) window.clearInterval(this.flushTimer);
		if (this.levelTimer !== undefined) window.clearInterval(this.levelTimer);
		if (this.watchdogTimer !== undefined) window.clearInterval(this.watchdogTimer);
		this.flushTimer = undefined;
		this.levelTimer = undefined;
		this.watchdogTimer = undefined;
	}

	private emit(): void {
		for (const l of this.listeners) l();
	}
}

/**
 * Strips placeholders (`_No transcript yet._`) and, for model input, audio embeds, so an empty
 * section reads as empty and a summary never sees "![[recording.webm]]" as the lecture.
 */
export function cleanTranscript(section: string, keepEmbeds: boolean): string {
	return section
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			if (/^_[^_]*_$/.test(t)) return false;
			if (!keepEmbeds && /^!\[\[[^\]]*\]\]$/.test(t)) return false;
			return true;
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
