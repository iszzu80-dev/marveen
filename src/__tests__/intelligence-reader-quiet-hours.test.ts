import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  runProjectionReader, loadLedger, READER_POLICY,
  isWithinQuietHours, breaksQuietHours, isMorningRelease,
  QUIET_HOURS_START, QUIET_HOURS_END, MORNING_RELEASE_MAX_INTERRUPTIONS,
} from '../cos/intelligence/reader.js'
import type { AttentionItem } from '../cos/intelligence/attention.js'

// QUIET HOURS (owner ruling 2026-09-04).
//
// The feature suppresses a correct message. That is the whole risk, so each test
// below names the failure it exists to catch, and the first two are about the
// thing that would be INVISIBLE if it broke: a held item must keep its utterance.
//
// Times are pinned as absolute epochs and asserted through the same helper the
// reader uses, so a change of APP_TZ moves the tests and the code together
// rather than leaving one of them quietly describing a different clock.

const DAY = 86_400
const HOUR = 3600

/** 2027-01-15, Europe/Budapest (CET, UTC+1). */
const at = (hourLocal: number, minute = 0) =>
  Date.UTC(2027, 0, 15, hourLocal - 1, minute, 0) / 1000

const NOON = at(12)
const NIGHT = at(3)          // deep inside the window
const JUST_BEFORE = at(21, 59)
const JUST_AFTER_START = at(22, 0)
const JUST_BEFORE_END = at(6, 59)
const JUST_AFTER_END = at(7, 0)

const personal = (over: Record<string, unknown> = {}) => {
  const row = {
    case_id: 'p1', title: 'p', case_type: 'ADMIN', status: 'READY',
    next_action: null, blocked_reason: null, due_at: null, completed_at: null,
    created_at: NOON - 30 * DAY, updated_at: NOON - 30 * DAY, ...over,
  }
  getDb().prepare(
    `INSERT INTO personal_cases (case_id,title,case_type,status,next_action,blocked_reason,due_at,completed_at,created_at,updated_at)
     VALUES (@case_id,@title,@case_type,@status,@next_action,@blocked_reason,@due_at,@completed_at,@created_at,@updated_at)`,
  ).run(row)
}

