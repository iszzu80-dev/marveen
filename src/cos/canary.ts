// Personal Chief of Staff (COS) — W14 / §8.5: CANARY rollout for a new critical
// behaviour.
//
// §8.5 asks for four things and they are four different mechanisms, not one:
//
//   limited traffic/workload   → a cap this module applies to the caller's limit
//   explicit metrics           → cos_feature_runs, which W14 finally gave a writer
//   abort threshold            → a failed run aborts, automatically
//   promotion gate             → N consecutive clean runs, and only then
//
// IT READS THE RUN LEDGER RATHER THAN KEEPING ITS OWN COUNTERS. That is the
// whole design: a canary with private metrics is a second opinion about whether
// the system is healthy, and the two opinions drift. The ledger is what the
// cycle already writes, and `run_status = SUCCESS` there already means
// "completed AND verified" (§8.7), so "ten clean runs" means the same thing here
// as it does everywhere else.
//
// WHAT IT DELIBERATELY DOES NOT DO: promote itself on a timer, or abort on
// anything softer than a recorded failure. A canary that promotes because time
// passed is a countdown, not a gate.

import type Database from 'better-sqlite3'

export type CanaryState = 'CANARY' | 'PROMOTED' | 'ABORTED'

export interface CanaryConfig {
  featureId: string
  /** The workload ceiling while in CANARY. The caller's own limit still applies
   *  — this can only narrow it. */
  maxPerRun: number
  /** Consecutive SUCCESS runs required before promotion. */
  promoteAfterRuns: number
}

export interface CanaryStatus {
  featureId: string
  state: CanaryState
  maxPerRun: number
  promoteAfterRuns: number
  consecutiveSuccesses: number
  startedAt: number
  promotedAt: number | null
  abortedAt: number | null
  abortReason: string | null
}

