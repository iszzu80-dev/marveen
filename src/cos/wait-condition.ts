// Personal Chief of Staff (COS) — §10.4 typed wait conditions.
//
// WHAT THE P1 AUDIT GOT WRONG ABOUT THIS, because the correction is the design.
//
// The audit called `wait_system_json` "a wake system with no writer, this
// codebase's signature defect, third instance", and corroborated it with
// WAIT_TIME appearing once in 17 343 runs against WAIT_EXTERNAL's 4 457. Both
// halves were wrong, and both were wrong in a way that mattered:
//
//   `wait_system_json` HAS a writer, a reader and a clearer, all in
//   capability-preflight.ts, and it means one specific thing: this case is
//   parked because a CAPABILITY is unavailable. It is empty because that branch
//   is UNREACHABLE -- `preflight` returns ok immediately when no capabilities
//   are declared, and no caller anywhere declares any. Built at both ends and
//   inert in the middle, which is the signature defect after all, just not the
//   one that was written down.
//
//   WAIT_TIME is rare for a reason that has nothing to do with typed waiting.
//   `decide()` returns WAIT_TIME only when `context.nextWakeAt !== null`, and
//   `next_wake_at` is 0 of 122 on the live store. So the decision engine's
//   discriminator between "waiting on a clock we hold" and "waiting on the
//   world" was a column nothing fills -- the SAME column P1 found is also an
//   owner appointment that the wake alert posts and clears, and also part of
//   the §10.8 dedup hash. Three consumers, three meanings, one column, almost
//   never written.
//
// So this module is not a backfill of an empty field. It is the fact that
// decision was missing: a durable, typed statement of WHAT this case is waiting
// for, WHEN it is expected, WHAT would settle it, and WHAT happens if that never
// arrives.
//
// FIVE PROPERTIES, which are the owner's acceptance conditions for P2:
//
//   A WRITER          — every WAIT_* decision arms one, or the run fails.
//   A DURABLE CONDITION — a row, not a JSON blob on the side, so a wait can be
//                       counted, queried and audited after it resolves.
//   AN EVALUATOR      — something reads it and answers satisfied / expired /
//                       still waiting, with the evidence that settled it.
//   AN IDEMPOTENT WAKE — resolving twice is a no-op, recorded against the run
//                       that consumed it.
//   STALE SAFETY      — §10.2 Invariant C. Every condition carries a stale
//                       review, including the event-only ones. An event that
//                       never arrives must not park a case for ever in silence.
//
// KINDS WITHOUT A DETECTOR ARE REFUSED, NOT FAKED. COMMITMENT needs the §11
// promise tracker, which is Phase 2's and does not exist; POLICY_CHANGE has no
// source at all. Arming either would put a row in the table that nothing could
// ever resolve -- a wait that looks typed and is actually a silent park. The
// owner's words for P2 were "fake backfill nem acceptance", and a kind with no
// evaluator is the same thing one layer down.

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export type WaitDomain = 'personal' | 'zst'

/** The seven §10.4 wake triggers, named as the spec names them. */
export const WAIT_KINDS = [
  'EVENT', 'NEW_EVIDENCE', 'SCHEDULED_REVIEW', 'DEADLINE',
  'COMMITMENT', 'EXTERNAL_RESPONSE', 'POLICY_CHANGE',
] as const
export type WaitKind = typeof WAIT_KINDS[number]

/** Kinds this module can actually EVALUATE today. The others are refused at arm
 *  time. Exported so a test can assert the refusal list and the evaluator agree
 *  — a kind that can be armed and never resolved is worse than one that cannot
 *  be armed at all. */
export const EVALUABLE_KINDS: readonly WaitKind[] = [
  'EVENT', 'NEW_EVIDENCE', 'SCHEDULED_REVIEW', 'DEADLINE', 'EXTERNAL_RESPONSE',
]

export type WakePolicy = 'TIMER' | 'EVENT_ONLY' | 'EITHER'

/** How long an event-only wait may sit before somebody must look at it. */
export const DEFAULT_STALE_REVIEW_SEC = 7 * 86400

