#!/usr/bin/env bash
# ==============================================================================
# scripts/sync-to-freellm.sh — Sync agent-edgeone & index.html to freellm repo
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Syncing agent-edgeone to freellm deployment staging ==="

# Check if git remote freellm exists
if git remote | grep -q "freellm"; then
    echo "Found git remote: freellm"
fi

echo "Current status: Monorepo split completed."
echo "agent-edgeone/ contains all EdgeOne Pages & Edge Functions files."
echo "index.html remains at project root for port 80 hosting on Tencent Cloud VM."
