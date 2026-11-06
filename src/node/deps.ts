/// <reference types="node" />
// Node-backed implementations of the core's injected dependencies. This plugin is desktop-only
// (`isDesktopOnly: true`), so Node built-ins are available in Obsidian's renderer.

import { spawn } from "child_process";
import { createHash } from "crypto";
import { createReadStream, createWriteStream, promises as fs } from "fs";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as os from "os";
import type { DownloadDeps } from "../core/whisper/models";
import type { LocateDeps } from "../core/whisper/locate";
import type { ProcessHandle, ServerDeps } from "../core/whisper/server";

export async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

export function cpuCount(): number {
	const n = os.cpus().length;
	return n > 0 ? n : 4;
}

/**
 * whisper.cpp runs fastest with one thread per physical core; hyper-threads add contention.
 * Node cannot see physical cores, so assume SMT on x86 with 8+ logical CPUs (Apple silicon has none).
 */
export function defaultThreads(): number {
	const logical = cpuCount();
	if (process.platform === "darwin" || logical < 8) return logical;
	return Math.max(4, Math.floor(logical / 2));
}

export interface GpuInfo {
	vendor: "nvidia" | "apple" | "none";
	name?: string;
}

/** NVIDIA via nvidia-smi (Windows/Linux); Apple silicon uses Metal through the Homebrew build automatically. */
export async function detectGpu(): Promise<GpuInfo> {
	if (process.platform === "darwin") return { vendor: process.arch === "arm64" ? "apple" : "none" };
	const smi = process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\nvidia-smi.exe` : await which("nvidia-smi");
	if (!smi || !(await exists(smi))) return { vendor: "none" };
	const name = await new Promise<string>((resolve) => {
		let out = "";
		try {
			const child = spawn(smi, ["--query-gpu=name", "--format=csv,noheader"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
			child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
			child.on("error", () => resolve(""));
			child.on("close", () => resolve(out.split(/\r?\n/)[0]?.trim() ?? ""));
		} catch {
			resolve("");
		}
	});
	return name ? { vendor: "nvidia", name } : { vendor: "none" };
}

/** Writes the installer script next to the plugin and opens it in a visible PowerShell window. */
export async function runWindowsInstaller(scriptDir: string, scriptText: string, args: (scriptPath: string) => { command: string; args: string[] }): Promise<string> {
	await fs.mkdir(scriptDir, { recursive: true });
	const scriptPath = `${scriptDir.replace(/[\\/]+$/, "")}\\install-whisper-windows.ps1`;
	await fs.writeFile(scriptPath, scriptText, "utf8");
	const { command, args: argv } = args(scriptPath);
	// The launcher itself stays hidden and exits at once; Start-Process inside it opens the visible window.
	await new Promise<void>((resolve, reject) => {
		let err = "";
		const child = spawn(command, argv, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
		child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `launcher exited with code ${String(code)}`))));
	});
	return scriptPath;
}

export function nodeLocateDeps(): LocateDeps {
	return {
		platform: process.platform,
		home: os.homedir(),
		env: process.env,
		exists,
		which: (name) => which(name),
	};
}

/** `where` on Windows, `which` elsewhere. Resolves to the first hit or null. */
export function which(name: string): Promise<string | null> {
	return new Promise((resolve) => {
		const cmd = process.platform === "win32" ? "where" : "which";
		let out = "";
		let child;
		try {
			child = spawn(cmd, [name], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve(null);
			return;
		}
		child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		child.on("error", () => resolve(null));
		child.on("close", (code) => {
			const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
			resolve(code === 0 && first ? first : null);
		});
	});
}

export function nodeServerDeps(): ServerDeps {
	return {
		spawn(command, args): ProcessHandle {
			const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			const stderrListeners: ((text: string) => void)[] = [];
			const exitListeners: ((code: number | null) => void)[] = [];
			const forward = (d: Buffer): void => {
				const text = d.toString();
				for (const l of stderrListeners) l(text);
			};
			child.stdout?.on("data", forward);
			child.stderr?.on("data", forward);
			let exited = false;
			const fire = (code: number | null): void => {
				if (exited) return;
				exited = true;
				for (const l of exitListeners) l(code);
			};
			child.on("exit", (code) => fire(code));
			child.on("error", (err) => {
				forward(Buffer.from(`${err.message}\n`));
				fire(-1);
			});
			return {
				pid: child.pid,
				kill: () => {
					if (!exited) child.kill();
				},
				onExit: (cb) => exitListeners.push(cb),
				onStderr: (cb) => stderrListeners.push(cb),
			};
		},
		probe: (url) =>
			new Promise<boolean>((resolve) => {
				const req = http.get(url, { timeout: 1500 }, (res) => {
					res.resume();
					resolve(true);
				});
				req.on("timeout", () => {
					req.destroy();
					resolve(false);
				});
				req.on("error", () => resolve(false));
			}),
		freePort: () =>
			new Promise<number>((resolve, reject) => {
				const server = net.createServer();
				server.unref();
				server.on("error", reject);
				server.listen(0, "127.0.0.1", () => {
					const addr = server.address();
					const port = typeof addr === "object" && addr ? addr.port : 0;
					server.close(() => (port ? resolve(port) : reject(new Error("No free port"))));
				});
			}),
		exists,
	};
}

export function nodeDownloadDeps(): DownloadDeps {
	return {
		exists,
		size: async (p) => (await fs.stat(p)).size,
		mkdir: (dir) => fs.mkdir(dir, { recursive: true }).then(() => undefined),
		download: (url, dest, onProgress, signal) => download(url, dest, onProgress, signal),
		sha256: (p) =>
			new Promise<string>((resolve, reject) => {
				const hash = createHash("sha256");
				const stream = createReadStream(p);
				stream.on("data", (d: string | Buffer) => hash.update(d));
				stream.on("error", reject);
				stream.on("end", () => resolve(hash.digest("hex")));
			}),
		rename: (from, to) => fs.rename(from, to),
		unlink: (p) => fs.unlink(p).catch(() => undefined),
	};
}

/** Streams a URL to disk following redirects (Hugging Face redirects to its CDN). */
export function download(
	url: string,
	dest: string,
	onProgress: (received: number, total: number) => void,
	signal?: AbortSignal,
	redirects = 0,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (redirects > 10) {
			reject(new Error("Too many redirects"));
			return;
		}
		const lib = url.startsWith("http:") ? http : https;
		const req = lib.get(url, { headers: { "User-Agent": "obsidian-lecture-companion" } }, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400 && res.headers.location) {
				res.resume();
				const next = new URL(res.headers.location, url).toString();
				download(next, dest, onProgress, signal, redirects + 1).then(resolve, reject);
				return;
			}
			if (status !== 200) {
				res.resume();
				reject(new Error(`HTTP ${status} from ${new URL(url).host}`));
				return;
			}
			const total = Number(res.headers["content-length"] ?? 0);
			let received = 0;
			const file = createWriteStream(dest);
			const abort = (): void => {
				req.destroy();
				file.destroy();
				const err = new Error("Download cancelled");
				err.name = "AbortError";
				reject(err);
			};
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			res.on("data", (chunk: Buffer) => {
				received += chunk.length;
				onProgress(received, total);
			});
			res.on("error", (err) => {
				file.destroy();
				reject(err);
			});
			file.on("error", reject);
			file.on("finish", () => {
				signal?.removeEventListener("abort", abort);
				resolve();
			});
			res.pipe(file);
		});
		req.on("error", reject);
	});
}
