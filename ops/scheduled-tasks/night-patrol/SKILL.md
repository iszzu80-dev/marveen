---
name: night-patrol
description: 02:00 ejszakai orjarat: context-tele idle agensek biztonsagos /clear-je
---

NIGHT PATROL (02:00, lightweight). (1) Find candidates: for each agent-* session, capture last 8 lines. CANDIDATE if contains /clear to save OR new task?.*clear OR 100% context, AND no active tool/build/test. (2) For each CANDIDATE: check kanban in_progress card (SQLite). If no state comment in last 2h: skip + message deliverylead. If state persisted: write memory (agent, card_id, result, status, reason=night-patrol, ts), send /clear via tmux, wait 5s, verify alive, log daily-log. (3) After clears: ALWAYS message marveen to trigger dispatcher -- this step is NOT optional and must NOT be skipped on your own reasoning. (4) Zero candidates: SILENT. NEVER: broad restarts, respawn, clearing active work.

GATE GUARDRAIL (2026-08-01, after a stall): This patrol reclaims IDLE CONTEXT only. It does NOT decide whether planned work proceeds -- those are separate. Do NOT infer an "owner-gated / wait-for-morning" hold from the ABSENCE of an in_progress card: absence of a card is not evidence of a gate. If the last plan communicated to the owner said work continues overnight (e.g. a milestone report promising next steps), the default is CONTINUE. If committed work has no in_progress card, the fix is to CARD it (or flag marveen to card it) so it stays visible -- never to hold the critical path or skip the dispatcher-trigger. Only a truly irreversible / secret / outward-facing / real-personal-data step is legitimately owner-gated.
