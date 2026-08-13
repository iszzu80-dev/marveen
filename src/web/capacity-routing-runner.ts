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
import { latestBalanceSnapshot } from '../costops/capacity-snapshots.js'
import {
  insertRoutingEvent,
  resolveOutcome,
  loadDispatchAttributionConfig,
  TERMINAL_OUTCOMES,
} from '../costops/dispatch.js'
import { readOptimizationConfig } from '../optimization/optimization-config.js'
import { detectsUsageLimit } from '../model-fallback.js'
import {
  readCapacityRoutingConfig,
  readRuntimeOverlay,
  writeRuntimeOverlay,
  clearRuntimeOverlay,
  type RuntimeOverlayEntry,
} from './capacity-routing-store.js'
import {
  deriveCapacityState,
  deriveCapacityStateFromBalance,
  resolveRuntimeRouting,
  shouldClimbBackToPrimary,
  classifyError,
  capacityKeyId,
  type CapacityState,
  type ErrorClass,
  type FallbackCandidate,
} from '../capacity-routing.js'
import { homedir } from 'node:os'
import type Database from 'better-sqlite3'

const INITIAL_DELAY_MS = 55_000 // offset from the other 50s/60s watchers
const INTERVAL_MS = 60_000

/** The agent's most recent dispatch (id + created_at seconds), or null if it has never dispatched. */
function latestDispatchForAgent(db: Database.Database, agent: string): { dispatchId: string; createdAtSec: number } | null {
  try {
    const row = db.prepare(
      `SELECT dispatch_id, created_at FROM dispatches WHERE agent = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(agent) as { dispatch_id: string; created_at: number } | undefined
    return row ? { dispatchId: row.dispatch_id, createdAtSec: row.created_at } : null
  } catch {
    return null
  }
}

/**
 * True when the agent has a dispatch that is still plausibly in flight: no
 * terminal outcome AND younger than the dispatch-attribution window cap.
 *
 * OPT-H1 (review 2026-08-12): "no terminal outcome" alone is NOT "in
 * progress". resolveOutcome defaults to 'unknown', and the dominant dispatch
 * origins never write a terminal outcome at all (successful message delivery
 * and schedule-runner dispatches -- Phase 2 canary: 16/20 stayed 'unknown').
 * The old identity therefore held routing open FOREVER for most agents: a
 * blocked primary never fell back ('sticky_package_open'), and an agent
 * already on an overlay never climbed back even after TTL
 * ('sticky_package_open_on_fallback').
 *
 * The time bound reuses the clock CostOps already trusts for exactly this
 * question: the dispatch-attribution window cap (store/dispatch-attribution.json
 * via loadDispatchAttributionConfig, default
 * DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS = 6h) is the point past which a
 * dispatch "may no longer absorb token_usage rows" -- i.e. the system already
 * declares the work package over for cost-attribution purposes
 * (correlateTokenUsageToDispatches, bound 3). Routing stickiness adopts the
 * same boundary so a package can never be simultaneously CLOSED for
 * attribution but OPEN for routing. The edge is inclusive
 * (open while nowSec <= created_at + cap), mirroring the correlation's
 * `timestamp <= created_at + maxWindowSeconds`.
 *
 * `nowSec`/`maxWindowSeconds` are explicit parameters so tests can drive the
 * clock; the default cap comes from the same deployment-local config the
 * attribution path reads (missing/invalid file -> the committed 6h default,
 * never unbounded).
 */
export function isPackageOpen(
  db: Database.Database,
  agent: string,
  nowSec: number,
  maxWindowSeconds: number = loadDispatchAttributionConfig().maxWindowSeconds,
): { open: boolean; dispatchId: string | null } {
  const latest = latestDispatchForAgent(db, agent)
  if (!latest) return { open: false, dispatchId: null }
  const outcome = resolveOutcome(db, latest.dispatchId)
  if (TERMINAL_OUTCOMES.includes(outcome)) return { open: false, dispatchId: latest.dispatchId }
  const agedOut = nowSec > latest.createdAtSec + maxWindowSeconds
  return { open: !agedOut, dispatchId: latest.dispatchId }
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

// Card 6976aaa2 (Istvan GO 2026-07-30). DeepSeek is a PREPAID account, not a
// subscription plan -- there is no subscriptions-config entry to find and
// none should be invented (that would fabricate a plan window DeepSeek does
// not have). Owner rule, verbatim: fall back to DeepSeek IFF its balance is
// above a small safety floor. $1.00 chosen as a conservative, easily-adjusted
// devops decision (per the card: "balance->threshold = owner/devops
// decision") -- current live balance is ~$8.74 (2026-07-30), so this is not
// tuned to today's number, it is "stop routing well before the account can
// hit exactly zero mid-request", the same spirit as the accounting-overshoot
// margins elsewhere in this program. Not a per-agent/per-request budget --
// a single account-wide floor, matching the single account-wide balance this
// reads from.
//
// Updated to $0.50 (Istvan owner decision 2026-08-08, Telegram): he asked for
// > $0 first, I flagged that removing the margin risks hitting zero mid-request,
// and he chose $0.50 as the compromise -- a smaller but still non-zero safety
// margin. Still an owner/devops-tunable single account-wide floor.
export const DEEPSEEK_BALANCE_FLOOR_USD = 0.5

function capacityStateForDeepSeekBalance(
  db: Database.Database,
  now: number,
  activeBlockingSignal: boolean,
): CapacityState {
  if (activeBlockingSignal) return 'blocked'
  const snap = latestBalanceSnapshot(db, 'deepseek')
  const fresh = freshnessOf(snap?.captured_at ?? null, now)
  return deriveCapacityStateFromBalance(
    { balanceUsd: snap?.balance ?? null, ageSeconds: fresh.age_seconds, staleAfterSeconds: CAPACITY_STALE_AFTER_SECONDS },
    DEEPSEEK_BALANCE_FLOOR_USD,
  )
}

export interface CapacityInfo {
  state: CapacityState
  /**
   * Provider-stated reset time (epoch sec) behind the reading, when the
   * underlying snapshot carried one (OPT-M1: the codex collector persists
   * resets_at and usageFigure now surfaces it). Null for the balance path,
   * for keys with no snapshot, and for providers that state no reset --
   * never fabricated from a TTL or a reset label.
   */
  providerStatedResetAtSec: number | null
}

/**
 * Capacity state PLUS the provider-stated reset time for one (provider,
 * authProfile) key. `limitedThreshold` is the deployment-local
 * capacity-routing-config value (OPT-M2 -- before this parameter the stored
 * knob never reached deriveCapacityState and the state layer always used the
 * committed 0.9); omitted = the pure layer's own default, so existing callers
 * that carry no config (optimization-routing.ts) are byte-identical.
 */
export function capacityInfoFor(
  db: Database.Database,
  provider: string,
  authProfile: string,
  now: number,
  activeBlockingSignal: boolean,
  limitedThreshold?: number,
): CapacityInfo {
  // DeepSeek: prepaid balance, not a subscription window -- see
  // capacityStateForDeepSeekBalance's header comment. Checked before the
  // subscriptions-config path below so a stray deepseek subscriptions.json
  // entry (there should never be one) cannot silently take over. A balance
  // has no provider-stated reset (money does not reset on a schedule).
  if (provider === 'deepseek') {
    return { state: capacityStateForDeepSeekBalance(db, now, activeBlockingSignal), providerStatedResetAtSec: null }
  }
  const { config } = loadSubscriptionsConfig()
  const lifecycle = deriveLifecycle(config, now)
  const sub = findSubscriptionFor(lifecycle, provider, authProfile)
  if (!sub) {
    return {
      state: deriveCapacityState({
        usageFraction: null, usageConfidence: 'unknown', ageSeconds: null,
        staleAfterSeconds: CAPACITY_STALE_AFTER_SECONDS, activeBlockingSignal,
      }, limitedThreshold),
      providerStatedResetAtSec: null,
    }
  }
  const usage = usageFigure(db, sub, now)
  const fresh = freshnessOf(usage.freshness.as_of, now)
  const resetAtSec = usage.resets_at ?? null
  const state = deriveCapacityState({
    usageFraction: usage.value,
    usageConfidence: usage.confidence,
    ageSeconds: fresh.age_seconds,
    staleAfterSeconds: CAPACITY_STALE_AFTER_SECONDS,
    activeBlockingSignal,
    // OPT-M1: an over-limit reading whose provider-stated reset has already
    // passed must degrade to 'unknown' in the pure layer, not pin 'blocked'.
    secondsUntilProviderReset: resetAtSec === null ? null : resetAtSec - now,
  }, limitedThreshold)
  return { state, providerStatedResetAtSec: resetAtSec }
}

/** State-only convenience over capacityInfoFor, for callers that need no reset time. */
export function capacityStateFor(
  db: Database.Database,
  provider: string,
  authProfile: string,
  now: number,
  activeBlockingSignal: boolean,
  limitedThreshold?: number,
): CapacityState {
  return capacityInfoFor(db, provider, authProfile, now, activeBlockingSignal, limitedThreshold).state
}

export interface AgentRoutingDecisionInput {
  overlay: RuntimeOverlayEntry | null
  packageOpen: boolean
  primaryState: CapacityState
  candidates: FallbackCandidate[]
  candidateStates: Map<string, CapacityState>
  errorClass: ErrorClass | null
  /**
   * optimization-config `routing.automaticFallback` (OPT-H2, review
   * 2026-08-12). False = observe-and-recover only: the sweep may still CLEAR
   * an overlay (climb-back to the configured primary is always a return to
   * owner-configured state, never a new routing decision) but must NOT SET a
   * new fallback overlay. This is what the summary's 'observation'
   * system_state (optimization-summary.ts) has claimed all along.
   */
  automaticFallback: boolean
  /**
   * The PRIMARY key's provider-stated capacity reset time (ms epoch), when one
   * is observable -- OPT-M1 (review 2026-08-12): this used to be hardcoded
   * null inside decideAgentRouting under a comment claiming no provider-stated
   * reset is observable, which is false for codex (its collector persists a
   * real resets_at and capacityInfoFor surfaces it). Null when the primary's
   * snapshot carries none; shouldClimbBackToPrimary then falls back to the
   * TTL guess exactly as before.
   */
  providerStatedResetAtMs: number | null
  nowMs: number
  ttlMs: number
}

export type AgentRoutingDecision =
  | { kind: 'set'; candidate: FallbackCandidate; reasonCode: string }
  | { kind: 'clear'; reasonCode: string }
  | { kind: 'none'; reasonCode: string }

/**
 * checkAgent's decision core, extracted so it is testable without the pane /
 * respawn / overlay-file I/O around it (OPT-H1/H2 tests drive this against a
 * real in-memory dispatches DB via isPackageOpen). Pure function of its
 * inputs; the caller applies the returned verdict.
 */
export function decideAgentRouting(input: AgentRoutingDecisionInput): AgentRoutingDecision {
  const { overlay, packageOpen, primaryState, candidates, candidateStates, errorClass, nowMs, ttlMs } = input

  if (overlay) {
    // Already on a fallback: only consider climbing back, never re-evaluate a
    // fresh routing decision mid-fallback (that is what sticky routing means
    // once an overlay is active -- a NEW routing decision only ever happens
    // from the primary side, in the branch below). Climb-back is deliberately
    // NOT gated on automaticFallback: clearing an overlay returns the agent to
    // owner-configured state, and holding it hostage to a disabled knob would
    // recreate OPT-C1's pinned-on-fallback failure one knob over.
    if (packageOpen) {
      return { kind: 'none', reasonCode: 'sticky_package_open_on_fallback' }
    }
    const climb = shouldClimbBackToPrimary({
      overlaySetAtMs: overlay.setAtMs, nowMs, ttlMs,
      // Real when the primary's snapshot states one (codex), null otherwise --
      // shouldClimbBackToPrimary prefers the stated reset over the TTL guess.
      providerStatedResetAtMs: input.providerStatedResetAtMs,
      primaryCapacityState: primaryState,
    })
    return climb
      ? { kind: 'clear', reasonCode: 'primary_recovered_climb_back' }
      : { kind: 'none', reasonCode: 'ttl_not_elapsed_or_primary_still_constrained' }
  }

  const routing = resolveRuntimeRouting({
    primaryState,
    candidates,
    candidateStates,
    packageOpen,
    fallbacksUsedThisPackage: 0, // no overlay yet this package => no auto-fallback consumed yet
    errorClass,
  })
  if (routing.action !== 'fallback') return { kind: 'none', reasonCode: routing.reasonCode }
  // OPT-H2: the knob the dashboard/emergency-stop writes and the committed
  // example advertises. Checked AFTER the resolver so a disabled knob is
  // reported as exactly that -- not disguised as "no candidate available".
  if (!input.automaticFallback) return { kind: 'none', reasonCode: 'automatic_fallback_disabled' }
  return { kind: 'set', candidate: routing.to, reasonCode: routing.reasonCode }
}

async function checkAgent(
  name: string,
  nowMs: number,
  candidates: FallbackCandidate[],
  ttlMs: number,
  automaticFallback: boolean,
  limitedThreshold: number,
): Promise<void> {
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
  // OPT-M2: the deployment-local limitedThreshold finally reaches the state
  // derivation (it used to be stored/normalized and then ignored). OPT-M1: the
  // primary's provider-stated reset time rides along for climb-back.
  const primaryInfo = capacityInfoFor(db, configuredProvider, configuredAuthProfile, nowSec, limitBannerShowing, limitedThreshold)
  const primaryState = primaryInfo.state
  const errorClass = limitBannerShowing ? classifyError({ kind: 'usage_limit_banner' }) : null

  const overlay = readRuntimeOverlay(name)
  const { open: packageOpen, dispatchId } = isPackageOpen(db, name, nowSec)

  const candidateStates = new Map<string, CapacityState>()
  for (const c of candidates) {
    const s = capacityStateFor(db, c.provider, c.authProfile, nowSec, false, limitedThreshold)
    candidateStates.set(capacityKeyId(c), s)
  }

  const decision = decideAgentRouting({
    overlay, packageOpen, primaryState, candidates, candidateStates,
    errorClass, automaticFallback,
    providerStatedResetAtMs: primaryInfo.providerStatedResetAtSec === null
      ? null
      : primaryInfo.providerStatedResetAtSec * 1000,
    nowMs, ttlMs,
  })

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
    // OPT-H2 (review 2026-08-12): routing.automaticFallback finally controls
    // something. Read FRESH each sweep straight from the optimization config
    // (store/optimization-config.json) -- the same read-live-not-cached
    // discipline as readCapacityRoutingConfig() above, and the same seam the
    // summary already reads it from (optimization-summary.ts), so there is
    // exactly ONE source of truth and no propagation lag: the dashboard /
    // emergency-stop write is honoured on the very next sweep. A separate
    // propagated copy in capacity-routing-config was rejected because the
    // existing propagation seam (writeOptimizationConfig) is deliberately
    // OFF-only and skips hand-edited files -- a knob that must work in BOTH
    // directions cannot ride it without recreating the O-1 divergence class.
    // Missing/invalid optimization config fails closed (default
    // automaticFallback: false -> observe + climb-back only, no new
    // fallbacks), matching this module's fail-closed convention.
    const automaticFallback = readOptimizationConfig().config.routing.automaticFallback
    const now = Date.now()
    for (const name of listAgentNames()) {
      try { await checkAgent(name, now, cfg.candidates, cfg.ttlMs, automaticFallback, cfg.limitedThreshold) }
      catch (err) { logger.debug({ err, agent: name }, 'capacity-routing: agent check error') }
    }
  }
  setTimeout(() => { void sweep() }, INITIAL_DELAY_MS)
  return setInterval(() => { void sweep() }, INTERVAL_MS)
}
