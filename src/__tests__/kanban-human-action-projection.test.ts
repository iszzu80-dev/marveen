import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  syncKanbanProjection, humanActionNeeds, cardIdFor, priorityFor,
  HUMAN_ACTION_REASONS, describeCard,
} from '../cos/kanban-bridge.js'

// PHASE 3 (P3-C) -- the Kanban is a DERIVED HUMAN-ACTION VIEW.
//
// Owner ruling 2026-09-01. Each block below defends one clause of it:
//   not a canonical source of truth   -> "a board move changes no case"
//   not a completion authority        -> "and closing the card does not close it"
//   dedupe                            -> "one need, one card, however often it runs"
//   due date only if provenanced      -> "an engine review date never becomes a due date"
//   scopes do not mix                 -> "a personal case never lands on the ZST project"
//   the projection may close itself   -> "the need went away, the card is archived"

const NOW = 1_800_000_000
const DAY = 86_400

const personal = (over: Record<string, unknown> = {}) => {
  const row = {
    case_id: 'p1', title: 'Valaszd ki a szallast', case_type: 'TRAVEL', status: 'AWAITING_SELECTION',
    next_action: null, blocked_reason: null, due_at: null, follow_up_at: null, completed_at: null,
    created_at: NOW - 10 * DAY, updated_at: NOW - DAY, ...over,
  }
  getDb().prepare(
    `INSERT INTO personal_cases (case_id,title,case_type,status,next_action,blocked_reason,due_at,follow_up_at,completed_at,created_at,updated_at)
     VALUES (@case_id,@title,@case_type,@status,@next_action,@blocked_reason,@due_at,@follow_up_at,@completed_at,@created_at,@updated_at)`,
  ).run(row)
}

const zstCase = (over: Record<string, unknown> = {}) => {
  const row = {
    case_id: 'z1', title: 'NAV irat a Cegkapun', description: 'From: ertesites@tarhely.gov.hu',
    case_type: 'REGULATORY_DEADLINE', status: 'NEW', next_action: null, due_at: null,
    waiting_on: null, related_document_ids: null,
    created_at: NOW - 7 * DAY, updated_at: NOW - 7 * DAY, ...over,
  }
  getDb().prepare(
    `INSERT INTO zst_cases (case_id,title,description,case_type,status,next_action,due_at,waiting_on,related_document_ids,created_at,updated_at)
     VALUES (@case_id,@title,@description,@case_type,@status,@next_action,@due_at,@waiting_on,@related_document_ids,@created_at,@updated_at)`,
  ).run(row)
}

const cards = () => getDb().prepare('SELECT * FROM kanban_cards ORDER BY id').all() as Array<Record<string, unknown>>

describe('ONLY THE NEEDS THAT ARE ACTUALLY HIS', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the two owner reasons project, and the other three do not', () => {
    expect([...HUMAN_ACTION_REASONS].sort()).toEqual(['AUTHORITATIVE_NOTICE_UNREAD', 'USER_ACTION_REQUIRED'])
  })

  it('a blocked-on-someone-else case is NOT his hands, and gets no card', () => {
    personal({ case_id: 'waiting', status: 'WAITING_EXTERNAL', title: 'a szallito valaszara var' })
    const r = syncKanbanProjection(getDb(), 'personal', NOW)
    expect(r.needs).toBe(0)
    expect(cards()).toEqual([])
  })

  it('a merely stale case is a prompt to the engine, not a task for a person', () => {
    personal({ case_id: 'old', status: 'READY', updated_at: NOW - 40 * DAY })
    expect(humanActionNeeds(getDb(), 'personal', NOW)).toEqual([])
  })

  it('an AWAITING_SELECTION case is, and it lands on the board', () => {
    personal()
    const r = syncKanbanProjection(getDb(), 'personal', NOW)
    expect(r.created).toBe(1)
    const c = cards()[0]
    expect(c.title).toBe('Valaszd ki a szallast')
    expect(c.assignee).toBe('istvan')
    expect(c.status).toBe('planned')
    expect(c.project).toBe('CoS szemelyes')
  })
})

