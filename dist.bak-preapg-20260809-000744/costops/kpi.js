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
import { costPerAcceptedTask } from './dispatch.js';
import { countSaturationEvents } from './saturation-events.js';
function measured(value, sample, unit = null) {
    return { value, state: 'measured', sample_size: sample, blocker: null, unit };
}
function unknown(blocker, sample = 0, unit = null) {
    return { value: null, state: 'unknown', sample_size: sample, blocker, unit };
}
function estimated(value, sample, blocker, unit = null) {
    return { value, state: 'estimated', sample_size: sample, blocker, unit };
}
/** Callers MUST have already established denominator > 0 -- there is no 0/0 here. */
function ratio(numerator, denominator) {
    return Math.round((numerator / denominator) * 10000) / 10000;
}
export const KPI_GROUP_BY = [
    'agent', 'modelProfile', 'model', 'provider', 'task_type', 'project', 'billingMode', 'period',
];
function periodOf(createdAtSec) {
    const d = new Date(createdAtSec * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function keyOf(k) {
    return [k.agent, k.modelProfile, k.model, k.provider, k.taskType, k.project, k.billingMode, k.period]
        .map(v => v ?? ' ').join('|');
}
/**
 * Build the Phase 2 KPI report.
 *
 * `from`/`to` are epoch seconds over dispatches.created_at, matching
 * costPerAcceptedTask's own window so the cost columns and the rate columns always
 * describe the same set of dispatches.
 */
export function buildPhase2Kpis(db, opts = {}) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const conds = [];
    const params = [];
    if (opts.from) {
        conds.push('d.created_at >= ?');
        params.push(opts.from);
    }
    if (opts.to) {
        conds.push('d.created_at < ?');
        params.push(opts.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // One row per DISPATCH with its outcome/token/packet/routing facts pre-reduced,
    // so the grouping below never double-counts a dispatch that has several token
    // rows or several outcome rows.
    let rows = [];
    try {
        rows = db.prepare(`
      SELECT d.agent, d.model_profile, d.runtime_model, d.provider, d.task_type, d.project,
             d.billing_mode, d.created_at, d.dispatch_id,
             (SELECT COUNT(*) FROM dispatch_outcomes o WHERE o.dispatch_id = d.dispatch_id AND o.outcome = 'accepted') AS accepted,
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
    `).all(...params);
    }
    catch {
        // A DB without the P2-A/P2-B tables reports an honest empty surface.
        return {
            generated_at: now,
            window: { from: opts.from ?? null, to: opts.to ?? null },
            group_by: KPI_GROUP_BY,
            rows: [],
            totals: {
                dispatches: 0, with_outcome: 0, accepted: 0, token_attributed_rows: 0,
                packet_rows: 0, routing_events: 0, saturation_observations: 0,
            },
            notes: ['the Phase 2 measurement tables are not present on this database; every KPI is unknown'],
        };
    }
    // Cost comes from the ONE implementation, keyed identically.
    const costByKey = new Map();
    try {
        for (const g of costPerAcceptedTask(db, { pricing: opts.pricing, from: opts.from, to: opts.to })) {
            costByKey.set(keyOf({
                agent: g.agent, modelProfile: g.modelProfile, model: g.model, provider: g.provider,
                taskType: g.taskType, project: g.project, billingMode: g.billingMode, period: g.period,
            }), g);
        }
    }
    catch { /* no accepted dispatches / no pricing -> every cost figure stays unknown */ }
    const groups = new Map();
    const agentPeriodSaturation = new Map();
    for (const r of rows) {
        const period = periodOf(r.created_at);
        const k = {
            agent: r.agent, modelProfile: r.model_profile, model: r.runtime_model, provider: r.provider,
            taskType: r.task_type, project: r.project, billingMode: r.billing_mode, period,
        };
        const key = keyOf(k);
        let acc = groups.get(key);
        if (!acc) {
            acc = {
                k, dispatches: 0, withOutcome: 0, accepted: 0, firstPass: 0, retried: 0, failed: 0,
                tokenRows: 0, totalTokens: 0, acceptedWithTokens: 0,
                packetRows: 0, packetFresh: 0, packetConfidences: new Set(),
                routingEvents: 0, fallbacks: 0,
            };
            groups.set(key, acc);
        }
        acc.dispatches++;
        if (r.any_outcome > 0)
            acc.withOutcome++;
        if (r.accepted > 0) {
            acc.accepted++;
            // First pass = accepted AND never retried. A dispatch accepted after a retry
            // is still accepted; it is just not first-pass.
            if (r.retried === 0)
                acc.firstPass++;
            if (r.token_rows > 0)
                acc.acceptedWithTokens++;
        }
        if (r.retried > 0)
            acc.retried++;
        if (r.failed > 0)
            acc.failed++;
        acc.tokenRows += r.token_rows;
        if (r.accepted > 0)
            acc.totalTokens += r.total_tokens ?? 0;
        acc.packetRows += r.packet_rows;
        acc.packetFresh += r.packet_fresh_tokens ?? 0;
        for (const c of (r.packet_estimate_confidences ?? '').split(','))
            if (c)
                acc.packetConfidences.add(c);
        acc.routingEvents += r.routing_events;
        acc.fallbacks += r.fallbacks;
    }
    const totals = {
        dispatches: rows.length,
        with_outcome: rows.filter(r => r.any_outcome > 0).length,
        accepted: rows.filter(r => r.accepted > 0).length,
        token_attributed_rows: rows.reduce((s, r) => s + r.token_rows, 0),
        packet_rows: rows.reduce((s, r) => s + r.packet_rows, 0),
        routing_events: rows.reduce((s, r) => s + r.routing_events, 0),
        saturation_observations: 0,
    };
    try {
        totals.saturation_observations = countSaturationEvents(db, { from: opts.from ?? null, to: opts.to ?? null }).observations;
    }
    catch { /* table absent -> stays 0 and every saturation KPI reports unknown */ }
    const out = [...groups.values()].map(acc => {
        const cost = costByKey.get(keyOf(acc.k));
        const satKey = `${acc.k.agent ?? ' '}|${acc.k.period}`;
        if (!agentPeriodSaturation.has(satKey)) {
            agentPeriodSaturation.set(satKey, saturationKpi(db, acc.k.agent, opts.from ?? null, opts.to ?? null));
        }
        return {
            ...acc.k,
            dispatches: acc.dispatches,
            accepted_tasks: acc.accepted,
            cost_per_accepted_task: {
                marginal: cost?.marginalCostPerTask != null
                    ? measured(cost.marginalCostPerTask, acc.accepted, 'currency_per_task')
                    : unknown(acc.accepted === 0
                        ? 'no accepted dispatch in this group, so there is no per-task cost to divide'
                        : 'no priced token_usage is attributed to the accepted dispatches in this group', acc.accepted, 'currency_per_task'),
                allocated: cost?.allocatedCostPerTask != null
                    ? measured(cost.allocatedCostPerTask, acc.accepted, 'currency_per_task')
                    : unknown('no subscription cost line exists for this provider and period, so nothing can be allocated', acc.accepted, 'currency_per_task'),
            },
            first_pass_acceptance: acc.withOutcome > 0
                ? measured(ratio(acc.firstPass, acc.withOutcome), acc.withOutcome)
                : unknown('no dispatch in this group has a recorded outcome, so acceptance is unknown (absence of an outcome row is not a rejection)', 0),
            retry_rate: acc.withOutcome > 0
                ? measured(ratio(acc.retried, acc.withOutcome), acc.withOutcome)
                : unknown('no dispatch in this group has a recorded outcome, so the retry rate is unknown', 0),
            failure_rate: acc.withOutcome > 0
                ? measured(ratio(acc.failed, acc.withOutcome), acc.withOutcome)
                : unknown('no dispatch in this group has a recorded outcome, so the failure rate is unknown', 0),
            tokens_per_accepted_task: acc.acceptedWithTokens > 0
                ? measured(Math.round(acc.totalTokens / acc.acceptedWithTokens), acc.acceptedWithTokens, 'tokens')
                : unknown(acc.accepted === 0
                    ? 'no accepted dispatch in this group'
                    : 'no token_usage row is attributed to any accepted dispatch in this group', acc.accepted, 'tokens'),
            context_packet_fresh_tokens: acc.packetRows > 0
                ? estimated(acc.packetFresh, acc.packetRows, `context-packet token counts are estimates by construction (confidence markers seen: ${[...acc.packetConfidences].sort().join(', ') || 'none'})`, 'tokens')
                : unknown('no context-packet metadata was recorded for any dispatch in this group', 0, 'tokens'),
            context_saturation_events: {
                ...agentPeriodSaturation.get(satKey),
                scope: 'agent_period',
            },
            fallback_rate: acc.routingEvents > 0
                // A real 0: Phase 2 has no routing, so with N observed routing events the
                // absence of a fallback is measured, not assumed.
                ? measured(ratio(acc.fallbacks, acc.routingEvents), acc.routingEvents)
                : unknown('no routing_event exists for this group, so the fallback rate is unobserved (Phase 2 has no routing, but that is a design fact, not a measurement)', 0),
        };
    });
    const notes = [];
    if (totals.dispatches === 0)
        notes.push('no dispatch was recorded in this window; every KPI is unknown rather than 0');
    if (totals.with_outcome === 0 && totals.dispatches > 0) {
        notes.push('dispatches exist but none has a recorded outcome, so acceptance/retry/failure rates are unknown -- outcome writing is the missing link, not the work');
    }
    if (totals.token_attributed_rows === 0 && totals.dispatches > 0) {
        notes.push('no token_usage row is attributed to any dispatch in this window, so marginal cost and tokens-per-task are unknown');
    }
    if (totals.saturation_observations === 0) {
        notes.push('the capacity gate recorded no measured saturation observation in this window, so context_saturation_events is unknown, not 0');
    }
    notes.push('fallback_rate is structurally 0 in Phase 2: no runtime routing or fallback exists to measure');
    return {
        generated_at: now,
        window: { from: opts.from ?? null, to: opts.to ?? null },
        group_by: KPI_GROUP_BY,
        rows: out,
        totals,
        notes,
    };
}
function saturationKpi(db, agent, from, to) {
    try {
        const c = countSaturationEvents(db, { agent, from, to });
        if (c.observations === 0) {
            return unknown('the capacity gate made no measured observation for this agent in the window, so saturation events are unknown '
                + '(a gate that never observed anything and a fleet with no saturation both produce zero rows)', 0, 'events');
        }
        return measured(c.events, c.observations, 'events');
    }
    catch {
        return unknown('the saturation-event table is not available on this database', 0, 'events');
    }
}
