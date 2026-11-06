// Finds a locally installed whisper.cpp `whisper-server`. The plugin never downloads the binary
// (Obsidian's developer policy forbids plugins installing their own dependencies); it only looks
// in the places a package manager or a manual unzip would put it.

export interface LocateDeps {
	/** Node's `process.platform`: "win32", "darwin", "linux", … */
	platform: string;
	home: string;
	env: Record<string, string | undefined>;
	exists(path: string): Promise<boolean>;
	/** `where`/`which` equivalent; null when not on PATH. */
	which(name: string): Promise<string | null>;
}

export function binaryName(platform: string): string {
	return platform === "win32" ? "whisper-server.exe" : "whisper-server";
}

/** Well-known install locations, most likely first. */
export function candidatePaths(deps: LocateDeps): string[] {
	const bin = binaryName(deps.platform);
	const home = deps.home.replace(/[\\/]+$/, "");
	const out: string[] = [];
	if (deps.platform === "win32") {
		const scoop = deps.env.SCOOP ?? `${home}\\scoop`;
		out.push(
			`${scoop}\\shims\\${bin}`,
			`${scoop}\\apps\\whisper-cpp\\current\\${bin}`,
			`${scoop}\\apps\\whisper-cpp\\current\\Release\\${bin}`,
			`${scoop}\\apps\\whisper-cpp\\current\\bin\\${bin}`,
			`${home}\\whisper.cpp\\${bin}`,
			`${home}\\whisper.cpp\\Release\\${bin}`,
			`${home}\\whisper.cpp\\build\\bin\\Release\\${bin}`,
			`C:\\whisper.cpp\\${bin}`,
			`C:\\whisper.cpp\\Release\\${bin}`,
			`${deps.env.LOCALAPPDATA ?? `${home}\\AppData\\Local`}\\whisper.cpp\\${bin}`,
		);
	} else {
		out.push(
			`/opt/homebrew/bin/${bin}`,
			`/usr/local/bin/${bin}`,
			`/usr/bin/${bin}`,
			`${home}/.local/bin/${bin}`,
			`${home}/whisper.cpp/build/bin/${bin}`,
			`${home}/whisper.cpp/${bin}`,
		);
	}
	return out;
}

/**
 * Resolution order: the explicit path from settings, then PATH, then known folders.
 * Returns the first that exists, or null.
 */
export async function locateWhisperServer(explicitPath: string, deps: LocateDeps): Promise<string | null> {
	const explicit = explicitPath.trim();
	if (explicit) {
		return (await deps.exists(explicit)) ? explicit : null;
	}
	const onPath = await deps.which(binaryName(deps.platform));
	if (onPath && (await deps.exists(onPath))) return onPath;
	for (const p of candidatePaths(deps)) {
		if (await deps.exists(p)) return p;
	}
	return null;
}

export interface InstallHint {
	/** A one-line shell command when a package manager ships it. */
	command?: string;
	url: string;
	text: string;
}

export const WHISPER_RELEASES_URL = "https://github.com/ggml-org/whisper.cpp/releases";

export function installHint(platform: string): InstallHint {
	if (platform === "win32") {
		return {
			command: "scoop install whisper-cpp",
			url: WHISPER_RELEASES_URL,
			text: "Install with Scoop (scoop.sh), or download whisper-bin-x64.zip from the whisper.cpp releases page, unzip it, and point the binary path at whisper-server.exe.",
		};
	}
	if (platform === "darwin") {
		return {
			command: "brew install whisper-cpp",
			url: WHISPER_RELEASES_URL,
			text: "Install with Homebrew, or build whisper.cpp from source and point the binary path at build/bin/whisper-server.",
		};
	}
	return {
		url: WHISPER_RELEASES_URL,
		text: "Download whisper-bin-ubuntu-x64.tar.gz from the whisper.cpp releases page (or build from source) and point the binary path at whisper-server.",
	};
}
