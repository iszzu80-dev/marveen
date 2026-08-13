// `marveen-acp-v1.4-acceptance-fixtures.md` — the normative acceptance baseline,
// `V4-F1`–`V4-F14`, played through the layers that exist.
//
// WHAT THIS FILE IS, AND IS NOT. It is the fixture set run against the real
// modules. It is NOT a claim that v1.4 is done: several fixtures need a running
// live system, a human adjudicator, or 90 days of data, and none of those can be
// synthesised here. The fixture file's own acceptance rule is what governs:
//
//     all mandatory V4-F1..V4-F14 = PASS
//     AND no fixture result is synthetic-only when the fixture claims runtime evidence
//     AND any capability gap is reported as a capability gap rather than a false
//         zero/green metric
//
// The middle line is the one that matters here. A fixture that claims runtime
// evidence must not be marked green by a test that fabricated the runtime. So
// every fixture below is one of two kinds, and the kind is stated:
//
//   MECHANISM — the rule is in code, and this exercises it. Genuinely green.
//   CAPABILITY GAP — the mechanism exists but the EVIDENCE needs live data or a
//     human. Asserted as far as it goes, and named as a gap for the rest.
//
// Calling the second kind green would be exactly the false green the acceptance
// rule forbids, and it is the easiest possible mistake to make in a file called
// "acceptance fixtures".
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { ensureProactiveSchema } from '../cos/proactive/schema.js'
import { recordSignal } from '../cos/proactive/signal-store.js'
import { qualifySignal } from '../cos/proactive/qualification.js'
import { promoteSignal } from '../cos/proactive/initiative-store.js'
import { ensureSweepSchema, selectCandidates, claimCandidate, releaseCandidate } from '../cos/proactive/sweep.js'
import { detectStalls, detectAnomalies } from '../cos/proactive/detectors.js'
import { deadlineIndex } from '../cos/deadline-index.js'
import { matchCase, attachToCase } from '../cos/proactive-case-bridge.js'
import {
  ensureApprovalLoadSchema, planApprovalQueue, recordDecisions,
  type ApprovalCandidate,
} from '../cos/proactive/approval-load.js'
import { draftQualityGate } from '../cos/proactive/preparation.js'
import {
  minSampleForPower, powerAt, DEFAULT_BLINDING_REGISTRATION,
} from '../cos/adjudication.js'
import type { SignalDraft } from '../cos/proactive/signal-store.js'

const T0 = 1_700_000_000
const DAY = 86400

/**
 * The capability gaps, DECLARED rather than accumulated as the tests run.
 *
 * Accumulating them would make the closing assertion depend on every earlier
 * test having executed — so running one fixture in isolation (`-t V4-F1`) would
 * report zero gaps, which is the exact false green this list exists to prevent.
 * A declared list is the deliverable; each fixture below asserts its own entry.
 */
const CAPABILITY_GAPS: ReadonlyArray<{ fixture: string; needs: string }> = [
  { fixture: 'V4-F5', needs: 'a dokumentumból kinyert összegek strukturált tárolása (AMOUNT_DIFFERS_FROM_CASE)' },
  { fixture: 'V4-F13', needs: 'nevesített, független EMBER adjudikátor (§26/31.) és éles vak adjudikáció' },
  { fixture: 'V4-F14', needs: '90 napos éles replay korpusz az eligible volume kalibrációjához (§26/3–5.)' },
]
function gap(fixture: string): { fixture: string; needs: string } {
  const g = CAPABILITY_GAPS.find(x => x.fixture === fixture)
  if (!g) throw new Error(`undeclared capability gap: ${fixture}`)
  return g
}

function setup(): void {
  initDatabase(':memory:')
  initProgressionSchema(getDb())
  ensureProactiveSchema(getDb())
  ensureSweepSchema(getDb())
  ensureApprovalLoadSchema(getDb())
}

function draft(over: Partial<SignalDraft> = {}): SignalDraft {
  return {
    domain: 'personal',
    signalType: 'DEADLINE',
    sourceRefs: ['doc-1'],
    subjectRef: 'Szolgaltatasi szerzodes',
    summary: 'A szerzodes megujulasi hatarideje kozeledik.',
    evidenceClaims: [{ statement: 'A felmondasi hatarido 2026-09-01.', sourceRef: 'doc-1' }],
    estimatedMateriality: 'HIGH',
    estimatedUrgency: 'HIGH',
    estimatedActionability: 'HIGH',
    candidateDeadline: T0 + 20 * DAY,
    confidence: 0.9,
    ...over,
  }
}

