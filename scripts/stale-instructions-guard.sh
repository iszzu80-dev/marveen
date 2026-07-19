#!/usr/bin/env bash
# stale-instructions-guard.sh <agent-name>
#
# Pre-dispatch guard: check if agent has stale instructions BEFORE sending
# a new, long task. Called as part of the dispatch pipeline, similar to how
# dispatch-guard.sh checks for CTX_SAT.
#
# POLICY (rolling refresh, NOT mass restart):
#   Stale state alone triggers NOTHING. Action ONLY when:
#   (a) stale agent is about to receive a NEW, LONG task (this guard), OR
#   (b) human decision (--report flag for manual inspection).
#
#   Refresh a stale agent ONLY if:
#   (a) genuinely idle (no in-progress work in pane),
#   (b) clean worktree state (no uncommitted changes, or known safe state),
#   (c) snapshot/handoff first (git status/diff/recent-files saved).
#   NEVER multiple agents at once, NEVER mid-task.
#
# Exit codes:
#   0 = safe to dispatch (agent is current, or was stale but refreshed+当前)
#   1 = agent has no tmux session
#   2 = agent is stale AND NOT idle -- BLOCK dispatch, needs human decision
#   3 = loop-guard quarantine -- repeated refresh within window, needs human
#   4 = refresh triggered but did not settle
#
# Usage:
#   scripts/stale-instructions-guard.sh <agent-name>       # pre-dispatch check
#   scripts/stale-instructions-guard.sh <agent-name> --report  # human inspection only

set -euo pipefail

AGENT="${1:?usage: stale-instructions-guard.sh <agent-name> [--report]}"
MODE="${2:-dispatch}"  # dispatch | report

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STORE_DIR="$REPO_ROOT/store"
TOKEN_FILE="$STORE_DIR/.dashboard-token"
DASH_URL="http://localhost:3420"
SESSION="agent-${AGENT}"
DETECTOR="$SCRIPT_DIR/stale-instructions-detect.sh"

# Recovery / loop-guard state (shared with dispatch-guard.sh pattern)
RECOVERY_STATE="$STORE_DIR/recovery/stale-refresh-state.json"
RECOVERY_DIR_BASE="$STORE_DIR/recovery/$AGENT"
LOOP_WINDOW_SEC=7200   # 2 hours
LOOP_MAX=2             # max 2 refreshes per window

# Git evidence root(s)
LEGACY_ROOT="$HOME/marveen-legacy-20260630-013023"

mkdir -p "$STORE_DIR/recovery"

# --- 1. Check tmux session exists ---
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "MISSING_SESSION: $SESSION does not exist"
    exit 1
fi

# --- 2. Run the stale-instructions detector ---
STALE_RESULT=$("$DETECTOR" --agent "$AGENT" --json 2>/dev/null || echo '{"status":"ERROR"}')
STALE_STATUS=$(echo "$STALE_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','ERROR'))" 2>/dev/null || echo "ERROR")

if [ "$STALE_STATUS" != "STALE" ]; then
    echo "OK: $AGENT instructions are current (status=$STALE_STATUS), safe to dispatch"
    exit 0
fi

echo "STALE: $AGENT has stale instructions (CLAUDE.md newer than session start)"

# --- 3. In --report mode, just report and exit (human decision) ---
if [ "$MODE" = "report" ]; then
    DELTA=$(echo "$STALE_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('delta_sec','?'))" 2>/dev/null || echo "?")
    echo "REPORT: $AGENT is stale by ${DELTA}s. Human decision required."
    exit 0
fi

# --- 4. Pre-dispatch mode: check if agent is idle ---
# An idle agent shows the "bypass permissions" footer (ready prompt) and has
# no recent activity in the last 30s of scrollback.
pane_tail=$(tmux capture-pane -t "$SESSION" -p -S -30 2>/dev/null | tail -30)

