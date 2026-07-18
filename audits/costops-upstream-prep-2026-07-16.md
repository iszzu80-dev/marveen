# CostOps upstream-prep (updated) — 2026-07-16

Supersedes the state in `audits/costops-upstream-split-plan.md` (2026-07-05, which covered PR1–6 for the EARLY CostOps). CostOps has grown a lot since; this reconciles the current footprint and defines the staging.
**Mode: PREP ONLY.** No push to upstream, no PR opened, no genericization edits committed yet — all gated on Istvan's explicit go (pushing to the shared upstream is outward-facing, affects other instances).

## 1. Upstream target
- **origin = `github.com/Szotasz/marveen`** = the shared/official upstream framework repo.
- **fork = `github.com/iszzu80-dev/marveen`** = our working fork.
- Goal (unchanged from the 07-05 plan / Istvan 07-02): keep the local deployment cleanly UPDATABLE (`update.sh` = `git pull --ff-only`, breaks on divergence). Upstreaming the generic CostOps slices removes long-term divergence.

## 2. Current state
- **102 commits ahead of origin/main**; ~25 are CostOps `feat(costops)` commits (Phase 0 → the Codex rate-limit collector 3a37d35, incl. the UI Command Center UI-1..4).
- **`src/costops/` footprint: 44 files** (was ~10 at 07-05): ledger, pricing, config, schema, subscriptions, limits, budgets, forecast(+capture), fx, reconciliation, correction, invoice, period(+close), alerts(+capture+store), optimization(+capture), recommendations-store, export, inventory, lifecycle, manual-entry, email-ingest, expiry-checks, warnings, workspace-alerts, reliability-observation, render-live-checks, import-durability, README + `collectors/{anthropic,openai,github,deepseek,codex,render,runner,config,types}` + example configs.
- **Seams (upstream-owned files CostOps touches, all marked LOCAL-FORK):** `src/db.ts:658` (schema seam), `src/web.ts:28/56/192/379` (import + mount + background-task seams). 5 seam points, clean + labelled.
- **Web UI:** `web/costops/*` (9 files) + `src/web/routes/costs.ts` + `src/web/routes/static.ts` allowlist.
- **Tests:** ~30 `src/__tests__/costops-*.test.ts`.

## 3. Genericization required BEFORE upstream (audit result)
Source is BRAND-CLEAN (no zstradio/mikrokonyv/quickquote/zsibongo/eskuvo/lumaseat/dora hardcode). But these local-specific hardcodes must become config/generic first:
- `src/costops/budgets.ts:36` + `inventory.ts:56` + `config.ts:53`: `DEFAULT_OWNER = 'Istvan'` → a config default (e.g. read from config, fall back to a generic `'operator'`), not a hardcoded name.
- `src/costops/collectors/github.ts:78`: `GITHUB_BILLING_USER = 'iszzu80-dev'` → config/env, not hardcoded.
- Code comments referencing `Istvan` / `Marveen` (subscriptions.ts, pricing.ts, manual-entry.ts, limits.ts, schema.ts, budgets.ts) → genericize to "the operator" / "the single-operator deployment" for upstream cleanliness (low-risk, comment-only).
- `src/costops/ledger.ts` example numbers (per the 07-05 plan) → abstract example, so they don't read as real prices.
- Confirm only `*.example.json` (zero-rate) collector/pricing configs go upstream; the real `store/costops-*.json` are gitignored and stay local.

## 4. Updated PR breakdown (small, independently-green, dependency-ordered)
The 07-05 PR1–6 still hold for the core; add PR7+ for the post-07-05 growth. Keep each PR small + reviewable + additive (schema always `CREATE TABLE IF NOT EXISTS`).
- **PR1** Cost ledger + summary (manual fallback) — c93060d core. [ready per 07-05]
- **PR2** Provider collector framework + dry-run + import_runs. [ready per 07-05]
- **PR3** Render plan-infra collector + provider-preferred operational spend.
- **PR4** API sync spine (sync endpoint + freshness/sync-state).
- **PR5** Forecast (pure-compute + capture) + FX provenance.
- **PR6** Reconciliation + correction relationship (accounting core).
- **PR7** Alerts lifecycle (schema + capture + routes) + workspace-alerts.
- **PR8** Multi-level budgets + limits/threshold-ladder + subscriptions.
- **PR9** Monthly period close/reopen + normalized export set + period-status.
- **PR10** Invoice / credit / refund / correction workflow.
- **PR11** Optimization advisor (compute + capture + recommendations-store).
- **PR12** New collectors: openai + deepseek balance + **codex rate-limit** (metadata read) + email-ingest.
- **PR13** UI Command Center (web/costops/* + costs.ts route + static allowlist) — LAST (frontend, depends on the API surface).
- Each PR carries its own `costops-*.test.ts` and is green standalone. The 5 seam edits (db.ts/web.ts) ship with PR1 (schema seam) + PR13 (mount/background seams) as tiny marked hunks.

## 5. Staging approach (execute ONLY on Istvan's go)
1. Fresh branch off `origin/main` (current upstream base), e.g. `upstream/costops-slices`.
2. Rebuild each PR as a clean slice (not a raw cherry-pick of the 25 intertwined commits — reconstruct per-PR so each is self-contained + green), applying the §3 genericization.
3. `npx vitest run` per slice green; `tsc --noEmit` clean.
4. Draft PR descriptions (what/why/additive-safety/test-evidence) — no secrets, example-configs only.
5. Open PRs to `Szotasz/marveen` IN ORDER (PR1 first), each after the previous merges — **this step is Istvan-gated** (outward-facing to the shared repo).

## 6. What stays LOCAL (never upstream)
`store/costops-*.json` (real prices/keys, gitignored), `scripts/inter-agent-evidence-gate.*`, `scripts/stale-instructions-*.sh`, `shared-dev/`, `audits/*`, and any deployment-specific config. Only the generic `src/costops/` domain + `*.example.json` + tests + the marked seams go upstream.

## 7. What needs Istvan (the go-list)
- Approve the genericization edits (§3) — small code changes to CostOps source before staging.
- Approve opening PRs to Szotasz/marveen (the actual outward-facing push), PR-by-PR.
- Decide PR granularity: 13 small PRs (this plan, cleanest review) vs fewer larger ones (faster but harder to review). Recommend the 13-small path.
