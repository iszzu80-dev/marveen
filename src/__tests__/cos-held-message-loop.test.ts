// The owner's words survive every branch of the inbox, and he hears back.
//
// Review 2026-08-12, T-2 / T-3 / T-4 / T-5. The inbox poll had three exits and
// only one of them kept the message:
//
//   AMBIGUOUS      -> holdOwnerMessage   (kept, with a comment explaining why)
//   question-back  -> counter only       (LOST -- the cursor moves and Telegram
//                                         does not re-serve the update)
//   matched        -> recordOwnerAnswer
//
// ...and the held table nothing read: no production caller, `resolved_at` never
// written, no reply to the owner. So "held, not lost" was true of the row and
// false of the conversation.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { initProgressionSchema } from '../cos/schema.js'
import { createCase } from '../cos/case-store.js'
import {
  holdOwnerMessage, heldOwnerMessages, buildHeldFollowUp, markHeldResolved,
  recordOwnerAnswer,
} from '../cos/owner-question.js'
import { looksLikeAQuestionBack, loadCosBotConfig } from '../cos/cos-telegram.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const T0 = 1_700_000_000
const REPO = process.cwd()

function held(text: string, reason = 'tobb nyitott kerdes') {
  return { text, reason }
}

describe('held owner messages: the loop closes', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
  })

  it('HEADLINE: the poll HOLDS a message it refused to read as an answer', () => {
    // The branch this test exists for. Not a behavioural test of the script (it
    // is a top-level program), but of the line that had to appear in it: the
    // question-back exit must reach holdOwnerMessage, exactly like the ambiguity
    // exit three lines below it.
    const src = readFileSync(join(REPO, 'scripts/cos-channel-poll.ts'), 'utf8')
    const branch = src.slice(src.indexOf('looksLikeAQuestionBack(u.text)'))
    const nextExit = branch.indexOf('matchAnswerTarget')
    expect(nextExit).toBeGreaterThan(-1)
    expect(branch.slice(0, nextExit)).toContain('holdOwnerMessage')
  })

  it('the detector is crude in BOTH directions — which is why holding matters', () => {
    // The fail-closed decision is right: a false OWNER_DECISION on an append-only
    // case record is worse than a missed answer. But `hogy`, `ki`, `mennyi` and
    // `milyen` are ordinary Hungarian conjunctions, so real answers land here.
    expect(looksLikeAQuestionBack('Igen, mehet.')).toBe(false)
    expect(looksLikeAQuestionBack('Ki kell fizetni a szamlat.')).toBe(true)
    expect(looksLikeAQuestionBack('Hogy őszinte legyek, inkább 12 milliót kérek.')).toBe(true)
  })

  it('a held message produces a follow-up that names the open questions', () => {
    const text = buildHeldFollowUp(
      held('Igen, fizessuk ki'),
      [{ caseId: 'PRI-1', text: '❓ Wizz Air szamla\n\nAmi Tőled kell:' }],
    )
    expect(text).toContain('Igen, fizessuk ki')
    // The one action that resolves it without any guessing.
    expect(text).toMatch(/reply/i)
    expect(text).toContain('Wizz Air szamla')
    expect(text).toContain('PRI-1')
  })

  it('and says so plainly when there is nothing open to attach it to', () => {
    // A different fact and a different bug: "I could not place it" reads very
    // differently when nothing is open at all.
    const text = buildHeldFollowUp(held('valami'), [])
    expect(text).toContain('nincs nyitott kérdés')
  })

  it('the follow-up truncates instead of echoing an essay back', () => {
    const long = 'a'.repeat(400)
    const text = buildHeldFollowUp(held(long), [])
    expect(text).toContain('…')
    expect(text.length).toBeLessThan(long.length)
  })

  it('resolving is idempotent and only ever closes an OPEN row', () => {
    holdOwnerMessage(getDb(), {
      channel: 'telegram:cos', chatId: '1', messageId: 10, text: 'valami', reason: 'ok', now: T0,
    })
    const [row] = heldOwnerMessages(getDb())
    expect(row).toBeTruthy()

    markHeldResolved(getDb(), row.heldId, 'visszakerdeztunk', T0 + 1)
    expect(heldOwnerMessages(getDb())).toHaveLength(0)

    // A second call must not re-stamp a row somebody already dealt with.
    markHeldResolved(getDb(), row.heldId, 'masodik probalkozas', T0 + 2)
    const stored = getDb().prepare(
      `SELECT resolved_at, resolution FROM cos_channel_held WHERE held_id = ?`,
    ).get(row.heldId) as { resolved_at: number; resolution: string }
    expect(stored.resolved_at).toBe(T0 + 1)
    expect(stored.resolution).toBe('visszakerdeztunk')
  })

  it('STANDING CHECK: the held table has a production reader', () => {
    // The half a table cannot enforce. This is the finding itself: the rows
    // existed and no shipped code ever looked at them.
    const sender = readFileSync(join(REPO, 'scripts/cos-channel-send.ts'), 'utf8')
    expect(sender).toContain('heldOwnerMessages')
    expect(sender).toContain('markHeldResolved')
    // Sent BEFORE marked, or a delivery failure eats the message the table
    // exists to protect. Compared inside the drain loop, not across the file —
    // the import line mentions both names and would make this pass by accident.
    const loop = sender.slice(sender.indexOf('for (const h of heldOwnerMessages'))
    expect(loop.indexOf('sendCosMessage(cfg, buildHeldFollowUp')).toBeGreaterThan(-1)
    expect(loop.indexOf('sendCosMessage(cfg, buildHeldFollowUp'))
      .toBeLessThan(loop.indexOf('markHeldResolved'))
  })
})

