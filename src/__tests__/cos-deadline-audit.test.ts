import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase, transitionCase } from '../cos/case-store.js'
import { auditProseDeadlines, describeDeadlineAudit } from '../cos/deadline-audit.js'

// The detector for deadlines that exist only as prose. Built after the live
// near miss: two car rentals whose next_action said "DONTES 2026-08-16 10:00
// elott" while due_at pointed at the pickup two days later, so every date-driven
// view was blind to the actual deadline.
//
// What these tests pin down is mostly what the detector must NOT do. It is a
// request to look, not a parser, and the failure mode that would kill it is
// noise: flag every case that mentions a date and it gets muted within a day.

const T0 = 1_700_000_000

describe('prose-only deadline audit', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function mk(id: string, nextAction: string | null, dates: Partial<Record<'due_at' | 'follow_up_at' | 'next_wake_at', number>> = {}) {
    const row = createCase(getDb(), { caseId: id, title: id, caseType: 'TRAVEL' }, T0)
    transitionCase(getDb(), {
      caseId: id, seenVersion: row.version, newStatus: 'READY', actor: 'test',
      patch: { next_action: nextAction, ...dates },
    }, T0 + 1)
  }

  it('finds a case that names a deadline while carrying no date at all', () => {
    mk('c1', 'DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt')
    const r = auditProseDeadlines(getDb())
    expect(r.proseOnly.map(c => c.caseId)).toEqual(['c1'])
    expect(r.proseOnly[0].quote).toContain('2026-08-16')
  })

  it('stays silent when the case carries a real timestamp — even the WRONG one', () => {
    // This is today's actual pair: the deadline was in prose AND due_at was set
    // (to the pickup, not the decision). Reporting these would mean six findings
    // every ten minutes, so the detector deliberately lets them pass. It catches
    // the total absence of a date, not the presence of a wrong one.
    mk('c2', 'DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt', { due_at: T0 + 86400 })
    expect(auditProseDeadlines(getDb()).proseOnly).toHaveLength(0)
  })

  it('needs BOTH a deadline word and a date-like token, not either alone', () => {
    mk('c3', 'Atvetel 2026-08-18 10:00, Valencia Train Station')   // date, no deadline word
    mk('c4', 'Meg kell hozni a dontest, amint lehet')              // deadline word, no date
    expect(auditProseDeadlines(getDb()).proseOnly).toHaveLength(0)
  })

  it('ignores closed cases — a lapsed deadline on a finished case is history', () => {
    mk('c5', 'DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt')
    const row = getDb().prepare('SELECT version FROM personal_cases WHERE case_id = ?').get('c5') as { version: number }
    transitionCase(getDb(), { caseId: 'c5', seenVersion: row.version, newStatus: 'CANCELLED', actor: 'test' }, T0 + 2)
    expect(auditProseDeadlines(getDb()).proseOnly).toHaveLength(0)
  })

  it('reports the zero out loud, with the number examined', () => {
    mk('c6', 'Atvetel 2026-08-18 10:00, Valencia Train Station')
    const lines = describeDeadlineAudit(auditProseDeadlines(getDb()))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1 nyitott ügy átnézve')
    expect(lines[0]).toContain('sincs csak-prózában élő határidő')
  })

  it('quotes the sentence, so the reader can judge the detector instead of trusting it', () => {
    mk('c7', 'Hatarido 2026-09-02: lemondani a probat')
    const lines = describeDeadlineAudit(auditProseDeadlines(getDb()))
    expect(lines[0]).toContain('Hatarido 2026-09-02')
  })
})
