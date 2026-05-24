# Upgrade the agent_v2 GUI client (omq-gui) on this Windows machine.
#
# Downloads the latest omq-gui.exe from dl.alexgr.space, stops the running
# process, replaces the installed binary, and relaunches it via the HKCU
# Run key ("OffloadAgent") if autostart is configured.
#
# agent_v2 on Windows uses a Registry Run key for autostart
# (HKCU\Software\Microsoft\Windows\CurrentVersion\Run, value "OffloadAgent").
# There is no Windows Service involved.
#
# Usage (from agent_v2/):
#   task upgrade-client-on-this-windows
#   # or directly:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/upgrade-client-on-this-windows.ps1

$ErrorActionPreference = "Stop"

$BaseUrl = if ($env:DL_BASE_URL) { $env:DL_BASE_URL } else { "https://dl.alexgr.space" }
$Bucket  = if ($env:DL_BUCKET)   { $env:DL_BUCKET   } else { "offload-agent" }

$Arch = $env:PROCESSOR_ARCHITECTURE
$ArchTag = switch ($Arch) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default { Write-Error "Unsupported architecture: $Arch"; exit 1 }
}

$FileName = "omq-gui-windows-$ArchTag.exe"
$Url      = "$BaseUrl/rs/$Bucket/latest/windows-$ArchTag/$FileName"

# Resolve current install directory from PATH so we replace the same binary.
$existing = Get-Command "omq-gui" -ErrorAction SilentlyContinue
if ($existing) {
    $Dest = $existing.Source
    $InstallDir = Split-Path $Dest
    Write-Host "Found existing install at $InstallDir"
} else {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\omq"
    $Dest = Join-Path $InstallDir "omq-gui.exe"
    Write-Host "No omq-gui on PATH — will install to $InstallDir"
}

Write-Host "Downloading $Url ..."
$Tmp = Join-Path $env:TEMP $FileName
Invoke-WebRequest -Uri $Url -OutFile $Tmp

# Stop any running omq-gui process so the binary file is not locked.
$running = Get-Process -Name "omq-gui*" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Stopping running omq-gui process(es)..."
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
} else {
    Write-Host "No running omq-gui process found, continuing..."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Move-Item -Force $Tmp $Dest
Write-Host "Installed -> $Dest"

# Relaunch via the Registry Run key command if autostart is configured.
$regProp = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "OffloadAgent" -ErrorAction SilentlyContinue
if ($regProp) {
    Write-Host "Relaunching via Registry Run key..."
    Start-Process powershell -ArgumentList "-NoProfile -Command `"$($regProp.OffloadAgent)`""
    Write-Host "Agent relaunched."
} else {
    Write-Host "No Registry Run key found — start omq-gui manually if needed:"
    Write-Host "  $Dest"
}
