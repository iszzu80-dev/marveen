#!/usr/bin/env bash
# List agent tmux sessions with total process-tree RSS (GiB), sorted descending.
# Called by memory-pressure-gate.ts for active pressure relief (component C).
# Output: one line per agent: "<name> <rssGiB>"

set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then exit 0; fi

tmux ls 2>/dev/null | grep '^agent-' | while IFS=: read -r session _; do
  name="${session#agent-}"
  pids=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null)
  if [ -z "$pids" ]; then continue; fi

  rss_kb=0
  for pid in $pids; do
    children=$(ps -eo pid,ppid,rss --no-headers 2>/dev/null | \
      awk -v p="$pid" '$2==p || $1==p {r+=$3} END{print r+0}')
    rss_kb=$((rss_kb + children))
  done

  rss_gb=$(awk "BEGIN {printf \"%.4f\", $rss_kb / 1048576}")
  echo "$name $rss_gb"
done | sort -k2 -rn
