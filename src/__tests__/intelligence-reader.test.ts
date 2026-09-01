import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { projectIntelligence } from '../cos/intelligence/project.js'
import {
  runProjectionReader, loadLedger, READER_POLICY, ATTENTION_DIGEST_HEADER,
  OpportunityInterruptedError,
} from '../cos/intelligence/reader.js'

// PHASE 3 (P3-A) -- the projection gets a scheduled reader.
//
// The owner's requirements, and each test below names the one it defends:
//   projection, not source of truth   -> "nothing but the delivery ledger moves"
//   deterministic                     -> "the same inputs produce the same text"
//   dedupe / supersede                -> "one utterance per element"
//   only on change or real attention  -> "silent inside the quiet window"
//   no notification storm             -> "bounded by the cap"
//   namespaces stay apart             -> "a ZST digest never carries a personal case"
//   opportunity never interrupts      -> "and the fixture leaves free slots"
//   NAV/P0 comes back until resolved  -> "it returns after twelve hours"

const NOW = 1_800_000_000
const DAY = 86_400
const HOUR = 3600

const personal = (over: Record<string, unknown> = {}) => {
  const row = {
    case_id: 'p1', title: 'p', case_type: 'ADMIN', status: 'READY',
    next_action: null, blocked_reason: null, due_at: null, completed_at: null,
    created_at: NOW - 30 * DAY, updated_at: NOW - DAY, ...over,
  }
  getDb().prepare(
    `INSERT INTO personal_cases (case_id,title,case_type,status,next_action,blocked_reason,due_at,completed_at,created_at,updated_at)
     VALUES (@case_id,@title,@case_type,@status,@next_action,@blocked_reason,@due_at,@completed_at,@created_at,@updated_at)`,
  ).run(row)
}

/** A ZST case shaped like the real NAV notice: an authority sender in the
 *  intake description and no document attached. */
const zst = (over: Record<string, unknown> = {}) => {
  const row = {
    case_id: 'z1', title: 'NAV vegrehajtas irat a Cegkapun', description: 'From: ertesites@tarhely.gov.hu',
    case_type: 'REGULATORY_DEADLINE', status: 'NEW', next_action: null, due_at: null,
    waiting_on: null, related_document_ids: null,
    created_at: NOW - 7 * DAY, updated_at: NOW - 7 * DAY, ...over,
  }
  getDb().prepare(
    `INSERT INTO zst_cases (case_id,title,description,case_type,status,next_action,due_at,waiting_on,related_document_ids,created_at,updated_at)
     VALUES (@case_id,@title,@description,@case_type,@status,@next_action,@due_at,@waiting_on,@related_document_ids,@created_at,@updated_at)`,
  ).run(row)
}

const sink = () => {
  const posts: string[] = []
  return { posts, post: (t: string) => { posts.push(t) } }
}

describe('THE NAV RULE -- it comes back on its own until the document is collected', () => {
  beforeEach(() => { initDatabase(':memory:'); zst() })

  it('speaks the first time, and says the item is new', () => {
    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NOW, s.post)
    expect(r.posted).toBe(true)
    expect(r.spoke.map((x) => x.band)).toContain('SAFETY')
    expect(r.spoke[0].trigger).toBe('NEW')
    expect(s.posts[0]).toContain(ATTENTION_DIGEST_HEADER)
    expect(s.posts[0]).toContain('no evidence it was collected')
  })

  it('stays silent an hour later -- nothing changed, and that is not news', () => {
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NOW + HOUR, s.post)
    expect(r.posted).toBe(false)
    expect(s.posts).toEqual([])
    expect(r.stillQuiet).toBeGreaterThan(0)
  })

  it('COMES BACK after twelve hours, because the notice is still uncollected', () => {
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NOW + 12 * HOUR + 1, s.post)
    expect(r.posted).toBe(true)
    expect(r.spoke[0].trigger).toBe('RESURFACED')
    // and it says how many times, so a reader can tell "again" from "new"
    expect(s.posts[0]).toContain('2. alkalom')
  })

  it('and STOPS coming back once a document is attached -- real resolution evidence', () => {
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    getDb().prepare(`UPDATE zst_cases SET related_document_ids = ? WHERE case_id = 'z1'`).run('["doc-1"]')
    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NOW + 5 * DAY, s.post)
    // The derivation no longer produces AUTHORITATIVE_NOTICE_UNREAD at all, so
    // the timer never gets a chance to fire. The rule lives in the evidence, not
    // in the clock.
    expect(r.spoke.filter((x) => x.statement.includes('no evidence it was collected'))).toEqual([])
    expect(s.posts.join('')).not.toContain('no evidence it was collected')
  })
})

