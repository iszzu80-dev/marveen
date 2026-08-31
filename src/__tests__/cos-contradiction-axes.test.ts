import { describe, it, expect, beforeEach } from 'vitest'
import { axisConflicts, isAxisContradiction, contradictionBlocksAction, claimsOf } from '../cos/contradiction-axes.js'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import { gatherRequiredInputs, invariantE } from '../cos/decision-confidence.js'

// E3, the owner's ruling of 2026-08-31, as executable statements.
//
//   "CONTRADICTION csak akkor áll fenn, ha két bizonyíték ugyanarról a konkrét
//    következő actionről, ugyanazon döntési dimenzióban, ugyanazon időhorizontra
//    egymással inkompatibilis állítást tesz."
//
// And the sentence that keeps it honest: NO RELEVANT CONTRADICTION != ALLOW.

const NOW = 1_700_000_000

function packetRow(caseId: string, rc: string | null, pr: string, decidedBy: string, reason: string | null): void {
  const db = getDb()
  createCase(db, { caseId, title: caseId, caseType: 'ADMIN' }, NOW)
  db.prepare(
    `INSERT INTO case_evidence_packets
       (packet_id, domain, case_id, created_at, packet_json, plan_json, confidence,
        reader_candidate, policy_result, conflict_reason, decided_by)
     VALUES (?, 'personal', ?, ?, '{}', '{}', 0.9, ?, ?, ?, ?)`,
  ).run(`pk-${caseId}`, caseId, NOW, rc, pr, reason, decidedBy)
}
const inputsFor = (caseId: string) =>
  gatherRequiredInputs(getDb(), 'personal', caseId, { verdict: 'PROCEED', degradations: 0 } as never, NOW)

describe('E3: same axis, or it is not a contradiction', () => {
  it('HUMAN_DEPENDENCY vs ENGINE_EXECUTION is not a contradiction', () => {
    // The owner's own example: "az ügynek kell emberi válasz, de a motor addig
    // tud biztonságos belső munkát végezni".
    expect(isAxisContradiction('ASK_INFORMATION', 'CONTINUE_AUTONOMOUSLY')).toBe(false)
    expect(isAxisContradiction('REQUEST_DECISION', 'CONTINUE_AUTONOMOUSLY')).toBe(false)
    expect(isAxisContradiction('MANUAL_ACTION_REQUIRED', 'CONTINUE_AUTONOMOUSLY')).toBe(false)
    expect(isAxisContradiction('CALL_REQUIRED', 'CONTINUE_AUTONOMOUSLY')).toBe(false)
  })

  it('TERMINALITY vs TERMINALITY is -- the CLOSE-versus-DoD dispute stays', () => {
    // The owner required these seven live cases to remain blocking.
    const c = axisConflicts('COMPLETE', 'CONTINUE_AUTONOMOUSLY')
    expect(c).toHaveLength(1)
    expect(c[0]!.axis).toBe('TERMINALITY')
  })

  it('ENGINE_EXECUTION vs ENGINE_EXECUTION is -- waiting is not continuing', () => {
    for (const r of ['WAIT_EXTERNAL', 'WAIT_TIME', 'RECOVERY_REQUIRED']) {
      const c = axisConflicts(r, 'CONTINUE_AUTONOMOUSLY')
      expect(c.map(x => x.axis)).toContain('ENGINE_EXECUTION')
    }
  })

  it('silence is not disagreement, and an unknown decision claims nothing', () => {
    expect(claimsOf('SOMETHING_NEW')).toEqual({})
    expect(isAxisContradiction('SOMETHING_NEW', 'CONTINUE_AUTONOMOUSLY')).toBe(false)
    expect(isAxisContradiction(null, 'CONTINUE_AUTONOMOUSLY')).toBe(false)
    expect(isAxisContradiction('COMPLETE', 'COMPLETE')).toBe(false)
  })
})

