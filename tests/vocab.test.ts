import { describe, expect, it } from "vitest";
import { buildVocabulary, composeWhisperPrompt, definedTerms, distinctiveTerms, extraVocabulary, MAX_VOCAB_WORDS } from "../src/core/vocab";

const SLIDES = `> [!note]- Slide text: Lecture 7
> --- Page 1 ---
> Variational Autoencoders
> The ELBO and the Kullback-Leibler divergence
> --- Page 2 ---
> Reparameterization trick: sample from Gaussian with mean and variance
> Kullback-Leibler term regularizes the encoder
> --- Page 3 ---
> Example: VAE on MNIST, latent dimension 2
> Training uses the ELBO`;

describe("distinctiveTerms", () => {
	it("keeps acronyms, hyphenated words, names and frequent long words, not common words", () => {
		const terms = distinctiveTerms(SLIDES);
		expect(terms).toEqual(expect.arrayContaining(["ELBO", "Kullback-Leibler", "MNIST", "VAE", "Gaussian"]));
		expect(terms.map((t) => t.toLowerCase())).not.toContain("example");
		expect(terms.map((t) => t.toLowerCase())).not.toContain("page");
		// ranked: things seen twice with high weight come first
		expect(terms.indexOf("Kullback-Leibler")).toBeLessThan(terms.indexOf("Gaussian"));
	});

	it("drops one-off ordinary words and the page markers", () => {
		const terms = distinctiveTerms("--- Page 1 ---\nthe weather is nice today");
		expect(terms).toEqual([]);
	});
});

describe("definedTerms", () => {
	it("reads the bold terms of the Terms and definitions section", () => {
		const summary = "### Key points\n- **not a term** here [01:00]\n### Terms and definitions\n- **ELBO** — evidence lower bound [02:10]\n- **Reparameterization trick** — sample noise [05:00]\n- plain line\n### Questions to review\n- What?";
		expect(definedTerms(summary)).toEqual(["ELBO", "Reparameterization trick"]);
		expect(definedTerms("no sections")).toEqual([]);
	});
});

describe("extraVocabulary", () => {
	it("takes lines for the course and lines without a course", () => {
		const setting = "# comment\nMachine Learning = Prof. Nguyen, softmax\nAlgorithms = Dijkstra\nTA Priya";
		expect(extraVocabulary(setting, "machine learning")).toEqual(["Prof. Nguyen", "softmax", "TA Priya"]);
		expect(extraVocabulary(setting, "Algorithms")).toEqual(["Dijkstra", "TA Priya"]);
	});
});

describe("buildVocabulary", () => {
	it("puts names first, dedupes, and interleaves slide and defined terms", () => {
		const vocab = buildVocabulary({ names: ["Machine Learning", "CS-229", "Machine learning"], defined: ["ELBO", "posterior collapse"], slideText: SLIDES });
		expect(vocab.slice(0, 2)).toEqual(["Machine Learning", "CS-229"]);
		expect(vocab.filter((v) => v.toLowerCase() === "elbo")).toHaveLength(1);
		expect(vocab).toContain("posterior collapse");
	});

	it("stays within the word budget", () => {
		const many = Array.from({ length: 300 }, (_, i) => `Term${i}x`).join(" ");
		const vocab = buildVocabulary({ names: ["Course"], slideText: `${many}\n${many}` });
		const words = vocab.join(" ").split(" ").length;
		expect(words).toBeLessThanOrEqual(MAX_VOCAB_WORDS);
		expect(buildVocabulary({ names: ["a b c", "d e"] }, 4)).toEqual(["a b c"]);
	});
});

describe("composeWhisperPrompt", () => {
	it("puts the glossary first and keeps the transcript tail last", () => {
		const prompt = composeWhisperPrompt(["ELBO", "Kullback-Leibler"], "x".repeat(500));
		expect(prompt?.startsWith("Glossary: ELBO, Kullback-Leibler. ")).toBe(true);
		expect(prompt?.endsWith("x".repeat(200))).toBe(true);
		expect(prompt?.length).toBe("Glossary: ELBO, Kullback-Leibler. ".length + 200);
	});

	it("works with only one part, or none", () => {
		expect(composeWhisperPrompt([], "hello there")).toBe("hello there");
		expect(composeWhisperPrompt(["ELBO"], undefined)).toBe("Glossary: ELBO.");
		expect(composeWhisperPrompt([], "")).toBeUndefined();
	});

	it("fits whisper's prompt budget with a full vocabulary (rough token estimate)", () => {
		const vocab = buildVocabulary({ names: Array.from({ length: 200 }, (_, i) => `Name${i}`) });
		const prompt = composeWhisperPrompt(vocab, "y ".repeat(300)) ?? "";
		// ≈ 1.6 tokens per word for names, 1 token per 4 chars of English
		const estimate = vocab.length * 2 + 200 / 4 + 5;
		expect(estimate).toBeLessThan(224);
		expect(prompt.length).toBeGreaterThan(0);
	});
});
