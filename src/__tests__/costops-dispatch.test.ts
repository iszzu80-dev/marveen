import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb, createAgentMessage, getPendingMessages } from '../db.js'
import {
  initDispatchSchema,
  createDispatch,
  createDispatchSafe,
  recordOutcome,
  recordAcceptedOutcomeForCard,
  resolveOutcome,
  correlateTokenUsageToDispatches,
  resolveBillingMode,
  loadBillingMap,
  costPerAcceptedTask,
  type BillingMap,
} from '../costops/dispatch.js'
// P2-A marginal cost REUSES costops/pricing.ts -- there is no second pricing
// impl in dispatch.ts. estimateModelCost is the shared per-model cost formula.
import { estimateModelCost, type PricingConfig } from '../costops/pricing.js'

// Deterministic epoch. Dispatch created_at is stored in SECONDS to line up with
// token_usage.timestamp (seconds). We pass Date.now()-style MILLISECONDS in.
const T0_SEC = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)
const ms = (sec: number) => sec * 1000

// pricing.ts PricingConfig shape: per-1M-token rates keyed by model id.
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

describe('P2-A schema (installed via the CostOps seam)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('initDispatchSchema is idempotent and creates the three tables + link column', () => {
    const db = getDb()
    // initDatabase already ran it once (through initCostOpsSchema); re-run must not throw.
    expect(() => initDispatchSchema(db)).not.toThrow()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    expect(tables).toContain('dispatches')
    expect(tables).toContain('routing_events')
    expect(tables).toContain('dispatch_outcomes')
    const cols = db.prepare("SELECT name FROM pragma_table_info('token_usage')").all().map((r: any) => r.name)
    expect(cols).toContain('dispatch_id')
  })

  it('the dispatches table carries NO prompt/PII/secret column', () => {
    const cols = getDb().prepare("SELECT name FROM pragma_table_info('dispatches')").all().map((r: any) => r.name)
    // Only opaque metadata columns; nothing that could hold prompt text.
    expect(cols.sort()).toEqual([
      'agent', 'auth_profile', 'billing_mode', 'card_id', 'configured_model', 'created_at',
      'dispatch_id', 'model_profile', 'project', 'provider', 'runtime_model', 'session_id', 'source', 'task_type',
    ])
    for (const forbidden of ['prompt', 'content', 'text', 'message', 'body', 'secret', 'token']) {
      expect(cols).not.toContain(forbidden)
    }
  })
})

describe('P2-A createDispatch + routing_event', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('creates a dispatch (opaque uuid) plus a default_route routing_event', () => {
    const db = getDb()
    const id = createDispatch(db, { source: 'kanban', agent: 'buildfejleszto', cardId: 'abc123', project: 'MK' }, ms(T0_SEC))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const d: any = db.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(id)
    expect(d.source).toBe('kanban')
    expect(d.agent).toBe('buildfejleszto')
    expect(d.card_id).toBe('abc123')
    expect(d.created_at).toBe(T0_SEC) // stored in SECONDS
    const ev: any = db.prepare('SELECT * FROM routing_events WHERE dispatch_id = ?').get(id)
    expect(ev.reason_code).toBe('default_route')
    expect(ev.fallback_used).toBe(0) // Phase 2 introduces NO fallback
  })

  it('dispatch -> routing_event -> token_usage -> outcome are joinable by dispatch_id', () => {
    const db = getDb()
    const id = createDispatch(db, { source: 'scheduler', agent: 'research', sessionId: 'sess-1', runtimeModel: 'claude-opus-4-8', provider: 'anthropic' }, ms(T0_SEC))
    insertTokenUsage({ agent: 'research', session_id: 'sess-1', timestamp: T0_SEC + 10, input: 100, output: 50, dispatch_id: id })
    recordOutcome(db, { dispatchId: id, outcome: 'accepted', evidence: 'kanban:done' }, ms(T0_SEC + 20))
    const joined: any = db.prepare(`
      SELECT d.dispatch_id, r.reason_code, tu.input_tokens, o.outcome
      FROM dispatches d
      JOIN routing_events r ON r.dispatch_id = d.dispatch_id
      JOIN token_usage tu ON tu.dispatch_id = d.dispatch_id
      JOIN dispatch_outcomes o ON o.dispatch_id = d.dispatch_id
      WHERE d.dispatch_id = ?
    `).get(id)
    expect(joined.dispatch_id).toBe(id)
    expect(joined.reason_code).toBe('default_route')
    expect(joined.input_tokens).toBe(100)
    expect(joined.outcome).toBe('accepted')
  })
})

