// CostOps Phase 2 / P2-C -- the Phase 2 KPI read surface.
//
// PURPOSE. The Phase 2 acceptance step has to read the programme's KPIs without
// anyone hand-writing SQL across dispatches / dispatch_outcomes / routing_events /
// token_usage / dispatch_packets / dispatch_saturation_events and getting a
// different answer than the last person did.
//
// THE TWO RULES THAT MATTER MORE THAN THE NUMBERS.
//
//  1. cost_per_accepted_task is NEVER mixed. MARGINAL (real token spend) and
//     ALLOCATED (prorated subscription) are separate fields and stay separate. The
//     maths is NOT reimplemented here -- costPerAcceptedTask() in dispatch.ts is
//     the one implementation, and this module joins to its output on the same
//     8-tuple group key.
//
//  2. An absent KPI is `state: 'unknown'` with a `blocker`, never 0. A 0 that
//     means "nothing happened" and a 0 that means "we cannot see it" are the same
//     byte on a dashboard and opposite facts in an acceptance decision. Every
//     empty state here therefore carries the denominator it was missing.
//
// fallback_rate is a genuine measured 0 whenever routing_events exist for a group:
// Phase 2 introduces no routing, so no fallback CAN have occurred, and 0/N with a
// real N is a measurement. With no routing_events at all it is unknown, because
// then we are not observing the fleet, we are just not looking.
//
// Deterministic: SQLite + costops/pricing.ts. No LLM, no network, no secret.

import type Database from 'better-sqlite3'
import { costPerAcceptedTask, type CostPerAcceptedGroup } from './dispatch.js'
import { countSaturationEvents } from './saturation-events.js'
import type { PricingConfig } from './pricing.js'

export type KpiState = 'measured' | 'estimated' | 'unknown'

export interface KpiValue {
  value: number | null
  state: KpiState
  /** The denominator the ratio was computed over. 0 with state 'unknown' = nothing seen. */
  sample_size: number
  /** Why the value is null / only estimated. Null when the value is measured. */
  blocker: string | null
  unit: string | null
}

function measured(value: number, sample: number, unit: string | null = null): KpiValue {
  return { value, state: 'measured', sample_size: sample, blocker: null, unit }
}
function unknown(blocker: string, sample = 0, unit: string | null = null): KpiValue {
  return { value: null, state: 'unknown', sample_size: sample, blocker, unit }
}
function estimated(value: number, sample: number, blocker: string, unit: string | null = null): KpiValue {
  return { value, state: 'estimated', sample_size: sample, blocker, unit }
}

/** Callers MUST have already established denominator > 0 -- there is no 0/0 here. */
function ratio(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10000) / 10000
}

export interface KpiGroupKey {
  agent: string | null
  modelProfile: string | null
  model: string | null
  provider: string | null
  taskType: string | null
  project: string | null
  billingMode: string | null
  period: string
}

export interface KpiGroupRow extends KpiGroupKey {
  dispatches: number
  /**
   * APG 1.9 §15.2 (WP6): WHICH population the per-task figures were divided by.
   * Always 'delivery_completed' on this report -- see `completed_tasks`. Carried
   * explicitly so no reader has to infer it from a field name.
   */
  acceptance_basis: 'delivery_completed'
  /**
   * Dispatches whose work package REACHED ITS END: `producer_completed` (a
   * producer said done) or `accepted` (the APG chain accepted).
   *
   * THIS FIELD WAS CALLED `accepted_tasks`, and the rename is the point. Before
   * WP6 the kanban done handler wrote `accepted` for every finished card, so
   * "accepted tasks" counted producer claims while being named after a
   * verification that had never happened -- §28.16's RED condition, expressed
   * as a KPI. The number is unchanged; only its name now matches what it counts.
   */
  completed_tasks: number
  /**
   * §15.2's second field: dispatches the ACCEPTANCE CHAIN accepted. Zero on this
   * deployment until the chain has a live writer, which is the honest state and
   * is exactly what `done_not_accepted` has been showing all along.
   */
  apg_accepted_tasks: number
  /** MARGINAL and ALLOCATED, never combined into one "cost" number. */
  cost_per_completed_task: { marginal: KpiValue; allocated: KpiValue }
  /** Completed on the first attempt (never retried), over dispatches with any
   *  outcome. Renamed from `first_pass_acceptance` for the reason above: it
   *  measures completion, and calling it acceptance was the claim WP6 removes. */
  first_pass_completion: KpiValue
  /** The §15.2 reading of the same ratio: APG-ACCEPTED on the first attempt. */
  apg_first_pass_acceptance: KpiValue
  retry_rate: KpiValue
  failure_rate: KpiValue
  tokens_per_completed_task: KpiValue
  context_packet_fresh_tokens: KpiValue
  /**
   * Scope note: saturation observations are recorded per AGENT (an admission
   * REFUSAL creates no dispatch, so it has no model/provider/billing dimension at
   * all). This figure is therefore the agent+period count, repeated on each of that
   * agent's group rows -- stated here rather than silently mis-joined.
   */
  context_saturation_events: KpiValue & { scope: 'agent_period' }
  fallback_rate: KpiValue
}

