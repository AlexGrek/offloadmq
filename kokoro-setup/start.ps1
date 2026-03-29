param(
    [int]$Port = 8443
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$KokoroDir = Join-Path $ScriptDir "kokoro-fastapi"
$CertsDir  = Join-Path $ScriptDir "certs"
$BinDir    = Join-Path $ScriptDir "bin"

$env:PATH = $BinDir + ";" + $env:PATH

# Add uv to PATH if installed in default location
$uvPath = Join-Path $env:USERPROFILE ".local\bin"
if (Test-Path $uvPath) { $env:PATH = $uvPath + ";" + $env:PATH }

if (-not (Test-Path $KokoroDir)) {
    Write-Error "kokoro-fastapi not found. Run .\setup.ps1 first."
    exit 1
}
if (-not (Test-Path (Join-Path $CertsDir "localhost.pem"))) {
    Write-Error "TLS certs not found. Run .\setup.ps1 first."
    exit 1
}

Set-Location $KokoroDir

$env:PYTHONUTF8         = "1"
$env:PROJECT_ROOT       = $KokoroDir
$env:USE_GPU            = "false"
$env:USE_ONNX           = "false"
$env:PYTHONPATH         = "$KokoroDir;$KokoroDir\api"
$env:MODEL_DIR          = "src/models"
$env:VOICES_DIR         = "src/voices/v1_0"
$env:WEB_PLAYER_PATH    = "$KokoroDir\web"

$EspeakDll = "C:\Program Files\eSpeak NG\libespeak-ng.dll"
if (Test-Path $EspeakDll) {
    $env:PHONEMIZER_ESPEAK_LIBRARY = $EspeakDll
}

Write-Host "Starting Kokoro API on https://localhost:$Port"
Write-Host ""

uv run --no-sync uvicorn api.src.main:app `
    --host 0.0.0.0 `
    --port $Port `
    --ssl-keyfile "$CertsDir\localhost-key.pem" `
    --ssl-certfile "$CertsDir\localhost.pem"
