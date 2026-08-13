import { describe, it, expect } from 'vitest'
import { fromSubscriptions, fromDeepSeekBalance, fromCodexRateLimit, LIMIT_SNAPSHOT_STALE_AFTER_SECONDS } from '../costops/limits.js'
import { deriveLifecycle, type SubscriptionsConfig } from '../costops/subscriptions.js'
import { initDatabase, getDb } from '../db.js'

// Card 2ed90db1: wiring real Claude Max/Pro weekly-limit % data into the subscription gauge.
const NOW = Math.floor(Date.UTC(2026, 6, 8, 19, 0, 0) / 1000) // 2026-07-08 21:00 CEST

function cfg(subs: Partial<SubscriptionsConfig['subscriptions'][number]>[]): SubscriptionsConfig {
  return { version: 1, subscriptions: subs.map(s => ({ id: 'x', name: 'X', provider: 'p', source: 's', status: 'active', amount_source: 'no_invoice_found', ...s })) as SubscriptionsConfig['subscriptions'] }
}

describe('costops limits: weekly usage-% snapshot (card 2ed90db1)', () => {
  it('emits a weekly_usage_pct entry from a usage_snapshot, percent converted to a 0..1 fraction', () => {
    const lc = deriveLifecycle(cfg([{
      id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', status: 'active', next_renewal: '2026-07-20',
      usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 5, weekly_pct: 19, weekly_reset_label: 'Tue 08:59', fable_pct: 0 },
    }]), NOW)
    const limits = fromSubscriptions(lc)
    const weekly = limits.find(l => l.limit_type === 'weekly_usage_pct')
    expect(weekly).toBeDefined()
    expect(weekly!.usage_pct).toBeCloseTo(0.19)
    expect(weekly!.status).toBe('ok') // below the 0.7 warning tier
    expect(weekly!.reset_date).toBe('Tue 08:59') // raw label, never a computed/parsed date
    expect(weekly!.sub_id).toBe('anthropic-max')
    expect(weekly!.current_usage).toBeNull() // no fabricated absolute ceiling
    expect(weekly!.limit_value).toBeNull()
  })

  it('a usage_snapshot with no renewal/cancellation date still emits its weekly_usage_pct entry (no early-continue bug)', () => {
    // Regression: fromSubscriptions used to `continue` the whole loop iteration when a
    // subscription had no paid_until/next_renewal, silently skipping the usage_snapshot entry
    // too. Claude Pro after re-activation is exactly this case (status active, no known next
    // renewal date, but a real usage_snapshot).
    const lc = deriveLifecycle(cfg([{
      id: 'claude-pro-google-play', name: 'Claude Pro', provider: 'anthropic', status: 'active',
      usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 16, weekly_pct: 2, weekly_reset_label: 'Wed 06:00', fable_pct: 0 },
    }]), NOW)
    const limits = fromSubscriptions(lc)
    expect(limits.some(l => l.limit_type === 'subscription_renewal')).toBe(false) // honestly no renewal-date entry
    const weekly = limits.find(l => l.limit_type === 'weekly_usage_pct')
    expect(weekly).toBeDefined()
    expect(weekly!.usage_pct).toBeCloseTo(0.02)
    expect(weekly!.sub_id).toBe('claude-pro-google-play')
  })

  it('crossing 80% weekly usage escalates status to high-tier (critical stays below 90, blocked at 100)', () => {
    const lc = deriveLifecycle(cfg([{
      id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', status: 'active',
      usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 50, weekly_pct: 85, weekly_reset_label: 'Tue 08:59' },
    }]), NOW)
    const weekly = fromSubscriptions(lc).find(l => l.limit_type === 'weekly_usage_pct')!
    expect(weekly.usage_pct).toBeCloseTo(0.85)
    expect(weekly.status).toBe('warning') // limits.ts's own tierForPct ladder: 0.7 warning / 0.9 critical / 1.0 blocked
  })

  it('two subscriptions sharing the same provider each get their own distinct sub_id', () => {
    const lc = deriveLifecycle(cfg([
      { id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', status: 'active', usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 5, weekly_pct: 19, weekly_reset_label: 'Tue 08:59' } },
      { id: 'claude-pro-google-play', name: 'Claude Pro', provider: 'anthropic', status: 'active', usage_snapshot: { as_of: '2026-07-08T21:00:00+02:00', session_pct: 16, weekly_pct: 2, weekly_reset_label: 'Wed 06:00' } },
    ]), NOW)
    const rows = fromSubscriptions(lc).filter(l => l.limit_type === 'weekly_usage_pct')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.sub_id).sort()).toEqual(['anthropic-max', 'claude-pro-google-play'])
  })

  it('no usage_snapshot at all -> no weekly_usage_pct entry (never fabricated)', () => {
    const lc = deriveLifecycle(cfg([{ id: 'openai-chatgpt', name: 'ChatGPT Plus', provider: 'openai', status: 'active' }]), NOW)
    expect(fromSubscriptions(lc).some(l => l.limit_type === 'weekly_usage_pct')).toBe(false)
  })
})

