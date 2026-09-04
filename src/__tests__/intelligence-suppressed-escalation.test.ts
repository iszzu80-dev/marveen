// SUPPRESSED IS NOT INELIGIBLE, AND URGENT IS NOT AUTOMATIC REDELIVERY.
//
// Owner ruling 2026-09-04, in two halves that pull against each other:
//
//   URGENCY / ELIGIBILITY -- always over the full relevant population: ranked,
//   outside the top-N, AND suppressed. "A suppression NEM jelentheti azt, hogy
//   egy tetelt nem vizsgalunk ujra."
//
//   DELIVERY / ANTI-SPAM -- a suppressed item may break suppression again only
//   on a MATERIAL ESCALATION since the previous delivery. Mere elapsed time, an
//   unchanged urgent state, and the case merely ageing are NOT material.
//
// WHERE THE ANSWER COMES FROM. The first implementation stored the prior
// deadline, owner and statement in the delivery ledger, and the projection
// guard rejected it: that ledger is exempt from the no-second-truth rule only
// because it holds utterance facts. So these tests exercise the real sources --
// the case's own event log, and the two utterance facts already stored.
//
// The five controls below are the owner's own list, A to E.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { materialEscalation, fingerprintOf, type LedgerRow, FINGERPRINT_ALGO} from '../cos/intelligence/reader.js'
import type { AttentionItem } from '../cos/intelligence/attention.js'

const HOUR = 3600
const DAY = 86_400
/** 2027-01-15 12:00 Europe/Budapest (CET, UTC+1). */
const NOON = Date.UTC(2027, 0, 15, 11, 0, 0) / 1000
const LAST_SPOKE = NOON - 6 * HOUR

const item = (el: Record<string, unknown>, band = 'OBLIGATION'): AttentionItem =>
  ({ band, element: {
    id: 'e1', caseId: 'c1', statement: 'a thing',
    // Every real element carries provenance, and since 2026-09-04 that is what
    // the fingerprint is taken over. A fixture without it would be testing a
    // shape the projection cannot produce.
    provenance: [{ source: 'CASE', ref: 'c1', observedAt: LAST_SPOKE - DAY }],
    ...el,
  } } as unknown as AttentionItem)

const ledgerFor = (it: AttentionItem, at = LAST_SPOKE): LedgerRow => ({
  element_id: 'e1', band: it.band, fingerprint: fingerprintOf(it),
  first_surfaced_at: at, last_surfaced_at: at, times_surfaced: 1,
  fingerprint_algo: FINGERPRINT_ALGO,
})

/** A case event written AFTER the last delivery: the case itself moved. */
function caseEvent(at: number, type = 'STATUS_CHANGED', reason = 'a real change'): void {
  getDb().prepare(
    `INSERT INTO personal_cases (case_id,title,case_type,status,created_at,updated_at)
     VALUES ('c1','c','ADMIN','READY',?,?) ON CONFLICT(case_id) DO NOTHING`,
  ).run(at - DAY, at)
  getDb().prepare(
    `INSERT INTO personal_case_events (case_id,case_version,actor,event_type,reason,created_at)
     VALUES ('c1',1,'test',?,?,?)`,
  ).run(type, reason, at)
}

describe("the owner's five controls", () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('A) suppressed + a NEW deadline within two hours -> speaks again', () => {
    // Setting a deadline is a change to the case, and the case log carries it.
    caseEvent(NOON - HOUR, 'STATUS_CHANGED', 'deadline set for this afternoon')
    const esc = materialEscalation(
      getDb(), 'personal', item({ dueAt: NOON + 2 * HOUR }), ledgerFor(item({ dueAt: null })), NOON)
    expect(esc.escalated).toBe(true)
    expect(esc.what).toContain('deadline set for this afternoon')
  })

  it('B) suppressed SECURITY + new active-compromise evidence -> speaks again', () => {
    const before = item({ dueAt: null }, 'SAFETY')
    // The evidence is what moved -- a new observation, filed after we last
    // spoke. Re-wording the sentence over the SAME rows would no longer count,
    // and must not: that is the manufactured-news defect this suite also pins.
    const after = item({
      dueAt: null,
      statement: 'active compromise observed',
      provenance: [
        { source: 'CASE', ref: 'c1', observedAt: LAST_SPOKE - DAY },
        { source: 'CASE_EVENT', ref: 'ev-compromise', observedAt: NOON - HOUR },
      ],
    }, 'SAFETY')
    const esc = materialEscalation(getDb(), 'personal', after, ledgerFor(before), NOON)
    expect(esc.escalated).toBe(true)
    expect(esc.what).toContain('new evidence changed what it says')
  })

  it('C) suppressed + only six hours elapsed, nothing else changed -> stays silent', () => {
    // Identical item, no case events, only the clock moved. The whole point.
    const unchanged = item({ dueAt: NOON + 40 * DAY })
    const esc = materialEscalation(getDb(), 'personal', unchanged, ledgerFor(unchanged), NOON)
    expect(esc.escalated).toBe(false)
    expect(esc.what).toBeNull()
  })

  it('D) suppressed OVERDUE + merely older -> stays silent', () => {
    const overdue = item({ dueAt: NOON - 10 * DAY })
    const prev = ledgerFor(overdue)
    expect(materialEscalation(getDb(), 'personal', overdue, prev, NOON).escalated).toBe(false)
    // ...and still silent a week later, or "not yet" is only a slower yes.
    expect(materialEscalation(getDb(), 'personal', overdue, prev, NOON + 7 * DAY).escalated).toBe(false)
  })

  it('E) a suppressed item OUTSIDE the top-N with a real escalation is still found', () => {
    // Eligibility must not depend on rank. The unit half; the reader half is in
    // intelligence-reader.test.ts, where the item is buried under a backlog.
    caseEvent(NOON - HOUR, 'STATUS_CHANGED', 'waiting on the vendor became his decision')
    const esc = materialEscalation(
      getDb(), 'personal', item({ dueAt: NOON + HOUR }), ledgerFor(item({ dueAt: null })), NOON)
    expect(esc.escalated).toBe(true)
    expect(esc.what).toContain('became his decision')
  })
})

