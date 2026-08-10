---
name: build-done-monitor
description: 30 percenként: új done kártyák ellenőrzése és Istvan értesítése
---

Build-done monitor: check kanban_cards WHERE status=done AND updated_at > (now - 35 minutes) AND archived_at IS NULL. For each newly done card: (1) verify the deliverable is accessible (URL test for deploys, file check for specs/docs), (2) send Istvan a Telegram notification via reply tool to chat_id 8942301795 with what is ready to review and the direct URL/path, (3) queue the next task to the same agent. Do not send duplicate notifications -- check if a comment already exists on the card saying notification was sent. Add a comment after notifying.
