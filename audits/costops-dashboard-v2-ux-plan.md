# CostOps Dashboard v2 — UX + Rollout Plan

**Date:** 2026-07-07 · **Author:** Marveen · **Status:** PLAN ONLY — DO NOT IMPLEMENT (Istvan).
**Guardrails:** no implementation, no dashboard/backend change, no push/PR, no provider/Gmail/Render/AWS change, no new collector, PR1 untouched. This file is the only deliverable now.

## Executive summary
The current Costs page works and is data-rich but too crowded, too technical, slow to read.
v2 = a simple, executive/operational view where the whole monthly picture is graspable in ~10s,
with progressive drill-down (category → provider → source). The v0.7 BACKEND already computes
almost everything needed (forecast, budget, previous_month, MoM, operational supersede,
provider_sync/stale, warnings, lifecycle, export). v2 is mainly a UI re-organization on the
existing `/api/costs/summary` + one new grouping layer (category) + one small data addition
(retain original currency/fx per line). No change to CostOps cost math.

## Design principles (Istvan)
Not all data at once · main view very simple · drill down layer by layer on click · actual/API
data primary, manual = background, estimate only where no actual/API · NO internal
version/commit/branch/raw-id/debug in user-facing UI · 10-second comprehension.

---

## 1. Main user questions
1) Hó-vége költés? 2) Budget alatt/felett? 3) Mi változott vs előző hó? 4) Mely kategóriák viszik a pénzt? 5) Mely providerek drágák/nőttek? 6) Hol hiányzik számla/API adat? 7) Van teendő?

## 2. Layout (4 stacked zones, top = simplest)
**A) Executive summary — max 4 kártya:** Várható hó-vége (forecast) · Budget státusz (used% + forecast%, color) · Változás előző hónaphoz (±Ft, arrow) · Adatminőség/frissesség ("7 providerből 3 actual/API · 2 manual · 2 pending", "frissítve 2 órája"). Big numbers, no raw epochs.
**B) "Mi változott?"** — the story: top increases/decreases, new cost, ending/canceled sub, actual-vs-earlier-estimate delta, missing-invoice/permission. One sentence + number + direction per row.
**C) Category level (FIRST drill-down, default entry — NOT vendors):** rows = categories (§ mapping below), each: havi összeg · forecast · Δ vs előző hó · provider count · adatminőség badge-mix · warning flag. Expand → providers.
**D) Provider level (SECOND drill-down):** current · forecast · previous · change · source-type badge · status · teendő.
**E) Source/invoice level (THIRD drill-down):** invoice lines · API usage · plan-estimate (comparison, not selected) · manual fallback · token estimate (SEPARATE) · lifecycle · technical detail only in a collapsed sub-block (no raw email/ID/PII).

Category → provider mapping:
| Kategória | Providerek |
|---|---|
| AI / LLM | OpenAI (ChatGPT+API), Anthropic (Max/Pro/API), DeepSeek, Google AI |
| Webservice / hosting | Render, Vercel |
| Cloud infra | AWS (Bedrock/KMS), Cloudflare |
| Monitoring / analytics | PostHog |
| Productivity / subscriptions | Wispr Flow, egyéb SaaS |
| Communication / SMS | Twilio |
| Payments | Barion |
| Domains | domain registrarok |
| Other / unknown | manual-other, osztályozatlan |

Worked example (real current data):
```
AI / LLM
 → Anthropic → Claude Pro (Google Play invoice 8 990 HUF, paid_until 2026-07-16, CANCELED)
             → Anthropic Max (manual fallback, next charge 2026-07-20, amount missing)
 → OpenAI    → ChatGPT (manual fallback, receipt missing) · OpenAI API (usage / no_data)
 → DeepSeek  → usage/estimate (prepaid drain)
Webservice/hosting → Render → actual invoice 11.15 USD = 4 014 HUF (SELECTED)
                            → plan estimate 28 080 HUF (comparison, NOT selected, no double count)
Cloud infra → AWS → pending_permission (Cost Explorer read needed; invoice email exists, no amount)
```

## 3. Simple provider table (alongside/under category view)
Columns: Provider · Havi összeg · Adatforrás · Változás · Státusz · Teendő. Details on expand.
**Source badges (color-coded):** Számla (actual_invoice, green) · API (provider_api, green) · API becslés (plan_estimate, grey/advisory) · Kézi fallback (manual, amber) · Jogosultság kell (pending_permission, orange) · Nincs adat (no_data, light grey — never fake 0).

