// §15.4 / §15.5 / §16 / §26(20, 22, 23): the internal preparation planner, the
// factual-quality gate, and the PreparedInitiative artifact.
//
// INTERNAL ONLY. Every step this planner can emit is one of §15.1's thirteen
// classes, and the release-boundary standing checks fail if that list ever grows
// an external one. Nothing here sends, fetches, browses or asks.
//
// §16'S ARTIFACT IS THE POINT OF THE WHOLE RELEASE, and the spec says why:
//
//     "This is what makes it measurable what Marveen noticed, why he judged it
//      important, what he resolved by himself, what he prepared, and when and
//      why he would interrupt István."
//
// Five questions, and every one of them has to be answerable from the stored row
// alone — "Mission Control UI nélkül is tárolható és replayelhető". So the
// artifact carries the qualification's reason codes, not a summary of them; the
// resolved evidence AND the remaining unknowns, not just the first; and the
// interruption decision with its reason, whether or not anyone is ever
// interrupted.
//
// THE DRAFT GATE (§15.5) IS THE SHARPEST EDGE IN v1.4. A draft is not an
// external side effect — it is one approval away from being one. So the gate's
// default is NOT approval-ready, and the named negative fixture (V4-F12) is a
// relative-time claim computed from the wrong timestamp. That failure is
// invisible in review: "7 days have passed" reads exactly as well when the true
// answer is 2.

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  INTERNAL_PREPARATION_CLASSES,
  type EvidenceClaim,
  type InternalPreparationClass,
  type ProactiveDomain,
  type ProactiveInitiative,
} from './types.js'

export interface InternalPreparationStep {
  stepClass: InternalPreparationClass
  label: string
  /** What this step needs before it can run. Empty is normal. */
  requires: string[]
}

/** §15.4. */
export interface InternalPreparationPlan {
  initiativeId: string
  steps: InternalPreparationStep[]
  stopCondition: string
  userBoundary?: string
  evidenceRequired: string[]
}

/** §15.4: "3–7 meaningful, case-specific steps; template reuse alone is not
 *  enough." The bounds are enforced; "case-specific" is checked in the weakest
 *  honest way — that the steps are not all identical boilerplate — because a
 *  stronger test would be a judgement this layer is not entitled to make. */
export const MIN_PLAN_STEPS = 3
export const MAX_PLAN_STEPS = 7

export type PlanResult =
  | { ok: true; plan: InternalPreparationPlan }
  | { ok: false; reasons: string[] }

/**
 * Build a preparation plan for a qualified Initiative.
 *
 * Deterministic, and derived from the Initiative's OWN gap and unresolved
 * requirements rather than from its type. A type-keyed template would satisfy
 * the step count and fail the sentence that follows it: the spec asks for
 * case-specific steps precisely because a plan that is the same for every
 * DEADLINE initiative tells the reader nothing they did not already know from
 * the word DEADLINE.
 */
