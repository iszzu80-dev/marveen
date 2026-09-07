// Does the code we are about to RELEASE reproduce the derived state already
// sitting in the live store?
//
// WHY. On 2026-09-06 unreleased candidate code changed 138 rows of
// `cos_documents` in the live database. The owner's ruling on 2026-09-07 let
// the state stand as LIVE_DERIVED_STATE_AHEAD_OF_RELEASE, with a condition:
// "Ne legyen olyan release, amely egyszeruen orokbe fogadja a live DB-ben levo,
// korabbi unreleased koddal letrehozott derived state-et bizonyitas nelkul."
// No release may simply ADOPT that state without proof.
//
// This is the proof, and it is a re-derivation rather than an inspection. Seed
// a clone from the pre-mutation reference, run the release candidate's own
// extraction against the clone, and compare what it produces with what is live.
// Equal means the release is not adopting anything it cannot reproduce.
//
// WHAT IS COMPARED, and what is deliberately not. The three CONTENT columns --
// `extracted_text`, `extraction_state`, `extraction_note` -- are the derived
// state. `extraction_attempted_at` and `updated_at` are wall clocks and MUST
// differ; a re-run at a later moment writes a later timestamp, and demanding
// they match would fail every honest reconciliation while proving nothing about
// the content. Their exclusion is stated in the output rather than left for a
// reader to infer.
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const expectedPath = arg('expected')   // the live/post-mutation state
const actualPath = arg('actual')       // what the candidate just re-derived

if (!expectedPath || !actualPath) {
  console.error('usage: cos-reconcile-extraction --expected <db> --actual <db>')
  process.exit(2)
}

const CONTENT_COLUMNS = ['extracted_text', 'extraction_state', 'extraction_note'] as const
const EXCLUDED = ['extraction_attempted_at', 'updated_at']

interface Row { document_id: string; filename: string | null; mime_type: string | null
  extracted_text: string | null; extraction_state: string | null; extraction_note: string | null }

function load(path: string): Map<string, Row> {
  const db = new Database(path, { readonly: true })
  const rows = db.prepare(
    `SELECT document_id, filename, mime_type, ${CONTENT_COLUMNS.join(', ')} FROM cos_documents`,
  ).all() as Row[]
  db.close()
  return new Map(rows.map((r) => [r.document_id, r]))
}

const digest = (v: string | null): string =>
  v === null ? 'NULL' : createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 12)

const expected = load(expectedPath)
const actual = load(actualPath)

const onlyExpected = [...expected.keys()].filter((k) => !actual.has(k))
const onlyActual = [...actual.keys()].filter((k) => !expected.has(k))

interface Diff { document_id: string; filename: string | null; mime_type: string | null
  column: string; expected: string; actual: string; expectedLen: number; actualLen: number }
const diffs: Diff[] = []
let identical = 0

for (const [id, e] of expected) {
  const a = actual.get(id)
  if (!a) continue
  let same = true
  for (const c of CONTENT_COLUMNS) {
    if (e[c] !== a[c]) {
      same = false
      diffs.push({
        document_id: id, filename: e.filename, mime_type: e.mime_type, column: c,
        // Text bodies are Istvan's contracts and invoices. A digest and a length
        // say whether they match without printing them into a report.
        expected: digest(e[c]), actual: digest(a[c]),
        expectedLen: (e[c] ?? '').length, actualLen: (a[c] ?? '').length,
      })
    }
  }
  if (same) identical += 1
}

// A reconciliation whose two sides came from the same file would report a
// perfect match and mean nothing. Say so out loud rather than trusting the
// caller to have passed different databases.
const sameFile = expectedPath === actualPath

const reproduced = diffs.length === 0 && onlyExpected.length === 0
  && onlyActual.length === 0 && !sameFile && expected.size > 0

console.log(JSON.stringify({
  expectedPath, actualPath,
  comparedColumns: CONTENT_COLUMNS, excludedColumns: EXCLUDED,
  excludedBecause: 'wall clocks: a re-run necessarily writes a later timestamp',
  documents: { expected: expected.size, actual: actual.size, identical },
  onlyInExpected: onlyExpected, onlyInActual: onlyActual,
  differing: diffs.length,
  diffs: diffs.slice(0, 40),
  truncated: diffs.length > 40,
  sameFile,
  reproduced,
  verdict: reproduced
    ? 'RELEASE_CANDIDATE_REPRODUCES_LIVE_DERIVED_STATE'
    : 'NOT_REPRODUCED -- the release would be adopting state it cannot re-derive',
}, null, 1))

process.exit(reproduced ? 0 : 1)
