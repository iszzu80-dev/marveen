#!/usr/bin/env bash
# health-watchdog: check agent session count and auth/routing/network errors. No LLM.
# exit 0 = all OK; exit 1 = issue detected (triggers Telegram alert after failThreshold).
#
# NOTE (2026-07-01): context-saturation detection was SPLIT OUT into the
# separate context-watchdog task (failThreshold=1 -- CTX_SAT is not transient,
# it never self-heals, so there is no point waiting for a 2nd confirmation).
# This task keeps failThreshold=2 for genuinely flaky signals (auth/routing/
# network errors can be a one-off blip that resolves itself).

AGENTS=$(tmux ls 2>/dev/null | grep -c "agent-" || true)
if [ "${AGENTS:-0}" -lt 5 ]; then
    echo "LOW_AGENTS: $AGENTS active (expected 5+)"
    exit 1
fi

if [ ! -d "$HOME/.claude-deepseek" ]; then
    echo "DEEPSEEK_ENV: missing ~/.claude-deepseek"
    exit 1
fi

ISSUES=""
for s in $(tmux ls 2>/dev/null | grep -oE "agent-[a-zA-Z0-9_-]+" | sort -u); do
    pane=$(tmux capture-pane -t "$s" -p 2>/dev/null | tail -15)
    if echo "$pane" | grep -qiE "401|403|auth.*error|invalid.*key|may not exist|model.*not found|ENOTFOUND|ECONNREFUSED"; then
        ISSUES="AUTH_ERR:$s $ISSUES"
    fi
done

if [ -n "$ISSUES" ]; then
    echo "$ISSUES"
    exit 1
fi

exit 0
