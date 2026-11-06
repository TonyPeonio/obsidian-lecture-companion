import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { INSTALL_SCRIPT_WINDOWS, installerArgs } from "../src/core/whisper/installer";

describe("installer", () => {
	it("embeds exactly the script that ships in scripts/", () => {
		const onDisk = readFileSync(path.join(__dirname, "..", "scripts", "install-whisper-windows.ps1"), "utf8");
		expect(INSTALL_SCRIPT_WINDOWS).toBe(onDisk);
	});

	it("pins the release and both checksums", () => {
		expect(INSTALL_SCRIPT_WINDOWS).toContain('$release = "b5454"');
		expect(INSTALL_SCRIPT_WINDOWS).toContain("6BA69E3482D7826214F90A6A9C84CA07782AEC1E1D0C6A7C30C994FD5D816CCB");
		expect(INSTALL_SCRIPT_WINDOWS).toContain("AFEF0B881C500958921C3F5523B50E59EE2EC9B6F5CBD25B324C51ED308A957A");
		expect(INSTALL_SCRIPT_WINDOWS).toContain("https://github.com/ggml-org/whisper.cpp/releases/download/");
	});

	it("opens a visible window via Start-Process and passes -Cuda only for the GPU build", () => {
		const cpu = installerArgs("C:\\Tony's Vault\\.obsidian\\plugins\\lecture-companion\\install-whisper-windows.ps1", "cpu");
		expect(cpu.command).toBe("powershell.exe");
		expect(cpu.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
		expect(cpu.args[3]).toBe(
			"Start-Process -FilePath powershell.exe -ArgumentList @('-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File','C:\\Tony''s Vault\\.obsidian\\plugins\\lecture-companion\\install-whisper-windows.ps1')",
		);
		expect(cpu.args.some((a) => a.includes('"'))).toBe(false);
		expect(installerArgs("x.ps1", "cuda").args[3]).toContain("'x.ps1','-Cuda')");
		expect(INSTALL_SCRIPT_WINDOWS).toContain('WindowTitle = "whisper.cpp installer"');
	});
});
