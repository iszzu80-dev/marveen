// CostOps Phase 4 -- weekly market watch: normalize/hash/diff/change-event.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeMarketSnapshot, hashSnapshot, diffSnapshots, runMarketWatchCycle,
  type MarketWatchCache,
} from '../costops/market-watch.js'

function snapshot(overPrice = 20) {
  return {
    meta: { snapshot_date: '2026-07-30', read_date: '2026-07-30' },
    providers: {
      anthropic: {
        subscriptions: [
          { package: 'Claude Pro', monthly_price: { amount: overPrice, currency: 'USD' }, source_url: 'https://anthropic.com/pricing', read_date: '2026-07-30' },
        ],
        api_payg: [
          { model: 'Claude Sonnet 5', input_price_per_1M: { amount: 3, currency: 'USD' }, source_url: 'https://anthropic.com/pricing', read_date: '2026-07-30' },
        ],
      },
      coding_tier_alternatives: {
        cursor: [
          { package: 'Cursor Pro', monthly_price: { amount: 20, currency: 'USD' }, source_url: 'https://cursor.com/pricing', read_date: '2026-07-30' },
        ],
      },
    },
  }
}

describe('normalizeMarketSnapshot', () => {
  it('flattens nested provider/group paths into a sorted, keyed entry list', () => {
    const n = normalizeMarketSnapshot(snapshot())
    expect(n.entries.map(e => e.key)).toEqual([
      'anthropic/api_payg/Claude Sonnet 5',
      'anthropic/subscriptions/Claude Pro',
      'coding_tier_alternatives/cursor/Cursor Pro',
    ])
  })

  it('carries source_url and read_date through per entry', () => {
    const n = normalizeMarketSnapshot(snapshot())
    const pro = n.entries.find(e => e.key === 'anthropic/subscriptions/Claude Pro')!
    expect(pro.source_url).toBe('https://anthropic.com/pricing')
    expect(pro.read_date).toBe('2026-07-30')
  })

  it('malformed/empty input degrades to an empty entry list, never throws', () => {
    expect(normalizeMarketSnapshot(null).entries).toEqual([])
    expect(normalizeMarketSnapshot({}).entries).toEqual([])
    expect(normalizeMarketSnapshot('not an object').entries).toEqual([])
  })
})

describe('hashSnapshot', () => {
  it('is deterministic and independent of input key order', () => {
    const a = normalizeMarketSnapshot(snapshot())
    const reordered = {
      providers: {
        coding_tier_alternatives: { cursor: [{ read_date: '2026-07-30', source_url: 'https://cursor.com/pricing', monthly_price: { currency: 'USD', amount: 20 }, package: 'Cursor Pro' }] },
        anthropic: {
          api_payg: [{ read_date: '2026-07-30', source_url: 'https://anthropic.com/pricing', input_price_per_1M: { currency: 'USD', amount: 3 }, model: 'Claude Sonnet 5' }],
          subscriptions: [{ read_date: '2026-07-30', source_url: 'https://anthropic.com/pricing', monthly_price: { currency: 'USD', amount: 20 }, package: 'Claude Pro' }],
        },
      },
      meta: { read_date: '2026-07-30', snapshot_date: '2026-07-30' },
    }
    const b = normalizeMarketSnapshot(reordered)
    expect(hashSnapshot(a)).toBe(hashSnapshot(b))
  })

  it('changes when a price actually changes', () => {
    const a = normalizeMarketSnapshot(snapshot(20))
    const b = normalizeMarketSnapshot(snapshot(25))
    expect(hashSnapshot(a)).not.toBe(hashSnapshot(b))
  })
})

describe('diffSnapshots', () => {
  it('reports added, removed and changed entries by key', () => {
    const prev = normalizeMarketSnapshot(snapshot(20))
    const next = normalizeMarketSnapshot(snapshot(25))
    const event = diffSnapshots(prev, next, hashSnapshot(prev), hashSnapshot(next), 1000)
    expect(event.changed).toHaveLength(1)
    expect(event.changed[0].key).toBe('anthropic/subscriptions/Claude Pro')
    expect(event.changed[0].source_url).toBe('https://anthropic.com/pricing')
    expect(event.added).toEqual([])
    expect(event.removed).toEqual([])
    expect(event.detected_at).toBe(1000)
  })

  it('a removed package appears in removed, not silently dropped', () => {
    const full = snapshot()
    const withoutCursor = { ...full, providers: { anthropic: full.providers.anthropic } }
    const prev = normalizeMarketSnapshot(full)
    const next = normalizeMarketSnapshot(withoutCursor)
    const event = diffSnapshots(prev, next, hashSnapshot(prev), hashSnapshot(next), 1000)
    expect(event.removed.map(e => e.key)).toEqual(['coding_tier_alternatives/cursor/Cursor Pro'])
  })

  it('a null previous (first-ever run) reports every entry as added', () => {
    const next = normalizeMarketSnapshot(snapshot())
    const event = diffSnapshots(null, next, null, hashSnapshot(next), 1000)
    expect(event.added).toHaveLength(next.entries.length)
    expect(event.previous_hash).toBeNull()
  })
})

describe('runMarketWatchCycle -- the load-bearing no-op-on-unchanged-hash guard', () => {
  it('an identical re-fetch produces changed:false and event:null -- no event on a content-identical cycle', () => {
    const first = runMarketWatchCycle(() => snapshot(), null, 1000)
    const cache: MarketWatchCache = { hash: first.hash, normalized: first.normalized }
    const second = runMarketWatchCycle(() => snapshot(), cache, 2000)
    expect(second.changed).toBe(false)
    expect(second.event).toBeNull()
  })

  it('a genuinely changed re-fetch produces changed:true with a populated event', () => {
    const first = runMarketWatchCycle(() => snapshot(20), null, 1000)
    const cache: MarketWatchCache = { hash: first.hash, normalized: first.normalized }
    const second = runMarketWatchCycle(() => snapshot(25), cache, 2000)
    expect(second.changed).toBe(true)
    expect(second.event).not.toBeNull()
    expect(second.event!.changed).toHaveLength(1)
  })

  it('deterministic: identical fetch+cache+detectedAt produce identical output on repeat calls', () => {
    const cache: MarketWatchCache = { hash: 'x', normalized: normalizeMarketSnapshot(snapshot(20)) }
    const a = runMarketWatchCycle(() => snapshot(25), cache, 1000)
    const b = runMarketWatchCycle(() => snapshot(25), cache, 1000)
    expect(a).toEqual(b)
  })
})

describe('advisory-only, structurally -- no LLM/network/exec call anywhere in the deterministic core', () => {
  it('the market watch source contains no fetch/exec/spawn/http call of any kind', () => {
    const src = readFileSync(join(__dirname, '../costops/market-watch.ts'), 'utf-8')
    const forbidden = /\bfetch\s*\(|\bexeca?\s*\(|\bspawn\s*\(|\bhttp\.request\b|\baxios\b|child_process/i
    expect(forbidden.test(src)).toBe(false)
  })
})
