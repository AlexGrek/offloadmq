$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$KokoroDir = Join-Path $ScriptDir "kokoro-fastapi"
$BinDir    = Join-Path $ScriptDir "bin"

# Ensure bin/ is on PATH for this session
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
$env:PATH = $BinDir + ";" + $env:PATH

# mkcert
$MkcertExe = Join-Path $BinDir "mkcert.exe"
if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
    Write-Host "Downloading mkcert..."
    $MkcertUrl = "https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v1.4.4-windows-amd64.exe"
    Invoke-WebRequest -Uri $MkcertUrl -OutFile $MkcertExe -UseBasicParsing
    Write-Host "mkcert downloaded."
}

# uv
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "Installing uv..."
    Invoke-WebRequest -Uri "https://astral.sh/uv/install.ps1" -UseBasicParsing | Invoke-Expression
    $uvPath = Join-Path $env:USERPROFILE ".local\bin"
    if (Test-Path $uvPath) { $env:PATH = $uvPath + ";" + $env:PATH }
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Host "uv installed but not in PATH yet. Open a new terminal and re-run setup.ps1."
        exit 1
    }
}

# Clone kokoro-fastapi
if (-not (Test-Path $KokoroDir)) {
    Write-Host "Cloning remsky/kokoro-fastapi..."
    git clone https://github.com/remsky/kokoro-fastapi.git $KokoroDir
} else {
    Write-Host "kokoro-fastapi already cloned - skipping."
}

# Install CPU dependencies via uv into a dedicated venv
Write-Host "Installing CPU dependencies (this may take a while on first run)..."
Set-Location $KokoroDir

# Clear any inherited venv so uv doesn't use offload-client's venv
Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $KokoroDir ".venv"))) {
    uv venv --python 3.10
}

uv pip install -e ".[cpu]" `
    --extra-index-url https://download.pytorch.org/whl/cpu `
    --index-strategy unsafe-best-match

# Download models
Write-Host "Downloading Kokoro models..."
uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0

# TLS certificates
$CertsDir = Join-Path $ScriptDir "certs"
if (-not (Test-Path $CertsDir)) { New-Item -ItemType Directory -Path $CertsDir | Out-Null }

if (-not (Test-Path (Join-Path $CertsDir "localhost.pem"))) {
    Write-Host "Generating locally-trusted TLS certs..."
    & $MkcertExe -install
    & $MkcertExe -key-file "$CertsDir\localhost-key.pem" `
                 -cert-file "$CertsDir\localhost.pem" `
                 localhost 127.0.0.1
    Write-Host "Certs written to $CertsDir"
} else {
    Write-Host "Certs already exist - skipping."
}

Write-Host ""
Write-Host "Setup complete. Run .\start.ps1 to launch on https://localhost:8443"
