/**
 * §19 closure B (owner, 2026-08-27) — from a PLANNED action to the CONCRETE
 * capability its execution will need.
 *
 * The complaint this answers, in his words: *"RUN_LEDGER önmagában nem teljes
 * dependency declaration az EXECUTE / COMMUNICATE műveleteknél. […] execution
 * előtt ne csak az executor belsejében derüljön ki, mit igényelt a művelet."*
 *
 * WHAT THIS FILE IS NOT. It does not duplicate the executor's policy, and it
 * does not decide whether a send may go out — the dispatch gate, the quota, the
 * sensitivity profile and the approval all stay exactly where they are. It
 * answers one narrower question, EARLIER: *which capability will this action
 * need?* The executor then still checks everything it checked before.
 *
 * DETERMINISTIC AND READ-ONLY, for the same reason the preflight is: a
 * resolution that reaches outside has become the thing it was meant to describe,
 * and one that varies between two runs cannot be replayed against a corpus.
 *
 * THE AUDIT CHAIN IS THE POINT. The owner asked for it explicitly and by name:
 *
 *     planned action -> resolved execution/channel -> required capability -> preflight verdict
 *
 * so the resolution carries every link, including its own failure. An
 * UNRESOLVED resolution is a first-class answer, not a null: on a HIGH_RISK or
 * MUTATING action it denies, because "we could not work out what this needs" and
 * "this needs nothing" must never render the same. That is the same rule
 * `source: UNDECLARED` encodes one layer up, applied to the layer below.
 */

import type Database from 'better-sqlite3'
import type { CapabilityContract, PlanStepKind } from './capability-contract.js'

export type ResolutionStatus =
  /** A concrete execution target was determined. */
  | 'RESOLVED'
  /** This kind of action reaches nothing outside; there is no target to find. */
  | 'NOT_REQUIRED'
  /** It DOES reach outside and the target could not be determined. */
  | 'UNRESOLVED'

export interface ResolvedExecution {
  status: ResolutionStatus
  /** The channel or tool the execution would use, e.g. `gmail`, `telegram:cos`. */
  target: string | null
  /** The capability that target needs, in `capability-preflight` vocabulary. */
  capability: string | null
  /** How it was determined, in one line, for the audit trail. */
  reason: string
  /** WHAT KIND OF ANSWER THIS IS, and the distinction is load-bearing for the
   *  side-effect classifier one layer up.
   *
   *  PENDING_OUTBOUND  a real queued outbound row drove this. EVIDENCE that this
   *                    action reaches outside.
   *  KIND_DEFAULT      the target is the one this KIND would use if it sent
   *                    anything. A capability floor, NOT evidence that this step
   *                    sends: every COMMUNICATE resolves a mailbox, including
   *                    the ones whose whole job is to write a local note.
   *  NONE              nothing to resolve.
   *
   *  Collapsing the first two is how "this kind could reach outside" became
   *  "this action does", which is the defect `action-side-effect.ts` exists to
   *  undo. A floor read as evidence would raise a contradiction on every
   *  internal COMMUNICATE step in the store. */
  evidence: 'PENDING_OUTBOUND' | 'KIND_DEFAULT' | 'NONE'
  /** The CONCRETE operation type this action would perform, when a queued
   *  outbound row names one. Null when nothing names it -- which is a gap the
   *  classifier must treat as a gap, never as "harmless". Never the plan-step
   *  kind: EXECUTE is not an operation. */
  operationType: string | null
}

/** The domain's outbound email connector.
 *
 *  From the DOMAIN, not from what is registered: reading the registry would make
 *  the requirement disappear together with the connector, which is the whole
 *  inference trap the contract layer exists to avoid. Personal mail goes through
 *  the private mailbox and ZST mail through the company one, and that is a fact
 *  about the scope boundary rather than about the deployment. */
export function emailConnectorFor(domain: 'personal' | 'zst'): string {
  return domain === 'personal' ? 'gmail' : 'gmail-zst'
}

/**
 * Resolve what the next action will actually need.
 *
 * COMMUNICATE reaches a person, so it resolves to a CHANNEL and needs write
 * access to it. EXECUTE reaches a tool, and which tool depends on the case's
 * declared next action -- so it is read from the case rather than assumed, and
 * an action whose tool cannot be named comes back UNRESOLVED rather than as a
 * cheerful default.
 */
