// THE DOSSIER PILOT MEASUREMENT, and the backfill that moves the numbers.
//
// The owner asked for five numbers by name: open personal cases, cases with no
// thread, multi-thread cases detected, false-link rate, unmatched threads. This
// script produces all five from the store, plus the BEFORE side of each, so
// that "0 after" can never be reported without the number it started from.
//
// Default is a DRY run: it measures and writes nothing. `--backfill` performs
// the explicit-relation backfill and then measures again, so one invocation
// carries before, action and after.
//
// Usage: npx tsx scripts/cos-case-dossier-report.ts [--backfill] [--namespace personal|zst]

import { getDb, initDatabase } from '../src/db.js'
import { backfillCaseSources } from '../src/cos/case-source-backfill.js'
import type { CaseNamespace } from '../src/cos/case-sources.js'

const args = process.argv.slice(2)
const doBackfill = args.includes('--backfill')
const nsArg = args[args.indexOf('--namespace') + 1]
const namespace: CaseNamespace = args.includes('--namespace') && nsArg === 'zst' ? 'zst' : 'personal'

initDatabase()
const db = getDb()
const caseTable = namespace === 'personal' ? 'personal_cases' : 'zst_cases'
const OPEN = `archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')`

const one = (sql: string, ...p: unknown[]): number =>
  (db.prepare(sql).get(...p) as { n: number }).n

interface Measurement {
  openCases: number
  openCasesWithNoThread: number
  casesWithMultipleThreads: number
  threadsClaimedByMoreThanOneCase: number
  canonicalLinks: number
  candidateLinks: number
  rejectedLinks: number
  /** Threads the mailbox has processed that NO case claims. Named "unmatched"
   *  by the owner. */
  unmatchedThreads: number
  /** Of the candidates a human has actually DECIDED, the share turned down.
   *  `null` when nothing has been decided -- a rate over an empty denominator
   *  is not 0%, it is unknown, and printing 0% would claim a quality we have
   *  not measured. */
  falseLinkRate: number | null
  falseLinkDecided: number
}

function measure(): Measurement {
  const canonicalThreads = `
    SELECT case_id, source_ref FROM case_sources
     WHERE namespace='${namespace}' AND source_type='GMAIL_THREAD' AND link_state='CANONICAL'`
  const rejected = one(`SELECT COUNT(*) n FROM case_sources WHERE namespace=? AND link_state='REJECTED'`, namespace)
  const promoted = one(
    `SELECT COUNT(*) n FROM case_sources
      WHERE namespace=? AND link_state='CANONICAL' AND link_method='OWNER_CONFIRMED'`, namespace)
  const decided = rejected + promoted
  return {
    openCases: one(`SELECT COUNT(*) n FROM ${caseTable} WHERE ${OPEN}`),
    openCasesWithNoThread: one(
      `SELECT COUNT(*) n FROM ${caseTable} c
        WHERE ${OPEN} AND c.case_id NOT IN (SELECT case_id FROM (${canonicalThreads}))`),
    casesWithMultipleThreads: one(
      `SELECT COUNT(*) n FROM (SELECT case_id FROM (${canonicalThreads})
         GROUP BY case_id HAVING COUNT(DISTINCT source_ref) > 1)`),
    threadsClaimedByMoreThanOneCase: one(
      `SELECT COUNT(*) n FROM (SELECT source_ref FROM (${canonicalThreads})
         GROUP BY source_ref HAVING COUNT(DISTINCT case_id) > 1)`),
    canonicalLinks: one(`SELECT COUNT(*) n FROM case_sources WHERE namespace=? AND link_state='CANONICAL'`, namespace),
    candidateLinks: one(`SELECT COUNT(*) n FROM case_sources WHERE namespace=? AND link_state='CANDIDATE'`, namespace),
    rejectedLinks: rejected,
    unmatchedThreads: namespace === 'personal'
      ? one(`SELECT COUNT(*) n FROM (
               SELECT DISTINCT thread_id FROM email_processing
                WHERE thread_id IS NOT NULL
                  AND thread_id NOT IN (SELECT source_ref FROM (${canonicalThreads})))`)
      : 0,
    falseLinkRate: decided === 0 ? null : rejected / decided,
    falseLinkDecided: decided,
  }
}

const before = measure()
const backfill = doBackfill ? backfillCaseSources(db, namespace, Math.floor(Date.now() / 1000)) : null
const after = doBackfill ? measure() : before

const out = {
  namespace,
  mode: doBackfill ? 'BACKFILL' : 'DRY',
  before,
  after,
  backfill: backfill && {
    created: backfill.created,
    unchanged: backfill.unchanged,
    upgraded: backfill.upgraded,
    heldByRejection: backfill.heldByRejection,
    bySource: backfill.bySource,
    unrecognisedCount: backfill.unrecognised.length,
    unrecognised: backfill.unrecognised.slice(0, 20),
  },
  // THE CYCLE'S COUNTER VOCABULARY: examined / matched / acted / failed.
  examined: before.openCases,
  matched: after.canonicalLinks,
  acted: backfill ? backfill.created + backfill.upgraded : 0,
  failed: 0,
  problems: [] as string[],
}
console.log(JSON.stringify(out, null, 1))
