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
import {
  mayApprove, mayCompose, OutboundModeRefusal,
  type ApprovalInitiator, type OutboundOrigin,
} from './outbound-mode-gate.js'
import { appendZstCaseEvent } from './zst-case-store.js'
import { randomUUID } from 'node:crypto'
import { isUsable } from './connector-health.js'
import { effectiveZstSensitivity, isProfileAllowedForZstSensitivity, coerceZstSensitivity } from './zst-sensitivity.js'
import { makeExecutor, type OutboundAdapter, type OutboundAction, type ExecuteOpts } from './executor-core.js'
import { zstApprovals, type ApprovalEnvelope } from './approval-core.js'
import { permits } from './autonomy-ladder.js'
import { issueAuthorization, type AuthorizationContext } from './action-authorization.js'
import { mintGatePermit } from './gate-permit.js'
import { evaluateEnvelope, type EnvelopeDecision, type Intent } from './delegation-envelope.js'
import { acquireZstClaim, releaseZstClaim } from './zst-case-store.js'
import { type EmailDraft, renderedPayloadHash, templateHashFor } from './email-payload.js'

const zstExecutor = makeExecutor('zst_outbound_ledger', 'zst_case_claims')

// The draft shape and the two hashes used to be a byte-for-byte copy of
// send-flow's. A copy of a canonical hash is the worst kind of duplication: if
// one side ever changes what goes into the object, nothing breaks loudly — every
// approval on the other side simply stops matching, which looks exactly like a
// gate doing its job. One definition now, re-exported here so existing callers
// (the HTTP door, the tests) keep importing it from where they always have.
export { renderedPayloadHash, templateHashFor }
export type { EmailDraft }

export interface DraftZstSendInput {
  caseId: string
  templateId: string
  email: EmailDraft
  campaignId?: string
  /** WHICH outbound path this is. Same required field and same reason as the
   *  personal DraftSendInput: a new corporate send route must name itself rather
   *  than inherit a default that happens to let it through. */
  origin: OutboundOrigin
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
  // The COMPOSE half of the mode gate. Missed on the first pass: the corporate
  // approval got mayApprove, and the corporate DRAFT did not get mayCompose — so
  // a case in `shadow` could still have a letter composed and a ledger row
  // written on this path, which is exactly what shadow is supposed to prevent.
  //
  // Found by reading the review card's task list line by line against the code
  // instead of against what I remembered doing. My own parity guard did not catch
  // it either, and could not: it named three protections and this is a fourth.
  // The guard was honest about its coverage, which is the only reason the gap was
  // findable rather than assumed closed.
  const gate = mayCompose(db, 'zst', input.caseId, input.origin)
  if (!gate.allowed) throw new OutboundModeRefusal(gate, input.caseId)
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
  const version = (db.prepare(
    `SELECT version FROM zst_campaigns WHERE campaign_id = ?`,
  ).get(campaignId) as { version: number } | undefined)?.version ?? 1
  const caseVersion = (db.prepare(
    `SELECT version FROM zst_cases WHERE case_id = ?`,
  ).get(input.caseId) as { version: number } | undefined)?.version ?? null

