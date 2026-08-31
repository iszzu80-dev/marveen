#!/usr/bin/env npx tsx
/**
 * RECOVERY GATE closure: disposition the stuck synthetic probe batches.
 *
 * It does NOT hand-write statuses. It runs the PRODUCTION path -- `closeBatch`
 * with the source-id classifier in it -- over the stuck batches, so the recovery
 * and the fix cannot drift apart. If the fix is wrong, this is wrong in the same
 * way, visibly, instead of papering over it with an UPDATE.
 *
 * The committer it passes THROWS. Nothing should ever reach it: that is the
 * whole claim being made about these rows, so the run asserts it rather than
 * assuming it.
 *
 * Owner's conditions (2026-08-31), each enforced here:
 *   - prove synthetic from durable provenance BEFORE writing        -> proveSynthetic()
 *   - never claim a Gmail source-commit happened                    -> EXCLUDED, asserted after
 *   - never leave them in LOCAL_APPLIED                             -> asserted after
 *   - never advance a cursor to make a gate green                   -> checkpoint compared before/after
 *
 * Usage:  npx tsx scripts/recover-synthetic-probe-batches.ts [--db <path>] [--apply]
 * Default is a dry run against the LIVE store that prints the proof and changes
 * nothing.
 *
 * IT NAMES ITS OWN DATABASE, and refuses an empty one. The first run of this
 * script called bare `initDatabase()`, which derives STORE_DIR from the module's
 * own location -- so from a worktree it opened the worktree's empty copy, found
 * no stuck rows, and printed "nothing to do". A recovery tool that reports
 * success over the wrong database is worse than one that crashes, and it is the
 * exact trap the pinned-cycle guard's inode check exists to close. So this one
 * prints the path AND the inode it opened, and refuses a database with no
 * ingestion history at all.
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDatabase } from '../src/db.js'
import { closeBatch, type SourceCommitter } from '../src/cos/source-commit.js'
import { classifySourceId } from '../src/cos/source-id.js'
import { getCheckpoint } from '../src/cos/email-ingest.js'
import { runDailyReconcile } from '../src/cos/reconcile.js'

const APPLY = process.argv.includes('--apply')
const now = Math.floor(Date.now() / 1000)

const LIVE_DB = join(homedir(), 'marveen', 'store', 'claudeclaw.db')
const dbArg = process.argv.indexOf('--db')
const DB_PATH = dbArg >= 0 ? process.argv[dbArg + 1] : LIVE_DB

interface Stuck { gmail_account_id: string; message_id: string; thread_id: string | null; batch_id: string; status: string; case_id: string | null; updated_at: number }

/** Every line of evidence, gathered from DURABLE local state. Nothing here is a
 *  judgement call; each item is a fact a later reader can re-check. */
function proveSynthetic(db: ReturnType<typeof getDb>, r: Stuck): { synthetic: boolean; evidence: string[] } {
  const evidence: string[] = []
  const verdict = classifySourceId(r.gmail_account_id, r.message_id)
  evidence.push(`id-shape: ${verdict.committable ? 'LOOKS LIKE A GMAIL ID' : 'not a Gmail id'} -- ${r.message_id}`)

  const real = db.prepare(
    `SELECT COUNT(*) n FROM email_processing WHERE gmail_account_id=? AND message_id GLOB '[0-9a-f]*'`,
  ).get(r.gmail_account_id) as { n: number }
  evidence.push(`peer-shape: ${real.n} messages on this account DO carry a hex Gmail id`)

  const receipt = db.prepare(
    `SELECT source_manifest_hash, title, actor FROM cos_triage_provenance WHERE message_id=?`,
  ).get(r.message_id) as { source_manifest_hash: string | null; title: string | null; actor: string | null } | undefined
  if (receipt) {
    evidence.push(`triage-receipt: source_manifest_hash=${receipt.source_manifest_hash ?? 'NULL'} ` +
      `(a mailbox fetch always carries one), title=${JSON.stringify(receipt.title)}, actor=${receipt.actor}`)
  } else {
    evidence.push('triage-receipt: none recorded')
  }

  const kase = db.prepare(`SELECT title FROM personal_cases WHERE case_id=?`).get(r.case_id ?? '') as { title: string } | undefined
  if (kase) evidence.push(`case-title: ${JSON.stringify(kase.title)}`)

  evidence.push('gmail-api: read on this id returns HTTP 400 "Invalid id value" (not 404) ' +
    '-- measured 2026-08-31, recorded in deliverables/recovery-gate/PROVENANCE.txt')

  // The disposition rests on the id rule alone. The rest is corroboration, and
  // it is printed so a reader can disagree with the conclusion on the facts.
  return { synthetic: !verdict.committable, evidence }
}

