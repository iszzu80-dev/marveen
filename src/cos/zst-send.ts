// ZST Slice 1 write-half — approval-gated ZST send flow. The ZST company mailbox
// can SEND, but only after a per-payload approval and only through the full gate,
// exactly like the personal send-flow — reusing the shared executor state machine
// (executor-core), the shared connector-health, and the ZST sensitivity policy.
//
//   draftZstSend()      PREPARE: typed campaign (no free text) + plan the ledger
//                       row. Sends nothing; not yet approved.
//   approveZstSend()    the owner's YES to THIS exact rendered payload + the
//                       allowed recipient list.
//   rejectZstSend()     abort → cancel the planned row.
//   dispatchZstSend()   send ONLY if the gate passes: connector write-usable AND
//                       ZST sensitivity allows AND the exact payload is approved
//                       at the current version AND the recipient is on the list.
// Nothing sends autonomously. A payload edited after approval fails the hash
// match; a recipient not on the list is vetoed; a free-text campaign is refused.

import type Database from 'better-sqlite3'
import { sha256Hex } from './attachments.js'
import { isUsable } from './connector-health.js'
import { effectiveZstSensitivity, isProfileAllowedForZstSensitivity, coerceZstSensitivity } from './zst-sensitivity.js'
import { makeExecutor, type OutboundAdapter, type OutboundAction, type ExecuteOpts } from './executor-core.js'
import { zstApprovals } from './approval-core.js'
import { permits } from './autonomy-ladder.js'
import { issueAuthorization, type AuthorizationContext } from './action-authorization.js'
import { mintGatePermit } from './gate-permit.js'
import { evaluateEnvelope, type EnvelopeDecision, type Intent } from './delegation-envelope.js'

const zstExecutor = makeExecutor('zst_outbound_ledger', 'zst_case_claims')

export interface EmailDraft {
  to: string; subject: string; body: string
  /** RFC Message-ID this mail answers. Included in the rendered payload hash,
   *  so approving a reply approves that it IS a reply: changing the threading
   *  after approval invalidates the approval, like changing the text does. */
  inReplyTo?: string
  references?: string
}

export function renderedPayloadHash(email: EmailDraft): string {
  // inReplyTo is part of what is approved. "Reply to this thread" and "start a
  // new conversation" are different acts with different consequences in the
  // recipient's mailbox, so flipping one into the other after approval must
  // invalidate the approval exactly like editing the text does.
  //
  // JSON.stringify drops undefined keys, so a non-reply hashes byte-identically
  // to what it did before this field existed — no stored approval is disturbed.
  return sha256Hex(JSON.stringify({
    to: email.to, subject: email.subject, body: email.body,
    inReplyTo: email.inReplyTo, references: email.references,
  }))
}
export function templateHashFor(templateId: string): string {
  return sha256Hex(`template:${templateId}`)
}

export interface DraftZstSendInput {
  caseId: string
  templateId: string
  email: EmailDraft
  campaignId?: string
}
export interface DraftZstSendResult {
  campaignId: string
  ledgerId: string
  sequenceNumber: number
  templateHash: string
  renderedPayloadHash: string
  email: EmailDraft
  status: 'AWAITING_APPROVAL'
}

