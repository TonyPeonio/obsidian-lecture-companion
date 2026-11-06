// PDF text via pdf.js. Obsidian ships pdf.js and exposes it through `loadPdfJs()`, so no
// dependency is bundled; the loader is injected to keep this testable.

export interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
}

export interface PdfPageLike {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

export interface PdfDocumentLike {
	numPages: number;
	getPage(n: number): Promise<PdfPageLike>;
	destroy?(): Promise<void> | void;
}

export interface PdfJsLike {
	getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocumentLike> };
}

export async function extractPdfText(bytes: Uint8Array, pdfjs: PdfJsLike, maxPages = 400): Promise<string> {
	const doc = await pdfjs.getDocument({ data: bytes }).promise;
	const blocks: string[] = [];
	try {
		const pages = Math.min(doc.numPages, maxPages);
		for (let n = 1; n <= pages; n++) {
			const page = await doc.getPage(n);
			const content = await page.getTextContent();
			let text = "";
			for (const item of content.items) {
				if (typeof item.str === "string") text += item.str;
				text += item.hasEOL ? "\n" : " ";
			}
			const cleaned = text
				.split("\n")
				.map((l) => l.replace(/\s+/g, " ").trim())
				.filter((l) => l.length > 0)
				.join("\n");
			blocks.push(`--- Page ${n} ---\n${cleaned}`);
		}
		if (doc.numPages > maxPages) blocks.push(`(… ${doc.numPages - maxPages} more pages not extracted)`);
	} finally {
		await doc.destroy?.();
	}
	return blocks.join("\n\n");
}
