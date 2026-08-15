import { describe, it, expect } from 'vitest'
import { isUsableRecommendation, expiredAskPrefix } from '../cos/owner-question.js'

/**
 * Three rules Istvan asked for on 2026-08-16, after reading a question the
 * system sent him and one I wrote by hand about the same case. The difference
 * was not more information — it was the same three elements in another order:
 * what changed since the question was framed, what each answer leads to, and
 * what the system could not check itself.
 */

const NOW = 1_760_000_000

describe('(1) a recommendation must be fit to read', () => {
  it('rejects the exact live string that prompted this', () => {
    // Measured on the store: one of the two questions carrying a recommendation.
    expect(isUsableRecommendation('Check for external response or escalate if overdue')).toBe(false)
  })

  it('rejects a raw enum leaking through', () => {
    expect(isUsableRecommendation('RECOVERY_REQUIRED')).toBe(false)
    expect(isUsableRecommendation('WAIT_EXTERNAL')).toBe(false)
  })

  it('rejects a stub too short to mean anything', () => {
    expect(isUsableRecommendation('ok')).toBe(false)
    expect(isUsableRecommendation('')).toBe(false)
    expect(isUsableRecommendation(null)).toBe(false)
  })

  // POSITIVE CONTROL, and the one that matters most: a gate that rejects
  // everything would pass every test above while silencing the feature.
  it('ACCEPTS a real Hungarian recommendation', () => {
    expect(isUsableRecommendation('Kérj új szállítási időpontot a boltnál, mert a csomag visszament.')).toBe(true)
    expect(isUsableRecommendation('Zárjuk le, mert a szerződés megújult az emelt díjjal.')).toBe(true)
  })

  it('accepts a Hungarian sentence written WITHOUT accents', () => {
    // The test is "does it look machine-internal", not "does it look Hungarian".
    // An accent-free Hungarian sentence is still a Hungarian sentence.
    expect(isUsableRecommendation('Zarjuk le az ugyet, mert a csomagot atvette.')).toBe(true)
  })
})

describe('(2) after the deadline the question changes', () => {
  it('names the elapsed time and BOTH branches', () => {
    const p = expiredAskPrefix({ at: NOW - 6 * 86_400, kind: 'due' }, NOW)!
    expect(p).toContain('6 NAPJA ELMÚLT')
    expect(p).toContain('megtörtént, vagy elmaradt')
    // The branches must lead somewhere different — that is the whole point.
    expect(p).toContain('lezárom')
    expect(p).toContain('új teendő')
  })

  it('says nothing while the deadline is still ahead', () => {
    // Positive control: a prefix that always fires would make every question
    // read as overdue.
    expect(expiredAskPrefix({ at: NOW + 86_400, kind: 'due' }, NOW)).toBeNull()
    expect(expiredAskPrefix(null, NOW)).toBeNull()
  })

  it('rounds up rather than saying "0 napja"', () => {
    expect(expiredAskPrefix({ at: NOW - 3600, kind: 'due' }, NOW)).toContain('1 NAPJA')
  })
})

// ── The rules where they are USED, not just their ingredients ─────────────
//
// Today's own lesson, twice over: a test that asserts a helper's return value
// proves nothing about whether the composer consults it. These drive
// buildOwnerQuestion and read the text Istvan would receive.

import { buildOwnerQuestion } from '../cos/owner-question.js'
import type { ReaderEvidencePacket } from '../cos/reader.js'
import type { EvidencePlan } from '../cos/evidence-planner.js'

const PACKET = {
  caseId: 'w1', domain: 'personal',
  readSources: ['email:1'], unreadableSources: [],
  facts: [{ statement: 'A csomag 08-05-en megerkezett az automatába.', sourceRef: 'email:1' }],
  missingRequirements: [{ what: 'a csomag átvétele a 408352241 nyitókóddal', whoHasIt: 'István', why: 'enélkül nem halad' }],
  ballHolder: 'ISTVAN', candidateDecision: 'REQUEST_DECISION', confidence: 0.85,
  uncertainty: ['Nem ismert, hogy István már átvette-e a csomagot.', 'A státusz WAITING_EXTERNAL.'],
} as unknown as ReaderEvidencePacket

const PLAN = {
  steps: [{ step: 1, label: 'átvétel', kind: 'ASK_OWNER', evidenceRefs: ['email:1'], needsExternal: false, blockedBy: 'István' }],
  nextBestAction: null, rationale: 'teszt',
} as unknown as EvidencePlan

const NOW2 = 1_760_000_000