export interface WaitConditionRow {
  wait_id: string
  domain: WaitDomain
  case_id: string
  kind: WaitKind
  subject: string
  expected_by: number | null
  evidence_predicate_json: string
  resolution_mode: WakePolicy
  stale_review_at: number
  armed_event_id: number | null
  armed_at: number
  armed_run_id: string | null
  resolved_at: number | null
  resolution: string | null
  resolution_detail: string | null
  resolved_run_id: string | null
}

export interface ArmInput {
  domain: WaitDomain
  caseId: string
  kind: WaitKind
  subject: string
  expectedBy?: number | null
  wakePolicy?: WakePolicy
  staleReviewAt?: number
  runId?: string
}

export type ArmRefusal =
  | 'UNEVALUABLE_KIND'
  | 'NO_SUBJECT'
  | 'NO_DEADLINE_FOR_TIMED_WAIT'
  | 'STALE_REVIEW_BEFORE_NOW'

export interface ArmResult {
  ok: boolean
  waitId?: string
  refusal?: ArmRefusal
  detail?: string
  /** The condition this one replaced, if the case already had a live wait. */
  supersededWaitId?: string
}

function eventsTable(domain: WaitDomain): string {
  return domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
}

function latestEventId(db: Database.Database, domain: WaitDomain, caseId: string): number | null {
  try {
    const r = db.prepare(
      `SELECT MAX(event_id) AS id FROM ${eventsTable(domain)} WHERE case_id = ?`,
    ).get(caseId) as { id: number | null } | undefined
    return r?.id ?? null
  } catch { return null }
}

/** The predicate, as data. Kept as JSON rather than code so a condition written
 *  today is still readable by an evaluator changed tomorrow, and so a human
 *  reading the row can see what the machine was waiting for. */
function predicateFor(kind: WaitKind, subject: string, expectedBy: number | null): string {
  switch (kind) {
    case 'EXTERNAL_RESPONSE':
      return JSON.stringify({ test: 'CASE_EVENT_AFTER_ARM', from: subject })
    case 'EVENT':
      return JSON.stringify({ test: 'CASE_EVENT_AFTER_ARM' })
    case 'NEW_EVIDENCE':
      return JSON.stringify({ test: 'EVIDENCE_PACKET_AFTER_ARM' })
    case 'SCHEDULED_REVIEW':
      return JSON.stringify({ test: 'CLOCK', at: expectedBy })
    case 'DEADLINE':
      return JSON.stringify({ test: 'CLOCK', at: expectedBy })
    default:
      return JSON.stringify({ test: 'NONE' })
  }
}

/**
 * Arm a wait condition on a case, superseding any live one.
 *
 * Refuses rather than writes an unresolvable row. Every refusal names itself:
 * a caller has to be able to tell "that kind has no detector" from "you gave me
 * a timed wait with no deadline", because the fixes are different.
 */
