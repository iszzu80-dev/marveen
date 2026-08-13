import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { askPendingOwnerQuestions, heldOwnerMessages } from '../cos/owner-question.js'
import { handleOwnerUpdate, type PollResult } from '../cos/owner-inbox.js'

// P10 (review 2026-08-13). The poll's own header argues that a withheld message
// must survive, and the ambiguous branch does hold it. Two other branches only
// COUNTED: a message classified `looksLikeAQuestionBack`, and a matched target
// whose recordOwnerAnswer returned falsy. In both the text was dropped while the
// offset advanced past the update — and Telegram never serves it again, so an
// owner who asked the system something got no reply, ever. The 2026-08-11
// postmortem's lesson was "fail closed is only protection if the withheld thing
// actually survives".

const NOW = 1_700_000_000
const OWNER = '8942301795'
const CHANNEL = 'telegram:cos'
const CHAT = '8942301795'

function fresh(): PollResult {
  return { channel: CHANNEL, read: 0, matched: 0, unmatched: 0, ambiguous: 0, rejected: 0, notAnAnswer: 0 }
}

function update(over: Partial<Parameters<typeof handleOwnerUpdate>[2]> = {}) {
  return { updateId: 1, fromId: OWNER, chatId: CHAT, messageId: 501, text: 'igen', ...over }
}

/** A case with an open ASK_OWNER step, then the question actually asked on the
 *  CoS channel — the state a real answer arrives into. */
function seedQuestion(caseId: string, ask: string) {
  const db = getDb()
  createCase(db, { caseId, title: `T ${caseId}`, caseType: 'ADMIN', status: 'NEW' }, NOW)
  db.prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`).run(caseId, NOW, NOW)
  const packet = {
    ballHolder: 'ISTVAN', facts: [{ statement: 'tény', source: 'e' }],
    missingRequirements: [{ what: ask, whoHasIt: 'ISTVAN', why: null }], uncertainty: [], confidence: 0.7,
  }
  db.prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(packet), JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: ask, blockedBy: 'ISTVAN' }] }), NOW)
  askPendingOwnerQuestions(db, { now: NOW, channel: { channel: CHANNEL, target: CHAT } })
}

describe('the CoS poll never drops the owner’s words', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a question back is HELD, not just counted', () => {
    const db = getDb()
    const r = fresh()
    handleOwnerUpdate(db, CHANNEL, update({ text: 'És a másik ügyben mi a helyzet?' }), r)
    expect(r.notAnAnswer).toBe(1)
    const held = heldOwnerMessages(db)
    expect(held).toHaveLength(1)
    expect(held[0].text).toBe('És a másik ügyben mi a helyzet?')
    expect(held[0].reason).toMatch(/visszakerdez/)
  })

  it('a message with nothing open is HELD too', () => {
    const db = getDb()
    const r = fresh()
    handleOwnerUpdate(db, CHANNEL, update({ text: 'rendben, csináljuk' }), r)
    expect(r.unmatched).toBe(1)
    expect(heldOwnerMessages(db).map(h => h.text)).toEqual(['rendben, csináljuk'])
  })

  it('a matched target whose write does not land is HELD, not silently dropped', () => {
    const db = getDb()
    seedQuestion('c1', 'Melyik ajánlatot válasszam?')
    // matchAnswerTarget finds the open question; recordOwnerAnswer then refuses
    // it because the message predates the question (`asked_at <= now`) — one of
    // the real ways its falsy return happens.
    db.prepare(`UPDATE cos_owner_questions SET asked_at = ? WHERE case_id='c1'`).run(4_000_000_000)
    const r = fresh()
    handleOwnerUpdate(db, CHANNEL, update({ text: 'a másodikat' }), r)
    expect(r.matched).toBe(0)
    expect(r.unmatched).toBe(1)
    const held = heldOwnerMessages(db)
    expect(held).toHaveLength(1)
    expect(held[0].text).toBe('a másodikat')
    expect(held[0].reason, 'the branch that dropped it must name the case').toContain('c1')
  })

  it('a real answer is still WRITTEN, not held — the counter-check', () => {
    const db = getDb()
    seedQuestion('c1', 'Melyik ajánlatot válasszam?')
    const r = fresh()
    handleOwnerUpdate(db, CHANNEL, update({ text: 'a másodikat' }), r)
    expect(r.matched).toBe(1)
    expect(heldOwnerMessages(db)).toEqual([])
  })

  it('a stranger’s message is rejected and NOT kept — it is not his to hold', () => {
    const db = getDb()
    const r = fresh()
    handleOwnerUpdate(db, CHANNEL, update({ fromId: '999', text: 'szia' }), r)
    expect(r.rejected).toBe(1)
    expect(heldOwnerMessages(db)).toEqual([])
  })
})
