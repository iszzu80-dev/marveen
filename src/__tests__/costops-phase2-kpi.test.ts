// P2-C: the Phase 2 KPI read surface.
//
// THE ONE RULE UNDER TEST: a KPI with no data behind it returns an explicit
// `unknown` carrying the denominator it was missing -- never a 0. On a dashboard a
// "0% failure rate" because nothing failed and a "0% failure rate" because no
// outcome was ever recorded are the same pixels and opposite facts, and only one of
// them should let an acceptance step proceed.
//
// The second rule: MARGINAL and ALLOCATED cost never merge, and the maths is not
// reimplemented -- costPerAcceptedTask() in dispatch.ts stays the only
// implementation.
//
// RED-ABILITY:
//  * make any unknown() return `value: 0` / state 'measured' -> tests 1-5 go red
//  * merge marginal and allocated into one figure            -> test 6 goes red
//  * make fallback_rate report 0 with no routing_events       -> test 7 goes red
//  * count saturation events off routing_events.capacity_state (which
//    createDispatch hardcodes to 'normal')                    -> test 8 goes red

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { buildPhase2Kpis, KPI_GROUP_BY } from '../costops/kpi.js'
import { createDispatch, recordOutcome, insertRoutingEvent } from '../costops/dispatch.js'
import { recordPacketMetadata } from '../costops/packet-metadata.js'
import { recordSaturationEvent } from '../costops/saturation-events.js'
import type { PricingConfig } from '../costops/pricing.js'

const NOW = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000)
const FROM = Math.floor(Date.UTC(2026, 6, 1) / 1000)
const TO = Math.floor(Date.UTC(2026, 7, 1) / 1000)

// A minimal priced model so marginal cost is computable where we want it to be.
const PRICING = {
  version: 1,
  currency: 'USD',
  models: { 'test-model': { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75 } },
} as unknown as PricingConfig

function kpis(opts: { pricing?: PricingConfig | null } = {}) {
  return buildPhase2Kpis(getDb(), { from: FROM, to: TO, now: NOW, pricing: opts.pricing ?? PRICING })
}

function makeDispatch(over: Partial<Parameters<typeof createDispatch>[1]> = {}, at = NOW): string {
  return createDispatch(getDb(), {
    source: 'kanban', agent: 'agent-a', project: 'proj', taskType: 'build',
    modelProfile: 'profile-x', runtimeModel: 'test-model', provider: 'anthropic',
    authProfile: 'sub', billingMode: 'subscription_included',
    ...over,
  } as Parameters<typeof createDispatch>[1], at * 1000)
}

function addTokenRow(dispatchId: string, input: number, output: number, at = NOW): void {
  getDb().prepare(`
    INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, model, dispatch_id)
    VALUES ('agent-a','s1', ?, ?, ?, 0, 0, 'test-model', ?)
  `).run(at, input, output, dispatchId)
}

