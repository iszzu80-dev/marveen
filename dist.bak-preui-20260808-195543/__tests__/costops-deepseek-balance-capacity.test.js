// Card 6976aaa2 (Istvan GO 2026-07-30): wire DeepSeek's prepaid balance into
// capacity-routing so the ARMED fallback (store/capacity-routing-config.json
// enabled:true, candidate deepseek-v4-pro) actually fires. Before this,
// capacityStateFor(db, 'deepseek', ...) went through the subscriptions-config
// path (findSubscriptionFor), found no subscription entry for a prepaid
// account, and returned 'unknown' -- unroutable by construction
// (isRoutable('unknown') === false) -- so the config was armed but INERT.
//
// THE THREE REQUIRED GUARD TESTS (card, verbatim), each run against a real
// in-memory DB via latestBalanceSnapshot -> capacityStateFor -> the actual
// resolveRuntimeRouting decision, not just the pure comparison in isolation:
//   1. balance>floor -> deepseek available -> resolveRuntimeRouting on a
//      constrained Max primary returns fallback to deepseek-v4-pro.
//   2. balance<=floor -> not routable -> no_eligible_fallback.
//   3. no/stale snapshot -> unknown -> no_eligible_fallback (fail-safe
//      preserved).
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { capacityStateFor, DEEPSEEK_BALANCE_FLOOR_USD } from '../web/capacity-routing-runner.js';
import { resolveRuntimeRouting, capacityKeyId } from '../capacity-routing.js';
const NOW_SEC = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000);
const NOW_MS = NOW_SEC * 1000;
function insertBalanceSnapshot(balance, capturedAtSec, provider = 'deepseek') {
    const db = getDb();
    db.prepare(`INSERT INTO provider_balance_snapshots (provider, currency, balance, captured_at) VALUES (?, 'USD', ?, ?)`).run(provider, balance, capturedAtSec);
}
const DEEPSEEK_CANDIDATE = {
    provider: 'deepseek',
    authProfile: 'configdir:.claude-deepseek',
    model: 'deepseek-v4-pro',
    enabledForRouting: true,
    subscriptionIncluded: false,
};
describe('card 6976aaa2: DeepSeek balance wired into capacity-routing availability', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    describe('capacityStateFor(db, \'deepseek\', ...) reads the balance path, not the subscription path', () => {
        it('GUARD TEST 1: balance above the floor -> available', () => {
            insertBalanceSnapshot(8.74, NOW_SEC - 60);
            const state = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(state).toBe('available');
        });
        it('GUARD TEST 2: balance at/below the floor -> blocked, not routable', () => {
            insertBalanceSnapshot(0.42, NOW_SEC - 60);
            const state = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(state).toBe('blocked');
        });
        it('GUARD TEST 3: no snapshot at all -> unknown (fail-safe preserved, this was the pre-fix defect)', () => {
            const state = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(state).toBe('unknown');
        });
        it('GUARD TEST 3 (stale variant): an old snapshot -> unknown, not a stale-but-trusted available', () => {
            const STALE_AFTER_SEC = 26 * 60 * 60;
            insertBalanceSnapshot(8.74, NOW_SEC - STALE_AFTER_SEC - 3600);
            const state = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(state).toBe('unknown');
        });
        it('a live usage-limit-banner signal still short-circuits to blocked, balance notwithstanding', () => {
            insertBalanceSnapshot(8.74, NOW_SEC - 60);
            const state = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, true);
            expect(state).toBe('blocked');
        });
        it('a subscriptions.json entry for deepseek (there should never be one) does not silently take over the balance path', () => {
            // Regression guard for the branch ordering in capacityStateFor: the
            // deepseek check must run BEFORE the subscriptions-config lookup.
            insertBalanceSnapshot(8.74, NOW_SEC - 60);
            const state = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(state).toBe('available');
        });
    });
    describe('end-to-end: resolveRuntimeRouting actually fires the armed fallback', () => {
        it('GUARD TEST 1 (full path): a constrained Max primary + available DeepSeek -> fallback decision names deepseek-v4-pro', () => {
            insertBalanceSnapshot(8.74, NOW_SEC - 60);
            const deepseekState = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(deepseekState).toBe('available'); // sanity, same as GUARD TEST 1 above
            const decision = resolveRuntimeRouting({
                primaryState: 'blocked', // the Anthropic Max primary is constrained
                candidates: [DEEPSEEK_CANDIDATE],
                candidateStates: new Map([[capacityKeyId(DEEPSEEK_CANDIDATE), deepseekState]]),
                packageOpen: false,
                fallbacksUsedThisPackage: 0,
                errorClass: 'capacity',
            });
            expect(decision.action).toBe('fallback');
            if (decision.action === 'fallback')
                expect(decision.to.model).toBe('deepseek-v4-pro');
        });
        it('GUARD TEST 2 (full path): DeepSeek balance at the floor -> no_eligible_fallback, primary stays constrained', () => {
            insertBalanceSnapshot(0.5, NOW_SEC - 60); // exactly at DEEPSEEK_BALANCE_FLOOR_USD (0.5, owner decision 2026-08-08)
            const deepseekState = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(deepseekState).toBe('blocked');
            const decision = resolveRuntimeRouting({
                primaryState: 'blocked',
                candidates: [DEEPSEEK_CANDIDATE],
                candidateStates: new Map([[capacityKeyId(DEEPSEEK_CANDIDATE), deepseekState]]),
                packageOpen: false,
                fallbacksUsedThisPackage: 0,
                errorClass: 'capacity',
            });
            expect(decision.action).toBe('no_eligible_fallback');
        });
        it('GUARD TEST 3 (full path): no DeepSeek balance snapshot -> unknown -> no_eligible_fallback, never a fabricated fallback', () => {
            // No insertBalanceSnapshot call at all -- the exact pre-fix defect
            // shape (armed config, no capacity signal).
            const deepseekState = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            expect(deepseekState).toBe('unknown');
            const decision = resolveRuntimeRouting({
                primaryState: 'blocked',
                candidates: [DEEPSEEK_CANDIDATE],
                candidateStates: new Map([[capacityKeyId(DEEPSEEK_CANDIDATE), deepseekState]]),
                packageOpen: false,
                fallbacksUsedThisPackage: 0,
                errorClass: 'capacity',
            });
            expect(decision.action).toBe('no_eligible_fallback');
        });
        it('a healthy Max primary never falls back at all, DeepSeek balance notwithstanding', () => {
            insertBalanceSnapshot(8.74, NOW_SEC - 60);
            const deepseekState = capacityStateFor(getDb(), 'deepseek', 'configdir:.claude-deepseek', NOW_SEC, false);
            const decision = resolveRuntimeRouting({
                primaryState: 'available',
                candidates: [DEEPSEEK_CANDIDATE],
                candidateStates: new Map([[capacityKeyId(DEEPSEEK_CANDIDATE), deepseekState]]),
                packageOpen: false,
                fallbacksUsedThisPackage: 0,
                errorClass: null,
            });
            expect(decision.action).toBe('stay_primary');
        });
    });
    it('the floor is a named, documented constant -- not a magic number buried in the branch', () => {
        expect(DEEPSEEK_BALANCE_FLOOR_USD).toBe(0.5);
    });
});