## 4. Warnings / teendők (deterministic, priority order)
AWS billing permission kell · Anthropic Max nincs invoice összeg · ChatGPT nincs receipt · DeepSeek nincs top-up/usage receipt · Forecast > budget (ha igaz) · Stale sync (ha igaz) · canceled subscription / paid_until. Each: severity · provider · one-line message · action. Empty: "Nincs teendő."

## 5. Havi trend
Simple last-3 / last-6 months view: total/month · category breakdown · provider breakdown only in detail · no_data explicitly marked (never fake 0). Note: current accounts are new (~June 2026), so pre-June months are legitimately no_data.

## 6. Deviza-kezelés (currency)
Every financial row shows two values where meaningful: original amount + reporting currency.
- Default reporting currency: **HUF**. Prep for selectable HUF/EUR/USD later.
- Show: original ("11.15 USD") + converted ("4 014 HUF") + FX rate source/date if available; if no conversion, just "8 990 HUF" (NO "HUF HUF").
- Main dashboard shows everything in HUF; details always show the original currency too.
- Never mix invoice-original-currency with reporting-currency. If the FX rate is estimated/manual, flag it.
- **GAP (see §11):** the ledger currently stores ONLY the HUF result (`billed_cost`); it does NOT retain original_amount / original_currency / fx_rate / fx_date. To show "11.15 USD → 4 014 HUF" the schema needs those 4 fields added to `cost_line_items` (additive) + the email-ingest module to store them. This is the one real data-model addition v2 needs.

## 7. Aggregációs logika
- category total = sum of provider OPERATIONAL-SELECTED lines (no double count).
- provider total = the single selected source per provider (not summed across confidences).
- confidence priority: actual_invoice > provider_api > provider_plan_estimate > local estimate > manual fallback.
- plan_estimate & manual = comparison-only when an actual exists (already implemented via OPERATIONAL_TIER + the plan-supersede).
- pending provider ≠ 0 → distinct "adat hiányzik / pending" status, excluded from the headline number, shown as its own state.

## 8. Diagnostics (collapsed at the bottom, hidden by default)
Collapsed "Technikai / Diagnosztika": raw provider breakdown · import_runs · sync diagnostics · confidence_breakdown · manual fallback list · token estimate breakdown · export link · dedup detail.
Hidden by default: import_runs, raw debug, dedup_key, raw_ref_hash, full token breakdown, all manual sources at once.

## 9. Vizualizáció
- **Cards:** the 4 executive cards (big number + label + one sub-stat + color only for budget/change).
- **Chart:** a simple monthly BAR chart (total/month, last 3-6) is enough; a small LINE for a single provider trend on drill-down. Avoid dense multi-series by default.
- **Top movers / waterfall:** a compact "top movers" list (not a full waterfall) for §B — cheaper + reads faster; a waterfall is optional later.
- **Data quality:** a small badge-strip ("3 Számla · 2 Kézi · 2 Jogosultság kell") + a subtle color legend.
- **Actual vs fallback:** the source badge (§3) is the primary signal; actual/API green + prominent, manual amber + muted, pending orange + actionable.
- **Drill-down look:** accordion rows (category → provider → source), each level indented, expand/collapse chevrons; the detail/technical block is a nested collapsed `<details>`.

## 10. Magyar címkék
Aktuális havi költés · Várható hó végi költés · Budget státusz · Mi változott? · Teendők · Kategóriák · Provider bontás · Adatforrás · Számla alapján · API alapján · API becslés · Kézi fallback · Jogosultság kell · Nincs adat · Eredeti deviza · Jelentési deviza.

**Entitlement/quota block labels (added 2026-07-07 with §16):** block title = **Csomagok és keretek** · quota column = **Felhasználási keret** · used = **Felhasználva** · reset = **Nullázódik** · expiry = **Lejárat** · status = **Státusz**. This block is SEPARATE from spend (§16: entitlement ≠ cost, never conflate a plan_estimate cost-proxy with a billing/quota limit).

**Entitlement `Forrás` column reuses the §3 srcBadge taxonomy** (consistency + honesty), mapped to the 4 that apply — **Számla and API becslés do NOT apply to entitlement rows**:
- official read-only source (provider API e.g. Render deploy-events / DeepSeek balance endpoint · Gmail-detected e.g. Workspace payment-failure · local cert check for SSL) → **API** (green) = "hivatalos read-only forrás".
- grantable permission missing (e.g. AWS Cost Explorer read) → **Jogosultság kell** (orange, actionable).
- no read-only source exists at all (Render 70/90% usage, spend-limit, Claude Max weekly) → **Nincs adat** (light grey) + reason text "nincs read-only forrás" — NOT a fabricated value.
- manual entry → **Kézi fallback** (amber).
Note there is NO "Kézi becslés" badge — the canonical set is exactly the six in §3.

