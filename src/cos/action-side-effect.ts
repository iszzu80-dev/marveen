// WHAT AN ACTION ACTUALLY DOES TO THE WORLD, as a classification with sources
// rather than a lookup on the plan-step kind.
//
// WHAT THIS REPLACES, and why it had to go. `capability-contract.ts` shipped a
// total map from plan-step kind to side-effect class, and two of its rows said:
//
//     EXECUTE:     'HIGH_RISK',
//     COMMUNICATE: 'HIGH_RISK',
//
// with the reasoning "they are the two that can reach outside". CAN is not DOES,
// and the difference reached the owner. On 2026-08-28 the ZST case for the
// NVIDIA Inception application produced a live approval request for plan step 3,
// whose label is "Identify required actions and dependencies" and whose own plan
// row says `needsExternal: false`. The step declares that it touches nothing
// outside; the classifier called it IRREVERSIBLE_EXTERNAL anyway, because of its
// kind; Invariant E refused it as high risk; and the producer asked Istvan to
// approve an irreversible external act that does not exist.
//
// Three separate harms, worth naming separately because only the first one is
// obvious:
//
//   1. He is asked to approve something that will not happen.
//   2. The approval question cannot be made honest by rewriting it. One of its
//      five required elements is WHAT CHANGES OUT IN THE WORLD, and for this
//      step the true answer is "nothing" -- a sentence that turns the whole ask
//      into theatre.
//   3. Approval becomes the way a wrong internal classification gets overridden
//      by a person. That is the worst of the three: it converts a model defect
//      into a human rubber stamp, and afterwards the record says the owner
//      approved an irreversible external action.
//
// THE OWNER'S ARCHITECTURAL DECISION (2026-08-28), implemented here:
//
//   "Az EXECUTE önmagában nem side-effect class. Az EXECUTE progression
//    semantics: hajtsd végre a terv következő műveletét. A side-effect/risk
//    classification ettől külön dimenzió."
//
// So there are two axes, not one. MUTATION is a property of the step kind and
// stays where it was. EXTERNALITY is derived, per action, from five declared
// sources, and the kind is not one of them.
//
// FAIL-CLOSED IN BOTH DIRECTIONS, which is the part that is easy to get wrong.
// A gap and a conflict are different states and neither may become "proceed":
//
//   CONTRADICTORY  the sources disagree -- the step says it stays inside and
//                  something else says it reaches out. No execution, NO
//                  APPROVAL, and the contradiction is recorded. The owner's
//                  rule: "Az approval nem való arra, hogy egy belső
//                  modell-kontradikciót emberrel felülírassunk."
//   UNKNOWN        a source could not be read, or the act reaches outside and
//                  mutates and nothing names the operation. We know it goes out
//                  and we do not know how far. Also no execution and no
//                  approval: resolve the classification first.
//
// NOTHING HERE IS AN AUTHORITY. This module returns a verdict and its reasons.
// It does not write, does not gate, and cannot authorise. The pipeline decides
// what to do with the verdict, and the two `executable: false` classes are
// refusals it must honour rather than facts it may weigh.

import type { SideEffectClass } from './capability-contract.js'
import {
  RISK_CLASS_ACTION_TYPES, CREDENTIAL_SENSITIVITY, type RiskClass,
} from './decision-confidence.js'

/**
 * The externality of one concrete action.
 *
 * INTERNAL is not the same as READ_ONLY. A step that rewrites local case state
 * and reaches nobody is INTERNAL and MUTATING, and collapsing those two would
 * reintroduce the defect from the other side: local writes would stop being
 * governed because "internal" got read as "harmless".
 */
export type ActionSideEffectClass =
  /** Changes nothing outside this system. May still change state in it. */
  | 'INTERNAL'
  /** Reaches an outside system and only reads from it. */
  | 'READ_ONLY_EXTERNAL'
  /** Changes something outside that can be put back. */
  | 'REVERSIBLE_EXTERNAL'
  /** Changes something outside that cannot be put back. A sent message. */
  | 'IRREVERSIBLE_EXTERNAL'
  /** The sources disagree about whether this reaches outside at all. */
  | 'CONTRADICTORY'
  /** A source could not be read, or the reach is known and its extent is not. */
  | 'UNKNOWN'

/**
 * Does this kind of step change state at all.
 *
 * THE SURVIVING HALF of the old table. Mutation genuinely is a property of the
 * kind: a VERIFY step reads and an EXECUTE step writes, whatever either of them
 * is pointed at. What was wrong was inferring EXTERNALITY from the same column.
 *
 * Total rather than defaulted, for the reason the old one gave and was right
 * about: a default makes a newly added kind silently the permissive answer.
 */
