/**
 * §19 hardening — the capability dependency CONTRACT.
 *
 * Owner's decision, 2026-08-27:
 *
 *   "A capability preflight aktiválása jóváhagyott, de nem globális implicit
 *    módban. […] A capability requirement ne runtime-heurisztikából vagy
 *    connector-jelenlétből legyen kitalálva. A plan/next-action létrehozásakor
 *    legyen deklarálva és auditálható. […] Ne egyetlen globális
 *    requiredCapabilities listát adj minden case-hez. A dependency az adott next
 *    action / planned execution tulajdonsága legyen."
 *
 * WHY THE HEURISTIC IS THE WRONG ANSWER, stated once so the rest of the file can
 * be short about it. Deriving "this needs Gmail" from "a Gmail connector is
 * registered" means the requirement changes when the DEPLOYMENT changes. Remove
 * the connector and the requirement disappears with it, so the action that
 * depended on it becomes an action that depends on nothing — and proceeds. The
 * dependency has to be a statement made when the work is PLANNED, by the code
 * that knows what the work is, and it has to survive the disappearance of the
 * thing it names. That is the whole difference between a declaration and an
 * inference.
 *
 * THE FOUR FIELDS ARE THE OWNER'S, and each answers a question that was
 * previously answered by silence:
 *
 *   requiredCapabilities   without these the action cannot produce its result
 *   optionalCapabilities   without these it produces a lesser result
 *   failurePolicy          what to do when a required one is missing
 *   source + reason        who said so, and why — the audit leg
 *
 * `source` matters more than it looks. UNDECLARED is not the same as "requires
 * nothing": one is a statement, the other is a gap, and collapsing them is how
 * a forgotten declaration becomes indistinguishable from a deliberate "this
 * needs nothing". Every enforcement decision below branches on it.
 */

import type Database from 'better-sqlite3'
import { preflight, type CapabilityPreflight } from './capability-preflight.js'

/** What a plan step can do to the world. Drives the fail-closed rule for
 *  undeclared dependencies: the owner's line is high-risk/mutating vs read-only
 *  low-risk enrichment, so the classification has to exist as data. */
export type SideEffectClass = 'READ_ONLY' | 'MUTATING' | 'HIGH_RISK'

export type FailurePolicy =
  /** A missing required capability parks the action. The default, and the only
   *  legal policy for anything that is not READ_ONLY. */
  | 'FAIL_CLOSED'
  /** The action may run without the capability, and the degradation is recorded.
   *  Legal only for READ_ONLY work whose goal survives the loss. */
  | 'DEGRADE_AUDITED'

export type CapabilitySource =
  /** The planner stated it. */
  | 'DECLARED'
  /** Taken from the case's kind rather than the step's own knowledge. Weaker
   *  than DECLARED and reported separately so coverage does not flatter itself. */
  | 'INHERITED'
  /** Nobody stated anything. NOT the same as "requires nothing". */
  | 'UNDECLARED'

export interface CapabilityContract {
  requiredCapabilities: readonly string[]
  optionalCapabilities: readonly string[]
  failurePolicy: FailurePolicy
  source: CapabilitySource
  /** One line, for the ledger. Why these capabilities and not others. */
  reason: string
}

/**
 * The side-effect class of each plan-step kind.
 *
 * A total record rather than a lookup with a default: a default would make a
 * newly added kind silently READ_ONLY, which is the permissive answer, and the
 * permissive answer is the one that must never be reached by forgetting. The
 * type checker fails the build instead.
 *
 * EXECUTE and COMMUNICATE are HIGH_RISK because they are the two that can reach
 * outside — a sent message cannot be unsent, and §6.5's RECOVERY_REQUIRED state
 * exists precisely because "did it go out?" is sometimes unanswerable. RECOVER
 * is MUTATING rather than HIGH_RISK: it writes local repair state and does not
 * itself deliver.
 */
export const SIDE_EFFECT_CLASS: Record<
  'GATHER_INFO' | 'AWAIT_EXTERNAL' | 'AWAIT_DECISION' | 'EXECUTE' | 'VERIFY' | 'COMMUNICATE' | 'RECOVER',
  SideEffectClass
> = {
  GATHER_INFO: 'READ_ONLY',
  AWAIT_EXTERNAL: 'READ_ONLY',
  AWAIT_DECISION: 'READ_ONLY',
  VERIFY: 'READ_ONLY',
  RECOVER: 'MUTATING',
  EXECUTE: 'HIGH_RISK',
  COMMUNICATE: 'HIGH_RISK',
}

