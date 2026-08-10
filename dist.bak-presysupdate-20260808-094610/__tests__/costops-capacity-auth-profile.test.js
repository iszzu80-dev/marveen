// Card 3ce58384 (Lean Optimization Phase 3 P2-C follow-up, 2026-07-30).
//
// THE DEFECT THIS CLOSES: capacity was read PER PROVIDER, so the fleet's two
// independent Anthropic auth profiles (host_default, configdir:.claude-personal)
// shared one usage figure -- one profile near its limit could make BOTH read
// constrained, or a genuinely exhausted profile could read healthy because the
// other profile's fresher reading was what got stored last. Both directions
// were silent (deferred honestly out of Phase 3, card 59b383a9).
//
// RED-ABILITY (each test names the mutation that makes it fail):
//  * findSubscriptionFor: revert to `lifecycle.find(s => s.provider === provider)`
//    (provider-only, ignoring authProfile) -> tests 1-2 go red.
//  * latestRateLimitSnapshot: drop the `authProfile === undefined` branch split
//    (always filter by auth_profile, or never filter) -> tests 3-5 go red.
//  * usageFigure: stop passing `sub.authProfile` through to
//    latestRateLimitSnapshot -> test 6 goes red (both profiles read identical).
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { writeRateLimitSnapshot, latestRateLimitSnapshot, } from '../costops/capacity-snapshots.js';
import { usageFigure } from '../costops/capacity.js';
import { deriveLifecycle } from '../costops/subscriptions.js';
import { syncAnthropicUsageSnapshot } from '../costops/collectors/anthropic-usage.js';
import { findSubscriptionFor } from '../web/capacity-routing-runner.js';
const NOW_SEC = Math.floor(Date.UTC(2026, 6, 30, 12, 0, 0) / 1000);
const NOW_MS = NOW_SEC * 1000;
const HOST_DEFAULT = 'host_default';
const PERSONAL = 'configdir:.claude-personal';
describe('card 3ce58384: capacity is keyed by (provider, authProfile)', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    describe('findSubscriptionFor (pure, no I/O)', () => {
        const lifecycle = deriveLifecycle({
            version: 1,
            subscriptions: [
                { id: 'a', name: 'A', provider: 'anthropic', authProfile: HOST_DEFAULT, source: 'anthropic', status: 'active', amount_source: 'no_invoice_found' },
                { id: 'b', name: 'B', provider: 'anthropic', authProfile: PERSONAL, source: 'anthropic', status: 'active', amount_source: 'no_invoice_found' },
                { id: 'c', name: 'C', provider: 'openai', source: 'openai', status: 'active', amount_source: 'no_invoice_found' },
            ],
        }, NOW_SEC);
        it('1. an exact (provider, authProfile) entry is preferred, so two profiles get independent entries', () => {
            const host = findSubscriptionFor(lifecycle, 'anthropic', HOST_DEFAULT);
            const personal = findSubscriptionFor(lifecycle, 'anthropic', PERSONAL);
            expect(host?.id).toBe('a');
            expect(personal?.id).toBe('b');
            expect(host?.id).not.toBe(personal?.id);
        });
        it('2. no match for a provider with no entry at all -> null, never borrowed from a sibling provider', () => {
            expect(findSubscriptionFor(lifecycle, 'anthropic', 'nonexistent-profile')).toBeNull();
            expect(findSubscriptionFor(lifecycle, 'deepseek', HOST_DEFAULT)).toBeNull();
        });
        it('backward compat: a provider-wide entry (no authProfile) answers for ANY profile of that provider -- no forced migration', () => {
            const wideLifecycle = deriveLifecycle({
                version: 1,
                subscriptions: [{ id: 'wide', name: 'Wide', provider: 'anthropic', source: 'anthropic', status: 'active', amount_source: 'no_invoice_found' }],
            }, NOW_SEC);
            expect(findSubscriptionFor(wideLifecycle, 'anthropic', HOST_DEFAULT)?.id).toBe('wide');
            expect(findSubscriptionFor(wideLifecycle, 'anthropic', PERSONAL)?.id).toBe('wide');
        });
    });
    describe('latestRateLimitSnapshot authProfile contract (real in-memory db)', () => {
        it('3. a specific-profile query only matches its own auth_profile, never a sibling profile\'s row', () => {
            const db = getDb();
            writeRateLimitSnapshot(db, {
                provider: 'anthropic', authProfile: HOST_DEFAULT, usedPercent: 95,
                source: 'operator_manual_snapshot', confidence: 'manual', dedupKey: 'host-1', capturedAt: NOW_SEC,
            });
            writeRateLimitSnapshot(db, {
                provider: 'anthropic', authProfile: PERSONAL, usedPercent: 10,
                source: 'operator_manual_snapshot', confidence: 'manual', dedupKey: 'personal-1', capturedAt: NOW_SEC,
            });
            expect(latestRateLimitSnapshot(db, 'anthropic', HOST_DEFAULT)?.used_percent).toBe(95);
            expect(latestRateLimitSnapshot(db, 'anthropic', PERSONAL)?.used_percent).toBe(10);
        });
        it('4. a provider-wide (no-authProfile) query is unaffected -- byte-identical to pre-3ce58384 behaviour', () => {
            const db = getDb();
            writeRateLimitSnapshot(db, {
                provider: 'anthropic', usedPercent: 42,
                source: 'operator_manual_snapshot', confidence: 'manual', dedupKey: 'wide-1', capturedAt: NOW_SEC,
            });
            expect(latestRateLimitSnapshot(db, 'anthropic')?.used_percent).toBe(42);
        });
        it('5. a provider-wide (NULL auth_profile) row does NOT satisfy a specific-profile query -- yields null, not a borrowed reading', () => {
            const db = getDb();
            writeRateLimitSnapshot(db, {
                provider: 'anthropic', usedPercent: 5, // no authProfile -- provider-wide row
                source: 'operator_manual_snapshot', confidence: 'manual', dedupKey: 'wide-only', capturedAt: NOW_SEC,
            });
            expect(latestRateLimitSnapshot(db, 'anthropic', HOST_DEFAULT)).toBeNull();
            // The provider-wide query still sees it, proving the row itself is fine --
            // only the SPECIFIC-profile query correctly refuses to borrow it.
            expect(latestRateLimitSnapshot(db, 'anthropic')?.used_percent).toBe(5);
        });
    });
    describe('usageFigure end-to-end: two profiles read differently (the exact scenario marveen named)', () => {
        it('6. host_default near its limit, configdir:.claude-personal with headroom -> DIFFERENT usage figures', () => {
            const db = getDb();
            writeRateLimitSnapshot(db, {
                provider: 'anthropic', authProfile: HOST_DEFAULT, usedPercent: 96,
                source: 'operator_manual_snapshot', confidence: 'manual', dedupKey: 'host-near-limit', capturedAt: NOW_SEC,
            });
            writeRateLimitSnapshot(db, {
                provider: 'anthropic', authProfile: PERSONAL, usedPercent: 12,
                source: 'operator_manual_snapshot', confidence: 'manual', dedupKey: 'personal-headroom', capturedAt: NOW_SEC,
            });
            const lifecycle = deriveLifecycle({
                version: 1,
                subscriptions: [
                    { id: 'a', name: 'A', provider: 'anthropic', authProfile: HOST_DEFAULT, source: 'anthropic', status: 'active', amount_source: 'no_invoice_found' },
                    { id: 'b', name: 'B', provider: 'anthropic', authProfile: PERSONAL, source: 'anthropic', status: 'active', amount_source: 'no_invoice_found' },
                ],
            }, NOW_SEC);
            const hostFigure = usageFigure(db, lifecycle[0], NOW_SEC);
            const personalFigure = usageFigure(db, lifecycle[1], NOW_SEC);
            expect(hostFigure.value).toBe(0.96);
            expect(personalFigure.value).toBe(0.12);
            expect(hostFigure.value).not.toBe(personalFigure.value);
        });
        it('7. a subscription entry with no authProfile keeps reading provider-wide, unaffected by profile-specific rows', () => {
            const db = getDb();
            writeRateLimitSnapshot(db, {
                provider: 'anthropic', usedPercent: 33,
                source: 'operator_manual_snapshot', confidence: 'manual', dedupKey: 'wide-reading', capturedAt: NOW_SEC,
            });
            const lifecycle = deriveLifecycle({
                version: 1,
                subscriptions: [{ id: 'wide', name: 'Wide', provider: 'anthropic', source: 'anthropic', status: 'active', amount_source: 'no_invoice_found' }],
            }, NOW_SEC);
            expect(usageFigure(db, lifecycle[0], NOW_SEC).value).toBe(0.33);
        });
    });
    describe('collector threads authProfile from config into the snapshot row', () => {
        it('8. syncAnthropicUsageSnapshot stamps each subscription entry\'s own authProfile, so two profiles land as two distinct rows', () => {
            const db = getDb();
            const config = {
                version: 1,
                subscriptions: [
                    {
                        id: 'host-plan', name: 'Host', provider: 'anthropic', authProfile: HOST_DEFAULT, source: 'anthropic', status: 'active', amount_source: 'no_invoice_found',
                        usage_snapshot: { as_of: '2026-07-30T10:00:00+02:00', session_pct: 50, weekly_pct: 91, weekly_reset_label: 'Tue 08:59' },
                    },
                    {
                        id: 'personal-plan', name: 'Personal', provider: 'anthropic', authProfile: PERSONAL, source: 'anthropic', status: 'active', amount_source: 'no_invoice_found',
                        usage_snapshot: { as_of: '2026-07-30T10:00:00+02:00', session_pct: 3, weekly_pct: 8, weekly_reset_label: 'Tue 08:59' },
                    },
                ],
            };
            const result = syncAnthropicUsageSnapshot(db, NOW_MS, { config });
            expect(result.imported_count).toBe(2);
            expect(latestRateLimitSnapshot(db, 'anthropic', HOST_DEFAULT)?.used_percent).toBe(91);
            expect(latestRateLimitSnapshot(db, 'anthropic', PERSONAL)?.used_percent).toBe(8);
        });
    });
});
