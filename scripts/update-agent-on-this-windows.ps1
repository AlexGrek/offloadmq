# Update offload-agent on this Windows machine
#
# Downloads the latest offload-agent binary from dl.alexgr.space,
# kills the running process (if any), installs the new binary, and relaunches it.
#
# NOTE: offload-agent on Windows uses a Registry Run key for autostart
# (HKCU\Software\Microsoft\Windows\CurrentVersion\Run, value "OffloadAgent").
# There is no Windows Service involved — do not use Stop-Service/Start-Service.
#
# Usage:
#   .\scripts\update-agent-on-this-windows.ps1

$ErrorActionPreference = "Stop"

$BaseUrl  = if ($env:DL_BASE_URL) { $env:DL_BASE_URL } else { "https://dl.alexgr.space" }
$FileName = "offload-agent-windows-amd64.exe"
$Url      = "$BaseUrl/rs/offload-agent/latest/windows-amd64/$FileName"

# Resolve current install directory from PATH so we install to the same location
$existing = Get-Command "offload-agent" -ErrorAction SilentlyContinue
if ($existing) {
    $InstallDir = Split-Path $existing.Source
    Write-Host "Found existing install at $InstallDir"
} else {
    $InstallDir = $null
    Write-Host "No existing offload-agent on PATH — will use default install location."
}

Write-Host "Downloading from $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $FileName

# Kill any running offload-agent process so the binary file is not locked
$running = Get-Process -Name "offload-agent*" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Stopping running offload-agent process(es)..."
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
} else {
    Write-Host "No running offload-agent process found, continuing..."
}

Write-Host "Installing binary..."
if ($InstallDir) {
    & ".\$FileName" install bin --dest $InstallDir
    $InstalledBin = Join-Path $InstallDir "offload-agent"
} else {
    & ".\$FileName" install bin
    $InstalledBin = "offload-agent"
}

Remove-Item -Force $FileName

# Show installed version using the known path (avoids stale PATH issues)
& $InstalledBin --version

# Relaunch via the Registry Run key command if autostart is configured
$regProp = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "OffloadAgent" -ErrorAction SilentlyContinue
if ($regProp) {
    Write-Host "Relaunching via Registry Run key..."
    Start-Process powershell -ArgumentList "-NoProfile -Command `"$($regProp.OffloadAgent)`""
    Write-Host "Agent relaunched."
} else {
    Write-Host "No Registry Run key found — agent will not auto-relaunch."
    Write-Host "Start offload-agent manually if needed."
}
