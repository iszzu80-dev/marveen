// THE EDGE where the intake's facts are gathered.
//
// `ingestEmail` is synchronous and decides over given facts; finding out what a
// message replies to needs a mailbox. This module is that lookup and nothing
// else, so the decision stays pure and the I/O stays testable in isolation.
//
// It exists as a wrapper rather than a parameter because of a failure earlier
// the same day: the Gmail transport needed a thread id on send, the caller had
// to remember to pass it, and the first real customer reply went out on a split
// thread because nobody did. A field the caller must remember is a field the
// caller will forget. Callers get the resolution by using this function.

import type Database from 'better-sqlite3'
import { ingestEmail, type EmailIntakeInput, type IntakeResult } from './intake.js'
import { resolveCaseByReplyReference, type ThreadLookup } from './reply-reference.js'
import { findCasesForSource } from './case-sources.js'

export interface Mailbox {
  /** Stable identifier recorded in the evidence, e.g. 'private' | 'zst'. */
  id: string
  lookup: ThreadLookup
}

/** Open cases claiming a conversation. ALL of them, because the ambiguity has
 *  to survive the lookup in order to be reportable — a "best" answer here would
 *  be the tie-break the owner ruled out, wearing a helpful name. */
export function openCasesClaimingThread(db: Database.Database, threadId: string): string[] {
  const claims = findCasesForSource(db, 'personal', 'GMAIL_THREAD', threadId)
  if (!claims.length) return []
  const rows = db.prepare(
    `SELECT case_id FROM personal_cases
      WHERE case_id IN (${claims.map(() => '?').join(',')})
        AND archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
      ORDER BY updated_at DESC`,
  ).all(...claims.map((c) => c.caseId)) as Array<{ case_id: string }>
  return rows.map((r) => r.case_id)
}

/**
 * Ingest an email, having first asked what it replies to.
 *
 * The resolution is attempted ONLY when the thread is unknown to us. Asking
 * anyway would spend a mailbox round-trip to answer a question already
 * answered, and would risk the parent's case quietly outranking the
 * conversation's — which is the wrong order (see `intake.ts`).
 *
 * A resolution failure is not an ingest failure. If the mailboxes cannot be
 * reached the message is ingested exactly as it would have been before this
 * feature existed: a possibly-orphaned case is recoverable, a dropped email is
 * not.
 */
export async function ingestEmailWithReferences(
  db: Database.Database,
  input: EmailIntakeInput,
  mailboxes: ReadonlyArray<Mailbox>,
  now: number,
): Promise<IntakeResult> {
  const threadKnown = input.threadId ? openCasesClaimingThread(db, input.threadId).length > 0 : false
  if (threadKnown || !input.headers) return ingestEmail(db, input, now)

  const headers = input.headers
  const pick = (name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null

  const referenceResolution = await resolveCaseByReplyReference(
    { inReplyTo: pick('in-reply-to'), references: pick('references') },
    mailboxes,
    (threadId) => openCasesClaimingThread(db, threadId),
  ) ?? undefined

  return ingestEmail(db, { ...input, referenceResolution }, now)
}
