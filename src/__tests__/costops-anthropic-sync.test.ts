// P2-C: the anthropic collectors now have call sites, and both are exercised
// against FIXTURES -- no live network, no Vault read, no LLM.
//
// Before P2-C the anthropic cost collector had zero call sites anywhere: the mapper
// was unit-tested (costops-collectors.test.ts) and nothing ever ran it. The mapper
// being green proved only that the mapper was green.
//
// The two anthropic signals are deliberately separate and must not be conflated:
//   COST     -> Admin API, real network read, needs an admin key.
//   CAPACITY -> no API exists at all; only the operator's manual snapshot.
//
// RED-ABILITY:
//  * delete syncAnthropicCostReport (or its plan entry) -> tests 1-3 go red
//  * make the no-key path return ok / import a guessed 0 -> test 3 goes red

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { syncAnthropicCostReport, ANTHROPIC_VAULT_SECRET_ID } from '../costops/collectors/anthropic.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)

// Shape of the Admin cost_report response (time buckets -> per-line USD results).
const FIXTURE = {
  data: [
    { starting_at: '2026-07-01T00:00:00Z', ending_at: '2026-07-02T00:00:00Z', results: [{ amount: 12.5, currency: 'USD', cost_type: 'tokens' }] },
    { starting_at: '2026-07-02T00:00:00Z', ending_at: '2026-07-03T00:00:00Z', results: [{ amount: 7.5, currency: 'USD', cost_type: 'tokens' }] },
  ],
  has_more: false,
}

