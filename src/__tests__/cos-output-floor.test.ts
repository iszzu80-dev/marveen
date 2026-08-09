import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { openBatch, localApply, sourceCommit } from '../cos/email-ingest.js'
import {
  evaluateOutputFloors, breachedFloors, OUTPUT_FLOORS, type FloorSpec,
} from '../cos/output-floor.js'

// Output floors: the check that answers "did anything happen at all?".
//
// The point of these tests is NOT that the numbers add up. It is that every
// floor can go RED and can go GREEN — a floor that cannot fail is decoration,
// and a floor that cannot pass is a permanently-red light people learn to
// ignore. Both failure modes are what this module exists to prevent.

const NOW = 1_800_000_000
const ACC = 'iszzu80'

describe('COS output floors', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('an empty system is SILENT on every floor, never OK', () => {
    const results = evaluateOutputFloors(getDb(), NOW)
    expect(results).toHaveLength(OUTPUT_FLOORS.length)
    expect(results.every((r) => r.status === 'SILENT')).toBe(true)
    // and every breach carries the sentence that says what the zero means
    for (const r of breachedFloors(results)) {
      expect(r.meaning.length).toBeGreaterThan(20)
      expect(r.ref).toBeTruthy()
    }
  })

  it('the email→case floor goes GREEN once a message actually becomes a case', () => {
    const db = getDb()
    const before = evaluateOutputFloors(db, NOW).find((r) => r.id === 'email_to_case')!
    expect(before.status).toBe('SILENT')

    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
    openBatch(db, {
      batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'm1', threadId: 't1' }],
    }, NOW - 100)
    localApply(db, ACC, 'm1', 'c1', NOW - 100)

    const after = evaluateOutputFloors(db, NOW).find((r) => r.id === 'email_to_case')!
    expect(after.status).toBe('OK')
    expect(after.observed).toBe(1)
  })

  it('output OUTSIDE the window does not count — a floor measures now, not history', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
    openBatch(db, {
      batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'm1' }],
    }, NOW - 30 * 86400)          // a month ago
    localApply(db, ACC, 'm1', 'c1', NOW - 30 * 86400)

    const r = evaluateOutputFloors(db, NOW).find((x) => x.id === 'email_to_case')!
    expect(r.status).toBe('SILENT')
    expect(r.observed).toBe(0)
  })

  it('reproduces the 2026-08-09 shape: messages applied locally but never terminal', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'ADMIN' }, NOW - 100)
    openBatch(db, {
      batchId: 'b1', accountId: ACC, cursorBefore: null, cursorAfter: 'c1',
      messages: [{ messageId: 'm1' }],
    }, NOW - 100)
    localApply(db, ACC, 'm1', 'c1', NOW - 100)

    const results = evaluateOutputFloors(db, NOW)
    // intake looks alive...
    expect(results.find((r) => r.id === 'email_to_case')!.status).toBe('OK')
    // ...while the half of the chain that never runs is loudly silent
    expect(results.find((r) => r.id === 'message_terminal')!.status).toBe('SILENT')
    expect(results.find((r) => r.id === 'batch_closed')!.status).toBe('SILENT')

    sourceCommit(db, ACC, 'm1', NOW - 50)
    const fixed = evaluateOutputFloors(db, NOW)
    expect(fixed.find((r) => r.id === 'message_terminal')!.status).toBe('OK')
  })

  it('BELOW_FLOOR and SILENT are different, and SILENT sorts first', () => {
    const db = getDb()
    const specs: FloorSpec[] = [
      { id: 'low', label: 'L', windowSec: 86400, floor: 5, ref: 'test',
        meaning: 'kevesebb mint amennyi kellene, de nem nulla',
        measure: () => 2 },
      { id: 'zero', label: 'Z', windowSec: 86400, floor: 1, ref: 'test',
        meaning: 'egyáltalán semmi nem történt',
        measure: () => 0 },
      { id: 'fine', label: 'F', windowSec: 86400, floor: 1, ref: 'test',
        meaning: 'rendben', measure: () => 9 },
    ]
    const results = evaluateOutputFloors(db, NOW, specs)
    expect(results.find((r) => r.id === 'low')!.status).toBe('BELOW_FLOOR')
    expect(results.find((r) => r.id === 'zero')!.status).toBe('SILENT')
    expect(results.find((r) => r.id === 'fine')!.status).toBe('OK')

    const breached = breachedFloors(results)
    expect(breached.map((r) => r.id)).toEqual(['zero', 'low'])
  })

  it('every declared floor names what its zero means and which rule it defends', () => {
    for (const s of OUTPUT_FLOORS) {
      expect(s.meaning, `${s.id} needs a meaning`).toMatch(/[Nn]ulla/)
      expect(s.ref, `${s.id} needs a spec reference`).toBeTruthy()
      expect(s.floor).toBeGreaterThan(0)
      expect(s.windowSec).toBeGreaterThan(0)
    }
  })

  it('a missing table reports 0 rather than throwing — an undeployed pipeline is producing nothing', () => {
    const db = getDb()
    const specs: FloorSpec[] = [{
      id: 'ghost', label: 'G', windowSec: 86400, floor: 1, ref: 'test',
      meaning: 'nulla, mert a tábla sincs',
      measure: (d, since) => {
        try {
          return (d.prepare('SELECT COUNT(*) AS n FROM table_that_does_not_exist WHERE t >= ?').get(since) as { n: number }).n
        } catch { return 0 }
      },
    }]
    expect(() => evaluateOutputFloors(db, NOW, specs)).not.toThrow()
    expect(evaluateOutputFloors(db, NOW, specs)[0].status).toBe('SILENT')
  })
})
