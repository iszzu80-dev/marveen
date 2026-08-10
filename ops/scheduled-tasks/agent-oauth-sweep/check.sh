#!/usr/bin/env bash
# agent-oauth-sweep: detect agents stuck on OAuth/login wall. No LLM.
# exit 0 = all clear; exit 1 = stuck agent detected (alert after failThreshold).

STUCK=""
for s in $(tmux ls 2>/dev/null | grep -oE "agent-[a-zA-Z0-9_-]+" | sort -u); do
    pane=$(tmux capture-pane -t "$s" -p 2>/dev/null | tail -20)
    if echo "$pane" | grep -qiE "claude\.ai.*login|sign in to claude|claude\.ai/login|Log in to Claude"; then
        STUCK="$s $STUCK"
    fi
done

if [ -n "$STUCK" ]; then
    echo "OAUTH_WALL: $STUCK"
    exit 1
fi

exit 0
