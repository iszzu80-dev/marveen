// Personal Chief of Staff (COS) — dynamic model routing by sensitivity (spec §F).
//
// The static P0.6 policy (sensitivity.ts PROFILE_ALLOWLIST) says WHICH model
// profiles MAY process a given data-sensitivity tier. This adds the dynamic step:
// given a task's effective tier + a strategy, PICK one profile from the allowed
// set. Sensitivity constrains the choice — you can only downgrade to a cheaper
// model within what the tier permits, so HIGHLY_SENSITIVE (allowed:
// premium_reasoning only) never gets a cost downgrade.
//
// HONEST LIMIT (data residency): routing cannot send HIGHLY_SENSITIVE data to an
// EU/local model for residency, because the Anthropic direct API exposes no EU
// inference geo (see memory anthropic-direct-api-no-eu-inference-geo) and there
// is no EU/local profile in MODEL_PROFILE_IDS. So this is capability/cost routing
// WITHIN the sensitivity-allowed set, not geo routing. If an EU/local profile is
// added later, extend PROFILE_ALLOWLIST and this picks it up automatically.
import { allowedProfilesFor, coerceSensitivity } from './sensitivity.js';
import { MODEL_PROFILE_IDS } from '../model-profiles.js';
/**
 * Route a task to a model profile given its data-sensitivity tier. Fail-closed:
 * an unknown tier is treated as HIGHLY_SENSITIVE (allowedProfilesFor coerces it),
 * so an unclassifiable task never gets a cheap/broad model. 'capability' picks
 * the most capable allowed profile; 'cost' (default) the cheapest allowed.
 */
export function routeModelForSensitivity(tier, opts = {}) {
    const strategy = opts.strategy ?? 'cost';
    const effectiveTier = coerceSensitivity(tier);
    const allowed = allowedProfilesFor(tier);
    // MODEL_PROFILE_IDS is ordered most-capable → cheapest.
    const candidates = MODEL_PROFILE_IDS.filter(p => allowed.has(p));
    if (candidates.length === 0) {
        return { profile: null, tier: effectiveTier, strategy, candidates: [], reason: `no profile allowed for ${effectiveTier} (fail-closed: do not route)` };
    }
    const profile = strategy === 'capability' ? candidates[0] : candidates[candidates.length - 1];
    return {
        profile, tier: effectiveTier, strategy, candidates,
        reason: `${strategy} → ${profile} (allowed for ${effectiveTier}: ${candidates.join(', ')})`,
    };
}
