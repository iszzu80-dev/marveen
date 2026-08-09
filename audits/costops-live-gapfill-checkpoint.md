# CostOps live gap-fill checkpoint

Date: 2026-07-07 ~22:20 CEST. Author: marveen. Scope: post-golive verification of the CostOps warnings gap-fill on the running local dashboard (http://localhost:3420). No new CostOps feature started; this is a checkpoint only.

## Running branch + commits
- Running branch (service checkout): `local/costops-live-dashboard` (local-only, NOT pushed upstream).
- Relevant commits (tip → down):
  - `e402f6c` merge(costops): backend warnings gap-fill (Workspace suspension-date lifecycle + DeepSeek balance visibility)
  - `2a94952` feat(costops): backend gap-fill (card 65da75e6) — merged via e402f6c
  - `0c1ecb9` feat(costops): frontend — render typed warnings UI (source/confidence badges, AI-subscription/quota gauges, FX rows)
- The WSL/stability fix (`23d9cb7`) also sits on this branch but is unrelated to CostOps; it went upstream separately as its own clean branch (PR Szotasz/marveen#530).

## Warning types visible (9 live)
| type | code | provider | sev | source | confidence |
|------|------|----------|-----|--------|-----------|
| cost | high_cost_manual_fallback | anthropic | low | ledger | estimated |
| cost | plan_estimate_variance | render | low | ledger | estimated |
| cost | invoice_amount_changed | anthropic | low | ledger | measured |
| access | billing_access_needed | aws | medium | config | no_api_or_no_access |
| quota | render_spend_limit_unknown | render | low | config | no_api_or_no_access |
| quota | claude_max_weekly_limit_unknown | anthropic | low | config | no_api_or_no_access |
| quota | deepseek_balance_unknown | deepseek | low | config | no_api_or_no_access |
| quota | render_build_minutes_exhausted | render | high | render_api | measured |
| expiry | workspace_suspension_scheduled | google-workspace | low | workspace_alert | measured (due 2026-08-04) |

Frontend renders each with category + action, a source badge (ledger/config/render_api/workspace_alert) and a confidence badge, plus days-remaining on due/reset/expiry.

## Operational spend / forecast (2026-07, HUF)
- Operational spend: **122 458 HUF**; forecast month-end: **122 458 HUF** (month is mostly manual/estimate, so forecast == current).
- Split: manual 118 444 · provider-derived (actual invoice) 4 014.

## Provider statuses (spend / confidence)
- anthropic: 67 004 · manual
- other: 27 000 · estimate
- deepseek: 15 450 · estimate
- openai: 8 990 · manual
- render: 4 014 · actual_invoice
- github / google / vercel / cloudflare: 0

## DeepSeek balance status
- `deepseek_balance_unknown` (quota, low, no_api_or_no_access). No official DeepSeek balance API, so the balance itself is NOT fetched. Gap-fill change: the signal is now **always shown** (previously the near-peak/single-snapshot case was silently dropped) so it never disappears — but the value stays pending until a balance is supplied manually. No fabricated number.

## Google Workspace suspension warning
- `workspace_suspension_scheduled`, source `workspace_alert`, confidence `measured`. Real date pulled via a targeted Gmail read (google-zst): **suspension 2026-08-04, 27 days remaining**. Severity rises on the 30/14/7-day lifecycle as the date approaches (currently low at 27d). Message: "google-zst: felfüggesztés 27 nap múlva (2026-08-04), ha a fizetés nem rendeződik."

## Render / invoice status
- Render actual invoice ingested: 4 014 HUF (confidence actual_invoice).
- `render_build_minutes_exhausted` (HIGH, render_api, measured): build minutes exhausted (suite-nav-sync-08wb) → new deploys blocked. This is a real live signal from the Render deploy-events API.
- `render_spend_limit_unknown` (no public billing API) and `plan_estimate_variance` (plan estimate 28 080 vs manual 4 014) both shown as low/pending.

## Currency / original-currency display status
- Frontend FX/original-currency table is **wired** (app.js renders rows where `original_currency` ≠ settlement currency; backend `export.ts` exposes original_amount/currency/fx_rate/fx_date).
- Current state: **0 rows** — no foreign-currency invoice line has been re-ingested yet, so the section is in its empty-state. It will populate once a non-HUF invoice line is ingested with the FX fields. KNOWN GAP (display correct, data pending), not a regression.

## Dashboard smoke
- dashboard HTTP 200; `/app.js` 200 (599 KB, new frontend served); `/api/costs/warnings` → 9; `/api/costs/summary` → operational figures above; `/api/costs/subscriptions` → 3 (claude-pro canceled, anthropic-max active, openai-chatgpt active).
- `systemctl --user is-active marveen-dashboard.service` = active.

## Test / build result
- `npm run build` (tsc): exit 0, clean.
- `npx vitest run costops`: **134 passed (19 files)**, full green.
- `node --check web/app.js`: syntax OK (static asset, not covered by tsc).

## Known gaps
1. Currency/FX table empty-state until a foreign-currency invoice line is re-ingested (display wired, data pending).
2. Pending (no official API) signals stay `no_api_or_no_access`: DeepSeek balance, Claude Max weekly limit, Render spend-limit, AWS billing access. Shown honestly as pending, no fabricated values.
3. `/api/costs/subscriptions` returns null amounts for the 3 subs (lifecycle/status shown, amount not populated in that endpoint shape).

## Rollback
```
# revert the two CostOps golive commits on the live branch (keeps the WSL fix):
git checkout local/costops-live-dashboard
git revert --no-edit e402f6c 0c1ecb9    # merge (with -m 1 if needed) + frontend
npm run build && systemctl --user restart marveen-dashboard.service
# the backend gap-fill branch local/costops-gapfill (2a94952) remains intact for re-merge.
```
