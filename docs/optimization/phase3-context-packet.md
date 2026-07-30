# Context Packet — Phase 3 (Capacity-Aware Runtime Routing)

> Card `59b383a9`. Starts only after Phase 2 acceptance is green + `f601e50b` done.
> Owner GO covers Phase 2-4 execution; marveen owns spec + gate and never accepts on report alone.
> **Phase 3 is NOT greenfield.** A fallback runner already exists and its current design violates
> the phase's central rule. Read the AS-IS section before designing anything.

## Goal
Let the fleet keep working when a subscription runs out of capacity, **without ever losing the
owner-set configured model**. Runtime may change what an agent is *currently running on*;
configuration is sacred. Every decision deterministic — no LLM anywhere in this path.

## AS-IS — grounded, live code (this is the part the older brief does not know)

**There is already a model-fallback feature, and it is wired into the live process:**
- `startModelFallbackRunner()` is called at `src/web.ts:378` (60s sweep, 50s initial delay).
- It is **INERT today**: `readModelFallbackConfig()` reads `store/model-fallback.json`, that file is
  **absent**, and `DEFAULT_MODEL_FALLBACK.enabled` is `false` (`src/model-fallback.ts:40`). The sweep
  returns immediately. So nothing is currently rewriting anything — but the machinery is one config
  file away from being live.
- Pure decision logic already exists and is worth keeping: `decideModelAction()` +
  `detectsUsageLimit()` in `src/model-fallback.ts`; chain + `revertAfterMinutes` config in
  `src/web/model-fallback-store.ts`.

**Two things about it are incompatible with this phase and must change:**
1. **It persists the fallback into the agent's configuration.** `checkAgent()` calls
   `writeModelFor(name, action.model)` → `writeAgentModel()` (`model-fallback-runner.ts:125,67-70`),
   and for the main agent it rewrites `.claude/settings.json` (`writeMainModel`, `:56-61`). That
   **overwrites configuredPrimary**, which this phase forbids. Concretely dangerous: Istvan's
   explicit model split (12 fleet agents configured `deepseek-v4-pro`, correction dated 2026-07-30)
   would be silently rewritten by an automatic downgrade, and nothing would ever restore the
   original value if the revert window were missed. A runtime condition must not mutate owner intent.
2. **Its only capacity signal is pane-text scraping** (`detectsUsageLimit(pane)` on
   `capturePane()`). That is a heuristic over a rendered banner, not a capacity state. Keep it as
   ONE input if you want — it is the only real-time signal for a subscription seat — but it must be
   classified into the deterministic registry, never be the decision itself.

**Also grounded:**
- Model resolution precedence (Phase 1 Block B, live): `resolveAgentModelDetailed(name)` →
  `resolveAgentModelFromConfig` — `explicit_model` → `model_profile` → `default`
  (`src/web/agent-config.ts:105-113`, `src/model-profiles.ts:97`). Profile map:
  `store/model-profile-map.json`. **This resolver is byte-frozen upstream-candidate code: extend
  around it, do not edit its precedence.**
- Spawn is where a model actually takes effect: the launch command is built at
  `src/web/agent-process.ts:1234` (`--model '${model}'`). A model change therefore requires a
  respawn; `restartAgentProcess(name, {fresh:false})` keeps the conversation.
- The worker launches with a LITERAL model (`WORKER_MODEL`, `src/web/agent-worker.ts:491`), outside
  per-agent resolution — do not pretend it participates.
- Capacity **observation** already landed in Phase 2 / P2-C: `src/costops/capacity.ts`
  (`CapacityFigure`, `UsageConfidence`, `freshnessOf`, `CAPACITY_STALE_AFTER_SECONDS`,
  `buildCapacityReport`) plus `capacity-snapshots.ts` and `saturation-events.ts`. **Consume these.
  Do not build a second capacity source.** Note `assertNoRecommendationLanguage()` there — P2-C is
  observation-only by construction; Phase 3 is where acting on it becomes legal.
- Identity stamping on dispatches is live: model / profile / provider / auth_profile / billing_mode
  (`src/costops/dispatch-identity.ts`). Billing truth is `store/billing-map.json` — never infer
  billing from a provider name.

## Build

### 1. Deterministic capacity-state registry
States: `available` / `degraded` / `limited` / `blocked` / `unknown`. Per (provider, auth_profile)
— that pair is the real unit of capacity, not the model id, because two accounts of the same
provider have independent quotas. Inputs: P2-C capacity figures, collector freshness, observed
limit signals, error classifications. **No LLM quota monitor.** `unknown` is a first-class state and
must never be silently treated as `available`; stale data degrades confidence rather than inventing
a state (`CAPACITY_STALE_AFTER_SECONDS` already encodes the staleness rule).

