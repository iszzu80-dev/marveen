#!/usr/bin/env bash
# verdict-posted-watchdog.sh  [--dry-run]
#
# Pane-sweep watchdog: detects agents that finished real work (completion-summary
# patterns visible in their tmux pane) but never posted the result to the inter-agent
# bus. This is the MECHANICAL check for card e5d77f80 item (b) -- the 3-case pattern
# where devops, frontendfejleszto, and uxuidesigner all finished work that sat only in
# their pane, invisible to fleet coordinators.
#
# Algorithm:
#   1. Query /api/agents for running agents + their tmux session names
#   2. For each agent (skip marveen, deliverylead, self):
#      a. Check tmux session exists
#      b. Classify pane state (idle/busy/stuck) -- only check IDLE agents
#      c. Search pane scrollback for completion-summary patterns
#      d. If patterns found: check DB for outbound messages from this agent
#         in last LOOKBACK_MIN minutes
#      e. If NO recent outbound message -> verdict-not-posted candidate
#      f. Rate-limit (don't re-alert same agent within RATE_LIMIT_SEC)
#      g. Capture evidence, alert deliverylead via inter-agent message
#
# Safety: only scans IDLE panes (never interrupts active work). Routes alerts to
# deliverylead for triage (same pattern as inter-agent-evidence-gate.py), NOT
# directly to Istvan -- this is a heuristic with false positives (e.g., an agent
# might have finished work but hasn't typed the summary yet, or uses unusual wording).
#
# Usage:
#   verdict-posted-watchdog.sh              # live scan
#   verdict-posted-watchdog.sh --dry-run    # print what would happen, no actions
set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_DIR="$SCRIPT_DIR/../store"
TOKEN_FILE="$STORE_DIR/.dashboard-token"
DASH_URL="http://localhost:3420"
STATE_FILE="$STORE_DIR/verdict-posted-state.json"
DB_PATH="$STORE_DIR/claudeclaw.db"

LOOKBACK_MIN="${VERDICT_LOOKBACK_MIN:-15}"    # how far back to check for outbound messages
RATE_LIMIT_SEC="${VERDICT_RATE_LIMIT_SEC:-3600}"  # don't re-alert same agent within 1h
SCROLLBACK_LINES="${VERDICT_SCROLLBACK_LINES:-60}" # how many lines of pane scrollback to scan
SKIP_AGENTS="marveen deliverylead devops"

[ -f "$TOKEN_FILE" ] || { echo "no dashboard token"; exit 0; }
TOKEN=$(cat "$TOKEN_FILE")

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [verdict-posted-watchdog] $*" || true; }

# --- completion-summary patterns (same concept as inter-agent-evidence-gate.py) ---
# Case-insensitive. Strong completion signals that suggest an agent FINISHED something.
# Avoid casual adjective uses like "what needs to be done".
COMPLETION_PATTERNS=(
  'K[EÉ]SZ[!.]?\s*$'
  'K[EÉ]SZ:\s'
  '\bK[AÁ]RTYA\s*K[EÉ]SZ'
  '\belk[eé]sz[üu]lt\s*'
  '\b(?:--\s*)?DONE\s*(?:[:!.]|$)'
  '\bCOMPLETE[D]?\s*(?:[:!.]|$)'
  '\b(?:Phase\s+\d+|Milestone)\s+(?:DONE|COMPLETE|K[EÉ]SZ)'
  '\bdelivered\s+\S+'
  '\bREADY\s*(?:[:!.]|$)'
  '\bDEPLOYED\s*(?:[:!.]|$)'
  '\bFINISHED\s*(?:[:!.]|$)'
  '\bMERGED\s*(?:[:!.]|$)'
  '\bVERDICT\s*:'
  '\bRESULT\s*:'
  '\bSUMMARY\s*:'
  '\bcommit\s+[a-f0-9]{7,}\b'
  '\bdeploy\s+(?:done|complete|ready|live)'
)

