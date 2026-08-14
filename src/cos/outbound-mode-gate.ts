// Personal Chief of Staff (COS) — what a case's progression_mode actually permits
// on the OUTBOUND path.
//
// Owner decision, Istvan, 2026-08-14 22:54, in these words: automatic approval is
// possible IN PRINCIPLE, not today and not soon, "but the system has to know the
// difference". Build the fifth mode. `external_shadow` = may compose, but the
// approval may NEVER run by itself; `live` = the approval may run too. Moving a
// case to live is a separate decision, per case type.
//
// WHY THIS FILE EXISTS AT ALL (card fa36dc4b). `progression_mode` has had five
// values since the schema was written, and NO production code branched on the
// VALUE — the real switch was the boolean progression_enabled. Harmless while
// there is no outbound path, and exactly the wrong kind of harmless: it LOOKS
// like the safety switch. The first day an outbound adapter lands, somebody sets
// a case to shadow believing they held it back, and they did not.
//
// ── THE MEASUREMENT THAT SHAPED THIS, because it nearly went the other way ──
//
// The agreed taxonomy reads:
//   shadow           the pipeline does not reach the composer — no ledger, no letter
//   internal         writes case state, but does not reach the composer
//   external_shadow  may compose -> a PLANNED row, but the approval cannot be automatic
//   live             may compose, and the approval may run
//
// Measured on the live store before writing a line: ALL 115 rows in
// case_progression_state are `internal`. Not one `off`, `external_shadow` or
// `live`. And the single real letter waiting in the ledger tonight
// (r.markschlaeger@aims-germany.com) belongs to a case that is `internal`.
//
// So a gate that simply reads "internal => must not compose" and sits inside
// draftSend would have silently switched off the only outbound behaviour the
// system actually has. It would have looked like a safety improvement and been a
// regression, discoverable only by noticing that letters stopped appearing.
//
// The resolution is that the mode governs the PROGRESSION-DRIVEN outbound path.
// The follow-up sweep that runs today is not that path: it is the older,
// separately gated route (existing conversation only, ball with them, past the
// grace period, at most two — followup-autodraft.ts). Both are real, and they are
// not the same thing.
//
// Hence ORIGIN. Every caller of the composer must say which path it is, the gate
// answers per origin, and the carve-out is a NAMED case with a reason rather than
// a silent default. A permissive default here would be the same shape as the bug
// this file exists to fix: something that reads as covered and is not.
//
// ── THE ASYMMETRY, stated because it is deliberate ──
//
// Composing already exists and already has a gate, so the mode must not be the
// thing that quietly turns it off: an unknown/ungoverned case keeps composing
// under its existing rules.
//
// Automatic approval does NOT exist yet. It is a brand new capability, so it
// starts CLOSED and only `live` opens it. An unknown mode, a missing row, a case
// nobody classified: all denied. The two defaults point in opposite directions on
// purpose, because one of them protects a working behaviour and the other one
// protects Istvan's signature.

import type Database from 'better-sqlite3'

/** The five values the schema has allowed all along (schema.ts CHECK). */
export type ProgressionMode = 'off' | 'shadow' | 'internal' | 'external_shadow' | 'live'

/**
 * WHICH path is asking. Required at every call site, so a new outbound route has
 * to state what it is instead of inheriting a default that happens to permit it.
 */
export type OutboundOrigin =
  /** The progression pipeline acting on its own. This is what the mode governs. */
  | 'progression'
  /** The pre-existing follow-up sweep (followup-autodraft.ts): an already-running
   *  conversation, the ball with them, past the grace period, capped at two. Its
   *  own gate is the one that decides; the mode is not it. */
  | 'followup-sweep'
  /** Istvan composing directly from the dashboard. The owner acting in person is
   *  not something a case-level automation flag may veto. */
  | 'owner'

/** Who is pressing approve. Required, so an automated approver cannot pass for a
 *  human by leaving a field unset. */
export type ApprovalInitiator = 'human' | 'automation'

export interface ModeDecision {
  allowed: boolean
  /** Machine-readable, so a refusal can be inspected instead of guessed at. */
  code:
    | 'ok'
    | 'mode_forbids_compose'
    | 'mode_forbids_automatic_approval'
    | 'mode_unknown'
    | 'not_governed_by_mode'
  reason: string
  /** What the case is actually set to, null when it has no progression row. */
  mode: ProgressionMode | null
}

const COMPOSE_ALLOWED: readonly ProgressionMode[] = ['external_shadow', 'live']
const KNOWN_MODES: readonly string[] = ['off', 'shadow', 'internal', 'external_shadow', 'live']
const KNOWN_ORIGINS: readonly string[] = ['progression', 'followup-sweep', 'owner']

