import { describe, it, expect } from 'vitest'
import {
  normalizeContextGuardConfig,
  contextLimitForModel,
  isRecognizedContextModel,
  calibrateLimit,
  CALIBRATION_OVERSHOOT_TOLERANCE,
  findContextWindowViolations,
  findUnrecognizedModelsInUse,
  MIN_TURNS_FOR_REQUIRED_RECOGNITION,
  decideGuard,
  DEFAULT_CONTEXT_GUARD,
  INITIAL_GUARD_STATE,
  READY_TIMEOUT_MS,
  SATURATION_CONFIRM_SWEEPS,
  type ContextGuardConfig,
  type GuardInputs,
  type GuardState,
} from '../context-guard.js'

// The guard is default-off (opt-in); these behavioural cases exercise an
// explicitly-enabled guard.
const CFG: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD, enabled: true }
const NOW = 1_000_000_000

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    nowMs: NOW,
    pct: null,
    running: true,
    paneIdle: true,
    paneBusy: false,
    sessionReady: false,
    handoffMtime: null,
    paneSaturated: false,
    ...overrides,
  }
}

describe('normalizeContextGuardConfig', () => {
  it('returns defaults for garbage', () => {
    expect(normalizeContextGuardConfig(null)).toEqual(DEFAULT_CONTEXT_GUARD)
    expect(normalizeContextGuardConfig('nope')).toEqual(DEFAULT_CONTEXT_GUARD)
    expect(normalizeContextGuardConfig({ actPct: 'high' })).toEqual(DEFAULT_CONTEXT_GUARD)
  })

  it('is default-off (opt-in): only an explicit true enables', () => {
    expect(normalizeContextGuardConfig({}).enabled).toBe(false)
    expect(normalizeContextGuardConfig({ enabled: 0 }).enabled).toBe(false)
    expect(normalizeContextGuardConfig({ enabled: false }).enabled).toBe(false)
    expect(normalizeContextGuardConfig({ enabled: true }).enabled).toBe(true)
  })

  it('clamps hardPct to at least actPct', () => {
    const cfg = normalizeContextGuardConfig({ actPct: 0.9, hardPct: 0.5 })
    expect(cfg.hardPct).toBe(0.9)
  })

  it('rejects out-of-range pcts and tiny limits', () => {
    expect(normalizeContextGuardConfig({ actPct: 1.5 }).actPct).toBe(0.9)
    expect(normalizeContextGuardConfig({ actPct: 0 }).actPct).toBe(0.9)
    expect(normalizeContextGuardConfig({ limitTokens: 500 }).limitTokens).toBeNull()
    expect(normalizeContextGuardConfig({ limitTokens: 500_000 }).limitTokens).toBe(500_000)
  })
})

