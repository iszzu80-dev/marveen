// ZST Radio Kft. Chief of Staff (Slice 1) — ZST email → zst_case intake
// (read-only). The company mailbox (google-zst) is triaged by the same heartbeat
// as the personal one; a candidate the heartbeat marks actionable for the ZST
// account is POSTed to /api/cos/intake, which routes it HERE (by account) so it
// becomes a zst_case, NOT a personal_case. Connector identity is the scope
// boundary (the ZST account never mixes with personal) — this module just
// executes the triage verdict against the ZST namespace.
//
// Read-only: NO Gmail write (no label, no SOURCE_COMMITTED), NO send. The ledger
// (zst_email_processing) is the per-(account,message) case-level dedup;
// idempotent — a message already seen is ALREADY_PROCESSED, untouched.

import type Database from 'better-sqlite3'
import { createZstCase, type ZstWorkspace } from './zst-case-store.js'
import { effectiveZstSensitivity, coerceZstSensitivity } from './zst-sensitivity.js'
import { IDEMPOTENCY_HEADER } from './adapters/gmail-send.js'
import { ingestZstInvoiceEmail } from './zst-invoice-extract.js'
import { ingestZstContractEmail } from './zst-contract-extract.js'
import { seedCaseProgressionState } from './case-progression-seed.js'

const INVOICE_CASE_TYPES = new Set(['INVOICE_INCOMING', 'INVOICE_OUTGOING'])
const CONTRACT_CASE_TYPES = new Set(['CONTRACT', 'LICENSE_SUBSCRIPTION'])

export interface ZstTriagedEmail {
  accountId: string
  messageId: string
  threadId?: string
  subject: string
  from: string
  to?: string
  snippet: string
  direction?: 'INBOUND' | 'OUTBOUND'
  /** The heartbeat's verdict: a real ZST to-do worth a case? */
  actionable: boolean
  /** ZST case type (spec §8.2). Defaults to GENERAL_OPERATION. */
  caseType?: string
  title?: string
  /** Operations vs Product Lab routing tag. Defaults to OPERATIONS. */
  workspace?: ZstWorkspace
  /** Owner-declared ZST sensitivity floor; content can only escalate it. */
  declaredSensitivity?: string
  priority?: string
  followUpAt?: number
  headers?: Record<string, string>
  /** The FULL message body, when the caller has it. The extractors used to run
   *  on `snippet` — 300 characters — so an amount, an invoice number, a date or
   *  a notice period further down the mail was unrecoverable, and the modules'
   *  promise that it would be "re-extracted later" was met by nothing. */
  body?: string
}

export type ZstIntakeOutcome =
  | 'CASE_CREATED' | 'LINKED_DUPLICATE' | 'EXCLUDED' | 'EXCLUDED_SELF_SEND' | 'ALREADY_PROCESSED'

export interface ZstIntakeResult {
  outcome: ZstIntakeOutcome
  caseId?: string
  messageStatus: string
  sensitivity?: string
}

function recordLedger(
  db: Database.Database,
  input: ZstTriagedEmail, status: string, caseId: string | null, now: number,
): void {
  db.prepare(
    `INSERT INTO zst_email_processing (gmail_account_id, message_id, thread_id, case_id, status, created_at)
     VALUES (@acc, @mid, @tid, @cid, @status, @now)`
  ).run({ acc: input.accountId, mid: input.messageId, tid: input.threadId ?? null, cid: caseId, status, now })
}

function findActiveZstCaseByThread(db: Database.Database, threadId: string): { case_id: string } | undefined {
  const byCase = db.prepare(
    `SELECT case_id FROM zst_cases
     WHERE gmail_thread_ids LIKE ? AND archived_at IS NULL
       AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED','FAILED_TERMINAL') LIMIT 1`
  ).get(`%"${threadId}"%`) as { case_id: string } | undefined
  if (byCase) return byCase

  // Second source, ported from the personal intake (2026-08-13) and not
  // redundant: gmail_thread_ids is written ONLY at case creation, from the
  // intake message's thread. A case that we WROTE to — where the thread exists
  // because our own letter created it — has nothing in that column, so the
  // company's answer to a company letter would find no case and open a second
  // one. The ledger knows which thread each sent action landed in.
  return db.prepare(
    `SELECT l.case_id FROM zst_outbound_ledger l
     JOIN zst_cases c ON c.case_id = l.case_id
     WHERE l.thread_ref = ? AND c.archived_at IS NULL
       AND c.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED','FAILED_TERMINAL')
     ORDER BY l.created_at DESC LIMIT 1`
  ).get(threadId) as { case_id: string } | undefined
}

/** Ingest one triaged ZST email into a zst_case. Idempotent per (account,
 *  message): a message already in zst_email_processing is ALREADY_PROCESSED. */
