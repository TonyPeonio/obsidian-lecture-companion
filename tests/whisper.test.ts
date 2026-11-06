import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpRequestOptions } from "../src/core/http";
import { parseWhisperResponse, transcribeWav, WhisperError } from "../src/core/whisper/client";
import { candidatePaths, installHint, locateWhisperServer } from "../src/core/whisper/locate";
import { downloadModel, findModel, isModelInstalled, modelUrl, WHISPER_MODELS, type DownloadDeps } from "../src/core/whisper/models";
import { buildServerArgs, parseExtraArgs, WhisperServerManager, type ProcessHandle, type ServerConfig, type ServerState } from "../src/core/whisper/server";

describe("whisper client", () => {
	it("posts multipart WAV to /inference and parses verbose_json", async () => {
		const seen: HttpRequestOptions[] = [];
		const http: HttpRequest = async (opts) => {
			seen.push(opts);
			return {
				status: 200,
				headers: {},
				text: JSON.stringify({ text: " Hello world.", segments: [{ start: 0, end: 1.2, text: " Hello world." }] }),
				arrayBuffer: new ArrayBuffer(0),
			};
		};
		const wav = new Uint8Array([82, 73, 70, 70]).buffer;
		const result = await transcribeWav(http, "http://127.0.0.1:9000/", wav, { prompt: "previous text", language: "en" });
		expect(result.segments).toEqual([{ start: 0, end: 1.2, text: " Hello world." }]);
		expect(seen[0]?.url).toBe("http://127.0.0.1:9000/inference");
		expect(seen[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
		const body = new TextDecoder().decode(seen[0]?.body as ArrayBuffer);
		expect(body).toContain('name="file"; filename="audio.wav"');
		expect(body).toContain("Content-Type: audio/wav");
		expect(body).toContain('name="response_format"\r\n\r\nverbose_json');
		expect(body).toContain('name="prompt"\r\n\r\nprevious text');
		expect(body).toContain('name="language"\r\n\r\nen');
		expect(body).toContain("RIFF");
	});

	it("surfaces HTTP and transport errors", async () => {
		const bad: HttpRequest = async () => ({ status: 500, headers: {}, text: "oops", arrayBuffer: new ArrayBuffer(0) });
		await expect(transcribeWav(bad, "http://x", new ArrayBuffer(0))).rejects.toThrow(/HTTP 500/);
		const down: HttpRequest = async () => {
			throw new Error("ECONNREFUSED");
		};
		await expect(transcribeWav(down, "http://x", new ArrayBuffer(0))).rejects.toThrow(/Cannot reach whisper-server/);
	});

	it("parses plain json, string timestamps and error payloads", () => {
		expect(parseWhisperResponse('{"text":"hi"}')).toEqual({ text: "hi", segments: [] });
		expect(parseWhisperResponse('{"segments":[{"start":"00:00:01,500","end":"2.5","text":"a"},{"start":0,"end":0,"text":"  "}]}')).toEqual({
			text: "a",
			segments: [{ start: 1.5, end: 2.5, text: "a" }],
		});
		expect(() => parseWhisperResponse('{"error":"no model"}')).toThrow(WhisperError);
		expect(() => parseWhisperResponse("<html>")).toThrow(/non-JSON/);
	});
});

describe("models", () => {
	it("has a sane pinned table", () => {
		expect(findModel("large-v3-turbo")?.bytes).toBe(1624555275);
		for (const m of WHISPER_MODELS) {
			expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(modelUrl(m)).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${m.file}`);
		}
	});

	function fakeFs(sha = "ab") {
		const files = new Map<string, number>();
		const log: string[] = [];
		const deps: DownloadDeps = {
			exists: async (p) => files.has(p),
			size: async (p) => files.get(p) ?? -1,
			mkdir: async () => undefined,
			download: async (url, dest, onProgress) => {
				log.push(`download ${url} -> ${dest}`);
				onProgress(50, 100);
				onProgress(100, 100);
				files.set(dest, 100);
			},
			sha256: async () => sha,
			rename: async (from, to) => {
				files.set(to, files.get(from) ?? 0);
				files.delete(from);
				log.push(`rename ${from} -> ${to}`);
			},
			unlink: async (p) => {
				files.delete(p);
				log.push(`unlink ${p}`);
			},
		};
		return { files, log, deps };
	}

	const entry = { id: "t", file: "ggml-t.bin", repo: "r/w", bytes: 100, sha256: "ab", note: "" };

	it("downloads to .part, verifies and renames", async () => {
		const { files, log, deps } = fakeFs();
		const progress: number[] = [];
		const path = await downloadModel("/m", entry, deps, (r) => progress.push(r));
		expect(path).toBe("/m/ggml-t.bin");
		expect(files.has("/m/ggml-t.bin")).toBe(true);
		expect(files.has("/m/ggml-t.bin.part")).toBe(false);
		expect(progress).toEqual([50, 100]);
		expect(log[0]).toBe("download https://huggingface.co/r/w/resolve/main/ggml-t.bin -> /m/ggml-t.bin.part");
		expect(await isModelInstalled("/m", entry, deps)).toBe(true);
	});

	it("rejects and deletes on hash or size mismatch", async () => {
		const bad = fakeFs("ff");
		await expect(downloadModel("/m", entry, bad.deps)).rejects.toThrow(/SHA-256 mismatch/);
		expect(bad.files.size).toBe(0);
		const short = fakeFs();
		await expect(downloadModel("/m", { ...entry, bytes: 101 }, short.deps)).rejects.toThrow(/Downloaded 100 bytes, expected 101/);
		expect(short.files.size).toBe(0);
	});
});

describe("locate", () => {
	const base = { home: "C:\\Users\\tony", env: { SCOOP: "D:\\scoop" } as Record<string, string | undefined> };

	it("prefers the explicit path, then PATH, then known folders", async () => {
		const existing = new Set(["D:\\scoop\\apps\\whisper-cpp\\current\\whisper-server.exe"]);
		const deps = { ...base, platform: "win32", exists: async (p: string) => existing.has(p), which: async () => null };
		expect(await locateWhisperServer("", deps)).toBe("D:\\scoop\\apps\\whisper-cpp\\current\\whisper-server.exe");
		expect(await locateWhisperServer("Z:\\nope.exe", deps)).toBeNull();
		existing.add("Z:\\mine.exe");
		expect(await locateWhisperServer("Z:\\mine.exe", deps)).toBe("Z:\\mine.exe");
		existing.add("C:\\bin\\whisper-server.exe");
		expect(await locateWhisperServer("", { ...deps, which: async () => "C:\\bin\\whisper-server.exe" })).toBe("C:\\bin\\whisper-server.exe");
	});

	it("lists platform-appropriate candidates and hints", () => {
		const win = candidatePaths({ ...base, platform: "win32", exists: async () => false, which: async () => null });
		expect(win[0]).toBe("C:\\Users\\tony\\AppData\\Local\\whisper.cpp\\whisper-server.exe");
		expect(win[1]).toBe("D:\\scoop\\shims\\whisper-server.exe");
		expect(candidatePaths({ ...base, home: "/home/t", platform: "linux", exists: async () => false, which: async () => null })).toContain("/home/t/.local/bin/whisper-server");
		expect(installHint("win32").command).toBe("scoop install whisper-cpp");
		expect(installHint("darwin").command).toBe("brew install whisper-cpp");
		expect(installHint("linux").command).toBeUndefined();
	});
});

describe("WhisperServerManager", () => {
	function harness(overrides: Partial<ServerConfig> = {}) {
		const spawned: { cmd: string; args: string[]; handle: FakeProcess }[] = [];
		let listening = false;
		const states: ServerState[] = [];
		const timers = { pending: [] as { fn: () => void; ms: number }[] };
		const cfg: ServerConfig = {
			binary: "/bin/whisper-server",
			modelPath: "/m/ggml-base.bin",
			threads: 8,
			language: "en",
			idleUnloadMs: 1000,
			pollIntervalMs: 1,
			startupTimeoutMs: 50,
			...overrides,
		};
		const manager = new WhisperServerManager(
			{
				spawn: (cmd, args) => {
					const handle = new FakeProcess();
					spawned.push({ cmd, args, handle });
					queueMicrotask(() => (listening = true));
					return handle;
				},
				probe: async () => listening,
				freePort: async () => 4321,
				exists: async (p) => p.startsWith("/bin/") || p.startsWith("/m/"),
				timers: {
					setTimeout: (fn, ms) => {
						const t = { fn, ms };
						timers.pending.push(t);
						if (ms <= 1) queueMicrotask(fn);
						return t;
					},
					clearTimeout: (h) => {
						timers.pending = timers.pending.filter((t) => t !== h);
					},
				},
			},
			() => cfg,
			(s) => states.push(s),
		);
		return { manager, spawned, states, cfg, timers, setListening: (v: boolean) => (listening = v) };
	}

	it("spawns with the right args and reports ready", async () => {
		const h = harness();
		const url = await h.manager.ensureRunning();
		expect(url).toBe("http://127.0.0.1:4321");
		expect(h.spawned[0]?.cmd).toBe("/bin/whisper-server");
		expect(h.spawned[0]?.args).toEqual(["-m", "/m/ggml-base.bin", "-t", "8", "--host", "127.0.0.1", "--port", "4321", "-l", "en"]);
		expect(h.states.map((s) => s.status)).toEqual(["starting", "ready"]);
		expect(h.manager.isRunning).toBe(true);
		// Second call reuses the process.
		expect(await h.manager.ensureRunning()).toBe(url);
		expect(h.spawned.length).toBe(1);
	});

	it("includes VAD args and restarts when the config changes", async () => {
		const h = harness();
		await h.manager.ensureRunning();
		h.cfg.vadModelPath = "/m/vad.bin";
		h.setListening(false);
		await h.manager.ensureRunning();
		expect(h.spawned.length).toBe(2);
		expect(h.spawned[0]?.handle.killed).toBe(true);
		expect(h.spawned[1]?.args.slice(-3)).toEqual(["--vad", "-vm", "/m/vad.bin"]);
		expect(buildServerArgs({ ...h.cfg, threads: 0.5 }, 1)).toContain("1");
		expect(buildServerArgs({ ...h.cfg, extraArgs: ["-fa", "-p", "2"] }, 1).slice(-3)).toEqual(["-fa", "-p", "2"]);
		expect(parseExtraArgs('  -fa -p 2 --public "C:\\My Folder" ')).toEqual(["-fa", "-p", "2", "--public", "C:\\My Folder"]);
		expect(parseExtraArgs("")).toEqual([]);
	});

	it("fails clearly when the binary or model is missing", async () => {
		await expect(harness({ binary: "" }).manager.ensureRunning()).rejects.toThrow(/not found/);
		await expect(harness({ modelPath: "/nope.bin" }).manager.ensureRunning()).rejects.toThrow(/not downloaded/);
	});

	it("reports an exit during startup with the last stderr line", async () => {
		const h = harness();
		const spawnOrig = h.manager;
		void spawnOrig;
		const deps = { spawn: (): ProcessHandle => {
			const p = new FakeProcess();
			queueMicrotask(() => {
				p.emitStderr("error: failed to load model\n");
				p.exit(1);
			});
			return p;
		} };
		const manager = new WhisperServerManager(
			{ ...deps, probe: async () => false, freePort: async () => 1, exists: async () => true, timers: { setTimeout: (fn) => (queueMicrotask(fn), 0), clearTimeout: () => undefined } },
			() => ({ binary: "/b", modelPath: "/m", threads: 1, language: "en", idleUnloadMs: 0, pollIntervalMs: 1 }),
		);
		await expect(manager.ensureRunning()).rejects.toThrow(/exited with code 1.*failed to load model/);
		expect(manager.stderrTail).toEqual(["error: failed to load model"]);
	});

	it("uses the remote URL without spawning and stops on idle", async () => {
		const remote = harness({ remoteUrl: "http://pc:8080/" });
		expect(await remote.manager.ensureRunning()).toBe("http://pc:8080");
		expect(remote.spawned.length).toBe(0);
		expect(remote.manager.state.status).toBe("remote");

		const h = harness();
		await h.manager.ensureRunning();
		const idle = h.timers.pending.find((t) => t.ms === 1000);
		expect(idle).toBeDefined();
		idle?.fn();
		expect(h.manager.isRunning).toBe(false);
		expect(h.spawned[0]?.handle.killed).toBe(true);
		expect(h.manager.state).toEqual({ status: "stopped", message: "Stopped after idle timeout" });
	});
});

class FakeProcess implements ProcessHandle {
	pid = 42;
	killed = false;
	private exitCbs: ((code: number | null) => void)[] = [];
	private errCbs: ((text: string) => void)[] = [];
	kill(): void {
		this.killed = true;
	}
	onExit(cb: (code: number | null) => void): void {
		this.exitCbs.push(cb);
	}
	onStderr(cb: (text: string) => void): void {
		this.errCbs.push(cb);
	}
	exit(code: number): void {
		for (const cb of this.exitCbs) cb(code);
	}
	emitStderr(text: string): void {
		for (const cb of this.errCbs) cb(text);
	}
}
