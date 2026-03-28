#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KOKORO_DIR="$SCRIPT_DIR/kokoro-fastapi"
VENV_DIR="$SCRIPT_DIR/venv"
CERTS_DIR="$SCRIPT_DIR/certs"

# Detect venv bin path (Windows Git Bash vs Unix)
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    VENV_BIN="$VENV_DIR/Scripts"
else
    VENV_BIN="$VENV_DIR/bin"
fi

# ── mkcert ────────────────────────────────────────────────────────────────────
if ! command -v mkcert &>/dev/null; then
    echo "mkcert not found — installing via winget..."
    winget install --id FiloSottile.mkcert -e --accept-source-agreements --accept-package-agreements
    # Reload PATH so mkcert is found in this session
    export PATH="$PATH:/c/Users/$USERNAME/AppData/Local/Microsoft/WinGet/Packages/FiloSottile.mkcert_Microsoft.Winget.Source_8wekyb3d8bbwe"
    if ! command -v mkcert &>/dev/null; then
        echo "mkcert installed but not in PATH yet. Open a new terminal and re-run setup.sh."
        exit 1
    fi
fi

# ── Clone kokoro-fastapi ──────────────────────────────────────────────────────
if [ ! -d "$KOKORO_DIR" ]; then
    echo "Cloning remsky/kokoro-fastapi..."
    git clone https://github.com/remsky/kokoro-fastapi.git "$KOKORO_DIR"
else
    echo "kokoro-fastapi already cloned — skipping."
fi

# ── Python venv ───────────────────────────────────────────────────────────────
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtualenv..."
    python -m venv "$VENV_DIR"
fi

echo "Installing Python dependencies..."
"$VENV_BIN/pip" install --upgrade pip -q

# Use CPU requirements if present, otherwise fall back to main requirements
if [ -f "$KOKORO_DIR/requirements-cpu.txt" ]; then
    "$VENV_BIN/pip" install -r "$KOKORO_DIR/requirements-cpu.txt"
elif [ -f "$KOKORO_DIR/requirements.txt" ]; then
    "$VENV_BIN/pip" install -r "$KOKORO_DIR/requirements.txt"
else
    echo "No requirements.txt found in $KOKORO_DIR — check the cloned repo."
    exit 1
fi

# ── TLS certificates ──────────────────────────────────────────────────────────
if [ ! -f "$CERTS_DIR/localhost.pem" ]; then
    echo "Generating locally-trusted TLS certs..."
    mkcert -install
    mkcert -key-file "$CERTS_DIR/localhost-key.pem" \
           -cert-file "$CERTS_DIR/localhost.pem" \
           localhost 127.0.0.1
    echo "Certs written to $CERTS_DIR"
else
    echo "Certs already exist — skipping."
fi

echo ""
echo "Setup complete. Run ./start.sh (or 'make start') to launch the server."
