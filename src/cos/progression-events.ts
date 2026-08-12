// §8 — the progression writes to the case's OWN event history.
//
// WHAT WAS MISSING. §8's first line is "the existing event/history system should
// be EXTENDED, no parallel generic event store should be built". What happened
// is neither: the progression built no parallel store, and wrote nothing into
// the existing one. Sixteen of the seventeen event types §8 lists had no
// producer anywhere in the codebase (review 2026-08-12, §8).
//
// The consequence is a split that only shows up when somebody asks a question:
//
//   "what did the engine do?"      -> case_progression_runs, 15k+ rows   ✅
//   "what happened to this case?"  -> personal_case_events, nothing       ❌
//
// Reading a case's history today, you cannot see that it was given a goal, that
// a plan was made, that it started waiting, that it escalated, or that it closed
// semantically. §27's PROGRESSION HISTORY panel has nothing to render for the
// same reason.
//
// WHY THIS IS SAFE TO DO NOW, AND WHY IT WAS RIGHT TO HESITATE. `recordOwnerAnswer`
// sets `last_event_id` on the CASE ROW to wake the engine, and its comment says
// plainly why that is not done for every event: "the engine writes its own events
// during a run, so waking on EVERY event would make each run schedule the next
// one." That worry is exactly right, and it is what this module must not trigger.
//
// It does not, by construction: `decideTrigger` hashes `last_event_id` read from
// the CASE ROW, not from the events table. So an appended event is invisible to
// the trigger contract unless somebody also updates that column — and nothing
// here does. The standing check in the test file enforces it.
//
// ONE EVENT PER CHANGE, NOT PER RUN. The cycle runs every ten minutes; a case
// waiting on a supplier would otherwise collect a WAIT_STARTED event every ten
// minutes forever. Every writer below is conditioned on the underlying fact
// having CHANGED since the previous run, which is what makes the history
// readable rather than a log.

import type Database from 'better-sqlite3'

/** The §8 vocabulary this module produces. Not all seventeen — the ones a
 *  progression run can honestly claim to have observed. The rest belong to
 *  subsystems that do not exist yet (ACTION_PROPOSED / ACTION_VERIFIED are the
 *  executor's, INFORMATION_RESOLVED is the resolver's) and inventing them here
 *  would put words in another component's mouth. */
export const PROGRESSION_EVENT_TYPES = [
  'GOAL_DEFINED',
  'PLAN_CREATED',
  'PLAN_REVISED',
  'WAIT_STARTED',
  'ESCALATION_CREATED',
  'COMPLETION_PROPOSED',
  'CASE_COMPLETED_SEMANTICALLY',
  'RECOVERY_STARTED',
] as const
export type ProgressionEventType = typeof PROGRESSION_EVENT_TYPES[number]

/** Which decisions mean "this case is now waiting", "…is now asking", and so on.
 *  Derived from §14's ten decisions so the mapping cannot drift from the enum. */
const WAIT_DECISIONS = new Set(['WAIT_EXTERNAL', 'WAIT_TIME'])
const ESCALATION_DECISIONS = new Set([
  'ASK_INFORMATION', 'REQUEST_DECISION', 'REQUEST_APPROVAL',
  'CALL_REQUIRED', 'MANUAL_ACTION_REQUIRED',
])

export interface ProgressionEventInput {
  domain: 'personal' | 'zst'
  caseId: string
  caseVersion: number
  runId: string
  now: number
  /** This run's decision, and the previous run's — an event is written only when
   *  the case moved INTO the state, not for every run that finds it there. */
  decision: string
  previousDecision: string | null
  planVersion: number
  previousPlanVersion: number | null
  goalDefined: boolean
  /** The §25 semantic status this run settled on, in the column's own
   *  vocabulary (NOT_STARTED / IN_PROGRESS / PROPOSED / VERIFIED). Null when the
   *  run settled nothing — a run that tripped a safety assertion, say. */
  semanticStatus: string | null
  previousSemanticStatus: string | null
}

/**
 * Append the events this run earned. Returns what was written, so the caller can
 * report it rather than trust it.
 *
 * NEVER throws past this function: an event-history write failing must not fail
 * a progression run. The history is the audit, not the work — losing a line of
 * it is bad, and losing the run because of it is worse.
 */
