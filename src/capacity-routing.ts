// Lean Optimization Phase 3 -- Capacity-Aware Runtime Routing (pure decision layer).
//
// Card 59b383a9. Mirrors src/model-fallback.ts's dependency-free, unit-testable
// shape: every decision here is a pure function of explicit inputs, so the
// I/O (pane capture, overlay file, respawn, CostOps rows) lives in
// src/web/capacity-routing-store.ts and src/web/capacity-routing-runner.ts.
// detectsUsageLimit() is REUSED from model-fallback.ts (not re-implemented) as
// one input into classifyError() below -- see capacity-routing-runner.ts.
//
// THE CENTRAL RULE THIS FILE SERVES: configuredPrimary is never overwritten.
// Every function here returns a DECISION (what the runtime overlay should be),
// never a mutation. The overlay is applied and persisted by the store layer;
// this module does not know a filesystem exists.
//
// No LLM anywhere in this file. Deterministic rules + explicit metadata only.

// ---------------------------------------------------------------------------
// Capacity-state registry
// ---------------------------------------------------------------------------

export const CAPACITY_STATES = ['available', 'degraded', 'limited', 'blocked', 'unknown'] as const
export type CapacityState = (typeof CAPACITY_STATES)[number]

/** The real unit of capacity: two accounts of the same provider have independent quotas. */
export interface CapacityKey {
  provider: string
  authProfile: string
}

export function capacityKeyId(k: CapacityKey): string {
  return `${k.provider}::${k.authProfile}`
}

export interface CapacityInputs {
  /** Fraction of the plan window consumed (0..1+), or null when there is no figure. */
  usageFraction: number | null
  /** Confidence behind usageFraction, mirroring costops/capacity-snapshots.ts. */
  usageConfidence: 'measured' | 'manual' | 'inferred' | 'unknown'
  /** Age in seconds of the underlying observation; null when there is none. */
  ageSeconds: number | null
  /** How old an observation may be before it is stale (costops CAPACITY_STALE_AFTER_SECONDS). */
  staleAfterSeconds: number
  /**
   * A live, real-time signal that this key cannot proceed AT ALL right now
   * (e.g. the Claude usage-limit banner is showing in the pane this instant).
   * This is ground truth and overrides a period-old usage fraction.
   */
  activeBlockingSignal: boolean
}

const DEFAULT_LIMITED_THRESHOLD = 0.9

/**
 * Derive one of the five capacity states from explicit, timestamped inputs.
 *
 * Two invariants a caller may rely on and a mutation test must be able to
 * break-and-catch:
 *   1. `unknown` is reachable ONLY when there is no usable figure -- it can
 *      NEVER be produced by a low/zero usageFraction, and a usageFraction of
 *      exactly 0 with 'measured' confidence is a real, confident 'available',
 *      not a stand-in for "we don't know".
 *   2. `available` is reachable ONLY when the data is fresh. Stale data can
 *      degrade a would-be-available read down to 'degraded', but staleness
 *      never manufactures 'available' out of an absent or old figure.
 */
export function deriveCapacityState(
  inputs: CapacityInputs,
  limitedThreshold: number = DEFAULT_LIMITED_THRESHOLD,
): CapacityState {
  if (inputs.activeBlockingSignal) return 'blocked'
  if (inputs.usageConfidence === 'unknown' || inputs.usageFraction === null) return 'unknown'

  const stale = inputs.ageSeconds === null || inputs.ageSeconds > inputs.staleAfterSeconds

  if (inputs.usageFraction >= 1) return 'blocked'
  if (inputs.usageFraction >= limitedThreshold) return 'limited'
  return stale ? 'degraded' : 'available'
}

