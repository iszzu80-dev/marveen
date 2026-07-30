import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { mapOpenAiCosts, openaiCollector, syncOpenAiCollector } from '../costops/collectors/openai.js'
import { monthWindow } from '../costops/ledger.js'
import type { CollectOpts } from '../costops/collectors/types.js'

// Fixture modelling the OpenAI /v1/organizations/costs page shape.
function fixturePage(vals: number[]) {
  const now = Math.floor(Date.UTC(2026, 6, 1) / 1000)
  return {
    object: 'page',
    data: vals.map((v, i) => ({
      object: 'bucket',
      start_time: now + i * 86400,
      end_time: now + (i + 1) * 86400,
      results: [{ object: 'organization.costs.result', amount: { value: v, currency: 'usd' }, line_item: null, project_id: null }],
    })),
    has_more: false,
    next_page: null,
  }
}

const START = Math.floor(Date.UTC(2026, 6, 1) / 1000)
const END = Math.floor(Date.UTC(2026, 7, 1) / 1000)

describe('mapOpenAiCosts (pure, offline)', () => {
  it('sums daily USD costs into one HUF provider_api line for openai-api', () => {
    const lines = mapOpenAiCosts(fixturePage([1.5, 2.0, 0.5]), { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 'salt', now: START })
    expect(lines).toHaveLength(1)
    const l = lines[0]
    expect(l.provider).toBe('openai')
    expect(l.service).toBe('openai-api')
    expect(l.confidence).toBe('provider_api')
    expect(l.currency).toBe('HUF')
    expect(l.amount).toBe(Math.round(4.0 * 360 * 100) / 100) // (1.5+2.0+0.5)*360
    expect(l.dedup_key).toBe('provider|openai|openai-api|2026-07|provider_api')
    expect(l.raw_ref_hash).not.toContain('openai-costs') // hashed, no raw
  })

  it('returns [] for an empty page (caller reports explicit 0)', () => {
    expect(mapOpenAiCosts({ object: 'page', data: [] }, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
    expect(mapOpenAiCosts(null, { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 's', now: START })).toHaveLength(0)
  })

  // Card 320c477a: data_freshness_at must be the INGEST instant (opts.now), never
  // a bucket end_time. The live collision this guards against: an openai-api
  // provider_api row was stamped 2026-08-01 (a bucket end_time) instead of its
  // real collection time, so it won an equal-tier freshness tiebreak
  // (ledger.ts) against a real 2026-07-19 invoice that should have stood.
  it('320c477a: data_freshness_at is opts.now, never a bucket end_time -- even when every bucket ends after now', () => {
    // Every bucket's end_time is deliberately AFTER `now`, mirroring the live
    // collision where the API's own period boundary was later than collection time.
    const now = START + 3600 // 1h into the period, all bucket end_times are later
    const lines = mapOpenAiCosts(fixturePage([1.5, 2.0, 0.5]), { periodStart: START, periodEnd: END, fxUsdHuf: 360, idSalt: 'salt', now })
    expect(lines[0].data_freshness_at).toBe(now)
    // None of the buckets' end_times leaked through as the freshness value.
    expect(lines[0].data_freshness_at).not.toBe(START + 86400)
    expect(lines[0].data_freshness_at).not.toBe(START + 3 * 86400)
  })
})

describe('openaiCollector + syncOpenAiCollector (offline stub, no live call)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('collect() returns normalized lines from the injected fetcher (no network)', async () => {
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const w = monthWindow(now)
    const opts: CollectOpts = {
      periodStart: w.start, periodEnd: w.end, secret: 'sk-admin-never-logged', fxUsdHuf: 360, idSalt: 'openai-salt',
      httpGetJson: async () => fixturePage([3.0, 1.0]), now,
    }
    const lines = await openaiCollector.collect(opts)
    expect(lines).toHaveLength(1)
    expect(lines[0].amount).toBe(Math.round(4.0 * 360 * 100) / 100)
  })

  it('320c477a: collectRaw wires opts.now (not opts.periodStart) into data_freshness_at', async () => {
    const w = monthWindow(START)
    const distinctNow = w.start + 12 * 86400 // well inside the period, far from periodStart
    const opts: CollectOpts = {
      periodStart: w.start, periodEnd: w.end, secret: 'sk-admin-never-logged', fxUsdHuf: 360, idSalt: 'openai-salt',
      httpGetJson: async () => fixturePage([3.0, 1.0]), now: distinctNow,
    }
    const { lines } = await openaiCollector.collectRaw!(opts)
    expect(lines[0].data_freshness_at).toBe(distinctNow)
    expect(lines[0].data_freshness_at).not.toBe(w.start)
  })

  it('sync imports a provider_api line + import_run using a stubbed key and fetcher (idempotent)', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const stub = async () => fixturePage([2.0, 2.0])
    const r1 = await syncOpenAiCollector(db, now, { apiKey: 'sk-admin-stub', fxUsdHuf: 360, httpGetJson: stub })
    expect(r1.ok).toBe(true)
    expect(r1.imported_count).toBe(1)
    const lineCount = () => (db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='openai-api'").get() as { c: number }).c
    expect(lineCount()).toBe(1)
    const r2 = await syncOpenAiCollector(db, now, { apiKey: 'sk-admin-stub', fxUsdHuf: 360, httpGetJson: stub })
    expect(r2.ok).toBe(true)
    expect(lineCount()).toBe(1) // idempotent upsert by dedup_key

    // secret must not leak into the import_runs audit rows
    const audit = JSON.stringify(db.prepare('SELECT * FROM import_runs').all())
    expect(audit).not.toContain('sk-admin-stub')
  })

  it('reports error (no import) when the vault key is missing', async () => {
    const db = getDb()
    const now = Math.floor(Date.UTC(2026, 6, 10) / 1000)
    const r = await syncOpenAiCollector(db, now, { apiKey: null, fxUsdHuf: 360, httpGetJson: async () => fixturePage([1]) })
    expect(r.ok).toBe(false)
    expect(r.status).toBe('error')
    expect((db.prepare("SELECT COUNT(*) c FROM cost_line_items WHERE source_id='openai-api'").get() as { c: number }).c).toBe(0)
  })
})
