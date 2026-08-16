import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { issueAuthorization } from '../cos/action-authorization.js'
import { mintGatePermit } from '../cos/gate-permit.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { planAction, executeAction } from '../cos/executor.js'
import { GmailSendAdapter, DryRunTransport } from '../cos/adapters/gmail-send.js'
import { createRadarItem, getRadarItem } from '../cos/radar.js'
import { setNextWake } from '../cos/scheduler.js'
import { cosTick } from '../cos/tick.js'
import { deliverRadarNotifications } from '../cos/runtime.js'
import type { RentalAdapter, RentalOffer, RentalSearchParams } from '../cos/rental-adapter.js'

// §22.2: a first send needs a gate-issued ticket, not a caller-side boolean.
// These tests issue one exactly as production does.
function authorized(db: Parameters<typeof issueAuthorization>[0], ledgerId: string, now: number) {
  const ctx = {
    domain: 'personal' as const, caseId: null, caseVersion: null, goalVersion: null,
    actionId: ledgerId, actionType: 'EMAIL_SEND', intent: 'TEST', targetReference: null,
    recipient: null, payloadHash: null, approvalId: null,
  }
  return { authorizationId: issueAuthorization(db, ctx, now, {}, mintGatePermit({ allowed: true, reasons: [] })).authorizationId, authorizationContext: ctx }
}


// COS tick — one cycle end to end: a planned email gets sent+verified, a due
// rental radar check records an observation and hits its target, and due
// cases/follow-ups are surfaced. Uses mock adapters (no network).

const NOW = 2_000_000

function offer(full: number): RentalOffer {
  return {
    car: 'Hyundai i30', category: 'Compact', transmission: 'Manual', seats: 5, bags: 2, supplier: 'Centauro',
    supplierKey: 'centauro', rating: 8.6, pickupType: 'Free shuttle service', pickupPlace: 'VLC',
    basePrice: full - 16000, currency: 'HUF', coveragePrice: 16000, fullPrice: full, deposit: 'Average deposit',
    depositValue: 'HUF 541,325', zeroExcessBadge: false, zeroDepositBadge: false, mileage: 'Unlimited', bookUrl: '/b',
  }
}
class MockRental implements RentalAdapter {
  readonly id = 'discovercars'; readonly displayName = 'DiscoverCars'
  async search(_p: RentalSearchParams): Promise<RentalOffer[]> { return [offer(84000)] }
}
const RENTAL_QUERY = {
  search: { pickup: { countryId: 26, cityId: 462, placeId: 462, label: 'VLC' }, dropoff: { countryId: 26, cityId: 455, placeId: 1848, label: 'AGP' }, pickupFrom: '2026-08-18 10:00', pickupTo: '2026-08-23 08:00', residenceCountry: 'HU' },
  categoryPattern: 'compact',
}

