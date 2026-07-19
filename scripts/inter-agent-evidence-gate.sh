#!/usr/bin/env bash
# inter-agent-evidence-gate.sh [--all] [--dry-run] [--id <N>]
#
# LLM-MENTES evidence verifier for inter-agent completion claims.
# Wrapper around inter-agent-evidence-gate.py.
#
# Monitors agent_messages for completion-claim patterns (kesz, done,
# elkészült, COMPLETE, etc.) and verifies that referenced file paths
# actually exist on disk.
#
# COMPLEMENTS done-evidence-gate (which checks kanban card status=done).
# Together they cover: (a) card set to done with FALSE file ref,
# (b) message claims FALSE file ref regardless of card status.
#
# Usage:
#   scripts/inter-agent-evidence-gate.sh              # incremental (since last marker)
#   scripts/inter-agent-evidence-gate.sh --all         # check all messages
#   scripts/inter-agent-evidence-gate.sh --dry-run     # inspect only
#   scripts/inter-agent-evidence-gate.sh --id <N>      # check specific message

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_PY="$SCRIPT_DIR/inter-agent-evidence-gate.py"

if [ ! -f "$GATE_PY" ]; then
    echo "ERROR: $GATE_PY not found" >&2
    exit 1
fi

exec python3 "$GATE_PY" "$@"
