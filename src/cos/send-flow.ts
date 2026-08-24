// Personal Chief of Staff (COS) — approval-gated send flow (spec item #4).
//
// The safe orchestration that lets the COS actually SEND an email — but only
// after Istvan's explicit per-payload approval, and only through the full
// dispatch gate. It composes the pieces already built and proven:
//   draftSend()            PREPARE: compose the email, greenlight the campaign,
//                          plan the outbound_ledger row. Sends NOTHING and does
//                          NOT approve the payload — authorizeSend is FALSE after.
//   approveSend()          the owner's explicit YES to THIS exact rendered payload
//                          (records a P0.4 campaign_approval at the current version).
//   rejectSend()           the owner's NO / an abort → the planned row is CANCELLED.
//   dispatchApprovedSend() actually send, but ONLY if evaluateDispatch passes
//                          (connector write-usable AND sensitivity-allowed AND the
//                          exact payload approved). Any veto → nothing is sent.
//
// Nothing here sends autonomously: dispatch is called explicitly (on approval),
// the gate re-checks everything at send time, and a payload edited after approval
// fails the rendered-payload-hash match. The real Gmail send only happens if the
// caller passes the live GmailApiTransport AND the gmail connector is READ_WRITE
// — otherwise the gate vetoes, so the flow is inert until deliberately activated.

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { sha256Hex } from './attachments.js'
import { createCampaign, getCampaign, approveCampaign, recordApproval } from './campaigns.js'
import type { ApprovalEnvelope } from './approval-core.js'
import { planAction, executeAction, cancelAction, type OutboundAdapter, type OutboundAction, type ExecuteOpts } from './executor.js'
import { evaluateDispatch, type DispatchDecision } from './dispatch-gate.js'
import { acquireClaim, releaseClaim, appendCaseEvent } from './case-store.js'
import {
  mayCompose, mayApprove, OutboundModeRefusal,
  type OutboundOrigin, type ApprovalInitiator,
} from './outbound-mode-gate.js'
import { issueAuthorization, type AuthorizationContext } from './action-authorization.js'

/** The case a ledger row belongs to, and the version it is at right now. Read
 *  here so the ticket binds the state the gate decided on; if the case moves
 *  before execution, the hash no longer matches and the ticket dies. */
function caseIdOf(db: Database.Database, ledgerId: string): string | null {
  return (db.prepare('SELECT case_id FROM outbound_ledger WHERE ledger_id = ?')
    .get(ledgerId) as { case_id: string | null } | undefined)?.case_id ?? null
}
function caseVersionOfLedger(db: Database.Database, ledgerId: string): number | null {
  return (db.prepare(
    `SELECT c.version AS v FROM outbound_ledger l
     JOIN personal_cases c ON c.case_id = l.case_id WHERE l.ledger_id = ?`
  ).get(ledgerId) as { v: number } | undefined)?.v ?? null
}

export interface EmailDraft {
  to: string; subject: string; body: string
  /** RFC Message-ID this mail answers. Included in the rendered payload hash,
   *  so approving a reply approves that it IS a reply: changing the threading
   *  after approval invalidates the approval, like changing the text does. */
  inReplyTo?: string
  references?: string
}

/** Deterministic hash of the EXACT rendered payload — what the owner approves and
 *  what the send gate re-checks. Any edit changes it → a stale approval no longer
 *  authorizes. */
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
/** Hash identifying the typed template a send is built from (free text is never
 *  autonomously sendable — authorizeSend rejects a free-text campaign). */
export function templateHashFor(templateId: string): string {
  return sha256Hex(`template:${templateId}`)
}

export interface DraftSendInput {
  caseId: string
  connectorId: string
  templateId: string
  email: EmailDraft
  declaredSensitivity?: unknown
  campaignId?: string
  /** WHICH outbound path this is. REQUIRED on purpose (card fa36dc4b): a new
   *  send route must state what it is rather than inherit a default that happens
   *  to let it through. tsc names every call site that has not chosen. */
  origin: OutboundOrigin
}
export interface DraftSendResult {
  campaignId: string
  ledgerId: string
  sequenceNumber: number
  templateHash: string
  renderedPayloadHash: string
  email: EmailDraft
  status: 'AWAITING_APPROVAL'
}