describe('THE CARD SAYS WHAT IT IS, AND CARRIES EVERY FIELD THE OWNER ASKED FOR', () => {
  beforeEach(() => { initDatabase(':memory:'); zstCase() })

  it('case id, namespace, why a human is needed, case state, provenance, last refreshed', () => {
    syncKanbanProjection(getDb(), 'zst', NOW)
    const body = String(cards()[0].description)
    expect(body).toContain('SZARMAZTATOTT NEZET')
    expect(body).toContain('nem zar le ugyet')
    expect(body).toContain('Ugy: z1')
    expect(body).toContain('Nevter: zst')
    expect(body).toContain('Hatosagi irat erkezett')
    expect(body).toContain('Az ugy allapota most: NEW')
    expect(body).toContain('Forras:')
    expect(body).toContain('Utoljara frissitve:')
  })

  it('and it never invents urgency: high at the most, never urgent', () => {
    expect(cards()[0]).toBeUndefined()
    syncKanbanProjection(getDb(), 'zst', NOW)
    expect(cards()[0].priority).toBe('high')
    const need = humanActionNeeds(getDb(), 'zst', NOW)[0]
    expect(priorityFor(need, NOW)).not.toBe('urgent')
  })
})

describe('A DUE DATE ONLY WHEN THE RECORD STATES ONE', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('an engine review date (follow_up_at) never becomes a board deadline', () => {
    // The Phase 2 ruling, carried through: follow_up_at answers "look again
    // when", not "you promised by when". A board that showed it as a due date
    // would recreate the 66 false overdue items in a place a person reads daily.
    personal({ case_id: 'p-rev', due_at: null, follow_up_at: NOW - 5 * DAY })
    syncKanbanProjection(getDb(), 'personal', NOW)
    expect(cards()[0].due_date).toBeNull()
    expect(String(cards()[0].description)).toContain('nincs provenance-olt hatarido')
  })

  it('a stated due_at does become one', () => {
    personal({ case_id: 'p-due', due_at: NOW + 3 * DAY })
    syncKanbanProjection(getDb(), 'personal', NOW)
    expect(cards()[0].due_date).toBe(NOW + 3 * DAY)
  })
})

describe('DEDUPE -- ONE NEED, ONE CARD, HOWEVER OFTEN IT RUNS', () => {
  beforeEach(() => { initDatabase(':memory:'); personal() })

  it('ten passes leave exactly one card', () => {
    for (let i = 0; i < 10; i++) syncKanbanProjection(getDb(), 'personal', NOW + i * 60)
    expect(cards().length).toBe(1)
    const idx = getDb().prepare('SELECT * FROM kanban_human_action_projection').all()
    expect(idx.length).toBe(1)
  })

  it('the card id is derived from the case, so dedupe survives losing the index', () => {
    syncKanbanProjection(getDb(), 'personal', NOW)
    const id = cardIdFor('personal', 'p1')
    expect(cards()[0].id).toBe(id)
    // Wipe the index and run again: the deterministic id means the bridge finds
    // a card it no longer has a record of, and REFUSES it rather than making a
    // duplicate or overwriting something it cannot prove is its own.
    getDb().prepare('DELETE FROM kanban_human_action_projection').run()
    const r = syncKanbanProjection(getDb(), 'personal', NOW + 60)
    expect(cards().length).toBe(1)
    expect(r.refusedForeign).toEqual([id])
    expect(r.created).toBe(0)
  })

  it('a card id that belongs to somebody else is refused, not rewritten', () => {
    const id = cardIdFor('personal', 'p1')
    getDb().prepare(
      `INSERT INTO kanban_cards (id,title,description,status,priority,sort_order,created_at,updated_at)
       VALUES (?,?,?,'planned','normal',0,?,?)`,
    ).run(id, 'Istvan sajat kartyaja', 'kezzel irva', NOW, NOW)
    const r = syncKanbanProjection(getDb(), 'personal', NOW)
    expect(r.refusedForeign).toEqual([id])
    expect(cards()[0].title).toBe('Istvan sajat kartyaja')
    expect(String(cards()[0].description)).toBe('kezzel irva')
  })
})

