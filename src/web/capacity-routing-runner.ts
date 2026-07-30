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
// CAPACITY GRANULARITY (card 3ce58384, 2026-07-30 -- RESOLVED, was deferred
// out of Phase 3 per marveen's explicit acceptance in card 59b383a9). The
// fleet runs TWO Anthropic auth profiles, `host_default` and
// `configdir:.claude-personal`, each an independent quota pool; live dispatch
// rows already tell them apart via dispatches.auth_profile. Phase 3 shipped
// reading capacity PER PROVIDER only: THE MIS-READ THAT CAUSED (now fixed) --
// if `host_default` was near its plan limit while `configdir:.claude-personal`
// had headroom, the registry reported BOTH as constrained, or the reverse (a
// genuinely exhausted profile reading healthy because the other profile's
// fresher reading is what got stored last). Both directions were silent.
//
// FIX: `provider_ratelimit_snapshots` gained a nullable `auth_profile` column
// (idempotent ALTER, schema.ts) and `SubscriptionEntry` gained an optional
// `authProfile` field (subscriptions.ts). `findSubscriptionFor()` below
// matches an EXACT (provider, authProfile) entry first; only when none exists
// does it fall back to a provider-wide entry (no authProfile set) -- which is
// exactly today's pre-fix behaviour, so an operator who has not configured
// per-profile entries sees NO change (no forced migration). `usageFigure()`
// (capacity.ts) and `latestRateLimitSnapshot()` (capacity-snapshots.ts) carry
// the same exact-match-vs-provider-wide contract: a provider-wide (unlabelled)
// snapshot never answers for a query that names a specific profile.

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
import { deriveLifecycle, type SubscriptionLifecycle } from '../costops/subscriptions.js'
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

/**
 * Find the subscription entry that answers for (provider, authProfile) --
 * card 3ce58384. Most specific wins: an entry configured for this EXACT auth
 * profile is preferred over a provider-wide entry, so two profiles with their
 * own entries get independent answers instead of sharing one. A provider-wide
 * entry (no authProfile set) still answers for ANY profile of that provider
 * when no more specific entry exists -- this is what "no forced migration"
 * means: an operator who has not configured per-profile entries keeps exactly
 * today's behaviour.
 */
export function findSubscriptionFor(
  lifecycle: SubscriptionLifecycle[],
  provider: string,
  authProfile: string,
): SubscriptionLifecycle | null {
  const exact = lifecycle.find((s) => s.provider === provider && s.authProfile === authProfile)
  if (exact) return exact
  const wide = lifecycle.find((s) => s.provider === provider && !s.authProfile)
  return wide ?? null
}

export function capacityStateFor(
  db: Database.Database,
  provider: string,
  authProfile: string,
  now: number,
  activeBlockingSignal: boolean,
): CapacityState {
  const { config } = loadSubscriptionsConfig()
  const lifecycle = deriveLifecycle(config, now)
  const sub = findSubscriptionFor(lifecycle, provider, authProfile)
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
