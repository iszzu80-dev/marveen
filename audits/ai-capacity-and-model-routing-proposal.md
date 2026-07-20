# AI Capacity & Model Routing -- deployment proposal

Status: PROPOSAL / AUDIT ONLY (2026-07-02). Nothing changed in the running system: no source, no
CLAUDE.md/SOUL.md, no agent-config, no model switches, no restarts. This document is decision
support only.

Scope: the local Marveen deployment (~/marveen, official Szotasz/marveen v1.18.5 + local ca63681).

---

## 1. Current runtime state (verified 2026-07-02 08:2x)

- **Main agent (marveen-channels):** `claude-opus-4-8[1m]`, Max/OAuth. (Note: earlier documented
  target was Sonnet; currently Opus -- see section 6/7, migration deferred per Istvan.)
- **marveen-worker:** `claude-opus-4-8[1m]` (scaffold/worker session).
- **Sub-agents (18):**
  - DeepSeek **v4-flash** (3): Cog (codeworker), Herald (marketing), Muse (uxuidesigner)
  - DeepSeek **v4-pro** (15): Atlas, Lens, Broker, Anvil, Bursar, Compass, Maestro, Pixel, Mason,
    Aegis, Falcon, Sonar, Sentinel, Steward, Thrin
- **DeepSeek routing:** direct to `api.deepseek.com/anthropic` via vault `DEEPSEEK_API_KEY`
  (`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`). NOT via CCR.
- **CCR (claude-code-router, :3456):** **successfully stopped vestigial process** (2026-07-02) --
  the official code path never referenced it, so stopping it had no runtime impact (dashboard stayed
  active/running, `/api/agents` stayed HTTP 200, tracked worktree stayed clean). Rollback if ever
  needed: `ccr start`.
- **Codex:** installed (`~/.local/bin/codex`, `~/.codex` configured). No persistent process =
  consistent with manual/on-demand use.
- **Fleet OAuth token (`store/.claude-oauth-token`):** ABSENT -- so a channel-having sub-agent
  cannot launch in an isolated config dir under a Claude login; this blocks putting sub-agents on
  Claude models with per-agent isolation today.
- **Auto model-fallback runner:** exists in code but `enabled: false` (no override config) -- fleet
  model-fallback is OFF; all model changes are currently manual.

## 2. Target state

A cost-tiered routing where the cheapest capable model runs each role, human/premium capacity is
reserved for interactive + final-review only, and nothing swaps models automatically in a way that
sends sensitive data to the wrong place or burns premium quota unattended.

- Marveen core + selected senior roles: **Claude Sonnet** (Pro) -- *migration deferred* (currently Opus).
- High-volume / mechanical worker roles: **DeepSeek** (pro or flash by task weight).
- Human-interactive coding & emergency final review: **Claude Max** (never automated runtime).
- Manual bulk coding / PR review / isolated patch: **Codex** (never Marveen runtime).
- Manual final review only: **Claude Opus** (keep current Opus default for now, do not change yet).

## 3. Suggested primary model per role

| Role (agent) | Current | Proposed primary | Rationale |
|---|---|---|---|
| Marveen (main/orchestrator) | Opus 4.8 | Sonnet (Pro) *[deferred]* | Orchestration + Telegram; Sonnet is close to Opus at lower cost. Keep Opus until explicitly migrated. |
| deliverylead (Maestro) | DS v4-pro | DS v4-pro | Coordination, high message volume; pro reasoning helps triage. |
| architect (Atlas) | DS v4-pro | DS v4-pro (Sonnet for hard specs) | Complex specs; escalate to Sonnet only for the hardest design calls. |
| fullstack (Mason), build (Anvil), frontend (Pixel) | DS v4-pro | DS v4-pro | Real code; pro is the right weight; Codex for bulk/isolated patches (manual). |
| qa (Falcon) | DS v4-pro | DS v4-pro | Verification needs nuance; pro justified (already moved off flash 2026-07-01). |
| ba (Lens), business (Compass), research (Sonar), jogasz (Aegis) | DS v4-pro | DS v4-pro | Analysis/legal drafting; pro. |
| broker/bursar (finance), sentinel, steward, thrinintee | DS v4-pro | DS v4-pro | Personal-assistant + monitoring; pro (some could trial flash, see 9). |
| codeworker (Cog) | DS v4-flash | DS v4-flash | Mechanical worker -- flash is the intended low-cost tier. |
| marketing (Herald) | DS v4-flash | DS v4-flash | Copy/marketing sweeps; flash adequate. |
| uxuidesigner (Muse) | DS v4-flash | DS v4-flash / pro for net-new component design | Flash for routine; consider pro when designing net-new UX. |

