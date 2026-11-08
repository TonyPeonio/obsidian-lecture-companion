// Summary faithfulness check over a vault: for every `[mm:ss]` a lecture summary cites, is there
// a transcript paragraph within ±20 s that shares a content word with the cited sentence?
// Prints per-note precision and a total; exits non-zero below the threshold. Runs under Node.
//
//   npm run check-summaries                              # the default test vault
//   npm run check-summaries -- "D:\My Vault" tests/fixtures/notes --threshold=90 --window=20
//
import { readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";
import { checkSummary, DEFAULT_WINDOW_SEC, lectureSectionsOf, type CitationResult } from "../src/core/faithfulness";
import { formatTimestamp, isLectureNote } from "../src/core/notes";

const DEFAULT_VAULT = "C:\\Users\\TonyPeonio\\ObsidianAgentTestVault";

interface Options {
	folders: string[];
	threshold: number;
	windowSec: number;
	verbose: boolean;
}

function parseArgs(argv: string[]): Options {
	const opts: Options = { folders: [], threshold: 90, windowSec: DEFAULT_WINDOW_SEC, verbose: false };
	for (const arg of argv) {
		const m = /^--(\w+)(?:=(.*))?$/.exec(arg);
		if (!m) {
			opts.folders.push(arg);
			continue;
		}
		const [, key, value] = m;
		if (key === "threshold") opts.threshold = Number(value);
		else if (key === "window") opts.windowSec = Number(value);
		else if (key === "verbose") opts.verbose = true;
		else {
			console.error(`unknown option ${arg}`);
			process.exit(2);
		}
	}
	if (opts.folders.length === 0) opts.folders.push(DEFAULT_VAULT);
	if (!Number.isFinite(opts.threshold) || !Number.isFinite(opts.windowSec)) {
		console.error("--threshold and --window must be numbers");
		process.exit(2);
	}
	return opts;
}

/** Markdown files under `root`, skipping dot-folders (.obsidian, .trash) and node_modules. */
function markdownFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			if (name.startsWith(".") || name === "node_modules") continue;
			const full = path.join(dir, name);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else if (st.isFile() && name.toLowerCase().endsWith(".md")) out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

function pct(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function describe(r: CitationResult): string {
	const where = r.line ? ` nearest [${formatTimestamp(r.line.sec)}] "${r.line.text.slice(0, 70)}${r.line.text.length > 70 ? "…" : ""}"` : "";
	return `    x ${r.citation.raw} "${r.citation.sentence.slice(0, 90)}${r.citation.sentence.length > 90 ? "…" : ""}" — ${r.verdict}${where}`;
}

function main(): void {
	const opts = parseArgs(process.argv.slice(2));
	let notes = 0;
	let checked = 0;
	let citations = 0;
	let supported = 0;
	for (const folder of opts.folders) {
		let files: string[];
		try {
			files = markdownFiles(folder);
		} catch (err) {
			console.error(`cannot read ${folder}: ${(err as Error).message}`);
			process.exit(2);
		}
		for (const file of files) {
			const md = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
			if (!isLectureNote(md)) continue;
			notes++;
			const rel = path.relative(folder, file);
			for (const section of lectureSectionsOf(md)) {
				if (!section.transcript || !section.summary) continue;
				const result = checkSummary(section.summary, section.transcript, opts.windowSec);
				const label = section.scope ? `${rel} › ${section.scope}` : rel;
				if (result.citations === 0) {
					console.log(`${label}: no [mm:ss] citations in the summary`);
					continue;
				}
				checked++;
				citations += result.citations;
				supported += result.supported;
				console.log(`${label}: ${result.supported}/${result.citations} supported (${pct(result.precision ?? 0)})`);
				for (const r of result.results) if (!r.supported || opts.verbose) console.log(r.supported ? `    ok ${r.citation.raw}` : describe(r));
			}
		}
	}
	console.log("");
	if (citations === 0) {
		console.log(`${notes} lecture note(s) found, none with a cited summary and a transcript; nothing to check.`);
		process.exit(2);
	}
	const total = supported / citations;
	console.log(`TOTAL: ${supported}/${citations} citations supported across ${checked} summar${checked === 1 ? "y" : "ies"} (${notes} lecture notes) = ${pct(total)}; threshold ${opts.threshold}%, window ±${opts.windowSec} s`);
	process.exit(total * 100 >= opts.threshold ? 0 : 1);
}

main();