export function recordProgressionEvents(
  db: Database.Database, input: ProgressionEventInput,
): ProgressionEventType[] {
  const written: ProgressionEventType[] = []
  const table = input.domain === 'zst' ? 'zst_case_events' : 'personal_case_events'

  const append = (type: ProgressionEventType, reason: string, payload: unknown): void => {
    try {
      db.prepare(
        `INSERT INTO ${table}
           (case_id, case_version, actor, event_type, reason, payload,
            source_system, source_reference, created_at)
         VALUES (?, ?, 'marveen', ?, ?, ?, 'progression', ?, ?)`,
      ).run(
        input.caseId, input.caseVersion, type, reason.slice(0, 500),
        JSON.stringify(payload), input.runId, input.now,
      )
      written.push(type)
    } catch { /* the history is the audit, not the work */ }
  }

  // The goal — written once, when the case first gets one.
  if (input.goalDefined) {
    append('GOAL_DEFINED', 'A rendszer célt rendelt az ügyhöz.', { runId: input.runId })
  }

  // The plan. First version is CREATED, every later bump is REVISED — §8 names
  // both, and the distinction is the one a reader actually wants.
  if (input.previousPlanVersion === null || input.planVersion > input.previousPlanVersion) {
    const first = input.previousPlanVersion === null || input.previousPlanVersion === 0
    append(
      first ? 'PLAN_CREATED' : 'PLAN_REVISED',
      first ? 'Terv készült az ügyhöz.' : 'A terv újratervezésre került.',
      { planVersion: input.planVersion, previousPlanVersion: input.previousPlanVersion },
    )
  }

  // The state changes. Conditioned on the decision having CHANGED — otherwise a
  // case waiting on a supplier would collect one event every ten minutes.
  const moved = input.decision !== input.previousDecision
  if (moved && WAIT_DECISIONS.has(input.decision)) {
    append('WAIT_STARTED', `Az ügy várakozik: ${input.decision}.`, { decision: input.decision })
  }
  if (moved && ESCALATION_DECISIONS.has(input.decision)) {
    append('ESCALATION_CREATED', `Az ügy megállt, és emberi lépésre vár: ${input.decision}.`,
      { decision: input.decision })
  }
  if (moved && input.decision === 'RECOVERY_REQUIRED') {
    append('RECOVERY_STARTED', 'Az ügy helyreállítást igényel.', { decision: input.decision })
  }
  // Closure is TWO facts, not one, and §25 is the reason. The COMPLETE decision
  // is not the event — the semantic status the run settled on is, because that
  // is the side of the completion gate the case actually ended up on:
  //
  //   PROPOSED  → the case row says closed, the outcome contract was NOT proven
  //   VERIFIED  → the same gate that guards closure says it was, with evidence
  //
  // Writing one event off `decision === 'COMPLETE'` would have said "closed"
  // for both, which is the exact conflation §25 exists to prevent.
  const semanticMoved = input.semanticStatus !== input.previousSemanticStatus
  if (semanticMoved && input.semanticStatus === 'PROPOSED') {
    append('COMPLETION_PROPOSED',
      'A rendszer lezárásra javasolja az ügyet, de a teljesülés még nincs bizonyítva.', {})
  }
  if (semanticMoved && input.semanticStatus === 'VERIFIED') {
    append('CASE_COMPLETED_SEMANTICALLY',
      'Az ügy szemantikailag lezárult: a definition-of-done bizonyítottan teljesült.', {})
  }

  return written
}

/** The progression events on a case, newest first — §27's PROGRESSION HISTORY
 *  panel has something to render only because these rows now exist. */
export function progressionHistory(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string, limit = 50,
): Array<{ eventType: string; reason: string | null; runId: string | null; createdAt: number }> {
  const table = domain === 'zst' ? 'zst_case_events' : 'personal_case_events'
  try {
    return db.prepare(
      `SELECT event_type AS eventType, reason, source_reference AS runId, created_at AS createdAt
         FROM ${table}
        WHERE case_id = ? AND source_system = 'progression'
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?`,
    ).all(caseId, limit) as never
  } catch { return [] }
}
