// BACKFILL: the links that already existed, moved to where they can be read.
//
// Every relation this pass writes is EXPLICIT_RELATION -- it is copied from a
// stored field, not inferred from meaning. Nothing here guesses, so nothing
// here produces a CANDIDATE. That is deliberate: the first job is to stop
// losing links we already have, and mixing it with a semantic pass would make
// the resulting numbers impossible to read.
//
// WHAT IT FOUND, measured on the live store before it was written (2026-09-03):
//   - 21 cases carry 55 Gmail thread ids inside the free-text `source_references`
//     blob left by the Sheet migration, and 21 of those cases have an EMPTY
//     `gmail_thread_ids` column. One of them, PRI-HOME-2026-005, holds its two
//     threads in a single SEMICOLON-JOINED string.
//   - `email_processing` knows 60 (case, thread) pairs; the case column knows 59;
//     they are not the same 59.
// The data was never missing. It was in four places, none of which was the one
// place a reader looks.

import type Database from 'better-sqlite3'
import { linkCaseSource, type CaseNamespace, type CaseSourceType, type LinkCaseSourceResult } from './case-sources.js'

/** A Gmail thread/message id as Gmail actually writes them: lowercase hex.
 *
 *  This matters most for the free-text blob, where a `email_thread_ids` entry
 *  can be anything a spreadsheet cell can hold. An entry that does not look
 *  like an id is REPORTED as unrecognised rather than linked -- a link to a
 *  malformed ref is worse than a missing one, because it reads as a fact. */
const GMAIL_ID = /^[0-9a-f]{12,20}$/

/** The blob's list fields hold several ids in one cell, joined by whatever the
 *  person typed. Splitting on any of these is safe because none can occur
 *  inside a Gmail id. */
const splitRefs = (s: string): string[] => String(s).split(/[;,\s|]+/).map((x) => x.trim()).filter(Boolean)

export interface BackfillCounts {
  created: number
  unchanged: number
  upgraded: number
  heldByRejection: number
  /** Refs found in a stored field that do NOT look like the identifier they
   *  claim to be. Not linked; listed so they can be looked at. */
  unrecognised: { caseId: string; field: string; value: string }[]
  /** Per-source-field tally, so "where did the links come from" is answerable
   *  from the run itself rather than by re-deriving it later. */
  bySource: Record<string, number>
}

export interface BackfillOptions {
  /** Report what it would write, write nothing. */
  dryRun?: boolean
  discoveredBy?: string
}

const emptyCounts = (): BackfillCounts => ({
  created: 0, unchanged: 0, upgraded: 0, heldByRejection: 0, unrecognised: [], bySource: {},
})

function tally(c: BackfillCounts, source: string, r: LinkCaseSourceResult): void {
  if (r.outcome === 'CREATED') c.created++
  else if (r.outcome === 'UNCHANGED') c.unchanged++
  else if (r.outcome === 'UPGRADED') c.upgraded++
  else c.heldByRejection++
  c.bySource[source] = (c.bySource[source] ?? 0) + 1
}

interface CaseRow {
  case_id: string
  gmail_thread_ids: string | null
  source_references: string | null
  calendar_event_ids: string | null
  related_document_ids: string | null
  related_case_ids: string | null
  parent_case_id: string | null
}

const parseJsonArray = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch { return [] }
}

/**
 * Copy every explicit case-to-source relation in the store into `case_sources`.
 *
 * Idempotent by construction: link ids are derived from (namespace, case, type,
 * ref), so a second run reports UNCHANGED and writes nothing new. Safe to run
 * on a schedule.
 */
