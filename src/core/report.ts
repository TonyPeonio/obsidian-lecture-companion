// "Report a problem": an in-memory log of what the plugin told the user, and a GitHub issue body
// built from it with secrets and personal paths removed. Nothing is sent anywhere: the user reviews
// and edits the report, then copies it or opens GitHub's new-issue page themselves.

export const REPO_URL = "https://github.com/TonyPeonio/obsidian-lecture-companion";
/** GitHub rejects very long issue URLs; above this the report goes through the clipboard instead. */
export const MAX_ISSUE_URL = 7000;

export interface LogEntry {
	/** ms since epoch */
	time: number;
	level: "info" | "warn" | "error";
	message: string;
}

/** Ring buffer of the most recent log entries (notices, errors). */
export class LogBuffer {
	private entries: LogEntry[] = [];

	constructor(private capacity = 200) {}

	add(level: LogEntry["level"], message: string, time = Date.now()): void {
		const text = message.replace(/\s+/g, " ").trim();
		if (!text) return;
		this.entries.push({ time, level, message: text.slice(0, 1000) });
		if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
	}

	recent(n = 50): LogEntry[] {
		return this.entries.slice(-n);
	}

	clear(): void {
		this.entries = [];
	}
}

/** Notice text that reads as a failure (these get a "Report" link). */
export function looksLikeError(message: string): boolean {
	return /\b(fail(?:ed|s|ure)?|could not|cannot|can't|error|unable|not found|refused|timed out|crash)/i.test(message);
}

export interface RedactOptions {
	/** Absolute paths to replace: the vault folder becomes `<vault>`, the home folder `~`. */
	vaultPath?: string;
	homeDir?: string;
	/** Values that must never appear (tokens, API keys). */
	secrets?: string[];
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A path in both slash styles and case-insensitively (Windows), longest first. */
function pathPattern(p: string): RegExp {
	const norm = p.replace(/[\\/]+$/, "");
	const parts = norm.split(/[\\/]+/).map(escapeRe);
	return new RegExp(parts.join("[\\\\/]+"), "gi");
}

/** URLs keep scheme, host and path; query strings and fragments (which can hold tokens) are dropped. */
export function redactUrl(url: string): string {
	return url.replace(/([?#])[^\s"')\]]*/, (_m, sep: string) => (sep === "?" ? "?…" : "#…"));
}

/**
 * Removes secrets and personal paths from text: given secrets become `[redacted]`, the vault path
 * `<vault>`, the home folder `~`, query strings of URLs `?…`, and anything that looks like a bearer
 * token or a long key `[redacted]`.
 */
export function redact(text: string, opts: RedactOptions = {}): string {
	let out = text;
	for (const s of (opts.secrets ?? []).filter((x) => x && x.length >= 4)) out = out.split(s).join("[redacted]");
	if (opts.vaultPath && opts.vaultPath.length > 3) out = out.replace(pathPattern(opts.vaultPath), "<vault>");
	if (opts.homeDir && opts.homeDir.length > 3) out = out.replace(pathPattern(opts.homeDir), "~");
	out = out.replace(/\bhttps?:\/\/[^\s"')\]]+/g, (u) => redactUrl(u));
	out = out.replace(/\b(Bearer|token[=:]\s*|access_token[=:]\s*|wstoken[=:]\s*|api[_-]?key[=:]\s*)\s*[A-Za-z0-9~._\-+/]{8,}/gi, (_m, p: string) => `${p}[redacted]`);
	// Canvas tokens look like 1234~AbCd…; OpenAI-style keys like sk-…
	out = out.replace(/\b\d{1,6}~[A-Za-z0-9]{20,}\b/g, "[redacted]").replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
	return out;
}

export interface ReportInput {
	pluginVersion: string;
	obsidianVersion: string;
	platform: string;
	/** Non-secret settings, already chosen by the caller (secrets are redacted again anyway). */
	settings: Record<string, unknown>;
	/** e.g. "whisper-server: ready (local)", "Ollama: 0.12.3, model qwen3.5:9b installed" */
	status: string[];
	log: LogEntry[];
	/** Extra lines, e.g. the whisper-server log tail. */
	serverLog?: string[];
	description?: string;
}

function fmtTime(t: number): string {
	const d = new Date(t);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** The issue body: what happened (for the user to fill in), environment, status, settings and the recent log, all redacted. */
export function buildReport(input: ReportInput, redaction: RedactOptions = {}): string {
	const settings = Object.entries(input.settings)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
		.join("\n");
	const log = input.log.length ? input.log.map((e) => `${fmtTime(e.time)} ${e.level.padEnd(5)} ${e.message}`).join("\n") : "(nothing logged)";
	const body = [
		"### What happened",
		"",
		input.description?.trim() || "<!-- Describe what you did, what you expected, and what happened instead. -->",
		"",
		"### Environment",
		"",
		`- Lecture Companion ${input.pluginVersion}`,
		`- Obsidian ${input.obsidianVersion}`,
		`- ${input.platform}`,
		"",
		"### Status",
		"",
		...input.status.map((s) => `- ${s}`),
		"",
		"<details><summary>Settings (secrets removed)</summary>",
		"",
		"```",
		settings,
		"```",
		"</details>",
		"",
		"<details><summary>Recent log</summary>",
		"",
		"```",
		log,
		"```",
		"</details>",
	];
	if (input.serverLog?.length) body.push("", "<details><summary>whisper-server output</summary>", "", "```", ...input.serverLog.slice(-30), "```", "</details>");
	return redact(body.join("\n"), redaction);
}

/**
 * The new-issue URL. When the full body makes the URL too long, the body is replaced by a short
 * request to paste the report (which the caller copies to the clipboard first).
 */
export function issueUrl(title: string, body: string, max = MAX_ISSUE_URL): { url: string; complete: boolean } {
	const make = (b: string) => `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
	const full = make(body);
	if (full.length <= max) return { url: full, complete: true };
	return { url: make("The report was copied to the clipboard: paste it here (Ctrl+V / Cmd+V), then describe what happened at the top.\n\n"), complete: false };
}