/** PREPARE. Creates/greenlights the case's EMAIL_SEND campaign (typed, no free
 *  text) and plans the outbound row. Sends nothing; the payload is NOT yet
 *  approved, so a dispatch now would be vetoed. */
export function draftSend(db: Database.Database, input: DraftSendInput, now: number): DraftSendResult {
  // THE MODE GATE, at the choke point rather than per caller. Same reasoning
  // dispatch-gate.ts states in its own header: gating at one choke point means a
  // new send path cannot forget the check. A mode test scattered through the
  // pipeline is precisely what a new route forgets.
  //
  // It refuses by THROWING. A gate that returns "no" politely is one ignored
  // return value away from being no gate at all, and the whole promise of the
  // mode is that it cannot be walked past.
  const gate = mayCompose(db, 'personal', input.caseId, input.origin)
  if (!gate.allowed) throw new OutboundModeRefusal(gate, input.caseId)
  const templateHash = templateHashFor(input.templateId)
  const rHash = renderedPayloadHash(input.email)
  const campaignId = input.campaignId ?? `camp-${input.caseId}-EMAIL_SEND`
  if (!getCampaign(db, campaignId)) {
    createCampaign(db, {
      campaignId, caseId: input.caseId, campaignType: 'EMAIL_SEND',
      templateId: input.templateId, templateHash, allowsFreeText: false,
    }, now)
    approveCampaign(db, campaignId, now) // campaign greenlit; per-send approval still required
  }
  // F-1: the sequence number used to be COUNT(*)+1, which two concurrent drafts
  // read identically and then collided on the UNIQUE key — surfacing as a raw
  // SqliteError to the caller. MAX(seq)+1 has the same race, so the race is
  // handled instead of wished away: on a unique-constraint collision, re-read
  // and try the next number. Bounded, because an unbounded retry on a
  // mis-shaped row would spin forever.
  let planned: ReturnType<typeof planAction> | undefined
  let seq = 0
  for (let attempt = 0; attempt < 8 && !planned; attempt++) {
    seq = ((db.prepare(
      `SELECT COALESCE(MAX(sequence_number), 0) AS n FROM outbound_ledger WHERE case_id=? AND action_type='EMAIL_SEND'`
    ).get(input.caseId) as { n: number }).n) + 1
    try {
      planned = planAction(db, {
        caseId: input.caseId, actionType: 'EMAIL_SEND', sequenceNumber: seq, payload: input.email,
        // F-1 / §7.1: the key binds campaign + recipient + rendered payload, so
        // they have to be known at plan time rather than patched in afterwards.
        campaignId, recipient: input.email.to, renderedPayloadHash: rHash,
        // F-2 / AC-21: which version of the case this was planned against.
        caseVersion: (db.prepare('SELECT version FROM personal_cases WHERE case_id = ?')
          .get(input.caseId) as { version: number } | undefined)?.version ?? null,
      }, now)
    } catch (err) {
      if (!String((err as Error)?.message ?? '').includes('UNIQUE')) throw err
    }
  }
  if (!planned) throw new Error(`could not allocate a sequence number for ${input.caseId}/EMAIL_SEND after 8 attempts`)
  // Fill the columns §6.2 / A.5 added: which campaign, to whom, what kind. The
  // quota has nothing to count without them, and the approval door cannot find
  // the campaign whose template it must bind to — a ledger row that does not say
  // which campaign it belongs to is unauditable by AC-21.
  // campaign_id and recipient are written by planAction now (F-2) — in the same
  // INSERT as the row, so no window exists where the row is unattributable.
  db.prepare(
    `UPDATE outbound_ledger SET channel='EMAIL',
       outbound_kind=COALESCE(outbound_kind, @k), first_attempt_at=COALESCE(first_attempt_at, @now)
     WHERE ledger_id=@id`
  ).run({ k: seq === 1 ? 'INITIAL' : 'FOLLOW_UP', now, id: planned.ledgerId })
  // 2026-08-15: the case's OWN timeline said nothing about this. Every other
  // meaningful thing that happens to a case appends an event, and "a letter was
  // composed in your name and is waiting for your yes" was the exception — so
  // reading the case history gave no hint that an outbound draft existed. The
  // ledger had it, the timeline did not, and only one of those is what you read
  // when you ask what happened to this case.
  //
  // Written unconditionally, not only in a future shadow mode. If the event were
  // shadow-only, the LIVE path — the one that can actually reach a real
  // recipient — would be the blind one.
  //
  // No body here either, for the reason the PLANNED digest gives: the timeline is
  // a read surface, the body stays in the ledger. Subject and recipient are kept,
  // because a wrong address is what has to be noticed first.
  appendCaseEvent(db, {
    caseId: input.caseId,
    caseVersion: caseVersionOfLedger(db, planned.ledgerId) ?? 0,
    actor: 'marveen',
    eventType: 'OUTBOUND_DRAFTED',
    reason: `Level megfogalmazva, jovahagyasra var: ${input.email.subject}`,
    sourceSystem: 'cos:send-flow',
    sourceReference: planned.ledgerId,
    payload: {
      ledgerId: planned.ledgerId, campaignId, templateId: input.templateId,
      recipient: input.email.to, subject: input.email.subject,
      renderedPayloadHash: rHash, sequenceNumber: seq,
    },
  }, now)
  return {
    campaignId, ledgerId: planned.ledgerId, sequenceNumber: seq,
    templateHash, renderedPayloadHash: rHash, email: input.email, status: 'AWAITING_APPROVAL',
  }
}