// Card 7d086cd3 (F4, Muse WS-C design-fidelity): DeepSeek's prepaid balance is a raw native-
// currency number (USD), unlike every other limit_type here which either has no monetary
// current_usage/limit_value at all, or is a plain percentage -- the renderer's HUF-formatter was
// silently stamping "Ft" onto it, printing "3,17 HUF" for a ~$3.17 USD balance.
describe('costops limits: DeepSeek balance unit (card 7d086cd3, F4)', () => {
  it('no snapshots yet -> unknown status, unit null (not assumed USD before any data exists)', () => {
    initDatabase(':memory:')
    const db = getDb()
    const limits = fromDeepSeekBalance(db)
    expect(limits).toHaveLength(1)
    expect(limits[0].status).toBe('unknown')
    expect(limits[0].unit).toBeNull()
  })

  it('carries the real native currency from the snapshot row, never HUF-assumed', () => {
    initDatabase(':memory:')
    const db = getDb()
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',10,?)`).run(1000)
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',3.17,?)`).run(2000)
    const limits = fromDeepSeekBalance(db)
    expect(limits).toHaveLength(1)
    expect(limits[0].unit).toBe('USD')
    expect(limits[0].current_usage).toBe(3.17)
    expect(limits[0].limit_value).toBe(10)
  })
})

