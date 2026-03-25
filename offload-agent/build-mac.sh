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

# ── 2b. Web UI (Vite) ───────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required to build frontend/dist (install Node.js)." >&2
    exit 1
fi
echo "Building web UI (frontend/dist) ..."
( cd "$SCRIPT_DIR/frontend" && npm ci && npm run build )

# ── 2c. Type-check ──────────────────────────────────────────────────────────
echo "Running mypy type check ..."
"$PYTHON" -m mypy

# ── 2d. Inject app version ──────────────────────────────────────────────────
_count=$(git -C "$SCRIPT_DIR" rev-list --count HEAD 2>/dev/null || echo "0")
_tag=$(git -C "$SCRIPT_DIR" describe --tags --match 'release-*' --abbrev=0 2>/dev/null || true)
if [[ -n "$_tag" ]]; then
    _ver="${_tag#release-}"
    _prefix="${_ver%.*}"
    APP_VERSION="${_prefix}.${_count}"
else
    APP_VERSION="v0.1.${_count}"
fi
echo "APP_VERSION = '$APP_VERSION'" > "$SCRIPT_DIR/app/_version.py"
echo "Injected version: $APP_VERSION"

# ── 3. Build .app bundle ────────────────────────────────────────────────────
echo "Building Offload Agent.app ..."
"$PYTHON" -m PyInstaller \
    --noconfirm \
    --onefile \
    --windowed \
    --name "Offload Agent" \
    --paths "." \
    --add-data "app:app" \
    --add-data "webui.py:." \
    --add-data "frontend/dist:frontend/dist" \
    --hidden-import "pystray._darwin" \
    --hidden-import "webui" \
    --hidden-import "app" \
    --hidden-import "app.config" \
    --hidden-import "app.ollama" \
    --hidden-import "app.core" \
    --hidden-import "app.httphelpers" \
    --hidden-import "app.capabilities" \
    --hidden-import "app.systeminfo" \
    --hidden-import "app.models" \
    --hidden-import "app.url_utils" \
    --hidden-import "app.websocket_client" \
    --hidden-import "app.cli" \
    --hidden-import "app.exec" \
    --hidden-import "app.exec.debug" \
    --hidden-import "app.exec.helpers" \
    --hidden-import "app.exec.llm" \
    --hidden-import "app.exec.shell" \
    --hidden-import "app.exec.shellcmd" \
    --hidden-import "app.exec.tts" \
    --hidden-import "app.data" \
    --hidden-import "app.data.fs_utils" \
    --hidden-import "app.data.updn" \
    --collect-submodules "app" \
    --osx-bundle-identifier "com.offloadmq.agent" \
    --info-plist '{"LSUIElement": true}' \
    "offload-agent-mac.py"

APP="$SCRIPT_DIR/dist/Offload Agent.app"
echo ""
echo "Build complete: $APP"
echo ""
echo "To install LaunchAgent (autostart at login):"
echo "  \"$APP/Contents/MacOS/Offload Agent\" install launchd"
