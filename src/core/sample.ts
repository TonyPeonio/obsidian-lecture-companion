// "Try a sample": a lecture note that shows what the plugin produces, without whisper.cpp, a model
// or a course site. Text only (a few KB), written for this plugin: a short lecture on binary
// search with its slides' text, a transcript with marks and a question from class, and an example
// summary that is replaced by a real one when a chat model is available.

import { renderLectureNote } from "./notes";

export const SAMPLE_COURSE = "Sample course";

export const SAMPLE_SLIDE_TEXT = [
	"--- Page 1 ---\nBinary search\nFinding things fast in sorted data",
	"--- Page 2 ---\nLinear search\nCheck every element in turn\nWorst case: n comparisons",
	"--- Page 3 ---\nThe idea\nCompare with the middle element\nDiscard the half that cannot contain the target",
	"--- Page 4 ---\nInvariant\nIf the target is present, it lies between low and high\nLoop until low > high",
	"--- Page 5 ---\nRunning time\nEach step halves the range: O(log n)\nOne million elements: about 20 comparisons",
	"--- Page 6 ---\nPitfalls\nOverflow in (low + high) / 2\nOff-by-one errors at the boundaries\nThe array must be sorted",
].join("\n\n");

export const SAMPLE_TRANSCRIPT = [
	"**[0:00]** Good morning everyone. Today is about binary search, which is how you find things fast in sorted data.",
	"**[0:41]** Let's start with linear search. You check every element in turn until you find the target. In the worst case that is n comparisons, so for a million elements, a million comparisons.",
	"**[1:58]** Now the idea of binary search. You compare the target with the middle element. If the target is smaller, it cannot be in the right half, so you discard that half and repeat on the left half.",
	"**[3:10]** ⭐ Important",
	"**[3:25]** The thing that makes this correct is the invariant: if the target is present, it lies between low and high. Every step keeps that true, and we loop until low is greater than high.",
	"**[4:47]** **Q:** What happens if the array has duplicates?",
	"**[4:55]** Good question. Binary search still finds one of them, but not necessarily the first. If you need the first occurrence, you keep searching left after a match.",
	"**[6:02]** Running time. Each step halves the range, so the number of steps is logarithmic, O of log n. For one million elements that is about twenty comparisons instead of a million.",
	"**[7:30]** A few pitfalls. Computing the middle as low plus high over two can overflow in languages with fixed-size integers, so write low plus high minus low over two.",
	"**[8:05]** ❓ Confusing",
	"**[8:20]** And the off-by-one errors: whether high is inclusive or exclusive changes the loop condition. Pick one convention and stick to it. Also, the array must be sorted, otherwise discarding half the range is wrong.",
	"**[9:31]** For next week, read chapter three and do the exercises on the invariant. That's it for today.",
].join("\n\n");

export const SAMPLE_SUMMARY = `_This is an example summary written by hand. With a chat model set up, run "Summarize this lecture note" to replace it with one written from the transcript._

### In one sentence
Binary search finds an element in sorted data in O(log n) steps by repeatedly halving the search range.

### Key points
- Linear search checks every element and needs up to n comparisons [0:41]
- Binary search compares with the middle element and discards the half that cannot contain the target [1:58]
- Correctness rests on the invariant that the target, if present, lies between low and high [3:25]
- Each step halves the range, so the running time is O(log n): about 20 comparisons for a million elements [6:02]
- Compute the middle as low + (high − low) / 2 to avoid overflow [7:30]
- Off-by-one errors come from mixing inclusive and exclusive bounds; pick one convention, and remember the array must be sorted [8:20]

### Terms and definitions
- **Binary search** — search in sorted data by halving the range at every step [1:58]
- **Invariant** — a condition that holds before and after every iteration of a loop [3:25]

### Announcements and deadlines
- Read chapter three and do the exercises on the invariant for next week [9:31]

### Questions from class
- What happens with duplicates? → one of them is found, not necessarily the first; keep searching left after a match for the first occurrence [4:47]

### Questions to review
- Why must the array be sorted for binary search to work?
- What invariant does binary search maintain, and how does each step preserve it?
- How many comparisons does binary search need for 1,000,000 elements, and why?`;

export const SAMPLE_MY_NOTES = "This note was made by **Try a sample**. Click a timestamp in a real lecture note to play the recording from there (this sample has no audio; the slide links at the end of transcript paragraphs open the deck at that page). Delete the Sample course folder when you are done.";

/** The sample lecture note for `date`, with an example summary (or `summary` when one was generated). */
export function sampleLectureNote(date: string, summary = SAMPLE_SUMMARY): string {
	return renderLectureNote({
		course: SAMPLE_COURSE,
		date,
		title: "Binary search",
		slides: [{ vaultPath: SAMPLE_DECK, title: "Binary search", text: SAMPLE_SLIDE_TEXT, source: "sample deck" }],
		summary,
		myNotes: SAMPLE_MY_NOTES,
	}).replace("_No transcript yet._", SAMPLE_TRANSCRIPT);
}

export const SAMPLE_DECK = "Binary search slides.pdf";

/** Pages of SAMPLE_SLIDE_TEXT: [title, ...lines]. */
export function samplePages(): string[][] {
	return SAMPLE_SLIDE_TEXT.split(/\n\n/).map((block) => block.split("\n").slice(1));
}

/**
 * A minimal PDF (one landscape page per slide, Helvetica, ASCII text) so the sample's embed and
 * `#page=N` slide links work. Built by hand: header, objects, cross-reference table, trailer.
 */
export function samplePdf(pages: string[][] = samplePages()): string {
	const esc = (t: string) => t.replace(/[^\x20-\x7e]/g, "-").replace(/([\\()])/g, "\\$1");
	const objects: string[] = [];
	const pageIds: number[] = [];
	// 1 catalog, 2 pages, 3 font; then per page: page object and content stream.
	pages.forEach((lines, i) => {
		const pageId = 4 + i * 2;
		pageIds.push(pageId);
		const text = lines.map((line, j) => (j === 0 ? `BT /F1 32 Tf 60 470 Td (${esc(line)}) Tj ET` : `BT /F1 20 Tf 60 ${400 - (j - 1) * 40} Td (${esc(line)}) Tj ET`)).join("\n");
		objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
		objects[pageId + 1] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
	});
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let id = 1; id < objects.length; id++) {
		offsets[id] = out.length;
		out += `${id} 0 obj\n${objects[id] ?? ""}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
	for (let id = 1; id < objects.length; id++) out += `${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return out;
}
