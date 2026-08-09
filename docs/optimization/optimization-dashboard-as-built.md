# Optimization Dashboard — As-Built

> Card `12d5c98d`. Owner spec (verbatim):
> `docs/optimization/optimization-dashboard-implementation-spec.md` (sections 1–27).
> Branch `feat/optimization-dashboard`, commits `b5ab216`, `0f50518`, `aec24b4`, `f70be5d`, `549a6b4`.
> Producer: buildfejleszto. Heavy scaffolding delegated to Codex CLI (`gpt-5.6-sol`, `model_reasoning_effort=high`),
> every file reviewed, tested, and in several cases fixed by the producer before commit — see
> "Codex-run evidence and bugs found" below.

## 1. Goal

One page answering: is the optimization system working, does it need a decision, what does it
recommend and why, what would turning something off actually do. Built entirely on top of the
existing Lean Optimization Phase 1–4 and Phase 3 capacity-routing capabilities — **no new
recommendation engine, no new capacity router, no new CostOps ledger.** This page aggregates and
controls; it computes nothing that wasn't already computed somewhere in `src/costops/*.ts` or
`src/capacity-routing.ts`.

## 2. UI architecture

Four internal tabs under one sidebar entry (`data-page="optimization"`, STATISZTIKÁK group, after
Token Monitor): **Overview**, **Routing & Capacity**, **Decisions**, **Controls**. Mirrors the
existing CostOps Command Center's module split (`web/costops/costops-shell.js`) exactly: one shell
file owning the tab bar + dispatch, one state file owning view/URL sync, one api file owning
fetch + a 60s TTL read cache, one render-helpers file, one file per tab.

```
web/optimization/
  optimization-state.js            -- view/window/drawer state + URL sync
  optimization-api.js              -- fetch wrapper, TTL cache, PATCH helper
  optimization-render-helpers.js   -- null-safe badge/HUF/percent/empty-state formatters
  optimization-shell.js            -- tab bar, shared status header, mount()
  optimization-overview.js         -- Overview tab
  optimization-routing.js          -- Routing & Capacity tab
  optimization-decisions.js        -- Decisions tab
  optimization-controls.js         -- Controls tab
  optimization.css                 -- page-scoped styles, reuses existing theme tokens
```

Wiring into the shared shell (`web/index.html`, `web/app.js`): a page container
(`#optimizationPage` / `#optimizationBody`), one `SIDEBAR_GROUPS` entry, one `NAV_I18N` entry, one
`switchPage()` dispatch line, 5 script includes + 1 CSS link. Done by hand (small precise diffs),
not delegated.

## 3. Backend domain layer

```
src/optimization/
  optimization-config.ts       -- versioned config, presets, dependency validation, atomic write
  optimization-summary.ts      -- aggregates real Phase 1-4 data into one OptimizationSummary
  optimization-routing.ts      -- routing snapshot + a NEW read-only routing preview
  optimization-decisions.ts    -- NEW decision-state + append-only audit store (Phase 4 recs only)
src/web/routes/optimization.ts -- thin HTTP adapter over the four modules above
```

**Nothing here reimplements existing business logic.** `optimization-summary.ts` calls
`buildCapacityReport` (capacity.ts), `buildPhase2Kpis` (kpi.ts), `buildPortfolioReport`
(portfolio-recommendation.ts), `buildMonthlyPortfolioReview` (monthly-portfolio-review.ts),
`buildMarveenBenchmarkPack` (marveen-benchmark-pack.ts), `readCapacityRoutingConfig` /
`listRuntimeOverlays` (capacity-routing-store.ts) — all pre-existing, all called verbatim.

## 4. Data sources per summary field

| Field | Source | Gated by module |
|---|---|---|
| `capacity` | `buildCapacityReport` (Phase 2, observation-only by contract) | `capacityMonitoring` |
| `kpi` | `buildPhase2Kpis` | `measurement` |
| `routing`, `runtime_routing_config` | `listRuntimeOverlays` + `readCapacityRoutingConfig` (Phase 3) | always attempted (passive read) |
| `top_recommendation`, `monthly_review` | `buildPortfolioReport` / `buildMonthlyPortfolioReview` (Phase 4) | `recommendations` |
| `benchmark` | `buildMarveenBenchmarkPack` (Phase 4) | `benchmarkRecommendations` |
| `market_watch` | **always** `{wired: false, ...}` | not gated — see §9 |

