#Requires -Version 5.1
<#
.SYNOPSIS
    Build offload-agent as a Windows .exe with embedded Python (via PyInstaller).

.DESCRIPTION
    Creates a standalone offload-agent.exe that runs the web UI without a
    console window and opens the browser on launch.

    Prerequisites:
      - Python 3.10+ on PATH
      - pdm available

    The script syncs dependencies via pdm and builds with PyInstaller,
    and produces dist/offload-agent.exe.

.EXAMPLE
    .\build-windows.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $ScriptDir

# ── Kill existing offload-agent processes ───────────────────────────────────
function Kill-ExistingAgent {
    $ExistingProcesses = Get-Process -Name "offload-agent" -ErrorAction SilentlyContinue
    if ($ExistingProcesses) {
        Write-Host "Stopping existing offload-agent process(es)..."
        foreach ($Process in $ExistingProcesses) {
            Write-Host "  - Stopping PID $($Process.Id)..."
            $Process.CloseMainWindow() | Out-Null
            $Process.WaitForExit(3000) # Wait 3 seconds for graceful shutdown
            if (-not $Process.HasExited) {
                Write-Host "    Force killing PID $($Process.Id)..."
                Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Host "All offload-agent processes stopped."
    }
}

try {
    Kill-ExistingAgent
    $PdmExe = Get-Command pdm -ErrorAction SilentlyContinue
    if (-not $PdmExe) {
        throw "pdm is required (install with: python -m pip install --user pdm)"
    }

    # When pdm is installed via pyapp, its launcher exposes its own runtime venv
    # through VIRTUAL_ENV — pdm would then try to sync project deps into its own
    # installation directory and fail with "Access is denied". Tell pdm to ignore
    # any activated venv and resolve the project interpreter normally.
    $env:PDM_IGNORE_ACTIVE_VENV = "1"

    # ── 2. Install dependencies ────────────────────────────────────────────
    Write-Host "Syncing dependencies via pdm ..."
    & pdm sync --group dev --group build
    if ($LASTEXITCODE -ne 0) { throw "pdm sync failed" }

    Write-Host "Running mypy type checks ..."
    & pdm run mypy app/ --warn-unused-ignores
    if ($LASTEXITCODE -ne 0) { throw "mypy type check failed" }

    $Npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $Npm) { throw "npm is required to build frontend/dist (install Node.js)" }
    Write-Host "Building web UI (frontend/dist) ..."
    Push-Location (Join-Path $ScriptDir "frontend")
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }

    # ── 2c. Inject app version (app/_version.py is bundled into the exe; env alone is ignored) ──
    $RepoRoot = git -C $ScriptDir rev-parse --show-toplevel 2>$null
    if (-not $RepoRoot) { $RepoRoot = $ScriptDir }
    $Count = git -C $RepoRoot rev-list --count HEAD 2>$null
    if (-not $Count) { $Count = "0" }
    $Tag = git -C $RepoRoot describe --tags --match 'release-*' --abbrev=0 2>$null
    if ($Tag) {
        $Ver = $Tag -replace '^release-', ''
        $Prefix = $Ver -replace '\.\d+$', ''
        $AppVersion = "${Prefix}.${Count}"
    } else {
        $AppVersion = "v0.1.${Count}"
    }
    Set-Content -Path (Join-Path $ScriptDir "app\_version.py") -Value "APP_VERSION = '$AppVersion'"
    Write-Host "App version: $AppVersion"

    # ── 3. Build ───────────────────────────────────────────────────────────
    Write-Host "Building offload-agent.exe ..."
    & pdm run pyinstaller `
        --noconfirm `
        --onefile `
        --windowed `
        --name "offload-agent" `
        --paths "." `
        --add-data "app;app" `
        --add-data "webui.py;." `
        --add-data "webui_comfy.py;." `
        --add-data "frontend\dist;frontend/dist" `
        --hidden-import "pystray._win32" `
        --hidden-import "webui" `
        --hidden-import "webui_comfy" `
        --hidden-import "app" `
        --hidden-import "app.config" `
        --hidden-import "app.ollama" `
        --hidden-import "app.core" `
        --hidden-import "app.httphelpers" `
        --hidden-import "app.capabilities" `
        --hidden-import "app.systeminfo" `
        --hidden-import "app.models" `
        --hidden-import "app.url_utils" `
        --hidden-import "app.websocket_client" `
        --hidden-import "app.cli" `
        --hidden-import "app.exec" `
        --hidden-import "app.exec.debug" `
        --hidden-import "app.exec.helpers" `
        --hidden-import "app.exec.llm" `
        --hidden-import "app.exec.shell" `
        --hidden-import "app.exec.shellcmd" `
        --hidden-import "app.exec.tts" `
        --hidden-import "app.data" `
        --hidden-import "app.data.fs_utils" `
        --hidden-import "app.data.updn" `
        --collect-submodules "app" `
        "offload-agent-win.pyw"

    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }

    $Exe = Join-Path $ScriptDir "dist\offload-agent.exe"
    Write-Host ""
    Write-Host "Build complete: $Exe" -ForegroundColor Green
}
finally {
    Pop-Location
}
