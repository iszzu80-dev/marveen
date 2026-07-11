import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { deriveMtdSpend, parseDeepSeekBalanceUsd, syncDeepSeekBalance, forecastDeepSeekExhaustion } from '../costops/collectors/deepseek.js'

describe('deriveMtdSpend (pure)', () => {
  it('sums balance drops, ignoring top-ups (rises)', () => {
    // 10 -> 8 (drop 2) -> 12 (top-up, ignore) -> 9 (drop 3) => spend 5
    const snaps = [10, 8, 12, 9].map((b, i) => ({ balance: b, captured_at: i }))
    expect(deriveMtdSpend(snaps)).toBe(5)
  })
  it('is 0 for a single snapshot (baseline)', () => {
    expect(deriveMtdSpend([{ balance: 4.55, captured_at: 1 }])).toBe(0)
    expect(deriveMtdSpend([])).toBe(0)
  })
})

describe('forecastDeepSeekExhaustion (pure)', () => {
  const DAY = 86400

  it('returns null with fewer than 2 snapshots', () => {
    expect(forecastDeepSeekExhaustion([], 1000)).toBeNull()
    expect(forecastDeepSeekExhaustion([{ balance: 5, captured_at: 1000 }], 1000)).toBeNull()
  })

  it('returns null when the history spans less than a day (too noisy to extrapolate)', () => {
    const snaps = [{ balance: 10, captured_at: 0 }, { balance: 8, captured_at: 3600 }] // 1 hour apart
    expect(forecastDeepSeekExhaustion(snaps, 3600)).toBeNull()
  })

  it('returns null when there is no net spend (flat or rising balance -- nothing to run out)', () => {
    const flat = [{ balance: 10, captured_at: 0 }, { balance: 10, captured_at: 10 * DAY }]
    expect(forecastDeepSeekExhaustion(flat, 10 * DAY)).toBeNull()
    const rising = [{ balance: 10, captured_at: 0 }, { balance: 15, captured_at: 10 * DAY }] // top-up only
    expect(forecastDeepSeekExhaustion(rising, 10 * DAY)).toBeNull()
  })

  it('extrapolates a steady daily burn rate to a future exhaustion timestamp', () => {
    // 10 -> 5 over 10 days = 0.5 USD/day burn. Balance now 5 -> 10 more days to zero.
    const snaps = [{ balance: 10, captured_at: 0 }, { balance: 5, captured_at: 10 * DAY }]
    const now = 10 * DAY
    const result = forecastDeepSeekExhaustion(snaps, now)
    expect(result).toBe(now + 10 * DAY)
  })

  it('ignores top-ups when computing the burn rate (same drop-summing rule as deriveMtdSpend)', () => {
    // 10 -> 8 (drop 2) -> 20 (top-up, ignored) -> 18 (drop 2) over 4 days => 4 USD spend / 4 days = 1/day
    // balance now 18 -> 18 more days to zero
    const snaps = [
      { balance: 10, captured_at: 0 },
      { balance: 8, captured_at: DAY },
      { balance: 20, captured_at: 2 * DAY },
      { balance: 18, captured_at: 4 * DAY },
    ]
    const now = 4 * DAY
    expect(forecastDeepSeekExhaustion(snaps, now)).toBe(now + 18 * DAY)
  })
})