export function ensureCanarySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_canary (
      feature_id         TEXT PRIMARY KEY,
      state              TEXT NOT NULL DEFAULT 'CANARY' CHECK(state IN ('CANARY','PROMOTED','ABORTED')),
      max_per_run        INTEGER NOT NULL,
      promote_after_runs INTEGER NOT NULL,
      started_at         INTEGER NOT NULL,
      promoted_at        INTEGER,
      aborted_at         INTEGER,
      abort_reason       TEXT,
      CHECK (max_per_run >= 0),
      CHECK (promote_after_runs >= 1)
    )
  `)
}

/** Put a feature under canary. Idempotent: calling it again does NOT restart a
 *  canary that is already running, because a restart would silently reset the
 *  promotion count and a feature could then live under canary forever without
 *  anyone noticing it never promoted. */
export function startCanary(db: Database.Database, cfg: CanaryConfig, now: number): CanaryStatus {
  ensureCanarySchema(db)
  db.prepare(
    `INSERT OR IGNORE INTO cos_canary (feature_id, state, max_per_run, promote_after_runs, started_at)
     VALUES (@featureId, 'CANARY', @maxPerRun, @promoteAfterRuns, @now)`
  ).run({ ...cfg, now })
  return canaryStatus(db, cfg.featureId)!
}

export function canaryStatus(db: Database.Database, featureId: string): CanaryStatus | null {
  ensureCanarySchema(db)
  const row = db.prepare(`SELECT * FROM cos_canary WHERE feature_id = ?`).get(featureId) as
    | Record<string, string | number | null> | undefined
  if (!row) return null
  return {
    featureId: String(row.feature_id), state: String(row.state) as CanaryState,
    maxPerRun: Number(row.max_per_run), promoteAfterRuns: Number(row.promote_after_runs),
    consecutiveSuccesses: consecutiveSuccesses(db, String(row.feature_id), Number(row.started_at)),
    startedAt: Number(row.started_at),
    promotedAt: row.promoted_at === null ? null : Number(row.promoted_at),
    abortedAt: row.aborted_at === null ? null : Number(row.aborted_at),
    abortReason: row.abort_reason === null ? null : String(row.abort_reason),
  }
}

/** SUCCESS runs since the canary started, counted from the newest backwards and
 *  stopping at the first run that was not SUCCESS.
 *
 *  Consecutive, not total: a feature that fails every other run would otherwise
 *  accumulate enough successes to promote while visibly misbehaving. */
function consecutiveSuccesses(db: Database.Database, featureId: string, since: number): number {
  const rows = db.prepare(
    `SELECT run_status FROM cos_feature_runs
      WHERE feature_id = ? AND finished_at >= ?
      ORDER BY finished_at DESC`
  ).all(featureId, since) as Array<{ run_status: string }>
  let n = 0
  for (const r of rows) {
    if (r.run_status !== 'SUCCESS') break
    n++
  }
  return n
}

export interface CanaryEvaluation {
  status: CanaryStatus
  changed: 'PROMOTED' | 'ABORTED' | null
}

/**
 * Look at the ledger and move the canary if it has earned it — in either
 * direction.
 *
 * ABORT IS CHECKED FIRST and it looks at the LATEST run only. A feature that
 * just failed must stop immediately, whatever its history says; letting a long
 * clean streak outvote a fresh failure is how a canary becomes decoration.
 */
export function evaluateCanary(db: Database.Database, featureId: string, now: number): CanaryEvaluation | null {
  const status = canaryStatus(db, featureId)
  if (!status || status.state !== 'CANARY') return status ? { status, changed: null } : null

  const latest = db.prepare(
    `SELECT run_status, reason FROM cos_feature_runs
      WHERE feature_id = ? AND finished_at >= ?
      ORDER BY finished_at DESC LIMIT 1`
  ).get(featureId, status.startedAt) as { run_status: string; reason: string } | undefined

  if (latest && (latest.run_status === 'FAILED' || latest.run_status === 'PARTIAL')) {
    db.prepare(
      `UPDATE cos_canary SET state='ABORTED', aborted_at=@now, abort_reason=@reason WHERE feature_id=@featureId`
    ).run({ now, featureId, reason: `${latest.run_status}: ${latest.reason}`.slice(0, 500) })
    return { status: canaryStatus(db, featureId)!, changed: 'ABORTED' }
  }

  if (status.consecutiveSuccesses >= status.promoteAfterRuns) {
    db.prepare(`UPDATE cos_canary SET state='PROMOTED', promoted_at=@now WHERE feature_id=@featureId`)
      .run({ now, featureId })
    return { status: canaryStatus(db, featureId)!, changed: 'PROMOTED' }
  }

  return { status, changed: null }
}

/**
 * The workload this run may take on.
 *
 * - no canary row   → the caller's own limit; a feature nobody put under canary
 *                     is not silently throttled
 * - PROMOTED        → the caller's own limit
 * - CANARY          → the smaller of the two
 * - ABORTED         → ZERO. Not "reduced": an aborted rollout does no work at
 *                     all until a human clears it, which is the difference
 *                     between an abort and a slowdown.
 */
export function canaryLimit(db: Database.Database, featureId: string, requested: number): number {
  const status = canaryStatus(db, featureId)
  if (!status || status.state === 'PROMOTED') return requested
  if (status.state === 'ABORTED') return 0
  return Math.min(requested, status.maxPerRun)
}

/** Clear an abort and resume the canary. A HUMAN act: nothing in the automatic
 *  path calls this, because an abort that clears itself is a retry loop with a
 *  ceremony. */
export function resumeCanary(db: Database.Database, featureId: string, now: number): CanaryStatus | null {
  ensureCanarySchema(db)
  db.prepare(
    `UPDATE cos_canary SET state='CANARY', aborted_at=NULL, abort_reason=NULL, started_at=@now
      WHERE feature_id=@featureId AND state='ABORTED'`
  ).run({ now, featureId })
  return canaryStatus(db, featureId)
}
