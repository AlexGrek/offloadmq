#!/bin/bash
set -e

if [[ "$OSTYPE" != "linux-gnu"* ]]; then
    echo "This script is for Linux only. Use start.ps1 on Windows."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS_DIR="$SCRIPT_DIR/certs"

if [ ! -f "$CERTS_DIR/localhost.pem" ]; then
    echo "Certs not found. Run './setup.sh' first."
    exit 1
fi

docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d
echo "Kokoro TTS started — https://localhost:8443"