### 2. Subscription-first runtime-only resolver
Prefer capacity that is already paid for (subscription-included) before anything metered. The
resolver returns a **runtime overlay**, never a config write:
- `configuredPrimary` — read-only, from `resolveAgentModelDetailed`. Never written by this layer.
- `runtimeActiveModel` / `runtimeActiveProvider` — the overlay, stored separately (a runtime state
  table/file, not the agent config), always carrying *why* and *when*.
The overlay must be observable (dashboard + CostOps) and must expire/reset; on dashboard restart the
absence of overlay state means "on primary", which is the safe default. **Delete the overlay ⇒ the
fleet is exactly as configured. That is the rollback, and it must be proven.**

### 3. Sticky work-package routing
A work package that started on a model finishes on it. Mid-package flapping would split one task's
attribution across models and corrupt `cost_per_accepted_task` — the KPI Phase 2 just built. Use the
P2-A dispatch/package identity as the stickiness key.

### 4. Primary retry
TTL / reset-time / backoff so a recovered primary is climbed back to, deterministically. Prefer a
provider-stated reset time when one is observable over a guessed backoff; if none is observable, say
so in the state rather than presenting the backoff as a known reset.

### 5. Fallback limits (hard ceilings)
1 primary + **max 2 fallback** candidates; **max 1 automatic fallback per work package**. A second
degradation on the same package escalates to the operator instead of walking down a ladder. These
are ceilings, not defaults to grow later.

### 6. Error classification
`capacity` / `rate_limit` / `outage` → fallback ALLOWED.
`validation` / `tool_error` / `privacy` → fallback FORBIDDEN.
An unclassifiable error is **not** fallback-eligible (default-deny). A privacy-class refusal must
never be worked around by moving the work to another provider — that is a data-egress decision
wearing a reliability costume, and it is exactly the failure this rule exists to prevent.

## Constraints (hard)
- `configuredPrimary` is NEVER overwritten by runtime fallback. This is the phase's central rule and
  the existing runner breaks it — fixing that is in scope.
- External / non-trusted providers stay `enabled_for_routing: false`. Never restore a DeepSeek agent,
  never activate an untrusted provider, **no automatic privacy downgrade**. Enabling any external
  provider for routing needs a separate owner GO — not a code default.
- The owner-set model split stays: 12 fleet agents keep their configured `deepseek-v4-pro`. Phase 3
  must not move a single agent's configuration. If your change would, it is wrong.
- No LLM for capacity, routing, error classification, or sizing. Deterministic rules + metadata.
- CostOps stays the only measurement stack.
- Additive + fault-isolated: if this layer throws, the agent still launches on its configured model.
  Mirror P2-A's `createDispatchSafe` and make the fault path test-covered.
- Reuse `src/model-fallback.ts`'s pure-decision pattern and `pricing.ts`; do not fork a parallel one.

## Data sensitivity
Internal. Quota/usage/capacity numbers are fine. No credentials, no API keys, no env values in code,
tests, logs, or reports. Concrete accounts, quotas, prices, trust policy, TTLs and thresholds stay
deployment-local in gitignored `store/`; only schema + `config-examples/` commit.

## Done when (I verify independently, and I WILL mutate your guards)
- Registry produces all five states from deterministic inputs; `unknown` proven not to collapse into
  `available`; staleness proven to degrade confidence.
- Runtime overlay changes the running model **without any write to the agent config or
  `.claude/settings.json`** — proven by a test that asserts config bytes are unchanged across a
  simulated fallback, and by a mutation showing that test goes RED if a config write is reintroduced.
  This is the single most important guard in the phase.
- The existing `writeModelFor`/`writeMainModel` config-persistence path is removed or made
  unreachable from the fallback decision, with a test pinning that it cannot be called.
- Sticky routing proven: a package that starts on model A does not switch mid-package.
- Fallback ceilings proven: a 2nd automatic fallback on one package is refused and escalates.
- Error classification proven per class, and **default-deny proven for an unclassifiable error**;
  privacy-class fallback proven refused.
- `enabled_for_routing:false` proven to actually exclude a provider from every routing decision (not
  merely hidden in a UI) — and no agent configuration moved anywhere in the diff.
- Rollback proven: removing the overlay state + config leaves the fleet running exactly as configured,
  no data loss.
- `npx tsc --noEmit` exit 0, `npm run build` exit 0, FULL suite green (baseline = the Phase 2
  acceptance number, which I will give you at dispatch time; it must not regress).
- Every load-bearing guard proven red-able by a named mutation, reverted clean (`grep -rn MUTATION` = 0).
- Upstream candidates identified per phase; **no PR or issue without a separate owner GO.**
