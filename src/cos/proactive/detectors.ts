// §12 / §13 / §26(17–18): stall and anomaly detection.
//
// BOTH ARE DETERMINISTIC, and both produce SIGNALS — never alerts. §13 is
// explicit: "anomaly → signal → qualification → existing Case update, not an
// automatic alert." So nothing here notifies anybody. Everything goes through
// the §6 qualification policy, which is where the decision about whether a
// situation is worth anyone's attention already lives.
//
// THE SENTENCE §12 IS BUILT AROUND: **not every old case is a stall.**
//
// That is the whole difficulty. A case waiting on a lawyer for three weeks is
// not stalled — it is waiting, correctly, and the system has nothing useful to
// do about it. A detector that cannot tell those apart produces a list of every
// old case, which is the same list the owner could produce by sorting by date,
// and it is worth exactly as much. So §12.1's four conditions are ANDed, and
// each one has to be false-able on its own.
//
// WHAT THE ANOMALY DETECTOR WILL NOT DO. §13 limits it to anomalies for which
// internal evidence ALREADY EXISTS. No fetching, no re-reading, no asking. Every
// finding below is a contradiction between two things the store already holds —
// which is also what makes each one citable, and §4.1 will not accept a signal
// that is not.

import type Database from 'better-sqlite3'
import { deadlineIndex } from '../deadline-index.js'
import type { EvidenceClaim, ProactiveDomain } from './types.js'
import type { SignalDraft } from './signal-store.js'

// ── §12 Stall detection ─────────────────────────────────────────────────

/** How long without a meaningful transition before age even becomes a
 *  question. Below this, "nothing has happened" is just "recently". */
export const STALL_AGE_SEC = 21 * 86400
/** The engine's own counter, already maintained. §3: reuse, do not re-count. */
export const STALL_NO_PROGRESS_RUNS = 12

/** Statuses in which waiting is the CORRECT state, so age proves nothing.
 *  §12.1's fourth condition, as data — the list is the load-bearing part and a
 *  buried `!==` would hide it. */
export const LEGITIMATE_WAIT_STATUSES = ['WAITING_EXTERNAL', 'SCHEDULED', 'AWAITING_APPROVAL', 'AWAITING_SELECTION'] as const

/** Terminal statuses: a finished case cannot stall. */
const TERMINAL = ['COMPLETED', 'CANCELLED', 'ARCHIVED'] as const

export interface StallFinding {
  domain: ProactiveDomain
  caseId: string
  ageSec: number
  noProgressRuns: number
  reason: string
  evidence: EvidenceClaim[]
}

/**
 * §12.1: age AND no meaningful transition AND outcome still open AND not
 * legitimately waiting.
 *
 * All four, and the last is the one that does the work. Dropping it turns this
 * into "list cases older than three weeks", which the owner can already do by
 * sorting a column — and which would put every correctly-waiting case in front
 * of him as though something were wrong.
 */