export function resolveExecutionDependency(
  db: Database.Database,
  domain: 'personal' | 'zst',
  caseId: string,
  kind: PlanStepKind,
  mutates: boolean,
): ResolvedExecution {
  // TAKES THE MUTATION AXIS, NOT THE OLD SIDE-EFFECT CLASS. Same set of steps
  // short-circuits -- the old `READ_ONLY` row of `SIDE_EFFECT_CLASS` is exactly
  // the `false` row of `MUTATES_BY_KIND` -- but the argument now says what it
  // means. Passing the class would be circular: the class is derived from this
  // resolution.
  if (!mutates) {
    return {
      status: 'NOT_REQUIRED', target: null, capability: null,
      reason: `${kind}: olvasó lépés, nem ér el semmit kifelé`,
      evidence: 'NONE', operationType: null,
    }
  }

  if (kind === 'COMMUNICATE') {
    // The channel a reply on this case would go out on. Today every COMMUNICATE
    // on a case that came from mail answers on the same mailbox -- the scope
    // boundary, not a preference -- so the domain determines it.
    const connector = emailConnectorFor(domain)
    return {
      status: 'RESOLVED', target: connector,
      capability: `CONNECTOR_WRITE:${connector}`,
      reason: `COMMUNICATE -> ${connector} (a ${domain} névtér kimenő levélcsatornája), írás kell`,
      evidence: 'KIND_DEFAULT', operationType: null,
    }
  }

  if (kind === 'EXECUTE') {
    // WHAT MAKES AN EXECUTE EXTERNAL IS A PENDING OUTBOUND ROW, not the kind.
    //
    // The first version treated every EXECUTE as external and returned
    // UNRESOLVED whenever the case had no outbound history -- which denied
    // ordinary local progression on every case in the store. Six existing tests
    // caught it, and they were right: most EXECUTE steps in this engine are
    // local or shadow work that never opens a channel. Refusing them would have
    // been the loudest possible way to be safe about nothing.
    //
    // So the question is evidence-based and narrow: is there an outbound row
    // WAITING to be performed for this case? If yes, this EXECUTE drives it and
    // the dependency is that row's action type. If no, there is nothing outside
    // to reach and NOT_REQUIRED is the honest answer, not a shrug.
    const pending = pendingOutbound(db, domain, caseId)
    if (!pending) {
      return {
        status: 'NOT_REQUIRED', target: null, capability: null,
        reason: 'EXECUTE: nincs végrehajtásra váró kimenő sor az ügyön — helyi lépés',
        evidence: 'NONE', operationType: null,
      }
    }
    const tool = toolForActionType(pending.actionType, domain)
    if (!tool) {
      // There IS pending external work and this layer cannot name what it needs.
      // That is the one case that must deny: a real send behind a capability
      // nobody checked is exactly what the contract exists to prevent.
      return {
        status: 'UNRESOLVED', target: null, capability: null,
        reason: `EXECUTE: végrehajtásra váró "${pending.actionType}" művelet, `
          + 'amelynek a függősége ebben a rétegben nem nevezhető meg',
        evidence: 'PENDING_OUTBOUND', operationType: pending.actionType,
      }
    }
    return {
      status: 'RESOLVED', target: tool.target, capability: tool.capability,
      reason: `EXECUTE -> ${tool.target} (${tool.why}, ledger ${pending.ledgerId})`,
      evidence: 'PENDING_OUTBOUND', operationType: pending.actionType,
    }
  }

  // RECOVER and anything else MUTATING: local repair, no external target.
  return {
    status: 'NOT_REQUIRED', target: null, capability: null,
    reason: `${kind}: helyi állapotot ír, nem ér el külső rendszert`,
    evidence: 'NONE', operationType: null,
  }
}

/** Outbound work on this case that has not been performed yet.
 *
 *  PLANNED and FAILED_RETRYABLE are the two states from which a first or repeat
 *  delivery can still start; every other state has either already left or is
 *  terminal, and neither is something the next EXECUTE would drive. */
const PENDING_OUTBOUND_STATUSES = ['PLANNED', 'FAILED_RETRYABLE'] as const

function pendingOutbound(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string,
): { actionType: string; ledgerId: string } | null {
  const table = domain === 'personal' ? 'outbound_ledger' : 'zst_outbound_ledger'
  try {
    const r = db.prepare(
      `SELECT action_type, ledger_id FROM ${table}
        WHERE case_id = ? AND status IN (${PENDING_OUTBOUND_STATUSES.map(() => '?').join(',')})
        ORDER BY sequence_number ASC LIMIT 1`,
    ).get(caseId, ...PENDING_OUTBOUND_STATUSES) as
      { action_type?: string; ledger_id?: string } | undefined
    return r?.action_type && r.ledger_id ? { actionType: r.action_type, ledgerId: r.ledger_id } : null
  } catch { return null }
}

/** The capability an outbound action type needs. Unknown types return null,
 *  which becomes UNRESOLVED and then a DENY -- never a default capability, since
 *  guessing here would put a real send behind a check nobody made. */
function toolForActionType(
  actionType: string, domain: 'personal' | 'zst',
): { target: string; capability: string; why: string } | null {
  const connector = emailConnectorFor(domain)
  switch (actionType) {
    case 'EMAIL_SEND':
      return {
        target: connector, capability: `CONNECTOR_WRITE:${connector}`,
        why: 'EMAIL_SEND a kimenő főkönyvben',
      }
    default:
      return null
  }
}

/**
 * Fold a resolution into the contract the action carries.
 *
 * The step-level declaration is a FLOOR (`RUN_LEDGER` for anything that writes),
 * and this adds the concrete channel or tool on top of it. Both survive: the
 * floor says what recording the action needs, the resolution says what
 * performing it needs, and they are different questions.
 */
export function withResolvedDependency(
  contract: CapabilityContract, resolved: ResolvedExecution,
): CapabilityContract {
  if (resolved.status === 'UNRESOLVED') {
    // The contract becomes UNDECLARED, which the enforcement layer already knows
    // how to refuse for risky work. Expressed as a source change rather than as
    // a new verdict, so there is exactly ONE place that decides what undeclared
    // means -- and it is the place the owner's rule is written down.
    return {
      ...contract, source: 'UNDECLARED',
      reason: `${contract.reason} | FELOLDATLAN: ${resolved.reason}`,
    }
  }
  if (resolved.status === 'NOT_REQUIRED' || !resolved.capability) return contract
  return {
    ...contract,
    requiredCapabilities: contract.requiredCapabilities.includes(resolved.capability)
      ? contract.requiredCapabilities
      : [...contract.requiredCapabilities, resolved.capability],
    source: 'DECLARED',
    reason: `${contract.reason} | feloldva: ${resolved.reason}`,
  }
}
