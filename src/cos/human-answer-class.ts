/**
 * P4 closure — what KIND of thing the owner said, and what it authorises.
 *
 * Owner's correction, 2026-08-27, and it overturns a judgement of mine:
 *
 *   "A human answer önmagában NEM teszi az utána következő high-risk actiont
 *    non-autonomous / exempt állapotúvá."
 *
 * My version granted the Invariant E exemption whenever a run consumed ANY owner
 * answer. The argument was that a step running on his answer is not autonomous,
 * and the argument is fine — for one of the three things an answer can be. He
 * separated them, and the separation is the whole point:
 *
 *   HUMAN_INFORMATION      "Igen, a cím 12/B."
 *                          A fact. Authorises nothing.
 *   HUMAN_DECISION         "Az A opciót választom."
 *                          A choice between alternatives. It feeds REASONING --
 *                          it is not permission for an external side effect.
 *   HUMAN_ACTION_APPROVAL  "Igen, küldd el EZT az emailt ENNEK a címzettnek
 *                          EZZEL a tartalommal."
 *                          Only this can pass the autonomous-execution branch,
 *                          because only here is the operation actually
 *                          human-authorised.
 *
 * NO PARALLEL APPROVAL SYSTEM. His instruction was explicit -- reuse the exact
 * approval object if one exists -- and one does. `action_authorizations` (§22.2)
 * already carries every field he required, as columns:
 *
 *   action_id + action_type      the concrete action
 *   recipient + target_reference the target
 *   payload_hash                 the parameters
 *   case_id + case_version       the case/run
 *   single_use + consumed_at     one use, via an atomic conditional UPDATE
 *   expires_at                   freshness
 *   revoked_at                   withdrawn authority, separately from spent
 *   policy_evaluation_hash       all of the above in ONE comparison, re-derived
 *                                at consumption, so an action edited after issue
 *                                no longer matches the ticket
 *
 * So the approval is not something this module invents. It is something this
 * module LOOKS UP, and the lookup is what makes the claim checkable: the answer
 * payload can say anything it likes, and the row either exists and binds to this
 * action or it does not.
 *
 * THE HONEST STATE, said here rather than discovered later. Nothing in the system
 * currently ISSUES such a ticket for a progression step -- an OWNER_DECISION
 * payload carries a single field, the choice. HUMAN_ACTION_APPROVAL is therefore
 * a built and tested path with no live producer today, and in practice every
 * high-risk step stays gated after an answer. That follows from the owner's rule
 * and he was told before this was written; it is not an accident, and it is not
 * a claim that approvals are happening.
 */

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  consumeAuthorization, type AuthorizationContext,
} from './action-authorization.js'
import type { RiskClass } from './decision-confidence.js'

export type HumanAnswerClass =
  | 'HUMAN_INFORMATION'
  | 'HUMAN_DECISION'
  | 'HUMAN_ACTION_APPROVAL'

/** What the owner said, in the shape the pipeline already has it. */
export interface OwnerAnswerFacts {
  eventType: string
  choice: string | null
  /** `answer-options`' reading of the choice. */
  intent: string
  /** The event payload, verbatim, so an approval reference can be read out of
   *  it without the pipeline having to know this module's schema. */
  payload: string | null
}

export interface HumanAnswerVerdict {
  answerClass: HumanAnswerClass
  /** TRUE only for an approval that was verified against the store AND consumed.
   *  Never true for information or a decision, whatever they say about
   *  themselves. */
  executionExemption: boolean
  /** Why, in one line, for the run record. A refused approval says which check
   *  refused it -- "no ticket" and "the ticket was for a different action" are
   *  different facts about the same answer. */
  reason: string
  authorizationId?: string
}

/**
 * The class, from what the event IS -- before any store lookup.
 *
 * An approval CLAIM is not an approval: a payload that names an authorization is
 * still only a claim until the row is found and consumed, so this function never
 * returns HUMAN_ACTION_APPROVAL. That verdict belongs to `resolveHumanAnswer`,
 * which can actually check.
 */
export function classifyHumanAnswer(a: OwnerAnswerFacts): HumanAnswerClass {
  // THE INTENT DECIDES, NOT THE EVENT LABEL, and the first version of this
  // function had both. It special-cased `OWNER_INFORMATION` and then fell
  // through to the intent -- two rules covering one question, and the mutation
  // harness proved the consequence: deleting the first changed nothing any test
  // could see, because every OWNER_INFORMATION in the fixtures also carried
  // INFORM. Two guards, neither proven.
  //
  // Deleted rather than propped up with a test, because the label is the weaker
  // of the two answers. This engine already rules that "the CHOICE decides when
  // there is one -- an OWNER_INFORMATION carrying {choice:'CANCEL'} is a
  // cancellation whatever the event is labelled". An OWNER_INFORMATION that
  // carries an explicit choice IS Istvan choosing between alternatives, and
  // classifying it by its envelope would contradict the rule the rest of the
  // engine already follows. Nothing about safety turns on it either way --
  // neither class grants an exemption -- so the consistent answer wins.
  //
  // INFORM: content without an instruction. UNMAPPED: a choice the engine has no
  // meaning for, which is recorded and never acted on -- calling that a decision
  // would give it exactly the weight the name exists to deny.
  if (a.intent === 'INFORM' || a.intent === 'UNMAPPED') return 'HUMAN_INFORMATION'
  return 'HUMAN_DECISION'
}