# Build a combined grep -E pattern
build_pattern() {
  local sep=""
  local pat=""
  for p in "${COMPLETION_PATTERNS[@]}"; do
    pat="${pat}${sep}(${p})"
    sep="|"
  done
  echo "$pat"
}

COMPLETION_RE=$(build_pattern)

# --- classify pane state (mirrors stuck-modal-guard.sh contract) ---
classify_pane() {
  local pane="$1"
  # empty / whitespace-only -> inconclusive
  if [ -z "$(printf '%s' "$pane" | tr -d '[:space:]')" ]; then
    echo "empty"; return
  fi
  # busy marker -> turn mid-flight
  if printf '%s' "$pane" | grep -qE 'esc to interrupt|\([0-9]+s (·|\.)'; then
    echo "busy"; return
  fi
  # idle footer -> healthy prompt
  if printf '%s' "$pane" | grep -qaF 'bypass permissions on' \
     || printf '%s' "$pane" | grep -qaF '? for shortcuts'; then
    echo "idle"; return
  fi
  # neither -> modal or indeterminate
  echo "stuck"
}

# --- check for outbound messages from an agent in last N minutes ---
has_recent_outbound() {
  local agent="$1" lookback_min="$2"
  local cutoff
  cutoff=$(date -d "$lookback_min minutes ago" +%s 2>/dev/null || echo 0)
  [ "$cutoff" = "0" ] && return 1  # safety: if date fails, assume no message

  if [ ! -f "$DB_PATH" ]; then
    log "DB not found at $DB_PATH -- assuming no recent outbound"
    return 1
  fi

  local count
  # created_at is INTEGER (epoch seconds). Compare directly with the epoch cutoff.
  # Sanitize agent name for SQLite: only [a-zA-Z0-9_-] allowed.
  local safe_agent
  safe_agent=$(echo "$agent" | tr -cd 'A-Za-z0-9_-')
  count=$(sqlite3 "$DB_PATH" \
    "SELECT COUNT(*) FROM agent_messages WHERE from_agent = '$safe_agent' AND created_at >= $cutoff" 2>/dev/null || echo 0)
  # strip whitespace
  count="${count//[^0-9]/}"
  [ "${count:-0}" -gt 0 ]
}

