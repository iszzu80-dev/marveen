// v1.4 Proactive Core — the signal → qualification → Initiative path.
//
// The three properties that carry the weight here, none of them about wording:
//
//   1. §4.1 — a signal exists only on evidence, and only on evidence it declared.
//   2. §7.2 — the same situation never appears twice, AND a situation whose facts
//      moved is never swallowed as a repeat. Those pull against each other, and
//      satisfying only one of them is the easy mistake.
//   3. §6 — the verdict is deterministic. Not a style preference: §1.4.3 measures
//      incremental value by blind adjudication over a frozen corpus, and a policy
//      whose answer drifts between the shadow run and the replay makes that
//      comparison mean nothing.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { ensureProactiveSchema } from '../cos/proactive/schema.js'
import {
  recordSignal, signalRefusal, readSignal, setSignalStatus,
  deriveDedupeKey, deriveNoveltyKey, type SignalDraft,
} from '../cos/proactive/signal-store.js'
import {
  qualifySignal, mayCreateNewCase, QUALIFICATION_STAGES, DEFAULT_QUALIFICATION_POLICY,
} from '../cos/proactive/qualification.js'
import {
  promoteSignal, recordQualification, readInitiative, activeInitiativeDedupeKeys,
  desiredOutcomeRefusal, DEFAULT_PREPARATION_LEAD_SEC,
} from '../cos/proactive/initiative-store.js'
import type { ProactiveSignal } from '../cos/proactive/types.js'

const T0 = 1_700_000_000
const DAY = 86400

function draft(over: Partial<SignalDraft> = {}): SignalDraft {
  return {
    domain: 'personal',
    signalType: 'DEADLINE',
    sourceRefs: ['doc-1'],
    subjectRef: 'berleti-szerzodes',
    summary: 'A berleti szerzodes felmondasi hatarideje kozeledik.',
    evidenceClaims: [{ statement: 'A felmondasi hatarido 2026-09-01.', sourceRef: 'doc-1' }],
    estimatedMateriality: 'HIGH',
    estimatedUrgency: 'MEDIUM',
    estimatedActionability: 'HIGH',
    candidateDeadline: T0 + 30 * DAY,
    confidence: 0.85,
    ...over,
  }
}

function recorded(over: Partial<SignalDraft> = {}, now = T0): ProactiveSignal {
  const r = recordSignal(getDb(), draft(over), now)
  if (r.outcome !== 'RECORDED' && r.outcome !== 'UPDATED') {
    throw new Error(`expected a stored signal, got ${JSON.stringify(r)}`)
  }
  return r.signal
}

const OUTCOME = {
  outcomeType: 'DECISION',
  targetState: 'A felmondasrol szuletett dontes',
  completionEvidence: ['a dontes rogzitve a case-en'],
}

describe('§4.1 a signal exists only on evidence', () => {
  beforeEach(() => { initDatabase(':memory:'); ensureProactiveSchema(getDb()) })

  it('HEADLINE: refuses a claim citing a source the signal never declared', () => {
    // The half that matters. Requiring "a citation" is easy to satisfy by
    // inventing one alongside the claim; requiring the citation to be among the
    // sources the signal actually declared is what makes it evidence. The
    // Reader's packet validation applies the same rule to facts, and this is
    // that rule, one layer out.
    const r = recordSignal(getDb(), draft({
      sourceRefs: ['doc-1'],
      evidenceClaims: [{ statement: 'Allitas.', sourceRef: 'doc-99' }],
    }), T0)
    expect(r.outcome).toBe('REFUSED')
    if (r.outcome === 'REFUSED') expect(r.reason).toMatch(/doc-99/)
  })

  it('refuses a signal with no source reference at all', () => {
    expect(recordSignal(getDb(), draft({ sourceRefs: [] }), T0).outcome).toBe('REFUSED')
    // Whitespace is not a source. A caller with nothing reaches for the empty
    // string as readily as for the empty array.
    expect(recordSignal(getDb(), draft({ sourceRefs: ['   '] }), T0).outcome).toBe('REFUSED')
  })

  it('refuses a signal with no evidence claim — a model-only guess is not a signal', () => {
    expect(recordSignal(getDb(), draft({ evidenceClaims: [] }), T0).outcome).toBe('REFUSED')
  })

  it('refuses a deadline that is not epoch seconds', () => {
    // V4-F12's failure class, caught at the door: an ISO string or milliseconds
    // arriving in a column every other deadline reads as seconds.
    const r = recordSignal(getDb(), draft({ candidateDeadline: (T0 + DAY) * 1000 + 0.5 }), T0)
    expect(r.outcome).toBe('REFUSED')
  })

  it('signalRefusal is callable on its own, so a caller can check before building', () => {
    expect(signalRefusal(draft())).toBeNull()
    expect(signalRefusal(draft({ summary: '  ' }))).toMatch(/summary/)
  })
})

