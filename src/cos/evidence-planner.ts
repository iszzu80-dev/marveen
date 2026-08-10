// Personal Chief of Staff (COS) — the plan derived from evidence (§12, §4.2).
//
// THE NUMBER THIS EXISTS TO MOVE. Measured on the live store before it was
// written: across 101 cases the goal field had 100 distinct values (0.99) and the
// plan had 10 (0.10), the next best action 7 (0.07). Every case knew what it was
// about — the interpreter did that — and none of them knew what to do next,
// because buildRollingPlan emits three fixed steps per status. "Verify current
// state and gathered context." "Execute the next action in the work plan."
//
// WHY THIS IS DETERMINISTIC AND NOT A SECOND MODEL CALL. The judgement already
// happened: the Reader (§10.2) produced facts, missing requirements and a ball
// holder, each cited to a source. A plan derived from THAT is specific because
// the PACKET is specific, not because a model was asked to be creative twice.
// One model call, in the place where judgement belongs, and a projection here
// that can be read, tested and argued with.
//
// It also makes §4.2's plan_step_evidence_linkage true by construction rather
// than by inspection: a step exists BECAUSE of a piece of evidence, and carries
// its reference.
import type { ReaderEvidencePacket, ProgressionDecision } from './reader.js'

export interface EvidencePlanStep {
  step: number
  label: string
  kind: 'OBTAIN' | 'AWAIT_EXTERNAL' | 'ASK_OWNER' | 'EXECUTE' | 'VERIFY' | 'CLOSE'
  /** Which evidence produced this step. Empty is a defect, not a default. */
  evidenceRefs: string[]
  needsExternal: boolean
  blockedBy: string | null
}

export interface NextBestAction {
  planStep: number
  description: string
  kind: EvidencePlanStep['kind']
  canProceedAutonomously: boolean
  evidenceRefs: string[]
}

export interface EvidencePlan {
  steps: EvidencePlanStep[]
  nextBestAction: NextBestAction | null
  /** Why the plan looks like this. Written for a human reading the case later,
   *  not for the machine. */
  rationale: string
}

/**
 * Turn an evidence packet into a plan.
 *
 * The shape of the plan follows the evidence, in this order:
 *   1. every missing requirement becomes a step to obtain it, from whoever has
 *      it — this is the part that makes plans differ between cases;
 *   2. the ball holder decides whether we wait, ask, or act;
 *   3. a closing step only when there is nothing missing and nothing to wait for.
 *
 * A case with three missing pieces of information gets a three-step plan naming
 * all three. That is the entire difference from the template.
 */
export function planFromEvidence(packet: ReaderEvidencePacket): EvidencePlan {
  const steps: EvidencePlanStep[] = []
  let n = 0

  // 1. What is missing, from whom, and why — one step each.
  for (const m of packet.missingRequirements) {
    n += 1
    const fromOwner = m.whoHasIt.toUpperCase() === 'ISTVAN'
    steps.push({
      step: n,
      label: `${m.what} beszerzése (${m.whoHasIt}) — ${m.why}`,
      kind: fromOwner ? 'ASK_OWNER' : 'OBTAIN',
      // The linkage §4.2 asks for. A missing requirement is itself the evidence
      // for the step, and the facts that mention the same source back it up.
      evidenceRefs: packet.facts
        .filter(f => f.statement.includes(m.what) || m.why.includes(f.statement.slice(0, 20)))
        .map(f => f.sourceRef)
        .concat(packet.readSources.slice(0, 1)),
      needsExternal: !fromOwner,
      blockedBy: m.whoHasIt,
    })
  }

  // 2. Whose move it is now.
  if (packet.ballHolder === 'EXTERNAL') {
    n += 1
    steps.push({
      step: n, label: 'Külső válasz bevárása', kind: 'AWAIT_EXTERNAL',
      evidenceRefs: packet.readSources, needsExternal: true, blockedBy: 'EXTERNAL',
    })
  } else if (packet.ballHolder === 'ISTVAN') {
    n += 1
    steps.push({
      step: n, label: 'Istvan döntése szükséges', kind: 'ASK_OWNER',
      evidenceRefs: packet.readSources, needsExternal: false, blockedBy: 'ISTVAN',
    })
  } else if (packet.ballHolder === 'MARVEEN' && packet.missingRequirements.length === 0) {
    n += 1
    steps.push({
      step: n, label: 'A következő lépés végrehajtása', kind: 'EXECUTE',
      evidenceRefs: packet.readSources, needsExternal: false, blockedBy: null,
    })
  }

  // 3. Closing, only when there is genuinely nothing left.
  if (packet.candidateDecision === 'COMPLETE' && packet.missingRequirements.length === 0) {
    n += 1
    steps.push({
      step: n, label: 'Az ügy lezárása és a bizonyíték rögzítése', kind: 'CLOSE',
      evidenceRefs: packet.readSources, needsExternal: false, blockedBy: null,
    })
  }

  // A packet with nothing missing, no ball holder and no completion says only
  // that we do not know enough. Saying so is better than inventing a step.
  if (steps.length === 0) {
    steps.push({
      step: 1, label: 'Nincs elég információ a következő lépéshez — újraolvasás szükséges',
      kind: 'VERIFY', evidenceRefs: packet.readSources, needsExternal: false,
      blockedBy: 'INSUFFICIENT_EVIDENCE',
    })
  }

  const first = steps[0]
  const nextBestAction: NextBestAction = {
    planStep: first.step,
    description: first.label,
    kind: first.kind,
    // Only a step that needs nobody else may proceed on its own — and low
    // confidence removes that permission whatever the step says (§13.1's
    // fail-safe: low confidence must not produce an external effect).
    canProceedAutonomously: !first.needsExternal && first.blockedBy === null && packet.confidence >= 0.6,
    evidenceRefs: first.evidenceRefs,
  }

  return {
    steps,
    nextBestAction,
    rationale: [
      `${packet.missingRequirements.length} hiányzó tétel`,
      `a labda: ${packet.ballHolder}`,
      `a Reader javaslata: ${packet.candidateDecision}`,
      `magabiztosság: ${packet.confidence}`,
    ].join(' · '),
  }
}

// ── §4.2 semantic-quality metrics ────────────────────────────────────────
//
// The spec names six. These are the three that can be computed from the stored
// plans alone; the rest need a run history to compare against. Written as code
// rather than described in prose so the claim "the plans are case-specific" is
// a number somebody can re-derive, not an impression.

export interface QualityMetrics {
  cases: number
  distinctPlans: number
  distinctNextActions: number
  /** distinct / total. 1.0 = every case has its own; near 0 = a template. */
  distinctValueRatio: number
  /** The share of plan steps that cite at least one piece of evidence. */
  planStepEvidenceLinkage: number
}

export function measurePlanQuality(
  plans: Array<{ steps: EvidencePlanStep[]; nextBestAction: NextBestAction | null }>,
): QualityMetrics {
  const cases = plans.length
  const planKeys = new Set(plans.map(p => JSON.stringify(p.steps.map(s => s.label))))
  const actionKeys = new Set(plans.map(p => p.nextBestAction?.description ?? ''))
  const allSteps = plans.flatMap(p => p.steps)
  const linked = allSteps.filter(s => s.evidenceRefs.length > 0).length
  return {
    cases,
    distinctPlans: planKeys.size,
    distinctNextActions: actionKeys.size,
    distinctValueRatio: cases === 0 ? 0 : planKeys.size / cases,
    planStepEvidenceLinkage: allSteps.length === 0 ? 0 : linked / allSteps.length,
  }
}
