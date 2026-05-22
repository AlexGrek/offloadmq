#!/bin/bash
set -e

if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    echo "This script is for Linux only. Use setup.ps1 on Windows."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="$SCRIPT_DIR/certs"

# ── Docker ────────────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
    echo "Docker not found. Install Docker Engine: https://docs.docker.com/engine/install/"
    exit 1
fi
if ! docker compose version &>/dev/null 2>&1; then
    echo "Docker Compose v2 not found. Update Docker or install the compose plugin."
    exit 1
fi

# ── TLS certificates ──────────────────────────────────────────────────────────
if [ -f "$CERTS_DIR/localhost.pem" ]; then
    echo "Certs already exist — skipping."
else
    mkdir -p "$CERTS_DIR"
    openssl req -x509 -newkey rsa:4096 -nodes \
        -keyout "$CERTS_DIR/localhost-key.pem" \
        -out    "$CERTS_DIR/localhost.pem" \
        -days 3650 \
        -subj "/CN=localhost" \
        2>/dev/null
    echo "Self-signed cert written to $CERTS_DIR"
fi

echo ""
echo "Setup complete. Run 'make start' (or 'bash start.sh') to launch Kokoro TTS."
echo "First start will build the Docker image and download the model — may take several minutes."