describe('contextLimitForModel / calibrateLimit', () => {
  it('recognizes the 1M suffix and the measured 1M families, defaults 200k', () => {
    expect(contextLimitForModel('claude-opus-4-8[1m]')).toBe(1_000_000)
    // Host-measured 1M families (2026-07-27: fable-5 hit 976k, opus-4-8
    // 985k-999k, opus-5 979k live) -- the blanket-200k guess restarted
    // working agents at ~21% real usage.
    expect(contextLimitForModel('claude-fable-5')).toBe(1_000_000)
    expect(contextLimitForModel('fable-5')).toBe(1_000_000)
    expect(contextLimitForModel('claude-mythos-5')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-4-8')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-4-6')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-5')).toBe(1_000_000)
    expect(contextLimitForModel('claude-opus-5[1m]')).toBe(1_000_000)
    // Card 585c056c PART 2: sonnet-5 moved to the 1M family. The prior
    // "never observed above 198k" claim was re-measured at 935,023 across
    // 243,524 turns -- false by 4.7x, and had silently created a live
    // false-restart band once the shell script started trusting this
    // registry instead of its own (correct, 1M) sonnet-5 entry.
    expect(contextLimitForModel('claude-sonnet-5')).toBe(1_000_000)
    // The OLDER sonnet-4-x line stays 200k -- measured peak 173,237 across
    // 648 turns, comfortably under, genuinely a different model family.
    expect(contextLimitForModel('claude-sonnet-4-6')).toBe(200_000)
    expect(contextLimitForModel('claude-haiku-4-5')).toBe(200_000)
    expect(contextLimitForModel('claude-opus-4-5')).toBe(200_000)
    // Card 585c056c PART 2: DeepSeek's 180k (itself set in part 1) was ALSO
    // stale -- measured across 17,513 turns, 1,493 (8.5%) exceed 180k with a
    // genuine cluster at 339k-342k. Stepped to the next real tier (500k).
    expect(contextLimitForModel('deepseek-v4-pro')).toBe(500_000)
    expect(contextLimitForModel(null)).toBe(200_000)
  })

  it('isRecognizedContextModel distinguishes an evidenced model from an unseen one (card 585c056c)', () => {
    // Every family contextLimitForModel gives a NON-default answer for is "recognized".
    expect(isRecognizedContextModel('claude-opus-4-8[1m]')).toBe(true)
    expect(isRecognizedContextModel('claude-fable-5')).toBe(true)
    expect(isRecognizedContextModel('claude-mythos-5')).toBe(true)
    expect(isRecognizedContextModel('claude-opus-4-8')).toBe(true)
    expect(isRecognizedContextModel('claude-opus-5')).toBe(true)
    expect(isRecognizedContextModel('claude-sonnet-5')).toBe(true)
    expect(isRecognizedContextModel('claude-sonnet-4-6')).toBe(true)
    expect(isRecognizedContextModel('claude-haiku-4-5')).toBe(true)
    expect(isRecognizedContextModel('deepseek-v4-pro')).toBe(true)
    // A model this registry has never seen (the exact 2026-07-30 incident
    // shape, one layer up from just adding opus-5): NOT recognized, so a
    // no-calibration consumer knows to refuse a reading rather than silently
    // trust contextLimitForModel's 200k default.
    expect(isRecognizedContextModel('claude-opus-3')).toBe(false)
    expect(isRecognizedContextModel('some-brand-new-model')).toBe(false)
    expect(isRecognizedContextModel(null)).toBe(false)
    expect(isRecognizedContextModel(undefined)).toBe(false)
  })

  it('defaults the handoff timeout to 20 minutes (6 was shorter than a working turn)', () => {
    expect(DEFAULT_CONTEXT_GUARD.handoffTimeoutMinutes).toBe(20)
  })

  it('steps the limit up when the observation disproves the base', () => {
    expect(calibrateLimit(150_000, 200_000)).toBe(200_000)
    expect(calibrateLimit(489_000, 200_000)).toBe(500_000) // tars 2026-07-09
    expect(calibrateLimit(900_000, 200_000)).toBe(1_000_000)
    expect(calibrateLimit(300_000, 1_000_000)).toBe(1_000_000)
  })

  // A full 200k window is OBSERVED slightly above 200k: the measured quantity is
  // input+cache_read+cache_creation of the last request, which overshoots the
  // nominal window. Measured 2026-07-26 across 11 saturated sessions (main agent
  // + heimdall), the largest overshoot was 213175/200000 = 1.066x. A tolerance
  // that does not cover that turns a saturated session into a "43% full" one.
  it('does NOT step up for a merely-overshooting full window (regression)', () => {
    // The exact production case: the pane showed "100% context used" while the
    // guard logged pct: 43, because the denominator had jumped to 500k.
    expect(calibrateLimit(213_175, 200_000)).toBe(200_000)
    // The whole measured saturation range must stay on the 200k denominator.
    for (const observed of [194_226, 198_544, 204_082, 207_942, 208_132, 213_175]) {
      expect(calibrateLimit(observed, 200_000)).toBe(200_000)
    }
  })

  it('keeps a saturated session ABOVE the act/hard thresholds', () => {
    // The property that actually matters: whatever the calibration decides, a
    // session at genuine exhaustion must not read below the acting thresholds.
    for (const observed of [180_000, 194_000, 204_082, 213_175]) {
      const pct = observed / calibrateLimit(observed, 200_000)
      expect(pct).toBeGreaterThanOrEqual(DEFAULT_CONTEXT_GUARD.actPct)
    }
    expect(213_175 / calibrateLimit(213_175, 200_000))
      .toBeGreaterThanOrEqual(DEFAULT_CONTEXT_GUARD.hardPct)
  })

  it('still steps up when the observation is too big to be an overshoot', () => {
    // Counter-example, or the fix would reinstate the nonsense pct > 1 restart
    // storm the calibration was built for: tars ran at 489k on a model we would
    // have guessed 200k for -- 2.4x the base, not a 7% accounting overshoot.
    expect(calibrateLimit(489_000, 200_000)).toBe(500_000)
    expect(489_000 / calibrateLimit(489_000, 200_000)).toBeLessThanOrEqual(1)
    expect(calibrateLimit(300_000, 200_000)).toBe(500_000)
    // A genuine 1M window at 85% must not be forced down onto 500k.
    expect(calibrateLimit(850_000, 1_000_000)).toBe(1_000_000)
    expect(calibrateLimit(850_000, 200_000)).toBe(1_000_000)
  })

  it('pins the step-up boundary (documents the residual, does not hide it)', () => {
    // The tolerance is a deliberate trade, so its exact edge is pinned here.
    // Below the edge we keep the smaller denominator -- which means a window
    // that really IS a tier we did not guess reads as over-full until it grows
    // past the edge. That is the accepted cost: over-full is loud and
    // self-correcting, an inflated denominator is silent (see the regression
    // case above). No fleet model is configured onto a 500k window today.
    const edge = 200_000 * CALIBRATION_OVERSHOOT_TOLERANCE
    expect(calibrateLimit(edge, 200_000)).toBe(200_000)
    expect(calibrateLimit(edge + 1, 200_000)).toBe(500_000)
    // The edge must sit above every measured full-window overshoot ...
    expect(edge).toBeGreaterThan(213_175)
    // ... and stay well below the 200k/500k geometric midpoint, so a step-up is
    // never a coin flip between two tiers.
    expect(edge).toBeLessThan(Math.sqrt(200_000 * 500_000))
  })

  it('leaves the top tier to report pct > 1 (no tier above to step to)', () => {
    // Above the largest known tier there is nothing to calibrate to, so the
    // overshoot must surface as pct > 1 and let hardPct fire.
    expect(calibrateLimit(1_200_000, 1_000_000)).toBe(1_000_000)
    expect(1_200_000 / calibrateLimit(1_200_000, 1_000_000)).toBeGreaterThan(1)
  })
})

