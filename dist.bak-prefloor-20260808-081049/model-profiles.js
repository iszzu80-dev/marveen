// Behaviour-neutral model profiles (card c755f4b2, Phase 1 Block B).
//
// The point of this layer is ABSTRACTION, not re-tiering. An agent config can
// name a generic capability tier instead of a concrete vendor model id, and the
// concrete mapping lives in a deployment-local file. Phase 1 ships a map whose
// answers are byte-identical to the models the fleet already runs, so turning
// this on changes nothing observable.
//
// Deliberately NOT the same concept as templates/profiles/*.json: that
// `profile` field is a Claude Code PERMISSIONS template (filesystem allow/deny,
// permissionMode) and has nothing to do with model selection. Overloading it
// would couple two unrelated axes, so `modelProfile` is a separate field with
// its own map (spec 5.1).
//
// Pure logic: no fs, no env, no I/O. The runner reads the map.
export const MODEL_PROFILE_IDS = [
    'premium_reasoning',
    'build_strong',
    'analysis_efficient',
    'routine_lowcost',
];
export function isModelProfileId(v) {
    return typeof v === 'string' && MODEL_PROFILE_IDS.includes(v);
}
export function validateModelProfileMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'profile_map_not_an_object' };
    }
    const o = raw;
    if (!o.profiles || typeof o.profiles !== 'object' || Array.isArray(o.profiles)) {
        return { ok: false, error: 'profile_map_missing_profiles' };
    }
    const src = o.profiles;
    const profiles = {};
    for (const id of MODEL_PROFILE_IDS) {
        const value = src[id];
        if (typeof value !== 'string' || !value.trim()) {
            return { ok: false, error: `profile_map_missing_or_empty:${id}` };
        }
        profiles[id] = value.trim();
    }
    for (const key of Object.keys(src)) {
        if (!isModelProfileId(key))
            return { ok: false, error: `profile_map_unknown_profile:${key}` };
    }
    return {
        ok: true,
        map: { profiles, version: typeof o.version === 'string' ? o.version : undefined },
    };
}
/**
 * Resolver precedence (spec 5.3): explicit model > modelProfile > install default.
 *
 * Failure semantics matter more than the happy path here. An unknown profile id
 * or an unusable map must NOT silently fall through to the default model -- that
 * is exactly the "no silent model change" the acceptance criteria forbid, since
 * it would move an agent onto a different provider without anyone asking. Those
 * cases resolve to the default AND carry an `error`, so the caller surfaces the
 * misconfiguration instead of running on a model nobody chose.
 *
 * `aliasResolver` is injected so this module stays free of agent-config imports.
 */
export function resolveAgentModelFromConfig(config, mapState, defaultModel, aliasResolver) {
    // 1. Explicit model always wins, exactly as before this layer existed.
    if (typeof config.model === 'string' && config.model.trim()) {
        return { model: aliasResolver(config.model.trim()), source: 'explicit_model' };
    }
    // 2. modelProfile, when one is configured.
    if (config.modelProfile !== undefined && config.modelProfile !== null && config.modelProfile !== '') {
        if (!isModelProfileId(config.modelProfile)) {
            return { model: defaultModel, source: 'default', error: `unknown_model_profile:${String(config.modelProfile).slice(0, 40)}` };
        }
        if (!mapState) {
            return { model: defaultModel, source: 'default', error: 'model_profile_map_missing' };
        }
        if (!mapState.ok) {
            return { model: defaultModel, source: 'default', error: mapState.error };
        }
        return { model: aliasResolver(mapState.map.profiles[config.modelProfile]), source: 'model_profile' };
    }
    // 3. Install default.
    return { model: defaultModel, source: 'default' };
}
