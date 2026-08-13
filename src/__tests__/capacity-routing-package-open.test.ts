// OPT-H1 + OPT-H2 (CostOps + lean optimization full review, 2026-08-12).
//
// OPT-H1: isPackageOpen used to treat "no terminal outcome" as "in progress",
// forever. resolveOutcome defaults to 'unknown' and the dominant dispatch
// origins (successful message delivery, schedule-runner) never write a
// terminal outcome at all -- Phase 2 canary: 16/20 dispatches stayed
// 'unknown'. Consequence, in BOTH directions: an agent with any such dispatch
// (a) never fell back when its primary was blocked ('sticky_package_open'),
// and (b) once on an overlay never climbed back to a recovered primary even
// after TTL ('sticky_package_open_on_fallback'). The fix bounds openness in
// time by REUSING the dispatch-attribution window cap
// (DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS = 6h, loadDispatchAttributionConfig)
// -- the boundary past which CostOps already declares the work package over
// for cost attribution -- so a package can never be closed for attribution
// but open for routing.
//
// OPT-H2: routing.automaticFallback (optimization-config) had ZERO readers in
// the decision path while the committed example advertised it and the summary
// reported 'observation' based on it. It is now read fresh each sweep and
// gates ONLY the set-a-new-overlay branch: climb-back/clear always still runs
// (holding an overlay hostage to a disabled knob would recreate OPT-C1's
// pinned-on-fallback failure one knob over).
//
// These are the FIRST tests for checkAgent's decision path: its decision core
// is now the exported decideAgentRouting(), driven here against a real
// in-memory dispatches DB through the real isPackageOpen(), following the
// pattern of costops-deepseek-balance-capacity.test.ts (exported runner
// functions + initDatabase(':memory:'), no fs mocking).

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import {
  createDispatch,
  recordOutcome,
  DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS,
} from '../costops/dispatch.js'
import { isPackageOpen, decideAgentRouting } from '../web/capacity-routing-runner.js'
import { capacityKeyId, type CapacityState, type FallbackCandidate } from '../capacity-routing.js'
import type { RuntimeOverlayEntry } from '../web/capacity-routing-store.js'

const NOW_SEC = Math.floor(Date.UTC(2026, 7, 12, 12, 0, 0) / 1000)
const NOW_MS = NOW_SEC * 1000
const CAP_SEC = DEFAULT_MAX_ATTRIBUTION_WINDOW_SECONDS // 6h
const TTL_MS = 30 * 60_000

const AGENT = 'devops'

const CANDIDATE: FallbackCandidate = {
  provider: 'anthropic',
  authProfile: 'plan:secondary',
  model: 'claude-sonnet-5',
  enabledForRouting: true,
  subscriptionIncluded: true,
}

function candidateStatesAvailable(): Map<string, CapacityState> {
  return new Map([[capacityKeyId(CANDIDATE), 'available' as CapacityState]])
}

/** A dispatch created `ageSec` before NOW, with no outcome row unless given one. */
function insertDispatch(ageSec: number, outcome?: 'accepted' | 'failed' | 'cancelled' | 'retry'): string {
  const db = getDb()
  const id = createDispatch(
    db,
    { source: 'message', agent: AGENT },
    (NOW_SEC - ageSec) * 1000,
  )
  if (outcome) recordOutcome(db, { dispatchId: id, outcome, evidence: 'test' }, NOW_MS)
  return id
}

const OVERLAY: RuntimeOverlayEntry = {
  model: CANDIDATE.model,
  provider: CANDIDATE.provider,
  authProfile: CANDIDATE.authProfile,
  dispatchId: 'd-earlier',
  fallbacksUsedThisPackage: 1,
  setAtMs: NOW_MS - TTL_MS - 60_000, // TTL comfortably elapsed
  reasonCode: 'primary_constrained_fallback_applied',
}

beforeEach(() => { initDatabase(':memory:') })

describe('OPT-H1: isPackageOpen is bounded by the dispatch-attribution window', () => {
  it('no dispatch at all -> closed', () => {
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC)).toEqual({ open: false, dispatchId: null })
  })

  it('unknown-outcome dispatch YOUNGER than the cap -> open (existing stickiness preserved)', () => {
    const id = insertDispatch(60)
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC)).toEqual({ open: true, dispatchId: id })
  })

  it('unknown-outcome dispatch OLDER than the cap -> closed (this was the forever-open defect)', () => {
    const id = insertDispatch(CAP_SEC + 60)
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC)).toEqual({ open: false, dispatchId: id })
  })

  it('the cap edge is inclusive, mirroring correlateTokenUsageToDispatches (open AT the cap, closed one past it)', () => {
    insertDispatch(CAP_SEC)
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC).open).toBe(true)
    initDatabase(':memory:')
    insertDispatch(CAP_SEC + 1)
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC).open).toBe(false)
  })

  it('a terminal outcome closes the package regardless of age', () => {
    insertDispatch(60, 'accepted')
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC).open).toBe(false)
  })

  it("'retry' is not terminal: a young retried dispatch is still open, but it ages out like any other", () => {
    insertDispatch(60, 'retry')
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC).open).toBe(true)
    initDatabase(':memory:')
    insertDispatch(CAP_SEC + 60, 'retry')
    expect(isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC).open).toBe(false)
  })
})