export function detectStalls(
  db: Database.Database, domain: ProactiveDomain, now: number,
): StallFinding[] {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  let rows: Array<{ id: string; status: string; u: number; runs: number | null }> = []
  try {
    rows = db.prepare(
      `SELECT c.case_id AS id, c.status AS status, c.updated_at AS u,
              s.no_progress_run_count AS runs
         FROM ${table} c
         LEFT JOIN case_progression_state s
           ON s.case_id = c.case_id AND s.domain = ?
        WHERE c.archived_at IS NULL
          AND c.status NOT IN (${TERMINAL.map(() => '?').join(',')})
          AND c.updated_at <= ?`,
    ).all(domain, ...TERMINAL, now - STALL_AGE_SEC) as typeof rows
  } catch { return [] }

  const out: StallFinding[] = []
  for (const r of rows) {
    // Condition 4, checked first because it is the cheapest way to be wrong.
    if ((LEGITIMATE_WAIT_STATUSES as readonly string[]).includes(r.status)) continue
    const runs = r.runs ?? 0
    const ageSec = now - r.u
    // Condition 2: "no meaningful state transition". The engine's counter is
    // the evidence for it — a case that reasoned twelve times and moved nothing
    // has been re-examined, not ignored.
    //
    // A case with NO progression row at all also qualifies on age alone: it has
    // not reasoned even once, which is a stronger form of the same fact and the
    // one an engine-counter-only rule would miss entirely.
    const hasEngineEvidence = r.runs != null
    if (hasEngineEvidence && runs < STALL_NO_PROGRESS_RUNS) continue

    const evidence: EvidenceClaim[] = [{
      statement: `Az ügy ${Math.floor(ageSec / 86400)} napja nem változott (utolsó módosítás: ${r.u}).`,
      sourceRef: `${table}#${r.id}`,
    }]
    if (hasEngineEvidence) {
      evidence.push({
        statement: `A motor ${runs} futáson át nem talált előrelépést.`,
        sourceRef: `case_progression_state#${domain}/${r.id}`,
      })
    }
    out.push({
      domain, caseId: r.id, ageSec, noProgressRuns: runs,
      reason: hasEngineEvidence
        ? `${runs} futás előrelépés nélkül, ${Math.floor(ageSec / 86400)} nap`
        : `${Math.floor(ageSec / 86400)} napja nem járt rajta a motor`,
      evidence,
    })
  }
  return out.sort((a, b) => b.ageSec - a.ageSec || a.caseId.localeCompare(b.caseId))
}

/** §12 → §4: a stall finding as a signal draft. Deliberately a separate step —
 *  detecting and recording are different decisions, and the store's §4.1
 *  refusals apply to this exactly as they do to any other signal. */
export function stallSignal(f: StallFinding): SignalDraft {
  const table = f.domain === 'zst' ? 'zst_cases' : 'personal_cases'
  return {
    domain: f.domain,
    signalType: 'STALL',
    sourceRefs: f.evidence.map(e => e.sourceRef),
    subjectRef: `${f.domain}/${f.caseId}`,
    candidateCaseId: f.caseId,
    summary: `Az ügy megakadt: ${f.reason}.`,
    evidenceClaims: f.evidence,
    estimatedMateriality: f.ageSec > 60 * 86400 ? 'HIGH' : 'MEDIUM',
    estimatedUrgency: 'MEDIUM',
    estimatedActionability: 'MEDIUM',
    // Confidence, not certainty: the detector knows the case has not moved. It
    // does not know that moving it is possible, and pretending otherwise is how
    // a stall list becomes a list of things nobody can do anything about.
    confidence: 0.7,
    sourceEventIds: [`${table}#${f.caseId}`],
  }
}

// ── §13 Anomaly detection ───────────────────────────────────────────────

export type AnomalyKind =
  | 'DEADLINE_SUPERSEDED'
  | 'STATUS_CONTRADICTS_DEADLINE'
  | 'CONFLICTING_DEADLINES'

export interface AnomalyFinding {
  domain: ProactiveDomain
  caseId: string
  kind: AnomalyKind
  summary: string
  evidence: EvidenceClaim[]
}

/**
 * §13: contradictions between two things the store ALREADY holds.
 *
 * Nothing here fetches, re-reads or asks. That is not a limitation being worked
 * around — it is what makes every finding citable, and §4.1 will not accept a
 * signal whose claims cite a source the signal did not declare.
 *
 * The three below are the ones the current schema can actually support. The
 * spec's other examples (an amount in a document differing from the case, a
 * promised reply that did not arrive) need the extracted-document layer and the
 * outcome contract respectively — named in `unsupportedAnomalyKinds` rather than
 * quietly absent, so a later audit can tell "not built" from "found nothing".
 */