export function ingestTriagedZstEmail(db: Database.Database, input: ZstTriagedEmail, now: number): ZstIntakeResult {
  const existing = db.prepare(
    `SELECT status FROM zst_email_processing WHERE gmail_account_id = ? AND message_id = ?`
  ).get(input.accountId, input.messageId) as { status: string } | undefined
  if (existing) return { outcome: 'ALREADY_PROCESSED', messageStatus: existing.status }

  // Self-event filter: our own idempotency marker means the COS executor sent it.
  if (input.headers && input.headers[IDEMPOTENCY_HEADER]) {
    recordLedger(db, input, 'EXCLUDED_SELF_SEND', null, now)
    return { outcome: 'EXCLUDED_SELF_SEND', messageStatus: 'EXCLUDED_SELF_SEND' }
  }

  // The same check without headers (ported 2026-08-13; the personal intake has
  // had it since 2026-08-10, live). The triage feeder queries BOTH accounts'
  // `in:sent` and posts candidates carrying no headers at all, so the marker
  // check above cannot fire for them — the feeder's own comment claiming it
  // does is wrong for this path. Without this, a corporate letter we sent on a
  // NEW thread comes back as an OUTBOUND candidate inside the feeder's window,
  // matches no case, and opens a SECOND zst_case in WAITING_EXTERNAL with a
  // follow-up: duplicate work, and a self-follow-up loop on company mail.
  //
  // Linked to the originating case rather than merely excluded: the sent letter
  // IS part of that case's history, and dropping it loses the record of what
  // went out.
  const ownSend = db.prepare(
    `SELECT case_id FROM zst_outbound_ledger WHERE external_ref = ? LIMIT 1`
  ).get(input.messageId) as { case_id: string | null } | undefined
  if (ownSend?.case_id) {
    recordLedger(db, input, 'DUPLICATE', ownSend.case_id, now)
    return { outcome: 'LINKED_DUPLICATE', caseId: ownSend.case_id, messageStatus: 'DUPLICATE' }
  }

  if (!input.actionable) {
    recordLedger(db, input, 'EXCLUDED', null, now)
    return { outcome: 'EXCLUDED', messageStatus: 'EXCLUDED' }
  }

  const outbound = input.direction === 'OUTBOUND'
  const tx = db.transaction((): ZstIntakeResult => {
    if (input.threadId) {
      const existingCase = findActiveZstCaseByThread(db, input.threadId)
      if (existingCase) {
        recordLedger(db, input, 'DUPLICATE', existingCase.case_id, now)
        return { outcome: 'LINKED_DUPLICATE', caseId: existingCase.case_id, messageStatus: 'DUPLICATE' }
      }
    }

    const caseId = `zst-${input.accountId}-${input.messageId}`
    const tier = effectiveZstSensitivity(
      coerceZstSensitivity(input.declaredSensitivity ?? 'ZST_INTERNAL'),
      `${input.subject}\n${input.snippet}`,
    )
    createZstCase(db, {
      caseId,
      title: input.title ?? input.subject,
      caseType: input.caseType ?? 'GENERAL_OPERATION',
      workspace: input.workspace ?? 'OPERATIONS',
      status: outbound ? 'WAITING_EXTERNAL' : 'NEW',
      description: outbound ? `Sent to: ${input.to ?? '?'}` : `From: ${input.from}`,
      sensitivity: tier,
      priority: input.priority ?? 'P2',
      sourceSystem: 'gmail-zst',
      sourceReference: input.messageId,
    }, now)

    const patch: Record<string, unknown> = {}
    if (input.threadId) patch.gmail_thread_ids = JSON.stringify([input.threadId])
    if (outbound) { patch.waiting_on = `reply from ${input.to ?? 'recipient'}`; patch.follow_up_at = input.followUpAt ?? now + 3 * 86400 }
    const keys = Object.keys(patch)
    if (keys.length) {
      db.prepare(`UPDATE zst_cases SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE case_id=@id`)
        .run({ ...patch, id: caseId })
    }
    // If this is an invoice, run the extractor so the case is backed by a real
    // zst_invoices row (Slice 2). Best-effort: extraction failure never blocks
    // the case creation (the invoice can be re-extracted later).
    if (INVOICE_CASE_TYPES.has(input.caseType ?? '')) {
      try {
        ingestZstInvoiceEmail(db, {
          caseId, from: input.from, subject: input.subject,
          body: input.body ?? input.snippet,
          extractionSource: input.body ? 'FULL_BODY' : 'SNIPPET',
        }, now)
      } catch { /* extraction is best-effort; the case still stands */ }
    }
    // If this is a contract/subscription-renewal case, run the contract extractor
    // so the case is backed by a real zst_contracts row (Slice 3) — this is what
    // makes a renewal notice surface on the due-item runner. Best-effort: the
    // case stands even if extraction fails, and the contract stays UNDER_REVIEW
    // (never auto-signed).
    if (CONTRACT_CASE_TYPES.has(input.caseType ?? '')) {
      try {
        ingestZstContractEmail(db, {
          caseId, from: input.from, subject: input.subject,
          body: input.body ?? input.snippet,
          extractionSource: input.body ? 'FULL_BODY' : 'SNIPPET',
        }, now)
      } catch { /* extraction is best-effort; the case still stands */ }
    }
    recordLedger(db, input, 'LOCAL_APPLIED', caseId, now)
    seedCaseProgressionState(db, 'zst', caseId, now)
    return { outcome: 'CASE_CREATED', caseId, messageStatus: 'LOCAL_APPLIED', sensitivity: tier }
  })
  return tx()
}
