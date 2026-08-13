// §15.4 / §15.5 / §16 / §26(20, 22, 23): the preparation planner, the draft
// quality gate, and the PreparedInitiative artifact.
//
// The §16 artifact is the point of the whole release, and the spec says why: it
// is what makes measurable "what Marveen noticed, why he judged it important,
// what he resolved by himself, what he prepared, and when and why he would
// interrupt István." Five questions, all answerable from one stored row.
//
// The draft gate is the sharpest edge in v1.4. A draft is not an external side
// effect — it is ONE APPROVAL away from being one. So its default is not
// approval-ready, and its named negative fixture (V4-F12) is a relative-time
// claim computed from the wrong timestamp: a failure that is invisible in
// review, because "7 days have passed" reads exactly as well when the true
// answer is 2.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  planPreparation, draftQualityGate, buildPreparedInitiative,
  ensurePreparationSchema, storePreparedInitiative, readPreparedInitiative,
  MIN_PLAN_STEPS, MAX_PLAN_STEPS,
  type DraftForGate, type InternalPreparationPlan,
} from '../cos/proactive/preparation.js'
import type { InternalPreparationClass, ProactiveInitiative } from '../cos/proactive/types.js'

const T0 = 1_700_000_000
const DAY = 86400

function initiative(over: Partial<ProactiveInitiative> = {}): ProactiveInitiative {
  return {
    initiativeId: 'pini-1',
    domain: 'personal',
    signalIds: ['psig-1'],
    initiativeType: 'DEADLINE',
    materiality: 'HIGH',
    urgency: 'MEDIUM',
    caseId: 'c1',
    desiredOutcome: {
      outcomeType: 'DECISION',
      targetState: 'A felmondasrol dontes szuletett',
      completionEvidence: ['a dontes rogzitve a case-en'],
    },
    currentGap: 'nincs dontes a felmondasrol',
    decisionDeadline: T0 + 30 * DAY,
    internalSafeDeadline: T0 + 29 * DAY,
    allowedPreparationClasses: [
      'READ_CONTEXT', 'RESOLVE_MISSING_INFORMATION', 'CHECK_DEADLINE',
      'ORGANIZE_EVIDENCE', 'PREPARE_DECISION_PACKAGE',
    ],
    unresolvedRequirements: ['a felmondasi ido pontos hossza'],
    userInterruptionRequired: false,
    state: 'QUALIFIED',
    confidence: 0.8,
    ...over,
  }
}

describe('§15.4 the preparation plan', () => {
  it('HEADLINE: 3–7 steps, and the bounds are real', () => {
    const r = planPreparation(initiative(), T0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.steps.length).toBeGreaterThanOrEqual(MIN_PLAN_STEPS)
    expect(r.plan.steps.length).toBeLessThanOrEqual(MAX_PLAN_STEPS)
  })

  it('HEADLINE: the steps are case-specific, not a type template', () => {
    // §15.4's second sentence. A plan that is the same for every DEADLINE
    // initiative tells the reader nothing they did not already know from the
    // word DEADLINE.
    const a = planPreparation(initiative(), T0)
    const b = planPreparation(initiative({
      initiativeId: 'pini-2',
      currentGap: 'hianyzik a szamla masolata',
      unresolvedRequirements: ['a szamlaszam'],
    }), T0)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.plan.steps.map(s => s.label)).not.toEqual(b.plan.steps.map(s => s.label))
    // ...and the gap is actually named in the plan, not paraphrased away.
    expect(JSON.stringify(a.plan.steps)).toContain('nincs dontes a felmondasrol')
  })

  it('names each unresolved requirement as its own step', () => {
    // So the plan says WHAT is missing rather than that something is.
    const r = planPreparation(initiative({
      unresolvedRequirements: ['a felmondasi ido', 'a szerzodes szama'],
    }), T0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const resolves = r.plan.steps.filter(s => s.stepClass === 'RESOLVE_MISSING_INFORMATION')
    expect(resolves).toHaveLength(2)
    expect(resolves[0].requires).toEqual(['a felmondasi ido'])
  })

  it('HEADLINE: it never plans a class the Initiative was not granted', () => {
    // Promotion already decided what THIS initiative may do. Widening it here
    // would route around that decision.
    const r = planPreparation(initiative({
      allowedPreparationClasses: ['READ_CONTEXT', 'ORGANIZE_EVIDENCE', 'PREPARE_DECISION_PACKAGE'],
      unresolvedRequirements: ['x'],
    }), T0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.steps.map(s => s.stepClass)).not.toContain('RESOLVE_MISSING_INFORMATION')
    expect(r.plan.steps.map(s => s.stepClass)).not.toContain('CHECK_DEADLINE')
  })

  it('refuses when the granted classes cannot produce enough steps', () => {
    const r = planPreparation(initiative({ allowedPreparationClasses: ['READ_CONTEXT'] }), T0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.join(' ')).toMatch(/§15\.4/)
  })

  it('states a stop condition — an internal loop with no stated end runs until the bill', () => {
    const r = planPreparation(initiative(), T0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.stopCondition).toContain(String(T0 + 29 * DAY))
  })

  it('names the user boundary only when there IS one', () => {
    const quiet = planPreparation(initiative(), T0)
    const loud = planPreparation(initiative({ userInterruptionRequired: true }), T0)
    expect(quiet.ok && loud.ok).toBe(true)
    if (!quiet.ok || !loud.ok) return
    expect(quiet.plan.userBoundary).toBeUndefined()
    expect(loud.plan.userBoundary).toContain('István')
  })
})

