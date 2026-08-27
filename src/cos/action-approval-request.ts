// The PRODUCER of §22.2 tickets for progression steps (P4 closure,
// ACTION_APPROVAL_PRODUCER_WIRING).
//
// WHAT WAS MISSING, in the words of the file that admitted it. `human-answer-
// class.ts` shipped with this in its header:
//
//   "THE HONEST STATE, said here rather than discovered later. Nothing in the
//    system currently ISSUES such a ticket for a progression step [...]
//    HUMAN_ACTION_APPROVAL is therefore a built and tested path with no live
//    producer today."
//
// So Invariant E's one allow-branch for a high-risk step was unreachable by any
// real sequence of events. Every high-risk step stayed MANUAL_ACTION_REQUIRED
// for ever, and the only way out was a person doing the thing by hand outside
// the system entirely -- which the case record then had no way to know about.
// The owner's blocker is this, exactly: the refusal must have a door, the door
// must be his, and walking through it must produce the existing scoped ticket
// rather than a second notion of approval.
//
// THE ARC, and which module owns each leg:
//
//   progression-pipeline  Invariant E refuses a HIGH-risk step
//         │                 → requestActionApproval (here)
//   cos_owner_questions   the question, carrying the action, the target and the
//         │               payload fingerprint, delivered by cos-channel-send
//   owner-question        Istvan replies; recordOwnerAnswer sees the binding
//         │                 → decideActionApproval (here)
//   progression-approval-gate   the deterministic checks
//         │                 → issueAuthorization (§22.2, unchanged)
//   personal_case_events  the answer event carries the authorizationId
//         │
//   human-answer-class    resolveHumanAnswer CONSUMES the ticket, single-use
//         │
//   progression-pipeline  the step is exempt from Invariant E, once
//
// NOTHING HERE IS AN AUTHORITY. This module writes a request row and a question,
// and calls the gate. The only object that authorises anything is the ticket,
// and the only thing that spends it is the consumer. That separation is the
// reason a bug in this file can lose an approval but cannot manufacture one.
import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'
import { issueAuthorization, type AuthorizationContext } from './action-authorization.js'
import {
  evaluateProgressionApproval, PROGRESSION_APPROVAL_TTL_SEC, APPROVAL_REQUEST_TTL_SEC,
} from './progression-approval-gate.js'
import { progressionActionIdentity, progressionPayloadHash } from './human-answer-class.js'
import type { RiskClass } from './decision-confidence.js'

export interface ApprovalRequestInput {
  domain: 'personal' | 'zst'
  caseId: string
  caseVersion: number | null
  goalVersion: number | null
  planStep: number
  /** The step's own text. It is what the owner reads AND what the ticket binds,
   *  so a re-planned step with different wording cannot inherit the approval. */
  description: string
  actionType: string
  recipient: string | null
  riskClasses: readonly RiskClass[]
  /** The run whose Invariant E refusal produced this request. Travels onto the
   *  question so the answer can name what it is answering. */
  progressionRunId: string | null
  /** For the question text. Falls back to the case id. */
  title?: string | null
}

export interface ApprovalRequestRow {
  request_id: string
  domain: 'personal' | 'zst'
  case_id: string
  case_version: number | null
  goal_version: number | null
  plan_step: number
  action_id: string
  action_type: string
  description: string
  target_reference: string | null
  recipient: string | null
  payload_hash: string
  risk_classes_json: string
  question_hash: string | null
  progression_run_id: string | null
  requested_at: number
  expires_at: number
  decided_at: number | null
  decision: 'APPROVED' | 'REJECTED' | null
  authorization_id: string | null
  refusal: string | null
}

/** Identity of the ASK, so the same request re-asked does not open a second
 *  question row. Same doctrine as the owner-question hash: the identity is the
 *  content of what is being asked, never the attempt. */
export function approvalQuestionHash(r: { domain: string; caseId: string; actionId: string; payloadHash: string }): string {
  return createHash('sha256')
    .update(['action-approval', r.domain, r.caseId, r.actionId, r.payloadHash].join('\0'))
    .digest('hex')
}

/**
 * The sentence Istvan actually reads.
 *
 * The owner's requirement is that the CONCRETE action, the target and the
 * relevant payload appear -- not "a step needs approval". Every line below is
 * one of the fields the ticket will bind, so what he sees and what gets
 * authorised are the same list, and a mismatch between them is visible rather
 * than buried in a hash.
 *
 * No em dash, per the channel's own writing rules.
 */
