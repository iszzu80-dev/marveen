import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Codex review P2-OFFICE-004, and it was right: the candidate CLAIMED that an
// unsupported container records EXTRACTION_UNSUPPORTED and that a second run
// changes nothing, while every supplied case exercised `officeText()` only. A
// persistence claim with no executable evidence is a claim, not a result.
//
// WHAT THIS DOES AND DOES NOT COVER, so the next reader is not misled: it
// exercises the WRITE GUARD the script uses -- the same statement, against a
// real SQLite table -- and proves the idempotence property that guard exists
// for. It does not drive the whole script end to end; that needs a seeded
// document store and is a separate piece of work. The extractor's own
// behaviour is covered in cos-office-text.test.ts.

/** The exact statement scripts/cos-extract-text-documents.ts runs for an
 *  unsupported container. Kept verbatim: a paraphrase would test a statement
 *  nobody ships. */
const UNSUPPORTED_WRITE = `
  UPDATE cos_documents SET extraction_state='EXTRACTION_UNSUPPORTED', extraction_note=?,
         extraction_attempted_at=?, updated_at=?
   WHERE document_id = ? AND extraction_state <> 'EXTRACTION_UNSUPPORTED'`

describe('extraction persistence: an unsupported container settles once', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`CREATE TABLE cos_documents (
      document_id TEXT PRIMARY KEY,
      extracted_text TEXT,
      extraction_state TEXT,
      extraction_note TEXT,
      extraction_attempted_at INTEGER,
      updated_at INTEGER
    )`)
    db.prepare(
      `INSERT INTO cos_documents (document_id, extraction_state, updated_at) VALUES ('doc-1','NOT_ATTEMPTED',1000)`,
    ).run()
  })

  it('records EXTRACTION_UNSUPPORTED rather than leaving it as NOT_ATTEMPTED', () => {
    // The defect this replaced: an unsupported archive produced empty text,
    // classified as NOT_ATTEMPTED, and so looked like a document nobody had got
    // to yet rather than one we have no reader for.
    const r = db.prepare(UNSUPPORTED_WRITE).run('no reader for this container', 2000, 2000, 'doc-1')
    expect(r.changes).toBe(1)
    const row = db.prepare('SELECT * FROM cos_documents WHERE document_id=?').get('doc-1') as
      { extraction_state: string; extraction_note: string; updated_at: number }
    expect(row.extraction_state).toBe('EXTRACTION_UNSUPPORTED')
    expect(row.extraction_note).toContain('no reader')
    expect(row.updated_at).toBe(2000)
  })

  it('HEADLINE: a second identical run writes NOTHING and moves no timestamp', () => {
    db.prepare(UNSUPPORTED_WRITE).run('no reader for this container', 2000, 2000, 'doc-1')
    const before = db.prepare('SELECT * FROM cos_documents WHERE document_id=?').get('doc-1') as
      { extraction_attempted_at: number; updated_at: number }

    const second = db.prepare(UNSUPPORTED_WRITE).run('no reader for this container', 9999, 9999, 'doc-1')

    expect(second.changes).toBe(0)
    const after = db.prepare('SELECT * FROM cos_documents WHERE document_id=?').get('doc-1') as
      { extraction_attempted_at: number; updated_at: number }
    // Not merely "the state is still right" -- the TIMESTAMPS must not move.
    // A row rewritten with a fresh timestamp on every pass is how an unbuilt
    // reader looks like continuous activity.
    expect(after.extraction_attempted_at).toBe(before.extraction_attempted_at)
    expect(after.updated_at).toBe(before.updated_at)
  })

  it('a document that later BECOMES readable is not blocked by the guard', () => {
    // The guard must not turn UNSUPPORTED into a trap. Once a reader exists,
    // the ordinary extraction path targets NOT_ATTEMPTED rows, so re-attempting
    // is a deliberate act rather than something the guard silently prevents.
    db.prepare(UNSUPPORTED_WRITE).run('no reader', 2000, 2000, 'doc-1')
    const reset = db.prepare(
      `UPDATE cos_documents SET extraction_state='NOT_ATTEMPTED' WHERE document_id=?`,
    ).run('doc-1')
    expect(reset.changes).toBe(1)
    const again = db.prepare(UNSUPPORTED_WRITE).run('no reader', 3000, 3000, 'doc-1')
    expect(again.changes).toBe(1)
  })

  it('the guard is scoped to ONE document and does not touch its neighbours', () => {
    db.prepare(
      `INSERT INTO cos_documents (document_id, extraction_state, updated_at) VALUES ('doc-2','NOT_ATTEMPTED',1000)`,
    ).run()
    db.prepare(UNSUPPORTED_WRITE).run('no reader', 2000, 2000, 'doc-1')
    const other = db.prepare('SELECT * FROM cos_documents WHERE document_id=?').get('doc-2') as
      { extraction_state: string; updated_at: number }
    expect(other.extraction_state).toBe('NOT_ATTEMPTED')
    expect(other.updated_at).toBe(1000)
  })
})