export const MUTATES_BY_KIND: Record<
  'GATHER_INFO' | 'AWAIT_EXTERNAL' | 'AWAIT_DECISION' | 'EXECUTE' | 'VERIFY' | 'COMMUNICATE' | 'RECOVER',
  boolean
> = {
  GATHER_INFO: false,
  AWAIT_EXTERNAL: false,
  AWAIT_DECISION: false,
  VERIFY: false,
  RECOVER: true,
  EXECUTE: true,
  COMMUNICATE: true,
}

/**
 * Concrete operation types whose effect on the outside world cannot be undone.
 *
 * ENUMERATED, NOT INFERRED, and the list is deliberately about OPERATIONS, not
 * about plan-step kinds. This is the list that used to be empty:
 *
 *     // Not a list: this one is a property of the STEP KIND, and the
 *     // side-effect class already carries it.
 *     IRREVERSIBLE_EXTERNAL: [],
 *
 * That comment is the defect, written down. `RISK_CLASS_ACTION_TYPES` keeps its
 * four populated rows and this file supplies the fifth, because the fifth is an
 * operation vocabulary like the others and never was a property of a kind.
 *
 * EMAIL_SEND is the only member the executor writes today. That is a statement
 * about the executor's vocabulary, not about this list being decorative: the
 * others are classified the day someone writes them, not the day someone
 * remembers this file.
 */
export const IRREVERSIBLE_OPERATION_TYPES: readonly string[] = [
  'EMAIL_SEND', 'EMAIL_REPLY', 'EMAIL_FORWARD',
  'SMS_SEND', 'MESSAGE_SEND', 'CALL_PLACE',
  'FILING_SUBMIT', 'FORM_SUBMIT', 'BOOKING_CONFIRM',
]

/** Operations that reach an outside system and only read from it. */
export const READ_ONLY_OPERATION_TYPES: readonly string[] = [
  'EMAIL_READ', 'CALENDAR_READ', 'DRIVE_READ', 'PROVIDER_FETCH', 'STATUS_POLL',
]

/** Operations that change something outside and can be put back. */
export const REVERSIBLE_OPERATION_TYPES: readonly string[] = [
  'DRAFT_CREATE', 'DRAFT_UPDATE', 'CALENDAR_EVENT_CREATE', 'CALENDAR_EVENT_UPDATE',
  'LABEL_APPLY', 'TASK_CREATE',
]

/** Every operation type this module can place. Used by the test that asserts a
 *  type is not in two vocabularies at once. */
export function classifiedOperationTypes(): string[] {
  return [
    ...IRREVERSIBLE_OPERATION_TYPES,
    ...READ_ONLY_OPERATION_TYPES,
    ...REVERSIBLE_OPERATION_TYPES,
  ]
}

/** The five sources, named as the owner named them. Every field is EVIDENCE
 *  gathered by the caller, never a guess made here. */
export interface ActionSideEffectSignals {
  /** 1. The step's own declared externality. `null` means the plan did not say,
   *     which is a gap and not a denial. */
  declaredExternal: boolean | null
  /** 2. A resolved outbound target, channel or tool bound to this action. */
  resolvedExternalTarget: string | null
  /** 3. External ledger or dispatch intents that exist or are planned for this
   *     CASE: the concrete operation types on unfinished outbound rows.
   *
   *     CONTEXT ONLY. RECORDED, NEVER DETERMINATIVE, and this is the field the
   *     owner named that turned out not to be usable as a determinant.
   *
   *     The outbound ledger records a case id and no plan step. So a queued
   *     EMAIL_SEND cannot be attributed to the step being classified, in either
   *     direction. It may not prove that an internal step reaches outside --
   *     that would raise a contradiction on every local step of every case with
   *     mail waiting. And it may not grade how far an already-external step
   *     reaches either, which is the subtler half and the one that bit first: a
   *     probe on 2026-08-28 showed an AWAIT_DECISION step, whose whole job is to
   *     check whether an answer arrived, classified IRREVERSIBLE_EXTERNAL
   *     because the CASE had a send queued behind it. Same category error as
   *     the one being fixed, one attribute over.
   *
   *     The step-scoped operation type is `operationType`, and that is what
   *     grades severity. This field appears in `reasons` so a reader can see the
   *     case has outward work pending, and it changes no verdict. */
  dispatchIntents: readonly string[]
  /** 4. The concrete operation type of THIS action, when one is named. The plan
   *     step kind is NOT an operation type and must not be passed here. */
  operationType: string | null
  /** 5. The policy taxonomy: financial, legal, security. */
  financialExposure: number | null
  legalExposure: string | null
  sensitivity: string | null
  /** Sources the caller tried to read and could not. Any entry forces UNKNOWN:
   *  a classification made with a source missing is a guess wearing a verdict. */
  unreadableSources: readonly string[]
  /** Whether the step changes state at all. From `MUTATES_BY_KIND`. */
  mutates: boolean
}

