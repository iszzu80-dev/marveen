import { homedir } from 'node:os';
import { MAX_FALLBACK_CANDIDATES, capacityKeyId, resolveRuntimeRouting, } from '../capacity-routing.js';
import { resolveAuthProfile } from '../costops/dispatch-identity.js';
import { deriveProvider } from '../costops/pricing.js';
import { listAgentNames, resolveAgentModelDetailed, } from '../web/agent-config.js';
import { capacityStateFor, } from '../web/capacity-routing-runner.js';
import { readCapacityRoutingConfig, readRuntimeOverlay, } from '../web/capacity-routing-store.js';
import { resolveAgentConfigDir } from '../web/claude-plans.js';
function authProfileFor(agent) {
    return resolveAuthProfile(agent, {
        resolveConfigDir: resolveAgentConfigDir,
        homeDir: homedir(),
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function buildRoutingSnapshot(db, now, opts = { runtimeRoutingEnabled: true }) {
    return listAgentNames().map((agent) => {
        let configuredPrimary = 'unknown';
        let provider = 'unknown';
        try {
            configuredPrimary = resolveAgentModelDetailed(agent).model;
            provider = deriveProvider(configuredPrimary);
            const authProfile = authProfileFor(agent);
            const capacityState = capacityStateFor(db, provider, authProfile, now, false);
            if (!opts.runtimeRoutingEnabled) {
                return {
                    agent,
                    configured_primary: configuredPrimary,
                    provider,
                    runtime_model: configuredPrimary,
                    capacity_state: capacityState,
                    routing_state: 'static_mode',
                    fallback_reason: null,
                    last_decision_at: null,
                };
            }
            const overlay = readRuntimeOverlay(agent);
            return {
                agent,
                configured_primary: configuredPrimary,
                provider,
                runtime_model: overlay?.model ?? configuredPrimary,
                capacity_state: capacityState,
                routing_state: overlay ? 'fallback' : 'primary',
                fallback_reason: overlay?.reasonCode ?? null,
                last_decision_at: overlay ? Math.floor(overlay.setAtMs / 1000) : null,
            };
        }
        catch (error) {
            return {
                agent,
                configured_primary: configuredPrimary,
                provider,
                runtime_model: configuredPrimary,
                capacity_state: 'unknown',
                routing_state: 'unknown',
                fallback_reason: errorMessage(error),
                last_decision_at: null,
            };
        }
    });
}
function noteForDecision(decision) {
    switch (decision.action) {
        case 'stay_primary':
            return decision.reasonCode === 'primary_capacity_ok'
                ? 'primary capacity ok, no change'
                : `would stay on primary (${decision.reasonCode})`;
        case 'hold_current_overlay':
            return `would hold the current overlay (${decision.reasonCode})`;
        case 'fallback':
            return `would fall back to ${decision.to.model} (${decision.reasonCode})`;
        case 'no_eligible_fallback':
            return 'no eligible fallback candidate';
        case 'ceiling_reached':
            return `automatic fallback ceiling reached (${decision.reasonCode})`;
    }
}
/**
 * Read-only by construction: it reads capacity/config state and asks the pure
 * resolver for a decision, without persisting or applying that decision.
 *
 * There is no existing production caller of resolveRuntimeRouting that is
 * side-effect-free; this dashboard preview is the first one.
 */
export function previewRuntimeRouting(db, input, now) {
    const configuredPrimary = resolveAgentModelDetailed(input.agent).model;
    const provider = deriveProvider(configuredPrimary);
    const authProfile = authProfileFor(input.agent);
    const primaryState = capacityStateFor(db, provider, authProfile, now, false);
    const config = readCapacityRoutingConfig();
    const candidates = config.candidates.slice(0, MAX_FALLBACK_CANDIDATES);
    const candidateStates = new Map();
    for (const candidate of config.candidates) {
        candidateStates.set(capacityKeyId(candidate), capacityStateFor(db, candidate.provider, candidate.authProfile, now, false));
    }
    const decision = resolveRuntimeRouting({
        primaryState,
        candidates,
        candidateStates,
        packageOpen: false,
        fallbacksUsedThisPackage: 0,
        errorClass: null,
    });
    return {
        agent: input.agent,
        configured_primary: configuredPrimary,
        provider,
        capacity_state: primaryState,
        decision,
        would_change: decision.action === 'fallback',
        note: noteForDecision(decision),
    };
}
// Concatenated spellings let source scans detect real call sites without the
// guard's own data values becoming false positives.
export const ROUTING_PREVIEW_FORBIDDEN_CALLS = [
    'writeRuntime' + 'Overlay',
    'clearRuntime' + 'Overlay',
    'restartAgent' + 'Process',
    'insertRouting' + 'Event',
];
