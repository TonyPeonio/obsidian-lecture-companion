// Lifecycle of a locally spawned `whisper-server`. Process control, port probing and file
// checks are injected so this stays Obsidian- and Node-free and unit-testable.

export interface ProcessHandle {
	pid?: number;
	kill(): void;
	onExit(cb: (code: number | null) => void): void;
	onStderr(cb: (text: string) => void): void;
}

export interface ServerDeps {
	spawn(command: string, args: string[]): ProcessHandle;
	/** True when something answers HTTP on `url` (any status counts: the server has no index page). */
	probe(url: string): Promise<boolean>;
	freePort(): Promise<number>;
	exists(path: string): Promise<boolean>;
	/** Injected so tests do not wait; defaults to the window timers. */
	timers?: Timers;
}

export interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

function windowTimers(): Timers {
	return {
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		clearTimeout: (h) => window.clearTimeout(h as number),
	};
}

export interface ServerConfig {
	/** Absolute path to whisper-server; empty when not found. */
	binary: string;
	modelPath: string;
	threads: number;
	language: string;
	vadModelPath?: string;
	/** When set, no process is spawned; requests go to this URL instead. */
	remoteUrl?: string;
	/** Stop the local server after this long without a request. 0 = never. */
	idleUnloadMs: number;
	startupTimeoutMs?: number;
	pollIntervalMs?: number;
}

export type ServerStatus = "stopped" | "starting" | "ready" | "error" | "remote";

export interface ServerState {
	status: ServerStatus;
	baseUrl?: string;
	message?: string;
	pid?: number;
}

export class WhisperServerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WhisperServerError";
	}
}

export function buildServerArgs(cfg: ServerConfig, port: number): string[] {
	const args = [
		"-m", cfg.modelPath,
		"-t", String(Math.max(1, Math.floor(cfg.threads))),
		"--host", "127.0.0.1",
		"--port", String(port),
		"-l", cfg.language.trim() || "en",
	];
	if (cfg.vadModelPath) args.push("--vad", "-vm", cfg.vadModelPath);
	return args;
}

export class WhisperServerManager {
	state: ServerState = { status: "stopped" };
	/** Last lines of the server's stderr, for the settings diagnostics panel. */
	readonly stderrTail: string[] = [];
	private proc?: ProcessHandle;
	private baseUrl?: string;
	private launchedSignature?: string;
	private starting?: Promise<string>;
	private idleTimer?: unknown;
	private timers: Timers;

	constructor(
		private deps: ServerDeps,
		private getConfig: () => ServerConfig,
		private onState: (state: ServerState) => void = () => {},
	) {
		this.timers = deps.timers ?? windowTimers();
	}

	/** Returns a base URL ready to accept `/inference`, starting the server if needed. */
	async ensureRunning(): Promise<string> {
		const cfg = this.getConfig();
		if (cfg.remoteUrl?.trim()) {
			const url = cfg.remoteUrl.trim().replace(/\/+$/, "");
			if (this.proc) this.stop();
			this.setState({ status: "remote", baseUrl: url });
			return url;
		}
		const signature = JSON.stringify([cfg.binary, cfg.modelPath, cfg.threads, cfg.language, cfg.vadModelPath ?? ""]);
		if (this.proc && this.baseUrl && this.launchedSignature === signature) {
			this.touch();
			return this.baseUrl;
		}
		if (this.starting) return this.starting;
		if (this.proc) this.stop();
		this.starting = this.start(cfg, signature).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	/** Call after each request so the idle timer only fires when the server is unused. */
	touch(): void {
		this.clearIdle();
		const ms = this.getConfig().idleUnloadMs;
		if (ms > 0 && this.proc) {
			this.idleTimer = this.timers.setTimeout(() => this.stop("idle"), ms);
		}
	}

	stop(reason = "stopped"): void {
		this.clearIdle();
		const proc = this.proc;
		this.proc = undefined;
		this.baseUrl = undefined;
		this.launchedSignature = undefined;
		if (proc) {
			try {
				proc.kill();
			} catch {
				// already gone
			}
		}
		if (this.state.status !== "remote" || proc) {
			this.setState({ status: "stopped", message: reason === "idle" ? "Stopped after idle timeout" : undefined });
		}
	}

	get isRunning(): boolean {
		return this.proc !== undefined && this.baseUrl !== undefined;
	}

	private async start(cfg: ServerConfig, signature: string): Promise<string> {
		if (!cfg.binary) {
			throw new WhisperServerError("whisper-server was not found. Install whisper.cpp or set the binary path in settings.");
		}
		if (!(await this.deps.exists(cfg.binary))) {
			throw new WhisperServerError(`whisper-server binary not found at ${cfg.binary}`);
		}
		if (!cfg.modelPath || !(await this.deps.exists(cfg.modelPath))) {
			throw new WhisperServerError("The Whisper model is not downloaded yet. Use \"Download model\" in settings.");
		}
		const port = await this.deps.freePort();
		const url = `http://127.0.0.1:${port}`;
		const args = buildServerArgs(cfg, port);
		this.setState({ status: "starting", message: `Loading ${cfg.modelPath.split(/[\\/]/).pop() ?? "model"}…` });

		let proc: ProcessHandle;
		try {
			proc = this.deps.spawn(cfg.binary, args);
		} catch (err) {
			const message = `Could not start whisper-server: ${(err as Error).message}`;
			this.setState({ status: "error", message });
			throw new WhisperServerError(message);
		}
		this.proc = proc;
		this.launchedSignature = signature;
		let exitCode: number | null | undefined;
		proc.onStderr((text) => this.pushStderr(text));
		proc.onExit((code) => {
			exitCode = code ?? -1;
			if (this.proc === proc) {
				this.proc = undefined;
				this.baseUrl = undefined;
				this.launchedSignature = undefined;
				this.clearIdle();
				this.setState({
					status: "error",
					message: `whisper-server exited (code ${String(exitCode)}). ${this.lastStderrLine()}`.trim(),
				});
			}
		});

		const timeout = cfg.startupTimeoutMs ?? 120_000;
		const interval = cfg.pollIntervalMs ?? 500;
		const sleep = (ms: number): Promise<void> => new Promise<void>((r) => this.timers.setTimeout(r, ms));
		const started = Date.now();
		for (;;) {
			if (exitCode !== undefined) {
				throw new WhisperServerError(`whisper-server exited with code ${String(exitCode)} during startup. ${this.lastStderrLine()}`.trim());
			}
			if (await this.deps.probe(url)) break;
			if (Date.now() - started > timeout) {
				this.stop();
				const message = `whisper-server did not become ready within ${Math.round(timeout / 1000)} s.`;
				this.setState({ status: "error", message });
				throw new WhisperServerError(message);
			}
			await sleep(interval);
		}
		if (this.proc !== proc) {
			throw new WhisperServerError("whisper-server was stopped while starting.");
		}
		this.baseUrl = url;
		this.setState({ status: "ready", baseUrl: url, pid: proc.pid });
		this.touch();
		return url;
	}

	private pushStderr(text: string): void {
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			this.stderrTail.push(line);
			if (this.stderrTail.length > 50) this.stderrTail.shift();
		}
	}

	private lastStderrLine(): string {
		return this.stderrTail[this.stderrTail.length - 1] ?? "";
	}

	private clearIdle(): void {
		if (this.idleTimer !== undefined) {
			this.timers.clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
	}

	private setState(state: ServerState): void {
		this.state = state;
		this.onState(state);
	}
}