export function planPreparation(
  initiative: ProactiveInitiative,
  now: number,
): PlanResult {
  const reasons: string[] = []
  const allowed = new Set<InternalPreparationClass>(initiative.allowedPreparationClasses)
  const steps: InternalPreparationStep[] = []

  const add = (stepClass: InternalPreparationClass, label: string, requires: string[] = []): void => {
    // The allowlist is the Initiative's, not the planner's: promotion already
    // decided what this particular initiative may do, and widening it here would
    // route around that decision.
    if (allowed.has(stepClass) && steps.length < MAX_PLAN_STEPS) {
      steps.push({ stepClass, label, requires })
    }
  }

  // 1. Read what we have. Always first: every later step is worth less without
  //    it, and it is the cheapest step in the list.
  add('READ_CONTEXT', `A(z) "${initiative.currentGap}" hiány kontextusának összeolvasása.`)

  // 2. Resolve-before-ask (§14). Each unresolved requirement becomes its own
  //    step, named — so the plan says WHAT is missing rather than that
  //    something is.
  for (const req of initiative.unresolvedRequirements.slice(0, 3)) {
    add('RESOLVE_MISSING_INFORMATION', `Hiányzó információ felkutatása belülről: ${req}.`, [req])
  }

  // 3. The deadline, when there is one to check.
  if (initiative.decisionDeadline != null) {
    add('CHECK_DEADLINE',
      `A(z) ${initiative.decisionDeadline} határidő és a belső biztonsági dátum ellenőrzése.`)
  }

  // 4. Type-specific, and only where it earns its place.
  if (initiative.initiativeType === 'STALL') add('CHECK_STALL', 'Az elakadás okának beazonosítása a futásnaplóból.')
  if (initiative.initiativeType === 'ANOMALY') add('CHECK_ANOMALY', 'Az ellentmondó tények szembeállítása.')
  if (initiative.initiativeType === 'RISK') add('ASSESS_RISK', 'A kockázat mértékének felmérése a meglévő bizonyítékokból.')

  // 5. Organise, and package the decision — the two that make the result
  //    readable by a person rather than only by the engine.
  add('ORGANIZE_EVIDENCE', 'A feloldott bizonyítékok rendezése a döntéshez.')
  add('PREPARE_DECISION_PACKAGE', `Döntési csomag: ${initiative.desiredOutcome.targetState}.`)

  if (steps.length < MIN_PLAN_STEPS) {
    reasons.push(
      `${steps.length} lépés a szükséges ${MIN_PLAN_STEPS} helyett — `
      + 'az Initiative megengedett előkészítési osztályai nem fedik le a hiányt (§15.4)',
    )
  }
  // §15.4's second sentence, in the weakest form that is still honest: a plan
  // whose steps are indistinguishable from each other is a template, not a plan.
  if (new Set(steps.map(s => s.label)).size < steps.length) {
    reasons.push('a terv ismétlődő lépéseket tartalmaz — a puszta sablon-újrafelhasználás nem elég (§15.4)')
  }
  if (reasons.length) return { ok: false, reasons }

  return {
    ok: true,
    plan: {
      initiativeId: initiative.initiativeId,
      steps,
      // Stop conditions are stated, not implied. An internal loop with no stated
      // end is the shape that runs until someone notices the bill.
      stopCondition: initiative.internalSafeDeadline != null
        ? `Minden lépés kész, VAGY elérjük a belső biztonsági dátumot (${initiative.internalSafeDeadline}).`
        : 'Minden lépés kész, VAGY nincs több belülről feloldható hiány.',
      userBoundary: initiative.userInterruptionRequired
        ? `A döntés Istváné: ${initiative.desiredOutcome.targetState}.`
        : undefined,
      evidenceRequired: initiative.desiredOutcome.completionEvidence,
    },
  }
}

// ── §15.5 the proactive draft factual-quality gate ──────────────────────

/** A computed claim, with the derivation that produced it. §15.5: "every
 *  computed statement must carry a deterministic derivation record." */
export interface DerivationRecord {
  claim: string
  /** The source timestamp the computation started from — NOT a follow-up due
   *  date, not "now", not any other proxy. This field is the whole of V4-F12. */
  sourceTimestamp: number
  sourceRef: string
  computedValue: number
  unit: 'days' | 'hours' | 'amount'
}

export interface DraftForGate {
  recipient?: string
  threadRef?: string
  contextTarget?: string
  /** Material factual statements, each with its citation. */
  factualClaims: EvidenceClaim[]
  /** Every claim that was COMPUTED rather than quoted. */
  derivations: DerivationRecord[]
  /** Evidence known to be stale or contradicted. Present and non-empty means
   *  NOT_APPROVAL_READY, by §15.5. */
  staleOrConflictingEvidence: string[]
}

export type DraftGateVerdict = 'APPROVAL_READY' | 'NOT_APPROVAL_READY'

export interface DraftGateResult {
  verdict: DraftGateVerdict
  reasons: string[]
}

/**
 * §15.5. Default NOT_APPROVAL_READY: a draft is one approval away from being an
 * external side effect, and the cost of a wrong default is asymmetric.
 *
 * `now` is passed in rather than read, so the same draft gives the same verdict
 * in a replay as it did live.
 */
