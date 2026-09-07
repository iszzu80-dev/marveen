// Extract text from the documents whose bytes ARE the text.
//
// Measured 2026-09-02: the store holds 153 documents and exactly ONE had its
// text extracted. 58 of the rest are text/plain -- their content is a file read
// away, and the pre-question evidence gate could not see any of it, because the
// gate reads `extracted_text` and nothing had ever written it.
//
// The alternative was to teach the gate a second way to read a document. That
// would have put "how to get a document's text" in two places, and the two would
// drift exactly where nobody looks. One definition: extract once, store it,
// classify it with the same classifier every other consumer uses.
//
// Text-ish types AND PDF. The PDF half arrived 2026-09-06: measured on the live
// store, 48 of 236 documents were PDFs and NOT ONE carried text, so every one of
// them was invisible to the evidence gate, which reads `extracted_text`. The
// extractor is stdlib-only (`src/cos/pdf-text.ts`) because this host has no pip,
// no poppler and no pdftotext.
//
// An IMAGE still needs a real extractor and is still refused here. Guessing at
// one is what produced the 0.014-letter-ratio garbage this module exists to
// reject -- and the same classifier still decides, so a scanned PDF that yields
// nothing readable is recorded as low quality rather than stored as text.
import { initDatabase, getDb } from '../src/db.js'
import { mayMutate, EXIT_LIVE_MUTATION_REFUSED } from '../src/cos/live-store-guard.js'
import { readDocumentBytes } from '../src/cos/cos-documents.js'
import { classifyExtraction } from '../src/cos/document-extraction.js'
import { pdfText } from '../src/cos/pdf-text.js'
import { officeText } from '../src/cos/office-text.js'

const APPLY = process.argv.includes('--apply')
// WHICH DATABASE. `MARVEEN_DB` is the seam (the spelling w11-staging-migration-proof
// and w14-restore-drill already use); the default is still the live store, so
// nothing about an ordinary invocation changes. Before this the path was
// hardcoded, so a dry run against a clone was not possible -- which is how the
// 2026-09-06 live mutation happened with nowhere else to point it.
const DB_PATH = process.env.MARVEEN_DB ?? 'store/claudeclaw.db'
const verdict = mayMutate(DB_PATH, process.argv, APPLY)
if (!verdict.allowed) {
  console.error(JSON.stringify({ refused: true, ...verdict }, null, 1))
  process.exit(EXIT_LIVE_MUTATION_REFUSED)
}
initDatabase(DB_PATH)
const db = getDb()
const now = Math.floor(Date.now() / 1000)

const TEXTISH = (m: string): boolean =>
  m.startsWith('text/') || m === 'message/rfc822' || m === 'application/json'
  // An .ics is BEGIN:VCALENDAR in plain text; only its declared mime type made
  // it look binary. Verified by reading the stored bytes, not by assuming.
  || m === 'application/ics' || m === 'text/calendar'
const IS_PDF = (m: string): boolean => m === 'application/pdf'
// .docx and .xlsx are ZIP archives of XML. The legacy .doc is an OLE compound
// file -- a different format wearing a similar extension -- and is deliberately
// NOT claimed here.
const IS_OFFICE = (m: string): boolean =>
  m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  || m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const rows = db.prepare(
  `SELECT document_id, mime_type, filename FROM cos_documents
    WHERE extraction_state = 'NOT_ATTEMPTED' AND content_purged_at IS NULL`,
).all() as Array<{ document_id: string; mime_type: string; filename: string | null }>

const tally: Record<string, number> = {}
const samples: string[] = []
for (const r of rows) {
  const mime = String(r.mime_type ?? '')
  if (!TEXTISH(mime) && !IS_PDF(mime) && !IS_OFFICE(mime)) { tally.SKIPPED_NOT_TEXT = (tally.SKIPPED_NOT_TEXT ?? 0) + 1; continue }
  let text: string
  // A format we cannot read is a fact about US, and it has to survive into the
  // stored state. Codex review P2-OFFICE-001: dropping officeText().kind meant
  // an unsupported archive became empty text, classified NOT_ATTEMPTED, and
  // rewritten with fresh timestamps on EVERY run -- an unbuilt reader wearing
  // the state of a document nobody has got to yet.
  let unsupported = false
  try {
    const bytes = readDocumentBytes(db, r.document_id)
    if (IS_PDF(mime)) text = pdfText(bytes).text
    else if (IS_OFFICE(mime)) {
      const office = officeText(bytes)
      unsupported = office.kind === 'UNSUPPORTED'
      text = office.text
    } else text = bytes.toString('utf8')
  } catch (e) {
    tally.EXTRACTION_FAILED = (tally.EXTRACTION_FAILED ?? 0) + 1
    if (APPLY) {
      db.prepare(`UPDATE cos_documents SET extraction_state='EXTRACTION_FAILED', extraction_note=?, extraction_attempted_at=? WHERE document_id=?`)
        .run(String((e as Error)?.message ?? e).slice(0, 200), now, r.document_id)
    }
    continue
  }
  // A decode that produced replacement characters is not text, whatever the
  // mime type claimed.
  if (!IS_PDF(mime) && !IS_OFFICE(mime) && text.includes('�')) {
    tally.EXTRACTION_LOW_QUALITY = (tally.EXTRACTION_LOW_QUALITY ?? 0) + 1
    if (APPLY) {
      db.prepare(`UPDATE cos_documents SET extraction_state='EXTRACTION_LOW_QUALITY', extraction_note='utf8 decode produced replacement characters', extraction_attempted_at=? WHERE document_id=?`)
        .run(now, r.document_id)
    }
    continue
  }
  if (unsupported) {
    tally.EXTRACTION_UNSUPPORTED = (tally.EXTRACTION_UNSUPPORTED ?? 0) + 1
    if (APPLY) {
      db.prepare(
        `UPDATE cos_documents SET extraction_state='EXTRACTION_UNSUPPORTED', extraction_note=?,
                extraction_attempted_at=?, updated_at=?
          WHERE document_id = ? AND extraction_state <> 'EXTRACTION_UNSUPPORTED'`,
      ).run('no reader for this container (not docx, not xlsx)', now, now, r.document_id)
    }
    continue
  }
  const q = classifyExtraction(text)
  tally[q.state] = (tally[q.state] ?? 0) + 1
  if (samples.length < 3 && q.state === 'EXTRACTED_VALID') {
    samples.push(`${r.filename ?? r.document_id}: ${q.chars} chars, ratio ${q.letterRatio.toFixed(2)}`)
  }
  if (APPLY) {
    db.prepare(
      `UPDATE cos_documents SET extracted_text = ?, extraction_state = ?, extraction_note = ?,
              extraction_attempted_at = ?, updated_at = ?
        WHERE document_id = ? AND extraction_state = 'NOT_ATTEMPTED'`,
    ).run(
      // Only a TRUSTED extraction is stored as text. A low-quality one records
      // its state and note and leaves the column empty -- a garbage field is
      // worse than an empty one, which is the whole point of this module.
      q.state === 'EXTRACTED_VALID' ? text : null,
      q.state, `${q.reason} (letterRatio ${q.letterRatio.toFixed(3)}, ${q.chars} chars)`,
      now, now, r.document_id,
    )
  }
}
console.log(JSON.stringify({ db: verdict.target, live: verdict.live, candidates: rows.length, apply: APPLY, tally, samples }, null, 1))
