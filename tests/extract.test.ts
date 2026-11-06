import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractSlideText, slideKind } from "../src/core/extract";
import { extractPdfText, type PdfJsLike } from "../src/core/extract/pdf";
import { decodeEntities, extractPptxText, xmlParagraphs } from "../src/core/extract/pptx";

const slide1 = `<?xml version="1.0"?><p:sld xmlns:a="x"><p:txBody><a:p><a:r><a:t>Hello </a:t></a:r><a:r><a:t>World</a:t></a:r></a:p><a:p><a:r><a:t>Second &amp; line</a:t></a:r></a:p></p:txBody></p:sld>`;
const slide2 = `<p:sld><a:p><a:r><a:t>Two</a:t></a:r><a:br/><a:r><a:t>Lines</a:t></a:r></a:p><a:p><a:t/></a:p></p:sld>`;
const slide10 = `<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>`;
const notes2 = `<p:notes><a:p><a:r><a:t>Remember the demo</a:t></a:r></a:p><a:p><a:fld type="slidenum"><a:t>2</a:t></a:fld></a:p></p:notes>`;

function pptx(): Uint8Array {
	return zipSync({
		"[Content_Types].xml": strToU8("<Types/>"),
		"ppt/slides/slide1.xml": strToU8(slide1),
		"ppt/slides/slide2.xml": strToU8(slide2),
		"ppt/slides/slide10.xml": strToU8(slide10),
		"ppt/notesSlides/notesSlide2.xml": strToU8(notes2),
		"ppt/slideLayouts/slideLayout1.xml": strToU8("<p:sldLayout><a:p><a:r><a:t>Layout text must not appear</a:t></a:r></a:p></p:sldLayout>"),
	});
}

describe("pptx", () => {
	it("extracts slide text in numeric order with speaker notes", () => {
		const text = extractPptxText(pptx());
		expect(text).toBe(
			["--- Slide 1 ---", "Hello World", "Second & line", "", "--- Slide 2 ---", "Two\nLines", "Speaker notes:", "Remember the demo", "", "--- Slide 10 ---", "Ten"].join("\n"),
		);
		expect(text).not.toContain("Layout text");
	});

	it("rejects non-zip input", () => {
		expect(() => extractPptxText(new Uint8Array([1, 2, 3]))).toThrow(/Not a valid \.pptx/);
	});

	it("xml helpers", () => {
		expect(xmlParagraphs('<a:p><a:t xml:space="preserve">a  </a:t><a:t>b</a:t></a:p>')).toEqual(["a b"]);
		expect(decodeEntities("&lt;&#65;&#x42;&quot;&apos;&amp;&gt;")).toBe('<AB"\'&>');
	});
});

describe("pdf", () => {
	const fakePdfJs: PdfJsLike = {
		getDocument: () => ({
			promise: Promise.resolve({
				numPages: 2,
				getPage: async (n: number) => ({
					getTextContent: async () => ({
						items: n === 1 ? [{ str: "Title" }, { str: "", hasEOL: true }, { str: "body  text" }] : [{ str: "Page two" }],
					}),
				}),
			}),
		}),
	};

	it("joins items per page and handles EOL", async () => {
		const text = await extractPdfText(new Uint8Array(0), fakePdfJs);
		expect(text).toBe("--- Page 1 ---\nTitle\nbody text\n\n--- Page 2 ---\nPage two");
	});

	it("dispatches by extension or content type", async () => {
		expect(slideKind("Deck.PPTX")).toBe("pptx");
		expect(slideKind("x", "application/pdf")).toBe("pdf");
		expect(slideKind("notes.docx")).toBe("other");
		const deps = { loadPdfJs: async () => fakePdfJs };
		expect(await extractSlideText("deck.pptx", pptx().buffer as ArrayBuffer, deps)).toContain("--- Slide 1 ---");
		expect(await extractSlideText("a.pdf", new ArrayBuffer(0), deps)).toContain("--- Page 1 ---");
		expect(await extractSlideText("a.ppt", new ArrayBuffer(0), deps)).toBeNull();
	});
});