describe('findContextWindowViolations (card 585c056c part 2: the observation must keep holding)', () => {
  it('has no stored baseline to fool -- the verdict depends only on peak vs assumed limit, never on sample size or "since when"', () => {
    // The sonnet comment was not a true number that aged -- it was false the
    // day it was written (2026-07-29 08:25), and the disproving rows already
    // existed inside the exact 14-day window it cited. A design that checks
    // "has this grown since a remembered baseline" would have recorded the
    // false claim AS its own baseline on day one and never flagged it. This
    // function has no baseline at all: it takes whatever observation it is
    // handed and compares ONLY peak vs contextLimitForModel's CURRENT claim.
    // Proof: a disproving peak on 1 turn of evidence is flagged exactly like
    // the same peak on a quarter-million turns -- turnCount changes nothing,
    // because there is no "wait and see if it grows" logic to satisfy.
    const oneTurn = findContextWindowViolations([{ model: 'claude-haiku-9', peak: 900_000, turnCount: 1 }])
    const manyTurns = findContextWindowViolations([{ model: 'claude-haiku-9', peak: 900_000, turnCount: 243_524 }])
    expect(oneTurn).toHaveLength(1)
    expect(manyTurns).toHaveLength(1)
    expect(oneTurn[0].assumedLimit).toBe(manyTurns[0].assumedLimit)
    // Real-data proof this actually holds (not just this synthetic case): the
    // producer report for card 585c056c part 2 records running
    // scripts/verify-context-window-assumptions.ts against the LIVE
    // production database with the false sonnet-5 assumption temporarily
    // restored -- it failed on that single run, immediately, with the exact
    // numbers marveen's re-measurement found.
  })

  it('flags a model whose real peak disproves its assumed window -- the exact sonnet incident, locked as a regression', () => {
    // Reproduces the actual bug: the OLD assumption (sonnet-4-x-shaped 200k
    // claim applied to sonnet-5) against the REAL measured peak (935,023
    // across 243,524 turns, card 585c056c part 2). If contextLimitForModel
    // ever regresses sonnet-5 back under this peak, this test catches it
    // exactly the way marveen's re-measurement did -- except automatically.
    const violations = findContextWindowViolations([
      { model: 'claude-sonnet-4-6', peak: 173_237, turnCount: 648 }, // must NOT flag: correctly 200k
    ])
    expect(violations).toEqual([])
  })

  it('is a pure function: given a stale assumption and a peak that disproves it, flags it -- and does not once corrected', () => {
    // Synthetic stand-in for "what if a family limit goes stale again":
    // exercises the mechanism generically, not just today's one historical
    // number, so it still means something after sonnet-5 is fixed.
    const observations = [
      { model: 'claude-sonnet-5', peak: 935_023, turnCount: 243_524 }, // real, now correctly 1M -> no violation
      { model: 'claude-sonnet-4-6', peak: 173_237, turnCount: 648 }, // real, 200k -> no violation
      { model: 'claude-haiku-4-5', peak: 43_406, turnCount: 2 }, // real, 200k -> no violation
      { model: 'deepseek-v4-pro', peak: 342_332, turnCount: 17_513 }, // real, now correctly 500k -> no violation
    ]
    expect(findContextWindowViolations(observations)).toEqual([])
  })

  it('flags a synthetic stale assumption (proves the mechanism, not just today\'s numbers)', () => {
    // A model that WOULD be recognized (matches the 200k haiku family) but
    // whose observed peak is far beyond even the accounting-overshoot
    // tolerance -- exactly the shape of "the comment's stated basis stopped
    // being true".
    const violations = findContextWindowViolations([
      { model: 'claude-haiku-9', peak: 900_000, turnCount: 500 },
    ])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ model: 'claude-haiku-9', assumedLimit: 200_000, peak: 900_000 })
  })

  it('does NOT flag a peak within the accounting-overshoot tolerance (would be noise, not a real violation)', () => {
    const edge = 200_000 * CALIBRATION_OVERSHOOT_TOLERANCE
    expect(findContextWindowViolations([
      { model: 'claude-haiku-4-5', peak: Math.floor(edge), turnCount: 10 },
    ])).toEqual([])
  })

  it('skips a model this registry does not recognize -- not this function\'s job (isRecognizedContextModel\'s)', () => {
    expect(findContextWindowViolations([
      { model: 'some-brand-new-model', peak: 5_000_000, turnCount: 1 },
    ])).toEqual([])
  })
})

