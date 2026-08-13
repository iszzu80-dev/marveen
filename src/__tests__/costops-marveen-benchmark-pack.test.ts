// CostOps Phase 4 -- Marveen-specific benchmark pack.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createDispatch, recordProducerCompletedOutcomeForCard } from '../costops/dispatch.js'
import { buildMarveenBenchmarkPack, MARVEEN_BENCHMARK_CAVEATS } from '../costops/marveen-benchmark-pack.js'
import type { PricingConfig } from '../costops/pricing.js'

const T0_SEC = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const ms = (sec: number) => sec * 1000

const pricing: PricingConfig = {
  version: 1, currency: 'USD',
  models: {
    'claude-opus-4-8': { input_per_mtok: 15, output_per_mtok: 75, cache_read_per_mtok: 1.5, cache_write_per_mtok: 18.75 },
  },
}

function insertTokenUsage(row: {
  agent: string; session_id: string; timestamp: number; input?: number; output?: number
  cache_read?: number; cache_creation?: number; model?: string | null; dispatch_id?: string | null
}) {
  getDb().prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, model, dispatch_id)
    VALUES (@agent, @session_id, @timestamp, @input, @output, @cache_read, @cache_creation, @model, @dispatch_id)
  `).run({
    agent: row.agent, session_id: row.session_id, timestamp: row.timestamp,
    input: row.input ?? 0, output: row.output ?? 0,
    cache_read: row.cache_read ?? 0, cache_creation: row.cache_creation ?? 0,
    model: row.model ?? null, dispatch_id: row.dispatch_id ?? null,
  })
}

describe('buildMarveenBenchmarkPack', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('includes only agent === marveen groups, excludes other agents entirely', () => {
    const db = getDb()
    const mDispatch = createDispatch(db, { source: 'kanban', agent: 'marveen', cardId: 'm1', provider: 'anthropic', runtimeModel: 'claude-opus-4-8' }, ms(T0_SEC))
    recordProducerCompletedOutcomeForCard(db, 'm1', 'OPERATOR_ATTESTED', ms(T0_SEC))
    insertTokenUsage({ agent: 'marveen', session_id: 's1', timestamp: T0_SEC + 1, input: 1_000_000, output: 0, model: 'claude-opus-4-8', dispatch_id: mDispatch })

    const bDispatch = createDispatch(db, { source: 'kanban', agent: 'buildfejleszto', cardId: 'b1', provider: 'anthropic', runtimeModel: 'claude-opus-4-8' }, ms(T0_SEC))
    recordProducerCompletedOutcomeForCard(db, 'b1', 'OPERATOR_ATTESTED', ms(T0_SEC))
    insertTokenUsage({ agent: 'buildfejleszto', session_id: 's2', timestamp: T0_SEC + 1, input: 1_000_000, output: 0, model: 'claude-opus-4-8', dispatch_id: bDispatch })

    const pack = buildMarveenBenchmarkPack(db, T0_SEC, { pricing })
    expect(pack.groups).toHaveLength(1)
    expect(pack.groups[0].agent).toBe('marveen')
    expect(pack.totals.accepted_tasks).toBe(1)
  })

  it('marginal_cost sums only groups with a KNOWN marginal cost, and reports how many that covers', () => {
    const db = getDb()
    const d1 = createDispatch(db, { source: 'kanban', agent: 'marveen', cardId: 'm1', provider: 'anthropic', runtimeModel: 'claude-opus-4-8', taskType: 'a' }, ms(T0_SEC))
    recordProducerCompletedOutcomeForCard(db, 'm1', 'OPERATOR_ATTESTED', ms(T0_SEC))
    insertTokenUsage({ agent: 'marveen', session_id: 's1', timestamp: T0_SEC + 1, input: 1_000_000, output: 0, model: 'claude-opus-4-8', dispatch_id: d1 })

    const d2 = createDispatch(db, { source: 'kanban', agent: 'marveen', cardId: 'm2', provider: 'anthropic', runtimeModel: 'unlisted-model', taskType: 'b' }, ms(T0_SEC))
    recordProducerCompletedOutcomeForCard(db, 'm2', 'OPERATOR_ATTESTED', ms(T0_SEC))
    insertTokenUsage({ agent: 'marveen', session_id: 's2', timestamp: T0_SEC + 1, input: 500_000, output: 0, model: 'unlisted-model', dispatch_id: d2 })

    const pack = buildMarveenBenchmarkPack(db, T0_SEC, { pricing })
    expect(pack.groups).toHaveLength(2)
    // priced group: 1M input tokens * $15/Mtok = $15. Unpriced group contributes nothing to the sum.
    expect(pack.totals.marginal_cost).toBeCloseTo(15, 4)
    expect(pack.totals.marginal_cost_known_groups).toBe(1)
    expect(pack.totals.accepted_tasks).toBe(2)
  })

  it('no marveen dispatches at all -> empty groups, marginal_cost null (never a fabricated 0)', () => {
    const db = getDb()
    const pack = buildMarveenBenchmarkPack(db, T0_SEC, { pricing })
    expect(pack.groups).toEqual([])
    expect(pack.totals.marginal_cost).toBeNull()
    expect(pack.totals.marginal_cost_known_groups).toBe(0)
    expect(pack.totals.accepted_tasks).toBe(0)
  })

  it('every report carries the full fixed caveat set -- never silently dropped', () => {
    const db = getDb()
    const pack = buildMarveenBenchmarkPack(db, T0_SEC, { pricing })
    expect(pack.caveats).toEqual(MARVEEN_BENCHMARK_CAVEATS)
    expect(pack.caveats.some(c => c.includes('session restart'))).toBe(true)
    expect(pack.caveats.some(c => c.includes('targetSession'))).toBe(true)
    expect(pack.caveats.some(c => c.includes('worker link is INERT'))).toBe(true)
    expect(pack.caveats.some(c => c.includes('never be summed or averaged'))).toBe(true)
  })

  it('deterministic: identical db state + inputs produce identical output on repeat calls', () => {
    const db = getDb()
    const d = createDispatch(db, { source: 'kanban', agent: 'marveen', cardId: 'm1', provider: 'anthropic', runtimeModel: 'claude-opus-4-8' }, ms(T0_SEC))
    recordProducerCompletedOutcomeForCard(db, 'm1', 'OPERATOR_ATTESTED', ms(T0_SEC))
    insertTokenUsage({ agent: 'marveen', session_id: 's1', timestamp: T0_SEC + 1, input: 1_000_000, output: 0, model: 'claude-opus-4-8', dispatch_id: d })
    const a = buildMarveenBenchmarkPack(db, T0_SEC, { pricing })
    const b = buildMarveenBenchmarkPack(db, T0_SEC, { pricing })
    expect(a).toEqual(b)
  })
})

describe('structurally -- no reimplemented cost math, no LLM/network call', () => {
  it('the benchmark pack source calls costPerAcceptedTask and does not reimplement pricing math (no *_per_mtok arithmetic)', () => {
    const src = readFileSync(join(__dirname, '../costops/marveen-benchmark-pack.ts'), 'utf-8')
    expect(src.includes('costPerAcceptedTask')).toBe(true)
    expect(/input_per_mtok|output_per_mtok|cache_read_per_mtok/.test(src)).toBe(false)
  })

  it('the benchmark pack source contains no fetch/exec/spawn/http call of any kind', () => {
    const src = readFileSync(join(__dirname, '../costops/marveen-benchmark-pack.ts'), 'utf-8')
    const forbidden = /\bfetch\s*\(|\bexeca?\s*\(|\bspawn\s*\(|\bhttp\.request\b|\baxios\b|child_process/i
    expect(forbidden.test(src)).toBe(false)
  })
})
