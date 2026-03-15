#Requires -Version 5.1
<#
.SYNOPSIS
    Build offload-agent as a Windows .exe with embedded Python (via PyInstaller).

.DESCRIPTION
    Creates a standalone offload-agent.exe that runs the web UI without a
    console window and opens the browser on launch.

    Prerequisites:
      - Python 3.10+ on PATH
      - pip available

    The script creates a temporary venv, installs dependencies + PyInstaller,
    and produces dist/offload-agent.exe.

.EXAMPLE
    .\build-windows.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $ScriptDir

try {
    # ── 1. Create / reuse venv ─────────────────────────────────────────────
    $VenvDir = Join-Path $ScriptDir "venv-win"
    $PipExe  = Join-Path $VenvDir "Scripts\pip.exe"
    $PyExe   = Join-Path $VenvDir "Scripts\python.exe"

    if (-not (Test-Path $PipExe)) {
        Write-Host "Creating venv at $VenvDir ..."
        python -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) { throw "Failed to create venv" }
    }

    # ── 2. Install dependencies ────────────────────────────────────────────
    Write-Host "Installing dependencies ..."
    & $PipExe install --quiet -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw "pip install requirements.txt failed" }

    Write-Host "Installing PyInstaller ..."
    & $PipExe install --quiet pyinstaller
    if ($LASTEXITCODE -ne 0) { throw "pip install pyinstaller failed" }

    # ── 3. Build ───────────────────────────────────────────────────────────
    Write-Host "Building offload-agent.exe ..."
    & $PyExe -m PyInstaller `
        --noconfirm `
        --onefile `
        --windowed `
        --name "offload-agent" `
        --add-data "app;app" `
        --add-data "webui.py;." `
        "offload-agent-win.pyw"

    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }

    $Exe = Join-Path $ScriptDir "dist\offload-agent.exe"
    Write-Host ""
    Write-Host "Build complete: $Exe" -ForegroundColor Green
}
finally {
    Pop-Location
}
