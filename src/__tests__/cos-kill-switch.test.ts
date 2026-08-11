// §22 kill switch (card 89b2ab52, P0). The mechanism existed and had no way to
// be operated: `pauseAll` set a flag every permits() decision reads, and nothing
// ever called it. cos_autonomy_global had ZERO rows — the flag had never once
// been set in the system's life. The card's sentence: if Istvan says "stop
// everything now", there is no button.
//
// The DoD the card asks for is behavioural: after the switch is engaged, a
// permits() call demonstrably refuses. These tests go further, because refusing
// NEW authority is the easy half — the hard half is authority already granted.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { setLadder, permits } from '../cos/autonomy-ladder.js'
import { planAction, executeAction } from '../cos/executor.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'
import { issueAuthorization } from '../cos/action-authorization.js'
import { engageKillSwitch, releaseKillSwitch, killSwitchState, killSwitchRefusal } from '../cos/kill-switch.js'

const T0 = 1_700_000_000
const PLAN = { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'v@x.com', subject: 'S', body: 'B' } }

function ticket(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {
  const ctx = {
    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,
    actionId: ledgerId, actionType: 'EMAIL_SEND', intent: 'TEST', targetReference: null,
    recipient: null, payloadHash: null, approvalId: null,
  }
  return { authorizationId: issueAuthorization(db, ctx, now).authorizationId, authorizationContext: ctx }
}

describe('§22 kill switch', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'T', caseType: 'QUOTE' }, T0)
    setLadder(getDb(), 'QUOTE', { rung: 'EXECUTE_WITH_APPROVAL' }, T0 - 1000)
  })

  it('THE CARD DoD: after engaging, a permits() call refuses', () => {
    const db = getDb()
    expect(permits(db, 'QUOTE', 'SEND').allowed).toBe(true) // control: it allowed before
    engageKillSwitch(db, { reason: 'Istvan azt mondta: allj le', actor: 'istvan' }, T0)
    const after = permits(db, 'QUOTE', 'SEND')
    expect(after.allowed).toBe(false)
    expect(after.code).toBe('paused')
  })

  it('engaging revokes authority ALREADY granted, not just future grants', async () => {
    // The half that matters. A stop that only refuses new tickets still lets the
    // next few seconds of already-authorised sends through, and those are the
    // seconds someone is trying to prevent (§22.2: withdrawn authority blocks).
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    const auth = ticket(db, p.ledgerId, T0)      // authorised BEFORE the stop
    engageKillSwitch(db, { reason: 'stop', actor: 'istvan' }, T0 + 1)
    const r = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 2, auth)
    expect(r.status).toBe('PLANNED')
    expect(t.sent.size).toBe(0)
  })

  it('a send attempted while engaged is refused at the executor, with the reason on the row', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    engageKillSwitch(db, { reason: 'gyanús kimenő forgalom', actor: 'istvan' }, T0)
    const p = planAction(db, PLAN, T0 + 1)
    await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 2, ticket(db, p.ledgerId, T0 + 2))
    expect(t.sent.size).toBe(0)
    const row = db.prepare('SELECT last_error FROM outbound_ledger WHERE ledger_id=?').get(p.ledgerId) as { last_error: string }
    expect(row.last_error).toContain('kill switch engaged')
    expect(row.last_error).toContain('gyanús kimenő forgalom') // the reason survives to the row
  })

  it('recovery of an in-flight row is NOT frozen', async () => {
    // Deliberate: readback sends nothing. Freezing it would leave a stopped
    // system full of rows nobody can ever settle — a worse place to be stuck.
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    t.reachThenThrow = true
    await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 1, ticket(db, p.ledgerId, T0 + 1))
    expect(String((db.prepare('SELECT status FROM outbound_ledger WHERE ledger_id=?').get(p.ledgerId) as never as { status: string }).status)).toBe('OUTCOME_UNKNOWN')
    t.reachThenThrow = false
    engageKillSwitch(db, { reason: 'stop', actor: 'istvan' }, T0 + 2)
    const rec = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 3)
    expect(rec.status).toBe('VERIFIED') // resolved by readback, no second delivery
    expect(t.sent.size).toBe(1)
  })

  it('the stop is auditable: who, why, and how many tickets it killed', () => {
    const db = getDb()
    const p = planAction(db, PLAN, T0)
    ticket(db, p.ledgerId, T0)
    const r = engageKillSwitch(db, { reason: 'teszt', actor: 'istvan' }, T0 + 1)
    expect(r.ticketsRevoked).toBe(1)
    const ev = db.prepare('SELECT * FROM cos_kill_switch_events ORDER BY event_id DESC LIMIT 1').get() as Record<string, unknown>
    expect(ev.actor).toBe('istvan')
    expect(ev.reason).toBe('teszt')
    expect(ev.tickets_revoked).toBe(1)
  })

  it('release restores operation but does NOT resurrect the revoked tickets', async () => {
    const db = getDb()
    const t = new DryRunTransport()
    const p = planAction(db, PLAN, T0)
    const auth = ticket(db, p.ledgerId, T0)
    engageKillSwitch(db, { reason: 'stop', actor: 'istvan' }, T0 + 1)
    releaseKillSwitch(db, { actor: 'istvan', reason: 'megnéztem, rendben' }, T0 + 2)
    expect(killSwitchState(db).engaged).toBe(false)
    expect(killSwitchRefusal(db)).toBeNull()

    // the OLD ticket stays dead: what was in flight goes back through the gate
    const r = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 3, auth)
    expect(t.sent.size).toBe(0)
    // a FRESH one works again — proof the release really restored operation
    const r2 = await executeAction(db, new GmailSendAdapter(t), p.ledgerId, T0 + 4, ticket(db, p.ledgerId, T0 + 4))
    expect(r2.status).toBe('VERIFIED')
    expect(t.sent.size).toBe(1)
  })
})