describe('owner answers are matched within their own domain (T-5)', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
    createCase(getDb(), { caseId: 'c1', title: 'Szemelyes ugy', caseType: 'ADMIN' }, T0)
    getDb().prepare(
      `INSERT INTO cos_owner_questions (case_id, domain, question_hash, question_text, asked_at)
       VALUES ('c1', 'personal', 'h1', 'kerdes', ?)`,
    ).run(T0)
  })

  it('HEADLINE: the WRONG domain does not close the question', () => {
    // Before the fix this closed the row and wrote no event, because the event
    // goes to the domain's own table and the case is not in zst_cases. The
    // answer vanished and the question looked answered.
    expect(recordOwnerAnswer(getDb(), {
      caseId: 'c1', domain: 'zst', text: 'Igen', now: T0 + 1,
    })).toBeNull()

    const still = getDb().prepare(
      `SELECT answered_at FROM cos_owner_questions WHERE case_id = 'c1'`,
    ).get() as { answered_at: number | null }
    expect(still.answered_at).toBeNull()
  })

  it('the right domain still works — the check is not a blanket refusal', () => {
    const rec = recordOwnerAnswer(getDb(), {
      caseId: 'c1', domain: 'personal', text: 'Igen', now: T0 + 1,
    })
    expect(rec?.choice).toBe('YES')
  })
})

describe('the owner id is configuration, not a literal (T-4)', () => {
  it('loadCosBotConfig reads owner_id, as a string or a number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosbot-'))
    const p = join(dir, 'bot.json')

    writeFileSync(p, JSON.stringify({ token: 't', channel_id: 'telegram:cos', owner_id: '123' }))
    expect(loadCosBotConfig(p)?.ownerId).toBe('123')

    // Telegram reports ids as numbers everywhere the owner would copy one from.
    // Ignoring `123` because the parser wanted `"123"` fails closed in the most
    // confusing possible way: the poller then authorises nobody.
    writeFileSync(p, JSON.stringify({ token: 't', channel_id: 'telegram:cos', owner_id: 123 }))
    expect(loadCosBotConfig(p)?.ownerId).toBe('123')

    writeFileSync(p, JSON.stringify({ token: 't', channel_id: 'telegram:cos' }))
    expect(loadCosBotConfig(p)?.ownerId).toBeUndefined()
  })

  it('STANDING CHECK: no owner id is hard-coded in the poller', () => {
    const src = readFileSync(join(REPO, 'scripts/cos-channel-poll.ts'), 'utf8')
    // A bare 6+ digit literal in an authorisation path is the shape of the bug.
    expect(src).not.toMatch(/=\s*['"]\d{6,}['"]/)
    expect(src).toContain('cfg.ownerId')
    // ...and a missing id must refuse, not fall through to accepting everyone.
    expect(src).toContain('if (!cfg.ownerId)')
  })
})
