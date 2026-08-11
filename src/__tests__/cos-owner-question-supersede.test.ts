import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { askPendingOwnerQuestions, outstandingOwnerQuestions, recordOwnerAnswer } from '../cos/owner-question.js'
import { createCase } from '../cos/case-store.js'

// One case, one open question. Live on 2026-08-11 that did not hold: I improved
// the Valencia deposit question at 07:35, the vague 07:28 version ("Istvan
// döntése szükséges") stayed unanswered, and the result was ONE case holding TWO
// of the five ceiling slots while asking Istvan the same thing twice — once in a
// form he could not answer.
//
// The rewrite is keyed by a hash of the ASK, so a better wording does not
// collide with the worse one. That is correct for dedup and wrong for the pile.

const NOW = 1_700_000_000

function seedCase(caseId: string, title: string) {
  createCase(getDb(), { caseId, title, caseType: 'TRAVEL', status: 'NEW' }, NOW)
}

/** A packet+plan pair that produces an owner question with the given ask text. */
function seedPacket(caseId: string, askLabel: string, at: number) {
  const packet = {
    ballHolder: 'ISTVAN',
    facts: [{ statement: 'A DiscoverCars jelezte, hogy a Revolut nem jó.', source: 'email' }],
    missingRequirements: [{ what: askLabel, whoHasIt: 'ISTVAN', why: null }],
    uncertainty: [],
    confidence: 0.7,
  }
  const plan = { steps: [{ kind: 'ASK_OWNER', label: askLabel, blockedBy: 'ISTVAN' }] }
  getDb().prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(packet), JSON.stringify(plan), at)
}

const openFor = (caseId: string) =>
  outstandingOwnerQuestions(getDb(), 50).filter(q => q.caseId === caseId)

describe('a reworded question replaces the old one instead of joining it', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    seedCase('c-valencia', 'Valencia autóbérlés')
  })

  it('leaves exactly ONE open question for the case after a rewrite', () => {
    seedPacket('c-valencia', 'Istvan döntése szükséges', NOW + 10)
    askPendingOwnerQuestions(getDb(), { now: NOW + 20 })
    expect(openFor('c-valencia')).toHaveLength(1)

    // The improved wording — a different ask, therefore a different hash.
    seedPacket('c-valencia', 'megvan-e a kaucióhoz elfogadott hagyományos bankkártya', NOW + 30)
    askPendingOwnerQuestions(getDb(), { now: NOW + 40 })

    const open = openFor('c-valencia')
    expect(open, 'one case must not occupy two slots with two wordings of one question').toHaveLength(1)
    expect(open[0].text).toContain('hagyományos bankkártya')
  })

  it('marks the old row superseded, NOT answered — nobody answered it', () => {
    seedPacket('c-valencia', 'Istvan döntése szükséges', NOW + 10)
    askPendingOwnerQuestions(getDb(), { now: NOW + 20 })
    seedPacket('c-valencia', 'megvan-e a kaucióhoz elfogadott hagyományos bankkártya', NOW + 30)
    askPendingOwnerQuestions(getDb(), { now: NOW + 40 })

    const rows = getDb().prepare(
      `SELECT answered_at, superseded_at, answer_text FROM cos_owner_questions
       WHERE case_id='c-valencia' AND superseded_at IS NOT NULL`,
    ).all() as Array<{ answered_at: number | null; superseded_at: number | null; answer_text: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0].superseded_at).toBe(NOW + 40)
    expect(rows[0].answered_at, 'closing it as answered would make "answered" mean two things').toBeNull()
    expect(rows[0].answer_text).toBeNull()
  })

  it('an answer lands on the CURRENT question, not the superseded one', () => {
    seedPacket('c-valencia', 'Istvan döntése szükséges', NOW + 10)
    askPendingOwnerQuestions(getDb(), { now: NOW + 20 })
    seedPacket('c-valencia', 'megvan-e a kaucióhoz elfogadott hagyományos bankkártya', NOW + 30)
    askPendingOwnerQuestions(getDb(), { now: NOW + 40 })

    const rec = recordOwnerAnswer(getDb(), { caseId: 'c-valencia', domain: 'personal', text: 'Igen, van.', now: NOW + 50 })
    expect(rec).not.toBeNull()
    const answered = getDb().prepare(
      `SELECT question_text FROM cos_owner_questions WHERE case_id='c-valencia' AND answered_at IS NOT NULL`,
    ).all() as Array<{ question_text: string }>
    expect(answered).toHaveLength(1)
    expect(answered[0].question_text).toContain('hagyományos bankkártya')
  })
})

describe('the ceiling counts the pile, and a replacement does not grow it', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a full queue does not block the rewrite that makes a bad question answerable', () => {
    // Exactly five open questions, Valencia among them: the ceiling is full and
    // the case we are about to rewrite already holds one of the slots.
    for (let i = 0; i < 4; i++) {
      seedCase(`c-other-${i}`, `Ügy ${i}`)
      seedPacket(`c-other-${i}`, `teendő ${i}`, NOW + i)
    }
    seedCase('c-valencia', 'Valencia autóbérlés')
    seedPacket('c-valencia', 'Istvan döntése szükséges', NOW + 9)
    askPendingOwnerQuestions(getDb(), { now: NOW + 20, limit: 10 })
    expect(outstandingOwnerQuestions(getDb(), 50).length, 'ceiling full').toBe(5)
    expect(openFor('c-valencia')).toHaveLength(1)

    seedPacket('c-valencia', 'megvan-e a kaucióhoz elfogadott hagyományos bankkártya', NOW + 30)
    askPendingOwnerQuestions(getDb(), { now: NOW + 40, limit: 10 })

    // The rewrite got through despite the full queue, because it replaced its
    // own slot. (heldBacklogFull is NOT asserted to be zero: an unrelated case
    // being held by a full ceiling is the ceiling working, not a defect.)
    expect(openFor('c-valencia')[0].text,
      'the rewrite must reach him even when the queue is full').toContain('hagyományos bankkártya')
    expect(outstandingOwnerQuestions(getDb(), 50).length, 'and the pile must not grow').toBe(5)
  })
})