export function backfillCaseSources(
  db: Database.Database, namespace: CaseNamespace, now: number, opts: BackfillOptions = {},
): BackfillCounts {
  const counts = emptyCounts()
  const by = opts.discoveredBy ?? 'cos-backfill-case-sources'
  const caseTable = namespace === 'personal' ? 'personal_cases' : 'zst_cases'

  const link = (
    caseId: string, sourceType: CaseSourceType, sourceRef: string, evidence: string, source: string,
  ): void => {
    if (opts.dryRun) {
      // A dry run must still say what it WOULD do, and the honest way to do
      // that is to ask the same question the writer asks: does this row exist
      // already? Anything else reports a fresh number on every run.
      const existing = db.prepare(
        `SELECT link_state FROM case_sources
          WHERE namespace=? AND case_id=? AND source_type=? AND source_ref=?`,
      ).get(namespace, caseId, sourceType, sourceRef) as { link_state: string } | undefined
      tally(counts, source, {
        linkId: '', state: 'CANONICAL',
        outcome: !existing ? 'CREATED'
          : existing.link_state === 'CANONICAL' ? 'UNCHANGED'
            : existing.link_state === 'CANDIDATE' ? 'UPGRADED' : 'UPGRADED',
      })
      return
    }
    tally(counts, source, linkCaseSource(db, {
      namespace, caseId, sourceType, sourceRef,
      linkMethod: 'EXPLICIT_RELATION', evidence, discoveredBy: by,
    }, now))
  }

  const cases = db.prepare(
    `SELECT case_id, gmail_thread_ids, source_references, calendar_event_ids,
            related_document_ids, related_case_ids, parent_case_id
       FROM ${caseTable}`,
  ).all() as CaseRow[]

  for (const c of cases) {
    // 1. The canonical column, such as it is.
    for (const t of parseJsonArray(c.gmail_thread_ids)) {
      if (!GMAIL_ID.test(t)) { counts.unrecognised.push({ caseId: c.case_id, field: 'gmail_thread_ids', value: t }); continue }
      link(c.case_id, 'GMAIL_THREAD', t, `${caseTable}.gmail_thread_ids`, 'case.gmail_thread_ids')
    }
    for (const e of parseJsonArray(c.calendar_event_ids)) {
      link(c.case_id, 'CALENDAR_EVENT', e, `${caseTable}.calendar_event_ids`, 'case.calendar_event_ids')
    }
    for (const d of parseJsonArray(c.related_document_ids)) {
      link(c.case_id, 'DOCUMENT', d, `${caseTable}.related_document_ids`, 'case.related_document_ids')
    }
    for (const r of parseJsonArray(c.related_case_ids)) {
      link(c.case_id, 'CASE', r, `${caseTable}.related_case_ids`, 'case.related_case_ids')
    }
    if (c.parent_case_id) {
      link(c.case_id, 'CASE', c.parent_case_id, `${caseTable}.parent_case_id`, 'case.parent_case_id')
    }

    // 2. THE SHEET-MIGRATION BLOB. This is where most of the missing links are.
    if (c.source_references && c.source_references.trim().startsWith('{')) {
      let blob: Record<string, unknown> | undefined
      try { blob = JSON.parse(c.source_references) as Record<string, unknown> } catch { blob = undefined }
      if (blob) {
        for (const entry of (Array.isArray(blob.email_thread_ids) ? blob.email_thread_ids : []) as unknown[]) {
          for (const t of splitRefs(String(entry))) {
            if (!GMAIL_ID.test(t)) {
              counts.unrecognised.push({ caseId: c.case_id, field: 'source_references.email_thread_ids', value: t })
              continue
            }
            link(c.case_id, 'GMAIL_THREAD', t,
              `${caseTable}.source_references JSON, email_thread_ids entry ${JSON.stringify(String(entry))}`,
              'sheet_blob.email_thread_ids')
          }
        }
        for (const entry of (Array.isArray(blob.calendar_event_ids) ? blob.calendar_event_ids : []) as unknown[]) {
          for (const e of splitRefs(String(entry))) {
            link(c.case_id, 'CALENDAR_EVENT', e,
              `${caseTable}.source_references JSON, calendar_event_ids`, 'sheet_blob.calendar_event_ids')
          }
        }
        if (typeof blob.drive_folder_url === 'string' && blob.drive_folder_url.startsWith('http')) {
          link(c.case_id, 'EXTERNAL_URL', blob.drive_folder_url,
            `${caseTable}.source_references JSON, drive_folder_url`, 'sheet_blob.drive_folder_url')
        }
      }
    }
  }

  // 3. THE MESSAGE LEDGER. `email_processing` records which message reached
  //    which case -- a relation the case row never gets told about after the
  //    one message that created it.
  if (namespace === 'personal') {
    const msgs = db.prepare(
      `SELECT case_id, thread_id, message_id FROM email_processing
        WHERE case_id IS NOT NULL`,
    ).all() as { case_id: string; thread_id: string | null; message_id: string }[]
    for (const m of msgs) {
      if (m.thread_id && GMAIL_ID.test(m.thread_id)) {
        link(m.case_id, 'GMAIL_THREAD', m.thread_id,
          `email_processing row (message ${m.message_id}) carries case_id`, 'email_processing.thread')
      }
      if (GMAIL_ID.test(m.message_id)) {
        link(m.case_id, 'GMAIL_MESSAGE', m.message_id,
          'email_processing row carries case_id', 'email_processing.message')
      }
    }

    // 4. WHAT WE SENT. The thread our own letter created or landed in.
    const sent = db.prepare(
      `SELECT case_id, thread_ref FROM outbound_ledger
        WHERE case_id IS NOT NULL AND thread_ref IS NOT NULL`,
    ).all() as { case_id: string; thread_ref: string }[]
    for (const s of sent) {
      if (!GMAIL_ID.test(s.thread_ref)) {
        counts.unrecognised.push({ caseId: s.case_id, field: 'outbound_ledger.thread_ref', value: s.thread_ref })
        continue
      }
      link(s.case_id, 'GMAIL_THREAD', s.thread_ref,
        'outbound_ledger: we sent into this thread from this case', 'outbound_ledger.thread_ref')
    }
  }

  // 5. DOCUMENTS, which already carry their case.
  const docs = db.prepare(
    `SELECT document_id, case_id FROM cos_documents WHERE namespace=? AND case_id IS NOT NULL`,
  ).all(namespace) as { document_id: string; case_id: string }[]
  for (const d of docs) {
    link(d.case_id, 'DOCUMENT', d.document_id, 'cos_documents.case_id', 'cos_documents.case_id')
  }

  // 6. RESEARCH. A ticket is evidence the case was researched, and the answer
  //    is part of the dossier whether or not it changed anything.
  const research = db.prepare(
    `SELECT ticket_id, case_id FROM case_research_queries WHERE namespace=? AND status='EXECUTED'`,
  ).all(namespace) as { ticket_id: string; case_id: string }[]
  for (const r of research) {
    link(r.case_id, 'RESEARCH_RESULT', r.ticket_id, 'case_research_queries executed ticket', 'case_research_queries')
  }

  return counts
}

