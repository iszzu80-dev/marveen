// F-7 (review 2026-08-10): cosTick drove executeAction on EVERY row that
// reconcileOutbound returned, and that query returned PLANNED rows. A PLANNED
// row has never been sent, so the tick was one adapter registration away from
// delivering mail nobody approved. §7.3 requires the approval/template/payload/
// scope/budget check before EVERY execution; the tick evaluates none of it.
//
// Two independent guards, tested independently, because a single guard that is
// also the only one is a guard nobody can prove:
//   1. reconcileOutbound never offers PLANNED.
//   2. executeAction refuses to leave PLANNED without an evaluated decision.
// Guard 2 matters even with guard 1 in place: any future caller reaching
// executeAction directly hits it.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { issueAuthorization } from '../cos/action-authorization.js'
import { createCase } from '../cos/case-store.js'
import { planAction, executeAction } from '../cos/executor.js'
import { reconcileOutbound } from '../cos/scheduler.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'

// §22.2: a first send needs a gate-issued ticket, not a caller-side boolean.
// These tests issue one exactly as production does.
function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {
  const ctx = {
    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,
    actionId: ledgerId, actionType: 'EMAIL_SEND', intent: 'TEST', targetReference: null,
    recipient: null, payloadHash: null, approvalId: null,
  }
  return { authorizationId: issueAuthorization(db, ctx, now).authorizationId, authorizationContext: ctx }
}


const T0 = 1_700_000_000
const PLAN = {
  caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1,
  payload: { to: 'vendor@example.com', subject: 'S', body: 'B' },
}

describe('a first send needs an evaluated decision (F-7)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'QUOTE' }, T0)
  })

  it('GUARD 1: reconcileOutbound does not offer a PLANNED row for automated work', () => {
    const db = getDb()
    const p = planAction(db, PLAN, T0)
    const work = reconcileOutbound(db)
    expect(work.map(w => w.ledger_id)).not.toContain(p.ledgerId)
  })

  it('GUARD 1 CONTROL: it still offers rows that genuinely need recovery', () => {
    // Without this, "returns nothing" would pass guard 1 and break the system.
    const db = getDb()
    const p = planAction(db, PLAN, T0)
    db.prepare("UPDATE outbound_ledger SET status='OUTCOME_UNKNOWN' WHERE ledger_id=?").run(p.ledgerId)
    expect(reconcileOutbound(db).map(w => w.ledger_id)).toContain(p.ledgerId)
  })

  it('GUARD 2: executeAction refuses to start a first send with no declared decision', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    const r = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 1)
    expect(r.status).toBe('PLANNED') // still planned, not sent
    expect(t.sent.size).toBe(0) // and provably nothing left the process
    const row = db.prepare('SELECT last_error FROM outbound_ledger WHERE ledger_id=?')
      .get(p.ledgerId) as { last_error: string | null }
    // §22.2: the refusal reason changed with the model — a missing ticket, not a
    // missing boolean. The property under test (refused, nothing sent) is the same.
    expect(row.last_error ?? '').toContain('no authorization ticket supplied')
  })

  it('GUARD 2: with the decision declared, the same send goes through', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    const r = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 1, authorized(db, p.ledgerId, T0))
    expect(r.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
  })

  it('recovery of an already-started row does NOT need the declaration', async () => {
    // The decision that authorized this row was made before it left PLANNED.
    // Requiring it again here would break recovery, which is the opposite of
    // the goal.
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    t.reachThenThrow = true
    await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 1, authorized(db, p.ledgerId, T0))
    const stuck = db.prepare('SELECT status FROM outbound_ledger WHERE ledger_id=?').get(p.ledgerId) as { status: string }
    expect(stuck.status).toBe('OUTCOME_UNKNOWN')
    t.reachThenThrow = false
    const recovered = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 2) // no opts
    expect(recovered.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1) // recovered by readback, not by a second delivery
  })
})
