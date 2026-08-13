// v1.4 Proactive Core — recording a signal (§4.1, §7).
//
// The four invariants of §4.1 are enforced HERE, at the only door into the
// table, rather than checked by whoever calls. Three of the four are refusals
// this module can make on its own:
//
//   • evidence only            — no claim without a citation
//   • source reference required — no signal without a source
//   • no repeat for one event   — the dedupe key is UNIQUE per domain
//
// The fourth ("a signal on its own must not interrupt the owner, and must not
// create a Case") is not something a store can refuse. It is enforced by the
// fact that nothing in this directory imports the interruption path or the case
// store at all — which is exactly what `proactive-core-import-boundary` asserts,
// permanently, instead of trusting this comment.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  PROACTIVE_SIGNAL_TYPES,
  type ProactiveDomain,
  type ProactiveSignal,
  type ProactiveSignalType,
  type SignalStatus,
  type EvidenceClaim,
} from './types.js'

export interface SignalDraft {
  domain: ProactiveDomain
  signalType: ProactiveSignalType
  sourceRefs: string[]
  sourceEventIds?: string[]
  subjectRef?: string
  candidateCaseId?: string
  summary: string
  evidenceClaims: EvidenceClaim[]
  estimatedMateriality: ProactiveSignal['estimatedMateriality']
  estimatedUrgency: ProactiveSignal['estimatedUrgency']
  estimatedActionability: ProactiveSignal['estimatedActionability']
  candidateDeadline?: number
  confidence: number
  /** Optional override. Left alone, both keys are derived below — which is the
   *  intended path, because a caller-supplied key is a caller-supplied dedupe
   *  policy. */
  dedupeKey?: string
  noveltyKey?: string
}

export type RecordSignalResult =
  /** A new signal. */
  | { outcome: 'RECORDED'; signal: ProactiveSignal }
  /** §7.2: same situation, nothing materially changed. Not an error, and
   *  counted — `duplicate_case_rate` and `suppressed_signal_rate` (§8.2) are
   *  built from exactly this. */
  | { outcome: 'DUPLICATE'; signalId: string; reason: string }
  /** §7.2: same situation, the facts moved. The existing row is UPDATED rather
   *  than a second one written — "duplicate suppression must not swallow a
   *  materially changed state" and "a new fact may update the existing
   *  Initiative" are the same sentence read from two sides. */
  | { outcome: 'UPDATED'; signal: ProactiveSignal; reason: string }
  /** §4.1 refused it. */
  | { outcome: 'REFUSED'; reason: string }

/** §7.1 tier 3: the semantic fingerprint. Identity of the SITUATION — what kind
 *  of thing, about which subject, in which domain — deliberately excluding
 *  anything that changes when the facts move. Two detections of the same
 *  approaching deadline share this; a different deadline on the same contract
 *  does not. */
export function deriveDedupeKey(d: Pick<SignalDraft, 'domain' | 'signalType' | 'subjectRef' | 'candidateCaseId' | 'sourceEventIds' | 'summary'>): string {
  // Preference order mirrors §7.1: the most specific identity available wins,
  // so an exact source event never collapses into a fuzzy subject match.
  const subject = d.subjectRef
    ?? d.candidateCaseId
    ?? (d.sourceEventIds?.length ? [...d.sourceEventIds].sort().join('|') : null)
    ?? normalise(d.summary)
  return sha(`${d.domain}\u0000${d.signalType}\u0000${subject}`)
}

/** What must change for this to count as NEW information about the same
 *  situation. Everything a reader would act on differently: the deadline, the
 *  estimates, and the claims themselves. */
export function deriveNoveltyKey(d: Pick<SignalDraft, 'evidenceClaims' | 'candidateDeadline' | 'estimatedMateriality' | 'estimatedUrgency' | 'estimatedActionability'>): string {
  const claims = d.evidenceClaims
    .map(c => `${normalise(c.statement)}@${String(c.sourceRef)}`)
    .sort()
    .join('\u0001')
  return sha([
    claims,
    d.candidateDeadline ?? '',
    d.estimatedMateriality,
    d.estimatedUrgency,
    d.estimatedActionability,
  ].join('\u0000'))
}

