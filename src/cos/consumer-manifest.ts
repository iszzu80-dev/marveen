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

export function ensureFeatureRunSchema(db: Database.Database): void {
  db.exec(`
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
      finished_at  INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cfr_feature ON cos_feature_runs(feature_id, domain, finished_at DESC)`)
}

export function recordFeatureRun(
  db: Database.Database,
  args: { runId: string; featureId: string; domain: CosDomain; result: FeatureRunResult; startedAt: number; finishedAt: number },
): void {
  ensureFeatureRunSchema(db)
  const r = args.result
  db.prepare(`
    INSERT INTO cos_feature_runs
      (run_id, feature_id, domain, examined, matched, acted, failed, outcome, reason, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(args.runId, args.featureId, args.domain, r.examined, r.matched, r.acted, r.failed, r.outcome, r.reason, args.startedAt, args.finishedAt)
}
