// Personal Chief of Staff (COS) — §10.7 reopen, which did not exist.
//
// THE INVESTIGATION, 2026-08-26, because the P1 audit recorded this as UNKNOWN
// rather than absent and the owner asked for evidence before a verdict. Three
// independent instruments, and they agree:
//
//   1. GREP. `reopen` across src/ and scripts/ hits CostOps accounting periods
//      (a different domain entirely) and exactly one COS site:
//      `proactive-case-bridge.matchCase`, which can return a
//      `RECENTLY_COMPLETED_REOPEN` tier.
//   2. CALLERS. `matchCase` has no production caller. Only tests import it. And
//      even called, it returns a tier and a case id — it transitions nothing,
//      records no reason, sets no next action.
//   3. THE LIVE HISTORY, which is the instrument that settles it. Eighty
//      transitions out of COMPLETED exist in the event log. Every one of them
//      belongs to two bulk repair sweeps (2026-08-09 19:12 and 2026-08-10
//      03:53, actor `marveen`, cleaning up after the mass-closure incident) and
//      one baseline import (2026-08-24, actor `marveen-baseline-import`). Not
//      one was produced by an engine actor, and no reopen reason was recorded
//      for any of them.
//
// WHAT INSTRUMENT 3 CANNOT SEE, stated because an absence proved with the wrong
// instrument is free and worthless: it cannot distinguish "no reopen path
// exists" from "one exists and no case has ever met its condition". Instrument 2
// is what closes that gap — a path with no caller cannot have fired.
//
// Verdict: ABSENT. So this module is the §10.7 mechanism, built.
//
// WHAT A REOPEN HAS TO GET RIGHT, and what each rule is defending against:
//
//   IT NEEDS A REASON AND A SOURCE. The eighty transitions above are what a
//   reopen looks like when nothing requires either: a bulk status rewrite,
//   indistinguishable in the log from a considered decision. A reopen that
//   cannot say what contradicted the completion is a repair pretending to be a
//   judgement.
//
//   THE COMPLETION SURVIVES. `completed_at` is cleared on the row — a live case
//   has not completed, and leaving it set is exactly the inconsistency the live
//   store already carries in 65 rows from those repair sweeps. The FACT is
//   preserved where facts belong: the append-only event log keeps the original
//   STATUS_CHANGED, and the CASE_REOPENED event carries the completion
//   timestamp it superseded.
//
//   IT REOPENS TO "NEEDS A LOOK", NOT TO A DECISION. TRIAGE (personal) /
//   TRIAGE_REQUIRED (ZST). Contradictory evidence means the completion was
//   wrong; it does not mean we know what is right. Choosing EXECUTING here
//   would be the reopen deciding the case, which is the engine's job.
//
//   THE ENGINE IS RE-ARMED, NOT RUN. Progression is switched back on and the
//   case is scheduled for now. The next action comes from the engine's next
//   run, because a reopen that writes its own next action is a second decision
//   maker on the same fact — the disease P1 spent its whole packet removing.

import type Database from 'better-sqlite3'
import { transitionCase, appendCaseEvent, getCase } from './case-store.js'
import { transitionZstCase, appendZstCaseEvent, getZstCase } from './zst-case-store.js'
import { REOPEN_WINDOW_SEC } from './proactive-case-bridge.js'
import { projectCase, type ProjectionDomain } from './case-projection.js'

export type ReopenDomain = ProjectionDomain

/** Where a reopened case lands. Deliberately the triage status of each
 *  namespace: "this needs re-examination", not "we know what to do".
 *
 *  Two spellings because the two namespaces have two, which the P1 audit
 *  already flagged (§3.4, `INFO_REQUIRED` vs `INFORMATION_REQUIRED`). Written
 *  here rather than derived because these are a POLICY choice about where a
 *  reopen lands, not a fact about the vocabulary — and a test asserts both are
 *  real statuses in their namespace's CHECK constraint. */
export const REOPEN_TARGET_STATUS: Record<ReopenDomain, string> = {
  personal: 'TRIAGE',
  zst: 'TRIAGE_REQUIRED',
}

export type ReopenRefusal =
  | 'NO_SUCH_CASE'
  | 'NOT_COMPLETED'
  | 'REASON_REQUIRED'
  | 'EVIDENCE_REQUIRED'
  | 'OUTSIDE_REOPEN_WINDOW'

export interface ReopenEvidence {
  /** Where the contradicting evidence came from (gmail, calendar, owner, …). */
  sourceSystem: string
  /** The thing itself: a message id, an event id, a document id. */
  sourceReference: string
}

