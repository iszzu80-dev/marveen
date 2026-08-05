// Personal Chief of Staff (COS) — email → case intake (inbound behavior).
//
// Turns a DISCOVERED email (from openBatch) into a case, composing the pieces
// built in this slice set: the email_processing state machine, the case store,
// and the sensitivity policy. This is where a message becomes work:
//   - not actionable → EXCLUDED (noise; the batch can still terminalize).
//   - actionable, new thread → CLAIMED → a new case is created (its sensitivity
//     is the ESCALATED tier of the declared value vs the actual content) →
//     LOCAL_APPLIED with the case_id. (The SOURCE_COMMITTED / Gmail-label step
//     is the source side, done once the connector confirms — separate.)
//   - actionable, thread already has a case → DUPLICATE, linked to that case.
//
// Pure DB composition — no Gmail client, so it builds/tests before the live
// connector. The triage decision (actionable? case_type?) is the caller's
// (heartbeat/LLM); this module executes it consistently and safely.

import type Database from 'better-sqlite3'
import { createCase } from './case-store.js'
import { claimMessage, localApply, excludeMessage, markDuplicate } from './email-ingest.js'
import { effectiveSensitivity } from './sensitivity.js'
import type { CaseSensitivity } from './schema.js'

export interface EmailIntakeInput {
  accountId: string
  /** Must already exist as DISCOVERED (via openBatch). */
  messageId: string
  threadId?: string
  subject: string
  from: string
  /** Body/snippet used (with the subject) to classify sensitivity. */
  snippet: string
  /** Triage verdict from the caller. */
  actionable: boolean
  caseType?: string
  title?: string
  /** Owner-declared floor; the content can only escalate it. */
  declaredSensitivity?: CaseSensitivity
  priority?: string
}

export type IntakeOutcome = 'CASE_CREATED' | 'LINKED_DUPLICATE' | 'EXCLUDED'

export interface IntakeResult {
  outcome: IntakeOutcome
  caseId?: string
  messageStatus: string
  sensitivity?: CaseSensitivity
}

function findActiveCaseByThread(db: Database.Database, threadId: string): { case_id: string } | undefined {
  return db.prepare(
    `SELECT case_id FROM personal_cases
     WHERE gmail_thread_ids LIKE ? AND archived_at IS NULL
       AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED') LIMIT 1`
  ).get(`%"${threadId}"%`) as { case_id: string } | undefined
}

export function ingestEmail(db: Database.Database, input: EmailIntakeInput, now: number): IntakeResult {
  if (!input.actionable) {
    excludeMessage(db, input.accountId, input.messageId, now)
    return { outcome: 'EXCLUDED', messageStatus: 'EXCLUDED' }
  }

  const tx = db.transaction((): IntakeResult => {
    claimMessage(db, input.accountId, input.messageId, now)

    if (input.threadId) {
      const existing = findActiveCaseByThread(db, input.threadId)
      if (existing) {
        markDuplicate(db, input.accountId, input.messageId, now)
        // record which case it belongs to even though it's a duplicate message
        db.prepare(`UPDATE email_processing SET case_id=@caseId WHERE gmail_account_id=@acc AND message_id=@mid`)
          .run({ caseId: existing.case_id, acc: input.accountId, mid: input.messageId })
        return { outcome: 'LINKED_DUPLICATE', caseId: existing.case_id, messageStatus: 'DUPLICATE' }
      }
    }

    const caseId = `case-${input.accountId}-${input.messageId}`
    const tier = effectiveSensitivity(input.declaredSensitivity ?? 'PERSONAL', `${input.subject}\n${input.snippet}`)
    createCase(db, {
      caseId,
      title: input.title ?? input.subject,
      caseType: input.caseType ?? 'EMAIL',
      description: `From: ${input.from}`,
      sensitivity: tier,
      priority: input.priority ?? 'P2',
      sourceSystem: 'gmail',
      sourceReference: input.messageId,
    }, now)
    if (input.threadId) {
      db.prepare(`UPDATE personal_cases SET gmail_thread_ids=@t WHERE case_id=@id`)
        .run({ t: JSON.stringify([input.threadId]), id: caseId })
    }
    localApply(db, input.accountId, input.messageId, caseId, now)
    return { outcome: 'CASE_CREATED', caseId, messageStatus: 'LOCAL_APPLIED', sensitivity: tier }
  })
  return tx()
}