describe('§7 duplicate and novelty suppression', () => {
  beforeEach(() => { initDatabase(':memory:'); ensureProactiveSchema(getDb()) })

  it('HEADLINE: the same situation with the same facts is a duplicate, not a second row', () => {
    const first = recordSignal(getDb(), draft(), T0)
    expect(first.outcome).toBe('RECORDED')
    const second = recordSignal(getDb(), draft(), T0 + 3600)
    expect(second.outcome).toBe('DUPLICATE')
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM proactive_signals`).get()).toEqual({ n: 1 })
  })

  it('HEADLINE: the same situation with MOVED facts updates — it is not swallowed', () => {
    // The other half of §7.2, and the one a naive dedupe loses. A deadline that
    // has been brought forward is the same situation and completely different
    // news; collapsing the two keys would report it as a repeat.
    recordSignal(getDb(), draft(), T0)
    const moved = recordSignal(getDb(), draft({ candidateDeadline: T0 + 3 * DAY }), T0 + 3600)
    expect(moved.outcome).toBe('UPDATED')
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM proactive_signals`).get()).toEqual({ n: 1 })
    expect(moved.outcome === 'UPDATED' && moved.signal.candidateDeadline).toBe(T0 + 3 * DAY)
  })

  it('a suppressed signal whose facts moved comes back to DETECTED', () => {
    const s = recorded()
    setSignalStatus(getDb(), s.signalId, 'SUPPRESSED', T0 + 10)
    recordSignal(getDb(), draft({ estimatedMateriality: 'CRITICAL' }), T0 + 20)
    expect(readSignal(getDb(), s.signalId)?.status).toBe('DETECTED')
  })

  it('the two domains do not suppress each other', () => {
    // §20.3. A globally unique dedupe key would let the personal side silence a
    // corporate signal it is not allowed to know exists.
    expect(recordSignal(getDb(), draft({ domain: 'personal' }), T0).outcome).toBe('RECORDED')
    expect(recordSignal(getDb(), draft({ domain: 'zst' }), T0).outcome).toBe('RECORDED')
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM proactive_signals`).get()).toEqual({ n: 2 })
  })

  it('the dedupe key ignores what the novelty key is for, and vice versa', () => {
    // Stated as a property rather than through the store, because this is the
    // separation the two invariants of §7.2 rest on.
    const a = draft()
    const b = draft({ candidateDeadline: T0 + 3 * DAY, estimatedUrgency: 'CRITICAL' })
    expect(deriveDedupeKey(b)).toBe(deriveDedupeKey(a))
    expect(deriveNoveltyKey(b)).not.toBe(deriveNoveltyKey(a))

    const other = draft({ subjectRef: 'masik-szerzodes' })
    expect(deriveDedupeKey(other)).not.toBe(deriveDedupeKey(a))
  })
})

describe('§6 the qualification policy is deterministic', () => {
  beforeEach(() => { initDatabase(':memory:'); ensureProactiveSchema(getDb()) })

  it('HEADLINE: the same signal qualifies the same way, every time', () => {
    const s = recorded()
    const a = qualifySignal(s, T0)
    const b = qualifySignal(s, T0)
    expect(b).toEqual(a)
  })

  it('the §6.1 stage order is fixed and complete', () => {
    expect([...QUALIFICATION_STAGES]).toEqual([
      'hard_gate', 'evidence_sufficiency', 'duplicate_novelty', 'materiality',
      'urgency_deadline', 'actionability', 'existing_case_relevance',
      'interruption_cost', 'promotion',
    ])
  })

  it('a hard deny is decided BEFORE the evidence is weighed', () => {
    // The order is the point. A denied signal must not have its content examined
    // at all — and the way to see that from the outside is that the verdict
    // carries the hard-gate code and nothing else.
    const s = recorded()
    const r = qualifySignal(s, T0, { hardDenyReason: 'PRI_HARD_DENY' })
    expect(r.decision).toBe('SUPPRESS')
    expect(r.reasonCodes).toEqual(['hard_gate:PRI_HARD_DENY'])
  })

  it('low confidence annotates rather than suppresses — the observation is kept', () => {
    const r = qualifySignal(recorded({ confidence: 0.2 }), T0)
    expect(r.decision).toBe('ANNOTATE')
    expect(r.reasonCodes).toContain('evidence_sufficiency:below_confidence_threshold')
  })

  it('V4-F10: a low-materiality signal is annotated, with a measurable reason', () => {
    const r = qualifySignal(recorded({ estimatedMateriality: 'LOW', candidateDeadline: undefined }), T0)
    expect(r.decision).toBe('ANNOTATE')
    expect(r.reasonCodes).toContain('materiality:below_threshold')
  })

  it('but an imminent deadline overrides a middling materiality', () => {
    // V4-F1 fails if a real deadline is dropped for looking unimportant. The
    // override is narrow and it names itself in the reason codes.
    const r = qualifySignal(recorded({ estimatedMateriality: 'LOW', candidateDeadline: T0 + DAY }), T0)
    expect(r.decision).toBe('PROMOTE')
    expect(r.reasonCodes).toContain('materiality:overridden_by_imminent_deadline')
  })

  it('§8.1: an informational signal never gets promoted', () => {
    const r = qualifySignal(recorded({ estimatedActionability: 'LOW' }), T0)
    expect(r.decision).toBe('ANNOTATE')
    expect(r.reasonCodes).toContain('actionability:informational_only')
  })

  it('V4-F7: an equivalent open Initiative suppresses the second sighting', () => {
    const s = recorded()
    const r = qualifySignal(s, T0, { activeInitiativeDedupeKeys: new Set([s.dedupeKey]) })
    expect(r.decision).toBe('SUPPRESS')
    expect(r.reasonCodes).toContain('duplicate_novelty:active_initiative_equivalent')
  })

  it('§8: an existing Case is matched BEFORE promotion, not after', () => {
    const s = recorded({ candidateCaseId: 'case-7' })
    const r = qualifySignal(s, T0, { activeCases: [{ caseId: 'case-7' }] })
    expect(r.matchedCaseId).toBe('case-7')
    expect(r.reasonCodes).toContain('existing_case_relevance:matched')
    // And with a match, a NEW Case is not warranted.
    expect(mayCreateNewCase(r)).toBe(false)
  })

  it('a named Case that is not active does not count as a match', () => {
    const r = qualifySignal(recorded({ candidateCaseId: 'case-closed' }), T0, { activeCases: [] })
    expect(r.matchedCaseId).toBeUndefined()
    expect(mayCreateNewCase(r)).toBe(true)
  })

  it('the interruption score is recorded but does not gate promotion', () => {
    // Two budgets, deliberately not merged: something worth preparing internally
    // is worth preparing whether or not it will ever be worth interrupting for.
    const r = qualifySignal(recorded({ estimatedUrgency: 'LOW', confidence: 0.6 }), T0)
    expect(r.decision).toBe('PROMOTE')
    expect(r.reasonCodes).toContain('interruption_cost:below_threshold')
    expect(r.interruptionScore).toBeLessThan(DEFAULT_QUALIFICATION_POLICY.interruptionThreshold)
  })
})

describe('§5.1 / §9 promotion', () => {
  beforeEach(() => { initDatabase(':memory:'); ensureProactiveSchema(getDb()) })

  function promote(over: Partial<Parameters<typeof promoteSignal>[3]> = {}, sig = recorded()) {
    return promoteSignal(getDb(), sig, qualifySignal(sig, T0), {
      desiredOutcome: OUTCOME,
      currentGap: 'nincs dontes a felmondasrol',
      allowedPreparationClasses: ['READ_CONTEXT', 'CHECK_DEADLINE'],
      ...over,
    }, T0)
  }

  it('HEADLINE: §9 — no Initiative without a desired outcome', () => {
    // "The Initiative must not stay in a 'let's have a look' state without an
    // outcome" is enforceable at exactly one place, and this is it.
    const noEvidence = promote({ desiredOutcome: { outcomeType: 'X', targetState: 'Y', completionEvidence: [] } })
    expect(noEvidence.outcome).toBe('REFUSED')
    if (noEvidence.outcome === 'REFUSED') expect(noEvidence.reason).toMatch(/bizonyíték/)
    expect(desiredOutcomeRefusal(undefined)).toMatch(/kötelező/)
  })

  it('refuses without a gap, and without any preparation class', () => {
    // One signal, two attempts — recording it twice would be a DUPLICATE, which
    // is the store behaving correctly and would look like a broken fixture.
    const s = recorded()
    expect(promote({ currentGap: '  ' }, s).outcome).toBe('REFUSED')
    expect(promote({ allowedPreparationClasses: [] }, s).outcome).toBe('REFUSED')
  })

  it('refuses a qualification that belongs to a different signal', () => {
    const a = recorded()
    const b = recorded({ subjectRef: 'masik' })
    const r = promoteSignal(getDb(), a, qualifySignal(b, T0), {
      desiredOutcome: OUTCOME, currentGap: 'gap', allowedPreparationClasses: ['READ_CONTEXT'],
    }, T0)
    expect(r.outcome).toBe('REFUSED')
  })

  it('refuses a verdict that was not PROMOTE', () => {
    const s = recorded({ estimatedActionability: 'LOW' })
    const r = promoteSignal(getDb(), s, qualifySignal(s, T0), {
      desiredOutcome: OUTCOME, currentGap: 'gap', allowedPreparationClasses: ['READ_CONTEXT'],
    }, T0)
    expect(r.outcome).toBe('REFUSED')
  })

  it('derives the internal safe deadline from the decision deadline, never after it', () => {
    const r = promote()
    expect(r.outcome).toBe('PROMOTED')
    if (r.outcome !== 'PROMOTED') return
    expect(r.initiative.decisionDeadline).toBe(T0 + 30 * DAY)
    expect(r.initiative.internalSafeDeadline).toBe(T0 + 30 * DAY - DEFAULT_PREPARATION_LEAD_SEC)
    expect(r.initiative.internalSafeDeadline!).toBeLessThan(r.initiative.decisionDeadline!)
  })

  it('a matched Case makes the Initiative LINKED_TO_CASE rather than free-standing', () => {
    const s = recorded({ candidateCaseId: 'case-7' })
    const q = qualifySignal(s, T0, { activeCases: [{ caseId: 'case-7' }] })
    const r = promoteSignal(getDb(), s, q, {
      desiredOutcome: OUTCOME, currentGap: 'gap', allowedPreparationClasses: ['READ_CONTEXT'],
    }, T0)
    expect(r.outcome).toBe('PROMOTED')
    if (r.outcome !== 'PROMOTED') return
    expect(r.initiative.state).toBe('LINKED_TO_CASE')
    expect(r.initiative.caseId).toBe('case-7')
    expect(readInitiative(getDb(), r.initiative.initiativeId)?.caseId).toBe('case-7')
  })

  it('an open Initiative feeds the §7.1 tier-4 check on the next sighting', () => {
    const s = recorded()
    promote({}, s)
    const keys = activeInitiativeDedupeKeys(getDb(), 'personal')
    expect(keys.has(s.dedupeKey)).toBe(true)
    // ...and the corporate side is unaffected by it.
    expect(activeInitiativeDedupeKeys(getDb(), 'zst').size).toBe(0)
  })
})

describe('§6.3 every verdict is written down, not only the promotions', () => {
  beforeEach(() => { initDatabase(':memory:'); ensureProactiveSchema(getDb()) })

  it('HEADLINE: a suppression is persisted with its reason codes', () => {
    // A policy that records only what it let through can be scored on precision
    // and never on recall — and a proactive layer that misses things quietly
    // looks exactly like one that had nothing to say.
    const s = recorded({ estimatedMateriality: 'LOW', candidateDeadline: undefined })
    const q = qualifySignal(s, T0)
    recordQualification(getDb(), 'personal', q, T0)
    const row = getDb().prepare(
      `SELECT decision, reason_codes_json FROM proactive_qualifications WHERE signal_id = ?`,
    ).get(s.signalId) as { decision: string; reason_codes_json: string }
    expect(row.decision).toBe('ANNOTATE')
    expect(JSON.parse(row.reason_codes_json)).toContain('materiality:below_threshold')
  })

  it('the scores are stored, so a later policy change cannot rewrite history', () => {
    // §1.4.3 adjudicates against a FROZEN corpus. A score recomputed at read
    // time would move when the thresholds are tuned, quietly re-writing the
    // record the value gate is being measured against.
    const s = recorded()
    recordQualification(getDb(), 'personal', qualifySignal(s, T0), T0)
    const row = getDb().prepare(
      `SELECT materiality_score, interruption_score FROM proactive_qualifications WHERE signal_id = ?`,
    ).get(s.signalId) as { materiality_score: number; interruption_score: number }
    expect(row.materiality_score).toBeGreaterThan(0)
    expect(row.interruption_score).toBeGreaterThan(0)
  })
})