export function armWaitCondition(
  db: Database.Database,
  input: ArmInput,
  now: number,
): ArmResult {
  const { domain, caseId, kind } = input
  if (!EVALUABLE_KINDS.includes(kind)) {
    return {
      ok: false, refusal: 'UNEVALUABLE_KIND',
      detail: `a(z) ${kind} típusú várakozásnak nincs kiértékelője — egy soha fel nem oldható `
        + 'sor rosszabb, mint egy meg nem írt sor, mert tipizáltnak látszik',
    }
  }
  const subject = (input.subject ?? '').trim()
  if (!subject) {
    return { ok: false, refusal: 'NO_SUBJECT', detail: 'meg kell nevezni, MIRE várunk' }
  }
  const policy: WakePolicy = input.wakePolicy ?? 'EITHER'
  const expectedBy = input.expectedBy ?? null
  if (policy !== 'EVENT_ONLY' && expectedBy === null) {
    return {
      ok: false, refusal: 'NO_DEADLINE_FOR_TIMED_WAIT',
      detail: `${policy} házirendhez határidő kell — óra nélkül semmi nem zárja le`,
    }
  }
  // Invariant C, enforced rather than documented: even an event-only wait
  // carries a review, so an event that never comes cannot park a case in
  // silence for ever.
  const staleReviewAt = input.staleReviewAt
    ?? (expectedBy !== null ? expectedBy : now + DEFAULT_STALE_REVIEW_SEC)
  if (staleReviewAt <= now) {
    return {
      ok: false, refusal: 'STALE_REVIEW_BEFORE_NOW',
      detail: 'a felülvizsgálat ideje már elmúlt, mielőtt a várakozás elkezdődött volna',
    }
  }

  const live = activeWaitCondition(db, domain, caseId)
  const waitId = randomUUID()
  db.transaction(() => {
    if (live) {
      // Superseded, not deleted. The previous wait is part of the case's
      // history: "we waited for X, then the situation changed" is a fact.
      db.prepare(
        `UPDATE case_wait_conditions
            SET resolved_at = ?, resolution = 'SUPERSEDED', resolution_detail = ?,
                resolved_run_id = ?
          WHERE wait_id = ?`,
      ).run(now, `felváltotta: ${kind} / ${subject}`, input.runId ?? null, live.wait_id)
    }
    db.prepare(
      `INSERT INTO case_wait_conditions
         (wait_id, domain, case_id, kind, subject, expected_by, evidence_predicate_json,
          resolution_mode, stale_review_at, armed_event_id, armed_at, armed_run_id)
       VALUES (@waitId, @domain, @caseId, @kind, @subject, @expectedBy, @predicate,
          @policy, @staleReviewAt, @armedEventId, @now, @runId)`,
    ).run({
      waitId, domain, caseId, kind, subject, expectedBy,
      predicate: predicateFor(kind, subject, expectedBy),
      policy, staleReviewAt,
      armedEventId: latestEventId(db, domain, caseId),
      now, runId: input.runId ?? null,
    })
  })()
  return { ok: true, waitId, supersededWaitId: live?.wait_id }
}

export function activeWaitCondition(
  db: Database.Database, domain: WaitDomain, caseId: string,
): WaitConditionRow | undefined {
  try {
    return db.prepare(
      `SELECT * FROM case_wait_conditions
        WHERE domain = ? AND case_id = ? AND resolved_at IS NULL`,
    ).get(domain, caseId) as WaitConditionRow | undefined
  } catch { return undefined }
}

export type WaitVerdict = 'SATISFIED' | 'EXPIRED' | 'WAITING' | 'NONE'

export interface WaitEvaluation {
  verdict: WaitVerdict
  waitId?: string
  kind?: WaitKind
  /** What settled it, in words. Empty for WAITING. */
  detail: string
  /** The evidence, when something satisfied it. */
  evidence?: { eventId?: number; at?: number }
}

/**
 * Read-only. Does this case's wait still hold?
 *
 * SEPARATE FROM RESOLVING IT on purpose. The trigger needs to ask "is this case
 * due?" on every sweep without consuming anything, and a query with a side
 * effect would make the answer depend on who asked first.
 */
export function evaluateWaitCondition(
  db: Database.Database, domain: WaitDomain, caseId: string, now: number,
): WaitEvaluation {
  const w = activeWaitCondition(db, domain, caseId)
  if (!w) return { verdict: 'NONE', detail: '' }

  const clockDue = w.expected_by !== null && now >= w.expected_by
  const eventEvidence = (): { eventId: number; at: number } | null => {
    if (w.kind !== 'EVENT' && w.kind !== 'EXTERNAL_RESPONSE' && w.kind !== 'NEW_EVIDENCE') return null
    try {
      const r = db.prepare(
        `SELECT event_id AS id, created_at AS at FROM ${eventsTable(domain)}
          WHERE case_id = ? AND event_id > ? ORDER BY event_id LIMIT 1`,
      ).get(caseId, w.armed_event_id ?? 0) as { id: number; at: number } | undefined
      return r ? { eventId: r.id, at: r.at } : null
    } catch { return null }
  }

  if (w.resolution_mode !== 'EVENT_ONLY' && clockDue) {
    return {
      verdict: 'SATISFIED', waitId: w.wait_id, kind: w.kind,
      detail: `az óra lejárt (${w.expected_by})`,
    }
  }
  if (w.resolution_mode !== 'TIMER') {
    const ev = eventEvidence()
    if (ev) {
      return {
        verdict: 'SATISFIED', waitId: w.wait_id, kind: w.kind,
        detail: `új esemény érkezett az ügyön (event ${ev.eventId})`,
        evidence: { eventId: ev.eventId, at: ev.at },
      }
    }
  }
  // STALE SAFETY. Nothing satisfied it and the review time has passed: the wait
  // has not been met, and saying so is the whole point of Invariant C. EXPIRED
  // is deliberately not SATISFIED -- they mean opposite things to the engine.
  if (now >= w.stale_review_at) {
    return {
      verdict: 'EXPIRED', waitId: w.wait_id, kind: w.kind,
      detail: `a várakozás felülvizsgálati ideje lejárt (${w.stale_review_at}) anélkül, hogy bármi teljesítette volna`,
    }
  }
  return { verdict: 'WAITING', waitId: w.wait_id, kind: w.kind, detail: '' }
}

