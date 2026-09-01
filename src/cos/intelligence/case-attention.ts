// PHASE 2 -- ATTENTION IS NOT COMMITMENT.
//
// Owner ruling 2026-09-01: "Egy ugy lehet magas prioritasu ATTENTION akkor is,
// ha nincs commitment. A ZST-oldali NAV/Cegkapu, AWS support es Spaceship
// verification tipusu ugyeket NE azert emeld fel, mert a motor next_actiont irt
// hozzajuk. A prioritas az ugy valodi evidence-ebol jojjon."
//
// Before this module the only route into attention was a commitment, so the
// obligation gate that (correctly) removed 17 engine templates would have taken
// a NAV enforcement notice out of view with them. The right cases were being
// surfaced for the wrong reason; removing the wrong reason must not remove the
// cases.
//
// Every reason below names something IN THE RECORD. None of them reads the
// engine's own plan.
import type Database from 'better-sqlite3'
import type { AttentionBand, AttentionItem } from './attention.js'
import { makeElement, type IntelligenceElement, type Provenance } from './element.js'

export type CaseAttentionReason =
  /** A named authority sent a named document and the record cannot show it was
   *  read. Legal/financial/admin risk with a real sender, not a generic doubt. */
  | 'AUTHORITATIVE_NOTICE_UNREAD'
  /** The owner is the only one who can move it: a selection, an approval, or a
   *  fact only they hold. */
  | 'USER_ACTION_REQUIRED'
  /** A date the record actually states, already passed. */
  | 'EXPLICIT_DEADLINE_PASSED'
  /** Waiting on somebody outside, named on the case. */
  | 'BLOCKED_EXTERNAL_DEPENDENCY'
  /** Open, and nothing has touched it for a long time. The weakest of these, and
   *  deliberately last. */
  | 'STALE_UNRESOLVED'

/**
 * Senders whose mail is an official notice rather than correspondence. This is a
 * judgement, declared as one: Hungarian public-authority domains, plus the
 * central government document portal that delivers on their behalf. It is a
 * definition of "authoritative", not a list of things seen going wrong.
 */
const AUTHORITY_DOMAINS = ['gov.hu', 'nmhh.hu', 'mkik.hu', 'onyf.hu', 'allamkincstar.gov.hu']

const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'ARCHIVED'])
const OWNER_MUST_ACT = new Set([
  'AWAITING_SELECTION', 'AWAITING_APPROVAL', 'INFO_REQUIRED', 'INFORMATION_REQUIRED',
])
const DAY = 86_400
const STALE_AFTER = 14 * DAY

export interface CaseAttentionRow {
  case_id: string
  title: string | null
  status: string
  description: string | null
  due_at: number | null
  waiting_on: string | null
  related_document_ids: string | null
  created_at: number
  updated_at: number
}

export interface CaseAttention extends IntelligenceElement {
  reason: CaseAttentionReason
  /** True only for AUTHORITATIVE_NOTICE_UNREAD: the notice exists, the document
   *  behind it does not. Reported as unknown, never as fulfilled or overdue --
   *  there is no evidence the owner collected it, and none that they did not. */
  contentUnknown: boolean
}

/** The sender, from the one place the intake records it. Null when absent -- an
 *  unparseable description is not an authority. */
export function senderOf(description: string | null): string | null {
  if (!description) return null
  const m = /From:\s*([^\s<>"]+@[^\s<>"]+)/i.exec(description)
  return m ? m[1].toLowerCase() : null
}