export interface ApproveSendInput {
  campaignId: string
  templateHash: string
  renderedPayloadHash: string
  approvedBy: string
  approvalId?: string
  /** The address this payload was approved FOR. The allowlist is exactly this
   *  one recipient: approving a message to eCipő does not authorize the same
   *  text to anyone else (AC-4). */
  recipient: string
  /** Optional narrowing: expiry, quotas, stop conditions (§3.2). */
  envelope?: Partial<ApprovalEnvelope>
  /** Is a person pressing this, or a machine? REQUIRED, and required rather than
   *  optional-defaulting-to-'human' for one reason: an optional field lets an
   *  automated approver pass for a human by simply not setting it. The field that
   *  guards the difference must not have a value you can reach by omission. */
  initiatedBy: ApprovalInitiator
}
/** The owner's explicit YES to THIS exact rendered payload. After this,
 *  authorizeSend passes for the matching payload at the current campaign version. */
/** F-16 / §3.2: how long an approval is good for, and how much it authorises,
 *  when the caller says nothing.
 *
 *  approveSend used to fill in only allowedChannels and allowedRecipients, so
 *  valid_until and maxTotalOutbound were always NULL and authorizeSend's expiry
 *  check could never fire: every approval lived forever and authorised an
 *  unbounded number of sends. §3.2 lists valid_until as a required envelope
 *  field precisely so that an approval nobody revoked still stops mattering.
 *
 *  Seven days because an approval older than that has almost certainly been
 *  overtaken by the conversation it belongs to; one message because approving
 *  THIS rendered payload to THIS recipient is what the owner did, and a second
 *  send is a second decision. Both are overridable per approval. */
export const DEFAULT_APPROVAL_TTL_SEC = 7 * 24 * 3600
export const DEFAULT_APPROVAL_MAX_OUTBOUND = 1

