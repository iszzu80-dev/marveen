// ZST Radio Kft. Chief of Staff (Slice 1) — ZST email → operational zst_case intake.
// Connector identity is the namespace security boundary. This module never
// routes between Personal and ZST; it only operates inside the ZST store.
//
// Read-only with respect to Gmail: NO label/write/send. Local ZST persistence is
// transactional and idempotent per (account,message).

import type Database from 'better-sqlite3'
import { createZstCase, type ZstWorkspace } from './zst-case-store.js'
import { effectiveZstSensitivity, coerceZstSensitivity } from './zst-sensitivity.js'
import { IDEMPOTENCY_HEADER } from './adapters/gmail-send.js'
import { ingestZstInvoiceEmail } from './zst-invoice-extract.js'
import { ingestZstContractEmail } from './zst-contract-extract.js'
import { seedCaseProgressionState } from './case-progression-seed.js'
import { projectZstOperationalIntake } from './zst-operational-projector.js'
import { recordTemporalFact } from './temporal-facts.js'
import { classifyActionability } from './actionability.js'
import { recordTriageReceipt, requireExactTriageReceipt } from './triage-provenance.js'

export const INVOICE_CASE_TYPES = new Set(['INVOICE_INCOMING', 'INVOICE_OUTGOING'])
export const CONTRACT_CASE_TYPES = new Set(['CONTRACT', 'LICENSE_SUBSCRIPTION'])

export type ZstExtractorRoute = 'INVOICE' | 'CONTRACT'

/** Which production extractor a caseType routes to, or null for none.
 *
 *  Exported and used by `ingestTriagedZstEmail` itself so there is exactly ONE
 *  copy of this gate. The Clean Replay extractor-parity surface imports it: a
 *  replay that re-declared the same two sets would fire on its own set of
 *  threads the moment either side drifted, and would then report the resulting
 *  silence as agreement. That is the failure this rebuild removes, so the gate
 *  is a single function and the replay measures the one production runs. */
export function routeZstExtractor(caseType: string): ZstExtractorRoute | null {
  if (INVOICE_CASE_TYPES.has(caseType)) return 'INVOICE'
  if (CONTRACT_CASE_TYPES.has(caseType)) return 'CONTRACT'
  return null
}

export interface ZstTriagedEmail {
  accountId: string
  messageId: string
  threadId?: string
  subject: string
  from: string
  to?: string
  snippet: string
  direction?: 'INBOUND' | 'OUTBOUND'
  actionable: boolean
  caseType?: string
  title?: string
  workspace?: ZstWorkspace
  declaredSensitivity?: string
  priority?: string
  followUpAt?: number
  headers?: Record<string, string>
  body?: string  /** Stage 2G provenance (all optional; absence is recorded as UNDECLARED). */
  sourceManifestHash?: string
  triageActor?: string
  triageModel?: string
  triagePromptFingerprint?: string
  triageDecidedAt?: number
}

export type ZstIntakeOutcome =
  | 'CASE_CREATED' | 'LINKED_DUPLICATE' | 'EXCLUDED' | 'EXCLUDED_SELF_SEND' | 'ALREADY_PROCESSED'

export interface ZstIntakeResult {
  outcome: ZstIntakeOutcome
  caseId?: string
  messageStatus: string
  sensitivity?: string
  actionability?: string
  extractionState?: 'NOT_ATTEMPTED' | 'ATTEMPTED' | 'FAILED'
}

function recordLedger(db: Database.Database, input: ZstTriagedEmail, status: string, caseId: string | null, now: number, receiptId?: string): void {
  db.prepare(
    `INSERT INTO zst_email_processing (gmail_account_id, message_id, thread_id, case_id, status, triage_receipt_id, created_at)
     VALUES (@acc, @mid, @tid, @cid, @status, @rid, @now)`
  ).run({ acc: input.accountId, mid: input.messageId, tid: input.threadId ?? null, cid: caseId, status, rid: receiptId ?? null, now })
}

function findActiveZstCaseByThread(db: Database.Database, threadId: string): { case_id: string } | undefined {
  const byCase = db.prepare(
    `SELECT case_id FROM zst_cases
     WHERE gmail_thread_ids LIKE ? AND archived_at IS NULL
       AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED','FAILED_TERMINAL') LIMIT 1`
  ).get(`%"${threadId}"%`) as { case_id: string } | undefined
  if (byCase) return byCase
  return db.prepare(
    `SELECT l.case_id FROM zst_outbound_ledger l
     JOIN zst_cases c ON c.case_id = l.case_id
     WHERE l.thread_ref = ? AND c.archived_at IS NULL
       AND c.status NOT IN ('COMPLETED','CANCELLED','ARCHIVED','FAILED_TERMINAL')
     ORDER BY l.created_at DESC LIMIT 1`
  ).get(threadId) as { case_id: string } | undefined
}

/** Ingest one triaged ZST email. New v1.2 invariant: a created open case leaves
 * this transaction with an explicit next action + owner, or the transaction
 * fails and no half-operational case is committed. */
