// Lean Optimization Phase 3 -- capacity-aware runtime routing sweep.
//
// Card 59b383a9. Supersedes the model-fallback-on-limit runner's ACTION path
// (model-fallback-runner.ts): that runner's config-write (writeModelFor /
// writeMainModel, rewriting agent-config.json / .claude/settings.json) is the
// exact violation this phase forbids, so it has been removed from that file
// entirely -- see the comment left there. This runner reuses its I/O plumbing
// (capturePane / paneLooksIdle / restartAgentProcess / detectsUsageLimit) but
// replaces the decision with the Phase 3 registry + resolver
// (src/capacity-routing.js) and replaces the action with a runtime-overlay
// write/clear (src/web/capacity-routing-store.js) instead of a config write.
//
// SCOPE BOUNDARY (accepted by marveen 2026-07-30, card 59b383a9 comment
// 8261: "the main session is service-managed and its model comes from
// .claude/settings.json, which this phase must not write"): the MAIN agent
// (marveen) is launched via hardRestartMarveenChannels() / channels.sh, which
// reads .claude/settings.json directly inside the `claude` binary itself --
// there is no TS-side --model flag construction to intercept the way there is
// for sub-agents in agent-process.ts. Extending routing to main would require
// either changing channels.sh's own launch path or writing that config file,
// the latter being exactly what this phase forbids. This sweep covers
// sub-agents only; main is left exactly as configured, which was already the
// live behaviour (the old runner's main path was config-write, and inert in
// practice since store/model-fallback.json never existed). Extending
// channels.sh to read the same overlay is future work, not a silent gap.
//
// CAPACITY GRANULARITY DECISION (marveen 2026-07-30: "not a to-do note" --
// the fleet genuinely runs TWO Anthropic auth profiles today, `host_default`
// and `configdir:.claude-personal`, each an independent quota pool; live
// dispatch rows already tell them apart via dispatches.auth_profile). This
// pass reads capacity PER PROVIDER, not per (provider, authProfile): P2-C's
// subscriptions config (store/costops-subscriptions.json) has one entry per
// PROVIDER, with no authProfile field, so `capacityStateFor()` below matches
// by provider alone and both Anthropic auth profiles currently read the SAME
// usage figure. THE EXACT MIS-READ THIS CAUSES: if `host_default` is the one
// actually near its plan limit while `configdir:.claude-personal` still has
// headroom, this registry reports BOTH as constrained (an agent on the
// healthy profile is denied a fallback it should be entitled to, or is
// wrongly routed away from a primary that was fine for IT specifically) --
// or the reverse, a genuinely exhausted profile reads as healthy because the
// OTHER profile's fresher reading is what got stored last. Both directions
// are silent: nothing in the current data model can tell them apart.
// DECISION (this pass): document precisely rather than extend the schema now
// -- fixing it means adding a nullable `auth_profile` column to
// `provider_ratelimit_snapshots` (idempotent ALTER, same pattern as the
// existing usage_confidence/snapshot_source columns in schema.ts) plus an
// optional `authProfile` field per entry in the subscriptions config, and
// teaching whatever supplies a manual/collector reading which auth profile it
// is FOR. That is a P2-C (already-shipped, already-live) schema extension,
// not a Phase 3 addition, and doing it inside this branch would silently
// widen this phase's blast radius onto merged, running code. Left for a
// follow-up item under P2-C, named exactly instead of left implicit.

