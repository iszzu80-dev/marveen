import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  askPendingOwnerQuestions, matchAnswerTarget, parseAnswerToken, deriveQuestionToken,
  ensureQuestionToken, restateQuestion, openQuestionTokens, recordOwnerAnswer,
  outstandingOwnerQuestions, MAX_OUTSTANDING_QUESTIONS,
} from '../cos/owner-question.js'
import { handleOwnerUpdate, type PollResult } from '../cos/owner-inbox.js'

// QUESTION CHANNEL RECOVERY — the owner's acceptance list, 2026-09-02.
//
// THE INCIDENT THIS IS ABOUT. On 2026-08-16 00:57 an answer arrived reading
// "Én voltam, rendben van". Five questions were open, the message named none of
// them, the matcher correctly refused to guess and asked back, and nothing came
// back. Because an open question is never superseded to make room, the five
// slots stayed occupied and NOT ONE QUESTION WAS ANSWERED FOR SEVENTEEN DAYS
// while seventeen more queued behind them, three of which were blocking
// decisions. The refusal was right. The absence of a way to NAME a question was
// the defect.
//
// Every test below is one line of the owner's acceptance list.

const NOW = 1_700_000_000
const OWNER = '8942301795'
const CHANNEL = 'telegram:cos'
const CHAT = '8942301795'

function fresh(): PollResult {
  return { channel: CHANNEL, read: 0, matched: 0, unmatched: 0, ambiguous: 0, rejected: 0, notAnAnswer: 0 }
}

