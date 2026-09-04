// WHERE PROPOSALS LIVE, and why it is not the relation table.
//
// Owner ruling 2026-09-04: out of a semantic candidate there is no canonical
// link, no parent assignment, no case merge, no namespace migration and no
// external action. "Első körben a candidate csak read-only projection legyen."
//
// So candidates are stored in their own table rather than as a state on
// `case_sources`. A CANDIDATE row sitting in the relation table is one careless
// `WHERE case_id = ?` away from being read as a relation, and the whole promise
// here is that it cannot be acted on by accident. A consumer of the case graph
// never sees this table unless it names it.
//
// Nothing in this module writes to `case_sources`, `personal_cases` or
// `zst_cases`. That is a property of the file, checkable by reading it, and a
// test asserts it stays that way.

import type Database from 'better-sqlite3'
import type { RelationCandidate, RelationType } from './relation-candidates.js'

export type SourceKind = 'CASE' | 'GMAIL_THREAD' | 'GMAIL_MESSAGE'

export interface StoredCandidate extends RelationCandidate {
  id: string
  sourceKind: SourceKind
  provenance: string
  createdAt: number
  updatedAt: number
}

function candidateId(c: RelationCandidate): string {
  return `${c.relationType}:${c.namespace}:${c.sourceRef}:${c.targetCaseId}:${c.algorithmFingerprint}`
}

/**
 * Record proposals. Idempotent per (type, namespace, source, target,
 * algorithm): re-running the same engine over the same data updates in place
 * rather than accumulating, while a NEW fingerprint deliberately writes new
 * rows — a different set of rules produced a different opinion, and overwriting
 * the old one would erase the comparison.
 */
export function recordCandidates(
  db: Database.Database,
  candidates: readonly RelationCandidate[],
  opts: { sourceKind: SourceKind; provenance: string },
  now: number,
): number {
  const stmt = db.prepare(`
    INSERT INTO semantic_relation_candidates
      (id, relation_type, namespace, source_ref, source_kind, target_case_id,
       confidence, features_json, negatives_json, reasons_json,
       source_mailbox, target_mailbox, algorithm_fingerprint, provenance,
       created_at, updated_at)
    VALUES (@id, @relationType, @namespace, @sourceRef, @sourceKind, @targetCaseId,
            @confidence, @features, @negatives, @reasons,
            @sourceMailbox, @targetMailbox, @fingerprint, @provenance, @now, @now)
    ON CONFLICT(relation_type, namespace, source_ref, target_case_id, algorithm_fingerprint)
    DO UPDATE SET confidence = excluded.confidence,
                  features_json = excluded.features_json,
                  negatives_json = excluded.negatives_json,
                  reasons_json = excluded.reasons_json,
                  updated_at = excluded.updated_at
  `)
  const run = db.transaction((cs: readonly RelationCandidate[]) => {
    for (const c of cs) {
      stmt.run({
        id: candidateId(c),
        relationType: c.relationType,
        namespace: c.namespace,
        sourceRef: c.sourceRef,
        sourceKind: opts.sourceKind,
        targetCaseId: c.targetCaseId,
        confidence: c.confidence,
        features: JSON.stringify(c.features),
        negatives: JSON.stringify(c.negatives),
        reasons: JSON.stringify(c.reasons),
        sourceMailbox: c.crossMailbox?.sourceMailbox ?? null,
        targetMailbox: c.crossMailbox?.targetMailbox ?? null,
        fingerprint: c.algorithmFingerprint,
        provenance: opts.provenance,
        now,
      })
    }
  })
  run(candidates)
  return candidates.length
}

interface Row {
  id: string; relation_type: string; namespace: string; source_ref: string
  source_kind: string; target_case_id: string; confidence: number
  features_json: string; negatives_json: string; reasons_json: string
  source_mailbox: string | null; target_mailbox: string | null
  algorithm_fingerprint: string; provenance: string
  created_at: number; updated_at: number
}

const hydrate = (r: Row): StoredCandidate => ({
  id: r.id,
  relationType: r.relation_type as RelationType,
  namespace: r.namespace,
  sourceRef: r.source_ref,
  sourceKind: r.source_kind as SourceKind,
  targetCaseId: r.target_case_id,
  confidence: r.confidence,
  features: JSON.parse(r.features_json),
  negatives: JSON.parse(r.negatives_json),
  reasons: JSON.parse(r.reasons_json),
  ...(r.source_mailbox
    ? { crossMailbox: { sourceMailbox: r.source_mailbox, ...(r.target_mailbox ? { targetMailbox: r.target_mailbox } : {}) } }
    : {}),
  algorithmFingerprint: r.algorithm_fingerprint,
  provenance: r.provenance,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** "Possible related case/source" for one case, best first. READ ONLY. */
export function candidatesForCase(
  db: Database.Database, namespace: string, caseId: string, limit = 5,
): StoredCandidate[] {
  return (db.prepare(
    `SELECT * FROM semantic_relation_candidates
      WHERE namespace = ? AND (target_case_id = ? OR source_ref = ?)
      ORDER BY confidence DESC, id LIMIT ?`,
  ).all(namespace, caseId, caseId, limit) as Row[]).map(hydrate)
}

/** Everything proposed by one algorithm version, for review and comparison. */
export function candidatesByFingerprint(
  db: Database.Database, fingerprint: string, limit = 200,
): StoredCandidate[] {
  return (db.prepare(
    `SELECT * FROM semantic_relation_candidates
      WHERE algorithm_fingerprint = ? ORDER BY confidence DESC, id LIMIT ?`,
  ).all(fingerprint, limit) as Row[]).map(hydrate)
}

/**
 * The projection a consumer renders: the proposal, and WHY, in words.
 *
 * Deliberately returns prose rather than a score. A number invites a threshold
 * somebody sets once and never revisits; a sentence naming a shared booking
 * reference is something the owner can agree or disagree with in one read.
 */
export function describeCandidate(c: StoredCandidate): string {
  const head = c.relationType === 'CASE_PARENT_CANDIDATE'
    ? `Possible parent: ${c.targetCaseId}`
    : `Possible related case: ${c.targetCaseId}`
  const cross = c.crossMailbox ? ` [arrived on ${c.crossMailbox.sourceMailbox}]` : ''
  const why = c.reasons.length ? c.reasons.map((r) => `  · ${r}`).join('\n') : '  · (no stated reason)'
  const against = c.negatives.filter((n) => !n.disqualifying)
  const but = against.length ? `\n  against: ${against.map((n) => n.reason).join('; ')}` : ''
  return `${head} (${c.confidence.toFixed(2)})${cross}\n${why}${but}`
}
