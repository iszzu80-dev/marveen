# CostOps v0.3 -- provider API cost collectors: PLAN (no implementation)

Author: marveen (Opus) · Date: 2026-07-04 · Status: PLAN (no source changed, no provider API touched)
Builds on: v0.1 local ledger (committed c93060d) + v0.2 local token-cost estimate.
Goal: import ACTUAL usage/cost from provider APIs into the CostOps ledger, as
high-confidence `provider_api` line items -- WITHOUT overwriting the local
manual/estimate spend, and with a strict secrets-in-Vault-only posture.

Out of scope (explicit): NO agent stop, NO model routing, NO #517, NO payment /
top-up / spend-cap / provider action of any kind.

---

## 0. Recommendation up front

**Start with the OpenAI Admin Costs API collector** as the first, smallest, safest
reference implementation -- then extend the SAME interface to Anthropic (highest
value) as the fast-follow.

Why OpenAI first for the reference:
- `GET /v1/organization/costs` is a clean, **read-only**, well-documented, paginated
  JSON cost endpoint (daily buckets, per line item). Lowest blast radius.
- It proves the whole pipeline (Vault secret -> collect -> normalize -> idempotent
  upsert -> import_runs status -> estimate-vs-actual dashboard) on a low-spend
  provider before touching our largest spend.
- The same `ProviderCollector` interface then drops onto Anthropic / Vercel / GitHub.

Trade-off (your call): if you prefer **value-first over smallest-first**, start with
the **Anthropic Cost/Usage Admin API** instead -- it reconciles our LARGEST real
line (the ~17.6k HUF "Anthropic / Claude API usage" estimate) and directly
validates the estimate-vs-actual reconcile that is the whole point of v0.3. Same
safety envelope; the only delta is which Admin key sits in the Vault first.

My pick: **OpenAI as the reference collector, Anthropic as collector #2.** Both
are read-only; neither can take a provider action.

---

## 1. Which provider = smallest safe first collector?

| Provider | Endpoint (read-only cost) | Auth | API simplicity | Our spend | FOCUS |
|---|---|---|---|---|---|
| **OpenAI** | `GET /v1/organization/costs` | Admin API key (org, read) | high (clean daily buckets) | low (ChatGPT sub; 0 API) | no |
| **Anthropic** | `GET /v1/organizations/cost_report` (+ usage_report) | Admin API key (org) | high | **highest** (API usage line) | no |
| **Vercel** | billing charges / FOCUS export | Vercel token (read) | medium | low now | **yes (FOCUS)** |
| **GitHub** | `GET /orgs/{org}/settings/billing/usage` | fine-grained PAT (read billing) | high (single GET) | low | no |
| later | Gemini/GCP Billing, Cloudflare, Render, DeepSeek | varies | varies | varies | GCP=partial | 

"Smallest safe" = single read-only endpoint + narrow key scope + clean JSON ->
**OpenAI or GitHub**. "Highest value" -> **Anthropic**. Recommended sequence:
**OpenAI (reference) -> Anthropic (value) -> Vercel (FOCUS-native) -> GitHub -> rest.**

---

## 2. Vault plan (secret IDs, NO values)

All provider credentials live ONLY in the existing Vault (`src/web/vault.ts` /
`store/vault.json`, AES-256-GCM). The collector reads them via `getSecret(id)` at
run time; the value never enters config, log, transcript, audit, or a dashboard
response. Proposed vault ids (values supplied by you later via the secure handover,
never pasted in plaintext into chat/config):

- `costops.openai_admin_key`
- `costops.anthropic_admin_key`
- `costops.vercel_token`
- `costops.github_pat`
- (later) `costops.gcp_billing_sa`, `costops.cloudflare_token`, `costops.render_key`, `costops.deepseek_key`

A local, gitignored **collector config** `store/costops-collectors.json` holds only
NON-secret wiring: which providers are enabled, their `secret_ref` (a vault id, NOT
the value), org/account identifiers stored as `account_ref_hash` (never raw), FX
rate, and schedule. No key, no raw account id, no invoice ref anywhere in it.

