// ZST Slice 5 — Product Lab gateway (spec §23). The escalation bridge between the
// Product Lab (Marveen/QuickQuote/Zsibongó/…) and ZST business governance. A
// Product Lab item that needs a business decision (cost, contract, commercial
// commitment, pricing, data-processing) is FELTERJESZTVE to ZST; a ZST answer
// (technical question, PRD, review) is TOVÁBBÍTVA to the Product Lab. Only a
// milestone/blocker/cost/decision PROJECTION crosses — never the full backlog
// (§23.4). This module is the state machine; nothing here acts externally.

import type Database from 'better-sqlite3'

export type EscalationStatus =
  | 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'WAITING_SOURCE' | 'RESULT_READY'
  | 'ACCEPTED' | 'REJECTED' | 'CANCELLED'

// Request types that carry a business commitment → they land on ZST governance
// and are hard-gated to Istvan (never auto-accepted). Spec §23.1.
export const ZST_HARD_GATE_REQUESTS = new Set([
  'PAID_SERVICE', 'LICENSE', 'SUBCONTRACTOR', 'CONTRACT', 'SIGNIFICANT_COST',
  'CUSTOMER_OFFER', 'COMMERCIAL_COMMITMENT', 'PRICING', 'DATA_PROCESSING', 'DOMAIN', 'INFRASTRUCTURE',
])

export interface NewEscalation {
  escalationId: string
  sourceWorkspace: 'PRODUCT_LAB' | 'ZST'
  targetWorkspace: 'PRODUCT_LAB' | 'ZST'
  zstCaseId?: string
  productId?: string
  requestType: string
  summary: string
  requiredDecision?: string
  requiredOutput?: string
  dueAt?: number
  sourceReferences?: unknown
}

export interface EscalationRow {
  escalation_id: string
  status: EscalationStatus
  source_workspace: string
  target_workspace: string
  request_type: string
  hard_gate: boolean
  [k: string]: unknown
}

/** Does this escalation require Istvan's business decision (a hard gate)? True
 *  when it targets ZST with a commitment-bearing request type. */
export function isHardGated(e: { targetWorkspace?: string; target_workspace?: string; requestType?: string; request_type?: string }): boolean {
  const target = e.targetWorkspace ?? e.target_workspace
  const type = e.requestType ?? e.request_type ?? ''
  return target === 'ZST' && ZST_HARD_GATE_REQUESTS.has(type)
}

export function createEscalation(db: Database.Database, input: NewEscalation, now: number): EscalationRow {
  db.prepare(
    `INSERT INTO zst_product_escalations
       (escalation_id, source_workspace, target_workspace, zst_case_id, product_id, request_type,
        summary, required_decision, required_output, due_at, status, source_references, created_at)
     VALUES (@id, @src, @tgt, @caseId, @productId, @type, @summary, @decision, @output, @dueAt,
        'OPEN', @refs, @now)`
  ).run({
    id: input.escalationId, src: input.sourceWorkspace, tgt: input.targetWorkspace,
    caseId: input.zstCaseId ?? null, productId: input.productId ?? null, type: input.requestType,
    summary: input.summary, decision: input.requiredDecision ?? null, output: input.requiredOutput ?? null,
    dueAt: input.dueAt ?? null, refs: input.sourceReferences === undefined ? null : JSON.stringify(input.sourceReferences), now,
  })
  return getEscalation(db, input.escalationId)!
}

export function getEscalation(db: Database.Database, escalationId: string): EscalationRow | undefined {
  const r = db.prepare(`SELECT * FROM zst_product_escalations WHERE escalation_id=?`).get(escalationId) as Record<string, unknown> | undefined
  if (!r) return undefined
  return { ...r, hard_gate: isHardGated(r as { target_workspace: string; request_type: string }) } as EscalationRow
}

