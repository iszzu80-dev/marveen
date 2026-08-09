// Test deployAndSeedProgression against a copy of the live DB.
// Usage: npx tsx scripts/test-deploy-against-live-copy.ts /tmp/claudeclaw-test-copy.db

import Database from 'better-sqlite3'
import { deployAndSeedProgression } from '../src/cos/progression-migrate.js'
import { runProgressionHeartbeat } from '../src/cos/progression-heartbeat.js'

const dbPath = process.argv[2]
if (!dbPath) { console.error('Usage: npx tsx scripts/test-deploy-against-live-copy.ts <db-path>'); process.exit(1) }

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
const now = Math.floor(Date.now() / 1000)

console.log('=== Pre-deploy state ===')

// Check if progression tables exist
const preTables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('case_progression_state','case_progression_runs')"
).all() as Array<{name:string}>
console.log('Progression tables exist:', preTables.map(t => t.name))

// Count cases by status
const personalByStatus = db.prepare(
  'SELECT status, COUNT(*) as c FROM personal_cases WHERE archived_at IS NULL GROUP BY status ORDER BY status'
).all() as Array<{status:string; c:number}>
console.log('Personal cases by status:', personalByStatus)

const zstByStatus = db.prepare(
  'SELECT status, COUNT(*) as c FROM zst_cases WHERE archived_at IS NULL GROUP BY status ORDER BY status'
).all() as Array<{status:string; c:number}>
console.log('ZST cases by status:', zstByStatus)

const totalPersonal = (db.prepare('SELECT COUNT(*) as c FROM personal_cases WHERE archived_at IS NULL').get() as {c:number}).c
const totalZst = (db.prepare('SELECT COUNT(*) as c FROM zst_cases WHERE archived_at IS NULL').get() as {c:number}).c
console.log(`Total active cases: ${totalPersonal} personal + ${totalZst} ZST = ${totalPersonal + totalZst}`)

console.log('\n=== Deploying ===')
const result = deployAndSeedProgression(db, now, 'live-copy-test')
console.log('Migration result:', JSON.stringify(result, null, 2))

console.log('\n=== Post-deploy state ===')
const stateCount = (db.prepare('SELECT COUNT(*) as c FROM case_progression_state').get() as {c:number}).c
const runCount = (db.prepare('SELECT COUNT(*) as c FROM case_progression_runs').get() as {c:number}).c
console.log(`case_progression_state rows: ${stateCount}`)
console.log(`case_progression_runs rows: ${runCount}`)

// Decisions breakdown
const decisions = db.prepare(
  'SELECT decision, COUNT(*) as c FROM case_progression_runs GROUP BY decision ORDER BY c DESC'
).all() as Array<{decision:string; c:number}>
console.log('Decisions:', decisions)

// Verify criteria 2: no zst_cases row is still NEW merely because nothing advances it
const zstNewWithoutState = db.prepare(
  `SELECT case_id, status, title FROM zst_cases
   WHERE archived_at IS NULL AND status = 'NEW'
     AND case_id NOT IN (SELECT case_id FROM case_progression_state WHERE domain = 'zst')`
).all() as Array<{case_id:string; status:string; title:string}>
console.log(`\nZST cases still NEW without progression state: ${zstNewWithoutState.length}`)
if (zstNewWithoutState.length > 0) {
  for (const c of zstNewWithoutState) console.log('  ', c.case_id, c.title)
}

const personalNewWithoutState = db.prepare(
  `SELECT case_id, status, title FROM personal_cases
   WHERE archived_at IS NULL AND status = 'NEW'
     AND case_id NOT IN (SELECT case_id FROM case_progression_state WHERE domain = 'personal')`
).all() as Array<{case_id:string; status:string; title:string}>
console.log(`Personal cases still NEW without progression state: ${personalNewWithoutState.length}`)
if (personalNewWithoutState.length > 0) {
  for (const c of personalNewWithoutState) console.log('  ', c.case_id, c.title)
}

// Progressed ZST cases — what did the engine decide?
const zstProgressed = db.prepare(
  `SELECT z.case_id, z.status, z.title, r.decision, r.reason
   FROM zst_cases z
   JOIN case_progression_state s ON s.case_id = z.case_id AND s.domain = 'zst'
   LEFT JOIN case_progression_runs r ON r.progression_run_id = (
     SELECT progression_run_id FROM case_progression_runs
     WHERE case_id = z.case_id AND domain = 'zst'
     ORDER BY started_at DESC LIMIT 1
   )
   WHERE z.archived_at IS NULL
   ORDER BY z.case_id`
).all() as Array<{case_id:string; status:string; title:string; decision:string|null; reason:string|null}>
console.log(`\nZST cases with progression state: ${zstProgressed.length}`)
for (const c of zstProgressed) {
  console.log(`  ${c.case_id} | ${c.status} | decision=${c.decision || 'none'} | ${c.title?.slice(0,40)}`)
}

// Run one heartbeat sweep to verify the heartbeat path
console.log('\n=== Heartbeat sweep ===')
const hb = runProgressionHeartbeat(db, now, 50)
console.log('Heartbeat result:', JSON.stringify(hb))

db.close()
console.log('\nDone.')