describe('P2-A window correlation (agent, session_id)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('attributes token_usage to the dispatch whose [created_at, next) window contains its timestamp', () => {
    const db = getDb()
    const d1 = createDispatch(db, { source: 'scheduler', agent: 'a', sessionId: 's1' }, ms(T0_SEC + 100))
    const d2 = createDispatch(db, { source: 'scheduler', agent: 'a', sessionId: 's1' }, ms(T0_SEC + 200))
    insertTokenUsage({ agent: 'a', session_id: 's1', timestamp: T0_SEC + 150 }) // -> d1 window
    insertTokenUsage({ agent: 'a', session_id: 's1', timestamp: T0_SEC + 250 }) // -> d2 window (open-ended)
    insertTokenUsage({ agent: 'a', session_id: 's1', timestamp: T0_SEC + 90 })  // before d1 -> unattributed

    const linked = correlateTokenUsageToDispatches(db)
    expect(linked).toBe(2)
    const at = (ts: number) => (db.prepare('SELECT dispatch_id FROM token_usage WHERE timestamp = ?').get(T0_SEC + ts) as any).dispatch_id
    expect(at(150)).toBe(d1)
    expect(at(250)).toBe(d2)
    expect(at(90)).toBeNull()
  })

  it('does not cross session boundaries and never overwrites an existing link', () => {
    const db = getDb()
    const d1 = createDispatch(db, { source: 'scheduler', agent: 'a', sessionId: 's1' }, ms(T0_SEC + 100))
    createDispatch(db, { source: 'scheduler', agent: 'a', sessionId: 's2' }, ms(T0_SEC + 100))
    // Row in s2's timeline but window belongs to a different session -> only s1's
    // own row is linked to d1; the s2 row links to its own dispatch, never d1.
    insertTokenUsage({ agent: 'a', session_id: 's2', timestamp: T0_SEC + 150 })
    // Pre-linked row must be left alone (forward-only).
    insertTokenUsage({ agent: 'a', session_id: 's1', timestamp: T0_SEC + 150, dispatch_id: 'MANUAL' })
    correlateTokenUsageToDispatches(db)
    const s1: any = db.prepare("SELECT dispatch_id FROM token_usage WHERE session_id='s1'").get()
    expect(s1.dispatch_id).toBe('MANUAL') // not overwritten
    const s2: any = db.prepare("SELECT dispatch_id FROM token_usage WHERE session_id='s2'").get()
    expect(s2.dispatch_id).not.toBe(d1) // never attributed across sessions
  })

  it('skips dispatches with no session_id (cannot be placed, never guessed)', () => {
    const db = getDb()
    createDispatch(db, { source: 'kanban', agent: 'a', cardId: 'c1' }, ms(T0_SEC + 100)) // no session_id
    insertTokenUsage({ agent: 'a', session_id: 's1', timestamp: T0_SEC + 150 })
    expect(correlateTokenUsageToDispatches(db)).toBe(0)
  })
})