/** PREPARE. Typed campaign (allows_free_text=0) + planned ledger row. Not approved. */
export function draftZstSend(db: Database.Database, input: DraftZstSendInput, now: number): DraftZstSendResult {
  const templateHash = templateHashFor(input.templateId)
  const rHash = renderedPayloadHash(input.email)
  const campaignId = input.campaignId ?? `zcamp-${input.caseId}-EMAIL_SEND`
  const existing = db.prepare(`SELECT campaign_id FROM zst_campaigns WHERE campaign_id=?`).get(campaignId)
  if (!existing) {
    db.prepare(
      `INSERT INTO zst_campaigns (campaign_id, case_id, campaign_type, template_id, template_hash,
         status, version, allows_free_text, created_at, updated_at)
       VALUES (@id, @caseId, 'EMAIL_SEND', @tpl, @th, 'APPROVED', 1, 0, @now, @now)`
    ).run({ id: campaignId, caseId: input.caseId, tpl: input.templateId, th: templateHash, now })
  }
  const seq = ((db.prepare(
    `SELECT COUNT(*) AS n FROM zst_outbound_ledger WHERE case_id=? AND action_type='EMAIL_SEND'`
  ).get(input.caseId) as { n: number }).n) + 1
  const planned = zstExecutor.planAction(db, { caseId: input.caseId, actionType: 'EMAIL_SEND', sequenceNumber: seq, payload: input.email }, now)
  // Link the ledger row to its campaign. The personal draft has always done
  // this and says why in a comment; the corporate draft did not, and that one
  // missing UPDATE is a large part of why the corporate send chain could not be
  // reached. planAction leaves campaign_id NULL, so the approval door -- which
  // has to look up the template hash the approval must bind to -- finds nothing
  // and refuses every send with "missing content or campaign". A row that does
  // not say which campaign authorises it is also unauditable.
  const version = (db.prepare(
    `SELECT version FROM zst_campaigns WHERE campaign_id = ?`,
  ).get(campaignId) as { version: number } | undefined)?.version ?? 1
  db.prepare(
    `UPDATE zst_outbound_ledger SET campaign_id = @c, campaign_version = @v, updated_at = @now
     WHERE ledger_id = @id`,
  ).run({ c: campaignId, v: version, now, id: planned.ledgerId })
  return { campaignId, ledgerId: planned.ledgerId, sequenceNumber: seq, templateHash, renderedPayloadHash: rHash, email: input.email, status: 'AWAITING_APPROVAL' }
}

export interface ApproveZstSendInput {
  campaignId: string
  templateHash: string
  renderedPayloadHash: string
  approvedBy: string
  /** The recipient(s) this approval authorises. A send to anyone else is vetoed. */
  allowedRecipients: string[]
  approvalId?: string
}
/** The owner's explicit YES to THIS exact payload + recipient list. */
export function approveZstSend(db: Database.Database, input: ApproveZstSendInput, now: number): void {
  const ver = (db.prepare(`SELECT version FROM zst_campaigns WHERE campaign_id=?`).get(input.campaignId) as { version: number } | undefined)?.version ?? 1
  db.prepare(
    `INSERT INTO zst_campaign_approvals (approval_id, campaign_id, campaign_version, approved_by,
       template_hash, rendered_payload_hash, allowed_recipients, status, created_at, updated_at)
     VALUES (@id, @cid, @ver, @by, @th, @rh, @rcpts, 'APPROVED', @now, @now)`
  ).run({
    id: input.approvalId ?? `zappr-${input.campaignId}-${input.renderedPayloadHash.slice(0, 16)}`,
    cid: input.campaignId, ver, by: input.approvedBy, th: input.templateHash,
    rh: input.renderedPayloadHash, rcpts: JSON.stringify(input.allowedRecipients), now,
  })
}

export function rejectZstSend(db: Database.Database, ledgerId: string, reason: string, now: number): OutboundAction {
  return zstExecutor.cancelAction(db, ledgerId, reason, now)
}

export interface ZstAuthorizeResult {
  authorized: boolean
  reason: string | null
  campaignVersion?: number
  approvalVersion?: number
}
/**
 * F-9: delegates to the SHARED approval engine (zstApprovals), which is the one
 * approval-core.ts was written for — its header says so in as many words: one
 * implementation, two table sets, so the two namespaces cannot drift.
 *
 * This function used to reimplement a narrower check locally, and the list of
 * what it left out is the point: valid_until (an approval that never expires),
 * stop conditions (§3.4 could trip and this path would not notice), the channel
 * check, the variable checks, and both quotas. `zstApprovals.authorizeSend`
 * existed the whole time and nothing called it.
 */