describe('§15.5 the draft factual-quality gate', () => {
  function draft(over: Partial<DraftForGate> = {}): DraftForGate {
    return {
      recipient: 'ugyved@pelda.hu',
      threadRef: 'thread-1',
      contextTarget: 'case:c1',
      factualClaims: [{ statement: 'A szerzodes 2026-09-01-jen jar le.', sourceRef: 'doc-1' }],
      derivations: [],
      staleOrConflictingEvidence: [],
      ...over,
    }
  }

  it('a complete, cited draft is approval-ready', () => {
    expect(draftQualityGate(draft(), T0).verdict).toBe('APPROVAL_READY')
  })

  it('HEADLINE: V4-F12 — "N days have passed" computed from the wrong timestamp is refused', () => {
    // The fixture, exactly as written: the outreach is 7 days old, the follow-up
    // due timestamp is 2 days old. A draft claiming "2 days have passed" while
    // citing the outreach as its source is the failure, and it is invisible in
    // review because the sentence reads perfectly.
    const outreach = T0 - 7 * DAY
    const wrong = draftQualityGate(draft({
      factualClaims: [{ statement: '2 napja nem erkezett valasz a megkeresesre.', sourceRef: 'msg-1' }],
      derivations: [{
        claim: '2 napja nem erkezett valasz', sourceTimestamp: outreach, sourceRef: 'msg-1',
        computedValue: 2, unit: 'days',
      }],
    }), T0)
    expect(wrong.verdict).toBe('NOT_APPROVAL_READY')
    expect(wrong.reasons.join(' ')).toMatch(/V4-F12/)

    // The same draft with N=7 — derived from the actual source event — passes.
    const right = draftQualityGate(draft({
      factualClaims: [{ statement: '7 napja nem erkezett valasz a megkeresesre.', sourceRef: 'msg-1' }],
      derivations: [{
        claim: '7 napja nem erkezett valasz', sourceTimestamp: outreach, sourceRef: 'msg-1',
        computedValue: 7, unit: 'days',
      }],
    }), T0)
    expect(right.verdict).toBe('APPROVAL_READY')
  })

  it('HEADLINE: a computed claim with NO derivation at all is refused', () => {
    // The failure the check above cannot see: somebody writes "7 days" into the
    // prose and nobody records where the 7 came from, after which there is
    // nothing to verify.
    const r = draftQualityGate(draft({
      factualClaims: [{ statement: '7 napja varunk valaszra.', sourceRef: 'msg-1' }],
      derivations: [],
    }), T0)
    expect(r.verdict).toBe('NOT_APPROVAL_READY')
    expect(r.reasons.join(' ')).toMatch(/levezetés nélkül/)
  })

  it('stale or conflicting evidence is NOT_APPROVAL_READY, not a warning label', () => {
    const r = draftQualityGate(draft({ staleOrConflictingEvidence: ['doc-1 elavult'] }), T0)
    expect(r.verdict).toBe('NOT_APPROVAL_READY')
  })

  it('an uncited factual claim is refused', () => {
    const r = draftQualityGate(draft({
      factualClaims: [{ statement: 'Valami tortent.', sourceRef: '' }],
    }), T0)
    expect(r.verdict).toBe('NOT_APPROVAL_READY')
  })

  it('recipient, thread and context target are each required by name', () => {
    for (const missing of ['recipient', 'threadRef', 'contextTarget'] as const) {
      const r = draftQualityGate(draft({ [missing]: '' }), T0)
      expect(r.verdict).toBe('NOT_APPROVAL_READY')
    }
  })

  it('the default is refusal — an empty draft is not approval-ready', () => {
    const r = draftQualityGate({
      factualClaims: [], derivations: [], staleOrConflictingEvidence: [],
    }, T0)
    expect(r.verdict).toBe('NOT_APPROVAL_READY')
    expect(r.reasons.length).toBeGreaterThanOrEqual(4)
  })
})