describe('the composed question obeys all three rules', () => {
  it('(1) an unusable recommendation is DROPPED — with its options', () => {
    const q = buildOwnerQuestion({
      caseId: 'w1', domain: 'personal', title: 'Waterpik szájzuhany', packet: PACKET, plan: PLAN, now: NOW2,
      pkg: {
        handled: [], stoppedBecause: 'a másik félre várunk',
        recommendation: 'Check for external response or escalate if overdue',
        options: ['„igen" — csináljam így', '„nem" — ne ezt csináljam'],
        deadline: null,
      } as never,
    })!
    expect(q.text).not.toContain('Javaslatom')
    // The options must go with it: "yes" to nothing is a recorded non-answer.
    expect(q.text).not.toContain('csináljam így')
  })

  it('(1) a usable recommendation is KEPT — positive control', () => {
    const q = buildOwnerQuestion({
      caseId: 'w1', domain: 'personal', title: 'Waterpik szájzuhany', packet: PACKET, plan: PLAN, now: NOW2,
      pkg: {
        handled: [], stoppedBecause: 'a másik félre várunk',
        recommendation: 'Kérdezd meg a boltot, visszament-e a csomag.',
        options: ['„igen" — csináljam így'], deadline: null,
      } as never,
    })!
    expect(q.text).toContain('Javaslatom: Kérdezd meg a boltot')
    expect(q.text).toContain('csináljam így')
  })

  it('(2) an expired deadline reframes the ask, in the question body', () => {
    const q = buildOwnerQuestion({
      caseId: 'w1', domain: 'personal', title: 'Waterpik szájzuhany', packet: PACKET, plan: PLAN, now: NOW2,
      pkg: { handled: [], stoppedBecause: null, recommendation: null, options: [],
             deadline: { at: NOW2 - 6 * 86_400, kind: 'due' } } as never,
    })!
    expect(q.text).toContain('A HATÁRIDŐ 6 NAPJA ELMÚLT')
    expect(q.text).toContain('megtörtént, vagy elmaradt')
    // ...and the original ask is still visible: he may still want to do it.
    expect(q.text).toContain('408352241')
  })

  it('(2) a future deadline leaves the ask alone — positive control', () => {
    const q = buildOwnerQuestion({
      caseId: 'w1', domain: 'personal', title: 'Waterpik szájzuhany', packet: PACKET, plan: PLAN, now: NOW2,
      pkg: { handled: [], stoppedBecause: null, recommendation: null, options: [],
             deadline: { at: NOW2 + 2 * 86_400, kind: 'due' } } as never,
    })!
    expect(q.text).not.toContain('ELMÚLT')
  })

  it('(3) the first uncertainty is IN THE BODY, not filed as a caveat', () => {
    const q = buildOwnerQuestion({
      caseId: 'w1', domain: 'personal', title: 'Waterpik szájzuhany', packet: PACKET, plan: PLAN, now: NOW2,
    })!
    expect(q.text).toContain('Amit magamtól nem tudok eldönteni: Nem ismert, hogy István már átvette-e')
    // The SECOND one stays where it was — the body carries the real question,
    // not the whole list.
    expect(q.text).toContain('Bizonytalanság: A státusz WAITING_EXTERNAL.')
  })
})

describe('the three rules do not disturb the ASK identity', () => {
  const base = { caseId: 'w1', domain: 'personal', title: 'Waterpik szájzuhany', packet: PACKET, plan: PLAN, now: NOW2 }

  it('the expired prefix does NOT change the hash — it counts days, and would re-ask daily', () => {
    const before = buildOwnerQuestion({ ...base,
      pkg: { handled: [], stoppedBecause: null, recommendation: null, options: [],
             deadline: { at: NOW2 + 86_400, kind: 'due' } } as never })!
    const after = buildOwnerQuestion({ ...base,
      pkg: { handled: [], stoppedBecause: null, recommendation: null, options: [],
             deadline: { at: NOW2 - 6 * 86_400, kind: 'due' } } as never })!
    // The text MUST differ — otherwise this test proves nothing about rule (2).
    expect(after.text).not.toEqual(before.text)
    expect(after.text).toContain('ELMÚLT')
    expect(after.hash).toEqual(before.hash)
  })

  it('and one more elapsed day does not make it a new question either', () => {
    const day6 = buildOwnerQuestion({ ...base,
      pkg: { handled: [], stoppedBecause: null, recommendation: null, options: [],
             deadline: { at: NOW2 - 6 * 86_400, kind: 'due' } } as never })!
    const day7 = buildOwnerQuestion({ ...base, now: NOW2 + 86_400,
      pkg: { handled: [], stoppedBecause: null, recommendation: null, options: [],
             deadline: { at: NOW2 - 6 * 86_400, kind: 'due' } } as never })!
    expect(day7.text).toContain('7 NAPJA ELMÚLT')
    expect(day7.hash).toEqual(day6.hash)
  })

  it('dropping an unusable recommendation does not change the hash either', () => {
    const dropped = buildOwnerQuestion({ ...base,
      pkg: { handled: [], stoppedBecause: null, recommendation: 'Check for external response or escalate if overdue',
             options: ['„igen"'], deadline: null } as never })!
    const none = buildOwnerQuestion({ ...base,
      pkg: { handled: [], stoppedBecause: null, recommendation: null, options: [], deadline: null } as never })!
    expect(dropped.hash).toEqual(none.hash)
  })

  it('POSITIVE CONTROL: a changed ASK still changes the hash', () => {
    const other = buildOwnerQuestion({ ...base, packet: { ...PACKET,
      missingRequirements: [{ what: 'valami egeszen mas', whoHasIt: 'István', why: 'mert' }],
    } as unknown as ReaderEvidencePacket })!
    const orig = buildOwnerQuestion(base)!
    expect(other.hash).not.toEqual(orig.hash)
  })
})
