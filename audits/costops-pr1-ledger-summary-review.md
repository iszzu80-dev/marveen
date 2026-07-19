# CostOps upstream PR1 -- ledger + summary (review note)

**Prepared:** 2026-07-05 by Marveen
**Status:** local prep only. NOT pushed, NO PR opened. Running `~/marveen` deployment untouched.

## Worktree / branch / base

- **Worktree:** `~/marveen-upstream-costops-pr1` (separate git worktree; `node_modules` symlinked from `~/marveen`, gitignored)
- **Branch:** `upstream/costops-pr1-ledger-summary`
- **Base commit:** `c396514` (tag `v1.19.0`, official main) -- clean upstream base, NOT the local feature branch
- **PR1 commit:** `a8711f1` -- `feat(costops): local cost ledger + monthly summary (base)`

## Where PR1 was carved from

PR1 is a **subset** of the local v0.1 commit `c93060d` ("add local ledger and token estimates"), NOT a cherry-pick. It takes the ledger/config/summary base and **strips** the token-cost/pricing parts that v0.1 bundled:

| PR1 file | Source | Change vs v0.1 |
|----------|--------|----------------|
| `src/db.ts` (+58) | c93060d schema block | cost_sources / cost_line_items / budgets + 2 indexes, inserted additively after the store_file_audit migration |
| `src/costops/config.ts` (181) | c93060d, unchanged | fixed-cost + budget loader, safe defaults, no pricing refs |
| `src/costops/ledger.ts` (288) | c93060d (was 301) | **stripped:** pricing import, `token_cost_estimate`, `estimated_total_with_token_cost`, `pricing`/`pricingExists` opts. **Kept:** month math, hashRef, confidence buckets, fixed-cost sync, summary, token_usage VOLUME (not priced) |
| `src/web/routes/costs.ts` (58) | c93060d (was 60) | **stripped:** `loadPricingConfig` import + pricing params. Kept summary/sources/budgets endpoints |
| `src/web.ts` (+2) | c93060d, identical | mount `tryHandleCosts` after `tryHandleTokenUsage` |
| `src/costops/README.md` (61) | rewritten | trimmed to PR1 scope; removed v0.2/token-cost/pricing/render sections and internal version labels |
| `src/__tests__/costops-ledger.test.ts` (204) | c93060d, unchanged | ledger unit tests |
| `src/__tests__/costops-api.test.ts` (62) | c93060d, unchanged | route-smoke tests |

## Exact PR1 scope

Cost ledger + summary base with manual fallback:
- additive DB schema: `cost_sources`, `cost_line_items`, `budgets` (+ 2 indexes)
- config loader with safe defaults; empty/absent config -> empty summary
- `GET /api/costs/summary` (+ `/sources`, `/budgets`), Bearer-gated, read-only
- manual/bootstrap fallback; empty provider-derived path handled gracefully
- token usage shown as VOLUME only, explicitly not priced
- unit + route-smoke tests; short README

## Intentionally excluded (out of PR1)

Render collector, any Render/provider API call, provider collector framework,
dry-run/import_runs, scheduled sync / timer, token pricing (`pricing.ts` +
`token_cost_estimate`), operational provider-preferred spend semantics, the
dashboard UX cleanup (`web/app.js`, `web/index.html`), all real `store/costops-*`
config, real pricing, Vault/secrets, raw provider/service/account IDs, internal
brand/domain references, local helper scripts, checkpoint artifacts.

Verified the source carries **no** brand/domain hardcode and **no** real prices.

## DB schema change

Additive only, all `CREATE TABLE IF NOT EXISTS` (+ `CREATE INDEX IF NOT EXISTS`).
No `ALTER`/`DROP` of existing tables, no data migration. Safe to run against an
existing DB; existing tables untouched.

## API change

Three new read-only routes under `/api/costs/*` (summary/sources/budgets),
Bearer-gated like every other `/api/*`. No new write surface from clients (the
only DB write is the idempotent config->ledger reflection on a summary read).

## Backward compatibility

- With no `store/costops-config.json`, the summary is empty and nothing else in
  the app changes -- existing Marveen behavior is identical.
- No existing route, table, or column is modified.
- No new env var required, no secret required, no external API call, no scheduled
  task, no dashboard/agent behavior change.

**Risk:** low. Main considerations for upstream: (1) new tables land in every DB
on init (additive, negligible); (2) `token_usage` volume query assumes the base
`token_usage` schema (present in v1.19.0: has agent/cache columns) -- verified.

## Test / build results (in the clean worktree)

- PR1 tests: `costops-ledger.test.ts` (14) + `costops-api.test.ts` (3) = **17 passed**.
- Full suite: **110 files, 1614 passed, 1 skipped, 0 failed**.
- `npm run build` (tsc): **green** (exit 0). Typecheck clean.

## Diff stat

```
 src/__tests__/costops-api.test.ts    |  62 ++++++++
 src/__tests__/costops-ledger.test.ts | 204 +++++++++++++++++++++++++
 src/costops/README.md                |  61 ++++++++
 src/costops/config.ts                | 181 ++++++++++++++++++++++
 src/costops/ledger.ts                | 288 +++++++++++++++++++++++++++++++++++
 src/db.ts                            |  58 +++++++
 src/web.ts                           |   2 +
 src/web/routes/costs.ts              |  58 +++++++
 8 files changed, 914 insertions(+)
```

## Upstream risks / notes

- The `store/costops-config.json.example` is generated on first load into the
  gitignored `store/` tree; ensure upstream `.gitignore` covers `store/` (it does
  in this base) so no real config is ever committed.
- README example uses 0-amount placeholders only.
- If upstream prefers token-usage volume also deferred, it can be dropped from the
  summary with a one-line change; kept here because it reads an existing table and
  the "never priced" test is a useful guardrail.

## Suggested PR

**Title:** `feat(costops): local cost ledger + monthly summary (base)`

**Body draft:**
> Adds a deterministic, read-mostly local cost ledger for the operator's own
> recurring costs (subscriptions, hosting, domain, SaaS). Pure SQL + arithmetic:
> no LLM, no provider API, no secrets; real amounts live in a gitignored local
> config.
>
> - additive schema: `cost_sources`, `cost_line_items`, `budgets` (+ indexes)
> - config loader with safe defaults (absent config -> empty summary, never
>   fabricated, never blocks the app)
> - `GET /api/costs/{summary,sources,budgets}` -- Bearer-gated, read-only
> - manual/fallback cost path; empty provider-derived path handled gracefully
> - token usage reported as volume only, explicitly not priced
> - unit + route-smoke tests
>
> Provider collectors, provider-API imports, token-cost pricing, scheduled sync
> and the operational dashboard are out of scope and land in follow-ups. With no
> CostOps config, existing behavior is unchanged. Additive schema only; no
> secret, env var, external call, or scheduled task introduced.

## Confirmations

- Running `~/marveen` deployment untouched (no restart, no deploy, no config/db change to the live instance).
- No push, no PR opened, no rebase of the working feature branch.
- No provider / DNS / Render change. No Vault/secrets access. Backup branches intact.
