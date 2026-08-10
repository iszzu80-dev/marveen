import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createRadarItem, getRadarItem } from '../cos/radar.js';
import { runProductRadarCheck, minorToMajor } from '../cos/radar-runner.js';
const T0 = 1_700_000_000;
// A deterministic mock price source (real adapters plug in the same way). HUF
// prices in minor units (HUF exponent 0 → minor == forint).
function mockAdapter(results) {
    return {
        id: 'mock', displayName: 'Mock', capabilities: { search: true, priceWatch: true, cart: false },
        async searchProducts() { return results; },
        async getProduct() { return null; },
    };
}
const p = (id, name, priceMinor, currency = 'HUF') => ({ ref: { adapterId: 'mock', productId: id }, name, priceMinor, currency, available: true });
describe('PRODUCT radar price-watch engine', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    function makeItem(q, target = 45000) {
        createRadarItem(getDb(), {
            radarId: 'BUY-TEST', kind: 'PRODUCT', label: 'On Cloud 6', currency: 'HUF',
            targetPrice: target, checkIntervalSec: 86400, query: q,
        }, T0);
    }
    it('minorToMajor respects the currency exponent (HUF 0, EUR 2)', () => {
        expect(minorToMajor(45000, 'HUF')).toBe(45000);
        expect(minorToMajor(4599, 'EUR')).toBe(46);
    });
    it('picks the cheapest matching offer and records an observation', async () => {
        makeItem();
        const res = await runProductRadarCheck(getDb(), getRadarItem(getDb(), 'BUY-TEST'), mockAdapter([p('a', 'On Cloud 6 white', 52000), p('b', 'On Cloud 6 midnight', 47000)]), T0 + 1);
        expect(res.bestPrice).toBe(47000);
        expect(res.hit).toBe(false); // 47000 > 45000 target
        const obs = getDb().prepare(`SELECT COUNT(*) n FROM radar_observations WHERE radar_id='BUY-TEST'`).get();
        expect(obs.n).toBe(1);
    });
    it('flips to HIT and notifies when the target is met', async () => {
        makeItem();
        const res = await runProductRadarCheck(getDb(), getRadarItem(getDb(), 'BUY-TEST'), mockAdapter([p('b', 'On Cloud 6 midnight', 44000)]), T0 + 1);
        expect(res.hit).toBe(true);
        expect(res.status).toBe('HIT');
        expect(res.notify).toMatchObject({ should: true, reason: 'NEW_HIT' });
    });
    it('applies mustMatch / excludeTerms filters', async () => {
        makeItem({ mustMatch: ['on cloud'], excludeTerms: ['kids'] });
        const res = await runProductRadarCheck(getDb(), getRadarItem(getDb(), 'BUY-TEST'), mockAdapter([
            p('x', 'Nike Pegasus', 30000), // filtered: not "on cloud"
            p('y', 'On Cloud 6 KIDS', 20000), // filtered: excluded "kids"
            p('z', 'On Cloud 6 adult', 46000), // kept
        ]), T0 + 1);
        expect(res.bestPrice).toBe(46000); // the kids 20000 was excluded, not picked
    });
    it('skips offers in a different currency (no silent FX)', async () => {
        makeItem();
        const res = await runProductRadarCheck(getDb(), getRadarItem(getDb(), 'BUY-TEST'), mockAdapter([p('e', 'On Cloud 6', 120, 'EUR'), p('h', 'On Cloud 6', 44000, 'HUF')]), T0 + 1);
        expect(res.bestPrice).toBe(44000); // EUR offer ignored, HUF one used
    });
    it('records an honest 0-offer observation (no fake price) when nothing matches', async () => {
        makeItem();
        const res = await runProductRadarCheck(getDb(), getRadarItem(getDb(), 'BUY-TEST'), mockAdapter([]), T0 + 1);
        expect(res.bestPrice).toBeNull();
        expect(res.hit).toBe(false);
        const obs = getDb().prepare(`SELECT best_price, offer_count FROM radar_observations WHERE radar_id='BUY-TEST'`).get();
        expect(obs.best_price).toBeNull();
        expect(obs.offer_count).toBe(0);
    });
});
