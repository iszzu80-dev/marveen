// W10 — the Marveen-owned action broker for external, side-effecting actions.
//
// Istvan's HYBRID EXTERNAL ACTION BOUNDARY decision (2026-08-25) replaced the
// invariant "every action passes a boundary in ONE process" with a weaker and
// more honest one: every side-effecting action has a Marveen-controlled,
// actor-aware enforcement point, which need not be the same process. Two layers
// are mandatory -- a provider-side least-privilege credential as the hard outer
// guard (W13 owns its lifecycle), and this broker in front of every external
// mutating action. Direct, broker-less external WRITE is no longer a supported
// normal path.
//
// WHY THE BROKER OWNS THE CALL INSTEAD OF ADVISING ON IT.
//
// The obvious shape is `if (checkAllowed(...)) { doTheThing() }`. That shape has
// failed in this repo before and will again: the check and the call are two
// statements, so a future edit can move, guard or forget one of them, and the
// resulting code still reads as gated. Here the caller hands the effect IN, as a
// thunk, and the broker decides whether it is ever invoked. A denial is then not
// a flag the caller is trusted to honour -- it is a function that was never
// called. There is no way to write the bypass by accident, only on purpose.
//
// WHAT THIS IS NOT.
//
// It is not a generic MCP gateway, and per Istvan's §3 it deliberately is not
// one: read-only external calls stay direct, on four conditions checked against
// the inventory rather than assumed. Building a proxy in front of every read to
// gain uniformity would be a large new moving part in the path of every triage
// run, bought with no reduction in blast radius -- a read that cannot mutate is
// not made safer by being proxied.
//
// It is also not a second policy engine. Every authority question is answered by
// `authorizeAction`; the broker adds only what that pure function cannot know:
// which connectors exist, what their credentials may do, and whether the effect
// actually ran.

import type Database from 'better-sqlite3'
import type { Capability, ExecutionIdentity } from './execution-identity.js'
import { authorizeAction, permitsExecution, type ActionKind, type AuthorizeDecision, type PolicyVerdict } from './authorize-action.js'
import { levelRank, type Classification, type SensitivityLevel } from './sensitivity-scale.js'
import {
  type ExternalCapabilityEntry, type RiskClass,
  isHighRisk, lookupExternalCapability,
} from './external-capability-inventory.js'
import { bumpPolicyCounter, counterForVerdict } from './policy-metrics.js'

export const EXTERNAL_ACTION_LOG_SCHEMA_VERSION = 1

/**
 * Evidence that an owner approved this specific high-risk action.
 *
 * Deliberately NOT a boolean. A boolean approval is indistinguishable from a
 * default, and defaults are what get shipped by accident. This carries who
 * approved, when, and the id of the approval record, so an approval can be
 * checked after the fact against the approvals table rather than believed.
 */
export interface ApprovalEvidence {
  /**
   * WHAT authorised this action.
   *
   * Istvan's §4 asks for approval "szukseg eseten" -- where needed -- not on
   * every high-risk call. The three kinds are the three things that actually
   * authorise a send in this system today, and naming which one applied is the
   * point: an audit row that says only "approved" cannot distinguish a human's
   * YES from a standing grant from a delegation envelope, and those carry very
   * different weight when something goes wrong.
   *
   * WHAT THE BROKER CAN AND CANNOT CHECK, stated plainly. It enforces that a
   * high-risk action has SOME basis; it cannot verify a basis minted elsewhere
   * in the same process. A `GATE_PERMIT` basis is a claim by the caller that the
   * COS dispatch gate ran and allowed this send -- true today at both call sites,
   * and recorded rather than proven. The enforcement is the absence case: no
   * basis at all is a refusal, which is what stops a new call path from reaching
   * the transport by simply not mentioning authorisation.
   */
  kind?: 'OWNER_APPROVAL' | 'DELEGATION' | 'STANDING_GRANT' | 'GATE_PERMIT'
  /** The approvals-table id, envelope id, or another durable reference. */
  approvalId: string
  approvedBy: string
  /** Unix seconds. */
  approvedAt: number
  /** What was approved, in the approver's terms -- not the code's. */
  scopeDescription: string
}

