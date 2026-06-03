#!/usr/bin/env bash
# Build a macOS installer (.pkg) for OffloadMQ Agent v2.
#
# Builds the React frontend, both PyInstaller binaries (omq-gui + omq),
# then packages them with pkgbuild/productbuild into agent_v2/installer-out/.
#
# Prerequisites:
#   - macOS (pkgbuild / productbuild)
#   - uv (https://docs.astral.sh/uv/)
#   - Node.js / npm
#
# Usage (from agent_v2/ or via Taskfile):
#   ./scripts/build-macos-installer.sh              # auto-detects version
#   ./scripts/build-macos-installer.sh v0.3.260     # explicit version
#   task installer:macos                          # via Taskfile

set -euo pipefail

VERSION="${1:-${VERSION:-}}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALLER_DIR="${SCRIPT_DIR}/macos-installer"
FRONTEND="${AGENT_DIR}/ui-server/frontend"
OUT_DIR="${AGENT_DIR}/installer-out"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

# ── Version ────────────────────────────────────────────────────────────────────

if [[ -z "${VERSION}" ]]; then
  REPO_ROOT="$(git -C "${AGENT_DIR}" rev-parse --show-toplevel 2>/dev/null || true)"
  COMPUTE="${REPO_ROOT}/scripts/compute-agent-version.sh"
  if [[ -n "${REPO_ROOT}" && -f "${COMPUTE}" ]]; then
    VERSION="$(bash "${COMPUTE}" "${REPO_ROOT}")"
  else
    count="$(git -C "${AGENT_DIR}" rev-list --count HEAD 2>/dev/null || echo "0")"
    tag="$(git -C "${AGENT_DIR}" describe --tags --match 'release-*' --abbrev=0 2>/dev/null || true)"
    if [[ -n "${tag}" ]]; then
      ver="${tag#release-}"
      prefix="${ver%.*}"
      VERSION="${prefix}.${count}"
    else
      VERSION="v0.3.${count}"
    fi
  fi
fi

echo "Building macOS installer for OffloadMQ Agent ${VERSION}"
echo ""

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS installer must be built on Darwin (macOS)." >&2
  exit 1
fi

for cmd in pkgbuild productbuild; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "error: ${cmd} not found (requires macOS Xcode Command Line Tools)." >&2
    exit 1
  fi
done

# ── Build frontend ─────────────────────────────────────────────────────────────

echo "-- npm ci"
( cd "${FRONTEND}" && npm ci )
echo "-- npm run build"
( cd "${FRONTEND}" && npm run build )

# ── uv sync ────────────────────────────────────────────────────────────────────

echo "-- uv sync"
( cd "${AGENT_DIR}" && uv sync )

# ── Stamp CLI version ──────────────────────────────────────────────────────────

printf '__version__ = "%s"\n' "${VERSION}" \
  > "${AGENT_DIR}/cli-manager/src/cli_manager/_version.py"

# ── Build CLI (omq) ──────────────────────────────────────────────────────────

echo "-- pyinstaller omq"
(
  cd "${AGENT_DIR}/cli-manager"
  rm -rf build dist ./*.spec
  uv run --with pyinstaller pyinstaller \
    --onefile \
    --name omq \
    --add-data "../ui-server/frontend/dist:frontend/dist" \
    src/cli_manager/main.py
)

# ── Build GUI (omq-gui) ───────────────────────────────────────────────────────

echo "-- pyinstaller omq-gui"
(
  cd "${AGENT_DIR}/gui-manager"
  rm -rf build dist ./*.spec
  uv run --with pyinstaller pyinstaller \
    --onefile \
    --windowed \
    --name omq-gui \
    --add-data "../ui-server/frontend/dist:frontend/dist" \
    src/gui_manager/main.py
)

CLI_BIN="${AGENT_DIR}/cli-manager/dist/omq"
GUI_BIN="${AGENT_DIR}/gui-manager/dist/omq-gui"
for f in "${CLI_BIN}" "${GUI_BIN}"; do
  if [[ ! -f "${f}" ]]; then
    echo "error: expected binary not found: ${f}" >&2
    exit 1
  fi
done

# ── Stage payload ──────────────────────────────────────────────────────────────

APP_ROOT="${WORK_DIR}/root/Applications/OffloadMQ Agent"
mkdir -p "${APP_ROOT}"
cp -f "${GUI_BIN}" "${CLI_BIN}" "${APP_ROOT}/"
chmod +x "${APP_ROOT}/omq-gui" "${APP_ROOT}/omq"

SCRIPTS_SRC="${INSTALLER_DIR}/scripts"
PKG_VERSION="${VERSION#v}"
EMPTY_ROOT="${WORK_DIR}/empty-root"
mkdir -p "${EMPTY_ROOT}"

stage_scripts() {
  local src_name="$1"
  local dest_dir="$2"
  mkdir -p "${dest_dir}"
  cp "${SCRIPTS_SRC}/${src_name}" "${dest_dir}/postinstall"
  chmod +x "${dest_dir}/postinstall"
}

for script in postinstall-app postinstall-path postinstall-autostart; do
  if [[ ! -f "${SCRIPTS_SRC}/${script}" ]]; then
    echo "error: missing ${SCRIPTS_SRC}/${script}" >&2
    exit 1
  fi
done

echo ""
echo "-- pkgbuild components"

SCRIPTS_APP="${WORK_DIR}/scripts-app"
stage_scripts postinstall-app "${SCRIPTS_APP}"
pkgbuild \
  --root "${WORK_DIR}/root" \
  --identifier "com.offloadmq.agent.app" \
  --version "${PKG_VERSION}" \
  --install-location "/" \
  --scripts "${SCRIPTS_APP}" \
  "${WORK_DIR}/omq-app.pkg"

SCRIPTS_PATH="${WORK_DIR}/scripts-path"
stage_scripts postinstall-path "${SCRIPTS_PATH}"
pkgbuild \
  --root "${EMPTY_ROOT}" \
  --identifier "com.offloadmq.path" \
  --version "${PKG_VERSION}" \
  --install-location "/" \
  --scripts "${SCRIPTS_PATH}" \
  "${WORK_DIR}/omq-path.pkg"

SCRIPTS_AUTOSTART="${WORK_DIR}/scripts-autostart"
stage_scripts postinstall-autostart "${SCRIPTS_AUTOSTART}"
pkgbuild \
  --root "${EMPTY_ROOT}" \
  --identifier "com.offloadmq.autostart" \
  --version "${PKG_VERSION}" \
  --install-location "/" \
  --scripts "${SCRIPTS_AUTOSTART}" \
  "${WORK_DIR}/omq-autostart.pkg"

# ── Product archive ────────────────────────────────────────────────────────────

mkdir -p "${OUT_DIR}"
OUT_FILE="${OUT_DIR}/omq-setup-${VERSION}-macos.pkg"

echo ""
echo "-- productbuild"
productbuild \
  --distribution "${INSTALLER_DIR}/Distribution.xml" \
  --package-path "${WORK_DIR}" \
  "${OUT_FILE}"

echo ""
echo "Installer ready: ${OUT_FILE}"
