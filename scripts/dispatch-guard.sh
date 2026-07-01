#!/usr/bin/env bash
# dispatch-guard.sh <agent-name>
#
# Pre-dispatch guard (2026-07-01, tg-directed): shell/tmux/curl/python only,
# NO LLM call -- run this before sending a new inter-agent task so a
# context-saturated agent never receives work it cannot actually process.
#
# On CTX_SAT detection:
#   1. NEVER blind-respawn. First capture evidence (full pane scrollback,
#      git status/diff/staged-diff, recently-touched files) to
#      store/recovery/<agent>/<timestamp>/ so nothing is silently lost.
#   2. Loop-guard: if this agent has already auto-recovered LOOP_MAX times
#      within LOOP_WINDOW_SEC, do NOT restart again -- quarantine and exit
#      non-zero so the caller alerts a human instead.
#   3. Fresh restart via the dashboard API (kill+respawn is NOT gated by any
#      "session busy" check -- a saturated agent looks permanently busy and
#      would never clear that gate on its own).
#   4. Once the fresh session is idle, send it a short recovery-context
#      message (git status summary + recent files) via the inter-agent
#      message API so it can reorient -- this is a curl call, not an LLM
#      call, so it costs nothing extra to send automatically every time.
#
# Exit codes:
#   0 = safe to dispatch now (was fine, or was recovered and briefed)
#   1 = tmux session for this agent does not exist
#   2 = recovery triggered but did not settle within the wait window
#   3 = loop-guard quarantine -- repeated saturation, needs a human
#
# Usage: scripts/dispatch-guard.sh <agent-name>

set -euo pipefail

AGENT="${1:?usage: dispatch-guard.sh <agent-name>}"
SESSION="agent-${AGENT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_DIR="$SCRIPT_DIR/../store"
TOKEN_FILE="$STORE_DIR/.dashboard-token"
DASH_URL="http://localhost:3420"
CTX_PATTERN='100% context used|context.*full|context limit|auto-?compact required'
RECOVERY_STATE="$STORE_DIR/recovery/recovery-state.json"
RECOVERY_DIR_BASE="$STORE_DIR/recovery/$AGENT"
# Best-effort git-evidence root: the product code (all real work observed
# 2026-06-30/07-01) lives here, NOT under the agent's launch cwd -- pane
# pane_current_path is always the session's launch dir (agents/<name>),
# agents cd into this repo during their work, so it is the primary source.
LEGACY_ROOT="$HOME/marveen-legacy-20260630-013023"
LOOP_WINDOW_SEC=7200
LOOP_MAX=2

mkdir -p "$STORE_DIR/recovery"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "MISSING_SESSION: $SESSION"
    exit 1
fi

pane=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -15)

if ! echo "$pane" | grep -qiE "$CTX_PATTERN"; then
    echo "OK: $SESSION not saturated, safe to dispatch"
    exit 0
fi

LOOP_CHECK=$(python3 - "$AGENT" "$RECOVERY_STATE" "$LOOP_WINDOW_SEC" "$LOOP_MAX" <<'PYEOF'
import json, sys, time
agent, state_path, window, maxcount = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
now = int(time.time())
try:
    state = json.load(open(state_path))
except Exception:
    state = {}
events = [t for t in state.get(agent, []) if now - t < window]
print("QUARANTINE" if len(events) >= maxcount else "PROCEED")
PYEOF
)

if [ "$LOOP_CHECK" = "QUARANTINE" ]; then
    echo "QUARANTINE: $SESSION saturated $LOOP_MAX+ times in the last $((LOOP_WINDOW_SEC/60)) min -- NOT auto-restarting again, needs a human look"
    exit 3
fi

echo "CTX_SAT: $SESSION is context-saturated -- capturing evidence before recovery"

TS=$(date +%Y%m%d-%H%M%S)
DIR="$RECOVERY_DIR_BASE/$TS"
mkdir -p "$DIR"

