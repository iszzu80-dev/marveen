import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { dueZstItems, seedZstProducts } from '../cos/zst-watch.js'

// dueZstItems uses SQLite date('now') (real clock), so test dates are computed
// relative to real now.
function isoInDays(days: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const NOW = 1_700_000_000

describe('ZST proactive due-item runner', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('flags a contract inside its renewal notice window, not one far out', () => {
    const db = getDb()
    db.prepare(`INSERT INTO zst_contracts (contract_id,title,status,expiry_date,notice_period_days,created_at,updated_at)
      VALUES ('c-soon','Cloud hosting','ACTIVE',@exp,30,@n,@n)`).run({ exp: isoInDays(20), n: NOW }) // expiry-30d = -10d ≤ horizon
    db.prepare(`INSERT INTO zst_contracts (contract_id,title,status,expiry_date,notice_period_days,created_at,updated_at)
      VALUES ('c-far','Long deal','ACTIVE',@exp,30,@n,@n)`).run({ exp: isoInDays(200), n: NOW })
    const due = dueZstItems(db, 45)
    const ids = due.contracts.map(c => c.contract_id)
    expect(ids).toContain('c-soon')
    expect(ids).not.toContain('c-far')
    expect(due.contracts.find(c => c.contract_id === 'c-soon')!.reason).toBe('RENEWAL_DUE')
  })

  it('flags licenses by 30/60/90-day renewal window', () => {
    const db = getDb()
    db.prepare(`INSERT INTO zst_licenses (license_id,product_name,renewal_date,auto_renew,created_at,updated_at) VALUES ('l1','LinkedIn',@d,1,@n,@n)`).run({ d: isoInDays(25), n: NOW })
    db.prepare(`INSERT INTO zst_licenses (license_id,product_name,renewal_date,auto_renew,created_at,updated_at) VALUES ('l2','VOIZ',@d,0,@n,@n)`).run({ d: isoInDays(120), n: NOW }) // beyond 90d
    const due = dueZstItems(db)
    expect(due.licenses.map(l => l.license_id)).toEqual(['l1'])
    expect(due.licenses[0].window).toBe('30d')
  })

  it('flags open obligations coming due and decision-stage opportunities', () => {
    const db = getDb()
    db.prepare(`INSERT INTO zst_obligations (obligation_id,contract_id,description,due_date,status,created_at) VALUES ('o1',NULL,'Report',@d,'OPEN',@n)`).run({ d: isoInDays(10), n: NOW })
    db.prepare(`INSERT INTO zst_obligations (obligation_id,contract_id,description,due_date,status,created_at) VALUES ('o2',NULL,'Done',@d,'CLOSED',@n)`).run({ d: isoInDays(5), n: NOW })
    db.prepare(`INSERT INTO zst_opportunities (opportunity_id,title,status,created_at,updated_at) VALUES ('op1','Pilot X','OFFER_REQUIRED',@n,@n)`).run({ n: NOW })
    db.prepare(`INSERT INTO zst_opportunities (opportunity_id,title,status,created_at,updated_at) VALUES ('op2','Won deal','WON',@n,@n)`).run({ n: NOW })
    const due = dueZstItems(db)
    expect(due.obligations.map(o => o.obligation_id)).toEqual(['o1'])
    expect(due.opportunities.map(o => o.opportunity_id)).toEqual(['op1'])
    expect(due.totals).toMatchObject({ obligations: 1, opportunities: 1 })
  })

  it('seeds the mandatory products idempotently', () => {
    const db = getDb()
    expect(seedZstProducts(db, NOW)).toBe(5)
    expect(seedZstProducts(db, NOW)).toBe(0) // idempotent
    expect((db.prepare(`SELECT COUNT(*) n FROM zst_products`).get() as any).n).toBe(5)
  })
})
