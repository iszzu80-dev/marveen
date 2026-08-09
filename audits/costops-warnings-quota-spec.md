# CostOps -- Cost/Quota/Expiry Warnings + AI-subscription quota view

Source: Istvan 2026-07-07 (Telegram msg 3427 + 3428). Faithful spec + gap analysis.
Principle: ADDITIVE only. Do NOT rewrite cost-math. The warning data model already
exists (Mason 51a571b) with the right fields -- most of this is gap-fill + frontend.

## Current state (already LIVE, verified on /api/costs/warnings, 82bb30f @ 18:31)
- Warning model has ALL requested fields: warning_type, provider, category, severity,
  message, action, threshold, current_value, unit, due_date, reset_date, expiry_date,
  source, confidence.
- 9 typed warnings fire incl: render_build_minutes_exhausted (100%), google-zst
  workspace payment_failure, Claude Max weekly-limit (manual/pending), DeepSeek balance
  (pending), domain/SSL expiry, plan_estimate_variance, invoice_amount_changed.
- Frontend loadCosts() (web/app.js ~11024) fetches /api/costs/summary + /api/costs/warnings
  and renders a categorized warnings section (~11100). Category labels already mapped.

## GAPS to build

### A. Backend gap-fill (Mason)
1. DeepSeek prepaid balance-warning tiers: <30% warning, <15% high, <5% critical.
   - Needs a reference "full/expected balance" to compute %. If only absolute balance is
     known (no baseline), emit balance value + manual threshold, or pending if no snapshot.
   - action: "top-up needed / balance low". read-only GET /user/balance (already wired).
2. Google Workspace SUSPENSION DATE lifecycle (not just payment_failure):
   - emit warning_type=expiry/lifecycle with due_date = suspension date (e.g. Aug 4),
     severity rising as it approaches; action "Payment failed" / "Suspension risk".
   - Source = Gmail read-only targeted query (workspace-alerts ingest already exists; extend
     the entry to carry suspension_date, or a second issue_type=suspension_scheduled).
3. Claude Max weekly limit: keep manual/pending (no official API, do NOT probe private
   endpoints, do NOT request a new admin key). Surface current status if known + reset
   date/window (reset_date field). Agents can stop silently -> keep as quota warning.
4. Render build-minutes: 70/90% tiers are NOT available (official Render API only exposes
   the discrete pipeline_minutes_exhausted = 100% event). Report intermediate as
   no_api_or_no_access, do NOT fabricate a %. 100%=blocker already fires. (confirmed)
5. Render spend-limit / plan usage: if visible via Render API or invoice -> warning; else
   capability/pending. Do NOT conflate plan-estimate with billing/spend-limit status.

### B. Frontend (Vecta)
1. Warnings panel discipline: TOP 3-5 teendő only at the top of the Costs page; the full
   list under a "Teendők / warnings" drill-down. Don't crowd the dashboard.
2. Category mapping in drill-down + provider/source drill-down:
   - Render build minutes -> Webservice / hosting
   - Claude Max / DeepSeek -> AI / LLM
   - Google Workspace -> Productivity / subscriptions
   - Domain/SSL -> Domains
3. NEW dedicated "AI subscription / token-limit" view (non-pay-as-you-go): Claude Max weekly
   limit + reset window, ChatGPT Plus, DeepSeek prepaid balance as a quota gauge. This is the
   piece Istvan explicitly "nem lát" (msg 3428). Distinct from PAYG cost rows.
4. Severity tiers already 3-tier (e2819ea). Render each warning with: message, action,
   due/reset/expiry date, days-remaining where applicable, current_value vs threshold.

## Data model reference (already present -- reuse, extend additively if a field is missing)
warning_type, provider, category, severity, message, action, threshold, current_value,
unit, due_date, reset_date, expiry_date, source, confidence.

## Hard rules (Istvan)
- No scraping. Only supported/read-only sources (official API, targeted Gmail read-only,
  local cert check for SSL, DNS/registrar read-only).
- No value fabrication when no API/access -> no_api_or_no_access / pending / manual.
- No DNS/domain/cert modification. No new admin keys. No unofficial/private endpoints.
