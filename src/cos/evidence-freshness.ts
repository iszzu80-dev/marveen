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
