// Copies of notes taken before a bulk move or rename (moving course notes into their folders,
// renaming a course), so a surprise can be undone by hand. Kept in the plugin's folder under
// `backups/<YYYY-MM-DD HHmmss> <reason>/<vault path>`; the newest KEEP_BACKUPS are kept.

export const KEEP_BACKUPS = 10;

export function backupStamp(d: Date = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Where each note is copied: `<root>/<stamp> <reason>/<path>`. Reason is cleaned for a folder name. */
export function backupPlan(paths: string[], root: string, stamp: string, reason: string): { folder: string; copies: { from: string; to: string }[] } {
	const clean = reason.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 60);
	const folder = `${root.replace(/\/+$/, "")}/${stamp}${clean ? ` ${clean}` : ""}`;
	return { folder, copies: [...new Set(paths)].map((from) => ({ from, to: `${folder}/${from}` })) };
}

/** Backup folders to delete so only the newest `keep` remain (names start with the sortable stamp). */
export function backupsToPrune(folderNames: string[], keep = KEEP_BACKUPS): string[] {
	const dated = folderNames.filter((n) => /^\d{4}-\d{2}-\d{2} \d{6}/.test(n)).sort();
	return dated.slice(0, Math.max(0, dated.length - keep));
}