async function main() {
  const st = statSync(DB_PATH)
  console.log(`db=${DB_PATH}  inode=${st.ino}  size=${st.size}`)
  initDatabase(DB_PATH)
  const db = getDb()

  // An empty database answers every question with "nothing to do". Refuse it.
  const seen = db.prepare(`SELECT COUNT(*) n FROM email_processing`).get() as { n: number }
  const batches = db.prepare(`SELECT COUNT(*) n FROM email_processing_batches`).get() as { n: number }
  console.log(`ingestion history: ${seen.n} messages, ${batches.n} batches`)
  if (seen.n === 0 || batches.n === 0) {
    console.error('REFUSED: this database has no ingestion history -- it is not the live store.')
    process.exit(2)
  }

  const stuck = db.prepare(
    `SELECT gmail_account_id, message_id, thread_id, batch_id, status, case_id, updated_at
     FROM email_processing WHERE status = 'LOCAL_APPLIED' ORDER BY updated_at`,
  ).all() as Stuck[]

  console.log(`mode=${APPLY ? 'APPLY' : 'DRY-RUN'}  stuck LOCAL_APPLIED rows: ${stuck.length}`)
  if (!stuck.length) { console.log('nothing to do'); return }

  const cursorsBefore = new Map<string, string | null>()
  const stuckBatches = new Set<string>()
  const toClose: Stuck[] = []

  for (const r of stuck) {
    const { synthetic, evidence } = proveSynthetic(db, r)
    console.log(`\n--- ${r.message_id}  (batch ${r.batch_id}, age ${((now - r.updated_at) / 3600).toFixed(1)} h)`)
    for (const e of evidence) console.log(`    ${e}`)
    console.log(`    VERDICT: ${synthetic ? 'SYNTHETIC -- no source object exists' : 'REAL -- leave it alone'}`)
    if (!synthetic) continue
    toClose.push(r)
    stuckBatches.add(r.batch_id)
    cursorsBefore.set(r.gmail_account_id, getCheckpoint(db, r.gmail_account_id))
  }

  if (!APPLY) {
    console.log(`\nDRY RUN -- would close ${stuckBatches.size} batch(es). Re-run with --apply.`)
    return
  }

  // Throws if anything reaches it. The claim is that nothing will.
  const refusingCommitter: SourceCommitter = {
    id: 'recovery-refusing-committer',
    async commit(_a: string, m: string) {
      throw new Error(`RECOVERY ABORTED: a message was handed to the committer during recovery: ${m}`)
    },
  }

  for (const batchId of stuckBatches) {
    const res = await closeBatch(db, batchId, refusingCommitter, now)
    console.log(`\nclosed ${batchId}: excluded=${res.excluded} committed=${res.committed} ` +
      `failed=${res.failed} batchClosed=${res.batchClosed} cursor=${res.cursor ?? 'null'} :: ${res.reason}`)
  }

  // ── READBACK. Not "the call returned", but "the store says so". ──
  console.log('\n=== READBACK ===')
  let ok = true
  for (const r of toClose) {
    const row = db.prepare(
      `SELECT status, last_error FROM email_processing WHERE gmail_account_id=? AND message_id=?`,
    ).get(r.gmail_account_id, r.message_id) as { status: string; last_error: string | null }
    const good = row.status === 'EXCLUDED'
    ok &&= good
    console.log(`  ${r.message_id}: status=${row.status} ${good ? 'OK' : 'WRONG'}`)
    if (row.status === 'SOURCE_COMMITTED' || row.status === 'SOURCE_COMMIT_SKIPPED') {
      ok = false; console.log('    FAIL: this claims a source commit that never happened')
    }
  }
  for (const batchId of stuckBatches) {
    const b = db.prepare(`SELECT status FROM email_processing_batches WHERE batch_id=?`).get(batchId) as { status: string }
    const good = !['OPEN', 'PROCESSING'].includes(b.status)
    ok &&= good
    console.log(`  ${batchId}: status=${b.status} ${good ? 'OK' : 'STILL OPEN'}`)
  }
  for (const [acct, before] of cursorsBefore) {
    const after = getCheckpoint(db, acct)
    const moved = before !== after
    console.log(`  cursor[${acct}]: before=${before ?? 'null'} after=${after ?? 'null'} ${moved ? 'MOVED' : 'unchanged'}`)
    if (moved) { ok = false; console.log('    FAIL: a probe must not move a mailbox position') }
  }

  const findings = runDailyReconcile(db, now).findings
  const criticals = findings.filter((f) => f.severity === 'CRITICAL')
  console.log(`\n  reconcile CRITICAL findings: ${criticals.length ? criticals.map((f) => f.id).join(', ') : 'none'}`)
  console.log(`  reconcile WARNINGs: ${findings.filter((f) => f.severity === 'WARNING').map((f) => f.id).join(', ') || 'none'}`)

  console.log(`\nRECOVERY ${ok ? 'OK' : 'FAILED'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