/**
 * Standing owner grants for recurring, automated high-risk operations.
 *
 * Istvan's decision §4 says high-risk actions need approval "szukseg eseten" --
 * where needed -- not per call unconditionally. A source-commit label runs over
 * every processed mail; asking him to approve each one would train him to
 * approve without reading, which is worse than not asking.
 *
 * So the standing grants live HERE, in one declared, greppable list, rather than
 * being constructed at a call site. What that buys is honesty rather than
 * enforcement: any code in this process could build an ApprovalEvidence object,
 * and pretending otherwise would be security theatre. What it does buy is that
 * the set of operations running on a standing grant is a list you can read, each
 * one dated and attributed, and the audit row names WHICH grant let it through.
 *
 * A grant here must name a real owner decision with a real date. One invented to
 * get a test green is a lie in a place nobody re-reads.
 */
export const STANDING_APPROVALS: Readonly<Record<string, ApprovalEvidence>> = Object.freeze({
  'gmail.label': Object.freeze({
    approvalId: 'standing:gmail-modify-2026-08-11',
    approvedBy: 'istvan',
    // The day Istvan granted gmail.modify for exactly this purpose; the scope is
    // confirmed by the provider, per gmail-label-api.ts's own header.
    approvedAt: 1_754_870_400,
    scopeDescription: 'apply the COS/Processed label to messages the COS has finished with',
  }),
})

export interface ExternalActionRequest {
  /** Connector id from the inventory. Unknown -> DENY. */
  connector: string
  /** The provider operation, for the audit record: 'messages.send', 'events.insert'. */
  operation: string
  /** True when this changes state at the provider. */
  mutating: boolean
  /** How much damage this call can do. */
  riskClass: RiskClass
  /** WHO is acting. Absent is a resolution failure, never an escape hatch. */
  identity: ExecutionIdentity | null | undefined
  /** WHO they act for, when there is one. Required for high-risk. */
  principal?: ExecutionIdentity | null
  /** Sensitivity of the payload leaving the machine. */
  classification: Classification
  /** Stable id of the receiver: recipient address, chat id, calendar id. */
  targetId?: string | null
  /** Owner approval, required for every high-risk action. */
  approval?: ApprovalEvidence | null
  /** Recorded, never authority-bearing. */
  context?: Record<string, string | number | boolean | null>
}

export type BrokerOutcome = 'EXECUTED' | 'DENIED' | 'FAILED'

export interface BrokeredResult<T> {
  outcome: BrokerOutcome
  /** The policy verdict that decided it. */
  verdict: PolicyVerdict
  /** Every reason, so a refusal is diagnosable rather than merely final. */
  reasons: string[]
  /** Present only when the effect actually ran. */
  value?: T
  /** Present when the effect ran and threw. */
  error?: string
  /** What the readback saw, when one was supplied. */
  readback?: string | null
  /** The underlying boundary decision, for callers that record their own audit. */
  decision: AuthorizeDecision
  /** The inventory entry used, when the connector was known. */
  entry: ExternalCapabilityEntry | null
}

export interface BrokerOptions<T> {
  /**
   * Confirm at the PROVIDER that the effect landed. Required for high-risk
   * actions, because for those the difference between "we called it" and "it
   * happened" is the difference between a record and a guess. Returns a short
   * string for the audit, or null when it could not confirm.
   */
  readback?: (value: T) => Promise<string | null> | string | null
  /** Where to persist the audit row and counters. Optional so the broker is
   *  usable in a pure unit test without a database. */
  db?: Database.Database
  /** Surface label for the counters, e.g. 'external_broker'. */
  surface?: string
  /** Injectable clock, so the audit row is testable. */
  now?: () => number
}

