import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { assertOwnerQuestionFreshForDelivery } from '../cos/owner-delivery-freshness.js'

function fixture(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE personal_cases (case_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE personal_case_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      source_reference TEXT
    );
    CREATE TABLE case_evidence_packets (
      packet_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      case_id TEXT NOT NULL,
      progression_run_id TEXT,
      created_at INTEGER NOT NULL,
      packet_json TEXT
    );
    CREATE TABLE case_progression_runs (
      progression_run_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      case_id TEXT NOT NULL,
      status TEXT NOT NULL,
      case_version_after INTEGER
    );
    INSERT INTO personal_cases VALUES ('PRI-1', 1);
    INSERT INTO case_progression_runs VALUES ('run-1','personal','PRI-1','COMPLETED',1);
    INSERT INTO personal_case_events(case_id,created_at,source_reference)
      VALUES ('PRI-1',100,'run-1');
    INSERT INTO case_evidence_packets
      VALUES ('packet-1','personal','PRI-1','run-1',100,'{}');
  `)
  return db
}

describe('owner delivery evidence freshness', () => {
  it('allows delivery while case version and event stream equal the packet watermark', () => {
    const db = fixture()
    try {
      const w = assertOwnerQuestionFreshForDelivery(db, 'personal', 'PRI-1', 'run-1')
      expect(w.caseVersion).toBe(1)
      expect(w.evidenceMaxEventSeq).toBe(1)
    } finally { db.close() }
  })

  it('blocks an owner event that arrives later in the SAME second as the packet', () => {
    const db = fixture()
    try {
      // Same timestamp as packet, but not sourced from run-1. This reproduces
      // the second-granularity form of the real 37-second stale-question class.
      db.prepare(`INSERT INTO personal_case_events(case_id,created_at,source_reference) VALUES(?,?,?)`)
        .run('PRI-1', 100, 'owner-answer')
      expect(() => assertOwnerQuestionFreshForDelivery(db, 'personal', 'PRI-1', 'run-1'))
        .toThrow(/STALE_EVIDENCE.*event/i)
    } finally { db.close() }
  })

  it('blocks a case-version move even when no later event exists', () => {
    const db = fixture()
    try {
      db.prepare(`UPDATE personal_cases SET version=2 WHERE case_id='PRI-1'`).run()
      expect(() => assertOwnerQuestionFreshForDelivery(db, 'personal', 'PRI-1', 'run-1'))
        .toThrow(/STALE_EVIDENCE.*version/i)
    } finally { db.close() }
  })

  it('fails closed when the question has no evidence run identity', () => {
    const db = fixture()
    try {
      expect(() => assertOwnerQuestionFreshForDelivery(db, 'personal', 'PRI-1', null))
        .toThrow(/EVIDENCE_UNKNOWN/)
    } finally { db.close() }
  })
})
