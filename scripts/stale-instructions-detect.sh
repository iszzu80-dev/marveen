#!/usr/bin/env bash
# stale-instructions-detect.sh [--agent <name>] [--json] [--all]
#
# LLM-MENTES detector: compare CLAUDE.md mtime vs tmux session start-time
# per agent. Pure shell/stat/tmux, NO LLM calls, 0 token cost.
#
# Checks BOTH the project-root CLAUDE.md AND the agent-specific
# agents/<name>/CLAUDE.md -- if EITHER is newer than the session start,
# the agent is "stale" (its loaded instructions are out of date).
#
# Exit codes:
#   0 = agent(s) checked, results emitted
#   1 = requested agent has no tmux session
#   2 = requested agent has no CLAUDE.md at all
#
# Usage:
#   scripts/stale-instructions-detect.sh --agent buildfejleszto
#   scripts/stale-instructions-detect.sh --all
#   scripts/stale-instructions-detect.sh --all --json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_DIR="$REPO_ROOT/agents"
ROOT_CLAUDE_MD="$REPO_ROOT/CLAUDE.md"

# Parse args
MODE=""
TARGET_AGENT=""
OUTPUT_JSON=false
ALL=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent) TARGET_AGENT="$2"; MODE="single"; shift 2 ;;
        --all) ALL=true; MODE="all"; shift ;;
        --json) OUTPUT_JSON=true; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [ -z "$MODE" ]; then
    echo "Usage: stale-instructions-detect.sh --agent <name> | --all [--json]"
    exit 1
fi

# Get root CLAUDE.md mtime (epoch)
ROOT_MTIME=""
if [ -f "$ROOT_CLAUDE_MD" ]; then
    ROOT_MTIME=$(stat -c %Y "$ROOT_CLAUDE_MD" 2>/dev/null || echo "")
fi

# --- Single agent check ---
check_agent() {
    local agent="$1"
    local session="agent-${agent}"

    # Check tmux session exists
    if ! tmux has-session -t "$session" 2>/dev/null; then
        return 1  # no session
    fi

    local agent_claude_md="$AGENTS_DIR/$agent/CLAUDE.md"
    local agent_mtime=""

    if [ -f "$agent_claude_md" ]; then
        agent_mtime=$(stat -c %Y "$agent_claude_md" 2>/dev/null || echo "")
    fi

    # No CLAUDE.md at all -> cannot determine
    if [ -z "$ROOT_MTIME" ] && [ -z "$agent_mtime" ]; then
        return 2  # no CLAUDE.md
    fi

    # Get the max CLAUDE.md mtime (newest relevant instruction file)
    local max_claude_mtime=0
    [ -n "$ROOT_MTIME" ] && [ "$ROOT_MTIME" -gt "$max_claude_mtime" ] && max_claude_mtime="$ROOT_MTIME"
    [ -n "$agent_mtime" ] && [ "$agent_mtime" -gt "$max_claude_mtime" ] && max_claude_mtime="$agent_mtime"

    # Get tmux session creation time
    local session_start
    session_start=$(tmux display-message -p -t "$session" -F '#{session_created}' 2>/dev/null || echo "")

    if [ -z "$session_start" ]; then
        return 1
    fi

    # Stale if CLAUDE.md is newer than session start
    local stale="ok"
    local delta=0
    if [ "$max_claude_mtime" -gt "$session_start" ]; then
        stale="STALE"
        delta=$((max_claude_mtime - session_start))
    fi

    # Output
    if $OUTPUT_JSON; then
        echo "{\"agent\":\"$agent\",\"status\":\"$stale\",\"session_start\":$session_start,\"claude_md_mtime\":$max_claude_mtime,\"delta_sec\":$delta}"
    else
        local session_hr claude_hr
        session_hr=$(date -d "@$session_start" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$session_start")
        claude_hr=$(date -d "@$max_claude_mtime" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$max_claude_mtime")
        echo "$agent|$stale|session=$session_hr|claude_md=$claude_hr|delta=${delta}s"
    fi

    return 0
}

# --- Main ---
if [ "$MODE" = "single" ]; then
    check_agent "$TARGET_AGENT"
    exit $?
fi

# --all mode
stale_count=0
ok_count=0
no_session_count=0
no_claude_count=0
first=true

if $OUTPUT_JSON; then
    echo "["
fi

for agent_dir in "$AGENTS_DIR"/*/; do
    agent=$(basename "$agent_dir")
    # Skip non-agent dirs
    [ ! -f "$agent_dir/CLAUDE.md" ] && continue

    set +e
    result=$(check_agent "$agent")
    rc=$?
    set -e

    if $OUTPUT_JSON; then
        $first || echo ","
        first=false
    fi

    case $rc in
        0)
            echo "$result"
            case "$result" in
                *'"status":"STALE"'*) stale_count=$((stale_count + 1)) ;;
                *) ok_count=$((ok_count + 1)) ;;
            esac
            ;;
        1)
            if $OUTPUT_JSON; then
                echo "{\"agent\":\"$agent\",\"status\":\"NO_SESSION\"}"
            else
                echo "$agent|NO_SESSION|tmux session not found"
            fi
            no_session_count=$((no_session_count + 1))
            ;;
        2)
            if $OUTPUT_JSON; then
                echo "{\"agent\":\"$agent\",\"status\":\"NO_CLAUDE_MD\"}"
            else
                echo "$agent|NO_CLAUDE_MD|no CLAUDE.md found"
            fi
            no_claude_count=$((no_claude_count + 1))
            ;;
    esac
done

if $OUTPUT_JSON; then
    echo ""
    echo "]"
    # Also emit summary on stderr so parsing stdout stays clean
    echo "{\"summary\":{\"stale\":$stale_count,\"ok\":$ok_count,\"no_session\":$no_session_count,\"no_claude_md\":$no_claude_count}}" >&2
else
    echo "---"
    echo "SUMMARY: stale=$stale_count ok=$ok_count no_session=$no_session_count no_claude_md=$no_claude_count"
fi

# Exit 0 even if some are stale -- the caller decides action
exit 0
