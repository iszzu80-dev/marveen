// E3 — a contradiction is two claims on the SAME axis, not two different words.
//
// Owner ruling, 2026-08-31: "CONTRADICTION csak akkor áll fenn, ha két bizonyíték
// ugyanarról a konkrét következő actionről, ugyanazon döntési dimenzióban,
// ugyanazon időhorizontra egymással inkompatibilis állítást tesz. A case-level
// need és az execution permission külön dimenzió."
//
// Before this, `arbitrate` called ANY difference between the reader's candidate
// and the policy's decision a conflict, and Invariant E refused every
// non-read-only action on the strength of it. Measured on the live store the
// same morning: 133 such conflicts, of which 106 were one shape -- the reader
// proposing a halt while the policy answered CONTINUE_AUTONOMOUSLY, its own
// reason reading "Information gathering can proceed without external input" or
// "Next action can be executed autonomously IN SHADOW MODE". Asking IS a way of
// gathering. Neither sentence is the negation of the other. They were two
// answers to two different questions, recorded as evidence contradicting itself.
//
// THE FOUR AXES. A decision speaks on some of them and is SILENT on the rest,
// and silence is not disagreement -- that distinction is the whole fix.
//
//   HUMAN_DEPENDENCY      does some necessary part of this case need a person:
//                         information, a decision, or an act only they can do?
//   ENGINE_EXECUTION      may the engine take the concrete next step on its own?
//   EXTERNAL_SIDE_EFFECT  is the concrete external action permitted right now,
//                         after every risk / approval / capability / safety gate?
//   TERMINALITY           is the DoD actually met -- may the case be closed?
//
// WHAT THIS IS NOT. Narrowing what counts as a contradiction is not permission
// to act. It removes ONE veto. Every other gate still has to pass on its own:
// action semantics, reachesOutside, capability, risk class, scoped approval
// where required, W12 idempotency, disclosure and egress, policy. In the owner's
// words: NO RELEVANT CONTRADICTION != ALLOW.

export const AXES = [
  'HUMAN_DEPENDENCY',
  'ENGINE_EXECUTION',
  'EXTERNAL_SIDE_EFFECT',
  'TERMINALITY',
] as const
export type Axis = (typeof AXES)[number]

/** A claim on one axis. `null` anywhere means the decision does not speak. */
export type AxisClaims = Partial<Record<Axis, boolean>>

/**
 * What each decision in the §7 vocabulary actually asserts.
 *
 * Written as a total table rather than a rule, because a rule that infers the
 * claims from the name is a rule that will quietly reclassify a decision the
 * day somebody adds one. An unlisted decision claims nothing and can therefore
 * contradict nothing -- see `claimsOf`, which says so out loud.
 */
export const DECISION_CLAIMS: Record<string, AxisClaims> = {
  // The engine may proceed on its own, and it is proceeding, so the case is not
  // finished. It says NOTHING about whether a person is also needed -- that is
  // exactly the silence that used to read as "no person is needed".
  CONTINUE_AUTONOMOUSLY: { ENGINE_EXECUTION: true, TERMINALITY: false },

  // A person is needed. None of these claims the engine must stand still
  // meanwhile: an engine can gather, verify and prepare while a question is out.
  ASK_INFORMATION: { HUMAN_DEPENDENCY: true, TERMINALITY: false },
  REQUEST_DECISION: { HUMAN_DEPENDENCY: true, TERMINALITY: false },
  CALL_REQUIRED: { HUMAN_DEPENDENCY: true, TERMINALITY: false },
  MANUAL_ACTION_REQUIRED: { HUMAN_DEPENDENCY: true, TERMINALITY: false },

  // Approval is a human dependency AND a statement about the outward act: it
  // may not go without a person saying so.
  REQUEST_APPROVAL: { HUMAN_DEPENDENCY: true, EXTERNAL_SIDE_EFFECT: false, TERMINALITY: false },

  // These DO speak on engine execution: the next step cannot be taken now,
  // because a third party or the clock or a broken state is in the way. Against
  // CONTINUE_AUTONOMOUSLY that is a real, same-axis disagreement and stays one.
  WAIT_EXTERNAL: { ENGINE_EXECUTION: false, TERMINALITY: false },
  WAIT_TIME: { ENGINE_EXECUTION: false, TERMINALITY: false },
  RECOVERY_REQUIRED: { ENGINE_EXECUTION: false, TERMINALITY: false },

  // The one claim about the end of the case.
  COMPLETE: { TERMINALITY: true },
}

export function claimsOf(decision: string | null | undefined): AxisClaims {
  if (!decision) return {}
  return DECISION_CLAIMS[decision] ?? {}
}

export interface AxisConflict {
  axis: Axis
  readerClaim: boolean
  policyClaim: boolean
  reason: string
}

/**
 * The same-axis test. Returns every axis on which the two make incompatible
 * claims -- usually none or one, and the list keeps it honest when it is more.
 *
 * Identical decisions cannot conflict, and a decision the table does not know
 * claims nothing: an unknown name must not manufacture a contradiction out of
 * unfamiliarity.
 */
export function axisConflicts(
  readerCandidate: string | null | undefined,
  policyDecision: string | null | undefined,
): AxisConflict[] {
  if (!readerCandidate || !policyDecision || readerCandidate === policyDecision) return []
  const r = claimsOf(readerCandidate)
  const p = claimsOf(policyDecision)
  const out: AxisConflict[] = []
  for (const axis of AXES) {
    const rc = r[axis]
    const pc = p[axis]
    if (rc === undefined || pc === undefined) continue   // silence is not disagreement
    if (rc === pc) continue
    out.push({
      axis, readerClaim: rc, policyClaim: pc,
      reason: `${axis}: az olvasó szerint ${rc ? 'IGEN' : 'NEM'}, a policy szerint ${pc ? 'IGEN' : 'NEM'}`
        + ` (${readerCandidate} kontra ${policyDecision})`,
    })
  }
  return out
}

/** Is there a real, same-axis contradiction between the two readings? */
export function isAxisContradiction(
  readerCandidate: string | null | undefined,
  policyDecision: string | null | undefined,
): boolean {
  return axisConflicts(readerCandidate, policyDecision).length > 0
}

/**
 * Is an existing contradiction RELEVANT to the action being weighed?
 *
 * The owner's list: the action itself, whether it is necessary, its target,
 * payload and externality, its human-approval requirement, its risk and safety
 * classification, or any prerequisite without which the action cannot be
 * justified.
 *
 * All four axes qualify for an action that reaches outside or mutates:
 *   - EXTERNAL_SIDE_EFFECT is the permission itself;
 *   - TERMINALITY decides whether the case is even open for it;
 *   - ENGINE_EXECUTION is the prerequisite that the engine may act at all;
 *   - HUMAN_DEPENDENCY -- note this is a DISAGREEMENT about whether a person is
 *     required, not the mere fact that one is, and acting outward while the two
 *     readings differ on that is exactly the case the invariant exists for.
 *
 * So the reduction comes entirely from the axis model, not from a narrower
 * relevance rule. Stated plainly rather than dressed up: inventing a rule that
 * let some axis through would be trading safety for a smaller number, and the
 * number was never the point.
 *
 * READ_ONLY keeps the owner's existing carve-out.
 */
export function contradictionBlocksAction(
  conflicts: readonly AxisConflict[], sideEffect: string | null | undefined,
): boolean {
  if (!conflicts.length) return false
  return sideEffect !== 'READ_ONLY'
}
