/**
 * P4 — confidence and risk, so Invariant E is an invariant.
 *
 * The spec sentence it exists to enforce:
 *
 *     Invariant E: Low-confidence high-risk action nem hajtható végre
 *     automatikusan.
 *
 * The audit's finding (§3.5) was not that this was violated -- it was that it
 * was **not enforceable**: personal cases carry neither a confidence nor a risk,
 * so the invariant lived as a sentence while the approval bind and the send
 * ceilings did the actual protecting. Real protections, and not this one.
 *
 * THE NAMES ARE `decision_*` ON PURPOSE. Two other `confidence` fields already
 * exist in this codebase and neither means what Invariant E means:
 *
 *   `answer-interpretation`  HIGH/LOW -- how unambiguous ISTVAN'S SENTENCE was
 *   `adjudication`           LOW/MEDIUM/HIGH -- how sure an origin GUESS is
 *
 * A third bare `confidence` would be the `next_wake_at` mistake again: one name,
 * three meanings, and a reader who cannot tell which one a number came from.
 * These are the ENGINE'S judgement about its OWN decision, and the column says so.
 *
 * DETERMINISTIC, and every input is a fact already on the row or already
 * computed by this run. No model call, no heuristic that varies between two
 * evaluations of the same state: a gate that can answer differently twice about
 * one case is not a gate, and §19's replay corpus could not exercise it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER'S P4 CLOSURE, 2026-08-27. Three changes, and the first is the one that
 * changes what a number MEANS:
 *
 *   "Confidence ne legyen »HIGH, amíg nem találtunk problémát« bizonyíték
 *    nélkül. […] A »nem detektáltunk doubt flaget« önmagában ne legyen
 *    bizonyíték a magas bizonyosságra."
 *
 * The first version started at HIGH and subtracted for named doubts. Every test
 * I wrote for it passed, and it was wrong in a way those tests could not see: a
 * case nobody had looked at -- no capability probe, no reconciliation, no
 * evidence at all -- scored exactly the same as one where every input had been
 * checked and found good. Absence of evidence was scoring as evidence of
 * absence, on the permissive side.
 *
 * So HIGH is now EARNED. The doubt ladder still runs and still names what it
 * finds, but the top of it is closed by a REQUIRED-INPUT PROOF SET: every input
 * in `REQUIRED_INPUTS` must have been positively checked and come back PASS. A
 * check that could not be run comes back UNKNOWN, and UNKNOWN caps confidence
 * at MEDIUM exactly as FAIL does -- it just does not spend a point, because
 * "we could not tell" and "we looked and it is bad" are different facts and the
 * reasons list has to keep them apart.
 *
 * Second: risk HIGH is no longer only money and law. Five classes, listed in
 * `RiskClass`, matching the Phase 0 policy surface.
 *
 * Third: the gate widened. It was LOW-confidence AND HIGH-risk. It is now
 * HIGH-risk with confidence that is not HIGH, plus a second rule for any
 * side-effecting action at LOW confidence. Two rules, two codes, so a test can
 * tell which one fired.
 */

import type Database from 'better-sqlite3'
import type { EnforcementVerdict, SideEffectClass } from './capability-contract.js'
import { PAYMENT_ACTION_TYPES, LEGAL_ACTION_TYPES } from './progression-eval.js'
import {
  reconstructLatestPacketWatermark, evaluateEvidenceFreshness,
} from './evidence-freshness.js'

export const DECISION_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const
export type DecisionLevel = (typeof DECISION_LEVELS)[number]

// ── Risk classes ────────────────────────────────────────────────────────

/**
 * What makes an action HIGH risk. The owner's list, 2026-08-27:
 *
 *   "HIGH risk ne csak financial/legal legyen. A Phase 0 policyval legyen
 *    konzisztens legalább: financial/contractual; credential/security;
 *    destructive action; access-control/permission change; más nehezen
 *    visszafordítható external side effect."
 *
 * Five classes rather than a boolean, because the refusal has to say WHICH kind
 * of exposure stopped it. "High risk" alone sends a reader back to the code.
 */
export type RiskClass =
  | 'FINANCIAL_CONTRACTUAL'
  | 'CREDENTIAL_SECURITY'
  | 'DESTRUCTIVE'
  | 'ACCESS_CONTROL'
  | 'IRREVERSIBLE_EXTERNAL'