describe('OPT-H1: both routing directions, through the real isPackageOpen -> decideAgentRouting path', () => {
  function decide(opts: {
    overlay: RuntimeOverlayEntry | null
    primaryState: CapacityState
    automaticFallback?: boolean
    providerStatedResetAtMs?: number | null
  }) {
    const { open: packageOpen } = isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC)
    return decideAgentRouting({
      overlay: opts.overlay,
      packageOpen,
      primaryState: opts.primaryState,
      candidates: [CANDIDATE],
      candidateStates: candidateStatesAvailable(),
      errorClass: null,
      automaticFallback: opts.automaticFallback ?? true,
      providerStatedResetAtMs: opts.providerStatedResetAtMs ?? null,
      nowMs: NOW_MS,
      ttlMs: TTL_MS,
    })
  }

  it('TEST 1 (behaviour preserved): young unknown-outcome dispatch holds the fallback even on a blocked primary', () => {
    insertDispatch(60)
    const d = decide({ overlay: null, primaryState: 'blocked' })
    expect(d).toEqual({ kind: 'none', reasonCode: 'sticky_package_open' })
  })

  it('TEST 2 (direction a): dispatch older than the cap no longer blocks the fallback on a blocked primary', () => {
    insertDispatch(CAP_SEC + 3600)
    const d = decide({ overlay: null, primaryState: 'blocked' })
    expect(d).toEqual({
      kind: 'set',
      candidate: CANDIDATE,
      reasonCode: 'primary_constrained_fallback_applied',
    })
  })

  it('TEST 3 (direction b): overlay + old unknown dispatch + recovered primary + TTL elapsed -> climb-back', () => {
    insertDispatch(CAP_SEC + 3600)
    const d = decide({ overlay: OVERLAY, primaryState: 'available' })
    expect(d).toEqual({ kind: 'clear', reasonCode: 'primary_recovered_climb_back' })
  })

  it('counterpart of TEST 3: a YOUNG unknown dispatch still holds the overlay (sticky mid-package, preserved)', () => {
    insertDispatch(60)
    const d = decide({ overlay: OVERLAY, primaryState: 'available' })
    expect(d).toEqual({ kind: 'none', reasonCode: 'sticky_package_open_on_fallback' })
  })

  it('climb-back still respects TTL and primary health once the package is closed', () => {
    insertDispatch(CAP_SEC + 3600)
    const young = { ...OVERLAY, setAtMs: NOW_MS - 60_000 } // TTL not elapsed
    expect(decide({ overlay: young, primaryState: 'available' }).kind).toBe('none')
    expect(decide({ overlay: OVERLAY, primaryState: 'blocked' }).kind).toBe('none')
  })
})

describe('OPT-M1: the provider-stated reset time reaches climb-back (no longer hardcoded null)', () => {
  function decide(opts: {
    overlay: RuntimeOverlayEntry | null
    primaryState: CapacityState
    providerStatedResetAtMs: number | null
  }) {
    const { open: packageOpen } = isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC)
    return decideAgentRouting({
      overlay: opts.overlay,
      packageOpen,
      primaryState: opts.primaryState,
      candidates: [CANDIDATE],
      candidateStates: candidateStatesAvailable(),
      errorClass: null,
      automaticFallback: true,
      providerStatedResetAtMs: opts.providerStatedResetAtMs,
      nowMs: NOW_MS,
      ttlMs: TTL_MS,
    })
  }

  it('a stated reset in the FUTURE holds the overlay even though the TTL has long elapsed', () => {
    // OVERLAY's setAtMs puts the TTL comfortably in the past -- before OPT-M1
    // the hardcoded null made this climb back on TTL alone.
    const d = decide({ overlay: OVERLAY, primaryState: 'available', providerStatedResetAtMs: NOW_MS + 60_000 })
    expect(d).toEqual({ kind: 'none', reasonCode: 'ttl_not_elapsed_or_primary_still_constrained' })
  })

  it('a stated reset that has PASSED climbs back (provider-stated beats the TTL guess)', () => {
    // TTL not yet elapsed, but the provider says the window reset a minute ago.
    const young = { ...OVERLAY, setAtMs: NOW_MS - 60_000 }
    const d = decide({ overlay: young, primaryState: 'available', providerStatedResetAtMs: NOW_MS - 60_000 })
    expect(d).toEqual({ kind: 'clear', reasonCode: 'primary_recovered_climb_back' })
  })

  it('null stated reset falls back to the TTL guess, byte-identical to the pre-fix behaviour', () => {
    expect(decide({ overlay: OVERLAY, primaryState: 'available', providerStatedResetAtMs: null }).kind).toBe('clear')
    const young = { ...OVERLAY, setAtMs: NOW_MS - 60_000 }
    expect(decide({ overlay: young, primaryState: 'available', providerStatedResetAtMs: null }).kind).toBe('none')
  })
})

