#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOKORO_DIR="$SCRIPT_DIR/kokoro-fastapi"
VENV_DIR="$SCRIPT_DIR/venv"
CERTS_DIR="$SCRIPT_DIR/certs"
PORT="${PORT:-8443}"

# Detect venv bin path
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    VENV_BIN="$VENV_DIR/Scripts"
else
    VENV_BIN="$VENV_DIR/bin"
fi

if [ ! -d "$KOKORO_DIR" ]; then
    echo "kokoro-fastapi not found. Run ./setup.sh first."
    exit 1
fi

if [ ! -f "$CERTS_DIR/localhost.pem" ]; then
    echo "TLS certs not found. Run ./setup.sh first."
    exit 1
fi

# Detect entry point — newer versions use api.src.main, older use main directly
if [ -f "$KOKORO_DIR/api/src/main.py" ]; then
    APP_MODULE="api.src.main:app"
elif [ -f "$KOKORO_DIR/main.py" ]; then
    APP_MODULE="main:app"
else
    echo "Cannot find main.py in kokoro-fastapi. Check the repo structure."
    exit 1
fi

echo "Starting Kokoro API ($APP_MODULE) on https://localhost:$PORT"
echo "Models will be downloaded on first request — this may take a while."
echo ""

cd "$KOKORO_DIR"
"$VENV_BIN/uvicorn" "$APP_MODULE" \
    --host 0.0.0.0 \
    --port "$PORT" \
    --ssl-keyfile "$CERTS_DIR/localhost-key.pem" \
    --ssl-certfile "$CERTS_DIR/localhost.pem"
