# CostOps upstream — Option-B PR grouping (module → PR mapping)

For devops + fullstack to reconstruct the slices in the ~/marveen-costops-slices worktree (off origin/main v1.22.2). Internal planning doc — do NOT commit this into the upstream slices (keep it in ~/marveen/audits, shared tree).
PR1 (ledger + summary base) is ALREADY upstream (v1.22.2). PR-A (collector framework + collectors) is DONE/staged. This maps the REMAINING groups PR-B..PR-F.

Rule for every slice: additive schema only (the file's own `initXSchema(db)` called from `schema.ts`, all `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` in try/catch), its own `costops-*.test.ts` green STANDALONE, no brand/owner hardcode (genericization already done on the devops branch — DEFAULT_OWNER→env, GITHUB_BILLING_USER→env), example configs only (`*.example.json`), never the real `store/costops-*.json`.

## PR-A — Collector framework + collectors  [DONE, staged]
collectors/{types,config,runner,render,anthropic,openai,github,deepseek,codex}.ts, email-ingest.ts, import-durability.ts; import_runs table + token_usage.model/provider/model_source columns; sync spine in costs.ts; example configs. Tests: costops-{api,collectors,collectors-dryrun,render,operational,sync,import-durability,codex}.

## PR-B — Forecast + FX + accounting-core (reconciliation/correction)
- Modules: `forecast.ts`, `forecast-capture.ts`, `fx.ts`, `reconciliation.ts`, `correction.ts`
- Schema: `initFxSchema` (fx_rates + fx_source/conversion_method cols), forecast_snapshots, cost_line_items.corrects_line_id/original_amount/original_currency/fx_rate/fx_date columns
- Tests: costops-{forecast,forecast-capture,fx,reconciliation,correction}
- Depends on PR-A (cost_line_items/cost_sources present).

## PR-C — Alerts + budgets + limits + subscriptions
- Modules: `alerts.ts`, `alerts-capture.ts`, `alerts-store.ts`, `budgets.ts`, `limits.ts`, `subscriptions.ts`, `warnings.ts`, `workspace-alerts.ts`, `expiry-checks.ts`, `render-live-checks.ts`
- Schema: `initAlertsSchema` (costops_alerts), `initBudgetAuditSchema`, budgets table, provider_balance_snapshots + provider_ratelimit_snapshots (codex — already in PR-A's schema seam? keep with limits if not)
- Tests: costops-{alerts,alerts-capture,budgets,limits,subscriptions,workspace-alerts,expiry-checks,render-live-checks}
- Depends on PR-A.

## PR-D — Period close/reopen + export + invoice
- Modules: `period.ts`, `period-close.ts`, `export.ts`, `invoice.ts`, `lifecycle.ts`, `inventory.ts`, `manual-entry.ts`, `reliability-observation.ts`
- Schema: `initPeriodCloseSchema` (period_status/period_close_events), `initInvoiceSchema`, costops_reliability_snapshots, cost_line_items.voided_at/void_reason/actual_source columns
- Tests: costops-{period,close,export,invoice,lifecycle,inventory,manual-entry,reliability-observation,reconciliation?}
- Depends on PR-A (+ PR-B for correction linkage if any).

## PR-E — Optimization advisor
- Modules: `optimization.ts`, `optimization-capture.ts`, `recommendations-store.ts`
- Schema: `initOptimizationSchema` (recommendations)
- Tests: costops-{optimization,optimization-capture}
- Depends on PR-A..PR-D (reads the ledger/limits/budgets to advise).

## PR-F — UI Command Center  [LAST]
- Frontend: `web/costops/*` (shell/state/api/overview/analysis/drawer/close/charts + costops.css), `web/routes/costs.ts` UI-route additions, `web/routes/static.ts` allowlist, the costs-cc data-page.
- Depends on the full API surface (PR-A..PR-E). Ship last.

## Seam edits (per PR, tiny marked LOCAL-FORK hunks)
- `src/db.ts`: the single `initCostOpsSchema(db)` call (schema seam) — already present via PR-A/PR1; each PR adds its `initXSchema` INTO `schema.ts`, not into db.ts.
- `src/web.ts`: costs import + mount + the background-task boot (mostly PR-A + PR-F).
- `src/web/routes/costs.ts`: route additions per PR (sync in PR-A, the rest as their endpoints land).

## Ordering / dependency
PR-A (done) → PR-B, PR-C, PR-D can each go off PR-A (mostly independent; PR-D's correction-linkage wants PR-B) → PR-E after B/C/D → PR-F last. Each standalone-green. NO push to origin/Szotasz — stage all, then Marveen routes the first PR to Istvan (outward-facing gate).