export interface ReopenInput {
  domain: ReopenDomain
  caseId: string
  /** What contradicted the completion. Required, and not a formality: see the
   *  header. */
  reason: string
  actor: string
  evidence: ReopenEvidence
  /** Reopen a case completed longer ago than the window anyway. Recorded on the
   *  event, never silent. */
  force?: boolean
}

export interface ReopenResult {
  ok: boolean
  caseId: string
  refusal?: ReopenRefusal
  /** Why, in words, for the caller and for the log. */
  detail?: string
  newStatus?: string
  newVersion?: number
  /** The completion this reopen superseded. Returned so a caller can show it. */
  supersededCompletedAt?: number | null
}

/**
 * Reopen a COMPLETED case because something contradicts its completion.
 *
 * Refuses rather than guesses, in five ways, and every refusal names itself so
 * a caller can tell them apart. A single boolean here would make "you may not
 * reopen a year-old case" indistinguishable from "that case does not exist".
 */
export function reopenCase(
  db: Database.Database,
  input: ReopenInput,
  now: number,
): ReopenResult {
  const { domain, caseId } = input
  const get = domain === 'personal' ? getCase : getZstCase
  const row = get(db, caseId) as
    { version: number; status: string; completed_at: number | null } | undefined
  if (!row) return { ok: false, caseId, refusal: 'NO_SUCH_CASE', detail: `nincs ilyen ügy: ${caseId}` }
  if (row.status !== 'COMPLETED') {
    return {
      ok: false, caseId, refusal: 'NOT_COMPLETED',
      detail: `az ügy nem lezárt, hanem ${row.status} — nincs mit újranyitni`,
    }
  }
  if (!input.reason?.trim()) {
    return {
      ok: false, caseId, refusal: 'REASON_REQUIRED',
      detail: 'egy indok nélküli újranyitás megkülönböztethetetlen egy tömeges státusz-átírástól',
    }
  }
  if (!input.evidence?.sourceSystem?.trim() || !input.evidence?.sourceReference?.trim()) {
    return {
      ok: false, caseId, refusal: 'EVIDENCE_REQUIRED',
      detail: 'meg kell nevezni, MI mond ellent a lezárásnak (forrásrendszer + hivatkozás)',
    }
  }
  const age = row.completed_at === null ? null : now - row.completed_at
  if (!input.force && age !== null && age > REOPEN_WINDOW_SEC) {
    return {
      ok: false, caseId, refusal: 'OUTSIDE_REOPEN_WINDOW',
      detail: `${Math.floor(age / 86400)} napja lezárva, a határ ${Math.floor(REOPEN_WINDOW_SEC / 86400)} nap `
        + '— egy régen lezárt ügy újranyitása nem folytatás, hanem feltámasztás. force kell hozzá.',
    }
  }

  const transition = domain === 'personal' ? transitionCase : transitionZstCase
  const append = domain === 'personal' ? appendCaseEvent : appendZstCaseEvent
  const table = domain === 'personal' ? 'personal_cases' : 'zst_cases'
  const target = REOPEN_TARGET_STATUS[domain]
  const supersededCompletedAt = row.completed_at

  const newVersion = db.transaction((): number => {
    const v = transition(db, {
      caseId, newStatus: target as never, actor: input.actor,
      seenVersion: row.version, reason: input.reason,
    }, now)

    // The row describes the CURRENT state, and a live case has not completed.
    // Not patchable through transitionCase on purpose — `completed_at` is set
    // by the engine on entering COMPLETED and this is the only place that
    // clears it. The fact is not lost: the event below carries it, and the
    // original STATUS_CHANGED is still in the append-only log.
    db.prepare(`UPDATE ${table} SET completed_at = NULL WHERE case_id = ?`).run(caseId)

    append(db, {
      caseId, caseVersion: v, actor: input.actor,
      eventType: 'CASE_REOPENED',
      reason: input.reason,
      sourceSystem: input.evidence.sourceSystem,
      sourceReference: input.evidence.sourceReference,
      payload: {
        supersededCompletedAt,
        reopenedTo: target,
        forced: input.force === true,
        ageDays: age === null ? null : Math.floor(age / 86400),
      },
    }, now)

    // Re-arm the engine. It decides what happens next; this does not.
    db.prepare(
      `UPDATE case_progression_state
          SET progression_enabled = 1,
              progression_mode = CASE WHEN progression_mode = 'off' THEN 'internal' ELSE progression_mode END,
              semantic_completion_status = 'IN_PROGRESS',
              next_progression_at = ?, updated_at = ?
        WHERE domain = ? AND case_id = ?`,
    ).run(now, now, domain, caseId)
    return v
  })()

  // Board and engine agree again before anyone reads either.
  projectCase(db, domain, caseId, now)

  return {
    ok: true, caseId, newStatus: target, newVersion, supersededCompletedAt,
  }
}
