import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ensureLadderSchema, getLadder, setLadder, permits, pauseAll, promotionEligibility, recordCampaignOutcome, fleetLevelFor, PROMOTION_THRESHOLD, RUNGS, } from '../cos/autonomy-ladder.js';
// Graduated autonomy (§22).
//
// The tests that carry the weight are the refusals: payment at the top rung, the
// master switch beating everything, and promotion stopping at the owner's
// ceiling. A ladder is only a safeguard if it can say no at its most permissive
// setting; otherwise it is a countdown.
const NOW = 1_800_000_000;
function db() {
    const d = new Database(':memory:');
    ensureLadderSchema(d);
    return d;
}
describe('COS autonomy ladder', () => {
    let d;
    beforeEach(() => { d = db(); });
    it('an unknown case type starts at PREPARE — it may draft, never send', () => {
        const s = getLadder(d, 'BRAND_NEW');
        expect(s.rung).toBe('PREPARE');
        expect(permits(d, 'BRAND_NEW', 'DRAFT').allowed).toBe(true);
        expect(permits(d, 'BRAND_NEW', 'SEND').allowed).toBe(false);
        expect(permits(d, 'BRAND_NEW', 'SEND').code).toBe('rung_too_low');
    });
    describe('what no rung ever unlocks', () => {
        it('payment is refused even at LIMITED_AUTONOMOUS', () => {
            setLadder(d, 'TRAVEL', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            const r = permits(d, 'TRAVEL', 'PAYMENT');
            expect(r.allowed).toBe(false);
            expect(r.code).toBe('never_autonomous');
            expect(r.requiresApproval).toBe(true);
        });
        it('sharing beyond the approved data is refused even at LIMITED_AUTONOMOUS', () => {
            setLadder(d, 'TRAVEL', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            expect(permits(d, 'TRAVEL', 'SHARE_BEYOND_APPROVED').code).toBe('never_autonomous');
        });
        it('the refusal does not depend on the type existing at all', () => {
            // Checked before the rung is read, so a future rung above the top cannot
            // silently unlock it.
            expect(permits(d, 'NEVER_CONFIGURED', 'PAYMENT').code).toBe('never_autonomous');
        });
    });
    describe('the two rungs the fleet 1-3 switch cannot express', () => {
        it('EXECUTE_WITH_APPROVAL sends only WITH an approval', () => {
            setLadder(d, 'HOME_REPAIR', { rung: 'EXECUTE_WITH_APPROVAL' }, NOW);
            const r = permits(d, 'HOME_REPAIR', 'SEND');
            expect(r.allowed).toBe(true);
            expect(r.requiresApproval).toBe(true);
            expect(r.code).toBe('approval_required');
        });
        it('LIMITED_AUTONOMOUS sends without asking each time', () => {
            setLadder(d, 'HOME_REPAIR', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            const r = permits(d, 'HOME_REPAIR', 'SEND');
            expect(r.allowed).toBe(true);
            expect(r.requiresApproval).toBe(false);
        });
        it('both map onto fleet level 2 and 3 — one truth, one mirror', () => {
            expect(fleetLevelFor('EXECUTE_WITH_APPROVAL')).toBe(2);
            expect(fleetLevelFor('LIMITED_AUTONOMOUS')).toBe(3);
            expect(fleetLevelFor('OFF')).toBe(1);
            // and the mapping is total — every rung has a mirror
            for (const r of RUNGS)
                expect([1, 2, 3]).toContain(fleetLevelFor(r));
        });
    });
    describe('the master switch', () => {
        it('pausing everything beats the highest rung', () => {
            setLadder(d, 'TRAVEL', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            expect(permits(d, 'TRAVEL', 'SEND').allowed).toBe(true);
            pauseAll(d, true, 'Istvan nyaral', NOW);
            const r = permits(d, 'TRAVEL', 'SEND');
            expect(r.allowed).toBe(false);
            expect(r.code).toBe('paused');
        });
        it('unpausing restores the previous rung, it does not reset it', () => {
            setLadder(d, 'TRAVEL', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            pauseAll(d, true, 'x', NOW);
            pauseAll(d, false, '', NOW + 10);
            expect(getLadder(d, 'TRAVEL').rung).toBe('LIMITED_AUTONOMOUS');
            expect(permits(d, 'TRAVEL', 'SEND').allowed).toBe(true);
        });
        it('a single type can be paused without stopping the rest', () => {
            setLadder(d, 'A', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            setLadder(d, 'B', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'LIMITED_AUTONOMOUS', paused: true }, NOW);
            expect(permits(d, 'A', 'SEND').allowed).toBe(true);
            expect(permits(d, 'B', 'SEND').code).toBe('paused');
        });
    });
    describe('promotion is earned and capped', () => {
        it('needs the threshold before it is even eligible', () => {
            setLadder(d, 'QUOTE', { rung: 'PREPARE', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            expect(promotionEligibility(d, 'QUOTE').eligible).toBe(false);
            for (let i = 0; i < PROMOTION_THRESHOLD; i++)
                recordCampaignOutcome(d, 'QUOTE', true, NOW + i);
            const e = promotionEligibility(d, 'QUOTE');
            expect(e.eligible).toBe(true);
            expect(e.nextRung).toBe('EXECUTE_WITH_APPROVAL');
        });
        it('eligibility does NOT raise the rung — the ladder never climbs itself', () => {
            setLadder(d, 'QUOTE', { rung: 'PREPARE', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            for (let i = 0; i < PROMOTION_THRESHOLD + 5; i++)
                recordCampaignOutcome(d, 'QUOTE', true, NOW + i);
            expect(getLadder(d, 'QUOTE').rung).toBe('PREPARE');
            expect(permits(d, 'QUOTE', 'SEND').allowed).toBe(false);
        });
        it('one fault resets the counter — three clean runs AFTER the mistake', () => {
            setLadder(d, 'QUOTE', { rung: 'PREPARE', ceiling: 'LIMITED_AUTONOMOUS' }, NOW);
            recordCampaignOutcome(d, 'QUOTE', true, NOW);
            recordCampaignOutcome(d, 'QUOTE', true, NOW + 1);
            expect(recordCampaignOutcome(d, 'QUOTE', false, NOW + 2)).toBe(0);
            expect(promotionEligibility(d, 'QUOTE').eligible).toBe(false);
        });
        it('the owner ceiling stops promotion however good the record is', () => {
            setLadder(d, 'FINANCE', { rung: 'PREPARE', ceiling: 'PREPARE' }, NOW);
            for (let i = 0; i < 50; i++)
                recordCampaignOutcome(d, 'FINANCE', true, NOW + i);
            const e = promotionEligibility(d, 'FINANCE');
            expect(e.eligible).toBe(false);
            expect(e.reason).toMatch(/plafon/);
        });
        it('a rung cannot be set above the ceiling, even directly', () => {
            expect(() => setLadder(d, 'FINANCE', { rung: 'LIMITED_AUTONOMOUS', ceiling: 'PREPARE' }, NOW))
                .toThrow(/plafon/);
        });
    });
    it('every refusal carries a code and a reason', () => {
        setLadder(d, 'X', { rung: 'OFF', ceiling: 'OFF' }, NOW);
        for (const a of ['OBSERVE', 'DRAFT', 'SEND', 'PAYMENT']) {
            const r = permits(d, 'X', a);
            if (!r.allowed) {
                expect(r.code, a).not.toBe('ok');
                expect(r.reason.length, a).toBeGreaterThan(10);
            }
        }
    });
});
