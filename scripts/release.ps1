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

# Compute version (mirrors compute-agent-version.sh logic)
$RepoRoot = Split-Path -Parent $PSScriptRoot

$Count = (git -C $RepoRoot rev-list --count HEAD 2>$null).Trim()
if (-not $Count) { $Count = "0" }

$Tag = (git -C $RepoRoot describe --tags --match 'release-*' --abbrev=0 2>$null).Trim()
if ($Tag) {
    $Ver     = $Tag -replace '^release-', ''
    $Prefix  = $Ver -replace '\.\d+$', ''
    $Version = "${Prefix}.${Count}"
} else {
    $Version = "v0.3.${Count}"
}

Write-Host "==> Releasing offloadmq $Version"

# Tag and push
git tag "release-$Version"
if ($LASTEXITCODE -ne 0) { throw "git tag failed" }

git push origin "release-$Version"
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

# Build and upload binaries (CLI + GUI)
$env:DL_BASE_URL = $DlBaseUrl
& "$PSScriptRoot\release-agent.ps1" $Version
if ($LASTEXITCODE -ne 0) { throw "release-agent.ps1 failed" }

# Build Windows installer (binaries already in dist/ from release-agent.ps1)
Write-Host ""
Write-Host "==> Building Windows installer for $Version"

$AgentDir = Join-Path $RepoRoot "agent_v2"
$IssFile  = Join-Path $AgentDir "scripts\windows-installer.iss"

$IsccCmd = $null
$IsccOnPath = Get-Command "ISCC" -ErrorAction SilentlyContinue
if ($IsccOnPath) {
    $IsccCmd = $IsccOnPath.Source
} else {
    $candidates = @(
        "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        "C:\Program Files\Inno Setup 6\ISCC.exe",
        "C:\Program Files (x86)\Inno Setup 5\ISCC.exe"
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { $IsccCmd = $p; break }
    }
}
if (-not $IsccCmd) {
    Write-Error "ISCC not found -- install Inno Setup 6 from https://jrsoftware.org/isinfo.php"
    exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $AgentDir "installer-out") | Out-Null
& $IsccCmd "/DINSTALLER_VERSION=$Version" $IssFile
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

$InstallerFile = Join-Path $AgentDir "installer-out\omq-setup-$Version-windows.exe"
if (-not (Test-Path $InstallerFile)) {
    Write-Error "Expected installer not found: $InstallerFile"
    exit 1
}
Write-Host "-> Installer: $InstallerFile"

# Upload installer
Write-Host ""
Write-Host "==> Uploading installer"

$Arch = $env:PROCESSOR_ARCHITECTURE
$ArchTag = switch ($Arch) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default  { "amd64" }
}
$OsArch = "windows-$ArchTag"
$Bucket = if ($env:DL_BUCKET) { $env:DL_BUCKET } else { "offload-agent" }

$AuthResp = Invoke-RestMethod `
    -Method Post `
    -Uri "${DlBaseUrl}/api/v1/auth/token" `
    -Headers @{ Authorization = "Bearer $env:DL_API_KEY" }
$Token = $AuthResp.token
if (-not $Token) {
    Write-Error "error: failed to obtain JWT for installer upload"
    exit 1
}

$InstallerName = "omq-setup-$Version-windows.exe"

if ($PSVersionTable.PSVersion.Major -ge 7) {
    Invoke-RestMethod `
        -Method Post `
        -Uri "${DlBaseUrl}/api/v1/release/${Bucket}/upload" `
        -Headers @{ Authorization = "Bearer $Token" } `
        -Form @{ version = $Version; os_arch = $OsArch; file = Get-Item $InstallerFile } | Out-Null
} else {
    $StatusFile = [System.IO.Path]::GetTempFileName()
    $RespFile   = [System.IO.Path]::GetTempFileName()
    curl.exe -sS --write-out "%{http_code}" -o "$RespFile" `
        -X POST "${DlBaseUrl}/api/v1/release/${Bucket}/upload" `
        -H "Authorization: Bearer $Token" `
        -F "version=$Version" `
        -F "os_arch=$OsArch" `
        -F "file=@${InstallerFile};filename=${InstallerName}" `
        | Out-File "$StatusFile" -Encoding ascii
    $Status = (Get-Content "$StatusFile").Trim()
    if ($Status -ne "201") {
        Get-Content "$RespFile" | Write-Error
        throw "installer upload failed (HTTP $Status)"
    }
}

Write-Host "  Latest: ${DlBaseUrl}/rs/${Bucket}/latest/${OsArch}/${InstallerName}"
Write-Host ""
Write-Host "Released $Bucket $Version for $OsArch (CLI + GUI + installer)"
