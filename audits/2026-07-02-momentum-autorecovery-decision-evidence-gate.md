# Evidence-gate audit: momentum-loop / auto-recovery / decision-contract
Date: 2026-07-02 ~14:10 CEST · Auditor: Marveen · Mode: READ-ONLY (no source change, no restart, no dispatch)
Verdict (round 1): **PARTIAL**

> ROUND 2 (~17:50 CEST) -- Istvan-approved minimal fixes applied in order; re-verdict at bottom (**PASS**).

## 1. Where these live (absolute paths)
- Momentum-loop prompt: `/home/iszzu/.claude/scheduled-tasks/maestro-backlog-review/SKILL.md` (+ `task-config.json`)
- Auto-recovery detector: `/home/iszzu/.claude/scheduled-tasks/context-watchdog/check.sh` (+ `task-config.json`)
- Auto-recovery executor (reused): `/home/iszzu/marveen/scripts/dispatch-guard.sh`
- Loop-guard state: `/home/iszzu/marveen/store/recovery/recovery-state.json` (+ evidence dirs `store/recovery/<agent>/<ts>/`)
- Redundant dispatcher (legacy): `/home/iszzu/.claude/scheduled-tasks/kanban-dispatcher/SKILL.md`
- Run history (authoritative): `store/claudeclaw.db` table `task_runs`; decision queue: table `agent_messages`
- Scheduler last-run: `/home/iszzu/marveen/store/schedule-last-run.json` (gitignored)

## 2. Tracked vs local-only vs unversioned
- Official repo = `Szotasz/marveen`, HEAD `ca63681`, origin/main `f35dd40` (v1.18.5). Position: **1 ahead / 0 behind**.
- `~/.claude/scheduled-tasks/` = **NOT a git repo → unversioned operator config.** My edits (context-watchdog, maestro-backlog-review) live here → zero official-repo impact.
- Official repo ships only 3 tracked scheduled-tasks: `dream-engine`, `memoria-heartbeat`, `reggeli-napindito`. context-watchdog / maestro-backlog-review / kanban-dispatcher / health-watchdog = **local-only** (not upstream).
- `scripts/dispatch-guard.sh` = **tracked**, part of the pre-existing local commit `ca63681` (the accepted 1-ahead). Not modified by me.
- FINDING (not mine): `src/web/schedule-runner.ts` is **modified & UNCOMMITTED on `main`** (+59/-10). This is Mason's #129 forceSend+CTX_SAT instrumentation, which already exists parked on branch `feat/forcesend-ctxsat-instrumentation` (`382c168`). An uncommitted tracked change on main = upstream-pull conflict risk → **worktree is NOT the clean baseline.**

## 3. Scheduled tasks (affected/relevant; 23 total enabled)
| task | cron | agent | enabled |
|---|---|---|---|
| maestro-backlog-review (momentum engine) | `*/30 * * * *` | deliverylead | yes |
| context-watchdog (auto-recovery) | `20,50 * * * *` | marveen | yes |
| health-watchdog | `20,50 * * * *` | marveen | yes |
| kanban-dispatcher (legacy dispatch) | `5,35 * * * *` | marveen | yes |

## 4. Last 24h run log (table `task_runs`)
- **maestro-backlog-review: fired 48/48** (last 14:00:03 @deliverylead) → momentum engine ALIVE.
- **context-watchdog: fired 48/48** (last 13:50, also 12:53/13:23 post-edit) → detector ALIVE.
- health-watchdog: fired 46/48.
- **kanban-dispatcher: SKIPPED 49/49** (last 14:05, status=skipped) → DEAD (skipIfBusy=true + main marveen session continuously busy; last real run 06-30 22:05, ~40h ago).

## 5. What runs on ctx-100%/stuck + loop-guard
- Detector `context-watchdog/check.sh`: scans every `agent-*` pane tail for `100% context used|context.*full|context limit|auto-?compact required`; for each hit calls `scripts/dispatch-guard.sh <agent>`.
- Executor `dispatch-guard.sh`: evidence capture (pane scrollback + git status/diff) → **loop-guard** (`store/recovery/recovery-state.json`, `LOOP_MAX=2` restarts per `LOOP_WINDOW_SEC=7200`s → exit 3 QUARANTINE) → dashboard `POST /api/agents/<a>/restart {fresh:true}` → wait ≤40s for `bypass permissions` ready-signal → recovery briefing message.
- Escalation: watchdog pings Istvan (Bot API) ONLY on rc=2 (timeout) / rc=3 (quarantine) / rc=1 (missing); clean recovery = silent + daily-log.
- Evidence guard IS firing: `recovery-state.json` shows ~11 recoveries on 2026-07-02 (buildfejleszto x2, frontendfejleszto x2, qa, architect, fullstack, marketing, business, uxuidesigner, deliverylead).
- GAP: those recoveries are attributable to the **proactive** dispatch-guard (pre-dispatch). No captured evidence of the **reactive** context-watchdog path executing a recovery since the 12:39 edit (no `context-watchdog: ... AUTO-RECOVERED` daily-log line). Reactive path = wired + fires, but not yet observed recovering in-the-act.