tmux capture-pane -t "$SESSION" -p -S -2000 > "$DIR/pane-scrollback.txt" 2>/dev/null || true
tmux display-message -p -t "$SESSION" '#{pane_current_path}' > "$DIR/pane-cwd.txt" 2>/dev/null || true

GIT_ROOT_USED=""
if [ -d "$LEGACY_ROOT/.git" ]; then
    ( cd "$LEGACY_ROOT" && git status --porcelain ) > "$DIR/git-status.txt" 2>/dev/null || true
    ( cd "$LEGACY_ROOT" && git diff ) > "$DIR/git-diff.txt" 2>/dev/null || true
    ( cd "$LEGACY_ROOT" && git diff --staged ) > "$DIR/git-diff-staged.txt" 2>/dev/null || true
    ( cd "$LEGACY_ROOT" && find . -mmin -120 -type f -not -path './node_modules/*' -not -path '*/node_modules/*' -not -path './.git/*' -not -path '*/.git/*' 2>/dev/null | head -100 ) > "$DIR/recent-files.txt" || true
    GIT_ROOT_USED="$LEGACY_ROOT"
    echo "$LEGACY_ROOT" > "$DIR/git-root-used.txt"
fi

echo "EVIDENCE: captured to $DIR"

python3 - "$AGENT" "$RECOVERY_STATE" <<'PYEOF'
import json, sys, time, os
agent, state_path = sys.argv[1], sys.argv[2]
now = int(time.time())
try:
    state = json.load(open(state_path))
except Exception:
    state = {}
state.setdefault(agent, []).append(now)
state[agent] = [t for t in state[agent] if now - t < 86400]
os.makedirs(os.path.dirname(state_path), exist_ok=True)
json.dump(state, open(state_path, 'w'), indent=2)
PYEOF

TOKEN=$(cat "$TOKEN_FILE")
curl -s -X POST "$DASH_URL/api/agents/$AGENT/restart" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"fresh":true}' >/dev/null

for i in $(seq 1 20); do
    sleep 2
    newpane=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -20)
    # Readiness signal: the "bypass permissions" footer is present in every
    # ready Claude Code pane observed tonight regardless of role, and is more
    # robust than matching the bare prompt char, which can get pushed out of
    # a short tail window by verbose startup output (e.g. an /mcp banner) --
    # that false-negative was observed live on agent-deliverylead 2026-07-01.
    if echo "$newpane" | grep -qE 'bypass permissions' && ! echo "$newpane" | grep -qiE "$CTX_PATTERN"; then
        echo "RECOVERED: $SESSION fresh and idle"
        if [ -n "$GIT_ROOT_USED" ]; then
            MODIFIED_COUNT=$(wc -l < "$DIR/git-status.txt" 2>/dev/null | tr -d ' ')
            RECENT_COUNT=$(wc -l < "$DIR/recent-files.txt" 2>/dev/null | tr -d ' ')
            BRIEF="Auto-recovery: a session context-saturation miatt fresh-restartolt. Mielott elakadt, $MODIFIED_COUNT modositott/uncommitted fajl volt a $GIT_ROOT_USED repoban, $RECENT_COUNT fajl valtozott az utolso 2 oraban. Evidence mentve: $DIR (pane-scrollback.txt, git-status.txt, git-diff.txt, recent-files.txt). Nezd meg a legutobbi kanban kartyadat es folytasd onnan -- ha nem emlekszel mit csinaltal, a git status/diff a legjobb nyom."
            curl -s -X POST "$DASH_URL/api/messages" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
                --data @- >/dev/null <<JSONEOF
{"from":"marveen","to":"$AGENT","content":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$BRIEF")}
JSONEOF
            echo "BRIEFED: recovery-context message sent to $AGENT"
        fi
        exit 0
    fi
done

echo "TIMEOUT: $SESSION restart triggered but did not settle within 40s -- check manually. Evidence: $DIR"
exit 2
