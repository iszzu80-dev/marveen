// §13.1 Reader–Policy–Kernel arbitration.
//
// The Reader's candidateDecision is a suggestion. These tests are the place
// where that sentence becomes enforceable: each one drives a rung of §13.1's
// precedence ladder and asserts which rung won, because "policy wins" verified
// by reading the code is the kind of claim that survives the code changing
// underneath it.
import { describe, it, expect } from 'vitest'
import { arbitrate, fallbackFor, hasExternalEffect, CONFIDENCE_THRESHOLDS } from '../cos/reader-arbitration.js'

describe('§13.1 arbitration', () => {
  it('POLICY WINS when the Reader disagrees, and the conflict is audited', () => {
    const r = arbitrate({
      readerCandidate: 'CONTINUE_AUTONOMOUSLY', confidence: 0.99,
      policyDecision: 'WAIT_EXTERNAL',
    })
    expect(r.finalDecision).toBe('WAIT_EXTERNAL')
    expect(r.decidedBy).toBe('POLICY')
    expect(r.conflict).toBe(true)
    // The four fields §13.1 names, all present.
    expect(r.readerCandidate).toBe('CONTINUE_AUTONOMOUSLY')
    expect(r.policyResult).toBe('WAIT_EXTERNAL')
    expect(r.conflictReason).toMatch(/reader proposed CONTINUE_AUTONOMOUSLY/)
    expect(r.safeFallbackDecision).toBe('WAIT_EXTERNAL')
  })

  it('a hard gate beats a confident Reader AND agreeing policy', () => {
    // "A Reader confidence soha nem írhat felül hard gate-et." Both lower rungs
    // agree here, so only the gate can produce this outcome.
    const r = arbitrate({
      readerCandidate: 'CONTINUE_AUTONOMOUSLY', confidence: 1,
      policyDecision: 'CONTINUE_AUTONOMOUSLY',
      hardGateRefusal: 'kill switch engaged',
    })
    expect(r.decidedBy).toBe('HARD_GATE')
    expect(r.finalDecision).toBe('RECOVERY_REQUIRED')
    expect(hasExternalEffect(r.finalDecision)).toBe(false)
    expect(r.conflictReason).toMatch(/kill switch engaged/)
  })

  it('COMPLETE is refused at low confidence even when policy agrees', () => {
    // §13.1: "COMPLETE alacsony confidence mellett nem fogadható el." This is
    // the case a policy-only check cannot catch, because policy said COMPLETE.
    const r = arbitrate({
      readerCandidate: 'COMPLETE', confidence: 0.5, policyDecision: 'COMPLETE',
    })
    expect(r.decidedBy).toBe('CONFIDENCE')
    expect(r.finalDecision).not.toBe('COMPLETE')
    expect(r.finalDecision).toBe('REQUEST_DECISION')
    expect(r.conflict).toBe(true)
  })

  it('low confidence produces NO external side effect', () => {
    const r = arbitrate({
      readerCandidate: 'CONTINUE_AUTONOMOUSLY', confidence: 0.3,
      policyDecision: 'CONTINUE_AUTONOMOUSLY',
    })
    expect(hasExternalEffect(r.finalDecision)).toBe(false)
    expect(r.finalDecision).toBe('ASK_INFORMATION')
  })

  it('high confidence on an agreed external decision is allowed through', () => {
    // The counter-case. A rule that refuses everything is not a rule, and a test
    // suite where every arbitration ends in a fallback cannot tell a working
    // gate from one stuck shut.
    const r = arbitrate({
      readerCandidate: 'CONTINUE_AUTONOMOUSLY', confidence: 0.9,
      policyDecision: 'CONTINUE_AUTONOMOUSLY',
    })
    expect(r.decidedBy).toBe('READER_AGREES')
    expect(r.finalDecision).toBe('CONTINUE_AUTONOMOUSLY')
    expect(r.conflict).toBe(false)
    expect(r.conflictReason).toBeNull()
  })

  it('asking and waiting need no confidence floor', () => {
    // Knowing little is the correct reason to ask. A floor here would push an
    // uncertain case towards silence instead of towards a question.
    for (const d of ['ASK_INFORMATION', 'WAIT_EXTERNAL', 'REQUEST_APPROVAL'] as const) {
      const r = arbitrate({ readerCandidate: d, confidence: 0.05, policyDecision: d })
      expect(r.finalDecision).toBe(d)
      expect(r.decidedBy).toBe('READER_AGREES')
    }
  })

  it('an invalid packet has no standing: policy stands alone and the discard is recorded', () => {
    const r = arbitrate({
      readerCandidate: 'COMPLETE', confidence: 1,
      policyDecision: 'WAIT_EXTERNAL', packetValid: false,
    })
    expect(r.decidedBy).toBe('INVALID_PACKET')
    expect(r.finalDecision).toBe('WAIT_EXTERNAL')
    expect(r.readerCandidate).toBeNull()
    expect(r.conflictReason).toMatch(/failed validation/)
  })

  it('the thresholds are per decision class, not one global number', () => {
    // §13.1 says so explicitly. Asserted as a property so a later "simplification"
    // to a single constant fails here instead of passing quietly.
    const values = Object.values(CONFIDENCE_THRESHOLDS)
    expect(values.length).toBeGreaterThan(1)
    expect(new Set(values).size).toBeGreaterThan(1)
    expect(CONFIDENCE_THRESHOLDS.COMPLETE).toBeGreaterThan(CONFIDENCE_THRESHOLDS.CONTINUE_AUTONOMOUSLY!)
  })

  it('every fallback is itself side-effect free', () => {
    for (const d of ['COMPLETE', 'CONTINUE_AUTONOMOUSLY', 'CALL_REQUIRED'] as const) {
      expect(hasExternalEffect(fallbackFor(d))).toBe(false)
    }
  })
})
