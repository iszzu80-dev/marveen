// Personal Chief of Staff (COS) Slice 0 — static data-sensitivity policy (P0.6).
//
// The fleet-dispatch gate (src/data-sensitivity-gate.ts) classifies content
// into public/internal/restricted for PROVIDER-TRUST decisions and stays
// unchanged. This module is the COS-domain 4-tier PERSONAL-data taxonomy the
// spec (v4.2.1 §P0.6) requires — PUBLIC / PERSONAL / SENSITIVE_PERSONAL /
// HIGHLY_SENSITIVE — plus the model-profile allowlist that says which model
// profile may process each tier. It reuses the gate's ONE matching engine
// (matchSensitivityPatterns) so regex + context-near-match semantics never
// fork.
//
// Two invariants the spec calls out:
//   - The classifier only ESCALATES. A case carries a declared sensitivity
//     (personal_cases.sensitivity, default PERSONAL); the classifier catches
//     content MORE sensitive than declared and raises the effective tier. It
//     never lowers it.
//   - FAIL-CLOSED: an unknown/unrecognised tier is treated as HIGHLY_SENSITIVE
//     (the smallest allowlist), never as PUBLIC.
import { matchSensitivityPatterns } from '../data-sensitivity-gate.js';
import { CASE_SENSITIVITIES } from './schema.js';
import { MODEL_PROFILE_IDS } from '../model-profiles.js';
// Severity order, least → most sensitive. Index = ordinal rank used to
// escalate (max) and to compare tiers.
const SENSITIVITY_RANK = {
    PUBLIC: 0,
    PERSONAL: 1,
    SENSITIVE_PERSONAL: 2,
    HIGHLY_SENSITIVE: 3,
};
// The most sensitive tier — the fail-closed target.
export const MOST_SENSITIVE = 'HIGHLY_SENSITIVE';
// Coerce any value into a known tier, FAIL-CLOSED to HIGHLY_SENSITIVE.
export function coerceSensitivity(value) {
    return typeof value === 'string' && CASE_SENSITIVITIES.includes(value)
        ? value
        : MOST_SENSITIVE;
}
// Return the MORE sensitive of two tiers (the escalation rule).
export function escalateSensitivity(a, b) {
    return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}
