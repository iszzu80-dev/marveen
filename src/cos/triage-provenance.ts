// Stage 2G — go-forward triage provenance (Istvan, 2026-08-17).
//
// The 2026-08-17 audit measured that NOTHING of a triage judgement survives it:
// the CREATED event's payload is NULL, both processing ledgers store only
// account/message/thread/status, and `content_hash` is unwritten in every row.
// The case row keeps the RESULT, which is exactly the part a replay cannot use
// as evidence — it is the answer, not the reasoning or its inputs.
//
// This module makes the judgement itself durable, from now on. It does not
// pretend to recover the past: history stays NOT_REPLAYABLE, and saying so is
// the point.
//
// Two properties, both load-bearing:
//   append-only  a re-decision is a NEW receipt. Nothing is ever updated, so a
//                later verdict cannot quietly overwrite the one a case was
//                actually opened on.
//   idempotent   the SAME verdict for the same message re-posted returns the
//                same receipt id instead of a second row, so a retried intake
//                does not inflate the record.
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export const TRIAGE_PROVENANCE_SCHEMA_VERSION = 1

/** Explicit marker for a field the caller did not declare. It is recorded, not
 *  defaulted away: an undeclared model is a gap someone can count, whereas a
 *  NULL is a gap that looks like a design decision. */
export const UNDECLARED = 'UNDECLARED'

export interface TriageReceiptInput {
  accountId: string
  messageId: string
  threadId?: string | null
  /** Hash of the source the verdict was made on (body/snippet as received). */
  sourceManifestHash?: string | null
  actionable: boolean
  caseType?: string | null
  title?: string | null
  workspace?: string | null
  priority?: string | null
  declaredSensitivity?: string | null
  /** Who decided. An agent name, not a session id. */
  actor?: string | null
  /** Model identity where one applies (a code classifier declares 'CODE:<fn>'). */
  model?: string | null
  /** Fingerprint of the prompt/rule/spec the decision was made under. */
  promptFingerprint?: string | null
  decidedAt?: number | null
}

export interface TriageReceipt {
  receiptId: string
  created: boolean
}

