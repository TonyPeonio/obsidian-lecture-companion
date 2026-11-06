// Pinned GGML models from the official whisper.cpp Hugging Face repos. Sizes and SHA-256 are the
// LFS object ids published by the repo (verified 2026-11-05); a download that does not match is deleted.

export interface ModelEntry {
	id: string;
	file: string;
	repo: string;
	bytes: number;
	sha256: string;
	/** Rough speed on 16 CPU threads, to help choose. */
	note: string;
}

const W = "ggerganov/whisper.cpp";

export const WHISPER_MODELS: ModelEntry[] = [
	{ id: "large-v3-turbo", file: "ggml-large-v3-turbo.bin", repo: W, bytes: 1624555275, sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69", note: "Best accuracy that still keeps up live on a fast laptop CPU (1.5 GB)" },
	{ id: "large-v3-turbo-q8_0", file: "ggml-large-v3-turbo-q8_0.bin", repo: W, bytes: 874188075, sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1", note: "Same model, 8-bit: faster, almost identical accuracy (830 MB)" },
	{ id: "large-v3-turbo-q5_0", file: "ggml-large-v3-turbo-q5_0.bin", repo: W, bytes: 574041195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", note: "Same model, 5-bit: fastest large variant (550 MB)" },
	{ id: "medium", file: "ggml-medium.bin", repo: W, bytes: 1533763059, sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208", note: "Accurate but slower than large-v3-turbo on CPU (1.5 GB)" },
	{ id: "medium-q8_0", file: "ggml-medium-q8_0.bin", repo: W, bytes: 823369779, sha256: "42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502", note: "Medium, 8-bit (790 MB)" },
	{ id: "medium.en", file: "ggml-medium.en.bin", repo: W, bytes: 1533774781, sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356", note: "Medium, English only (1.5 GB)" },
	{ id: "small", file: "ggml-small.bin", repo: W, bytes: 487601967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", note: "Fast; more mistakes on technical terms (470 MB)" },
	{ id: "small-q8_0", file: "ggml-small-q8_0.bin", repo: W, bytes: 264464607, sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f", note: "Small, 8-bit (250 MB)" },
	{ id: "small.en", file: "ggml-small.en.bin", repo: W, bytes: 487614201, sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d", note: "Small, English only (470 MB)" },
	{ id: "base", file: "ggml-base.bin", repo: W, bytes: 147951465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", note: "Very fast, rough (140 MB)" },
	{ id: "base.en", file: "ggml-base.en.bin", repo: W, bytes: 147964211, sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002", note: "Base, English only (140 MB)" },
	{ id: "tiny", file: "ggml-tiny.bin", repo: W, bytes: 77691713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", note: "For testing the setup only (75 MB)" },
	{ id: "tiny.en", file: "ggml-tiny.en.bin", repo: W, bytes: 77704715, sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f", note: "Tiny, English only (75 MB)" },
	{ id: "large-v3", file: "ggml-large-v3.bin", repo: W, bytes: 3095033483, sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2", note: "Full large model: too slow for live use on CPU (3 GB)" },
	{ id: "large-v3-q5_0", file: "ggml-large-v3-q5_0.bin", repo: W, bytes: 1081140203, sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1", note: "Full large model, 5-bit (1 GB)" },
];

/** Silero VAD model for whisper-server's `--vad` (skips silence inside a chunk). */
export const VAD_MODEL: ModelEntry = {
	id: "silero-vad",
	file: "ggml-silero-v6.2.0.bin",
	repo: "ggml-org/whisper-vad",
	bytes: 885098,
	sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
	note: "Voice activity detection (0.9 MB)",
};

export function findModel(id: string): ModelEntry | undefined {
	return WHISPER_MODELS.find((m) => m.id === id);
}

export function modelUrl(entry: ModelEntry): string {
	return `https://huggingface.co/${entry.repo}/resolve/main/${entry.file}`;
}

export function modelPath(modelsDir: string, entry: ModelEntry): string {
	return `${modelsDir.replace(/[\\/]+$/, "")}/${entry.file}`;
}

export interface DownloadDeps {
	exists(path: string): Promise<boolean>;
	size(path: string): Promise<number>;
	mkdir(dir: string): Promise<void>;
	/** Streams `url` to `dest`, following redirects, reporting bytes received. */
	download(url: string, dest: string, onProgress: (received: number, total: number) => void, signal?: AbortSignal): Promise<void>;
	sha256(path: string): Promise<string>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export class ModelDownloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelDownloadError";
	}
}

/** True when the model file is present with the expected size (cheap check; hashing 1.5 GB on every start is not). */
export async function isModelInstalled(modelsDir: string, entry: ModelEntry, deps: Pick<DownloadDeps, "exists" | "size">): Promise<boolean> {
	const path = modelPath(modelsDir, entry);
	if (!(await deps.exists(path))) return false;
	return (await deps.size(path)) === entry.bytes;
}

/**
 * Downloads a model to `<modelsDir>/<file>.part`, verifies its SHA-256, then renames it into
 * place. Returns the final path. The caller is responsible for having asked the user first.
 */
export async function downloadModel(
	modelsDir: string,
	entry: ModelEntry,
	deps: DownloadDeps,
	onProgress: (received: number, total: number) => void = () => {},
	signal?: AbortSignal,
): Promise<string> {
	const dest = modelPath(modelsDir, entry);
	await deps.mkdir(modelsDir);
	const part = `${dest}.part`;
	if (await deps.exists(part)) await deps.unlink(part);
	try {
		await deps.download(modelUrl(entry), part, (received, total) => onProgress(received, total || entry.bytes), signal);
		const size = await deps.size(part);
		if (size !== entry.bytes) {
			throw new ModelDownloadError(`Downloaded ${size} bytes, expected ${entry.bytes}. The download was incomplete or the file changed upstream.`);
		}
		const hash = await deps.sha256(part);
		if (hash.toLowerCase() !== entry.sha256) {
			throw new ModelDownloadError(`SHA-256 mismatch for ${entry.file}: got ${hash}, expected ${entry.sha256}. The file was deleted.`);
		}
		if (await deps.exists(dest)) await deps.unlink(dest);
		await deps.rename(part, dest);
		return dest;
	} catch (err) {
		if (await deps.exists(part)) await deps.unlink(part);
		throw err;
	}
}

export function formatBytes(n: number): string {
	if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
	if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
	return `${n} B`;
}
