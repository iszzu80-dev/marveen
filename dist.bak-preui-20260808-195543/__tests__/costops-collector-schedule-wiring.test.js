// P2-C gate closure: the provider collectors are INVOKED periodically, in process.
//
// Storage restored is not invocation restored -- P2-A already paid a gate cycle for
// exactly this (correlateTokenUsageToDispatches had storage and no call site). The
// P2-C variant was worse, because the collectors LOOKED wired: there was a
// `POST /api/costs/sync` route and an out-of-repo file-based cron under
// ~/.claude/scheduled-tasks/ that covered four providers. Neither is visible to any
// test in this repository, and the live evidence on 2026-07-30 was that
// provider_ratelimit_snapshots had NEVER received a single row: the codex collector
// had no caller at all, in or out of repo, and neither did the anthropic one.
//
// So this file pins the invocation from three directions:
//   1. behaviour  -- startCostOpsBackgroundTasks() really returns a collector-sync
//      interval, on the documented tick, alongside the daily snapshot one;
//   2. source     -- the seam calls the sweep, and web.ts calls the seam and clears
//      every handle it returns;
//   3. contract   -- the sweep it calls is the fault-isolated variant, so a provider
//      outage cannot take the background loop down.
//
// MUTATION (a): delete the collector-sync interval (or the tick function's call to
// the sweep) and tests 1, 3 and 4 go red.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const read = (rel) => readFileSync(join(__dirname, rel), 'utf-8');
const { initDatabase } = await import('../db.js');
const { startCostOpsBackgroundTasks } = await import('../costops/reliability-observation.js');
const { COLLECTOR_TICK_MS } = await import('../costops/collectors/scheduled-sync.js');
// ---------------------------------------------------------------------------
// 1. Behaviour: the interval exists and is on the documented cadence
// ---------------------------------------------------------------------------
describe('P2-C: the CostOps seam starts a periodic collector sync', () => {
    beforeEach(() => { initDatabase(':memory:'); vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    it('1. startCostOpsBackgroundTasks returns BOTH the daily snapshot interval and the collector-sync interval', () => {
        const handles = startCostOpsBackgroundTasks();
        try {
            // Two distinct cadences: 24h reliability snapshot + the collector due-check.
            // One handle means the collector sync was removed.
            expect(handles).toHaveLength(2);
            expect(handles.every(h => typeof h === 'object' || typeof h === 'number')).toBe(true);
        }
        finally {
            handles.forEach(clearInterval);
        }
    });
    it('2. the collector tick is finer than the finest per-collector cadence', () => {
        // An "hourly" collector that is only asked every 6h is not hourly.
        expect(COLLECTOR_TICK_MS).toBeLessThan(60 * 60 * 1000);
        expect(COLLECTOR_TICK_MS).toBeGreaterThan(60 * 1000); // and not a busy-loop
    });
});
// ---------------------------------------------------------------------------
// 2-3. Source-level wiring
// ---------------------------------------------------------------------------
describe('P2-C: source-level wiring of the collector sync', () => {
    const SEAM = read('../costops/reliability-observation.ts');
    const WEB = read('../web.ts');
    const SWEEP = read('../costops/collectors/scheduled-sync.ts');
    it('3. the seam schedules the sweep AND runs it once at boot', () => {
        const idx = SEAM.indexOf('export function startCostOpsBackgroundTasks(');
        expect(idx).toBeGreaterThan(0);
        const body = SEAM.slice(idx);
        expect(body).toMatch(/collectorSyncTickSafely\(\)/); // boot pass
        expect(body).toMatch(/setInterval\(collectorSyncTickSafely, COLLECTOR_TICK_MS\)/); // periodic
        expect(body).toMatch(/setInterval\(captureNowSafely, SNAPSHOT_INTERVAL_MS\)/); // unchanged daily task
        // The tick must call the FAULT-ISOLATED sweep, not the raw one.
        expect(SEAM).toMatch(/runScheduledCollectorSyncSafe\(getDb\(\), now\)/);
    });
    it('4. web.ts calls the seam and clears every interval it returns', () => {
        expect(WEB).toMatch(/const costOpsBackgroundIntervals = webOnly \? \[\] : startCostOpsBackgroundTasks\(\)/);
        // A single clearInterval would leak the second timer on shutdown.
        expect(WEB).toMatch(/costOpsBackgroundIntervals\.forEach\(clearInterval\)/);
    });
    it('5. the _Safe sweep swallows and logs, never rejects', () => {
        const idx = SWEEP.indexOf('export async function runScheduledCollectorSyncSafe(');
        expect(idx).toBeGreaterThan(0);
        const body = SWEEP.slice(idx);
        expect(body).toMatch(/try \{/);
        expect(body).toMatch(/\} catch \(err\) \{/);
        expect(body).toMatch(/logger\.warn\(/);
        expect(body).toMatch(/return null/);
        expect(body).not.toMatch(/throw/);
    });
    it('6b. the saturation-event writer has a real call site on the dispatch path', () => {
        // Same defect class: a recorder nobody calls leaves the KPI permanently unknown
        // while the code looks finished. The kanban dispatch path is the ONE place the
        // P2-B admission gate produces a measured observation, and it must record BOTH
        // outcomes -- a refusal creates no dispatch row, so it is the case that was
        // invisible before P2-C. The call therefore has to sit BEFORE the refusal return.
        const KANBAN = read('../web/routes/kanban.ts');
        expect(KANBAN).toMatch(/import \{ recordSaturationEventSafe \} from '\.\.\/\.\.\/costops\/saturation-events\.js'/);
        const gateIdx = KANBAN.indexOf('const admission = evaluateDispatchAdmissionSafe(');
        const refusalIdx = KANBAN.indexOf('if (!admission.admit) {', gateIdx);
        const recordIdx = KANBAN.indexOf('recordSaturationEventSafe(', gateIdx);
        expect(gateIdx).toBeGreaterThan(0);
        expect(recordIdx).toBeGreaterThan(gateIdx);
        expect(recordIdx).toBeLessThan(refusalIdx); // both outcomes, not just admissions
        // It must pass the gate's OWN measured flag through, or a fail-open default
        // would be stored as an observation.
        const call = KANBAN.slice(recordIdx, KANBAN.indexOf('})', recordIdx));
        expect(call).toMatch(/measured: admission\.measured/);
        expect(call).toMatch(/admitted: admission\.admit/);
        // Best-effort variant only: measurement may never break a dispatch.
        expect(KANBAN).not.toMatch(/[^e]recordSaturationEvent\(/);
    });
    it('6. the sweep invokes no model: no LLM SDK import, no agent worker, no completion call', () => {
        // Deterministic-only is a programme rule, not a preference. Checked as imports
        // and call shapes rather than bare provider words, because this module
        // legitimately NAMES providers (they are the things it collects from).
        expect(SWEEP).not.toMatch(/from '@anthropic-ai\//);
        expect(SWEEP).not.toMatch(/from 'openai'/);
        expect(SWEEP).not.toMatch(/agent-worker|runViaWorker|runAgent\(/);
        expect(SWEEP).not.toMatch(/chat\.completions|\/v1\/messages|createMessage\(/);
        // And it does not reach the network itself -- the collectors own their fetchers.
        expect(SWEEP).not.toMatch(/\bfetch\(/);
    });
});
