import { describe, it, expect } from 'vitest';
import { routeModelForSensitivity } from '../cos/model-routing.js';
// #5a dynamic routing: pick a model profile from the sensitivity-allowed set.
// Sensitivity constrains the downgrade; fail-closed on unknown tiers.
describe('dynamic model routing by sensitivity (#5a)', () => {
    it('PUBLIC + cost → the cheapest profile (routine_lowcost)', () => {
        const r = routeModelForSensitivity('PUBLIC', { strategy: 'cost' });
        expect(r.profile).toBe('routine_lowcost');
        expect(r.candidates[0]).toBe('premium_reasoning'); // ordered most-capable first
    });
    it('PUBLIC + capability → the most capable profile', () => {
        expect(routeModelForSensitivity('PUBLIC', { strategy: 'capability' }).profile).toBe('premium_reasoning');
    });
    it('HIGHLY_SENSITIVE → premium_reasoning under EITHER strategy (no cost downgrade)', () => {
        expect(routeModelForSensitivity('HIGHLY_SENSITIVE', { strategy: 'cost' }).profile).toBe('premium_reasoning');
        expect(routeModelForSensitivity('HIGHLY_SENSITIVE', { strategy: 'capability' }).profile).toBe('premium_reasoning');
    });
    it('SENSITIVE_PERSONAL + cost → cheapest of its restricted set (build_strong, not routine)', () => {
        const r = routeModelForSensitivity('SENSITIVE_PERSONAL', { strategy: 'cost' });
        expect(r.candidates).not.toContain('routine_lowcost');
        expect(r.profile).toBe('build_strong');
    });
    it('an unknown/garbage tier is fail-closed to HIGHLY_SENSITIVE (premium only)', () => {
        const r = routeModelForSensitivity('NONSENSE');
        expect(r.tier).toBe('HIGHLY_SENSITIVE');
        expect(r.profile).toBe('premium_reasoning');
        expect(r.candidates).toEqual(['premium_reasoning']);
    });
    it('defaults to the cost strategy', () => {
        expect(routeModelForSensitivity('PUBLIC').strategy).toBe('cost');
    });
});
