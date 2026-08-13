// Personal Chief of Staff (COS) — the progression trigger contract (§10.8).
//
// THE PROBLEM THIS SOLVES, measured before it was written: over 24 hours the
// engine wrote 10 716 runs across 101 cases — roughly one per case every ten
// minutes — and decided CONTINUE_AUTONOMOUSLY 10 347 times. Zero of those runs
// started any action. The scheduler asks "is this case due?", the answer is
// always yes because `next_progression_at` keeps being pushed forward, and a
// case with nothing new about it is reasoned over again and again.
//
// While the engine is deterministic that is only waste. The moment §10.2's
// Reader arrives, each of those runs becomes a model call. So this is not an
// optimisation to do later — it is the Reader's precondition.
//
// THE RULE, from §10.8: progression may run when there is a REASON, and the same
// case must not reason again on the same effective state. Both halves matter. A
// pure "has anything changed?" check would never fire for a case waiting on a
// deadline; a pure "is it due?" check is what we have now.
import type Database from 'better-sqlite3'
import { readWaitSystem, capabilityRecovered } from './capability-preflight.js'
import { createHash } from 'node:crypto'

/** §10.8's trigger list. `SCHEDULED` is deliberately NOT here: "the clock came
 *  round again" is not a reason, and treating it as one is the current
 *  behaviour. */
export const TRIGGER_TYPES = [
  'NEW_RELEVANT_EVENT',
  'WAIT_WAKE_DUE',
  'FOLLOW_UP_DUE',
  'APPROVAL_RESOLVED',
  'DECISION_RESOLVED',
  'USER_INPUT',
  'CAPABILITY_RECOVERED',
  'MANUAL_REVIEW_REQUEST',
] as const
export type TriggerType = (typeof TRIGGER_TYPES)[number]

/**
 * Legacy trigger names → the §10.8 vocabulary (review #3, Ú-5).
 *
 * The old six values stayed legal when §10.8's eight arrived, so the stored
 * vocabulary is fourteen wide and an analysis of the trigger distribution counts
 * the same event under two names. This maps the ones that are genuinely
 * synonyms, at the WRITE boundary — old rows keep their old values, because
 * rewriting history to make a report tidier is how history stops being evidence.
 *
 * NOT mapped, deliberately, against the review's suggestion:
 *   - `INTAKE` is not `NEW_RELEVANT_EVENT`. Intake is the case coming into
 *     existence; a new relevant event happens to a case that already exists.
 *     They answer different questions ("where do cases come from" vs "what wakes
 *     them"), and the live store has 101 INTAKE rows that mean the first.
 *   - `ESCALATION_RESOLVED` has no §10.8 equivalent. Mapping it to
 *     APPROVAL_RESOLVED or DECISION_RESOLVED would invent a distinction the
 *     caller never made.
 */
const TRIGGER_SYNONYMS: Record<string, TriggerType> = {
  WAKE: 'WAIT_WAKE_DUE',
  MANUAL: 'MANUAL_REVIEW_REQUEST',
  RECOVERY: 'CAPABILITY_RECOVERED',
}

/** Canonical name for a trigger about to be WRITTEN. Unknown and un-mapped
 *  values pass through unchanged: this is a de-duplicator, not a validator, and
 *  the CHECK constraint is what rejects an illegal value. */
export function canonicalTriggerType(t: string): string {
  return TRIGGER_SYNONYMS[t] ?? t
}

export interface TriggerDecision {
  shouldRun: boolean
  trigger: TriggerType | null
  triggerReference: string | null
  /** The identity of the state this decision was made on. Stored after a run so
   *  the next cycle can tell "nothing has changed" from "something has". */
  effectiveStateHash: string
  reason: string
}

interface StateRow {
  case_version: number | null
  goal_version: number | null
  wait_version: number | null
  last_effective_state: string | null
  last_event_seen: number | null
}

/**
 * The effective state of a case, as §10.8 defines the dedup key: domain,
 * case id, case version, goal version, context/source cursor, wait version.
 *
 * Hashing rather than comparing fields one by one is deliberate — a partial
 * comparison is the failure mode where one forgotten field lets a stale run
 * through, and there is no such thing as a partially equal hash.
 */
export function effectiveStateHash(parts: {
  domain: string
  caseId: string
  caseVersion: number | null
  goalVersion: number | null
  waitVersion: number | null
  lastEventId: number | null
  /** The two deadlines are PART of the state. Without them an overdue follow-up
   *  fires every cycle for ever: the deadline stays in the past, the trigger
   *  keeps saying yes, and nothing records that it was already handled. Measured
   *  on the live store — 30 cases doing exactly that on every pass. With the
   *  deadline in the hash, the SAME overdue deadline is a state already reasoned
   *  about, and a NEW or MOVED deadline is a new state worth waking for. */
  nextWakeAt: number | null
  followUpAt: number | null
}): string {
  return createHash('sha256').update([
    parts.domain, parts.caseId,
    String(parts.caseVersion ?? ''), String(parts.goalVersion ?? ''),
    String(parts.waitVersion ?? ''), String(parts.lastEventId ?? ''),
    String(parts.nextWakeAt ?? ''), String(parts.followUpAt ?? ''),
  ].join('\0')).digest('hex').slice(0, 32)
}

/**
 * Should this case reason now, and why?
 *
 * ONE question decides it: is this the same effective state I already reasoned
 * about? The deadlines are part of that state, which is what lets a single rule
 * do both jobs — a new or moved deadline is a new state and wakes the case,
 * while the same overdue deadline is a state already handled. The trigger TYPE
 * is chosen afterwards, only to name the reason for the run ledger.
 */
