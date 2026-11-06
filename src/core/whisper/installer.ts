// The Windows installer the plugin can hand to the user. Kept byte-identical to
// scripts/install-whisper-windows.ps1 (a unit test enforces it) so the script in the repo
// and the one the settings tab runs are the same file.

export const INSTALL_SCRIPT_WINDOWS = "# Installs the official whisper.cpp Windows build into %LOCALAPPDATA%\\whisper.cpp, where the\n# Lecture Companion plugin auto-detects it. Release b5454 (= v1.9.5); checksums are the ones\n# GitHub publishes for the release assets.\n#\n#   powershell -NoProfile -ExecutionPolicy Bypass -File install-whisper-windows.ps1          # CPU build (any PC)\n#   powershell -NoProfile -ExecutionPolicy Bypass -File install-whisper-windows.ps1 -Cuda    # NVIDIA GPU build (10x+ faster)\n#\nparam(\n    [switch]$Cuda\n)\n$ErrorActionPreference = \"Stop\"\ntry { $host.UI.RawUI.WindowTitle = \"whisper.cpp installer\" } catch { }\n$release = \"b5454\"\nif ($Cuda) {\n    $asset = \"whisper-bin-win-cuda-12.4.0-x64.zip\"   # needs an NVIDIA driver that supports CUDA 12.4 (any 2024+ driver)\n    $sha   = \"AFEF0B881C500958921C3F5523B50E59EE2EC9B6F5CBD25B324C51ED308A957A\"\n} else {\n    $asset = \"whisper-bin-x64.zip\"\n    $sha   = \"6BA69E3482D7826214F90A6A9C84CA07782AEC1E1D0C6A7C30C994FD5D816CCB\"\n}\n$url  = \"https://github.com/ggml-org/whisper.cpp/releases/download/$release/$asset\"\n$zip  = Join-Path $env:TEMP $asset\n$tmp  = Join-Path $env:TEMP \"whisper-unzip\"\n$dest = Join-Path $env:LOCALAPPDATA \"whisper.cpp\"\n\nWrite-Host \"Downloading $url ...\"\nInvoke-WebRequest -Uri $url -OutFile $zip\n$hash = (Get-FileHash $zip -Algorithm SHA256).Hash\nif ($hash -ne $sha) { throw \"Checksum mismatch: got $hash, expected $sha\" }\nWrite-Host \"Checksum OK\"\n\nRemove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue\nExpand-Archive $zip -DestinationPath $tmp -Force\nif (Test-Path $dest) {\n    Write-Host \"Replacing the existing install in $dest\"\n    Remove-Item $dest -Recurse -Force\n}\nNew-Item $dest -ItemType Directory -Force | Out-Null\n$src = if (Test-Path (Join-Path $tmp \"Release\")) { Join-Path $tmp \"Release\" } else { $tmp }\nCopy-Item (Join-Path $src \"*\") $dest -Recurse -Force\nRemove-Item $tmp -Recurse -Force\nRemove-Item $zip -Force\n\n$exe = Join-Path $dest \"whisper-server.exe\"\nif (-not (Test-Path $exe)) { throw \"whisper-server.exe not found in $dest\" }\nWrite-Host \"\"\nWrite-Host \"Installed: $exe\"\nif ($Cuda) { Write-Host \"GPU build. In the plugin settings set the binary path to the path above (a Scoop CPU install would otherwise be found first), then click Detect.\" }\n& $exe --help 2>&1 | Select-Object -First 2\n";

export type WhisperBuild = "cpu" | "cuda";

/**
 * PowerShell is started directly (not through `cmd /c start`): Node escapes embedded quotes
 * with backslashes, which cmd does not understand. A detached child gets its own console
 * window on Windows, so the user can watch the script run.
 */
export function installerArgs(scriptPath: string, build: WhisperBuild): { command: string; args: string[] } {
	const args = ["-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
	if (build === "cuda") args.push("-Cuda");
	return { command: "powershell.exe", args };
}