/** A CASE ID WRITTEN INTO A FILENAME IS A LINK, and it was being thrown away.
 *
 *  Measured on the live store 2026-09-03, in the pool cluster: SEVEN photos
 *  named `PRI-HOME-2026-005_20260621_medenceoldal_*` are stored against a
 *  DIFFERENT case (case-iszzu80-19fcbd3b431aa3c0), because `cos_documents`
 *  holds exactly one `case_id` and the row got the case the mail arrived on.
 *  The file's own name says which matter it documents. Asked for "all the
 *  photos of the pool case", the umbrella case could offer two of twenty-two.
 *
 *  This is a DETERMINISTIC_IDENTIFIER match, not a guess: the identifier is a
 *  case id from this store, matched whole. It is therefore canonical -- and it
 *  ADDS a link rather than moving anything. The document keeps the case its row
 *  names; the graph simply stops pretending that is the only case it belongs to.
 *
 *  Two guards against a false link, both mattering:
 *   - the id must match at a NON-ALPHANUMERIC boundary, so `PRI-HOME-2026-005`
 *     cannot claim a file named for `PRI-HOME-2026-0051`;
 *   - ids shorter than 8 characters are skipped entirely. A short id is the one
 *     that turns up inside an unrelated word or a hash, and a wrong canonical
 *     link is worse than a missing one because it reads as a fact.
 */
export function linkDocumentsByCaseIdentifier(
  db: Database.Database, namespace: CaseNamespace, now: number, opts: BackfillOptions = {},
): BackfillCounts {
  const counts = emptyCounts()
  const by = opts.discoveredBy ?? 'cos-doc-identifier-link'
  const caseTable = namespace === 'personal' ? 'personal_cases' : 'zst_cases'

  const caseIds = (db.prepare(`SELECT case_id FROM ${caseTable}`).all() as { case_id: string }[])
    .map((r) => r.case_id).filter((id) => id.length >= 8)
  // Longest first, so a case id that contains a shorter one is credited before
  // the shorter one gets a chance to match the same text.
  caseIds.sort((a, b) => b.length - a.length)

  const docs = db.prepare(
    `SELECT document_id, case_id, filename, source_ref FROM cos_documents WHERE namespace = ?`,
  ).all(namespace) as { document_id: string; case_id: string | null; filename: string | null; source_ref: string | null }[]

  const boundary = (haystack: string, needle: string): boolean => {
    let from = 0
    for (;;) {
      const i = haystack.indexOf(needle, from)
      if (i < 0) return false
      const before = i === 0 ? '' : haystack[i - 1]
      const after = haystack[i + needle.length] ?? ''
      const ok = (c: string) => c === '' || !/[A-Za-z0-9]/.test(c)
      if (ok(before) && ok(after)) return true
      from = i + 1
    }
  }

  for (const d of docs) {
    for (const field of ['filename', 'source_ref'] as const) {
      const text = d[field]
      if (!text) continue
      for (const caseId of caseIds) {
        if (!boundary(text, caseId)) continue
        // Already the document's own case: the row says it, nothing to add.
        if (d.case_id === caseId) continue
        if (opts.dryRun) {
          const existing = db.prepare(
            `SELECT link_state FROM case_sources
              WHERE namespace=? AND case_id=? AND source_type='DOCUMENT' AND source_ref=?`,
          ).get(namespace, caseId, d.document_id) as { link_state: string } | undefined
          tally(counts, `document.${field}`, {
            linkId: '', state: 'CANONICAL',
            outcome: !existing ? 'CREATED' : existing.link_state === 'CANONICAL' ? 'UNCHANGED' : 'UPGRADED',
          })
        } else {
          tally(counts, `document.${field}`, linkCaseSource(db, {
            namespace, caseId, sourceType: 'DOCUMENT', sourceRef: d.document_id,
            linkMethod: 'DETERMINISTIC_IDENTIFIER',
            evidence: `cos_documents.${field} ${JSON.stringify(text)} contains the case id ${caseId} `
              + `(the row itself is filed under ${d.case_id ?? 'no case'})`,
            discoveredBy: by,
          }, now))
        }
        // One case per field: the longest match wins, and a file naming two
        // cases in one filename is a case for a human, not for two links.
        break
      }
    }
  }
  return counts
}
