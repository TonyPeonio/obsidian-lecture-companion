/// <reference types="node" />
// .pptx → .pdf through whatever is installed: PowerPoint (Windows, via COM from PowerShell) or
// LibreOffice (any platform, `soffice --headless`). Obsidian renders PDFs inline but can only link a .pptx.

import { spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { exists, which } from "./deps";

export interface PptxConverter {
	kind: "powerpoint" | "libreoffice";
	path: string;
}

const POWERPOINT_PATHS = [
	"C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
	"C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\POWERPNT.EXE",
	"C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE",
	"C:\\Program Files (x86)\\Microsoft Office\\Office16\\POWERPNT.EXE",
];

const LIBREOFFICE_PATHS: Record<string, string[]> = {
	win32: ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"],
	darwin: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"],
	linux: ["/usr/bin/soffice", "/usr/bin/libreoffice", "/snap/bin/libreoffice", "/usr/lib/libreoffice/program/soffice"],
};

export async function findPptxConverter(): Promise<PptxConverter | null> {
	if (process.platform === "win32") {
		for (const p of POWERPOINT_PATHS) if (await exists(p)) return { kind: "powerpoint", path: p };
	}
	for (const p of LIBREOFFICE_PATHS[process.platform] ?? []) if (await exists(p)) return { kind: "libreoffice", path: p };
	const onPath = (await which("soffice")) ?? (await which("libreoffice"));
	if (onPath) return { kind: "libreoffice", path: onPath };
	return null;
}

/** Converts a .pptx (given as bytes) to PDF bytes using a temporary folder. */
export async function convertPptxToPdf(converter: PptxConverter, pptx: ArrayBuffer, baseName: string): Promise<ArrayBuffer> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lecture-companion-"));
	const safe = baseName.replace(/[^\w.-]+/g, "_").replace(/\.pptx$/i, "") || "deck";
	const input = path.join(dir, `${safe}.pptx`);
	const output = path.join(dir, `${safe}.pdf`);
	try {
		await fs.writeFile(input, Buffer.from(pptx));
		if (converter.kind === "powerpoint") {
			await runPowerPoint(input, output);
		} else {
			await run(converter.path, ["--headless", "--convert-to", "pdf", "--outdir", dir, input], 180_000);
		}
		if (!(await exists(output))) throw new Error("the converter produced no PDF");
		const bytes = await fs.readFile(output);
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	} finally {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** PowerPoint's COM automation: open read-only without a window, SaveAs PDF (ppSaveAsPDF = 32). */
function runPowerPoint(input: string, output: string): Promise<void> {
	const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"$app = New-Object -ComObject PowerPoint.Application",
		"try {",
		`  $pres = $app.Presentations.Open(${q(input)}, -1, 0, 0)`,
		`  $pres.SaveAs(${q(output)}, 32)`,
		"  $pres.Close()",
		"} finally { $app.Quit() }",
	].join("; ");
	return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], 180_000);
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let err = "";
		const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		const timer = window.setTimeout(() => {
			child.kill();
			reject(new Error(`conversion timed out after ${Math.round(timeoutMs / 1000)} s`));
		}, timeoutMs);
		child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
		child.on("error", (e) => {
			window.clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			window.clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `converter exited with code ${String(code)}`));
		});
	});
}