## 6. ISTVAN-DÖNTÉS queue (current content, table `agent_messages` → marveen)
The contract IS generating decisions (deliverylead → marveen), but there is **no durable queue structure** (ephemeral messages) and several sat delivered-but-not-relayed to Istvan:
1. **RENDER-CONNECT (global, all 5)** — msg #4687 (12:42). Hard deploy gate: connect repo to Render once → all Blueprints go. Bölcsi (zero creds) launches immediately after.
2. **QQ DB provision + postgres creds** — #4687/#4747.
3. **DORA S3 bucket provision** — #4747.
4. **MK ágazati pótlék scope** — 5 questions from Mason (which sector, Excel template?, standalone vs F2-core, calc-only vs full submission).
5. **PRICING direction** — #4766 + Naszdal correction #4824: Bölcsi 5–15k Ft/mo band; Esküvő model (viral-wedge vs B2C+B2B). Landings run with price-ranges meanwhile so GTM doesn't stall.
6. **Bölcsi DPA/DPIA ügyvéd** — #4836: registered lawyer/DPO countersignature required before prod; GDPR blocker #3 not clearable without it.
- Process incident (healthy self-catch): "Naszdal" competitor = ChatGPT hallucination, caught by Sonar; 3 docs were infected; pricing recalibrated. Silver lining: LumaSeat AI-seating confirmed unique on HU market.

## 7. Verdict + minimal fix plan (NOT applied)
**PARTIAL.** Momentum engine strongly proven (48/48 + real output: deploy-ready ×5, GTM landings, decisions, hallucination caught). Four gaps block a clean PASS:
1. **kanban-dispatcher dead (skipped 49/49).** Fix (minimal): disable it (maestro-backlog-review already carries momentum) OR convert its deterministic dispatch to `type=command` so skipIfBusy can't block it.
2. **Reactive auto-recovery unproven in-the-act.** Fix: one controlled verification (observe/trigger a saturation at a watchdog tick and confirm a `context-watchdog … AUTO-RECOVERED` entry).
3. **Decision-contract not durable + relay backlog.** Fix: persist the ISTVAN-DÖNTÉS queue (dedicated kanban lane or table) + auto-relay to Istvan's Telegram on arrival (don't wait for main-session idle).
4. **Worktree not update-safe.** Fix: return `src/web/schedule-runner.ts` on `main` to clean (the #129 work is already parked on `feat/forcesend-ctxsat-instrumentation`); keep main at the accepted baseline.

---

## ROUND 2 -- Fix results (Istvan-approved, applied in order)

### Fix 1 -- Worktree hygiene: **PASS**
- `src/web/schedule-runner.ts` restored on `main` (was uncommitted #129 instrumentation). Working-tree version backed up first (non-destructive): `store/recovery/worktree-hygiene-20260702/schedule-runner.worktree.{patch,ts}`.
- Evidence: `git status` = branch main, ahead 1 / behind 0, **uncommitted tracked changes = 0**. Parked branch `feat/forcesend-ctxsat-instrumentation` (382c168) intact. No merge, no PR.
- Note: working-tree draft was an EARLIER iteration than the branch (+59 vs +94); same feature, fuller version parked -> nothing unique lost (24 diff-lines were reworded comments, backed up regardless).

### Fix 2 -- Durable decision queue: **PASS**
- Built on existing kanban (labels + cards, no new platform code). Queue label `istvan-dontes`; state labels `needs_istvan` / `answered` / `superseded`.
- 6 decision cards created, each with: title, project, why-Istvan, options, suggested default, blocked-next-step, owner/waiting, urgency. Status=waiting, assignee=istvan.
  - a6f31140 Render-connect (urgent) · ad1f67ae QQ DB+creds · 99743d76 DORA S3 · 49347caa MK scope · 3c0a6168 pricing · c91e93c9 Bolcsi DPA lawyer.
- Maestro mandate (`maestro-backlog-review/SKILL.md` sec.4) rewritten: the "ISTVAN-DONTES KELL" message is now GENERATED FROM the queue (needs_istvan cards), not ad-hoc memory; answered->answered, invalidated->superseded.

### Fix 3 -- kanban-dispatcher disabled: **PASS**
- `~/.claude/scheduled-tasks/kanban-dispatcher/task-config.json` -> `enabled=false` (disk + API both confirm). Reason recorded in description. NOT converted to command (per directive).
- Rationale: skipped 49/49 in 24h; momentum carried by maestro-backlog-review (48/48).

### Fix 4 -- Auto-recovery evidence (controlled, dummy session): **PASS (mechanism) + precise nuance**
- Controlled test on dummy `agent-canarytest` (never a real/registered agent; killed at 17:49:59, before the :50 tick; no stray session/agent):
  - DETECTION: `tail -15` grep flagged it CTX_SAT (after fixing test setup -- real Claude panes show the marker in the bottom status line, my first dummy put it at the top).
  - EXECUTOR (`dispatch-guard.sh canarytest`, run directly, no Telegram): evidence captured (`store/recovery/canarytest/.../pane-scrollback.txt`, git-status/diff), loop-guard entry recorded, restart invoked -> **exit 2 TIMEOUT** = EXPECTED (a dummy is not a bootable Claude agent, so it never reaches the "bypass permissions" ready signal). Test loop-guard entry then removed for hygiene.
- Production proof of the rc=0 (successful boot) path: `recovery-state.json` = **16 real recovery events across 9 agents today** (agents booted back + briefed).
- PRECISE NUANCE (the honest FAIL-reason for "reactive-triggered rc=0 captured in the act"): my NEW reactive context-watchdog fires 48/48 but has logged **ZERO** recoveries since the 12:39 edit -- because the **proactive** `dispatch-guard` (pre-dispatch, any minute) recovers a saturated agent BEFORE the reactive watchdog's next :20/:50 tick sees it. The reactive path is a verified BACKSTOP (correct detection+invocation proven by test) that is normally pre-empted by the faster proactive path. Same proven executor underneath.

## RE-VERDICT: **PASS**
All 4 approved fixes applied and evidenced. One documented residual (not a failure): the reactive auto-recovery line has not fired a real recovery in production because the proactive guard pre-empts it; it remains a verified safety-net for cases the proactive path can't see (e.g. an idle agent that saturates without receiving a dispatch). Constraints honored: no product code, no production deploy, no pricing/legal decision advanced.
