// The deterministic gate that stands between "Istvan pressed Approve" and a
// §22.2 ticket existing (P4 closure, ACTION_APPROVAL_PRODUCER_WIRING).
//
// WHY A THIRD MINTER, said plainly because the standing check in
// `cos-gate-permit.test.ts` exists to make somebody defend exactly this.
//
// `issueAuthorization` refuses any caller that cannot present a decision minted
// by a real gate. Until now the two minters were the two SEND gates
// (`evaluateDispatch`, `evaluateZstSendGate`), and that was the whole world:
// every ticket in the system authorised an outbound message. The owner's P4
// closure adds a second kind of authorised thing -- a PROGRESSION STEP that
// Invariant E refused to run autonomously -- and neither send gate can evaluate
// it. `evaluateDispatch` asks whether a connector can write, whether a campaign
// approval covers this rendered payload, and which model profile may see the
// content. A plan step has no connector, no campaign and no rendered payload.
// Handing it to that gate would mean either lying to it (fabricating a campaign
// so its checks pass) or widening it until it no longer means what its callers
// think it means. Both are worse than a third gate that answers the question
// actually being asked.
//
// WHAT WOULD BE THE WRONG ANSWER: exporting `issueAuthorization` to the answer
// path with no gate at all, on the argument that "the owner said yes, so what is
// left to check?". Plenty is left to check, and every item below is a way for a
// yes to be true and the ticket still wrong: the case moved on since the
// question went out, the step was already completed by another run, the kill
// switch was engaged in between, the request sat unanswered for a week, or the
// risk class is one the owner's own rule says an approval may never waive. A
// human yes is an input to this gate, not a replacement for it.
import type Database from 'better-sqlite3'
import { mintGatePermit, type GateDecisionLike } from './gate-permit.js'
import { killSwitchRefusal } from './kill-switch.js'
import { APPROVAL_CANNOT_WAIVE } from './human-answer-class.js'
import type { RiskClass } from './decision-confidence.js'

/** How long an issued progression ticket lives.
 *
 *  Deliberately longer than AUTHORIZATION_TTL_SEC (120s). A send ticket is
 *  consumed by the send that immediately follows its issue; this one is consumed
 *  by the NEXT progression run of the case, and the engine's cadence is minutes.
 *  A 120-second ticket would expire before the run it exists for, which is not a
 *  stricter system -- it is a producer that cannot produce, and the failure would
 *  look exactly like the gap this packet closes.
 *
 *  One hour, not a day: the ticket is permission for one step of one case at one
 *  version, and permission that outlives the situation it was granted in is the
 *  thing `expires_at` exists to prevent. */
export const PROGRESSION_APPROVAL_TTL_SEC = 3600

/** How long an UNANSWERED request stays answerable.
 *
 *  Separate from the ticket's TTL because they measure different things: this is
 *  how long the QUESTION is still the question, and Istvan answers on human time.
 *  Seven days, after which the answer is refused and the engine re-asks from the
 *  current state rather than acting on a week-old picture. */
export const APPROVAL_REQUEST_TTL_SEC = 7 * 86_400

export interface ProgressionApprovalRequestFacts {
  domain: 'personal' | 'zst'
  caseId: string
  /** The case version the request was BOUND to when it went out. */
  caseVersion: number | null
  planStep: number
  actionId: string
  riskClasses: readonly RiskClass[]
  requestedAt: number
  expiresAt: number
}

export interface ProgressionApprovalDecision extends GateDecisionLike {
  allowed: boolean
  reasons: string[]
}

/**
 * Evaluate whether an owner approval may become a ticket. Fail-closed: every
 * check must pass, and a check that cannot run counts as a refusal.
 *
 * The returned object is MINTED, allowed or not — `gatePermitRefusal` requires
 * both provenance and a yes, so a refused decision is safe to hand around and
 * still cannot buy a ticket.
 */
export function evaluateProgressionApproval(
  db: Database.Database,
  req: ProgressionApprovalRequestFacts,
  now: number,
): ProgressionApprovalDecision {
  const reasons: string[] = []

  // SINGLE USE IS NOT CHECKED HERE, deliberately. It belongs to the conditional
  // UPDATE in `decideActionApproval`, which is the only place that can enforce
  // it against two answers arriving at once. A copy of the check in this gate
  // would be a second guard for one property -- and the mutation harness has
  // already shown what that costs: whichever copy the tests happen to hit is the
  // one that gets proven, and the other can be deleted unnoticed.

  // 1. Freshness. A question answered after its window is answered about a
  //    situation that no longer has to be the current one.
  if (req.expiresAt <= now) {
    reasons.push(`a jóváhagyás-kérés lejárt (${req.expiresAt} <= ${now})`)
  }

  // 2. The kill switch. Engaged between the ask and the answer is the whole
  //    reason this is checked at ANSWER time and not only at ask time.
  const killed = killSwitchRefusal(db)
  if (killed) reasons.push(`kill switch: ${killed}`)

  // 3. Risk classes the owner's own rule says an approval may not waive. The
  //    same list `resolveHumanAnswer` refuses on at consumption — checked here
  //    too, because a ticket that can never be consumed should never be issued:
  //    an unusable ticket in the audit trail reads as a granted approval.
  const blocked = req.riskClasses.filter(c => APPROVAL_CANNOT_WAIVE.includes(c))
  if (blocked.length) {
    reasons.push(`a jóváhagyás nem írhatja felül a szigorúbb szabályt: ${blocked.join(', ')}`)
  }

  // 4. THE CASE MUST NOT HAVE MOVED. This is the check that makes the approval
  //    scoped in time as well as in shape. `policy_evaluation_hash` would catch
  //    it later at consumption — but refusing at issue means the audit trail
  //    never contains a ticket that was dead on arrival, and the owner gets told
  //    now rather than discovering silence.
  try {
    const table = req.domain === 'zst' ? 'zst_cases' : 'personal_cases'
    const row = db.prepare(`SELECT version FROM ${table} WHERE case_id = ?`)
      .get(req.caseId) as { version: number } | undefined
    if (!row) reasons.push(`az ügy nem létezik: ${req.caseId}`)
    else if (req.caseVersion !== null && row.version !== req.caseVersion) {
      reasons.push(`az ügy azóta változott (v${req.caseVersion} → v${row.version})`)
    }
  } catch (err) {
    // Cannot verify is not "fine". Same posture as consumeAuthorization's
    // approval lookup: a store that cannot answer the question refuses.
    reasons.push(`az ügy verziója nem ellenőrizhető: ${String((err as Error)?.message ?? err)}`)
  }

  // 5. The step must still be the step. A run that completed it between the ask
  //    and the answer makes the approval an approval of the past.
  try {
    const st = db.prepare(
      `SELECT completed_plan_step AS s FROM case_progression_state
        WHERE domain = ? AND case_id = ?`,
    ).get(req.domain, req.caseId) as { s: number | null } | undefined
    if (!st) reasons.push('az ügynek nincs progression állapota')
    else if ((st.s ?? 0) >= req.planStep) {
      reasons.push(`a lépés időközben elkészült (completed=${st.s} >= step=${req.planStep})`)
    }
  } catch (err) {
    reasons.push(`a lépés állapota nem ellenőrizhető: ${String((err as Error)?.message ?? err)}`)
  }

  return mintGatePermit({ allowed: reasons.length === 0, reasons })
}