describe('§16 the PreparedInitiative artifact', () => {
  beforeEach(() => { initDatabase(':memory:'); ensurePreparationSchema(getDb()) })

  function artifact(over: Partial<ProactiveInitiative> = {}) {
    const ini = initiative(over)
    const p = planPreparation(ini, T0)
    if (!p.ok) throw new Error(p.reasons.join('; '))
    return buildPreparedInitiative(
      ini, p.plan,
      {
        evidenceResolved: ['doc-1', 'doc-2'],
        remainingUnknowns: ['a felmondasi ido pontos hossza'],
        riskAssessment: 'Kozepes: a hatarido elmulasztasa automatikus hosszabbitas.',
      },
      ['materiality:above_threshold', 'promotion:qualified'],
      0.8, T0,
    )
  }

  it('HEADLINE: the five §16 questions are answerable from the row alone', () => {
    const a = artifact()
    expect(a.signalRefs).toEqual(['psig-1'])                       // what he noticed
    expect(a.qualification.reasonCodes.length).toBeGreaterThan(0)  // why it mattered
    expect(a.evidenceResolved).toHaveLength(2)                     // what he resolved
    expect(a.preparedActions.length).toBeGreaterThanOrEqual(3)     // what he prepared
    expect(a.interruptionPriority).toBeDefined()                   // when he would interrupt
  })

  it('HEADLINE: remaining unknowns are carried, so "what he resolved" has a denominator', () => {
    // Without them, a preparation that resolved one of nine looks identical to
    // one that resolved nine of nine.
    const a = artifact()
    expect(a.remainingUnknowns).toHaveLength(1)
    expect(a.blockedBy).toBe('a felmondasi ido pontos hossza')
  })

  it('interruption priority is present even when the answer is NONE', () => {
    // "When and why would he interrupt" is a question about the cases where the
    // answer is never, too.
    expect(artifact().interruptionPriority).toBe('NONE')
    expect(artifact({ userInterruptionRequired: true, urgency: 'CRITICAL' }).interruptionPriority).toBe('HIGH')
    expect(artifact({ userInterruptionRequired: true, urgency: 'LOW' }).interruptionPriority).toBe('LOW')
  })

  it('stores and reads back identically, with a digest', () => {
    const a = artifact()
    const r = storePreparedInitiative(getDb(), a, T0)
    expect(r.ok).toBe(true)
    expect(readPreparedInitiative(getDb(), a.initiativeId)).toEqual(a)
  })

  it('the digest changes when the artifact does', () => {
    // §1.4.3 adjudicates against a frozen corpus; an artifact that changed after
    // being adjudicated would rewrite the evidence the gate was measured on.
    const a = artifact()
    const first = storePreparedInitiative(getDb(), a, T0)
    const second = storePreparedInitiative(getDb(), { ...a, riskAssessment: 'Magas.' }, T0 + 10)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.digest).not.toBe(first.digest)
  })

  it('HEADLINE: storing refuses a prepared action outside §15.1', () => {
    // A second door into the same room. §15.3(5) is about aliases arriving
    // anywhere, so the check is at every door rather than only at the first.
    const a = artifact()
    const r = storePreparedInitiative(getDb(), {
      ...a,
      preparedActions: [
        ...a.preparedActions,
        { stepClass: 'BROWSER_NAVIGATE' as unknown as InternalPreparationClass, label: 'x', requires: [] },
      ],
    }, T0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/BROWSER_NAVIGATE/)
  })

  it('is replayable without any UI — everything needed is in the JSON', () => {
    const a = artifact()
    storePreparedInitiative(getDb(), a, T0)
    const raw = getDb().prepare(`SELECT artifact_json FROM prepared_initiatives`).get() as { artifact_json: string }
    const parsed = JSON.parse(raw.artifact_json) as Record<string, unknown>
    for (const field of ['signalRefs', 'qualification', 'desiredOutcome', 'currentGap',
      'evidenceResolved', 'remainingUnknowns', 'riskAssessment', 'preparedActions',
      'userDecisionRequired', 'interruptionPriority', 'confidence']) {
      expect(parsed[field]).toBeDefined()
    }
  })
})