/**
 * The action-type vocabularies that put an action in a class.
 *
 * ENUMERATED LISTS, NOT A REGEX OVER DESCRIPTIONS. The same decision
 * `PAYMENT_ACTION_TYPES` made and for the same reason: a blocklist of the words
 * seen so far is not a description of the class, and this codebase has already
 * shipped one of those and watched it let "Execute first recovery action"
 * through an hour later.
 *
 * FINANCIAL_CONTRACTUAL reuses the two lists §24 already owns rather than
 * spelling them a second time -- two spellings of one policy is how the ladder
 * and the assertions drifted apart before, and a test below asserts they are
 * still the same set.
 *
 * HONEST STATE, said once: today the executor only ever writes `EMAIL_SEND`, so
 * nothing in this table matches anything in production yet. The classes are
 * READY, not exercised -- which is the same posture §24's lists carry, and it is
 * a statement about the executor's vocabulary, not about this table being
 * decorative. The moment a destructive or access-control action type exists, it
 * is classified the day it is written, not the day someone remembers this file.
 */
export const RISK_CLASS_ACTION_TYPES: Record<RiskClass, readonly string[]> = {
  FINANCIAL_CONTRACTUAL: [...PAYMENT_ACTION_TYPES, ...LEGAL_ACTION_TYPES],
  CREDENTIAL_SECURITY: [
    'CREDENTIAL_ROTATE', 'CREDENTIAL_ISSUE', 'CREDENTIAL_REVOKE',
    'SECRET_WRITE', 'TOKEN_MINT',
  ],
  DESTRUCTIVE: [
    'DELETE', 'PURGE', 'DESTROY', 'DATA_ERASE', 'SUBSCRIPTION_CANCEL',
  ],
  ACCESS_CONTROL: [
    'GRANT_ACCESS', 'REVOKE_ACCESS', 'PERMISSION_CHANGE', 'ROLE_ASSIGN',
    'SHARE_BEYOND_APPROVED',
  ],
  // Not a list: this one is a property of the STEP KIND, and the side-effect
  // class already carries it. EXECUTE and COMMUNICATE reach outside, and a sent
  // message cannot be unsent.
  IRREVERSIBLE_EXTERNAL: [],
}

/** Data sensitivity classes that make an action CREDENTIAL_SECURITY risk
 *  whatever it is doing. W10's vocabulary, not a new one. */
export const CREDENTIAL_SENSITIVITY = ['SECRET', 'CREDENTIAL', 'AUTH_TOKEN'] as const

// ── Required-input completeness ─────────────────────────────────────────

/**
 * The inputs a decision needs before the engine is allowed to call itself sure.
 *
 * Each one is the owner's, mapped to the fact that settles it:
 *
 *   required fact/input missing        -> `required_evidence_declared`
 *   canonical state contradictory      -> `canonical_state_consistent`
 *   canonical state stale              -> `canonical_state_fresh`
 *   unresolved external outcome        -> `external_outcome_settled`
 *   conflicting evidence               -> `evidence_non_conflicting`
 *   required capability degraded/unknown -> `required_capabilities_known`
 *   required field value UNKNOWN       -> `no_unknown_required_field`
 *
 * A TOTAL LIST, checked by a test against the type, because the gap that would
 * matter here is a check that quietly stops being asked.
 */
export const REQUIRED_INPUTS = [
  'required_evidence_declared',
  'canonical_state_consistent',
  'canonical_state_fresh',
  'external_outcome_settled',
  'evidence_non_conflicting',
  'required_capabilities_known',
  'no_unknown_required_field',
] as const
export type RequiredInput = (typeof REQUIRED_INPUTS)[number]

/**
 * PASS is the only one that counts toward HIGH.
 *
 * UNKNOWN is deliberately NOT a synonym for FAIL even though both cap the same
 * way: a check that could not run and a check that ran and found a problem are
 * different states, and collapsing them is how "we never looked" becomes
 * indistinguishable from "we looked and it was fine" -- the exact defect this
 * closure exists to remove, in the other direction.
 */
export type FactStatus = 'PASS' | 'FAIL' | 'UNKNOWN'

export interface RequiredInputFact {
  input: RequiredInput
  status: FactStatus
  detail: string
}

/** What the engine knows about the decision it just made. Every field is a fact
 *  it already has -- nothing here requires a new source. */
