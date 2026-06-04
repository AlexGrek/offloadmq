# Full release flow on Windows: compute version, tag, push, upload binaries.
# Called by `task release` on Windows, or directly:
#   $env:DL_API_KEY="dlk_..."; .\scripts\release.ps1
#   $env:DL_API_KEY="dlk_..."; .\scripts\release.ps1 https://dl.alexgr.space
param(
    [Parameter(Position=0)]
    [string]$DlBaseUrl = "https://dl.alexgr.space"
)

$ErrorActionPreference = "Stop"

if (-not $env:DL_API_KEY) {
    Write-Error "error: DL_API_KEY is not set"
    exit 1
}

# ── Compute version (mirrors compute-agent-version.sh logic) ──────────────────
$RepoRoot = Split-Path -Parent $PSScriptRoot

$Count = (git -C $RepoRoot rev-list --count HEAD 2>$null).Trim()
if (-not $Count) { $Count = "0" }

$Tag = (git -C $RepoRoot describe --tags --match 'release-*' --abbrev=0 2>$null).Trim()
if ($Tag) {
    $Ver    = $Tag -replace '^release-', ''
    $Prefix = $Ver -replace '\.\d+$', ''
    $Version = "${Prefix}.${Count}"
} else {
    $Version = "v0.3.${Count}"
}

Write-Host "==> Releasing offloadmq $Version"

# ── Tag and push ───────────────────────────────────────────────────────────────
git tag "release-$Version"
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

git push origin "release-$Version"
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

# ── Build and upload ───────────────────────────────────────────────────────────
$env:DL_BASE_URL = $DlBaseUrl
& "$PSScriptRoot\release-agent.ps1" $Version
if ($LASTEXITCODE -ne 0) { throw "release-agent.ps1 failed" }