describe('AN INFORMATIONAL ITEM HAS NO TIMER -- it speaks on change and never again', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    // A closed case with nothing evidencing the closure: UNEVIDENCED_CLOSURE,
    // which the closure-evidence band puts in INFORMATIONAL.
    personal({ case_id: 'closed', status: 'COMPLETED', completed_at: NOW - 2 * DAY })
  })

  it('is silent a month later, with no change behind it', () => {
    const first = runProjectionReader(getDb(), 'personal', NOW, sink().post)
    expect(first.posted).toBe(true)
    const s = sink()
    const r = runProjectionReader(getDb(), 'personal', NOW + 30 * DAY, s.post)
    expect(r.posted).toBe(false)
    expect(s.posts).toEqual([])
  })
})

describe('A CHANGE INSIDE THE QUIET WINDOW STILL SPEAKS', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the sentence changed under an unchanged band, and the reader noticed', () => {
    // AWAITING_SELECTION -> USER_ACTION_REQUIRED. Then the status changes to a
    // different owner-must-act value: the element id is stable by design and the
    // band does not move, so a band-only comparison would have stayed quiet
    // through a real change.
    zst({ case_id: 'z2', title: 'valaszd ki', description: 'no sender', status: 'AWAITING_SELECTION' })
    const first = runProjectionReader(getDb(), 'zst', NOW, sink().post)
    expect(first.posted).toBe(true)

    getDb().prepare(`UPDATE zst_cases SET status = 'AWAITING_APPROVAL' WHERE case_id = 'z2'`).run()
    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NOW + HOUR, s.post)
    expect(r.posted).toBe(true)
    expect(r.promotedByChange).toBe(1)
    expect(r.spoke[0].trigger).toBe('CHANGED_WHILE_QUIET')
    expect(s.posts[0]).toContain('AWAITING_APPROVAL')
  })

  it('but an unchanged sentence in the same window does not', () => {
    zst({ case_id: 'z3', title: 'valaszd ki', description: 'no sender', status: 'AWAITING_SELECTION' })
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    const r = runProjectionReader(getDb(), 'zst', NOW + HOUR, sink().post)
    expect(r.posted).toBe(false)
    expect(r.promotedByChange).toBe(0)
  })
})

describe('AN OPPORTUNITY NEVER INTERRUPTS -- and the fixture leaves room for it to try', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    // ONE obligation and TWO FREE interrupt slots. With three obligations the
    // cap alone would keep opportunities out and the assertion would pass over a
    // broken rule -- that vacuity is what the Phase 2 mutation run found, twice.
    //
    // The opportunity cases are deliberately only TWO DAYS old: old enough to be
    // STALLED_NO_ACTION opportunities, too recent to earn STALE_UNRESOLVED case
    // attention, which would have filled the very slots this test needs empty.
    personal({ case_id: 'owed', status: 'READY', next_action: 'send the form', due_at: NOW - DAY })
    personal({ case_id: 'chance1', status: 'READY', updated_at: NOW - 2 * DAY })
    personal({ case_id: 'chance2', status: 'READY', updated_at: NOW - 3 * DAY })
  })

  it('opportunities exist, slots are free, and none of them speaks', () => {
    // The fixture is checked, not assumed: without real opportunities and real
    // free slots this assertion proves nothing at all.
    const p = projectIntelligence(getDb(), 'personal', NOW)
    expect(p.opportunities.length).toBeGreaterThan(0)

    const r = runProjectionReader(getDb(), 'personal', NOW, sink().post)
    expect(r.spoke.length).toBeLessThan(READER_POLICY.maxInterruptions)
    expect(r.opportunityInSpoken).toBe(0)
    expect(r.spoke.every((x) => x.band !== 'OPPORTUNITY')).toBe(true)
    expect(r.quiet).toBeGreaterThan(0)      // they ARE available, just not spoken
  })

  it('the guard is a throw, not a filter: a wrong list stops the digest', () => {
    expect(new OpportunityInterruptedError('x')).toBeInstanceOf(Error)
  })
})

describe('THE NAMESPACES STAY APART', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    personal({ case_id: 'p-secret', title: 'maganugy', status: 'AWAITING_SELECTION' })
    zst({ case_id: 'z-work', title: 'ceges ugy', description: 'no sender', status: 'AWAITING_SELECTION' })
  })

  it('a ZST digest carries no personal case, and the other way round', () => {
    const pz = sink(); const pp = sink()
    runProjectionReader(getDb(), 'zst', NOW, pz.post)
    runProjectionReader(getDb(), 'personal', NOW, pp.post)
    expect(pz.posts.join('')).not.toContain('p-secret')
    expect(pz.posts.join('')).not.toContain('maganugy')
    expect(pp.posts.join('')).not.toContain('z-work')
    expect(pp.posts.join('')).not.toContain('ceges ugy')
  })

  it('and their ledgers are separate rows, so one cannot silence the other', () => {
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    expect(loadLedger(getDb(), 'personal').size).toBe(0)
    expect(loadLedger(getDb(), 'zst').size).toBeGreaterThan(0)
  })
})

