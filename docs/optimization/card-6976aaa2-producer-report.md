# Card 6976aaa2 — Producer Report (devops)

Wire DeepSeek's prepaid balance into capacity-routing availability, so the already-armed fallback
(`store/capacity-routing-config.json`: `enabled:true`, candidate `deepseek-v4-pro`) actually fires
instead of silently no-op'ing on `capacityStateFor(deepseek,...) === 'unknown'`.

Branch `feat/deepseek-balance-capacity`, worktree `/home/iszzu/marveen-wt/deepseek-balance`, base
verified against local `develop` (fork-local marker `src/costops/schema.ts` present). **Not merged.
Not pushed.**

## The defect, confirmed before writing code

`capacityStateFor(db, provider, authProfile, ...)` (`src/web/capacity-routing-runner.ts`) only ever
had ONE path: look up a subscriptions-config entry (`findSubscriptionFor`) and read a plan-window
usage figure from it (`usageFigure`). DeepSeek is a prepaid/pay-as-you-go account, not a subscription
plan — there was never a `store/costops-subscriptions.json` entry for it, so `findSubscriptionFor`
always returned `null` and the function fell through to `unknown`. `isRoutable('unknown') === false`,
so `resolveRuntimeRouting` could never select it: the config was armed, the balance was real and
already collected (`provider_balance_snapshots`, hourly, currently $8.74), but nothing connected
the two.

## What I built

| File | Change |
|---|---|
| `src/capacity-routing.ts` | New `deriveCapacityStateFromBalance(inputs, floorUsd)` (pure, exported): a DIFFERENT shape from `deriveCapacityState` — a dollar balance against a safety floor, not a fraction of a plan window. Owner rule verbatim: balance > floor → `available`; balance ≤ floor → `blocked` (not routable). No/absent balance → `unknown`. Deliberately stricter staleness than the window-based function: a stale balance is `unknown`, never `degraded` — money can be spent to zero by anything between snapshots, so "old" is not "close enough" the way a slow-moving token count is. |
| `src/costops/capacity-snapshots.ts` | New `latestBalanceSnapshot(db, provider)` reader for `provider_balance_snapshots`, mirroring `latestRateLimitSnapshot`'s role — the single reader for this new consumer, rather than a 4th inline `SELECT` copy (3 already exist in `limits.ts`/`warnings.ts`/`forecast-capture.ts`, pre-existing, out of this card's scope to refactor). |
| `src/web/capacity-routing-runner.ts` | `capacityStateFor` now branches on `provider === 'deepseek'` **before** the subscriptions-config path, dispatching to `capacityStateForDeepSeekBalance` (new, private): reads the latest balance snapshot, applies the same `activeBlockingSignal` short-circuit as the window path (a live usage-limit banner still means `blocked` regardless of balance), and calls `deriveCapacityStateFromBalance`. New exported `DEEPSEEK_BALANCE_FLOOR_USD = 1.0` — a named, documented devops decision (the card explicitly assigns picking this number to devops), not tuned to today's $8.74, chosen as "stop routing well before the account can hit exactly zero mid-request." |

## The three required guard tests, each run at BOTH layers (pure function + real end-to-end) and mutation-proven

All in `src/__tests__/capacity-routing.test.ts` (pure `deriveCapacityStateFromBalance`) and the new
`src/__tests__/costops-deepseek-balance-capacity.test.ts` (real in-memory DB → `capacityStateFor` →
actual `resolveRuntimeRouting` decision, not just the isolated comparison):

1. **balance > floor → available → `resolveRuntimeRouting` on a constrained Max primary returns
   fallback to `deepseek-v4-pro`.** Full path test inserts a real `$8.74` balance row, calls
   `capacityStateFor(db, 'deepseek', ...)`, confirms `available`, then feeds that into
   `resolveRuntimeRouting({primaryState: 'blocked', candidates: [deepseekCandidate], ...})` and
   asserts `decision.action === 'fallback'` and `decision.to.model === 'deepseek-v4-pro'`.
2. **balance ≤ floor → not routable → `no_eligible_fallback`.** Inserts `$1.00` (exactly at the
   floor), confirms `blocked`, confirms the full routing decision is `no_eligible_fallback`.
3. **no/stale snapshot → `unknown` → `no_eligible_fallback` (fail-safe preserved).** Two variants:
   no row at all (the exact pre-fix defect shape), and a row older than
   `CAPACITY_STALE_AFTER_SECONDS`. Both confirm `unknown` at the `capacityStateFor` layer and
   `no_eligible_fallback` at the full routing-decision layer.

**Mutation-proven, not just asserted** (reverted clean via `diff`-verified backups):
- Hardcoded `deriveCapacityStateFromBalance` to `return 'available'` unconditionally (exactly what
  the card explicitly forbids: "do NOT hardcode available, that fabricates a capacity signal") →
  9 tests went RED, including the full `resolveRuntimeRouting` end-to-end assertion — proving the
  guard would catch a fabricated capacity signal, not just a wrong number.
- Removed the `provider === 'deepseek'` dispatch branch from `capacityStateFor` entirely → 5 tests
  went RED — proving the branch ordering itself (checked before the subscriptions path) is
  load-bearing, not incidental.

## Sanity-checked against the real live balance (read-only, no writes)

```
SELECT balance, currency, captured_at FROM provider_balance_snapshots WHERE provider='deepseek' ...
-> {"balance":8.74,"currency":"USD","captured_at":1785443398}  (~52 min old at check time)
```

$8.74 > $1.00 floor, well within the 26h staleness window → this would resolve `available` in
production today, meaning the fallback is genuinely ready to fire as soon as this merges and the
dashboard is rebuilt/restarted (same sequencing note as every prior card in this program).

## Data sensitivity

Per the card: the data-sensitivity carve-out for DeepSeek is OFF (Istvan, no real users yet) — this
change treats DeepSeek like any other provider, no per-agent gate added or removed.

## Verification

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0.
- **Full suite: 292 files, 3999 passed / 1 skipped, exit 0.** Clean baseline measured directly at
  this branch's base (`f378626`, changes moved aside): **291 files / 3982 passed / 1 skipped.**
  Delta: **+1 file, +17 tests, 0 regressions.**

## What I did not do

- Did not merge to `develop`. Did not push. Did not move kanban card `6976aaa2` to `done` — producer
  report only, per this program's established gate process.
- Did not touch the live install or the running dashboard (needs the same rebuild+restart sequencing
  as every prior capacity-routing card before it takes effect).
- Did not add a per-agent data-sensitivity gate for DeepSeek (per Istvan's explicit direction that
  the carve-out is off).
- Did not refactor the three pre-existing inline `provider_balance_snapshots` queries in
  `limits.ts`/`warnings.ts`/`forecast-capture.ts` onto the new `latestBalanceSnapshot` reader — out
  of this card's scope, noted as a possible future consolidation, not actioned.
