// Personal Chief of Staff (COS) — email-triage → intake bridge.
//
// The hard parts of "email monitoring" already exist: the read-only Google MCP
// reads Gmail, and the email-triage heartbeat (email-triage-fetch.py, run every
// few hours) polls both accounts, strips noise, and dedups already-reported
// messages. This bridge is the small glue that turns a TRIAGED email (a real
// candidate the heartbeat picked) into a COS case — feeding it through the
// intake instead of only pinging Istvan. Direction-aware (inbound vs his own
// sent), self-send filtered, and idempotent: a message already in
// email_processing is ALREADY_PROCESSED (no duplicate case, no clobbering a
// terminal row). No LLM here — the triage verdict is decided upstream (the
// heartbeat) and passed in.

import type Database from 'better-sqlite3'
import { openBatch, TRIAGE_BATCH_PREFIX } from './email-ingest.js'
import { ingestEmail, type EmailIntakeInput, type IntakeOutcome } from './intake.js'
import type { CaseSensitivity } from './schema.js'
import { recordTriageReceipt } from './triage-provenance.js'

export interface TriagedEmail {
  accountId: string
  messageId: string
  /** §8 / IN-2: supply it whenever the source has it. Omitting it no longer
   *  writes a NULL — the message is filed as its own thread and flagged derived
   *  (see openBatch/resolveThreadId) — but a derived thread cannot link a later
   *  reply back to this case, so omitting it still costs something real. */
  threadId?: string
  subject: string
  from: string
  to?: string
  snippet: string
  direction?: 'INBOUND' | 'OUTBOUND'
  /** The heartbeat's verdict: is this a real to-do worth a case? */
  actionable: boolean
  caseType?: string
  title?: string
  declaredSensitivity?: CaseSensitivity
  followUpAt?: number
  headers?: Record<string, string>
  /** Verdict priority. It reaches the CASE, so it must reach the RECEIPT too:
   *  a receipt that omits part of the verdict cannot prove what opened the case. */
  priority?: string
  /** Stage 2G provenance (all optional; absence is recorded as UNDECLARED). */
  sourceManifestHash?: string
  triageActor?: string
  triageModel?: string
  triagePromptFingerprint?: string
  triageDecidedAt?: number
}

export type BridgeOutcome = IntakeOutcome | 'ALREADY_PROCESSED'

export interface BridgeResult {
  outcome: BridgeOutcome
  caseId?: string
  messageStatus: string
}

/** Ingest one triaged email into the COS. Idempotent per (account, message):
 *  a message already seen returns ALREADY_PROCESSED and is left untouched. */
export function ingestTriagedEmail(db: Database.Database, input: TriagedEmail, now: number): BridgeResult {
  const existing = db.prepare(
    `SELECT status FROM email_processing WHERE gmail_account_id = ? AND message_id = ?`
  ).get(input.accountId, input.messageId) as { status: string } | undefined
  if (existing) return { outcome: 'ALREADY_PROCESSED', messageStatus: existing.status }

  // A minimal per-email batch (the authoritative history-sync checkpoint model
  // is not used here — the heartbeat's own --mark file is the poll-level dedup,
  // and email_processing's UNIQUE is the case-level dedup).
  //
  // The TRIAGE_BATCH_PREFIX is load-bearing, not cosmetic: it is how
  // tryAdvanceCheckpoint knows this batch's cursor_after is a wall-clock stamp
  // and not a Gmail historyId, so closing it must never write the account
  // checkpoint. Every triage batch that closed used to stamp `triage-<unix>`
  // into email_source_checkpoints for the real account id, filling the P0.2
  // cursor the whole state machine reads with a string no history poller can
  // start from.
  // Stage 2G: the judgement becomes durable BEFORE the case it authorises.
  // Undeclared actor/model/prompt fields are recorded as UNDECLARED rather than
  // dropped, so the gap stays countable instead of looking like a decision.
  recordTriageReceipt(db, {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: input.sourceManifestHash ?? null,
    actionable: input.actionable, caseType: input.caseType ?? null, title: input.title ?? null,
    workspace: null, priority: input.priority ?? null, declaredSensitivity: input.declaredSensitivity ?? null,
    actor: input.triageActor ?? null, model: input.triageModel ?? null,
    promptFingerprint: input.triagePromptFingerprint ?? null,
    decidedAt: input.triageDecidedAt ?? now,
  }, now)

  const batchId = `${TRIAGE_BATCH_PREFIX}${input.accountId}-${input.messageId}`
  openBatch(db, {
    batchId, accountId: input.accountId, cursorBefore: null, cursorAfter: `${TRIAGE_BATCH_PREFIX}${now}`,
    messages: [{ messageId: input.messageId, threadId: input.threadId }],
  }, now)

  const intakeInput: EmailIntakeInput = {
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId,
    subject: input.subject, from: input.from, to: input.to, snippet: input.snippet,
    actionable: input.actionable, caseType: input.caseType, title: input.title,
    declaredSensitivity: input.declaredSensitivity, direction: input.direction,
    followUpAt: input.followUpAt, headers: input.headers,
    priority: input.priority,
    // Stage 2G: forwarded VERBATIM. The receipt above was written from these
    // values, and the intake re-derives the fingerprint from what it receives —
    // so dropping them here would make the gate reject the very receipt this
    // function just wrote, and only after activation, when the fields stop
    // being UNDECLARED on both sides at once.
    sourceManifestHash: input.sourceManifestHash,
    triageActor: input.triageActor,
    triageModel: input.triageModel,
    triagePromptFingerprint: input.triagePromptFingerprint,
  }
  const res = ingestEmail(db, intakeInput, now)
  return { outcome: res.outcome, caseId: res.caseId, messageStatus: res.messageStatus }
}
