#!/usr/bin/env bash
# fleet-context-guard.sh  [--dry-run]
#
# Two-tier proactive context-saturation guard (card e5d77f80 item c).
#
# WARN tier (>= CONTEXT_WARN_PCT, default 85%): alerts deliverylead via inter-agent
#   message but does NOT restart the agent. Rate-limited to WARN_RATE_LIMIT_SEC (2h).
#   Gives deliverylead a chance to manually fresh-restart BEFORE the agent freezes.
# CRITICAL tier (>= CONTEXT_RECOVER_PCT, default 92%): same behavior as before --
#   captures evidence, fresh-restarts via dashboard API, sends re-orient brief.
#   Rate-limited to RATE_LIMIT_SEC (1h). Only acts on IDLE agents (never interrupts
#   active work). Skips marveen.
#
# Thresholds are configurable via environment variables:
#   CONTEXT_WARN_PCT=85     # warn deliverylead at this %
#   CONTEXT_RECOVER_PCT=92  # auto-recover at this %
set -uo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_DIR="$SCRIPT_DIR/../store"
TOKEN_FILE="$STORE_DIR/.dashboard-token"
DASH_URL="http://localhost:3420"
STATE_FILE="$STORE_DIR/fleet-context-state.json"
WARN_STATE_FILE="$STORE_DIR/fleet-context-warn-state.json"
THRESHOLD="${CONTEXT_RECOVER_PCT:-92}"       # % of context window that triggers proactive recovery (env-overridable)
WARN_THRESHOLD="${CONTEXT_WARN_PCT:-85}"     # % of context window that triggers a WARN alert to deliverylead (no restart)
RATE_LIMIT_SEC=3600          # do not re-recover the same agent within 1h
WARN_RATE_LIMIT_SEC=7200     # do not re-warn the same agent within 2h
SKIP_AGENTS="marveen"

[ -f "$TOKEN_FILE" ] || { echo "no dashboard token"; exit 0; }
TOKEN=$(cat "$TOKEN_FILE")

# Two-tier detection: parse /api/agents, map model -> context window.
# Emit "<agent> <pct> <level>" lines (level=warn|critical) for agents at/over WARN_THRESHOLD.
OVER=$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" "$DASH_URL/api/agents" 2>/dev/null | python3 -c "
import json,sys
WARN=$WARN_THRESHOLD
CRIT=$THRESHOLD
# effective context windows (empirically: sonnet-5/opus run to ~1M; deepseek froze ~176k)
WIN={'claude-sonnet-5':1000000,'claude-opus-4-8':1000000,'claude-opus-4-8[1m]':1000000,'deepseek-v4-pro':180000}
try: ags=json.load(sys.stdin)
except Exception: sys.exit(0)
for a in ags:
    ct=a.get('contextTokens') or 0
    if not ct: continue
    win=WIN.get(a.get('model'),200000)
    pct=round(100*ct/win)
    if pct>=CRIT: print(a.get('name'),pct,'critical')
    elif pct>=WARN: print(a.get('name'),pct,'warn')
" 2>/dev/null)

now=$(date +%s)
recovered=0
warned=0