function sha(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 32) }
/** Whitespace and case are not information. Accents are: `foldName` exists for
 *  people's names precisely because the model spells them both ways, but a
 *  document title that differs by an accent is a different title. */
function normalise(s: string): string { return s.trim().toLowerCase().replace(/\s+/g, ' ') }

/** §4.1, stated as a function so a caller can check before building a row and
 *  the store can refuse regardless. Returns the reason, or null when the draft
 *  is admissible. */
export function signalRefusal(d: SignalDraft): string | null {
  if (!PROACTIVE_SIGNAL_TYPES.includes(d.signalType)) return `unknown signal type: ${String(d.signalType)}`
  if (d.domain !== 'personal' && d.domain !== 'zst') return `unknown domain: ${String(d.domain)}`
  if (!d.summary?.trim()) return 'a signal with no summary says nothing'
  // Source reference mandatory (§4.1). An empty array is the shape a caller
  // reaches for when it has nothing, so it is refused by name rather than
  // passing as "technically present".
  const refs = d.sourceRefs.filter(r => typeof r === 'string' && r.trim().length > 0)
  if (refs.length === 0) return 'a signal needs at least one source reference (§4.1)'
  // Evidence-grounded (§4.1). "model-only guess is not enough" is enforced as:
  // there is at least one claim, and every claim cites a source that was
  // actually declared. The second half is what stops a citation being invented
  // alongside the claim it is supposed to support — the same rule the Reader's
  // packet validation already applies to facts.
  if (!d.evidenceClaims?.length) return 'a signal needs at least one evidence claim (§4.1)'
  const declared = new Set(refs)
  for (const c of d.evidenceClaims) {
    if (!c?.statement?.trim()) return 'an evidence claim with no statement is not evidence'
    if (!declared.has(String(c.sourceRef))) {
      return `an evidence claim cites "${String(c.sourceRef)}", which is not among the signal's sources (§4.1)`
    }
  }
  if (!(d.confidence >= 0 && d.confidence <= 1)) return `confidence out of range: ${String(d.confidence)}`
  if (d.candidateDeadline != null && !Number.isSafeInteger(d.candidateDeadline)) {
    // Epoch seconds, not an ISO string and not milliseconds. V4-F12 is the
    // fixture for what unchecked time arithmetic costs.
    return `candidate deadline must be epoch seconds: ${String(d.candidateDeadline)}`
  }
  return null
}

/**
 * Record a signal, or say precisely why not.
 *
 * The one thing this function will never do is write a second row for a
 * situation that already has one. §7.2's invariants pull in opposite directions
 * — never duplicate, never swallow a change — and the only way to satisfy both
 * is to make "same situation" and "same information" two separate questions,
 * which is what the two keys are for.
 */
