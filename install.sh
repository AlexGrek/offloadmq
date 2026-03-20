#!/usr/bin/env bash
# Offload Agent Auto-Install Script
# Usage: curl -fsSL https://github.com/AlexGrek/offloadmq/releases/download/__VERSION__/install.sh | bash
#        bash install.sh [--install-dir /usr/local/bin]
#
# To install a specific version:
#   curl -fsSL https://github.com/AlexGrek/offloadmq/releases/download/release-v0.2.219/install.sh | bash

set -euo pipefail

REPO="AlexGrek/offloadmq"
VERSION="__VERSION__"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="offload-agent"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Detect OS
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  OS_TAG="linux" ;;
  Darwin) OS_TAG="macos" ;;
  *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)   ARCH_TAG="amd64" ;;
  aarch64|arm64)  ARCH_TAG="arm64" ;;
  *)              echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET_NAME="${BINARY_NAME}-${OS_TAG}-${ARCH_TAG}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"

echo "Installing offload-agent ${VERSION} (${OS_TAG}/${ARCH_TAG})..."
echo "Downloading from: ${DOWNLOAD_URL}"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

if ! curl -fsSL -o "$TMP_FILE" "$DOWNLOAD_URL"; then
  echo "Download failed. Check that ${ASSET_NAME} exists in release ${VERSION}." >&2
  exit 1
fi

chmod +x "$TMP_FILE"

DEST="${INSTALL_DIR}/${BINARY_NAME}"

if [[ -w "$INSTALL_DIR" ]]; then
  mv "$TMP_FILE" "$DEST"
else
  echo "Installing to ${INSTALL_DIR} requires sudo..."
  sudo mv "$TMP_FILE" "$DEST"
fi

echo ""
echo "offload-agent installed to ${DEST}"
echo "Run 'offload-agent --help' to get started."