/** The case's mode, or null when it has no progression row at all. */
export function progressionModeOf(
  db: Database.Database, domain: string, caseId: string,
): ProgressionMode | null {
  const row = db.prepare(
    `SELECT progression_mode FROM case_progression_state WHERE domain = ? AND case_id = ?`
  ).get(domain, caseId) as { progression_mode: string } | undefined
  if (!row) return null
  return KNOWN_MODES.includes(row.progression_mode)
    ? row.progression_mode as ProgressionMode
    : null
}

/**
 * May this origin compose an outbound action for this case right now?
 *
 * Only `progression` is judged by the mode. The other two origins are named
 * carve-outs with reasons above, and they say so in the returned code — a caller
 * that logs the decision logs WHY it was allowed, not just that it was.
 */
export function mayCompose(
  db: Database.Database, domain: string, caseId: string, origin: OutboundOrigin,
): ModeDecision {
  const mode = progressionModeOf(db, domain, caseId)
  // FAIL CLOSED ON AN ORIGIN NOBODY DECLARED. The required field is enforced by
  // tsc, and tsc only covers `src/**` — `scripts/` is outside the include, so a
  // script calling draftSend without an origin would arrive here with `undefined`
  // and, under a plain `!== 'progression'` test, land in the permissive branch.
  // The type system's guarantee stops at a directory boundary; this check does
  // not. Checked BEFORE the carve-outs, because the carve-outs are the permissive
  // side.
  if (!KNOWN_ORIGINS.includes(origin)) {
    return { allowed: false, code: 'mode_unknown', mode,
      reason: `ismeretlen eredet (${String(origin)}): a kimeno utnak meg kell neveznie magat` }
  }
  if (origin !== 'progression') {
    return { allowed: true, code: 'not_governed_by_mode', mode,
      reason: `${origin}: ennek az utnak sajat kapuja van, a progression_mode nem ez` }
  }
  if (mode === null) {
    // A case the pipeline drives must have been classified. Unclassified means
    // nobody decided, and "nobody decided" is not permission.
    return { allowed: false, code: 'mode_unknown', mode,
      reason: 'az ugynek nincs progression-sora, tehat senki nem dontott rola' }
  }
  if (!COMPOSE_ALLOWED.includes(mode)) {
    return { allowed: false, code: 'mode_forbids_compose', mode,
      reason: `a mod ${mode}: a pipeline nem erheti el a fogalmazo utat` }
  }
  return { allowed: true, code: 'ok', mode, reason: `a mod ${mode}: megfogalmazhat` }
}

/**
 * May an approval run for this case WITHOUT a human pressing it?
 *
 * This is the fifth mode's entire reason to exist. `external_shadow` and `live`
 * are identical everywhere else; here they differ, and Istvan's sentence is the
 * specification: in external_shadow the approval may never run by itself.
 *
 * A human approval is always allowed — including in external_shadow, which is the
 * mode every drafted letter waits in today. Blocking that would not be caution,
 * it would mean nothing could ever be sent.
 */
export function mayApprove(
  db: Database.Database, domain: string, caseId: string, initiator: ApprovalInitiator,
): ModeDecision {
  const mode = progressionModeOf(db, domain, caseId)
  // Same directory-boundary reasoning as mayCompose, and it bites harder here:
  // anything that is not literally 'human' is treated as automation, so an
  // untypechecked caller that omits the field gets the CLOSED side, not the open
  // one. "Nobody said a person pressed it" must never read as "a person pressed it".
  if (initiator === 'human') {
    return { allowed: true, code: 'not_governed_by_mode', mode,
      reason: 'ember hagyja jova: a mod ezt nem korlatozza' }
  }
  // Default-deny from here down. Every branch that is not exactly `live` refuses,
  // including a case with no row and a value the schema would not accept.
  if (mode !== 'live') {
    return { allowed: false, code: 'mode_forbids_automatic_approval', mode,
      reason: mode === null
        ? 'automatikus jovahagyas: az ugynek nincs progression-sora, tehat nem live'
        : `automatikus jovahagyas: a mod ${mode}, es csak a live engedi` }
  }
  return { allowed: true, code: 'ok', mode, reason: 'a mod live: a jovahagyas futhat magatol' }
}

/** Thrown, not returned, when a gate refuses. A composer that returns a
 *  "sorry, no" object is one `if` away from a caller that ignores it; the whole
 *  point of the mode is that it CANNOT be walked past. */
export class OutboundModeRefusal extends Error {
  constructor(public readonly decision: ModeDecision, public readonly caseId: string) {
    super(`outbound mode refusal [${decision.code}] ${caseId}: ${decision.reason}`)
    this.name = 'OutboundModeRefusal'
  }
}
