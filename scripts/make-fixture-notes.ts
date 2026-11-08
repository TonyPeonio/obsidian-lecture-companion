// Writes two synthetic lecture notes under tests/fixtures/notes/ with the plugin's own note
// renderer, so `npm run check-summaries -- tests/fixtures/notes` and the faithfulness tests have
// notes whose summaries are known to cite the transcript correctly. Re-run after changing the
// note layout:
//
//   npx esbuild scripts/make-fixture-notes.ts --bundle --platform=node --format=cjs --outfile=.e2e/make-fixture-notes.cjs && node .e2e/make-fixture-notes.cjs
//
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import type { TranscriptSegment } from "../src/core/audio/pipeline";
import { lectureNotePath, renderLectureNote } from "../src/core/notes";

const root = path.join(__dirname, "..", "tests", "fixtures", "notes");

/** Builds segments from (start second, sentence) pairs; each ends 3 s before the next starts (past the 2.5 s paragraph gap). */
function segments(rows: [number, string][]): TranscriptSegment[] {
	return rows.map(([start, text], i) => ({ start, end: (rows[i + 1]?.[0] ?? start + 8) - 3, text }));
}

const sorting = segments([
	[0, "Good morning. Today we start sorting, which is the first big topic of the second half of the course."],
	[9, "Merge sort splits the array in half, sorts each half recursively, and merges the two sorted halves back together."],
	[21, "The merge step is linear, so the recurrence is T of n equals two T of n over two plus n, which solves to n log n."],
	[48, "Quick sort instead picks a pivot and partitions the array so that everything smaller is on the left."],
	[62, "In the worst case the pivot is always the smallest element and quick sort degrades to n squared."],
	[80, "Picking the pivot at random makes the expected running time n log n, and that is what most libraries do."],
	[112, "Homework four on recurrences is due Friday at midnight on Canvas; the late policy is in the syllabus."],
	[140, "A quick question for next time: why can no comparison sort beat n log n? Think about the decision tree."],
]);

const sortingSummary = `### In one sentence
Merge sort and quick sort, their recurrences, and why the pivot choice decides quick sort's running time.
### Key points
- Sorting opens the second half of the course [0:00]
- Merge sort splits the array in half, sorts each half recursively and merges the sorted halves [0:09]
- The merge step is linear, so the recurrence $T(n) = 2T(n/2) + n$ solves to $n \\log n$ [0:21]
- Quick sort picks a pivot and partitions the array around it [0:48]
- With the smallest element as pivot every time, quick sort degrades to $n^2$ [1:02]
- A random pivot gives an expected $n \\log n$ running time, which is what libraries use [1:20]
### Terms and definitions
- **Pivot** — the element quick sort partitions the array around [0:48]
### Worked examples and formulas
- Merge sort recurrence: $T(n) = 2T(n/2) + n = O(n \\log n)$ [0:21]
### Announcements and deadlines
- Homework 4 on recurrences is due Friday at midnight on Canvas [1:52]
### Questions to review
1. Why does the merge step make merge sort $n \\log n$? [0:21]
2. When does quick sort take quadratic time, and how does a random pivot avoid it? [1:02]
3. Why can no comparison sort beat $n \\log n$? [2:20]`;

const alignment = segments([
	[0, "Last week we aligned sequences; today we align structures, which means finding which residues of two proteins correspond in three dimensions."],
	[14, "Once we know the correspondence, superimposing the two structures is easy: rotate and translate one so the matched atoms are as close as possible."],
	[31, "We measure how close with the root mean square deviation, RMSD, in angstroms; identical structures give zero and similar folds are around one to three."],
	[57, "RMSD alone is not enough, because matching only two atoms gives a tiny RMSD. You always report the alignment length with it."],
	[84, "DALI avoids coordinates altogether. It compares distance matrices, the distances between every pair of alpha carbons inside each protein."],
	[109, "The project proposal is due next Thursday, and I posted the rubric under Module 4."],
	[125, "For next time, think about why a distance matrix does not depend on the frame of reference."],
]);

const alignmentSummary = `### In one sentence
Structural alignment of proteins: finding corresponding residues, superimposing them, scoring with RMSD and alignment length, and DALI's distance matrices.
### Key points
- Structural alignment finds which residues of two proteins correspond in three dimensions [0:00]
- Given the correspondence, superposition rotates and translates one structure so matched atoms are close [0:14]
- Similarity is measured with RMSD in angstroms; identical structures give zero, similar folds one to three [0:31]
- RMSD alone is misleading because matching two atoms gives a tiny RMSD, so the alignment length is reported too [0:57]
- DALI compares distance matrices of alpha-carbon distances instead of coordinates [1:24]
### Terms and definitions
- **RMSD** — root mean square deviation between matched atoms, in angstroms [0:31]
- **Distance matrix** — the distances between every pair of alpha carbons in one protein [1:24]
### Announcements and deadlines
- Project proposal due next Thursday; rubric under Module 4 [1:49]
### Questions to review
1. Why is RMSD insufficient on its own to score an alignment? [0:57]
2. Why does a distance matrix not depend on the frame of reference? [2:05]`;

const notes = [
	{ course: "Algorithms", date: "2026-10-12", transcript: sorting, summary: sortingSummary, slides: [{ vaultPath: "Courses/Algorithms/attachments/sorting.pdf", title: "Sorting", text: "--- Page 1 ---\nSorting\nMerge sort and quick sort" }] },
	{ course: "Bioinformatics", date: "2026-10-14", transcript: alignment, summary: alignmentSummary, slides: [] },
];

for (const n of notes) {
	const rel = lectureNotePath("", n.course, n.date);
	const file = path.join(root, ...rel.split("/"));
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, renderLectureNote({ course: n.course, date: n.date, transcript: n.transcript, summary: n.summary, slides: n.slides, audioPath: `Courses/${n.course}/attachments/${n.course} ${n.date} 0900.webm` }), "utf8");
	console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
