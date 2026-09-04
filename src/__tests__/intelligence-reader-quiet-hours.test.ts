import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  runProjectionReader, loadLedger, READER_POLICY,
  isWithinQuietHours, breaksQuietHours, quietHoursDecision, quietHoursEndAt, isMorningRelease,
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
  // REWRITTEN 2026-09-04 on an owner ruling that overturned the rule these
  // tests encoded, and the change is declared rather than quietly applied:
  // "Ne kategória önmagában döntsön az éjszakai interruptról."
  //
  // Two assertions were deleted because they asserted the defect. One said a
  // SAFETY item always speaks at 03:00; one said any deadline inside 24 hours
  // does. The new rule asks whether waiting until the window opens materially
  // increases the harm, loses an opportunity, or blocks a time-critical owner
  // action -- and the owner asked specifically for positive AND negative
  // controls, not category tests, so each limb below is paired with the case
  // that must NOT fire it.

  const item = (el: Record<string, unknown>, band = 'OBLIGATION') =>
    ({ band, element: el } as unknown as AttentionItem)

  it('HEADLINE: a deadline that expires BEFORE the window opens breaks it', () => {
    // 03:00 now, due 05:00. Waiting for the 07:00 package misses it outright.
    const d = quietHoursDecision(item({ dueAt: NIGHT + 2 * HOUR }), NIGHT)
    expect(d.breaks).toBe(true)
    expect(d.limb).toBe('OPPORTUNITY_LOST')
  })

  it('NEGATIVE CONTROL: a deadline AFTER the window opens does not', () => {
    // 03:00 now, due 09:00. The morning package reaches him at 07:00, in time.
    // The old rule woke him for this, because six hours is "inside 24".
    const d = quietHoursDecision(item({ dueAt: NIGHT + 6 * HOUR }), NIGHT)
    expect(d.breaks).toBe(false)
    expect(d.reason).toContain('beyond the quiet window')
  })

  it('the boundary is the window, not a horizon: exactly at 07:00 still breaks', () => {
    const endsAt = quietHoursEndAt(NIGHT)
    expect(quietHoursDecision(item({ dueAt: endsAt }), NIGHT).breaks).toBe(true)
    expect(quietHoursDecision(item({ dueAt: endsAt + 1 }), NIGHT).breaks).toBe(false)
  })

  it('HEADLINE: if the owner cannot act, nothing wakes him -- whatever the band', () => {
    // The capability gate. Waking someone to watch a clock they cannot move is
    // the definition of a pointless interrupt.
    const d = quietHoursDecision(
      item({ dueAt: NIGHT + 2 * HOUR, owner: 'EXTERNAL' }, 'SAFETY'), NIGHT)
    expect(d.breaks).toBe(false)
    expect(d.reason).toContain('moves nothing')
  })

  it('MIRROR: the same item owned by HIM does break, so the gate is what decided', () => {
    const d = quietHoursDecision(
      item({ dueAt: NIGHT + 2 * HOUR, owner: 'OWNER' }, 'SAFETY'), NIGHT)
    expect(d.breaks).toBe(true)
  })

  it('UNKNOWN ownership is not evidence that it is somebody else\'s', () => {
    // The bug this forbids was nearly shipped: the gate first read
    // `owner !== 'OWNER'`, which treats a never-filled column as proof the
    // owner cannot act. Measured on the live shape, that silenced the one item
    // in the set that could actually lose something before morning.
    const d = quietHoursDecision(item({ dueAt: NIGHT + 2 * HOUR, owner: 'UNKNOWN' }), NIGHT)
    expect(d.breaks).toBe(true)
    expect(d.limb).toBe('OPPORTUNITY_LOST')

    // ...while a POSITIVE statement of other ownership still refuses.
    for (const owner of ['ENGINE', 'EXTERNAL']) {
      expect(quietHoursDecision(item({ dueAt: NIGHT + 2 * HOUR, owner }), NIGHT).breaks,
        `${owner} must not wake him`).toBe(false)
    }
  })

  it('HEADLINE: SAFETY alone no longer breaks the window', () => {
    // The direct reversal. An authority notice with no deadline and nothing
    // declared as accruing is a real item and a morning item.
    const d = quietHoursDecision(item({ dueAt: null }, 'SAFETY'), NIGHT)
    expect(d.breaks).toBe(false)
    expect(d.limb).toBeNull()
  })

  it('MIRROR: a SAFETY item with declared accruing harm DOES break', () => {
    // So the band is not being ignored -- the evidence is what changed.
    const d = quietHoursDecision(
      item({ dueAt: null, harmGrowsOvernight: true }, 'SAFETY'), NIGHT)
    expect(d.breaks).toBe(true)
    expect(d.limb).toBe('HARM_GROWS')
  })

  it('HEADLINE: an overdue deadline with growing harm breaks, the owner\'s carve-out', () => {
    const d = quietHoursDecision(
      item({ dueAt: NIGHT - HOUR, harmGrowsOvernight: true }), NIGHT)
    expect(d.breaks).toBe(true)
    expect(d.limb).toBe('HARM_GROWS')
  })

  it('HARM_GROWS must be DECLARED -- a merely old item is not an emergency at 04:00', () => {
    // The failure mode this forbids: deriving "harm is accruing" from staleness,
    // which would make every neglected case urgent by the small hours. The
    // staleness has to sit on `factors`, where the ranker actually puts it --
    // the first version of this test put it on the element, so a mutation that
    // read `item.factors.staleness` sailed straight through it.
    const ancient = {
      band: 'OBLIGATION',
      element: { dueAt: null, recencySeconds: 400 * DAY },
      factors: { risk: 0, urgency: 0, staleness: 1, blockedness: 0, unresolvedContradiction: 0 },
    } as unknown as AttentionItem
    expect(ancient.factors.staleness).toBe(1)
    expect(quietHoursDecision(ancient, NIGHT).breaks).toBe(false)
  })

  it('outside the window the decision is not consulted at all', () => {
    // Sanity on the caller\'s side: at noon nothing is held, so a false here
    // would be invisible.
    expect(isWithinQuietHours(NOON)).toBe(false)
    expect(isWithinQuietHours(NIGHT)).toBe(true)
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
    // The speaker is now a case whose DEADLINE falls inside the window, because
    // that is what breaks through under the new rule. It used to be the
    // authority notice, which broke through on its band alone -- and no longer
    // does. (Giving the notice a due_at is not a substitute: a dated notice
    // stops being AUTHORITATIVE_NOTICE_UNREAD and leaves the SAFETY band, which
    // is how the first attempt at this fixture silently emptied the set.)
    //
    // AWAITING_SELECTION and not READY, and the reason is worth recording: the
    // case-attention producer has NO "deadline approaching" branch. Its only
    // deadline reason is EXPLICIT_DEADLINE_PASSED, so a case whose deadline is
    // still ahead earns no attention item at all and never reaches this filter.
    // The status is what puts it in the set (USER_ACTION_REQUIRED); the due_at
    // is what breaks the window once it is there.
    // next_action_owner = OWNER is load-bearing, not decoration. Without it the
    // commitment derives owner ENGINE, and the capability gate refuses it -- as
    // it should. That is what the first version of this fixture ran into: the
    // deadline was real, the hour was right, and the next step still belonged
    // to the engine, so waking him would have moved nothing.
    getDb().prepare(
      `INSERT INTO zst_cases (case_id,title,description,case_type,status,next_action,next_action_owner,due_at,waiting_on,related_document_ids,created_at,updated_at)
       VALUES ('z1','Hatarido hajnalban',NULL,'REGULATORY_DEADLINE','AWAITING_SELECTION','Istvan dontese','OWNER',?,NULL,NULL,?,?)`,
    ).run(NIGHT + 2 * HOUR, NOON - 7 * DAY, NOON - 7 * DAY)
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
    expect(r.spoke).toHaveLength(1)
    expect(r.spoke[0].id).toContain('z1')
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
