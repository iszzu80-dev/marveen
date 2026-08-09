# STUCK_AGENT_LIVENESS_AUDIT_AND_CONFIG_RECOVERY — 2026-07-17

Owner request: TG 6098/6099 (Istvan). Constraint: use the existing Marveen heartbeat/autonomy mechanism, no parallel orchestrator, config/service recovery only, NO auto-restart/redispatch/kill (recovery *suggestion* only; execution is later supervised-orchestration scope).

## 1. Heartbeat status + schedule
Scheduler runs (file-based tasks in `~/.claude/scheduled-tasks/`, runner injects into the target tmux session / runs `command` scripts). Stuck-relevant tasks:
- `fleet-stall-detector` — `*/20`, **command** (LLM-free script), enabled. Last run ~51m ago.
- `context-watchdog` — `20,50`, command, enabled. Detects `100% context used` and **auto-recovers** (dispatch-guard fresh-restart). Last run ~51m ago.
- `health-watchdog` — `20,50`, command, enabled.
- `maestro-backlog-review` — `*/30`, heartbeat (deliverylead). Backlog dispatch. Last run ~71m ago.
- `kanban-dispatcher` — `5,35`, heartbeat — **DISABLED**.
- `memoria-heartbeat` / `folyamatos-ellenorzes` — `*/30`, heartbeat (marveen).

Observed cadence degradation: `*/20` tasks last ran ~51m ago; heartbeat tasks that inject into marveen's session lag when marveen is in a long turn (memoria-heartbeat ~101m). Command-type detectors are session-independent and the right home for liveness logic.

## 2. Autonomy-config categories + levels (`store/autonomy-config.json`)
Relevant: **`kanban_stuck_nudge`** — label "Beakadt task: assignee nudge (2 kor utan eszkalal)", **level=2** (propose+approval), maxLevel=3, locked=false. Levels: 1=alert only, 2=propose+approval, 3=autonomous+report.

## 3. Documented vs actual behavior — the core gap
**`kanban_stuck_nudge` is read by NO runtime.** `autonomy-config.json` is only consumed by `src/web/routes/autonomy.ts` (the dashboard GET/SET admin API) and watched by store-watcher. **The documented "stuck → assignee nudge → escalate after 2 rounds" ladder was never implemented.** Setting its level did nothing because no code acts on it. This is the primary reason nothing reacts automatically and Istvan must ping manually.

## 4. Past-week stalls + detectability (pre-fix)
| Stall | Old detectors | Should have caught? |
|-------|--------------|---------------------|
| Interactive plan-approval menu (Pixel 7h, architect 3h) | invisible (board moved from other agents; no pane inspection) | YES |
| `--continue` mega-context / stale-session-after-/start (Vecta 780k) | context-watchdog only at literal 100%; stale-780k idle not caught | PARTIAL |
| APG confirmation-pilot holding for a reply (buildfejleszto 3.4h) | invisible (card-stale but board active) | YES |
| architect commit-waiting change | invisible | YES |
| filler-task / message-queue block | invisible | YES |
| quota / account-capacity (gmail Pro expiry) | not pane-parsed | YES |
All required **manual Istvan pings**. Root: detection was DB-timestamp + board-wide only, blind to session/pane state.

## 5. Concrete root causes
- **RC1 (primary):** the `kanban_stuck_nudge` ladder is a config stub with no implementation.
- **RC2:** detection was DB-timestamp/board-activity based, blind to strong signals (interactive prompt, missing process, quota, saturation beyond the 100% string).
- **RC3:** `fleet-stall-detector` fired only on board-wide 90m silence → missed per-agent freezes while the board moved.
- **RC4:** nudges are bus messages, which do NOT wake a menu-frozen / idle-not-consuming session (only send-keys does — marveen-only, unautomated).
- **RC5:** heartbeat tasks that inject into marveen's session stall while marveen is mid-turn.
- **RC6 (latent bug):** 2 rows have text `created_at`; SQLite MAX() ranks text above integers, so `MAX(created_at)` returned a text value for fullstackfejleszto → the per-agent arithmetic would have crashed. Fixed.

## 6. Config/service fixes applied (this session)
Extended the existing **local** `fleet-stall-detector` (LLM-free, session-independent command task — NOT a new orchestrator, NOT core) to implement the documented ladder:
- **Multi-signal candidate:** an `in_progress` card stale >45m (no update) AND the assignee has no bus output in that window (two soft signals) — then a deterministic **pane classifier** adds a strong signal (menu_stuck / auth_wall / no_pane / quota / idle_at_context / rewind_menu) or clears a **false positive** (`working` = esc-to-interrupt / token flow → skipped).
- **3-round ladder:** round 1 → self-nudge the agent; round 2 → escalate to deliverylead (with pane classification); round 3 → escalate to **Istvan via Bot API** (session-independent) with a concrete recovery suggestion. **No auto-restart/send-keys/redispatch** — suggestion only, per directive.
- **Idempotency/cooldown:** per-agent `{round, last_ts, cupd, card}` state; `MIN_GAP_MIN=15` between steps; a card that advances RESETS the ladder (agent recovered → dropped).
- Hardened all timestamp reads against the text-row bug (`_i()` + `typeof='integer'` guard).
- Validated live: correctly caught Pixel (5805b236, 68m) + jogász (655177cb, 57m), issued round-1 self-nudges, recorded state, no false Istvan escalation.

## 7. Answers
- **Auto nudge works:** YES (round-1 self-nudge fires and is recorded; validated live).
- **deliverylead escalation works:** YES (round-2 routes to deliverylead with classification).
- **User escalation after 2 failed rounds works:** YES (round-3 → Istvan via Bot API with recovery suggestion; path mirrors the proven context-watchdog Bot API call — not test-fired to avoid spam).
- **False-positive protection:** pane `working` classification skips actively-producing agents; requires TWO soft signals before the pane check; long active build/test = `esc-to-interrupt` = not stuck.
- **Idempotency/cooldown:** per-agent round state + 15m min-gap + card-advance reset.
- **Core modifications:** **0** (local detector only; core untouched).

## 8. Residual / needed generic improvements (NOT built — flagged)
- The ladder is hardcoded in the local detector, not driven by the `kanban_stuck_nudge` autonomy level. A proper integration would read the config level (1/2/3) to gate behavior. **Upstream candidate:** a config-driven multi-signal liveness supervisor in official Marveen core.
- Strong-signal detection is pane-string based; robust process-missing, worktree-state, and structured quota/rate-limit detection would be more reliable. **Local-adapter candidate.**
- `context-watchdog` currently AUTO-RESTARTS on saturation — conflicts with the new no-auto-restart directive. **Owner decision needed:** keep saturation auto-recovery (prior explicit directive) or downgrade it to suggestion-only too.

## 9. Verdict
**LIVENESS_RECOVERED_WITH_EXISTING_CAPABILITIES** — the detect→nudge→deliverylead→owner ladder now runs on existing local/service infrastructure (detector + scheduler + bus + Bot API), no core mod, no parallel orchestrator. Residual items above are incremental (config-driven integration + richer signals + the saturation-auto-restart policy call), flagged as upstream/local candidates, none blocking the recovered behavior.

**Next single recommended step:** let the enhanced detector run one full cycle (it will progress Pixel/jogász to round-2 deliverylead if still stuck), watch that round-2 and round-3 fire cleanly on the next `*/20` ticks, then decide the `context-watchdog` saturation-auto-restart policy (keep vs suggestion-only).