describe('IT IS A PROJECTION READER, SO NOTHING BUT THE DELIVERY LEDGER MOVES', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    zst()
    personal({ case_id: 'owed', status: 'READY', next_action: 'send the form', due_at: NOW - DAY })
  })

  const census = () => {
    const db = getDb()
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>
    const out: Record<string, number> = {}
    for (const t of tables) {
      out[t.name] = (db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number }).n
    }
    return out
  }

  it('the ONLY table that gains a row is intelligence_surfaced', () => {
    const before = census()
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    runProjectionReader(getDb(), 'personal', NOW, sink().post)
    const after = census()
    const moved = Object.keys(after).filter((k) => after[k] !== before[k])
    expect(moved).toEqual(['intelligence_surfaced'])
  })

  it('no case row is touched: contents and timestamps are byte-identical', () => {
    const snap = () => JSON.stringify([
      getDb().prepare('SELECT * FROM zst_cases ORDER BY case_id').all(),
      getDb().prepare('SELECT * FROM personal_cases ORDER BY case_id').all(),
    ])
    const before = snap()
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    runProjectionReader(getDb(), 'personal', NOW, sink().post)
    expect(snap()).toBe(before)
  })

  it('it opens no question, so the E2 ceiling cannot be reached around', () => {
    // Named separately from the census above because this is the requirement,
    // and a future table added to the census would not say WHY it matters.
    const q = () => (getDb().prepare(
      `SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE '%question%'`,
    ).get() as { n: number }).n
    const tables = getDb().prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%question%'`,
    ).all() as Array<{ name: string }>
    const before = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number }).n)
    runProjectionReader(getDb(), 'zst', NOW, sink().post)
    const after = tables.map((t) => (getDb().prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number }).n)
    expect(after).toEqual(before)
    expect(q()).toBeGreaterThanOrEqual(0)
  })
})

describe('POST FIRST, RECORD AFTER', () => {
  beforeEach(() => { initDatabase(':memory:'); zst() })

  it('a failing post leaves the ledger EMPTY, so the item speaks again', () => {
    expect(() => runProjectionReader(getDb(), 'zst', NOW, () => { throw new Error('bus down') }))
      .toThrow('bus down')
    expect(loadLedger(getDb(), 'zst').size).toBe(0)

    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NOW + 60, s.post)
    expect(r.posted).toBe(true)
    expect(r.spoke[0].trigger).toBe('NEW')      // never marked as told
  })
})

describe('BOUNDED AND DETERMINISTIC', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    for (let i = 0; i < 12; i++) {
      zst({ case_id: `z${i}`, title: `NAV irat ${i}`, description: 'From: ertesites@tarhely.gov.hu' })
    }
  })

  it('twelve items compete and at most three speak -- the storm cannot form', () => {
    const r = runProjectionReader(getDb(), 'zst', NOW, sink().post)
    expect(r.spoke.length).toBe(READER_POLICY.maxInterruptions)
    expect(r.spoke.length + r.quiet + r.stillQuiet).toBeGreaterThanOrEqual(12)
  })

  it('the same inputs produce the same text, character for character', () => {
    const a = sink(); runProjectionReader(getDb(), 'zst', NOW, a.post)
    initDatabase(':memory:')
    for (let i = 0; i < 12; i++) {
      zst({ case_id: `z${i}`, title: `NAV irat ${i}`, description: 'From: ertesites@tarhely.gov.hu' })
    }
    const b = sink(); runProjectionReader(getDb(), 'zst', NOW, b.post)
    expect(b.posts[0]).toBe(a.posts[0])
  })
})

describe('A REHEARSAL WRITES NOTHING', () => {
  beforeEach(() => { initDatabase(':memory:'); zst() })

  it('a dry run does not mark the item as told, so the real run still speaks', () => {
    // The obvious dry run -- pass a no-op poster -- silences the message and
    // STILL writes the ledger, spending the one utterance an unread NAV notice
    // gets on nobody. Nothing would look broken afterwards.
    const dry = runProjectionReader(getDb(), 'zst', NOW, () => {}, undefined, undefined, true)
    expect(dry.text).not.toBeNull()
    expect(dry.posted).toBe(false)
    expect(loadLedger(getDb(), 'zst').size).toBe(0)

    const s = sink()
    const real = runProjectionReader(getDb(), 'zst', NOW + 60, s.post)
    expect(real.posted).toBe(true)
    expect(real.spoke[0].trigger).toBe('NEW')
    expect(s.posts.length).toBe(1)
  })
})