export type PlanStepKind = keyof typeof SIDE_EFFECT_CLASS

/** The contract for an action nobody declared one for. */
export function undeclaredContract(): CapabilityContract {
  return {
    requiredCapabilities: [], optionalCapabilities: [],
    failurePolicy: 'FAIL_CLOSED', source: 'UNDECLARED',
    reason: 'nincs deklarált capability-függőség ehhez a lépéshez',
  }
}

/**
 * What a plan step of this kind depends on, declared at plan-build time.
 *
 * Deliberately NOT a probe of what exists. It is a statement of what the work
 * needs, made by the code that knows what the work is. If the named capability
 * is absent from the deployment, the enforcement below reports a missing
 * dependency — it does not conclude the dependency was imaginary.
 */
export function declareForPlanStep(kind: PlanStepKind): CapabilityContract {
  switch (kind) {
    case 'VERIFY':
      return {
        requiredCapabilities: ['RUN_LEDGER'],
        optionalCapabilities: ['EVIDENCE_PACKETS'],
        failurePolicy: 'FAIL_CLOSED', source: 'DECLARED',
        reason: 'a futás-főkönyv nélkül az ellenőrzés nem rögzíthető; a bizonyíték-csomagok gazdagítanak, de nem feltételek',
      }
    case 'GATHER_INFO':
      return {
        requiredCapabilities: [],
        optionalCapabilities: ['EVIDENCE_PACKETS', 'DOCUMENT_STORE'],
        failurePolicy: 'DEGRADE_AUDITED', source: 'DECLARED',
        reason: 'olvasó gyűjtés: kevesebb forrással kevesebbet tud, de a cél elérhető marad',
      }
    case 'AWAIT_EXTERNAL':
    case 'AWAIT_DECISION':
      return {
        requiredCapabilities: [],
        optionalCapabilities: [],
        failurePolicy: 'DEGRADE_AUDITED', source: 'DECLARED',
        reason: 'a várakozás nem igényel képességet — a világra vár, nem a gépre',
      }
    case 'RECOVER':
      return {
        requiredCapabilities: ['RUN_LEDGER'],
        optionalCapabilities: [],
        failurePolicy: 'FAIL_CLOSED', source: 'DECLARED',
        reason: 'a helyreállítás állapotot ír; főkönyv nélkül nem visszakövethető',
      }
    case 'EXECUTE':
    case 'COMMUNICATE':
      return {
        requiredCapabilities: ['RUN_LEDGER'],
        optionalCapabilities: [],
        failurePolicy: 'FAIL_CLOSED', source: 'DECLARED',
        reason: 'kifelé ható lépés: a főkönyv nélkül egy elküldött művelet nyom nélkül maradna. '
          + 'A KONKRÉT csatorna-capability a végrehajtó úton kerül a szerződésbe, nem itt: '
          + 'ez a lépés-szintű alap, nem a művelet teljes függőségi listája',
      }
  }
}

// ── Enforcement ─────────────────────────────────────────────────────────

export type EnforcementVerdict =
  /** Everything required is there. May still carry degradations. */
  | 'PROCEED'
  /** A required capability is missing: park on a typed capability wait. */
  | 'WAIT_CAPABILITY'
  /** Nobody declared a dependency for work that can touch the world. */
  | 'DENY_UNDECLARED'
  /** Nobody declared one, but the work is read-only: proceed, and say so. */
  | 'CONTRACT_GAP'

export interface EnforcementResult {
  verdict: EnforcementVerdict
  /** The required capability that blocks, when one does. */
  blocker?: CapabilityPreflight
  /** Optional capabilities that were missing and were proceeded without. The
   *  audit leg of "degradált módban továbbmehet, ha a degradáció auditált". */
  degradations: CapabilityPreflight[]
  /** One line for the run ledger and the wait row. */
  detail: string
}

/**
 * Apply one contract to one action.
 *
 * THE ORDER IS THE POLICY, and each step of it is the owner's:
 *
 *  1. UNDECLARED first, because it is a statement about the CONTRACT and not
 *     about the deployment. High-risk or mutating work with no declaration is
 *     denied — "undeclared high-risk action → DENY/NEEDS_HUMAN, nem silent
 *     continue". Read-only work is not stopped merely for lacking a declaration;
 *     it is flagged as a contract gap, which is a backlog item, not an outage.
 *  2. REQUIRED next. A missing one parks the action on a typed wait. The engine
 *     does NOT continue in a degraded context: that is the specific thing the
 *     owner forbade, because a decision made without a capability the action
 *     itself called necessary is a decision made on partial evidence while
 *     believing it is complete.
 *  3. OPTIONAL last, and it never parks the case. It records what was missing so
 *     the confidence/risk policy — which owns the blocking decision, not this
 *     file — can weigh it.
 */