export interface DecisionSignals {
  /** The side-effect class of the chosen action (capability-contract's). */
  sideEffect: SideEffectClass
  /** The capability verdict for it. DENY and WAIT are not merely blockers: they
   *  are evidence the engine does not have what the action needs. */
  capabilityVerdict: EnforcementVerdict
  /** Optional capabilities that were missing and proceeded without. */
  degradations: number
  /** Consecutive runs that moved nothing. A case the engine keeps failing to
   *  advance is a case it understands less well than it thinks. */
  noProgressRuns: number
  /** Times the case was interrupted / replanned. */
  interruptions: number
  /** Whether the case carries a real Definition of Done, verified per criterion.
   *  Deciding without one is deciding against an unstated target. */
  hasVerifiedDoD: boolean
  /** Money at stake, when the namespace records it (ZST does, personal does not). */
  financialExposure: number | null
  /** Legal exposure marker, same. */
  legalExposure: string | null
  /** Action types already staged on the outbound ledger for this case, so the
   *  risk class is read off what the case will actually DO, not off the step
   *  kind alone. */
  pendingActionTypes: readonly string[]
  /** The case's data sensitivity class (W10's vocabulary). */
  sensitivity: string | null
  /** The required-input proof set. An EMPTY list is not "all good" -- it is
   *  "nothing was proven", and confidence is capped accordingly. */
  requiredInputs: readonly RequiredInputFact[]
}

export interface DecisionAssessment {
  confidence: DecisionLevel
  risk: DecisionLevel
  riskClasses: RiskClass[]
  /** Why, in short machine-readable tokens. On the run, so a later reader can
   *  see which signal moved the number rather than re-deriving it. */
  reasons: string[]
}

/**
 * Risk. The side-effect class is the floor; each risk class lifts it to HIGH.
 *
 * A READ_ONLY step in no risk class is LOW -- and it has to be, or the gate
 * would refuse ordinary reading and the whole engine would stop.
 */
export function assessRisk(s: DecisionSignals): {
  risk: DecisionLevel; riskClasses: RiskClass[]; reasons: string[]
} {
  const reasons: string[] = []
  const classes = new Set<RiskClass>()
  let risk: DecisionLevel = 'LOW'

  if (s.sideEffect === 'MUTATING') { risk = 'MEDIUM'; reasons.push('side-effect:MUTATING') }
  if (s.sideEffect === 'HIGH_RISK') {
    risk = 'HIGH'; classes.add('IRREVERSIBLE_EXTERNAL'); reasons.push('side-effect:HIGH_RISK')
  }
  if (s.financialExposure !== null && s.financialExposure > 0) {
    risk = 'HIGH'; classes.add('FINANCIAL_CONTRACTUAL')
    reasons.push(`financial-exposure:${s.financialExposure}`)
  }
  if (s.legalExposure) {
    risk = 'HIGH'; classes.add('FINANCIAL_CONTRACTUAL'); reasons.push(`legal-exposure:${s.legalExposure}`)
  }
  if (s.sensitivity && (CREDENTIAL_SENSITIVITY as readonly string[]).includes(s.sensitivity)) {
    risk = 'HIGH'; classes.add('CREDENTIAL_SECURITY'); reasons.push(`sensitivity:${s.sensitivity}`)
  }
  for (const t of s.pendingActionTypes) {
    const cls = riskClassOfActionType(t)
    if (cls) { risk = 'HIGH'; classes.add(cls); reasons.push(`action:${t}=${cls}`) }
  }
  return { risk, riskClasses: [...classes], reasons }
}

/** Which class an outbound action type belongs to, or null when it is in none.
 *  Exported so the standing check can compare this vocabulary with the ladder's
 *  rather than two files hoping they agree. */
export function riskClassOfActionType(actionType: string): RiskClass | null {
  for (const cls of Object.keys(RISK_CLASS_ACTION_TYPES) as RiskClass[]) {
    if (RISK_CLASS_ACTION_TYPES[cls].includes(actionType)) return cls
  }
  return null
}

/**
 * Confidence. Two halves, and the second one is the closure.
 *
 * HALF ONE, the doubt ladder: named doubts spend points, exactly as before.
 * HALF TWO, the proof set: HIGH is reachable ONLY if every required input came
 * back PASS. A FAIL also spends a point, so several failures reach LOW; an
 * UNKNOWN spends nothing and only caps, because it is not a finding.
 */
