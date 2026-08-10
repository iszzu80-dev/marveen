import { describe, it, expect } from 'vitest';
import { assessBrowserAdapter, REQUIRED_BROWSER_METHODS } from '../cos/browser-adapter.js';
// P1.4: a browser/checkout adapter may only EXECUTE if it implements the full
// six-method contract AND has a reliable readback. This is a machine-checkable
// statement of "no autonomous purchase without a way to verify it landed".
function fullAdapter(readback) {
    return {
        prepare: () => ({}), execute: () => ({}), verify: () => true,
        dedupeKey: () => 'k', compensateOrCancel: () => undefined, readback,
    };
}
describe('browser adapter capability (P1.4)', () => {
    it('requires all six methods', () => {
        expect([...REQUIRED_BROWSER_METHODS].sort()).toEqual(['compensateOrCancel', 'dedupeKey', 'execute', 'prepare', 'readback', 'verify'].sort());
    });
    it('a shopping-style adapter with NO execute/checkout → PREPARE (missing methods listed)', async () => {
        // e.g. the rental/DiscoverCars adapter: search only, no checkout by design.
        const shopping = { search: async () => [], readback: async () => ({ found: false }) };
        const r = await assessBrowserAdapter(shopping, { dedupeKey: 'k' });
        expect(r.mode).toBe('PREPARE');
        expect(r.missing).toContain('execute');
        expect(r.missing).toContain('prepare');
    });
    it('a fully-shaped adapter with a reliable readback probe → EXECUTE', async () => {
        const adapter = fullAdapter(async () => ({ found: true, available: true }));
        const r = await assessBrowserAdapter(adapter, { dedupeKey: 'k' });
        expect(r.mode).toBe('EXECUTE');
        expect(r.readbackReliable).toBe(true);
    });
    it('a fully-shaped adapter whose readback is unavailable → PREPARE', async () => {
        const adapter = fullAdapter(async () => ({ found: false, available: false }));
        const r = await assessBrowserAdapter(adapter, { dedupeKey: 'k' });
        expect(r.mode).toBe('PREPARE');
        expect(r.readbackReliable).toBe(false);
    });
    it('a fully-shaped adapter whose readback throws → PREPARE', async () => {
        const adapter = fullAdapter(async () => { throw new Error('probe failed'); });
        const r = await assessBrowserAdapter(adapter, { dedupeKey: 'k' });
        expect(r.mode).toBe('PREPARE');
        expect(r.detail).toMatch(/threw/);
    });
    it('a fully-shaped adapter with NO probe run → PREPARE (fail-safe default)', async () => {
        const adapter = fullAdapter(async () => ({ found: true }));
        const r = await assessBrowserAdapter(adapter); // no probe
        expect(r.mode).toBe('PREPARE');
        expect(r.missing).toEqual([]);
    });
});