/** Read an authorization reference out of the answer payload. A payload that
 *  will not parse yields none: an unreadable claim is not a claim. */
export function approvalReferenceOf(payload: string | null): string | null {
  if (!payload) return null
  try {
    const p = JSON.parse(payload) as { authorizationId?: unknown }
    const id = p.authorizationId
    return typeof id === 'string' && id.trim() !== '' ? id : null
  } catch { return null }
}

/**
 * The identity of a progression step, as an action a ticket can be bound to.
 *
 * Deterministic and derived from the step itself -- the case, the plan step and
 * the step's own text. Two different actions on one case cannot collide, and the
 * same action re-planned with a different description does not inherit the old
 * approval, because the description is inside the payload hash.
 */
export function progressionActionIdentity(
  domain: 'personal' | 'zst', caseId: string, planStep: number,
): string {
  return `${domain}:${caseId}:plan-step:${planStep}`
}

export function progressionPayloadHash(description: string): string {
  return createHash('sha256').update(description).digest('hex')
}

/**
 * Risk classes an owner approval may NOT wave through.
 *
 *   "A meglévő strictebb PAYMENT / legal / contractual / SHARE_BEYOND_APPROVED
 *    szabályokat ez se írhatja felül."
 *
 * IRREVERSIBLE_EXTERNAL is absent on purpose: that class is "this step can reach
 * outside", which is precisely the thing an explicit action approval is for. The
 * other four are categories the system refuses on their own terms, and an
 * approval collected for one action must not become a key to them.
 */
export const APPROVAL_CANNOT_WAIVE: readonly RiskClass[] = [
  'FINANCIAL_CONTRACTUAL', 'CREDENTIAL_SECURITY', 'DESTRUCTIVE', 'ACCESS_CONTROL',
]

export interface ApprovalCheckContext {
  domain: 'personal' | 'zst'
  caseId: string
  caseVersion: number | null
  goalVersion: number | null
  planStep: number
  /** The step's own text -- what was approved, not merely which step number. */
  description: string
  actionType: string
  recipient: string | null
  riskClasses: readonly RiskClass[]
}

/**
 * The full verdict: class first, then -- only for a decision-shaped answer that
 * names a ticket -- an actual, consuming check against the store.
 *
 * CONSUMING, not peeking. The ticket is single-use, and a check that looked
 * without spending would let one approval authorise every subsequent run: the
 * second use is exactly what the owner's fourth mandatory counter-example
 * requires to be denied.
 */
export function resolveHumanAnswer(
  db: Database.Database,
  answer: OwnerAnswerFacts,
  ctx: ApprovalCheckContext,
  now: number,
): HumanAnswerVerdict {
  const answerClass = classifyHumanAnswer(answer)
  const ref = approvalReferenceOf(answer.payload)

  if (!ref) {
    return {
      answerClass, executionExemption: false,
      reason: answerClass === 'HUMAN_INFORMATION'
        ? 'a tulajdonos tényt közölt — ez nem jóváhagyás'
        : 'a tulajdonos döntött — ez a bizalomba számít, nem külső művelet jóváhagyása',
    }
  }

  // A named ticket on an INFORMATION answer is still not an approval: "the
  // address is 12/B" does not become permission because a field was attached.
  if (answerClass !== 'HUMAN_DECISION') {
    return {
      answerClass, executionExemption: false,
      reason: 'információ-válaszhoz csatolt jóváhagyás-hivatkozás — nem jóváhagyás',
    }
  }

  const blocked = ctx.riskClasses.filter(c => APPROVAL_CANNOT_WAIVE.includes(c))
  if (blocked.length) {
    return {
      answerClass, executionExemption: false,
      reason: `a jóváhagyás nem írhatja felül a szigorúbb szabályt: ${blocked.join(', ')}`,
    }
  }

  const authCtx: AuthorizationContext = {
    domain: ctx.domain,
    caseId: ctx.caseId,
    caseVersion: ctx.caseVersion,
    goalVersion: ctx.goalVersion,
    actionId: progressionActionIdentity(ctx.domain, ctx.caseId, ctx.planStep),
    actionType: ctx.actionType,
    intent: 'PROGRESSION_STEP',
    targetReference: ctx.caseId,
    recipient: ctx.recipient,
    payloadHash: progressionPayloadHash(ctx.description),
    approvalId: null,
  }
  const consumed = consumeAuthorization(db, ref, authCtx, now)
  if (!consumed.ok) {
    return {
      answerClass, executionExemption: false,
      reason: `a hivatkozott jóváhagyás nem érvényes erre a műveletre: ${consumed.reason}`,
    }
  }
  return {
    answerClass: 'HUMAN_ACTION_APPROVAL',
    executionExemption: true,
    reason: 'a tulajdonos ezt a konkrét műveletet hagyta jóvá (egyszer használatos jegy felhasználva)',
    authorizationId: consumed.authorizationId,
  }
}