describe('what counts, and what refuses to count', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: crossing INTO the actionable window is material, and fires ONCE', () => {
    // The one place time legitimately escalates, named by the owner. It is a
    // crossing, and the far side is recomputed rather than stored -- so it
    // stops firing once we have spoken from inside the window.
    const near = item({ dueAt: NOON + 15 * HOUR })
    const night = Date.UTC(2027, 0, 15, 21, 30, 0) / 1000
    const first = materialEscalation(getDb(), 'personal', near, ledgerFor(near, NOON - 6 * HOUR), night)
    expect(first.escalated).toBe(true)
    expect(first.what).toContain('window where acting is still possible')

    const spokenFromInside = ledgerFor(near, night)
    expect(materialEscalation(getDb(), 'personal', near, spokenFromInside, night + HOUR).escalated,
      'it must not keep firing once delivered from inside the window').toBe(false)
  })

  it('a band FALLING is not an escalation, only a band rising', () => {
    // The fingerprint hashes band + statement, so a band change moves it in
    // BOTH directions. Isolating the statement is what keeps a fall quiet.
    const fell = materialEscalation(getDb(), 'personal',
      item({ dueAt: null }, 'INFORMATIONAL'), ledgerFor(item({ dueAt: null }, 'SAFETY')), NOON)
    expect(fell.escalated).toBe(false)

    const rose = materialEscalation(getDb(), 'personal',
      item({ dueAt: null }, 'SAFETY'), ledgerFor(item({ dueAt: null }, 'INFORMATIONAL')), NOON)
    expect(rose.escalated).toBe(true)
    expect(rose.what).toContain('band rose')
  })

  it('an event from BEFORE the last delivery is not news', () => {
    // It was already accounted for when we spoke; counting it again would
    // redeliver on history.
    caseEvent(LAST_SPOKE - HOUR, 'STATUS_CHANGED', 'old news')
    const unchanged = item({ dueAt: null })
    expect(materialEscalation(getDb(), 'personal', unchanged, ledgerFor(unchanged), NOON).escalated)
      .toBe(false)
  })

  it('a never-delivered item is not an escalation question at all', () => {
    expect(materialEscalation(getDb(), 'personal', item({ dueAt: NOON + HOUR }), undefined, NOON))
      .toEqual({ escalated: false, what: null })
  })

  it('every escalation says WHAT changed, never just that something did', () => {
    caseEvent(NOON - HOUR, 'STATUS_CHANGED', 'the supplier confirmed the date')
    const esc = materialEscalation(
      getDb(), 'personal', item({ dueAt: NOON + HOUR }), ledgerFor(item({ dueAt: null })), NOON)
    expect(esc.what).toBeTruthy()
    expect(esc.what!.length).toBeGreaterThan(20)
    expect(esc.what).toContain('supplier confirmed')
  })

  it('the ledger holds NO case state -- the guard that sent this design back', () => {
    initDatabase(':memory:')
    const cols = (getDb().prepare(`PRAGMA table_info("intelligence_surfaced")`).all() as Array<{ name: string }>)
      .map((c) => c.name).sort()
    expect(cols).toEqual([
      'band', 'element_id', 'fingerprint',
      // Which recipe produced `fingerprint`. It describes OUR digest, not the
      // case -- delete every row and the reader repeats itself once, which is
      // the same test the exemption has always had to pass.
      'fingerprint_algo',
      'first_surfaced_at',
      'last_surfaced_at', 'namespace', 'times_surfaced',
    ])
  })
})
