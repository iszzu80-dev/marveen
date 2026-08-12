// CostOps schema -- ALL CostOps CREATE TABLE / ALTER TABLE / CREATE INDEX
// statements live here, not in src/db.ts. This is the "schema" seam
// (docs/fork-upstream-policy.md §2a): db.ts owns exactly one call,
// `initCostOpsSchema(db)`, marked `// LOCAL-FORK: costops seam`. Every table
// this feature has ever added (v0.1 through Phase 0) is consolidated here,
// verbatim, so the upstream-owned db.ts stops growing a table per CostOps
// release. Idempotent by construction (CREATE TABLE IF NOT EXISTS, and
// `addColumn` below, which tolerates ONLY "already there") -- calling this on
// an already-migrated DB is a safe no-op, exactly like the individual
// statements were before the move.

import type Database from 'better-sqlite3'
import { initForecastSchema } from './forecast.js'
import { initFxSchema } from './fx.js'
import { initAlertsSchema } from './alerts.js'
import { initPeriodCloseSchema } from './period-close.js'
import { initBudgetAuditSchema } from './budgets.js'
import { initOptimizationSchema } from './optimization.js'
import { initInvoiceSchema } from './invoice.js'
import { initDispatchSchema } from './dispatch.js'
import { initPacketMetadataSchema } from './packet-metadata.js'
import { initSaturationEventsSchema } from './saturation-events.js'

/**
 * Add a column, tolerating ONLY "it is already there" (C-7).
 *
 * WHAT WAS WRONG. Twenty `try { db.exec('ALTER TABLE …') } catch { /* already
 * exists }` lines ran on every boot, and the catch swallowed EVERYTHING.
 * "The column is already there" and "this migration is broken" produced exactly
 * the same silence — a typo in a column type, a table that does not exist yet
 * because an ordering assumption changed, a disk error: all of them looked like
 * a successful no-op, and the feature that needed the column failed later
 * somewhere else entirely.
 *
 * SQLite has one specific error for the benign case, and it names the column:
 * `duplicate column name: x`. That is the only one worth ignoring; everything
 * else is a migration that did not do what it says.
 *
 * Kept as a throw rather than a log: boot-time schema is the one place where
 * carrying on with a half-applied migration is worse than stopping, because
 * every later read then produces a plausible wrong answer instead of an error.
 */
