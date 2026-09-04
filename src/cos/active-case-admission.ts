// WHAT MAY BE AN ACTIVE OPERATIONAL CASE.
//
// Owner ruling 2026-09-04, generalised from an incident I caused. I recorded an
// architectural backlog note as a ZST case; the live reconcile went red the same
// minute with `Invariant A: NO_NEXT_ACTION_AND_NO_WAIT`, and stayed red for two
// cycles until the case was archived.
//
// The invariant was right. Every ACTIVE case must carry either a real next
// action or a real, evaluable wait with review semantics. A note parked
// indefinitely pending an architectural change has neither -- and every way of
// giving it one would have been a fabrication: a capability probe that does not
// exist, or a review date invented to make the row look scheduled, which the
// owner had already forbidden on the CostOps cards.
//
// So the check moves BEFORE the write. Invariant A was a detector, reporting a
// bad row after it existed; this is the same rule asked one step earlier, where
// the answer is still "don't", rather than "now go and clean up".
//
// DELIBERATELY SMALL. This admits or refuses; it does not redesign case state,
// and it invents nothing on the caller's behalf. A refusal names the missing
// evidence and says where a non-operational note belongs instead.

/** The shape an admission decision is made from. Only the fields the rule
 *  actually reads -- a wider input would invite the guard to grow opinions. */
export interface ActiveCaseAdmissionInput {
  caseId: string
  status: string
  /** The next action, as the case would carry it. */
  nextAction?: string | null
  /** Free-text or typed subject of what is being waited for. */
  waitingOn?: string | null
  /** When the wait is next due a look. A wait with no review time is a wait
   *  nothing will ever end. */
  reviewAt?: number | null
  /** Terminal statuses are not active and are never admitted or refused here. */
  terminalStatuses: readonly string[]
}

export type AdmissionRefusal =
  | 'NO_ACTION_AND_NO_WAIT'
  | 'WAIT_WITHOUT_REVIEW_TIME'

export interface AdmissionResult {
  admitted: boolean
  refusal?: AdmissionRefusal
  /** Says what is missing and what to do instead. Never suggests inventing a
   *  value, because the whole point is that the missing value does not exist. */
  detail?: string
}

const NON_OPERATIONAL_ADVICE =
  'If this is an architecture or design note rather than operational work, it belongs in a '
  + 'backlog document, not in the case store: an operational case store is for operational cases.'

/**
 * May this be written as an ACTIVE operational case?
 *
 * Mirrors `evaluateInvariantA` deliberately: the detector and the admission
 * guard must agree, or a row admitted here would be reported as a violation
 * moments later, which is worse than either check alone.
 */
export function admitActiveCase(input: ActiveCaseAdmissionInput): AdmissionResult {
  // Terminal rows are outside the invariant entirely -- it only looks at active
  // cases -- so refusing them here would forbid closing anything.
  if (input.terminalStatuses.includes(input.status)) return { admitted: true }

  const action = input.nextAction?.trim()
  if (action) return { admitted: true }

  const wait = input.waitingOn?.trim()
  if (!wait) {
    return {
      admitted: false, refusal: 'NO_ACTION_AND_NO_WAIT',
      detail: `${input.caseId} would be ACTIVE (${input.status}) with no next action and nothing `
        + `being waited for. Do not invent a wait, a deadline or a review date to get past this. `
        + NON_OPERATIONAL_ADVICE,
    }
  }
  if (input.reviewAt === null || input.reviewAt === undefined) {
    return {
      admitted: false, refusal: 'WAIT_WITHOUT_REVIEW_TIME',
      detail: `${input.caseId} waits on "${wait}" with no review time, so nothing will ever bring `
        + `it back. Give the wait a real review moment, or record it as a backlog document. `
        + `Do not invent a date to satisfy this check. ` + NON_OPERATIONAL_ADVICE,
    }
  }
  return { admitted: true }
}

export class ActiveCaseAdmissionError extends Error {
  readonly refusal: AdmissionRefusal
  constructor(result: AdmissionResult & { refusal: AdmissionRefusal }) {
    super(`active case refused (${result.refusal}): ${result.detail}`)
    this.name = 'ActiveCaseAdmissionError'
    this.refusal = result.refusal
  }
}
