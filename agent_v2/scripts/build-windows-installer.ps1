# Build a Windows installer (.exe) for OffloadMQ Agent v2 using Inno Setup.
#
# Builds the React frontend, both PyInstaller binaries (omq-gui.exe + omq.exe),
# then runs ISCC to produce the installer at agent_v2/installer-out/.
#
# Prerequisites:
#   - uv (https://docs.astral.sh/uv/)
#   - Node.js / npm
#   - Inno Setup 6 (https://jrsoftware.org/isinfo.php) — ISCC on PATH or default location
#
# Usage (from agent_v2/ or repo root via Taskfile):
#   .\scripts\build-windows-installer.ps1              # auto-detects version
#   .\scripts\build-windows-installer.ps1 v0.3.260     # explicit version
#   task installer:windows                              # via Taskfile

param(
    [Parameter(Mandatory=$false, Position=0)]
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir  = Split-Path -Parent $ScriptDir   # agent_v2/

# ── Version ────────────────────────────────────────────────────────────────────

if (-not $Version) {
    $Count = git -C $AgentDir rev-list --count HEAD 2>$null
    if (-not $Count) { $Count = "0" }
    $Tag = git -C $AgentDir describe --tags --match 'release-*' --abbrev=0 2>$null
    if ($Tag) {
        $Prefix  = ($Tag -replace '^release-', '') -replace '\.\d+$', ''
        $Version = "${Prefix}.${Count}"
    } else {
        $Version = "v0.3.${Count}"
    }
}

Write-Host "Building Windows installer for OffloadMQ Agent $Version"
Write-Host ""

# ── Build frontend ─────────────────────────────────────────────────────────────

Push-Location (Join-Path $AgentDir "ui-server\frontend")
try {
    Write-Host "-- npm ci"
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    Write-Host "-- npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally { Pop-Location }

# ── uv sync ────────────────────────────────────────────────────────────────────

Push-Location $AgentDir
try {
    Write-Host "-- uv sync"
    uv sync
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }
} finally { Pop-Location }

# ── Stamp CLI version ──────────────────────────────────────────────────────────

$VersionFile = Join-Path $AgentDir "cli-manager\src\cli_manager\_version.py"
Set-Content -Path $VersionFile -Value "__version__ = `"$Version`""

# ── Build CLI (omq.exe) ────────────────────────────────────────────────────────

Push-Location (Join-Path $AgentDir "cli-manager")
try {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "dist", "build", "*.spec"
    Write-Host "-- pyinstaller omq"
    uv run --with pyinstaller pyinstaller `
        --onefile `
        --name omq `
        "--add-data=../ui-server/frontend/dist;frontend/dist" `
        src/cli_manager/main.py
    if ($LASTEXITCODE -ne 0) { throw "pyinstaller (omq) failed" }
} finally { Pop-Location }

# ── Build GUI (omq-gui.exe) ────────────────────────────────────────────────────

Push-Location (Join-Path $AgentDir "gui-manager")
try {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "dist", "build", "*.spec"
    Write-Host "-- pyinstaller omq-gui"
    uv run --with pyinstaller pyinstaller `
        --onefile `
        --windowed `
        --name omq-gui `
        "--add-data=../ui-server/frontend/dist;frontend/dist" `
        src/gui_manager/main.py
    if ($LASTEXITCODE -ne 0) { throw "pyinstaller (omq-gui) failed" }
} finally { Pop-Location }

# ── Verify binaries ────────────────────────────────────────────────────────────

$CliBin = Join-Path $AgentDir "cli-manager\dist\omq.exe"
$GuiBin = Join-Path $AgentDir "gui-manager\dist\omq-gui.exe"
foreach ($f in @($CliBin, $GuiBin)) {
    if (-not (Test-Path $f)) {
        Write-Error "Expected binary not found: $f"
        exit 1
    }
}

# ── Find ISCC ──────────────────────────────────────────────────────────────────

$IsccCmd = $null
$IsccOnPath = Get-Command "ISCC" -ErrorAction SilentlyContinue
if ($IsccOnPath) {
    $IsccCmd = $IsccOnPath.Source
} else {
    foreach ($p in @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        "C:\Program Files (x86)\Inno Setup 5\ISCC.exe"
    )) {
        if (Test-Path $p) { $IsccCmd = $p; break }
    }
}
if (-not $IsccCmd) {
    Write-Error "ISCC not found. Install Inno Setup 6 from https://jrsoftware.org/isinfo.php"
    exit 1
}

# ── Run Inno Setup ─────────────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path (Join-Path $AgentDir "installer-out") | Out-Null
$IssFile = Join-Path $ScriptDir "windows-installer.iss"

Write-Host ""
Write-Host "-- ISCC $IssFile"
& $IsccCmd "/DINSTALLER_VERSION=$Version" $IssFile
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

$OutFile = Join-Path $AgentDir "installer-out\omq-setup-$Version-windows.exe"
Write-Host ""
Write-Host "Installer ready: $OutFile"