describe('P2-C: syncAnthropicCostReport', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('1. imports a provider_api line from a fixture payload, converted at the supplied FX rate', async () => {
    const db = getDb()
    let calledUrl = ''
    let sawAuthHeader = false
    const res = await syncAnthropicCostReport(db, NOW, {
      apiKey: 'fixture-key-not-a-real-secret',
      fxUsdHuf: 400,
      httpGetJson: async (url, headers) => {
        calledUrl = url
        sawAuthHeader = typeof headers['x-api-key'] === 'string'
        return FIXTURE
      },
    })

    expect(res.ok).toBe(true)
    expect(res.imported_count).toBe(1)
    expect(calledUrl).toContain('/v1/organizations/cost_report')
    expect(sawAuthHeader).toBe(true)

    const line = db.prepare(`
      SELECT billed_cost, currency, confidence, actual_source, source_id
      FROM cost_line_items WHERE source_id = 'anthropic-api'
    `).get() as { billed_cost: number; currency: string; confidence: string; actual_source: string; source_id: string }
    // (12.5 + 7.5) USD * 400 = 8000 HUF
    expect(line.billed_cost).toBe(8000)
    expect(line.currency).toBe('HUF')
    expect(line.confidence).toBe('provider_api')
    expect(line.actual_source).toBe('provider_api')
  })

  it('2. a second run over the same period is idempotent (upsert by dedup_key)', async () => {
    const db = getDb()
    const deps = { apiKey: 'fixture-key', fxUsdHuf: 400, httpGetJson: async () => FIXTURE }
    await syncAnthropicCostReport(db, NOW, deps)
    await syncAnthropicCostReport(db, NOW + 60, deps)
    const n = db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='anthropic-api'").get() as { c: number }
    expect(n.c).toBe(1)
  })

  it('3. no admin key => a precise blocker naming the vault id, and NOTHING imported', async () => {
    const db = getDb()
    const res = await syncAnthropicCostReport(db, NOW, { apiKey: null })
    expect(res.ok).toBe(false)
    expect(res.imported_count).toBe(0)
    expect(res.error).toContain(ANTHROPIC_VAULT_SECRET_ID)
    // Not a fabricated 0-cost line.
    const n = db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='anthropic-api'").get() as { c: number }
    expect(n.c).toBe(0)
  })

  it('4. an API failure records a SANITIZED error and imports nothing (no secret in the run row)', async () => {
    const db = getDb()
    const res = await syncAnthropicCostReport(db, NOW, {
      apiKey: 'fixture-key',
      fxUsdHuf: 400,
      httpGetJson: async () => { throw new Error('anthropic admin api 401 for sk-abcdefghijklmnopqrstuvwxyz012345') },
    })
    expect(res.ok).toBe(false)
    const row = db.prepare(`
      SELECT status, imported_count, error_message_sanitized m FROM import_runs
      WHERE collector_name = 'anthropic-cost-report' ORDER BY id DESC LIMIT 1
    `).get() as { status: string; imported_count: number; m: string | null }
    expect(row.status).toBe('error')
    expect(row.imported_count).toBe(0)
    expect(row.m ?? '').not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('5. an empty report imports nothing rather than a 0 line (cost is unknown, not zero)', async () => {
    const db = getDb()
    const res = await syncAnthropicCostReport(db, NOW, {
      apiKey: 'fixture-key', fxUsdHuf: 400, httpGetJson: async () => ({ data: [], has_more: false }),
    })
    expect(res.imported_count).toBe(0)
    const n = db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='anthropic-api'").get() as { c: number }
    expect(n.c).toBe(0)
  })

  // Card 23912ca4 / COS-OPS-H4: the fx=0 guard existed only on the OpenAI sync;
  // this one silently stored usd*0=0 HUF as a provider_api line that outranked
  // the real manual estimate.
  it('6. an unset (0) USD rate is a loud blocker -- no import, an actionable error', async () => {
    const db = getDb()
    const res = await syncAnthropicCostReport(db, NOW, {
      apiKey: 'fixture-key', fxUsdHuf: 0, httpGetJson: async () => FIXTURE,
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe('error')
    expect(res.error).toMatch(/rate is not configured/i)
    const n = db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='anthropic-api'").get() as { c: number }
    expect(n.c).toBe(0)
  })

  // COS-OPS-H5: cost_report pages in daily buckets -- before the cursor was
  // followed, a paged month imported only its first page as the authoritative
  // provider_api actual (a silent under-count that won the reconcile).
  it('7. follows the has_more/next_page cursor and sums ALL pages into the month line', async () => {
    const db = getDb()
    const page1 = {
      data: [{ starting_at: '2026-07-01T00:00:00Z', ending_at: '2026-07-02T00:00:00Z', results: [{ amount: 12.5, currency: 'USD', cost_type: 'tokens' }] }],
      has_more: true,
      next_page: 'cursor-page-2',
    }
    const page2 = {
      data: [{ starting_at: '2026-07-02T00:00:00Z', ending_at: '2026-07-03T00:00:00Z', results: [{ amount: 7.5, currency: 'USD', cost_type: 'tokens' }] }],
      has_more: false,
      next_page: null,
    }
    const urls: string[] = []
    const res = await syncAnthropicCostReport(db, NOW, {
      apiKey: 'fixture-key', fxUsdHuf: 400,
      httpGetJson: async (url) => {
        urls.push(url)
        return url.includes('page=cursor-page-2') ? page2 : page1
      },
    })
    expect(res.ok).toBe(true)
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('page=cursor-page-2')
    const line = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-api'").get() as { billed_cost: number }
    // (12.5 + 7.5) USD * 400 = 8000 HUF -- both pages, not just the first.
    expect(line.billed_cost).toBe(8000)
  })

  it('8. runaway pagination FAILS the run (error, nothing imported) instead of silently booking a partial month', async () => {
    const db = getDb()
    let calls = 0
    const res = await syncAnthropicCostReport(db, NOW, {
      apiKey: 'fixture-key', fxUsdHuf: 400,
      httpGetJson: async () => {
        calls++
        return {
          data: [{ starting_at: '2026-07-01T00:00:00Z', ending_at: '2026-07-02T00:00:00Z', results: [{ amount: 1, currency: 'USD' }] }],
          has_more: true, next_page: `cursor-${calls}`,
        }
      },
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe('error')
    expect(calls).toBeLessThanOrEqual(41) // bounded, not an infinite loop
    const n = db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='anthropic-api'").get() as { c: number }
    expect(n.c).toBe(0) // no partial total was imported
  })

  it('9. has_more without a next_page cursor also fails the run rather than importing a partial month', async () => {
    const db = getDb()
    const res = await syncAnthropicCostReport(db, NOW, {
      apiKey: 'fixture-key', fxUsdHuf: 400,
      httpGetJson: async () => ({
        data: [{ starting_at: '2026-07-01T00:00:00Z', ending_at: '2026-07-02T00:00:00Z', results: [{ amount: 1, currency: 'USD' }] }],
        has_more: true, next_page: null,
      }),
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe('error')
    const n = db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='anthropic-api'").get() as { c: number }
    expect(n.c).toBe(0)
  })
})
