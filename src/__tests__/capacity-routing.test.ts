import { describe, it, expect } from 'vitest'
import {
  deriveCapacityState,
  deriveCapacityStateFromBalance,
  isRoutable,
  classifyError,
  isFallbackEligible,
  isRoutingChangeAllowed,
  canAutoFallback,
  withinCandidateCeiling,
  shouldClimbBackToPrimary,
  resolveRuntimeRouting,
  capacityKeyId,
  MAX_FALLBACK_CANDIDATES,
  MAX_AUTO_FALLBACKS_PER_PACKAGE,
  type CapacityInputs,
  type BalanceCapacityInputs,
  type FallbackCandidate,
} from '../capacity-routing.js'

const STALE_AFTER = 26 * 60 * 60 // mirrors costops CAPACITY_STALE_AFTER_SECONDS

function inputs(overrides: Partial<CapacityInputs> = {}): CapacityInputs {
  return {
    usageFraction: 0.1,
    usageConfidence: 'measured',
    ageSeconds: 60,
    staleAfterSeconds: STALE_AFTER,
    activeBlockingSignal: false,
    ...overrides,
  }
}

describe('deriveCapacityState', () => {
  it('produces available for a fresh, low-usage, measured figure', () => {
    expect(deriveCapacityState(inputs())).toBe('available')
  })

  it('produces limited at/above the threshold', () => {
    expect(deriveCapacityState(inputs({ usageFraction: 0.9 }))).toBe('limited')
    expect(deriveCapacityState(inputs({ usageFraction: 0.95 }))).toBe('limited')
  })

  it('produces blocked when usage has overflowed the window', () => {
    expect(deriveCapacityState(inputs({ usageFraction: 1 }))).toBe('blocked')
    expect(deriveCapacityState(inputs({ usageFraction: 1.2 }))).toBe('blocked')
  })

  it('produces blocked when a live blocking signal is present, regardless of the usage figure', () => {
    expect(deriveCapacityState(inputs({ usageFraction: 0, activeBlockingSignal: true }))).toBe('blocked')
    expect(deriveCapacityState(inputs({ usageFraction: null, usageConfidence: 'unknown', activeBlockingSignal: true }))).toBe('blocked')
  })

  describe('invariant: unknown never collapses into available', () => {
    it('is unknown when confidence is unknown, even with a numeric value present', () => {
      const state = deriveCapacityState(inputs({ usageFraction: 0.05, usageConfidence: 'unknown' }))
      expect(state).toBe('unknown')
      expect(state).not.toBe('available')
    })

    it('is unknown when there is no figure at all', () => {
      const state = deriveCapacityState(inputs({ usageFraction: null, usageConfidence: 'unknown', ageSeconds: null }))
      expect(state).toBe('unknown')
    })

    it('a confident zero-usage measured figure IS available, not unknown -- 0 is a real reading', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 0, usageConfidence: 'measured', ageSeconds: 1 }))).toBe('available')
    })
  })

  describe('OPT-M1: a constrained reading past its horizon degrades to unknown, never pins forever', () => {
    it('a snapshot at 100% whose provider-stated reset has PASSED is unknown, not blocked', () => {
      const state = deriveCapacityState(inputs({ usageFraction: 1, secondsUntilProviderReset: -60 }))
      expect(state).toBe('unknown')
      expect(state).not.toBe('blocked')
    })

    it('a snapshot at 100% past the staleness horizon is unknown, not blocked (the forever-pin defect)', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 1, ageSeconds: STALE_AFTER + 1 }))).toBe('unknown')
      expect(deriveCapacityState(inputs({ usageFraction: 1.2, ageSeconds: null }))).toBe('unknown')
    })

    it('a FRESH 100% reading with the stated reset still in the future stays blocked -- the demotion needs an expired horizon', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 1, secondsUntilProviderReset: 3600 }))).toBe('blocked')
      expect(deriveCapacityState(inputs({ usageFraction: 1 }))).toBe('blocked')
    })

    it('a limited reading past its provider-stated reset or the staleness horizon degrades to unknown too', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 0.95, secondsUntilProviderReset: 0 }))).toBe('unknown')
      expect(deriveCapacityState(inputs({ usageFraction: 0.95, ageSeconds: STALE_AFTER + 1 }))).toBe('unknown')
      expect(deriveCapacityState(inputs({ usageFraction: 0.95, secondsUntilProviderReset: 600 }))).toBe('limited')
    })

    it('the demotion never manufactures a routable state: unknown is not routable', () => {
      expect(isRoutable(deriveCapacityState(inputs({ usageFraction: 1, secondsUntilProviderReset: -1 })))).toBe(false)
    })

    it('a LOW stale reading still degrades to degraded (routable), unchanged: an old low figure still bounds usage from below', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 0.05, ageSeconds: STALE_AFTER + 1 }))).toBe('degraded')
    })

    it('an active blocking signal still wins over an elapsed reset -- live ground truth beats any snapshot', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 1, secondsUntilProviderReset: -60, activeBlockingSignal: true }))).toBe('blocked')
    })
  })

  describe('OPT-M2: limitedThreshold is a real parameter, defaulting to the committed 0.9', () => {
    it('a configured threshold of 0.5 makes a 0.6 usage read limited', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 0.6 }), 0.5)).toBe('limited')
    })

    it('the same 0.6 usage stays available under the default threshold', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 0.6 }))).toBe('available')
    })

    it('the threshold moves the limited boundary only -- blocked at >= 1 is unaffected', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 1 }), 0.5)).toBe('blocked')
    })
  })

  describe('invariant: staleness never manufactures available', () => {
    it('degrades a would-be-available fresh-looking figure to degraded once stale', () => {
      const state = deriveCapacityState(inputs({ usageFraction: 0.05, ageSeconds: STALE_AFTER + 1 }))
      expect(state).toBe('degraded')
      expect(state).not.toBe('available')
    })

    it('a null age (no observation timestamp at all) counts as stale', () => {
      const state = deriveCapacityState(inputs({ usageFraction: 0.05, ageSeconds: null }))
      expect(state).toBe('degraded')
    })

    it('fresh data at the same usage level stays available', () => {
      expect(deriveCapacityState(inputs({ usageFraction: 0.05, ageSeconds: STALE_AFTER - 1 }))).toBe('available')
    })
  })
})

