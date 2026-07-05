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

## v0.3 -- provider cost collector framework (offline; no live API in PR1)

v0.3 adds a generic, deterministic framework to import ACTUAL provider cost as
high-confidence `provider_api` line items -- **without** overwriting the local
manual/estimate rows, and with a strict secrets-in-Vault-only posture.

- **Framework** (`src/costops/collectors/`): `ProviderCollector` interface with an
  INJECTED HTTP fetcher (so collectors are unit-tested fully offline with fixtures
  -- no live call unless a real fetcher is passed after explicit approval). The
  first collector is **Anthropic** (`anthropic-cost-report`), live-ready but never
  called live in PR1; its mapper is pure and fixture-tested.
- **`runner.ts`**: loads a collector's normalized lines, idempotently upserts them
  into `cost_line_items` as `confidence='provider_api'` (dedup_key distinct from the
  manual/estimate row -> both coexist), and records an `import_runs` row. On error
  it DELETES NOTHING and records a **sanitized** failure (keys redacted).
- **`import_runs` table**: provider, collector_name, started/finished, status,
  period, imported_count, error_code, `error_message_sanitized`, data_freshness_at.
  No raw account id, no raw API response, no secret ever stored.
- **Config**: gitignored `store/costops-collectors.json` holds only non-secret
  wiring -- an `enabled` flag and a `secret_ref` like `vault:costops.anthropic_admin_key`
  (validated to REQUIRE the `vault:` form, never a raw key), plus `fx_usd_huf` and an
  optional `account_ref_hash`. A tracked safe example lives at
  `src/costops/collectors/collectors-config.example.json` (no key, no account id).
- **Summary reconcile**: the headline `current_spend` resolves each source to its
  single highest-confidence line (`actual_invoice` > `provider_api` > `billing_export`
  > `local_usage` > `estimate` > `manual`) so an actual supersedes an estimate WITHOUT
  double counting. New `reconcile[]` (per-source estimate vs actual vs variance) and
  `provider_sync[]` (last run per provider: status, freshness, stale/failed marker).
- **Dashboard**: a "Provider sync + estimate vs actual" section (empty until a run).

**Vault**: real Admin keys go into `src/web/vault.ts` via the secure handover, never
into config/log/transcript/dashboard-response. PR1 creates NO real secret and makes
NO live call. A live dry-run is a separate, explicitly-approved step. Full design:
`audits/costops-v0.3-provider-api-collectors-plan.md`.

## Known limitations

- **v0.3 PR1 is offline-only**: no provider API is called; `provider_sync`/`reconcile`
  stay empty until a Vault key is added and a live dry-run is explicitly approved.
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