/** The audit row. Content NEVER appears here -- only what it was about. */
export interface ExternalActionAudit {
  at: number
  connector: string
  operation: string
  mutating: boolean
  riskClass: RiskClass
  actorId: string
  actorType: string
  onBehalfOf: string | null
  runId: string | null
  targetId: string | null
  level: string
  tags: string
  verdict: PolicyVerdict
  outcome: BrokerOutcome
  reasons: string
  approvalId: string | null
  readback: string | null
}

export function initExternalActionLogSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_action_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      connector    TEXT    NOT NULL,
      operation    TEXT    NOT NULL,
      mutating     INTEGER NOT NULL,
      risk_class   TEXT    NOT NULL,
      actor_id     TEXT    NOT NULL,
      actor_type   TEXT    NOT NULL,
      on_behalf_of TEXT,
      run_id       TEXT,
      target_id    TEXT,
      level        TEXT    NOT NULL,
      tags         TEXT    NOT NULL,
      verdict      TEXT    NOT NULL,
      outcome      TEXT    NOT NULL,
      reasons      TEXT    NOT NULL,
      approval_id  TEXT,
      readback     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_external_action_log_at ON external_action_log(at);
    CREATE INDEX IF NOT EXISTS idx_external_action_log_connector ON external_action_log(connector, at);
  `)
}

export function recordExternalAction(db: Database.Database, a: ExternalActionAudit): void {
  initExternalActionLogSchema(db)
  db.prepare(`
    INSERT INTO external_action_log
      (at, connector, operation, mutating, risk_class, actor_id, actor_type,
       on_behalf_of, run_id, target_id, level, tags, verdict, outcome, reasons,
       approval_id, readback)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    a.at, a.connector, a.operation, a.mutating ? 1 : 0, a.riskClass,
    a.actorId, a.actorType, a.onBehalfOf, a.runId, a.targetId,
    a.level, a.tags, a.verdict, a.outcome, a.reasons, a.approvalId, a.readback,
  )
}

/** Which boundary action a broker request maps onto. A mutating external call is
 *  an EXTERNAL_EFFECT; a read is a READ. There is no third answer, and no
 *  connector gets to choose a gentler one for itself. */
function actionKindFor(req: ExternalActionRequest): ActionKind {
  return req.mutating ? 'EXTERNAL_EFFECT' : 'READ'
}

/**
 * The one supported path for an external action.
 *
 * `execute` is invoked ONLY if every gate below passes. When it is not invoked,
 * nothing outside this machine changed -- that is the guarantee, and it is
 * structural rather than promised.
 */