export function approveSend(db: Database.Database, input: ApproveSendInput, now: number): void {
  // The fifth mode's whole purpose. external_shadow and live are identical
  // everywhere else in this file; the ONE place they differ is here, and Istvan's
  // sentence is the specification: in external_shadow the approval may never run
  // by itself.
  //
  // A human approval always passes — including in external_shadow, which is where
  // every drafted letter waits today. Blocking that would not be caution, it would
  // mean nothing could ever be sent.
  //
  // Default-deny for automation: no progression row, an unrecognised value, a case
  // nobody classified — all refused. Automatic approval is a capability that does
  // not exist yet, and a capability that does not exist yet starts closed.
  const caseId = (db.prepare('SELECT case_id FROM campaigns WHERE campaign_id = ?')
    .get(input.campaignId) as { case_id: string | null } | undefined)?.case_id ?? null
  if (caseId !== null) {
    const gate = mayApprove(db, 'personal', caseId, input.initiatedBy)
    if (!gate.allowed) throw new OutboundModeRefusal(gate, caseId)
  } else if (input.initiatedBy === 'automation') {
    // No campaign row means no case to look the mode up on. For a human that is
    // somebody else's bug; for automation it is an unclassifiable approval, and
    // an unclassifiable approval is exactly what must not go through.
    throw new OutboundModeRefusal({
      allowed: false, code: 'mode_unknown', mode: null,
      reason: `automatikus jovahagyas: a(z) ${input.campaignId} kampanyhoz nem tartozik ugy, tehat nincs mire modot nezni`,
    }, input.campaignId)
  }
  recordApproval(db, {
    approvalId: input.approvalId ?? `appr-${input.campaignId}-${input.renderedPayloadHash.slice(0, 16)}`,
    campaignId: input.campaignId, approvedBy: input.approvedBy,
    templateHash: input.templateHash, renderedPayloadHash: input.renderedPayloadHash,
    allowedChannels: ['EMAIL'],
    // F-16: the defaults go BEFORE the caller's envelope, so an explicit
    // validUntil or maxTotalOutbound still wins.
    validUntil: now + DEFAULT_APPROVAL_TTL_SEC,
    maxTotalOutbound: DEFAULT_APPROVAL_MAX_OUTBOUND,
    ...input.envelope,
    allowedRecipients: [input.recipient],
  }, now)
}

/** The owner's NO / an abort. Cancels the planned (not-yet-sent) row. */
export function rejectSend(db: Database.Database, ledgerId: string, reason: string, now: number): OutboundAction {
  return cancelAction(db, ledgerId, reason, now)
}

export interface DispatchSendInput {
  ledgerId: string
  campaignId: string
  connectorId: string
  email: EmailDraft
  templateHash: string
  renderedPayloadHash: string
  declaredSensitivity?: unknown
  targetProfile: string
  /** F-2 / AC-21: which run drove this send. Optional because a send triggered
   *  by the owner from the UI belongs to no run. */
  runId?: string
  /**
   * W10: who is causing this send, threaded to the gate's policy boundary.
   *
   * Optional so every existing caller compiles, and its absence is COUNTED as an
   * identity-resolution failure rather than waved through -- see the migration
   * note in dispatch-gate.ts. When present, the boundary's verdict BINDS.
   */
  identity?: import('../identity/execution-identity.js').ExecutionIdentity | null
  /** The principal this send is made for, when one exists. */
  principal?: import('../identity/execution-identity.js').ExecutionIdentity | null
  /** E13: the template variable names the rendered payload used, when the caller
   *  rendered from a template and knows them. Absent for a hand-composed mail —
   *  and absent means the variable checks have nothing to check, not that they
   *  passed. */
  usedVariables?: string[]
}
export interface DispatchSendResult {
  sent: boolean
  decision: DispatchDecision
  action?: OutboundAction
  /** E18: why nothing was sent when the GATE allowed it. The gate's own vetoes
   *  are in `decision.reasons`; everything that refuses AFTER it — the kill
   *  switch, a dead ticket, a stale claim fence, a campaign ceiling, the quota —
   *  is written to the ledger row's last_error and used to end here as
   *  `{sent:false}` with no reason attached, which reads to a caller (and to the
   *  UI) as an unexplained failure. */
  lastError?: string | null
}

/** E7 / §C. The per-connector rolling cap the atomic quota layer enforces when
 *  the caller does not name one.
 *
 *  `quota.ts` implements a correct check-and-increment in one transaction, and
 *  until now the only thing that ever passed `opts.quota` was a test: no rate
 *  cap of any kind existed on the live personal send path. A bug that plans in a
 *  loop, a retry storm, or a prompt that decides to chase forty suppliers at once
 *  had nothing between it and the mailbox.
 *
 *  Twenty a day per connector, because this is ONE person's assistant: a day on
 *  which Istvan's COS legitimately sends more than twenty emails through one
 *  connector has not happened, and if it does, the cap refusing is the correct
 *  first response — the row stays PLANNED with the reason on it, nothing is
 *  lost, and a human raises the ceiling deliberately by passing `opts.quota`.
 *  A rolling 24h window rather than a calendar day, so a burst cannot be reset
 *  by midnight arriving in the middle of it. */
