# Build and release offload-agent to dl.alexgr.space (Windows)
#
# Usage:
#   .\scripts\release-agent.ps1 [version]
#
# If version is omitted it is auto-computed: major.minor from the latest
# release-* tag + current commit count as the build number.
# Example: latest tag release-v0.3.250, 260 commits -> v0.3.260
# Falls back to v0.1.<count> when no release tag exists.
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
$AgentDir = Join-Path $RepoRoot "offload-agent"

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

$OsArch    = "windows-$ArchTag"
$BinaryExt = ".exe"
$BinaryName = "offload-agent-${OsArch}${BinaryExt}"

Write-Host "Platform: $OsArch"
Write-Host "Version:  $Version"
Write-Host "Bucket:   $Bucket"
Write-Host ""

# ── Build ──────────────────────────────────────────────────────────────────────

Write-Host "-> Building offload-agent..."

Push-Location $AgentDir
try {
    # Create venv if missing
    if (-not (Test-Path "venv")) {
        python -m venv venv
    }

    # Build frontend
    Push-Location "frontend"
    npm ci
    npm run build
    Pop-Location

    # Install deps + pyinstaller
    & venv\Scripts\pip.exe install -r requirements.txt --quiet
    & venv\Scripts\pip.exe install pyinstaller --quiet

    # Inject version into _version.py so it's bundled correctly
    Set-Content -Path "app\_version.py" -Value "APP_VERSION = '$Version'"

    # Clean stale build artifacts so PyInstaller always picks up current source
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "dist", "build"

    # Build single-file exe (Windows uses ; as add-data separator)
    & venv\Scripts\python.exe -m PyInstaller `
        --onefile `
        --name offload-agent `
        "--add-data=app;app" `
        "--add-data=webui.py;." `
        "--add-data=frontend/dist;frontend/dist" `
        offload-agent.py
} finally {
    Pop-Location
}

$DistBinary = Join-Path $AgentDir "dist\offload-agent.exe"
if (-not (Test-Path $DistBinary)) {
    Write-Error "error: expected binary not found at $DistBinary"
    exit 1
}

$RenamedBinary = Join-Path $AgentDir "dist\$BinaryName"
Copy-Item $DistBinary $RenamedBinary -Force
Write-Host "-> Binary: $RenamedBinary"

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

Write-Host "-> Uploading $BinaryName as $Version..."

# PowerShell's Invoke-RestMethod handles multipart via -Form (PS 7+)
# Fall back to curl.exe on older versions
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $Form = @{
        version  = $Version
        os_arch  = $OsArch
        file     = Get-Item $RenamedBinary
    }
    $Resp = Invoke-RestMethod `
        -Method Post `
        -Uri "${BaseUrl}/api/v1/release/${Bucket}/upload" `
        -Headers @{ Authorization = "Bearer $Token" } `
        -Form $Form

    Write-Host ""
    Write-Host "Released $Bucket $Version for $OsArch"
    Write-Host "  Latest:  ${BaseUrl}/rs/${Bucket}/latest/${OsArch}/${BinaryName}"
    Write-Host "  Landing: ${BaseUrl}/r/${Bucket}"
} else {
    # curl.exe is bundled with Windows 10 1803+
    $StatusFile = [System.IO.Path]::GetTempFileName()
    $RespFile   = [System.IO.Path]::GetTempFileName()

    curl.exe -sS --write-out "%{http_code}" -o $RespFile `
        -X POST "${BaseUrl}/api/v1/release/${Bucket}/upload" `
        -H "Authorization: Bearer $Token" `
        -F "version=$Version" `
        -F "os_arch=$OsArch" `
        -F "file=@${RenamedBinary};filename=${BinaryName}" `
        | Out-File $StatusFile -Encoding ascii

    $Status = (Get-Content $StatusFile).Trim()
    if ($Status -ne "201") {
        Write-Error "error: upload failed (HTTP $Status)"
        Get-Content $RespFile | Write-Error
        exit 1
    }

    Write-Host ""
    Write-Host "Released $Bucket $Version for $OsArch"
    Write-Host "  Latest:  ${BaseUrl}/rs/${Bucket}/latest/${OsArch}/${BinaryName}"
    Write-Host "  Landing: ${BaseUrl}/r/${Bucket}"
}