import { logger } from '../logger.js'
import { getDb } from '../db.js'
import { listAgentNames } from './agent-config.js'
import { agentRunState, agentSessionName, restartAgentProcess, capturePane } from './agent-process.js'
import { paneLooksIdle } from '../pane-state.js'
import { resolveAgentModelDetailed, readAgentModelProfile } from './agent-config.js'
import { resolveAuthProfile } from '../costops/dispatch-identity.js'
import { resolveAgentConfigDir } from './claude-plans.js'
import { deriveProvider } from '../costops/pricing.js'
import { loadSubscriptionsConfig } from '../costops/subscriptions.js'
import { deriveLifecycle } from '../costops/subscriptions.js'
import { usageFigure, freshnessOf, CAPACITY_STALE_AFTER_SECONDS } from '../costops/capacity.js'
import { insertRoutingEvent, resolveOutcome } from '../costops/dispatch.js'
import { detectsUsageLimit } from '../model-fallback.js'
import {
  readCapacityRoutingConfig,
  readRuntimeOverlay,
  writeRuntimeOverlay,
  clearRuntimeOverlay,
} from './capacity-routing-store.js'
import {
  deriveCapacityState,
  resolveRuntimeRouting,
  shouldClimbBackToPrimary,
  classifyError,
  capacityKeyId,
  type CapacityState,
  type FallbackCandidate,
} from '../capacity-routing.js'
import { homedir } from 'node:os'
import type Database from 'better-sqlite3'

const INITIAL_DELAY_MS = 55_000 // offset from the other 50s/60s watchers
const INTERVAL_MS = 60_000