function seedQuestion(caseId: string, ask: string, at = NOW): void {
  const db = getDb()
  createCase(db, { caseId, title: `T ${caseId}`, caseType: 'ADMIN', status: 'NEW' }, at)
  db.prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`).run(caseId, at, at)
  const packet = {
    ballHolder: 'ISTVAN', facts: [{ statement: 'teny', source: 'e' }],
    missingRequirements: [{ what: ask, whoHasIt: 'ISTVAN', why: null }], uncertainty: [], confidence: 0.7,
  }
  db.prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(packet),
        JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: ask, blockedBy: 'ISTVAN' }] }), at)
  askPendingOwnerQuestions(db, { now: at, channel: { channel: CHANNEL, target: CHAT } })
}

const tokenOf = (caseId: string): string =>
  (getDb().prepare(`SELECT token FROM cos_owner_questions
                     WHERE case_id = ? AND answered_at IS NULL AND superseded_at IS NULL`)
    .get(caseId) as { token: string }).token

describe('question channel recovery', () => {
  beforeEach(() => { initDatabase(':memory:') })

  // ── the token itself ─────────────────────────────────────────────────────
  it('assigns a token at ask time and puts the reply contract in the message', () => {
    seedQuestion('C-1', 'Melyik ajanlat?')
    const token = tokenOf('C-1')
    expect(token).toMatch(/^Q[0-9A-F]{4,12}$/)

    const sent = getDb().prepare(
      `SELECT content FROM agent_messages WHERE origin_note = 'cos-owner-question'
        ORDER BY id DESC LIMIT 1`).get() as { content: string }
    expect(sent.content).toContain(`Válasz: ${token}:`)
  })

  it('the token survives a restart: it is stored, not re-derived from what is open', () => {
    seedQuestion('C-1', 'Melyik ajanlat?')
    const before = tokenOf('C-1')
    const hash = (getDb().prepare(`SELECT question_hash h FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { h: string }).h

    // A second question opens; a derive-on-read scheme could now pick a
    // different length for the first one. The stored token must not move.
    seedQuestion('C-2', 'Mikor legyen?')
    expect(tokenOf('C-1')).toBe(before)
    expect(ensureQuestionToken(getDb(), 'C-1', hash)).toBe(before)
    expect(before).toBe(deriveQuestionToken(hash))
  })

  it('a token is never reused for another question', () => {
    seedQuestion('C-1', 'A')
    seedQuestion('C-2', 'B')
    const t1 = tokenOf('C-1')
    expect(() => getDb().prepare(
      `UPDATE cos_owner_questions SET token = ? WHERE case_id = 'C-2'`).run(t1),
    ).toThrow()  // the partial unique index, not a function anybody has to remember to call
  })

  // ── (B) explicit token binding ───────────────────────────────────────────
  it('binds an answer by its token even with several questions open', () => {
    seedQuestion('C-1', 'A'); seedQuestion('C-2', 'B'); seedQuestion('C-3', 'C')
    const t2 = tokenOf('C-2')
    const target = matchAnswerTarget(getDb(), { channel: CHANNEL, text: `Válasz: ${t2}: nem kell` })
    expect(target).toEqual({ caseId: 'C-2', domain: 'personal' })
  })

  it('parses the token out of the shapes a person actually types', () => {
    seedQuestion('C-1', 'A')
    const t = tokenOf('C-1')
    for (const line of [`Válasz: ${t}: nem`, `${t}: nem`, `${t.toLowerCase()} - nem`, `ez a ${t}`, t]) {
      expect(parseAnswerToken(line)).toBe(t)
    }
    // And does NOT fire on ordinary prose.
    for (const line of ['Én voltam, rendben van', 'igen', 'Q12', 'kerdes: mi legyen?']) {
      expect(parseAnswerToken(line)).toBeNull()
    }
  })

  it('the same reply cannot bind to two questions', () => {
    seedQuestion('C-1', 'A'); seedQuestion('C-2', 'B')
    const t1 = tokenOf('C-1')
    const r = fresh()
    handleOwnerUpdate(getDb(), CHANNEL,
      { updateId: 1, fromId: OWNER, chatId: CHAT, messageId: 601, text: `Válasz: ${t1}: igen` }, r)
    expect(r.matched).toBe(1)
    const open = getDb().prepare(
      `SELECT case_id FROM cos_owner_questions WHERE answered_at IS NULL AND superseded_at IS NULL`)
      .all() as Array<{ case_id: string }>
    expect(open.map(o => o.case_id)).toEqual(['C-2'])
  })

  it('a token that matches nothing open fails closed, it does not fall through to the single open question', () => {
    seedQuestion('C-1', 'A')
    // Exactly one question open, so branch (C) would have answered it. A named
    // token that does not exist must NOT be read as "no token given".
    const target = matchAnswerTarget(getDb(), { channel: CHANNEL, text: 'Válasz: QDEAD: igen' })
    expect(target).toBe('AMBIGUOUS')
  })

  // ── the adversarial case the owner asked for by name ─────────────────────
  it('ADVERSARIAL: "Én voltam, rendben van" with several open questions answers none and does not freeze the channel', () => {
    seedQuestion('C-1', 'A'); seedQuestion('C-2', 'B'); seedQuestion('C-3', 'C')
    const before = outstandingOwnerQuestions(getDb()).length

    const r = fresh()
    handleOwnerUpdate(getDb(), CHANNEL,
      { updateId: 1, fromId: OWNER, chatId: CHAT, messageId: 700, text: 'Én voltam, rendben van' }, r)

    // 1. no question is answered
    expect(r.ambiguous).toBe(1)
    expect(r.matched).toBe(0)
    const answered = getDb().prepare(
      `SELECT COUNT(*) c FROM cos_owner_questions WHERE answered_at IS NOT NULL`).get() as { c: number }
    expect(answered.c).toBe(0)

    // 2. the words survive, as their own state, with the candidates frozen in
    const held = getDb().prepare(
      `SELECT text, state, candidate_tokens FROM cos_channel_held`).get() as
      { text: string; state: string; candidate_tokens: string }
    expect(held.text).toBe('Én voltam, rendben van')
    expect(held.state).toBe('UNATTRIBUTED_RESPONSE')
    expect(JSON.parse(held.candidate_tokens)).toHaveLength(3)

    // 3. the ask-back names the tokens, so the next message can be one word
    expect(r.disambiguationPrompt).toContain(tokenOf('C-1'))

    // 4. AND THE CHANNEL IS NOT FROZEN — the state is local to this message.
    //    Capacity is unchanged, and a properly named answer still lands.
    expect(outstandingOwnerQuestions(getDb()).length).toBe(before)
    const r2 = fresh()
    handleOwnerUpdate(getDb(), CHANNEL,
      { updateId: 2, fromId: OWNER, chatId: CHAT, messageId: 701, text: `Válasz: ${tokenOf('C-2')}: igen` }, r2)
    expect(r2.matched).toBe(1)
  })

  // ── duplicates ───────────────────────────────────────────────────────────
  it('a duplicate answer does not produce a second progression', () => {
    seedQuestion('C-1', 'A')
    const t = tokenOf('C-1')
    const db = getDb()
    const first = recordOwnerAnswer(db, {
      caseId: 'C-1', domain: 'personal', text: `Válasz: ${t}: igen`,
      channel: { channel: CHANNEL, target: CHAT },
    })
    expect(first).not.toBeNull()
    const eventsAfterFirst = (db.prepare(
      `SELECT COUNT(*) c FROM personal_case_events WHERE case_id='C-1'`).get() as { c: number }).c

    const second = recordOwnerAnswer(db, {
      caseId: 'C-1', domain: 'personal', text: `Válasz: ${t}: igen`,
      channel: { channel: CHANNEL, target: CHAT },
    })
    expect(second).toBeNull()   // nothing open any more
    const eventsAfterSecond = (db.prepare(
      `SELECT COUNT(*) c FROM personal_case_events WHERE case_id='C-1'`).get() as { c: number }).c
    expect(eventsAfterSecond).toBe(eventsAfterFirst)
  })

  // ── restatement ──────────────────────────────────────────────────────────
  it('restating a stale question consumes no new slot and keeps the same identity', () => {
    seedQuestion('C-1', 'A')
    const db = getDb()
    const token = tokenOf('C-1')
    const hash = (db.prepare(`SELECT question_hash h FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { h: string }).h
    const rowsBefore = (db.prepare(`SELECT COUNT(*) c FROM cos_owner_questions`).get() as { c: number }).c
    const openBefore = outstandingOwnerQuestions(db).length
    const askedAtBefore = (db.prepare(`SELECT asked_at a FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { a: number }).a

    const r = restateQuestion(db, { caseId: 'C-1', questionHash: hash, now: NOW + 86400 })

    expect(r?.token).toBe(token)                       // same identity
    expect(r?.restateCount).toBe(1)
    expect((db.prepare(`SELECT COUNT(*) c FROM cos_owner_questions`).get() as { c: number }).c)
      .toBe(rowsBefore)                                 // no new row
    expect(outstandingOwnerQuestions(db).length).toBe(openBefore)  // no new slot
    expect((db.prepare(`SELECT asked_at a FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { a: number }).a).toBe(askedAtBefore)   // age is not erased
  })

  it('restating an answered question does nothing', () => {
    seedQuestion('C-1', 'A')
    const db = getDb()
    const hash = (db.prepare(`SELECT question_hash h FROM cos_owner_questions WHERE case_id='C-1'`)
      .get() as { h: string }).h
    recordOwnerAnswer(db, {
      caseId: 'C-1', domain: 'personal', text: 'igen', channel: { channel: CHANNEL, target: CHAT },
    })
    expect(restateQuestion(db, { caseId: 'C-1', questionHash: hash })).toBeNull()
  })

  // ── the invariants that must NOT have moved ──────────────────────────────
  it('the cap is still five', () => {
    expect(MAX_OUTSTANDING_QUESTIONS).toBe(5)
    for (let i = 1; i <= 7; i++) seedQuestion(`C-${i}`, `ask ${i}`)
    expect(outstandingOwnerQuestions(getDb()).length).toBeLessThanOrEqual(5)
  })

  it('openQuestionTokens lists what a disambiguation prompt may offer, oldest first', () => {
    seedQuestion('C-1', 'A', NOW)
    seedQuestion('C-2', 'B', NOW + 10)
    const toks = openQuestionTokens(getDb(), CHANNEL)
    expect(toks.map(t => t.caseId)).toEqual(['C-1', 'C-2'])
    expect(toks.every(t => /^Q[0-9A-F]{4,12}$/.test(t.token))).toBe(true)
  })
})
