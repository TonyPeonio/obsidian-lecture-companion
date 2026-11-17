import { describe, expect, it } from "vitest";
import { buildReviewNote, buildReviewOverviewMessages, lecturesInRange, reviewNotePath, sectionBullets } from "../src/core/review";
import { buildCatchUpMessages } from "../src/core/catchup";
import { renamedAttachment } from "../src/core/notes";

const SUMMARY_1 = `### In one sentence
Kernels let linear methods learn nonlinear boundaries.
### Key points
- A kernel is an inner product in a feature space [01:10]
- The kernel trick avoids computing features [05:20]
### Terms and definitions
- **Kernel** — inner product in feature space [01:10]
- **Gram matrix** — matrix of pairwise kernel values [07:00]
### Questions from class
- Must a kernel be symmetric? → yes, and PSD [12:03]
### Questions to review
- Why does the kernel trick save computation?`;

const SUMMARY_2 = `### In one sentence
Support vector machines maximise the margin.
### Key points
- The margin is the distance to the closest points [00:40]
### Terms and definitions
- **kernel** — repeated term [03:00]
- **Support vector** — a point on the margin [04:00]
### Questions to review
- What is a support vector?`;

const lectures = [
	{ path: "Courses/ML/2026-10-14.md", date: "2026-10-14", summary: SUMMARY_2 },
	{ path: "Courses/ML/2026-10-12.md", date: "2026-10-12", summary: SUMMARY_1 },
	{ path: "Courses/ML/2026-09-01.md", date: "2026-09-01", summary: "" },
];

describe("review notes", () => {
	it("filters by date range and sorts", () => {
		expect(lecturesInRange(lectures, "2026-10-01", "2026-10-31").map((l) => l.date)).toEqual(["2026-10-12", "2026-10-14"]);
		expect(lecturesInRange(lectures, "", "2026-10-12").map((l) => l.date)).toEqual(["2026-09-01", "2026-10-12"]);
	});

	it("names the note after the range", () => {
		expect(reviewNotePath("Courses/ML/", "2026-10-01", "2026-10-31")).toBe("Courses/ML/Review 2026-10-01–2026-10-31.md");
	});

	it("reads bullets without timestamps", () => {
		expect(sectionBullets(SUMMARY_1, "Key points")).toEqual(["A kernel is an inner product in a feature space", "The kernel trick avoids computing features"]);
	});

	it("combines sentences, key points, terms and questions with links back", () => {
		const md = buildReviewNote({ course: "ML", from: "2026-10-01", to: "2026-10-31", lectures: lecturesInRange(lectures, "2026-10-01", "2026-10-31"), overview: "Big picture." });
		expect(md).toContain('course: "ML"\nfrom: 2026-10-01\nto: 2026-10-31\ntags:\n  - review');
		expect(md).toContain("## Overview\n\nBig picture.");
		expect(md).toContain("### [[Courses/ML/2026-10-12|2026-10-12]]\n\nKernels let linear methods learn nonlinear boundaries.\n\n- A kernel is an inner product in a feature space\n- The kernel trick avoids computing features");
		expect(md.indexOf("2026-10-12|2026-10-12]]\n")).toBeLessThan(md.indexOf("2026-10-14|2026-10-14]]\n"));
		expect(md).toContain("- **Kernel** — inner product in feature space ([[Courses/ML/2026-10-12|2026-10-12]], [[Courses/ML/2026-10-14|2026-10-14]])");
		expect(md).toContain("- **Gram matrix** — matrix of pairwise kernel values ([[Courses/ML/2026-10-12|2026-10-12]])");
		expect(md).toContain("## Questions to review\n\n- Why does the kernel trick save computation? ([[Courses/ML/2026-10-12|2026-10-12]])\n- What is a support vector? ([[Courses/ML/2026-10-14|2026-10-14]])");
		expect(md).toContain("## Questions from class\n\n- Must a kernel be symmetric? → yes, and PSD ([[Courses/ML/2026-10-12|2026-10-12]])");
		expect(md).not.toMatch(/\[\d{2}:\d{2}\]/);
	});

	it("says when a lecture has no summary", () => {
		const md = buildReviewNote({ course: "ML", from: "2026-09-01", to: "2026-09-01", lectures: [lectures[2]!] });
		expect(md).toContain("_Not summarized yet._");
		expect(md).not.toContain("## Overview");
	});

	it("builds the overview prompt from the summaries", () => {
		const msgs = buildReviewOverviewMessages({ course: "ML", from: "a", to: "b", lectures: lecturesInRange(lectures, "2026-10-01", "2026-10-31") });
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[1]?.content).toContain("## 2026-10-12\nKernels let linear methods learn nonlinear boundaries.\n- A kernel is an inner product");
	});
});

describe("catch-up prompt", () => {
	it("includes the course, minutes and transcript", () => {
		const msgs = buildCatchUpMessages("ML", 5, "we just derived the dual");
		expect(msgs[0]?.content).toContain("last 5 minutes");
		expect(msgs[1]?.content).toContain("Course: ML");
		expect(msgs[1]?.content).toContain("we just derived the dual");
	});
});

describe("renamedAttachment", () => {
	it("renames recordings named after the course", () => {
		expect(renamedAttachment("ADVANCED SOFTWARE ENGINEERING-12345 2026-11-05 1000.webm", "ADVANCED SOFTWARE ENGINEERING-12345", "Advanced Software Engineering")).toBe("Advanced Software Engineering 2026-11-05 1000.webm");
		expect(renamedAttachment("ml 2026-11-05 1000.webm", "ML", "Machine Learning")).toBe("Machine Learning 2026-11-05 1000.webm");
	});

	it("uses the file-name form of course names", () => {
		expect(renamedAttachment("CS-101 Intro 2026-11-05 1000.ogg", "CS:101 Intro", "Intro to CS")).toBe("Intro to CS 2026-11-05 1000.ogg");
	});

	it("leaves other files alone", () => {
		expect(renamedAttachment("MLOps slides.pdf", "ML", "Machine Learning")).toBeNull();
		expect(renamedAttachment("Lecture 5.pdf", "ML", "Machine Learning")).toBeNull();
		expect(renamedAttachment("ML", "ML", "Machine Learning")).toBeNull();
		expect(renamedAttachment("ML 2026.webm", "ML", "ML")).toBeNull();
	});
});
