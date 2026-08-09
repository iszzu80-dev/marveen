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
  db.prepare(`UPDATE zst_product_escalations SET status=@to${done ? ', completed_at=@now' : ''} WHERE escalation_id=@id`)
    .run({ to, now, id: escalationId })
  return getEscalation(db, escalationId)!
}

export function listOpenEscalations(db: Database.Database): EscalationRow[] {
  const rows = db.prepare(
    `SELECT * FROM zst_product_escalations WHERE status NOT IN ('ACCEPTED','REJECTED','CANCELLED') ORDER BY created_at`
  ).all() as Array<Record<string, unknown>>
  return rows.map(r => ({ ...r, hard_gate: isHardGated(r as { target_workspace: string; request_type: string }) }) as EscalationRow)
}