describe('isRoutable', () => {
  it('only available and degraded are routable', () => {
    expect(isRoutable('available')).toBe(true)
    expect(isRoutable('degraded')).toBe(true)
    expect(isRoutable('limited')).toBe(false)
    expect(isRoutable('blocked')).toBe(false)
    expect(isRoutable('unknown')).toBe(false)
  })
})

describe('deriveCapacityStateFromBalance (card 6976aaa2: DeepSeek prepaid-balance capacity)', () => {
  const FLOOR = 1.0

  function balanceInputs(overrides: Partial<BalanceCapacityInputs> = {}): BalanceCapacityInputs {
    return { balanceUsd: 8.74, ageSeconds: 60, staleAfterSeconds: STALE_AFTER, ...overrides }
  }

  it('GUARD TEST 1: balance above the floor -> available', () => {
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: 8.74 }), FLOOR)).toBe('available')
    // Just above the floor still counts.
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: 1.01 }), FLOOR)).toBe('available')
  })

  it('GUARD TEST 2: balance at or below the floor -> blocked (not routable)', () => {
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: 1.0 }), FLOOR)).toBe('blocked')
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: 0.5 }), FLOOR)).toBe('blocked')
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: 0 }), FLOOR)).toBe('blocked')
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: -3 }), FLOOR)).toBe('blocked')
    expect(isRoutable('blocked')).toBe(false)
  })

  it('GUARD TEST 3: no snapshot at all -> unknown, never a fabricated available', () => {
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: null, ageSeconds: null }), FLOOR)).toBe('unknown')
  })

  it('GUARD TEST 3 (stale variant): a snapshot older than staleAfterSeconds -> unknown, NOT degraded', () => {
    // Deliberately stricter than deriveCapacityState's window-staleness
    // handling (which degrades to 'degraded', still routable) -- a dollar
    // balance can be spent to zero by anything between snapshots, so an old
    // reading is not "close enough".
    const state = deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: 8.74, ageSeconds: STALE_AFTER + 1 }), FLOOR)
    expect(state).toBe('unknown')
    expect(state).not.toBe('degraded')
    expect(state).not.toBe('available')
  })

  it('an active blocking signal is not this function\'s concern -- that is capacityStateForDeepSeekBalance\'s short-circuit', () => {
    // deriveCapacityStateFromBalance has no activeBlockingSignal field by
    // design (a pane-detected limit banner is a Claude-plan concept, not a
    // prepaid-balance one) -- the runner checks it before ever calling this.
    expect(deriveCapacityStateFromBalance(balanceInputs({ balanceUsd: 8.74 }), FLOOR)).toBe('available')
  })

  it('never fabricates available: a positive but unreadable/absent balance is still unknown, not assumed healthy', () => {
    expect(deriveCapacityStateFromBalance({ balanceUsd: null, ageSeconds: 5, staleAfterSeconds: STALE_AFTER }, FLOOR)).toBe('unknown')
  })
})