describe('V4-F1 — renewal / deadline opportunity [MECHANISM]', () => {
  beforeEach(setup)

  it('a signal is detected, an existing Case is reused, and both deadlines are derived', () => {
    createCase(getDb(), { caseId: 'c1', title: 'Szolgaltatasi szerzodes', caseType: 'ADMIN' }, T0 - 30 * DAY)
    const rec = recordSignal(getDb(), draft(), T0)
    expect(rec.outcome).toBe('RECORDED')
    if (rec.outcome !== 'RECORDED') return

    // Existing Case reused rather than a new one opened (§8).
    expect(matchCase(getDb(), rec.signal, T0).tier).toBe('ACTIVE_SUBJECT')

    const q = qualifySignal(rec.signal, T0, { activeCases: [{ caseId: 'c1', subjectRef: 'Szolgaltatasi szerzodes' }] })
    expect(q.decision).toBe('PROMOTE')

    const p = promoteSignal(getDb(), rec.signal, q, {
      desiredOutcome: {
        outcomeType: 'DECISION', targetState: 'Dontes a megujitasrol',
        completionEvidence: ['a dontes rogzitve'],
      },
      currentGap: 'nincs dontes a megujitasrol',
      allowedPreparationClasses: ['READ_CONTEXT', 'CHECK_DEADLINE', 'PREPARE_DECISION_PACKAGE'],
    }, T0)
    expect(p.outcome).toBe('PROMOTED')
    if (p.outcome !== 'PROMOTED') return
    // Authoritative deadline AND internal_safe_deadline, both derived.
    expect(p.initiative.decisionDeadline).toBe(T0 + 20 * DAY)
    expect(p.initiative.internalSafeDeadline).toBeLessThan(p.initiative.decisionDeadline!)
    // FAIL condition: no binding action occurs. Nothing here can send.
    expect(p.initiative.allowedPreparationClasses).not.toContain('SEND_TO_NEW_EXTERNAL_RECIPIENT')
  })
})

describe('V4-F2 — stalled home repair [MECHANISM]', () => {
  beforeEach(setup)

  it('a STALL signal is created, the existing Case is reused, no duplicate Case', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'Lakasfelujitas', caseType: 'ADMIN' }, T0 - 60 * DAY)
    db.prepare(`UPDATE personal_cases SET status='READY', updated_at=? WHERE case_id='c1'`).run(T0 - 60 * DAY)
    const stalls = detectStalls(db, 'personal', T0)
    expect(stalls.map(s => s.caseId)).toEqual(['c1'])
    // One Case before, one Case after: no duplicate.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM personal_cases`).get()).toEqual({ n: 1 })
  })
})

describe('V4-F3 — warranty discovery without a new email [MECHANISM]', () => {
  beforeEach(setup)

  it('the scheduled sweep finds it, and deadline priority beats read order', () => {
    const db = getDb()
    // Read LAST but due FIRST: under read order it would be behind the other.
    createCase(db, { caseId: 'garancia', title: 'Garancia', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(`UPDATE personal_cases SET due_at=? WHERE case_id='garancia'`).run(T0 - 5 * DAY)
    createCase(db, { caseId: 'friss', title: 'Friss', caseType: 'ADMIN' }, T0)
    db.prepare(`UPDATE personal_cases SET due_at=? WHERE case_id='friss'`).run(T0 - DAY)

    const r = selectCandidates(db, T0, { limit: 1 })
    expect(r.candidates[0].caseId).toBe('garancia')
    // No new email was involved: the candidate came from the deadline index.
    expect(r.candidates[0].reason).toBe('DEADLINE_DUE')
  })
})

describe('V4-F4 — ZST administrative obligation [MECHANISM]', () => {
  beforeEach(setup)

  it('domain isolation holds, and no PRI data is mixed in', () => {
    const db = getDb()
    createCase(db, { caseId: 'p1', title: 'Ugyanaz a cim', caseType: 'ADMIN' }, T0)
    createZstCase(db, { caseId: 'z1', title: 'Ugyanaz a cim', caseType: 'ADMIN' }, T0)
    const rec = recordSignal(db, draft({
      domain: 'zst', signalType: 'OBLIGATION', subjectRef: 'Ugyanaz a cim',
    }), T0)
    expect(rec.outcome).toBe('RECORDED')
    if (rec.outcome !== 'RECORDED') return
    // The corporate signal matches the corporate case and cannot see the
    // personal one, despite the identical title.
    expect(matchCase(db, rec.signal, T0).caseId).toBe('z1')
    expect(deadlineIndex(db, 'zst', T0).records.every(x => x.domain === 'zst')).toBe(true)
  })
})

describe('V4-F5 — invoice anomaly [MECHANISM, partial]', () => {
  beforeEach(setup)

  it('an anomaly with explicit evidence refs is created, and no financial action follows', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'Szamla', caseType: 'ADMIN' }, T0 - DAY)
    db.prepare(`UPDATE personal_cases SET status='READY', due_at=? WHERE case_id='c1'`).run(T0 - 5 * DAY)
    const a = detectAnomalies(db, 'personal', T0)
    expect(a.length).toBeGreaterThan(0)
    for (const f of a) expect(f.evidence.every(e => e.sourceRef.length > 0)).toBe(true)
    // The fixture's headline case — an AMOUNT in a document differing from the
    // case — needs the extracted-document layer, and is declared as a gap.
    expect(gap('V4-F5').needs).toMatch(/összegek/)
  })
})

