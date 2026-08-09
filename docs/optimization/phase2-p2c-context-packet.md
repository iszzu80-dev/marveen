# Context Packet — Phase 2 / P2-C (Collectors, Subscription Visibility, KPI Read Surface)

> Owner GO: full Phase 2 execution. You build; marveen gates independently and WILL mutate your guards.
> This packet is an instance of the P2-B format it dogfoods. Work item: **finish + verify**, not greenfield.

## Goal
Close Phase 2's measurement surface so `cost_per_accepted_task` can be reported without false
precision: deterministic collectors, subscription/quota visibility, capacity **observation** (not
routing), and a KPI read surface on the CostOps page. Measurement only — **NO runtime routing, NO
fallback** (that is Phase 3).

## Where the work already is (do NOT restart it)
Worktree `/home/iszzu/marveen-wt/p2c-collect`, branch `feat/lean-opt-phase2-p2c`, base `3cad439`
(= develop tip, P2-A + identity stamping merged). A producer built ~2900 lines; its first run was
killed by a transient 529 with **everything uncommitted**. I recovered and checkpointed it as
`37c7e06` ("wip(costops): P2-C collectors, capacity, KPI read surface (checkpoint)"). That commit is
UNVERIFIED — treat it as a draft you now own.

Already present in `37c7e06`:
- new: `src/costops/kpi.ts`, `capacity.ts`, `capacity-snapshots.ts`, `saturation-events.ts`,
  `collectors/anthropic-usage.ts`, `collectors/scheduled-sync.ts`,
  `config-examples/costops-subscriptions.example.json`
- modified: `collectors/anthropic.ts`, `collectors/codex.ts`, `collectors/types.ts`,
  `reliability-observation.ts`, `schema.ts`, `subscriptions.ts`, `web.ts`,
  `web/routes/costs.ts`, `web/routes/kanban.ts`, `web/costops/*` (api, overview, css)
- 6 new test files (`costops-anthropic-sync`, `costops-capacity-confidence`,
  `costops-capacity-view`, `costops-collector-schedule`, `costops-collector-schedule-wiring`,
  `costops-phase2-kpi`)

## Canonical references (live code is truth — cite file:line in your report)
- DDL seam: `initCostOpsSchema` in `src/costops/schema.ts`. Idempotent boot DDL only
  (`CREATE TABLE IF NOT EXISTS`, `try{ALTER TABLE ADD COLUMN}catch{}`), nullable, forward-only, no backfill.
- P2-A attribution contract: `src/costops/dispatch.ts` — dispatches / routing_events /
  dispatch_outcomes, `createDispatchSafe` (fault isolation), window correlation bounded by BOTH a
  terminal outcome and `maxWindowSeconds`, `resolveBillingMode`, `costPerAcceptedTask`
  (marginal vs allocated). Read `docs/optimization/phase2-p2a-context-packet.md`.
- Pricing must be REUSED, never re-derived: `src/costops/pricing.ts` (`estimateModelCost`).
- Identity stamping already live on dispatches: model / profile / provider / auth_profile /
  billing_mode. Billing truth is `store/billing-map.json` (deployment-local, built from VERIFIED
  live pairs — deepseek is `api_payg`, NOT subscription). Never infer billing from a provider name.
- Saturation config: `store/session-efficiency.json` (P2-B, deployment-local). Live context-guard
  thresholds are `actPct 0.90` / `hardPct 0.97` + an always-on pane-saturation net
  (`src/context-guard.ts:53-55,83`) — NOT 85/90/92/97.
- Tests cannot run in the live install by design
  (`src/__tests__/setup/assert-not-live-install.ts`) — run them in the worktree.

## Your work item
1. **Fix the one known break:** `src/__tests__/costops-phase2-kpi.test.ts:136` — `TS2322`,
   `"heuristic"` is not assignable to `"estimated"`. Decide which side is right (the confidence
   vocabulary in the source is authoritative unless the source vocabulary itself is wrong) and say
   which you changed and why. Do not widen a type just to silence it.
2. `npx tsc --noEmit` exit 0, `npm run build` exit 0.
3. **FULL suite green.** Baseline that must not regress: **3623 passed / 1 skipped / 265 files**
   (develop @ `3cad439`). Report your actual numbers.
4. **Prove every new guard can go RED.** For each load-bearing rule you added, mutate the source so
   the rule is broken, record which tests turn red, then revert and confirm `grep -rn MUTATION` = 0.
   A green test that survives mutation proves nothing and I will reject the item for it. At minimum:
   - collector fault isolation (a collector failing must not break the page or the dispatch path)
   - the confidence marker (an estimated/heuristic number must never be presentable as measured)
   - KPI marginal-vs-allocated split (a subscription-included dispatch must not be billed as PAYG)
5. **Confidence honesty:** any number the read surface shows must carry its confidence, and a
   partial/missing collector window must render as *insufficient evidence*, never as a confident
   zero or a silently-low total. A silent under-count is the failure mode I care about most here.
6. Commit in coherent commits on top of `37c7e06` (do not squash away the checkpoint), then report.

## Constraints (hard)
- No LLM for any cost/capacity/size/routing decision. Deterministic rules + explicit metadata only.
- CostOps is the ONLY measurement stack — never build a parallel ledger.
- Additive + behaviour-neutral: if this layer faults, dispatch and the dashboard must still work.
- Rollback: new columns nullable, new config optional; deleting the config leaves the layer inert.
- Concrete accounts/prices/quotas stay deployment-local (gitignored `store/`); only schema + examples commit.
- Capacity here is **observation only**. Do not add a resolver, fallback, or any routing decision.

## Data sensitivity
Internal. No secrets, credentials, API keys, or PII in code, tests, fixtures, logs, or your report.
Never print an env value. Quota/usage numbers are fine; the credentials behind them never leave `store/`.

## Done when
tsc 0 + build 0 + full suite ≥ baseline with your numbers shown; every new guard proven red-able by a
named mutation (with the reverted-clean check); confidence markers enforced by test; committed on
`feat/lean-opt-phase2-p2c`; report lists file:line for each claim. I verify independently — I do not
accept on report alone.