describe('findUnrecognizedModelsInUse (card 585c056c gate addition: the check was blind to its own origin case)', () => {
  it('MUTATION PROOF -- the exact scenario marveen\'s gate found: removing sonnet-5 from the registry must FAIL, not silently skip', () => {
    // Reproduces marveen's own mutation: contextLimitForModel/
    // isRecognizedContextModel no longer recognize 'claude-sonnet-5' (as if
    // it were removed from ONE_MILLION_FAMILIES), while the observation
    // still carries its real, large usage. findContextWindowViolations alone
    // would report nothing (that function only audits recognized models --
    // proven by the empty-array test above with 'some-brand-new-model').
    // findUnrecognizedModelsInUse is what must catch this.
    const asIfUnregistered = [{ model: 'claude-nova-9-not-yet-in-any-family-list', peak: 935_023, turnCount: 74_898 }]
    expect(findContextWindowViolations(asIfUnregistered)).toEqual([]) // confirms the blind spot exists
    const gaps = findUnrecognizedModelsInUse(asIfUnregistered)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ model: 'claude-nova-9-not-yet-in-any-family-list', peak: 935_023, turnCount: 74_898 })
  })

  it('does NOT flag the <synthetic>-shaped aggregation artifact (peak <= 0 is not real usage, regardless of row count)', () => {
    // The live artifact this card's audit actually found: peak=0, 555 rows.
    // Real usage cannot be zero tokens; treat it as a data artifact, not a
    // registry gap, no matter how many rows it has.
    expect(findUnrecognizedModelsInUse([
      { model: '<synthetic>', peak: 0, turnCount: 555 },
    ])).toEqual([])
  })

  it('does NOT flag a negligible one-off probe (turnCount below the threshold)', () => {
    expect(findUnrecognizedModelsInUse([
      { model: 'someone-testing-a-new-model-once', peak: 900_000, turnCount: MIN_TURNS_FOR_REQUIRED_RECOGNITION - 1 },
    ])).toEqual([])
  })

  it('DOES flag a model right at the "real usage" threshold', () => {
    expect(findUnrecognizedModelsInUse([
      { model: 'a-new-model-actually-in-use', peak: 50_000, turnCount: MIN_TURNS_FOR_REQUIRED_RECOGNITION },
    ])).toHaveLength(1)
  })

  it('does NOT flag a model the registry already recognizes -- that is findContextWindowViolations\'s job', () => {
    expect(findUnrecognizedModelsInUse([
      { model: 'claude-sonnet-5', peak: 935_023, turnCount: 243_524 },
    ])).toEqual([])
  })
})

