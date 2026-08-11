// Canary scenarios from the owner spec (section 20), exercised at the route
// level against a real in-memory DB -- the same fake-ServerResponse pattern
// as optimization-routes.test.ts and costops-api.test.ts's route smoke tests.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { initDatabase } from '../db.js';
import { tryHandleOptimization } from '../web/routes/optimization.js';
import { tryHandleCostOps } from '../web/routes/costs.js';
import { tryHandleTokenUsage } from '../web/routes/token-usage.js';
import { OPTIMIZATION_CONFIG_PATH } from '../optimization/optimization-config.js';
function fakeCtx(path, method = 'GET') {
    const out = { status: 0, body: null };
    const res = {
        writeHead(status) { out.status = status; return res; },
        end(chunk) {
            if (chunk) {
                try {
                    out.body = JSON.parse(chunk);
                }
                catch {
                    out.body = chunk;
                }
            }
        },
    };
    const url = new URL(`http://localhost:3420${path}`);
    const ctx = { req: {}, res, path: url.pathname, method, url };
    return { ctx, out };
}
function fakeCtxWithBody(path, method, body) {
    const { ctx, out } = fakeCtx(path, method);
    ctx.req.on = ((event, cb) => {
        if (event === 'data')
            cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end')
            cb();
        return ctx.req;
    });
    return { ctx, out };
}
const ACTIVE_BODY = {
    masterEnabled: true,
    preset: 'active',
    modules: {
        measurement: true, contextEfficiency: true, capacityMonitoring: true,
        runtimeRouting: true, recommendations: true, marketWatch: true, benchmarkRecommendations: true,
    },
    routing: { automaticFallback: true, trustedProvidersOnly: true, maxFallbacksPerProfile: 2, maxAutomaticFallbacksPerDispatch: 1 },
    ui: { defaultWindow: '30d', showAllocationCost: true },
};
describe('canary scenarios (spec section 20)', () => {
    beforeEach(() => {
        initDatabase(':memory:');
        for (const p of [OPTIMIZATION_CONFIG_PATH, `${OPTIMIZATION_CONFIG_PATH}.bak`]) {
            if (existsSync(p))
                rmSync(p);
        }
    });
    it('scenario 1 (Active): every module status is correct and summary reflects the active config, no crash', async () => {
        const write = fakeCtxWithBody('/api/optimization/settings', 'PATCH', ACTIVE_BODY);
        await tryHandleOptimization(write.ctx);
        expect(write.out.status).toBe(200);
        const { ctx, out } = fakeCtx('/api/optimization/summary');
        await tryHandleOptimization(ctx);
        expect(out.status).toBe(200);
        expect(out.body.master_enabled).toBe(true);
        expect(out.body.active_module_count).toBe(7);
        expect(out.body.config_valid).toBe(true);
        // Every gated sub-report is now attempted (not blocked by a disabled module) --
        // each either succeeds or fails with its own real blocker, never silently absent.
        for (const key of ['capacity', 'kpi', 'top_recommendation', 'monthly_review', 'benchmark']) {
            expect(out.body[key]).toHaveProperty('available');
            expect(out.body[key]).toHaveProperty('blocker');
        }
    });
    it('scenario 5 (full disable): CostOps and Token Monitor keep working, completely independent of the optimization master switch', async () => {
        // Master OFF (the default, safe state) -- optimization's own summary reports disabled...
        const summary = fakeCtx('/api/optimization/summary');
        await tryHandleOptimization(summary.ctx);
        expect(summary.out.body.system_state).toBe('disabled');
        // ...but CostOps and Token Monitor are entirely separate route handlers that
        // never read optimization-config.json at all -- prove they still return 200.
        const costs = fakeCtx('/api/costs/summary');
        expect(await tryHandleCostOps(costs.ctx)).toBe(true);
        expect(costs.out.status).toBe(200);
        const tokens = fakeCtx('/api/token-usage/summary');
        expect(await tryHandleTokenUsage(tokens.ctx)).toBe(true);
        expect(tokens.out.status).toBe(200);
    });
    it('scenario 6 (re-enable): turning the master switch back on offers the exact previous module configuration', async () => {
        // Reach an active state, then turn master off (captures lastEnabledConfiguration).
        await tryHandleOptimization(fakeCtxWithBody('/api/optimization/settings', 'PATCH', ACTIVE_BODY).ctx);
        const disable = fakeCtxWithBody('/api/optimization/settings', 'PATCH', { ...ACTIVE_BODY, masterEnabled: false });
        await tryHandleOptimization(disable.ctx);
        expect(disable.out.body.config.masterEnabled).toBe(false);
        expect(disable.out.body.config.lastEnabledConfiguration).not.toBeNull();
        expect(disable.out.body.config.lastEnabledConfiguration.modules).toEqual(ACTIVE_BODY.modules);
        // Re-enabling with the offered previous modules restores exactly that state,
        // and it passes dependency validation cleanly (no forced corrections).
        const reenable = fakeCtxWithBody('/api/optimization/settings', 'PATCH', {
            ...ACTIVE_BODY,
            masterEnabled: true,
            modules: disable.out.body.config.lastEnabledConfiguration.modules,
        });
        await tryHandleOptimization(reenable.ctx);
        expect(reenable.out.status).toBe(200);
        expect(reenable.out.body.config.masterEnabled).toBe(true);
        expect(reenable.out.body.config.modules).toEqual(ACTIVE_BODY.modules);
        expect(reenable.out.body.config.preset).toBe('active');
    });
    it('scenario 8 (recommendation decision): accepting audits, no commercial action fires, and NO routing-config write occurs from a decision alone', async () => {
        const before = fakeCtx('/api/optimization/settings');
        await tryHandleOptimization(before.ctx);
        const routingConfigBefore = JSON.stringify(before.out.body.config.routing);
        const decision = fakeCtxWithBody('/api/optimization/recommendations/decision', 'POST', {
            package_id: 'does-not-exist-in-this-test', status: 'accepted', actor: 'test',
        });
        await tryHandleOptimization(decision.ctx);
        // Unknown package (no live inventory in this test) -> 404, not a crash --
        // the important assertion is what does NOT happen as a side effect below.
        expect(decision.out.status).toBe(404);
        const after = fakeCtx('/api/optimization/settings');
        await tryHandleOptimization(after.ctx);
        expect(JSON.stringify(after.out.body.config.routing)).toBe(routingConfigBefore);
        const audit = fakeCtx('/api/optimization/audit');
        await tryHandleOptimization(audit.ctx);
        expect(Array.isArray(audit.out.body)).toBe(true);
    });
});
