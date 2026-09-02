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
import { handleOwnerUpdate, OWNER_ID } from '../cos/owner-inbox.js'
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

  it('HEADLINE: the inbox HOLDS a message it refused to read as an answer', () => {
    // The branch this test exists for: the question-back exit must reach
    // holdOwnerMessage, exactly like the ambiguity exit below it.
    //
    // MERGE 2026-08-13 — RE-POINTED, AND DELIBERATELY NOT WEAKENED. The branches
    // moved out of scripts/cos-channel-poll.ts into src/cos/owner-inbox.ts, so
    // that the exits could be driven by tests instead of only by a live Telegram
    // poll. This check scanned the SCRIPT, so after the extraction it was
    // scanning a file that no longer contains the branch — and `indexOf` on a
    // missing needle returns -1, which `slice(-1)` turns into a happy little
    // substring. A source scan that survives the code moving away is worse than
    // no scan: it reports on a file that cannot fail it.
    //
    // It now follows the code AND asserts the stronger property the extracted
    // module states about itself: every exit except the not-the-owner rejection
    // either records the answer or holds the text.
    const src = readFileSync(join(REPO, 'src/cos/owner-inbox.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function handleOwnerUpdate'))
    expect(body.length).toBeGreaterThan(0)

    const branch = body.slice(body.indexOf('looksLikeAQuestionBack(u.text)'))
    const nextExit = branch.indexOf('matchAnswerTarget')
    expect(nextExit).toBeGreaterThan(-1)
    expect(branch.slice(0, nextExit)).toContain('holdOwnerMessage')

    // Every `return` in the handler is preceded by a hold or a record. The one
    // exception is the sender check, which is the first line and is not his
    // message to keep.
    const returns = body.split(/\breturn\b/).slice(1, -1)
    const unguarded = body
      .split('\n')
      .filter(l => /result\.\w+\+\+; return/.test(l) || /^\s*result\.\w+$/.test(l))
      .filter(l => !/rejected/.test(l))
    expect(unguarded.length).toBeGreaterThan(0) // the shape still exists
    expect(returns.length).toBeGreaterThan(3)
    // 2026-09-02, Question Channel Recovery. The ambiguous exit now calls
    // `recordUnattributedResponse` instead of `holdOwnerMessage`. That is the
    // SAME hold — it writes the identical row to cos_channel_held — plus the
    // state and the candidate tokens that make an attribution failure visible
    // as a failure instead of as five slots that never empty.
    //
    // So the accepted set is widened, and NOT the property. To make sure this
    // widening cannot become the hole the header warns about, the source scan is
    // now backed by the behavioural assertion below: the ambiguous branch is
    // actually driven, and the row is actually there.
    const HOLDERS = ['holdOwnerMessage', 'recordUnattributedResponse']
    for (const kind of ['notAnAnswer', 'ambiguous', 'unmatched']) {
      const at = body.indexOf(`result.${kind}++`)
      expect(at).toBeGreaterThan(-1)
      // The nearest preceding statement of substance must be a hold.
      const before = body.slice(Math.max(0, at - 600), at)
      expect(HOLDERS.some(h => before.includes(h))).toBe(true)
    }
  })

  it('BEHAVIOURAL: the ambiguous exit really writes the words, whatever the function is called', () => {
    // The scan above reads source text. This one drives the branch and looks in
    // the table, so renaming the holder cannot quietly empty the guarantee.
    const db = getDb()
    for (const id of ['H-1', 'H-2']) {
      createCase(db, { caseId: id, title: `T ${id}`, caseType: 'ADMIN', status: 'NEW' }, T0)
      db.prepare(
        `INSERT INTO cos_owner_questions
           (case_id, domain, question_hash, question_text, asked_at, channel, token)
         VALUES (?, 'personal', ?, 'k?', ?, 'telegram:cos', ?)`,
      ).run(id, `hash-${id}`, T0, `Q${id === 'H-1' ? 'AAAA' : 'BBBB'}`)
    }
    const result = {
      channel: 'telegram:cos', read: 0, matched: 0, unmatched: 0,
      ambiguous: 0, rejected: 0, notAnAnswer: 0,
    }
    handleOwnerUpdate(db, 'telegram:cos', {
      updateId: 1, fromId: OWNER_ID, chatId: '8942301795', messageId: 900,
      text: 'Én voltam, rendben van',
    }, result)

    expect(result.ambiguous).toBe(1)
    const row = db.prepare(`SELECT text, state FROM cos_channel_held`).get() as
      { text: string; state: string } | undefined
    expect(row?.text).toBe('Én voltam, rendben van')
    expect(row?.state).toBe('UNATTRIBUTED_RESPONSE')
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