## 11. Implementációs terv
- **Files touched:** `web/app.js` (loadCosts() render — the bulk), `web/index.html` (Costs page markup + a feature-flag/route), maybe `src/costops/summary`/route for the small additions. NO change to `ledger.ts` cost math.
- **Backend:** mostly the existing `/api/costs/summary` suffices for phases 1-2. Minimal additions only if needed (phase 3): category grouping (can be a static provider→category map applied client-side OR a small server aggregation), and the currency fields (§6 gap — additive to cost_line_items + ingest).
- **New summary fields (phase 3, only if needed):** `category` per provider/source; `original_amount`+`original_currency`+`fx_rate`+`fx_date` per line; a compact `data_quality` summary; the `warnings[]` array surfaced (v0.7 adds this); `trend` (last-3/6 months per category/provider).
- **Feature flag / route:** ship v2 under a separate route (e.g. `#costs-v2`) or a `COSTOPS_DASHBOARD_V2` flag; keep v1 reachable. Dashboard-only restart validates.
- **Rollback:** flip the flag/route back to v1 — no DB/data change, no provider/sync/ingest/timer impact.
Preferred order: (1) new layout on the SAME API, (2) minimal API expansion only if a field is missing, (3) never touch the CostOps calculation logic.

## 12. Rollout plan
- **Phase 1 — v2 layout behind a flag/route.** New v2 layout under a feature flag or separate route; old Costs view stays reachable for rollback; NO backend calc change.
- **Phase 2 — MVP on the existing summary API.** Build as much as possible from `/api/costs/summary`; UI-only reorg; dashboard-only-restart validatable.
- **Phase 3 — minimal API expansion (only if needed):** category breakdown · provider drill-down · source-level rows · original/reporting currency · data-quality summary · warnings/tasks.
- **Phase 4 — smoke + UX check:** loads · no NaN/undefined/"HUF HUF" · operational_spend unchanged by the refactor · actual/API/manual/pending clear · category→provider→source drill-down works · original+reporting currency correct · usable on mobile/small window.
- **Phase 5 — make v2 default** once smoke is green; old crowded view stays as legacy/diagnostics or rollback.
- **Phase 6 — legacy cleanup LATER** (separate GO only): remove old view/debug blocks once v2 is proven.

## 13. Rollback plan
Feature-flag toggle restores the old Costs view · no DB rollback needed · no provider-sync disable · daily sync timer untouched · invoice ingest untouched · if v2 is broken it's a UI-only fallback with zero data loss.

## 14. Acceptance criteria
10s whole-month comprehension · category-level "where the money goes" · provider-level "who's expensive/grew" · source visible in detail (invoice/API/manual) · original+reporting currency everywhere relevant · actual/API/manual/pending unambiguous · usable on mobile/small window · no "HUF HUF"/NaN/undefined · no internal branch/commit/version/debug · details reachable but not dominating · operational_spend & forecast UNCHANGED by pure UI refactor · old view restorable for rollback.

## 15. Copyable GO prompt (for LATER — do not run now)
> **GO — CostOps Dashboard v2 implementation + rollout to default.**
> Implement the v2 Costs page per audits/costops-dashboard-v2-ux-plan.md. Guardrails: no push, no PR, PR1 untouched, no provider/Gmail/Render/AWS change, no new collector, do NOT change CostOps calc logic.
> 1) Build the v2 layout (executive 4 cards + "Mi változott?" + category→provider→source drill-down + provider table with source badges + warnings panel + last-3/6 trend + collapsed diagnostics) under a feature flag / separate route (`#costs-v2`); keep v1 reachable.
> 2) Prefer the existing `/api/costs/summary`. Only if a field is missing, add minimal additive API/schema: category grouping, original_currency+fx retention on cost_line_items (+ email-ingest storing them), data-quality summary, warnings[]. No cost-math change.
> 3) HUF-primary, original currency in detail, selectable-currency-ready (HUF/EUR/USD), flag estimated FX, no "HUF HUF".
> 4) dashboard-only restart; smoke (Phase-4 checklist); confirm operational_spend/forecast unchanged.
> 5) local commit if green; then flip v2 to default (Phase 5); old view stays as legacy/rollback.
> 6) Rollback = flag back to v1, no data/DB/sync/timer/ingest impact.
> Report: files changed, new API fields (if any), smoke result, commit hash, git status, confirm no push/PR/provider-change/tracked-PII.

