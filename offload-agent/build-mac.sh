#!/usr/bin/env bash
# Build offload-agent as a macOS .app bundle with a menu-bar tray icon.
#
# Prerequisites:
#   - Python 3.10+ on PATH
#   - pip available
#
# The script creates a venv, installs dependencies + PyInstaller, and
# produces dist/Offload Agent.app (a self-contained macOS application).
#
# Usage:
#   ./build-mac.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="$SCRIPT_DIR/venv-mac"

# ── 1. Create / reuse venv ──────────────────────────────────────────────────
if [ ! -x "$VENV_DIR/bin/pip" ]; then
    echo "Creating venv at $VENV_DIR ..."
    python3 -m venv "$VENV_DIR"
fi

PIP="$VENV_DIR/bin/pip"
PYTHON="$VENV_DIR/bin/python"

# ── 2. Install dependencies ─────────────────────────────────────────────────
echo "Installing dependencies ..."
"$PIP" install --quiet -r requirements.txt

echo "Installing PyInstaller ..."
"$PIP" install --quiet pyinstaller

# ── 3. Build .app bundle ────────────────────────────────────────────────────
echo "Building Offload Agent.app ..."
"$PYTHON" -m PyInstaller \
    --noconfirm \
    --onefile \
    --windowed \
    --name "Offload Agent" \
    --add-data "app:app" \
    --add-data "webui.py:." \
    --hidden-import "pystray._darwin" \
    --osx-bundle-identifier "com.offloadmq.agent" \
    --info-plist '{"LSUIElement": true}' \
    "offload-agent-mac.py"

APP="$SCRIPT_DIR/dist/Offload Agent.app"
echo ""
echo "Build complete: $APP"
echo ""
echo "To install LaunchAgent (autostart at login):"
echo "  \"$APP/Contents/MacOS/Offload Agent\" install launchd"
