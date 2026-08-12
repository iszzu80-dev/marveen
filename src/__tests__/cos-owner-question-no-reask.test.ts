import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { askPendingOwnerQuestions, outstandingOwnerQuestions, recordOwnerAnswer } from '../cos/owner-question.js'

// 2026-08-11, measured live. Istvan answered five owner questions in one message.
// Twenty minutes later two of them came straight back — same case, same ask,
// nothing changed in between — and the question rows showed answered_at = NULL,
// because the re-ask UPSERT had wiped the answer on its way in.
//
// Getting an answer must not be what makes the question reappear.

const NOW = 1_700_000_000

function seed(caseId: string, ask: string, at = NOW) {
  createCase(getDb(), { caseId, title: `T ${caseId}`, caseType: 'ADMIN', status: 'NEW' }, at)
  getDb().prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`,
  ).run(caseId, at, at)
  packet(caseId, ask, at)
}

function packet(caseId: string, ask: string, at: number) {
  const p = {
    ballHolder: 'ISTVAN',
    facts: [{ statement: 'tény', source: 'email' }],
    missingRequirements: [{ what: ask, whoHasIt: 'ISTVAN', why: null }],
    uncertainty: [], confidence: 0.7,
  }
  const plan = { steps: [{ kind: 'ASK_OWNER', label: ask, blockedBy: 'ISTVAN' }] }
  getDb().prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(p), JSON.stringify(plan), at)
}

const openFor = (caseId: string) =>
  outstandingOwnerQuestions(getDb(), 50).filter(q => q.caseId === caseId)

describe('an answered question does not come back on its own', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('stays closed when nothing about the case has changed', () => {
    seed('c1', 'kell-e a kártya')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10 })
    expect(openFor('c1')).toHaveLength(1)

    recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Rendben, megoldottam.', now: NOW + 20 })
    expect(openFor('c1')).toHaveLength(0)

    // A later sweep, same packet, same ask, case untouched.
    askPendingOwnerQuestions(getDb(), { now: NOW + 1000 })
    expect(openFor('c1'), 'answering must not be what brings the question back').toHaveLength(0)
  })

  it('the recorded ANSWER survives a later sweep', () => {
    // The old UPSERT reset answered_at/answer_text on re-ask, so the store lost
    // the fact that he had replied at all.
    seed('c1', 'kell-e a kártya')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10 })
    recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Rendben, megoldottam.', now: NOW + 20 })
    askPendingOwnerQuestions(getDb(), { now: NOW + 1000 })

    const row = getDb().prepare(
      `SELECT answered_at, answer_text FROM cos_owner_questions WHERE case_id='c1'`,
    ).get() as { answered_at: number | null; answer_text: string | null }
    expect(row.answered_at).toBe(NOW + 20)
    expect(row.answer_text).toContain('megoldottam')
  })

  it('DOES ask again once the case actually moves on', () => {
    // The counter-check. Suppression must be tied to "nothing changed", not to
    // "was ever answered" — otherwise a case that genuinely reopens goes silent.
    seed('c1', 'kell-e a kártya')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10 })
    recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Rendben.', now: NOW + 20 })

    getDb().prepare(`UPDATE personal_cases SET updated_at=? WHERE case_id='c1'`).run(NOW + 500)

    // MOVING ON IS NOT ENOUGH BY ITSELF -- the case must be RE-READ first.
    // Sharpened 2026-08-11: this test originally expected the bare updated_at
    // bump to re-ask, and it did, from the ORIGINAL packet. Then the
    // stale-reading guard landed and correctly refused: a reading older than the
    // case does not describe the case. The two rules together are stricter and
    // righter than either alone -- move, re-read, THEN ask -- so the test now
    // asserts that sequence instead of the shortcut.
    askPendingOwnerQuestions(getDb(), { now: NOW + 600 })
    expect(openFor('c1'), 'a moved case with a STALE reading must not be asked yet').toHaveLength(0)

    packet('c1', 'kell-e a kártya', NOW + 550)   // friss olvasat a mozgas utan
    askPendingOwnerQuestions(getDb(), { now: NOW + 700 })
    expect(openFor('c1'), 'once re-read, the question may go out again').toHaveLength(1)
  })
})

describe('a finished case has no open question', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('does not ask about a COMPLETED case', () => {
    seed('c-done', 'mit tegyünk')
    getDb().prepare(`UPDATE personal_cases SET status='COMPLETED' WHERE case_id='c-done'`).run()
    askPendingOwnerQuestions(getDb(), { now: NOW + 10 })
    expect(openFor('c-done'),
      'a rental that is settled must not keep asking about itself').toHaveLength(0)
  })

  it('still asks about an ordinary open case', () => {
    seed('c-open', 'mit tegyünk')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10 })
    expect(openFor('c-open')).toHaveLength(1)
  })
})
