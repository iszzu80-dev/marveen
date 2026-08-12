import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import {
  askPendingOwnerQuestions, recordOwnerAnswer, outstandingOwnerQuestions, matchAnswerTarget,
  holdOwnerMessage, heldOwnerMessages,
} from '../cos/owner-question.js'

// Istvan's decision (2026-08-11): the CoS gets its own Telegram bot and chat, so
// case traffic stops competing with build and fleet noise. The part that makes
// the split safe rather than merely tidy is the ANSWER path -- if a reply cannot
// be matched back to the question, separating the channels costs him the thing
// the channel exists for.

const NOW = 1_700_000_000
// The two channels share a chat id and differ by BOT. Measured 2026-08-11: in a
// private chat Telegram uses the user's own id, so both bots' chats with Istvan
// are 8942301795. The first version of this file distinguished them by TARGET,
// which the live measurement disproved -- so the identity is the channel name.
const CHAT = '8942301795'
const COS = { channel: 'telegram:cos', target: CHAT }
const DEV = { channel: 'telegram', target: CHAT }

function seed(caseId: string, ask: string) {
  createCase(getDb(), { caseId, title: `T ${caseId}`, caseType: 'ADMIN', status: 'NEW' }, NOW)
  getDb().prepare(
    `INSERT INTO case_progression_state (domain, case_id, progression_enabled, created_at, updated_at)
     VALUES ('personal', ?, 1, ?, ?)`).run(caseId, NOW, NOW)
  const packet = {
    ballHolder: 'ISTVAN', facts: [{ statement: 'tény', source: 'e' }],
    missingRequirements: [{ what: ask, whoHasIt: 'ISTVAN', why: null }], uncertainty: [], confidence: 0.7,
  }
  getDb().prepare(
    `INSERT INTO case_evidence_packets (case_id, domain, packet_json, plan_json, created_at)
     VALUES (?, 'personal', ?, ?, ?)`,
  ).run(caseId, JSON.stringify(packet), JSON.stringify({ steps: [{ kind: 'ASK_OWNER', label: ask, blockedBy: 'ISTVAN' }] }), NOW)
}

const channelOf = (caseId: string) => getDb().prepare(
  `SELECT channel, channel_target FROM cos_owner_questions WHERE case_id = ?`,
).get(caseId) as { channel: string | null; channel_target: string | null } | undefined

describe('a question remembers where it was asked', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('records the channel and target it went out on', () => {
    seed('c1', 'kell-e')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10, channel: COS })
    expect(channelOf('c1')).toEqual({ channel: 'telegram:cos', channel_target: CHAT })
  })

  it('leaves them NULL when no channel is given — no invented provenance', () => {
    seed('c1', 'kell-e')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10 })
    expect(channelOf('c1')).toEqual({ channel: null, channel_target: null })
  })
})

describe('an answer only closes a question asked on the SAME channel', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an answer from the DEV bot does not close a CoS-bot question — same chat id, different channel', () => {
    seed('c1', 'kell-e')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10, channel: COS })
    const r = recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen.', now: NOW + 20, channel: DEV })
    expect(r, 'a reply typed elsewhere must not silently absorb this question').toBeNull()
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(1)
  })

  it('an answer from the SAME chat closes it', () => {
    seed('c1', 'kell-e')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10, channel: COS })
    const r = recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen.', now: NOW + 20, channel: COS })
    expect(r).not.toBeNull()
    expect(outstandingOwnerQuestions(getDb(), 10)).toHaveLength(0)
  })

  it('a question asked BEFORE the split still accepts an answer from anywhere', () => {
    // Every question asked today has no channel. Refusing those would strand
    // them the moment the split goes live.
    seed('c1', 'kell-e')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10 })   // no channel
    const r = recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen.', now: NOW + 20, channel: COS })
    expect(r, 'pre-split questions predate the distinction').not.toBeNull()
  })

  it('an answer with no channel still works — the single-channel world keeps running', () => {
    seed('c1', 'kell-e')
    askPendingOwnerQuestions(getDb(), { now: NOW + 10, channel: COS })
    const r = recordOwnerAnswer(getDb(), { caseId: 'c1', domain: 'personal', text: 'Igen.', now: NOW + 20 })
    expect(r).not.toBeNull()
  })
})

