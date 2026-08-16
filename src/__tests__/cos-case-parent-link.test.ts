import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  createCase, getCase, attachToParent, setCalendarEvents, CaseConcurrencyError,
} from '../cos/case-store.js'

// The WRITE side of parent_case_id and calendar_event_ids.
//
// Both columns shipped with the schema and neither was ever written: 0 of 79
// personal cases carried a parent, 0 of 79 carried a calendar event, while the
// owner's calendar held an entire eight-day trip as real start/end pairs. The
// read side of the parent column, meanwhile, is built all the way to
// ResolvedContext. That asymmetry is what these commands close.
//
// What is proven here is not that the writes run. It is that the two ways a
// link can be WORSE than no link are refused: a pointer to a case that does not
// exist, and a loop. Plus the boring-but-load-bearing ones: optimistic
// concurrency, an audit event per write, and idempotence, because the linking
// sweep will be run more than once over the same cluster.

const T0 = 1_700_000_000

describe('COS parent link + calendar link (write side)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function mk(id: string, title = id) {
    return createCase(getDb(), { caseId: id, title, caseType: 'TRAVEL' }, T0)
  }
  function events(caseId: string) {
    return getDb().prepare(
      `SELECT event_type, case_version, payload FROM personal_case_events
       WHERE case_id = ? ORDER BY event_id`
    ).all(caseId) as Array<{ event_type: string; case_version: number; payload: string | null }>
  }

  describe('attachToParent', () => {
    it('writes the parent, bumps the version and records a PARENT_LINKED event', () => {
      const db = getDb()
      mk('trip'); const child = mk('booking')
      const v = attachToParent(db, {
        caseId: 'booking', parentCaseId: 'trip', seenVersion: child.version, actor: 'marveen',
      }, T0 + 10)
      expect(v).toBe(2)
      expect(getCase(db, 'booking')!.parent_case_id).toBe('trip')
      const evs = events('booking')
      expect(evs.map(e => e.event_type)).toEqual(['CREATED', 'PARENT_LINKED'])
      expect(JSON.parse(evs[1].payload!)).toMatchObject({ parentCaseId: 'trip', previousParentCaseId: null })
    })

    it('REFUSES a parent that does not exist — a dangling pointer reads like data', () => {
      const db = getDb()
      const child = mk('booking')
      expect(() => attachToParent(db, {
        caseId: 'booking', parentCaseId: 'trip-that-was-never-created',
        seenVersion: child.version, actor: 'marveen',
      }, T0 + 10)).toThrow(/does not exist/)
      // And leaves nothing behind: no write, no version bump, no event.
      expect(getCase(db, 'booking')!.parent_case_id).toBeNull()
      expect(getCase(db, 'booking')!.version).toBe(1)
      expect(events('booking').map(e => e.event_type)).toEqual(['CREATED'])
    })

    it('refuses a case as its own parent', () => {
      const db = getDb()
      const c = mk('trip')
      expect(() => attachToParent(db, {
        caseId: 'trip', parentCaseId: 'trip', seenVersion: c.version, actor: 'marveen',
      }, T0 + 10)).toThrow(/its own parent/)
    })

    it('refuses a cycle: a trip cannot end up inside one of its own bookings', () => {
      const db = getDb()
      const a = mk('a'); mk('b')
      attachToParent(db, { caseId: 'a', parentCaseId: 'b', seenVersion: a.version, actor: 'marveen' }, T0 + 10)
      const b = getCase(db, 'b')!
      expect(() => attachToParent(db, {
        caseId: 'b', parentCaseId: 'a', seenVersion: b.version, actor: 'marveen',
      }, T0 + 20)).toThrow(/cycle/)
      expect(getCase(db, 'b')!.parent_case_id).toBeNull()
    })

    it('is idempotent: re-linking to the same parent writes no second event', () => {
      const db = getDb()
      mk('trip'); const child = mk('booking')
      const v1 = attachToParent(db, {
        caseId: 'booking', parentCaseId: 'trip', seenVersion: child.version, actor: 'marveen',
      }, T0 + 10)
      const v2 = attachToParent(db, {
        caseId: 'booking', parentCaseId: 'trip', seenVersion: v1, actor: 'marveen',
      }, T0 + 20)
      expect(v2).toBe(v1)
      expect(events('booking').filter(e => e.event_type === 'PARENT_LINKED')).toHaveLength(1)
    })

    it('throws on a stale version instead of clobbering a concurrent write', () => {
      const db = getDb()
      mk('trip'); mk('other-trip'); const child = mk('booking')
      attachToParent(db, {
        caseId: 'booking', parentCaseId: 'trip', seenVersion: child.version, actor: 'marveen',
      }, T0 + 10)
      expect(() => attachToParent(db, {
        caseId: 'booking', parentCaseId: 'other-trip', seenVersion: child.version, actor: 'marveen',
      }, T0 + 20)).toThrow(CaseConcurrencyError)
      expect(getCase(db, 'booking')!.parent_case_id).toBe('trip')
    })
  })

  describe('setCalendarEvents', () => {
    it('stores a deduplicated JSON array and records the event', () => {
      const db = getDb()
      const c = mk('trip')
      const v = setCalendarEvents(db, {
        caseId: 'trip', eventIds: ['evt-a', 'evt-b', 'evt-a', '  '], seenVersion: c.version, actor: 'marveen',
      }, T0 + 10)
      expect(v).toBe(2)
      expect(JSON.parse(getCase(db, 'trip')!.calendar_event_ids as string)).toEqual(['evt-a', 'evt-b'])
      expect(events('trip').map(e => e.event_type)).toEqual(['CREATED', 'CALENDAR_EVENTS_LINKED'])
    })

    it('writes [] for an empty list — "checked, none" must not read as "never looked"', () => {
      const db = getDb()
      const c = mk('trip')
      setCalendarEvents(db, { caseId: 'trip', eventIds: [], seenVersion: c.version, actor: 'marveen' }, T0 + 10)
      expect(getCase(db, 'trip')!.calendar_event_ids).toBe('[]')
      expect(getCase(db, 'trip')!.calendar_event_ids).not.toBeNull()
    })

    it('is idempotent for the same set', () => {
      const db = getDb()
      const c = mk('trip')
      const v1 = setCalendarEvents(db, {
        caseId: 'trip', eventIds: ['evt-a'], seenVersion: c.version, actor: 'marveen',
      }, T0 + 10)
      const v2 = setCalendarEvents(db, {
        caseId: 'trip', eventIds: ['evt-a'], seenVersion: v1, actor: 'marveen',
      }, T0 + 20)
      expect(v2).toBe(v1)
      expect(events('trip').filter(e => e.event_type === 'CALENDAR_EVENTS_LINKED')).toHaveLength(1)
    })
  })
})
