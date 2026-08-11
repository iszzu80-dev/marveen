// CostOps Phase 4 -- Marveen-specific benchmark pack.
//
// What Marveen's own workloads actually cost per unit of delivered work.
// Reuses Phase 2's costPerAcceptedTask() (dispatch.ts) -- MARGINAL (real
// token spend) and ALLOCATED (prorated subscription) stay separate fields,
// exactly as dispatch.ts already enforces; this module adds NO new
// measurement and reimplements none of that math, it only filters and
// labels dispatch.ts's own output for agent === 'marveen'.
//
// The attribution limits below are NOT new findings -- they were established
// and test-pinned during Phase 2 (see
// docs/optimization/lean-optimization-phase-2-as-built.md, point 5) and are
// carried forward here as fixed caveats attached to every report, so a
// benchmark reader never mistakes this pack's numbers for a complete
// accounting of Marveen's actual cost.
import { costPerAcceptedTask } from './dispatch.js';
export const MARVEEN_BENCHMARK_CAVEATS = [
    'A session restart mid-package leaves later tokens UNATTRIBUTED -- marginal cost here is under-attributed (silently low), never overstated.',
    'Remote agents and scheduled tasks with a targetSession override stay NULL by design -- never guessed.',
    "The worker link is INERT: a worker sub-agent's own project directory sits outside the token_usage mapping, so its tokens are not separately attributed here (they fold into the parent dispatch package instead).",
    'marginal and allocated cost per task are separate figures (see dispatch.ts) and must never be summed or averaged together.',
];
function round2(n) {
    return Math.round(n * 100) / 100;
}
/**
 * Builds Marveen's own benchmark pack: costPerAcceptedTask() filtered to
 * agent === 'marveen'. `now` is caller-supplied, never read from the clock in
 * here.
 */
export function buildMarveenBenchmarkPack(db, now, opts = {}) {
    const all = costPerAcceptedTask(db, opts);
    const groups = all.filter(g => g.agent === 'marveen');
    const accepted_tasks = groups.reduce((s, g) => s + g.acceptedTasks, 0);
    const knownMarginal = groups.filter(g => g.marginalCost !== null);
    const marginal_cost = knownMarginal.length > 0
        ? round2(knownMarginal.reduce((s, g) => s + (g.marginalCost ?? 0), 0))
        : null;
    return {
        window: { from: opts.from ?? null, to: opts.to ?? null },
        groups,
        totals: { accepted_tasks, marginal_cost, marginal_cost_known_groups: knownMarginal.length },
        caveats: MARVEEN_BENCHMARK_CAVEATS,
        generated_at: now,
    };
}