export function assessConfidence(s: DecisionSignals): {
  confidence: DecisionLevel; reasons: string[]
} {
  const reasons: string[] = []
  let score = 2   // 2 = HIGH, 1 = MEDIUM, 0 = LOW

  // The engine does not have what the action needs. Not a doubt -- a fact.
  if (s.capabilityVerdict === 'DENY_UNDECLARED') { score -= 2; reasons.push('capability:UNDECLARED') }
  else if (s.capabilityVerdict === 'WAIT_CAPABILITY') { score -= 2; reasons.push('capability:MISSING') }
  else if (s.capabilityVerdict === 'CONTRACT_GAP') { score -= 1; reasons.push('capability:CONTRACT_GAP') }

  if (s.degradations > 0) { score -= 1; reasons.push(`degraded:${s.degradations}`) }
  // Three is the point at which "it did not move" stops being noise. The same
  // number the recovery queue escalates at, deliberately: two thresholds that
  // mean "this is not working any more" should not disagree.
  if (s.noProgressRuns >= 3) { score -= 1; reasons.push(`no-progress:${s.noProgressRuns}`) }
  if (s.interruptions >= 3) { score -= 1; reasons.push(`interruptions:${s.interruptions}`) }
  if (!s.hasVerifiedDoD) { score -= 1; reasons.push('dod:unverified') }

  // ── The proof set. Absence of a doubt flag is not evidence. ──
  const byInput = new Map(s.requiredInputs.map(f => [f.input, f]))
  let proven = true
  for (const input of REQUIRED_INPUTS) {
    const fact = byInput.get(input)
    if (!fact || fact.status === 'UNKNOWN') {
      proven = false
      reasons.push(`unproven:${input}${fact ? '' : ':not-checked'}`)
    } else if (fact.status === 'FAIL') {
      proven = false
      score -= 1
      reasons.push(`failed:${input}`)
    }
  }
  if (!proven) score = Math.min(score, 1)

  const confidence: DecisionLevel = score >= 2 ? 'HIGH' : score >= 1 ? 'MEDIUM' : 'LOW'
  return { confidence, reasons }
}

export function assessDecision(s: DecisionSignals): DecisionAssessment {
  const r = assessRisk(s)
  const c = assessConfidence(s)
  return {
    confidence: c.confidence, risk: r.risk, riskClasses: r.riskClasses,
    reasons: [...r.reasons, ...c.reasons],
  }
}

// ── Invariant E ─────────────────────────────────────────────────────────

export type InvariantECode =
  | 'ok'
  /** HIGH risk, and confidence that is not HIGH. The owner's widened rule. */
  | 'invariant_e_high_risk_unproven_confidence'
  /** LOW confidence and an action that changes something. */
  | 'invariant_e_low_confidence_side_effect'

export interface InvariantEResult {
  allowed: boolean
  /** Machine-readable and UNIQUE to this gate. The acceptance criterion requires
   *  a test to tell an Invariant E refusal apart from an approval-bind refusal
   *  and from a ladder refusal; a shared code would make all three read the same
   *  in the log, which is the one thing that must not happen. TWO refusal codes,
   *  not one, so a test can also tell the two rules apart. */
  code: InvariantECode
  reason: string
  /**
   * The read-only carve-out, made explicit rather than left as a silence.
   *
   *   "read-only low-confidence reasoning folytatódhat, ha más gate nem tiltja,
   *    de ne váljon bizonyítatlan completionné vagy external factual
   *    assertionné."
   *
   * True means: this run may keep thinking, and may NOT convert that thinking
   * into a completion or into a claim about the outside world.
   */
  assertionRestricted: boolean
}

/**
 * The gate.
 *
 * IT CAN ONLY REFUSE. There is no branch that returns `allowed: true` for
 * something another gate refused -- the ladder, the approval bind and the send
 * ceilings all run regardless of what this returns, and HIGH confidence is never
 * a permission. A gate that could turn a ladder refusal into a pass would be a
 * hole wearing a gate's name.
 *
 * NOT APPLIED TO A COMPLETION. Invariant E governs EXECUTING an action; a
 * completion is not an outward act, and the gate that owns it is the DoD
 * completion gate, which requires evidence per criterion. Letting E overwrite a
 * COMPLETE would produce a run record whose decision contradicts the case row it
 * just transitioned -- and would not make completion any safer, because an
 * unproven completion is already refused upstream. The caller is what enforces
 * this; the test named `a completion is governed by the DoD gate` is what keeps
 * it honest.
 */