export interface ResolveResult {
  resolved: boolean
  /** True when this call did nothing because the condition was already
   *  resolved. The idempotency receipt: a second wake is not a wake. */
  alreadyResolved: boolean
  waitId?: string
  resolution?: string
}

/**
 * Consume a wake.
 *
 * IDEMPOTENT BY THE WHERE CLAUSE, not by a check-then-act. Two runners
 * evaluating the same satisfied condition both call this; exactly one changes a
 * row, and the other is told so rather than being allowed to believe it woke the
 * case. `resolved_run_id` records which one it was.
 */
export function resolveWaitCondition(
  db: Database.Database,
  domain: WaitDomain,
  caseId: string,
  resolution: 'SATISFIED' | 'EXPIRED' | 'CANCELLED',
  detail: string,
  runId: string | null,
  now: number,
): ResolveResult {
  const w = activeWaitCondition(db, domain, caseId)
  if (!w) return { resolved: false, alreadyResolved: true }
  return resolveWaitById(db, w.wait_id, resolution, detail, runId, now)
}

/**
 * Resolve a condition the caller has ALREADY READ, by id.
 *
 * Extracted so the idempotency guard can be driven on its own. There are two of
 * them: `resolveWaitCondition` looks the row up first and returns early if it is
 * gone, and this statement's WHERE clause refuses a row that was resolved
 * between the read and the write. A mutation removing the WHERE clause survived
 * the first test suite, because the only test for idempotency called the
 * lookup-first path twice and never reached the statement.
 *
 * The two answer different questions. The early return answers "was it already
 * resolved when I looked". Only the WHERE clause answers "did somebody resolve
 * it while I was deciding" -- which is the actual race, because two sweeps can
 * evaluate the same satisfied condition at the same moment.
 */
export function resolveWaitById(
  db: Database.Database,
  waitId: string,
  resolution: 'SATISFIED' | 'EXPIRED' | 'CANCELLED',
  detail: string,
  runId: string | null,
  now: number,
): ResolveResult {
  const info = db.prepare(
    `UPDATE case_wait_conditions
        SET resolved_at = @now, resolution = @resolution, resolution_detail = @detail,
            resolved_run_id = @runId
      WHERE wait_id = @waitId AND resolved_at IS NULL`,
  ).run({ now, resolution, detail, runId, waitId })
  return {
    resolved: info.changes === 1,
    alreadyResolved: info.changes === 0,
    waitId,
    resolution,
  }
}

/** Every case whose wait is satisfied or expired right now. The wake engine's
 *  read side: a case wakes because its CONDITION says so, not only because a
 *  timer fired. */
export function dueWaitConditions(
  db: Database.Database, now: number, limit = 500,
): Array<{ domain: WaitDomain; caseId: string; verdict: WaitVerdict; detail: string }> {
  let rows: Array<{ domain: WaitDomain; case_id: string }>
  try {
    rows = db.prepare(
      `SELECT domain, case_id FROM case_wait_conditions
        WHERE resolved_at IS NULL LIMIT ?`,
    ).all(limit) as Array<{ domain: WaitDomain; case_id: string }>
  } catch { return [] }
  const out: Array<{ domain: WaitDomain; caseId: string; verdict: WaitVerdict; detail: string }> = []
  for (const r of rows) {
    const e = evaluateWaitCondition(db, r.domain, r.case_id, now)
    if (e.verdict === 'SATISFIED' || e.verdict === 'EXPIRED') {
      out.push({ domain: r.domain, caseId: r.case_id, verdict: e.verdict, detail: e.detail })
    }
  }
  return out
}