Every sub-report is wrapped in try/catch; a failure never crashes the summary, it reports
`available: false` with the real caught error message as `blocker`. `data_freshness` is the max
`generated_at`/similar timestamp across every sub-report actually computed this call — `null` when
nothing was computed.

## 5. Configuration model

`store/optimization-config.json` (gitignored), schema in §9 of the owner spec, implemented exactly:
`version` (optimistic-concurrency token), `masterEnabled`, `preset`
(`off|observation|advisory|active|custom`), `modules` (7 booleans), `routing`, `ui`,
`lastEnabledConfiguration` (captured the instant `masterEnabled` transitions true→false; restored
on request when turning back on).

**Presets** (`PRESET_MODULES` in `optimization-config.ts`):

| Preset | measurement | contextEfficiency | capacityMonitoring | runtimeRouting | recommendations | marketWatch | benchmarkRecommendations |
|---|---|---|---|---|---|---|---|
| off | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| observation | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ |
| advisory | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ |
| active | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**Dependency rules** (`validateModuleDependencies`, never returns a rule-violating combination):
`measurement:false` forces `runtimeRouting` and `recommendations` off (`marketWatch` untouched);
`runtimeRouting:true` requires `capacityMonitoring:true` or is forced off;
`benchmarkRecommendations:true` requires `recommendations:true` or is forced off.
`presetForModules()` recomputes the preset label from the actual module map on every read/write —
a stale/hand-edited `preset` string can never lie about what the modules actually are.

**Write path**: `writeOptimizationConfig()` — optimistic concurrency (`expectedVersion` mismatch →
`version_conflict`, no write), a `.bak` copy of the exact prior bytes before every write (**new to
this codebase** — no other config file in this repo has a backup-before-write step; flagged as new,
not a copy of an existing pattern), atomic write via the existing `src/web/atomic-write.ts`.

## 6. Backend API

All ten endpoints from spec §10, at `/api/optimization/*`, auth inherited globally
(`src/web/auth-gate.ts` — no manual check in the route file):

- `GET /summary`, `GET /routing` (filters: agent/state/problematicOnly), `POST /routing/preview`
  (read-only, agent-only body), `GET /recommendations`, `GET /recommendations/events`,
  `POST /recommendations/decision`, `GET /settings`, `PATCH /settings` (preview:true dry-run,
  optimistic concurrency), `GET /audit` (metadata only), `POST /emergency-disable` (unconditional,
  forces only `runtimeRouting` + `automaticFallback` off).

Every GET is a pure read **except one documented exception**: `GET /recommendations` persists the
freshly computed decision-state snapshot via `upsertDecisionsFromRecommendations` — idempotent,
changes no config, starts no LLM/screening work, commented in the route itself.

## 7. Decision-state store (new)

Phase 4's `buildPortfolioReport` (package recommendations: KEEP/UPGRADE/DOWNGRADE/CANCEL/ADD/
ENABLE_USAGE_CREDIT/REBALANCE/NO_DECISION/INSUFFICIENT_EVIDENCE) had **no persistence anywhere** —
every call recomputed fresh with no memory of a human decision. This dashboard adds
`optimization_decisions` (current status per package) + `optimization_decision_events`
(append-only audit trail — every transition, including first-observed, gets one row, never
overwritten) specifically for these.

**Deliberately NOT merged** with the older, already-live `src/costops/optimization.ts` /
`recommendations-store.ts` (GAP-17's subscription/hosting-savings detector engine — 9 different
recommendation types, a different status enum `open/accepted/dismissed/resolved/expired`, and
completely different row fields: `current_monthly_cost`, `estimated_monthly_saving`,
`switching_cost`, `risk` — none of which exist on a Phase 4 `PackageRecommendation`). Forcing these
into one table would fabricate a correspondence between two genuinely different kinds of
recommendation. GAP-17's engine keeps running exactly as it did before this card, unmodified,
independently surfaced on the existing Cost page's own attention/recommendation panels.