## 4. Fallback policy per role

General rule: **manual, evidence-based fallback** (the auto model-fallback runner stays OFF).

- **DeepSeek roles:** if a DeepSeek agent errors on model-availability/auth (e.g. "model may not
  exist", ECONNREFUSED) -> first verify it's a routing issue (respawn via
  `/api/agents/:name/restart`, not a CCR restart -- see the official-deepseek-routing note), NOT a
  credit exhaustion. If genuinely DeepSeek-side outage/credit: fall back to **Claude Sonnet (Max)**
  temporarily (Istvan's directive: on DeepSeek exhaustion, migrate worker to a Claude model). Record
  the switch + reason; revert to DeepSeek when restored.
- **flash roles:** if a flash agent repeatedly produces low-quality output on a nuanced task ->
  escalate that role to pro (as was done for Falcon 2026-07-01). One-way until reviewed.
- **Sonnet/Opus core (Marveen):** no automatic fallback. If Max weekly limit is hit, that is an
  operator decision (Max resets weekly); do not silently downgrade the orchestrator mid-conversation.
- **NO automatic cross-tier data movement:** a role that handles sensitive DATA must never be
  auto-routed to DeepSeek (Chinese-hosted) -- classify by data-in-context, not just role (existing
  model-routing-data-sensitivity rule).

## 5. What the system must NOT do automatically

- Do NOT auto-switch the main orchestrator's model mid-run.
- Do NOT auto-route sensitive-data roles to DeepSeek.
- Do NOT auto-enable the model-fallback runner without an explicit config + review.
- Do NOT auto-consume Claude Max quota for unattended runtime (Max = interactive + emergency only).
- Do NOT auto-run Codex as part of Marveen runtime.
- Do NOT auto-enable forceSend safe-mode behaviour (the #129 flag stays default-OFF; observation first).

## 6. Opus usage rule

- **Opus = manual final review only** is the target policy.
- **Exception (current):** the main channels session + marveen-worker currently run Opus 4.8[1m].
  Per Istvan (2026-07-02) **do NOT change the current Opus default yet.** So today Opus is also the
  interactive orchestrator; the "manual-final-review-only" restriction applies to *new* automated
  Opus usage, not to the existing running sessions until an explicit migration.
- No sub-agent should be put on Opus automatically.

## 7. Claude Max usage rule

- Max = **human interactive Claude Code + emergency/final review**. NOT automated runtime.
- The main channels session runs under Max/OAuth today -- acceptable as the interactive orchestrator.
- Do not spin up automated/background agents that burn Max weekly quota. If a task needs a Claude
  model in the background, prefer Sonnet (Pro) capacity, not Max.
- Max weekly limit exhaustion is an operator-visible event; handle by pausing non-essential Claude
  usage, not by silent downgrade.

## 8. Codex usage rule

- Codex = **manual bulk coding / PR review / isolated patch generation**, invoked by an operator or
  by an agent explicitly delegating a heavy mechanical coding job to save Claude tokens (codex-delegate
  skill). NOT part of Marveen runtime, no persistent Codex process, no auto-invocation on a schedule.
- Good fits: large boilerplate/scaffolding, multi-file mechanical refactors, an isolated patch to
  review before applying. Poor fits: anything needing fleet context, secrets, or live coordination.

## 9. DeepSeek Pro vs Flash split

- **Flash** = mechanical, high-volume, low-nuance: codeworker (Cog), marketing sweeps (Herald),
  routine UX (Muse). Cheapest; accept lower reasoning.
- **Pro** = anything needing multi-step reasoning, correctness judgement, legal/analysis nuance, or
  real code: the other 15 roles.
- **Movement rule:** promote flash->pro when a role shows repeated quality misses on nuanced work
  (Falcon precedent). Demote pro->flash only after observing that a role's actual tasks are
  consistently mechanical (candidates to *trial*: the pure-monitoring roles sentinel/steward if their
  daily work is just scans -- but verify first, do not assume).

## 10. Peak / off-peak DeepSeek handling (CONDITIONAL -- pricing NOT verified)

DeepSeek has historically offered off-peak discount windows, but **official pricing was NOT checked
for this document** (no live pricing fetch). CONDITIONAL proposal, to be confirmed against official
DeepSeek pricing before any action:

- IF off-peak discount windows exist and are material: schedule non-urgent high-volume batch work
  (nightly sweeps, bulk analysis, non-interactive builds) into the off-peak window; keep interactive
  / time-sensitive tasks on-demand regardless.
- IF no material off-peak difference: no scheduling change needed; route purely by task weight (9).
- **Action gate:** verify current DeepSeek pricing + any peak/off-peak terms FIRST (a research task,
  or Istvan confirms) before implementing any time-based routing. Do not implement on assumption.

## 11. Which changes are LOCAL deployment configs

- Per-agent model assignment (flash/pro): `agent-config.json` `model` field via
  `PUT /api/agents/:name` or dashboard (local).
- Main model (Sonnet migration, when approved): `.claude/settings.json` `model` field (local,
  skip-worktree'd -- the tracked-vs-local divergence is intentional).
- Enabling/tuning the model-fallback runner: local fallback config (currently absent -> OFF).
- CCR teardown: local process/service cleanup (vestigial).
- Peak/off-peak batch scheduling: local scheduled-tasks cron (if pursued after pricing check).

## 12. Which changes are UPSTREAM proposals

- Nothing in this routing proposal strictly requires upstream changes -- it is deployment policy.
- Possible upstream candidate (separate from routing): a first-class "role -> model tier" policy
  map + a data-sensitivity guard in the dispatch path, so cost-tiering + the "no sensitive data to
  DeepSeek" rule are enforced in code rather than by convention. Only worth proposing if other
  Marveen deployments want the same; otherwise keep local.
- The ca63681 dispatch-guard (separate doc) is the active upstream PR candidate.

## 13. Pilot order (3 steps)

1. **Observe (no change):** stand up a tiny read-only usage/quality snapshot -- per-role model,
   recent error rate (auth/model-availability), and any flash-role quality complaints. Confirms the
   current split is right before touching anything. (Cheapest, zero risk.)
2. **Trim the obvious waste:** CCR teardown (vestigial process) + confirm no sensitive-data role is on
   DeepSeek. Local, reversible, no model quality impact.
3. **Targeted model moves (one at a time, with revert):** e.g. trial a pure-monitoring role pro->flash
   OR migrate Marveen core Opus->Sonnet (only on explicit GO) -- each as a single reversible change,
   verify a day, then next. Never a fleet-wide simultaneous swap.

## 14. Rollback plan

- Per-agent model change: revert the `agent-config.json` `model` field to the prior value + respawn
  (`/api/agents/:name/restart`). Prior values recorded in this doc section 1/3.
- Main model change: restore `.claude/settings.json` `model` (keep a copy of the pre-change file).
- Any config change: the dashboard config-change-log + git (for tracked files) provides the prior
  state; agent-config.json changes are local, so snapshot before editing.
- Golden rule: change ONE role at a time so rollback is a single-field revert, never a fleet reset.

## 15. Concrete next commands for later implementation (DO NOT RUN NOW)

```bash
# Step-1 observe (read-only): current per-agent model snapshot
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/agents \
  | python3 -c "import json,sys; [print(a['name'],a['model'],a.get('activeModel')) for a in json.load(sys.stdin)]"

# Step-2 CCR teardown -- DONE 2026-07-02 (vestigial process stopped, no runtime impact).
# Rollback if ever needed: ccr start

# Step-3 example single-role model move (ONLY on explicit GO), e.g. a monitoring role to flash:
curl -s -X PUT http://localhost:3420/api/agents/sentinel \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash"}'
curl -s -X POST http://localhost:3420/api/agents/sentinel/restart \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" -H "Content-Type: application/json" -d '{}'
# verify, observe 24h, revert if quality drops:
#   PUT model back to deepseek-v4-pro + restart

# Main Opus->Sonnet migration (ONLY on explicit GO -- currently deferred):
#   edit .claude/settings.json "model": "sonnet"  (keep a backup copy first)
#   then hard-restart the channels session via the official path
```

Everything above is proposal only. No model was changed, no config edited, no process restarted for
this document.
