import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { mapGitHubUsage, githubCollector, syncGitHubCollector } from '../costops/collectors/github.js'
import { monthWindow } from '../costops/ledger.js'
import type { CollectOpts } from '../costops/collectors/types.js'

const START = Math.floor(Date.UTC(2026, 6, 1) / 1000)
const END = Math.floor(Date.UTC(2026, 7, 1) / 1000)

function report(amounts: number[]) {
  return { usageItems: amounts.map((a, i) => ({ date: '2026-07-0' + (i + 1), product: 'actions', sku: 'x', quantity: 1, unitType: 'min', netAmount: a })) }
}

describe('mapGitHubUsage (pure, offline)', () => {
  it('sums netAmount USD into one HUF provider_api line for github', () => {
    const lines = mapGitHubUsage(report([2, 3]), { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })
    expect(lines).toHaveLength(1)
    expect(lines[0].provider).toBe('github')
    expect(lines[0].confidence).toBe('provider_api')
    expect(lines[0].amount).toBe(Math.round(5 * 360 * 100) / 100)
    expect(lines[0].dedup_key).toBe('provider|github|github|2026-07|provider_api')
  })

  it('emits an EXPLICIT 0 provider_api line on a valid empty report (API-observed zero)', () => {
    const lines = mapGitHubUsage({ usageItems: [] }, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })
    expect(lines).toHaveLength(1)
    expect(lines[0].amount).toBe(0)
    expect(lines[0].confidence).toBe('provider_api')
  })

  it('returns [] only when the raw is not a usage report', () => {
    expect(mapGitHubUsage(null, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
    expect(mapGitHubUsage({ message: 'Not Found' }, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
  })

  // Card 23912ca4 / COS-OPS-H4: the fx=0 guard originally landed on the OpenAI
  // mapper only -- this one kept storing usd*0=0 as an HUF provider_api line,
  // which outranked the real manual estimate in the reconcile.
  it('a zero fxUsdHuf produces NO line -- real USD spend is not fabricated into 0 HUF', () => {
    expect(mapGitHubUsage(report([2, 3]), { periodStart: START, periodEnd: END, fxUsdHuf: 0, idSalt: 's', now: START })).toHaveLength(0)
  })

  it('a negative fxUsdHuf is treated the same as zero -- no fabricated line', () => {
    expect(mapGitHubUsage(report([2, 3]), { periodStart: START, periodEnd: END, fxUsdHuf: -1, idSalt: 's', now: START })).toHaveLength(0)
  })

  it('with no rate even the explicit empty-report 0 line is withheld -- an unconvertible zero is still unknown-in-HUF', () => {
    expect(mapGitHubUsage({ usageItems: [] }, { periodStart: START, periodEnd: END, fxUsdHuf: 0, idSalt: 's', now: START })).toHaveLength(0)
  })
})

describe('githubCollector + syncGitHubCollector (offline stub)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('sync imports a provider_api line (even at 0) with a stubbed key + fetcher; idempotent', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const r1 = await syncGitHubCollector(db, now, { apiKey: 'ghp-stub', fxUsdHuf: 360, httpGetJson: async () => report([]) })
    expect(r1.ok).toBe(true)
    expect(r1.imported_count).toBe(1)
    const row = db.prepare("SELECT billed_cost, confidence, data_freshness FROM cost_line_items WHERE source_id='github'").get() as { billed_cost: number; confidence: string; data_freshness: number }
    expect(row.billed_cost).toBe(0)
    expect(row.confidence).toBe('provider_api')
    // 320c477a: data_freshness is the real collection instant (now, 2026-07-10),
    // never the billing period start (2026-07-01) that used to leak through
    // collectRaw's internal wiring.
    expect(row.data_freshness).toBe(now)
    expect(row.data_freshness).not.toBe(monthWindow(now).start)
    // idempotent
    await syncGitHubCollector(db, now, { apiKey: 'ghp-stub', fxUsdHuf: 360, httpGetJson: async () => report([]) })
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='github'").get() as { c: number }).c).toBe(1)
    const audit = JSON.stringify(db.prepare('SELECT * FROM import_runs').all())
    expect(audit).not.toContain('ghp-stub')
  })

  it('errors (no import) when the vault token is missing', async () => {
    const db = getDb()
    const r = await syncGitHubCollector(db, Math.floor(Date.now() / 1000), { apiKey: null, fxUsdHuf: 360, httpGetJson: async () => report([1]) })
    expect(r.ok).toBe(false)
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='github'").get() as { c: number }).c).toBe(0)
  })

  // Card 23912ca4 / COS-OPS-H4: an unconfigured USD rate must be an explicit,
  // actionable BLOCKER (status/error field), not a silent 0-import that looks
  // identical to "there was no GitHub spend this month".
  it('an unset (0) USD rate is a loud blocker -- no import, an actionable error', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const r = await syncGitHubCollector(db, now, { apiKey: 'ghp-stub', fxUsdHuf: 0, httpGetJson: async () => report([2, 3]) })
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/rate is not configured/i)
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='github'").get() as { c: number }).c).toBe(0)
  })

  it('a negative USD rate is also a blocker, not a silent import', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const r = await syncGitHubCollector(db, now, { apiKey: 'ghp-stub', fxUsdHuf: -5, httpGetJson: async () => report([2]) })
    expect(r.ok).toBe(false)
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='github'").get() as { c: number }).c).toBe(0)
  })
})
