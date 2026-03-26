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
BINARY_NAME="offload-agent-${OS_ARCH}"

echo "Platform: ${OS_ARCH}"
echo "Version:  ${VERSION}"
echo "Bucket:   ${BUCKET}"
echo ""

# ── Build ──────────────────────────────────────────────────────────────────────

DIST_BINARY="${AGENT_DIR}/dist/offload-agent"
RENAMED_BINARY="${AGENT_DIR}/dist/${BINARY_NAME}"

if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  echo "→ Skipping build (SKIP_BUILD=1)..."
  if [[ ! -f "$DIST_BINARY" && ! -f "$RENAMED_BINARY" ]]; then
    echo "error: SKIP_BUILD=1 but no binary found at ${DIST_BINARY}" >&2
    exit 1
  fi
else
  echo "→ Building offload-agent..."
  make -C "${AGENT_DIR}" build VERSION="${VERSION}" OFFLOAD_AGENT_VERSION="${VERSION}"
  if [[ ! -f "$DIST_BINARY" ]]; then
    echo "error: expected binary not found at ${DIST_BINARY}" >&2
    exit 1
  fi
fi

if [[ ! -f "$RENAMED_BINARY" ]]; then
  cp "$DIST_BINARY" "$RENAMED_BINARY"
fi
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
