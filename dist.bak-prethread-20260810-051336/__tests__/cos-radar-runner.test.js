import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { createCase } from '../cos/case-store.js';
import { createRadarItem, getRadarItem } from '../cos/radar.js';
import { runRentalRadarCheck } from '../cos/radar-runner.js';
// COS radar runner — the working glue: a RENTAL radar item drives the rental
// adapter, the best offer is recorded, and the target flips it to HIT. Uses a
// mock RentalAdapter (no network).
const NOW = 1_000_000;
function offer(car, category, full, supplier = 'Centauro') {
    return {
        car, category, transmission: 'Manual', seats: 5, bags: 2, supplier, supplierKey: supplier.toLowerCase(),
        rating: 8.6, pickupType: 'Free shuttle service', pickupPlace: 'Valencia Airport (VLC)',
        basePrice: full - 18000, currency: 'HUF', coveragePrice: 18000, fullPrice: full,
        deposit: 'Average deposit', depositValue: 'HUF 541,325', zeroExcessBadge: false, zeroDepositBadge: false,
        mileage: 'Unlimited', bookUrl: '/book',
    };
}
class MockRental {
    offers;
    id = 'discovercars';
    displayName = 'DiscoverCars';
    constructor(offers) {
        this.offers = offers;
    }
    async search(_p) { return this.offers; }
}
const QUERY = {
    search: { pickup: { countryId: 26, cityId: 462, placeId: 462, label: 'VLC' }, dropoff: { countryId: 26, cityId: 455, placeId: 1848, label: 'AGP' }, pickupFrom: '2026-08-18 10:00', pickupTo: '2026-08-23 08:00', residenceCountry: 'HU' },
    categoryPattern: 'compact',
};
describe('COS radar runner (rental)', () => {
    beforeEach(() => {
        initDatabase(':memory:');
        createCase(getDb(), { caseId: 'c1', title: 'Spain', caseType: 'TRAVEL' }, NOW);
    });
    it('searches, filters by category, records the cheapest as the observation', async () => {
        const db = getDb();
        createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'VLC→AGP', query: QUERY, targetPrice: 80000, currency: 'HUF', checkIntervalSec: 3600 }, NOW);
        const adapter = new MockRental([
            offer('Hyundai i30', 'Compact', 87900),
            offer('Toyota Aygo', 'Mini', 55000), // filtered out by categoryPattern 'compact'
            offer('Jeep Avenger', 'Compact SUV', 91789),
        ]);
        const res = await runRentalRadarCheck(db, getRadarItem(db, 'r1'), adapter, NOW + 3600);
        expect(res.hit).toBe(false); // cheapest compact 87900 > target 80000
        expect(res.isNewLow).toBe(true);
        expect(getRadarItem(db, 'r1').best_seen_price).toBe(87900); // the Mini was filtered out
        const obs = db.prepare(`SELECT best_price, offer_count, offer_ref FROM radar_observations WHERE radar_id='r1'`).get();
        expect(obs.best_price).toBe(87900);
        expect(obs.offer_count).toBe(2); // 2 compact offers after filtering
        expect(JSON.parse(obs.offer_ref).car).toBe('Hyundai i30');
    });
    it('flips to HIT when the cheapest meets the target', async () => {
        const db = getDb();
        createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'x', query: QUERY, targetPrice: 90000, currency: 'HUF', checkIntervalSec: 3600 }, NOW);
        const res = await runRentalRadarCheck(db, getRadarItem(db, 'r1'), new MockRental([offer('Hyundai i30', 'Compact', 87900)]), NOW + 3600);
        expect(res.hit).toBe(true);
        expect(getRadarItem(db, 'r1').status).toBe('HIT');
    });
    it('records a null best price when no offers match', async () => {
        const db = getDb();
        createRadarItem(db, { radarId: 'r1', caseId: 'c1', kind: 'RENTAL', label: 'x', query: QUERY, targetPrice: 90000, checkIntervalSec: 3600 }, NOW);
        const res = await runRentalRadarCheck(db, getRadarItem(db, 'r1'), new MockRental([offer('Toyota Aygo', 'Mini', 55000)]), NOW + 3600);
        expect(res.hit).toBe(false);
        const obs = db.prepare(`SELECT best_price, offer_count FROM radar_observations WHERE radar_id='r1'`).get();
        expect(obs.best_price).toBeNull();
        expect(obs.offer_count).toBe(0);
    });
});
