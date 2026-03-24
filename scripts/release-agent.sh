#!/usr/bin/env bash
# Build and release offload-agent to dl.alexgr.space
#
# Usage:
#   ./scripts/release-agent.sh [version]
#
# If version is omitted it is auto-computed: major.minor from the latest
# release-* tag + current commit count as the build number.
# Example: latest tag release-v0.3.250, 260 commits → v0.3.260
# Falls back to v0.1.<count> when no release tag exists.
#
# Environment variables:
#   DL_API_KEY    (required) API key with release-create and release-write:offload-agent scopes
#   DL_BUCKET     Release bucket name (default: offload-agent)
#   DL_BASE_URL   Server base URL (default: https://dl.alexgr.space)
#
# Examples:
#   DL_API_KEY=dlk_... ./scripts/release-agent.sh
#   DL_API_KEY=dlk_... ./scripts/release-agent.sh v0.3.250
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${REPO_ROOT}/offload-agent"
BASE_URL="${DL_BASE_URL:-https://dl.alexgr.space}"
BUCKET="${DL_BUCKET:-offload-agent}"

if [[ -z "${DL_API_KEY:-}" ]]; then
  echo "error: DL_API_KEY is not set" >&2
  exit 1
fi

# ── Version auto-detection ─────────────────────────────────────────────────────
# Takes major.minor from the latest release-* tag and replaces the build number
# with the current commit count.  Example: release-v0.3.250 + 260 commits → v0.3.260
# Falls back to v0.1.<count> when no release tag exists yet.

detect_version() {
  local count
  count=$(git -C "${REPO_ROOT}" rev-list --count HEAD 2>/dev/null || echo "0")

  local tag
  tag=$(git -C "${REPO_ROOT}" describe --tags --match 'release-*' --abbrev=0 2>/dev/null || true)
  if [[ -n "$tag" ]]; then
    # strip "release-" prefix and replace last numeric segment with commit count
    local ver="${tag#release-}"           # e.g. v0.3.250
    local prefix="${ver%.*}"              # e.g. v0.3
    echo "${prefix}.${count}"
  else
    echo "v0.1.${count}"
  fi
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
BINARY_NAME="offload-agent-${OS_ARCH}"

echo "Platform: ${OS_ARCH}"
echo "Version:  ${VERSION}"
echo "Bucket:   ${BUCKET}"
echo ""

# ── Build ──────────────────────────────────────────────────────────────────────

echo "→ Building offload-agent..."
make -C "${AGENT_DIR}" build VERSION="${VERSION}" OFFLOAD_AGENT_VERSION="${VERSION}"

DIST_BINARY="${AGENT_DIR}/dist/offload-agent"
if [[ ! -f "$DIST_BINARY" ]]; then
  echo "error: expected binary not found at ${DIST_BINARY}" >&2
  exit 1
fi

RENAMED_BINARY="${AGENT_DIR}/dist/${BINARY_NAME}"
cp "$DIST_BINARY" "$RENAMED_BINARY"
echo "→ Binary: ${RENAMED_BINARY}"

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
curl -sS --fail \
  -X POST "${BASE_URL}/api/v1/release/create" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"bucket\":\"${BUCKET}\"}" \
  -o /dev/null

# ── Upload ─────────────────────────────────────────────────────────────────────

echo "→ Uploading ${BINARY_NAME} as ${VERSION}..."

HTTP_STATUS=$(curl -sS --write-out "%{http_code}" -o /tmp/dl_upload_resp \
  -X POST "${BASE_URL}/api/v1/release/${BUCKET}/upload" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "version=${VERSION}" \
  -F "os_arch=${OS_ARCH}" \
  -F "file=@${RENAMED_BINARY};filename=${BINARY_NAME}")

if [[ "$HTTP_STATUS" != "201" ]]; then
  echo "error: upload failed (HTTP ${HTTP_STATUS})" >&2
  cat /tmp/dl_upload_resp >&2
  exit 1
fi

echo ""
echo "Released ${BUCKET} ${VERSION} for ${OS_ARCH}"
echo "  Latest:  ${BASE_URL}/rs/${BUCKET}/latest/${OS_ARCH}/${BINARY_NAME}"
echo "  Landing: ${BASE_URL}/r/${BUCKET}"
