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
			// The plugin's own installer writes here, so it wins over an older Scoop copy.
			`${deps.env.LOCALAPPDATA ?? `${home}\\AppData\\Local`}\\whisper.cpp\\${bin}`,
			`${scoop}\\shims\\${bin}`,
			`${scoop}\\apps\\whisper-cpp\\current\\${bin}`,
			`${scoop}\\apps\\whisper-cpp\\current\\Release\\${bin}`,
			`${scoop}\\apps\\whisper-cpp\\current\\bin\\${bin}`,
			`${home}\\whisper.cpp\\${bin}`,
			`${home}\\whisper.cpp\\Release\\${bin}`,
			`${home}\\whisper.cpp\\build\\bin\\Release\\${bin}`,
			`C:\\whisper.cpp\\${bin}`,
			`C:\\whisper.cpp\\Release\\${bin}`,
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
	/** A one-line shell command when a package manager ships it (only works if that package manager is installed). */
	command?: string;
	/** What `command` needs, shown next to it. */
	commandNote?: string;
	url: string;
	guideUrl: string;
	text: string;
}

export const WHISPER_RELEASES_URL = "https://github.com/ggml-org/whisper.cpp/releases";
export const INSTALL_GUIDE_URL = "https://github.com/TonyPeonio/obsidian-lecture-companion#installing-whispercpp";

export function installHint(platform: string): InstallHint {
	if (platform === "win32") {
		return {
			command: "scoop install whisper-cpp",
			commandNote: "only if Scoop is installed",
			url: WHISPER_RELEASES_URL,
			guideUrl: INSTALL_GUIDE_URL,
			text:
				"Easiest: run the install script from the plugin's README (Install guide button) in Command Prompt or PowerShell; it downloads the official whisper-bin-x64.zip, verifies it and unpacks it to %LOCALAPPDATA%\\whisper.cpp. " +
				"Or unzip whisper-bin-x64.zip from the releases page yourself (use a bNNNN build tag; the vX.Y.Z tags carry no files) and paste the path to whisper-server.exe above. " +
				"The CPU build is the right one; no NVIDIA card needed.",
		};
	}
	if (platform === "darwin") {
		return {
			command: "brew install whisper-cpp",
			commandNote: "needs Homebrew",
			url: WHISPER_RELEASES_URL,
			guideUrl: INSTALL_GUIDE_URL,
			text: "Install with Homebrew, or build whisper.cpp from source and paste the path to build/bin/whisper-server above.",
		};
	}
	return {
		url: WHISPER_RELEASES_URL,
		guideUrl: INSTALL_GUIDE_URL,
		text: "Download whisper-bin-ubuntu-x64.tar.gz from the releases page (or build from source) and copy whisper-server to ~/.local/bin, or paste its path above.",
	};
}
