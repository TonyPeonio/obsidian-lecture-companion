// "Transcribe audio from a link": a direct link to a media file (a lecture-capture download link,
// a podcast episode, an .mp4 on a course page). Only plain HTTP downloads: no streaming-site
// extractors and no helper programs.

const MEDIA_EXT = /\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|mp4|m4v|mov|mkv|3gp)$/i;

/** True for an http(s) URL. */
export function isHttpUrl(text: string): boolean {
	try {
		const u = new URL(text.trim());
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** Whether a download is audio or video, by its Content-Type or, for generic types, the URL's extension. */
export function isMediaResponse(contentType: string, url: string): boolean {
	const ct = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (ct.startsWith("audio/") || ct.startsWith("video/")) return true;
	if (ct === "" || ct === "application/octet-stream" || ct === "binary/octet-stream" || ct === "application/mp4") return MEDIA_EXT.test(pathOf(url));
	return false;
}

function pathOf(url: string): string {
	try {
		return decodeURIComponent(new URL(url).pathname);
	} catch {
		return url.split(/[?#]/)[0] ?? url;
	}
}

const EXT_FOR_TYPE: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/opus": "opus", "audio/flac": "flac", "audio/webm": "webm", "video/webm": "webm", "video/mp4": "mp4", "video/quicktime": "mov" };

/** A file name for the download: the URL's last path segment, with an extension from the type when it has none. */
export function mediaFileName(url: string, contentType = ""): string {
	const last = pathOf(url).split("/").filter(Boolean).pop() ?? "";
	const base = last.replace(/[\\/:*?"<>|#^[\]]/g, "-").slice(0, 100) || "recording";
	if (MEDIA_EXT.test(base)) return base;
	const ext = EXT_FOR_TYPE[contentType.toLowerCase().split(";")[0]?.trim() ?? ""] ?? "mp4";
	return `${base}.${ext}`;
}