describe('P2-A billingMode from config (NO provider-name heuristic)', () => {
  const map: BillingMap = {
    entries: [
      { provider: 'anthropic', auth_profile: 'max-subscription', billing_mode: 'subscription_included' },
      { provider: 'anthropic', auth_profile: 'api-key', billing_mode: 'api_payg' },
    ],
  }

  it('resolves from the (provider, auth_profile) config entry', () => {
    expect(resolveBillingMode(map, 'anthropic', 'max-subscription')).toBe('subscription_included')
    expect(resolveBillingMode(map, 'anthropic', 'api-key')).toBe('api_payg')
  })

  it('missing config -> unknown, never a false free/not_billed', () => {
    expect(resolveBillingMode(null, 'anthropic', 'max-subscription')).toBe('unknown')
    expect(resolveBillingMode({ entries: [] }, 'anthropic', 'max-subscription')).toBe('unknown')
    expect(resolveBillingMode(map, 'anthropic', 'unmapped-profile')).toBe('unknown')
    expect(resolveBillingMode(map, 'openai', 'api-key')).toBe('unknown')
    expect(resolveBillingMode(map, null, null)).toBe('unknown')
  })

  // GUARD: this test FAILS if billingMode were ever derived from the provider
  // NAME (e.g. "anthropic" -> subscription). With an EMPTY map, a name-based
  // heuristic would return subscription_included; the config-only rule returns
  // unknown. This is the "prove a guard can matter" test.
  it('does NOT infer billing from the provider name (empty map => unknown for a well-known provider)', () => {
    expect(resolveBillingMode({ entries: [] }, 'anthropic', 'max-subscription')).toBe('unknown')
    expect(resolveBillingMode({ entries: [] }, 'openai', 'chatgpt-plus')).toBe('unknown')
  })

  it('loadBillingMap reads a file, and missing file -> null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2a-billing-'))
    try {
      const p = join(dir, 'billing-map.json')
      writeFileSync(p, JSON.stringify(map))
      const loaded = loadBillingMap(p)
      expect(loaded?.entries.length).toBe(2)
      expect(resolveBillingMode(loaded, 'anthropic', 'api-key')).toBe('api_payg')
      expect(loadBillingMap(join(dir, 'does-not-exist.json'))).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('P2-A outcome rules', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('accepted comes from kanban status->done for carded dispatches', () => {
    const db = getDb()
    const id = createDispatch(db, { source: 'kanban', agent: 'buildfejleszto', cardId: 'card-1' }, ms(T0_SEC))
    expect(resolveOutcome(db, id)).toBe('unknown') // no outcome yet
    const n = recordAcceptedOutcomeForCard(db, 'card-1', ms(T0_SEC + 5))
    expect(n).toBe(1)
    expect(resolveOutcome(db, id)).toBe('accepted')
  })

  it('is idempotent and never backfills a card that was never instrumented', () => {
    const db = getDb()
    const id = createDispatch(db, { source: 'kanban', agent: 'a', cardId: 'card-1' }, ms(T0_SEC))
    recordAcceptedOutcomeForCard(db, 'card-1', ms(T0_SEC + 5))
    expect(recordAcceptedOutcomeForCard(db, 'card-1', ms(T0_SEC + 6))).toBe(0) // idempotent
    // A card with no dispatch row gets zero outcomes -- no invented history.
    expect(recordAcceptedOutcomeForCard(db, 'never-dispatched', ms(T0_SEC + 7))).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM dispatch_outcomes').get()).toEqual({ n: 1 })
    expect(resolveOutcome(db, id)).toBe('accepted')
  })

  it('unknown is the default for any dispatch without an outcome row', () => {
    const db = getDb()
    const id = createDispatch(db, { source: 'message', agent: 'a' }, ms(T0_SEC))
    expect(resolveOutcome(db, id)).toBe('unknown')
  })
})

describe('P2-A pricing (reused from pricing.ts) + cost_per_accepted_task', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('estimateModelCost prices per 1M tokens; unpriced model -> null (never a fake 0)', () => {
    // 1,000,000 input @ $15/1M = $15 exactly.
    expect(estimateModelCost(pricing, 'claude-opus-4-8', { input: 1_000_000, output: 0 })).toBeCloseTo(15, 6)
    expect(estimateModelCost(pricing, 'claude-opus-4-8', { input: 0, output: 1_000_000 })).toBeCloseTo(75, 6)
    // GUARD: an unpriced model is UNKNOWN (null), not falsely free (0).
    expect(estimateModelCost(pricing, 'some-unlisted-model', { input: 1_000_000, output: 0 })).toBeNull()
    expect(estimateModelCost(pricing, null, { input: 10, output: 10 })).toBeNull()
  })

  it('joins accepted dispatches -> token_usage -> pricing and returns MARGINAL and ALLOCATED separately', () => {
    const db = getDb()
    // Two accepted dispatches for buildfejleszto on anthropic/opus, same period.
    const d1 = createDispatch(db, { source: 'kanban', agent: 'buildfejleszto', cardId: 'c1', provider: 'anthropic', runtimeModel: 'claude-opus-4-8', modelProfile: 'default', taskType: 'build', project: 'MK', billingMode: 'subscription_included' }, ms(T0_SEC))
    const d2 = createDispatch(db, { source: 'kanban', agent: 'buildfejleszto', cardId: 'c2', provider: 'anthropic', runtimeModel: 'claude-opus-4-8', modelProfile: 'default', taskType: 'build', project: 'MK', billingMode: 'subscription_included' }, ms(T0_SEC))
    recordAcceptedOutcomeForCard(db, 'c1', ms(T0_SEC))
    recordAcceptedOutcomeForCard(db, 'c2', ms(T0_SEC))
    insertTokenUsage({ agent: 'buildfejleszto', session_id: 's', timestamp: T0_SEC + 1, input: 1_000_000, output: 0, model: 'claude-opus-4-8', dispatch_id: d1 })
    insertTokenUsage({ agent: 'buildfejleszto', session_id: 's', timestamp: T0_SEC + 2, input: 1_000_000, output: 0, model: 'claude-opus-4-8', dispatch_id: d2 })

    // Subscription cost line for anthropic in this month -> allocated base.
    const monthStart = Math.floor(Date.UTC(2026, 6, 1) / 1000)
    const monthEnd = Math.floor(Date.UTC(2026, 7, 1) / 1000)
    db.prepare(`INSERT INTO cost_sources (id, name, provider, source_type, currency, active, created_at, updated_at) VALUES ('src-anthropic','Claude Max','anthropic','subscription','USD',1,?,?)`).run(T0_SEC, T0_SEC)
    db.prepare(`INSERT INTO cost_line_items (source_id, charge_period_start, charge_period_end, charge_category, billed_cost, currency, confidence, data_freshness, dedup_key, created_at) VALUES ('src-anthropic', ?, ?, 'subscription', 100, 'USD', 'manual', ?, 'k', ?)`).run(monthStart, monthEnd, T0_SEC, T0_SEC)

    const rows = costPerAcceptedTask(db, { pricing })
    expect(rows.length).toBe(1)
    const g = rows[0]
    expect(g.agent).toBe('buildfejleszto')
    expect(g.model).toBe('claude-opus-4-8')
    expect(g.provider).toBe('anthropic')
    expect(g.billingMode).toBe('subscription_included')
    expect(g.period).toBe('2026-07')
    expect(g.acceptedTasks).toBe(2)
    // MARGINAL: 2 * $15 execution cost = $30, per task $15.
    expect(g.marginalCost).toBeCloseTo(30, 4)
    expect(g.marginalCostPerTask).toBeCloseTo(15, 4)
    // ALLOCATED: $100 subscription / 2 accepted tasks = $50 per task. Distinct
    // from marginal -- the two values are never mixed.
    expect(g.allocatedCostPerTask).toBeCloseTo(50, 4)
    expect(g.allocatedCostPerTask).not.toBe(g.marginalCostPerTask)
  })

  it('computes for research too, and unpriced model keeps marginal null while accepted still counts', () => {
    const db = getDb()
    const d = createDispatch(db, { source: 'scheduler', agent: 'research', cardId: 'r1', provider: 'anthropic', runtimeModel: 'unlisted-model', taskType: 'research' }, ms(T0_SEC))
    recordAcceptedOutcomeForCard(db, 'r1', ms(T0_SEC))
    insertTokenUsage({ agent: 'research', session_id: 's', timestamp: T0_SEC + 1, input: 500_000, output: 0, model: 'unlisted-model', dispatch_id: d })
    const rows = costPerAcceptedTask(db, { pricing })
    expect(rows.length).toBe(1)
    expect(rows[0].agent).toBe('research')
    expect(rows[0].acceptedTasks).toBe(1)
    expect(rows[0].marginalCost).toBeNull() // unpriced -> unknown, not 0
  })

  it('only accepted dispatches are counted (unknown-outcome dispatches are excluded)', () => {
    const db = getDb()
    const d = createDispatch(db, { source: 'kanban', agent: 'buildfejleszto', cardId: 'c1', provider: 'anthropic', runtimeModel: 'claude-opus-4-8' }, ms(T0_SEC))
    insertTokenUsage({ agent: 'buildfejleszto', session_id: 's', timestamp: T0_SEC + 1, input: 1_000_000, output: 0, model: 'claude-opus-4-8', dispatch_id: d })
    // No outcome recorded -> not accepted -> not in the result set.
    expect(costPerAcceptedTask(db, { pricing })).toEqual([])
  })
})