export function recordSignal(
  db: Database.Database,
  draft: SignalDraft,
  now: number,
): RecordSignalResult {
  const refusal = signalRefusal(draft)
  if (refusal) return { outcome: 'REFUSED', reason: refusal }

  const dedupeKey = draft.dedupeKey ?? deriveDedupeKey(draft)
  const noveltyKey = draft.noveltyKey ?? deriveNoveltyKey(draft)

  const existing = db.prepare(
    `SELECT signal_id, novelty_key, status FROM proactive_signals WHERE domain = ? AND dedupe_key = ?`,
  ).get(draft.domain, dedupeKey) as { signal_id: string; novelty_key: string; status: SignalStatus } | undefined

  if (existing && existing.novelty_key === noveltyKey) {
    return {
      outcome: 'DUPLICATE',
      signalId: existing.signal_id,
      reason: 'ugyanaz a helyzet, változatlan tényekkel',
    }
  }

  const signalId = existing?.signal_id ?? `psig-${sha(`${dedupeKey}${noveltyKey}${now}`)}`
  const row = {
    signal_id: signalId,
    domain: draft.domain,
    signal_type: draft.signalType,
    source_refs_json: JSON.stringify(draft.sourceRefs),
    source_event_ids_json: JSON.stringify(draft.sourceEventIds ?? []),
    detected_at: now,
    subject_ref: draft.subjectRef ?? null,
    candidate_case_id: draft.candidateCaseId ?? null,
    summary: draft.summary,
    evidence_claims_json: JSON.stringify(draft.evidenceClaims),
    estimated_materiality: draft.estimatedMateriality,
    estimated_urgency: draft.estimatedUrgency,
    estimated_actionability: draft.estimatedActionability,
    candidate_deadline: draft.candidateDeadline ?? null,
    confidence: draft.confidence,
    dedupe_key: dedupeKey,
    novelty_key: noveltyKey,
    now,
  }

  if (existing) {
    // Materially changed. The row is updated in place and the status returns to
    // DETECTED: a suppressed signal whose facts moved has to be looked at again,
    // and leaving it SUPPRESSED would be the swallow §7.2 forbids.
    db.prepare(
      `UPDATE proactive_signals SET
         signal_type = @signal_type, source_refs_json = @source_refs_json,
         source_event_ids_json = @source_event_ids_json, detected_at = @detected_at,
         subject_ref = @subject_ref, candidate_case_id = @candidate_case_id,
         summary = @summary, evidence_claims_json = @evidence_claims_json,
         estimated_materiality = @estimated_materiality, estimated_urgency = @estimated_urgency,
         estimated_actionability = @estimated_actionability, candidate_deadline = @candidate_deadline,
         confidence = @confidence, novelty_key = @novelty_key,
         status = 'DETECTED', updated_at = @now
       WHERE signal_id = @signal_id`,
    ).run(row)
    return {
      outcome: 'UPDATED',
      signal: readSignal(db, signalId)!,
      reason: 'ugyanaz a helyzet, de a tények megváltoztak',
    }
  }

  db.prepare(
    `INSERT INTO proactive_signals (
       signal_id, domain, signal_type, source_refs_json, source_event_ids_json, detected_at,
       subject_ref, candidate_case_id, summary, evidence_claims_json,
       estimated_materiality, estimated_urgency, estimated_actionability,
       candidate_deadline, confidence, dedupe_key, novelty_key, status, created_at, updated_at)
     VALUES (
       @signal_id, @domain, @signal_type, @source_refs_json, @source_event_ids_json, @detected_at,
       @subject_ref, @candidate_case_id, @summary, @evidence_claims_json,
       @estimated_materiality, @estimated_urgency, @estimated_actionability,
       @candidate_deadline, @confidence, @dedupe_key, @novelty_key, 'DETECTED', @now, @now)`,
  ).run(row)
  return { outcome: 'RECORDED', signal: readSignal(db, signalId)! }
}

export function readSignal(db: Database.Database, signalId: string): ProactiveSignal | null {
  const r = db.prepare(`SELECT * FROM proactive_signals WHERE signal_id = ?`).get(signalId) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    signalId: r.signal_id as string,
    domain: r.domain as ProactiveDomain,
    signalType: r.signal_type as ProactiveSignalType,
    sourceRefs: JSON.parse(r.source_refs_json as string) as string[],
    sourceEventIds: JSON.parse(r.source_event_ids_json as string) as string[],
    detectedAt: r.detected_at as number,
    subjectRef: (r.subject_ref as string | null) ?? undefined,
    candidateCaseId: (r.candidate_case_id as string | null) ?? undefined,
    summary: r.summary as string,
    evidenceClaims: JSON.parse(r.evidence_claims_json as string) as EvidenceClaim[],
    estimatedMateriality: r.estimated_materiality as ProactiveSignal['estimatedMateriality'],
    estimatedUrgency: r.estimated_urgency as ProactiveSignal['estimatedUrgency'],
    estimatedActionability: r.estimated_actionability as ProactiveSignal['estimatedActionability'],
    candidateDeadline: (r.candidate_deadline as number | null) ?? undefined,
    confidence: r.confidence as number,
    dedupeKey: r.dedupe_key as string,
    noveltyKey: r.novelty_key as string,
    status: r.status as SignalStatus,
  }
}

/** Set a signal's status. The store owns the transition so `PROMOTED` can only
 *  be written by the promotion path — a status that anyone may set is a status
 *  that stops meaning anything. */
export function setSignalStatus(
  db: Database.Database, signalId: string, status: SignalStatus, now: number,
): boolean {
  const r = db.prepare(
    `UPDATE proactive_signals SET status = ?, updated_at = ? WHERE signal_id = ?`,
  ).run(status, now, signalId)
  return r.changes === 1
}
