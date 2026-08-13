import { homedir } from 'node:os'
import type Database from 'better-sqlite3'
import {
  MAX_FALLBACK_CANDIDATES,
  capacityKeyId,
  resolveRuntimeRouting,
  type CapacityState,
  type RoutingDecision,
} from '../capacity-routing.js'
import { resolveAuthProfile } from '../costops/dispatch-identity.js'
import { deriveProvider } from '../costops/pricing.js'
import {
  listAgentNames,
  resolveAgentModelDetailed,
} from '../web/agent-config.js'
import {
  capacityStateFor,
} from '../web/capacity-routing-runner.js'
import {
  readCapacityRoutingConfig,
  readRuntimeOverlay,
} from '../web/capacity-routing-store.js'
import { resolveAgentConfigDir } from '../web/claude-plans.js'

export interface AgentRoutingRow {
  agent: string
  configured_primary: string
  provider: string
  runtime_model: string
  capacity_state: CapacityState
  routing_state: 'primary' | 'fallback' | 'static_mode' | 'unknown'
  fallback_reason: string | null
  last_decision_at: number | null
}

function authProfileFor(agent: string): string {
  return resolveAuthProfile(agent, {
    resolveConfigDir: resolveAgentConfigDir,
    homeDir: homedir(),
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function buildRoutingSnapshot(
  db: Database.Database,
  now: number,
  opts: { runtimeRoutingEnabled: boolean; overlayPath?: string } = { runtimeRoutingEnabled: true },
): AgentRoutingRow[] {
  return listAgentNames().map((agent): AgentRoutingRow => {
    let configuredPrimary = 'unknown'
    let provider = 'unknown'
    try {
      configuredPrimary = resolveAgentModelDetailed(agent).model
      provider = deriveProvider(configuredPrimary)
      const authProfile = authProfileFor(agent)
      const capacityState = capacityStateFor(db, provider, authProfile, now, false)
      const overlay = opts.overlayPath === undefined
        ? readRuntimeOverlay(agent)
        : readRuntimeOverlay(agent, opts.overlayPath)

      if (!opts.runtimeRoutingEnabled) {
        // OPT-C1 (review 2026-08-12): static_mode used to report
        // runtime_model = configured_primary WITHOUT reading the overlay --
        // exactly when routing is switched off is when a surviving overlay
        // means an agent is still sitting on its fallback model, and this
        // view was the instrument claiming otherwise. Report reality: the
        // overlay model when one exists, with a fallback_reason marking that
        // routing is off yet the agent has not returned to its primary.
        return {
          agent,
          configured_primary: configuredPrimary,
          provider,
          runtime_model: overlay?.model ?? configuredPrimary,
          capacity_state: capacityState,
          routing_state: 'static_mode',
          fallback_reason: overlay ? `routing_disabled_overlay_active:${overlay.reasonCode}` : null,
          last_decision_at: overlay ? Math.floor(overlay.setAtMs / 1000) : null,
        }
      }

      return {
        agent,
        configured_primary: configuredPrimary,
        provider,
        runtime_model: overlay?.model ?? configuredPrimary,
        capacity_state: capacityState,
        routing_state: overlay ? 'fallback' : 'primary',
        fallback_reason: overlay?.reasonCode ?? null,
        last_decision_at: overlay ? Math.floor(overlay.setAtMs / 1000) : null,
      }
    } catch (error) {
      return {
        agent,
        configured_primary: configuredPrimary,
        provider,
        runtime_model: configuredPrimary,
        capacity_state: 'unknown',
        routing_state: 'unknown',
        fallback_reason: errorMessage(error),
        last_decision_at: null,
      }
    }
  })
}

export interface RoutingPreviewInput {
  agent: string
}

export interface RoutingPreviewResult {
  agent: string
  configured_primary: string
  provider: string
  capacity_state: CapacityState
  decision: RoutingDecision
  would_change: boolean
  note: string
}

function noteForDecision(decision: RoutingDecision): string {
  switch (decision.action) {
    case 'stay_primary':
      return decision.reasonCode === 'primary_capacity_ok'
        ? 'primary capacity ok, no change'
        : `would stay on primary (${decision.reasonCode})`
    case 'hold_current_overlay':
      return `would hold the current overlay (${decision.reasonCode})`
    case 'fallback':
      return `would fall back to ${decision.to.model} (${decision.reasonCode})`
    case 'no_eligible_fallback':
      return 'no eligible fallback candidate'
    case 'ceiling_reached':
      return `automatic fallback ceiling reached (${decision.reasonCode})`
  }
}

/**
 * Read-only by construction: it reads capacity/config state and asks the pure
 * resolver for a decision, without persisting or applying that decision.
 *
 * There is no existing production caller of resolveRuntimeRouting that is
 * side-effect-free; this dashboard preview is the first one.
 */
export function previewRuntimeRouting(
  db: Database.Database,
  input: RoutingPreviewInput,
  now: number,
): RoutingPreviewResult {
  const configuredPrimary = resolveAgentModelDetailed(input.agent).model
  const provider = deriveProvider(configuredPrimary)
  const authProfile = authProfileFor(input.agent)
  const primaryState = capacityStateFor(db, provider, authProfile, now, false)
  const config = readCapacityRoutingConfig()
  const candidates = config.candidates.slice(0, MAX_FALLBACK_CANDIDATES)
  const candidateStates = new Map<string, CapacityState>()

  for (const candidate of config.candidates) {
    candidateStates.set(
      capacityKeyId(candidate),
      capacityStateFor(db, candidate.provider, candidate.authProfile, now, false),
    )
  }

  const decision = resolveRuntimeRouting({
    primaryState,
    candidates,
    candidateStates,
    packageOpen: false,
    fallbacksUsedThisPackage: 0,
    errorClass: null,
  })

  return {
    agent: input.agent,
    configured_primary: configuredPrimary,
    provider,
    capacity_state: primaryState,
    decision,
    would_change: decision.action === 'fallback',
    note: noteForDecision(decision),
  }
}

// Concatenated spellings let source scans detect real call sites without the
// guard's own data values becoming false positives.
export const ROUTING_PREVIEW_FORBIDDEN_CALLS = [
  'writeRuntime' + 'Overlay',
  'clearRuntime' + 'Overlay',
  'restartAgent' + 'Process',
  'insertRouting' + 'Event',
]