describe('cosTick (one full cycle)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW)
  })

  // CHANGED 2026-08-10 (F-7). This used to plan an email and assert the tick
  // SENT it (outboundProcessed === 1). That was the defect stated as a
  // requirement: cosTick evaluates no dispatch gate, so a first delivery decided
  // here is a delivery nobody approved. The row now starts mid-flight
  // (OUTCOME_UNKNOWN) so the test still proves the tick drives outbound work —
  // recovery, which is the work it is allowed to do.
  it('recovers an in-flight email, runs a due radar check that hits, and surfaces due work', async () => {
    const db = getDb()
    // An outbound email that already left PLANNED under a decision, reached the
    // provider, and then threw — the real OUTCOME_UNKNOWN. The same transport is
    // handed to the tick so its readback can find the delivered message; a fresh
    // transport would have nothing to read back and the test would be proving
    // the wrong thing.
    const transport = new DryRunTransport()
    const p = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'v@x.com', subject: 'Quote' } }, NOW)
    transport.reachThenThrow = true
    await executeAction(db, new GmailSendAdapter(transport), p.ledgerId, NOW, authorized(db, p.ledgerId, NOW))
    transport.reachThenThrow = false
    expect((db.prepare('SELECT status FROM outbound_ledger WHERE ledger_id=?').get(p.ledgerId) as any).status).toBe('OUTCOME_UNKNOWN')
    // a due RENTAL radar item with a reachable target
    createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', query: RENTAL_QUERY, targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW - 7200) // next_check in the past → due
    // a due case wake + a due follow-up
    setNextWake(db, 'c1', NOW - 10, NOW)
    transitionCase(db, { caseId: 'c1', seenVersion: 1, newStatus: 'WAITING_EXTERNAL', actor: 'm', patch: { follow_up_at: NOW - 5 } }, NOW)

    const res = await cosTick(db, {
      outboundAdapters: { EMAIL_SEND: new GmailSendAdapter(transport) },
      rentalAdapter: new MockRental(),
    }, NOW)

    expect(res.outboundProcessed).toBe(1)
    expect(res.errors).toEqual([])
    expect(res.radarChecked).toBe(1)
    expect(res.radarHits).toEqual(['r1'])
    // The ROWS, not a count: a tick that reports "1" cannot be acted on, and
    // for months nothing did. See CosTickResult.dueCases.
    expect(res.dueCases.map((c) => c.case_id)).toEqual(['c1'])
    expect(res.dueFollowUps.map((c) => c.case_id)).toEqual(['c1'])
    // effects landed
    const ledger = db.prepare(`SELECT status FROM outbound_ledger WHERE ledger_id=?`).get(p.ledgerId) as any
    expect(ledger.status).toBe('VERIFIED')
    expect(getRadarItem(db, 'r1')!.status).toBe('HIT')
  })

  // CHANGED 2026-08-13 (P1). The tick no longer persists the notify decision —
  // it hands it out and the caller marks it only after the alert has actually
  // been posted (runtime.deliverRadarNotifications), because marking first meant
  // a crash in between silenced the hit for good. The dedup this test is about is
  // unchanged; the test now performs the delivery step the runtime performs.
  it('AC-29: a second cycle on the same unchanged HIT offer does NOT re-alert', async () => {
    const db = getDb()
    createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', query: RENTAL_QUERY, targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW - 7200)
    const deps = { rentalAdapter: new MockRental() }
    const first = await cosTick(db, deps, NOW)
    expect(first.radarHits).toEqual(['r1']) // first HIT → alert
    deliverRadarNotifications(db, first, NOW)
    // make it due again without changing the offer, run another cycle
    db.prepare(`UPDATE radar_items SET next_check_at=? WHERE radar_id='r1'`).run(NOW + 10)
    const second = await cosTick(db, deps, NOW + 20)
    expect(second.radarChecked).toBe(1)
    expect(second.radarHits).toEqual([]) // <-- deduped: same offer, no repeat alert
    expect(getRadarItem(db, 'r1')!.status).toBe('HIT') // still a hit, just not re-announced
  })

  it('surfaces RECOVERY_REQUIRED outbound rows for a human (never auto-driven)', async () => {
    const db = getDb()
    const p = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 9, payload: {} }, NOW)
    db.prepare(`UPDATE outbound_ledger SET status='RECOVERY_REQUIRED' WHERE ledger_id=?`).run(p.ledgerId)
    const res = await cosTick(db, { outboundAdapters: { EMAIL_SEND: new GmailSendAdapter(new DryRunTransport()) } }, NOW)
    expect(res.recoveryRequired).toEqual([p.ledgerId])
    // it is NOT auto-driven: the reconcile loop excludes RECOVERY_REQUIRED
    expect(res.outboundProcessed).toBe(0)
    // and it stays put
    expect((db.prepare(`SELECT status FROM outbound_ledger WHERE ledger_id=?`).get(p.ledgerId) as any).status).toBe('RECOVERY_REQUIRED')
  })

  // CHANGED 2026-08-10 (F-7). The row used to be left PLANNED, so the counter it
  // asserted was really measuring "the tick reached a never-sent row". It now
  // starts mid-flight, which is the only kind of row the tick is offered, and
  // the no-adapter skip is still what the test is about.
  it('skips outbound rows with no registered adapter, and does not throw', async () => {
    const db = getDb()
    const p = planAction(db, { caseId: 'c1', actionType: 'CALENDAR_CREATE', sequenceNumber: 1, payload: {} }, NOW)
    db.prepare("UPDATE outbound_ledger SET status='OUTCOME_UNKNOWN' WHERE ledger_id=?").run(p.ledgerId)
    const res = await cosTick(db, { outboundAdapters: {} }, NOW) // no CALENDAR_CREATE adapter
    expect(res.outboundProcessed).toBe(0)
    expect(res.outboundSkippedNoAdapter).toBe(1)
    expect(res.errors).toEqual([])
  })
})
