import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { askPendingOwnerQuestions, recordOwnerAnswer, outstandingOwnerQuestions } from '../cos/owner-question.js'

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
