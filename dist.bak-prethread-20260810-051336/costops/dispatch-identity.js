// CostOps Phase 2 / P2-C -- dispatch IDENTITY stamping (MEASUREMENT ONLY).
//
// The gap this closes: P2-A created the `dispatches` table WITH the
// model_profile / configured_model / runtime_model / provider / auth_profile /
// billing_mode columns and threaded a dispatch_id from every origin -- but no
// origin ever POPULATED those columns. Every live row read:
//
//   model_profile NULL  configured_model NULL  runtime_model NULL
//   provider NULL       auth_profile NULL      billing_mode NULL
//
// so spec 7.5's required grouping of cost_per_accepted_task by agent /
// modelProfile / model / provider / billingMode could only ever group by
// `agent`. The columns, the join and the read function were all built; only the
// write was missing. This module is that write, and nothing else.
//
// It INVENTS NO RESOLVER. Every value comes from something the codebase already
// knows:
//   - configured_model / model_profile : resolveAgentModelDetailed (Phase 1,
//     web/agent-config.ts -> model-profiles.ts)
//   - provider                        : deriveProvider (costops/pricing.ts)
//   - auth_profile                    : the per-agent Claude login binding the
//     LAUNCHER itself uses -- resolveAgentConfigDir (web/claude-plans.ts)
//   - billing_mode                    : resolveBillingMode + loadBillingMap
//     (costops/dispatch.ts), config-driven, never a provider-name heuristic
//
// PHASE 2 HAS NO RUNTIME ROUTING. runtime_model is therefore set EQUAL to the
// configured model, from the single expression below -- it is not a second
// resolution and there is no routing/fallback/model-switching code here. Phase 3
// is what makes the two diverge; until then a divergence would be a bug, and
// dispatch-model-stamping.test.ts asserts the equality.
//
// DATA SENSITIVITY (hard, inherited from dispatch.ts): no value produced here
// may carry prompt text, PII, secrets or credentials. In particular auth_profile
// is NEVER an absolute path: a config dir under $HOME is stored home-relative
// (so the OS username never lands in the DB, which the dashboard API serves),
// and a dir outside $HOME degrades to its basename.
//
// COST: three small synchronous local reads per dispatch (the agent's
// agent-config.json, plus store/billing-map.json), on a path that already scans
// transcript directories to resolve session_id. The model-profile map and the
// Claude-plan registry are already mtime-memoized by their own modules. No extra
// caching is added -- there is nothing expensive here to memoize.
import { basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../logger.js';
import { deriveProvider } from './pricing.js';
import { loadBillingMap, resolveBillingMode } from './dispatch.js';
import { resolveAgentModelDetailed, readAgentModelProfile } from '../web/agent-config.js';
import { resolveAgentConfigDir } from '../web/claude-plans.js';
/**
 * What a resolver FAULT stamps: the four descriptive columns stay NULL (an
 * un-resolvable dispatch is honestly unattributed, never guessed) and
 * billing_mode is 'unknown' -- the same sentinel resolveBillingMode already
 * returns for a missing/unmapped config, so "we could not determine it" has
 * exactly ONE spelling instead of two (NULL and 'unknown').
 */
export const UNRESOLVED_DISPATCH_IDENTITY = {
    modelProfile: null,
    configuredModel: null,
    runtimeModel: null,
    provider: null,
    authProfile: null,
    billingMode: 'unknown',
};
/** auth_profile for an agent bound to no named plan and no explicit config dir. */
export const HOST_DEFAULT_AUTH_PROFILE = 'host_default';
/**
 * The real wiring. `deriveProvider` here is the pricing.ts export by reference,
 * NOT a copy: there must never be a second provider mapping in this codebase,
 * and dispatch-model-stamping.test.ts asserts this identity.
 *
 * Built lazily (a function, not a module-level const) on purpose: this module is
 * imported by every dispatch origin, and binding the upstream resolvers at
 * IMPORT time makes a partial test-double of web/agent-config.js -- of which
 * several already exist for the router -- explode while merely loading the
 * router, instead of at most degrading one resolution.
 */
export function defaultDispatchIdentityDeps() {
    return {
        resolveModel: resolveAgentModelDetailed,
        readModelProfile: readAgentModelProfile,
        resolveConfigDir: resolveAgentConfigDir,
        deriveProvider,
        loadBillingMap,
        homeDir: homedir(),
    };
}
/**
 * Stable, non-sensitive identifier for a CLAUDE_CONFIG_DIR. A dir inside $HOME
 * becomes its home-RELATIVE path (unique across the worker/agent dirs, and the
 * OS username never reaches the DB); $HOME itself becomes 'home'; anything
 * outside $HOME degrades to its basename -- deliberately lossy rather than
 * storing an absolute filesystem path, at the cost of a theoretical collision
 * between two same-named dirs in different parents.
 */
export function configDirIdentifier(configDir, homeDir) {
    if (configDir === homeDir)
        return 'home';
    if (homeDir && configDir.startsWith(homeDir + sep))
        return configDir.slice(homeDir.length + 1);
    return basename(configDir);
}
/**
 * The agent's auth profile == the Claude login the LAUNCHER will actually use.
 * resolveAgentConfigDir is the one place that decides that (named plan wins over
 * the raw claudeConfigDir; an unresolved plan id falls back to the raw dir), so
 * this reads it rather than re-deciding. Namespaced ('plan:' / 'configdir:' /
 * the host-default constant) so a plan id and a dir name can never collide in
 * the billing map's key space.
 */
export function resolveAuthProfile(agent, deps) {
    const { configDir, planId } = deps.resolveConfigDir(agent);
    // A resolved named plan is the most stable, operator-facing identity: many
    // agents share one login under one id. resolveAgentConfigDir already reports
    // planId as null when the plan is missing/dangling, so this branch can only
    // fire for a login that really exists.
    if (planId)
        return `plan:${planId}`;
    if (!configDir)
        return HOST_DEFAULT_AUTH_PROFILE;
    return `configdir:${configDirIdentifier(configDir, deps.homeDir)}`;
}
/**
 * Resolve the six identity columns for one dispatch. Pure w.r.t. the DB; may
 * throw (agentDir() rejects a traversal-shaped agent name, a config file can be
 * unreadable) -- which is why every ORIGIN calls resolveDispatchIdentitySafe.
 */
export function resolveDispatchIdentity(agent, overrides = {}, deps = defaultDispatchIdentityDeps()) {
    let modelProfile = null;
    let configuredModel;
    if (overrides.configuredModel) {
        // Origin knows the exact launched model (agent-worker). No profile applies:
        // the worker is launched with a literal --model, not through the per-agent
        // profile indirection, and claiming a profile it never used would be a lie.
        configuredModel = overrides.configuredModel;
    }
    else {
        const resolution = deps.resolveModel(agent);
        configuredModel = resolution.model;
        // model_profile is stamped ONLY when the profile was actually HONOURED.
        // A configured-but-unusable profile (unknown id, missing/broken map) makes
        // the agent run on the install default; attributing that cost to the named
        // profile would misreport which profile the dispatch ran on. It stays NULL
        // and the misconfiguration is logged instead of silently absorbed.
        if (resolution.source === 'model_profile') {
            modelProfile = deps.readModelProfile(agent);
        }
        else if (resolution.error) {
            logger.warn({ agent, modelProfileError: resolution.error, model: resolution.model }, 'dispatch identity: agent names a model profile that could not be honoured; model_profile stays NULL');
        }
    }
    const provider = deps.deriveProvider(configuredModel);
    const authProfile = overrides.configDir
        ? `configdir:${configDirIdentifier(overrides.configDir, deps.homeDir)}`
        : resolveAuthProfile(agent, deps);
    const billingMode = resolveBillingMode(deps.loadBillingMap(), provider, authProfile);
    return {
        modelProfile,
        configuredModel,
        // PHASE 2 INVARIANT: no runtime routing exists, so the runtime model IS the
        // configured model -- one expression, not a second resolution.
        runtimeModel: configuredModel,
        provider,
        authProfile,
        billingMode,
    };
}
/**
 * Best-effort identity resolution for the hot dispatch paths, mirroring
 * createDispatchSafe: identity is MEASUREMENT, so a resolver fault must never
 * block a send (program principle 20). A fault stamps
 * UNRESOLVED_DISPATCH_IDENTITY -- the dispatch is still created, just
 * un-attributed. `resolve` is injectable so the fault path is directly testable.
 */
export function resolveDispatchIdentitySafe(agent, overrides = {}, resolve = resolveDispatchIdentity) {
    try {
        return resolve(agent, overrides);
    }
    catch (err) {
        logger.warn({ err, agent }, 'resolveDispatchIdentity failed; dispatch stamped un-attributed (send unaffected)');
        return { ...UNRESOLVED_DISPATCH_IDENTITY };
    }
}
