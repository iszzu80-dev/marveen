// W10 §4.7 — the policy counters, and the reason they also fix liveness.
//
// THE PROBLEM THEY SOLVE, which is one problem wearing two hats.
//
// The fleet gate persists only NON-allow verdicts, deliberately, so the
// false-positive sample stays undiluted. Two consequences follow, and the second
// one is the dangerous one:
//
//   1. `policy_allow_count` (§4.7) is structurally unmeasurable. There is
//      nowhere it could be counted.
//   2. The gate's liveness check reads that same log and reports FAILED when it
//      is empty or stale. But an empty log is what a HEALTHY gate produces during
//      a quiet period, and it is also exactly what an UNWIRED gate produces
//      forever. The check therefore cannot answer its own question in either
//      direction -- and on 2026-08-24 it was reporting FAILED after fifteen
//      genuinely quiet days. I replayed the shipping classifier over all 52
//      messages delivered in that window: 52 allow, 0 non-allow. The gate was
//      alive the whole time.
//
// Both come from the same root: the system records VIOLATIONS and infers health
// from their absence. An absence-based liveness claim is unfalsifiable, and this
// one had been quietly wrong for two weeks.
//
// THE FIX: count DECISIONS, not violations. An aggregate row per (hour, verdict)
// is cheap regardless of traffic -- it does not grow with message volume the way
// per-message allow rows would, which is what made per-message allow logging a
// bad idea in the first place. Liveness then becomes "the gate decided N things
// in the last hour", a presence claim, which can actually be false.
import type Database from 'better-sqlite3'

export const POLICY_METRICS_SCHEMA_VERSION = 1

/** The counters §4.7 names, plus the two the boundary can also produce. */
export type PolicyCounter =
  | 'policy_allow'
  | 'policy_deny'
  | 'policy_redact'
  | 'policy_require_approval'
  | 'sensitivity_unknown'
  | 'identity_resolution_failure'

export const POLICY_COUNTERS: readonly PolicyCounter[] = [
  'policy_allow', 'policy_deny', 'policy_redact', 'policy_require_approval',
  'sensitivity_unknown', 'identity_resolution_failure',
]

export function initPolicyMetricsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_decision_counters (
      bucket_hour  INTEGER NOT NULL,   -- unix seconds truncated to the hour
      surface      TEXT    NOT NULL,   -- which boundary produced it
      counter      TEXT    NOT NULL,
      n            INTEGER NOT NULL,
      PRIMARY KEY (bucket_hour, surface, counter)
    );
    CREATE INDEX IF NOT EXISTS idx_policy_counters_hour
      ON policy_decision_counters(bucket_hour);
  `)
}

function hourBucket(nowSec: number): number {
  return Math.floor(nowSec / 3600) * 3600
}

/**
 * Add to a counter. Cheap and lock-friendly: one UPSERT per decision, and the
 * row count grows with TIME, not with traffic.
 */
export function bumpPolicyCounter(
  db: Database.Database, surface: string, counter: PolicyCounter, nowSec: number, by = 1,
): void {
  initPolicyMetricsSchema(db)
  db.prepare(`
    INSERT INTO policy_decision_counters (bucket_hour, surface, counter, n)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(bucket_hour, surface, counter) DO UPDATE SET n = n + excluded.n
  `).run(hourBucket(nowSec), surface, counter, by)
}

/** Map a verdict onto its counter. Exhaustive by construction. */
export function counterForVerdict(v: 'ALLOW' | 'DENY' | 'REDACT' | 'REQUIRE_APPROVAL'): PolicyCounter {
  switch (v) {
    case 'ALLOW': return 'policy_allow'
    case 'DENY': return 'policy_deny'
    case 'REDACT': return 'policy_redact'
    case 'REQUIRE_APPROVAL': return 'policy_require_approval'
  }
}

export interface PolicyMetricsWindow {
  sinceHour: number
  totals: Record<string, number>
  /** Total decisions of ANY verdict. This is the liveness signal. */
  decisions: number
  bySurface: Record<string, number>
}

/** Read the counters over a window, for the dashboard and for liveness. */
export function readPolicyMetrics(
  db: Database.Database, nowSec: number, windowHours = 24,
): PolicyMetricsWindow {
  initPolicyMetricsSchema(db)
  const since = hourBucket(nowSec) - (windowHours - 1) * 3600
  const rows = db.prepare(
    'SELECT surface, counter, SUM(n) AS n FROM policy_decision_counters WHERE bucket_hour >= ? GROUP BY surface, counter'
  ).all(since) as Array<{ surface: string; counter: string; n: number }>

  const totals: Record<string, number> = {}
  const bySurface: Record<string, number> = {}
  let decisions = 0
  for (const r of rows) {
    totals[r.counter] = (totals[r.counter] ?? 0) + r.n
    bySurface[r.surface] = (bySurface[r.surface] ?? 0) + r.n
    // Only VERDICT counters count as decisions; the diagnostic counters
    // (unknown sensitivity, identity failure) are attributes OF a decision and
    // would double-count it.
    if (r.counter.startsWith('policy_')) decisions += r.n
  }
  return { sinceHour: since, totals, decisions, bySurface }
}

export type LivenessState =
  /** The gate decided something recently. Presence, not absence. */
  | 'LIVE'
  /** No decisions recorded in the window: the gate is not being called. */
  | 'NO_DECISIONS_RECORDED'
  /** Counters have never been written at all -- the surface predates them. */
  | 'NOT_INSTRUMENTED'

/**
 * Liveness as a PRESENCE claim.
 *
 * The distinction the old check could not make:
 *   - decisions > 0                  -> LIVE, whatever the verdicts were.
 *   - decisions == 0, rows exist     -> genuinely not being called.
 *   - no rows at all                 -> not instrumented yet; say so rather than
 *                                       reporting a failure, because "we never
 *                                       measured" and "it is broken" are
 *                                       different facts and only one is alarming.
 */
export function policyGateLiveness(
  db: Database.Database, nowSec: number, windowHours = 24,
): { state: LivenessState; decisions: number; windowHours: number } {
  initPolicyMetricsSchema(db)
  const any = db.prepare('SELECT COUNT(*) AS n FROM policy_decision_counters').get() as { n: number }
  if (!any.n) return { state: 'NOT_INSTRUMENTED', decisions: 0, windowHours }
  const m = readPolicyMetrics(db, nowSec, windowHours)
  return {
    state: m.decisions > 0 ? 'LIVE' : 'NO_DECISIONS_RECORDED',
    decisions: m.decisions,
    windowHours,
  }
}
