import { extractPdfText, type PdfJsLike } from "./pdf";
import { extractPptxText } from "./pptx";

export interface ExtractDeps {
	loadPdfJs(): Promise<PdfJsLike>;
}

export type SlideKind = "pdf" | "pptx" | "other";

export function slideKind(filename: string, contentType = ""): SlideKind {
	const ext = filename.toLowerCase().split(".").pop() ?? "";
	if (ext === "pdf" || contentType === "application/pdf") return "pdf";
	if (ext === "pptx" || contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
	return "other";
}

/** Text of a slide deck, or null when the format is not supported (.ppt, images, …). */
export async function extractSlideText(filename: string, bytes: ArrayBuffer, deps: ExtractDeps, contentType = ""): Promise<string | null> {
	const kind = slideKind(filename, contentType);
	const data = new Uint8Array(bytes);
	if (kind === "pptx") return extractPptxText(data);
	if (kind === "pdf") return extractPdfText(data, await deps.loadPdfJs());
	return null;
}