describe('E3: the gate', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('MUTATION GUARD: a real action-relevant contradiction still stops an external act', () => {
    packetRow('same-axis', 'COMPLETE', 'CONTINUE_AUTONOMOUSLY', 'POLICY',
      'reader proposed COMPLETE, deterministic policy decided CONTINUE_AUTONOMOUSLY')
    const inputs = inputsFor('same-axis')
    expect(Object.fromEntries(inputs.map(f => [f.input, f.status])).evidence_non_conflicting).toBe('FAIL')
    const v = invariantE({ requiredInputs: inputs, sideEffect: 'IRREVERSIBLE_EXTERNAL' } as never)
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('invariant_e_unresolved_contradiction')
  })

  it('NEGATIVE CONTROL: a cross-axis difference does not stop internal progression', () => {
    packetRow('cross-axis', 'ASK_INFORMATION', 'CONTINUE_AUTONOMOUSLY', 'POLICY',
      'reader proposed ASK_INFORMATION, deterministic policy decided CONTINUE_AUTONOMOUSLY')
    const inputs = inputsFor('cross-axis')
    const byInput = Object.fromEntries(inputs.map(f => [f.input, f.status]))
    expect(byInput.evidence_non_conflicting).toBe('PASS')
    // Internal work is not vetoed by this...
    expect(invariantE({ requiredInputs: inputs, sideEffect: 'INTERNAL' } as never).allowed).not.toBe(false)
    // ...and neither is a read.
    expect(invariantE({ requiredInputs: inputs, sideEffect: 'READ_ONLY' } as never).allowed).not.toBe(false)
  })

  it('the OLD stored prose does not resurrect a contradiction the ruling removed', () => {
    // The row was written before 2026-08-31 and still carries the old sentence.
    // The axis model decides from the two candidates it actually holds.
    packetRow('legacy', 'ASK_INFORMATION', 'CONTINUE_AUTONOMOUSLY', 'POLICY',
      'reader proposed ASK_INFORMATION, deterministic policy decided CONTINUE_AUTONOMOUSLY')
    const s = Object.fromEntries(inputsFor('legacy').map(f => [f.input, f.status]))
    expect(s.evidence_non_conflicting).toBe('PASS')
  })

  it('invalid evidence is still not a contradiction, and still fails closed', () => {
    packetRow('invalid', null, 'CONTINUE_AUTONOMOUSLY', 'INVALID_PACKET',
      'packet failed validation; no reader input considered')
    const inputs = inputsFor('invalid')
    const s = Object.fromEntries(inputs.map(f => [f.input, f.status]))
    expect(s.evidence_non_conflicting).toBe('PASS')
    expect(s.reader_evidence_valid).toBe('FAIL')
    expect(invariantE({ requiredInputs: inputs, sideEffect: 'IRREVERSIBLE_EXTERNAL' } as never).allowed).toBe(false)
  })

  it('NO RELEVANT CONTRADICTION is not ALLOW -- only this one veto is absent', () => {
    // The helper answers exactly one question and never "may this go out".
    expect(contradictionBlocksAction([], 'IRREVERSIBLE_EXTERNAL')).toBe(false)
    const real = axisConflicts('COMPLETE', 'CONTINUE_AUTONOMOUSLY')
    expect(contradictionBlocksAction(real, 'IRREVERSIBLE_EXTERNAL')).toBe(true)
    expect(contradictionBlocksAction(real, 'READ_ONLY')).toBe(false)
  })
})

describe('E3: the axis test must not erase vetoes it was never about', () => {
  beforeEach(() => { initDatabase(':memory:'); initProgressionSchema(getDb()) })

  it('a CONFIDENCE-floor refusal survives -- reader and policy AGREED there', () => {
    // Rung 3 is only reached when the two agree, so an axis test finds nothing
    // conflicting and would have let four live cases through. Found by
    // measuring the population, not by reading the diff.
    packetRow('conf', 'COMPLETE', 'COMPLETE', 'CONFIDENCE', 'confidence 0.55 below the 0.7 floor for COMPLETE')
    const inputs = inputsFor('conf')
    expect(Object.fromEntries(inputs.map(f => [f.input, f.status])).evidence_non_conflicting).toBe('FAIL')
    expect(invariantE({ requiredInputs: inputs, sideEffect: 'IRREVERSIBLE_EXTERNAL' } as never).allowed).toBe(false)
  })

  it('a HARD_GATE refusal survives too', () => {
    packetRow('hard', 'COMPLETE', 'RECOVERY_REQUIRED', 'HARD_GATE', 'hard gate closed: kill switch engaged')
    const inputs = inputsFor('hard')
    expect(Object.fromEntries(inputs.map(f => [f.input, f.status])).evidence_non_conflicting).toBe('FAIL')
  })
})
