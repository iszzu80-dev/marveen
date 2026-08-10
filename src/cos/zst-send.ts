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

const zstExecutor = makeExecutor('zst_outbound_ledger')

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

export interface ZstAuthorizeResult { authorized: boolean; reason: string | null }
/** Is there an APPROVED approval for this exact template + rendered payload at the
 *  campaign's current version, whose allowed_recipients includes the recipient? */
export function authorizeZstSend(
  db: Database.Database,
  args: { campaignId: string; templateHash: string; renderedPayloadHash: string; recipient: string },
): ZstAuthorizeResult {
  const camp = db.prepare(`SELECT version, status, allows_free_text FROM zst_campaigns WHERE campaign_id=?`)
    .get(args.campaignId) as { version: number; status: string; allows_free_text: number } | undefined
  if (!camp) return { authorized: false, reason: 'campaign not found' }
  if (camp.status !== 'APPROVED') return { authorized: false, reason: `campaign status ${camp.status}` }
  if (camp.allows_free_text) return { authorized: false, reason: 'free-text campaign cannot autonomously send' }
  const appr = db.prepare(
    `SELECT allowed_recipients FROM zst_campaign_approvals
     WHERE campaign_id=@cid AND campaign_version=@ver AND template_hash=@th
       AND rendered_payload_hash=@rh AND status='APPROVED' LIMIT 1`
  ).get({ cid: args.campaignId, ver: camp.version, th: args.templateHash, rh: args.renderedPayloadHash }) as { allowed_recipients: string } | undefined
  if (!appr) return { authorized: false, reason: 'no approval for this exact payload at the current version' }
  const list = JSON.parse(appr.allowed_recipients) as string[]
  if (!list.map(r => r.toLowerCase()).includes(args.recipient.toLowerCase())) {
    return { authorized: false, reason: `recipient ${args.recipient} not in the approved list` }
  }
  return { authorized: true, reason: null }
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
}
export interface ZstDispatchDecision { allowed: boolean; reasons: string[]; sensitivityTier: string }

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

  const auth = authorizeZstSend(db, {
    campaignId: req.campaignId, templateHash: req.templateHash,
    renderedPayloadHash: req.renderedPayloadHash, recipient: req.email.to,
  })
  if (!auth.authorized) reasons.push(`not authorized: ${auth.reason}`)

  return { allowed: reasons.length === 0, reasons, sensitivityTier: tier }
}

export interface DispatchZstSendResult { sent: boolean; decision: ZstDispatchDecision; action?: OutboundAction }

/** Actually send — ONLY through the full gate. Any veto → nothing leaves. */
export async function dispatchZstSend(
  db: Database.Database, adapter: OutboundAdapter, input: DispatchZstSendInput, now: number, opts: ExecuteOpts = {},
): Promise<DispatchZstSendResult> {
  const decision = evaluateZstSendGate(db, input)
  if (!decision.allowed) return { sent: false, decision }
  const action = await zstExecutor.executeAction(db, adapter, input.ledgerId, now, opts)
  return { sent: action.status === 'VERIFIED' || action.status === 'APPLIED_UNVERIFIED', decision, action }
}
