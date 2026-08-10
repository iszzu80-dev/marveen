import { describe, it, expect } from 'vitest';
import { classifyPersonalSensitivity, coerceSensitivity, escalateSensitivity, effectiveSensitivity, isProfileAllowedForSensitivity, allowedProfilesFor, evaluatePersonalDispatch, MOST_SENSITIVE, } from '../cos/sensitivity.js';
// COS Slice 0 — static data-sensitivity policy (P0.6). Proves the 4-tier
// classifier, the escalate-only rule, the fail-closed coercion, and the
// model-profile allowlist. The classifier reuses the fleet gate's matching
// engine but is a separate personal-data taxonomy.
describe('classifyPersonalSensitivity (escalation guard)', () => {
    it('flags HIGHLY_SENSITIVE for Art.9 health, financial, and credential markers', () => {
        expect(classifyPersonalSensitivity('A TAJ száma 123 456 789, egészségügyi ügy').tier).toBe('HIGHLY_SENSITIVE');
        expect(classifyPersonalSensitivity('kártya: 4111 1111 1111 1111').tier).toBe('HIGHLY_SENSITIVE');
        expect(classifyPersonalSensitivity('IBAN HU42117730161111101800000000 bank').tier).toBe('HIGHLY_SENSITIVE');
        expect(classifyPersonalSensitivity('-----BEGIN RSA PRIVATE KEY-----').tier).toBe('HIGHLY_SENSITIVE');
        expect(classifyPersonalSensitivity('token Bearer abcdefghijklmnopqrstuvwxyz123456').tier).toBe('HIGHLY_SENSITIVE');
        expect(classifyPersonalSensitivity('adószám: 1234567890').tier).toBe('HIGHLY_SENSITIVE');
        expect(classifyPersonalSensitivity('jelszó: titkos123').tier).toBe('HIGHLY_SENSITIVE');
    });
    it('flags SENSITIVE_PERSONAL for phone, home address, date of birth', () => {
        expect(classifyPersonalSensitivity('hívj: +36 30 123 4567').tier).toBe('SENSITIVE_PERSONAL');
        expect(classifyPersonalSensitivity('1051 Budapest, Váci utca 10').tier).toBe('SENSITIVE_PERSONAL');
        expect(classifyPersonalSensitivity('születési dátum: 1985.03.12').tier).toBe('SENSITIVE_PERSONAL');
    });
    it('flags PERSONAL for a bare contact email', () => {
        expect(classifyPersonalSensitivity('kapcsolat: pisti@example.com').tier).toBe('PERSONAL');
    });
    it('returns PUBLIC when nothing sensitive matches', () => {
        const r = classifyPersonalSensitivity('A találkozó holnap 10-kor lesz a parkban.');
        expect(r.tier).toBe('PUBLIC');
        expect(r.matched).toEqual([]);
    });
    it('picks the MOST sensitive tier when multiple markers co-occur', () => {
        // phone (SENSITIVE) + card (HIGHLY) → HIGHLY wins
        expect(classifyPersonalSensitivity('+36 30 123 4567 és 4111 1111 1111 1111').tier).toBe('HIGHLY_SENSITIVE');
    });
});
describe('fail-closed coercion + escalation', () => {
    it('coerces an unknown declared value to HIGHLY_SENSITIVE, never PUBLIC', () => {
        expect(coerceSensitivity('FOO')).toBe('HIGHLY_SENSITIVE');
        expect(coerceSensitivity(undefined)).toBe('HIGHLY_SENSITIVE');
        expect(coerceSensitivity(null)).toBe('HIGHLY_SENSITIVE');
        expect(MOST_SENSITIVE).toBe('HIGHLY_SENSITIVE');
        // a known value passes through
        expect(coerceSensitivity('PERSONAL')).toBe('PERSONAL');
    });
    it('escalateSensitivity returns the more sensitive of two tiers', () => {
        expect(escalateSensitivity('PUBLIC', 'HIGHLY_SENSITIVE')).toBe('HIGHLY_SENSITIVE');
        expect(escalateSensitivity('SENSITIVE_PERSONAL', 'PERSONAL')).toBe('SENSITIVE_PERSONAL');
        expect(escalateSensitivity('PERSONAL', 'PERSONAL')).toBe('PERSONAL');
    });
    it('effectiveSensitivity escalates a declared tier when content is more sensitive, never lowers it', () => {
        // declared PERSONAL, content has a card → HIGHLY
        expect(effectiveSensitivity('PERSONAL', 'kártya 4111 1111 1111 1111')).toBe('HIGHLY_SENSITIVE');
        // declared HIGHLY, content public → stays HIGHLY (no de-escalation)
        expect(effectiveSensitivity('HIGHLY_SENSITIVE', 'semmi érzékeny itt')).toBe('HIGHLY_SENSITIVE');
        // declared bogus, content public → fail-closed HIGHLY
        expect(effectiveSensitivity('BOGUS', 'semmi érzékeny')).toBe('HIGHLY_SENSITIVE');
    });
});
describe('model-profile allowlist (P0.6 wiring, fail-closed)', () => {
    it('PUBLIC allows every profile; each tier up narrows it', () => {
        expect(isProfileAllowedForSensitivity('routine_lowcost', 'PUBLIC')).toBe(true);
        expect(isProfileAllowedForSensitivity('routine_lowcost', 'PERSONAL')).toBe(false);
        expect(isProfileAllowedForSensitivity('analysis_efficient', 'PERSONAL')).toBe(true);
        expect(isProfileAllowedForSensitivity('analysis_efficient', 'SENSITIVE_PERSONAL')).toBe(false);
        expect(isProfileAllowedForSensitivity('build_strong', 'SENSITIVE_PERSONAL')).toBe(true);
        expect(isProfileAllowedForSensitivity('build_strong', 'HIGHLY_SENSITIVE')).toBe(false);
        expect(isProfileAllowedForSensitivity('premium_reasoning', 'HIGHLY_SENSITIVE')).toBe(true);
    });
    it('is fail-closed: unknown tier → HIGHLY allowlist; unknown profile → never allowed', () => {
        expect(isProfileAllowedForSensitivity('premium_reasoning', 'BOGUS_TIER')).toBe(true); // BOGUS→HIGHLY, premium allowed
        expect(isProfileAllowedForSensitivity('routine_lowcost', 'BOGUS_TIER')).toBe(false); // BOGUS→HIGHLY, routine denied
        expect(isProfileAllowedForSensitivity('nonexistent_profile', 'PUBLIC')).toBe(false); // unknown profile never allowed
        expect([...allowedProfilesFor('BOGUS')]).toEqual(['premium_reasoning']);
    });
});
describe('evaluatePersonalDispatch (end-to-end)', () => {
    it('blocks a low-cost profile when content escalates a PERSONAL case to HIGHLY', () => {
        const r = evaluatePersonalDispatch('a kártyaszám 4111 1111 1111 1111', 'PERSONAL', 'routine_lowcost');
        expect(r.tier).toBe('HIGHLY_SENSITIVE');
        expect(r.verdict).toBe('block');
        expect(r.matched).toContain('credit_card_number');
    });
    it('allows the premium profile for the same escalated content', () => {
        const r = evaluatePersonalDispatch('a kártyaszám 4111 1111 1111 1111', 'PERSONAL', 'premium_reasoning');
        expect(r.tier).toBe('HIGHLY_SENSITIVE');
        expect(r.verdict).toBe('allow');
    });
    it('allows any profile for genuinely public content', () => {
        const r = evaluatePersonalDispatch('a találkozó holnap a parkban', 'PUBLIC', 'routine_lowcost');
        expect(r.tier).toBe('PUBLIC');
        expect(r.verdict).toBe('allow');
    });
});