export interface ActionSideEffectVerdict {
  klass: ActionSideEffectClass
  /** Why, one short clause per contributing source. */
  reasons: string[]
  /** Populated only for CONTRADICTORY: which two sources disagree, and how. */
  conflicts: string[]
  /** The class the pre-existing gates understand. Derived, never chosen. */
  legacy: SideEffectClass
  /** May this action run, or be put in front of the owner for approval? False
   *  for CONTRADICTORY and UNKNOWN, and those are refusals, not weights. */
  executable: boolean
  /** True only for the three classes that genuinely reach outside. An approval
   *  request may be produced only when this is true. */
  reachesOutside: boolean
}

function opClass(t: string): 'IRREVERSIBLE' | 'READ_ONLY' | 'REVERSIBLE' | null {
  if (IRREVERSIBLE_OPERATION_TYPES.includes(t)) return 'IRREVERSIBLE'
  if (READ_ONLY_OPERATION_TYPES.includes(t)) return 'READ_ONLY'
  if (REVERSIBLE_OPERATION_TYPES.includes(t)) return 'REVERSIBLE'
  return null
}

/** Policy taxonomy classes an action carries whatever it is pointed at. Reuses
 *  the vocabularies §24 owns rather than spelling them again. */
function policyClasses(s: ActionSideEffectSignals): RiskClass[] {
  const out = new Set<RiskClass>()
  if (s.financialExposure !== null && s.financialExposure > 0) out.add('FINANCIAL_CONTRACTUAL')
  if (s.legalExposure) out.add('FINANCIAL_CONTRACTUAL')
  if (s.sensitivity && (CREDENTIAL_SENSITIVITY as readonly string[]).includes(s.sensitivity)) {
    out.add('CREDENTIAL_SECURITY')
  }
  // The STEP'S operation only. A queued operation belonging to another step of
  // the same case cannot classify this one.
  for (const t of [s.operationType].filter((t): t is string => !!t)) {
    for (const cls of Object.keys(RISK_CLASS_ACTION_TYPES) as RiskClass[]) {
      if (RISK_CLASS_ACTION_TYPES[cls].includes(t)) out.add(cls)
    }
  }
  return [...out]
}

/**
 * The classification.
 *
 * ORDER MATTERS AND IS THE POLICY. Unreadable sources first, because a verdict
 * built on a source that did not answer is not a verdict. Contradiction second,
 * because a conflict outranks every reading of the individual signals. Only then
 * the ordinary derivation.
 */
