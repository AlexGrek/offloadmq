#!/usr/bin/env bash
# Build and release agent_v2 to dl.alexgr.space
#
# Builds and uploads TWO targets for the current platform:
#   - CLI  (omq)      → omq-<os>-<arch>
#   - GUI  (omq-gui)  → omq-gui-<os>-<arch>
# Both land in the same bucket / os_arch slot, distinguished by filename.
#
# Usage:
#   ./scripts/release-agent.sh [version]
#
# If version is omitted it is auto-computed: major.minor from the latest
# release-* tag + current commit count as the build number.
# Example: latest tag release-v0.3.250, 260 commits → v0.3.260
# Falls back to v0.3.<count> when no release tag exists.
#
# Environment variables:
#   DL_API_KEY    (required) API key with release-create and release-write:offload-agent scopes
#   DL_BUCKET     Release bucket name (default: offload-agent)
#   DL_BASE_URL   Server base URL (default: https://dl.alexgr.space)
#   SKIP_BUILD    Set to 1 to reuse already-built binaries (CI uploads built artifacts)
#
# Examples:
#   DL_API_KEY=dlk_... ./scripts/release-agent.sh
#   DL_API_KEY=dlk_... ./scripts/release-agent.sh v0.3.250
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${REPO_ROOT}/agent_v2"
BASE_URL="${DL_BASE_URL:-https://dl.alexgr.space}"
BUCKET="${DL_BUCKET:-offload-agent}"

if [[ -z "${DL_API_KEY:-}" ]]; then
  echo "error: DL_API_KEY is not set" >&2
  exit 1
fi

# ── Version auto-detection ─────────────────────────────────────────────────────
# Takes major.minor from the latest release-* tag and replaces the build number
# with the current commit count.  Example: release-v0.3.250 + 260 commits → v0.3.260
# Falls back to v0.3.<count> when no release tag exists yet.

detect_version() {
  bash "${REPO_ROOT}/scripts/compute-agent-version.sh" "${REPO_ROOT}"
}

VERSION="${1:-$(detect_version)}"

# ── Detect platform ────────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_TAG="darwin" ;;
  Linux)  OS_TAG="linux"  ;;
  *)      echo "error: unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_TAG="amd64" ;;
  aarch64|arm64) ARCH_TAG="arm64" ;;
  *)             echo "error: unsupported arch: $ARCH" >&2; exit 1 ;;
esac

OS_ARCH="${OS_TAG}-${ARCH_TAG}"

# target name → (dist binary, uploaded filename)
CLI_DIST="${AGENT_DIR}/cli-manager/dist/omq"
GUI_DIST="${AGENT_DIR}/gui-manager/dist/omq-gui"
CLI_NAME="omq-${OS_ARCH}"
GUI_NAME="omq-gui-${OS_ARCH}"

echo "Platform: ${OS_ARCH}"
echo "Version:  ${VERSION}"
echo "Bucket:   ${BUCKET}"
echo "Targets:  ${CLI_NAME}, ${GUI_NAME}"
echo ""

# ── Build ──────────────────────────────────────────────────────────────────────

FRONTEND_DIST="${AGENT_DIR}/ui-server/frontend/dist"

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  echo "→ Skipping build (SKIP_BUILD=1)..."
  for f in "$CLI_DIST" "$GUI_DIST"; do
    if [[ ! -f "$f" ]]; then
      echo "error: SKIP_BUILD=1 but no binary found at ${f}" >&2
      exit 1
    fi
  done
