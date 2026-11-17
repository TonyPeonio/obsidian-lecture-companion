// Clickable timestamps: `**[m:ss]**` transcript markers and `[mm:ss]` summary citations seek the
// note's recording to that time, in reading view (a markdown post-processor) and in live preview
// (a CodeMirror decoration). The note text is not changed.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, type MarkdownPostProcessorContext, Notice, TFile } from "obsidian";
import { findTimestamps } from "./core/transcript";
import type LectureCompanionPlugin from "./main";

const AUDIO_EXT = /^(?:webm|ogg|oga|opus|m4a|mp3|wav|flac|aac|mp4|3gp)$/i;

export class TimestampLinks {
	private player?: { wrap: HTMLElement; audio: HTMLAudioElement; label: HTMLElement };

	constructor(private plugin: LectureCompanionPlugin) {}

	register(): void {
		this.plugin.registerMarkdownPostProcessor((el, ctx) => this.process(el, ctx));
		this.plugin.registerEditorExtension(this.editorExtension());
		this.plugin.register(() => this.player?.wrap.remove());
	}

	/** The recording a note refers to: frontmatter `audio`, else the first embedded audio file. */
	audioFileOf(sourcePath: string): TFile | null {
		const { metadataCache } = this.plugin.app;
		const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) return null;
		const cache = metadataCache.getFileCache(file);
		const fm = cache?.frontmatter?.audio as unknown;
		const fromFm = typeof fm === "string" ? fm.replace(/^\[\[|\]\]$/g, "").split("|")[0]?.trim() : undefined;
		const candidates = [fromFm, ...(cache?.embeds ?? []).map((e) => e.link.split("#")[0])].filter((l): l is string => !!l);
		for (const link of candidates) {
			const dest = metadataCache.getFirstLinkpathDest(link, sourcePath);
			if (dest && AUDIO_EXT.test(dest.extension)) return dest;
		}
		return null;
	}

	private process(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		if (!/\[\d{1,3}:\d{2}/.test(el.textContent ?? "")) return;
		if (!this.audioFileOf(ctx.sourcePath)) return;
		const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) => (node.parentElement?.closest("code, pre, a, .lc-timestamp") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
		});
		const nodes: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
		for (const node of nodes) {
			const text = node.data;
			const matches = findTimestamps(text);
			if (matches.length === 0) continue;
			const frag = createFragment();
			let at = 0;
			for (const m of matches) {
				frag.append(text.slice(at, m.from));
				const span = createSpan({ cls: "lc-timestamp", text: text.slice(m.from, m.to), attr: { "aria-label": "Play the recording from here", role: "button" } });
				span.addEventListener("click", (e) => {
					e.preventDefault();
					e.stopPropagation();
					void this.seek(ctx.sourcePath, m.seconds, span);
				});
				frag.append(span);
				at = m.to;
			}
			frag.append(text.slice(at));
			node.replaceWith(frag);
		}
	}

	private editorExtension() {
		const hasAudio = (path: string): boolean => this.audioFileOf(path) !== null;
		const seek = (path: string, seconds: number, from: HTMLElement): Promise<void> => this.seek(path, seconds, from);
		const mark = (seconds: number) => Decoration.mark({ class: "lc-timestamp", attributes: { "data-lc-seconds": String(seconds), "aria-label": "Play the recording from here (Alt-click to edit)" } });
		const build = (view: EditorView): DecorationSet => {
			const builder = new RangeSetBuilder<Decoration>();
			const path = view.state.field(editorInfoField, false)?.file?.path;
			if (!path || !hasAudio(path)) return builder.finish();
			for (const { from, to } of view.visibleRanges) {
				const text = view.state.doc.sliceString(from, to);
				for (const m of findTimestamps(text)) builder.add(from + m.from, from + m.to, mark(m.seconds));
			}
			return builder.finish();
		};
		const plugin = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				constructor(view: EditorView) {
					this.decorations = build(view);
				}
				update(u: ViewUpdate): void {
					if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
				}
			},
			{ decorations: (v) => v.decorations },
		);
		const clicks = EditorView.domEventHandlers({
			mousedown(e, view) {
				if (e.altKey || e.button !== 0) return false;
				const target = (e.target as HTMLElement | null)?.closest<HTMLElement>(".lc-timestamp");
				const seconds = Number(target?.dataset.lcSeconds);
				const path = view.state.field(editorInfoField, false)?.file?.path;
				if (!target || !path || !Number.isFinite(seconds)) return false;
				e.preventDefault();
				void seek(path, seconds, target);
				return true;
			},
		});
		return [plugin, clicks];
	}

	/** Plays the note's recording from `seconds`: the embedded player in the same view when it is rendered, else a small floating player. */
	async seek(sourcePath: string, seconds: number, from: HTMLElement): Promise<void> {
		const file = this.audioFileOf(sourcePath);
		if (!file) {
			new Notice("This note has no recording to play.");
			return;
		}
		const src = this.plugin.app.vault.getResourcePath(file).split("?")[0] ?? "";
		const container = from.closest(".workspace-leaf-content") ?? from.closest(".markdown-preview-view, .markdown-source-view") ?? activeDocument.body;
		const embedded = Array.from(container.querySelectorAll("audio")).find((a) => (a.currentSrc || a.src).split("?")[0] === src);
		const audio = embedded ?? this.floatingPlayer(file, src);
		try {
			await seekTo(audio, seconds);
			await audio.play();
		} catch (err) {
			new Notice(`Could not play the recording: ${(err as Error).message}`, 6000);
		}
	}

	private floatingPlayer(file: TFile, src: string): HTMLAudioElement {
		if (!this.player) {
			const wrap = activeDocument.body.createDiv({ cls: "lc-player" });
			const label = wrap.createDiv({ cls: "lc-player-label" });
			const close = wrap.createEl("button", { cls: "lc-player-close clickable-icon", text: "×", attr: { "aria-label": "Close player" } });
			const audio = wrap.createEl("audio", { attr: { controls: "" } });
			close.addEventListener("click", () => {
				audio.pause();
				wrap.addClass("is-hidden");
			});
			this.player = { wrap, audio, label };
		}
		const p = this.player;
		p.wrap.removeClass("is-hidden");
		p.label.setText(file.name);
		if (p.audio.src.split("?")[0] !== src) p.audio.src = this.plugin.app.vault.getResourcePath(file);
		return p.audio;
	}
}

/**
 * Seeks once metadata is loaded. Recordings made by MediaRecorder (WebM) carry no duration, and
 * Chromium will not seek in them until it has scanned the file; jumping far past the end first
 * makes it compute the duration.
 */
async function seekTo(audio: HTMLAudioElement, seconds: number): Promise<void> {
	if (audio.readyState < 1) await once(audio, "loadedmetadata");
	if (!Number.isFinite(audio.duration)) {
		const settled = once(audio, "durationchange", 3000);
		audio.currentTime = 1e101;
		await settled;
	}
	audio.currentTime = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds));
}

function once(el: HTMLElement, event: string, timeoutMs = 10_000): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			window.clearTimeout(timer);
			el.removeEventListener(event, done);
			resolve();
		};
		const timer = window.setTimeout(done, timeoutMs);
		el.addEventListener(event, done);
	});
}