while read -r agent pct level; do
    [ -z "${agent:-}" ] && continue
    case " $SKIP_AGENTS " in *" $agent "*) continue;; esac
    sess="agent-$agent"
    tmux has-session -t "$sess" 2>/dev/null || continue

    pane=$(tmux capture-pane -t "$sess" -p 2>/dev/null | tail -25)
    # only recover an IDLE agent (never interrupt an active turn)
    echo "$pane" | grep -qE 'esc to interrupt' && continue
    echo "$pane" | grep -qE 'bypass permissions' || continue

    # --- WARN tier: alert deliverylead only, no restart ---
    if [ "$level" = "warn" ]; then
      last_warn=$(python3 -c "
import json
try: s=json.load(open('$WARN_STATE_FILE'))
except Exception: s={}
print(s.get('$agent',0))
" 2>/dev/null)
      last_warn="${last_warn//[^0-9]/}"
      if [ $(( now - ${last_warn:-0} )) -ge "$WARN_RATE_LIMIT_SEC" ]; then
        if [ "$DRY_RUN" = "1" ]; then
          echo "WOULD-WARN: $agent (${pct}% context, idle) -> deliverylead"
        else
          WARN_MSG="[CONTEXT-GUARD WARN] ${agent} ~${pct}% context (warn: ${WARN_THRESHOLD}%, recover: ${THRESHOLD}%). Meg nem kritikus, de figyeld -- ha tovabb no es eleri a ${THRESHOLD}%-ot, auto-recovery indul. Ha ez az agent eppen dolgozik valamin, erdemes lehet manualisan fresh-restartolni MEG MIELOTT nema befagyashoz vezet."
          curl -s -X POST "$DASH_URL/api/messages" \
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
            --data @- >/dev/null <<JSONEOF
{"from":"devops","to":"deliverylead","content":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$WARN_MSG")}
JSONEOF
        fi
        python3 -c "
import json
p='$WARN_STATE_FILE'
try: s=json.load(open(p))
except Exception: s={}
s['$agent']=$now
json.dump(s,open(p,'w'),indent=2)
" 2>/dev/null || true
        warned=$((warned+1))
      fi
      continue
    fi

    # --- CRITICAL tier: recovery ---
    # rate-limit
    last=$(python3 -c "
import json
try: s=json.load(open('$STATE_FILE'))
except Exception: s={}
print(s.get('$agent',0))
" 2>/dev/null)
    [ $(( now - ${last:-0} )) -lt $RATE_LIMIT_SEC ] && continue

    if [ "$DRY_RUN" = "1" ]; then
        echo "WOULD-RECOVER: $agent (${pct}% context, idle)"
        continue
    fi

    # 1) evidence
    ts=$(date +%Y%m%d-%H%M%S)
    dir="$STORE_DIR/recovery/$agent/$ts-proactive"
    mkdir -p "$dir"
    tmux capture-pane -t "$sess" -p -S -2000 > "$dir/pane-scrollback.txt" 2>/dev/null || true
    echo "${pct}% context (proactive, pre-freeze)" > "$dir/reason.txt"

    # 2) fresh restart
    curl -s -X POST "$DASH_URL/api/agents/$agent/restart" \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d '{"fresh":true}' >/dev/null

    # 3) wait for ready, then brief
    for i in $(seq 1 20); do
        sleep 2
        np=$(tmux capture-pane -t "$sess" -p 2>/dev/null | tail -20)
        if echo "$np" | grep -qE 'bypass permissions' && ! echo "$np" | grep -qiE '100% context'; then
            BRIEF="Proactive context-recovery: fresh-restartoltalak, mert ~${pct}%-on voltal a context-limithez es idle -> megelozzuk a nema befagyast. Evidence (elozo pane): $dir/pane-scrollback.txt. Nezd meg a legutobbi in_progress kanban kartyadat es folytasd onnan; ha nem emlekszel a reszletekre, a kartya kommentjei + git status a legjobb nyom."
            curl -s -X POST "$DASH_URL/api/messages" -H "Authorization: Bearer $TOKEN" \
                -H "Content-Type: application/json" --data @- >/dev/null <<JSONEOF
{"from":"marveen","to":"$agent","content":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$BRIEF")}
JSONEOF
            break
        fi
    done

    python3 -c "
import json
p='$STATE_FILE'
try: s=json.load(open(p))
except Exception: s={}
s['$agent']=$now
json.dump(s,open(p,'w'),indent=2)
"
    echo "RECOVERED: $agent (was ${pct}% context, idle -> fresh restart + brief)"
    recovered=$((recovered+1))
done <<< "$OVER"

echo "fleet-context-guard: warned=$warned recovered=$recovered$([ "$DRY_RUN" = 1 ] && echo ' (dry-run)')"
exit 0
