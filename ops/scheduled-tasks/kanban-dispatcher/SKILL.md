---
name: kanban-dispatcher
description: 10 percenkent: dispatch + 24h blocker vizsgalat + waiting unblock detection + spec-build handoff + waiting Telegram ping
---

KANBAN DISPATCHER (SQLite direct).

STEP 1 -- Standard dispatch:
SELECT id,title,assignee,status,updated_at FROM kanban_cards WHERE status IN (planned,in_progress) AND assignee IS NOT NULL AND archived_at IS NULL ORDER BY updated_at ASC
Skip: istvan/Istvan/marveen. Skip if last dispatcher: comment < 15 min ago.
in_progress + stale >30min: send reminder to assignee with MANDATORY kanban-update instruction.
planned + assignee has no active in_progress: send assignment.
2+ unanswered pings: escalate to deliverylead.

STEP 2 -- 24h blocker investigation (NEW):
For in_progress cards stale >24h: check if a blocker-check: comment exists in last 24h. If NOT:
- Send to assignee: "Card stale 24h+. Are you blocked? Reply: BLOCKED: [reason] or PROGRESS: [what done]. MANDATORY: update kanban."
- Add comment: blocker-check: sent at HH:MM
- If blocker-check was sent >4h ago with NO subsequent status update: send Telegram to Istvan via Bot API:
  BOT_TOKEN=$(grep BOT_TOKEN ~/.claude/channels/telegram/.env | cut -d= -f2 | tr -d '"')
  curl -s -X POST https://api.telegram.org/bot${BOT_TOKEN}/sendMessage -H "Content-Type:application/json" -d '{"chat_id":"8942301795","text":"Potencialis blocker: TITLE (ASSIGNEE) -- 24h+ stale, nem valaszolt. Megvizsgalom."}'
  Then investigate manually and report blocker to Istvan.

STEP 3 -- Spec-build handoff:
Find done spec cards (architect/ba/business, done in last 60min). Match title prefix (e.g. QQ-3, MK-F5) to planned build card. Handoff if: build planned, build assignee idle, no handoff: comment yet. Send spec deliverable path to build assignee.

STEP 4 -- Waiting unblock detection (NEW):
SELECT id,title,assignee FROM kanban_cards WHERE status='waiting' AND archived_at IS NULL AND assignee NOT IN ('istvan','Istvan','marveen')
For each: get latest comment. If the latest comment author is NOT 'marveen' (i.e. another agent responded):
- Set status to in_progress, update updated_at
- Send message to assignee: "Card unblocked: '<title>'. Latest update: <last_comment>. Continue and update kanban when done."
- Add comment: unblocked: at HH:MM, triggered by <last_comment_author> comment

STEP 5 -- Waiting blocker Telegram notification:
SELECT id,title,assignee FROM kanban_cards WHERE status=waiting AND archived_at IS NULL AND updated_at > (now-20*60)
For each: if no telegram-notified: comment -- get latest comment for blocker reason, send Telegram via Bot API, add telegram-notified: comment.

ADD dispatcher: comment after every send. SILENT if nothing to do.
