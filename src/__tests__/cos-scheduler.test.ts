import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { planAction, executeAction } from '../cos/executor.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'
import { openBatch, quarantineMessage } from '../cos/email-ingest.js'
import { dueCases, dueFollowUps, setNextWake, reconcileOutbound, openEmailBatches } from '../cos/scheduler.js'

// COS scheduler query layer — the "what needs doing now" surface the heartbeat
// drives each tick.

const NOW = 1_000_000

describe('COS scheduler queries', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('dueCases returns only active cases whose wake time has arrived', () => {
    const db = getDb()
    createCase(db, { caseId: 'past', title: 'P', caseType: 'X' }, NOW)
    createCase(db, { caseId: 'future', title: 'F', caseType: 'X' }, NOW)
    createCase(db, { caseId: 'none', title: 'N', caseType: 'X' }, NOW)
    createCase(db, { caseId: 'done', title: 'D', caseType: 'X' }, NOW)
    setNextWake(db, 'past', NOW - 10, NOW)
    setNextWake(db, 'future', NOW + 10_000, NOW)
    transitionCase(db, { caseId: 'done', seenVersion: 1, newStatus: 'COMPLETED', actor: 'm' }, NOW)
    setNextWake(db, 'done', NOW - 10, NOW) // due-timed but terminal → excluded

    const ids = dueCases(db, NOW).map((c) => c.case_id)
    expect(ids).toEqual(['past']) // future not yet, none has no wake, done is terminal
  })

  it('dueFollowUps returns active cases with a due follow_up_at', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'A', caseType: 'X' }, NOW)
    transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'm', patch: { follow_up_at: NOW - 5 } }, NOW)
    createCase(db, { caseId: 'c2', title: 'B', caseType: 'X' }, NOW)
    transitionCase(db, { caseId: 'c2', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'm', patch: { follow_up_at: NOW + 5000 } }, NOW)
    expect(dueFollowUps(db, NOW).map((c) => c.case_id)).toEqual(['c1'])
  })

  // CHANGED 2026-08-10 (F-7). This asserted `['PLANNED']` — i.e. it asserted the
  // defect: reconcileOutbound handing a never-sent row to a background loop that
  // evaluates no dispatch gate. reconcileOutbound is a RECOVERY queue now, so a
  // PLANNED row must not appear in it. The property the test cared about (a
  // VERIFIED row is not returned) is still asserted, alongside the new one.
  it('reconcileOutbound returns rows needing recovery — never a PLANNED first send, never VERIFIED', async () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW)
    const done = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'a@b.c', subject: 's' } }, NOW)
    await executeAction(db, new GmailSendAdapter(new DryRunTransport()), done.ledgerId, NOW, { authorizedByDispatchGate: true }) // → VERIFIED
    const planned = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 2, payload: { to: 'x@y.z', subject: 's2' } }, NOW)

    expect(reconcileOutbound(db)).toEqual([]) // neither the VERIFIED one nor the PLANNED one

    // CONTROL: the same row, once it is genuinely mid-flight, IS offered — so
    // the assertion above cannot be satisfied by returning nothing ever.
    db.prepare("UPDATE outbound_ledger SET status='OUTCOME_UNKNOWN' WHERE ledger_id=?").run(planned.ledgerId)
    expect(reconcileOutbound(db).map((w) => w.status)).toEqual(['OUTCOME_UNKNOWN'])
  })

  it('openEmailBatches returns OPEN/PROCESSING batches, not TERMINAL', () => {
    const db = getDb()
    openBatch(db, { batchId: 'b1', accountId: 'acc', cursorBefore: '1', cursorAfter: '2', messages: [{ messageId: 'm1' }] }, NOW)
    // b1 stays OPEN (m1 in flight). A terminal batch:
    openBatch(db, { batchId: 'b2', accountId: 'acc', cursorBefore: '2', cursorAfter: '3', messages: [{ messageId: 'm2' }] }, NOW)
    quarantineMessage(db, 'acc', 'm2', 'poison', NOW)
    db.prepare(`UPDATE email_processing_batches SET status='TERMINAL' WHERE batch_id='b2'`).run()
    expect(openEmailBatches(db).map((b) => b.batch_id)).toEqual(['b1'])
  })
})