// WHICH CASE does a plain message answer? (live misattribution, 2026-08-11)
//
// At 16:40 Istvan answered about the WIZZ AIR invoice. The rule was "take the
// newest open question"; the newest happened to be the NAV mailbox case, so his
// sentence was written onto that case. Everything downstream then treated the
// guess as his word — including me: I built a card on it and reported it back to
// him. He corrected it five hours later: "I wrote about the Wizz Air invoice,
// not the NAV one."
//
// A wrong attribution is worse than none. The wrong case gains a decision he
// never made, the right case stays open, and nothing in the record says it was
// a guess.
describe('matchAnswerTarget', () => {
  const ask = (caseId: string, domain: string, askedAt: number, target?: string): void => {
    getDb().prepare(
      `INSERT INTO cos_owner_questions
         (case_id, domain, question_hash, question_text, asked_at, channel, channel_target)
       VALUES (?, ?, ?, 'kerdes', ?, 'telegram:cos', ?)`,
    ).run(caseId, domain, `h-${caseId}`, askedAt, target ?? null)
  }

  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: with several questions open and no reply target, it refuses to guess', () => {
    ask('nav-case', 'zst', 1000)
    ask('wizz-case', 'zst', 900)
    expect(matchAnswerTarget(getDb(), { channel: 'telegram:cos', chatId: '1' })).toBe('AMBIGUOUS')
  })

  it('an explicit reply names the question, however many are open', () => {
    ask('nav-case', 'zst', 1000)
    ask('wizz-case', 'zst', 900, '1:77')
    expect(matchAnswerTarget(getDb(), { channel: 'telegram:cos', chatId: '1', replyToMessageId: 77 }))
      .toEqual({ caseId: 'wizz-case', domain: 'zst' })
  })

  it('with exactly ONE open question there is nothing to guess', () => {
    // The common case, and the reason this is not simply "require a reply": he
    // usually types a plain sentence, and refusing that would drop every answer.
    ask('only-case', 'personal', 1000)
    expect(matchAnswerTarget(getDb(), { channel: 'telegram:cos', chatId: '1' }))
      .toEqual({ caseId: 'only-case', domain: 'personal' })
  })

  it('nothing open at all is NOT ambiguity', () => {
    // Different fact, different response: nobody asked him anything, so there is
    // no case to attach to and no question to put back to him.
    expect(matchAnswerTarget(getDb(), { channel: 'telegram:cos', chatId: '1' })).toBeNull()
  })

  it('an answered question does not compete for the attribution', () => {
    ask('done-case', 'zst', 1000)
    getDb().prepare(`UPDATE cos_owner_questions SET answered_at = 1200 WHERE case_id = 'done-case'`).run()
    ask('live-case', 'zst', 900)
    expect(matchAnswerTarget(getDb(), { channel: 'telegram:cos', chatId: '1' }))
      .toEqual({ caseId: 'live-case', domain: 'zst' })
  })

  it('a question on ANOTHER channel does not create ambiguity here', () => {
    ask('cos-case', 'zst', 1000)
    getDb().prepare(
      `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at, channel)
       VALUES ('radar-case', 'zst', 'h-radar', 'kerdes', 1100, 'telegram:radar')`,
    ).run()
    expect(matchAnswerTarget(getDb(), { channel: 'telegram:cos', chatId: '1' }))
      .toEqual({ caseId: 'cos-case', domain: 'zst' })
  })
})

// HELD MEANS THE WORDS ARE KEPT, not just a counter.
//
// The ambiguity rule went in at 21:52 and fired live at 22:00: the poll counted
// `ambiguous: 1`, advanced the Telegram cursor, and the sentence was gone —
// Telegram does not re-serve an update once a higher offset is requested. I had
// told Istvan "the message is not lost, it is on the channel and in the
// counter". Only the counter was true.
describe('an unattributable message is HELD, not dropped', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the text survives, with the reason it could not be placed', () => {
    holdOwnerMessage(getDb(), {
      channel: 'telegram:cos', chatId: '1', messageId: 42,
      text: 'Nem a NAV ugyre irtam hanem a wizzair szamlara',
      reason: 'tobb nyitott kerdes', now: 1000,
    })
    const held = heldOwnerMessages(getDb())
    expect(held).toHaveLength(1)
    expect(held[0].text).toContain('wizzair')
    expect(held[0].reason).toContain('tobb nyitott')
  })

  it('the same message is not held twice', () => {
    // Polls overlap and a crash costs a re-read by design; a re-read must not
    // turn one sentence into a queue of duplicates.
    for (const now of [1000, 1100]) {
      holdOwnerMessage(getDb(), { channel: 'telegram:cos', chatId: '1', messageId: 42, text: 'egy', reason: 'r', now })
    }
    expect(heldOwnerMessages(getDb())).toHaveLength(1)
  })

  it('a resolved message leaves the list', () => {
    holdOwnerMessage(getDb(), { channel: 'telegram:cos', chatId: '1', messageId: 42, text: 'egy', reason: 'r', now: 1000 })
    getDb().prepare(`UPDATE cos_channel_held SET resolved_at = 1200, resolution = 'a Wizz ugyre tettem' WHERE held_id = 1`).run()
    expect(heldOwnerMessages(getDb())).toHaveLength(0)
  })
})
