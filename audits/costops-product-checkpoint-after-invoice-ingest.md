# CostOps -- Product Checkpoint (after email invoice ingest)

**Date:** 2026-07-07
**Author:** Marveen (main worker)
**Status:** local, working, validated end-to-end. NOT deployed, NOT pushed.

## Running branch / backup / rollback
- **Running branch:** `local/costops-live-dashboard` (HEAD `d81c726`) -- a clean local copy of `feat/costops-ledger-token-estimates` + one local bugfix commit.
- **Backup:** `backup/before-costops-live-dashboard` (= `develop` @ v1.19.0, a163eaa).
- **Rollback:** `git checkout develop && systemctl --user restart marveen-dashboard.service` (fleet dashboard back to v1.19.0; the feature diverges from develop only by 13 CostOps commits + this fix, minus the trivial #523 paste-fix).
- Dashboard is the systemd user unit `marveen-dashboard.service` (`node dist/index.js`); rebuild = `npm run build` then restart.

## CostOps core features (all present + working locally)
- Local cost **ledger** + monthly **summary** + user-friendly **Costs** dashboard page.
- **Collectors** (read-only): OpenAI, GitHub (vault-keyed), DeepSeek prepaid-balance, Render plan-based infra estimate.
- **Email invoice ingest** (`POST /api/costs/email-ingest`): agent-side Gmail read-only sweep -> normalized `EmailCostEntry[]` -> pure idempotent upsert. Only a **sha256 hash** of the message ref is stored (no raw id/body/PII).
- **Operational-spend supersede** (`ledger.ts` OPERATIONAL_TIER): a real `actual_invoice`/`provider_api` (tier>=4) for a provider **supersedes that provider's `provider_plan_estimate`** -- no double count. `provider_plan_estimate` is advisory-only in the headline.
- **Daily sync timer** (`marveen-costops-sync.timer`, read-only Render sync) -- active, next fire 2026-07-08 06:15.
- **Token estimate** stays a **separate** module/route (unaffected by cost ledger).

## Provider status table (current month 2026-07)
| Provider | Amount (HUF) | Confidence | Source |
|---|---|---|---|
| anthropic (Claude Max) | 67 004 | manual | manual fallback -- Max receipt went to freemail.hu (no amount in Gmail) |
| render (hosting) | **4 014** | **actual_invoice** | Render Stripe receipt $11.15 (fx 360) -- **supersedes** the 28 080 plan estimate |
| other (SaaS/domain/etc.) | 27 000 | estimate | manual/estimate |
| deepseek | 15 450 | estimate | no receipt/top-up email -> estimate fallback |
| openai (ChatGPT) | 8 990 | manual | no receipt in Gmail -> manual fallback |
| github | 0 | manual | -- |

Confidence breakdown (July): manual 58 339 | actual_invoice 4 014 | estimate 60 105.

## Data-source classification
- **actual_invoice:** Render (July, $11.15 -> 4 014 Ft) ; Claude Pro (June, 8 990 Ft, previous month).
- **provider_plan_estimate (advisory/fallback only):** Render plan proxy (28 080) -- excluded from headline now that Render has a real actual.
- **manual fallback:** Anthropic Max (67 004), OpenAI/ChatGPT (8 990).
- **estimate:** DeepSeek (15 450), other (27 000).

## Numbers
- **operational_spend (July):** 122 458 Ft (was 146 524 before ingest -- the render plan-estimate inflation of ~24k removed).
- **forecast month-end:** 122 458 Ft (was 158 444).
- **previous month (June):** 8 990 Ft -- Claude Pro `actual_invoice` (real, not fabricated).

## Known gaps
- **ChatGPT/OpenAI:** no receipt in the iszzu80 Gmail -> stays manual (8 990). If a receipt exists elsewhere, ingest it later.
- **Anthropic Max:** welcome/charge email has no amount + went to freemail.hu (not reachable via the google-private MCP) -> stays manual (67 004).
- **DeepSeek:** no receipt/top-up email -> stays estimate (15 450).
- **Render period nuance:** the $11.15 receipt (paid July 4) represents the latest monthly cycle; assigned to 2026-07 so it supersedes the July plan estimate. Render's true July invoice won't exist until August.
- **Render plan-estimate is ~7x the actual** (28 080 vs 4 014) -- the plan collector overestimates; now advisory-only, but worth tuning later.

## Gmail ingest safety (guardrails held)
Gmail read-only (search+read only, no send/label/draft/archive/delete), targeted billing queries only (no broad mailbox), no full body logged, no raw invoice/attachment/PII in any tracked file (module stores only a hash). No provider-side change, no Vault touch, no deploy.

## Route bugfix
`d81c726` -- `/api/costs/email-ingest` cast the raw `readBody` Buffer to `{entries}` without `JSON.parse`, so posted entries were always empty (`ingested:0`). Fixed to `JSON.parse(raw.toString()||'{}')`. This is what made the ingest functional.

## Upstream PR position
- **PR1** (Szotasz/marveen #524, ledger + monthly summary): OPEN, politely pinged, **not modified**.
- **PR2** (collector framework): prepared, in queue.
- **PR3** (Render plan collector): in queue.
- The `d81c726` route JSON-parse fix belongs in the **later invoice-ingest PR** (with the email-ingest endpoint), NOT PR1.
- This checkpoint demonstrates the **full local CostOps direction is validated end-to-end** (ledger -> collectors -> invoice ingest -> supersede -> dashboard) ahead of the sliced upstreaming.

## Suggested next step
1. Keep running locally on `local/costops-live-dashboard` for daily use (timer keeps Render sync fresh).
2. When a ChatGPT/OpenAI or Anthropic-Max receipt is available (or wire the freemail.hu mailbox), ingest to replace those manual fallbacks with actual_invoice.
3. Continue the upstream slices at Szotasz's pace (PR1 -> PR2 -> PR3); fold `d81c726` into the invoice-ingest slice.
4. Optional: tune the Render plan-estimate collector (it overestimates ~7x vs the actual invoice).

## Manual decision needed?
None to run this. Optional future decision: whether to also connect the freemail.hu mailbox for the Anthropic Max actual.