function addColumn(db: Database.Database, table: string, columnDef: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`)
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (/duplicate column name/i.test(message)) return
    throw new Error(`CostOps schema: ALTER TABLE ${table} ADD COLUMN ${columnDef} failed: ${message}`)
  }
}

export function initCostOpsSchema(db: Database.Database): void {
  // CostOps v0.2: model/provider enrichment on the CORE token_usage table
  // (not CostOps-owned, but this feature bolts 3 nullable columns onto it for
  // token-cost estimation). Nullable + forward-only: NEW ingested rows carry
  // the model from the transcript; existing rows stay NULL (unknown) -> left
  // unpriced, never guessed. Must run after token_usage itself exists --
  // db.ts calls initCostOpsSchema() after that table's own setup.
  addColumn(db, 'token_usage', `model TEXT`)
  addColumn(db, 'token_usage', `provider TEXT`)
  addColumn(db, 'token_usage', `model_source TEXT`)
  // --- CostOps (local cost ledger, v0.1) ---
  // Read-mostly, FOCUS-inspired. cost_sources = provider/subscription origin,
  // cost_line_items = individual charge rows (estimate or provider-sourced),
  // budgets = display-only warning thresholds. No secrets/account IDs stored raw.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      source_type TEXT NOT NULL,
      account_ref TEXT,
      currency TEXT NOT NULL DEFAULT 'HUF',
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  // Card 484cad98: decommissioned lifecycle state. A cost source whose account
  // has been deleted (e.g. Render account deleted 2026-07-30) is NOT deleted
  // from the ledger -- that would silently drop historical costs. Instead it
  // transitions to 'decommissioned': historical line items are preserved (the
  // ledger total is invariant), but the source is excluded from active-
  // collection queries (sync, forecast, reconciliation, inventory, alerts,
  // optimization). 'decommissioned' is a terminal state; a source cannot be
  // reactivated (the provider account no longer exists). For a source that is
  // merely paused/disabled, use active=0 with lifecycle_state='active'.
  addColumn(db, 'cost_sources', `lifecycle_state TEXT NOT NULL DEFAULT 'active'`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_sources_lifecycle ON cost_sources(lifecycle_state, active)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_line_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES cost_sources(id),
      charge_period_start INTEGER NOT NULL,
      charge_period_end INTEGER NOT NULL,
      charge_category TEXT NOT NULL,
      service_name TEXT,
      usage_type TEXT,
      consumed_quantity REAL,
      consumed_unit TEXT,
      billed_cost REAL NOT NULL,
      effective_cost REAL,
      currency TEXT NOT NULL DEFAULT 'HUF',
      confidence TEXT NOT NULL,
      data_freshness INTEGER NOT NULL,
      source_ref TEXT,
      dedup_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_line_items_period ON cost_line_items(charge_period_start, charge_period_end)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_line_items_source ON cost_line_items(source_id)`)
  // v0.7 currency-retention (additive, Phase-3 per the spec): when a line's
  // billed_cost is HUF-converted from a foreign-currency invoice, keep the original
  // amount/currency/fx_rate/fx_date alongside it so the UI can show "11.15 USD ->
  // 4014 HUF" instead of just the converted number. NULL for lines that were never
  // converted (already-HUF entries) -- never fabricated, no existing calc touched.
  addColumn(db, 'cost_line_items', `original_amount REAL`)
  addColumn(db, 'cost_line_items', `original_currency TEXT`)
  addColumn(db, 'cost_line_items', `fx_rate REAL`)
  addColumn(db, 'cost_line_items', `fx_date INTEGER`)
  // v0.8 (card 6f4d1332): distinguishes "we queried the provider API live" (provider_api) from
  // "we read an email invoice" (email_invoice) from "config-driven fixed cost" (manual_entry) --
  // neither `confidence` (the priority/authoritativeness axis) nor `cost_sources.source_type`
  // (a category axis) cleanly carries this. Nullable, no default: every write site sets it
  // explicitly; a NULL row (pre-migration history) falls back to 'no_data' at read time, never guessed.
  addColumn(db, 'cost_line_items', `actual_source TEXT`)
  // CostOps Phase 0 (card 73e8914a decision, docs/costops/phase0-73e8914a-void-vs-delete.md):
  // a financial ledger row must never silently disappear -- void/archive instead of hard
  // DELETE, so a mistaken/superseded manual entry stays auditable. NULL = active (the
  // overwhelming majority of rows, including all pre-Phase-0 history); every read path
  // that aggregates cost_line_items must filter `voided_at IS NULL`.
  addColumn(db, 'cost_line_items', `voided_at INTEGER`)
  addColumn(db, 'cost_line_items', `void_reason TEXT`)
  // Phase 1 (GAP-05/GAP-06/GAP-14, docs/costops/phase0-73e8914a-void-vs-delete.md's
  // deferred "no supersede/correction relationship" follow-up): a correction
  // voids the wrong row (same mechanism as above) AND inserts a new row
  // pointing back at it via corrects_line_id, so "what replaced this, and
  // why" stays traceable instead of two unrelated void+POST rows correlated
  // only by matching source_id/month/timing. See correction.ts.
  addColumn(db, 'cost_line_items', `corrects_line_id INTEGER REFERENCES cost_line_items(id)`)
  // Phase 1 (GAP-09, Anvil's fx.ts): fx_source/conversion_method columns +
  // the fx_rates history table. Must run after cost_line_items exists.
  initFxSchema(db)
  // Phase 3 (GAP-12, Anvil's alerts.ts): costops_alerts lifecycle table.
  initAlertsSchema(db)
  // Phase 1 (GAP-10, Anvil's forecast.ts): forecast_snapshots.source_id
  // references cost_sources(id) -- must run after that table exists, which it
  // already does at this point in initCostOpsSchema.
  initForecastSchema(db)
  // Phase 2 (GAP-13): period_status/period_close_events -- monthly close/
  // reopen workflow. No FK dependency on any other CostOps table.
  initPeriodCloseSchema(db)
  // Phase 3 (GAP-11): budget change audit trail. No FK dependency -- budget
  // entries themselves stay in costops-config.json, not the DB.
  initBudgetAuditSchema(db)
  initOptimizationSchema(db)
  initInvoiceSchema(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      scope_ref TEXT,
      period TEXT NOT NULL DEFAULT 'monthly',
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'HUF',
      warning_threshold REAL NOT NULL DEFAULT 0.8,
      hard_threshold REAL NOT NULL DEFAULT 1.0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  // CostOps v0.3: provider cost-collector run history / sync status. No raw
  // account id, no raw API response, no secret ever stored here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      collector_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      period_start INTEGER,
      period_end INTEGER,
      imported_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message_sanitized TEXT,
      data_freshness_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_import_runs_provider ON import_runs(provider, started_at)`)
  // v0.5: sanitized per-run detail (service_count, plan breakdown, not_covered) as JSON.
  // NO raw service/account IDs -- the breakdown carries only type/plan labels + counts.
  addColumn(db, 'import_runs', `detail_json TEXT`)
  // Phase 1 (GAP-07): per-provider import lock, so two concurrent syncs of the
  // same provider (e.g. a manual "sync now" racing the scheduled one) never
  // race each other's upserts. See collectors/import-durability.ts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS import_locks (
      provider TEXT PRIMARY KEY,
      locked_at INTEGER NOT NULL,
      lock_token TEXT NOT NULL
    )
  `)
  // CostOps: provider prepaid-balance snapshots. For prepaid providers (e.g.
  // DeepSeek) that expose remaining balance but not per-period cost, MTD spend
  // is derived from the balance DROP across snapshots. No secret, no raw id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      currency TEXT NOT NULL,
      balance REAL NOT NULL,
      captured_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_balance_snapshots_provider ON provider_balance_snapshots(provider, captured_at)`)
  // CostOps: provider rate-limit / quota-usage snapshots. For providers that
  // expose a percent-of-window usage (e.g. Codex / ChatGPT Plus via the codex
  // app-server account/rateLimits/read metadata read -- NOT a model call, zero
  // quota) rather than a dollar cost. One row per capture; limits.ts reads the
  // latest per provider onto the shared threshold ladder, and a rise-rate
  // forecast projects when the window hits 100%. No secret, no raw id.
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_ratelimit_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      limit_id TEXT,
      used_percent REAL NOT NULL,
      window_duration_mins INTEGER,
      resets_at INTEGER,
      plan_type TEXT,
      captured_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ratelimit_snapshots_provider ON provider_ratelimit_snapshots(provider, captured_at)`)
  // Phase 2 / P2-C: confidence + provenance on every capacity snapshot.
  //
  // There is NO official Claude/Anthropic quota or usage API (re-checked
  // 2026-07-30 -- Anthropic's Admin API exposes COST, not remaining quota), so an
  // anthropic weekly-usage figure can only ever be an operator-supplied MANUAL
  // reading off the usage screen. Such a figure must never be storable as if it
  // were measured, and the old table had no column in which to say so: every row
  // looked identical whether it came from a real provider metadata read or a
  // human retyping a percentage. usage_confidence ('measured' | 'manual' |
  // 'inferred' | 'unknown') + snapshot_source make that explicit per row, and
  // capacity-snapshots.ts's writeRateLimitSnapshot() is the ONLY writer -- it
  // refuses 'measured' for any non-measured source, so the mislabel is not
  // reachable rather than merely discouraged.
  //
  // reset_label carries a provider's VERBATIM reset text (e.g. 'Tue 08:59') for
  // the case where no real epoch reset exists; it is never parsed into a
  // fabricated timestamp (resets_at stays NULL then).
  //
  // dedup_key + its UNIQUE index make re-reading the SAME manual snapshot on
  // every scheduled tick idempotent, instead of accumulating 24 identical rows a
  // day that would then look like 24 independent observations. Pre-migration rows
  // keep dedup_key NULL, which SQLite's UNIQUE index permits repeatedly.
  addColumn(db, 'provider_ratelimit_snapshots', `usage_confidence TEXT`)
  addColumn(db, 'provider_ratelimit_snapshots', `snapshot_source TEXT`)
  addColumn(db, 'provider_ratelimit_snapshots', `reset_label TEXT`)
  addColumn(db, 'provider_ratelimit_snapshots', `dedup_key TEXT`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ratelimit_snapshots_dedup ON provider_ratelimit_snapshots(dedup_key)`)
  // Card 3ce58384 (Phase 3 P2-C follow-up, 2026-07-30): the fleet runs TWO
  // independent Anthropic quota pools (auth profiles host_default and
  // configdir:.claude-personal), but a snapshot row had no way to say which
  // one it was FOR -- every reading looked provider-wide, so one profile's
  // exhaustion could read as both profiles' exhaustion, or the reverse.
  // Nullable, additive, same idempotent-ALTER pattern as the three columns
  // above: a pre-migration row (auth_profile NULL) stays a legitimate
  // PROVIDER-WIDE observation, not a broken row -- see capacity-snapshots.ts's
  // latestRateLimitSnapshot() for the exact-match-vs-provider-wide contract.
  addColumn(db, 'provider_ratelimit_snapshots', `auth_profile TEXT`)
  // CostOps Phase 0: baseline for the 7-day source-reliability observation window
  // (gap-analysis P0.4). One row per capture -- the whole source inventory
  // (lifecycle + freshness + sync status per source) as a sanitized JSON snapshot,
  // so day-over-day reliability can be compared once several captures exist. No
  // secret, no raw account ref (inventory.ts never includes either).
  db.exec(`
    CREATE TABLE IF NOT EXISTS costops_reliability_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      inventory_json TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reliability_snapshots_captured ON costops_reliability_snapshots(captured_at)`)
  // v0.7/v2 (card bea78483): Google Workspace payment-failure/suspension signal.
  // Gmail is NOT reachable from this backend process -- an agent-side read-only
  // sweep POSTs a structured, sanitized entry per detected signal (no raw email
  // body/subject/sender, same convention as email-ingest.ts's cost lines).
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      detected_at INTEGER NOT NULL,
      message_ref TEXT,
      dedup_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workspace_alerts_account ON workspace_alerts(account, detected_at)`)
  // v0.7/v2 gap-fill (card 65da75e6): the actual suspension DEADLINE date, when the ingest
  // sweep can read it from the email (e.g. "suspended on Aug 4") -- lets the warning show a
  // real due_date + severity that rises as the date approaches, not just a flat flag.
  addColumn(db, 'workspace_alerts', `suspension_date INTEGER`)
  // CostOps v1.0 (card ef6c6a2c, spec section 5.1): included-usage/entitlement model, kept
  // SEPARATE from cost_line_items -- included usage must never leak into operational_spend.
  // This is a presentational/status view only, same role as the existing limits.ts output for
  // subscriptions/DeepSeek balance/Render build-minutes -- it does NOT feed resolveOperational()
  // or CONF_PRIORITY/OPERATIONAL_TIER (per architect's 2026-07-08 spec, that resolver must stay
  // the single source of truth for spend; a second one would be exactly the double-counting
  // risk the whole ledger design guards against). dedup_key lets a sync job upsert idempotently
  // per (provider, product, entitlement_type, billing_period) without a separate lookup query.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entitlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      product TEXT NOT NULL,
      plan_name TEXT,
      billing_period TEXT NOT NULL,
      entitlement_type TEXT NOT NULL,
      included_limit REAL,
      included_unit TEXT,
      usage_to_date REAL,
      remaining REAL,
      usage_pct REAL,
      reset_at INTEGER,
      usage_source TEXT NOT NULL,
      usage_confidence TEXT,
      forecast_usage_period_end REAL,
      forecast_exhaustion_at INTEGER,
      overage_supported INTEGER NOT NULL DEFAULT 0,
      overage_unit_price REAL,
      forecast_overage_quantity REAL,
      forecast_overage_cost REAL,
      status TEXT NOT NULL,
      dedup_key TEXT UNIQUE,
      last_updated INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entitlements_provider ON entitlements(provider, product)`)
  // Phase 2 / P2-A (Dispatch & Outcome Attribution): dispatches / routing_events
  // / dispatch_outcomes tables + the token_usage.dispatch_id link column. Kept
  // on the CostOps seam (not db.ts, not a parallel init) so the measurement
  // stack travels with CostOps across upstream merges. Runs last: it ALTERs
  // token_usage, which the v0.2 block above has already ensured exists.
  initDispatchSchema(db)
  // Phase 2 / P2-B (Context Packet & Session Efficiency): the optional
  // packet-metadata tables hanging off a P2-A dispatch row. Same seam, right
  // after initDispatchSchema because it keys on dispatches.dispatch_id.
  initPacketMetadataSchema(db)
  // Phase 2 / P2-C: observed context-saturation events. Same seam. Must come
  // after initDispatchSchema because a recorded event may carry a dispatch_id --
  // and, crucially, may NOT (an admission REFUSAL creates no dispatch at all,
  // which is exactly the case that was previously invisible to every read path).
  initSaturationEventsSchema(db)
}