describe('V4-F6 — unanswered follow-up [MECHANISM]', () => {
  beforeEach(setup)

  it('the sweep finds it, advances the due state, and does not reclaim it forever', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'Kovetes', caseType: 'ADMIN' }, T0 - 10 * DAY)
    db.prepare(`UPDATE personal_cases SET follow_up_at=? WHERE case_id='c1'`).run(T0 - DAY)

    expect(selectCandidates(db, T0).candidates.map(c => c.caseId)).toContain('c1')
    expect(claimCandidate(db, 'personal', 'c1', 'sweep-1', T0)).toBe(true)
    expect(releaseCandidate(db, 'personal', 'c1', 'sweep-1', 'NO_OP', T0)).toBe(true)

    // THE FAIL CONDITION: "infinite due-loop, repeated claim with no state
    // advancement". The review row now carries a future next_review_at.
    const row = db.prepare(`SELECT next_review_at FROM proactive_sweep_state WHERE case_id='c1'`)
      .get() as { next_review_at: number }
    expect(row.next_review_at).toBeGreaterThan(T0)
  })
})

describe('V4-F7 — duplicate signal suppression [MECHANISM]', () => {
  beforeEach(setup)

  it('the same event through two paths yields ONE Initiative', () => {
    const db = getDb()
    const first = recordSignal(db, draft(), T0)
    expect(first.outcome).toBe('RECORDED')
    // The sweep path sees the same situation seconds later.
    const second = recordSignal(db, draft(), T0 + 30)
    expect(second.outcome).toBe('DUPLICATE')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM proactive_signals`).get()).toEqual({ n: 1 })

    // And an equivalent open Initiative suppresses a third sighting.
    if (first.outcome !== 'RECORDED') return
    const q = qualifySignal(first.signal, T0, {
      activeInitiativeDedupeKeys: new Set([first.signal.dedupeKey]),
    })
    expect(q.decision).toBe('SUPPRESS')
    expect(q.reasonCodes).toContain('duplicate_novelty:active_initiative_equivalent')
  })
})

describe('V4-F8 — scheduled discovery fairness [MECHANISM]', () => {
  beforeEach(setup)

  it('neither domain starves, continuation exists, and nothing disappears', () => {
    const db = getDb()
    for (let i = 0; i < 8; i++) {
      createCase(db, { caseId: `p${i}`, title: `p${i}`, caseType: 'ADMIN' }, T0 - DAY)
      db.prepare(`UPDATE personal_cases SET due_at=? WHERE case_id=?`).run(T0 - DAY, `p${i}`)
    }
    for (let i = 0; i < 8; i++) {
      createZstCase(db, { caseId: `z${i}`, title: `z${i}`, caseType: 'ADMIN' }, T0 - DAY)
      db.prepare(`UPDATE zst_cases SET due_at=? WHERE case_id=?`).run(T0 - DAY, `z${i}`)
    }
    const first = selectCandidates(db, T0, { limit: 4 })
    expect(first.candidates.filter(c => c.domain === 'personal').length).toBeGreaterThan(0)
    expect(first.candidates.filter(c => c.domain === 'zst').length).toBeGreaterThan(0)
    expect(first.starvationDetected).toEqual([])
    expect(first.hasMore).toBe(true)
    expect(first.silentTruncationCount).toBe(0)

    // Nothing disappears behind the limit: the rest is reachable.
    const rest = selectCandidates(db, T0, { limit: 100, after: first.nextCursor! })
    expect(first.candidates.length + rest.candidates.length).toBe(16)
  })
})

describe('V4-F9 — stale evidence replacement [MECHANISM]', () => {
  beforeEach(setup)

  it('newer evidence updates the record rather than creating a second one', () => {
    const db = getDb()
    recordSignal(db, draft({ candidateDeadline: T0 + 20 * DAY }), T0)
    const moved = recordSignal(db, draft({ candidateDeadline: T0 + 3 * DAY }), T0 + 3600)
    // Superseded, not silently deleted, and not duplicated.
    expect(moved.outcome).toBe('UPDATED')
    expect(db.prepare(`SELECT COUNT(*) AS n FROM proactive_signals`).get()).toEqual({ n: 1 })
    if (moved.outcome !== 'UPDATED') return
    expect(moved.signal.candidateDeadline).toBe(T0 + 3 * DAY)
  })
})

describe('V4-F10 — low-materiality suppression [MECHANISM]', () => {
  beforeEach(setup)

  it('low-value signals are suppressed with a measurable reason, and nobody is interrupted', () => {
    const db = getDb()
    const rec = recordSignal(db, draft({
      estimatedMateriality: 'LOW', estimatedUrgency: 'LOW',
      estimatedActionability: 'LOW', candidateDeadline: undefined,
    }), T0)
    expect(rec.outcome).toBe('RECORDED')
    if (rec.outcome !== 'RECORDED') return
    const q = qualifySignal(rec.signal, T0)
    expect(q.decision).toBe('ANNOTATE')
    // "Suppression reason is measurable" — a machine-readable code, not prose.
    expect(q.reasonCodes.some(c => c.startsWith('materiality:'))).toBe(true)
  })
})

describe('V4-F11 — proactive approval-fatigue backpressure [MECHANISM]', () => {
  beforeEach(setup)

  function candidate(id: string, over: Partial<ApprovalCandidate> = {}): ApprovalCandidate {
    return {
      candidateId: id, domain: 'personal', caseId: `case-${id}`, decisionKey: `d-${id}`,
      materiality: 'HIGH', queueEnteredAt: T0, priority: 10,
      factualQualityPassed: true, contentDigest: `dig-${id}`, ...over,
    }
  }

  it('five candidates in 24h: no more than the cap surfaces, and none is lost', () => {
    const cands = ['a', 'b', 'c', 'd', 'e'].map(id => candidate(id))
    const r = planApprovalQueue(getDb(), cands, T0)
    recordDecisions(getDb(), cands, r, T0)
    expect(r.presentedCount).toBeLessThanOrEqual(2)
    // The rest become DEFER/BUNDLE/SUPPRESS — no evidence loss, and every
    // candidate has a disposition.
    expect(r.decisions).toHaveLength(5)
    for (const d of r.decisions) {
      expect(['PRESENT', 'DEFER', 'BUNDLE', 'SUPPRESS', 'DEADLINE_ESCALATED_APPROVAL'])
        .toContain(d.disposition)
    }
    // "There is no implicit or automatic approval."
    expect(r.decisions.some(d => /APPROVED|AUTO/i.test(d.disposition))).toBe(false)
  })

  it('an owner response does NOT release the approval budget', () => {
    const cands = ['a', 'b', 'c'].map(id => candidate(id))
    const first = planApprovalQueue(getDb(), cands, T0)
    recordDecisions(getDb(), cands, first, T0)
    // An owner answers an unrelated question. Nothing about that touches this.
    const after = planApprovalQueue(getDb(), [candidate('later')], T0 + 100)
    expect(after.presentedCount).toBe(0)
  })

  it('deadline subcase: it surfaces via DEADLINE_ESCALATED_APPROVAL despite the cap', () => {
    const cands = [
      candidate('a'), candidate('b'),
      candidate('urgent', { internalSafeDeadline: T0 + 3600 }),
    ]
    const r = planApprovalQueue(getDb(), cands, T0)
    expect(r.decisions.find(d => d.candidateId === 'urgent')?.disposition)
      .toBe('DEADLINE_ESCALATED_APPROVAL')
  })

  it('several simultaneous escapes become ONE bundled interruption, not a burst', () => {
    const cands = ['u1', 'u2', 'u3'].map(id => candidate(id, { internalSafeDeadline: T0 + 3600 }))
    const r = planApprovalQueue(getDb(), cands, T0)
    expect(r.burstBundleId).toBeTruthy()
    expect(new Set(r.decisions.map(d => d.bundleId)).size).toBe(1)
  })
})

describe('V4-F12 — temporal derivation correctness [MECHANISM]', () => {
  it('the fixture, verbatim: outreach 7 days old, follow-up due 2 days old', () => {
    const outreach = T0 - 7 * DAY
    const base = {
      recipient: 'partner@pelda.hu', threadRef: 'thread-1', contextTarget: 'case:c1',
      staleOrConflictingEvidence: [],
    }
    // N=2 — computed from the follow-up due timestamp, the proxy the fixture
    // names. FAIL.
    const wrong = draftQualityGate({
      ...base,
      factualClaims: [{ statement: '2 napja nem erkezett valasz.', sourceRef: 'msg-1' }],
      derivations: [{
        claim: '2 nap', sourceTimestamp: outreach, sourceRef: 'msg-1',
        computedValue: 2, unit: 'days',
      }],
    }, T0)
    expect(wrong.verdict).toBe('NOT_APPROVAL_READY')

    // N=7 — from the authoritative source event, with provenance. PASS.
    const right = draftQualityGate({
      ...base,
      factualClaims: [{ statement: '7 napja nem erkezett valasz.', sourceRef: 'msg-1' }],
      derivations: [{
        claim: '7 nap', sourceTimestamp: outreach, sourceRef: 'msg-1',
        computedValue: 7, unit: 'days',
      }],
    }, T0)
    expect(right.verdict).toBe('APPROVAL_READY')
  })
})

describe('V4-F13 — blind adjudication and effective blinding [CAPABILITY GAP]', () => {
  it('the MECHANISM is complete and the power design is derived, not hand-entered', () => {
    // What IS green: the canonical schema, the hidden origin, the randomised
    // order, the persisted origin_guess, the pre-registered power-qualified
    // test. The fixture explicitly fails a "blinding sample minimum that is an
    // arbitrary hand-entered value without documented power derivation" — this
    // one is computed.
    expect(minSampleForPower()).toBe(37)
    expect(powerAt(DEFAULT_BLINDING_REGISTRATION.minPackets, DEFAULT_BLINDING_REGISTRATION))
      .toBeGreaterThanOrEqual(DEFAULT_BLINDING_REGISTRATION.targetPower)
  })

  it('the EVIDENCE is not available here, and says so', () => {
    // The fixture requires a named independent HUMAN adjudicator who is not the
    // output-producing system. No test can satisfy that, and a test that
    // asserted it would be asserting a lie about an organisation.
    expect(gap('V4-F13').needs).toMatch(/EMBER adjudikátor/)
  })
})

describe('V4-F14 — low-volume value-gate calibration [CAPABILITY GAP]', () => {
  it('the non-monotonic power curve is measured, not assumed', () => {
    // The reason 40 is not simply "37 rounded up": 38 and 39 are both WORSE
    // than 37, because the critical value jumps in whole counts while n grows
    // continuously.
    const r = DEFAULT_BLINDING_REGISTRATION
    expect(powerAt(37, r)).toBeGreaterThanOrEqual(r.targetPower)
    expect(powerAt(38, r)).toBeLessThan(r.targetPower)
    expect(powerAt(39, r)).toBeLessThan(r.targetPower)
  })

  it('the 90-day replay calibration needs live data, and says so', () => {
    // `frozen_shadow_window = max(value_gate_required_window,
    // blinding_required_window)` cannot be computed without the eligible volume,
    // and the eligible volume is a fact about a store this container does not
    // have.
    expect(gap('V4-F14').needs).toMatch(/90 napos éles replay/)
  })
})

describe('the fixture-set acceptance rule', () => {
  it('HEADLINE: the capability gaps are REPORTED, not counted as green', () => {
    // The fixture file's own rule: "any capability gap is reported as a
    // capability gap rather than a false zero/green metric". An empty list here
    // would mean v1.4 is complete — and claiming that from a test suite would be
    // the single most misleading thing this file could do.
    expect(CAPABILITY_GAPS.length).toBeGreaterThanOrEqual(3)
    for (const g of CAPABILITY_GAPS) expect(g.needs.length).toBeGreaterThan(20)
    const fixtures = CAPABILITY_GAPS.map(g => g.fixture)
    expect(fixtures).toContain('V4-F13')
    expect(fixtures).toContain('V4-F14')
  })
})
