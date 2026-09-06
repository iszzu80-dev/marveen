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
import { readDocumentBytes } from '../src/cos/cos-documents.js'
import { classifyExtraction } from '../src/cos/document-extraction.js'
import { pdfText } from '../src/cos/pdf-text.js'

const APPLY = process.argv.includes('--apply')
initDatabase('store/claudeclaw.db')
const db = getDb()
const now = Math.floor(Date.now() / 1000)

const TEXTISH = (m: string): boolean =>
  m.startsWith('text/') || m === 'message/rfc822' || m === 'application/json'
const IS_PDF = (m: string): boolean => m === 'application/pdf'

const rows = db.prepare(
  `SELECT document_id, mime_type, filename FROM cos_documents
    WHERE extraction_state = 'NOT_ATTEMPTED' AND content_purged_at IS NULL`,
).all() as Array<{ document_id: string; mime_type: string; filename: string | null }>

const tally: Record<string, number> = {}
const samples: string[] = []
for (const r of rows) {
  const mime = String(r.mime_type ?? '')
  if (!TEXTISH(mime) && !IS_PDF(mime)) { tally.SKIPPED_NOT_TEXT = (tally.SKIPPED_NOT_TEXT ?? 0) + 1; continue }
  let text: string
  try {
    const bytes = readDocumentBytes(db, r.document_id)
    text = IS_PDF(mime) ? pdfText(bytes).text : bytes.toString('utf8')
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
  if (!IS_PDF(mime) && text.includes('�')) {
    tally.EXTRACTION_LOW_QUALITY = (tally.EXTRACTION_LOW_QUALITY ?? 0) + 1
    if (APPLY) {
      db.prepare(`UPDATE cos_documents SET extraction_state='EXTRACTION_LOW_QUALITY', extraction_note='utf8 decode produced replacement characters', extraction_attempted_at=? WHERE document_id=?`)
        .run(now, r.document_id)
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
console.log(JSON.stringify({ candidates: rows.length, apply: APPLY, tally, samples }, null, 1))
