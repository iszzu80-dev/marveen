// §20 — the Decision Package: the seven things a question has to say.
//
// WHAT THE SPEC ASKS FOR, verbatim:
//
//   Mi az ügy? · Mit intézett Marveen? · Miért állt meg? · Mik az opciók?
//   Mit javasol? · Mi kell Istvántól? · Meddig?
//
// WHAT THE QUESTION SAID BEFORE. Three of the seven: the title, "Amit tudunk",
// and "Ami Tőled kell". Four were missing, and their absence is not cosmetic —
// each one is a reason the owner has to open the case to answer a question that
// was supposed to save him from opening the case:
//
//   "mit intézett"  — he cannot tell whether the system already tried something,
//                     so he re-does work or assumes nothing happened
//   "miért állt meg" — he gets the symptom (what is missing) and not the cause
//   "mik az opciók"  — he is asked an open question where a choice would do
//   "meddig"         — nothing distinguishes "answer this week" from "the
//                     deadline is tomorrow", so everything reads equally urgent,
//                     which is the same as nothing being urgent
//
// EVERY ELEMENT HAS A REAL SOURCE, OR IT IS OMITTED. This is the whole design
// rule of this module and the reason it is deterministic rather than a second
// model call. The judgement already happened — the Reader read the case, the
// planner made the plan, the engine made a decision, and all three are stored.
// Composing them into a sentence is a formatting job, and a model asked to do a
// formatting job will occasionally do a judgement job instead.
//
// So where there is no source, the element is LEFT OUT rather than filled with a
// plausible sentence. A Decision Package that invents options is worse than one
// that has none: the owner would be choosing between things the system made up.
//
// §8 IS WHAT MAKES ELEMENT 2 POSSIBLE. "Mit intézett Marveen?" had no honest
// answer until the progression started writing its own history — before that,
// the only record of the engine's work was case_progression_runs, which is a
// ledger of runs, not a narrative of the case. This module reads the events §8
// now produces, which is the first time the two sections have been able to
// compose.

import type Database from 'better-sqlite3'
import { progressionHistory, type ProgressionEventType } from './progression-events.js'

/** The four elements the question was missing. `null` means "no source said
 *  anything", and the composer omits the line rather than printing an empty
 *  heading. */
export interface DecisionPackage {
  /** §20.2 — what the system has already done on this case, in order. */
  handled: string[]
  /** §20.3 — why it stopped, in the engine's own words (decision + reason). */
  stoppedBecause: string | null
  /** §20.4 — what the owner may answer. Deterministic and small on purpose. */
  options: string[]
  /** §20.5 — what the system suggests, clearly labelled as a suggestion. */
  recommendation: string | null
  /** §20.7 — the date that makes this urgent or not. */
  deadline: { at: number; kind: 'due' | 'follow_up' } | null
}

/** What each progression event means to a human reading "what did it do?".
 *
 *  Deliberately a table and not a template: an event type with no line here
 *  produces NO line, so a new event type cannot leak a raw enum name into a
 *  sentence Istvan reads. */
const HANDLED_LINES: Partial<Record<ProgressionEventType, string>> = {
  GOAL_DEFINED: 'Kiolvastam, mi az ügy célja',
  PLAN_CREATED: 'Tervet készítettem a lezáráshoz',
  PLAN_REVISED: 'Újraterveztem, mert változott a helyzet',
  WAIT_STARTED: 'Vártam a másik félre',
  ESCALATION_CREATED: 'Megálltam, mert emberi lépés kell',
  RECOVERY_STARTED: 'Helyreállítást indítottam',
  COMPLETION_PROPOSED: 'Lezárásra javasoltam',
  CASE_COMPLETED_SEMANTICALLY: 'Lezártam',
}

/** Decisions that mean "the engine stopped and is waiting on a person", with the
 *  cause written the way a person would say it. */
