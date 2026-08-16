// ACP v1.4.5 — shared evidence watermark / freshness guard.
//
// Owner-facing or external candidates must be based on evidence that still
// covers the latest relevant case event. Time-of-build alone is not enough:
// concurrent writes may have the same second, clocks may drift, and an owner
// answer arriving after Reader built a packet must invalidate that packet.

import type Database from 'better-sqlite3'
import type { CosDomain } from './temporal-facts.js'

export interface EvidenceWatermark {
  domain: CosDomain
  caseId: string
  caseVersion: number
  evidenceMaxEventSeq: number
  builtAt: number
  sourceFingerprint?: string | null
}

export interface EvidenceFreshnessResult {
  fresh: boolean
  currentCaseVersion: number | null
  currentMaxEventSeq: number
  reasons: string[]
}

export interface ReconstructedEvidenceWatermark {
  ok: boolean
  watermark: EvidenceWatermark | null
  reason: string
  packetId?: string
  progressionRunId?: string
}

function tables(domain: CosDomain): { cases: string; events: string } {
  return domain === 'personal'
    ? { cases: 'personal_cases', events: 'personal_case_events' }
    : { cases: 'zst_cases', events: 'zst_case_events' }
}

export function currentEvidenceWatermark(
  db: Database.Database,
  domain: CosDomain,
  caseId: string,
): { caseVersion: number | null; maxEventSeq: number } {
  const t = tables(domain)
  const c = db.prepare(`SELECT version FROM ${t.cases} WHERE case_id=?`).get(caseId) as { version: number } | undefined
  const e = db.prepare(`SELECT COALESCE(MAX(event_id), 0) AS n FROM ${t.events} WHERE case_id=?`).get(caseId) as { n: number }
  return { caseVersion: c?.version ?? null, maxEventSeq: e.n }
}

export function evaluateEvidenceFreshness(
  db: Database.Database,
  watermark: EvidenceWatermark,
): EvidenceFreshnessResult {
  const current = currentEvidenceWatermark(db, watermark.domain, watermark.caseId)
  const reasons: string[] = []
  if (current.caseVersion === null) reasons.push('case no longer exists')
  if (current.caseVersion !== null && current.caseVersion !== watermark.caseVersion) {
    reasons.push(`case version moved ${watermark.caseVersion} -> ${current.caseVersion}`)
  }
  if (current.maxEventSeq > watermark.evidenceMaxEventSeq) {
    reasons.push(`new case event after evidence watermark: ${watermark.evidenceMaxEventSeq} -> ${current.maxEventSeq}`)
  }
  return {
    fresh: reasons.length === 0,
    currentCaseVersion: current.caseVersion,
    currentMaxEventSeq: current.maxEventSeq,
    reasons: reasons.length ? reasons : ['evidence covers current case version and event stream'],
  }
}

export function assertFreshForOwnerOrExternal(db: Database.Database, watermark: EvidenceWatermark): void {
  const r = evaluateEvidenceFreshness(db, watermark)
  if (!r.fresh) throw new Error(`STALE_EVIDENCE: ${r.reasons.join('; ')}`)
}

export function makeEvidenceWatermark(
  db: Database.Database,
  domain: CosDomain,
  caseId: string,
  builtAt: number = Math.floor(Date.now() / 1000),
  sourceFingerprint?: string | null,
): EvidenceWatermark {
  const current = currentEvidenceWatermark(db, domain, caseId)
  if (current.caseVersion === null) throw new Error(`cannot watermark missing ${domain} case ${caseId}`)
  return {
    domain, caseId, caseVersion: current.caseVersion,
    evidenceMaxEventSeq: current.maxEventSeq, builtAt, sourceFingerprint: sourceFingerprint ?? null,
  }
}

/**
 * Reconstruct the watermark for the evidence packet that an owner question was
 * built from, without pretending a timestamp is an event sequence.
 *
 * `case_evidence_packets` predates v1.4.5 and therefore does not yet persist the
 * watermark directly. It DOES persist the progression run id. That run carries
 * the case version the policy had after reasoning, and its own case-history
 * events carry the same source_reference. We can therefore reconstruct a
 * conservative historical watermark:
 *
 *   - case version = referenced run's case_version_after;
 *   - event sequence = every event strictly before packet time, plus events
 *     explicitly belonging to that progression run.
 *
 * The strict `< packet_at` is deliberate. SQLite timestamps are second-granular;
 * an owner answer that arrives later in the same second must not be mistaken for
 * evidence the Reader had already seen. Progression events from that same second
 * are included only when their source_reference proves they belong to the run.
 *
 * If any link in that proof is absent, return UNKNOWN (ok=false). Callers must
 * fail closed for owner-facing/external delivery rather than invent a watermark.
 */
export function reconstructLatestPacketWatermark(
  db: Database.Database,
  domain: CosDomain,
  caseId: string,
  notAfter: number,
): ReconstructedEvidenceWatermark {
  const packet = db.prepare(`
    SELECT packet_id, progression_run_id, created_at
      FROM case_evidence_packets
     WHERE domain=? AND case_id=? AND packet_json IS NOT NULL AND created_at <= ?
     ORDER BY created_at DESC, packet_id DESC LIMIT 1
  `).get(domain, caseId, notAfter) as {
    packet_id: string
    progression_run_id: string | null
    created_at: number
  } | undefined

  if (!packet) return { ok: false, watermark: null, reason: 'no evidence packet exists before owner-facing candidate' }
  if (!packet.progression_run_id) {
    return { ok: false, watermark: null, reason: 'evidence packet has no progression_run_id', packetId: packet.packet_id }
  }

  const run = db.prepare(`
    SELECT case_version_after
      FROM case_progression_runs
     WHERE progression_run_id=? AND domain=? AND case_id=? AND status='COMPLETED'
  `).get(packet.progression_run_id, domain, caseId) as { case_version_after: number | null } | undefined

  if (!run || run.case_version_after == null) {
    return {
      ok: false, watermark: null,
      reason: 'referenced progression run is missing/completed-version is unknown',
      packetId: packet.packet_id, progressionRunId: packet.progression_run_id,
    }
  }

  const t = tables(domain)
  const event = db.prepare(`
    SELECT COALESCE(MAX(event_id), 0) AS n
      FROM ${t.events}
     WHERE case_id=?
       AND (created_at < ? OR source_reference = ?)
  `).get(caseId, packet.created_at, packet.progression_run_id) as { n: number }

  return {
    ok: true,
    packetId: packet.packet_id,
    progressionRunId: packet.progression_run_id,
    reason: 'watermark reconstructed from progression run + event ledger',
    watermark: {
      domain,
      caseId,
      caseVersion: run.case_version_after,
      evidenceMaxEventSeq: event.n,
      builtAt: packet.created_at,
      sourceFingerprint: `packet:${packet.packet_id}:run:${packet.progression_run_id}`,
    },
  }
}

/** Final owner-facing delivery gate for a question already composed/stored. */
export function assertFreshOwnerQuestionDelivery(
  db: Database.Database,
  domain: CosDomain,
  caseId: string,
  askedAt: number,
): EvidenceWatermark {
  const reconstructed = reconstructLatestPacketWatermark(db, domain, caseId, askedAt)
  if (!reconstructed.ok || !reconstructed.watermark) {
    throw new Error(`EVIDENCE_UNKNOWN: ${reconstructed.reason}`)
  }
  assertFreshForOwnerOrExternal(db, reconstructed.watermark)
  return reconstructed.watermark
}