/** Is the actor column present on this database?
 *
 *  "Who accepted this commitment" is not answerable from the store today: the
 *  actor is checked by the hard gate and then dropped, so zst_product_escalations
 *  records that a contract was ACCEPTED and not by whom. The column belongs in
 *  schema.ts, which this module may not edit — the ALTER TABLE is reported
 *  instead, and the write is already here behind this probe, so the actor starts
 *  being recorded the moment the column exists rather than needing a second
 *  change nobody remembers to make.
 *
 *  Cached per database handle: PRAGMA on every transition would be a query for a
 *  fact that cannot change under a running process. */
const DECIDED_BY_CACHE = new WeakMap<object, boolean>()
function hasDecidedByColumn(db: Database.Database): boolean {
  const cached = DECIDED_BY_CACHE.get(db as unknown as object)
  if (cached !== undefined) return cached
  const cols = db.prepare(`PRAGMA table_info(zst_product_escalations)`).all() as Array<{ name: string }>
  const present = cols.some(c => c.name === 'decided_by')
  DECIDED_BY_CACHE.set(db as unknown as object, present)
  return present
}

const ALLOWED: Record<EscalationStatus, EscalationStatus[]> = {
  OPEN: ['ACKNOWLEDGED', 'CANCELLED'],
  ACKNOWLEDGED: ['IN_PROGRESS', 'WAITING_SOURCE', 'CANCELLED'],
  IN_PROGRESS: ['WAITING_SOURCE', 'RESULT_READY', 'CANCELLED'],
  WAITING_SOURCE: ['IN_PROGRESS', 'RESULT_READY', 'CANCELLED'],
  RESULT_READY: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [], REJECTED: [], CANCELLED: [],
}

/** Move an escalation along its lifecycle. A hard-gated escalation cannot be
 *  ACCEPTED except by Istvan (actor must be 'istvan') — the business commitment
 *  gate (§23.1). Invalid transitions throw. */
export function transitionEscalation(
  db: Database.Database, escalationId: string, to: EscalationStatus, actor: string, now: number,
): EscalationRow {
  const e = getEscalation(db, escalationId)
  if (!e) throw new Error(`escalation ${escalationId} not found`)
  const from = e.status
  if (!ALLOWED[from]?.includes(to)) throw new Error(`illegal escalation transition ${from} → ${to}`)
  if (to === 'ACCEPTED' && e.hard_gate && actor !== 'istvan') {
    throw new Error(`escalation ${escalationId} is hard-gated: only Istvan can ACCEPT a ${e.request_type} commitment`)
  }
  const done = to === 'ACCEPTED' || to === 'REJECTED' || to === 'CANCELLED'
  // The write is conditional on the status the legality check was made against.
  // It used to be `WHERE escalation_id = ?`, so the check and the act were two
  // separate statements with a gap between them: two concurrent transitions both
  // read RESULT_READY, both found their move legal, and the second one landed on
  // top of the first — an escalation ACCEPTED after it had been REJECTED, with
  // nothing anywhere saying it happened. Everything this state machine guards is
  // a business commitment, so the last writer must not win by accident.
  const withActor = hasDecidedByColumn(db)
  const info = db.prepare(
    `UPDATE zst_product_escalations
       SET status=@to${done ? ', completed_at=@now' : ''}${withActor ? ', decided_by=@actor' : ''}
     WHERE escalation_id=@id AND status=@from`,
  ).run({ to, now, id: escalationId, from, ...(withActor ? { actor } : {}) })
  if (info.changes === 0) {
    const current = getEscalation(db, escalationId)
    throw new Error(
      `escalation ${escalationId} moved to ${current?.status ?? 'MISSING'} while this ${from} → ${to} was being decided`)
  }
  return getEscalation(db, escalationId)!
}

export function listOpenEscalations(db: Database.Database): EscalationRow[] {
  const rows = db.prepare(
    `SELECT * FROM zst_product_escalations WHERE status NOT IN ('ACCEPTED','REJECTED','CANCELLED') ORDER BY created_at`
  ).all() as Array<Record<string, unknown>>
  return rows.map(r => ({ ...r, hard_gate: isHardGated(r as { target_workspace: string; request_type: string }) }) as EscalationRow)
}