export function initTriageProvenanceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cos_triage_provenance (
      receipt_id            TEXT PRIMARY KEY,
      schema_version        INTEGER NOT NULL,
      account_id            TEXT NOT NULL,
      message_id            TEXT NOT NULL,
      thread_id             TEXT,
      source_manifest_hash  TEXT,
      actionable            INTEGER NOT NULL,
      case_type             TEXT,
      title                 TEXT,
      workspace             TEXT,
      priority              TEXT,
      declared_sensitivity  TEXT,
      actor                 TEXT NOT NULL,
      model                 TEXT NOT NULL,
      prompt_fingerprint    TEXT NOT NULL,
      decided_at            INTEGER NOT NULL,
      created_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_triage_prov_msg
      ON cos_triage_provenance(account_id, message_id, created_at);
  `)
}

/** The receipt id IS the verdict's fingerprint, so idempotency needs no
 *  separate uniqueness rule: the same decision hashes to the same id, and a
 *  changed decision cannot collide with the one it replaces. */
export function triageReceiptId(input: TriageReceiptInput): string {
  const canonical = JSON.stringify([
    TRIAGE_PROVENANCE_SCHEMA_VERSION,
    input.accountId, input.messageId, input.threadId ?? null,
    input.sourceManifestHash ?? null,
    input.actionable ? 1 : 0,
    input.caseType ?? null, input.title ?? null, input.workspace ?? null,
    input.priority ?? null, input.declaredSensitivity ?? null,
    input.actor ?? UNDECLARED, input.model ?? UNDECLARED,
    input.promptFingerprint ?? UNDECLARED,
  ])
  return `trp:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

export function recordTriageReceipt(
  db: Database.Database, input: TriageReceiptInput, now: number,
): TriageReceipt {
  if (!input.accountId || !input.messageId) {
    throw new Error('triage receipt requires accountId and messageId')
  }
  initTriageProvenanceSchema(db)
  const receiptId = triageReceiptId(input)
  const existing = db.prepare('SELECT receipt_id FROM cos_triage_provenance WHERE receipt_id=?')
    .get(receiptId) as { receipt_id: string } | undefined
  if (existing) return { receiptId, created: false }

  db.prepare(`
    INSERT INTO cos_triage_provenance
      (receipt_id, schema_version, account_id, message_id, thread_id, source_manifest_hash,
       actionable, case_type, title, workspace, priority, declared_sensitivity,
       actor, model, prompt_fingerprint, decided_at, created_at)
    VALUES
      (@receiptId, @schemaVersion, @accountId, @messageId, @threadId, @sourceManifestHash,
       @actionable, @caseType, @title, @workspace, @priority, @declaredSensitivity,
       @actor, @model, @promptFingerprint, @decidedAt, @now)
  `).run({
    receiptId, schemaVersion: TRIAGE_PROVENANCE_SCHEMA_VERSION,
    accountId: input.accountId, messageId: input.messageId, threadId: input.threadId ?? null,
    sourceManifestHash: input.sourceManifestHash ?? null,
    actionable: input.actionable ? 1 : 0,
    caseType: input.caseType ?? null, title: input.title ?? null,
    workspace: input.workspace ?? null, priority: input.priority ?? null,
    declaredSensitivity: input.declaredSensitivity ?? null,
    actor: input.actor || UNDECLARED, model: input.model || UNDECLARED,
    promptFingerprint: input.promptFingerprint || UNDECLARED,
    decidedAt: input.decidedAt ?? now, now,
  })
  return { receiptId, created: true }
}

/** The Stage 2G gate. Throws unless a receipt exists for this message.
 *
 *  It is deliberately a THROW and not a boolean: a case that silently opens with
 *  a missing receipt is exactly the state the 2026-08-17 audit had to reconstruct
 *  from absence, and one that never opens is trivially diagnosable. */
export function requireTriageReceipt(db: Database.Database, accountId: string, messageId: string): void {
  initTriageProvenanceSchema(db)
  const row = db.prepare(
    'SELECT receipt_id FROM cos_triage_provenance WHERE account_id=? AND message_id=? LIMIT 1'
  ).get(accountId, messageId) as { receipt_id: string } | undefined
  if (!row) {
    throw new Error(
      `TRIAGE_PROVENANCE_MISSING: no triage receipt for ${accountId}/${messageId}; `
      + 'an email-derived case may not be created without one (Stage 2G)')
  }
}

export function triageReceiptsFor(
  db: Database.Database, accountId: string, messageId: string,
): Array<Record<string, unknown>> {
  try {
    return db.prepare(
      `SELECT * FROM cos_triage_provenance WHERE account_id=? AND message_id=? ORDER BY created_at, receipt_id`
    ).all(accountId, messageId) as Array<Record<string, unknown>>
  } catch {
    return []
  }
}

/** Coverage, not decoration: how much of the recorded provenance is actually
 *  declared. A store full of UNDECLARED receipts satisfies the gate and proves
 *  nothing, so the number has to be visible. */
export function triageProvenanceCoverage(db: Database.Database): {
  receipts: number; withActor: number; withModel: number; withPromptFingerprint: number; withSourceHash: number
} {
  try {
    const r = db.prepare(`
      SELECT COUNT(*) AS receipts,
             SUM(actor <> '${UNDECLARED}') AS withActor,
             SUM(model <> '${UNDECLARED}') AS withModel,
             SUM(prompt_fingerprint <> '${UNDECLARED}') AS withPromptFingerprint,
             SUM(source_manifest_hash IS NOT NULL) AS withSourceHash
      FROM cos_triage_provenance
    `).get() as Record<string, number | null>
    return {
      receipts: r.receipts ?? 0, withActor: r.withActor ?? 0, withModel: r.withModel ?? 0,
      withPromptFingerprint: r.withPromptFingerprint ?? 0, withSourceHash: r.withSourceHash ?? 0,
    }
  } catch {
    return { receipts: 0, withActor: 0, withModel: 0, withPromptFingerprint: 0, withSourceHash: 0 }
  }
}