# --- alert deliverylead via inter-agent message ---
alert_deliverylead() {
  local agent="$1" evidence_file="$2" snippet="$3"
  local msg
  msg=$(cat <<'MSGEOF'
[VERDICT-NOT-POSTED WATCHDOG -- TRIAGE]

Agent: AGENT_PLACEHOLDER
Status: completion-summary patterns detected in tmux pane, but NO outbound bus message in last LOOKBACK_PLACEHOLDER min.

Pane evidence saved: EVIDENCE_PLACEHOLDER

Last pane snippet:
---
SNIPPET_PLACEHOLDER
---

Automatikus heurisztika, lehet false positive (meg kezzel gepel, unusual wording, etc.). Ellenorizd:
- tenyleg vegzett-e az agent (capture-pane a session-re)?
- ha igen, kuldj neki egy wake-up bus message-et vagy fresh-restart-ot
- CSAK ha confirmed missing verdict, eszkalald marveen-nek

NE menjen Istvanhoz triage nelkul.
MSGEOF
)
  msg="${msg//AGENT_PLACEHOLDER/$agent}"
  msg="${msg//LOOKBACK_PLACEHOLDER/$LOOKBACK_MIN}"
  msg="${msg//EVIDENCE_PLACEHOLDER/$evidence_file}"
  msg="${msg//SNIPPET_PLACEHOLDER/$snippet}"

  if [ "$DRY_RUN" = "1" ]; then
    log "DRY-RUN: would alert deliverylead about $agent"
    log "DRY-RUN: message preview: ${msg:0:200}..."
    return
  fi

  curl -s -X POST "$DASH_URL/api/messages" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    --data @- >/dev/null <<JSONEOF
{"from":"devops","to":"deliverylead","content":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$msg")}
JSONEOF
  log "alert sent to deliverylead about $agent"
}

# --- persist state ---
save_state() {
  local agent="$1" now="$2"
  python3 -c "
import json
p='$STATE_FILE'
try: s=json.load(open(p))
except Exception: s={}
s['$agent']=$now
json.dump(s,open(p,'w'),indent=2)
" 2>/dev/null || true
}

# --- main ---
now=$(date +%s)
alerts=0

# Get running agents from API
AGENTS_JSON=$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" "$DASH_URL/api/agents" 2>/dev/null)
if [ -z "$AGENTS_JSON" ]; then
  log "failed to fetch /api/agents"
  exit 0
fi

# Parse agent list: emit "<name> <session> <contextTokens>" for running agents with tmux sessions
AGENT_LIST=$(echo "$AGENTS_JSON" | python3 -c "
import json,sys
try: ags=json.load(sys.stdin)
except Exception: sys.exit(0)
for a in ags:
    name=a.get('name','')
    sess=a.get('session','')
    if not name or not sess: continue
    if not a.get('running'): continue
    print(name, sess, a.get('contextTokens',0))
" 2>/dev/null)

while read -r agent session ctx; do
  [ -z "${agent:-}" ] && continue
  case " $SKIP_AGENTS " in *" $agent "*) continue;; esac

  # Check tmux session exists
  tmux has-session -t "$session" 2>/dev/null || continue

  # Capture pane (recent scrollback for completion context)
  pane=$(tmux capture-pane -t "$session" -p -S -"$SCROLLBACK_LINES" 2>/dev/null || true)
  [ -z "$pane" ] && continue

  # Only check IDLE agents
  state=$(classify_pane "$pane")
  if [ "$state" != "idle" ]; then
    # log "skipping $agent: pane state=$state"
    continue
  fi

  # Search for completion-summary patterns (case-insensitive)
  matches=$(echo "$pane" | grep -iE "$COMPLETION_RE" 2>/dev/null || true)
  if [ -z "$matches" ]; then
    continue  # no completion patterns
  fi

  # Completion patterns found in idle pane -- check for recent outbound messages
  if has_recent_outbound "$agent" "$LOOKBACK_MIN"; then
    # Agent posted recently -- normal, verdict was delivered
    continue
  fi

  # Rate-limit check
  last_alert=$(python3 -c "
import json
try: s=json.load(open('$STATE_FILE'))
except Exception: s={}
print(s.get('$agent',0))
" 2>/dev/null)
  last_alert="${last_alert//[^0-9]/}"
  if [ $(( now - ${last_alert:-0} )) -lt "$RATE_LIMIT_SEC" ]; then
    log "skipping $agent: rate-limited (last alert $(( (now - ${last_alert:-0}) / 60 ))m ago)"
    continue
  fi

  # --- ALERT: verdict-not-posted candidate ---
  ts=$(date +%Y%m%d-%H%M%S)
  dir="$STORE_DIR/recovery/$agent/$ts-verdict-not-posted"
  mkdir -p "$dir"
  echo "$pane" > "$dir/pane-scrollback.txt" 2>/dev/null || true

  # Snippet: first 3 matching lines + context
  snippet=$(echo "$matches" | head -5 | sed 's/^/  /')

  log "VERDICT-NOT-POSTED candidate: $agent (session=$session, contextTokens=$ctx, state=$state)"
  alert_deliverylead "$agent" "$dir/pane-scrollback.txt" "$snippet"
  save_state "$agent" "$now"
  alerts=$((alerts + 1))

done <<< "$AGENT_LIST"

echo "verdict-posted-watchdog: alerts=$alerts$([ "$DRY_RUN" = 1 ] && echo ' (dry-run)')"
exit 0