describe('ONE-WAY -- THE BOARD IS A WINDOW, NOT A LEVER', () => {
  beforeEach(() => { initDatabase(':memory:'); personal() })

  const caseSnap = () => JSON.stringify(getDb().prepare('SELECT * FROM personal_cases ORDER BY case_id').all())

  it('a full sync changes no case row at all', () => {
    const before = caseSnap()
    syncKanbanProjection(getDb(), 'personal', NOW)
    expect(caseSnap()).toBe(before)
  })

  it('moving the card to done does NOT close the case, and the need stays open', () => {
    syncKanbanProjection(getDb(), 'personal', NOW)
    const id = cardIdFor('personal', 'p1')
    getDb().prepare(`UPDATE kanban_cards SET status='done' WHERE id=?`).run(id)
    const before = caseSnap()

    const r = syncKanbanProjection(getDb(), 'personal', NOW + DAY)
    expect(caseSnap()).toBe(before)                       // the case did not move
    expect(r.needs).toBe(1)                               // the need is still there
    expect(r.movedByHuman).toEqual([id])                  // reported, not acted on
    // And the projection did not drag the card back: where it sits is the
    // human's statement, so the refresh leaves the status alone.
    expect((getDb().prepare('SELECT status FROM kanban_cards WHERE id=?').get(id) as { status: string }).status)
      .toBe('done')
  })

  it('the case status is what decides, and the board has no vote', () => {
    syncKanbanProjection(getDb(), 'personal', NOW)
    getDb().prepare(`UPDATE personal_cases SET status='READY', updated_at=? WHERE case_id='p1'`).run(NOW)
    const r = syncKanbanProjection(getDb(), 'personal', NOW + 60)
    expect(r.needs).toBe(0)
    expect(r.closed).toBe(1)
    const c = getDb().prepare('SELECT archived_at FROM kanban_cards WHERE id=?')
      .get(cardIdFor('personal', 'p1')) as { archived_at: number | null }
    expect(c.archived_at).not.toBeNull()
    const idx = getDb().prepare('SELECT close_reason FROM kanban_human_action_projection').get() as { close_reason: string }
    expect(idx.close_reason).toContain('no longer needs the owner')
  })
})

describe('THE SCOPES DO NOT MIX', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    personal({ case_id: 'p-private', title: 'maganugy' })
    zstCase({ case_id: 'z-work', title: 'ceges ugy' })
  })

  it('each case reaches its own project label and no other', () => {
    syncKanbanProjection(getDb(), 'personal', NOW)
    syncKanbanProjection(getDb(), 'zst', NOW)
    const byTitle = new Map(cards().map((c) => [String(c.title), c]))
    expect(byTitle.get('maganugy')!.project).toBe('CoS szemelyes')
    expect(byTitle.get('ceges ugy')!.project).toBe('CoS ZST')
  })

  it('a ZST pass never touches a personal case, and the index rows stay apart', () => {
    syncKanbanProjection(getDb(), 'zst', NOW)
    const rows = getDb().prepare('SELECT namespace, case_id FROM kanban_human_action_projection').all() as Array<{ namespace: string; case_id: string }>
    expect(rows).toEqual([{ namespace: 'zst', case_id: 'z-work' }])
    expect(cards().length).toBe(1)
  })

  it('two namespaces cannot collide on one card id', () => {
    expect(cardIdFor('personal', 'same-id')).not.toBe(cardIdFor('zst', 'same-id'))
  })
})

describe('DETERMINISTIC', () => {
  beforeEach(() => { initDatabase(':memory:'); zstCase() })

  it('the same need renders the same card body', () => {
    const n = humanActionNeeds(getDb(), 'zst', NOW)[0]
    expect(describeCard(n, NOW)).toBe(describeCard(n, NOW))
  })
})
