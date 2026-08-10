#!/usr/bin/env bash
# context-watchdog: detect AND auto-recover agent context-saturation. No LLM.
#
# 2026-07-02 CHANGE (Istvan directive "menjen magatol tovabb, csak dontesnel
# szolj"): previously this task only DETECTED saturation and exited 1 to
# alert -- but nothing actually revived the agent, so a saturated orchestrator
# (observed: deliverylead/Maestro at 100% context) sat stuck silently until
# a human noticed. Now the watchdog REACTIVELY calls the existing, battle-
# tested dispatch-guard.sh (evidence capture + loop-guard + dashboard
# fresh-restart + recovery briefing) for each saturated agent, so recovery is
# automatic. Istvan is pinged ONLY when auto-recovery fails or quarantines
# (repeated saturation = needs a human), never for a clean auto-recovery.
#
# WHY failThreshold=1: context saturation is not transient -- if 100% now it
# stays 100%. Act on first detection; do not wait a cycle.
#
# Exit 0 always (self-contained: escalates via Bot API itself, so the
# scheduler does not double-handle). Logs actions to daily-log.
#
# 2026-07-20 (card d3f9fd90): GUARD resolves to releases/scheduled-scripts-current/,
# not dispatch-guard.sh in the shared checkout -- another agent's branch
# switch there must not silently break this watchdog's recovery path. Re-pin
# with: scripts/sync-scheduled-scripts.sh (run from ~/marveen).

REPO="$HOME/marveen"
export MARVEEN_REPO_ROOT="$REPO"
GUARD="$REPO/releases/scheduled-scripts-current/dispatch-guard.sh"
TOKEN_FILE="$REPO/store/.dashboard-token"
CHAT_ID="8942301795"
CTX_PATTERN='100% context used|context.*full|context limit|auto-?compact required'

log_daily() {
    [ -f "$TOKEN_FILE" ] || return 0
    curl -s -X POST http://localhost:3420/api/daily-log \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
        --data @- >/dev/null 2>&1 <<JSONEOF
{"agent_id":"marveen","content":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$1")}
JSONEOF
}

tg_istvan() {
    local env="$HOME/.claude/channels/telegram/.env"
    [ -f "$env" ] || return 0
    local bt; bt=$(grep BOT_TOKEN "$env" | cut -d= -f2 | tr -d '"' | tr -d "'")
    [ -n "$bt" ] || return 0
    curl -s -X POST "https://api.telegram.org/bot${bt}/sendMessage" \
        -H "Content-Type: application/json" \
        --data @- >/dev/null 2>&1 <<JSONEOF
{"chat_id":"$CHAT_ID","text":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$1")}
JSONEOF
}

SAT_AGENTS=""
for s in $(tmux ls 2>/dev/null | grep -oE "agent-[a-zA-Z0-9_-]+" | sort -u); do
    pane=$(tmux capture-pane -t "$s" -p 2>/dev/null | tail -15)
    if echo "$pane" | grep -qiE "$CTX_PATTERN"; then
        SAT_AGENTS="$SAT_AGENTS ${s#agent-}"
    fi
done

# All healthy -> silent.
[ -z "$SAT_AGENTS" ] && exit 0

for a in $SAT_AGENTS; do
    if [ ! -x "$GUARD" ]; then
        tg_istvan "context-watchdog: $a 100% context, de a dispatch-guard.sh nem futtathato. Kezi beavatkozas kell."
        continue
    fi

    # --- PRE-FLIGHT SAFETY GATE (Istvan 2026-07-17 policy) ------------------------
    # Saturation auto-restart is a NARROW exception. It is allowed only on a clean
    # 100%-context pane with no active tool/build/test, no interactive/auth prompt,
    # and no sensitive/irreversible operation in flight. Otherwise DO NOT auto-restart
    # -> escalate (owner recovery proposal). dispatch-guard already enforces fresh:true
    # (no --continue), one restart per window (quarantine), and evidence-packet capture.
    fp=$(tmux capture-pane -t "agent-$a" -p 2>/dev/null | tail -30)
    # (2) active tool / turn running -> not actually stuck; let it finish, no restart.
    if echo "$fp" | grep -qiE 'esc to interrupt|Effecting|Cooking|Brewing|Gitifying|Crunching|Considering|↓ [0-9]+(\.[0-9]+)?k? tokens'; then
        log_daily "## $(date +%H:%M) context-watchdog: $a 100% ctx BUT active tool/turn running -> NO auto-restart (cond.2). Left to finish."
        continue
    fi
    # (3) interactive approval / auth prompt -> restart would drop the prompt; escalate.
    if echo "$fp" | grep -qiE '1\. Yes|Would you like to proceed|manually approve|Ready to code|oauth/authorize|Authentication Fails|Restore the code|What should Claude do'; then
        log_daily "## $(date +%H:%M) context-watchdog: $a 100% ctx on an interactive/auth prompt -> NO auto-restart (cond.3). Escalated."
        tg_istvan "context-watchdog: $a 100% kontextus, DE interaktiv/auth prompton all -- NEM restartolok automatikusan (felulirna a jovahagyast/autht). Kezi beavatkozas kell."
        continue
    fi
    # forbidden domains: payment/auth/tenant/deploy/rollback/destructive-DB/external/irreversible.
    if echo "$fp" | grep -qiE 'payment|billing|barion|poskey|invoice|password|credential|secret|api[_-]?key|database_url|jwt|kms|drop |delete |truncate|force-push|git push -f|production deploy|prod deploy|rollback|s3:putobject|putobjectretention|send.*email|külso'; then
        log_daily "## $(date +%H:%M) context-watchdog: $a 100% ctx with a sensitive/irreversible op in flight -> NO auto-restart (forbidden domain). Escalated."
        tg_istvan "context-watchdog: $a 100% kontextus, DE erzekeny/visszafordithatatlan muvelet kozben (payment/auth/tenant/deploy/DB/kulso) -- NEM restartolok automatikusan. Kezi donto kell."
        continue
    fi
    # --- clean saturation -> safe narrow-exception auto-restart (dispatch-guard fresh:true)
    out=$("$GUARD" "$a" 2>&1); rc=$?
    case "$rc" in
        0) log_daily "## $(date +%H:%M) context-watchdog: $a context-saturated -> AUTO-RECOVERED (fresh restart + briefing). Nincs Istvan-riasztas." ;;
        2) log_daily "## $(date +%H:%M) context-watchdog: $a restart triggered de nem allt be 40s alatt -- Istvan ertesitve."
           tg_istvan "Auto-recovery figyelmeztetes: $a context-saturationbol restartolt, de nem allt be 40s alatt. Ranezek, de lehet kezi kell." ;;
        3) log_daily "## $(date +%H:%M) context-watchdog: $a QUARANTINE (ismetelt saturation 2h-n belul) -- Istvan ertesitve, human kell."
           tg_istvan "Ismetelt context-saturation: $a 2x+ tellett be 2 oran belul, az auto-recovery karantenba tette (nem restartolom ujra, vegtelen loop elkerulese). Ranezel? Ez mar valszeg strukturalis (tul nagy feladat / tul sok toldalek a promptban)." ;;
        1) tg_istvan "context-watchdog: $a sessionje eltunt (dispatch-guard: missing session). Ranezel?" ;;
        *) log_daily "## $(date +%H:%M) context-watchdog: $a dispatch-guard rc=$rc -- $out" ;;
    esac
done

exit 0