/** The agent's most recent dispatch_id, or null if it has never dispatched. */
function latestDispatchIdForAgent(db: Database.Database, agent: string): string | null {
  try {
    const row = db.prepare(
      `SELECT dispatch_id FROM dispatches WHERE agent = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(agent) as { dispatch_id: string } | undefined
    return row?.dispatch_id ?? null
  } catch {
    return null
  }
}

/** True when the agent has a dispatch that has not reached a terminal outcome. */
function isPackageOpen(db: Database.Database, agent: string): { open: boolean; dispatchId: string | null } {
  const dispatchId = latestDispatchIdForAgent(db, agent)
  if (!dispatchId) return { open: false, dispatchId: null }
  const outcome = resolveOutcome(db, dispatchId)
  const terminal = outcome === 'accepted' || outcome === 'failed' || outcome === 'cancelled'
  return { open: !terminal, dispatchId }
}

function capacityStateFor(
  db: Database.Database,
  provider: string,
  authProfile: string,
  now: number,
  activeBlockingSignal: boolean,
): CapacityState {
  const { config } = loadSubscriptionsConfig()
  const lifecycle = deriveLifecycle(config, now)
  // Honest coarseness (see file header): matched by provider only.
  const sub = lifecycle.find((s) => s.provider === provider)
  if (!sub) {
    return deriveCapacityState({
      usageFraction: null, usageConfidence: 'unknown', ageSeconds: null,
      staleAfterSeconds: CAPACITY_STALE_AFTER_SECONDS, activeBlockingSignal,
    })
  }
  const usage = usageFigure(db, sub, now)
  const fresh = freshnessOf(usage.freshness.as_of, now)
  return deriveCapacityState({
    usageFraction: usage.value,
    usageConfidence: usage.confidence,
    ageSeconds: fresh.age_seconds,
    staleAfterSeconds: CAPACITY_STALE_AFTER_SECONDS,
    activeBlockingSignal,
  }, undefined) // uses the module default limitedThreshold; see checkAgent for the config-driven override path
}

async function checkAgent(name: string, nowMs: number, candidates: FallbackCandidate[], ttlMs: number): Promise<void> {
  if (agentRunState(name) !== 'running') return

  const session = agentSessionName(name)
  const pane = capturePane(session, null)
  if (pane == null) return

  const db = getDb()
  const nowSec = Math.floor(nowMs / 1000)

  const configuredResolution = resolveAgentModelDetailed(name)
  const configuredModel = configuredResolution.model
  const configuredProvider = deriveProvider(configuredModel)
  const configuredAuthProfile = resolveAuthProfile(name, { resolveConfigDir: resolveAgentConfigDir, homeDir: homedir() })
  const configuredKey = capacityKeyId({ provider: configuredProvider, authProfile: configuredAuthProfile })

  const limitBannerShowing = detectsUsageLimit(pane)
  const primaryState = capacityStateFor(db, configuredProvider, configuredAuthProfile, nowSec, limitBannerShowing)
  const errorClass = limitBannerShowing ? classifyError({ kind: 'usage_limit_banner' }) : null

  const overlay = readRuntimeOverlay(name)
  const { open: packageOpen, dispatchId } = isPackageOpen(db, name)

  const candidateStates = new Map<string, CapacityState>()
  for (const c of candidates) {
    const s = capacityStateFor(db, c.provider, c.authProfile, nowSec, false)
    candidateStates.set(capacityKeyId(c), s)
  }

  let decision:
    | { kind: 'set'; candidate: FallbackCandidate; reasonCode: string }
    | { kind: 'clear'; reasonCode: string }
    | { kind: 'none'; reasonCode: string }

  if (overlay) {
    // Already on a fallback: only consider climbing back, never re-evaluate a
    // fresh routing decision mid-fallback (that is what sticky routing means
    // once an overlay is active -- a NEW routing decision only ever happens
    // from the primary side, in the branch below).
    if (packageOpen) {
      decision = { kind: 'none', reasonCode: 'sticky_package_open_on_fallback' }
    } else {
      const climb = shouldClimbBackToPrimary({
        overlaySetAtMs: overlay.setAtMs, nowMs, ttlMs,
        providerStatedResetAtMs: null, // no provider-stated reset is observable today; TTL guess only
        primaryCapacityState: primaryState,
      })
      decision = climb
        ? { kind: 'clear', reasonCode: 'primary_recovered_climb_back' }
        : { kind: 'none', reasonCode: 'ttl_not_elapsed_or_primary_still_constrained' }
    }
  } else {
    const routing = resolveRuntimeRouting({
      primaryState,
      candidates,
      candidateStates,
      packageOpen,
      fallbacksUsedThisPackage: 0, // no overlay yet this package => no auto-fallback consumed yet
      errorClass,
    })
    decision = routing.action === 'fallback'
      ? { kind: 'set', candidate: routing.to, reasonCode: routing.reasonCode }
      : { kind: 'none', reasonCode: routing.reasonCode }
  }

  if (decision.kind === 'none') {
    logger.debug({ name, reasonCode: decision.reasonCode }, 'capacity-routing: no change')
    return
  }

  // A model change takes effect only via respawn; never cut a live turn.
  if (!paneLooksIdle(pane)) {
    logger.info({ name, action: decision.kind }, 'capacity-routing: action due but pane busy, deferring')
    return
  }

  try {
    if (decision.kind === 'set') {
      writeRuntimeOverlay(name, {
        model: decision.candidate.model,
        provider: decision.candidate.provider,
        authProfile: decision.candidate.authProfile,
        dispatchId,
        fallbacksUsedThisPackage: (overlay?.fallbacksUsedThisPackage ?? 0) + 1,
        setAtMs: nowMs,
        reasonCode: decision.reasonCode,
      })
      insertRoutingEvent(db, {
        dispatchId, agent: name,
        configuredModel, runtimeModel: decision.candidate.model,
        provider: decision.candidate.provider, authProfile: decision.candidate.authProfile,
        capacityState: primaryState, reasonCode: decision.reasonCode, fallbackUsed: 1,
      }, nowSec)
    } else {
      clearRuntimeOverlay(name)
      insertRoutingEvent(db, {
        dispatchId, agent: name,
        configuredModel, runtimeModel: configuredModel,
        provider: configuredProvider, authProfile: configuredAuthProfile,
        capacityState: primaryState, reasonCode: decision.reasonCode, fallbackUsed: 0,
      }, nowSec)
    }
    await restartAgentProcess(name, { fresh: false })
    logger.info({ name, decision: decision.kind, reasonCode: decision.reasonCode }, 'capacity-routing: applied')
  } catch (err) {
    logger.warn({ err, name }, 'capacity-routing: apply failed')
  }
}

export function startCapacityRoutingRunner(): NodeJS.Timeout {
  async function sweep() {
    const cfg = readCapacityRoutingConfig()
    if (!cfg.enabled) return
    const now = Date.now()
    for (const name of listAgentNames()) {
      try { await checkAgent(name, now, cfg.candidates, cfg.ttlMs) }
      catch (err) { logger.debug({ err, agent: name }, 'capacity-routing: agent check error') }
    }
  }
  setTimeout(() => { void sweep() }, INITIAL_DELAY_MS)
  return setInterval(() => { void sweep() }, INTERVAL_MS)
}