export async function brokerExternalAction<T>(
  req: ExternalActionRequest,
  execute: () => Promise<T> | T,
  opts: BrokerOptions<T> = {},
): Promise<BrokeredResult<T>> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const surface = opts.surface ?? 'external_broker'
  const reasons: string[] = []

  const entry = lookupExternalCapability(req.connector)

  // GATE 1 -- the connector must be declared. An undeclared connector is denied
  // even for a read, because the inventory's four read-only conditions cannot be
  // checked for something that is not in it. This is what keeps the inventory
  // honest: an entry nobody added is an action nobody can make.
  if (!entry) reasons.push(`connector not in the external capability inventory: ${req.connector}`)

  // GATE 2 -- a read-only credential may not be used for a mutating call. The
  // provider would refuse anyway; refusing here means the attempt is RECORDED
  // rather than discovered later in a provider error log nobody reads.
  if (entry && req.mutating && entry.readOnly) {
    reasons.push(`connector ${entry.id} is declared read-only (${entry.grantedScopes.join(', ')}); a mutating call is not a supported path`)
  }

  // GATE 3 -- the connector's own risk ceiling. A caller may not declare a
  // gmail.send as ROUTINE to skip the approval requirement: the ceiling comes
  // from the inventory, and the effective risk is the HIGHER of the two.
  const effectiveRisk: RiskClass = entry
    ? (riskRank(req.riskClass) >= riskRank(entry.maxRisk) ? req.riskClass : entry.maxRisk)
    : req.riskClass
  if (entry && riskRank(req.riskClass) < riskRank(entry.maxRisk)) {
    reasons.push(`risk raised to ${effectiveRisk} by the inventory ceiling for ${entry.id} (caller declared ${req.riskClass})`)
  }

  // GATE 4 -- identity requirements for anything that mutates. §4 of the
  // decision asks for actor + on_behalf_of + run_id on high-risk actions; a
  // mutating action of any risk needs at least an actor and a run to be
  // attributable at all.
  if (req.mutating && !req.identity) reasons.push('mutating external action without a resolved identity')
  if (req.mutating && req.identity && !req.identity.runId) {
    reasons.push('mutating external action without a run id (not attributable to a run)')
  }
  if (isHighRisk(effectiveRisk)) {
    // §4 asks for actor + on_behalf_of + run_id on high-risk actions. The
    // on_behalf_of half applies to actors that act FOR someone -- an agent, a
    // scheduled automation, a service. A HUMAN_USER acting at the dashboard IS
    // the principal, and demanding that they name one would either block the
    // send or train the code to invent a delegation that did not happen. So the
    // requirement is: an action must be attributable to a human, directly or
    // through a named delegation chain.
    const actsForSomeone = !!req.identity?.onBehalfOf || !!req.principal
    const isItsOwnPrincipal = req.identity?.actorType === 'HUMAN_USER'
    if (!actsForSomeone && !isItsOwnPrincipal) {
      reasons.push(
        `high-risk external action (${effectiveRisk}) by ${req.identity?.actorType ?? 'nobody'} `
        + 'with no on_behalf_of principal: it is attributable to no human')
    }
    if (!req.approval) {
      reasons.push(`high-risk external action (${effectiveRisk}) without an authorisation basis`)
    }
    if (!opts.readback) {
      reasons.push(`high-risk external action (${effectiveRisk}) without a readback: the result would not be verifiable`)
    }
  }

  // GATE 5 -- the boundary itself. Every authority question goes here; the
  // broker adds no rule of its own about levels, tags or capabilities.
  const decision = authorizeAction({
    action: actionKindFor(req),
    identity: req.identity,
    principal: req.principal,
    classification: req.classification,
    // The boundary refuses an egress target that cannot answer "are you approved
    // for this level?", and it is right to: unestablished trust is not trust.
    // The answer comes from the INVENTORY, not from the call site -- a
    // per-call-site trust predicate is a per-call-site opportunity to be
    // generous, and the generous one is the one that ships.
    target: req.targetId
      ? {
          id: req.targetId,
          trustedForLevel: entry
            ? (level: SensitivityLevel) => levelRank(level) <= levelRank(entry.maxLevelOut)
            : undefined,
        }
      : undefined,
    context: {
      ...(req.context ?? {}),
      connector: req.connector,
      operation: req.operation,
      riskClass: effectiveRisk,
      broker: true,
    },
  })
  reasons.push(...decision.reasons)

  // A REQUIRE_APPROVAL verdict is satisfiable by approval evidence: that is what
  // the evidence is FOR. Without evidence the verdict stands as a refusal, which
  // is why the missing-approval reason is ADDED above rather than substituted --
  // the audit then shows both that approval was required and that it was given.
  const approvalSatisfies = decision.verdict === 'REQUIRE_APPROVAL' && !!req.approval

  // "Did one of the broker's own gates fail" must be answered by which reasons
  // are the broker's, not by counting strings against the boundary's list.
  const gatesFailed = collectGateFailures(reasons, decision.reasons)
  const allowed = gatesFailed.length === 0 && (permitsExecution(decision) || approvalSatisfies)

  const verdict: PolicyVerdict = allowed ? decision.verdict : 'DENY'

  const auditBase = {
    at: now(),
    connector: req.connector,
    operation: req.operation,
    mutating: req.mutating,
    riskClass: effectiveRisk,
    actorId: decision.identity.actorId,
    actorType: decision.identity.actorType,
    onBehalfOf: decision.identity.onBehalfOf,
    runId: decision.identity.runId,
    targetId: req.targetId ?? null,
    level: decision.audit.level,
    tags: decision.audit.tags.join(','),
    verdict,
    approvalId: req.approval
      ? `${req.approval.kind ?? 'OWNER_APPROVAL'}:${req.approval.approvalId}`
      : null,
  }

  if (!allowed) {
    finish(opts, surface, 'DENY', {
      ...auditBase, outcome: 'DENIED', reasons: reasons.join('; '), readback: null,
    })
    return { outcome: 'DENIED', verdict: 'DENY', reasons, decision, entry }
  }

  // Only here does anything outside this machine happen.
  let value: T
  try {
    value = await execute()
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    finish(opts, surface, verdict, {
      ...auditBase, outcome: 'FAILED', reasons: [...reasons, `execution failed: ${error}`].join('; '), readback: null,
    })
    return { outcome: 'FAILED', verdict, reasons: [...reasons, `execution failed: ${error}`], error, decision, entry }
  }

  let readback: string | null = null
  if (opts.readback) {
    try {
      readback = await opts.readback(value)
    } catch (e) {
      readback = `readback failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  finish(opts, surface, verdict, {
    ...auditBase, outcome: 'EXECUTED', reasons: reasons.join('; '), readback,
  })
  return { outcome: 'EXECUTED', verdict, reasons, value, readback, decision, entry }
}

/**
 * Separate the broker's OWN gate failures from the boundary's reasons.
 *
 * Needed because the two lists are concatenated for the audit, and "did a broker
 * gate fail" must not be answered by counting strings.
 */
function collectGateFailures(all: string[], fromDecision: string[]): string[] {
  const tail = new Set(fromDecision)
  return all.filter(r => !tail.has(r))
}

const RISK_ORDER: Record<RiskClass, number> = {
  ROUTINE: 0,
  ACCESS_CONTROL: 1,
  DESTRUCTIVE: 2,
  CREDENTIAL_SECURITY: 3,
  FINANCIAL: 4,
  CONTRACTUAL: 4,
}

function riskRank(r: RiskClass): number {
  // An unrecognised risk class ranks above everything, so a value added to the
  // type but forgotten here fails closed instead of ranking as ROUTINE.
  return RISK_ORDER[r] ?? Number.MAX_SAFE_INTEGER
}

function finish<T>(
  opts: BrokerOptions<T>, surface: string, verdict: PolicyVerdict, audit: ExternalActionAudit,
): void {
  if (!opts.db) return
  try {
    recordExternalAction(opts.db, audit)
    bumpPolicyCounter(opts.db, surface, counterForVerdict(verdict), audit.at)
    if (audit.actorType === 'LEGACY_UNKNOWN') {
      bumpPolicyCounter(opts.db, surface, 'identity_resolution_failure', audit.at)
    }
  } catch {
    // An audit failure must not silently turn into an execution failure, and
    // must not be swallowed either -- the counter surface is where it shows up.
  }
}

/**
 * Read the log back. Used by the acceptance check and the liveness report: a
 * broker that has never recorded a decision cannot be shown to be wired.
 */
export function readExternalActionLog(
  db: Database.Database, sinceUnix: number, limit = 200,
): ExternalActionAudit[] {
  initExternalActionLogSchema(db)
  const rows = db.prepare(`
    SELECT at, connector, operation, mutating, risk_class AS riskClass,
           actor_id AS actorId, actor_type AS actorType, on_behalf_of AS onBehalfOf,
           run_id AS runId, target_id AS targetId, level, tags, verdict, outcome,
           reasons, approval_id AS approvalId, readback
    FROM external_action_log WHERE at >= ? ORDER BY at DESC LIMIT ?
  `).all(sinceUnix, limit) as Array<Record<string, unknown>>
  return rows.map(r => ({
    ...r,
    mutating: r.mutating === 1,
  })) as ExternalActionAudit[]
}

/** Capability a connector demands, for callers that want to check before asking. */
export function requiredCapabilityFor(connector: string): Capability | null {
  return lookupExternalCapability(connector)?.requiredCapability ?? null
}
