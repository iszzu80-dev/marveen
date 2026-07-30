# Context Packet — Phase 4 (Package Portfolio & Market Optimization)

> Card `4e2c31ef`. Owner GO given 2026-07-30 15:18 ("Indulhat phase4"), after Phase 3 acceptance.
> **ADVISORY ONLY. No autonomous commercial action, ever — not a cancellation, not an upgrade,
> not a signup.** marveen owns spec + gate and never accepts on report alone.

## Goal
Answer one question honestly and repeatably: *are we paying for the right packages?* Output is a
recommendation with its evidence, its confidence and its window attached — never a bare verdict. The
system that **refuses to answer** when the inputs are inadequate is the one worth building; a
confident recommendation on thin data is the failure mode, not the feature.

## THE HARD PRECONDITION — read this before designing anything
The FX layer is **not finished**, and Phase 4 consumes money figures. Owner rule, confirmed
2026-07-30: convert at the **MNB mid-rate of the day the cost arose** (card `97accbce`, still open).
Today: `store/costops-fx.json` holds a single static `USD: 360`, EUR is unset, and
`resolveRateDate()` still prefers the invoice date — a precedence the owner's rule overturns.

So build Phase 4 **on top of an honest gap, not around it**:
- Any recommendation whose evidence depends on a figure that is unconverted, or converted at a flat
  rate instead of the cost-arising day's rate, MUST return `INSUFFICIENT_EVIDENCE` with the reason
  named. It must not round, guess, or quietly drop the line.
- A portfolio comparison must NOT silently omit an unconvertible cost. The Anthropic Max 5x
  (EUR 90.00/mo, company mailbox, ~36k Ft/month) is currently invisible for exactly this reason;
  a plan comparison that leaves it out is wrong in a way that favours the status quo.
- `INSUFFICIENT_EVIDENCE` is a first-class result to be tested, not an error path.

## Canonical references (live code is truth — cite file:line in the as-built)
- Cost truth: `src/costops/ledger.ts`. Note `resolveSourceWinners` — within one period, lines sharing
  a confidence class are SUMMED (distinct charges), while tier / accounting-rule / freshness選 selects
  BETWEEN classes (card `dec9ae64`). Every surface must agree; an agreement assertion exists because a
  22431 HUF disagreement shipped once.
- KPI + confidence vocabulary: `src/costops/kpi.ts` — `measured` / `estimated` / `unknown`, each with a
  mandatory blocker string. **Reuse this vocabulary; do not invent a second one.**
- FX: `src/costops/fx.ts` (`resolveFxRate` rejects zero/negative/non-finite — an unset rate is
  unconvertible, never 0) and `src/costops/fx-config.ts` (`store/costops-fx.json`, the single
  provider-neutral home).
- Capacity/subscription facts: `src/costops/capacity.ts`, `subscriptions.ts`,
  `capacity-snapshots.ts`. Note `assertNoRecommendationLanguage()` in capacity.ts — P2-C is
  observation-only **by construction**, and Phase 4 is the first place recommendation language is
  legal. Do not weaken that guard; put your language on your side of the boundary.
- Market input already gathered: `store/market-snapshot-2026-07-30.json` +
  `docs/optimization/phase4-market-snapshot-2026-07-30.md`. **Read the gate notes in that markdown
  first**: every figure is aggregator-derived (WebFetch was blocked), so it is `inferred`-grade, NOT
  `measured`. Anthropic API rates in it came from a skill cache dated 2026-06-24.
- Anthropic exposes **no quota/usage API** (re-verified 2026-07-30). Subscription headroom is unknown
  unless a human reads it off the UI. Do not model it as measured.

## Build

### 1. Package inventory
Schema + committed example in the repo; concrete accounts, prices, seats and contract dates stay
deployment-local in gitignored `store/`. Per package: provider, name, price + currency, quota/limit
shape, overage/credit availability, contract granularity, renewal, and **the provenance of each
number** (invoice / manual / aggregator / not published).

### 2. Recommendation engine — deterministic, no LLM
Verdicts: `KEEP` / `UPGRADE` / `DOWNGRADE` / `CANCEL` / `ADD` / `ENABLE_USAGE_CREDIT` / `REBALANCE` /
`NO_DECISION` / `INSUFFICIENT_EVIDENCE`. Every verdict carries evidence (which figures, from which
source), confidence (reuse kpi.ts's vocabulary), and the window it was computed over.
**No LLM anywhere in the decision.** Deterministic rules over explicit metadata.
A decommissioned cost centre must read as an already-executed cancellation, not an active line — the
Render account is deleted and its historical spend is real (card `484cad98` tracks the missing
lifecycle; until it lands, treat a `blocked`/`not_configured` collector as unknown, not zero).

### 3. Weekly market watch — deterministic
`fetch → normalize → hash → diff → change event`. **No LLM unless the content actually changed**, and
then only on the diff. Cache by content hash; a re-fetch that hashes identically is a no-op with no
model call and no change event. Record the fetch date and the source URL per figure. Respect the
egress reality: WebFetch is blocked for these domains, so state how each figure was obtained and mark
it `inferred` accordingly.

### 4. Monthly portfolio review
Reads CostOps only — never a parallel ledger. Produces the recommendation set for the period with
totals that agree with the cost surfaces (see the agreement assertion in `dec9ae64`).

### 5. Marveen-specific benchmark pack
What *our* workloads actually cost per unit of delivered work, using Phase 2's
`cost_per_accepted_task` (marginal vs allocated). Honest about its own limits: session-restart
mid-package leaves tokens unattributed (silently low), remote agents and `targetSession` tasks are
NULL by design, the worker link is inert.

## Constraints (hard)
- **Advisory only.** No autonomous commercial action of any kind. No API call that changes a plan.
- No LLM for any cost, capacity, sizing or routing decision.
- CostOps is the only measurement stack; never build a second ledger.
- External / non-trusted providers stay `enabled_for_routing: false`. A recommendation may *name* a
  cheaper external provider as market comparison, but must not imply enabling one is approved.
- Never fabricate a converted amount, a quota, or a price. `NOT PUBLISHED` and `INSUFFICIENT_EVIDENCE`
  are correct answers.
- Concrete accounts/prices/quotas stay in gitignored `store/`; only schema + `config-examples/` commit.
- Upstream candidates documented; **no PR or issue without a separate owner GO.**

## Data sensitivity
Internal. Prices and quotas are fine in `store/`. No credentials, no API keys, no env values in code,
tests, logs or reports — the market snapshot was gathered without a single login and it stays that way.

## Done when (I verify independently, and I WILL mutate your guards)
- `INSUFFICIENT_EVIDENCE` proven to fire on an unconvertible figure, and a mutation removing that
  check turns tests RED. **This is the load-bearing guard of the phase**: the engine must refuse
  rather than guess.
- A portfolio comparison containing an unconvertible line is proven NOT to silently omit it.
- Every verdict proven to carry evidence + confidence + window; a verdict without them fails a test.
- Market watch proven to make NO model call when the content hash is unchanged.
- Deterministic: the same inputs produce the same verdicts, proven by a repeat run.
- No autonomous action: proven by asserting no plan-changing call exists on any path.
- Totals agree with the CostOps surfaces (reuse the `dec9ae64` agreement assertion shape).
- `npx tsc --noEmit` 0, `npm run build` 0, FULL suite green — baseline given at dispatch, must not regress.
- Every load-bearing guard proven RED-able by a named mutation, reverted clean (`grep MUTATION` = 0).
- Worktree off our local `develop` from the FIRST edit (never the shared live install, never `git add -A`).
  Branch + report; card to `waiting`; I gate and I merge.
