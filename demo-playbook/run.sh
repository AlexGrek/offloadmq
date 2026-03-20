#!/bin/bash
# Quick-start script to provision the demo agent
# Usage: ./run.sh [OPTIONS]
#   ./run.sh                          # Run with current inventory.yml
#   ./run.sh -v                       # Verbose mode
#   ./run.sh --force                  # Force re-registration
#   ./run.sh --local-binary PATH      # Use local binary instead of GitHub release

set -e

PLAYBOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PLAYBOOK_DIR"

# Parse arguments
EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
  case $1 in
    -v|--verbose)
      EXTRA_ARGS+=("-v")
      shift
      ;;
    --force)
      EXTRA_ARGS+=("-e" "offload_agent_force_register=true")
      shift
      ;;
    --local-binary)
      BINARY_PATH="$2"
      if [[ ! -f "$BINARY_PATH" ]]; then
        echo "Error: Binary not found: $BINARY_PATH"
        exit 1
      fi
      EXTRA_ARGS+=("-e" "offload_agent_install_method=local")
      EXTRA_ARGS+=("-e" "offload_agent_local_binary=$BINARY_PATH")
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--verbose] [--force] [--local-binary PATH]"
      exit 1
      ;;
  esac
done

echo "🚀 Provisioning OffloadMQ agent on 192.168.69.192..."
echo ""

ansible-playbook playbook.yml -i inventory.yml "${EXTRA_ARGS[@]}"

echo ""
echo "✅ Playbook complete!"
echo ""
echo "Next steps:"
echo "  1. SSH to the host: ssh 192.168.69.192"
echo "  2. Check status: systemctl status offload-agent"
echo "  3. View logs: journalctl -u offload-agent -f"