export const DEFAULT_SEND_QUOTA_MAX = 20
export const DEFAULT_SEND_QUOTA_WINDOW_SEC = 24 * 3600
export function defaultSendQuota(connectorId: string): { key: string; maxCount: number; windowSec: number } {
  return {
    key: `personal:EMAIL_SEND:${connectorId}`,
    maxCount: DEFAULT_SEND_QUOTA_MAX,
    windowSec: DEFAULT_SEND_QUOTA_WINDOW_SEC,
  }
}

/** Actually send — but ONLY through the full gate. evaluateDispatch must pass
 *  (connector write-usable AND content's sensitivity allowed for the profile AND
 *  the exact payload approved at the current version). Any veto → sent:false,
 *  nothing leaves. On pass, the crash-safe executor performs the send. */
/** The case type behind a ledger row, from the store. Returns undefined when it
 *  cannot be determined — and undefined means the gate treats it as a new type,
 *  which cannot send. Fail-closed. */
function caseTypeOf(db: Database.Database, ledgerId: string): string | undefined {
  const r = db.prepare(
    `SELECT c.case_type AS t FROM outbound_ledger l
     JOIN personal_cases c ON c.case_id = l.case_id WHERE l.ledger_id = ?`
  ).get(ledgerId) as { t: string } | undefined
  return r?.t
}