export function authorizeZstSend(
  db: Database.Database,
  args: { campaignId: string; templateHash: string; renderedPayloadHash: string; recipient: string; now?: number },
): ZstAuthorizeResult {
  const r = zstApprovals.authorizeSend(db, {
    campaignId: args.campaignId, templateHash: args.templateHash,
    renderedPayloadHash: args.renderedPayloadHash, recipient: args.recipient,
    channel: 'EMAIL',
  }, args.now ?? Math.floor(Date.now() / 1000))
  return {
    authorized: r.authorized,
    reason: r.authorized ? null : r.reason,
    campaignVersion: r.campaignVersion, approvalVersion: r.approvalVersion,
  }
}

export interface DispatchZstSendInput {
  ledgerId: string
  campaignId: string
  connectorId: string
  email: EmailDraft
  templateHash: string
  renderedPayloadHash: string
  declaredSensitivity?: unknown
  targetProfile: string
  /** F-9 / §22: the case's own type, for the autonomy rung. Read from the store
   *  by the caller for the same reason the personal gate reads it there — a
   *  caller-asserted type would let the same path pick a more permissive rung. */
  caseType?: string
  /** F-9: evaluation time, so approval expiry is checked against the same clock
   *  the rest of the send uses instead of wall time inside the gate. */
  now?: number
  /** F-2 / AC-21. */
  runId?: string
  /** §21: INITIAL opens a thread, REPLY/FOLLOW_UP continue one. The corporate
   *  envelope opens none, so an absent value is read as INITIAL — fail-closed. */
  outboundKind?: 'INITIAL' | 'FOLLOW_UP' | 'REPLY' | null
}
export interface ZstDispatchDecision {
  allowed: boolean
  reasons: string[]
  sensitivityTier: string
  campaignVersion?: number
  approvalVersion?: number
  /** §21: set when a STANDING DELEGATION allowed this, not a human approval. */
  delegationEnvelopeId?: string
  delegatedIntent?: Intent
}

/** Evaluate the full ZST send gate. Fail-closed: every layer must pass. */
export function evaluateZstSendGate(db: Database.Database, req: DispatchZstSendInput): ZstDispatchDecision {
  const reasons: string[] = []
  if (!isUsable(db, req.connectorId, true)) reasons.push(`connector "${req.connectorId}" is not write-usable`)

  // Fail-closed sensitivity: UNKNOWN/unrecognised → most-restricted; the target
  // profile must be allowed for the effective tier (AT-ZA10).
  const declared = coerceZstSensitivity(req.declaredSensitivity)
  const tier = effectiveZstSensitivity(declared, `${req.email.subject}\n${req.email.body}`)
  if (!isProfileAllowedForZstSensitivity(req.targetProfile, tier)) {
    reasons.push(`profile "${req.targetProfile}" not allowed for ZST sensitivity ${tier}`)
  }

  // F-9: the autonomy ladder. The personal gate has checked it since §22
  // (dispatch-gate.ts); the corporate one never did, so a case type sitting at
  // PREPARE could still send on this path. Checked alongside the others, never
  // instead of them.
  const rung = permits(db, req.caseType ?? 'UNKNOWN', 'SEND')
  if (!rung.allowed) reasons.push(`autonómia-fokozat: ${rung.reason}`)

  const auth = authorizeZstSend(db, {
    campaignId: req.campaignId, templateHash: req.templateHash,
    renderedPayloadHash: req.renderedPayloadHash, recipient: req.email.to, now: req.now,
  })

  // §21 — the corporate standing delegation. Istvan, 2026-08-12: "A COS a cég
  // nevében is küldhet majd levelet."
  //
  // BOTH GATES, AND THAT IS THE POINT OF DOING IT HERE. The two send paths are
  // separate modules with separate tables, which is exactly how the corporate
  // half has repeatedly been the one left behind — the autonomy rung above says
  // so in its own comment, and the 2026-08-12 review's T-1 said it again. An
  // envelope wired only into the personal gate would have been the same defect a
  // third time.
  //
  // The corporate envelope is narrower than the personal one, and the narrowness
  // is Istvan's answer rather than my caution: he named one address for the
  // allowlist (the accountant), and named no vendors.
  let delegation: EnvelopeDecision | null = null
  if (!auth.authorized) {
    delegation = evaluateEnvelope(db, {
      domain: 'zst', actionType: 'EMAIL_SEND', recipient: req.email.to,
      subject: req.email.subject, body: req.email.body,
      outboundKind: req.outboundKind ?? null,
      now: req.now ?? Math.floor(Date.now() / 1000),
    })
    if (!delegation.delegated) {
      reasons.push(`not authorized: ${auth.reason}`)
      for (const r of delegation.reasons) reasons.push(`delegálás: ${r}`)
    }
  }

  // §22.2 (review #3 U-4): same stamp as the personal gate. The two gates are
  // separate modules on purpose (different tables, different limits), so both
  // must mint -- and the standing check test enumerates exactly these two.
  return mintGatePermit({
    allowed: reasons.length === 0, reasons, sensitivityTier: tier,
    campaignVersion: auth.campaignVersion, approvalVersion: auth.approvalVersion,
    ...(delegation?.delegated
      ? { delegationEnvelopeId: delegation.envelopeId, delegatedIntent: delegation.intent }
      : {}),
  })
}

