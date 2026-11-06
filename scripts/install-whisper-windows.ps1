# Installs the official whisper.cpp Windows build into %LOCALAPPDATA%\whisper.cpp, where the
# Lecture Companion plugin auto-detects it. Release b5454 (= v1.9.5); checksums are the ones
# GitHub publishes for the release assets.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-whisper-windows.ps1          # CPU build (any PC)
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-whisper-windows.ps1 -Cuda    # NVIDIA GPU build (10x+ faster)
#
param(
    [switch]$Cuda
)
$ErrorActionPreference = "Stop"
try { $host.UI.RawUI.WindowTitle = "whisper.cpp installer" } catch { }
$release = "b5454"
if ($Cuda) {
    $asset = "whisper-bin-win-cuda-12.4.0-x64.zip"   # needs an NVIDIA driver that supports CUDA 12.4 (any 2024+ driver)
    $sha   = "AFEF0B881C500958921C3F5523B50E59EE2EC9B6F5CBD25B324C51ED308A957A"
} else {
    $asset = "whisper-bin-x64.zip"
    $sha   = "6BA69E3482D7826214F90A6A9C84CA07782AEC1E1D0C6A7C30C994FD5D816CCB"
}
$url  = "https://github.com/ggml-org/whisper.cpp/releases/download/$release/$asset"
$zip  = Join-Path $env:TEMP $asset
$tmp  = Join-Path $env:TEMP "whisper-unzip"
$dest = Join-Path $env:LOCALAPPDATA "whisper.cpp"

Write-Host "Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
if ($hash -ne $sha) { throw "Checksum mismatch: got $hash, expected $sha" }
Write-Host "Checksum OK"

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $tmp -Force
if (Test-Path $dest) {
    Write-Host "Replacing the existing install in $dest"
    Remove-Item $dest -Recurse -Force
}
New-Item $dest -ItemType Directory -Force | Out-Null
$src = if (Test-Path (Join-Path $tmp "Release")) { Join-Path $tmp "Release" } else { $tmp }
Copy-Item (Join-Path $src "*") $dest -Recurse -Force
Remove-Item $tmp -Recurse -Force
Remove-Item $zip -Force

$exe = Join-Path $dest "whisper-server.exe"
if (-not (Test-Path $exe)) { throw "whisper-server.exe not found in $dest" }
Write-Host ""
Write-Host "Installed: $exe"
if ($Cuda) { Write-Host "GPU build. In the plugin settings set the binary path to the path above (a Scoop CPU install would otherwise be found first), then click Detect." }
& $exe --help 2>&1 | Select-Object -First 2
