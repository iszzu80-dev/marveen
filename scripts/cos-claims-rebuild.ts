// CONTROLLED REBUILD of structured_claims after an identity-recipe change.
//
// Owner ruling, 2026-09-05: "NE hagyd egymas mellett a regi es uj claim-id
// generaciot. A structured_claims derived/rebuildable evidence layer, nem
// canonical truth store." And: "Ne probald a regi claim_id-ket helyben migralni
// vagy kezzel parositani."
//
// So this deletes and re-extracts rather than migrating. The deletion is the
// safe operation ONLY while the four preconditions below hold, and they are
// CHECKED rather than remembered -- the day one of them stops holding is the day
// somebody runs this from memory of when it was safe.
//
// It refuses (exit 94) if any precheck fails, and writes nothing.
//
//   npx tsx scripts/cos-claims-rebuild.ts <db> <namespace> <rootCaseId> <bodies.json> [--apply]
//
// Without --apply it runs every precheck and reports, and touches nothing.

import Database from 'better-sqlite3'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extractDossierClaims } from '../src/cos/claims/extract-dossier.js'
import { EXTRACTOR_VERSION } from '../src/cos/claims/pool-claims.js'
import { dossierSources } from '../src/cos/claims/dossier-traversal.js'

const [dbPath, namespace, rootCaseId, bodiesPath] = process.argv.slice(2)
const APPLY = process.argv.includes('--apply')
if (!dbPath || !namespace || !rootCaseId || !bodiesPath) {
  console.error('usage: cos-claims-rebuild.ts <db> <namespace> <rootCaseId> <bodies.json> [--apply]')
  process.exit(2)
}
const REPO = process.env.MARVEEN_REPO_ROOT ?? join(import.meta.dirname, '..')

const problems: string[] = []
const note = (ok: boolean, label: string, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}`)
  if (!ok) problems.push(label)
}

const db = new Database(dbPath)

// ---------------------------------------------------------------- PRECHECK 1
// No production caller. Anything that runs on a schedule and reads these rows
// would see them vanish; the whole premise of a cheap rebuild is that nothing
// downstream is watching.
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e.startsWith('dist.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.js')) out.push(p)
  }
  return out
}
const ALLOWED = [
  'src/cos/claims/',                       // the module itself
  'src/__tests__/',                        // tests
  'scripts/pool-dossier-claim-readback.ts',// the on-demand readback
  'scripts/cos-claims-rebuild.ts',         // this file
]
const files = [...walk(join(REPO, 'src')), ...walk(join(REPO, 'scripts'))]
const callers = files.filter((f) => {
  const rel = f.slice(REPO.length + 1)
  if (ALLOWED.some((a) => rel.startsWith(a))) return false
  const body = readFileSync(f, 'latin1')
  return body.includes('extractDossierClaims') || body.includes('structured_claims')
    || body.includes('recordClaims') || body.includes('claimsForField')
}).map((f) => f.slice(REPO.length + 1))
note(callers.length === 0, 'no production caller',
  callers.length === 0
    ? `${files.length} source files scanned; the only references are inside src/cos/claims, the tests, the readback script and this one`
    : `referenced by: ${callers.join(', ')}`)

// ---------------------------------------------------------------- PRECHECK 2
// No FK or downstream canonical dependency ON these rows.
const fkRefs = (db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name<>'structured_claims'`
).all() as Array<{ name: string }>).filter((t) => {
  const fks = db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all() as Array<{ table: string }>
  return fks.some((fk) => fk.table === 'structured_claims')
}).map((t) => t.name)
const viewRefs = (db.prepare(
  `SELECT name, sql FROM sqlite_master WHERE type IN ('view','trigger') AND sql LIKE '%structured_claims%'`
).all() as Array<{ name: string }>).map((v) => v.name)
note(fkRefs.length === 0 && viewRefs.length === 0, 'no FK / view / trigger dependency',
  fkRefs.length === 0 && viewRefs.length === 0
    ? 'no table declares a foreign key to structured_claims, and no view or trigger mentions it'
    : `FKs from: ${fkRefs.join(', ') || 'none'}; views/triggers: ${viewRefs.join(', ') || 'none'}`)

// ---------------------------------------------------------------- PRECHECK 3
// No external action and no user-authored state. Every column is extractor
// output; a column outside this set could hold something a person typed, and
// deleting that would be destroying work rather than dropping a cache.
const DERIVED_COLUMNS = new Set([
  'claim_id', 'namespace', 'case_id', 'claim_type', 'field', 'normalized_value',
  'normalized_unit', 'original_value', 'source_id', 'source_type',
  'source_timestamp', 'channel', 'span_kind', 'span_start', 'span_end',
  'span_marker', 'attribution_status', 'asserted_by', 'asserted_by_name',
  'confidence', 'extraction_status', 'extractor_version', 'provenance',
  'first_seen_at', 'last_changed_at',
])
const tableExists = db.prepare(
  `SELECT name FROM sqlite_master WHERE name='structured_claims'`).get() !== undefined
const cols = tableExists
  ? (db.prepare(`PRAGMA table_info(structured_claims)`).all() as Array<{ name: string }>).map((c) => c.name)
  : []
const foreign = cols.filter((c) => !DERIVED_COLUMNS.has(c))
note(foreign.length === 0, 'every column is extractor-derived',
  foreign.length === 0
    ? tableExists ? `${cols.length} columns, all produced by the extractor; no user-authored or action-carrying column`
                  : 'the table does not exist yet, so it holds nothing'
    : `columns outside the derived set: ${foreign.join(', ')}`)