export function isAuthority(sender: string | null): boolean {
  if (!sender) return false
  const domain = sender.split('@')[1] ?? ''
  return AUTHORITY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/**
 * The attention a case earns on its own evidence. At most one item per case: the
 * first reason that applies, in the order they are declared, so the reason a
 * reader sees is the strongest true one and never a blend.
 */
export function caseAttentionFor(
  row: CaseAttentionRow, namespace: 'personal' | 'zst', now: number,
): CaseAttention | null {
  if (TERMINAL.has(row.status)) return null

  const sender = senderOf(row.description)
  const hasDocument = !!(row.related_document_ids && row.related_document_ids !== '[]')
  const prov = (field: string): Provenance[] => [{
    source: 'CASE', ref: row.case_id, observedAt: row.updated_at, field,
  }]

  let reason: CaseAttentionReason | null = null
  let statement = ''
  let provenance: Provenance[] = []
  let contentUnknown = false

  if (isAuthority(sender) && !hasDocument) {
    reason = 'AUTHORITATIVE_NOTICE_UNREAD'
    contentUnknown = true
    statement = `${sender} sent an official notice and no document is attached to the case -- ` +
      `the content is unknown and there is no evidence it was collected`
    provenance = prov('description')
  } else if (OWNER_MUST_ACT.has(row.status)) {
    reason = 'USER_ACTION_REQUIRED'
    statement = `only the owner can move this: the case is ${row.status}`
    provenance = prov('status')
  } else if (row.due_at != null && row.due_at < now) {
    reason = 'EXPLICIT_DEADLINE_PASSED'
    statement = `a stated deadline passed ${Math.floor((now - row.due_at) / DAY)} days ago`
    provenance = prov('due_at')
  } else if (row.waiting_on?.trim() || row.status === 'WAITING_EXTERNAL') {
    reason = 'BLOCKED_EXTERNAL_DEPENDENCY'
    statement = `blocked on ${row.waiting_on?.trim() || 'an external party'}`
    provenance = prov(row.waiting_on?.trim() ? 'waiting_on' : 'status')
  } else if (now - row.updated_at > STALE_AFTER) {
    reason = 'STALE_UNRESOLVED'
    statement = `open and untouched for ${Math.floor((now - row.updated_at) / DAY)} days`
    provenance = prov('updated_at')
  }

  if (!reason) return null

  const el = makeElement({
    id: `case-attention:${namespace}:${row.case_id}`,
    // What the record says, not what anyone concluded from it.
    kind: 'FACT',
    caseId: row.case_id,
    namespace,
    statement: `${row.title?.trim() || row.case_id}: ${statement}`,
    provenance,
    confidence: reason === 'STALE_UNRESOLVED' ? 'MEDIUM' : 'HIGH',
    contradiction: { state: 'NONE' },
  }, now)

  return { ...el, reason, contentUnknown }
}

/** Band and factors for a case-derived attention item.
 *
 *  AUTHORITATIVE_NOTICE_UNREAD is the one that reaches SAFETY, and it is a
 *  different thing from the generic "UNKNOWN therefore unsafe" alarm the owner
 *  ruled out: a named authority, a named document, and a record that cannot show
 *  it was read. The owner asked for exactly this class to be HIGH/P0. */
export function caseAttentionToAttention(a: CaseAttention, now: number): AttentionItem {
  const band: AttentionBand =
      a.reason === 'AUTHORITATIVE_NOTICE_UNREAD' ? 'SAFETY'
    : a.reason === 'STALE_UNRESOLVED' ? 'INFORMATIONAL'
    : a.reason === 'BLOCKED_EXTERNAL_DEPENDENCY' ? 'BLOCKING'
    : 'OBLIGATION'
  const risk =
      a.reason === 'AUTHORITATIVE_NOTICE_UNREAD' ? 0.95
    : a.reason === 'USER_ACTION_REQUIRED' ? 0.5
    : a.reason === 'EXPLICIT_DEADLINE_PASSED' ? 0.4
    : 0.1
  return {
    element: a,
    band,
    factors: {
      risk,
      urgency: a.reason === 'EXPLICIT_DEADLINE_PASSED' ? 1 : 0,
      staleness: Math.min(1, a.recencySeconds / (14 * DAY)),
      blockedness: a.reason === 'BLOCKED_EXTERNAL_DEPENDENCY' ? 1 : 0,
      unresolvedContradiction: 0,
    },
    why: a.statement,
  }
}

const COLUMNS = `case_id, title, status, description, due_at, waiting_on,
   related_document_ids, created_at, updated_at`

/** Project case-level attention across a namespace. Reads only. */
export function projectCaseAttention(
  db: Database.Database, namespace: 'personal' | 'zst', now: number, limit = 500,
): CaseAttention[] {
  const table = namespace === 'personal' ? 'personal_cases' : 'zst_cases'
  const rows = db.prepare(
    `SELECT ${COLUMNS} FROM ${table} WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).all(limit) as CaseAttentionRow[]
  const out: CaseAttention[] = []
  for (const r of rows) {
    const a = caseAttentionFor(r, namespace, now)
    if (a) out.push(a)
  }
  return out
}