export function classifyActionSideEffect(s: ActionSideEffectSignals): ActionSideEffectVerdict {
  const reasons: string[] = []

  if (s.unreadableSources.length > 0) {
    return {
      klass: 'UNKNOWN', conflicts: [],
      reasons: [`nem olvasható forrás: ${s.unreadableSources.join(', ')}`],
      legacy: 'HIGH_RISK', executable: false, reachesOutside: false,
    }
  }

  // Is the operation type itself an outward one? Asked of the TYPE alone: the
  // case's financial or legal exposure says how far an outward act reaches, and
  // says nothing about whether this step is outward at all. Mixing the two would
  // make every step of a case with money attached look externally evidenced.
  const namedOpIsExternal = (t: string): boolean =>
    opClass(t) !== null
    || (Object.keys(RISK_CLASS_ACTION_TYPES) as RiskClass[])
      .some(cls => RISK_CLASS_ACTION_TYPES[cls].includes(t))

  const evidence = {
    declared: s.declaredExternal === true,
    target: s.resolvedExternalTarget !== null,
    operation: s.operationType !== null && namedOpIsExternal(s.operationType),
  }
  // ONLY STEP-SCOPED EVIDENCE DECIDES ANYTHING. See the note on
  // `dispatchIntents` for the source that was dropped from the derivation and
  // why keeping it would have reproduced the defect one attribute over.
  const stepScopedExternal = evidence.target || evidence.operation
  const anyExternalEvidence = stepScopedExternal

  // ── CONTRADICTION. The step says it stays inside; something bound to the same
  //    step says it does not. This is the class the owner named, and it must
  //    never become an approval question.
  if (s.declaredExternal === false && stepScopedExternal) {
    const conflicts: string[] = []
    if (evidence.target) conflicts.push(`needsExternal=false, de van feloldott külső célpont: ${s.resolvedExternalTarget}`)
    if (evidence.operation) conflicts.push(`needsExternal=false, de a művelet-típus külső: ${s.operationType}`)
    return {
      klass: 'CONTRADICTORY', conflicts,
      reasons: ['a lépés saját deklarációja és a hozzá kötött külső jelek ellentmondanak'],
      legacy: 'HIGH_RISK', executable: false, reachesOutside: false,
    }
  }

  // ── NO EXTERNAL REACH AT ALL. Internal, and the mutation axis decides what the
  //    old gates are told.
  //
  // A step that declares `needsExternal: false` is INTERNAL even when the case
  // has queued outbound work, for the reason above: that work is not this step.
  if (s.declaredExternal === false || (!evidence.declared && !anyExternalEvidence)) {
    reasons.push(s.declaredExternal === false
      ? 'a lépés deklaráltan nem igényel külső bemenetet'
      : 'a lépés nem deklarált külső igényt, és semmilyen külső jel nem tartozik hozzá')
    if (s.mutates) reasons.push('állapotot módosít, de csak a rendszeren belül')
    return {
      klass: 'INTERNAL', conflicts: [], reasons,
      legacy: s.mutates ? 'MUTATING' : 'READ_ONLY',
      executable: true, reachesOutside: false,
    }
  }

  // ── IT REACHES OUTSIDE. How far is the remaining question.
  if (evidence.declared) reasons.push('a lépés deklaráltan külső bemenetet igényel')
  if (evidence.target) reasons.push(`feloldott külső célpont: ${s.resolvedExternalTarget}`)
  // Context, and labelled as context. It grades nothing.
  if (s.dispatchIntents.length) {
    reasons.push(`az ügyön kimenő munka is várakozik (nem ehhez a lépéshez kötve): ${s.dispatchIntents.join(', ')}`)
  }

  const policy = policyClasses(s)
  const named = [s.operationType].filter((t): t is string => !!t)
  const classes = named.map(opClass).filter((c): c is NonNullable<ReturnType<typeof opClass>> => c !== null)

  if (policy.length > 0 || classes.includes('IRREVERSIBLE')) {
    reasons.push(policy.length ? `policy-osztály: ${policy.join(', ')}` : 'visszafordíthatatlan művelet-típus')
    return {
      klass: 'IRREVERSIBLE_EXTERNAL', conflicts: [], reasons,
      legacy: 'HIGH_RISK', executable: true, reachesOutside: true,
    }
  }

  if (!s.mutates) {
    reasons.push('kifelé nyúl, de nem módosít')
    return {
      klass: 'READ_ONLY_EXTERNAL', conflicts: [], reasons,
      legacy: 'MUTATING', executable: true, reachesOutside: true,
    }
  }

  if (classes.includes('REVERSIBLE')) {
    reasons.push('visszafordítható külső művelet-típus')
    return {
      klass: 'REVERSIBLE_EXTERNAL', conflicts: [], reasons,
      legacy: 'MUTATING', executable: true, reachesOutside: true,
    }
  }
  if (classes.includes('READ_ONLY')) {
    reasons.push('olvasó külső művelet-típus')
    return {
      klass: 'READ_ONLY_EXTERNAL', conflicts: [], reasons,
      legacy: 'MUTATING', executable: true, reachesOutside: true,
    }
  }

  // ── REACHES OUT, MUTATES, AND NOTHING NAMES THE OPERATION.
  //
  // The tempting answer is REVERSIBLE_EXTERNAL, because most things are. That is
  // a guess, and the guess is in the permissive direction. We know two facts
  // (it goes out, it changes something) and not the third, so the verdict is the
  // gap itself. The owner's rule 4: resolve the classification, do not execute
  // it and do not legalise it with an approval.
  reasons.push('kifelé nyúl és módosít, de egyetlen forrás sem nevezi meg a konkrét műveletet')
  return {
    klass: 'UNKNOWN', conflicts: [], reasons,
    legacy: 'HIGH_RISK', executable: false, reachesOutside: false,
  }
}