describe('OPT-H2: routing.automaticFallback gates SET, never climb-back/clear', () => {
  function decide(opts: {
    overlay: RuntimeOverlayEntry | null
    primaryState: CapacityState
    automaticFallback: boolean
  }) {
    const { open: packageOpen } = isPackageOpen(getDb(), AGENT, NOW_SEC, CAP_SEC)
    return decideAgentRouting({
      overlay: opts.overlay,
      packageOpen,
      primaryState: opts.primaryState,
      candidates: [CANDIDATE],
      candidateStates: candidateStatesAvailable(),
      errorClass: null,
      automaticFallback: opts.automaticFallback,
      providerStatedResetAtMs: null,
      nowMs: NOW_MS,
      ttlMs: TTL_MS,
    })
  }

  it('TEST 4a: automaticFallback=false -> NO new overlay even with primary blocked and a healthy candidate', () => {
    insertDispatch(CAP_SEC + 3600)
    const d = decide({ overlay: null, primaryState: 'blocked', automaticFallback: false })
    expect(d).toEqual({ kind: 'none', reasonCode: 'automatic_fallback_disabled' })
  })

  it('TEST 4b: automaticFallback=false -> an EXISTING overlay still climbs back/clears', () => {
    insertDispatch(CAP_SEC + 3600)
    const d = decide({ overlay: OVERLAY, primaryState: 'available', automaticFallback: false })
    expect(d).toEqual({ kind: 'clear', reasonCode: 'primary_recovered_climb_back' })
  })

  it('TEST 5: automaticFallback=true -> overlay set exactly as before', () => {
    insertDispatch(CAP_SEC + 3600)
    const d = decide({ overlay: null, primaryState: 'blocked', automaticFallback: true })
    expect(d).toEqual({
      kind: 'set',
      candidate: CANDIDATE,
      reasonCode: 'primary_constrained_fallback_applied',
    })
  })

  it('the disabled knob is reported as itself, not disguised as no-candidate/primary-ok', () => {
    // With the primary healthy the reason must stay primary_capacity_ok --
    // automatic_fallback_disabled may only appear when a fallback WOULD have
    // been set. That keeps the routing_events/log trail honest about causality.
    insertDispatch(CAP_SEC + 3600)
    const d = decide({ overlay: null, primaryState: 'available', automaticFallback: false })
    expect(d).toEqual({ kind: 'none', reasonCode: 'primary_capacity_ok' })
  })
})

describe('STANDING CHECKS: the wiring stays wired (source-level, same pattern as optimization-kill-switch-reaches-runner)', () => {
  const runnerSrc = () => readFileSync(join(process.cwd(), 'src/web/capacity-routing-runner.ts'), 'utf8')

  it('the sweep reads routing.automaticFallback from the optimization config, fresh each pass', () => {
    // If this read disappears, the knob is decorative again (OPT-H2's exact
    // pre-fix state) and the summary's 'observation' system_state lies.
    expect(runnerSrc()).toMatch(/readOptimizationConfig\(\)\.config\.routing\.automaticFallback/)
  })

  it('checkAgent decides through decideAgentRouting and passes the knob + the clock into isPackageOpen', () => {
    const src = runnerSrc()
    expect(src).toMatch(/decideAgentRouting\(\{/)
    expect(src).toMatch(/isPackageOpen\(db, name, nowSec\)/)
    expect(src).toMatch(/automaticFallback/)
  })

  it('isPackageOpen defaults its bound to the dispatch-attribution window cap (never unbounded)', () => {
    expect(runnerSrc()).toMatch(/loadDispatchAttributionConfig\(\)\.maxWindowSeconds/)
  })

  it('OPT-M2: the sweep threads cfg.limitedThreshold into the per-agent check (the knob is not decorative)', () => {
    expect(runnerSrc()).toMatch(/cfg\.limitedThreshold/)
  })

  it('OPT-M1: decideAgentRouting no longer hardcodes providerStatedResetAtMs to null', () => {
    // The pre-fix line was `providerStatedResetAtMs: null, // no provider-stated
    // reset is observable today` -- false for codex. The value must flow from
    // the input (fed by capacityInfoFor's snapshot read), never a literal null.
    expect(runnerSrc()).toMatch(/providerStatedResetAtMs:\s*input\.providerStatedResetAtMs/)
    expect(runnerSrc()).toMatch(/providerStatedResetAtSec/)
  })
})
