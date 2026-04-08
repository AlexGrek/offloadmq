# Diagnose Offload Agent "Start with Windows" (HKCU Run -> OffloadAgent).
# Run in PowerShell:  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose-windows-startup.ps1
# From repo:         cd offload-agent  then run the line above.

$ErrorActionPreference = 'Continue'

function Write-Section($title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

Write-Section "Environment"
Write-Host "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Host "Is 64-bit process: $([Environment]::Is64BitOperatingSystem)"

Write-Section "Registry: Run key"
$runPath = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'
if (-not (Test-Path -LiteralPath $runPath)) {
    Write-Host "FAIL: Run key path missing (very unusual): $runPath" -ForegroundColor Red
    exit 1
}
Write-Host "OK: Run key exists"

$name = 'OffloadAgent'
try {
    $raw = (Get-ItemProperty -LiteralPath $runPath -Name $name -ErrorAction Stop).$name
} catch {
    $raw = $null
}

if ($null -eq $raw -or $raw -eq '') {
    Write-Host "No '$name' value. Startup is NOT enabled in registry." -ForegroundColor Yellow
    Write-Host "Enable it in the agent Web UI: System tab -> Start with Windows."
    Write-Host "If you did enable it, the app may not have had permission to write HKCU, or a different user profile is active."
    exit 0
}

Write-Host "Raw registry value:" -ForegroundColor Green
Write-Host $raw

Write-Section "Expected shape (from Offload Agent)"
Write-Host "Should be like: powershell.exe ... Start-Process -FilePath '<exe>' -WorkingDirectory '<dir>'"
if ($raw -notmatch 'powershell\.exe') {
    Write-Host "WARN: Value does not mention powershell.exe (unexpected for current agent builds)." -ForegroundColor Yellow
}
if ($raw -notmatch 'Start-Process') {
    Write-Host "WARN: Value does not mention Start-Process." -ForegroundColor Yellow
}

Write-Section "PowerShell launcher"
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (Test-Path -LiteralPath $psExe) {
    Write-Host "OK: $psExe exists"
    try {
        $psVer = & $psExe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
        Write-Host "    Version: $psVer"
    } catch {
        Write-Host "WARN: Could not query PowerShell version: $_" -ForegroundColor Yellow
    }
} else {
    Write-Host "FAIL: Default PowerShell not found at $psExe" -ForegroundColor Red
}

Write-Section "Extract paths from Start-Process (best effort)"
$filePath = $null
$workDir = $null
if ($raw -match "-FilePath\s+'([^']+)'") {
    $filePath = $Matches[1]
}
if ($raw -match '-FilePath\s+"([^"]+)"') {
    $filePath = $Matches[1]
}
if ($raw -match "-WorkingDirectory\s+'([^']+)'") {
    $workDir = $Matches[1]
}
if ($raw -match '-WorkingDirectory\s+"([^"]+)"') {
    $workDir = $Matches[1]
}

if ($null -eq $filePath) {
    Write-Host "Could not parse -FilePath from registry string (quotes or spacing differ)." -ForegroundColor Yellow
} else {
    Write-Host "FilePath: $filePath"
    if (Test-Path -LiteralPath $filePath) {
        Write-Host "OK: Executable exists" -ForegroundColor Green
    } else {
        Write-Host "FAIL: Executable missing (moved, uninstalled, or wrong path). Re-enable startup from the Web UI while the agent runs from the final install location." -ForegroundColor Red
    }
}

if ($null -ne $workDir) {
    Write-Host "WorkingDirectory: $workDir"
    if (Test-Path -LiteralPath $workDir) {
        Write-Host "OK: Working directory exists" -ForegroundColor Green
    } else {
        Write-Host "FAIL: Working directory missing." -ForegroundColor Red
    }
}

Write-Section "Execution policy (can block -Command at logon)"
try {
    $pol = Get-ExecutionPolicy -Scope CurrentUser
    Write-Host "Get-ExecutionPolicy -Scope CurrentUser: $pol"
    if ($pol -eq 'Restricted') {
        Write-Host "WARN: Restricted may block the Run command. The agent uses -ExecutionPolicy Bypass on powershell.exe; if an older entry lacks it, toggle startup off/on in the Web UI." -ForegroundColor Yellow
    }
} catch {
    Write-Host "Could not read execution policy: $_" -ForegroundColor Yellow
}

Write-Section "Notes"
Write-Host "- The agent waits ~10 seconds after logon before Start-Process (by design)."
Write-Host "- Startup runs as your user (HKCU), not as Administrator."
Write-Host "- If Smart App Control / policy blocks the exe, check Windows Security and Event Viewer."
Write-Host "- After moving the .exe, re-save 'Start with Windows' from the Web UI so the registry path updates."

Write-Host ""
Write-Host "Done."
