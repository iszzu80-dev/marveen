# Card 3ce58384 — Producer Report (devops)

P2-C follow-up: capacity is read per provider, so two Anthropic auth profiles shared one usage
figure. Deferred out of Phase 3 (card 59b383a9) with marveen's explicit acceptance; carded here so
the deferral is real rather than a comment. This is a producer report, not the as-built — same
program rule as Phase 3: marveen verifies independently and never accepts on report alone.

Branch `fix/capacity-auth-profile-granularity`, worktree `/home/iszzu/marveen-wt/p3ce`, base
verified against local `develop` (fork-local marker `src/costops/schema.ts` present). **Not merged.
Not pushed.**

## What I built (per the card's exact scope)

| File | Change |
|---|---|
| `src/costops/schema.ts` | Nullable `auth_profile` column on `provider_ratelimit_snapshots` (idempotent `ALTER`, same pattern as the existing `usage_confidence`/`snapshot_source`/`reset_label`/`dedup_key` columns). |
| `src/costops/capacity-snapshots.ts` | `RateLimitSnapshotInput`/`RateLimitSnapshotRow` gained `authProfile`/`auth_profile`. `writeRateLimitSnapshot` stores it. `latestRateLimitSnapshot(db, provider, authProfile?)` — omitted `authProfile` is a byte-identical provider-wide query (no forced migration); a specific `authProfile` is an EXACT match only, so a provider-wide (`auth_profile IS NULL`) row never satisfies a named-profile query. |
| `src/costops/subscriptions.ts` | `SubscriptionEntry` gained optional `authProfile`. Validated (blank/non-string → `undefined`, never coerced to `''`). Both the auto-generated example (`EXAMPLE_CONFIG`) and the committed illustrative example (`config-examples/costops-subscriptions.example.json`) updated — the committed one now shows two entries (`host_default` / `configdir:.claude-personal`) for the same provider to make the feature concrete, not just documented. |
| `src/costops/capacity.ts` | `usageFigure` passes `sub.authProfile` through to `latestRateLimitSnapshot`. An entry with no `authProfile` keeps querying provider-wide, unchanged. |
| `src/costops/collectors/anthropic-usage.ts` | Threads each subscription entry's own `authProfile` into its `writeRateLimitSnapshot` call, so two configured profiles land as two distinct, independently-queryable rows. |
| `src/web/capacity-routing-runner.ts` | New exported `findSubscriptionFor(lifecycle, provider, authProfile)`: exact `(provider, authProfile)` entry wins; falls back to a provider-wide entry (no `authProfile` set) only when no exact entry exists — this fallback IS "no forced migration". `capacityStateFor` (now exported, was module-private) uses it instead of the old `lifecycle.find(s => s.provider === provider)`. Header comment rewritten from "deferred" to "resolved", explaining the fix. |
| `src/__tests__/costops-capacity-auth-profile.test.ts` (new, 9 tests) | Covers exactly the three guard tests the card asked for, plus the collector integration. |

## The three guard tests, each proven RED-able (mutated live, reverted clean via `diff`-verified backup)

1. **Two auth profiles, one near limit one with headroom → different states; mutate the key back to
   provider-only → red.** Test 6 (`usageFigure` end-to-end: `host_default` at 96%, `configdir:.claude-personal`
   at 12%, asserted to differ) plus test 1 (`findSubscriptionFor` returns distinct entries). Mutation:
   reverted `findSubscriptionFor` to `lifecycle.find(s => s.provider === provider)` (provider-only,
   ignoring the `authProfile` parameter entirely) → 2 tests red, including test 2's "no match for a
   provider with no entry" (now wrongly matched anything for that provider).
2. **A snapshot with a NULL `auth_profile` does not make a specific profile read healthy/constrained;
   yields unknown for profiles it does not name.** Test 5 (a provider-wide row exists; a
   `host_default`-specific query returns `null`, while the provider-wide query still sees the row) and
   test 6/8 (the end-to-end and collector scenarios). Mutation: collapsed `latestRateLimitSnapshot` to
   always ignore the `auth_profile` column (single unconditional provider-only query) → 4 tests red,
   including the collector-integration test (`syncAnthropicUsageSnapshot` writing two distinct
   profile readings, then reading back the wrong one for each).
3. **Existing provider-only configs keep working (no forced migration).** Explicitly tested:
   `findSubscriptionFor` test 3 (a provider-wide entry answers for ANY profile queried) and
   `usageFigure` test 7 (a provider-wide subscription entry reads the provider-wide snapshot
   unaffected by profile-specific rows sitting in the same table). Both pass against the SAME code
   the profile-specific tests exercise — no separate legacy code path, so there is nothing to drift
   out of sync.

## Verification

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0.
- **Full suite: 285 files, 3917 passed / 1 skipped, exit 0.** Clean baseline measured directly (my
  branch's base commit `bc49da1`, my one new test file moved aside temporarily to isolate it):
  **284 files / 3908 passed / 1 skipped.** Delta: **+1 file, +9 tests, 0 regressions** — exactly my
  one new test file; every pre-existing capacity/subscriptions/collector test (`costops-capacity-confidence`,
  `costops-capacity-view`, `capacity-routing`, `capacity-routing-store`) still passes unchanged.
- Both mutations above reverted (`diff` against a pre-mutation backup = clean) and the suite
  re-verified green afterward.

## Blast-radius note (per marveen's framing)

Capacity routing is still inert at three levels (Phase 3's own fail-closed defaults): `store/
capacity-routing-config.json` absent, `DEFAULT_CAPACITY_ROUTING_CONFIG.enabled = false`. This card
does not change that -- it only makes the underlying capacity READING correct once an operator
configures per-profile subscription entries. Arming routing remains Istvan's separate decision.

## What I did not do

- Did not merge to `develop`. Did not push. Did not move kanban card `3ce58384` to `done` -- left
  for marveen's independent gate, same as Phase 3.
- Did not touch the live install or the running dashboard.
- Did not configure any real per-profile subscription entries in `store/costops-subscriptions.json`
  (that file is gitignored/deployment-local; an operator opts in by adding `authProfile` to their own
  entries whenever they choose to).
