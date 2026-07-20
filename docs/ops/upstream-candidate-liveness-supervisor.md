# UPSTREAM CANDIDATE (PREPARED, NOT OPENED) — Config-driven multi-signal agent liveness supervisor

Status: DRAFT / not filed. Do not open the upstream issue until the local soak closes `LIVENESS_STABILIZED_AND_READY` (owner directive 2026-07-17). This documents the generic capability that official Marveen lacks; the product-local implementation (below the line) stays in this repo as adapters.

## Problem
Marveen's `autonomy-config.json` defines a `kanban_stuck_nudge` category (with levels 1/2/3) but **no core runtime reads it** — the documented "stuck agent → nudge → escalate after 2 rounds" ladder is unimplemented. Stuck detection that does exist is fragmented: `context-watchdog` handles only literal 100%-context saturation; backlog nudging is board-wide + timestamp-based, blind to per-agent session/pane state (interactive prompt, missing process, quota, idle-not-consuming). Operators must ping agents manually.

## Proposed generic capability (core)
A **config-driven multi-signal agent liveness supervisor** with these generic parts (each independently useful):
1. **Autonomy-level reading** — a small resolver that reads `autonomy-config.json` category levels each cycle and exposes them to detectors, so behavior is owner-controllable (1=report, 2=suggest+approve, 3=autonomous) without code changes.
2. **Multi-signal stuck detection** — combine soft signals (no card progress, no bus output, no tool/process activity, elapsed > per-task expected progress-heartbeat) with strong signals (missing process/session, interactive/auth prompt, quota/rate-limit, context saturation), requiring ≥2 signals except hard failures. Long active build/test must NOT read as stuck.
3. **Idempotent escalation ladder** — per-target round state with cooldown + auto-reset on recovery: round 1 self-nudge the agent, round 2 escalate to the coordinator, round 3 escalate to the owner with a concrete recovery suggestion. No auto-execution of recovery (restart/redispatch/kill) at any level unless a separate supervised-orchestration capability is explicitly enabled.
4. **Structured liveness events** — emit machine-readable events (detected / nudged / escalated / recovered / quarantined) instead of ad-hoc log lines, so dashboards + audits can consume them.
5. **Scheduler health** — surface planned-vs-actual run times, run lag, and missed-run reasons; a detector that itself silently stops firing is the worst failure mode.
6. **Recovery policy hook** — a policy interface gating any automatic recovery action (e.g. saturation auto-restart) behind explicit preconditions (no active tool, no interactive/auth prompt, no sensitive/irreversible operation, evidence-packet producible, fresh-restart-only, one-attempt-then-escalate) and a forbidden-domain denylist (payment, auth/identity/tenant, prod deploy/rollback, destructive DB, external comms, uncertain repo/worktree).

## Product-local adapters (STAY local, not upstream)
- tmux-pane capture + deterministic classification patterns (menu/auth/quota/idle/working) — environment-specific.
- The local Bot API escalation path (Telegram) — install-specific.
- account/quota detection specifics — install-specific.
These plug into the generic hooks (2 strong-signal source, 3 escalation sink, 6 recovery precheck) as product adapters.

## Constraints
Config-driven, toggleable, re-appliable after upstream update, no core-fork. The local `fleet-stall-detector` + `context-watchdog` implement this today as separate services with zero core modification; if/when the core supervisor lands, the local pieces collapse into adapters.
