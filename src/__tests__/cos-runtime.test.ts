import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { planAction } from '../cos/executor.js'
import { createRadarItem } from '../cos/radar.js'
import { runCosTickOnce, safeCosDeps, registerCosConnectors } from '../cos/runtime.js'
import { getHealth, setMode } from '../cos/connector-health.js'
import type { RentalAdapter, RentalOffer, RentalSearchParams } from '../cos/rental-adapter.js'

// COS autonomous runtime. Proves the SAFETY posture: safeCosDeps wires no
// outbound adapter (so a planned send is skipped, never sent), and a due radar
// item IS checked.

const NOW = 3_000_000

class MockRental implements RentalAdapter {
  readonly id = 'discovercars'; readonly displayName = 'DiscoverCars'
  called = 0
  async search(_p: RentalSearchParams): Promise<RentalOffer[]> {
    this.called++
    return [{ car: 'i30', category: 'Compact', transmission: 'Manual', seats: 5, bags: 2, supplier: 'Centauro', supplierKey: 'centauro', rating: 8.6, pickupType: 'shuttle', pickupPlace: 'VLC', basePrice: 70000, currency: 'HUF', coveragePrice: 16000, fullPrice: 86000, deposit: 'Average deposit', depositValue: 'x', zeroExcessBadge: false, zeroDepositBadge: false, mileage: 'Unlimited', bookUrl: '/b' }]
  }
}
const QUERY = { search: { pickup: { countryId: 26, cityId: 462, placeId: 462, label: 'VLC' }, dropoff: { countryId: 26, cityId: 455, placeId: 1848, label: 'AGP' }, pickupFrom: '2026-08-18 10:00', pickupTo: '2026-08-23 08:00', residenceCountry: 'HU' }, categoryPattern: 'compact' }

describe('COS autonomous runtime', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createCase(getDb(), { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW)
  })

  it('runs a due radar check but NEVER sends (no outbound adapter in safe deps)', async () => {
    const db = getDb()
    // a PLANNED outbound row + a due radar item
    const p = planAction(db, { caseId: 'c1', actionType: 'EMAIL_SEND', sequenceNumber: 1, payload: { to: 'a@b.c', subject: 's' } }, NOW)
    createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'x', query: QUERY, targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW - 7200)
    const rental = new MockRental()

    const res = await runCosTickOnce(db, { rentalAdapter: rental }, NOW)

    expect(res.radarChecked).toBe(1)         // radar ran
    expect(rental.called).toBe(1)
    expect(res.outboundProcessed).toBe(0)    // the planned email was NOT sent
    // CHANGED 2026-08-10 (F-7). This asserted `outboundSkippedNoAdapter === 1`,
    // which recorded WHY nothing was sent: the tick reached the row and stopped
    // only because no adapter was registered. That was the whole danger — one
    // adapter registration away from an unapproved send. The tick is no longer
    // offered PLANNED rows at all, so the counter is 0 and the safety no longer
    // depends on a missing dependency. The test's title ("NEVER sends") is now
    // true for a structural reason instead of an accidental one.
    expect(res.outboundSkippedNoAdapter).toBe(0)
    // the outbound row is still PLANNED (untouched) — proof nothing was sent
    expect((db.prepare(`SELECT status FROM outbound_ledger WHERE ledger_id=?`).get(p.ledgerId) as any).status).toBe('PLANNED')
  })

  it('safeCosDeps wires the rental adapter and NO outbound adapter', () => {
    const deps = safeCosDeps()
    expect(deps.rentalAdapter).toBeTruthy()
    expect(deps.outboundAdapters).toBeUndefined() // no send capability
  })

  it('registerCosConnectors registers gmail READ_ONLY (send inert) + rental, idempotently', () => {
    const db = getDb()
    registerCosConnectors(db, NOW)
    expect(getHealth(db, 'gmail')?.mode).toBe('READ_ONLY') // send stays inert by default
    expect(getHealth(db, 'rental')?.mode).toBe('READ_ONLY')
    expect(getHealth(db, 'rental')?.status).toBe('OK')
    // a later READ_WRITE flip is NOT clobbered by re-registration (ON CONFLICT DO NOTHING)
    setMode(db, 'gmail', 'READ_WRITE', NOW + 1)
    registerCosConnectors(db, NOW + 2)
    expect(getHealth(db, 'gmail')?.mode).toBe('READ_WRITE')
  })
})
