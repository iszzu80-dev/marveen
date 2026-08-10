#!/usr/bin/env bash
# limit-revive: unpark agents stuck on the Claude usage-limit modal. No LLM.
#
# 2026-07-03 CHANGE: converted from type=heartbeat (LLM prompt injected into
# codeworker/Cog's DeepSeek session, which burned its context every 30 min for
# a mostly no-op sweep -- Cog flagged it) to type=command. The logic was always
# pure deterministic bash (tmux capture + grep + send-keys), so it belongs as a
# host command that costs ZERO agent context. Same 30-min cadence, same safety
# function. Also removes the DeepSeek data-leak concern entirely (nothing runs
# in an LLM now).
#
# Silent (no output/log) when 0 parked. Exit 0 always.

REPO="$HOME/marveen"
TOKEN_FILE="$REPO/store/.dashboard-token"
MODAL='Stop and wait for limit to reset|Upgrade your plan|hit your.*limit|usage limit'
# Never touch the main marveen sessions or arbitrary non-agent panes.
SKIP='agent-codeworker'   # codeworker is the historical executor; leave it alone

parked=0; revived=0; parked_list=""
for s in $(tmux ls 2>/dev/null | grep -oE 'agent-[a-zA-Z0-9_-]+' | sort -u); do
    [ "$s" = "$SKIP" ] && continue
    if tmux capture-pane -t "$s" -p 2>/dev/null | tail -8 | grep -qiE "$MODAL"; then
        parked=$((parked+1)); parked_list="$parked_list ${s#agent-}"
        # Enter confirms the pre-selected "Stop and wait" option -> auto-resume on reset.
        tmux send-keys -t "$s" Enter 2>/dev/null
    fi
done

[ "$parked" -eq 0 ] && exit 0

# brief settle, then re-check which cleared
sleep 3
for s in $parked_list; do
    tmux capture-pane -t "agent-$s" -p 2>/dev/null | tail -8 | grep -qiE "$MODAL" || revived=$((revived+1))
done

# log counts only (no pane content)
if [ -f "$TOKEN_FILE" ]; then
    TS=$(date +%H:%M)
    curl -s -X POST http://localhost:3420/api/daily-log \
        -H "Content-Type: application/json" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
        -d "{\"agent_id\":\"marveen\",\"content\":\"## $TS limit-revive: parked=$parked revived=$revived\"}" >/dev/null 2>&1
    # if several parked at once, ping marveen (informational)
    if [ "$parked" -ge 3 ]; then
        curl -s -X POST http://localhost:3420/api/messages \
            -H "Content-Type: application/json" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
            -d "{\"from\":\"marveen\",\"to\":\"marveen\",\"content\":\"LIMIT-REVIVE: $parked agens egyszerre parkolt, feloldva $revived.\"}" >/dev/null 2>&1
    fi
fi
exit 0