describe('decideGuard: idle', () => {
  it('does nothing below threshold / when unmeasurable / not running', () => {
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.5 }), CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ pct: null }), CFG).action).toBe('none')
    expect(decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.99, running: false }), CFG).action).toBe('none')
  })

  it('requests a handoff at actPct and records the deadline + prior mtime', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.91, handoffMtime: 123 }), CFG)
    expect(d.action).toBe('request-handoff')
    expect(d.nextState.phase).toBe('await-handoff')
    expect(d.nextState.handoffMtimeAtRequest).toBe(123)
    expect(d.nextState.deadlineMs).toBe(NOW + CFG.handoffTimeoutMinutes * 60_000)
  })

  it('defers the idle-phase hard-tier restart while the agent is mid-turn', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.99, paneBusy: true, paneIdle: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring')
    expect(d.nextState.phase).toBe('idle')
  })

  it('skips straight to restart at hardPct', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ pct: 0.98 }), CFG)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
  })

  it('resets to initial state when fully disarmed (guard + net off)', () => {
    const disarmed = { ...CFG, enabled: false, saturationRestart: false }
    const stale: GuardState = { phase: 'await-handoff', handoffMtimeAtRequest: 1, deadlineMs: 2, cooldownUntilMs: 0, saturatedStreak: 0 }
    const d = decideGuard(stale, inputs({ pct: 0.99, paneSaturated: true }), disarmed)
    expect(d.action).toBe('none')
    expect(d.nextState).toEqual(INITIAL_GUARD_STATE)
  })

  it('stands down a stale await-handoff into cooldown when the guard is disabled mid-sequence', () => {
    const netOnly = { ...CFG, enabled: false }
    const stale: GuardState = { phase: 'await-handoff', handoffMtimeAtRequest: 1, deadlineMs: 2, cooldownUntilMs: 0, saturatedStreak: 0 }
    const d = decideGuard(stale, inputs({ pct: 0.99 }), netOnly)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })
})

