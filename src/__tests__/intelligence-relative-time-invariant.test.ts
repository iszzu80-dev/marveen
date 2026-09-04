// RELATIVE TIME IS PRESENTATION, NOT CHANGE EVIDENCE.
//
// Standing invariant, owner ruling 2026-09-04, recorded after the ageing defect:
//
//   CANONICAL state/evidence  -> an absolute timestamp or date.
//   DERIVED presentation      -> "N days ago", "today", "N hours old", "overdue
//                                by N days".
//
//   Relative time may NOT enter a semantic/change fingerprint, may NOT produce a
//   CHANGED trigger on its own, may NOT count as a material escalation, and must
//   be computed at RENDER time from the absolute fact.
//
// Enforced behaviourally rather than by grepping for words. The property that
// matters is not "no digits in the sentence" -- it is that the SAME underlying
// row, evaluated at two different moments, is the same thing. A regex would pass
// a producer that encoded the age some other way; this cannot.
//
// This is the general form of the bug measured on the live ZST board: unchanged
// 26-day-old cases announcing themselves as CHANGED every single day, because
// the rendered age was inside the fingerprinted statement.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { caseAttentionFor, caseAttentionToAttention } from '../cos/intelligence/case-attention.js'
import { fingerprintOf, materialEscalation, type LedgerRow, FINGERPRINT_ALGO} from '../cos/intelligence/reader.js'
import type { AttentionItem } from '../cos/intelligence/attention.js'

const DAY = 86_400
const T0 = Date.UTC(2027, 0, 15, 11, 0, 0) / 1000

/** The same unchanged row, seen from several later vantage points. */
const VANTAGES: Array<[string, number]> = [
  ['same day', T0],
  ['next calendar day', T0 + DAY],
  ['a week later', T0 + 7 * DAY],
  ['a month later', T0 + 30 * DAY],
  ['a year later', T0 + 365 * DAY],
]

function row(over: Record<string, unknown> = {}) {
  return {
    case_id: 'c1', title: 'valami regi', description: null, case_type: 'GENERAL_OPERATION',
    status: 'NEW', next_action: null, blocked_reason: null, due_at: null, waiting_on: null,
    related_document_ids: null, created_at: T0 - 30 * DAY, updated_at: T0 - 30 * DAY, ...over,
  }
}

const itemAt = (now: number, over: Record<string, unknown> = {}): AttentionItem | null => {
  const a = caseAttentionFor(row(over) as never, 'zst', now)
  return a ? caseAttentionToAttention(a, now) : null
}

describe('the same unchanged case is the same thing whenever you look at it', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: the fingerprint is identical from every vantage point', () => {
    const seen = new Map<string, string>()
    for (const [label, now] of VANTAGES) {
      const it0 = itemAt(now)
      expect(it0, `${label}: expected an attention item`).not.toBeNull()
      seen.set(label, fingerprintOf(it0!))
    }
    const distinct = new Set(seen.values())
    expect(distinct.size, `fingerprints drifted with time: ${JSON.stringify([...seen])}`).toBe(1)
  })

  it('...and the STATEMENT is identical too, since that is what gets hashed', () => {
    const statements = new Set(VANTAGES.map(([, now]) => itemAt(now)!.element.statement))
    expect(statements.size).toBe(1)
    expect([...statements][0]).toMatch(/since \d{4}-\d{2}-\d{2}/)
  })

  it('HEADLINE: no CHANGED trigger and no material escalation, ever', () => {
    // The two consumers of the fingerprint, asked directly. Either one firing on
    // ageing alone is the defect, whatever the sentence looks like.
    const first = itemAt(T0)!
    const prev: LedgerRow = {
      element_id: first.element.id, band: first.band, fingerprint: fingerprintOf(first),
      first_surfaced_at: T0, last_surfaced_at: T0, times_surfaced: 4,
      fingerprint_algo: FINGERPRINT_ALGO,
    }
    for (const [label, now] of VANTAGES.slice(1)) {
      const later = itemAt(now)!
      expect(fingerprintOf(later), `${label}: CHANGED trigger`).toBe(prev.fingerprint)
      const esc = materialEscalation(getDb(), 'zst', later, prev, now)
      expect(esc.escalated, `${label}: material escalation from ageing alone`).toBe(false)
    }
  })

  it('MIRROR: a case that actually changes DOES move its fingerprint', () => {
    // Without this the invariant is satisfied by a producer that never says
    // anything at all -- silence passing as stability.
    const before = itemAt(T0)!
    // Still stale (past STALE_AFTER), but touched on a DIFFERENT day -- a
    // three-day-old case produces no item at all, which would have made this
    // mirror pass on a null instead of on a difference.
    const touched = itemAt(T0, { updated_at: T0 - 20 * DAY })!
    expect(fingerprintOf(touched)).not.toBe(fingerprintOf(before))
  })

  it('the OVERDUE path carries the deadline, not the days since it passed', () => {
    // "a stated deadline passed N days ago" is the same defect in the other
    // branch: N grows nightly and the sentence would drift with it.
    const overdue = itemAt(T0, { status: 'READY', due_at: T0 - 10 * DAY })
    expect(overdue, 'expected an EXPLICIT_DEADLINE_PASSED item').not.toBeNull()
    const later = itemAt(T0 + 20 * DAY, { status: 'READY', due_at: T0 - 10 * DAY })!
    expect(fingerprintOf(later), 'the overdue sentence drifted with the clock')
      .toBe(fingerprintOf(overdue!))
  })
})