describe('P2-A message-carry of dispatch_id (DB layer)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('createAgentMessage persists dispatch_id and getPendingMessages returns it', () => {
    const id = createDispatch(getDb(), { source: 'kanban', agent: 'buildfejleszto', cardId: 'c1' }, ms(T0_SEC))
    const m = createAgentMessage('marveen', 'buildfejleszto', 'hello', null, null, id)
    expect(m.dispatch_id).toBe(id)
    const pending = getPendingMessages('buildfejleszto')
    expect(pending[0].dispatch_id).toBe(id)
  })

  it('a message created without a dispatch_id stays null (un-instrumented)', () => {
    const m = createAgentMessage('marveen', 'buildfejleszto', 'hi')
    expect(m.dispatch_id).toBeNull()
  })
})

afterEach(() => {})

// P2-A hard constraint (program principle 20): if the measurement/optimizer layer
// faults, the agent's normal dispatch path MUST still work. createDispatchSafe is
// that seam -- a measurement fault returns null instead of propagating. Without
// this test the try/catch could be refactored away and nothing would notice.
describe('P2-A measurement faults never block a dispatch', () => {
  it('createDispatchSafe returns null instead of throwing when the write fails', () => {
    const broken = { prepare() { throw new Error('simulated measurement failure (disk/schema fault)') } } as never
    let result: string | null | undefined
    expect(() => {
      result = createDispatchSafe(broken, { source: 'message', agent: 'buildfejleszto' }, ms(T0_SEC))
    }).not.toThrow()
    expect(result).toBeNull()
  })

  it('createDispatch (unsafe) DOES throw -- proving the safe wrapper is what isolates the fault', () => {
    const broken = { prepare() { throw new Error('simulated measurement failure') } } as never
    expect(() => createDispatch(broken, { source: 'message', agent: 'buildfejleszto' }, ms(T0_SEC))).toThrow()
  })
})
