# CostOps v0.8 -- Cost-control usability (Istvan requirements capture)

Source: Istvan Telegram 2026-07-08 (msg 3524), explicit GO. This is the faithful
requirements capture; architect turns it into the technical/architecture spec.
Constraint from Istvan: "implementáld egy menetben, ha guardrailen belül marad."
Only ADDITIVE DB/schema changes allowed.

## Goal
The CostOps dashboard must be a real cost-control tool, not a data dump. Per line-item
it must show: actual cost, where the actual came from, month-end forecast, forecast basis,
original currency paid, limit/quota risk, and 80%+ alerts.

## 1. Actual data-source per line-item
Every cost/source row gets an explicit `actual_source` (distinct from `confidence`):
- `provider_api`  -> label "Lekérdezett adat"
- `email_invoice` -> label "Email számla"
- `manual_entry`  -> label "Manuális felvétel"
- `no_data`       -> label "Nincs adat"
- `pending_permission` -> label "Jogosultság kell"

Examples (rendered):
- Render · Email számla · 11.15 USD -> 4 014 HUF
- DeepSeek · Manuális / becslés · 15 450 HUF
- AWS · Jogosultság kell · nincs összeg

## 2. Forecast per line-item (not just top KPI)
Each item gets: `actual_month_to_date`, `forecast_month_end`, `forecast_basis`, `forecast_confidence`.
`forecast_basis` labels:
- Provider forecast / Provider current spend / Run-rate extrapoláció / Fix havi előfizetés /
  Email invoice alapján / Tokenhasználat alapján / Manuális forecast / Nincs forecast
Rules:
- No global-only forecast; per-item must show whether forecast came from provider or WE extrapolated.
- If no good basis -> `no_forecast`, NEVER a fake number.
Examples:
- Render: 4 014 HUF actual invoice, forecast=4 014, basis=email/fixed monthly invoice
- OpenAI API: forecast = MTD / elapsed_days × days_in_month, basis=provider/run-rate
- Claude Max: manual fallback, forecast=manual monthly, basis=manual forecast

## 3. Original currency INLINE in the item list (not a separate block)
Each item financial display: `original_amount original_currency -> reporting_amount HUF`.
Show: original amount, original currency, reporting amount HUF, fx_rate, fx_date/source (at least in details).
If original currency is HUF, do NOT render "HUF HUF".
Additive fields: `original_amount`, `original_currency`, `fx_rate`, `fx_date`, `fx_source`.
Additive DB/schema only.
Examples: 11.15 USD -> 4 014 HUF ; 114.30 EUR -> 45 xxx HUF ; 8 990 HUF

## 4. Subscription & limit usage (separate cost-control dimension, not just warning text)
Track e.g.: Claude Max weekly limit; Claude Pro canceled/paid_until; ChatGPT Plus;
Google Workspace payment failure/suspension; Render build minutes; DeepSeek prepaid balance; domain/SSL expiry.
Each limit/quota row: `provider`, `limit_type`, `current_usage`, `limit_value`, `usage_pct`,
`reset_date`/`paid_until`/`expiry_date`, `status`, `source`.
`status`: ok / warning / high / critical / blocked / unknown / pending_permission
Thresholds: 70% warning, 80% alert, 90% high, 100% critical/blocked. **80%+ alert MANDATORY.**

## 5. Agent token-usage -> monthly API-cost & limit forecast
Integrate existing token monitor / `token_usage` data.
- Show actual token consumption by provider/model/agent.
- Derive monthly API-cost forecast; show which agent/model drives cost.
- Limit forecast: will the 5h / weekly / monthly quota fill?
Minimum fields: `agent`, `provider`, `model`, `input_tokens`, `output_tokens`, `cache_read/write`,
`actual_cost_estimate_mtd`, `forecast_month_end`, `forecast_basis=token_runrate`, `limit_usage_pct` (if limit data).
Rules:
- API-cost and subscription-limit shown SEPARATELY.
- Do NOT assert an official Claude Max/ChatGPT limit without reliable data.
- If estimated only from local token usage -> label `token_runrate_estimate`.
- If no official limit API -> `limit_source = local_observed / manual / unknown`.

## 6. Alerting (deterministic alert block, not just data) -- msg 3525
Mandatory alert types:
- limit >80% ; limit >90% ; limit =100%/blocked
- forecast > budget
- invoice missing
- expected invoice found but amount missing
- provider permission missing
- payment failure
- subscription expiring/canceled
- domain/SSL expiring
- sync stale
- large increase vs previous month
- actual invoice materially differs from plan/manual estimate
Each alert: `severity`, `category`, `provider`, `message`, `action`, `due_date`/`reset_date`, `source`, `confidence`.
Top 3-5 alerts shown up top; full list in drill-down.

## 7. Dashboard structure (v2 layout, main throughline)
1. Executive summary
2. Top alerts / teendők
3. Kategóriák
4. Provider drill-down
5. Source / invoice / usage drill-down
6. Token & limit monitor blokk
7. Diagnostics (collapsed)
Item list must be UNIFIED (no separate islands). Each provider/source row shows:
actual, data-source, forecast, forecast-basis, original currency, HUF, limit status (if relevant), action/warning.

## 8. Guardrails (HARD)
- NO push, NO PR. PR1 stays untouched.
- NO provider-side changes. NO scraping / private API. NO new admin key request.
- NO raw invoice / email body / PII into any tracked file.
- Do NOT change cost-math priority: actual_invoice > provider_api > provider_plan_estimate > local/token estimate > manual fallback.
- No double-counting. No fake 0 for pending providers.
- Additive DB/schema only.

## 9. Return-back checklist (Istvan wants ALL of these on completion)
- what was implemented
- which new fields were added
- does actual_source work ; does forecast_basis work
- where original currency shows
- what API-cost forecast comes from the token monitor
- does limit/quota alert work ; does the 80% alert work
- dashboard smoke
- build/test result
- did operational_spend change ; did forecast change
- commit hash ; git status
- confirmation: NO push / PR / provider-side change

## Verification (Marveen, before reporting done)
LIVE-verify per the QQ/backend-live-not-visible lesson: curl each endpoint returns the new fields;
served app.js (curl :3420/app.js) renders the new sections; do NOT rely on a done-card.
