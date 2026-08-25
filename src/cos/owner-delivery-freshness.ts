// ACP v1.4.5 — final freshness gate for owner-facing questions.
//
// The question row carries the progression_run_id it currently represents.
// owner-question.ts refreshes that id when the same ask is re-read without
// re-notifying the owner. This module therefore binds delivery to THAT exact run,
// rather than to asked_at (which deliberately does not move on silent refresh).

import type Database from 'better-sqlite3'
import { assertFreshForOwnerOrExternal, type EvidenceWatermark } from './evidence-freshness.js'
import type { CosDomain } from './temporal-facts.js'

function eventsTable(domain: CosDomain): string {
  return domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
}

export function evidenceWatermarkForProgressionRun(
  db: Database.Database,
  domain: CosDomain,
  caseId: string,
  progressionRunId: string,
): EvidenceWatermark {
  const packet = db.prepare(`
    SELECT packet_id, created_at
      FROM case_evidence_packets
     WHERE domain=? AND case_id=? AND progression_run_id=? AND packet_json IS NOT NULL
     ORDER BY created_at DESC, packet_id DESC LIMIT 1
  `).get(domain, caseId, progressionRunId) as { packet_id: string; created_at: number } | undefined
  if (!packet) throw new Error('EVIDENCE_UNKNOWN: no valid evidence packet for question progression run')

  const run = db.prepare(`
    SELECT case_version_after
      FROM case_progression_runs
     WHERE progression_run_id=? AND domain=? AND case_id=? AND status='COMPLETED'
  `).get(progressionRunId, domain, caseId) as { case_version_after: number | null } | undefined
  if (!run || run.case_version_after == null) {
    throw new Error('EVIDENCE_UNKNOWN: question progression run has no completed case version')
  }

  // Second-granular timestamps need conservative handling. Include events from
  // the same second ONLY when their source_reference proves they came from the
  // progression run itself. An owner reply landing later in that same second is
  // therefore not silently included in the old evidence horizon.
  const ev = db.prepare(`
    SELECT COALESCE(MAX(event_id), 0) AS n
      FROM ${eventsTable(domain)}
     WHERE case_id=? AND (created_at < ? OR source_reference = ?)
  `).get(caseId, packet.created_at, progressionRunId) as { n: number }

  return {
    domain,
    caseId,
    caseVersion: run.case_version_after,
    evidenceMaxEventSeq: ev.n,
    builtAt: packet.created_at,
    sourceFingerprint: `packet:${packet.packet_id}:run:${progressionRunId}`,
  }
}

/**
 * Throws STALE_EVIDENCE / EVIDENCE_UNKNOWN. A caller must leave the question
 * undelivered so the Reader/question sweep can refresh it; stale owner-facing
 * text is never converted into a successful send.
 */
export function assertOwnerQuestionFreshForDelivery(
  db: Database.Database,
  domain: CosDomain,
  caseId: string,
  progressionRunId: string | null,
): EvidenceWatermark {
  if (!progressionRunId) throw new Error('EVIDENCE_UNKNOWN: owner question has no progression_run_id')
  const watermark = evidenceWatermarkForProgressionRun(db, domain, caseId, progressionRunId)
  assertFreshForOwnerOrExternal(db, watermark)
  return watermark
}