Status vocabulary: `new / viewed / accepted / rejected / deferred / canary_needed / executed /
expired / insufficient_evidence`. A decided item (`executed/rejected/expired`) whose verdict
changes on the next refresh reopens to `new` with an audit event explaining why. An item still
mid-review (`deferred/viewed/canary_needed`) is never touched by a routine data refresh — only its
computed columns (verdict/evidence/confidence) update, status stays exactly where a human left it.

## 8. Module dependency rules (runtime enforcement)

Implemented exactly as specified in §8.5 of the owner spec, enforced server-side in
`validateModuleDependencies` and re-checked on every read (self-healing — an invalid on-disk
combination is corrected the moment it's read, never silently kept).

## 9. Known gaps (named honestly, not hidden)

1. **Market watch has no scheduler.** `runMarketWatchCycle` (Phase 4, deterministic
   fetch→normalize→hash→diff→change-event core) has zero production callers anywhere in this
   codebase — confirmed by full-tree grep before this card started, and unchanged by it. The
   `marketWatch` module flag controls whether the *dashboard* treats this as intentionally-off vs.
   blocked-on-infra, but `market_watch.wired` in the summary is **unconditionally `false`**
   regardless of that flag — a config toggle cannot retroactively wire a cron that was never built.
   Building the actual fetcher (WebFetch is blocked for the relevant vendor domains; a real fetcher
   would need to read a WebSearch-gathered snapshot, as `research` did once manually) and the
   schedule itself is explicitly out of scope for this card.
2. **No recommendation→approval integration.** Spec §7.3 wants a `REBALANCE`-type decision to
   create a routing/config diff + approval request through the existing Jóváhagyások/Approvals
   system before any routing change applies. This was **not built** in this pass — accepting a
   `REBALANCE` recommendation today only records the local decision (`optimization_decisions`
   status → `accepted`); it does not create an approval request, and no routing config changes as
   a result. Named explicitly rather than silently no-op'd; canary scenario 8's second half is
   unproven for this reason (see `optimization-canary.test.ts`'s own comment).
3. **Presets are read-only in the Controls UI**, not one-click buttons. The frontend has no access
   to `PRESET_MODULES` (backend-only); a one-click preset button would have to guess or duplicate
   the server's module map on the client. Scoped out deliberately — the preset label recomputes
   itself from the module toggles, which is the honest mechanism.
4. **No authenticated operator identity** is plumbed to the Decisions tab yet. Every decision is
   recorded with a fixed `actor: 'dashboard-operator'` string, not a real logged-in user. Named in
   a code comment in `optimization-decisions.js`, not silently guessed.
5. **The Overview tab omits one KPI card from the original mockup** ("Elfogadási minőség" /
   acceptance quality + retry trend) — `OptimizationSummary` exposes no acceptance-rate or
   retry-trend field at this aggregation layer today. Not fabricated; named in a code comment at
   the exact point it would have gone.
6. **No live end-to-end browser check was performed** in this pass, and unlike gaps 1–5 this is
   not a scope boundary — it is unperformed verification against the owner spec's own acceptance
   criteria. `src/index.ts` spawns agent processes and touches credential files on boot, which is
   unsafe to run casually in a build worktree, so every verification in this card was done via
   `tsc`, the full automated suite, and route-level smoke tests against a real in-memory DB (the
   same pattern already established for every other `web/costops/*.js`-adjacent route in this
   repo). That is a correct and sufficient proof for everything it covers, but section 21's
   acceptance list is explicitly conjunctive ("csak ha MIND teljesül") and three of its items —
   light+dark, desktop+tablet+mobil, and keyboard+screen-reader alapok — cannot be established
   without actually rendering the page. **Those three items are therefore UNMET, not merely
   pending a nice-to-have follow-up.** Overall status: **MET-EXCEPT-RENDER** — every gate-able-
   without-a-browser criterion in section 21 passes; the render-dependent criteria are open until
   someone performs that check, pre-go-live. (Correction credited to deliverylead's review of this
   card, 2026-07-31.)

## 10. Tests

- `optimization-config.test.ts` (16) — presets, dependency validation (including a regression test
  for a real bug found on review: a duplicate-error misattribution when two rules fired at once),
  optimistic-concurrency write (byte-for-byte unchanged on a rejected write), `.bak` backup.
- `optimization-summary.test.ts` (6), `optimization-routing.test.ts` (5),
  `optimization-decisions.test.ts` (8) — domain-layer coverage per module.
- `optimization-routes.test.ts` (12) — full HTTP-route smoke coverage, including a real bug found
  and fixed (schema-not-initialized-before-first-call crash on `/audit` and
  `/recommendations/decision`).
- `optimization-canary.test.ts` (4) — scenarios 1, 5, 6, 8 from spec §20 (2, 3, 4, 7 covered by
  earlier tests; see the file's own header comment for the full mapping).

**51 new backend tests total.** Mutation-proven guards (broken, confirmed red, reverted clean,
`git status`/`git diff` empty afterward, zero leftover `MUTATION` markers): the dependency-gate
rules, the optimistic-concurrency version check, `market_watch.wired`'s unconditional falseness,
and the routing-preview's never-writes guarantee (caught independently by both a behavioral
byte-comparison test on the real overlay file path AND a structural forbidden-call source scan).

Frontend: `node --check` syntax validation on all 8 `.js` files; no automated test harness exists
for frontend JS anywhere in this repo (confirmed by grep before assuming one was missing) — verified
by the null-safety/XSS-escaping/race-guard code review documented in the commit messages, pending
the manual browser check named in §9.6.

## 11. Rollback (both levels, actually tested — not asserted)

**Runtime rollback**: `POST /api/optimization/emergency-disable` forces only `runtimeRouting` +
`automaticFallback` off — proven by `optimization-routes.test.ts`'s emergency-disable test to leave
every other module, `masterEnabled`, and all config data untouched. Turning `masterEnabled` off
entirely is proven (canary scenario 5, `optimization-canary.test.ts`) to leave CostOps and Token
Monitor completely functional — they are separate route handlers that never read
`optimization-config.json` at all, not merely "expected to still work."

**Code rollback**: actually tested, not just claimed. All 5 commits on this branch
(`b5ab216`..`549a6b4`) were `git revert`ed in reverse order on a disposable throwaway branch. All 5
reverts applied with **zero conflicts**. Post-revert: `tsc --noEmit` → 0 errors, full suite → 291
files / 3982 passed / 1 skipped — **exactly matching the pre-card develop baseline byte-for-byte in
test count**, confirming the revert is complete and CostOps/Token Monitor/Phase 1-4/every other
existing test is entirely unaffected. The throwaway branch was deleted after the check; no residue
on the real branch.

## 12. Upstream / local boundary (spec §24)

**Upstream candidates**: the generic dashboard shell pattern (tab bar / state / api / render-helpers
split), the aggregate API response schemas, the module feature-flag + preset + dependency-validation
system, the routing-preview pattern (read-only wrapper around a pure decision function), the
decision-state + append-only-audit-event pattern, empty/stale/insufficient-evidence rendering
conventions.

**Deployment-local**: account names, provider permissions, package prices (`store/costops-*.json`,
already gitignored), `store/optimization-config.json` itself, the capacity-routing config's trusted
candidate list, market-watch sources (once built), recommendation evidence thresholds (none exist
yet — deterministic FX-evidence gating only).

No upstream issue/PR opened — none requested by the owner GO for this card.

## 13. Final report

See the kanban card `12d5c98d` comment thread and the bus report to marveen for the full
mit/hogyan/eredmény breakdown per commit. Verdict: **MET-EXCEPT-RENDER**. Gaps 1–5 in §9 are real
scope boundaries, not hidden failures. Gap 6 is different in kind: three literal items in section
21's conjunctive acceptance list (light+dark, desktop+tablet+mobil, keyboard+screen-reader alapok)
are currently unproven because no live render was performed, and stay open until someone does that
check pre-go-live. Everything gate-able without a browser — backend, config, dependency rules,
both rollback levels, i18n completeness — is proven and DONE.
