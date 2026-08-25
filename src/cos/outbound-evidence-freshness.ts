// ACP v1.4.5 — shared outbound evidence freshness.
//
// Both Personal and ZST already persist the two facts needed to prove whether a
// prepared email is still based on the current case:
//
//   1. the ledger row stores case_version at plan time;
//   2. the case timeline receives OUTBOUND_DRAFTED with source_reference=ledgerId
//      after the exact payload has been planned.
//
// That event is the evidence horizon. Any later case event or case-version move
// means the prepared payload is no longer proven current and first delivery must
// stop. Human approval does not rewrite the payload and is stored in the approval
// ledger, so it does not need to masquerade as evidence freshness.
//
// Recovery states are deliberately not blocked here: SENDING/OUTCOME_UNKNOWN/
// APPLIED_UNVERIFIED recovery sends nothing new and must remain able to settle a
// provider outcome even when the case has moved on.

import type Database from 'better-sqlite3'
import type { CosDomain } from './temporal-facts.js'

export interface OutboundEvidenceFreshnessResult {
  applicable: boolean
  fresh: boolean
  status: 'FRESH' | 'STALE' | 'UNKNOWN' | 'NOT_APPLICABLE'
  reason: string
  ledgerId: string
  caseId: string | null
  plannedCaseVersion: number | null
  currentCaseVersion: number | null
  draftEventSeq: number | null
  currentEventSeq: number
}

function tables(domain: CosDomain): { ledger: string; cases: string; events: string } {
  return domain === 'personal'
    ? { ledger: 'outbound_ledger', cases: 'personal_cases', events: 'personal_case_events' }
    : { ledger: 'zst_outbound_ledger', cases: 'zst_cases', events: 'zst_case_events' }
}

export function evaluateOutboundEvidenceFreshness(
  db: Database.Database,
  domain: CosDomain,
  ledgerId: string,
): OutboundEvidenceFreshnessResult {
  const t = tables(domain)
  let ledger: {
    case_id: string | null
    case_version: number | null
    status: string
    action_type: string
  } | undefined
  try {
    ledger = db.prepare(
      `SELECT case_id, case_version, status, action_type FROM ${t.ledger} WHERE ledger_id=?`,
    ).get(ledgerId) as typeof ledger
  } catch (err) {
    return {
      applicable: true, fresh: false, status: 'UNKNOWN', ledgerId,
      caseId: null, plannedCaseVersion: null, currentCaseVersion: null,
      draftEventSeq: null, currentEventSeq: 0,
      reason: `cannot read ${domain} outbound ledger: ${(err as Error).message}`,
    }
  }

  if (!ledger) {
    return {
      applicable: true, fresh: false, status: 'UNKNOWN', ledgerId,
      caseId: null, plannedCaseVersion: null, currentCaseVersion: null,
      draftEventSeq: null, currentEventSeq: 0,
      reason: 'outbound ledger row is missing',
    }
  }

  // The v1.4.5 gate is about first/retry external delivery. Calendar or future
  // action types need their own evidence horizon, not an email event borrowed by
  // analogy.
  if (ledger.action_type !== 'EMAIL_SEND') {
    return {
      applicable: false, fresh: true, status: 'NOT_APPLICABLE', ledgerId,
      caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
      currentCaseVersion: null, draftEventSeq: null, currentEventSeq: 0,
      reason: `action_type ${ledger.action_type} is not governed by the email draft freshness gate`,
    }
  }

  if (ledger.status !== 'PLANNED' && ledger.status !== 'FAILED_RETRYABLE') {
    return {
      applicable: false, fresh: true, status: 'NOT_APPLICABLE', ledgerId,
      caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
      currentCaseVersion: null, draftEventSeq: null, currentEventSeq: 0,
      reason: `status ${ledger.status} is recovery/settlement, not a first/retry delivery`,
    }
  }

  if (!ledger.case_id || ledger.case_version == null) {
    return {
      applicable: true, fresh: false, status: 'UNKNOWN', ledgerId,
      caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
      currentCaseVersion: null, draftEventSeq: null, currentEventSeq: 0,
      reason: 'ledger row has no case_id or plan-time case_version',
    }
  }

  let currentCase: { version: number } | undefined
  let draft: { event_id: number } | undefined
  let currentEventSeq = 0
  try {
    currentCase = db.prepare(`SELECT version FROM ${t.cases} WHERE case_id=?`)
      .get(ledger.case_id) as { version: number } | undefined
    draft = db.prepare(`
      SELECT event_id FROM ${t.events}
       WHERE case_id=? AND event_type='OUTBOUND_DRAFTED' AND source_reference=?
       ORDER BY event_id DESC LIMIT 1
    `).get(ledger.case_id, ledgerId) as { event_id: number } | undefined
    currentEventSeq = Number((db.prepare(
      `SELECT COALESCE(MAX(event_id),0) AS n FROM ${t.events} WHERE case_id=?`,
    ).get(ledger.case_id) as { n: number }).n)
  } catch (err) {
    return {
      applicable: true, fresh: false, status: 'UNKNOWN', ledgerId,
      caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
      currentCaseVersion: currentCase?.version ?? null,
      draftEventSeq: draft?.event_id ?? null, currentEventSeq,
      reason: `cannot prove outbound evidence horizon: ${(err as Error).message}`,
    }
  }

  if (!currentCase) {
    return {
      applicable: true, fresh: false, status: 'UNKNOWN', ledgerId,
      caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
      currentCaseVersion: null, draftEventSeq: draft?.event_id ?? null, currentEventSeq,
      reason: 'case no longer exists',
    }
  }
  if (!draft) {
    // Legacy drafts created before OUTBOUND_DRAFTED existed are not silently
    // grandfathered. The safe repair is re-draft/re-approve the exact payload.
    return {
      applicable: true, fresh: false, status: 'UNKNOWN', ledgerId,
      caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
      currentCaseVersion: currentCase.version, draftEventSeq: null, currentEventSeq,
      reason: 'no OUTBOUND_DRAFTED evidence horizon exists for this ledger row',
    }
  }

  const reasons: string[] = []
  if (currentCase.version !== ledger.case_version) {
    reasons.push(`case version moved ${ledger.case_version} -> ${currentCase.version}`)
  }
  if (currentEventSeq > draft.event_id) {
    reasons.push(`new case event after draft horizon ${draft.event_id} -> ${currentEventSeq}`)
  }
  if (reasons.length) {
    return {
      applicable: true, fresh: false, status: 'STALE', ledgerId,
      caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
      currentCaseVersion: currentCase.version, draftEventSeq: draft.event_id,
      currentEventSeq, reason: reasons.join('; '),
    }
  }

  return {
    applicable: true, fresh: true, status: 'FRESH', ledgerId,
    caseId: ledger.case_id, plannedCaseVersion: ledger.case_version,
    currentCaseVersion: currentCase.version, draftEventSeq: draft.event_id,
    currentEventSeq, reason: 'case version and event stream still equal the exact draft horizon',
  }
}

/**
 * Shared first-delivery assertion. The marker is intentionally stable: the
 * hardening acceptance scanner requires this exact chokepoint family to be wired
 * into authorization consumption before readiness may pass.
 */
export function assertOutboundEvidenceFresh(
  db: Database.Database,
  domain: CosDomain,
  ledgerId: string,
): void {
  const r = evaluateOutboundEvidenceFreshness(db, domain, ledgerId)
  if (!r.applicable) return
  if (!r.fresh) throw new Error(`OUTBOUND_EVIDENCE_FRESHNESS: ${r.status}: ${r.reason}`)
}