export function buildApprovalQuestion(r: ApprovalRequestRow, title: string): string {
  const risk = (JSON.parse(r.risk_classes_json) as string[]).join(', ') || 'nincs osztályozva'
  return [
    `JÓVÁHAGYÁS KÉRÉSE: ${title}`,
    '',
    'Ez a lépés magas kockázatú, és a motor bizonyítottan magas bizalom nélkül',
    'nem hajthatja végre magától (Invariáns E).',
    '',
    `Művelet: ${r.description}`,
    `Típus: ${r.action_type} (terv-lépés #${r.plan_step})`,
    `Ügy: ${r.case_id}${r.case_version !== null ? ` (v${r.case_version})` : ''}`,
    `Címzett: ${r.recipient ?? 'nincs, ez belső lépés'}`,
    `Payload-ujjlenyomat: ${r.payload_hash.slice(0, 12)}`,
    `Kockázat: ${risk}`,
    '',
    '"igen" = EZT a konkrét műveletet hagyod jóvá, egyszer.',
    '"nem" = nem hajtjuk végre.',
    'Bármi más szöveg információ marad, és nem jóváhagyás.',
    '',
    'Ha a leírás, az ügy verziója vagy a lépés időközben változik,',
    'a jóváhagyás magától érvénytelen lesz.',
  ].join('\n')
}

/**
 * Open (or re-attach) an approval request for one high-risk step.
 *
 * IDEMPOTENT on (domain, case, action, payload hash) while the request is
 * undecided -- the partial unique index is the enforcement, this is the read
 * that keeps the common path from relying on a caught constraint error. A
 * second Invariant E refusal on the same step ten minutes later must not put a
 * second question in front of him.
 *
 * RE-ATTACHES the question when an open request exists whose question row was
 * answered in words (which decides nothing) or superseded by another ask. Left
 * alone, that request would be open for ever with nothing on screen to answer
 * it: a door that exists and cannot be reached, which is the shape of the defect
 * this whole module closes.
 */
