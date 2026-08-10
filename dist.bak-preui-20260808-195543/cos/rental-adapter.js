// Personal Chief of Staff (COS) — car-rental adapter contract.
//
// Rental is a different search shape than the grocery ShoppingAdapter (search
// by pickup/dropoff + dates → offers), so it has its own interface. The SAME
// safety invariant holds via the shared guard: NO book/checkout/pay method
// exists (assertNoCheckoutSurface also rejects book/reserve) — booking is
// always manual. This module is PURE (no network): the offer parser + filters +
// day-count are the testable heart. The live adapter (./adapters/discovercars.ts)
// calls DiscoverCars' JSON API directly (no browser) and feeds the raw offer
// objects to parseApiOffer.
import { assertNoCheckoutSurface } from './shopping-adapter.js';
export function assertRentalAdapterSafe(adapter) {
    assertNoCheckoutSurface(adapter);
}
// ---- pure parser over the DiscoverCars API offer object -----------------------
function num(v) {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : null;
}
/** Parse one raw offer object from /api/v2/search/<guid>. Returns null if it has
 *  no vehicle (defensive). Field shape verified from live 2026-08-05 responses. */
export function parseApiOffer(o) {
    const v = o?.vehicle;
    if (!v?.carName)
        return null;
    const spec = v.specifications ?? {};
    const base = num(o?.price?.raw);
    const coverage = num(o?.coverage?.total);
    return {
        car: String(v.carName),
        category: String(v.sippGroup ?? ''),
        transmission: spec.isAutomaticTransmission ? 'Automatic' : 'Manual',
        seats: num(spec.seats?.number),
        bags: num(spec.bags?.number),
        supplier: String(o?.supplier?.name ?? ''),
        supplierKey: String(o?.supplier?.key ?? ''),
        rating: num(o?.supplier?.rating?.score),
        pickupType: String(o?.supplier?.loc?.label ?? ''),
        pickupPlace: String(o?.location?.name ?? ''),
        basePrice: base,
        currency: String(o?.price?.currency ?? o?.coverage?.currency ?? 'HUF'),
        coveragePrice: coverage,
        fullPrice: base != null ? base + (coverage ?? 0) : null,
        deposit: String(o?.depositType?.title ?? ''),
        depositValue: String(o?.depositType?.value ?? ''),
        zeroExcessBadge: !!o?.badges?.zero_excess,
        zeroDepositBadge: !!o?.badges?.zero_deposit,
        mileage: String(o?.mileage?.label ?? ''),
        bookUrl: String(o?.bookUrl ?? ''),
    };
}
export function parseApiOffers(offers) {
    const out = [];
    for (const o of offers ?? []) {
        const p = parseApiOffer(o);
        if (p)
            out.push(p);
    }
    return out;
}
// ---- filters / helpers --------------------------------------------------------
/** Spanish suppliers known to accept debit cards (see the COS rental notes). */
export const DEBIT_FRIENDLY_SUPPLIERS = new Set([
    'goldcar', 'okmobility', 'ok mobility', 'centauro', 'recordgo', 'record go', 'okrentacar',
]);
export function isDebitFriendly(o) {
    return DEBIT_FRIENDLY_SUPPLIERS.has(o.supplierKey.toLowerCase()) || DEBIT_FRIENDLY_SUPPLIERS.has(o.supplier.toLowerCase());
}
export function filterByCategory(offers, re) {
    return offers.filter((o) => re.test(o.category));
}
export function underFullPrice(offers, max) {
    return offers.filter((o) => o.fullPrice != null && o.fullPrice < max);
}
/** Cheapest by all-in (base + full coverage) price. */
export function cheapestByFullPrice(offers) {
    return [...offers].sort((a, b) => (a.fullPrice ?? Infinity) - (b.fullPrice ?? Infinity));
}
/** Whole days between two 'YYYY-MM-DD HH:mm' (or ISO) local timestamps. */
export function rentalDayCount(pickup, dropoff) {
    const day = (s) => {
        const [y, m, d] = s.split(/[ T]/)[0].split('-').map(Number);
        return Date.UTC(y, m - 1, d);
    };
    return Math.round((day(dropoff) - day(pickup)) / 86_400_000);
}
