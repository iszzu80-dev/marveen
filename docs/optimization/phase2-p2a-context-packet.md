# Context Packet — Phase 2 / P2-A (Dispatch & Outcome Attribution)

> Fleet Context Packet format (dogfooding Phase 2 P2-B). Reference-based, not inlined.
> Owner GO: full Phase 2 execution. Producer builds; marveen owns the gate.

## Goal
Make every Node-side work-package dispatch **measurable end to end**: a stable
`dispatch_id` that links dispatch → routing event → token_usage → outcome →
CostOps cost, so `cost_per_accepted_task` is computable per agent/profile/model.
Phase 2 is **measurement only** — NO runtime routing, NO fallback, NO model
switching. Additive to `develop`, no behaviour change to the normal path.

## Canonical references (current live code = truth; cite file:line in the as-built)
- token_usage table + writer: `src/db.ts:556-599`; `src/web/token-usage.ts:214-281`
  (tails Claude Code transcripts; has `session_id,agent,model,provider,model_source`;
  NO dispatch/task id). Fuzzy task link: `correlateWithKanban()` `token-usage.ts:502-531`.
- CostOps DDL seam (put ALL new CostOps tables/cols here, NOT db.ts):
  `src/costops/schema.ts` `initCostOpsSchema(db)` (`// LOCAL-FORK: costops seam`).
- Per-agent cost (reuse): `getTokenCostByAgent()` `src/costops/pricing.ts:267-312`;
  `getTokenCostEstimate()` `pricing.ts:156`; rates `store/costops-pricing.json`.
- Existing trace correlation (pattern to mirror, message-router ONLY):
  `agent_messages.trace_id/span_id/parent_span_id` `db.ts:456-458`; `otel_spans` `db.ts:928-940`;
  `stampTraceOnMessage()` `message-router.ts:175-185`.
- The single dispatch funnel (thread dispatch_id here): `sendPromptToSession()`
  `src/web/agent-process.ts:1634`, params `(session, prompt, host?, opts?)`. On develop
  it has NO gate/metadata param — greenfield. Every path calls it.
- Dispatch origins to instrument:
  (a) kanban `src/kanban-dispatch.ts` + `src/web/routes/kanban.ts:251` (`fireKanbanDispatch`);
  (b) inter-agent `src/web/message-router.ts:621-662` (stamp beside trace at :583-588);
  (c) scheduler `src/web/schedule-runner.ts:518-527`;
  (d) worker `src/web/agent-worker.ts:637-653` (has ephemeral `reqId`, not persisted);
  (e) reinjection: `message-router.ts:663-669`, `pending_task_retries` `db.ts:526-537`,
      `schedule-runner.ts:574-601`.
- Outcome/acceptance today: kanban `status→done` (agent-asserted) `routes/kanban.ts:29,58-75`;
  status enums to reuse: `agent_messages.status` `db.ts:423`, `task_runs`, `background_tasks.status`
  `db.ts:545`, `pending_task_retries.attempt_count/last_reason` `db.ts:526-537`.
- Migration pattern: idempotent boot DDL — `CREATE TABLE IF NOT EXISTS` + `try{ALTER TABLE ADD COLUMN}catch{}`
  in `db.ts`; CostOps ones through `costops/schema.ts`. Nullable, forward-only, NEVER backfill guessed values.

## Build (P2-A)
1. **`dispatches` table** (via costops/schema.ts seam or db.ts — pick the seam so it survives upstream merges;
   justify choice in as-built). Columns (all nullable except id/created_at/agent):
   `dispatch_id TEXT PK` (crypto.randomUUID at origin — runtime code MAY use randomUUID/Date.now),
   `created_at INTEGER`, `source TEXT` (kanban|message|scheduler|worker|reinject|manual),
   `card_id`, `agent`, `project`, `session_id`, `task_type`, `model_profile`,
   `configured_model`, `runtime_model`, `provider`, `auth_profile`, `billing_mode`.
   **The dispatch_id and every column MUST NOT contain prompt text, PII, or secrets.**