describe('classifyError', () => {
  it('classifies each named signal correctly', () => {
    expect(classifyError({ kind: 'usage_limit_banner' })).toBe('capacity')
    expect(classifyError({ kind: 'http_status', status: 429 })).toBe('rate_limit')
    expect(classifyError({ kind: 'http_status', status: 500 })).toBe('outage')
    expect(classifyError({ kind: 'http_status', status: 503 })).toBe('outage')
    expect(classifyError({ kind: 'validation_error' })).toBe('validation')
    expect(classifyError({ kind: 'tool_error' })).toBe('tool_error')
    expect(classifyError({ kind: 'privacy_refusal' })).toBe('privacy')
  })

  it('default-denies an unrecognised http status to unclassified, never guesses outage', () => {
    expect(classifyError({ kind: 'http_status', status: 418 })).toBe('unclassified')
  })

  it('fallback eligibility is a strict whitelist: capacity/rate_limit/outage only', () => {
    expect(isFallbackEligible('capacity')).toBe(true)
    expect(isFallbackEligible('rate_limit')).toBe(true)
    expect(isFallbackEligible('outage')).toBe(true)
    expect(isFallbackEligible('validation')).toBe(false)
    expect(isFallbackEligible('tool_error')).toBe(false)
    expect(isFallbackEligible('privacy')).toBe(false)
  })

  it('default-denies an unclassified error -- it is NOT fallback-eligible', () => {
    expect(isFallbackEligible('unclassified')).toBe(false)
  })

  it('a privacy refusal is never reclassified into a fallback-eligible class', () => {
    const cls = classifyError({ kind: 'privacy_refusal' })
    expect(cls).toBe('privacy')
    expect(isFallbackEligible(cls)).toBe(false)
  })
})

describe('isRoutingChangeAllowed (sticky routing)', () => {
  it('refuses a routing change while the package is open', () => {
    expect(isRoutingChangeAllowed({ packageOpen: true })).toBe(false)
  })
  it('allows a routing change once the package is closed', () => {
    expect(isRoutingChangeAllowed({ packageOpen: false })).toBe(true)
  })
})

describe('fallback ceilings', () => {
  it('MAX_FALLBACK_CANDIDATES is 2 and MAX_AUTO_FALLBACKS_PER_PACKAGE is 1 -- hard ceilings, not defaults', () => {
    expect(MAX_FALLBACK_CANDIDATES).toBe(2)
    expect(MAX_AUTO_FALLBACKS_PER_PACKAGE).toBe(1)
  })

  it('withinCandidateCeiling accepts up to 2, refuses 3', () => {
    expect(withinCandidateCeiling(0)).toBe(true)
    expect(withinCandidateCeiling(2)).toBe(true)
    expect(withinCandidateCeiling(3)).toBe(false)
  })

  it('canAutoFallback allows exactly one automatic fallback per package, refuses a second', () => {
    expect(canAutoFallback(0)).toBe(true)
    expect(canAutoFallback(1)).toBe(false)
    expect(canAutoFallback(2)).toBe(false)
  })
})

describe('shouldClimbBackToPrimary', () => {
  it('never climbs onto a primary that is itself still constrained', () => {
    expect(shouldClimbBackToPrimary({
      overlaySetAtMs: 0, nowMs: 10_000_000, ttlMs: 1000, providerStatedResetAtMs: null, primaryCapacityState: 'limited',
    })).toBe(false)
    expect(shouldClimbBackToPrimary({
      overlaySetAtMs: 0, nowMs: 10_000_000, ttlMs: 1000, providerStatedResetAtMs: null, primaryCapacityState: 'blocked',
    })).toBe(false)
    expect(shouldClimbBackToPrimary({
      overlaySetAtMs: 0, nowMs: 10_000_000, ttlMs: 1000, providerStatedResetAtMs: null, primaryCapacityState: 'unknown',
    })).toBe(false)
  })

  it('prefers a provider-stated reset time over the TTL guess when both are available', () => {
    // TTL alone would already be satisfied, but the stated reset is in the future -> not yet.
    expect(shouldClimbBackToPrimary({
      overlaySetAtMs: 0, nowMs: 5000, ttlMs: 1000, providerStatedResetAtMs: 9000, primaryCapacityState: 'available',
    })).toBe(false)
    expect(shouldClimbBackToPrimary({
      overlaySetAtMs: 0, nowMs: 9000, ttlMs: 1000, providerStatedResetAtMs: 9000, primaryCapacityState: 'available',
    })).toBe(true)
  })

  it('falls back to the TTL guess when no reset time is observable', () => {
    expect(shouldClimbBackToPrimary({
      overlaySetAtMs: 0, nowMs: 999, ttlMs: 1000, providerStatedResetAtMs: null, primaryCapacityState: 'degraded',
    })).toBe(false)
    expect(shouldClimbBackToPrimary({
      overlaySetAtMs: 0, nowMs: 1000, ttlMs: 1000, providerStatedResetAtMs: null, primaryCapacityState: 'degraded',
    })).toBe(true)
  })
})