export function draftQualityGate(
  draft: DraftForGate,
  now: number,
  /** Tolerance for a derivation that was computed at a slightly different
   *  moment than the check. Not a tolerance for a WRONG source. */
  toleranceSec = 86400,
): DraftGateResult {
  const reasons: string[] = []

  if (!draft.recipient?.trim()) reasons.push('a címzett nincs megadva (§15.5)')
  if (!draft.threadRef?.trim()) reasons.push('a szál nincs megadva (§15.5)')
  if (!draft.contextTarget?.trim()) reasons.push('a kontextus-cél nincs megadva (§15.5)')

  if (!draft.factualClaims.length) reasons.push('nincs egyetlen tényállítás sem, amit ellenőrizni lehetne')
  for (const c of draft.factualClaims) {
    if (!c.sourceRef?.trim()) reasons.push(`bizonyíték nélküli tényállítás: "${c.statement}"`)
  }

  if (draft.staleOrConflictingEvidence.length) {
    // §15.5 names this outcome directly. A draft built on evidence we KNOW is
    // contested is not a draft that needs a warning label; it is one that must
    // not reach the approval queue.
    reasons.push(`elavult vagy ellentmondó bizonyíték (${draft.staleOrConflictingEvidence.join(', ')})`)
  }

  for (const d of draft.derivations) {
    if (!d.sourceRef?.trim()) {
      reasons.push(`levezetés forrás nélkül: "${d.claim}"`)
      continue
    }
    if (!Number.isSafeInteger(d.sourceTimestamp) || d.sourceTimestamp <= 0) {
      reasons.push(`a levezetés forrás-időbélyege érvénytelen: "${d.claim}"`)
      continue
    }
    if (d.unit === 'days' || d.unit === 'hours') {
      // V4-F12, checked rather than trusted. The stored derivation says which
      // timestamp it started from; recomputing from that timestamp must give the
      // number the draft states. A claim computed from the follow-up due date
      // instead of the outreach fails here, and the fixture is exactly that.
      const per = d.unit === 'days' ? 86400 : 3600
      const expected = Math.floor((now - d.sourceTimestamp) / per)
      if (Math.abs(expected - d.computedValue) > Math.ceil(toleranceSec / per)) {
        reasons.push(
          `a(z) "${d.claim}" állítás ${d.computedValue} ${d.unit}, de a megadott forrás-időbélyegből `
          + `${expected} jön ki — más időalapból számolt relatív idő (V4-F12)`,
        )
      }
    }
  }

  // Every material claim that reads as a computed number must HAVE a derivation.
  // The failure this catches is the one where somebody writes "7 days" into the
  // prose and nobody records where the 7 came from — after which the check above
  // has nothing to check.
  for (const c of draft.factualClaims) {
    if (!/\d+\s*(nap|napja|óra|órája|day|days|hour|hours)/i.test(c.statement)) continue
    const covered = draft.derivations.some(d => c.statement.includes(String(d.computedValue)))
    if (!covered) {
      reasons.push(`számított állítás levezetés nélkül: "${c.statement}" (§15.5)`)
    }
  }

  return reasons.length
    ? { verdict: 'NOT_APPROVAL_READY', reasons }
    : { verdict: 'APPROVAL_READY', reasons: [] }
}

// ── §16 the PreparedInitiative artifact ─────────────────────────────────

export interface PreparedInitiative {
  initiativeId: string
  domain: ProactiveDomain
  caseId?: string
  signalRefs: string[]
  qualification: {
    materiality: string
    urgency: string
    actionability: number
    reasonCodes: string[]
  }
  desiredOutcome: unknown
  currentGap: string
  deadline?: number
  internalSafeDeadline?: number
  evidenceResolved: string[]
  remainingUnknowns: string[]
  riskAssessment: string
  preparedActions: InternalPreparationStep[]
  blockedBy?: string
  userDecisionRequired: boolean
  interruptionPriority: 'NONE' | 'LOW' | 'NORMAL' | 'HIGH'
  nextReviewAt?: number
  confidence: number
}