const STOP_REASONS: Record<string, string> = {
  ASK_INFORMATION: 'hiányzik egy információ, amit csak Te tudsz',
  REQUEST_DECISION: 'döntést kell hozni, ami nem az enyém',
  REQUEST_APPROVAL: 'jóváhagyás kell, mielőtt bármi kimegy',
  CALL_REQUIRED: 'telefonálni kell, azt nem tudom megtenni',
  MANUAL_ACTION_REQUIRED: 'olyan lépés kell, amit csak kézzel lehet',
  RECOVERY_REQUIRED: 'egy korábbi lépés kimenetele bizonytalan',
  WAIT_EXTERNAL: 'a másik félre várunk',
  WAIT_TIME: 'egy határidőre várunk',
}

/**
 * Gather the four missing elements for one case.
 *
 * Reads only. Every query is individually guarded: a missing table on a partial
 * install costs that ONE element, not the question — a question with five of
 * seven elements still reaches Istvan, and one that throws reaches nobody.
 */
export function collectDecisionPackage(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string,
): DecisionPackage {
  return {
    handled: whatWasHandled(db, domain, caseId),
    stoppedBecause: whyItStopped(db, domain, caseId),
    options: whatCanBeAnswered(db, domain, caseId),
    recommendation: whatIsSuggested(db, domain, caseId),
    deadline: whenIsItDue(db, domain, caseId),
  }
}

/** §20.2 — the engine's own history, oldest first, one line per distinct thing.
 *
 *  Distinct, because §8 already writes one event per CHANGE rather than per run;
 *  the de-duplication here is the second belt: an older case whose history
 *  predates that rule must not produce "Vártam a másik félre" eleven times. */