is_idle=false
# Idle signal: the "bypass permissions" footer is present (ready prompt)
if echo "$pane_tail" | grep -q 'bypass permissions'; then
    # Also check there's no recent tool-call / work activity pattern
    if ! echo "$pane_tail" | grep -qiE 'tool_call|thinking|█|⏳|Processing|Executing'; then
        is_idle=true
    fi
fi

if ! $is_idle; then
    echo "BLOCKED: $AGENT is stale but appears BUSY (not idle). Will NOT refresh mid-task."
    echo "  Dispatch should WAIT or a human should decide."
    exit 2
fi

echo "IDLE: $AGENT appears idle, proceeding with worktree check"

# --- 5. Check worktree state ---
# Determine the agent's likely git worktree
# Priority: agent's CLAUDE.md mentions a repo, tmux pane shows a cwd
AGENT_WORKTREE=""
pane_cwd=$(tmux display-message -p -t "$SESSION" -F '#{pane_current_path}' 2>/dev/null || echo "")

# Try common worktree locations
for candidate in "$REPO_ROOT" "$LEGACY_ROOT" "$pane_cwd"; do
    if [ -n "$candidate" ] && [ -d "$candidate/.git" ]; then
        AGENT_WORKTREE="$candidate"
        break
    fi
done

WORKTREE_CLEAN=true
WORKTREE_DIRTY_FILES=""
if [ -n "$AGENT_WORKTREE" ]; then
    dirty=$(cd "$AGENT_WORKTREE" && git status --porcelain 2>/dev/null || echo "GIT_ERROR")
    if [ "$dirty" = "GIT_ERROR" ]; then
        echo "WARN: cannot check git status in $AGENT_WORKTREE"
        WORKTREE_CLEAN=false
    elif [ -n "$dirty" ]; then
        WORKTREE_CLEAN=false
        WORKTREE_DIRTY_FILES="$dirty"
    fi
else
    echo "WARN: no git worktree found for $AGENT, skipping worktree check"
fi

if ! $WORKTREE_CLEAN; then
    echo "BLOCKED: $AGENT worktree is NOT clean. Will NOT refresh with uncommitted changes."
    echo "Dirty files:"
    echo "$WORKTREE_DIRTY_FILES" | head -20
    echo "  Dispatch should WAIT or a human should decide."
    exit 2
fi

echo "CLEAN: worktree is clean, proceeding with loop-guard check"

# --- 6. Loop-guard: prevent repeated refreshes ---
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
    echo "QUARANTINE: $AGENT already refreshed $LOOP_MAX+ times in ${LOOP_WINDOW_SEC}s window -- NOT auto-restarting again"
    exit 3
fi

echo "PROCEED: loop-guard check passed, starting rolling refresh for $AGENT"

# --- 7. Snapshot / handoff (evidence capture) ---
TS=$(date +%Y%m%d-%H%M%S)
DIR="$RECOVERY_DIR_BASE/$TS"
mkdir -p "$DIR"

# Capture pane scrollback
tmux capture-pane -t "$SESSION" -p -S -2000 > "$DIR/pane-scrollback.txt" 2>/dev/null || true
tmux display-message -p -t "$SESSION" -F '#{pane_current_path}' > "$DIR/pane-cwd.txt" 2>/dev/null || true

# Git evidence from all possible worktrees
for wt in "$REPO_ROOT" "$LEGACY_ROOT"; do
    if [ -d "$wt/.git" ]; then
        wt_label=$(basename "$wt")
        ( cd "$wt" && git status --porcelain ) > "$DIR/git-status-${wt_label}.txt" 2>/dev/null || true
        ( cd "$wt" && git diff ) > "$DIR/git-diff-${wt_label}.txt" 2>/dev/null || true
        ( cd "$wt" && git diff --staged ) > "$DIR/git-diff-staged-${wt_label}.txt" 2>/dev/null || true
        ( cd "$wt" && git log --oneline -5 ) > "$DIR/git-log-${wt_label}.txt" 2>/dev/null || true
        # Recent files touched (last 2 hours)
        ( cd "$wt" && find . -mmin -120 -type f \
            -not -path './node_modules/*' -not -path '*/node_modules/*' \
            -not -path './.git/*' -not -path '*/.git/*' \
            -not -path './store/*' \
            2>/dev/null | head -100 ) > "$DIR/recent-files-${wt_label}.txt" || true
    fi
