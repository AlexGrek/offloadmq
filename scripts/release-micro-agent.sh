#!/usr/bin/env bash
# Build and release micro-agent to dl.alexgr.space
#
# Usage:
#   ./scripts/release-micro-agent.sh [version]
#
# If version is omitted it is auto-computed using the same rules as release-agent.sh.
#
# Environment variables:
#   DL_API_KEY    (required) API key with release-create and release-write:micro-agent scopes
#   DL_BUCKET     Release bucket name (default: micro-agent)
#   DL_BASE_URL   Server base URL (default: https://dl.alexgr.space)
#   SKIP_BUILD    Set to 1 to skip the go build step (binary must already exist in micro-agent/dist/)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="${REPO_ROOT}/micro-agent"
BASE_URL="${DL_BASE_URL:-https://dl.alexgr.space}"
BUCKET="${DL_BUCKET:-micro-agent}"

if [[ -z "${DL_API_KEY:-}" ]]; then
  echo "error: DL_API_KEY is not set" >&2
  exit 1
fi

# ── Version ────────────────────────────────────────────────────────────────────

VERSION="${1:-$(bash "${REPO_ROOT}/scripts/compute-agent-version.sh" "${REPO_ROOT}")}"

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
BINARY_NAME="micro-agent-${OS_ARCH}"
DIST_DIR="${AGENT_DIR}/dist"
DIST_BINARY="${DIST_DIR}/${BINARY_NAME}"

echo "Platform: ${OS_ARCH}"
echo "Version:  ${VERSION}"
echo "Bucket:   ${BUCKET}"
echo ""

# ── Build ──────────────────────────────────────────────────────────────────────

mkdir -p "${DIST_DIR}"

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  echo "→ Skipping build (SKIP_BUILD=1)..."
  if [[ ! -f "${DIST_BINARY}" ]]; then
    echo "error: SKIP_BUILD=1 but no binary found at ${DIST_BINARY}" >&2
    exit 1
  fi
else
  echo "→ Building micro-agent..."
  GOOS="${OS_TAG}" GOARCH="${ARCH_TAG}" go build -C "${AGENT_DIR}" -o "${DIST_BINARY}" .
  echo "→ Binary: ${DIST_BINARY}"
fi

# ── Auth ───────────────────────────────────────────────────────────────────────

echo "→ Authenticating..."
TOKEN=$(curl -sS --fail \
  -X POST "${BASE_URL}/api/v1/auth/token" \
  -H "Authorization: Bearer ${DL_API_KEY}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

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

echo "→ Uploading ${BINARY_NAME} as ${VERSION}..."

HTTP_STATUS=$(curl -sS --write-out "%{http_code}" -o /tmp/dl_upload_resp \
  -X POST "${BASE_URL}/api/v1/release/${BUCKET}/upload" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "version=${VERSION}" \
  -F "os_arch=${OS_ARCH}" \
  -F "file=@${DIST_BINARY};filename=${BINARY_NAME}")

if [[ "$HTTP_STATUS" != "201" ]]; then
  echo "error: upload failed (HTTP ${HTTP_STATUS})" >&2
  cat /tmp/dl_upload_resp >&2
  exit 1
fi

echo ""
echo "Released ${BUCKET} ${VERSION} for ${OS_ARCH}"
echo "  Latest:  ${BASE_URL}/rs/${BUCKET}/latest/${OS_ARCH}/${BINARY_NAME}"
echo "  Landing: ${BASE_URL}/r/${BUCKET}"