export function requestActionApproval(
  db: Database.Database, input: ApprovalRequestInput, now: number,
): { requestId: string; created: boolean; questionHash: string } {
  const actionId = progressionActionIdentity(input.domain, input.caseId, input.planStep)
  const payloadHash = progressionPayloadHash(input.description)
  const questionHash = approvalQuestionHash({
    domain: input.domain, caseId: input.caseId, actionId, payloadHash,
  })

  const existing = db.prepare(
    `SELECT * FROM cos_action_approval_requests
      WHERE domain = ? AND case_id = ? AND action_id = ? AND payload_hash = ?
        AND decided_at IS NULL`,
  ).get(input.domain, input.caseId, actionId, payloadHash) as ApprovalRequestRow | undefined

  const row: ApprovalRequestRow = existing ?? {
    request_id: randomBytes(16).toString('hex'),
    domain: input.domain, case_id: input.caseId,
    case_version: input.caseVersion, goal_version: input.goalVersion,
    plan_step: input.planStep, action_id: actionId, action_type: input.actionType,
    description: input.description, target_reference: input.caseId,
    recipient: input.recipient, payload_hash: payloadHash,
    risk_classes_json: JSON.stringify([...input.riskClasses]),
    question_hash: questionHash, progression_run_id: input.progressionRunId,
    requested_at: now, expires_at: now + APPROVAL_REQUEST_TTL_SEC,
    decided_at: null, decision: null, authorization_id: null, refusal: null,
  }

  if (!existing) {
    db.prepare(
      `INSERT INTO cos_action_approval_requests
         (request_id, domain, case_id, case_version, goal_version, plan_step,
          action_id, action_type, description, target_reference, recipient,
          payload_hash, risk_classes_json, question_hash, progression_run_id,
          requested_at, expires_at)
       VALUES (@request_id, @domain, @case_id, @case_version, @goal_version, @plan_step,
          @action_id, @action_type, @description, @target_reference, @recipient,
          @payload_hash, @risk_classes_json, @question_hash, @progression_run_id,
          @requested_at, @expires_at)`,
    ).run(row)
  } else if (input.progressionRunId && input.progressionRunId !== row.progression_run_id) {
    // THE QUESTION MUST NAME THE RUN THE OWNER IS LOOKING AT. Same reason
    // askPendingOwnerQuestions refreshes it on a suppressed re-ask: an answer
    // that names a run whose decision has moved on is dropped as stale by
    // consumeOwnerAnswer, and the owner sees silence after answering.
    db.prepare(`UPDATE cos_action_approval_requests SET progression_run_id = ? WHERE request_id = ?`)
      .run(input.progressionRunId, row.request_id)
    row.progression_run_id = input.progressionRunId
  }

  const title = input.title ?? input.caseId
  const text = buildApprovalQuestion(row, title)

  // The question row is the DELIVERY surface: cos-channel-send picks up every
  // open, undelivered question and sends it. Writing here rather than sending
  // keeps the "what to say" and "did it leave" split this subsystem exists on.
  //
  // SUPERSEDE the case's other open questions first, for the same reason
  // askPendingOwnerQuestions does: one case, one open question, or the ceiling
  // fills with two askings of the same situation. An approval request outranks a
  // reader question -- the reader is asking what is missing, this is asking
  // whether the engine may act.
  db.prepare(
    `UPDATE cos_owner_questions SET superseded_at = ?
      WHERE case_id = ? AND domain = ? AND question_hash != ?
        AND answered_at IS NULL AND superseded_at IS NULL`,
  ).run(now, input.caseId, input.domain, questionHash)

  const before = db.prepare(
    `SELECT 1 FROM cos_owner_questions
      WHERE case_id = ? AND question_hash = ? AND answered_at IS NULL AND superseded_at IS NULL`,
  ).get(input.caseId, questionHash)

  db.prepare(
    `INSERT INTO cos_owner_questions
       (case_id, domain, question_hash, question_text, asked_at, progression_run_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (case_id, question_hash) DO UPDATE
       SET question_text = excluded.question_text,
           asked_at = excluded.asked_at,
           answered_at = NULL, answer_text = NULL, superseded_at = NULL,
           channel = NULL, channel_target = NULL,
           progression_run_id = excluded.progression_run_id`,
  ).run(input.caseId, input.domain, questionHash, text, now, row.progression_run_id)

  return { requestId: row.request_id, created: !existing || !before, questionHash }
}

/** The open request a given question is asking about, if it is asking about one.
 *
 *  Matched on the QUESTION HASH, not on the case: a case can carry an ordinary
 *  reader question and an approval request in its history, and answering the
 *  reader question must not decide the approval. That is the owner's first
 *  mandatory counter-example, enforced by the lookup rather than by the caller
 *  remembering to check. */
export function openApprovalRequestForQuestion(
  db: Database.Database, domain: string, caseId: string, questionHash: string,
): ApprovalRequestRow | null {
  try {
    return (db.prepare(
      `SELECT * FROM cos_action_approval_requests
        WHERE domain = ? AND case_id = ? AND question_hash = ? AND decided_at IS NULL`,
    ).get(domain, caseId, questionHash) as ApprovalRequestRow | undefined) ?? null
  } catch {
    // A store that predates this table has no approval requests, and therefore
    // no approval to grant. Fail-closed is the same as the true answer here.
    return null
  }
}

export type ApprovalDecisionResult =
  | { ok: true; requestId: string; authorizationId: string; expiresAt: number }
  | { ok: false; requestId: string; reason: string }

/**
 * Decide one request. APPROVE runs the gate and issues the ticket; REJECT
 * records the no. Either way the request is spent.
 *
 * THE LATCH IS THE FIRST ACT, and it is the ONLY thing enforcing single use.
 *
 * The first version of this function read the row, returned early if it was
 * already decided, and then wrote under `WHERE decided_at IS NULL` as well. Two
 * guards for one property -- and the mutation harness showed what that costs:
 * deleting the `WHERE` clause changed nothing any test could see, because the
 * read caught every case the suite exercised. Two guards, neither proven, which
 * is the exact pattern this codebase keeps finding in its own work.
 *
 * So the read-check is gone and the conditional UPDATE stands alone. It claims
 * the request pessimistically -- decided, REJECTED, "under decision" -- and the
 * outcome is written over that claim a few lines later. Any early return, any
 * throw, any crash therefore leaves the request in the safe state rather than
 * the permissive one, and two answers arriving together cannot both be the one
 * that decided.
 *
 * A REFUSED APPROVAL IS STILL A SPENT REQUEST. The alternative -- leaving it
 * open so a later cycle might grant it -- means the owner's yes could take
 * effect at a moment he never saw, under conditions that changed after he
 * answered. The engine re-asks from the current state instead.
 */