describe('resolveRuntimeRouting', () => {
  const untrusted: FallbackCandidate = {
    provider: 'deepseek', authProfile: 'plan:default', model: 'deepseek-v4-pro',
    enabledForRouting: false, subscriptionIncluded: false,
  }
  const metered: FallbackCandidate = {
    provider: 'anthropic', authProfile: 'plan:secondary', model: 'claude-sonnet-5',
    enabledForRouting: true, subscriptionIncluded: false,
  }
  const subscriptionIncluded: FallbackCandidate = {
    provider: 'anthropic', authProfile: 'plan:secondary_max', model: 'claude-sonnet-5',
    enabledForRouting: true, subscriptionIncluded: true,
  }

  it('stays on primary when primary capacity is fine', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'available', candidates: [], candidateStates: new Map(),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: null,
    })
    expect(d.action).toBe('stay_primary')
  })

  it('holds the current overlay (does not change routing) while the package is open, even if primary is blocked', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked', candidates: [metered], candidateStates: new Map([[capacityKeyId(metered), 'available']]),
      packageOpen: true, fallbacksUsedThisPackage: 0, errorClass: 'capacity',
    })
    expect(d.action).toBe('hold_current_overlay')
  })

  it('falls back to an enabled, routable candidate when primary is constrained', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked', candidates: [metered], candidateStates: new Map([[capacityKeyId(metered), 'available']]),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: 'capacity',
    })
    expect(d.action).toBe('fallback')
    if (d.action === 'fallback') expect(d.to).toBe(metered)
  })

  it('prefers a subscription-included candidate over a metered one (subscription-first)', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked',
      candidates: [metered, subscriptionIncluded],
      candidateStates: new Map([[capacityKeyId(metered), 'available'], [capacityKeyId(subscriptionIncluded), 'available']]),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: 'capacity',
    })
    expect(d.action).toBe('fallback')
    if (d.action === 'fallback') expect(d.to).toBe(subscriptionIncluded)
  })

  it('excludes a candidate with enabledForRouting:false from EVERY routing decision, not just hidden in a UI', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked', candidates: [untrusted], candidateStates: new Map([[capacityKeyId(untrusted), 'available']]),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: 'capacity',
    })
    expect(d.action).toBe('no_eligible_fallback')
  })

  it('refuses a second automatic fallback on the same package and escalates instead of walking further down', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked', candidates: [metered], candidateStates: new Map([[capacityKeyId(metered), 'available']]),
      packageOpen: false, fallbacksUsedThisPackage: 1, errorClass: 'capacity',
    })
    expect(d.action).toBe('ceiling_reached')
  })

  it('refuses to fallback for a non-eligible error class (validation) even with a healthy candidate available', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked', candidates: [metered], candidateStates: new Map([[capacityKeyId(metered), 'available']]),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: 'validation',
    })
    expect(d.action).toBe('stay_primary')
    expect(d.reasonCode).toContain('validation')
  })

  it('refuses to fallback for a privacy-class refusal -- never routed around to another provider', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked', candidates: [metered], candidateStates: new Map([[capacityKeyId(metered), 'available']]),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: 'privacy',
    })
    expect(d.action).toBe('stay_primary')
    expect(d.reasonCode).toContain('privacy')
  })

  it('rejects a candidate list beyond the hard ceiling instead of silently truncating it', () => {
    const three = [untrusted, metered, subscriptionIncluded]
    expect(() => resolveRuntimeRouting({
      primaryState: 'blocked', candidates: three, candidateStates: new Map(),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: 'capacity',
    })).toThrow(/ceiling/)
  })

  it('returns no_eligible_fallback (not a false fallback) when every candidate is itself unroutable', () => {
    const d = resolveRuntimeRouting({
      primaryState: 'blocked', candidates: [metered], candidateStates: new Map([[capacityKeyId(metered), 'blocked']]),
      packageOpen: false, fallbacksUsedThisPackage: 0, errorClass: 'capacity',
    })
    expect(d.action).toBe('no_eligible_fallback')
  })
})
