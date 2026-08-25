// CoS v4.4 / ACP v1.4.5 — provenance-bound temporal facts.
//
// Legacy scalar dates (due_at/follow_up_at/next_wake_at) remain projections
// during migration. This table is the semantic layer: a date is not actionable
// until we know WHAT event it describes, where it came from, and whether it has
// been verified. No function in this module performs an external side effect.

import type Database from 'better-sqlite3'

export type CosDomain = 'personal' | 'zst'
export type TemporalVerification = 'VERIFIED' | 'UNVERIFIED' | 'CONFLICTED' | 'REJECTED'

export type TemporalFactKind =
  | 'CASE_DUE'
  | 'FOLLOW_UP_DUE'
  | 'WAKE'
  | 'WATCH_DUE'
  | 'PAYMENT_DUE'
  | 'DOCUMENT_DUE'
  | 'TERMINATION_DEADLINE'
  | 'CONTRACT_EXPIRY'
  | 'INITIATIVE_DECISION_DUE'
  | 'ESCALATION_DUE'
  | 'DECISION_DUE'
  | 'APPOINTMENT_START'
  | 'BOOKING_START'
  | 'BOOKING_END'
  | 'OTHER'

export interface TemporalFactInput {
  factId: string
  domain: CosDomain
  caseId: string
  kind: TemporalFactKind
  occursAt: number
  sourceSystem: string
  sourceReference: string
  sourceField?: string | null
  confidence?: number
  verification?: TemporalVerification
  supersedesFactId?: string | null
  rawText?: string | null
  actor?: string
}

export interface TemporalFactRow {
  fact_id: string
  domain: CosDomain
  case_id: string
  fact_kind: TemporalFactKind
  occurs_at: number
  source_system: string
  source_reference: string
  source_field: string | null
  confidence: number
  verification: TemporalVerification
  supersedes_fact_id: string | null
  raw_text: string | null
  actor: string
  created_at: number
}

/**
 * Additive schema bootstrap. The main schema seam should call this during init;
 * callers also invoke it defensively so a rolling deploy against an older store
 * fails safe instead of reading a table that does not yet exist.
 */
export function ensureTemporalFactsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_temporal_facts (
      fact_id              TEXT PRIMARY KEY,
      domain               TEXT NOT NULL CHECK(domain IN ('personal','zst')),
      case_id              TEXT NOT NULL,
      fact_kind            TEXT NOT NULL,
      occurs_at            INTEGER NOT NULL,
      source_system        TEXT NOT NULL,
      source_reference     TEXT NOT NULL,
      source_field         TEXT,
      confidence           REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
      verification         TEXT NOT NULL DEFAULT 'UNVERIFIED'
        CHECK(verification IN ('VERIFIED','UNVERIFIED','CONFLICTED','REJECTED')),
      supersedes_fact_id   TEXT,
      raw_text             TEXT,
      actor                TEXT NOT NULL DEFAULT 'system',
      created_at           INTEGER NOT NULL,
      UNIQUE(domain, case_id, fact_kind, occurs_at, source_system, source_reference)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ctf_case ON case_temporal_facts(domain, case_id, verification, occurs_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ctf_due ON case_temporal_facts(domain, verification, occurs_at)`)
}

export function recordTemporalFact(
  db: Database.Database,
  input: TemporalFactInput,
  now: number = Math.floor(Date.now() / 1000),
): TemporalFactRow {
  ensureTemporalFactsSchema(db)
  const confidence = input.confidence ?? 0.5
  const verification = input.verification ?? 'UNVERIFIED'
  db.prepare(`
    INSERT INTO case_temporal_facts (
      fact_id, domain, case_id, fact_kind, occurs_at, source_system,
      source_reference, source_field, confidence, verification,
      supersedes_fact_id, raw_text, actor, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET
      verification=excluded.verification,
      confidence=excluded.confidence,
      supersedes_fact_id=excluded.supersedes_fact_id,
      raw_text=COALESCE(excluded.raw_text, case_temporal_facts.raw_text),
      actor=excluded.actor
  `).run(
    input.factId, input.domain, input.caseId, input.kind, input.occursAt,
    input.sourceSystem, input.sourceReference, input.sourceField ?? null,
    confidence, verification, input.supersedesFactId ?? null,
    input.rawText ?? null, input.actor ?? 'system', now,
  )
  return getTemporalFact(db, input.factId)!
}

export function getTemporalFact(db: Database.Database, factId: string): TemporalFactRow | undefined {
  ensureTemporalFactsSchema(db)
  return db.prepare(`SELECT * FROM case_temporal_facts WHERE fact_id=?`).get(factId) as TemporalFactRow | undefined
}

export function listCaseTemporalFacts(
  db: Database.Database,
  domain: CosDomain,
  caseId: string,
  includeRejected = false,
): TemporalFactRow[] {
  ensureTemporalFactsSchema(db)
  const rejectedClause = includeRejected ? '' : `AND verification <> 'REJECTED'`
  return db.prepare(`
    SELECT * FROM case_temporal_facts
    WHERE domain=? AND case_id=? ${rejectedClause}
    ORDER BY occurs_at ASC, fact_kind ASC, created_at ASC
  `).all(domain, caseId) as TemporalFactRow[]
}

export function setTemporalFactVerification(
  db: Database.Database,
  factId: string,
  verification: TemporalVerification,
  actor: string,
): boolean {
  ensureTemporalFactsSchema(db)
  const r = db.prepare(`
    UPDATE case_temporal_facts
       SET verification=?, actor=?
     WHERE fact_id=?
  `).run(verification, actor, factId)
  return r.changes === 1
}

/** A binding date is one whose loss can make a case materially wrong or late. */
export function isBindingTemporalKind(kind: TemporalFactKind): boolean {
  return [
    'CASE_DUE', 'PAYMENT_DUE', 'DOCUMENT_DUE', 'TERMINATION_DEADLINE',
    'CONTRACT_EXPIRY', 'INITIATIVE_DECISION_DUE', 'ESCALATION_DUE', 'DECISION_DUE',
  ].includes(kind)
}