export function ingestTriagedZstEmail(db: Database.Database, input: ZstTriagedEmail, now: number): ZstIntakeResult {
  const existing = db.prepare(
    `SELECT status FROM zst_email_processing WHERE gmail_account_id = ? AND message_id = ?`
  ).get(input.accountId, input.messageId) as { status: string } | undefined
  if (existing) return { outcome: 'ALREADY_PROCESSED', messageStatus: existing.status }

  if (input.headers && input.headers[IDEMPOTENCY_HEADER]) {
    recordLedger(db, input, 'EXCLUDED_SELF_SEND', null, now)
    return { outcome: 'EXCLUDED_SELF_SEND', messageStatus: 'EXCLUDED_SELF_SEND' }
  }

  const ownSend = db.prepare(
    `SELECT case_id FROM zst_outbound_ledger WHERE external_ref = ? LIMIT 1`
  ).get(input.messageId) as { case_id: string | null } | undefined
  if (ownSend?.case_id) {
    recordLedger(db, input, 'DUPLICATE', ownSend.case_id, now)
    return { outcome: 'LINKED_DUPLICATE', caseId: ownSend.case_id, messageStatus: 'DUPLICATE' }
  }

  recordTriageReceipt(db, {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: input.sourceManifestHash ?? null,
    actionable: input.actionable, caseType: input.caseType ?? null, title: input.title ?? null,
    workspace: input.workspace ?? null, priority: input.priority ?? null,
    declaredSensitivity: input.declaredSensitivity ?? null,
    actor: input.triageActor ?? null, model: input.triageModel ?? null,
    promptFingerprint: input.triagePromptFingerprint ?? null,
    decidedAt: input.triageDecidedAt ?? now,
  }, now)
  const triageReceiptId = requireExactTriageReceipt(db, {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: input.sourceManifestHash ?? null,
    actionable: input.actionable, caseType: input.caseType ?? null, title: input.title ?? null,
    workspace: input.workspace ?? null, priority: input.priority ?? null,
    declaredSensitivity: input.declaredSensitivity ?? null,
    actor: input.triageActor ?? null, model: input.triageModel ?? null,
    promptFingerprint: input.triagePromptFingerprint ?? null,
  })
  if (!input.actionable) {
    recordLedger(db, input, 'EXCLUDED', null, now, triageReceiptId)
    return { outcome: 'EXCLUDED', messageStatus: 'EXCLUDED' }
  }

  const direction: 'INBOUND' | 'OUTBOUND' = input.direction === 'OUTBOUND' ? 'OUTBOUND' : 'INBOUND'
  const fullText = input.body ?? input.snippet
  const caseType = input.caseType ?? 'GENERAL_OPERATION'
  const operational = projectZstOperationalIntake({
    caseType, direction, subject: input.subject, body: fullText,
    from: input.from, to: input.to, occurredAt: now, explicitFollowUpAt: input.followUpAt,
  })

  const tx = db.transaction((): ZstIntakeResult => {
    if (input.threadId) {
      const existingCase = findActiveZstCaseByThread(db, input.threadId)
      if (existingCase) {
        recordLedger(db, input, 'DUPLICATE', existingCase.case_id, now, triageReceiptId)
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
      caseType,
      workspace: input.workspace ?? 'OPERATIONS',
      status: operational.status,
      description: direction === 'OUTBOUND' ? `Sent to: ${input.to ?? '?'}` : `From: ${input.from}`,
      sensitivity: tier,
      priority: input.priority ?? 'P2',
      sourceSystem: 'gmail-zst',
      sourceReference: input.messageId,
      triageReceiptId,
    }, now)

    const patch: Record<string, unknown> = {
      next_action: operational.nextAction,
      next_action_owner: operational.nextActionOwner,
      waiting_on: operational.waitingOn,
      follow_up_at: operational.followUpAt,
    }
    if (input.threadId) patch.gmail_thread_ids = JSON.stringify([input.threadId])
    const keys = Object.keys(patch)
    db.prepare(`UPDATE zst_cases SET ${keys.map((k) => `${k}=@${k}`).join(', ')} WHERE case_id=@id`)
      .run({ ...patch, id: caseId })

    // Semantic dates are evidence, not guessed scalar due_at values. Text
    // extraction starts UNVERIFIED and must pass TSCG verification before a
    // binding deadline can authorize progression.
    for (const [index, claim] of operational.temporalClaims.entries()) {
      recordTemporalFact(db, {
        factId: `zst:${input.accountId}:${input.messageId}:${index}`,
        domain: 'zst', caseId, kind: claim.kind, occursAt: claim.occursAt,
        sourceSystem: 'gmail-zst', sourceReference: input.messageId,
        sourceField: input.body ? 'body' : 'snippet', rawText: claim.raw,
        verification: 'UNVERIFIED', confidence: input.body ? 0.65 : 0.45,
        actor: 'zst-intake',
      }, now)
    }

    let extractionState: ZstIntakeResult['extractionState'] = 'NOT_ATTEMPTED'
    const route = routeZstExtractor(caseType)
    if (route) {
      extractionState = 'ATTEMPTED'
      const src = {
        caseId, from: input.from, subject: input.subject, body: fullText,
        extractionSource: (input.body ? 'FULL_BODY' : 'SNIPPET') as 'FULL_BODY' | 'SNIPPET',
      }
      try {
        if (route === 'INVOICE') ingestZstInvoiceEmail(db, src, now)
        else ingestZstContractEmail(db, src, now)
      } catch {
        extractionState = 'FAILED'
      }
    }

    const actionability = classifyActionability({
      status: operational.status, nextAction: operational.nextAction,
      nextActionOwner: operational.nextActionOwner, waitingOn: operational.waitingOn,
      followUpAt: operational.followUpAt,
    })
    if (!actionability.valid || actionability.classification === 'ORPHAN') {
      throw new Error(`ZST_INTAKE_ORPHAN: ${actionability.reasons.join('; ')}`)
    }

    recordLedger(db, input, 'LOCAL_APPLIED', caseId, now, triageReceiptId)
    seedCaseProgressionState(db, 'zst', caseId, now)
    return {
      outcome: 'CASE_CREATED', caseId, messageStatus: 'LOCAL_APPLIED', sensitivity: tier,
      actionability: actionability.classification, extractionState,
    }
  })
  return tx()
}