export function invariantE(a: {
  confidence: DecisionLevel
  risk: DecisionLevel
  sideEffect: SideEffectClass
}): InvariantEResult {
  if (a.risk === 'HIGH' && a.confidence !== 'HIGH') {
    return {
      allowed: false,
      code: 'invariant_e_high_risk_unproven_confidence',
      reason: `Invariáns E: magas kockázatú (${a.risk}) művelet nem hajtható végre `
        + `automatikusan bizonyítottan magas bizalom nélkül (${a.confidence})`,
      assertionRestricted: true,
    }
  }
  if (a.confidence === 'LOW' && a.sideEffect !== 'READ_ONLY') {
    return {
      allowed: false,
      code: 'invariant_e_low_confidence_side_effect',
      reason: `Invariáns E: alacsony bizalmú (${a.confidence}) ${a.sideEffect} `
        + 'művelet nem hajtható végre automatikusan',
      assertionRestricted: true,
    }
  }
  return {
    allowed: true, code: 'ok', reason: '',
    // Allowed, and still restricted: a LOW-confidence READ_ONLY step may reason
    // on. It may not turn that reasoning into a completion or an assertion.
    assertionRestricted: a.confidence === 'LOW',
  }
}

// ── Gathering the proof set from the live store ─────────────────────────

/**
 * Ask each required input its question against the real tables.
 *
 * EVERY CHECK IS GUARDED, AND A GUARD RETURNS UNKNOWN. A store that predates a
 * column, a table that does not exist in this namespace, a malformed JSON -- all
 * of those are "could not tell", and could-not-tell caps confidence. The
 * tempting shape is `catch { return PASS }`, which reads as robustness and is
 * the permissive answer to a question nobody managed to ask.
 */
