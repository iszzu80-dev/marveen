import { describe, it, expect } from 'vitest'
import { arbitrate, packetIsContradictory, NON_CONFLICT_DECIDED_BY } from '../cos/reader-arbitration.js'

// E3 — is 84% a real disagreement rate, or is the comparison mis-specified?
//
// Measured on the live store, 2026-08-31: 152 of 181 active cases counted as
// contradicted. Broken down by `decided_by`: POLICY 133, CONFIDENCE 4, and
// INVALID_PACKET 15.
//
// The last group is the mis-specification. `arbitrate` returns `conflict: false`
// for an invalid packet -- in its own words, "an unvalidated packet is not a
// weaker opinion, it is not evidence" -- and then fills conflictReason with an
// explanatory note. The flag is never persisted; the note is. So every consumer
// asked `conflict_reason IS NOT NULL` and got the wrong answer for exactly that
// branch.
//
// 137 of 181 is the real number: 0.76, not 0.84. Still most of the population,
// and the remaining question (why the reader proposes a halt and the policy says
// CONTINUE_AUTONOMOUSLY in 106 of 133 cases) is a real one. But it has to be
// asked about the right 137 cases.

describe('E3: what counts as a contradiction', () => {
  it('an invalid packet is NOT a contradiction -- arbitrate says so itself', () => {
    const r = arbitrate({
      readerCandidate: 'ASK_INFORMATION', confidence: 0.9,
      policyDecision: 'CONTINUE_AUTONOMOUSLY', packetValid: false,
    })
    expect(r.conflict).toBe(false)
    expect(r.decidedBy).toBe(NON_CONFLICT_DECIDED_BY)
    // ...and the note it leaves must not be read as one.
    expect(r.conflictReason).toBeTruthy()
    expect(packetIsContradictory({ conflictReason: r.conflictReason, decidedBy: r.decidedBy })).toBe(false)
  })

  // UPDATED after the owner's ruling of 2026-08-31, and the update is the
  // ruling. This test used to assert that ASK_INFORMATION against
  // CONTINUE_AUTONOMOUSLY is a contradiction. It is not: one speaks about
  // whether a person is needed, the other about whether the engine may take its
  // next step, and the owner named exactly this pair as the compatible case.
  it('a SAME-AXIS disagreement IS one, and the predicate agrees with the flag', () => {
    // TERMINALITY, both speaking, opposite claims.
    const r = arbitrate({
      readerCandidate: 'COMPLETE', confidence: 0.9,
      policyDecision: 'CONTINUE_AUTONOMOUSLY', packetValid: true,
    })
    expect(r.conflict).toBe(true)
    expect(r.conflictReason).toContain('TERMINALITY')
    expect(packetIsContradictory({ conflictReason: r.conflictReason, decidedBy: r.decidedBy })).toBe(true)
  })

  it('a CROSS-AXIS difference is not a contradiction, and says so in decided_by', () => {
    const r = arbitrate({
      readerCandidate: 'ASK_INFORMATION', confidence: 0.9,
      policyDecision: 'CONTINUE_AUTONOMOUSLY', packetValid: true,
    })
    expect(r.conflict).toBe(false)
    expect(r.conflictReason).toBeNull()
    // Not silence: a later reader must be able to tell "they spoke about
    // different things" from "they never differed".
    expect(r.decidedBy).toBe('POLICY_CROSS_AXIS')
    // POLICY still wins the decision itself.
    expect(r.finalDecision).toBe('CONTINUE_AUTONOMOUSLY')
  })

  it('the predicate and the flag never disagree, across every branch', () => {
    const cases = [
      { readerCandidate: 'COMPLETE', confidence: 0.9, policyDecision: 'COMPLETE', packetValid: true },
      { readerCandidate: 'COMPLETE', confidence: 0.1, policyDecision: 'COMPLETE', packetValid: true },
      { readerCandidate: 'WAIT_EXTERNAL', confidence: 0.9, policyDecision: 'CONTINUE_AUTONOMOUSLY', packetValid: true },
      { readerCandidate: 'ASK_INFORMATION', confidence: 0.9, policyDecision: 'CONTINUE_AUTONOMOUSLY', packetValid: false },
      { readerCandidate: 'COMPLETE', confidence: 0.9, policyDecision: 'COMPLETE', packetValid: true, hardGateRefusal: 'kill switch' },
    ] as const
    for (const c of cases) {
      const r = arbitrate(c as never)
      expect(packetIsContradictory({ conflictReason: r.conflictReason, decidedBy: r.decidedBy }))
        .toBe(r.conflict)
    }
  })

  it('the old predicate was wrong for exactly one branch -- and this names it', () => {
    const invalid = arbitrate({
      readerCandidate: 'ASK_INFORMATION', confidence: 0.9,
      policyDecision: 'CONTINUE_AUTONOMOUSLY', packetValid: false,
    })
    // What every consumer used to compute:
    const oldPredicate = invalid.conflictReason !== null
    expect(oldPredicate).toBe(true)
    // What is true:
    expect(invalid.conflict).toBe(false)
  })
})

// THE SPLIT MUST NOT OPEN A DOOR.
//
// Excluding invalid packets from "contradiction" would, on its own, let 15 live
// cases through Invariant E -- cases with NO valid reading at all, which is
// worse than a disagreement, not better. So the single check became two and
// both still refuse. This is the test that says the refusal survived.
describe('E3: correcting the label does not loosen the gate', () => {
  it('an invalid packet still stops a non-read-only action, under a true name', async () => {
    const { initDatabase, getDb } = await import('../db.js')
    const { initProgressionSchema } = await import('../cos/schema.js')
    const { createCase } = await import('../cos/case-store.js')
    const { gatherRequiredInputs, invariantE } = await import('../cos/decision-confidence.js')
    initDatabase(':memory:'); initProgressionSchema(getDb())
    const db = getDb()
    const NOW = 1_700_000_000
    createCase(db, { caseId: 'inv1', title: 'T', caseType: 'ADMIN' }, NOW)
    db.prepare(
      `INSERT INTO case_evidence_packets
         (packet_id, domain, case_id, created_at, packet_json, plan_json, confidence,
          policy_result, conflict_reason, decided_by)
       VALUES ('p1', 'personal', 'inv1', ?, '{}', '{}', 0.9, 'CONTINUE_AUTONOMOUSLY',
               'packet failed validation; no reader input considered', 'INVALID_PACKET')`,
    ).run(NOW)

    const requiredInputs = gatherRequiredInputs(
      db, 'personal', 'inv1', { verdict: 'PROCEED', degradations: 0 } as never, NOW)
    const inputs = Object.fromEntries(requiredInputs.map(f => [f.input, f.status]))
    // The label is now true...
    expect(inputs.evidence_non_conflicting).toBe('PASS')
    expect(inputs.reader_evidence_valid).toBe('FAIL')
    // ...and the door is still shut.
    const verdict = invariantE({ requiredInputs, sideEffect: 'IRREVERSIBLE_EXTERNAL' } as never)
    expect(verdict.allowed).toBe(false)
    expect(verdict.code).toBe('invariant_e_unresolved_contradiction')
    // Read-only work continues, exactly as the owner's carve-out says.
    expect(invariantE({ requiredInputs, sideEffect: 'READ_ONLY' } as never).allowed).not.toBe(false)
  })
})