  // F-1 / F-2, ported from the personal draft (2026-08-13). Two defects lived in
  // the three lines this replaces:
  //   - COUNT(*)+1 as the sequence number. Two concurrent drafts read the same
  //     count and then collided on UNIQUE(case_id, action_type, sequence_number),
  //     surfacing as a raw SqliteError. MAX+1 has the same race, so the race is
  //     handled rather than wished away: on a UNIQUE collision, re-read and take
  //     the next number. Bounded, because an unbounded retry on a mis-shaped row
  //     would spin forever.
  //   - planning with none of the F-1 fields. campaign_id, recipient, the
  //     rendered payload hash and the case version were absent from the INSERT,
  //     so the idempotency key bound neither the campaign nor the recipient, and
  //     the row spent a window being unattributable — a crash inside it left the
  //     row unattributable for good. The executor has supported all four since
  //     F-2; only this caller never passed them.
  let planned: OutboundAction | undefined
  let seq = 0
  for (let attempt = 0; attempt < 8 && !planned; attempt++) {
    seq = ((db.prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) AS n FROM zst_outbound_ledger WHERE case_id=? AND action_type='EMAIL_SEND'`
    ).get(input.caseId) as { n: number }).n) + 1
    try {
      planned = zstExecutor.planAction(db, {
        caseId: input.caseId, actionType: 'EMAIL_SEND', sequenceNumber: seq, payload: input.email,
        campaignId, recipient: input.email.to, renderedPayloadHash: rHash, caseVersion,
      }, now)
    } catch (err) {
      if (!String((err as Error)?.message ?? '').includes('UNIQUE')) throw err
    }
  }
  if (!planned) throw new Error(`could not allocate a sequence number for ${input.caseId}/EMAIL_SEND after 8 attempts`)
  // What planAction still does not write: the campaign VERSION the row was
  // planned at, and which kind of send this is. outbound_kind is not cosmetic —
  // the approval envelope's per-kind quotas count ledger rows by it, so while it
  // stayed NULL no ZST row could ever be counted against an INITIAL/FOLLOW_UP
  // ceiling and those ceilings silently did nothing.
  db.prepare(
    `UPDATE zst_outbound_ledger
       SET campaign_version = @v, outbound_kind = COALESCE(outbound_kind, @k), updated_at = @now
     WHERE ledger_id = @id`,
  ).run({ v: version, k: seq === 1 ? 'INITIAL' : 'FOLLOW_UP', now, id: planned.ledgerId })
  // The corporate case timeline knew nothing about a composed letter either — the
  // same blindness fixed on the personal path hours earlier, in the other
  // namespace. Written here rather than left for the shared entry point, because
  // "the timeline will mention it once we refactor" is how a case history stays
  // wrong for weeks. No body, subject and recipient only, same reasoning as there.
  appendZstCaseEvent(db, {
    caseId: input.caseId, caseVersion: caseVersion ?? 0, actor: 'marveen',
    eventType: 'OUTBOUND_DRAFTED',
    reason: `Level megfogalmazva, jovahagyasra var: ${input.email.subject}`,
    sourceSystem: 'cos:zst-send', sourceReference: planned.ledgerId,
    payload: {
      ledgerId: planned.ledgerId, campaignId, templateId: input.templateId,
      recipient: input.email.to, subject: input.email.subject,
      renderedPayloadHash: rHash, sequenceNumber: seq,
    },
  }, now)
  return { campaignId, ledgerId: planned.ledgerId, sequenceNumber: seq, templateHash, renderedPayloadHash: rHash, email: input.email, status: 'AWAITING_APPROVAL' }
}

export interface ApproveZstSendInput {
  campaignId: string
  templateHash: string
  renderedPayloadHash: string
  approvedBy: string
  /** Human or machine. Same required field, same reason, as the personal path:
   *  an optional flag lets an automated approver pass for a person by omission. */
  initiatedBy: ApprovalInitiator
  /** The recipient(s) this approval authorises. A send to anyone else is vetoed. */
  allowedRecipients: string[]
  approvalId?: string
  /** Optional narrowing: expiry, quotas, stop conditions (§3.2). */
  envelope?: Partial<ApprovalEnvelope>
}

/** §3.2 defaults, the same numbers the personal approveSend has used since F-16.
 *
 *  What the corporate approval used to write: a raw INSERT of the two hashes and
 *  the recipient list, with valid_until and max_total_outbound left NULL. The
 *  shared engine reads NULL valid_until as "never expires" and NULL
 *  max_total_outbound as "uncapped", so one YES was a standing permission — a new
 *  draft of the same payload a year later dispatched with no new approval, which
 *  §3.2 exists to forbid. Reproduced live before this fix.
 *
 *  Seven days because an approval older than that has been overtaken by the
 *  conversation it belongs to; one message because approving THIS payload to THIS
 *  recipient is what the owner did, and a second send is a second decision. Both
 *  overridable per approval via `envelope`. */
export const ZST_DEFAULT_APPROVAL_TTL_SEC = 7 * 24 * 3600
export const ZST_DEFAULT_APPROVAL_MAX_OUTBOUND = 1

/** The owner's explicit YES to THIS exact payload + recipient list. */
export function approveZstSend(db: Database.Database, input: ApproveZstSendInput, now: number): void {
  // 2026-08-15. The fifth mode landed on the personal path only, and this was the
  // FOURTH protection to be born there and skip the corporate one (after the §22
  // dispatch check this file's own comment at the recovery path already names,
  // the PLANNED digest, and the OUTBOUND_DRAFTED event). Four times is not four
  // bugs, it is the shape of having two send paths.
  //
  // So this is NOT a fifth copy: mayApprove has taken `domain` since it was
  // written, and this is a second CALLER of the same gate. Copying the logic is
  // what the choke-point doctrine forbids; adding a caller is what it asks for.
  // The structural fix — one entry point in front of both paths — is carded
  // separately, and it is bigger than tonight.
  const zCaseId = (db.prepare('SELECT case_id FROM zst_campaigns WHERE campaign_id = ?')
    .get(input.campaignId) as { case_id: string | null } | undefined)?.case_id ?? null
  if (zCaseId !== null) {
    const gate = mayApprove(db, 'zst', zCaseId, input.initiatedBy)
    if (!gate.allowed) throw new OutboundModeRefusal(gate, zCaseId)
  } else if (input.initiatedBy === 'automation') {
    throw new OutboundModeRefusal({
      allowed: false, code: 'mode_unknown', mode: null,
      reason: `automatikus jovahagyas: a(z) ${input.campaignId} ZST-kampanyhoz nem tartozik ugy`,
    }, input.campaignId)
  }
  // Through the shared engine, not around it. recordApproval carries the whole
  // §3.2 envelope and refuses at write time what the raw INSERT accepted
  // silently: a campaign that does not exist (the old code shrugged with
  // `version ?? 1` and wrote an orphan approval nothing could ever match) and an
  // empty recipient allowlist.
  zstApprovals.recordApproval(db, {
    // The id carries the clock and a random discriminator on purpose. The old
    // deterministic id collided the moment the owner said YES twice to the same
    // payload — a raw PRIMARY KEY violation surfaced to the dashboard as an
    // opaque 400. A second YES is a second decision and gets its own row; what
    // stops the second SEND is the quota, which counts the ledger, not the
    // approvals.
    approvalId: input.approvalId
      ?? `zappr-${input.campaignId}-${input.renderedPayloadHash.slice(0, 16)}-${now}-${randomUUID().slice(0, 8)}`,
    campaignId: input.campaignId, approvedBy: input.approvedBy,
    templateHash: input.templateHash, renderedPayloadHash: input.renderedPayloadHash,
    allowedChannels: ['EMAIL'],
    // The defaults go BEFORE the caller's envelope, so an explicit validUntil or
    // maxTotalOutbound still wins.
    validUntil: now + ZST_DEFAULT_APPROVAL_TTL_SEC,
    maxTotalOutbound: ZST_DEFAULT_APPROVAL_MAX_OUTBOUND,
    ...input.envelope,
    allowedRecipients: input.allowedRecipients,
  }, now)
}

export function rejectZstSend(db: Database.Database, ledgerId: string, reason: string, now: number): OutboundAction {
  return zstExecutor.cancelAction(db, ledgerId, reason, now)
}

export interface ZstAuthorizeResult {
  authorized: boolean
  reason: string | null
  campaignVersion?: number
  approvalVersion?: number
  /** N-2: the approval this authorisation came from, and the ceilings it carries.
   *  Both used to be dropped on the floor here, which is why the corporate path
   *  could not count anything inside the SENDING transaction. */
  approvalId?: string
  limits?: { maxTotal: number | null; maxPerKind: number | null; kind: string | null }
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
  args: {
    campaignId: string; templateHash: string; renderedPayloadHash: string; recipient: string
    outboundKind?: 'INITIAL' | 'FOLLOW_UP' | 'REPLY'; now?: number
  },
): ZstAuthorizeResult {
  const r = zstApprovals.authorizeSend(db, {
    campaignId: args.campaignId, templateHash: args.templateHash,
    renderedPayloadHash: args.renderedPayloadHash, recipient: args.recipient,
    channel: 'EMAIL', outboundKind: args.outboundKind,
  }, args.now ?? Math.floor(Date.now() / 1000))
  return {
    authorized: r.authorized,
    reason: r.authorized ? null : r.reason,
    campaignVersion: r.campaignVersion, approvalVersion: r.approvalVersion,
    // N-2: the ceilings and the approval id travel OUT of here now. They were
    // computed by the shared engine and thrown away, so the ceiling could only
    // ever be enforced by the COUNT(*) pre-filter inside authorizeSend — a
    // check-then-act outside the write, which is the exact hole decision N-2
    // closed on the personal path.
    approvalId: r.approvalId, limits: r.limits,
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
  /** F-9 / §22: the case's own type, for the autonomy rung.
   *
   *  FALLBACK ONLY (2026-08-13). This field was documented as "read from the
   *  store by the caller" and the one production caller never read it, so every
   *  corporate send evaluated the rung of the literal type 'UNKNOWN' — which
   *  defaults to PREPARE and cannot SEND. The door was dead, or was being kept
   *  open by raising the rung of 'UNKNOWN' in the SHARED ladder table, which
   *  would have unlocked SEND for every unknown case type on the personal path
   *  too. The gate reads the type off the ledger row itself now; a value passed
   *  here is used only when the row is attached to no case, and the store always
   *  wins, so a caller cannot assert its way to a more permissive rung. */
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
  approvalId?: string
  /** N-2: handed to the executor so the ceiling is counted inside the same
   *  transaction that writes SENDING. */
  limits?: { maxTotal: number | null; maxPerKind: number | null; kind: string | null }
}

/** The case type behind a ledger row, from the store — the corporate twin of
 *  send-flow's caseTypeOf. Returns undefined when the row belongs to no case,
 *  and undefined means the gate treats it as a new type, which cannot send. */
function zstCaseTypeOf(db: Database.Database, ledgerId: string): string | undefined {
  return (db.prepare(
    `SELECT c.case_type AS t FROM zst_outbound_ledger l
     JOIN zst_cases c ON c.case_id = l.case_id WHERE l.ledger_id = ?`
  ).get(ledgerId) as { t: string } | undefined)?.t
}

/** Which kind of send this row IS, read from the row rather than asserted by the
 *  caller — the ceiling that applies is the one for the kind actually being sent. */
function zstOutboundKindOf(db: Database.Database, ledgerId: string): 'INITIAL' | 'FOLLOW_UP' | 'REPLY' | undefined {
  const k = (db.prepare('SELECT outbound_kind FROM zst_outbound_ledger WHERE ledger_id = ?')
    .get(ledgerId) as { outbound_kind: string | null } | undefined)?.outbound_kind
  return (k ?? undefined) as 'INITIAL' | 'FOLLOW_UP' | 'REPLY' | undefined
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
  const caseType = zstCaseTypeOf(db, req.ledgerId) ?? req.caseType
  const rung = permits(db, caseType ?? 'UNKNOWN', 'SEND')
  if (!rung.allowed) reasons.push(`autonómia-fokozat: ${rung.reason}`)

  const auth = authorizeZstSend(db, {
    campaignId: req.campaignId, templateHash: req.templateHash,
    renderedPayloadHash: req.renderedPayloadHash, recipient: req.email.to,
    outboundKind: zstOutboundKindOf(db, req.ledgerId), now: req.now,
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
    approvalId: auth.approvalId, limits: auth.limits,
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
  // A row that has already left PLANNED cannot produce a FIRST delivery here:
  // executeAction returns a terminal row untouched, verifies an APPLIED_UNVERIFIED
  // one and recovers SENDING / OUTCOME_UNKNOWN by readback — none of which calls
  // adapter.send(). Those paths must stay reachable even when the gate refuses,
  // and after the §3.2 ceilings became real (max_total_outbound = 1 by default)
  // the gate DOES refuse them: the row being recovered is itself the one live
  // outbound row the campaign is allowed, so its own existence exhausts the
  // quota. Blocking recovery there would strand exactly the rows whose outcome is
  // unknown — the ones that must be resolved by readback rather than by a resend.
  // The gate is still evaluated and still returned; it just does not veto a step
  // that sends nothing.
  const status = (db.prepare('SELECT status FROM zst_outbound_ledger WHERE ledger_id = ?')
    .get(input.ledgerId) as { status: string } | undefined)?.status
  if (status && status !== 'PLANNED' && status !== 'FAILED_RETRYABLE') {
    const action = await zstExecutor.executeAction(db, adapter, input.ledgerId, now, opts)
    return { sent: action.status === 'VERIFIED' || action.status === 'APPLIED_UNVERIFIED', decision, action }
  }
  if (!decision.allowed) return { sent: false, decision }
  // N-2, corporate side (2026-08-13). The claim and the ceilings are PASSED now.
  // Before this, dispatchZstSend called executeAction with neither, so the fence
  // check and the atomic in-transaction ceiling count — both of which the shared
  // executor implements behind `if (opts.claim)` / `if (opts.campaignLimit)` —
  // were dead code on this path, and the only limit was the COUNT(*) pre-filter
  // inside authorizeSend. That is check-then-act: two concurrent dispatches of
  // the same row both read "there is still room".
  //
  // The claim is acquired HERE, on the ledger row: an owner-triggered send has no
  // run to inherit one from, and the race that matters is two dispatches of the
  // SAME row (a double-click, a retried HTTP call). Short TTL — it guards one
  // send, not a work session.
  //
  // The run id is unique per invocation, deliberately. A deterministic id derived
  // from the ledger row makes the claim re-entrant: the second concurrent
  // dispatch presents the same owner_run_id, is told it holds the claim, and the
  // fence check it was supposed to fail passes. A claim you can always re-take is
  // not a claim.
  const claimKey = `zst-outbound:${input.ledgerId}`
  const runId = opts.audit?.runId ?? input.runId ?? `zst-dispatch-${randomUUID()}`
  const claim = acquireZstClaim(db, { claimKey, ownerRunId: runId, ttlSeconds: 120 }, now)
  if (!claim.acquired) {
    return {
      sent: false,
      decision: { ...decision, allowed: false, reasons: [...decision.reasons, `a sor már küldés alatt van (${claim.ownerRunId})`] },
    }
  }
  // F-7: the gate ran and allowed it above. F-2: the versions come from that same
  // evaluation, not from a fresh read that could have moved.
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
    // The approval this send is running under, recorded on the ticket. It used
    // to be a hardcoded null, so the corporate half of the AC-21 trail could not
    // answer "which YES authorised this letter" -- AND, more sharply, so
    // consumeAuthorization's approval-revocation re-check (§22.2's TOCTOU list,
    // sixth field) never ran on the corporate path at all: that block is gated
    // on the ticket carrying an approval_id. A corporate approval withdrawn
    // between issue and execution could still send inside the ticket's lifetime.
    approvalId: decision.approvalId ?? null,
    // §21: binds the ticket to the delegation that justified it. The field
    // counts towards policyEvaluationHash, so a delegated send cannot be
    // consumed as though a human had approved it.
    delegationEnvelopeId: decision.delegationEnvelopeId ?? null,
  }
  const ticket = issueAuthorization(db, authContext, now, {}, decision)
  try {
    const action = await zstExecutor.executeAction(db, adapter, input.ledgerId, now, {
      ...opts,
      authorizationId: ticket.authorizationId,
      authorizationContext: authContext,
      claim: { claimKey, ownerRunId: runId, fence: claim.fence },
      campaignLimit: decision.limits
        ? {
            campaignId: input.campaignId,
            ...(decision.limits.maxTotal !== null ? { maxTotal: decision.limits.maxTotal } : {}),
            ...(decision.limits.kind ? { kind: decision.limits.kind } : {}),
            ...(decision.limits.maxPerKind !== null ? { maxPerKind: decision.limits.maxPerKind } : {}),
          }
        : opts.campaignLimit,
      audit: {
        ...opts.audit,
        runId,
        campaignVersion: decision.campaignVersion ?? null,
        approvalVersion: decision.approvalVersion ?? null,
      },
    })
    return { sent: action.status === 'VERIFIED' || action.status === 'APPLIED_UNVERIFIED', decision, action }
  } finally {
    // Released whatever happened: a claim left behind would block the row's next
    // legitimate attempt for its whole TTL.
    releaseZstClaim(db, { claimKey, ownerRunId: runId, fence: claim.fence })
  }
}
