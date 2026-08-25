import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { recordTemporalFact } from '../cos/temporal-facts.js'
import { evaluateCaseTemporalConsistency } from '../cos/temporal-consistency-gate.js'

function dbWithCase(nextAction: string): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE personal_cases (
      case_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      next_action TEXT
    )
  `)
  db.prepare(`INSERT INTO personal_cases(case_id,title,description,next_action) VALUES(?,?,?,?)`)
    .run('PRI-HERTZ-SIXT', 'Valencia autóbérlés', null, nextAction)
  return db
}

describe('runtime Temporal Semantic Consistency Gate', () => {
  it('does not freeze a legacy case that has no explicit binding semantic date', () => {
    const db = dbWithCase('Ellenőrizd a foglalás visszaigazolását')
    try {
      expect(evaluateCaseTemporalConsistency(db, 'personal', 'PRI-HERTZ-SIXT', 1_723_800_000).allowProgression)
        .toBe(true)
    } finally { db.close() }
  })

  it('blocks the Hertz/Sixt class when a decision deadline exists only in prose', () => {
    const db = dbWithCase('DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt')
    try {
      recordTemporalFact(db, {
        factId: 'pickup', domain: 'personal', caseId: 'PRI-HERTZ-SIXT',
        kind: 'BOOKING_START', occursAt: Date.UTC(2026, 7, 18, 9, 0) / 1000,
        sourceSystem: 'booking', sourceReference: 'sixt-confirmation',
        verification: 'VERIFIED', confidence: 1,
      }, Date.UTC(2026, 7, 15) / 1000)
      const r = evaluateCaseTemporalConsistency(
        db, 'personal', 'PRI-HERTZ-SIXT', Date.UTC(2026, 7, 16, 7, 0) / 1000,
      )
      expect(r.allowProgression).toBe(false)
      expect(r.status).toBe('TEMPORAL_MISSING')
      expect(r.missingKinds).toContain('DECISION_DUE')
    } finally { db.close() }
  })

  it('does not accept a verified fact of the right kind at the wrong time', () => {
    const db = dbWithCase('DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt')
    try {
      recordTemporalFact(db, {
        factId: 'wrong-decision', domain: 'personal', caseId: 'PRI-HERTZ-SIXT',
        kind: 'DECISION_DUE', occursAt: Date.UTC(2026, 7, 18, 10, 0) / 1000,
        sourceSystem: 'manual', sourceReference: 'wrong-date',
        verification: 'VERIFIED', confidence: 1,
      }, Date.UTC(2026, 7, 15) / 1000)
      const r = evaluateCaseTemporalConsistency(
        db, 'personal', 'PRI-HERTZ-SIXT', Date.UTC(2026, 7, 16, 7, 0) / 1000,
      )
      expect(r.allowProgression).toBe(false)
      expect(r.status).toBe('TEMPORAL_MISSING')
      expect(r.blockingFactIds).toContain('wrong-decision')
    } finally { db.close() }
  })

  it('allows the decision only when semantic kind and occurrence both match', () => {
    const db = dbWithCase('DONTES 2026-08-16 10:00 elott: Hertz VAGY Sixt')
    try {
      recordTemporalFact(db, {
        factId: 'decision-ok', domain: 'personal', caseId: 'PRI-HERTZ-SIXT',
        kind: 'DECISION_DUE', occursAt: Date.UTC(2026, 7, 16, 10, 0) / 1000,
        sourceSystem: 'owner-plan', sourceReference: 'rental-decision',
        verification: 'VERIFIED', confidence: 1,
      }, Date.UTC(2026, 7, 15) / 1000)
      const r = evaluateCaseTemporalConsistency(
        db, 'personal', 'PRI-HERTZ-SIXT', Date.UTC(2026, 7, 16, 7, 0) / 1000,
      )
      expect(r.allowProgression).toBe(true)
      expect(r.status).toBe('TEMPORAL_OK')
    } finally { db.close() }
  })
})