---

## 3. Collector interface (deterministic, no LLM)

```ts
interface NormalizedCostLine {
  provider: string
  service: string                  // provider-native service/product
  billing_period_start: number     // epoch sec
  billing_period_end: number
  amount: number                   // in `currency`
  currency: string
  confidence: 'provider_api' | 'billing_export'
  usage_type?: string              // optional (tokens/requests/gb...)
  quantity?: number
  unit?: string
  data_freshness_at: number        // when the provider data was as-of
  raw_ref_hash?: string            // sha256(salt, raw invoice/line id) -- never raw
  dedup_key: string
}

interface ProviderCollector {
  provider: string
  // PURE network READ + normalize. Never writes to the provider. No LLM.
  collect(opts: { periodStart: number; periodEnd: number; secret: string; fxUsdHuf?: number }): Promise<NormalizedCostLine[]>
}
```

A generic **runner** (`src/costops/collectors/runner.ts`): for each enabled provider
-> load `secret` from Vault -> `collect()` -> map to `cost_line_items` -> idempotent
upsert -> write an `import_runs` row. On any error it imports NOTHING destructive
and records a failed/partial run (see §8). Runnable as a **manual CLI**
(`npm run costops:collect -- --provider openai --period 2026-07`) first; a
`type:"command"` scheduled task later (raw shell, zero LLM tokens).

---

## 4. provider-native -> cost_line_items mapping

Each provider gets a small pure mapper `providerResponse -> NormalizedCostLine[]`,
then the runner writes into the EXISTING `cost_line_items` (no new cost table):

- `source_id`: stable id per provider+service (e.g. `openai-api`, matching the
  manual line's source where it exists, so estimate and actual share a source).
- `charge_category`: 'usage' | 'subscription' | ... (FOCUS-aligned).
- `confidence`: 'provider_api' (or 'billing_export' for FOCUS files).
- `billed_cost`: the provider amount (FX-converted to `currency` if needed).
- `data_freshness`: the provider's as-of time (provider cost is NOT real-time).
- `source_ref`: `raw_ref_hash` only.
- `dedup_key`: see §5.

FOCUS note: Vercel's FOCUS export maps almost 1:1 (BilledCost/EffectiveCost,
ChargePeriod, ServiceName, BillingAccountId->hash). Non-FOCUS providers are
normalized into the same shape.

---

## 5. Dedup (idempotent import)

`dedup_key = "provider|<provider>|<source_id>|<YYYY-MM(-DD)>|<confidence>"`.
Re-importing the same period UPSERTS the same row (updates amount/freshness), never
duplicates. The `confidence` in the key keeps a `provider_api` row DISTINCT from the
`manual`/`estimate` row for the same source+period, so both coexist (see §6). Each
provider bucket maps to one deterministic dedup_key -> re-runs converge.

---

## 6. Manual estimate vs imported provider_api -- SEPARATE, never overwrite

**Decision: separate line items, never overwrite.** The manual/estimate line stays
(confidence `manual`/`estimate`); the imported actual is a NEW line
(confidence `provider_api`) with a distinct `dedup_key`. Rationale: keeping both
enables estimate-vs-actual **variance**, and overwriting would lose the estimate and
the audit trail.

To avoid **double counting** in the headline number, the summary RESOLVES per
`(source_id, billing_period)` to the single highest-confidence line for
`current_spend` (priority: `actual_invoice` > `provider_api` > `billing_export` >
`local_usage` > `estimate` > `manual`). Both rows remain in the ledger; a new
**reconcile view** shows, per source: estimate, actual, variance, and which one the
headline used. So: ledger keeps both; `current_spend` never double-counts; the
dashboard shows estimate and actual side by side.

---

## 7. New table: `import_runs` (a.k.a. provider_sync_status) -- YES

The cost stays in `cost_line_items`; we add ONE status table for sync health:

```sql
CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  status TEXT NOT NULL,              -- 'ok' | 'partial' | 'rate_limited' | 'error'
  rows_imported INTEGER NOT NULL DEFAULT 0,
  data_freshness_at INTEGER,         -- provider as-of time
  error_note TEXT,                   -- non-secret message only
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
```
This drives the dashboard "stale provider data" and "failed sync" signals and makes
retries safe (idempotent import + a fresh run row).

---

## 8. Dashboard display (Költségek tab)

Extend the tab, keeping v0.1/v0.2 blocks:
- **Per-source reconcile**: for each source show `estimate` and `provider actual`
  side by side + variance, with a confidence badge: `estimate` (grey), `actual`
  (green `provider_api`), `stale` (amber -- `data_freshness_at` older than a
  threshold), `sync failed` (red -- last `import_runs.status = error`).
- **Provider sync panel**: per provider, last run time, status, freshness, rows.
- Headline `current_spend` uses actual where available (labelled), estimate else.
- Everything read-only; still no provider setup / payment / cap / action controls
  on the dashboard (forbidden).

---

## 9. Token-saving

The collectors are **pure HTTP + arithmetic, zero LLM**. Preferred execution: a
manual CLI (`npm run costops:collect`) or a `type:"command"` scheduled task (raw
node/shell, the `build-done-monitor` pattern) -- never an LLM heartbeat and never a
scheduled task that prompts an agent. No model is ever invoked for collection,
mapping, dedup, or reconcile.

---

## 10. Updatable + upstreamable core, local secret/config stays

- **Upstreamable (generic, no secrets/prices)**: the `ProviderCollector` interface,
  per-provider mappers, the runner, `import_runs` schema, reconcile/summary logic,
  dashboard reconcile view, fixture tests. All config-driven.
- **Stays local (never tracked, never pushed)**: Vault secrets (`store/vault.json`),
  `store/costops-collectors.json` (enable flags + `secret_ref` vault-ids +
  `account_ref_hash`), FX. No key, amount, account id, or invoice ref in tracked
  source -- consistent with v0.1/v0.2. So the core can be updated / upstream-PR'd
  while your credentials and numbers stay on your machine.

---

## 11. Test plan (offline, deterministic, no live API)

- **Mapper units**: a saved provider RESPONSE FIXTURE (JSON) -> expected
  `NormalizedCostLine[]` (golden). No network in tests -- the HTTP layer is injected.
- **Dedup/idempotency**: import the same fixture twice -> no duplicate rows.
- **Reconcile**: estimate + provider_api for one source -> variance correct;
  `current_spend` picks the higher-confidence line (no double count).
- **import_runs**: ok / rate_limited / error transitions; a failed run deletes
  nothing and leaves the last good data intact.
- **Secret hygiene**: assert no secret / raw account id / invoice ref appears in any
  serialized output (summary JSON, import_runs.error_note, logs).
- **FX/period**: deterministic conversion + period-boundary math.

Plus: CostOps existing unit + route smoke tests stay green; typecheck; build;
frontend check if the dashboard changed; API smoke on `/api/costs/summary`.

---

## 12. Security guardrails (mandatory)

- Read-only against providers; NEVER a payment/top-up/spend-cap/provider action.
- Secrets ONLY in Vault; the collector never logs/persists/returns a key; never
  request a key in plaintext in chat/config.
- Account/invoice identifiers stored ONLY as `raw_ref_hash` (sha256+salt).
- No raw cost/secret/account/invoice in git, logs, audit, or dashboard response.
- Rate-limit / API error -> import nothing destructive, record a failed/partial run,
  keep the last good data.
- No LLM anywhere in collection/mapping/reconcile. No scheduled LLM task.
- No agent stop, no model routing, no #517 (documented future hook only).

---

## 13. Risks

- **Admin-key elevation** (OpenAI/Anthropic cost APIs need an org Admin key) ->
  Vault-only, read-only endpoints, never logged; consider a dedicated read-scoped key.
