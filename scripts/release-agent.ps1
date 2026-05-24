# Build and release agent_v2 to dl.alexgr.space (Windows)
#
# Builds and uploads TWO targets for Windows:
#   - CLI  (omq)      -> omq-windows-<arch>.exe
#   - GUI  (omq-gui)  -> omq-gui-windows-<arch>.exe
# Both land in the same bucket / os_arch slot, distinguished by filename.
#
# Usage:
#   .\scripts\release-agent.ps1 [version]
#
# If version is omitted it is auto-computed: major.minor from the latest
# release-* tag + current commit count as the build number.
# Example: latest tag release-v0.3.250, 260 commits -> v0.3.260
# Falls back to v0.3.<count> when no release tag exists.
#
# Environment variables:
#   DL_API_KEY    (required) API key with release-create and release-write:offload-agent scopes
#   DL_BUCKET     Release bucket name (default: offload-agent)
#   DL_BASE_URL   Server base URL (default: https://dl.alexgr.space)
#
# Examples:
#   $env:DL_API_KEY="dlk_..."; .\scripts\release-agent.ps1
#   $env:DL_API_KEY="dlk_..."; .\scripts\release-agent.ps1 v0.3.260
#
param(
    [Parameter(Mandatory=$false, Position=0)]
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$BaseUrl  = if ($env:DL_BASE_URL) { $env:DL_BASE_URL } else { "https://dl.alexgr.space" }
$Bucket   = if ($env:DL_BUCKET)   { $env:DL_BUCKET   } else { "offload-agent" }
$RepoRoot = Split-Path -Parent $PSScriptRoot
$AgentDir = Join-Path $RepoRoot "agent_v2"

if (-not $env:DL_API_KEY) {
    Write-Error "error: DL_API_KEY is not set"
    exit 1
}

# ── Version auto-detection ─────────────────────────────────────────────────────

if (-not $Version) {
    $Count = git -C $RepoRoot rev-list --count HEAD 2>$null
    if (-not $Count) { $Count = "0" }
    $Tag = git -C $RepoRoot describe --tags --match 'release-*' --abbrev=0 2>$null
    if ($Tag) {
        $Ver    = $Tag -replace '^release-', ''   # e.g. v0.3.250
        $Prefix = $Ver -replace '\.\d+$', ''      # e.g. v0.3
        $Version = "${Prefix}.${Count}"
    } else {
        $Version = "v0.3.${Count}"
    }
}

# ── Detect platform ────────────────────────────────────────────────────────────

$Arch = $env:PROCESSOR_ARCHITECTURE
$ArchTag = switch ($Arch) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default { Write-Error "Unsupported architecture: $Arch"; exit 1 }
}

$OsArch  = "windows-$ArchTag"
$CliName = "omq-${OsArch}.exe"
$GuiName = "omq-gui-${OsArch}.exe"

Write-Host "Platform: $OsArch"
Write-Host "Version:  $Version"
Write-Host "Bucket:   $Bucket"
Write-Host "Targets:  $CliName, $GuiName"
Write-Host ""

# ── Build ──────────────────────────────────────────────────────────────────────

$UvExe = Get-Command uv -ErrorAction SilentlyContinue
if (-not $UvExe) {
    Write-Error "uv is required (install from https://docs.astral.sh/uv/)"
    exit 1
}