export function detectAnomalies(
  db: Database.Database, domain: ProactiveDomain, now: number,
): AnomalyFinding[] {
  const out: AnomalyFinding[] = []
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  const records = deadlineIndex(db, domain, now).records

  // 1. Two deadlines of the SAME kind on one case, at different times. One of
  //    them superseded the other and nothing recorded which — §9's "fresh
  //    evidence wins, the old record is superseded not deleted" has no answer
  //    here, so a human has to give one.
  const byCaseKind = new Map<string, typeof records>()
  for (const r of records) {
    if (!r.caseId) continue
    const k = `${r.caseId}|${r.deadlineType}`
    const list = byCaseKind.get(k) ?? []
    list.push(r)
    byCaseKind.set(k, list)
  }
  for (const [k, list] of byCaseKind) {
    if (list.length < 2) continue
    const distinct = new Set(list.map(r => r.externalDeadline))
    if (distinct.size < 2) continue
    const [caseId, kind] = k.split('|')
    out.push({
      domain, caseId, kind: 'CONFLICTING_DEADLINES',
      summary: `Ugyanarra az ügyre két eltérő ${kind} határidő van rögzítve.`,
      evidence: list.map(r => ({
        statement: `${kind} határidő: ${r.externalDeadline} (${r.sourceRef}).`,
        sourceRef: r.sourceRef,
      })),
    })
  }

  // 2. A case whose own status says it is finished with the outside world while
  //    a deadline attached to it is still open and already past.
  let rows: Array<{ id: string; status: string }> = []
  try {
    rows = db.prepare(
      `SELECT case_id AS id, status FROM ${table} WHERE archived_at IS NULL`,
    ).all() as typeof rows
  } catch { return out }
  const statusOf = new Map(rows.map(r => [r.id, r.status]))
  for (const r of records) {
    if (!r.caseId) continue
    const status = statusOf.get(r.caseId)
    if (!status) continue
    if (status !== 'READY' && status !== 'SCHEDULED') continue
    if (r.externalDeadline > now) continue
    out.push({
      domain, caseId: r.caseId, kind: 'STATUS_CONTRADICTS_DEADLINE',
      summary: `Az ügy állapota ${status}, miközben egy ${r.deadlineType} határideje már lejárt.`,
      evidence: [
        { statement: `Az ügy állapota: ${status}.`, sourceRef: `${table}#${r.caseId}` },
        { statement: `Lejárt ${r.deadlineType} határidő: ${r.externalDeadline}.`, sourceRef: r.sourceRef },
      ],
    })
  }

  return out.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.kind.localeCompare(b.kind))
}

/** §22's rule, applied to this module: a capability gap is reported as a
 *  capability gap, never as a clean zero. These are §13 examples the current
 *  schema cannot support, and each one names what it is waiting for. */
export const unsupportedAnomalyKinds: ReadonlyArray<{ kind: string; needs: string }> = [
  { kind: 'AMOUNT_DIFFERS_FROM_CASE', needs: 'a dokumentumból kinyert összegek strukturált tárolása' },
  { kind: 'PROMISED_REPLY_MISSING', needs: 'az Outcome Contract ígéret-nyilvántartása (§26/12.)' },
  { kind: 'EXPECTED_EVIDENCE_MISSING', needs: 'ügytípusonkénti elvárt bizonyíték-lista' },
]

export function anomalySignal(f: AnomalyFinding): SignalDraft {
  return {
    domain: f.domain,
    signalType: 'ANOMALY',
    sourceRefs: f.evidence.map(e => e.sourceRef),
    subjectRef: `${f.domain}/${f.caseId}`,
    candidateCaseId: f.caseId,
    summary: f.summary,
    evidenceClaims: f.evidence,
    // An anomaly is a contradiction between two stored facts, so the DETECTION
    // is certain even when its significance is not. High confidence, moderate
    // materiality: we are sure of what we saw, not of what it means.
    estimatedMateriality: 'MEDIUM',
    estimatedUrgency: f.kind === 'STATUS_CONTRADICTS_DEADLINE' ? 'HIGH' : 'MEDIUM',
    estimatedActionability: 'HIGH',
    confidence: 0.9,
    sourceEventIds: f.evidence.map(e => e.sourceRef),
  }
}
