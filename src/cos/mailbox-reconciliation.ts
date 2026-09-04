// MAILBOX RECONCILIATION — what the dossier knows about and the intake never saw.
//
// MEASURED BEFORE IT WAS BUILT (live store, 2026-09-04): of 111 threads that a
// personal case canonically claims, 53 have no `email_processing` row at all.
// Not a rounding error — 48% of the conversations the dossier says a case is
// about were never processed by the intake, so nothing about them was triaged,
// no message of theirs is a source, and a reply arriving on one would be judged
// by a system that has never read the conversation it belongs to.
//
// Most of that population came in with the Sheet migration, which wrote case →
// thread relations directly. That explains it; it does not make it visible, and
// the whole point here is that a gap nobody can enumerate is a gap nobody
// closes.
//
// THIS MODULE ONLY LOOKS. It reports what is missing and never ingests: pulling
// 53 conversations into the intake is a decision with a cost (triage verdicts,
// case creation, owner attention) and it belongs to whoever is willing to own
// the result. Discovery that silently repairs is how a backfill becomes an
// incident.

import type Database from 'better-sqlite3'
import type { CaseNamespace } from './case-sources.js'

export interface UnprocessedClaimedThread {
  threadId: string
  /** Every open-or-closed case claiming it. Plural because six threads in the
   *  live store are claimed by more than one case. */
  caseIds: string[]
  /** Whether the thread's content is known to be gone. A thread that 404s is
   *  missing from the intake for a reason nobody needs to investigate again,
   *  and mixing it in with the recoverable ones would send someone chasing it. */
  contentUnavailable: boolean
}

/**
 * Threads a case claims that the intake has never processed.
 *
 * "Relevant" is not guessed here: a canonical case-source link IS the statement
 * that this conversation matters to that case. That is why this direction is
 * the useful one — the alternative, listing everything in the mailbox that is
 * not local, is mostly newsletters.
 */
export function unprocessedClaimedThreads(
  db: Database.Database, namespace: CaseNamespace,
): UnprocessedClaimedThread[] {
  const rows = db.prepare(
    `SELECT cs.source_ref AS thread_id,
            GROUP_CONCAT(cs.case_id) AS case_ids,
            MAX(CASE WHEN cs.content_state = 'CONTENT_UNAVAILABLE' THEN 1 ELSE 0 END) AS gone
       FROM case_sources cs
      WHERE cs.namespace = ?
        AND cs.source_type = 'GMAIL_THREAD'
        AND cs.link_state = 'CANONICAL'
        AND NOT EXISTS (
          SELECT 1 FROM email_processing ep WHERE ep.thread_id = cs.source_ref)
      GROUP BY cs.source_ref
      ORDER BY cs.source_ref`,
  ).all(namespace) as Array<{ thread_id: string; case_ids: string; gone: number }>

  return rows.map((r) => ({
    threadId: r.thread_id,
    caseIds: (r.case_ids ?? '').split(',').filter(Boolean),
    contentUnavailable: r.gone === 1,
  }))
}

export interface ReconciliationReport {
  namespace: CaseNamespace
  /** Distinct threads any case canonically claims. */
  claimedThreads: number
  /** Of those, how many the intake has a row for. */
  processedThreads: number
  /** Claimed, never processed, content still expected to be there. */
  unprocessed: UnprocessedClaimedThread[]
  /** Claimed, never processed, and already known to be gone. Separated so a
   *  reader is not sent chasing conversations that cannot be fetched. */
  unprocessedAndGone: UnprocessedClaimedThread[]
  /** In the mailbox, not in `email_processing` at all. Empty unless the caller
   *  supplied a mailbox listing — and stated as empty rather than omitted, so a
   *  report produced without a mailbox cannot be read as "the mailbox is clean". */
  mailboxOnly: string[]
  /** False when no mailbox listing was supplied. The distinction between "we
   *  looked and found nothing" and "we did not look" is the entire reason this
   *  flag exists. */
  mailboxChecked: boolean
}

/**
 * One reconciliation pass.
 *
 * `mailboxThreadIds` is optional and the report says whether it was given. A
 * pass with no mailbox still answers the more valuable question — what the
 * dossier claims and the intake never saw — and must not be mistaken for a
 * clean bill of health on the mailbox it never opened.
 */
export function reconcileMailbox(
  db: Database.Database,
  namespace: CaseNamespace,
  mailboxThreadIds?: readonly string[],
): ReconciliationReport {
  const all = unprocessedClaimedThreads(db, namespace)
  const claimedThreads = (db.prepare(
    `SELECT COUNT(DISTINCT source_ref) AS n FROM case_sources
      WHERE namespace = ? AND source_type = 'GMAIL_THREAD' AND link_state = 'CANONICAL'`,
  ).get(namespace) as { n: number }).n

  let mailboxOnly: string[] = []
  if (mailboxThreadIds) {
    const known = new Set(
      (db.prepare(`SELECT DISTINCT thread_id FROM email_processing WHERE thread_id IS NOT NULL`)
        .all() as Array<{ thread_id: string }>).map((r) => r.thread_id))
    mailboxOnly = [...new Set(mailboxThreadIds)].filter((t) => !known.has(t)).sort()
  }

  return {
    namespace,
    claimedThreads,
    processedThreads: claimedThreads - all.length,
    unprocessed: all.filter((t) => !t.contentUnavailable),
    unprocessedAndGone: all.filter((t) => t.contentUnavailable),
    mailboxOnly,
    mailboxChecked: mailboxThreadIds !== undefined,
  }
}