/** States a resolver may route work TO (a place work can actually happen). */
export function isRoutable(state: CapacityState): boolean {
  return state === 'available' || state === 'degraded'
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type ErrorClass =
  | 'capacity' | 'rate_limit' | 'outage'
  | 'validation' | 'tool_error' | 'privacy'
  | 'unclassified'

/** Exactly these three classes may ever trigger a fallback. Whitelist, not blocklist. */
const FALLBACK_ELIGIBLE_CLASSES: ReadonlySet<ErrorClass> = new Set(['capacity', 'rate_limit', 'outage'])

/**
 * Default-deny: an error class not explicitly in the eligible set is NOT
 * fallback-eligible, including 'unclassified' itself and any future class
 * this function has not been taught about.
 */
export function isFallbackEligible(cls: ErrorClass): boolean {
  return FALLBACK_ELIGIBLE_CLASSES.has(cls)
}

export type ErrorSignal =
  | { kind: 'usage_limit_banner' }
  | { kind: 'http_status'; status: number }
  | { kind: 'validation_error' }
  | { kind: 'tool_error' }
  | { kind: 'privacy_refusal' }

/**
 * Classify a raw signal into one of the six known classes, or 'unclassified'
 * when the signal does not map onto anything this function recognises
 * (default-deny: an unrecognised HTTP status is 'unclassified', not guessed
 * into 'outage' just because it is an error).
 *
 * A privacy-class refusal must NEVER be reclassified as a capacity/outage
 * problem to make it fallback-eligible -- that would move the work to another
 * provider to route around a content-safety decision, which is a data-egress
 * decision wearing a reliability costume.
 */
export function classifyError(signal: ErrorSignal): ErrorClass {
  switch (signal.kind) {
    case 'usage_limit_banner': return 'capacity'
    case 'privacy_refusal': return 'privacy'
    case 'validation_error': return 'validation'
    case 'tool_error': return 'tool_error'
    case 'http_status':
      if (signal.status === 429) return 'rate_limit'
      if (signal.status >= 500 && signal.status < 600) return 'outage'
      if (signal.status === 400 || signal.status === 422) return 'validation'
      return 'unclassified'
    default:
      return 'unclassified'
  }
}

// ---------------------------------------------------------------------------
// Sticky work-package routing
// ---------------------------------------------------------------------------

export interface StickyRoutingInput {
  /** True when the agent's current work package has not reached a terminal outcome yet. */
  packageOpen: boolean
}

/** A package that started on a model finishes on it: no mid-package routing change. */
export function isRoutingChangeAllowed(input: StickyRoutingInput): boolean {
  return !input.packageOpen
}

// ---------------------------------------------------------------------------
// Fallback ceilings (hard, not defaults to grow later)
// ---------------------------------------------------------------------------

export const MAX_FALLBACK_CANDIDATES = 2
export const MAX_AUTO_FALLBACKS_PER_PACKAGE = 1

export function withinCandidateCeiling(candidateCount: number): boolean {
  return candidateCount <= MAX_FALLBACK_CANDIDATES
}

/** A 2nd automatic fallback on the same package must be refused, not walked. */
export function canAutoFallback(fallbacksUsedThisPackage: number): boolean {
  return fallbacksUsedThisPackage < MAX_AUTO_FALLBACKS_PER_PACKAGE
}

// ---------------------------------------------------------------------------
// Primary retry (climb back to configuredPrimary once it is healthy again)
// ---------------------------------------------------------------------------

export interface RetryInput {
  overlaySetAtMs: number
  nowMs: number
  /** Used only when no provider-stated reset time is observable. */
  ttlMs: number
  /** A provider-stated capacity reset time (ms epoch), when actually observable. */
  providerStatedResetAtMs: number | null
  primaryCapacityState: CapacityState
}

/**
 * Whether it is time to climb back onto the primary. Never climbs onto a
 * primary that is itself still constrained -- that would just re-trip the
 * same condition on the very next sweep. Prefers a provider-stated reset time
 * over a guessed backoff when one is observable.
 */
export function shouldClimbBackToPrimary(input: RetryInput): boolean {
  if (!isRoutable(input.primaryCapacityState)) return false
  if (input.providerStatedResetAtMs !== null) return input.nowMs >= input.providerStatedResetAtMs
  return input.nowMs - input.overlaySetAtMs >= input.ttlMs
}

// ---------------------------------------------------------------------------
// Subscription-first runtime-only resolver
// ---------------------------------------------------------------------------

export interface FallbackCandidate {
  provider: string
  authProfile: string
  model: string
  /** Trust gate: an external/non-trusted provider stays excluded until a separate owner GO. */
  enabledForRouting: boolean
  /** Capacity already paid for (subscription-included) is preferred over anything metered. */
  subscriptionIncluded: boolean
}

export interface ResolveRoutingInput {
  primaryState: CapacityState
  /** Capped externally to MAX_FALLBACK_CANDIDATES before this is called; withinCandidateCeiling asserts it. */
  candidates: FallbackCandidate[]
  candidateStates: Map<string, CapacityState>
  packageOpen: boolean
  fallbacksUsedThisPackage: number
  /** The error class that triggered this evaluation, if any (null = pure capacity-state trigger, e.g. a scheduled sweep). */
  errorClass: ErrorClass | null
}

export type RoutingDecision =
  | { action: 'stay_primary'; reasonCode: string }
  | { action: 'hold_current_overlay'; reasonCode: string }
  | { action: 'fallback'; to: FallbackCandidate; reasonCode: string }
  | { action: 'no_eligible_fallback'; reasonCode: string }
  | { action: 'ceiling_reached'; reasonCode: string }

/**
 * The one decision function the runner calls per sweep tick. Never returns a
 * config write -- only ever a runtime-overlay verdict for the store layer to
 * apply (or not) to the overlay file.
 */
export function resolveRuntimeRouting(input: ResolveRoutingInput): RoutingDecision {
  if (!withinCandidateCeiling(input.candidates.length)) {
    throw new Error(`resolveRuntimeRouting: candidate list exceeds the hard ceiling of ${MAX_FALLBACK_CANDIDATES}`)
  }

  // Sticky: a package in flight never has its routing changed underneath it,
  // regardless of what capacity now says.
  if (input.packageOpen) return { action: 'hold_current_overlay', reasonCode: 'sticky_package_open' }

  if (isRoutable(input.primaryState)) {
    return { action: 'stay_primary', reasonCode: 'primary_capacity_ok' }
  }

  if (input.errorClass !== null && !isFallbackEligible(input.errorClass)) {
    return { action: 'stay_primary', reasonCode: `fallback_forbidden_error_class:${input.errorClass}` }
  }

  if (!canAutoFallback(input.fallbacksUsedThisPackage)) {
    return { action: 'ceiling_reached', reasonCode: 'max_one_auto_fallback_per_package' }
  }

  const usable = input.candidates
    .filter((c) => c.enabledForRouting)
    .filter((c) => isRoutable(input.candidateStates.get(capacityKeyId(c)) ?? 'unknown'))
    // Subscription-first: prefer already-paid-for capacity over metered, stable sort keeps caller order among equals.
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (Number(b.c.subscriptionIncluded) - Number(a.c.subscriptionIncluded)) || (a.i - b.i))
    .map(({ c }) => c)

  if (usable.length === 0) return { action: 'no_eligible_fallback', reasonCode: 'no_candidate_available' }
  return { action: 'fallback', to: usable[0], reasonCode: 'primary_constrained_fallback_applied' }
}