export interface DispatchZstSendResult { sent: boolean; decision: ZstDispatchDecision; action?: OutboundAction }

/** Actually send — ONLY through the full gate. Any veto → nothing leaves. */
export async function dispatchZstSend(
  db: Database.Database, adapter: OutboundAdapter, input: DispatchZstSendInput, now: number, opts: ExecuteOpts = {},
): Promise<DispatchZstSendResult> {
  const decision = evaluateZstSendGate(db, { ...input, now: input.now ?? now })
  if (!decision.allowed) return { sent: false, decision }
  // F-7: the gate ran and allowed it on the line above. F-2: the versions come
  // from that same evaluation, not from a fresh read that could have moved.
  // §22.2, corporate side. Same rule, same single issuing point.
  const authContext: AuthorizationContext = {
    domain: 'zst',
    caseId: (db.prepare('SELECT case_id FROM zst_outbound_ledger WHERE ledger_id = ?')
      .get(input.ledgerId) as { case_id: string | null } | undefined)?.case_id ?? null,
    caseVersion: (db.prepare(
      `SELECT c.version AS v FROM zst_outbound_ledger l
       JOIN zst_cases c ON c.case_id = l.case_id WHERE l.ledger_id = ?`
    ).get(input.ledgerId) as { v: number } | undefined)?.v ?? null,
    goalVersion: null,
    actionId: input.ledgerId,
    actionType: 'EMAIL_SEND',
    intent: decision.delegatedIntent ?? 'SEND_APPROVED_EMAIL',
    targetReference: input.campaignId,
    recipient: input.email.to,
    payloadHash: input.renderedPayloadHash,
    approvalId: null,
    // §21: binds the ticket to the delegation that justified it. The field
    // counts towards policyEvaluationHash, so a delegated send cannot be
    // consumed as though a human had approved it.
    delegationEnvelopeId: decision.delegationEnvelopeId ?? null,
  }
  const ticket = issueAuthorization(db, authContext, now, {}, decision)
  const action = await zstExecutor.executeAction(db, adapter, input.ledgerId, now, {
    ...opts,
    authorizationId: ticket.authorizationId,
    authorizationContext: authContext,
    audit: {
      ...opts.audit,
      runId: opts.audit?.runId ?? input.runId,
      campaignVersion: decision.campaignVersion ?? null,
      approvalVersion: decision.approvalVersion ?? null,
    },
  })
  return { sent: action.status === 'VERIFIED' || action.status === 'APPLIED_UNVERIFIED', decision, action }
}