// ---- classifier pattern sets (personal-data oriented) ------------------------
// Checked most-sensitive first; the first tier with any match wins.
const HIGHLY_SENSITIVE_PATTERNS = [
    // GDPR Art.9 special category: health data (Hungarian TAJ near health context)
    { name: 'hungarian_taj', pattern: '\\b\\d{3}\\s?\\d{3}\\s?\\d{3}\\b', context: 'taj|társadalombiztosítás|TB|egészség|orvos|betegség|diagnózis|health|OEP|NEAK', description: 'Hungarian TAJ / health identifier' },
    { name: 'credit_card_number', pattern: '\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b', description: 'Credit/debit card number' },
    { name: 'iban_bank_account', pattern: '\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b', context: 'iban|bank|számla|account|utalás|transfer', description: 'IBAN / bank account number' },
    { name: 'private_key_pem', pattern: '-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----', description: 'PEM private key block' },
    { name: 'api_key_or_token', pattern: '(?:Bearer\\s+[A-Za-z0-9_\\-]{20,}|eyJ[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{10,}|rnd_[A-Za-z0-9]{20,})', description: 'Credential: bearer token, JWT, or Render key' },
    { name: 'hungarian_tax_id', pattern: '\\b\\d{10}\\b', context: 'adószám|adóazonosító|tax.id|NAV|tax_?id', description: 'Hungarian tax ID near tax context' },
    { name: 'password_literal', pattern: '(?:jelszó|password|passwd|pwd)\\s*[:=]\\s*\\S{6,}', description: 'Password literal' },
];
const SENSITIVE_PERSONAL_PATTERNS = [
    { name: 'phone_number_hu', pattern: '(?:\\+36|\\b06)[\\s-]?\\d{1,2}[\\s-]?\\d{3}[\\s-]?\\d{3,4}\\b', description: 'Hungarian phone number' },
    { name: 'home_address', pattern: '\\b\\d{4}\\b', context: 'utca|út\\b|tér|köz|körút|krt|lakcím|address|cím\\b|házszám', description: 'Home address (postal code near street context)' },
    { name: 'date_of_birth', pattern: '\\b(?:19|20)\\d{2}[.\\-/ ]\\d{1,2}[.\\-/ ]\\d{1,2}\\b', context: 'születési|születés|born|birth|dob', description: 'Date of birth near birth context' },
];
const PERSONAL_PATTERNS = [
    { name: 'email_address', pattern: '[\\w.+-]+@[\\w.-]+\\.[\\w]{2,}', description: 'Email address (personal contact)' },
];
// Classify raw content into the highest personal-sensitivity tier whose
// patterns match. No match → PUBLIC. This only ESCALATES; combine with the
// declared tier via escalateSensitivity() to get the effective tier.
export function classifyPersonalSensitivity(content) {
    const highly = matchSensitivityPatterns(content, HIGHLY_SENSITIVE_PATTERNS);
    if (highly.length > 0)
        return { tier: 'HIGHLY_SENSITIVE', matched: highly };
    const sensitive = matchSensitivityPatterns(content, SENSITIVE_PERSONAL_PATTERNS);
    if (sensitive.length > 0)
        return { tier: 'SENSITIVE_PERSONAL', matched: sensitive };
    const personal = matchSensitivityPatterns(content, PERSONAL_PATTERNS);
    if (personal.length > 0)
        return { tier: 'PERSONAL', matched: personal };
    return { tier: 'PUBLIC', matched: [] };
}
// The effective tier = the MORE sensitive of the case's declared tier and what
// the content classifier finds. Declared tier is coerced fail-closed first.
export function effectiveSensitivity(declared, content) {
    return escalateSensitivity(coerceSensitivity(declared), classifyPersonalSensitivity(content).tier);
}
// ---- model-profile allowlist (P0.6 wiring) -----------------------------------
// Static policy: the more sensitive the tier, the fewer (and more controlled)
// model profiles allowed to process it. This is a POLICY table, not a
// provider-trust check (that stays in the fleet gate) — the intent is to route
// sensitive personal data only through our most-controlled profiles. Every tier
// must be present; a missing tier would resolve to `undefined` and the
// fail-closed helper below denies it.
const PROFILE_ALLOWLIST = {
    PUBLIC: new Set(MODEL_PROFILE_IDS),
    PERSONAL: new Set(['premium_reasoning', 'build_strong', 'analysis_efficient']),
    SENSITIVE_PERSONAL: new Set(['premium_reasoning', 'build_strong']),
    HIGHLY_SENSITIVE: new Set(['premium_reasoning']),
};
// Is `profile` allowed to process content of `tier`? FAIL-CLOSED: an unknown
// tier is treated as HIGHLY_SENSITIVE, and an unknown profile is never allowed.
export function isProfileAllowedForSensitivity(profile, tier) {
    const t = coerceSensitivity(tier);
    const allowed = PROFILE_ALLOWLIST[t];
    return allowed.has(profile);
}
// The set of profiles allowed for a tier (fail-closed to the HIGHLY_SENSITIVE set).
export function allowedProfilesFor(tier) {
    return PROFILE_ALLOWLIST[coerceSensitivity(tier)];
}
// Full COS check: classify content, escalate against the declared tier, and
// authorise the target model profile against the effective tier. FAIL-CLOSED
// throughout.
export function evaluatePersonalDispatch(content, declaredSensitivity, targetProfile) {
    const { matched } = classifyPersonalSensitivity(content);
    const tier = effectiveSensitivity(declaredSensitivity, content);
    const allowed = isProfileAllowedForSensitivity(targetProfile, tier);
    return {
        verdict: allowed ? 'allow' : 'block',
        tier,
        matched,
        reason: allowed
            ? `profile=${targetProfile} allowed for tier=${tier}`
            : `profile=${targetProfile} NOT allowed for tier=${tier} (allowed: ${[...allowedProfilesFor(tier)].join(', ')})`,
    };
}