// ---------------------------------------------------------------- PRECHECK 4
// Reproducible: every source the stored claims came from is still reachable by
// the traversal. A row whose source has left the dossier could not be rebuilt.
const srcs = dossierSources(db, namespace as 'personal' | 'zst', rootCaseId)
const reachable = new Set(srcs.map((s) => `${s.sourceType}:${s.sourceId}`))
const stored = tableExists
  ? (db.prepare(
      `SELECT DISTINCT source_type, source_id FROM structured_claims WHERE namespace=? AND case_id=?`
    ).all(namespace, rootCaseId) as Array<{ source_type: string; source_id: string }>)
  : []
const orphan = stored.filter((r) => !reachable.has(`${r.source_type}:${r.source_id}`))
note(orphan.length === 0, 'every stored claim is reproducible from a reachable source',
  orphan.length === 0
    ? `${stored.length} distinct sources in the table, all still returned by the traversal (${srcs.length} sources)`
    : `sources no longer in the dossier: ${orphan.map((o) => `${o.source_type}:${o.source_id}`).join(', ')}`)

// -------------------------------------------------------------------- VERDICT
const before = tableExists
  ? (db.prepare(`SELECT COUNT(*) n FROM structured_claims WHERE namespace=? AND case_id=?`)
      .get(namespace, rootCaseId) as { n: number }).n
  : 0
const oldRecipes = tableExists
  ? (db.prepare(
      `SELECT extractor_version, COUNT(*) n FROM structured_claims WHERE namespace=? AND case_id=? GROUP BY 1`
    ).all(namespace, rootCaseId) as Array<{ extractor_version: string; n: number }>)
  : []
console.log(`\nrows held for ${namespace}/${rootCaseId}: ${before}`)
console.log(`recipes present: ${oldRecipes.map((r) => `${r.extractor_version}=${r.n}`).join(', ') || 'none'}`)
console.log(`new recipe: ${EXTRACTOR_VERSION}`)

if (problems.length > 0) {
  console.error(`\nREBUILD REFUSED: ${problems.length} precheck(s) failed: ${problems.join('; ')}`)
  console.error('Nothing was deleted and nothing was written.')
  process.exit(94)
}
if (!APPLY) {
  console.log('\nAll prechecks pass. Re-run with --apply to delete and re-extract.')
  process.exit(0)
}

// ------------------------------------------------------------------- REBUILD
// The audit outlives the rows: which recipe was dropped, which replaced it, how
// many rows, and when. The rows themselves do not stay behind as a second
// generation -- an active evidence store with two recipes in it is a store where
// every reader has to know which one to believe.
db.exec(`
  CREATE TABLE IF NOT EXISTS structured_claim_rebuilds (
    rebuild_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at             INTEGER NOT NULL,
    namespace      TEXT NOT NULL,
    case_id        TEXT NOT NULL,
    rows_dropped   INTEGER NOT NULL,
    recipes_dropped TEXT NOT NULL,
    recipe_installed TEXT NOT NULL,
    rows_rebuilt   INTEGER,
    reason         TEXT NOT NULL
  )`)
const now = Math.floor(Date.now() / 1000)
const rebuildId = (db.prepare(`
  INSERT INTO structured_claim_rebuilds
    (at, namespace, case_id, rows_dropped, recipes_dropped, recipe_installed, rows_rebuilt, reason)
  VALUES (?,?,?,?,?,?,NULL,?)`).run(
  now, namespace, rootCaseId, before,
  JSON.stringify(oldRecipes), EXTRACTOR_VERSION,
  'claim identity recipe changed: source_type joined source_id, so every claim_id from the previous recipe is stale; owner ruling 2026-09-05 forbids keeping two generations in the active store',
).lastInsertRowid)

db.prepare(`DELETE FROM structured_claims WHERE namespace=? AND case_id=?`).run(namespace, rootCaseId)
const after0 = (db.prepare(`SELECT COUNT(*) n FROM structured_claims WHERE namespace=? AND case_id=?`)
  .get(namespace, rootCaseId) as { n: number }).n
console.log(`\ndropped ${before} rows; table now holds ${after0} for this dossier`)

const bodies: Record<string, { text: string; from: string; timestamp: number }> =
  JSON.parse(readFileSync(bodiesPath, 'utf8'))
const load = (id: string, t: 'GMAIL_MESSAGE' | 'GMAIL_THREAD') => bodies[`${t}:${id}`] ?? null
const r = extractDossierClaims(db, namespace as 'personal' | 'zst', rootCaseId, load, now)
console.log('re-extraction:', JSON.stringify(r))

const after = (db.prepare(`SELECT COUNT(*) n FROM structured_claims WHERE namespace=? AND case_id=?`)
  .get(namespace, rootCaseId) as { n: number }).n
db.prepare(`UPDATE structured_claim_rebuilds SET rows_rebuilt=? WHERE rebuild_id=?`).run(after, rebuildId)

const recipes = db.prepare(
  `SELECT extractor_version, COUNT(*) n FROM structured_claims WHERE namespace=? AND case_id=? GROUP BY 1`
).all(namespace, rootCaseId) as Array<{ extractor_version: string; n: number }>
console.log(`rows after rebuild: ${after}`)
console.log(`recipes now in the active store: ${recipes.map((x) => `${x.extractor_version}=${x.n}`).join(', ')}`)
if (recipes.length !== 1 || recipes[0].extractor_version !== EXTRACTOR_VERSION) {
  console.error('REBUILD INCOMPLETE: the active store holds more than the installed recipe')
  process.exit(95)
}
console.log(`audit row: structured_claim_rebuilds #${rebuildId}`)
db.close()
