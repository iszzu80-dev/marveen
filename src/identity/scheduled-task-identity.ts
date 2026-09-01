// W10 — who a scheduled task is, and how that survives a process boundary.
//
// Istvan's decision (2026-08-25) §1: "Fejezd be a scheduled task identity
// propagationt is. W10 vegen relevans hivonal LEGACY_UNKNOWN nem maradhat normal
// vegallapot." This module is that completion.
//
// THE PROBLEM THIS SOLVES, WHICH IS NOT THE OBVIOUS ONE.
//
// `scheduledTaskIdentity()` already existed and was already tested. What it had
// no answer for is that the COS cycle does not RUN its steps -- it SPAWNS them.
// Eleven child processes, each of which is where the actual side effects happen.
// An identity constructed in the parent and never crossing the process boundary
// is an identity the acting code does not have, and the acting code is where the
// gate is. That is the exact shape of a gate that reads as wired and is not.
//
// SO WHY NOT JUST PUT THE SCOPE IN THE ENVIRONMENT.
//
// Because then the scope is whatever the environment says, and the environment
// is writable by anything that can spawn a process -- including a child of a
// child, which is precisely the actor the gate exists to constrain. A cycle step
// could hand its own grandchild `MARVEEN_CAPABILITY_SCOPE=EXTERNAL_EFFECT,ADMIN`
// and the grandchild would believe it.
//
// So the environment carries only IDENTIFIERS -- which task, which run, for whom
// -- and the SCOPE is re-derived here from a declaration in code. Env can say
// who you claim to be; it cannot say what you may do. A forged task name gets
// the unknown-task scope, which grants nothing beyond the local floor.

import type { Capability, ExecutionIdentity } from './execution-identity.js'

/** Env keys. Named so they are greppable and obviously ours. */
export const SCHEDULED_IDENTITY_ENV = {
  task: 'MARVEEN_SCHED_TASK',
  runId: 'MARVEEN_SCHED_RUN_ID',
  onBehalfOf: 'MARVEEN_SCHED_ON_BEHALF_OF',
} as const

export interface ScheduledTaskGrant {
  /** Task name, matching the scheduled task / cycle step id. */
  task: string
  /** What this task may do. Absent EXTERNAL_EFFECT means it cannot reach out. */
  capabilities: readonly Capability[]
  /**
   * The principal this task acts for, when it genuinely does.
   *
   * This is the field that decides whether confidential egress is ALLOW or
   * REQUIRE_APPROVAL, so it is declared per task rather than passed at a call
   * site: "the cycle acts for Istvan" is a standing fact about the cycle, and a
   * per-call-site answer would let one forgetful call site turn an approval gate
   * into a silent allow.
   */
  onBehalfOf: string | null
  /** Why this task holds what it holds. Read by humans, not by code. */
  rationale: string
}

/**
 * The declared grants.
 *
 * Everything not listed gets `UNKNOWN_TASK_CAPABILITIES`: READ and WRITE_LOCAL,
 * never EXTERNAL_EFFECT. A task that needs to reach outside has to be written
 * down here, which is the point -- the list of things that can act on the world
 * unattended should be short enough to read in one sitting.
 */