export function decideTrigger(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string, now: number,
): TriggerDecision {
  const caseTable = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  const c = db.prepare(
    `SELECT version, status, next_wake_at, follow_up_at, last_event_id FROM ${caseTable} WHERE case_id = ?`
  ).get(caseId) as {
    version: number; status: string; next_wake_at: number | null
    follow_up_at: number | null; last_event_id: number | null
  } | undefined

  const s = db.prepare(
    `SELECT case_version, goal_version, wait_version, last_effective_state, last_event_seen
     FROM case_progression_state WHERE domain = ? AND case_id = ?`
  ).get(domain, caseId) as StateRow | undefined

  const hash = effectiveStateHash({
    domain, caseId,
    caseVersion: c?.version ?? null,
    goalVersion: s?.goal_version ?? null,
    waitVersion: s?.wait_version ?? null,
    lastEventId: c?.last_event_id ?? null,
    nextWakeAt: c?.next_wake_at ?? null,
    followUpAt: c?.follow_up_at ?? null,
  })

  const no = (reason: string): TriggerDecision =>
    ({ shouldRun: false, trigger: null, triggerReference: null, effectiveStateHash: hash, reason })
  const yes = (trigger: TriggerType, ref: string, reason: string): TriggerDecision =>
    ({ shouldRun: true, trigger, triggerReference: ref, effectiveStateHash: hash, reason })

  if (!c) return no('the case no longer exists')

  // A case that has never reasoned must reason once, whatever else is true.
  if (!s || s.last_effective_state === null) {
    return yes('NEW_RELEVANT_EVENT', `first:${hash.slice(0, 8)}`, 'the case has never been progressed')
  }

  // §19: a case parked on a CAPABILITY, and the door the CAPABILITY_RECOVERED
  // doorbell has been ringing for since this vocabulary was written.
  //
  // Checked BEFORE the deadline rule, and that ordering is the whole fix. A
  // parked case's effective state does not change while it waits — same case
  // version, same deadlines, same hash — so the rule below would answer "nothing
  // has changed" for ever, and the case would stay parked after the connector
  // came back. And an overdue deadline must NOT pull it out either: running with
  // the capability still dead only re-parks it, once per sweep, for as long as
  // the outage lasts.
  //
  // So the wait ends on one condition and one only: the same capability probes
  // healthy again. Deterministic, as §19 requires, and reproducible on a replay
  // corpus where nothing is reachable at all.
  const wait = readWaitSystem(db, domain, caseId)
  if (wait) {
    const rec = capabilityRecovered(db, domain, caseId, now)
    return rec.recovered
      ? yes('CAPABILITY_RECOVERED', `capability:${wait.capability}`,
          `the capability came back: ${wait.capability}`)
      : no(`waiting on a capability: ${wait.capability}`)
  }

  // A DUE deadline that has not been handled yet fires, whatever the hash says.
  //
  // This is the hole the hash alone leaves, and it took a red test to see it: a
  // follow-up set for NEXT WEEK changes the state today (so the case runs), and
  // then the clock passes it without changing anything — same case version, same
  // deadline value, same hash. Under a hash-only rule that follow-up would never
  // fire. Under a time-only rule it fires for ever. So the deadline VALUE is
  // remembered once it has been acted on, and "due AND not yet handled" is the
  // condition.
  const due = [c.next_wake_at, c.follow_up_at]
    .filter((d): d is number => d !== null && d <= now)
    .sort((a, b) => a - b)[0] ?? null
  if (due !== null && due !== s.last_event_seen) {
    return c.next_wake_at === due
      ? yes('WAIT_WAKE_DUE', `wake:${due}`, 'the wake time has arrived')
      : yes('FOLLOW_UP_DUE', `followup:${due}`, 'a follow-up is due')
  }

  // ONE question, asked once: is this the same state I already reasoned about?
  //
  // The first version checked the time triggers BEFORE this, so a waiting case
  // would still wake. Right about the goal, wrong about the mechanism: an
  // overdue deadline stays overdue, so the trigger fired on every pass for ever
  // — 30 cases doing exactly that on the live store, found by watching the
  // number refuse to fall over three cycles. The deadlines are in the hash now,
  // which gets both properties from one rule.
  if (s.last_effective_state === hash) {
    return no('nothing has changed and no new deadline has arrived')
  }

  return yes('NEW_RELEVANT_EVENT', `state:${hash.slice(0, 8)}`, 'the effective state changed since the last run')
}

/** Record the state a run was made on. Called AFTER the run, so a crash mid-run
 *  leaves the case eligible rather than silently skipped — the safe direction is
 *  running twice, never missing. */
export function recordProgressionState(
  db: Database.Database, domain: string, caseId: string, hash: string, now: number,
  handledDeadline: number | null = null,
): void {
  db.prepare(
    `UPDATE case_progression_state
     SET last_effective_state = @hash,
         last_event_seen = COALESCE(@deadline, last_event_seen),
         updated_at = @now
     WHERE domain = @domain AND case_id = @caseId`
  ).run({ hash, now, domain, caseId, deadline: handledDeadline })
}

/** The deadline (if any) that is due right now — what recordProgressionState
 *  should be told was handled. Kept next to decideTrigger so the two cannot
 *  disagree about what "due" means. */
export function dueDeadline(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string, now: number,
): number | null {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  const c = db.prepare(`SELECT next_wake_at, follow_up_at FROM ${table} WHERE case_id = ?`)
    .get(caseId) as { next_wake_at: number | null; follow_up_at: number | null } | undefined
  if (!c) return null
  return [c.next_wake_at, c.follow_up_at]
    .filter((d): d is number => d !== null && d <= now)
    .sort((a, b) => a - b)[0] ?? null
}
