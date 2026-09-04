// HISTORICAL INTAKE BACKFILL — creating the evidence that should already exist.
//
// The reconciler measured it: 53 of 111 threads a personal case canonically
// claims have no `email_processing` row (48%). Those conversations came in with
// the Sheet migration, which wrote case → thread relations directly and skipped
// the intake, so the dossier says the case is about a conversation the system
// has never read.
//
// This module fills that in, and the whole design is about what it may NOT do.
// Owner constraints (Istvan, 2026-09-04), each enforced in code below rather
// than promised in prose:
//
//   1. start ONLY from an existing, provenance-carrying case↔thread relation;
//   2. read-only from Gmail (a GmailThreadReader has no send surface at all);
//   3. create the MISSING intake/source evidence;
//   4. never open a case merely because a backfill wanted one;
//   5. never merge cases;
//   6. never overwrite an existing canonical relation.
//
// A BACKFILLED ROW IS NOT A TRIAGED ROW, and must never be mistakable for one.
// These messages were never judged by a triage step; nobody decided they were
// actionable, and no receipt exists. The batch id carries that: every row this
// module writes is stamped with BACKFILL_BATCH_PREFIX, exactly as triaged rows
// carry TRIAGE_BATCH_PREFIX, so provenance is a property of the row and not of
// whoever remembers how it got there.
//
// Nothing here can reach case creation. It has no import path to it: the case
// must already exist and must already claim the thread, or the thread is
// refused. That is why Stage 2G's receipt gate is not an obstacle and not a
// bypass — the gate guards case creation from email origin, and this never
// creates a case.

import type Database from 'better-sqlite3'
import {
  linkCaseSource, markSourceContentUnavailable, findCasesForSource,
  type CaseNamespace,
} from './case-sources.js'
import { unprocessedClaimedThreads } from './mailbox-reconciliation.js'

/** Stamped on every batch this module opens. The discriminator between "the
 *  intake saw this" and "we reconstructed it afterwards". */
export const BACKFILL_BATCH_PREFIX = 'backfill-'

/** One message as the mailbox returned it. Structural only: this module never
 *  interprets a body, because interpreting it would be triage. */
export interface BackfillMessage {
  id: string
  threadId?: string
}

/** Read-only mailbox access. Deliberately the narrowest possible shape — a
 *  fetcher that can only fetch cannot be handed something that also sends. */
export type ThreadFetcher = (threadId: string) => Promise<BackfillMessage[]>

export type ThreadOutcome =
  /** Messages were written as sources; the conversation is now evidence. */
  | 'BACKFILLED'
  /** The mailbox says the conversation is gone. Relation kept, marked. */
  | 'CONTENT_UNAVAILABLE'
  /** More than one case claims it. Choosing one would be a merge by another
   *  name, so nothing is written and a human decides. */
  | 'AMBIGUOUS_CASE_RELATION'
  /** The claiming case does not exist in this namespace's table. */
  | 'NAMESPACE_MISMATCH'
  /** The mailbox could not be asked. Nothing written; a later run can retry. */
  | 'FETCH_FAILED'
  /** Every message was already present. Nothing to do, and not an error. */
  | 'ALREADY_COMPLETE'

export interface BackfillThreadReport {
  threadId: string
  caseId: string | null
  outcome: ThreadOutcome
  /** Messages the mailbox returned. */
  fetched: number
  /** Rows this run created. */
  written: number
  /** Rows that already existed — the duplicate count Istvan asked for. */
  duplicates: number
  /** Cases claiming this thread beyond the one we would write to. */
  otherClaimants: string[]
  detail?: string
  elapsedMs: number
}

export interface BackfillRunReport {
  namespace: CaseNamespace
  /** Candidates considered this run. */
  examined: number
  threads: BackfillThreadReport[]
  totals: Record<ThreadOutcome, number> & { fetched: number; written: number; duplicates: number }
  elapsedMs: number
}

const EMPTY_TOTALS = (): BackfillRunReport['totals'] => ({
  BACKFILLED: 0, CONTENT_UNAVAILABLE: 0, AMBIGUOUS_CASE_RELATION: 0,
  NAMESPACE_MISMATCH: 0, FETCH_FAILED: 0, ALREADY_COMPLETE: 0,
  fetched: 0, written: 0, duplicates: 0,
})

function caseTable(namespace: CaseNamespace): string {
  return namespace === 'zst' ? 'zst_cases' : 'personal_cases'
}

/**
 * Candidate threads for a backfill, newest-claimed first, capped.
 *
 * The cap is a parameter and not a default buried in the caller, because the
 * owner authorised a bounded pilot and "bounded" has to be a value someone
 * passes, not a habit.
 */
export function backfillCandidates(
  db: Database.Database, namespace: CaseNamespace, limit: number,
): Array<{ threadId: string; caseIds: string[]; contentUnavailable: boolean }> {
  return unprocessedClaimedThreads(db, namespace).slice(0, Math.max(0, limit))
}

/**
 * Backfill ONE thread.
 *
 * Refuses, in this order, before it writes anything:
 *   - a thread already known to be gone, or one that turns out to be gone;
 *   - a thread claimed by more than one case (constraint 5: picking a winner
 *     here is a merge wearing a helpful name);
 *   - a claiming case that does not exist in this namespace (constraint 4: the
 *     alternative is to create it, which is exactly what may not happen).
 */
