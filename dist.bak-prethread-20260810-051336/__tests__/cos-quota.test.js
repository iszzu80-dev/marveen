import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../db.js';
import { reserveQuota, releaseQuota, quotaUsage } from '../cos/quota.js';
// COS atomic send quota (P0.4). Proves the window limit is enforced, resets on
// rollover, and refunds correctly. The atomicity itself (single transaction)
// means concurrent callers can never exceed the limit.
const NOW = 1_000_000;
const KEY = 'EMAIL_SEND:daily';
describe('COS send quota', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('reserves up to the limit, then refuses without incrementing', () => {
        const db = getDb();
        expect(reserveQuota(db, KEY, 3, 86400, NOW)).toMatchObject({ reserved: true, remaining: 2 });
        expect(reserveQuota(db, KEY, 3, 86400, NOW + 1)).toMatchObject({ reserved: true, remaining: 1 });
        expect(reserveQuota(db, KEY, 3, 86400, NOW + 2)).toMatchObject({ reserved: true, remaining: 0 });
        expect(reserveQuota(db, KEY, 3, 86400, NOW + 3)).toMatchObject({ reserved: false, remaining: 0 });
        expect(quotaUsage(db, KEY)).toEqual({ used: 3, max: 3 }); // the refused call did NOT increment
    });
    it('resets when the window rolls over', () => {
        const db = getDb();
        reserveQuota(db, KEY, 2, 3600, NOW);
        reserveQuota(db, KEY, 2, 3600, NOW + 1);
        expect(reserveQuota(db, KEY, 2, 3600, NOW + 2).reserved).toBe(false); // full within window
        const r = reserveQuota(db, KEY, 2, 3600, NOW + 3601); // window expired → fresh
        expect(r).toMatchObject({ reserved: true, remaining: 1 });
        expect(r.windowStart).toBe(NOW + 3601);
    });
    it('a zero limit never reserves', () => {
        expect(reserveQuota(getDb(), KEY, 0, 86400, NOW).reserved).toBe(false);
    });
    it('release refunds a slot within the window', () => {
        const db = getDb();
        reserveQuota(db, KEY, 2, 86400, NOW);
        reserveQuota(db, KEY, 2, 86400, NOW + 1);
        expect(reserveQuota(db, KEY, 2, 86400, NOW + 2).reserved).toBe(false); // full
        releaseQuota(db, KEY, NOW + 3);
        expect(reserveQuota(db, KEY, 2, 86400, NOW + 4).reserved).toBe(true); // slot freed
    });
});