export function ensurePreparationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prepared_initiatives (
      initiative_id     TEXT PRIMARY KEY,
      domain            TEXT NOT NULL,
      case_id           TEXT,
      artifact_json     TEXT NOT NULL,
      /* Digest of the artifact at write time. §1.4.3 adjudicates against a
         frozen corpus, and an artifact that changed after being adjudicated
         would rewrite the evidence the value gate was measured on. */
      artifact_digest   TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      CHECK (domain IN ('personal','zst'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_prepinit_case ON prepared_initiatives(case_id) WHERE case_id IS NOT NULL`)
}

/**
 * §16: assemble the artifact.
 *
 * Every field the spec lists, and the five questions it exists to answer are
 * answerable from this row alone. Two of them are easy to get wrong by omission:
 *
 *   - `remainingUnknowns` — without it, "what did he resolve by himself" has no
 *     denominator, and a preparation that resolved one of nine looks the same as
 *     one that resolved nine of nine.
 *   - `interruptionPriority` even when it is NONE. "When and why would he
 *     interrupt" is a question about the cases where the answer is never, too.
 */
export function buildPreparedInitiative(
  initiative: ProactiveInitiative,
  plan: InternalPreparationPlan,
  resolved: { evidenceResolved: string[]; remainingUnknowns: string[]; riskAssessment: string },
  qualificationReasonCodes: string[],
  actionabilityScore: number,
  now: number,
): PreparedInitiative {
  const priority: PreparedInitiative['interruptionPriority'] = !initiative.userInterruptionRequired
    ? 'NONE'
    : initiative.urgency === 'CRITICAL' ? 'HIGH'
      : initiative.urgency === 'HIGH' ? 'NORMAL' : 'LOW'
  return {
    initiativeId: initiative.initiativeId,
    domain: initiative.domain,
    caseId: initiative.caseId,
    signalRefs: initiative.signalIds,
    qualification: {
      materiality: initiative.materiality,
      urgency: initiative.urgency,
      actionability: actionabilityScore,
      reasonCodes: qualificationReasonCodes,
    },
    desiredOutcome: initiative.desiredOutcome,
    currentGap: initiative.currentGap,
    deadline: initiative.decisionDeadline,
    internalSafeDeadline: initiative.internalSafeDeadline,
    evidenceResolved: resolved.evidenceResolved,
    remainingUnknowns: resolved.remainingUnknowns,
    riskAssessment: resolved.riskAssessment,
    preparedActions: plan.steps,
    blockedBy: resolved.remainingUnknowns.length ? resolved.remainingUnknowns[0] : undefined,
    userDecisionRequired: initiative.userInterruptionRequired,
    interruptionPriority: priority,
    nextReviewAt: initiative.internalSafeDeadline ?? initiative.decisionDeadline,
    confidence: initiative.confidence,
  }
}

export type StoreArtifactResult = { ok: true; digest: string } | { ok: false; reason: string }

/** Persist the artifact. Refuses a prepared action outside §15.1 — the same
 *  check the promotion path makes, repeated here because this is a second door
 *  into the same room and §15.3(5) is about aliases arriving anywhere. */
export function storePreparedInitiative(
  db: Database.Database, artifact: PreparedInitiative, now: number,
): StoreArtifactResult {
  const foreign = artifact.preparedActions
    .map(s => s.stepClass)
    .filter(c => !INTERNAL_PREPARATION_CLASSES.includes(c))
  if (foreign.length) {
    return { ok: false, reason: `nem engedélyezett előkészítési osztály (§15.1): ${foreign.join(', ')}` }
  }
  const json = JSON.stringify(artifact)
  const digest = createHash('sha256').update(json).digest('hex').slice(0, 32)
  db.prepare(
    `INSERT INTO prepared_initiatives (initiative_id, domain, case_id, artifact_json, artifact_digest, created_at, updated_at)
     VALUES (@id, @domain, @caseId, @json, @digest, @now, @now)
     ON CONFLICT(initiative_id) DO UPDATE SET
       artifact_json = @json, artifact_digest = @digest, updated_at = @now`,
  ).run({
    id: artifact.initiativeId, domain: artifact.domain, caseId: artifact.caseId ?? null,
    json, digest, now,
  })
  return { ok: true, digest }
}

export function readPreparedInitiative(db: Database.Database, initiativeId: string): PreparedInitiative | null {
  const r = db.prepare(`SELECT artifact_json FROM prepared_initiatives WHERE initiative_id = ?`)
    .get(initiativeId) as { artifact_json: string } | undefined
  return r ? JSON.parse(r.artifact_json) as PreparedInitiative : null
}
