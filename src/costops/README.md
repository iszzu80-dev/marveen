# CostOps v0.1 -- local cost ledger

Read-only, deterministic, FOCUS-inspired cost-tracking base layer. No LLM, no
provider billing API, no secrets. Fixed/manual monthly costs are configured
locally; token usage is shown as **volume only** (not priced) until v0.2.

## How to add your first fixed costs

Edit `store/costops-config.json` (gitignored, local-only). If it does not exist,
a placeholder is generated at `store/costops-config.json.example` -- copy it:

```bash
cp store/costops-config.json.example store/costops-config.json
# then edit amounts (per month, in `currency`)
```

Example entry (amount is per month):

```json
{
  "version": 1,
  "currency": "HUF",
  "fixed_costs": [
    { "source_id": "anthropic-max", "name": "Claude Max", "provider": "anthropic", "source_type": "subscription", "amount": 22000, "confidence": "manual" },
    { "source_id": "render-hosting", "name": "Render hosting", "provider": "render", "source_type": "hosting", "amount": 12000, "confidence": "manual" }
  ],
  "budgets": [
    { "id": "global-monthly", "scope": "global", "amount": 60000, "warning_threshold": 0.8, "hard_threshold": 1.0 }
  ]
}
```

No secrets/API keys go in this file -- provider billing credentials belong in the
Vault (`src/web/vault.ts`), and only a vault-id reference would be stored here (future).

## Read-only API

- `GET /api/costs/summary?month=YYYY-MM` -- current spend, forecast, budget %,
  top sources, confidence breakdown, fixed/provider/estimate split, budget
  warning status, and token-usage **volume** (not priced). On read it idempotently
  reconciles the config's fixed costs into the ledger (upsert by dedup_key).
- `GET /api/costs/sources` -- active cost sources.
- `GET /api/costs/budgets` -- configured budgets.

All Bearer-gated like every `/api/*` route. Dashboard: "Költségek" tab.

## Guardrails (v0.1)

- No autonomous action of any kind. `warning_threshold` / `hard_threshold` are
  **display-only** -- never stop an agent, switch a model, change a spend cap,
  top-up, or modify a subscription.
- No LLM anywhere in CostOps (summary is pure SQL + arithmetic). Future periodic
  collectors must run as `type: "command"` scheduled tasks (raw shell, no LLM),
  never as an LLM heartbeat.
- No raw account IDs / invoice refs / secrets in DB, logs, audit or API response.
  Use `hashRef(salt, raw)` for identifiers if ever needed.

## v0.2 -- token-cost ESTIMATE (deterministic, no LLM/provider API)

v0.2 adds a **separate, estimate-only** token cost derived from `token_usage`.
It is never folded into `current_spend` and is clearly labelled as an estimate.

**Model enrichment (forward-only).** `token_usage` now has nullable `model`,
`provider`, `model_source` columns. The ingestion (`src/web/token-usage.ts`)
captures `message.model` from the transcript for NEW rows (`model_source =
'transcript'`) and derives a coarse `provider` (`deriveProvider`). Existing rows
stay `NULL` (unknown) -- no uncertain backfill. **The model-capture activates on
the next dashboard restart**; rows ingested before that stay unknown.

**Pricing config (local, gitignored).** Per-model rates live in
`store/costops-pricing.json` (gitignored; a safe 0-rate `.example` is generated).
Rates are **per 1,000,000 tokens** in `currency`. No provider prices are hardcoded
in tracked source. Format:

```json
{
  "version": 1,
  "currency": "HUF",
  "models": {
    "claude-opus-4-8": { "input_per_mtok": 0, "output_per_mtok": 0, "cache_read_per_mtok": 0, "cache_write_per_mtok": 0 }
  }
}
```
Keys are model ids exactly as they appear in `message.model`.

**Summary block.** `GET /api/costs/summary` gains `token_cost_estimate`
(`total_estimated_huf`, `priced_by_model[]`, `unpriced.{unknown_model_tokens,
no_rate_tokens}`, `pricing_profile_status`, `confidence: "estimate"`) and
`estimated_total_with_token_cost` (= `current_spend` + token estimate, clearly
labelled -- not added to `current_spend`). The Költségek tab shows a "Token
költségbecslés (ESTIMATE, nem számla)" section.

**Rules:** unknown model -> no cost (unpriced). Missing rate -> no cost (unpriced).
Missing pricing config -> `pricing_profile_status: "no_pricing_config"`, everything
unpriced. Estimate is never an invoice.

**Provider billing/usage API collector is v0.3** (still no external API in v0.2).

## Known limitations

- **Forward-only enrichment**: token costs only appear for rows ingested AFTER
  the dashboard restart that activates model-capture, and only once you fill
  `store/costops-pricing.json` rates. Existing rows stay unknown -> unpriced.
  (A deterministic transcript re-parse backfill is a possible v0.2.1 add-on.)
- `deriveProvider` is a coarse string heuristic; unrecognised models -> `unknown`.
- Forecast is a naive linear proration of usage-type lines; fixed monthly costs
  are attributed whole-month (no proration). Flagged via `confidence` + the
  `data_freshness` timestamp.
- No provider billing integration yet (see the maturity model in
  `audits/costops-v0.1-pr1-local-ledger-plan.md`).

## #517 future hook (documentation only)

Later, CostOps v0.2 may emit `reasonCode`s to the capacity layer
(`audits/upstream-capacity-aware-model-routing-design.md`), advisory only:
`budget_near_limit`, `budget_hard_limit`, `provider_cost_unavailable`,
`cost_data_stale`. Even then, budget signals never auto-stop anything -- the
capacity layer decides, with operator approval for hard actions.
