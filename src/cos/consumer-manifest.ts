// ACP v1.4.5 — Complete Progression Path (CPP) registry + standard telemetry.
//
// A feature is not production-complete because a producer wrote a row. Every
// normative feature declares producer -> persist -> consumer -> observable
// effect -> receipt/readback -> dedup -> recovery, plus explicit zero semantics.

import type Database from 'better-sqlite3'
import type { CosDomain } from './temporal-facts.js'

export type FeatureOutcome = 'NO_DATA' | 'NO_MATCH' | 'NO_ACTION' | 'ACTED' | 'FAILED' | 'UNKNOWN'

export interface FeatureRunResult {
  examined: number
  matched: number
  acted: number
  failed: number
  outcome: FeatureOutcome
  reason: string
}

export interface ConsumerManifestEntry {
  featureId: string
  domains: readonly CosDomain[]
  producer: string
  storage: string
  consumer: string
  observableEffect: string
  receiptOrReadback: string
  dedupOrIdempotency: string
  recovery: string
  zeroSemantics: string
  critical?: boolean
}

const BUILT_INS: readonly ConsumerManifestEntry[] = [
  {
    featureId: 'semantic-temporal-deadline', domains: ['personal', 'zst'],
    producer: 'temporal fact extractor/projector', storage: 'case_temporal_facts',
    consumer: 'TSCG + progression/deadline consumer', observableEffect: 'owner/system sees correct semantic deadline before action',
    receiptOrReadback: 'feature run + case/event evidence', dedupOrIdempotency: 'fact_id + semantic source uniqueness',
    recovery: 'reconcile reports unconsumed verified deadline', zeroSemantics: 'NO_DATA=no active facts; NO_MATCH=no due facts; NO_ACTION=all handled', critical: true,
  },
  {
    featureId: 'wake-delivery', domains: ['personal', 'zst'],
    producer: 'scheduler/owner-question', storage: 'next_wake_at / progression state',
    consumer: 'wake consumer', observableEffect: 'due wake becomes owner/system-visible before clear',
    receiptOrReadback: 'post-before-clear / run ledger', dedupOrIdempotency: 'case wake state hash',
    recovery: 'overdue wake reconcile', zeroSemantics: 'NO_DATA=no wakes; NO_MATCH=none due; NO_ACTION=already consumed', critical: true,
  },
  {
    featureId: 'owner-question', domains: ['personal', 'zst'],
    producer: 'Reader/progression', storage: 'evidence packet + question state',
    consumer: 'owner-question channel', observableEffect: 'fresh specific owner question',
    receiptOrReadback: 'question post record', dedupOrIdempotency: 'question hash + evidence watermark',
    recovery: 'stale suppression + next cycle re-read', zeroSemantics: 'NO_DATA=no candidate; NO_MATCH=no owner ask; NO_ACTION=dedup/capacity', critical: true,
  },
  {
    featureId: 'approval-gated-outbound', domains: ['personal', 'zst'],
    producer: 'compose/draft path', storage: 'approval + outbound ledger',
    consumer: 'shared executor', observableEffect: 'provider side effect only after exact approval',
    receiptOrReadback: 'provider marker readback + VERIFIED ledger', dedupOrIdempotency: 'internal key + sequence + external marker',
    recovery: 'OUTCOME_UNKNOWN/RECOVERY_REQUIRED readback', zeroSemantics: 'NO_DATA=no candidates; NO_MATCH=no approval; NO_ACTION=policy/mode block', critical: true,
  },
  {
    featureId: 'namespace-routing', domains: ['personal', 'zst'],
    producer: 'connector intake', storage: 'domain case store + provenance',
    consumer: 'case progression', observableEffect: 'automatic writes stay inside connector namespace',
    receiptOrReadback: 'scope decision/audit event', dedupOrIdempotency: 'message_id + thread_id ingress dedup',
    recovery: 'scope-review + explicit human bridge', zeroSemantics: 'NO_DATA=no messages; NO_MATCH=scope unchanged; NO_ACTION=security blocked', critical: true,
  },
]

export function builtinConsumerManifest(): readonly ConsumerManifestEntry[] { return BUILT_INS }

