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
import type { ActionSideEffectClass } from './action-side-effect.js'
import { buildNarration, renderApprovalQuestion } from './approval-narration.js'

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
  /** THE CLASSIFICATION THIS REQUEST RESTS ON, passed rather than re-derived so
   *  the gate's verdict and the owner's sentence come from one reading. A class
   *  that does not reach outside is refused here, not narrated. */
  sideEffectClass: ActionSideEffectClass
  sideEffectReasons: readonly string[]
  /** Concrete operation types the action would perform. Empty when nothing
   *  names one, which is a defect for an outward action and is treated as one. */
  operationTypes: readonly string[]
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
export function buildApprovalQuestion(
  r: ApprovalRequestRow, title: string, i: {
    sideEffectClass: ActionSideEffectClass
    sideEffectReasons: readonly string[]
    operationTypes: readonly string[]
  },
): string {
  // WHAT THIS USED TO BE, kept as the reason it is not that any more. The first
  // version's headline line was:
  //
  //     `Művelet: ${r.description}`
  //
  // and `r.description` is a plan-step label out of `buildRollingPlan`. On
  // 2026-08-28 that put "Művelet: Identify required actions and dependencies" in
  // front of Istvan, above "igen = jóváhagyod". The label is not wrong, it is
  // internal: it names the step to the engine and says nothing to a person about
  // what would happen. It is now on the audit line, where it belongs, and the
  // reader gets the five things the owner asked for.
  //
  // THROWS on a narration it cannot build. See `renderApprovalQuestion`.
  const narrationInput = {
    machineLabel: r.description,
    caseId: r.case_id, caseVersion: r.case_version, caseTitle: title,
    planStep: r.plan_step, target: r.recipient,
    operationTypes: i.operationTypes,
    riskClasses: JSON.parse(r.risk_classes_json) as RiskClass[],
    sideEffectClass: i.sideEffectClass,
    sideEffectReasons: i.sideEffectReasons,
    payloadFingerprint: r.payload_hash,
  }
  return renderApprovalQuestion(buildNarration(narrationInput), narrationInput)
}

/**
 * Close every open request on this action whose payload no longer matches.
 *
 * WHY THIS IS NOT LEFT TO DRIFT. Changing what a request binds already makes an
 * old row unmatchable: the consumer recomputes the hash and the ticket dies. But
 * "unmatchable" is a property nobody can see. The row still says `decided_at IS
 * NULL`, the board still counts it as an open question, and the question text it
 * put on the channel is still on the channel, still answerable in words. The
 * owner asked for the opposite of that:
 *
 *   "A már létrejött NVIDIA approval requestet ne lehessen a hibás szöveg
 *    alapján jóváhagyni. Invalidáld/revoke-old a régi requestet."
 *
 * So it is settled REJECTED with a refusal that names why, and its question is
 * superseded. A revoked request and a request that was never asked are different
 * facts and the store keeps both.
 *
 * AT THE PRODUCER, which every path to a new request goes through, rather than
 * in a migration that runs once and covers only what existed on the day.
 */
export function revokeOpenApprovalRequests(
  db: Database.Database,
  r: {
    domain: string; caseId: string; actionId: string
    /** Leave this one alone. Omitted or null revokes every open request on the
     *  action, which is what a step that stopped being approval-eligible needs. */
    exceptPayloadHash?: string | null
  },
  now: number,
  reason: string,
): string[] {
  const keep = r.exceptPayloadHash ?? null
  const stale = db.prepare(
    `SELECT request_id, question_hash FROM cos_action_approval_requests
      WHERE domain = ? AND case_id = ? AND action_id = ?
        AND decided_at IS NULL
        AND (? IS NULL OR payload_hash != ?)`,
  ).all(r.domain, r.caseId, r.actionId, keep, keep) as
    Array<{ request_id: string; question_hash: string | null }>

  for (const row of stale) {
    db.prepare(
      `UPDATE cos_action_approval_requests
          SET decided_at = ?, decision = 'REJECTED', refusal = ?
        WHERE request_id = ? AND decided_at IS NULL`,
    ).run(now, reason, row.request_id)
    if (row.question_hash) {
      db.prepare(
        `UPDATE cos_owner_questions SET superseded_at = ?
          WHERE case_id = ? AND domain = ? AND question_hash = ?
            AND answered_at IS NULL AND superseded_at IS NULL`,
      ).run(now, r.caseId, r.domain, row.question_hash)
    }
  }
  return stale.map(x => x.request_id)
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

  // AN OLD ASK ON THE SAME ACTION, bound to a payload this one no longer uses,
  // is closed with a reason before anything new is written. Leaving it open
  // would put two asks about one step on the board, one of them answerable and
  // meaningless.
  revokeOpenApprovalRequests(
    db, { domain: input.domain, caseId: input.caseId, actionId, exceptPayloadHash: payloadHash },
    now,
    'SUPERSEDED_PAYLOAD: a lépéshez tartozó kötés megváltozott, a kérés újra lett nyitva',
  )

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


  const title = input.title ?? input.caseId
  const text = buildApprovalQuestion(row, title, {
    sideEffectClass: input.sideEffectClass,
    sideEffectReasons: input.sideEffectReasons,
    operationTypes: input.operationTypes,
  })

  // THE ROW IS WRITTEN ONLY ONCE THE QUESTION EXISTS. `buildApprovalQuestion`
  // throws on a narration it cannot honestly build, and if the insert came
  // first that throw would leave an open request with no question anywhere: a
  // door that exists and cannot be reached, which is the exact shape of the
  // defect this module was created to close. Text first, row second.
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