describe('P2-C KPI surface: empty states are UNKNOWN, never 0', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('0. exposes exactly the required group-by dimensions', () => {
    expect(KPI_GROUP_BY).toEqual([
      'agent', 'modelProfile', 'model', 'provider', 'task_type', 'project', 'billingMode', 'period',
    ])
  })

  it('1. a completely empty database returns no rows and says every KPI is unknown', () => {
    const r = kpis()
    expect(r.rows).toEqual([])
    expect(r.totals.dispatches).toBe(0)
    expect(r.notes.join(' ')).toMatch(/unknown rather than 0/)
  })

  it('2. dispatches with NO outcome: acceptance/retry/failure are unknown, not 0', () => {
    makeDispatch()
    makeDispatch()
    const row = kpis().rows[0]
    expect(row.dispatches).toBe(2)
    expect(row.completed_tasks).toBe(0)

    for (const k of ['first_pass_completion', 'retry_rate', 'failure_rate'] as const) {
      expect(row[k].value).toBeNull()
      expect(row[k].state).toBe('unknown')
      expect(row[k].sample_size).toBe(0)
      expect(row[k].blocker).toBeTruthy()
    }
    // The specific trap: an absent outcome row is not a rejection.
    expect(row.first_pass_completion.blocker).toMatch(/not a rejection/)
  })

  it('3. accepted but no attributed tokens: marginal cost and tokens-per-task are unknown, not 0', () => {
    const d = makeDispatch()
    recordOutcome(getDb(), { dispatchId: d, outcome: 'accepted' }, NOW * 1000)
    const row = kpis().rows[0]
    expect(row.completed_tasks).toBe(1)
    expect(row.cost_per_completed_task.marginal.value).toBeNull()
    expect(row.cost_per_completed_task.marginal.state).toBe('unknown')
    expect(row.cost_per_completed_task.marginal.blocker).toMatch(/no priced token_usage/)
    expect(row.tokens_per_completed_task.value).toBeNull()
    expect(row.tokens_per_completed_task.blocker).toMatch(/no token_usage row/)
  })

  it('3b. an UNPRICED model leaves marginal cost unknown even though tokens exist', () => {
    const d = makeDispatch({ runtimeModel: 'model-with-no-price' })
    recordOutcome(getDb(), { dispatchId: d, outcome: 'accepted' }, NOW * 1000)
    addTokenRow(d, 1_000_000, 100_000)
    const row = kpis().rows[0]
    // Tokens ARE measured; the money is not, and the two do not contaminate each other.
    expect(row.tokens_per_completed_task.value).toBe(1_100_000)
    expect(row.cost_per_completed_task.marginal.value).toBeNull()
    expect(row.cost_per_completed_task.marginal.state).toBe('unknown')
  })

  it('4. no subscription cost line: ALLOCATED is unknown, not 0', () => {
    const d = makeDispatch()
    recordOutcome(getDb(), { dispatchId: d, outcome: 'accepted' }, NOW * 1000)
    const row = kpis().rows[0]
    expect(row.cost_per_completed_task.allocated.value).toBeNull()
    expect(row.cost_per_completed_task.allocated.state).toBe('unknown')
    expect(row.cost_per_completed_task.allocated.blocker).toMatch(/nothing can be allocated/)
  })

  it('5. no packet metadata: context_packet_fresh_tokens is unknown, not 0', () => {
    makeDispatch()
    const row = kpis().rows[0]
    expect(row.context_packet_fresh_tokens.value).toBeNull()
    expect(row.context_packet_fresh_tokens.state).toBe('unknown')
    expect(row.context_packet_fresh_tokens.blocker).toMatch(/no context-packet metadata/)
  })

  it('5b. packet tokens are reported as ESTIMATED, carrying the confidence markers seen', () => {
    const d = makeDispatch()
    recordPacketMetadata(getDb(), d, {
      packetVersion: 'v1', estimatedFreshTokens: 4200, estimateConfidence: 'heuristic',
      estimateMethod: 'chars/4', taskSize: 'normal', contextBudgetClass: 'standard',
      referencedArtifacts: [], contentHashes: [],
    }, NOW * 1000)
    const row = kpis().rows[0]
    expect(row.context_packet_fresh_tokens.value).toBe(4200)
    // Never 'measured': a packet token count is an estimate by construction.
    expect(row.context_packet_fresh_tokens.state).toBe('estimated')
    expect(row.context_packet_fresh_tokens.blocker).toMatch(/heuristic/)
  })

  it('6. MARGINAL and ALLOCATED are separate figures and are never combined', () => {
    const d = makeDispatch()
    recordOutcome(getDb(), { dispatchId: d, outcome: 'accepted' }, NOW * 1000)
    addTokenRow(d, 1_000_000, 100_000)

    const db = getDb()
    // A real subscription line for this provider/period, so ALLOCATED is computable.
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
      VALUES ('anthropic-sub','Sub','anthropic','subscription','HUF',1,?,?)`).run(NOW, NOW)
    db.prepare(`INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,
      service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at)
      VALUES ('anthropic-sub',?,?,'subscription','Sub',9000,'HUF','manual',?,'sub|2026-07',?)`).run(FROM, TO, NOW, NOW)

    const row = kpis().rows[0]
    const marginal = row.cost_per_completed_task.marginal
    const allocated = row.cost_per_completed_task.allocated
    expect(marginal.value).not.toBeNull()
    expect(allocated.value).not.toBeNull()
    expect(marginal.state).toBe('measured')
    expect(allocated.state).toBe('measured')
    // Two distinct numbers on two distinct scales -- not summed, not averaged.
    expect(marginal.value).not.toBe(allocated.value)
    expect(allocated.value).toBe(9000)
    // 1M input @3 + 0.1M output @15 = 3 + 1.5 = 4.5 (dispatch.ts's own maths).
    expect(marginal.value).toBeCloseTo(4.5, 4)
    expect(row).not.toHaveProperty('cost_per_task')  // no merged figure exists
  })

  it('6b. acceptance/retry/failure become measured once outcomes exist', () => {
    const a = makeDispatch()
    const b = makeDispatch()
    const c = makeDispatch()
    recordOutcome(getDb(), { dispatchId: a, outcome: 'accepted' }, NOW * 1000)
    recordOutcome(getDb(), { dispatchId: b, outcome: 'retry' }, NOW * 1000)
    recordOutcome(getDb(), { dispatchId: b, outcome: 'accepted' }, NOW * 1000)
    recordOutcome(getDb(), { dispatchId: c, outcome: 'failed' }, NOW * 1000)

    const row = kpis().rows[0]
    expect(row.dispatches).toBe(3)
    expect(row.completed_tasks).toBe(2)
    // a was accepted with no retry; b was accepted but retried => not first pass.
    expect(row.first_pass_completion.state).toBe('measured')
    expect(row.first_pass_completion.value).toBeCloseTo(1 / 3, 4)
    expect(row.retry_rate.value).toBeCloseTo(1 / 3, 4)
    expect(row.failure_rate.value).toBeCloseTo(1 / 3, 4)
    expect(row.first_pass_completion.sample_size).toBe(3)
  })

  it('7. fallback_rate: a measured 0 when routing events exist, unknown when none do', () => {
    // createDispatch writes a default routing_event, so this group HAS observations.
    const d = makeDispatch()
    const withEvents = kpis().rows[0]
    expect(withEvents.fallback_rate.state).toBe('measured')
    expect(withEvents.fallback_rate.value).toBe(0)
    expect(withEvents.fallback_rate.sample_size).toBeGreaterThan(0)

    // Strip the routing events: the same 0 is now UNOBSERVED, and must say so.
    getDb().prepare('DELETE FROM routing_events').run()
    const withoutEvents = kpis().rows[0]
    expect(withoutEvents.fallback_rate.value).toBeNull()
    expect(withoutEvents.fallback_rate.state).toBe('unknown')
    expect(withoutEvents.fallback_rate.blocker).toMatch(/not a measurement/)

    // And a real fallback would be counted if one ever existed.
    insertRoutingEvent(getDb(), { dispatchId: d, agent: 'agent-a', fallbackUsed: 1 }, NOW)
    expect(kpis().rows[0].fallback_rate.value).toBe(1)
  })

  it('8. context_saturation_events comes from MEASURED gate observations, not from capacity_state', () => {
    const d = makeDispatch()
    // The trap: createDispatch hardcodes routing_events.capacity_state = 'normal'
    // regardless of real saturation, so a KPI built on it would report a confident,
    // measured-looking 0 that measures nothing.
    const cs = getDb().prepare('SELECT capacity_state FROM routing_events WHERE dispatch_id = ?').get(d) as { capacity_state: string }
    expect(cs.capacity_state).toBe('normal')

    const before = kpis().rows[0]
    expect(before.context_saturation_events.value).toBeNull()
    expect(before.context_saturation_events.state).toBe('unknown')
    expect(before.context_saturation_events.scope).toBe('agent_period')
    expect(before.context_saturation_events.blocker).toMatch(/never observed anything/)

    // Two real observations for this agent, one of which is a saturation event.
    recordSaturationEvent(getDb(), { agent: 'agent-a', state: 'ok', pct: 0.2, admitted: true, measured: true }, NOW * 1000)
    recordSaturationEvent(getDb(), { agent: 'agent-a', state: 'checkpoint_required', pct: 0.88, admitted: false, measured: true }, NOW * 1000)
    const after = kpis().rows[0]
    expect(after.context_saturation_events.state).toBe('measured')
    expect(after.context_saturation_events.value).toBe(1)
    expect(after.context_saturation_events.sample_size).toBe(2)
  })

  it('8b. a FAIL-OPEN gate default is not recorded as an observation', () => {
    makeDispatch()
    // measured: false is what evaluateDispatchAdmissionSafe returns when it could
    // not read the real signal. Storing it would manufacture reassuring data.
    expect(recordSaturationEvent(getDb(), { agent: 'agent-a', state: 'ok', pct: null, admitted: true, measured: false }, NOW * 1000)).toBe(false)
    const row = kpis().rows[0]
    expect(row.context_saturation_events.state).toBe('unknown')
  })

  it('9. groups split on every dimension, and each group keeps its own KPIs', () => {
    const a = makeDispatch({ agent: 'agent-a', provider: 'anthropic' })
    const b = makeDispatch({ agent: 'agent-b', provider: 'openai', runtimeModel: 'other-model' })
    recordOutcome(getDb(), { dispatchId: a, outcome: 'accepted' }, NOW * 1000)
    recordOutcome(getDb(), { dispatchId: b, outcome: 'failed' }, NOW * 1000)

    const rows = kpis().rows
    expect(rows).toHaveLength(2)
    const byAgent = new Map(rows.map(r => [r.agent, r]))
    expect(byAgent.get('agent-a')!.first_pass_completion.value).toBe(1)
    expect(byAgent.get('agent-b')!.first_pass_completion.value).toBe(0)
    expect(byAgent.get('agent-b')!.failure_rate.value).toBe(1)
    expect(byAgent.get('agent-a')!.model).toBe('test-model')
    expect(byAgent.get('agent-b')!.model).toBe('other-model')
    expect(byAgent.get('agent-a')!.period).toBe('2026-07')
  })

  it('10. a dispatch with SEVERAL token rows is still one accepted task', () => {
    const d = makeDispatch()
    recordOutcome(getDb(), { dispatchId: d, outcome: 'accepted' }, NOW * 1000)
    addTokenRow(d, 500_000, 50_000)
    addTokenRow(d, 500_000, 50_000, NOW + 10)
    const row = kpis().rows[0]
    expect(row.completed_tasks).toBe(1)
    expect(row.dispatches).toBe(1)
    // Tokens are summed, the denominator is not inflated.
    expect(row.tokens_per_completed_task.value).toBe(1_100_000)
  })

  it('11. missing P2-A tables => an honest empty surface, not a crash', () => {
    getDb().exec('DROP TABLE dispatches')
    const r = kpis()
    expect(r.rows).toEqual([])
    expect(r.notes.join(' ')).toMatch(/not present on this database/)
  })
})
