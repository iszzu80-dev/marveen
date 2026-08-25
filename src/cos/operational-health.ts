// Personal Chief of Staff (COS) — W14 / §8.6: the two operational health
// metrics the audit found missing.
//
// §8.6 lists nine. Seven were measurable somewhere (the cycle's problems, the
// outbound status counts, the recovery queue, the migration ledger, the
// disclosure records' deny flag). Two had nothing behind them, and both became
// cheap the moment the run ledger got a writer (§8.7):
//
//   STALE RUNS             — something that should be running is not
//   UNVERIFIED COMPLETION  — something acted and nobody confirmed it landed
//
// They answer different questions and they fail in opposite directions. A stale
// run is silence where there should be noise; an unverified completion is noise
// that was never resolved into a fact. A monitoring surface that reports only
// one of them can be perfectly green while the other is the outage.

import type Database from 'better-sqlite3'

/** Six cycles of silence. The COS cycle runs every ten minutes, so anything
 *  that has not recorded a run in an hour has missed five in a row — long
 *  enough that a slow cycle or one skipped tick is not reported as a failure,
 *  short enough to notice within a working morning. */
export const STALE_RUN_MAX_AGE_SEC = 3600

/** How long an "it landed but we could not confirm it" may stand before it
 *  counts as a problem rather than a moment. The outbound executor re-attempts
 *  the readback on later ticks, so anything still unverified after an hour is
 *  not waiting for the next attempt — it is stuck. */
export const UNVERIFIED_GRACE_SEC = 3600

export interface StaleRun {
  featureId: string
  lastFinishedAt: number
  ageSeconds: number
  lastRunStatus: string
}

/**
 * Features whose newest recorded run is older than the window.
 *
 * WHAT THIS CANNOT SEE, said here rather than discovered later: a feature that
 * has NEVER recorded a run has no row, so it cannot be stale — it is absent, and
 * absence is a different question with a different answer (the cycle's own step
 * list is what knows the expected set). A caller that needs "should be running
 * and never has" must compare against a declared list; this function is about
 * things that used to run and stopped.
 */
export function staleRuns(
  db: Database.Database, now: number, maxAgeSec: number = STALE_RUN_MAX_AGE_SEC,
): StaleRun[] {
  const rows = db.prepare(
    `SELECT feature_id, MAX(finished_at) AS last_finished
       FROM cos_feature_runs GROUP BY feature_id`
  ).all() as Array<{ feature_id: string; last_finished: number }>
  const out: StaleRun[] = []
  for (const r of rows) {
    const age = now - r.last_finished
    if (age <= maxAgeSec) continue
    const last = db.prepare(
      `SELECT run_status FROM cos_feature_runs WHERE feature_id=? ORDER BY finished_at DESC LIMIT 1`
    ).get(r.feature_id) as { run_status: string } | undefined
    out.push({
      featureId: r.feature_id, lastFinishedAt: r.last_finished, ageSeconds: age,
      lastRunStatus: last?.run_status ?? 'UNKNOWN',
    })
  }
  return out.sort((a, b) => b.ageSeconds - a.ageSeconds)
}

export interface UnverifiedCompletion {
  /** 'RUN' — a recorded run that acted without verification.
   *  'OUTBOUND' — a ledger row the provider accepted and the readback never
   *  confirmed. Two different surfaces of the same class of fact. */
  source: 'RUN' | 'OUTBOUND'
  reference: string
  since: number
  ageSeconds: number
  detail: string
}

/**
 * Things that acted and were never confirmed.
 *
 * TWO SOURCES ON PURPOSE. `cos_feature_runs` knows about a RUN that acted
 * without a readback (§8.7's PARTIAL). `outbound_ledger` knows about a
 * particular letter the provider accepted while the marker never came back
 * (`APPLIED_UNVERIFIED`, which the executor will never resend). Reporting only
 * the first would miss the concrete side effect; reporting only the second would
 * miss every non-outbound step that acts outside.
 *
 * Measured on the live store while writing this: TWO `APPLIED_UNVERIFIED` rows
 * from 2026-08-10, sixteen days old, surfaced by nothing. That is the metric's
 * first real finding, and it existed before the metric did.
 */
export function unverifiedCompletions(
  db: Database.Database, now: number, graceSec: number = UNVERIFIED_GRACE_SEC,
): UnverifiedCompletion[] {
  const out: UnverifiedCompletion[] = []
  const cutoff = now - graceSec

  const runs = db.prepare(
    `SELECT run_id, feature_id, finished_at, reason FROM cos_feature_runs
      WHERE run_status='PARTIAL' AND verification_status='UNVERIFIED' AND finished_at <= ?
      ORDER BY finished_at ASC LIMIT 50`
  ).all(cutoff) as Array<{ run_id: string; feature_id: string; finished_at: number; reason: string }>
  for (const r of runs) {
    out.push({
      source: 'RUN', reference: r.run_id, since: r.finished_at,
      ageSeconds: now - r.finished_at,
      detail: `${r.feature_id} acted without a readback: ${r.reason}`,
    })
  }

  for (const table of ['outbound_ledger', 'zst_outbound_ledger']) {
    const present = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table)
    if (!present) continue
    const rows = db.prepare(
      `SELECT ledger_id, action_type, updated_at, last_error FROM ${table}
        WHERE status='APPLIED_UNVERIFIED' AND updated_at <= ?
        ORDER BY updated_at ASC LIMIT 50`
    ).all(cutoff) as Array<{ ledger_id: string; action_type: string; updated_at: number; last_error: string | null }>
    for (const r of rows) {
      out.push({
        source: 'OUTBOUND', reference: r.ledger_id, since: r.updated_at,
        ageSeconds: now - r.updated_at,
        detail: `${r.action_type} accepted by the provider, never confirmed: ${r.last_error ?? 'readback unavailable'}`,
      })
    }
  }

  return out.sort((a, b) => b.ageSeconds - a.ageSeconds)
}

export interface OperationalHealth {
  stale: StaleRun[]
  unverified: UnverifiedCompletion[]
  /** Explicit zero semantics: a surface that renders nothing when both lists are
   *  empty cannot be told apart from one whose data stopped arriving. */
  clean: boolean
  checkedAt: number
}

export function operationalHealth(db: Database.Database, now: number): OperationalHealth {
  const stale = staleRuns(db, now)
  const unverified = unverifiedCompletions(db, now)
  return { stale, unverified, clean: stale.length === 0 && unverified.length === 0, checkedAt: now }
}
