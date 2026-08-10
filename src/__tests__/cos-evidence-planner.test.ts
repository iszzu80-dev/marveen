// §12 + §4.2 — the plan derived from evidence.
//
// THE NUMBER THIS EXISTS TO MOVE, measured on the live store beforehand: 101
// cases, 100 distinct goals (0.99) and 10 distinct plans (0.10), 7 distinct next
// actions (0.07). Every case knew what it was about; none knew what to do next.
//
// So the tests are about SPECIFICITY, not about the code running. A plan that
// runs and says "Execute the next action in the work plan" for every case is
// exactly the state being replaced.
import { describe, it, expect } from 'vitest'
import { planFromEvidence, measurePlanQuality } from '../cos/evidence-planner.js'
import type { ReaderEvidencePacket } from '../cos/reader.js'

function packet(over: Partial<ReaderEvidencePacket> = {}): ReaderEvidencePacket {
  return {
    caseId: 'c1', domain: 'personal',
    readSources: ['doc-1'], unreadableSources: [],
    facts: [{ statement: 'A szállító 236 EUR-s ajánlatot küldött.', sourceRef: 'doc-1' }],
    missingRequirements: [],
    ballHolder: 'MARVEEN', candidateDecision: 'CONTINUE_AUTONOMOUSLY',
    confidence: 0.8, uncertainty: [], ...over,
  }
}

describe('§12 plan from evidence', () => {
  it('HEADLINE: two different cases get two different plans', () => {
    // The whole point. Under the template they were identical.
    const a = planFromEvidence(packet({
      missingRequirements: [{ what: 'Panos útlevélszáma', whoHasIt: 'PANOS', why: 'az átruházási okirathoz kell' }],
      ballHolder: 'EXTERNAL',
    }))
    const b = planFromEvidence(packet({
      missingRequirements: [{ what: 'a medence vegyszer-mérés eredménye', whoHasIt: 'ISTVAN', why: 'a dózis ettől függ' }],
      ballHolder: 'ISTVAN',
    }))
    expect(a.steps[0].label).not.toBe(b.steps[0].label)
    expect(a.steps[0].label).toContain('útlevélszáma')
    expect(b.steps[0].label).toContain('vegyszer-mérés')
  })

  it('three missing pieces produce a three-part plan that NAMES all three', () => {
    const p = planFromEvidence(packet({
      missingRequirements: [
        { what: 'IBAN', whoHasIt: 'PANOS', why: 'utaláshoz' },
        { what: 'aláírt szerződés', whoHasIt: 'UGYVED', why: 'a bejegyzéshez' },
        { what: 'Istvan jóváhagyása', whoHasIt: 'ISTVAN', why: 'összeghatár fölött' },
      ],
    }))
    const labels = p.steps.map(s => s.label).join(' ')
    expect(labels).toContain('IBAN')
    expect(labels).toContain('aláírt szerződés')
    expect(labels).toContain('Istvan jóváhagyása')
  })

  it('§4.2 plan_step_evidence_linkage: every step cites evidence', () => {
    const p = planFromEvidence(packet({
      missingRequirements: [{ what: 'IBAN', whoHasIt: 'PANOS', why: 'utaláshoz' }],
    }))
    for (const s of p.steps) expect(s.evidenceRefs.length).toBeGreaterThan(0)
  })

  it('a step needing someone else is NOT autonomous', () => {
    const p = planFromEvidence(packet({
      missingRequirements: [{ what: 'IBAN', whoHasIt: 'PANOS', why: 'utaláshoz' }],
    }))
    expect(p.nextBestAction?.canProceedAutonomously).toBe(false)
  })

  it('LOW CONFIDENCE removes autonomy even when the step itself is unblocked', () => {
    // §13.1's fail-safe: low confidence must not produce an external effect.
    const sure = planFromEvidence(packet({ confidence: 0.9 }))
    const unsure = planFromEvidence(packet({ confidence: 0.2 }))
    expect(sure.nextBestAction?.canProceedAutonomously).toBe(true)
    expect(unsure.nextBestAction?.canProceedAutonomously).toBe(false)
  })

  it('a packet with nothing to go on SAYS SO instead of inventing a step', () => {
    const p = planFromEvidence(packet({
      ballHolder: 'UNKNOWN', candidateDecision: 'RECOVERY_REQUIRED', missingRequirements: [],
    }))
    expect(p.steps).toHaveLength(1)
    expect(p.steps[0].blockedBy).toBe('INSUFFICIENT_EVIDENCE')
    expect(p.nextBestAction?.canProceedAutonomously).toBe(false)
  })

  it('§4.2 metrics: the measurement itself distinguishes specific from template', () => {
    // A metric that cannot tell the two apart would let the old behaviour pass.
    const specific = [
      planFromEvidence(packet({ missingRequirements: [{ what: 'A', whoHasIt: 'X', why: 'a' }] })),
      planFromEvidence(packet({ missingRequirements: [{ what: 'B', whoHasIt: 'Y', why: 'b' }] })),
      planFromEvidence(packet({ missingRequirements: [{ what: 'C', whoHasIt: 'Z', why: 'c' }] })),
    ]
    const templated = [packet(), packet(), packet()].map(planFromEvidence)

    const s = measurePlanQuality(specific)
    const t = measurePlanQuality(templated)
    expect(s.distinctValueRatio).toBe(1)
    expect(t.distinctValueRatio).toBeLessThan(0.5) // three identical packets → one plan
    expect(s.planStepEvidenceLinkage).toBe(1)
  })
})