export function validateConsumerManifest(entries: readonly ConsumerManifestEntry[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (seen.has(e.featureId)) errors.push(`${e.featureId}: duplicate feature id`)
    seen.add(e.featureId)
    for (const [k, v] of Object.entries({
      producer: e.producer, storage: e.storage, consumer: e.consumer,
      observableEffect: e.observableEffect, receiptOrReadback: e.receiptOrReadback,
      dedupOrIdempotency: e.dedupOrIdempotency, recovery: e.recovery, zeroSemantics: e.zeroSemantics,
    })) if (!v.trim()) errors.push(`${e.featureId}: missing ${k}`)
    if (!e.domains.length) errors.push(`${e.featureId}: no domains`)
  }
  return errors
}

export function standardFeatureResult(input: Omit<FeatureRunResult, 'outcome'> & { outcome?: FeatureOutcome }): FeatureRunResult {
  const outcome: FeatureOutcome = input.outcome ?? (
    input.failed > 0 ? 'FAILED'
      : input.acted > 0 ? 'ACTED'
        : input.examined === 0 ? 'NO_DATA'
          : input.matched === 0 ? 'NO_MATCH'
            : 'NO_ACTION'
  )
  return { ...input, outcome }
}

/** W14 / §8.7 — RUN INTEGRITY.
 *
 *  §8.7 lists what every run must record, and the table this file shipped held
 *  about half of it: counts, outcome, reason, start and finish. Missing were the
 *  capability/preflight result, the input and final cursor, the pending writes,
 *  the side effects, and — the one that matters most — the VERIFICATION STATUS,
 *  because §8.7's rule is `SUCCESS` only after readback/verification.
 *
 *  `outcome: ACTED` says something happened. It does not say it was confirmed.
 *  The outbound executor has made exactly that distinction since P1.1
 *  (APPLIED_UNVERIFIED vs VERIFIED); the run record did not inherit it, so a run
 *  that sent a letter it could not read back looked identical to one that did.
 */
const FEATURE_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS cos_feature_runs (
    run_id       TEXT PRIMARY KEY,
    feature_id   TEXT NOT NULL,
    domain       TEXT NOT NULL CHECK(domain IN ('personal','zst')),
    examined     INTEGER NOT NULL,
    matched      INTEGER NOT NULL,
    acted        INTEGER NOT NULL,
    failed       INTEGER NOT NULL,
    outcome      TEXT NOT NULL CHECK(outcome IN ('NO_DATA','NO_MATCH','NO_ACTION','ACTED','FAILED','UNKNOWN')),
    reason       TEXT NOT NULL,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER NOT NULL,
    -- §8.7 additions
    capability_result   TEXT,
    input_cursor        TEXT,
    final_cursor        TEXT,
    processed_ids       TEXT,
    pending_writes      INTEGER,
    side_effects        TEXT,
    verification_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
      CHECK(verification_status IN ('VERIFIED','UNVERIFIED','NOT_APPLICABLE')),
    run_status          TEXT NOT NULL DEFAULT 'UNKNOWN'
      CHECK(run_status IN ('SUCCESS','PARTIAL','FAILED','UNKNOWN')),
    -- THE §8.7 RULE, AS A CONSTRAINT. Not a convention a writer must remember:
    -- a row claiming SUCCESS while its verification is UNVERIFIED cannot be
    -- inserted at all. The code check below refuses first and says why; this is
    -- what stands if a future writer skips the helper.
    CHECK (run_status <> 'SUCCESS' OR verification_status IN ('VERIFIED','NOT_APPLICABLE'))
  )
