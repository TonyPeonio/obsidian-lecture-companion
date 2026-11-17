// Which Whisper and chat models to suggest for this computer. Live transcription has to keep up
// with speech, and the chat model plus a 32k context has to fit in (video) memory; both depend on
// the GPU (NVIDIA through CUDA, Apple silicon through Metal) or, without one, the CPU cores and RAM.

export interface HardwareInfo {
	/** Node's process.platform */
	platform: string;
	/** Node's process.arch */
	arch: string;
	/** Physical CPU cores (or a good guess). */
	cpuCores: number;
	ramGb: number;
	gpu: { vendor: "nvidia" | "apple" | "none"; name?: string; vramGb?: number };
}

export interface Recommendation {
	whisperModel: string;
	whisperWhy: string;
	/** Ollama tag. */
	chatModel: string;
	chatWhy: string;
	/** One line about the whisper.cpp build to use. */
	build: string;
}

/** Memory a chat model may use: VRAM on NVIDIA, part of unified memory on Apple silicon, part of RAM otherwise. */
export function chatMemoryGb(hw: HardwareInfo): number {
	if (hw.gpu.vendor === "nvidia" && hw.gpu.vramGb) return hw.gpu.vramGb;
	if (hw.gpu.vendor === "apple") return hw.ramGb * 0.6;
	return hw.ramGb * 0.5;
}

export function recommendModels(hw: HardwareInfo): Recommendation {
	const appleSilicon = hw.platform === "darwin" && hw.arch === "arm64";
	const nvidia = hw.gpu.vendor === "nvidia" && (hw.gpu.vramGb ?? 0) >= 4;
	let whisperModel: string;
	let whisperWhy: string;
	let build: string;
	if (nvidia) {
		whisperModel = "large-v3-turbo";
		whisperWhy = `${hw.gpu.name ?? "NVIDIA GPU"}: the GPU build runs the best model many times faster than real time.`;
		build = "Use the GPU (CUDA) build of whisper.cpp.";
	} else if (appleSilicon) {
		whisperModel = hw.ramGb >= 16 ? "large-v3-turbo" : "large-v3-turbo-q8_0";
		whisperWhy = "Apple silicon: Homebrew's whisper.cpp uses the GPU (Metal), so the large turbo model keeps up live.";
		build = "Install with Homebrew (brew install whisper-cpp): it is built with Metal.";
	} else {
		build = hw.platform === "darwin" ? "Intel Mac: the Homebrew build runs on the CPU." : "No NVIDIA GPU found: use the CPU build.";
		if (hw.cpuCores >= 8) {
			whisperModel = "large-v3-turbo";
			whisperWhy = `${hw.cpuCores} CPU cores keep up with the large turbo model live.`;
		} else if (hw.cpuCores >= 6) {
			whisperModel = "large-v3-turbo-q8_0";
			whisperWhy = `${hw.cpuCores} CPU cores: the 8-bit large turbo model keeps up with nearly the same accuracy.`;
		} else if (hw.cpuCores >= 4) {
			whisperModel = "large-v3-turbo-q5_0";
			whisperWhy = `${hw.cpuCores} CPU cores: the 5-bit large turbo model is the fastest large variant.`;
		} else {
			whisperModel = "small-q8_0";
			whisperWhy = `${hw.cpuCores} CPU cores: a small model keeps up live (more mistakes on technical terms; transcribing a recording afterwards can use a larger one).`;
		}
	}
	const mem = chatMemoryGb(hw);
	let chatModel: string;
	if (mem >= 28) chatModel = "qwen3.5:27b";
	else if (mem >= 10) chatModel = "qwen3.5:9b";
	else if (mem >= 6) chatModel = "qwen3.5:4b";
	else chatModel = "qwen3.5:2b";
	const where = hw.gpu.vendor === "nvidia" && hw.gpu.vramGb ? `${Math.round(hw.gpu.vramGb)} GB of VRAM` : hw.gpu.vendor === "apple" ? `${Math.round(hw.ramGb)} GB of unified memory` : `${Math.round(hw.ramGb)} GB of RAM`;
	const chatWhy = `${where}: ${chatModel} with a 32k context fits${mem < 10 ? "; summaries are shorter and less precise than with a 9b model" : ""}.`;
	return { whisperModel, whisperWhy, chatModel, chatWhy, build };
}
