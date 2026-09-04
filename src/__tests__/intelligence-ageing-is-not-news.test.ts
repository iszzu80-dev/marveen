// AGEING IS NOT NEWS.
//
// The reader fingerprints `band + statement`, and the STALE_UNRESOLVED statement
// used to read "open and untouched for N days". N rose at every midnight, so the
// fingerprint moved with it and an item that had not changed in any way
// announced itself as NEWS every day -- for ever, and more insistently the
// longer nobody touched it.
//
// Measured on the live ZST board, 2026-09-04: three-item batches marked
// "valtozott" in cycle after cycle, all 26 days old, none of them changed.
//
// It is the owner's own rule inverted -- "Nem material escalation: pusztan az
// ido mulasa; az ugy puszta oregedese" -- because the ageing counter WAS the
// change signal. It defeated the cadence floor AND the material-escalation gate
// at once, since both ask whether the sentence changed.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { caseAttentionFor, caseAttentionToAttention } from '../cos/intelligence/case-attention.js'
import { fingerprintOf, materialEscalation, type LedgerRow } from '../cos/intelligence/reader.js'

const DAY = 86_400
const BASE = Date.UTC(2027, 0, 15, 11, 0, 0) / 1000

const staleRow = (updatedAt: number) => ({
  case_id: 'c1', title: 'egy regi ugy', description: null, case_type: 'GENERAL_OPERATION',
  status: 'NEW', next_action: null, blocked_reason: null, due_at: null, waiting_on: null,
  related_document_ids: null, created_at: updatedAt, updated_at: updatedAt,
})

const attentionAt = (now: number, updatedAt: number) => {
  const a = caseAttentionFor(staleRow(updatedAt) as never, 'zst', now)
  if (!a) throw new Error('expected a STALE_UNRESOLVED item')
  return caseAttentionToAttention(a, now)
}

describe('a case that merely gets older says the same thing', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('HEADLINE: the fingerprint does not move as the days pass', () => {
    const updatedAt = BASE - 26 * DAY
    const day26 = attentionAt(BASE, updatedAt)
    const day27 = attentionAt(BASE + DAY, updatedAt)
    const day40 = attentionAt(BASE + 14 * DAY, updatedAt)

    expect(day26.element.statement).toBe(day27.element.statement)
    expect(fingerprintOf(day26)).toBe(fingerprintOf(day27))
    expect(fingerprintOf(day26), 'still the same a fortnight later')
      .toBe(fingerprintOf(day40))
  })

  it('and it says WHEN, which a drifting count never could', () => {
    const a = attentionAt(BASE, BASE - 26 * DAY)
    expect(a.element.statement).toContain('since 2026-12-20')
    expect(a.element.statement, 'no rendered age anywhere in it').not.toMatch(/\d+ days/)
  })

  it('MIRROR: a case that actually MOVES does change its sentence', () => {
    // Without this, the headline is satisfied by a statement that never varies
    // at all, which would be a different bug wearing the same green.
    const older = attentionAt(BASE, BASE - 26 * DAY)
    const touched = attentionAt(BASE, BASE - 20 * DAY)
    expect(fingerprintOf(older)).not.toBe(fingerprintOf(touched))
  })

  it('HEADLINE: ageing alone is not a material escalation', () => {
    // The end the whole thing is for. A suppressed stale item must not buy a
    // re-delivery just by surviving another midnight.
    const updatedAt = BASE - 26 * DAY
    const before = attentionAt(BASE, updatedAt)
    const prev: LedgerRow = {
      element_id: before.element.id, band: before.band, fingerprint: fingerprintOf(before),
      first_surfaced_at: BASE, last_surfaced_at: BASE, times_surfaced: 3,
    }
    const after = attentionAt(BASE + 3 * DAY, updatedAt)
    const esc = materialEscalation(getDb(), 'zst', after, prev, BASE + 3 * DAY)
    expect(esc.escalated).toBe(false)
    expect(esc.what).toBeNull()
  })
})