## Missing API fields (summary)
Only one real gap: **original_amount / original_currency / fx_rate / fx_date** are not retained per line (ledger stores HUF only) — additive schema + ingest change (Phase 3). Everything else for the main view exists or is a client-side regroup (category) on `/api/costs/summary` (which v0.7 also extends with warnings/lifecycle/trend/export).

## Estimated implementation size
- Phase 1-2 (layout + MVP on existing API): **medium**, UI-only in web/app.js + index.html, ~1 focused frontend session.
- Phase 3 (currency retention + category + trend fields): **small-medium** additive backend.
- Phase 4-5 (smoke + default cutover): small.
Net: a **medium** build, mostly frontend, low risk (flag-gated, no calc change, easy rollback).

---

## 16. Cost / quota / expiry warnings (Istvan addendum 2026-07-07)
Explicit quota/limit/expiry warning TYPES (distinct from generic cost rows). Each ties to a category, shows in the top "Teendők" (max 3-5) + the warnings drill-down + the provider/source drill-down. **Rule: if no official/read-only source, status = pending / no_api_or_no_access -- NEVER fabricate a value.**

Additive `warnings[]` fields: `warning_type · provider · category · severity · message · action · threshold · current_value · unit · due_date/reset_date/expiry_date · source · confidence`. No cost-math change.

| # | Warning type | Category | Thresholds | Read-only source availability (HONEST) |
|---|---|---|---|---|
| 1 | Render build-minutes / pipeline | Webservice/hosting | 70% warn · 90% high · 100% blocked | **100%/blocked IS detectable** from the Render deploy-events API (event type `pipeline_minutes_exhausted` -- official, read-only, no scraping). The 70%/90% intermediate usage is NOT exposed by any Render API (dashboard-only) -> `no_api_or_no_access` for those; surface the 100% state from deploy events + a "billing/usage on the Render dashboard" note. |
| 2 | Render spend-limit / plan usage | Webservice/hosting | over-limit | Render exposes NO billing/usage/plan via API -> `capability/pending`. Do NOT conflate with the plan_estimate (that's a cost proxy, not the billing spend-limit). |
| 3 | Claude Max weekly limit | AI/LLM | approaching / reached | No official API. The Claude Code agent panes DO surface e.g. "82% of weekly limit, resets 9pm" (deliverylead saw it 2026-07-07) -- a best-effort read from the agent tmux pane is possible but fragile; safest = `manual/pending` + show status+reset if known. NO unofficial/private endpoint, NO new admin key. |
| 4 | DeepSeek prepaid balance | AI/LLM | <30% warn · <15% high · <5% critical | The DeepSeek prepaid collector exists (v0.7) -- IF it has a read-only balance endpoint, use it for the real balance %; else `pending/manual`. Action: "top-up needed / balance low". |
| 5 | Google Workspace payment failure / suspension | Productivity/subscriptions | payment_failed · suspension_risk + due date | READABLE read-only via targeted Gmail query (the payment-failure email + suspension date, e.g. Aug 4). Lifecycle+action item, not just a cost row. |
| 6 | Domain + SSL expiry | Domains | ok >30d · warn ≤30d · high ≤14d · critical ≤7d | SSL expiry = LOCAL cert check (openssl/connect, read-only) -> real days-remaining. Domain-registration expiry = WHOIS/registrar read-only. Show domain · registrar · expiry_date · days_remaining · status. NO DNS/domain/cert modification. |

UI principle: these do NOT crowd the dashboard -- top shows only the top 3-5 actions; full list in the "Teendők/warnings" drill-down; each linked to its category + visible in the provider/source drill-down.

Guardrails (same as v2): no provider-side change, no scraping/private API, no new admin key, no DNS/domain/cert change, no deploy, no push, PR1 untouched. If no official/read-only source -> pending status, never a fake value.

Build note: this EXTENDS the v0.7 `warnings[]` engine with these 6 typed warnings. Items detectable read-only NOW: #1 (100% via deploy events), #5 (Gmail), #6 SSL (local cert check). Items that are pending/capability until a source exists: #1 (70/90%), #2, #3, #4 (unless the DeepSeek balance endpoint works). Wire the detectable ones live; render the rest as pending/no_api_or_no_access with the reason.