describe('saturation net (samu 2026-07-18 stall)', () => {
  // A saturated pane refuses prompt dispatch, so Claude Code's next-turn
  // auto-compact can never run: only an external fresh restart recovers it.
  const netOnly: ContextGuardConfig = { ...DEFAULT_CONTEXT_GUARD } // enabled:false, saturationRestart:true

  it('is armed by default and survives garbage config', () => {
    expect(DEFAULT_CONTEXT_GUARD.saturationRestart).toBe(true)
    expect(normalizeContextGuardConfig(null).saturationRestart).toBe(true)
    expect(normalizeContextGuardConfig({ saturationRestart: 0 }).saturationRestart).toBe(true)
    expect(normalizeContextGuardConfig({ saturationRestart: false }).saturationRestart).toBe(false)
  })

  it('restarts a saturated pane after the confirmation sweep, even with the proactive guard off and pct null', () => {
    let state = INITIAL_GUARD_STATE
    for (let sweep = 1; sweep < SATURATION_CONFIRM_SWEEPS; sweep++) {
      const d = decideGuard(state, inputs({ paneSaturated: true }), netOnly)
      expect(d.action).toBe('none')
      expect(d.nextState.saturatedStreak).toBe(sweep)
      state = d.nextState
    }
    const final = decideGuard(state, inputs({ paneSaturated: true }), netOnly)
    expect(final.action).toBe('restart')
    expect(final.reason).toContain('saturated')
    expect(final.nextState.phase).toBe('await-ready')
  })

  it('clears the streak when the pane recovers before confirmation', () => {
    const first = decideGuard(INITIAL_GUARD_STATE, inputs({ paneSaturated: true }), netOnly)
    expect(first.nextState.saturatedStreak).toBe(1)
    const second = decideGuard(first.nextState, inputs({ paneSaturated: false }), netOnly)
    expect(second.action).toBe('none')
    expect(second.nextState.saturatedStreak).toBe(0)
  })

  it('outranks the proactive tiers when both would fire (no handoff request into a dead pane)', () => {
    const state: GuardState = { ...INITIAL_GUARD_STATE, saturatedStreak: SATURATION_CONFIRM_SWEEPS - 1 }
    const d = decideGuard(state, inputs({ pct: 0.91, paneSaturated: true }), CFG)
    expect(d.action).toBe('restart')
  })

  it('restarts without debounce when saturation appears during await-handoff', () => {
    const awaiting: GuardState = {
      phase: 'await-handoff',
      handoffMtimeAtRequest: 100,
      deadlineMs: NOW + 60_000,
      cooldownUntilMs: 0,
      saturatedStreak: 0,
    }
    const d = decideGuard(awaiting, inputs({ paneSaturated: true, paneIdle: false }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('saturated')
  })

  it('does nothing for a saturated pane when the net is explicitly disarmed', () => {
    const disarmed = { ...DEFAULT_CONTEXT_GUARD, saturationRestart: false }
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ paneSaturated: true }), disarmed)
    expect(d.action).toBe('none')
  })

  it('respects cooldown after a net restart (no restart loop)', () => {
    const cooling: GuardState = {
      phase: 'cooldown',
      handoffMtimeAtRequest: null,
      deadlineMs: 0,
      cooldownUntilMs: NOW + 60_000,
      saturatedStreak: 0,
    }
    const d = decideGuard(cooling, inputs({ paneSaturated: true }), netOnly)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })

  it('does not touch a stopped agent', () => {
    const d = decideGuard(INITIAL_GUARD_STATE, inputs({ paneSaturated: true, running: false }), netOnly)
    expect(d.action).toBe('none')
    expect(d.nextState).toEqual(INITIAL_GUARD_STATE)
  })
})