export function gatherRequiredInputs(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  cap: { verdict: EnforcementVerdict; degradations: number },
  now: number,
): RequiredInputFact[] {
  const caseTable = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const ledgerTable = domain === 'personal' ? 'outbound_ledger' : 'zst_outbound_ledger'
  const facts: RequiredInputFact[] = []
  const add = (input: RequiredInput, status: FactStatus, detail: string): void => {
    facts.push({ input, status, detail })
  }

  // 1. Does the case state what would prove its outcome? Deciding without a
  //    success-evidence requirement is deciding against an unstated target.
  try {
    const r = db.prepare(
      `SELECT success_evidence_requirements_json AS req, dod_verification_json AS dod
         FROM case_progression_state WHERE domain = ? AND case_id = ?`,
    ).get(domain, caseId) as { req?: string | null; dod?: string | null } | undefined
    if (!r) add('required_evidence_declared', 'UNKNOWN', 'nincs haladás-állapot sor')
    else if (!r.req && !r.dod) add('required_evidence_declared', 'FAIL', 'nincs kimondott siker-bizonyíték')
    else add('required_evidence_declared', 'PASS', r.req ? 'követelmény deklarálva' : 'DoD rögzítve')
  } catch (e) {
    add('required_evidence_declared', 'UNKNOWN', String((e as Error)?.message ?? e))
  }

  // 2. CONTRADICTORY: does the board's view of this case contradict the engine's?
  //    P1 records that as a named conflict rather than as a silent overwrite,
  //    which is the only reason this is answerable at all.
  try {
    const r = db.prepare(
      `SELECT projection_conflict_reason AS conflict FROM ${caseTable} WHERE case_id = ?`,
    ).get(caseId) as { conflict?: string | null } | undefined
    if (!r) add('canonical_state_consistent', 'UNKNOWN', 'nincs ügy-sor')
    else if (r.conflict) add('canonical_state_consistent', 'FAIL', `projekció-konfliktus: ${r.conflict}`)
    else add('canonical_state_consistent', 'PASS', 'nincs projekció-konfliktus')
  } catch (e) {
    add('canonical_state_consistent', 'UNKNOWN', String((e as Error)?.message ?? e))
  }

  // 3. STALE: does the evidence this decision rests on still cover the case as
  //    it is now?
  //
  //    NOT A TIMESTAMP COMPARISON, and the first version was one -- it asked
  //    whether `last_reconciled_at` was older than the case row's `updated_at`.
  //    That question is unanswerable mid-run by construction: the run bumps
  //    `updated_at` at its own upsert and projects at its own end, so every run
  //    that changed anything would have called its own inputs stale. It would
  //    have measured "did this run do something", not "is what we know current".
  //
  //    The real instrument already exists: the watermark on the latest evidence
  //    packet, compared with the case's current version and event stream. NO
  //    PACKET AT ALL IS UNKNOWN, NOT PASS -- a case nobody has read is exactly
  //    the state this closure exists to stop scoring as certainty.
  try {
    const wm = reconstructLatestPacketWatermark(db, domain, caseId, now)
    if (!wm.ok || !wm.watermark) add('canonical_state_fresh', 'UNKNOWN', wm.reason)
    else {
      const f = evaluateEvidenceFreshness(db, wm.watermark)
      if (f.fresh) add('canonical_state_fresh', 'PASS', f.reasons.join('; '))
      else add('canonical_state_fresh', 'FAIL', f.reasons.join('; '))
    }
  } catch (e) {
    add('canonical_state_fresh', 'UNKNOWN', String((e as Error)?.message ?? e))
  }

  // 4. Is there an outward action whose outcome nobody knows? §8.7's three
  //    unsettled statuses. Deciding the next step while a previous send may or
  //    may not have gone out is deciding on a fork in the world.
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS n FROM ${ledgerTable}
        WHERE case_id = ? AND status IN ('APPLIED_UNVERIFIED','OUTCOME_UNKNOWN','RECOVERY_REQUIRED')`,
    ).get(caseId) as { n: number } | undefined
    if (!r) add('external_outcome_settled', 'UNKNOWN', 'a főkönyv nem kérdezhető')
    else if (r.n > 0) add('external_outcome_settled', 'FAIL', `${r.n} lezáratlan kimenő művelet`)
    else add('external_outcome_settled', 'PASS', 'nincs lezáratlan kimenő művelet')
  } catch (e) {
    add('external_outcome_settled', 'UNKNOWN', String((e as Error)?.message ?? e))
  }

  // 5. Did the two readings of this case disagree? The evidence packet records
  //    it when the reader and the deterministic policy reached different
  //    decisions -- which is the literal shape of contradictory evidence.
  //    THE LATEST packet only: an old disagreement that a later run settled is
  //    history, and history that never expires would cap every case for ever.
  try {
    const r = db.prepare(
      `SELECT conflict_reason AS c FROM case_evidence_packets
        WHERE domain = ? AND case_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(domain, caseId) as { c?: string | null } | undefined
    if (!r) add('evidence_non_conflicting', 'PASS', 'nincs bizonyíték-csomag ehhez az ügyhöz')
    else if (r.c) add('evidence_non_conflicting', 'FAIL', `ellentmondó olvasat: ${r.c}`)
    else add('evidence_non_conflicting', 'PASS', 'az utolsó csomag konfliktusmentes')
  } catch (e) {
    add('evidence_non_conflicting', 'UNKNOWN', String((e as Error)?.message ?? e))
  }

  // 6. The capability verdict, already computed by this run.
  if (cap.verdict === 'PROCEED' && cap.degradations === 0) {
    add('required_capabilities_known', 'PASS', 'minden szükséges képesség megvan')
  } else {
    add('required_capabilities_known', 'FAIL',
      `verdict=${cap.verdict}, degradált=${cap.degradations}`)
  }

  // 7. Does any field the decision reads carry a literal UNKNOWN? The §7.4
  //    dictionary's UNKNOWN is not a value the engine may act on as if it were
  //    one -- §3.7: "az UNKNOWN NEM pass".
  try {
    const r = db.prepare(
      `SELECT semantic_completion_status AS sem, last_effective_state AS eff,
              blocked_reason AS blk, waiting_on AS wait
         FROM case_progression_state WHERE domain = ? AND case_id = ?`,
    ).get(domain, caseId) as Record<string, string | null> | undefined
    if (!r) add('no_unknown_required_field', 'UNKNOWN', 'nincs haladás-állapot sor')
    else {
      const unknowns = Object.entries(r)
        .filter(([, v]) => typeof v === 'string' && v.trim().toUpperCase() === 'UNKNOWN')
        .map(([k]) => k)
      if (unknowns.length) add('no_unknown_required_field', 'FAIL', `UNKNOWN mező: ${unknowns.join(', ')}`)
      else add('no_unknown_required_field', 'PASS', 'egy döntési mező sem UNKNOWN')
    }
  } catch (e) {
    add('no_unknown_required_field', 'UNKNOWN', String((e as Error)?.message ?? e))
  }

  return facts
}
