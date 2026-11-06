// "Pull today's slides": deterministic Canvas → vault ingestion. No model involved.

import { loadPdfJs } from "obsidian";
import type { CanvasCourse } from "./core/canvas";
import { extractSlideText, slideKind } from "./core/extract";
import type { PdfJsLike } from "./core/extract/pdf";
import { addDays, safeFileName, SECTION_SLIDES, slidesToMarkdown, startOfDay, type SlideAttachment } from "./core/notes";
import type LectureCompanionPlugin from "./main";
import { vaultCourseName } from "./settings";

export interface PullResult {
	course: string;
	added: string[];
	skipped: number;
	errors: string[];
}

export interface PullOptions {
	/** YYYY-MM-DD; files changed on this local day are pulled. */
	date: string;
	/** Restrict to one course (Canvas id or name). */
	course?: CanvasCourse;
	onStatus?(message: string): void;
}

export async function pullSlides(plugin: LectureCompanionPlugin, opts: PullOptions): Promise<PullResult[]> {
	const canvas = plugin.canvas;
	if (!canvas.configured) throw new Error("Set the Canvas URL and access token in settings first.");
	const until = addDays(startOfDay(opts.date), 1);
	const since = addDays(until, -Math.max(1, plugin.settings.lookbackDays));
	const courses = opts.course ? [opts.course] : await plugin.refreshCourses();
	const results: PullResult[] = [];
	for (const course of courses) {
		opts.onStatus?.(`Checking ${course.name}…`);
		const result: PullResult = { course: course.name, added: [], skipped: 0, errors: [] };
		results.push(result);
		let files;
		try {
			files = await canvas.listFiles(course.id, { since, until });
		} catch (err) {
			result.errors.push((err as Error).message);
			continue;
		}
		if (files.length === 0) continue;
		const target = await plugin.ensureLectureNote(vaultCourseName(plugin.settings, course), opts.date);
		const existing = (await plugin.vault.readSection(target, SECTION_SLIDES)) ?? "";
		const attachments: SlideAttachment[] = [];
		for (const file of files) {
			const safeName = safeFileName(file.displayName || file.filename);
			if (existing.includes(`[[${safeName}`) || existing.includes(`[[${file.filename}`)) {
				result.skipped++;
				continue;
			}
			opts.onStatus?.(`Downloading ${file.displayName} (${course.name})…`);
			try {
				const { bytes, contentType } = await canvas.download(file);
				const vaultPath = await plugin.vault.attachmentPath(safeName, target.path);
				await plugin.vault.createBinary(vaultPath, bytes);
				let text: string | undefined;
				if (slideKind(file.displayName, contentType) !== "other") {
					try {
						text = (await extractSlideText(file.displayName, bytes, { loadPdfJs: () => loadPdfJs() as Promise<PdfJsLike> }, contentType)) ?? undefined;
					} catch (err) {
						result.errors.push(`${file.displayName}: text extraction failed (${(err as Error).message})`);
					}
				}
				attachments.push({
					vaultPath,
					title: file.displayName,
					text,
					source: file.moduleName ? `Canvas · ${file.moduleName}` : "Canvas · Files",
				});
				result.added.push(file.displayName);
			} catch (err) {
				result.errors.push(`${file.displayName}: ${(err as Error).message}`);
			}
		}
		if (attachments.length > 0) {
			await plugin.vault.writeSection(target, SECTION_SLIDES, slidesToMarkdown(attachments), "append");
		}
	}
	return results;
}

export function describePull(results: PullResult[]): string {
	const added = results.reduce((n, r) => n + r.added.length, 0);
	const errors = results.flatMap((r) => r.errors);
	const parts = [`${added} slide file${added === 1 ? "" : "s"} added`];
	const touched = results.filter((r) => r.added.length > 0).map((r) => r.course);
	if (touched.length) parts.push(`(${touched.join(", ")})`);
	if (errors.length) parts.push(`· ${errors.length} error${errors.length === 1 ? "" : "s"}: ${errors[0]}`);
	return parts.join(" ");
}