export interface KpiReport {
  generated_at: number
  window: { from: number | null; to: number | null }
  group_by: string[]
  rows: KpiGroupRow[]
  /** Fleet-wide totals, so an empty `rows` is still explainable. */
  totals: {
    dispatches: number
    with_outcome: number
    /** §15.2's first field, fleet-wide: work packages a producer finished. */
    completed: number
    /** §15.2's second field, fleet-wide: work packages the chain accepted. */
    apg_accepted: number
    token_attributed_rows: number
    packet_rows: number
    routing_events: number
    saturation_observations: number
  }
  notes: string[]
}

export const KPI_GROUP_BY: string[] = [
  'agent', 'modelProfile', 'model', 'provider', 'task_type', 'project', 'billingMode', 'period',
]

function periodOf(createdAtSec: number): string {
  const d = new Date(createdAtSec * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function keyOf(k: KpiGroupKey): string {
  return [k.agent, k.modelProfile, k.model, k.provider, k.taskType, k.project, k.billingMode, k.period]
    .map(v => v ?? ' ').join('|')
}

interface DispatchAggRow {
  agent: string | null
  model_profile: string | null
  runtime_model: string | null
  provider: string | null
  task_type: string | null
  project: string | null
  billing_mode: string | null
  created_at: number
  dispatch_id: string
  /** §15.2's first field: the work package ended (producer_completed OR accepted). */
  completed: number
  /** §15.2's second field: the acceptance chain accepted it. */
  apg_accepted: number
  retried: number
  failed: number
  any_outcome: number
  token_rows: number
  total_tokens: number | null
  packet_rows: number
  packet_fresh_tokens: number | null
  packet_estimate_confidences: string | null
  routing_events: number
  fallbacks: number
}

/**
 * Build the Phase 2 KPI report.
 *
 * `from`/`to` are epoch seconds over dispatches.created_at, matching
 * costPerAcceptedTask's own window so the cost columns and the rate columns always
 * describe the same set of dispatches.
 */
export function buildPhase2Kpis(
  db: Database.Database,
  opts: { from?: number; to?: number; pricing?: PricingConfig | null; now?: number } = {},
): KpiReport {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const conds: string[] = []
  const params: unknown[] = []
  if (opts.from) { conds.push('d.created_at >= ?'); params.push(opts.from) }
  if (opts.to) { conds.push('d.created_at < ?'); params.push(opts.to) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  // One row per DISPATCH with its outcome/token/packet/routing facts pre-reduced,
  // so the grouping below never double-counts a dispatch that has several token
  // rows or several outcome rows.
  let rows: DispatchAggRow[] = []
  try {
    rows = db.prepare(`
      SELECT d.agent, d.model_profile, d.runtime_model, d.provider, d.task_type, d.project,
             d.billing_mode, d.created_at, d.dispatch_id,
             -- §15.2 (WP6): the two words are counted SEPARATELY. Before WP6 the
             -- kanban done handler wrote 'accepted' for every finished card, so one
             -- subquery answered both questions and got the second one wrong.
             (SELECT COUNT(*) FROM dispatch_outcomes o WHERE o.dispatch_id = d.dispatch_id
                AND o.outcome IN ('accepted', 'producer_completed')) AS completed,
             (SELECT COUNT(*) FROM dispatch_outcomes o WHERE o.dispatch_id = d.dispatch_id AND o.outcome = 'accepted') AS apg_accepted,
             (SELECT COUNT(*) FROM dispatch_outcomes o WHERE o.dispatch_id = d.dispatch_id AND o.outcome = 'retry') AS retried,
             (SELECT COUNT(*) FROM dispatch_outcomes o WHERE o.dispatch_id = d.dispatch_id AND o.outcome = 'failed') AS failed,
             (SELECT COUNT(*) FROM dispatch_outcomes o WHERE o.dispatch_id = d.dispatch_id) AS any_outcome,
             (SELECT COUNT(*) FROM token_usage tu WHERE tu.dispatch_id = d.dispatch_id) AS token_rows,
             (SELECT SUM(COALESCE(tu.input_tokens,0) + COALESCE(tu.output_tokens,0)
                         + COALESCE(tu.cache_read_tokens,0) + COALESCE(tu.cache_creation_tokens,0))
                FROM token_usage tu WHERE tu.dispatch_id = d.dispatch_id) AS total_tokens,
             (SELECT COUNT(*) FROM dispatch_packets p WHERE p.dispatch_id = d.dispatch_id) AS packet_rows,
             (SELECT SUM(p.estimated_fresh_tokens) FROM dispatch_packets p WHERE p.dispatch_id = d.dispatch_id) AS packet_fresh_tokens,
             (SELECT GROUP_CONCAT(p.estimate_confidence) FROM dispatch_packets p WHERE p.dispatch_id = d.dispatch_id) AS packet_estimate_confidences,
             (SELECT COUNT(*) FROM routing_events r WHERE r.dispatch_id = d.dispatch_id) AS routing_events,
             (SELECT COUNT(*) FROM routing_events r WHERE r.dispatch_id = d.dispatch_id AND r.fallback_used = 1) AS fallbacks
      FROM dispatches d
      ${where}
    `).all(...params) as DispatchAggRow[]
  } catch {
    // A DB without the P2-A/P2-B tables reports an honest empty surface.
    return {
      generated_at: now,
      window: { from: opts.from ?? null, to: opts.to ?? null },
      group_by: KPI_GROUP_BY,
      rows: [],
      totals: {
        dispatches: 0, with_outcome: 0, completed: 0, apg_accepted: 0, token_attributed_rows: 0,
        packet_rows: 0, routing_events: 0, saturation_observations: 0,
      },
      notes: ['the Phase 2 measurement tables are not present on this database; every KPI is unknown'],
    }
  }

  // Cost comes from the ONE implementation, keyed identically.
  const costByKey = new Map<string, CostPerAcceptedGroup>()
  try {
    for (const g of costPerAcceptedTask(db, { pricing: opts.pricing, from: opts.from, to: opts.to })) {
      costByKey.set(keyOf({
        agent: g.agent, modelProfile: g.modelProfile, model: g.model, provider: g.provider,
        taskType: g.taskType, project: g.project, billingMode: g.billingMode, period: g.period,
      }), g)
    }
  } catch { /* no accepted dispatches / no pricing -> every cost figure stays unknown */ }

  interface Acc {
    k: KpiGroupKey
    dispatches: number
    withOutcome: number
    completed: number
    apgAccepted: number
    firstPass: number
    apgFirstPass: number
    retried: number
    failed: number
    tokenRows: number
    totalTokens: number
    completedWithTokens: number
    packetRows: number
    packetFresh: number
    packetConfidences: Set<string>
    routingEvents: number
    fallbacks: number
  }
  const groups = new Map<string, Acc>()
  const agentPeriodSaturation = new Map<string, KpiValue>()

  for (const r of rows) {
    const period = periodOf(r.created_at)
    const k: KpiGroupKey = {
      agent: r.agent, modelProfile: r.model_profile, model: r.runtime_model, provider: r.provider,
      taskType: r.task_type, project: r.project, billingMode: r.billing_mode, period,
    }
    const key = keyOf(k)
    let acc = groups.get(key)
    if (!acc) {
      acc = {
        k, dispatches: 0, withOutcome: 0, completed: 0, apgAccepted: 0,
        firstPass: 0, apgFirstPass: 0, retried: 0, failed: 0,
        tokenRows: 0, totalTokens: 0, completedWithTokens: 0,
        packetRows: 0, packetFresh: 0, packetConfidences: new Set(),
        routingEvents: 0, fallbacks: 0,
      }
      groups.set(key, acc)
    }
    acc.dispatches++
    if (r.any_outcome > 0) acc.withOutcome++
    if (r.completed > 0) {
      acc.completed++
      // First pass = completed AND never retried. A dispatch completed after a
      // retry is still completed; it is just not first-pass.
      if (r.retried === 0) acc.firstPass++
      if (r.token_rows > 0) acc.completedWithTokens++
    }
    if (r.apg_accepted > 0) {
      acc.apgAccepted++
      if (r.retried === 0) acc.apgFirstPass++
    }
    if (r.retried > 0) acc.retried++
    if (r.failed > 0) acc.failed++
    acc.tokenRows += r.token_rows
    if (r.completed > 0) acc.totalTokens += r.total_tokens ?? 0
    acc.packetRows += r.packet_rows
    acc.packetFresh += r.packet_fresh_tokens ?? 0
    for (const c of (r.packet_estimate_confidences ?? '').split(',')) if (c) acc.packetConfidences.add(c)
    acc.routingEvents += r.routing_events
    acc.fallbacks += r.fallbacks
  }

  const totals = {
    dispatches: rows.length,
    with_outcome: rows.filter(r => r.any_outcome > 0).length,
    completed: rows.filter(r => r.completed > 0).length,
    apg_accepted: rows.filter(r => r.apg_accepted > 0).length,
    token_attributed_rows: rows.reduce((s, r) => s + r.token_rows, 0),
    packet_rows: rows.reduce((s, r) => s + r.packet_rows, 0),
    routing_events: rows.reduce((s, r) => s + r.routing_events, 0),
    saturation_observations: 0,
  }
  try {
    totals.saturation_observations = countSaturationEvents(db, { from: opts.from ?? null, to: opts.to ?? null }).observations
  } catch { /* table absent -> stays 0 and every saturation KPI reports unknown */ }

  const out: KpiGroupRow[] = [...groups.values()].map(acc => {
    const cost = costByKey.get(keyOf(acc.k))
    const satKey = `${acc.k.agent ?? ' '}|${acc.k.period}`
    if (!agentPeriodSaturation.has(satKey)) {
      agentPeriodSaturation.set(satKey, saturationKpi(db, acc.k.agent, opts.from ?? null, opts.to ?? null))
    }
    return {
      ...acc.k,
      dispatches: acc.dispatches,
      acceptance_basis: 'delivery_completed',
      completed_tasks: acc.completed,
      apg_accepted_tasks: acc.apgAccepted,
      cost_per_completed_task: {
        marginal: cost?.marginalCostPerTask != null
          ? measured(cost.marginalCostPerTask, acc.completed, 'currency_per_task')
          : unknown(
            acc.completed === 0
              ? 'no completed dispatch in this group, so there is no per-task cost to divide'
              : 'no priced token_usage is attributed to the completed dispatches in this group',
            acc.completed, 'currency_per_task',
          ),
        allocated: cost?.allocatedCostPerTask != null
          ? measured(cost.allocatedCostPerTask, acc.completed, 'currency_per_task')
          : unknown(
            'no subscription cost line exists for this provider and period, so nothing can be allocated',
            acc.completed, 'currency_per_task',
          ),
      },
      first_pass_completion: acc.withOutcome > 0
        ? measured(ratio(acc.firstPass, acc.withOutcome), acc.withOutcome)
        : unknown('no dispatch in this group has a recorded outcome, so completion is unknown (absence of an outcome row is not a rejection)', 0),
      // §15.2's second field as a rate. Deliberately reported as MEASURED zero
      // rather than unknown when outcomes exist: "nothing here was accepted by
      // the acceptance chain" is a measurement, and it is the one this
      // deployment most needs to keep seeing.
      apg_first_pass_acceptance: acc.withOutcome > 0
        ? measured(ratio(acc.apgFirstPass, acc.withOutcome), acc.withOutcome)
        : unknown('no dispatch in this group has a recorded outcome, so APG acceptance is unknown (absence of an outcome row is not a rejection)', 0),
      retry_rate: acc.withOutcome > 0
        ? measured(ratio(acc.retried, acc.withOutcome), acc.withOutcome)
        : unknown('no dispatch in this group has a recorded outcome, so the retry rate is unknown', 0),
      failure_rate: acc.withOutcome > 0
        ? measured(ratio(acc.failed, acc.withOutcome), acc.withOutcome)
        : unknown('no dispatch in this group has a recorded outcome, so the failure rate is unknown', 0),
      tokens_per_completed_task: acc.completedWithTokens > 0
        ? measured(Math.round(acc.totalTokens / acc.completedWithTokens), acc.completedWithTokens, 'tokens')
        : unknown(
          acc.completed === 0
            ? 'no completed dispatch in this group'
            : 'no token_usage row is attributed to any completed dispatch in this group',
          acc.completed, 'tokens',
        ),
      context_packet_fresh_tokens: acc.packetRows > 0
        ? estimated(
          acc.packetFresh, acc.packetRows,
          `context-packet token counts are estimates by construction (confidence markers seen: ${[...acc.packetConfidences].sort().join(', ') || 'none'})`,
          'tokens',
        )
        : unknown('no context-packet metadata was recorded for any dispatch in this group', 0, 'tokens'),
      context_saturation_events: {
        ...agentPeriodSaturation.get(satKey)!,
        scope: 'agent_period' as const,
      },
      fallback_rate: acc.routingEvents > 0
        // A real 0: Phase 2 has no routing, so with N observed routing events the
        // absence of a fallback is measured, not assumed.
        ? measured(ratio(acc.fallbacks, acc.routingEvents), acc.routingEvents)
        : unknown('no routing_event exists for this group, so the fallback rate is unobserved (Phase 2 has no routing, but that is a design fact, not a measurement)', 0),
    }
  })

  const notes: string[] = []
  if (totals.dispatches === 0) notes.push('no dispatch was recorded in this window; every KPI is unknown rather than 0')
  if (totals.with_outcome === 0 && totals.dispatches > 0) {
    notes.push('dispatches exist but none has a recorded outcome, so acceptance/retry/failure rates are unknown -- outcome writing is the missing link, not the work')
  }
  if (totals.token_attributed_rows === 0 && totals.dispatches > 0) {
    notes.push('no token_usage row is attributed to any dispatch in this window, so marginal cost and tokens-per-task are unknown')
  }
  if (totals.saturation_observations === 0) {
    notes.push('the capacity gate recorded no measured saturation observation in this window, so context_saturation_events is unknown, not 0')
  }
  notes.push('fallback_rate is structurally 0 in Phase 2: no runtime routing or fallback exists to measure')

  return {
    generated_at: now,
    window: { from: opts.from ?? null, to: opts.to ?? null },
    group_by: KPI_GROUP_BY,
    rows: out,
    totals,
    notes,
  }
}

function saturationKpi(db: Database.Database, agent: string | null, from: number | null, to: number | null): KpiValue {
  try {
    const c = countSaturationEvents(db, { agent, from, to })
    if (c.observations === 0) {
      return unknown(
        'the capacity gate made no measured observation for this agent in the window, so saturation events are unknown '
        + '(a gate that never observed anything and a fleet with no saturation both produce zero rows)',
        0, 'events',
      )
    }
    return measured(c.events, c.observations, 'events')
  } catch {
    return unknown('the saturation-event table is not available on this database', 0, 'events')
  }
}