export function decideActionApproval(
  db: Database.Database, requestId: string, verdict: 'APPROVE' | 'REJECT', now: number,
): ApprovalDecisionResult {
  return db.transaction((): ApprovalDecisionResult => {
    const claimed = db.prepare(
      `UPDATE cos_action_approval_requests
          SET decided_at = @now, decision = 'REJECTED', refusal = @claim
        WHERE request_id = @requestId AND decided_at IS NULL`,
    ).run({ now, requestId, claim: 'döntés alatt' })
    if (claimed.changes !== 1) {
      const prior = db.prepare(`SELECT decision FROM cos_action_approval_requests WHERE request_id = ?`)
        .get(requestId) as { decision: string | null } | undefined
      return {
        ok: false, requestId,
        reason: prior ? `a kérés már el lett döntve (${prior.decision})` : 'ismeretlen jóváhagyás-kérés',
      }
    }

    const row = db.prepare(`SELECT * FROM cos_action_approval_requests WHERE request_id = ?`)
      .get(requestId) as ApprovalRequestRow

    /** Write the real outcome over the pessimistic claim. Unconditional on
     *  purpose: this row is already ours, and re-testing `decided_at IS NULL`
     *  here would fail on the very claim we just made. */
    const settle = (decision: 'APPROVED' | 'REJECTED', authorizationId: string | null, refusal: string | null): void => {
      db.prepare(
        `UPDATE cos_action_approval_requests
            SET decision = @decision, authorization_id = @authorizationId, refusal = @refusal
          WHERE request_id = @requestId`,
      ).run({ decision, authorizationId, refusal, requestId })
    }

    if (verdict === 'REJECT') {
      settle('REJECTED', null, 'a tulajdonos elutasította')
      return { ok: false, requestId, reason: 'a tulajdonos elutasította' }
    }

    const riskClasses = (() => {
      try { return JSON.parse(row.risk_classes_json) as RiskClass[] } catch { return [] as RiskClass[] }
    })()
    const permit = evaluateProgressionApproval(db, {
      domain: row.domain, caseId: row.case_id, caseVersion: row.case_version,
      planStep: row.plan_step, actionId: row.action_id, riskClasses,
      requestedAt: row.requested_at, expiresAt: row.expires_at,
    }, now)
    if (!permit.allowed) {
      // REFUSED HERE, NOT BY THE ISSUER. `issueAuthorization` would also refuse
      // a permit that says no -- by THROWING, which would unwind out of
      // `recordOwnerAnswer` and lose the owner's message. The refusal has to
      // become a recorded decision, so it is handled where it can be written
      // down. (The mutation harness caught this one too: deleting this branch
      // was invisible until a test asked what happens when the gate says no at
      // answer time.)
      const why = permit.reasons.join('; ')
      settle('REJECTED', null, why)
      return { ok: false, requestId, reason: why }
    }

    // THE CONTEXT MUST BE THE ONE THE CONSUMER WILL REBUILD. `resolveHumanAnswer`
    // derives its own AuthorizationContext from the live step at consumption
    // time; if this one differs by a single field the policy hash will not match
    // and the ticket dies unused. So it is written here in the same shape and
    // from the same two helpers, not assembled by hand.
    const ctx: AuthorizationContext = {
      domain: row.domain, caseId: row.case_id,
      caseVersion: row.case_version, goalVersion: row.goal_version,
      actionId: row.action_id, actionType: row.action_type,
      intent: 'PROGRESSION_STEP',
      targetReference: row.target_reference, recipient: row.recipient,
      payloadHash: row.payload_hash, approvalId: null,
    }
    const ticket = issueAuthorization(
      db, ctx, now, { ttlSeconds: PROGRESSION_APPROVAL_TTL_SEC, singleUse: true }, permit,
    )
    settle('APPROVED', ticket.authorizationId, null)
    return {
      ok: true, requestId, authorizationId: ticket.authorizationId, expiresAt: ticket.expiresAt,
    }
  })()
}