export function enforceCapabilityContract(
  db: Database.Database,
  contract: CapabilityContract,
  sideEffect: SideEffectClass,
  now: number,
): EnforcementResult {
  if (contract.source === 'UNDECLARED') {
    if (sideEffect !== 'READ_ONLY') {
      return {
        verdict: 'DENY_UNDECLARED', degradations: [],
        detail: `${sideEffect} művelet deklarált capability-szerződés nélkül — ez nem folytatható csendben`,
      }
    }
    return {
      verdict: 'CONTRACT_GAP', degradations: [],
      detail: 'olvasó lépés capability-deklaráció nélkül: szerződés-hiány, nem üzemzavar',
    }
  }

  const req = preflight(db, contract.requiredCapabilities, now)
  if (!req.ok && req.blocker) {
    return {
      verdict: 'WAIT_CAPABILITY', blocker: req.blocker, degradations: [],
      detail: `hiányzó kötelező capability: ${req.blocker.capability} — ${req.blocker.detail}`,
    }
  }

  // Optional capabilities are probed but never block. `preflight` returns ok
  // only when nothing is UNAVAILABLE, so the list is read directly instead.
  const opt = contract.optionalCapabilities.length
    ? preflight(db, contract.optionalCapabilities, now).results
    : []
  const degradations = opt.filter(r => r.state !== 'AVAILABLE')
  return {
    verdict: 'PROCEED', degradations,
    detail: degradations.length
      ? `degradált: ${degradations.map(d => d.capability).join(', ')} — a cél továbbra is elérhető`
      : 'minden deklarált capability elérhető',
  }
}

// ── Coverage ────────────────────────────────────────────────────────────

export interface CoverageRow {
  kind: PlanStepKind
  sideEffect: SideEffectClass
  declared: number
  total: number
}

export interface CoverageReport {
  rows: CoverageRow[]
  /** Declared / total across every kind. */
  overall: { declared: number; total: number }
  /** Declared / total across MUTATING and HIGH_RISK only. The owner's gate:
   *  "mutating/high-risk utaknál legyen 100% coverage az enforcement előtt". */
  risky: { declared: number; total: number }
  /** True only when every mutating and high-risk kind is fully declared. This
   *  is a MEASUREMENT, not a switch: whoever turns enforcement on reads it. */
  enforcementReady: boolean
}

/**
 * How much of the action surface actually carries a declaration.
 *
 * Measured over the KINDS the planner can emit, not over rows in a table: a
 * count of live cases would move with the board and would report 100% on a
 * quiet day. What matters is whether the code that plans work states what that
 * work needs, and that is a property of the vocabulary.
 */
export function capabilityCoverage(): CoverageReport {
  const kinds = Object.keys(SIDE_EFFECT_CLASS) as PlanStepKind[]
  return summariseCoverage(kinds.map(kind => {
    const c = declareForPlanStep(kind)
    return {
      kind, sideEffect: SIDE_EFFECT_CLASS[kind],
      declared: c.source === 'DECLARED' ? 1 : 0, total: 1,
    }
  }))
}

/**
 * The gate itself, separated from where the rows come from.
 *
 * SPLIT BECAUSE A MUTATION SURVIVED. Hardwiring `enforcementReady: true` left the
 * whole suite green: the tests asserted the gate says *ready* on a surface that
 * IS complete, and checked the incomplete case against a hand-built object
 * instead of this function. So the one branch that decides whether enforcement
 * runs at all was the one branch nothing drove red — in a file whose entire
 * argument is that a gate must be able to refuse.
 *
 * Pure, and takes its rows, so an INCOMPLETE surface can be handed to the real
 * gate rather than imagined next to it.
 */
export function summariseCoverage(rows: readonly CoverageRow[]): CoverageReport {
  const sum = (rs: readonly CoverageRow[]) => ({
    declared: rs.reduce((n, r) => n + r.declared, 0),
    total: rs.reduce((n, r) => n + r.total, 0),
  })
  const risky = sum(rows.filter(r => r.sideEffect !== 'READ_ONLY'))
  return {
    rows: [...rows], overall: sum(rows), risky,
    // `risky.total > 0` is not pedantry: without it, DELETING the risk
    // classification would produce "100% of zero" and arm the gate.
    enforcementReady: risky.total > 0 && risky.declared === risky.total,
  }
}
