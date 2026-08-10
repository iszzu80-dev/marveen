import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureQuoteSchema, createQuoteCampaign, approveShortlist, transitionQuote, recordQuote, compareQuotes, chooseProvider, getQuoteCampaign, QUOTE_TRANSITIONS, } from '../cos/quote-campaign.js';
// The quote-request campaign (§13.1), the spec's first pilot.
//
// Nearly every test here is a refusal, because the ways this workflow goes
// wrong are all quiet ones: asking someone the owner never approved, comparing
// a price that arrived unsolicited, presenting one quote as a comparison, or
// booking without him. None of those look like errors while they happen.
const NOW = 1_800_000_000;
const P = ['kovacs@epito.hu', 'nagy@burkolo.hu', 'kiss@szereles.hu'];
function seed(state) {
    const db = new Database(':memory:');
    ensureQuoteSchema(db);
    createQuoteCampaign(db, 'q1', 'PRI-HOME-2026-002', NOW - 100);
    if (state) {
        approveShortlist(db, 'q1', P, 'istvan', NOW - 90);
        if (state !== 'SHORTLIST_READY') {
            transitionQuote(db, 'q1', 'REQUESTS_SENDING', NOW - 80);
            if (state !== 'REQUESTS_SENDING')
                transitionQuote(db, 'q1', 'WAITING_EXTERNAL', NOW - 70);
        }
    }
    return db;
}
const quote = (i, amount) => ({
    provider: `P${i}`, fromAddress: P[i], amount, currency: 'HUF',
});
describe('quote-request campaign (§13.1)', () => {
    it('starts in DRAFT and cannot send before the owner approved a shortlist', () => {
        const db = seed();
        const r = transitionQuote(db, 'q1', 'REQUESTS_SENDING', NOW);
        expect(r.ok).toBe(false);
        // refused by the state machine first; the guard is the second line
        expect(r.reason).toMatch(/nem megengedett|nincs jóváhagyva/);
    });
    it('an empty shortlist authorizes nobody', () => {
        const db = seed();
        const r = approveShortlist(db, 'q1', [], 'istvan', NOW);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/üres/);
    });
    it('once the shortlist is approved, sending may start', () => {
        const db = seed('SHORTLIST_READY');
        expect(getQuoteCampaign(db, 'q1').shortlistApprovedBy).toBe('istvan');
        expect(transitionQuote(db, 'q1', 'REQUESTS_SENDING', NOW).ok).toBe(true);
    });
    describe('quotes arriving', () => {
        it('accepts one from an approved provider', () => {
            const db = seed('WAITING_EXTERNAL');
            const r = recordQuote(db, 'q1', quote(0, 450_000), NOW);
            expect(r.ok).toBe(true);
            expect(getQuoteCampaign(db, 'q1').quotes).toHaveLength(1);
        });
        it('REFUSES one from an address nobody approved', () => {
            // An unsolicited price is not a quote. Taking it would quietly widen the
            // set of people whose numbers reach the comparison.
            const db = seed('WAITING_EXTERNAL');
            const r = recordQuote(db, 'q1', { provider: 'Idegen', fromAddress: 'valaki@mas.hu', amount: 400_000, currency: 'HUF' }, NOW);
            expect(r.ok).toBe(false);
            expect(r.reason).toMatch(/nincs a jóváhagyott listán/);
            expect(getQuoteCampaign(db, 'q1').quotes).toHaveLength(0);
        });
        it('matches the address inside a display name', () => {
            const db = seed('WAITING_EXTERNAL');
            const r = recordQuote(db, 'q1', { provider: 'Kovács', fromAddress: 'Kovács Bt <KOVACS@epito.hu>', amount: 1, currency: 'HUF' }, NOW);
            expect(r.ok).toBe(true);
        });
        it('a re-sent quote replaces the old one instead of counting twice', () => {
            const db = seed('WAITING_EXTERNAL');
            recordQuote(db, 'q1', quote(0, 450_000), NOW);
            recordQuote(db, 'q1', quote(0, 430_000), NOW + 10);
            const q = getQuoteCampaign(db, 'q1').quotes;
            expect(q).toHaveLength(1);
            expect(q[0].amount).toBe(430_000);
        });
        it('refuses a nonsense amount', () => {
            const db = seed('WAITING_EXTERNAL');
            expect(recordQuote(db, 'q1', quote(0, 0), NOW).ok).toBe(false);
        });
    });
    describe('comparison', () => {
        it('one quote is NOT a comparison', () => {
            // Presenting a single price as a comparison invites a decision that looks
            // informed and is not.
            const db = seed('WAITING_EXTERNAL');
            recordQuote(db, 'q1', quote(0, 450_000), NOW);
            transitionQuote(db, 'q1', 'QUOTES_COLLECTED', NOW);
            const r = transitionQuote(db, 'q1', 'COMPARISON_READY', NOW);
            expect(r.ok).toBe(false);
            expect(r.reason).toMatch(/legalább 2/);
            expect(compareQuotes(db, 'q1')).toBeUndefined();
        });
        it('ranks by price and reports the spread', () => {
            const db = seed('WAITING_EXTERNAL');
            recordQuote(db, 'q1', quote(0, 450_000), NOW);
            recordQuote(db, 'q1', quote(1, 390_000), NOW);
            recordQuote(db, 'q1', quote(2, 520_000), NOW);
            const c = compareQuotes(db, 'q1');
            expect(c.quotes.map((q) => q.amount)).toEqual([390_000, 450_000, 520_000]);
            expect(c.cheapest).toBe('P1');
            expect(c.spread).toBe(130_000);
            expect(c.quotes[1].deltaFromCheapest).toBe(60_000);
        });
        it('never marks one as recommended — the cheapest is a fact, the best is a judgement', () => {
            const db = seed('WAITING_EXTERNAL');
            recordQuote(db, 'q1', quote(0, 450_000), NOW);
            recordQuote(db, 'q1', quote(1, 390_000), NOW);
            const c = compareQuotes(db, 'q1');
            expect(JSON.stringify(c)).not.toMatch(/recommend|ajánlott|javasolt/i);
            expect(c.note).toMatch(/választás Istváné/);
        });
    });
    describe('the final gate', () => {
        function ready() {
            const db = seed('WAITING_EXTERNAL');
            recordQuote(db, 'q1', quote(0, 450_000), NOW);
            recordQuote(db, 'q1', quote(1, 390_000), NOW);
            transitionQuote(db, 'q1', 'QUOTES_COLLECTED', NOW);
            transitionQuote(db, 'q1', 'COMPARISON_READY', NOW);
            return db;
        }
        it('cannot choose before the final gate is reached', () => {
            const db = ready();
            expect(chooseProvider(db, 'q1', 'P1', NOW).ok).toBe(false);
        });
        it('the owner picks, and booking stays manual', () => {
            const db = ready();
            transitionQuote(db, 'q1', 'AWAITING_FINAL_GATE', NOW);
            const r = chooseProvider(db, 'q1', 'P1', NOW);
            expect(r.ok).toBe(true);
            expect(r.state).toBe('BOOKING');
            expect(r.reason).toMatch(/kézi/);
        });
        it('cannot pick someone who never quoted', () => {
            const db = ready();
            transitionQuote(db, 'q1', 'AWAITING_FINAL_GATE', NOW);
            expect(chooseProvider(db, 'q1', 'Sógorom', NOW).ok).toBe(false);
        });
    });
    it('every state can be cancelled except the terminal ones', () => {
        for (const [from, to] of Object.entries(QUOTE_TRANSITIONS)) {
            if (from === 'COMPLETED' || from === 'CANCELLED')
                expect(to).toEqual([]);
            else
                expect(to, from).toContain('CANCELLED');
        }
    });
    it('refuses a hop the machine does not allow', () => {
        const db = seed('SHORTLIST_READY');
        expect(transitionQuote(db, 'q1', 'BOOKING', NOW).ok).toBe(false);
    });
});