else
  echo "→ Building frontend bundle..."
  ( cd "${AGENT_DIR}/ui-server/frontend" && npm ci && npm run build )
  if [[ ! -d "$FRONTEND_DIST" ]]; then
    echo "error: frontend dist not found at ${FRONTEND_DIST}" >&2
    exit 1
  fi

  echo "→ Syncing uv workspace..."
  ( cd "${AGENT_DIR}" && uv sync )

  echo "→ Stamping CLI version ${VERSION}..."
  printf '__version__ = "%s"\n' "${VERSION}" \
    > "${AGENT_DIR}/cli-manager/src/cli_manager/_version.py"

  echo "→ Building CLI (omq)..."
  ( cd "${AGENT_DIR}/cli-manager" && rm -rf build dist ./*.spec && \
    uv run --with pyinstaller pyinstaller --onefile --name omq \
      --add-data "../ui-server/frontend/dist:frontend/dist" \
      src/cli_manager/main.py )
  if [[ ! -f "$CLI_DIST" ]]; then
    echo "error: expected CLI binary not found at ${CLI_DIST}" >&2
    exit 1
  fi

  echo "→ Building GUI (omq-gui)..."
  ( cd "${AGENT_DIR}/gui-manager" && rm -rf build dist ./*.spec && \
    uv run --with pyinstaller pyinstaller --onefile --windowed --name omq-gui \
      --add-data "../ui-server/frontend/dist:frontend/dist" \
      src/gui_manager/main.py )
  if [[ ! -f "$GUI_DIST" ]]; then
    echo "error: expected GUI binary not found at ${GUI_DIST}" >&2
    exit 1
  fi
fi

# rename with platform suffix for upload
CLI_RENAMED="${AGENT_DIR}/cli-manager/dist/${CLI_NAME}"
GUI_RENAMED="${AGENT_DIR}/gui-manager/dist/${GUI_NAME}"
cp -f "$CLI_DIST" "$CLI_RENAMED"
cp -f "$GUI_DIST" "$GUI_RENAMED"
echo "→ CLI binary: ${CLI_RENAMED}"
echo "→ GUI binary: ${GUI_RENAMED}"

# ── Auth ───────────────────────────────────────────────────────────────────────

echo "→ Authenticating..."
TOKEN=$(curl -sS --fail \
  -X POST "${BASE_URL}/api/v1/auth/token" \
  -H "Authorization: Bearer ${DL_API_KEY}" | jq -r .token)

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "error: failed to obtain JWT — check DL_API_KEY" >&2
  exit 1
fi

# ── Ensure bucket exists ───────────────────────────────────────────────────────

echo "→ Ensuring bucket '${BUCKET}' exists..."
curl -sS \
  -X POST "${BASE_URL}/api/v1/release/create" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"bucket\":\"${BUCKET}\"}" \
  -o /dev/null || true

# ── Upload ─────────────────────────────────────────────────────────────────────

upload_target() {
  local file="$1" filename="$2"
  local attempt max_attempts=4 delay=20
  for attempt in $(seq 1 $max_attempts); do
    echo "→ Uploading ${filename} as ${VERSION} (attempt ${attempt}/${max_attempts})..."
    local http_status
    http_status=$(curl -sS --write-out "%{http_code}" -o /tmp/dl_upload_resp \
      --max-time 300 \
      -X POST "${BASE_URL}/api/v1/release/${BUCKET}/upload" \
      -H "Authorization: Bearer ${TOKEN}" \
      -F "version=${VERSION}" \
      -F "os_arch=${OS_ARCH}" \
      -F "file=@${file};filename=${filename}")
    if [[ "$http_status" == "201" ]]; then
      echo "  Latest: ${BASE_URL}/rs/${BUCKET}/latest/${OS_ARCH}/${filename}"
      return 0
    fi
    echo "  Upload returned HTTP ${http_status}:" >&2
    cat /tmp/dl_upload_resp >&2
    if [[ $attempt -lt $max_attempts ]]; then
      echo "  Retrying in ${delay}s..." >&2
      sleep $delay
    fi
  done
  echo "error: upload failed for ${filename} after ${max_attempts} attempts" >&2
  exit 1
}

upload_target "$CLI_RENAMED" "$CLI_NAME"
upload_target "$GUI_RENAMED" "$GUI_NAME"

echo ""
echo "Released ${BUCKET} ${VERSION} for ${OS_ARCH} (CLI + GUI)"
echo "  Landing: ${BASE_URL}/r/${BUCKET}"

# Release notes (macOS only, upload once per version)

if [[ "$OS_TAG" == "darwin" ]]; then
  echo ""
  echo "Generating release notes..."

  PREV_TAG=$(git -C "${REPO_ROOT}" describe --tags --match 'release-*' --abbrev=0 HEAD^ 2>/dev/null || true)
  if [[ -n "$PREV_TAG" ]]; then
    NOTES=$(git -C "${REPO_ROOT}" log "${PREV_TAG}..HEAD" --pretty=format:"- %s" --no-merges)
  else
    NOTES=$(git -C "${REPO_ROOT}" log --pretty=format:"- %s" --no-merges -20)
  fi

  NOTES_JSON=$(printf '%s' "$NOTES" | python3 -c 'import json,sys; print(json.dumps({"content": sys.stdin.read()}))')

  HTTP_NOTES=$(curl -sS --write-out "%{http_code}" -o /tmp/dl_notes_resp \
    -X PUT "${BASE_URL}/api/v1/release/${BUCKET}/versions/${VERSION}/docs/release-notes" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$NOTES_JSON")

  if [[ "$HTTP_NOTES" == "200" || "$HTTP_NOTES" == "201" || "$HTTP_NOTES" == "204" ]]; then
    echo "Release notes uploaded."
  else
    echo "warning: release notes upload failed (HTTP ${HTTP_NOTES})" >&2
    cat /tmp/dl_notes_resp >&2
  fi
fi
