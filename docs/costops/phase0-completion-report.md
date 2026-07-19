# CostOps Phase 0 -- Baseline Formalization & Source Lifecycle: completion report

**Date:** 2026-07-15
**Branch:** `mason-costops-phase0` (isolated worktree, based on `9fc1b34` -- current live HEAD)
**Verification:** unit/build only, no dashboard boot (per the day's binary-pattern-kill incident, see [[cross-worktree-dashboard-binary-pattern-kill-bug]])

## What was built

1. **`src/costops/lifecycle.ts`** (new) -- `SourceLifecycle` (`active|inactive|
   not_configured|unsupported|blocked|deprecated`) and `SourceProvenance`
   (`provider_api_actual|invoice_actual|imported_actual|manual_actual|
   calculated_estimate|unknown`) as two genuinely separate, pure derivation
   functions. 18 unit tests.
2. **`src/costops/inventory.ts`** (new) -- `buildSourceInventory()` gathers
   real signals (cost_sources, import_runs, cost_line_items, config
   overrides, credential presence) and produces one `SourceInventoryEntry`
   per active source: lifecycle, provenance, collection_method, freshness,
   last_data_freshness, sync_cadence, owner, operational_inclusion_rule,
   manual_fallback, blocker, last_successful_sync, last_attempted_sync. 12
   unit tests, including the exact OpenAI headline scenario.
3. **`GET /api/costs/source-inventory`** (new route) -- exposes the above.
   Additive; does not touch `/api/costs/summary`'s contract.
4. **`src/costops/reliability-observation.ts`** (new) -- 7-day observation
   window: `captureReliabilitySnapshot()` stores one full inventory snapshot
   in the new `costops_reliability_snapshots` table; `listReliabilitySnapshots()`
   / `getLatestReliabilitySnapshot()` read them back. Wired into `web.ts`'s
   boot sequence (capture at startup + every 24h, same pattern as the
   existing token-usage auto-collect interval) plus `POST`/`GET
   /api/costs/reliability-snapshots`. 4 module unit tests + 1 route test
   (capture-then-list-then-latest).
5. **Void/archive instead of hard DELETE** (card 73e8914a decision,
   `docs/costops/phase0-73e8914a-void-vs-delete.md`) -- `cost_line_items`
   gained nullable `voided_at`/`void_reason`; `deleteManualCost()` now voids
   (renames `dedup_key`, sets the two columns) instead of `DELETE`-ing. Every
   aggregating read path (`getCostSummary` x2, `getPeriodTrend`,
   `exportCostRows`, the pending-permission warning query) now filters
   `voided_at IS NULL`. `deleteManualEntitlement()` is unchanged (hard
   delete) -- entitlements are not financial rows, out of this decision's
   scope. 4 test changes/additions in `costops-manual-entry.test.ts`.
6. **Baseline semantics regression suite**
   (`costops-phase0-baseline-semantics.test.ts`) -- 7 tests locking the
   numbered Phase 0 acceptance criteria against one realistic mixed scenario
   (provider_api actual + plan estimate + pending_permission + manual +
   voided + token usage) simultaneously.
7. **`FixedCostEntry` gained two optional fields** (`owner`, `lifecycle_override`)
   -- additive, config-schema-only, defaults preserve all existing behavior.

## Phase 0 acceptance criteria (gap-analysis, verbatim numbering)

| # | Criterion | Status |
|---|---|---|
| 1 | Minden ismert source inventoryban szerepel | DONE -- `buildSourceInventory` covers every active `cost_sources` row |
| 2 | Minden source pontosan egy lifecycle állapotot kap | DONE -- `deriveSourceLifecycle` always returns exactly one of 6 states (tested) |
| 3 | Lifecycle és provenance külön mező | DONE -- separate fields on `SourceInventoryEntry`, separate derivation functions |
| 4 | OpenAI API source nem credential_error, ha nincs aktív API-használat | DONE -- headline test: working credential + zero usage -> `inactive` |
| 5 | Minden aktív source-nak van: collection method/provenance/freshness/cadence/owner/inclusion-rule/manual-fallback | DONE -- all 7 fields populated on every entry |
| 6 | Minden blocked source-nak van konkrét blocker és owner action | DONE -- `blocker` carries the error_code (blocked) or the missing-credential name (not_configured) |
| 7 | Nincs unknown lifecycle | DONE -- enum has no `unknown` value; explicit test |
| 8 | Nincs headline szemantikai változás | DONE -- `CostSummary` shape unchanged (explicit test); all pre-existing route/summary/operational tests pass unmodified |
| 9 | Reconciliation delta 0 marad | DONE -- explicit test with a real-invoice-supersedes-plan-estimate scenario |
| 10 | Opportunity cost nem kerül operational spendbe | DONE -- explicit test: `token_cost_estimate` is additive to `current_spend`, never merged in |
| 11 | A hétnapos observation window induló snapshotja elkészül | DONE (mechanism) -- capture function + table + boot wiring built and unit-tested; the actual 7 daily captures happen once this lands and the live process runs for a week -- that part is calendar time, not something buildable now |
| 12 | 73e8914a: dokumentált döntés (hard DELETE vs void/archive) | DONE -- decision doc + implemented: void/archive |
| 13 | Build és teljes tesztsuite zöld | DONE -- `tsc build` clean; `vitest run` 156 files / 2054 passed + 1 skipped (baseline pre-Phase-0: 152/2009+1) -- zero regressions, +45 new tests |
| 14 | API és browser smoke zöld | PARTIAL -- route-level unit tests (fakeCtx) pass; no live dashboard boot / curl smoke / browser check was performed, per the explicit "no live-boot" instruction after today's binary-pattern-kill incident. Deferred to Marveen's controlled live-verify, same as the v1.22.0 merge and the binary-pattern fix earlier today. |
| 15 | Nincs push vagy PR | DONE -- landed locally only, isolated worktree/branch |
| 16 | A meglévő upstream CostOps PR érintetlen | DONE -- no upstream-PR-related file/branch touched |

## Explicitly NOT done (out of Phase 0 scope, confirmed against the dispatch)

- Dashboard redesign, close/reopen workflow, large ledger migration,
  optimization advisor, agent/task/product attribution, routing, upstream PR
  -- none of these were touched.
- Actor/audit-trail identity for the void operation (who voided it) -- only
  `void_reason` is captured; wiring a real actor through the Bearer-token
  layer is Phase 1 scope (see the 73e8914a decision doc).
- The recurring 7-day capture cadence has not actually observed 7 real days
  yet -- it will, once this change lands and the live process stays up; that
  is an operational/calendar fact, not a code gap.

## Verify

- `tsc --noEmit` clean, `tsc` build clean.
- `vitest run`: 156 test files / 2054 passed + 1 skipped.
- Baseline (pre-Phase-0, same `9fc1b34` HEAD): 152 test files / 2009 passed + 1 skipped.
- Delta: +4 files, +45 tests, 0 failures, 0 regressions.
- No dashboard was booted at any point during this work.
