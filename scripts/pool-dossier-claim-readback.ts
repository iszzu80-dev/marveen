// POOL DOSSIER CLAIM READBACK -- what every source in PRI-HOME-2026-005 says,
// side by side, with nothing chosen between them.
//
// Owner acceptance, Priority 2, 2026-09-04: "A readbackban látszódjon ugyanarra
// a fieldre több source-bound claim winner nélkül."
//
// So this prints the claims grouped by FIELD and ordered by when each source
// spoke. It does not rank them, does not mark one as likelier, and does not
// reconcile the two prices it will show. Conflict resolution is Priority 3, and
// a readback that quietly sorted by confidence would have shipped it early.
//
// Runs against a COPY of the live store -- real cases, real documents -- with
// Gmail bodies supplied from a fixture file so the run needs no network and
// repeats identically.
//
//   npx tsx scripts/pool-dossier-claim-readback.ts <db> <bodies.json>

import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { extractDossierClaims } from '../src/cos/claims/extract-dossier.js'
import { claimsForField, displayTime } from '../src/cos/claims/claim-store.js'
import { dossierSources } from '../src/cos/claims/dossier-traversal.js'

const db = new Database(process.argv[2])
const ROOT = 'PRI-HOME-2026-005'
const bodies: Record<string, { text: string; from: string; timestamp: number }> =
  JSON.parse(readFileSync(process.argv[3], 'utf8'))

const srcs = dossierSources(db, 'personal', ROOT)
console.log(`dossier sources: ${srcs.length}`)
const byKind = new Map<string, number>()
for (const s of srcs) byKind.set(s.sourceType, (byKind.get(s.sourceType) ?? 0) + 1)
for (const [k, n] of byKind) console.log(`   ${k}: ${n}`)
const branches = new Set(srcs.map((s) => s.viaCaseId))
console.log(`   across ${branches.size} case(s): ${[...branches].join(', ')}`)

const now = Math.floor(Date.now() / 1000)
const r = extractDossierClaims(db, 'personal', ROOT, (id) => bodies[id] ?? null, now)
console.log('\nrun:', JSON.stringify(r))

const again = extractDossierClaims(db, 'personal', ROOT, (id) => bodies[id] ?? null, now + 60)
console.log('second run (idempotence):',
  JSON.stringify({ written: again.claimsWritten, refreshed: again.claimsRefreshed }))

const FIELDS: Array<[string, string | null]> = [
  ['PART_NUMBER', null],
  ['POSITION', null],
  ['PACKAGE_QUANTITY', null],
  ['PACKAGE_PRICE', 'gross'],
  ['UNIT_PRICE', 'net'],
  ['AVAILABILITY', 'production'],
  ['AVAILABILITY', 'local_release'],
]

for (const [type, field] of FIELDS) {
  const rows = claimsForField(db, 'personal', ROOT, type, field)
    .filter((c) => c.normalizedValue !== '')
  const label = `${type}${field ? '/' + field : ''}`
  console.log(`\n--- ${label}: ${rows.length} source-bound claim(s), no winner ---`)
  for (const c of rows) {
    console.log(`  ${displayTime(c.sourceTimestamp)}  ${c.normalizedValue}${c.normalizedUnit ? ' ' + c.normalizedUnit : ''}   (verbatim: "${c.originalValue}")`)
    console.log(`     from ${c.sourceId} [${c.sourceType}], segment ${c.spanKind} @${c.claimId.slice(4, 12)}`)
    console.log(`     ${c.attributionStatus}, assertedBy=${c.assertedBy ?? 'null'}, ${c.confidence}/${c.extractionStatus}`)
  }
}

// What the extractor cannot see at all, said out loud. Absence here is a fact
// about this extractor, never about the sources.
const unsupported = db.prepare(
  `SELECT DISTINCT claim_type FROM structured_claims
    WHERE case_id = ? AND extraction_status = 'UNSUPPORTED' ORDER BY claim_type`,
).all(ROOT) as Array<{ claim_type: string }>
console.log(`\n--- UNSUPPORTED (no rule exists; says nothing about the sources) ---`)
console.log('   ' + unsupported.map((u) => u.claim_type).join(', '))
