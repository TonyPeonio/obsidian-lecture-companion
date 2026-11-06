# Installs the official whisper.cpp Windows CPU build (release b5454, the build Scoop pins)
# into %LOCALAPPDATA%\whisper.cpp, where the Lecture Companion plugin auto-detects it.
$ErrorActionPreference = "Stop"
$url  = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip"
$sha  = "6BA69E3482D7826214F90A6A9C84CA07782AEC1E1D0C6A7C30C994FD5D816CCB"
$zip  = Join-Path $env:TEMP "whisper-bin-x64.zip"
$tmp  = Join-Path $env:TEMP "whisper-unzip"
$dest = Join-Path $env:LOCALAPPDATA "whisper.cpp"

Write-Host "Downloading $url ..."
Invoke-WebRequest -Uri $url -OutFile $zip
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
if ($hash -ne $sha) { throw "Checksum mismatch: got $hash, expected $sha" }
Write-Host "Checksum OK"

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip -DestinationPath $tmp -Force
New-Item $dest -ItemType Directory -Force | Out-Null
$src = if (Test-Path (Join-Path $tmp "Release")) { Join-Path $tmp "Release" } else { $tmp }
Copy-Item (Join-Path $src "*") $dest -Recurse -Force
Remove-Item $tmp -Recurse -Force
Remove-Item $zip -Force

$exe = Join-Path $dest "whisper-server.exe"
if (-not (Test-Path $exe)) { throw "whisper-server.exe not found in $dest" }
Write-Host ""
Write-Host "Installed: $exe"
& $exe --help 2>&1 | Select-Object -First 2