done

# Stale detection details
echo "$STALE_RESULT" > "$DIR/stale-detection.json"

# Kanban snapshot (what was the agent working on?)
if [ -f "$STORE_DIR/claudeclaw.db" ]; then
    python3 - "$STORE_DIR/claudeclaw.db" "$AGENT" > "$DIR/kanban-context.txt" 2>/dev/null <<'PYEOF' || true
import sqlite3, sys, json
db_path, agent = sys.argv[1], sys.argv[2]
db = sqlite3.connect(db_path)
# Try to find recent cards that might belong to this agent
# Look in comments or metadata for agent references
try:
    rows = db.execute("""
        SELECT c.id, c.title, c.status, c.priority
        FROM kanban_cards c
        WHERE c.status IN ('in_progress','planned')
        ORDER BY c.priority DESC, c.rowid DESC
        LIMIT 20
    """).fetchall()
    for r in rows:
        print(f"[{r[2]}|{r[3]}] {r[0][:8]}: {r[1]}")
except Exception:
    print("(kanban query failed)")
PYEOF
fi

echo "SNAPSHOT: evidence captured to $DIR"

# --- 8. Record the refresh in loop-guard state ---
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

# --- 9. Rolling refresh: restart the agent ---
TOKEN=$(cat "$TOKEN_FILE")

echo "RESTART: triggering fresh restart for $AGENT via dashboard API"
RESTART_RESULT=$(curl -s -X POST "$DASH_URL/api/agents/$AGENT/restart" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"fresh":true}' 2>/dev/null || echo "CURL_FAILED")

if [ "$RESTART_RESULT" = "CURL_FAILED" ]; then
    echo "ERROR: dashboard restart API call failed for $AGENT"
    exit 4
fi

# --- 10. Wait for the new session to settle ---
SETTLED=false
for i in $(seq 1 25); do
    sleep 2
    if ! tmux has-session -t "$SESSION" 2>/dev/null; then
        echo "WAIT: $SESSION gone, waiting for respawn... ($i/25)"
        continue
    fi
    newpane=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -20)
    # Readiness: bypass permissions footer visible, agent is idle
    if echo "$newpane" | grep -qE 'bypass permissions'; then
        SETTLED=true
        echo "SETTLED: $SESSION is ready after ${i}s"
        break
    fi
    echo "WAIT: $SESSION starting up... ($i/25)"
done

if ! $SETTLED; then
    echo "TIMEOUT: $SESSION restart did not settle within 50s. Evidence: $DIR"
    exit 4
fi

# --- 11. Brief the refreshed agent ---
BRIEF="Stale-instructions rolling refresh: a CLAUDE.md valtozas utan a session-ed ujraindult, mert a regi session meg a regi instruction-okkel futott. Elozmeny snapshot mentve: $DIR (pane-scrollback.txt, git-status, recent-files). Legutobbi aktivitasod / kanban kontextus: lasd kanban-context.txt a snapshotban. Kerlek folytasd a munkat ahol abbahagytad -- a git status/diff es a recent-files segithet. Ha bizonytalan vagy, kerdezz ra a deliverylead-nel vagy Marveen-nel."

curl -s -X POST "$DASH_URL/api/messages" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data @- >/dev/null <<JSONEOF
{"from":"marveen","to":"$AGENT","content":$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$BRIEF")}
JSONEOF

echo "BRIEFED: recovery-context message sent to $AGENT"
echo "REFRESHED: $AGENT is now running with current instructions, safe to dispatch"
echo "  Evidence: $DIR"

exit 0
