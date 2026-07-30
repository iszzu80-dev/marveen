// Lean Optimization Phase 2 / P2-C -- capacity snapshot storage + confidence.
//
// ONE writer for provider_ratelimit_snapshots, so no collector can store a
// capacity figure without saying where it came from and how much it is worth.
//
// WHY THIS EXISTS (the defect it forecloses): Anthropic publishes NO quota or
// usage API. The Admin API exposes COST, not remaining capacity, and the Claude
// usage screen shows a PERCENT with no absolute ceiling behind it (re-verified
// 2026-07-30). So an "anthropic weekly usage" number in this system is always one
// of: an operator's manual reading, something inferred from other signals, or
// unknown. It is NEVER measured. Before P2-C the snapshot table had no column in
// which to record that distinction, so a manual retype and a real provider
// metadata read produced byte-identical rows -- and any reader (dashboard,
// warnings ladder, KPI surface) would present the retype with the same authority
// as the measurement.
//
// The rule is enforced structurally, not by convention: `measured` is reachable
// ONLY from a source in MEASURED_SNAPSHOT_SOURCES, and every write goes through
// writeRateLimitSnapshot(), which calls assertSnapshotConfidence() first. A
// collector that tries to label its manual figure 'measured' throws at the write,
// which is a red test rather than a plausible-looking row.
//
// Deterministic: no LLM, no network, no secret. Pure SQLite.

import type Database from 'better-sqlite3'

/**
 * How much a stored capacity figure is worth.
 *  - measured:  read from a provider interface that reports the real figure.
 *  - manual:    a human supplied it (e.g. read off a usage screen). Real, but
 *               as of when they read it, and not re-verifiable by us.
 *  - inferred:  derived from other observations (e.g. a balance-drop burn rate).
 *  - unknown:   we have no figure. Never paired with a non-null number.
 */
export type UsageConfidence = 'measured' | 'manual' | 'inferred' | 'unknown'

/** Where a capacity snapshot physically came from. */
export type SnapshotSource =
  | 'provider_metadata_api'      // e.g. codex app-server account/rateLimits/read
  | 'operator_manual_snapshot'   // e.g. a Claude usage-screen reading in local config
  | 'derived_from_snapshots'     // e.g. a burn rate over our own stored history

/**
 * The ONLY sources that may claim 'measured'. Adding a source here is a
 * deliberate claim that the provider itself reported the figure -- it is not a
 * place to promote a manual reading to look better on a dashboard.
 */
export const MEASURED_SNAPSHOT_SOURCES: readonly SnapshotSource[] = ['provider_metadata_api']

/** The confidence a given source is ALLOWED to be stored with, at most. */
export function defaultConfidenceForSource(source: SnapshotSource): UsageConfidence {
  switch (source) {
    case 'provider_metadata_api': return 'measured'
    case 'operator_manual_snapshot': return 'manual'
    case 'derived_from_snapshots': return 'inferred'
    default: return 'unknown'
  }
}

/**
 * Throws when a figure claims more authority than its source can support. This is
 * the guard that makes "never present an inferred number as measured" a property
 * of the storage layer rather than a habit of whoever wrote the collector.
 */
export function assertSnapshotConfidence(source: SnapshotSource, confidence: UsageConfidence): void {
  if (confidence === 'measured' && !MEASURED_SNAPSHOT_SOURCES.includes(source)) {
    throw new Error(
      `capacity snapshot: confidence 'measured' is not available to source '${source}' ` +
      `(only ${MEASURED_SNAPSHOT_SOURCES.join(', ')} may claim it) -- ` +
      `store it as '${defaultConfidenceForSource(source)}' instead of overstating it`,
    )
  }
}

export interface RateLimitSnapshotInput {
  provider: string
  /** Provider-side limit identifier, when it has one. */
  limitId?: string | null
  /** 0..100 percent of the window CONSUMED. */
  usedPercent: number
  windowDurationMins?: number | null
  /** Real epoch-sec reset, ONLY when the provider gave a real timestamp. */
  resetsAt?: number | null
  /** Verbatim reset text when there is no real timestamp (never parsed into one). */
  resetLabel?: string | null
  planType?: string | null
  source: SnapshotSource
  confidence: UsageConfidence
  /** Idempotency key. Re-writing the same key is a no-op, not a second observation. */
  dedupKey: string
  capturedAt: number
}

export interface RateLimitSnapshotRow {
  provider: string
  limit_id: string | null
  used_percent: number
  window_duration_mins: number | null
  resets_at: number | null
  reset_label: string | null
  plan_type: string | null
  usage_confidence: UsageConfidence | null
  snapshot_source: string | null
  captured_at: number
}

/**
 * Persist one capacity snapshot. Returns true when a NEW row landed, false when
 * the dedup_key was already present (an unchanged manual reading re-read on the
 * next tick -- deliberately not a second observation).
 *
 * Throws when the confidence overstates the source (see assertSnapshotConfidence)
 * or when usedPercent is not a finite 0..100 number: a NaN/out-of-range capacity
 * figure is a bug in the collector, and silently clamping it would hide that.
 */
export function writeRateLimitSnapshot(db: Database.Database, input: RateLimitSnapshotInput): boolean {
  assertSnapshotConfidence(input.source, input.confidence)
  if (!Number.isFinite(input.usedPercent) || input.usedPercent < 0 || input.usedPercent > 100) {
    throw new Error(`capacity snapshot: usedPercent must be a finite 0..100 value for provider '${input.provider}'`)
  }
  if (!input.dedupKey) throw new Error('capacity snapshot: dedupKey is required (idempotency)')
  const info = db.prepare(`
    INSERT INTO provider_ratelimit_snapshots
      (provider, limit_id, used_percent, window_duration_mins, resets_at, reset_label,
       plan_type, usage_confidence, snapshot_source, dedup_key, captured_at)
    VALUES
      (@provider, @limit_id, @used_percent, @window_duration_mins, @resets_at, @reset_label,
       @plan_type, @usage_confidence, @snapshot_source, @dedup_key, @captured_at)
    ON CONFLICT(dedup_key) DO NOTHING
  `).run({
    provider: input.provider,
    limit_id: input.limitId ?? null,
    used_percent: input.usedPercent,
    window_duration_mins: input.windowDurationMins ?? null,
    resets_at: input.resetsAt ?? null,
    reset_label: input.resetLabel ?? null,
    plan_type: input.planType ?? null,
    usage_confidence: input.confidence,
    snapshot_source: input.source,
    dedup_key: input.dedupKey,
    captured_at: input.capturedAt,
  })
  return info.changes > 0
}

/** The newest snapshot for a provider, or null. Never a synthesised default. */
export function latestRateLimitSnapshot(db: Database.Database, provider: string): RateLimitSnapshotRow | null {
  const row = db.prepare(`
    SELECT provider, limit_id, used_percent, window_duration_mins, resets_at, reset_label,
           plan_type, usage_confidence, snapshot_source, captured_at
    FROM provider_ratelimit_snapshots
    WHERE provider = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `).get(provider) as RateLimitSnapshotRow | undefined
  return row ?? null
}