/** The NAV shape: an authority sender and no document -- SAFETY band. */
const authorityNotice = (over: Record<string, unknown> = {}) => {
  const row = {
    case_id: 'z1', title: 'NAV irat a Cegkapun', description: 'From: ertesites@tarhely.gov.hu',
    case_type: 'REGULATORY_DEADLINE', status: 'NEW', next_action: null, due_at: null,
    waiting_on: null, related_document_ids: null,
    created_at: NOON - 7 * DAY, updated_at: NOON - 7 * DAY, ...over,
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

describe('the window itself', () => {
  it('is closed across midnight, and the boundaries belong where the owner put them', () => {
    expect(isWithinQuietHours(JUST_BEFORE)).toBe(false)
    expect(isWithinQuietHours(JUST_AFTER_START)).toBe(true)
    expect(isWithinQuietHours(NIGHT)).toBe(true)
    expect(isWithinQuietHours(at(0, 0))).toBe(true)      // midnight is inside
    expect(isWithinQuietHours(JUST_BEFORE_END)).toBe(true)
    expect(isWithinQuietHours(JUST_AFTER_END)).toBe(false)
    expect(isWithinQuietHours(NOON)).toBe(false)
    expect([QUIET_HOURS_START, QUIET_HOURS_END]).toEqual([22, 7])
  })
})

describe('THE HELD ITEM KEEPS ITS UTTERANCE -- the failure nobody would see', () => {
  beforeEach(() => { initDatabase(':memory:'); personal({ status: 'INFO_REQUIRED' }) })

  it('says nothing at 03:00 and writes NOTHING to the ledger', () => {
    const s = sink()
    const r = runProjectionReader(getDb(), 'personal', NIGHT, s.post)
    expect(r.posted).toBe(false)
    expect(s.posts).toEqual([])
    expect(r.heldByQuietHours).toBeGreaterThan(0)
    expect(r.inQuietHours).toBe(true)
    // The point: no ledger row. A held item that got recorded would be marked as
    // told, and the morning run would find nothing to say -- silently.
    expect(loadLedger(getDb(), 'personal').size).toBe(0)
  })

  it('and therefore still speaks, as NEW, once the window closes', () => {
    const held = sink()
    runProjectionReader(getDb(), 'personal', NIGHT, held.post)
    expect(held.posts).toEqual([])

    const morning = sink()
    const r = runProjectionReader(getDb(), 'personal', JUST_AFTER_END, morning.post)
    expect(r.posted).toBe(true)
    expect(morning.posts).toHaveLength(1)
    expect(r.spoke[0].trigger).toBe('NEW')
    expect(r.spoke[0].timesSurfacedBefore).toBe(0)
  })
})

describe('what may break the window', () => {
  it('SAFETY speaks at 03:00 -- an authority notice is not a backlog item', () => {
    initDatabase(':memory:'); authorityNotice()
    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NIGHT, s.post)
    expect(r.posted).toBe(true)
    expect(r.spoke.map((x) => x.band)).toContain('SAFETY')
    expect(r.heldByQuietHours).toBe(0)
  })

  it('a deadline falling inside 24 hours breaks the window', () => {
    const item = { band: 'OBLIGATION', element: { dueAt: NIGHT + 6 * HOUR } } as unknown as AttentionItem
    expect(breaksQuietHours(item, NIGHT)).toBe(true)
  })

  it('a deadline further out does NOT', () => {
    const item = { band: 'OBLIGATION', element: { dueAt: NIGHT + 3 * DAY } } as unknown as AttentionItem
    expect(breaksQuietHours(item, NIGHT)).toBe(false)
  })

  it('a deadline that ALREADY PASSED does not -- waking the owner cannot un-pass it', () => {
    const item = { band: 'OBLIGATION', element: { dueAt: NIGHT - HOUR } } as unknown as AttentionItem
    expect(breaksQuietHours(item, NIGHT)).toBe(false)
  })

  it('a case with no stated deadline does not', () => {
    const item = { band: 'OBLIGATION', element: { dueAt: null } } as unknown as AttentionItem
    expect(breaksQuietHours(item, NIGHT)).toBe(false)
  })

  it('WAITING_EXTERNAL alone never breaks it -- owner, verbatim', () => {
    initDatabase(':memory:')
    personal({ status: 'WAITING_EXTERNAL' })
    const s = sink()
    const r = runProjectionReader(getDb(), 'personal', NIGHT, s.post)
    expect(r.posted).toBe(false)
    expect(s.posts).toEqual([])
  })
})

describe('THE MIXED NIGHT -- one item speaks, the rest must not be marked as told', () => {
  // The test above ("writes NOTHING to the ledger") holds only because the run
  // returns early when nothing is exempt, so it stays green even if the ledger
  // were handed the HELD set. Found by mutation: replacing `exempt` with `speak`
  // in `recordSurfaced` did not turn it red. This is the case that does -- an
  // exempt item forces the post-and-record path to run WHILE held items exist.
  beforeEach(() => {
    initDatabase(':memory:')
    authorityNotice()                                   // SAFETY, breaks the window
    for (let i = 0; i < 4; i++) {                       // ordinary, must be held
      getDb().prepare(
        `INSERT INTO zst_cases (case_id,title,description,case_type,status,next_action,due_at,waiting_on,related_document_ids,created_at,updated_at)
         VALUES (?,?,NULL,'GENERAL_OPERATION','INFORMATION_REQUIRED',NULL,NULL,NULL,NULL,?,?)`,
      ).run(`h${i}`, `held ${i}`, NOON - 30 * DAY, NOON - 30 * DAY)
    }
  })

  it('records ONLY what actually spoke', () => {
    const s = sink()
    const r = runProjectionReader(getDb(), 'zst', NIGHT, s.post)

    expect(r.posted).toBe(true)
    expect(s.posts).toHaveLength(1)
    expect(r.spoke.every((x) => x.band === 'SAFETY')).toBe(true)
    expect(r.heldByQuietHours).toBeGreaterThan(0)

    const ledger = loadLedger(getDb(), 'zst')
    expect(ledger.size).toBe(r.spoke.length)
    for (const spoken of r.spoke) expect(ledger.has(spoken.id)).toBe(true)
  })

  it('and the held ones are still unsaid in the morning', () => {
    runProjectionReader(getDb(), 'zst', NIGHT, sink().post)
    const morning = sink()
    const r = runProjectionReader(getDb(), 'zst', JUST_AFTER_END, morning.post)
    expect(r.posted).toBe(true)
    // Every held item arrives as NEW: none of them was consumed by the night run.
    expect(r.spoke.length).toBeGreaterThan(0)
    expect(r.spoke.every((x) => x.trigger === 'NEW')).toBe(true)
  })
})

describe('the morning package', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a namespace that never spoke gets the NORMAL cap, not a twelve-item wall', () => {
    expect(isMorningRelease(NOON, 0)).toBe(false)
  })

  it('is the first run after the window closes, and only the first', () => {
    // spoke last night, inside the window -> the morning run releases
    expect(isMorningRelease(JUST_AFTER_END, NIGHT)).toBe(true)
    // spoke already this morning -> no second package
    expect(isMorningRelease(at(9), at(8))).toBe(false)
  })

  it('never fires inside the window', () => {
    expect(isMorningRelease(NIGHT, NIGHT - DAY)).toBe(false)
  })

  it('releases more than the hourly three in one message', () => {
    for (let i = 0; i < 10; i++) {
      personal({ case_id: `p${i}`, title: `case ${i}`, status: 'INFO_REQUIRED' })
    }
    // Held overnight: nothing recorded, so all ten are still unspoken.
    const night = sink()
    runProjectionReader(getDb(), 'personal', NIGHT, night.post)
    expect(night.posts).toEqual([])

    // Seed a ledger row dated inside the window so the morning run counts as a
    // release rather than a first-ever utterance.
    getDb().prepare(
      `INSERT INTO intelligence_surfaced
         (namespace,element_id,band,fingerprint,first_surfaced_at,last_surfaced_at,times_surfaced)
       VALUES ('personal','seed','OBLIGATION','f',?,?,1)`,
    ).run(NIGHT, NIGHT)

    const morning = sink()
    const r = runProjectionReader(getDb(), 'personal', JUST_AFTER_END, morning.post)
    expect(r.morningRelease).toBe(true)
    expect(morning.posts).toHaveLength(1)
    expect(r.spoke.length).toBeGreaterThan(READER_POLICY.maxInterruptions)
    expect(r.spoke.length).toBeLessThanOrEqual(MORNING_RELEASE_MAX_INTERRUPTIONS)
  })
})
