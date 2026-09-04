// WALKING A DOSSIER FOR ITS SOURCES.
//
// A dossier is not one case. PRI-HOME-2026-005 holds the summary thread, and the
// live correspondence runs on two children -- the Piscinarium branch and the
// Fluidra/Kállai branch. Extracting from the parent alone would have produced a
// dossier readback with no Kállai evidence in it at all, which is the acceptance
// the owner named.
//
// EMAIL AND DOCUMENTS USE THE SAME CLAIM MODEL, owner requirement 2026-09-04.
// So this module's job is to turn every source, whatever its kind, into the same
// `{ text, from, timestamp }` shape and hand it to one extractor. A separate
// document path would have been a second definition of what a claim is, and the
// two would drift the way the invoice and contract extractors already did once
// in this repo.
//
// NO I/O LIVES HERE. Gmail bodies are fetched by the caller and passed in
// through `loadText`. That keeps the traversal testable against a real store
// without a network, keeps it local-first, and means a Gmail outage degrades
// this to "fewer sources read" rather than "traversal failed".

import type Database from 'better-sqlite3'

export interface DossierSource {
  sourceId: string
  sourceType: 'GMAIL_MESSAGE' | 'GMAIL_THREAD' | 'DOCUMENT' | 'CASE'
  /** Which case in the dossier carries this source. Recorded because a reader
   *  asking "where did this come from" usually means the branch, not the id. */
  viaCaseId: string
  /** Whether this case is the dossier root or one of its children. */
  viaRelation: 'ROOT' | 'CHILD'
}

/**
 * Every case in the dossier: the root plus its direct children.
 *
 * ONE LEVEL, deliberately. The pool dossier is two deep and a recursive walk
 * would be untested generality -- worse, an accidental cycle in `parent_case_id`
 * would hang the intake path. When a three-deep dossier actually appears, this
 * grows with a test that has one.
 */
export function dossierCases(
  db: Database.Database, namespace: 'personal' | 'zst', rootCaseId: string,
): Array<{ caseId: string; relation: 'ROOT' | 'CHILD' }> {
  const table = namespace === 'zst' ? 'zst_cases' : 'personal_cases'
  const root = db.prepare(`SELECT case_id FROM ${table} WHERE case_id = ?`)
    .get(rootCaseId) as { case_id: string } | undefined
  if (!root) return []
  const children = db.prepare(
    `SELECT case_id FROM ${table} WHERE parent_case_id = ? ORDER BY case_id`,
  ).all(rootCaseId) as Array<{ case_id: string }>
  return [
    { caseId: root.case_id, relation: 'ROOT' as const },
    ...children.map((c) => ({ caseId: c.case_id, relation: 'CHILD' as const })),
  ]
}

/**
 * Every CANONICAL source the dossier holds.
 *
 * Candidate links are not followed. A semantic candidate is a proposal that a
 * source might belong to a case, and reading it as a dossier member would let a
 * proposal put words in a dossier's mouth -- the same reason the router reads
 * canonical links only.
 */
export function dossierSources(
  db: Database.Database, namespace: 'personal' | 'zst', rootCaseId: string,
): DossierSource[] {
  const cases = dossierCases(db, namespace, rootCaseId)
  const out: DossierSource[] = []
  const seen = new Set<string>()
  for (const c of cases) {
    const rows = db.prepare(
      `SELECT source_type, source_ref FROM case_sources
        WHERE namespace = ? AND case_id = ? AND link_state = 'CANONICAL'
        ORDER BY source_type, source_ref`,
    ).all(namespace, c.caseId) as Array<{ source_type: string; source_ref: string }>
    for (const r of rows) {
      // A source can hang off both the parent and a child. It is ONE source, and
      // reading it twice would double every claim it carries.
      const key = `${r.source_type}:${r.source_ref}`
      if (seen.has(key)) continue
      seen.add(key)
      if (r.source_type === 'CALENDAR_EVENT' || r.source_type === 'EXTERNAL_URL') continue
      out.push({
        sourceId: r.source_ref,
        sourceType: r.source_type as DossierSource['sourceType'],
        viaCaseId: c.caseId,
        viaRelation: c.relation,
      })
    }
  }
  return out
}

export interface SourceText {
  text: string
  from?: string
  /** The source's own instant. */
  timestamp: number
  truncated?: boolean
}

/**
 * Text for a DOCUMENT source, read from the store.
 *
 * Returns null when the document holds no text -- an image with no OCR, or one
 * whose extraction never ran. That is not an error and must not be reported as
 * one: the pool dossier is mostly photographs of a damaged pool edge, and a
 * traversal that treated each of them as a failure would bury a real problem in
 * eighteen false ones.
 */
export function documentText(
  db: Database.Database, documentId: string,
): SourceText | null {
  const row = db.prepare(
    `SELECT extracted_text, filename, received_at, created_at, extraction_state
       FROM cos_documents WHERE document_id = ?`,
  ).get(documentId) as {
    extracted_text: string | null; filename: string | null
    received_at: number | null; created_at: number; extraction_state: string | null
  } | undefined
  if (!row) return null
  const text = row.extracted_text ?? ''
  if (!text.trim()) return null
  return {
    text,
    // A document has no envelope sender, so no VENDOR_IDENTITY claim can come
    // from it. Leaving `from` unset is what keeps the extractor from inventing
    // one out of a filename.
    timestamp: row.received_at ?? row.created_at,
  }
}