`

export function ensureFeatureRunSchema(db: Database.Database): void {
  const stored = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='cos_feature_runs'`)
    .get() as { sql: string } | undefined)?.sql
  if (stored && !stored.includes('run_status')) {
    // REBUILD, not ALTER: the §8.7 rule is a cross-column CHECK and SQLite
    // cannot add one to an existing table. Rows are copied and counted; the
    // original is dropped only if every row arrived. (Same discipline as
    // schema.ts's widenCheckConstraint, and for the same reason: a rebuild that
    // silently loses rows is worse than the missing constraint.)
    const tx = db.transaction(() => {
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM cos_feature_runs`).get() as { n: number }).n
      db.exec(`ALTER TABLE cos_feature_runs RENAME TO cos_feature_runs_pre_w14`)
      db.exec(FEATURE_RUNS_DDL)
      db.exec(`
        INSERT INTO cos_feature_runs
          (run_id, feature_id, domain, examined, matched, acted, failed, outcome, reason,
           started_at, finished_at, verification_status, run_status)
        SELECT run_id, feature_id, domain, examined, matched, acted, failed, outcome, reason,
           started_at, finished_at, 'NOT_APPLICABLE',
           -- A pre-W14 row cannot claim SUCCESS: nothing recorded whether it was
           -- verified, and inventing a verdict for it would be the exact lie the
           -- new column exists to prevent.
           'UNKNOWN'
        FROM cos_feature_runs_pre_w14`)
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM cos_feature_runs`).get() as { n: number }).n
      if (after !== before) throw new Error(`cos_feature_runs rebuild: copied ${after} of ${before} rows — refusing to drop the original`)
      db.exec(`DROP TABLE cos_feature_runs_pre_w14`)
    })
    tx()
  } else {
    db.exec(FEATURE_RUNS_DDL)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfr_feature ON cos_feature_runs(feature_id, domain, finished_at DESC)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfr_status ON cos_feature_runs(run_status, finished_at DESC)`)
}

export type VerificationStatus = 'VERIFIED' | 'UNVERIFIED' | 'NOT_APPLICABLE'
export type RunStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'UNKNOWN'

/** §8.7's run envelope, beyond the counts. Every field optional: a step that has
 *  no cursor should record no cursor rather than an invented one. */
export interface RunIntegrity {
  capabilityResult?: string | null
  inputCursor?: string | null
  finalCursor?: string | null
  processedIds?: readonly string[] | null
  pendingWrites?: number | null
  sideEffects?: unknown
  /** NOT_APPLICABLE is a real answer, not a shrug: a read-only step has nothing
   *  to read back. UNVERIFIED means there WAS something and it was not
   *  confirmed — those two must never render the same. */
  verificationStatus?: VerificationStatus
}

/**
 * Derive the run status from the result and the verification.
 *
 * §8.7: SUCCESS only after readback/verification. So an ACTED run whose side
 * effect was not verified is PARTIAL, not SUCCESS — the same distinction the
 * outbound executor makes between APPLIED_UNVERIFIED and VERIFIED.
 */
export function deriveRunStatus(result: FeatureRunResult, verification: VerificationStatus): RunStatus {
  if (result.outcome === 'FAILED' || result.failed > 0) return result.acted > 0 ? 'PARTIAL' : 'FAILED'
  if (result.outcome === 'UNKNOWN') return 'UNKNOWN'
  if (result.outcome === 'ACTED') return verification === 'VERIFIED' ? 'SUCCESS' : 'PARTIAL'
  // NO_DATA / NO_MATCH / NO_ACTION: the run completed and did nothing. There is
  // nothing to verify, and calling that PARTIAL would make every quiet cycle
  // look half-broken.
  return 'SUCCESS'
}

export function recordFeatureRun(
  db: Database.Database,
  args: {
    runId: string; featureId: string; domain: CosDomain; result: FeatureRunResult
    startedAt: number; finishedAt: number; integrity?: RunIntegrity
  },
): RunStatus {
  ensureFeatureRunSchema(db)
  const r = args.result
  const verification = args.integrity?.verificationStatus ?? 'NOT_APPLICABLE'
  const runStatus = deriveRunStatus(r, verification)
  db.prepare(`
    INSERT INTO cos_feature_runs
      (run_id, feature_id, domain, examined, matched, acted, failed, outcome, reason,
       started_at, finished_at, capability_result, input_cursor, final_cursor,
       processed_ids, pending_writes, side_effects, verification_status, run_status)
    VALUES (@runId, @featureId, @domain, @examined, @matched, @acted, @failed, @outcome, @reason,
       @startedAt, @finishedAt, @capabilityResult, @inputCursor, @finalCursor,
       @processedIds, @pendingWrites, @sideEffects, @verification, @runStatus)
  `).run({
    runId: args.runId, featureId: args.featureId, domain: args.domain,
    examined: r.examined, matched: r.matched, acted: r.acted, failed: r.failed,
    outcome: r.outcome, reason: r.reason, startedAt: args.startedAt, finishedAt: args.finishedAt,
    capabilityResult: args.integrity?.capabilityResult ?? null,
    inputCursor: args.integrity?.inputCursor ?? null,
    finalCursor: args.integrity?.finalCursor ?? null,
    processedIds: args.integrity?.processedIds ? JSON.stringify(args.integrity.processedIds) : null,
    pendingWrites: args.integrity?.pendingWrites ?? null,
    sideEffects: args.integrity?.sideEffects === undefined ? null : JSON.stringify(args.integrity.sideEffects),
    verification, runStatus,
  })
  return runStatus
}