export async function backfillThread(
  db: Database.Database,
  namespace: CaseNamespace,
  candidate: { threadId: string; caseIds: string[]; contentUnavailable: boolean },
  fetch: ThreadFetcher,
  now: number,
  clock: () => number = Date.now,
): Promise<BackfillThreadReport> {
  const startedAt = clock()
  const base = {
    threadId: candidate.threadId, caseId: null as string | null,
    fetched: 0, written: 0, duplicates: 0, otherClaimants: [] as string[],
  }
  const done = (r: Partial<BackfillThreadReport> & { outcome: ThreadOutcome }): BackfillThreadReport =>
    ({ ...base, ...r, elapsedMs: clock() - startedAt })

  // Re-read the claimants rather than trusting the candidate list: the list may
  // be minutes old, and a relation added in between is exactly the case where
  // writing to a stale winner would be worst.
  const claimants = findCasesForSource(db, namespace, 'GMAIL_THREAD', candidate.threadId)
    .map((c) => c.caseId)
  const unique = [...new Set(claimants)]
  if (unique.length !== 1) {
    return done({
      outcome: 'AMBIGUOUS_CASE_RELATION', otherClaimants: unique,
      detail: `${unique.length} cases claim this thread; choosing one would merge them`,
    })
  }
  const caseId = unique[0]
  base.caseId = caseId

  const exists = db.prepare(
    `SELECT 1 FROM ${caseTable(namespace)} WHERE case_id = ?`,
  ).get(caseId)
  if (!exists) {
    return done({
      outcome: 'NAMESPACE_MISMATCH', caseId,
      detail: `${caseId} claims this thread in '${namespace}' but has no row in ${caseTable(namespace)}`,
    })
  }

  if (candidate.contentUnavailable) {
    return done({ outcome: 'CONTENT_UNAVAILABLE', caseId, detail: 'already marked gone; not re-fetched' })
  }

  let messages: BackfillMessage[]
  try {
    messages = await fetch(candidate.threadId)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // A 404 is an ANSWER: the conversation is gone, and the relation should say
    // so permanently. Anything else is "could not ask", which must stay
    // retryable — collapsing the two would retire a thread over a token refresh.
    if (/\b404\b/.test(msg)) {
      markSourceContentUnavailable(db, {
        namespace, caseId, sourceType: 'GMAIL_THREAD', sourceRef: candidate.threadId,
        note: `backfill ${new Date(now * 1000).toISOString().slice(0, 10)}: mailbox returned 404`,
      }, now)
      return done({ outcome: 'CONTENT_UNAVAILABLE', caseId, detail: msg })
    }
    return done({ outcome: 'FETCH_FAILED', caseId, detail: msg })
  }

  if (!messages.length) {
    // An empty thread is not a 404 and must not be filed as one: "the mailbox
    // answered with nothing" and "the mailbox says it is gone" are different
    // facts, and only one of them is permanent.
    return done({ outcome: 'FETCH_FAILED', caseId, fetched: 0, detail: 'mailbox returned an empty thread' })
  }

  const batchId = `${BACKFILL_BATCH_PREFIX}${namespace}-${candidate.threadId}`
  let written = 0, duplicates = 0

  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO email_processing_batches
         (batch_id, gmail_account_id, cursor_before, cursor_after, status, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 'COMMITTED', ?, ?)`,
    ).run(batchId, namespace, `${BACKFILL_BATCH_PREFIX}${now}`, now, now)

    for (const m of messages) {
      const already = db.prepare(
        `SELECT 1 FROM email_processing WHERE gmail_account_id = ? AND message_id = ?`,
      ).get(namespace, m.id)
      if (already) { duplicates++; continue }

      db.prepare(
        `INSERT INTO email_processing
           (gmail_account_id, message_id, thread_id, batch_id, status, case_id,
            thread_id_derived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'SOURCE_COMMITTED', ?, 0, ?, ?)`,
      ).run(namespace, m.id, candidate.threadId, batchId, caseId, now, now)

      // The message becomes a source of the case that ALREADY claims the
      // thread. linkCaseSource is additive here by construction: a message id
      // that was already a source is one of the duplicates skipped above, so
      // this cannot restate an existing link's method — constraint 6.
      linkCaseSource(db, {
        namespace, caseId, sourceType: 'GMAIL_MESSAGE', sourceRef: m.id,
        linkMethod: 'DETERMINISTIC_IDENTIFIER', discoveredBy: 'intake-backfill',
        evidence:
          `historical backfill: message ${m.id} on thread ${candidate.threadId}, `
          + `which ${caseId} already claimed canonically. NOT triaged: no verdict `
          + `was made about this message, then or now.`,
      }, now)
      written++
    }
  }).immediate()

  return done({
    outcome: written > 0 ? 'BACKFILLED' : 'ALREADY_COMPLETE',
    caseId, fetched: messages.length, written, duplicates,
  })
}

/** Run a bounded batch. Sequential on purpose: a read-only backfill has no
 *  reason to be fast, and a serial run keeps the mailbox cost legible. */
export async function runBackfill(
  db: Database.Database,
  namespace: CaseNamespace,
  fetch: ThreadFetcher,
  limit: number,
  now: number,
  clock: () => number = Date.now,
): Promise<BackfillRunReport> {
  const startedAt = clock()
  const candidates = backfillCandidates(db, namespace, limit)
  const threads: BackfillThreadReport[] = []
  const totals = EMPTY_TOTALS()

  for (const c of candidates) {
    const r = await backfillThread(db, namespace, c, fetch, now, clock)
    threads.push(r)
    totals[r.outcome]++
    totals.fetched += r.fetched
    totals.written += r.written
    totals.duplicates += r.duplicates
  }

  return { namespace, examined: candidates.length, threads, totals, elapsedMs: clock() - startedAt }
}
