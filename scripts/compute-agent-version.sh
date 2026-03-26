#!/usr/bin/env bash
# Print the agent bundle version string (same rules as scripts/release-agent.sh).
# Usage: compute-agent-version.sh [REPO_ROOT]
# If REPO_ROOT is omitted, uses the Git top-level for the current working directory.
set -euo pipefail

if [[ -n "${1:-}" ]]; then
  REPO_ROOT="$1"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi

if [[ -z "${REPO_ROOT}" ]] || ! git -C "${REPO_ROOT}" rev-parse HEAD >/dev/null 2>&1; then
  echo "v0.0.0"
  exit 0
fi

count=$(git -C "${REPO_ROOT}" rev-list --count HEAD 2>/dev/null || echo "0")
tag=$(git -C "${REPO_ROOT}" describe --tags --match 'release-*' --abbrev=0 2>/dev/null || true)

if [[ -n "${tag}" ]]; then
  ver="${tag#release-}"
  prefix="${ver%.*}"
  echo "${prefix}.${count}"
else
  echo "v0.1.${count}"
fi
