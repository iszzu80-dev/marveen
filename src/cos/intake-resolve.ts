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
import {
  resolveCaseByReplyReference, type ThreadLookup, type ReplyReferenceResolution,
} from './reply-reference.js'
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
  const referenceResolution = await resolveReferencesForIntake(db, input, mailboxes)
  return ingestEmail(db, referenceResolution ? { ...input, referenceResolution } : input, now)
}

/**
 * The lookup ALONE, without the ingest that usually follows it.
 *
 * It is separate because the live path could not use the wrapper. Real triaged
 * mail enters through `ingestTriagedEmail`, which is synchronous and runs the
 * idempotency check and its writes inside ONE immediate transaction; an async
 * mailbox round-trip cannot go in there, and wrapping the transaction would put
 * the network call inside the lock.
 *
 * That mattered more than it sounds. The wrapper shipped with no production
 * caller at all: every real email still went straight to `ingestEmail`, so the
 * whole reply/reference route was dead code that only tests ever reached, and
 * its tests passed the entire time. Resolving BEFORE the transaction and passing
 * the answer in is what actually put it on the live path.
 */
export async function resolveReferencesForIntake(
  db: Database.Database,
  input: Pick<EmailIntakeInput, 'threadId' | 'headers'>,
  mailboxes: ReadonlyArray<Mailbox>,
): Promise<ReplyReferenceResolution | undefined> {
  const threadKnown = input.threadId ? openCasesClaimingThread(db, input.threadId).length > 0 : false
  if (threadKnown || !input.headers) return undefined

  const headers = input.headers
  const pick = (name: string) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null

  return await resolveCaseByReplyReference(
    { inReplyTo: pick('in-reply-to'), references: pick('references') },
    mailboxes,
    (threadId) => openCasesClaimingThread(db, threadId),
  ) ?? undefined
}
