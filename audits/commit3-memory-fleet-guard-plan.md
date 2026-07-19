# Commit 3 -- Memory / fleet guard (DETAILED PLAN, not implemented)

Context: 2026-07-09 incident. 7.4G WSL VM, ~13 Claude/node sessions @ 360-430MB each
(~4.5G in claude alone). Peak 6.9G + 1.8G swap -> OOM killer -> systemd poweroff.
No memory gate exists anywhere today.

## 1. Where exactly the guard hooks in

Topology (verified):
- `marveen-dashboard.service` + `marveen-channels.service` = systemd **user services**,
  fully independent of agent tmux sessions.
- Fleet agents = `agent-*` **tmux sessions**, defined by `agents/<id>/agent-config.json`.
- **STORM SOURCE (confirmed):** `scripts/watchdog.sh` (cron `*/5`) loops over
  `agents/*/` and restarts EVERY missing session in one pass. After a VM restart all
  ~13 agents are missing -> ~13 Claude cold-starts fire simultaneously -> RAM spike ->
  OOM. This loop is the primary chokepoint.
- `scripts/fleet-resume-guard.sh` (cron `*/3`) only nudges (one rate-limited
  `/api/messages` curl); NOT a spawn source -> no change needed there.
- Dashboard `dist/index.js` also spawns agents on-demand via create/start API =
  secondary chokepoint.

Hook points:
- **Primary:** insert a memory pre-check + stagger into `watchdog.sh` sub-agent
  restart loop (lines ~110-130). New shared helper `scripts/lib/mem-guard.sh`
  (sourced) exposing `mem_available_mb`, `mem_state` (OK|WARN|CRIT), `safe_mode_on`.
- **Secondary:** a standalone `scripts/fleet-mem-guard.sh` (new, cron `*/2`) that does
  proactive shedding independent of the restart loop (parks agents when already-running
  fleet pushes memory into CRIT) and sends the OOM pre-alert.
- **Dashboard spawn:** dashboard reads the same safe-mode flag file before honoring a
  start/create; if safe-mode on, it refuses non-critical spawns with a visible reason
  (source change, lower priority -- can defer to a later sub-commit).

## 2. Temporary safe-mode mechanism

- Flag file `store/.fleet-safe-mode` (JSON: `{reason, since, trigger_mb}`).
- When present: `watchdog.sh` and dashboard spawn ONLY restart/allow a **critical
  allowlist** (`marveen` main + `deliverylead`); all other `agent-*` stay parked.
- "Parked" = tmux session stopped (not deleted) OR left un-nudged; config + kanban
  untouched, so resume is a no-op restart. No data loss.
- Auto-clear: `fleet-mem-guard.sh` removes the flag once `mem_available_mb` recovers
  above the WARN line for 2 consecutive checks (hysteresis, avoids flap).
- Manual override: `touch`/`rm` the flag; a Telegram command later if wanted.

## 3. How the agent storm is bounded

In `watchdog.sh` restart loop:
- **Max N cold-starts per run** (default `MAX_SPAWN_PER_RUN=3`). Remaining missing
  agents wait for the next `*/5` tick -> natural spread instead of a thundering herd.
- **Stagger**: `sleep 15-20s` between spawns (Claude cold-start RAM settles before the
  next), and re-check `mem_state` between each -- abort the loop if it crosses CRIT
  mid-batch.
- **Priority order**: restart the critical allowlist first, then by
  `agent-config.json` priority, so a partial batch still brings up the important agents.

## 4. MemAvailable thresholds

Expressed on `MemAvailable` (from `/proc/meminfo`), VM total ~7.4G:
- **OK**: available > 1.6G (~78% used). Normal operation.
- **WARN**: available <= 1.6G (~80% used). Telegram warn (deduped, llm-free pattern),
  enable stagger, cap `MAX_SPAWN_PER_RUN=2`, no new dashboard spawns of low-priority.
- **CRIT**: available <= 0.8G (~90% used). Enter safe-mode: stop all non-critical
  spawns, park lowest-priority running agents oldest-idle-first, send **OOM pre-alert**
  Telegram. Reuses the proven `llm-free-telegram-alert-pusher` dedupe/rate-limit.
- Thresholds overridable via env (`MEM_WARN_MB`, `MEM_CRIT_MB`) for tuning.

## 5. How dashboard + channels stay alive while the fleet is parked

They already are structurally separate: both are **systemd user services**, not tmux
agents. The guard only ever touches `agent-*` tmux sessions and spawn decisions -- it
never stops `marveen-dashboard.service` / `marveen-channels.service`. Both stay up in
CRIT/safe-mode, so:
- Telegram (marveen main) keeps answering.
- The dashboard keeps serving CostOps etc.
- Parked = only the sub-agent fleet; the main channel + admin surface are unaffected.
The critical allowlist explicitly keeps `marveen` + `deliverylead` running so coordination
survives shedding.

## Risk / scope guardrails
- Read-only except the flag file + dedupe state; never stops the two user services;
  never touches CostOps 0.7; never deletes agent config/kanban. Park = reversible stop.
- All new logic behind the mem-guard helper so it is unit-testable with a faked
  `MemAvailable` (dry-run + `MEM_FAKE_AVAIL_MB=` override), like Commit 2's `--dry-run`.

## Suggested commit split (when GO'd)
- 3a: `scripts/lib/mem-guard.sh` helper + tests (no behavior change yet).
- 3b: wire stagger + MAX_SPAWN + mem pre-check into `watchdog.sh`.
- 3c: `scripts/fleet-mem-guard.sh` (proactive shed + OOM pre-alert) + cron `*/2`.
- 3d: dashboard spawn respects `.fleet-safe-mode` (optional, source change).
