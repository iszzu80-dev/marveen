# CostOps upstream PR2 -- provider collector framework (review note)

**Prepared:** 2026-07-05 by Marveen
**Status:** local prep only. NOT pushed, NO PR opened. Running `~/marveen` deployment untouched.

## Worktree / branch / base

- **Worktree:** `~/marveen-upstream-costops-pr2` (separate git worktree; `node_modules` symlinked, gitignored)
- **Branch:** `upstream/costops-pr2-collector-framework`
- **Base:** built ON TOP OF PR1 (`upstream/costops-pr1-ledger-summary` @ `540fa2f`), NOT directly on main. This keeps the split logical (PR1 = ledger+summary, PR2 = collector framework).
- **PR2 commit:** `4860a42` -- `feat(costops): provider collector framework + dry-run + import_runs`

## PR2 scope

A provider-**agnostic**, offline, deterministic framework for importing provider-reported costs. No concrete provider, no live API call, no secret.

- `collectors/types.ts` -- `ProviderCollector` interface (injected HTTP fetcher -> fully offline unit tests with fixtures); normalized cost line + dry-run report shape types.
- `collectors/runner.ts` -- `runCollector()` (import + record an `import_runs` row; idempotent upsert by `dedup_key`; never throws on a collector error -- records a sanitized failure, imports nothing); `dryRunCollector()` (fetch + normalize but write NO cost line; returns planned lines + a value-free response SHAPE); `sanitizeError()`; `describeShape()`.
- `collectors/config.ts` -- loads gitignored `store/costops-collectors.json`: enable flags + a `vault:<id>` `secret_ref` (a raw key is rejected) + FX rate. No API key / raw account id ever here.
- `import_runs` table (additive) -- collector run history / sync status. No raw account id, no raw response, no secret stored.
- `collectors-config.example.json` -- generic `example` provider skeleton, `enabled:false`, `vault:` secret_ref only.
- Offline fixture tests -- a fake collector implementing `ProviderCollector`, no real provider.

## Where it was carved from

Subset of the local v0.2 (`bb0206f`) + v0.3 dry-run (`5896a3c`) commits, **stripped** of everything provider- or dashboard-specific:

| PR2 file | Source | Change |
|----------|--------|--------|
| `collectors/types.ts` | 5896a3c, unchanged | provider-agnostic types (2 comment provider-name examples genericized to `<provider>`) |
| `collectors/runner.ts` | 5896a3c, unchanged | generic runner (takes any `ProviderCollector`; `upsertProviderLines` is self-contained here, so NO ledger.ts change is needed) |
| `collectors/config.ts` | bb0206f, unchanged | collector config loader (comment genericized) |
| `collectors-config.example.json` | rewritten | generic `example` provider (was `anthropic`) |
| `src/db.ts` (+19) | bb0206f schema block | `import_runs` table + index, inserted additively after the PR1 `budgets` table |
| `costops-collectors.test.ts` | rewritten | **new** offline fixture-collector test (the original v0.2/v0.3 tests imported the concrete `anthropic` collector; rewritten to use a fake collector so PR2 carries no provider) |
| `README.md` (+27) | new section | "Provider collector framework (offline)" |

## Intentionally excluded (out of PR2)

Render collector, Render API, Anthropic/OpenAI/GitHub concrete providers (`anthropic.ts` NOT included), Vault secret use, scheduled sync, systemd timer, dashboard UX (`web/app.js` NOT included), token pricing, operational spend semantics (the v0.3 `provider_sync`/`reconcile` summary extensions to `getCostSummary` were NOT included -- summary stays exactly as PR1 left it), real store config, real price/provider/account/service data, helper scripts, checkpoint artifacts.

## DB / API change

- **DB:** one additive table `import_runs` (+ 1 index), all `CREATE TABLE IF NOT EXISTS`. No existing table touched.
- **API:** none. PR2 adds no HTTP route (the framework is library code; wiring a concrete collector to an endpoint is a later slice).

## Backward compatibility

- Additive schema only; no ALTER/DROP, no data migration.
- No new route, no new env var, no secret, no external API call, no scheduled task.
- The framework is dormant until a concrete collector + config exist (neither is in PR2). With no CostOps config, existing behavior is unchanged.
- Depends on PR1 (uses `cost_sources`/`cost_line_items` for provider-line upserts). Not independently mergeable onto main -- must land after PR1.

**Risk:** low. The runner writes provider lines into the PR1 tables via a self-contained idempotent upsert; dry-run writes nothing.

## Test / build results (in the clean worktree)

- Full suite: **111 files, 1621 passed, 1 skipped, 0 failed** (110 PR1 files + 1 new collector test; 7 new collector test cases).
- `npm run build` (tsc): **green** (exit 0). Typecheck clean.

## Diff stat

```
 src/__tests__/costops-collectors.test.ts           | 148 +++++++++++++++
 src/costops/README.md                              |  27 +++
 .../collectors/collectors-config.example.json      |  13 ++
 src/costops/collectors/config.ts                   |  69 +++++++
 src/costops/collectors/runner.ts                   | 199 +++++++++++++++++++++
 src/costops/collectors/types.ts                    |  83 +++++++++
 src/db.ts                                          |  19 ++
 7 files changed, 558 insertions(+)
```

## Dependency on PR1

PR2 branches off `540fa2f` (PR1 HEAD) and uses the PR1 ledger tables. When opening PRs upstream: PR1 first (already ready-for-review, #524), then PR2 as a follow-up targeting main after PR1 merges (or stacked on the PR1 branch).

## Suggested PR

**Title:** `feat(costops): provider collector framework + dry-run + import_runs`

**Body draft:**
> Adds a provider-agnostic, offline, deterministic framework for importing
> provider-reported costs. No concrete provider, no live API call, no secret.
>
> - `ProviderCollector` interface with an INJECTED HTTP fetcher (collectors are
>   unit-tested fully offline with fixtures)
> - `runCollector` (idempotent import + `import_runs` audit row; never throws on a
>   collector error -- records a sanitized failure and imports nothing)
> - `dryRunCollector` (fetch + normalize but write NO cost line; returns planned
>   lines + a value-free response SHAPE)
> - gitignored collectors config with `vault:<id>` secret refs only (raw keys
>   rejected); additive `import_runs` table
> - offline fixture tests
>
> Concrete providers, scheduled sync, token pricing, operational spend and
> dashboard changes are out of scope (later slices). Builds on the PR1 ledger +
> summary base; additive schema only, no secret, no external call.

## Confirmations

- No push, no PR opened. PR1 NOT modified. No rebase of the working feature branch. No PR3 started.
- No provider / DNS / Render / Vault change. Running `~/marveen` deployment untouched (no restart, no deploy).
- Worktree git status clean after commit.