describe('parseDeepSeekBalanceUsd', () => {
  it('reads the USD total_balance from the /user/balance shape', () => {
    expect(parseDeepSeekBalanceUsd({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.55' }] })).toBe(4.55)
    expect(parseDeepSeekBalanceUsd({ balance_infos: [{ currency: 'CNY', total_balance: '30' }] })).toBe(30) // falls back to first
    expect(parseDeepSeekBalanceUsd(null)).toBe(0)
  })
})

describe('syncDeepSeekBalance (offline stub)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('records a snapshot + baseline line on first sync, then MTD spend on a later drop', async () => {
    const db = getDb()
    const t0 = Math.floor(Date.UTC(2026, 6, 5) / 1000)
    const bal = (v: string) => async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: v }] })
    // first sync: balance 5.00 -> baseline, spend 0
    const r1 = await syncDeepSeekBalance(db, t0, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('5.00') })
    expect(r1.ok).toBe(true)
    expect(r1.balance_usd).toBe(5)
    expect(r1.mtd_spend_usd).toBe(0)
    const line0 = db.prepare("SELECT billed_cost, confidence FROM cost_line_items WHERE source_id='deepseek-api'").get() as { billed_cost: number; confidence: string }
    expect(line0.billed_cost).toBe(0)
    expect(line0.confidence).toBe('provider_api')

    // second sync later same month: balance dropped to 3.20 -> spend 1.80 usd -> 648 HUF
    const r2 = await syncDeepSeekBalance(db, t0 + 86400, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('3.20') })
    expect(r2.mtd_spend_usd).toBeCloseTo(1.8, 4)
    const line1 = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='deepseek-api'").get() as { billed_cost: number }
    expect(line1.billed_cost).toBeCloseTo(1.8 * 360, 2) // idempotent upsert, single line
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='deepseek-api'").get() as { c: number }).c).toBe(1)
    // secret never in audit rows
    expect(JSON.stringify(db.prepare('SELECT * FROM import_runs').all())).not.toContain('"k"')
  })

  it('errors (no line) when the vault key is missing', async () => {
    const db = getDb()
    const r = await syncDeepSeekBalance(db, Math.floor(Date.now() / 1000), { apiKey: null, fxUsdHuf: 360, httpGetJson: async () => ({}) })
    expect(r.ok).toBe(false)
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='deepseek-api'").get() as { c: number }).c).toBe(0)
  })

  // Card ef6c6a2c (spec section 4): prepaid balance is also a distinct entitlements row,
  // separate from the derived cost_line_items spend above.
  it('upserts a single entitlements row per sync, remaining tracks the live balance, status derives from absolute thresholds', async () => {
    const db = getDb()
    const t0 = Math.floor(Date.UTC(2026, 6, 5) / 1000)
    const bal = (v: string) => async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: v }] })

    await syncDeepSeekBalance(db, t0, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('5.00') })
    let row = db.prepare("SELECT * FROM entitlements WHERE dedup_key='deepseek|prepaid_balance'").get() as any
    expect(row.remaining).toBe(5)
    expect(row.status).toBe('ok')
    expect(row.provider).toBe('deepseek')
    expect(row.included_limit).toBeNull()
    expect(row.reset_at).toBeNull()

    // balance drops into the warning band -- same row updates, no duplicate
    await syncDeepSeekBalance(db, t0 + 86400, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('2.50') })
    row = db.prepare("SELECT * FROM entitlements WHERE dedup_key='deepseek|prepaid_balance'").get() as any
    expect(row.remaining).toBe(2.5)
    expect(row.status).toBe('warning')
    expect((db.prepare("SELECT COUNT(*) c FROM entitlements WHERE provider='deepseek'").get() as { c: number }).c).toBe(1)

    // critical band
    await syncDeepSeekBalance(db, t0 + 2 * 86400, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('0.50') })
    row = db.prepare("SELECT * FROM entitlements WHERE dedup_key='deepseek|prepaid_balance'").get() as any
    expect(row.status).toBe('critical')
  })

  it('does not touch entitlements when the sync itself fails (no key)', async () => {
    const db = getDb()
    await syncDeepSeekBalance(db, Math.floor(Date.now() / 1000), { apiKey: null, fxUsdHuf: 360, httpGetJson: async () => ({}) })
    expect((db.prepare("SELECT COUNT(*) c FROM entitlements WHERE provider='deepseek'").get() as { c: number }).c).toBe(0)
  })

  it('populates forecast_exhaustion_at once there is enough history, null on the first (baseline-only) sync', async () => {
    const db = getDb()
    const t0 = Math.floor(Date.UTC(2026, 6, 1) / 1000)
    const bal = (v: string) => async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: v }] })

    // first sync ever: single snapshot, no rate can be derived yet
    await syncDeepSeekBalance(db, t0, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('10.00') })
    let row = db.prepare("SELECT forecast_exhaustion_at FROM entitlements WHERE dedup_key='deepseek|prepaid_balance'").get() as any
    expect(row.forecast_exhaustion_at).toBeNull()

    // 10 days later, balance dropped 10 -> 5 (steady 0.5/day burn over real history)
    const t1 = t0 + 10 * 86400
    await syncDeepSeekBalance(db, t1, { apiKey: 'k', fxUsdHuf: 360, httpGetJson: bal('5.00') })
    row = db.prepare("SELECT forecast_exhaustion_at FROM entitlements WHERE dedup_key='deepseek|prepaid_balance'").get() as any
    expect(row.forecast_exhaustion_at).toBe(t1 + 10 * 86400) // 5 USD remaining / 0.5 per day = 10 more days
  })
})
