import { strFromU8, unzipSync } from "fflate";

/**
 * Pulls the text out of a .pptx without a full Office parser: a .pptx is a zip whose
 * `ppt/slides/slideN.xml` files hold every text run in `<a:t>` elements.
 */
export function extractPptxText(bytes: Uint8Array): string {
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes);
	} catch (err) {
		throw new Error(`Not a valid .pptx (zip) file: ${(err as Error).message}`);
	}
	const slides = Object.keys(files)
		.map((name) => ({ name, n: slideNumber(name, /^ppt\/slides\/slide(\d+)\.xml$/) }))
		.filter((s): s is { name: string; n: number } => s.n !== null)
		.sort((a, b) => a.n - b.n);
	const notes = new Map<number, string>();
	for (const name of Object.keys(files)) {
		const n = slideNumber(name, /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
		if (n !== null) notes.set(n, name);
	}
	const blocks: string[] = [];
	for (const slide of slides) {
		const data = files[slide.name];
		if (!data) continue;
		const paragraphs = xmlParagraphs(strFromU8(data));
		const lines = [`--- Slide ${slide.n} ---`, ...paragraphs];
		const notesFile = notes.get(slide.n);
		const notesData = notesFile ? files[notesFile] : undefined;
		if (notesData) {
			const notesText = xmlParagraphs(strFromU8(notesData)).filter((p) => !/^\d+$/.test(p));
			if (notesText.length) lines.push("Speaker notes:", ...notesText);
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n");
}

function slideNumber(name: string, re: RegExp): number | null {
	const m = re.exec(name);
	return m ? Number(m[1]) : null;
}

/** One string per `<a:p>` paragraph, with its `<a:t>` runs joined. Entities decoded. */
export function xmlParagraphs(xml: string): string[] {
	const out: string[] = [];
	for (const para of xml.split(/<\/a:p>/)) {
		const runs: string[] = [];
		const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\s*\/>/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(para)) !== null) {
			runs.push(m[1] === undefined ? "\n" : decodeEntities(m[1]));
		}
		const text = runs.join("").replace(/[ \t]+/g, " ").trim();
		if (text) out.push(text);
	}
	return out;
}

export function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}
