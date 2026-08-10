---
name: health-watchdog
description: 15 percenként: read-only agent health check, csak 2. előfordulásnál eszkalál
---

LIGHTWEIGHT HEALTH WATCHDOG (read-only, silent unless issue).

NOTE: This task runs as type=command (see task-config.json) -- the live logic lives in check.sh, this file is documentation only and is NOT executed as an LLM prompt. Keep it in sync with check.sh.

Run these checks (mirrors check.sh):
1. Agent sessions: sessions=$(tmux ls 2>/dev/null | grep -c "agent-"); echo "AGENTS: $sessions"
2. DeepSeek env: python3 -c "import os; ccr=os.path.expanduser('~/.claude-deepseek'); print('DEEPSEEK: OK' if os.path.exists(ccr) else 'DEEPSEEK: MISSING')"
3. Context saturation: for s in $(tmux ls 2>/dev/null | grep -oE "agent-[a-zA-Z0-9_-]+" | sort -u); do tmux capture-pane -t $s -p 2>/dev/null | tail -15 | grep -qiE "100% context used|context.*full" && echo "CTX_SAT: $s"; done
4. Auth/routing errors: for s in $(tmux ls 2>/dev/null | grep -oE "agent-[a-zA-Z0-9_-]+" | sort -u); do tmux capture-pane -t $s -p 2>/dev/null | tail -15 | grep -qiE "401|403|auth.*error|invalid.*key|may not exist|model.*not found|ENOTFOUND|ECONNREFUSED" && echo "AUTH_ERR: $s"; done

Rules:
- If all OK: SILENT. No log. No message. Return immediately.
- If same issue appears in THIS check AND it was flagged in previous check (check kanban_comments for 'watchdog:' in last 20 min): THEN send to deliverylead via API and log to daily-log.
- Single-occurrence issue: add watchdog comment to a scratch card (id: use daily-log instead) and wait for next cycle to confirm.
- NEVER repair automatically. Only escalate on 2nd consecutive detection.
- Do NOT send Telegram unless escalating a confirmed 2nd-occurrence issue to Istvan.

Log format (only on action): curl -s -X POST http://localhost:3420/api/daily-log -H "Content-Type: application/json" -H "Authorization: Bearer $(cat /home/iszzu/marveen/store/.dashboard-token)" -d '{"agent_id":"marveen","content":"## HH:MM watchdog: ISSUE detected (2nd occurrence) -- escalated to deliverylead"}'