- **Provider schema drift** -> mappers isolated + fixture tests catch breakage.
- **Double counting estimate+actual** -> dedup + per-source highest-confidence resolve (§6).
- **Currency/FX + period boundaries** -> explicit FX + deterministic UTC period math.
- **Rate limits / partial data** -> idempotent import + import_runs status; never delete.
- **Stale provider cost** (not real-time) -> `data_freshness_at` + amber "stale" badge.

---

## 14. Exact MVP scope (v0.3 slice 1)

ONE provider (recommended: OpenAI, or Anthropic for value), read-only:
1. `store/costops-collectors.json` (gitignored) + Vault secret id.
2. `ProviderCollector` interface + one mapper + injectable HTTP client.
3. Runner: Vault secret -> collect -> normalize -> idempotent upsert into
   `cost_line_items` (confidence `provider_api`) -> `import_runs` row.
4. `import_runs` table (idempotent CREATE in `src/db.ts`).
5. Summary reconcile: per-source estimate vs actual + variance; `current_spend`
   resolves to highest confidence (no double count).
6. Dashboard: reconcile badges + provider sync panel.
7. Fixture tests (offline). Manual CLI first; scheduled `command` task later.
NOT in MVP: multiple providers, FOCUS import, automated scheduling, any action.

## 15. Next implementation step

On your GO: implement the OpenAI (or Anthropic) collector MVP above as a single
branch on top of `feat/costops-ledger-token-estimates`, offline fixture tests only,
Vault secret wired via the secure handover (no plaintext key in chat) -- then a
diff + test review before any live run. No provider call until the review passes and
you explicitly approve running it with a real (Vault-stored) key.

---

## 16. Decision highlights (your 5 questions)

1. **Which collector first?** Recommended: **OpenAI Admin Costs API**
   (`GET /v1/organization/costs`) as the smallest, safest reference -- clean
   read-only JSON, lowest blast radius, proves the whole pipeline. If you prefer
   value-first, **Anthropic Cost Admin API** instead (reconciles our largest real
   line). My pick: **OpenAI reference -> Anthropic #2.** Both read-only, neither can
   take a provider action.

2. **Secret / Vault prerequisites (values-less now).** One org-scoped, read-only
   **Admin key** for the chosen provider, stored ONLY in the Vault via the secure
   handover flow (never pasted in plaintext into chat/config). Vault id e.g.
   `costops.openai_admin_key` (or `costops.anthropic_admin_key`). Plus a gitignored
   `store/costops-collectors.json` holding only the `secret_ref` (vault id), an
   `account_ref_hash`, FX, and the enable flag -- no key, no raw account id. Nothing
   else is needed until you approve the first live run.

3. **Expected risk: LOW-MEDIUM.** The single real risk is the Admin-key elevation;
   mitigated by Vault-only storage, read-only cost endpoints, never logging the key,
   idempotent import, and the hard guardrail that no provider action (payment / cap /
   top-up) is even implemented. Everything is offline-testable with fixtures; no live
   provider call happens until a diff+test review passes and you explicitly approve.

4. **Is a main/upstream sync needed first?** **No.** The `feat/costops-ledger-token-
   estimates` branch was cut from the current main (which was in sync with origin at
   commit time), so v0.3 can build on it directly. A rebase onto the latest
   develop/main is only relevant WHEN we decide to open the upstream PR -- not a
   prerequisite for planning or the MVP. (If you want, I can do a read-only
   `git fetch` to confirm no upstream drift before the v0.3 branch -- no merge.)

5. **How it connects to the v0.1+v0.2 branch.** v0.3 is implemented as new
   commits/branch **on top of `feat/costops-ledger-token-estimates`**. It reuses the
   existing `cost_line_items` (adds `provider_api` rows next to the manual/estimate
   ones -- never overwriting), adds the `import_runs` table + a `src/costops/
   collectors/` module + the reconcile summary/dashboard view. The generic core stays
   upstream-PR-able; your Vault secrets + `store/costops-collectors.json` stay
   entirely local, exactly like v0.1/v0.2. No push / PR until you decide.