export const SCHEDULED_TASK_GRANTS: readonly ScheduledTaskGrant[] = Object.freeze([
  {
    task: 'cos-cycle',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale:
      'The CoS cycle asks Istvan questions and posts his digests on his own channel. '
      + 'It acts for him by construction, and saying so is what keeps confidential '
      + 'egress an ALLOW rather than an unattended REQUIRE_APPROVAL that nobody answers at 3am.',
  },
  {
    task: 'cos-channel-send',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'The step that actually delivers an owner question to the CoS channel.',
  },
  {
    task: 'cos-planned-digest',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Posts the daily PLANNED digest, including the zero case, to Istvan.',
  },
  {
    task: 'cos-radar-digest',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Posts the radar digest to Istvan.',
  },
  {
    task: 'cos-wake-alert',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Surfaces woken cases to Istvan; silent when nothing woke.',
  },
  {
    task: 'cos-attention-digest',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale:
      'P3-A: reads the Phase 2 projection and speaks the interrupt list to Istvan. '
      + 'WRITE_LOCAL is the delivery ledger only -- what was said, when -- never a case fact; '
      + 'EXTERNAL_EFFECT because a message reaching Istvan is an effect outside this process, '
      + 'the same grant cos-wake-alert carries for the same reason.',
  },
  {
    task: 'cos-close-batches',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL', 'EXTERNAL_EFFECT'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale:
      'Source-commit labels a finished message at Gmail (gmail.modify). That is an '
      + 'external write, so the step needs EXTERNAL_EFFECT even though nothing is sent.',
  },
  // Deliberately NOT granted EXTERNAL_EFFECT, and each for a stated reason:
  {
    task: 'progression',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Advances case state locally. It has never needed to reach outside, and should fail loudly the day it tries.',
  },
  {
    task: 'cos-fetch-threads',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Reads mail threads through a read-only credential. A read needs no external-effect grant.',
  },
  {
    task: 'cos-draft-followups',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale:
      'DRAFTS a follow-up; it does not send one. Sending is a separate, gated step, and the '
      + 'grant boundary is where that separation stops being a convention and becomes enforced.',
  },
  {
    task: 'cos-recovery-queue',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale:
      'Reconciles the W12 recovery queue over local rows. Deliberately WITHOUT '
      + 'EXTERNAL_EFFECT: Istvan ruled that W12 adds no new notification channel, and a '
      + 'grant boundary enforces that where a comment would only ask.',
  },
  {
    task: 'cos-reconcile-projection',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale:
      'P1 projection sweep. Writes ONLY the engine-owned proj_* columns and their reconciliation '
      + 'metadata on the case board -- no status, no version bump, no scheduling, nothing outbound. '
      + 'WRITE_LOCAL rather than READ because it does write, and a step that under-declares its '
      + 'grant is a worse lie than one that over-declares it.',
  },
  {
    task: 'cos-deadline-audit',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Detects prose-only deadlines. Local reasoning over local rows.',
  },
  {
    task: 'cos-channel-poll',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Reads inbound replies. getUpdates is a read; nothing leaves.',
  },
  {
    task: 'cos-maintenance',
    capabilities: Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[]),
    onBehalfOf: 'istvan',
    rationale: 'Backup, retention and permission repair. All local, and deliberately holds no ADMIN: it repairs data, not policy.',
  },
])

/** What an unlisted task gets. Never EXTERNAL_EFFECT, never ADMIN, never SECRET_READ. */
export const UNKNOWN_TASK_CAPABILITIES: readonly Capability[] =
  Object.freeze(['READ', 'WRITE_LOCAL'] as Capability[])

const GRANTS = new Map(SCHEDULED_TASK_GRANTS.map(g => [g.task, g]))

export function lookupScheduledGrant(task: string): ScheduledTaskGrant | null {
  return GRANTS.get(task) ?? null
}

/**
 * The identity a scheduled task acts under.
 *
 * `onBehalfOf` may be overridden DOWNWARD by the caller (to null, for a task
 * doing something on its own initiative) but never upward: a caller cannot name
 * a principal the declaration did not grant. Delegation you can assert for
 * yourself is not delegation.
 */
export function declaredScheduledIdentity(
  task: string, runId: string | null, actForPrincipal = true,
): ExecutionIdentity {
  const grant = lookupScheduledGrant(task)
  return {
    actorId: `schedule:${task}`,
    actorType: 'SYSTEM_AUTOMATION',
    onBehalfOf: actForPrincipal ? (grant?.onBehalfOf ?? null) : null,
    runId,
    capabilityScope: grant?.capabilities ?? UNKNOWN_TASK_CAPABILITIES,
  }
}

/**
 * Rebuild the identity in a CHILD process from the environment.
 *
 * Reads the task name, the run id and whether it acts for a principal; re-derives
 * the SCOPE from the declaration above. Returns null when no task name is
 * present, so a process that was not launched by the cycle gets an identity
 * resolution FAILURE rather than a plausible-looking identity -- the two must
 * not look the same, or every unattended script quietly becomes a scheduled task.
 */
export function scheduledIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionIdentity | null {
  const task = env[SCHEDULED_IDENTITY_ENV.task]
  if (!task) return null
  const runId = env[SCHEDULED_IDENTITY_ENV.runId] ?? null
  // The env may say "I act for nobody", which narrows. It may not say "I act for
  // Istvan" if the declaration does not -- so the value is compared to the
  // declaration rather than adopted.
  const claimed = env[SCHEDULED_IDENTITY_ENV.onBehalfOf] ?? null
  const declared = lookupScheduledGrant(task)?.onBehalfOf ?? null
  const actFor = claimed !== null && claimed === declared
  return declaredScheduledIdentity(task, runId, actFor)
}

/** The env a parent sets when spawning a step. Identifiers only, never scope. */
export function scheduledIdentityEnv(id: ExecutionIdentity): Record<string, string> {
  const task = id.actorId.startsWith('schedule:') ? id.actorId.slice('schedule:'.length) : id.actorId
  const out: Record<string, string> = { [SCHEDULED_IDENTITY_ENV.task]: task }
  if (id.runId) out[SCHEDULED_IDENTITY_ENV.runId] = id.runId
  if (id.onBehalfOf) out[SCHEDULED_IDENTITY_ENV.onBehalfOf] = id.onBehalfOf
  return out
}