function whatWasHandled(db: Database.Database, domain: 'personal' | 'zst', caseId: string): string[] {
  const events = progressionHistory(db, domain, caseId, 40)
  const lines: string[] = []
  const seen = new Set<string>()
  for (const e of [...events].reverse()) {
    const line = HANDLED_LINES[e.eventType as ProgressionEventType]
    if (!line || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }

  // What actually LEFT the machine belongs here too, and it is the half the
  // owner most needs: "I already emailed them" is the difference between him
  // writing the same mail and him waiting.
  try {
    const sent = db.prepare(
      `SELECT action_type, COUNT(*) AS n FROM outbound_ledger
        WHERE case_id = ? AND status IN ('APPLIED_UNVERIFIED','VERIFIED')
        GROUP BY action_type`,
    ).all(caseId) as Array<{ action_type: string; n: number }>
    for (const s of sent) {
      lines.push(s.action_type === 'EMAIL_SEND'
        ? `Kiküldtem ${s.n} levelet az ügyben`
        : `Végrehajtottam ${s.n} külső lépést (${s.action_type})`)
    }
  } catch { /* no ledger on this install — the events alone are still an answer */ }

  return lines
}

/** The newest progression run for this case, or null. */
function latestRun(
  db: Database.Database, domain: string, caseId: string,
): { decision: string | null; reason: string | null } | null {
  try {
    return (db.prepare(
      `SELECT decision, reason FROM case_progression_runs
        WHERE domain = ? AND case_id = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(domain, caseId) as { decision: string | null; reason: string | null } | undefined) ?? null
  } catch { return null }
}

/** §20.3 — the cause, not the symptom.
 *
 *  Prefers the engine's own decision over the case's `blocked_reason`, because
 *  the decision is what the engine ACTED on and the blocked_reason is a note
 *  somebody left. When neither exists there is no honest answer, and the line is
 *  omitted. */
function whyItStopped(db: Database.Database, domain: 'personal' | 'zst', caseId: string): string | null {
  const run = latestRun(db, domain, caseId)
  const named = run?.decision ? STOP_REASONS[run.decision] : undefined
  if (named) return named

  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  try {
    const row = db.prepare(
      `SELECT blocked_reason, waiting_on FROM ${table} WHERE case_id = ?`,
    ).get(caseId) as { blocked_reason: string | null; waiting_on: string | null } | undefined
    if (row?.blocked_reason) return row.blocked_reason
    if (row?.waiting_on) return `${row.waiting_on} válaszára várunk`
  } catch { /* fall through */ }
  return null
}

/** §20.4 — what he may answer, and it is deliberately the SMALL true set.
 *
 *  This is the element most easily faked. A model asked for "the options" will
 *  produce three plausible courses of action, and the owner will then choose
 *  between three things the system invented and cannot carry out.
 *
 *  What is TRUE about the answer channel is narrow and worth saying: the answer
 *  parser recognises exactly a yes, a no, and free text (recordOwnerAnswer's
 *  YES/NO regexes — anything else is stored verbatim as OWNER_INFORMATION). So
 *  the options are the ones the machine can actually distinguish, and they are
 *  listed only when there IS a recommendation to say yes or no TO. Without one,
 *  "igen" answers nothing and printing it would be a lie about what the system
 *  understands. */
function whatCanBeAnswered(db: Database.Database, domain: 'personal' | 'zst', caseId: string): string[] {
  if (!whatIsSuggested(db, domain, caseId)) return []
  return [
    '„igen" — csináljam így',
    '„nem" — ne ezt csináljam',
    'vagy írd le szabadon, mit tegyek',
  ]
}

/** §20.5 — the suggestion, from what the engine already computed.
 *
 *  The next best action is the planner's output, stored on the case, and it is a
 *  concrete sentence about THIS case rather than a decision enum. It is the
 *  honest content of "mit javasol": the system's own next step, which is exactly
 *  what a yes/no would confirm or refuse.
 *
 *  Returns null for a step the engine would take on its own — proposing to
 *  Istvan something that needs no decision from him is how a question becomes
 *  noise. */
function whatIsSuggested(db: Database.Database, domain: 'personal' | 'zst', caseId: string): string | null {
  try {
    const row = db.prepare(
      `SELECT next_best_action_json FROM case_progression_state
        WHERE domain = ? AND case_id = ?`,
    ).get(domain, caseId) as { next_best_action_json: string | null } | undefined
    if (!row?.next_best_action_json) return null
    const nba = JSON.parse(row.next_best_action_json) as
      { description?: unknown; canProceedAutonomously?: unknown }
    if (nba.canProceedAutonomously === true) return null
    const d = typeof nba.description === 'string' ? nba.description.trim() : ''
    return d.length > 0 ? d : null
  } catch { return null }
}

/** §20.7 — the date. `due_at` beats `follow_up_at`: one is a commitment, the
 *  other is a reminder, and reading a reminder as a deadline is how everything
 *  ends up looking equally urgent. */
function whenIsItDue(
  db: Database.Database, domain: 'personal' | 'zst', caseId: string,
): { at: number; kind: 'due' | 'follow_up' } | null {
  const table = domain === 'zst' ? 'zst_cases' : 'personal_cases'
  try {
    const row = db.prepare(
      `SELECT due_at, follow_up_at FROM ${table} WHERE case_id = ?`,
    ).get(caseId) as { due_at: number | null; follow_up_at: number | null } | undefined
    if (row?.due_at) return { at: row.due_at, kind: 'due' }
    if (row?.follow_up_at) return { at: row.follow_up_at, kind: 'follow_up' }
  } catch { /* no such column on this install */ }
  return null
}

/** The deadline as Istvan reads it: the date, and how far away it is.
 *
 *  "2026-08-14 (2 nap múlva)" carries the urgency that a bare date does not, and
 *  a date already past says so rather than quietly looking like a future one. */
export function formatDeadline(d: { at: number; kind: 'due' | 'follow_up' }, now: number): string {
  const date = new Date(d.at * 1000).toISOString().slice(0, 10)
  const days = Math.round((d.at - now) / 86_400)
  const rel = days < 0
    ? `${Math.abs(days)} napja lejárt`
    : days === 0 ? 'ma' : days === 1 ? 'holnap' : `${days} nap múlva`
  const label = d.kind === 'due' ? 'Határidő' : 'Emlékeztető'
  return `${label}: ${date} (${rel})`
}
