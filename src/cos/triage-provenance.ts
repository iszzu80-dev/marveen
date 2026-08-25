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

/** The Stage 2G gate, bound to the EXACT verdict (Istvan, 2026-08-17, second pass).
 *
 *  "Some receipt exists for this message" was too weak, and the weakness was
 *  precise: once a message has two verdicts, that check proves only that a
 *  judgement was made at some point — not that THIS case came from THIS one.
 *  So the gate re-derives the fingerprint from the verdict the intake is acting
 *  on and demands that exact row. A stale or foreign receipt cannot satisfy it,
 *  because a different verdict simply hashes elsewhere.
 *
 *  Returns the receipt id, so the caller can record what opened the case rather
 *  than assert it. */
export function requireExactTriageReceipt(db: Database.Database, verdict: TriageReceiptInput): string {
  initTriageProvenanceSchema(db)
  const receiptId = triageReceiptId(verdict)
  const row = db.prepare(
    'SELECT receipt_id FROM cos_triage_provenance WHERE receipt_id=?'
  ).get(receiptId) as { receipt_id: string } | undefined
  if (row) return receiptId

  const anyForMessage = db.prepare(
    'SELECT COUNT(*) AS n FROM cos_triage_provenance WHERE account_id=? AND message_id=?'
  ).get(verdict.accountId, verdict.messageId) as { n: number }
  if (anyForMessage.n > 0) {
    // The interesting failure: receipts exist, but none of them is this verdict.
    throw new Error(
      `TRIAGE_PROVENANCE_VERDICT_MISMATCH: ${verdict.accountId}/${verdict.messageId} has `
      + `${anyForMessage.n} receipt(s), none matching the verdict now being applied `
      + `(expected ${receiptId}); a case may only be opened by the receipt that decided it`)
  }
  throw new Error(
    `TRIAGE_PROVENANCE_MISSING: no triage receipt for ${verdict.accountId}/${verdict.messageId}; `
    + 'an email-derived case may not be created without one (Stage 2G)')
}

/** Go-forward readiness (Stage 2G). After the activation cutoff every heartbeat
 *  receipt must name its actor, model, prompt fingerprint and the exact input it
 *  judged. Receipts written BEFORE the cutoff are left alone on purpose: history
 *  is NOT_REPLAYABLE, and back-filling it would manufacture provenance that never
 *  existed — the precise failure this whole stage exists to avoid. */
export function goForwardProvenanceStatus(db: Database.Database, cutoff: number): {
  status: 'PASS' | 'GO_FORWARD_PROVENANCE_INCOMPLETE'
  cutoff: number
  examined: number
  incomplete: number
  offenders: Array<{ receiptId: string; missing: string[] }>
} {
  initTriageProvenanceSchema(db)
  const rows = db.prepare(
    `SELECT receipt_id, actor, model, prompt_fingerprint, source_manifest_hash
     FROM cos_triage_provenance WHERE decided_at >= ? ORDER BY decided_at, receipt_id`
  ).all(cutoff) as Array<Record<string, string | null>>
  const offenders: Array<{ receiptId: string; missing: string[] }> = []
  for (const r of rows) {
    const missing: string[] = []
    if (!r.actor || r.actor === UNDECLARED) missing.push('actor')
    if (!r.model || r.model === UNDECLARED) missing.push('model')
    if (!r.prompt_fingerprint || r.prompt_fingerprint === UNDECLARED) missing.push('promptFingerprint')
    if (!r.source_manifest_hash) missing.push('sourceManifestHash')
    if (missing.length) offenders.push({ receiptId: String(r.receipt_id), missing })
  }
  return {
    status: offenders.length ? 'GO_FORWARD_PROVENANCE_INCOMPLETE' : 'PASS',
    cutoff, examined: rows.length, incomplete: offenders.length, offenders,
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