Push-Location $AgentDir
try {
    # Build frontend bundle
    Push-Location "ui-server/frontend"
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    Pop-Location

    # Sync workspace
    & uv sync
    if ($LASTEXITCODE -ne 0) { throw "uv sync failed" }

    # Stamp the CLI version so `omq --version` reports the release version
    Set-Content -Path "cli-manager\src\cli_manager\_version.py" `
        -Value "__version__ = `"$Version`""

    # Build CLI (omq.exe) — Windows uses ; as add-data separator
    Push-Location "cli-manager"
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "dist", "build", "*.spec"
    & uv run --with pyinstaller pyinstaller `
        --onefile `
        --name omq `
        "--add-data=../ui-server/frontend/dist;frontend/dist" `
        src/cli_manager/main.py
    if ($LASTEXITCODE -ne 0) { throw "pyinstaller (omq) failed" }
    Pop-Location

    # Build GUI (omq-gui.exe)
    Push-Location "gui-manager"
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "dist", "build", "*.spec"
    & uv run --with pyinstaller pyinstaller `
        --onefile `
        --windowed `
        --name omq-gui `
        "--add-data=../ui-server/frontend/dist;frontend/dist" `
        src/gui_manager/main.py
    if ($LASTEXITCODE -ne 0) { throw "pyinstaller (omq-gui) failed" }
    Pop-Location
} finally {
    Pop-Location
}

$CliDist = Join-Path $AgentDir "cli-manager\dist\omq.exe"
$GuiDist = Join-Path $AgentDir "gui-manager\dist\omq-gui.exe"
foreach ($f in @($CliDist, $GuiDist)) {
    if (-not (Test-Path $f)) {
        Write-Error "error: expected binary not found at $f"
        exit 1
    }
}

$CliRenamed = Join-Path $AgentDir "cli-manager\dist\$CliName"
$GuiRenamed = Join-Path $AgentDir "gui-manager\dist\$GuiName"
Copy-Item $CliDist $CliRenamed -Force
Copy-Item $GuiDist $GuiRenamed -Force
Write-Host "-> CLI binary: $CliRenamed"
Write-Host "-> GUI binary: $GuiRenamed"

# ── Auth ───────────────────────────────────────────────────────────────────────

Write-Host "-> Authenticating..."
$AuthResp = Invoke-RestMethod `
    -Method Post `
    -Uri "${BaseUrl}/api/v1/auth/token" `
    -Headers @{ Authorization = "Bearer $env:DL_API_KEY" }

$Token = $AuthResp.token
if (-not $Token) {
    Write-Error "error: failed to obtain JWT - check DL_API_KEY"
    exit 1
}

# ── Ensure bucket exists ───────────────────────────────────────────────────────

Write-Host "-> Ensuring bucket '$Bucket' exists..."
try {
    Invoke-RestMethod `
        -Method Post `
        -Uri "${BaseUrl}/api/v1/release/create" `
        -Headers @{ Authorization = "Bearer $Token" } `
        -ContentType "application/json" `
        -Body "{`"bucket`":`"$Bucket`"}" | Out-Null
} catch {
    # 409 Conflict is fine (bucket already exists); re-throw anything else
    if ($_.Exception.Response.StatusCode.value__ -ne 409) { throw }
}

# ── Upload ─────────────────────────────────────────────────────────────────────

function Invoke-Upload {
    param([string]$File, [string]$FileName)

    Write-Host "-> Uploading $FileName as $Version..."

    if ($PSVersionTable.PSVersion.Major -ge 7) {
        $Form = @{
            version  = $Version
            os_arch  = $OsArch
            file     = Get-Item $File
        }
        Invoke-RestMethod `
            -Method Post `
            -Uri "${BaseUrl}/api/v1/release/${Bucket}/upload" `
            -Headers @{ Authorization = "Bearer $Token" } `
            -Form $Form | Out-Null
    } else {
        # curl.exe is bundled with Windows 10 1803+
        $StatusFile = [System.IO.Path]::GetTempFileName()
        $RespFile   = [System.IO.Path]::GetTempFileName()

        curl.exe -sS --write-out "%{http_code}" -o $RespFile `
            -X POST "${BaseUrl}/api/v1/release/${Bucket}/upload" `
            -H "Authorization: Bearer $Token" `
            -F "version=$Version" `
            -F "os_arch=$OsArch" `
            -F "file=@${File};filename=${FileName}" `
            | Out-File $StatusFile -Encoding ascii

        $Status = (Get-Content $StatusFile).Trim()
        if ($Status -ne "201") {
            Get-Content $RespFile | Write-Error
            throw "upload failed for $FileName (HTTP $Status)"
        }
    }

    Write-Host "  Latest: ${BaseUrl}/rs/${Bucket}/latest/${OsArch}/${FileName}"
}

Invoke-Upload -File $CliRenamed -FileName $CliName
Invoke-Upload -File $GuiRenamed -FileName $GuiName

Write-Host ""
Write-Host "Released $Bucket $Version for $OsArch (CLI + GUI)"
Write-Host "  Landing: ${BaseUrl}/r/${Bucket}"
