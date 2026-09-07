// Backfill `extraction_state` for documents already in the store.
//
// Uses classifyExtraction from document-extraction.ts rather than repeating the
// measure here: two copies of "does this read as language" would drift, and the
// drift would be invisible because both would look reasonable.
//
// --apply writes; the default only reports.
import { initDatabase, getDb } from '../src/db.js'
import { mayMutate, EXIT_LIVE_MUTATION_REFUSED } from '../src/cos/live-store-guard.js'
import { classifyExtraction } from '../src/cos/document-extraction.js'

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

const rows = db.prepare(
  `SELECT document_id, namespace, filename, extracted_text, extraction_state
     FROM cos_documents`,
).all() as Array<{ document_id: string; namespace: string; filename: string | null
                  extracted_text: string | null; extraction_state: string | null }>

const tally: Record<string, number> = {}
let written = 0
for (const r of rows) {
  if (r.extraction_state) { tally[`already:${r.extraction_state}`] = (tally[`already:${r.extraction_state}`] ?? 0) + 1; continue }
  const q = classifyExtraction(r.extracted_text)
  tally[q.state] = (tally[q.state] ?? 0) + 1
  if (APPLY) {
    db.prepare(
      `UPDATE cos_documents SET extraction_state = ?, extraction_note = ?, updated_at = ?
        WHERE document_id = ? AND extraction_state IS NULL`,
    ).run(q.state, `${q.reason} (letterRatio ${q.letterRatio.toFixed(3)}, ${q.wordCount} words, ${q.chars} chars)`, now, r.document_id)
    written++
  }
}
console.log(JSON.stringify({ db: verdict.target, live: verdict.live, documents: rows.length, apply: APPLY, written, tally }, null, 1))