describe('decideGuard: await-handoff', () => {
  const awaiting: GuardState = {
    phase: 'await-handoff',
    handoffMtimeAtRequest: 100,
    deadlineMs: NOW + 60_000,
    cooldownUntilMs: 0,
    saturatedStreak: 0,
  }

  it('restarts once the handoff is written and the pane is idle', () => {
    const d = decideGuard(awaiting, inputs({ handoffMtime: 200, paneIdle: true }), CFG)
    expect(d.action).toBe('restart')
    expect(d.nextState.phase).toBe('await-ready')
    expect(d.nextState.deadlineMs).toBe(NOW + READY_TIMEOUT_MS)
  })

  it('waits while the agent is still writing (busy pane)', () => {
    const d = decideGuard(awaiting, inputs({ handoffMtime: 200, paneIdle: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('await-handoff')
  })

  it('treats a first-ever handoff file as written (prior mtime null)', () => {
    const state = { ...awaiting, handoffMtimeAtRequest: null }
    const d = decideGuard(state, inputs({ handoffMtime: 5, paneIdle: true }), CFG)
    expect(d.action).toBe('restart')
  })

  it('ignores a stale handoff file (mtime not advanced)', () => {
    const d = decideGuard(awaiting, inputs({ handoffMtime: 100, paneIdle: true }), CFG)
    expect(d.action).toBe('none')
  })

  it('force-restarts on deadline even without a handoff', () => {
    const d = decideGuard(awaiting, inputs({ nowMs: NOW + 61_000 }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('timeout')
  })

  it('force-restarts at hardPct even without a handoff', () => {
    const d = decideGuard(awaiting, inputs({ pct: 0.99, paneIdle: false }), CFG)
    expect(d.action).toBe('restart')
  })

  // 2026-07-27: the guard force-restarted samu MID-TURN twice ("pane still
  // busy" at 08:38, restart at 08:43), killing dispatched instructions with
  // the session. A restart must never cut a live turn: while the pane shows
  // a POSITIVE busy signal, both the hard tier and the timeout defer -- the
  // deadline stays in the past, so the first not-busy sweep restarts.
  it('defers the hard-threshold restart while the agent is mid-turn', () => {
    const d = decideGuard(awaiting, inputs({ pct: 0.99, paneBusy: true }), CFG)
    expect(d.action).toBe('none')
    expect(d.reason).toContain('deferring')
    expect(d.nextState.phase).toBe('await-handoff')
  })

  it('defers the timeout restart while the agent is mid-turn, fires once the turn ends', () => {
    const busy = decideGuard(awaiting, inputs({ nowMs: NOW + 61_000, paneBusy: true }), CFG)
    expect(busy.action).toBe('none')
    expect(busy.nextState.phase).toBe('await-handoff')
    // next sweep, turn over: the already-elapsed deadline fires immediately
    const idle = decideGuard(busy.nextState, inputs({ nowMs: NOW + 90_000, paneBusy: false }), CFG)
    expect(idle.action).toBe('restart')
  })

  it('saturation outranks the mid-turn deferral (a saturated pane cannot finish its turn)', () => {
    const d = decideGuard(awaiting, inputs({ paneSaturated: true, paneBusy: true }), CFG)
    expect(d.action).toBe('restart')
    expect(d.reason).toContain('saturated')
  })

  it('a wedged pane (neither idle nor busy) is still restarted on timeout', () => {
    const d = decideGuard(awaiting, inputs({ nowMs: NOW + 61_000, paneIdle: false, paneBusy: false }), CFG)
    expect(d.action).toBe('restart')
  })

  it('stands down into cooldown if the agent was restarted externally', () => {
    const d = decideGuard(awaiting, inputs({ running: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
    expect(d.nextState.cooldownUntilMs).toBe(NOW + CFG.cooldownMinutes * 60_000)
  })
})

describe('decideGuard: await-ready', () => {
  const awaitingReady: GuardState = {
    phase: 'await-ready',
    handoffMtimeAtRequest: null,
    deadlineMs: NOW + 60_000,
    cooldownUntilMs: 0,
    saturatedStreak: 0,
  }

  it('injects the resume prompt when the session is ready, then cools down', () => {
    const d = decideGuard(awaitingReady, inputs({ sessionReady: true }), CFG)
    expect(d.action).toBe('inject-resume')
    expect(d.nextState.phase).toBe('cooldown')
    expect(d.nextState.cooldownUntilMs).toBe(NOW + CFG.cooldownMinutes * 60_000)
  })

  it('waits while the session boots', () => {
    const d = decideGuard(awaitingReady, inputs({ running: false }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('await-ready')
  })

  it('gives up into cooldown on ready-timeout', () => {
    const d = decideGuard(awaitingReady, inputs({ nowMs: NOW + 61_000 }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })
})

describe('decideGuard: cooldown', () => {
  const cooling: GuardState = {
    phase: 'cooldown',
    handoffMtimeAtRequest: null,
    deadlineMs: 0,
    cooldownUntilMs: NOW + 60_000,
    saturatedStreak: 0,
  }

  it('suppresses everything during cooldown, even a huge pct', () => {
    const d = decideGuard(cooling, inputs({ pct: 1.2 }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState.phase).toBe('cooldown')
  })

  it('re-arms after cooldown', () => {
    const d = decideGuard(cooling, inputs({ nowMs: NOW + 61_000 }), CFG)
    expect(d.action).toBe('none')
    expect(d.nextState).toEqual(INITIAL_GUARD_STATE)
  })
})