2. **Thread dispatch_id** from each origin (a-e) through to `sendPromptToSession(opts.dispatchId)`.
   Origin creates the id + inserts the `dispatches` row with all known metadata. Where there is
   no kanban card, the dispatch_id STILL exists (card_id null). A dispatch below a real
   work-package threshold (e.g. a bare nudge/heartbeat ping) MAY be skipped — document the threshold.
3. **`routing_events` table** (single structure, CostOps-linked): `routing_event_id, dispatch_id,
   card_id, agent, configured_profile, runtime_profile, configured_model, runtime_model, provider,
   auth_profile, billing_mode, capacity_state, reason_code, fallback_used, timestamp`. In Phase 2
   essentially every event is `reason_code='default_route'`, `fallback_used=0`. Do NOT build a
   parallel DB — this rides CostOps.
4. **`dispatch_outcomes` table**: `outcome_id, dispatch_id, outcome` (accepted|retry|failed|cancelled|unknown),
   `retry_of, correction_of, fallback_event_id, evidence, created_at`. Rules per spec 7.2. Wire
   `accepted` from kanban status→done for carded dispatches; leave others `unknown` (NEVER invent
   historical backfill — old rows stay unknown).
5. **token_usage ↔ dispatch link**: add nullable `dispatch_id` column to `token_usage`. Correlate
   deterministically by **dispatch-time window within (agent, session_id)**: a token_usage row is
   attributed to the dispatch whose [created_at, next-dispatch-of-same-session) window contains its
   timestamp. Rule-based, no LLM. This refines (does not replace) `correlateWithKanban`.
6. **billingMode**: from deployment-local config `store/billing-map.json` keyed by (provider, auth_profile)
   → one of `subscription_included|subscription_credit|api_payg|local_compute|unknown`. NO provider-name
   heuristic. Missing config → `unknown` (NEVER a false `free`/`not_billed`). Ship a committed
   `config-examples/billing-map.example.json`; the concrete map stays in gitignored store/.
7. **cost_per_accepted_task**: join accepted dispatches → their token_usage (via dispatch_id) → pricing.
   Expose TWO distinct values, never mixed: **marginal** (actual execution $ from cost_line_items/token
   estimate) and **allocated** (prorated subscription monthly ÷ accepted tasks). Group-by: agent,
   modelProfile, model, provider, task_type, project, billingMode, period. Add a read function in
   costops (mirror `getTokenCostByAgent`) — no new endpoint required for P2-A, but expose a callable.

## Constraints (hard)
- Agent-default + modelProfile stays the normal path; no re-optimization per task; NO LLM for any
  routing/cost/size decision; deterministic rules + explicit metadata only.
- CostOps is the ONLY measurement/ledger system — no second parallel usage stack.
- Additive: do not alter the normal dispatch behaviour; measurement overhead must not add material
  token or latency regression. If the optimizer layer errored, the static default path still works.
- Rollback: all new columns nullable + new tables independent, so disabling the feature leaves them
  inert with zero data loss.
- Upstream-friendly: generic (dispatch_id, outcome, routing_event schema, billing-mode interface) so it
  can later be an upstream PR; concrete billing/account maps stay deployment-local.

## Data sensitivity
No prompt content, PII, secret, or credential in any new column, id, log, or the dispatch row. The
dispatch_id is an opaque uuid. billing-map/account specifics live in gitignored store/ only.

## Done when (P2-A gate — I verify independently)
- New dispatches across all instrumented origins get a dispatch_id (prove for kanban+message+scheduler+worker).
- routing_event ↔ token_usage ↔ outcome are joinable by dispatch_id.
- `cost_per_accepted_task` computable for buildfejleszto + research; marginal vs allocated returned separately.
- billingMode resolves from config, `unknown` when absent; proven NOT derived from provider name.
- Build + `tsc --noEmit` clean; new unit + integration tests green (dispatch threading, window-correlation,
  billing-mode-from-config, outcome rules, cost join). Tests run in a git worktree (the suite refuses to run
  in the live install via `src/__tests__/setup/assert-not-live-install.ts` — that refusal is a guard, not a failure).
- No parallel measurement stack; no runtime routing/fallback introduced.
- Rollback proven: dropping/ignoring the new columns leaves the system working, no data loss.