// COS-OPS-M1: "peak" for the DeepSeek usage-% must be the peak since the LAST
// OBSERVED TOP-UP (a rise between consecutive snapshots), never the all-time max
// -- otherwise cruising low after a small top-up pins usage_pct near-critical
// forever against an old, long-spent high.
describe('costops limits: DeepSeek balance peak = since last top-up (COS-OPS-M1)', () => {
  function seed(balances: number[]): ReturnType<typeof getDb> {
    initDatabase(':memory:')
    const db = getDb()
    const ins = db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES ('deepseek','USD',?,?)`)
    balances.forEach((b, i) => ins.run(b, 1000 + i))
    return db
  }

  it('$50 history -> drops -> top-up to $5 -> current $4 reads as 20% of $5, not 92% of $50', () => {
    const db = seed([50, 30, 10, 1, 5, 4]) // 1 -> 5 is the top-up; peak since then is 5
    const [l] = fromDeepSeekBalance(db)
    expect(l.limit_value).toBe(5)
    expect(l.current_usage).toBe(4)
    expect(l.usage_pct).toBeCloseTo(0.2, 4)
    expect(l.status).toBe('ok') // NOT the pinned 'critical' the all-time max produced
  })

  it('with no top-up ever observed, the all-time max IS the last top-up level (unchanged behaviour)', () => {
    const db = seed([50, 30, 4])
    const [l] = fromDeepSeekBalance(db)
    expect(l.limit_value).toBe(50)
    expect(l.usage_pct).toBeCloseTo(0.92, 4)
    expect(l.status).toBe('critical')
  })

  it('right after a top-up (latest IS the peak) the % is null, not a fabricated 0', () => {
    const db = seed([50, 2, 60])
    const [l] = fromDeepSeekBalance(db)
    expect(l.limit_value).toBe(60)
    expect(l.usage_pct).toBeNull()
    expect(l.status).toBe('unknown')
  })
})

// COS-OPS-M2: point-in-time weekly-% snapshots (manual Claude reading, codex
// rate-limit read) degrade to usage_pct null / status 'unknown' past the
// staleness horizon -- a 3-week-old 85% is not a live figure to alert on (nor
// an all-clear to trust).
describe('costops limits: snapshot staleness horizon (COS-OPS-M2)', () => {
  const NOW_TS = Math.floor(Date.parse('2026-07-08T21:00:00+02:00') / 1000)
  const THREE_WEEKS = 21 * 24 * 3600

  function subWithSnapshot(asOf: string) {
    return deriveLifecycle(cfg([{
      id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', status: 'active',
      usage_snapshot: { as_of: asOf, session_pct: 50, weekly_pct: 85, weekly_reset_label: 'Tue 08:59' },
    }]), NOW_TS)
  }

  it('a fresh manual snapshot still reports its live % (and its age)', () => {
    const weekly = fromSubscriptions(subWithSnapshot('2026-07-08T20:00:00+02:00'), NOW_TS).find(l => l.limit_type === 'weekly_usage_pct')!
    expect(weekly.usage_pct).toBeCloseTo(0.85)
    expect(weekly.status).toBe('warning')
    expect(weekly.stale).toBe(false)
    expect(weekly.snapshot_age_seconds).toBe(3600)
  })

  it('a 3-week-old manual snapshot degrades to null/unknown and reports staleness', () => {
    const weekly = fromSubscriptions(subWithSnapshot('2026-06-17T21:00:00+02:00'), NOW_TS).find(l => l.limit_type === 'weekly_usage_pct')!
    expect(weekly.usage_pct).toBeNull()          // no live figure fabricated from history
    expect(weekly.status).toBe('unknown')
    expect(weekly.stale).toBe(true)
    expect(weekly.snapshot_age_seconds).toBe(THREE_WEEKS)
  })

  it('without a clock (now omitted) behaviour is unchanged -- no staleness judgement', () => {
    const weekly = fromSubscriptions(subWithSnapshot('2026-06-17T21:00:00+02:00')).find(l => l.limit_type === 'weekly_usage_pct')!
    expect(weekly.usage_pct).toBeCloseTo(0.85)
    expect(weekly.snapshot_age_seconds).toBeNull()
  })

  it('a fresh codex rate-limit snapshot reports its live %', () => {
    initDatabase(':memory:')
    const db = getDb()
    db.prepare(`INSERT INTO provider_ratelimit_snapshots (provider, used_percent, resets_at, captured_at) VALUES ('codex', 85, NULL, ?)`).run(NOW_TS - 3600)
    const [l] = fromCodexRateLimit(db, NOW_TS)
    expect(l.usage_pct).toBeCloseTo(0.85)
    expect(l.status).toBe('warning')
    expect(l.stale).toBe(false)
  })

  it('a 3-week-old codex snapshot degrades to null/unknown and reports staleness', () => {
    initDatabase(':memory:')
    const db = getDb()
    db.prepare(`INSERT INTO provider_ratelimit_snapshots (provider, used_percent, resets_at, captured_at) VALUES ('codex', 85, NULL, ?)`).run(NOW_TS - THREE_WEEKS)
    const [l] = fromCodexRateLimit(db, NOW_TS)
    expect(l.usage_pct).toBeNull()
    expect(l.current_usage).toBeNull()
    expect(l.status).toBe('unknown')
    expect(l.stale).toBe(true)
    expect(l.snapshot_age_seconds).toBe(THREE_WEEKS)
  })

  it('the horizon covers one full weekly window plus grace (documented default)', () => {
    expect(LIMIT_SNAPSHOT_STALE_AFTER_SECONDS).toBe(10 * 24 * 3600)
  })
})