export async function dispatchApprovedSend(
  db: Database.Database, adapter: OutboundAdapter, input: DispatchSendInput, now: number, opts: ExecuteOpts = {},
): Promise<DispatchSendResult> {
  const decision = evaluateDispatch(db, {
    identity: input.identity ?? null,
    principal: input.principal ?? null,
    connectorId: input.connectorId, requireWrite: true,
    declaredSensitivity: input.declaredSensitivity,
    content: `${input.email.subject}\n${input.email.body}`,
    targetProfile: input.targetProfile,
    campaignId: input.campaignId, templateHash: input.templateHash, renderedPayloadHash: input.renderedPayloadHash,
    // §21: the classifier needs the letter, and needs subject and body apart —
    // `content` above is already their concatenation.
    envelopeDomain: 'personal', subject: input.email.subject, body: input.email.body,
    // The address on the envelope we are about to put in the post, not a stored
    // intention: the allowlist must be checked against what actually goes out.
    recipient: input.email.to,
    // E13: the channel this actually goes out on. draftSend stamps
    // channel='EMAIL' on the row and approveSend stores allowedChannels:['EMAIL']
    // — and until now nothing compared the two.
    channel: 'EMAIL',
    ...(input.usedVariables ? { usedVariables: input.usedVariables } : {}),
    // §22: the case's OWN type decides the rung, read from the store rather than
    // taken from the caller. A caller-asserted type would let the same code path
    // pick a more permissive rung by claiming to be a different kind of case.
    caseType: caseTypeOf(db, input.ledgerId),
    now, // F-16: the same clock as the rest of the send
    // N-2: read from the row, not asserted by the caller — the ceiling that
    // applies is the one for the kind this send actually IS.
    outboundKind: (db.prepare('SELECT outbound_kind FROM outbound_ledger WHERE ledger_id = ?')
      .get(input.ledgerId) as { outbound_kind: string | null } | undefined)?.outbound_kind as
      'INITIAL' | 'FOLLOW_UP' | 'REPLY' | undefined,
  })
  if (!decision.allowed) return { sent: false, decision }
  // The gate ran and allowed it three lines up — that is the assertion F-7 asks
  // this call site to make explicit. The versions come from the same evaluation
  // (F-2), not from a fresh read that could have moved.
  // N-2 (second review): the claim and the ceilings are PASSED now. Before this,
  // executor-core's fence check and quota reservation sat behind `if (opts.claim)`
  // and `if (opts.campaignLimit)` that no production caller ever satisfied — the
  // exact pattern the first review named as the system's recurring fault, and I
  // reproduced it while fixing it. My own scripts/cos-caller-report.ts would have
  // shown it; I did not run it on my own work.
  //
  // The claim is acquired HERE, on the ledger row, rather than taken from a
  // caller. An owner-triggered send has no run to inherit a claim from, and the
  // race that matters on this path is two dispatches of the SAME row (a
  // double-click, a retried HTTP call) — which is exactly what a per-row claim
  // serialises. Short TTL: it guards one send, not a work session.
  const claimKey = `outbound:${input.ledgerId}`
  // E2 (review 2026-08-13). The fallback used to be `dispatch-${ledgerId}` —
  // DETERMINISTIC, and that quietly disabled the claim it was supposed to take.
  // acquireClaim is re-entrant for the same owner: on a live claim the upsert is
  // a no-op and the follow-up SELECT reports acquired = (owner === ours), so two
  // concurrent dispatches of the same row computed the SAME owner id, both got
  // acquired:true and both got the same fence. The comment above said this
  // serialises a double-click; it serialised nothing. A per-invocation id makes
  // the second caller a genuine contender, which is what the check assumes.
  //
  // A caller-supplied runId is still honoured: a run really is one owner, and
  // its own claim discipline is not this function's to override.
  const runId = opts.audit?.runId ?? input.runId ?? `dispatch-${randomUUID()}`
  const claim = acquireClaim(db, { claimKey, ownerRunId: runId, ttlSeconds: 120 }, now)
  if (!claim.acquired) {
    return { sent: false, decision: { ...decision, allowed: false, reasons: [...decision.reasons, `a sor mar kuldes alatt van (${claim.ownerRunId})`] } }
  }
  // §22.2: the gate allowed it, so the gate ISSUES the ticket. This is the only
  // place on the personal path that may call issueAuthorization, and it happens
  // after evaluateDispatch and after the claim — never before.
  const authContext: AuthorizationContext = {
    domain: 'personal',
    caseId: caseIdOf(db, input.ledgerId),
    caseVersion: caseVersionOfLedger(db, input.ledgerId),
    goalVersion: null,
    actionId: input.ledgerId,
    actionType: 'EMAIL_SEND',
    // §21: the intent the gate's deterministic classifier recognised, when this
    // send is going out on a standing delegation. Falls back to the old constant
    // when a human approved it — there the intent is not what justified the
    // send, the approval is.
    intent: decision.delegatedIntent ?? 'SEND_APPROVED_EMAIL',
    targetReference: input.campaignId,
    recipient: input.email.to,
    payloadHash: input.renderedPayloadHash,
    approvalId: decision.approvalId ?? null,
    // THE COLUMN FINALLY GETS A VALUE. `delegation_envelope_id` has existed and
    // counted towards policyEvaluationHash since §22.2 was built, and was NULL
    // on every row ever written because no caller set it — the audit for the
    // 2026-08-12 review found the pipeline complete and the concept absent.
    // Binding it here means a ticket issued under a delegation cannot be
    // consumed as though a human had approved it: the hash would differ.
    delegationEnvelopeId: decision.delegationEnvelopeId ?? null,
  }
  const ticket = issueAuthorization(db, authContext, now, {}, decision)

  try {
    const action = await executeAction(db, adapter, input.ledgerId, now, {
      ...opts,
      authorizationId: ticket.authorizationId,
      authorizationContext: authContext,
      claim: { claimKey, ownerRunId: runId, fence: claim.fence },
      // E7: the quota layer joins the traffic. Caller-supplied wins.
      quota: opts.quota ?? defaultSendQuota(input.connectorId),
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
    return {
      sent: action.status === 'VERIFIED' || action.status === 'APPLIED_UNVERIFIED',
      decision, action,
      // E18: the gate said yes and the send still did not happen — the reason is
      // on the row, and a caller that only gets `sent:false` cannot tell a quota
      // ceiling from a dead connector.
      lastError: action.lastError ?? null,
    }
  } finally {
    // Released whatever happened: a claim left behind would block the row's next
    // legitimate attempt for its whole TTL.
    releaseClaim(db, { claimKey, ownerRunId: runId, fence: claim.fence })
  }
}
