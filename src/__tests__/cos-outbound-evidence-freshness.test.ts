import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { assertOutboundEvidenceFresh, evaluateOutboundEvidenceFreshness } from '../cos/outbound-evidence-freshness.js'

function schema(db: Database.Database, domain: 'personal' | 'zst'): void {
  const ledger = domain === 'personal' ? 'outbound_ledger' : 'zst_outbound_ledger'
  const cases = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const events = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
  db.exec(`
    CREATE TABLE ${cases} (case_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE ${ledger} (
      ledger_id TEXT PRIMARY KEY, case_id TEXT, case_version INTEGER,
      status TEXT NOT NULL, action_type TEXT NOT NULL
    );
    CREATE TABLE ${events} (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL,
      event_type TEXT NOT NULL, source_reference TEXT, created_at INTEGER NOT NULL
    );
  `)
}

function freshFixture(domain: 'personal' | 'zst'): Database.Database {
  const db = new Database(':memory:')
  schema(db, domain)
  const ledger = domain === 'personal' ? 'outbound_ledger' : 'zst_outbound_ledger'
  const cases = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const events = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
  db.prepare(`INSERT INTO ${cases} VALUES ('C-1',3)`).run()
  db.prepare(`INSERT INTO ${ledger} VALUES ('L-1','C-1',3,'PLANNED','EMAIL_SEND')`).run()
  db.prepare(`INSERT INTO ${events}(case_id,event_type,source_reference,created_at) VALUES(?,?,?,?)`)
    .run('C-1', 'OUTBOUND_DRAFTED', 'L-1', 100)
  return db
}

describe.each(['personal', 'zst'] as const)('%s outbound evidence freshness', (domain) => {
  it('accepts first delivery when case version and event stream equal the draft horizon', () => {
    const db = freshFixture(domain)
    try {
      const r = evaluateOutboundEvidenceFreshness(db, domain, 'L-1')
      expect(r.status).toBe('FRESH')
      expect(r.fresh).toBe(true)
      expect(() => assertOutboundEvidenceFresh(db, domain, 'L-1')).not.toThrow()
    } finally { db.close() }
  })

  it('blocks any later case event, including one with the same timestamp', () => {
    const db = freshFixture(domain)
    try {
      const events = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
      db.prepare(`INSERT INTO ${events}(case_id,event_type,source_reference,created_at) VALUES(?,?,?,?)`)
        .run('C-1', 'OWNER_INFORMATION', 'owner', 100)
      const r = evaluateOutboundEvidenceFreshness(db, domain, 'L-1')
      expect(r.status).toBe('STALE')
      expect(r.reason).toMatch(/new case event/i)
      expect(() => assertOutboundEvidenceFresh(db, domain, 'L-1'))
        .toThrow(/OUTBOUND_EVIDENCE_FRESHNESS: STALE/)
    } finally { db.close() }
  })

  it('blocks a case-version move even without a later event', () => {
    const db = freshFixture(domain)
    try {
      const cases = domain === 'personal' ? 'personal_cases' : 'zst_cases'
      db.prepare(`UPDATE ${cases} SET version=4 WHERE case_id='C-1'`).run()
      expect(evaluateOutboundEvidenceFreshness(db, domain, 'L-1').reason).toMatch(/version moved/i)
    } finally { db.close() }
  })

  it('fails closed for a legacy draft with no OUTBOUND_DRAFTED evidence horizon', () => {
    const db = freshFixture(domain)
    try {
      const events = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
      db.prepare(`DELETE FROM ${events}`).run()
      const r = evaluateOutboundEvidenceFreshness(db, domain, 'L-1')
      expect(r.status).toBe('UNKNOWN')
      expect(r.fresh).toBe(false)
    } finally { db.close() }
  })

  it('does not block recovery/settlement states that create no new delivery', () => {
    const db = freshFixture(domain)
    try {
      const ledger = domain === 'personal' ? 'outbound_ledger' : 'zst_outbound_ledger'
      db.prepare(`UPDATE ${ledger} SET status='OUTCOME_UNKNOWN' WHERE ledger_id='L-1'`).run()
      const r = evaluateOutboundEvidenceFreshness(db, domain, 'L-1')
      expect(r.status).toBe('NOT_APPLICABLE')
      expect(r.fresh).toBe(true)
    } finally { db.close() }
  })
})
