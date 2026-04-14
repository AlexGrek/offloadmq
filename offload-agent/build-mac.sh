#!/usr/bin/env bash
# Build offload-agent as a macOS .app bundle with a menu-bar tray icon.
#
# Prerequisites:
#   - Python 3.10+ on PATH
#   - pdm available
#
# The script installs dependencies via pdm and
# produces dist/Offload Agent.app (a self-contained macOS application).
#
# Usage:
#   ./build-mac.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v pdm >/dev/null 2>&1; then
    echo "ERROR: pdm is required (install: python3 -m pip install --user pdm)." >&2
    exit 1
fi

# ── 2. Install dependencies ─────────────────────────────────────────────────
echo "Syncing dependencies via pdm ..."
pdm sync --group dev --group build

# ── 2b. Web UI (Vite) ───────────────────────────────────────────────────────
if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required to build frontend/dist (install Node.js)." >&2
    exit 1
fi
echo "Building web UI (frontend/dist) ..."
( cd "$SCRIPT_DIR/frontend" && npm ci && npm run build )

# ── 2c. Type-check ──────────────────────────────────────────────────────────
echo "Running mypy type check ..."
pdm run mypy

# ── 2d. Inject app version (same as make build / scripts/compute-agent-version.sh) ──
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
COMPUTE="${REPO_ROOT}/scripts/compute-agent-version.sh"
if [[ -n "$REPO_ROOT" && -f "$COMPUTE" ]]; then
    APP_VERSION="$(bash "$COMPUTE" "$REPO_ROOT")"
else
    _count=$(git -C "$SCRIPT_DIR" rev-list --count HEAD 2>/dev/null || echo "0")
    _tag=$(git -C "$SCRIPT_DIR" describe --tags --match 'release-*' --abbrev=0 2>/dev/null || true)
    if [[ -n "$_tag" ]]; then
        _ver="${_tag#release-}"
        _prefix="${_ver%.*}"
        APP_VERSION="${_prefix}.${_count}"
    else
        APP_VERSION="v0.1.${_count}"
    fi
fi
echo "APP_VERSION = '$APP_VERSION'" > "$SCRIPT_DIR/app/_version.py"
echo "Injected version: $APP_VERSION"

# ── 3. Build .app bundle ────────────────────────────────────────────────────
echo "Building Offload Agent.app ..."
pdm run pyinstaller \
    --noconfirm \
    --onefile \
    --windowed \
    --name "Offload Agent" \
    --paths "." \
    --add-data "app:app" \
    --add-data "webui.py:." \
    --add-data "webui_comfy.py:." \
    --add-data "frontend/dist:frontend/dist" \
    --hidden-import "pystray._darwin" \
    --hidden-import "webui" \
    --hidden-import "webui_comfy" \
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
    "offload-agent-mac.py"

APP="$SCRIPT_DIR/dist/Offload Agent.app"
echo ""
echo "Build complete: $APP"
echo ""
echo "To install LaunchAgent (autostart at login):"
echo "  \"$APP/Contents/MacOS/Offload Agent\" install launchd"
