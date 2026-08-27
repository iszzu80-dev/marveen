// Personal Chief of Staff (COS) — P1 §10.1/§10.2: one case, one truth.
//
// THE MEASUREMENT THAT OPENED THIS PACKET, 2026-08-26, on the live store:
// Invariant A ("every active case carries a next action, OR a wait condition
// plus a review time") held 166 of 167 inside `case_progression_state` and
// failed 90 of 147 on the case board — 31 personal, 59 ZST. The board was not
// WRONG about those cases. It was silent about them, nothing reconciled the two
// views, and there was no `last_reconciled_at` for anything to notice.
//
// THE ARCHITECTURE, decided by the owner on 2026-08-26 and implemented here
// literally:
//
//     the progression state machine is the SOURCE OF TRUTH;
//     the case board is a PROJECTION of it.
//     No bidirectional field sync. A user-authored change on the projection
//     surface is ingested as an INPUT event; the canonical engine's decision is
//     what projects back.
//
// So this module writes in exactly one direction, into columns that have
// exactly one writer, and it refuses rather than guesses when the two sides
// cannot be reconciled.
//
// WHAT IT DELIBERATELY DOES NOT DO — and this is most of the design
//
// The audit that opened P1 named three board columns as the engine's unwritten
// twins. All three were wrong, each in a different way, and each would have
// broken something live and quiet:
//
//   `next_wake_at` is an APPOINTMENT that `alertWokenCases` posts and then
//   CLEARS. `next_progression_at` is a five-minute poll cadence usually in the
//   past. Copying one into the other would have alerted ~120 cases in one
//   cycle, cleared them, and re-armed them on the next: a permanent alert loop
//   built by the reconciliation that was supposed to end drift.
//
//   `waiting_on` is where `followup-autodraft` regexes the RECIPIENT ADDRESS of
//   a follow-up out of prose that intake wrote ("reply from <address>").
//   Overwriting it with the engine's wait reason disarms follow-up drafting
//   silently, and a bad overwrite would address a draft to the wrong party.
//
//   `next_action` is in `case-link`'s TRUSTED_CASE_FIELDS — identifiers found
//   there auto-link a stranger's incoming mail to a case — and it is precisely
//   what `isUsableRecommendation` REFUSES to put in front of the owner: the
//   engine's next-best-action text is a closed set of internal English plan
//   labels, and "Javaslatom: Execute first recovery action" already reached
//   Istvan once.
//
// Hence: engine-owned `proj_*` columns, and Invariant A carried by the action
// KIND rather than by its text. Whether a next action EXISTS is a fact; the
// English label is a rendering, and a rendering we are not allowed to show does
// not make the fact absent.
//
// ON THE IMPORT CYCLE with progression-pipeline: deliberate and two-node. The
// projection has to know the planner's closed label set, and the pipeline has
// to call the projection at its one choke point. `internalPlanLabels` is a
// hoisted function called at runtime, never at module evaluation, which is the
// condition under which an ESM cycle is safe. The alternative was four call
// sites remembering to project, which is the failure this codebase logs most.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { internalPlanLabels } from './progression-pipeline.js'
import { PERSONAL_STATUS_SETS } from './case-engine-core.js'
import { ZST_STATUS_SETS } from './zst-case-store.js'
import { activeWaitCondition } from './wait-condition.js'
import { stageForCase } from './progress-stage.js'

export type ProjectionDomain = 'personal' | 'zst'

/** The canonical columns whose change bumps `canonical_revision`.
 *
 *  Exported so a test can assert that the trigger in schema.ts watches exactly
 *  this set. A projection reading a field the trigger does not watch would go
 *  stale with the revision saying it is current — silent drift wearing the
 *  badge of freshness. */
export const CANONICAL_PROJECTION_INPUTS = [
  'next_best_action_json',
  'next_progression_at',
  'waiting_on',
  'blocked_reason',
  'wait_system_json',
] as const

/** The board columns this module owns. Nothing else may write them, and it
 *  writes nothing else. */
export const PROJECTED_COLUMNS = [
  'proj_next_action',
  'proj_next_action_kind',
  'proj_next_action_step',
  'proj_wait_condition',
  'proj_next_review_at',
  'proj_blocked_reason',
  // P3: the coarse "whose move is it" stage, DERIVED from the case's own status
  // and written here rather than replacing anything. The 17 + 21 statuses stay
  // exactly as they are -- the owner reads them, and they carry meaning a
  // five-value vocabulary cannot.
  'proj_progress_stage',
] as const

export function caseTableFor(domain: ProjectionDomain): string {
  return domain === 'personal' ? 'personal_cases' : 'zst_cases'
}

/** The ONE failure these read paths are allowed to treat as "nothing to say":
 *  a namespace that has not been migrated on this install.
 *
 *  Written narrow, and driven red, after the first live dry run of this very
 *  module reported `active 0, satisfied 0, violations []` on a board with 146
 *  active cases. The catch was a bare `catch {}` around the query, the database
 *  handle was undefined because the caller never initialised it, and every
 *  query threw -- so a broken instrument printed a perfectly reconciled board.
 *
 *  That is the failure class this entire packet exists to end, produced by the
 *  packet's own code, and it is why the catch now has to NAME what it forgives.
 *  Anything else rethrows: a check that cannot run must not be able to pass. */
function isMissingTable(e: unknown, table: string): boolean {
  const msg = String((e as Error)?.message ?? '')
  return msg.includes('no such table') && msg.includes(table)
}

/** Terminal statuses, taken from the engine that defines them rather than
 *  retyped here. A status added to a namespace tomorrow is covered without
 *  anyone remembering this file. */
export function terminalStatusesFor(domain: ProjectionDomain): readonly string[] {
  return domain === 'personal' ? PERSONAL_STATUS_SETS.terminal : ZST_STATUS_SETS.terminal
}

export interface CanonicalRow {
  domain: ProjectionDomain
  case_id: string
  canonical_revision: number
  next_best_action_json: string | null
  next_progression_at: number | null
  waiting_on: string | null
  blocked_reason: string | null
  wait_system_json: string | null
  progression_enabled: number
  /** The live §10.4 typed wait condition, when the case has one. Read from its
   *  own table rather than from the canonical row, because a wait is a fact
   *  with a lifecycle and the canonical row holds only its current shadow. */
  wait?: { kind: string; subject: string; expected_by: number | null; stale_review_at: number } | null
  /** The case's own lifecycle status, read from the case row. ONE input to the
   *  stage, and listed here explicitly rather than smuggled in: the status is
   *  the case engine's, not the progression state's, and blurring that is how a
   *  projection starts believing it owns a column. */
  status?: string
  /** The P3 stage, already derived from the canonical facts by the caller.
   *  Passed in rather than computed here because `deriveProjection` is pure by
   *  contract and the derivation needs the database. */
  progress_stage?: string | null
}

export interface ProjectedFields {
  proj_next_action: string | null
  proj_next_action_kind: string | null
  proj_next_action_step: number | null
  proj_wait_condition: string | null
  proj_next_review_at: number | null
  proj_blocked_reason: string | null
  /** ACTIONABLE | WAITING | NEEDS_USER | MONITORING | COMPLETED, or null when the
   *  case's status is outside the mapped vocabulary -- which is a fault, not a
   *  state, and must not be given a plausible-looking stage. */
  proj_progress_stage: string | null
}

/** True when this text may be shown to the owner.
 *
 *  The engine's NBA description is copied verbatim from `buildRollingPlan`'s
 *  step labels, so membership in that closed set is not a heuristic about this
 *  string — it is the exact question. A blocklist of yesterday's English words
 *  is what failed here the first time. */
export function isOwnerSafeActionText(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (t.length < 3) return false
  if (internalPlanLabels().has(t)) return false
  // A raw enum leaking through (WAIT_EXTERNAL, RECOVERY_REQUIRED) is machine
  // text too, and it does not come from the planner's set.
  if (/^[A-Z][A-Z0-9_]{4,}$/.test(t)) return false
  return true
}

/** Canonical state -> board fields. Pure: same input, same output, no clock,
 *  no database. Everything the fence and the idempotency check rely on is
 *  decided here. */
export function deriveProjection(c: CanonicalRow): ProjectedFields {
  let kind: string | null = null
  let step: number | null = null
  let text: string | null = null
  if (c.next_best_action_json) {
    try {
      const nba = JSON.parse(c.next_best_action_json) as {
        kind?: unknown; planStep?: unknown; description?: unknown
      }
      kind = typeof nba.kind === 'string' ? nba.kind : null
      step = typeof nba.planStep === 'number' ? nba.planStep : null
      const desc = typeof nba.description === 'string' ? nba.description : null
      // NULL text beside a non-null kind is the designed state, not a gap: the
      // action exists, its only rendering is one we may not show.
      text = desc && isOwnerSafeActionText(desc) ? desc : null
    } catch {
      // Unparseable canonical JSON is a canonical problem. The projection
      // records the absence rather than inventing a shape, and the drift check
      // reports the case as unprojectable.
      kind = null; step = null; text = null
    }
  }
  // §10.4 (P2): when the case carries a TYPED wait condition, the board reads
  // THAT rather than the free-text `waiting_on` and the poll timer.
  //
  // This is what the P1 proof recorded as still-not-true. `next_progression_at`
  // carries two meanings written by two functions -- "arm this wait" and "come
  // back later" -- and in practice every value is the poller's five-minute
  // re-check, so `proj_next_review_at` was a poll timer wearing the name of a
  // review appointment. A typed condition has an actual expected-by and an
  // actual stale review, so it can say when this case is genuinely next due a
  // look. Falls back to the old pair when there is no condition, which is what
  // every case looked like before this packet.
  const wait = c.wait ?? null
  return {
    proj_next_action: text,
    proj_next_action_kind: kind,
    proj_next_action_step: step,
    proj_wait_condition: wait ? `${wait.kind}: ${wait.subject}` : c.waiting_on,
    proj_next_review_at: wait
      ? (wait.expected_by ?? wait.stale_review_at)
      : c.next_progression_at,
    proj_blocked_reason: c.blocked_reason,
    // P3 closure (owner, 2026-08-27): the stage is the summarised state of the
    // canonical progression FACTS, not a table lookup on the status. It is
    // computed by the caller and handed in, because `deriveProjection` is pure
    // by contract -- same input, same output, no database -- and the facts need
    // five reads. Null is a real answer: nothing closed, nobody owes anything,
    // no wait, not monitored, nothing to do.
    proj_progress_stage: c.progress_stage ?? null,
  }
}

/** Fingerprint of the values the projection last wrote. Its job is to tell a
 *  FOREIGN write apart from a stale one: a stale row is behind, a foreign row
 *  was edited by somebody else, and those need opposite responses. */
export function projectionFingerprint(f: ProjectedFields): string {
  const canonical = JSON.stringify([
    f.proj_next_action, f.proj_next_action_kind, f.proj_next_action_step,
    f.proj_wait_condition, f.proj_next_review_at, f.proj_blocked_reason,
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export type ProjectionOutcome =
  | 'PROJECTED'      // the board changed to match canonical
  | 'UNCHANGED'      // already identical; only last_reconciled_at was stamped
  | 'FENCED'         // a newer projection is already on the row; refused
  | 'NO_CANONICAL'   // no progression state for this case
  | 'NO_CASE'        // no board row for this case

export interface ProjectionResult {
  domain: ProjectionDomain
  caseId: string
  outcome: ProjectionOutcome
  canonicalRevision: number | null
  previousProjectedRevision: number | null
  changedFields: string[]
  /** Fields a writer other than this projection had changed since the last
   *  projection. Recorded, ingested as an input event, then overwritten —
   *  canonical wins, but never silently. */
  foreignFields: string[]
  conflictReason: string | null
}

interface ProjectOptions {
  /** Compute and report, write nothing. The backfill's dry run. */
  dryRun?: boolean
  /** Append a CASE_INPUT_OBSERVED event when a foreign write is found, so the
   *  owner's edit reaches the engine as an INPUT instead of being erased.
   *  Off in dry runs by definition. */
  ingestConflicts?: boolean
}

function readCanonical(
  db: Database.Database, domain: ProjectionDomain, caseId: string,
): CanonicalRow | undefined {
  const row = db.prepare(
    `SELECT domain, case_id, canonical_revision, next_best_action_json, next_progression_at,
            waiting_on, blocked_reason, wait_system_json, progression_enabled
       FROM case_progression_state WHERE domain = ? AND case_id = ?`,
  ).get(domain, caseId) as CanonicalRow | undefined
  if (!row) return undefined
  const w = activeWaitCondition(db, domain, caseId)
  row.wait = w
    ? { kind: w.kind, subject: w.subject, expected_by: w.expected_by, stale_review_at: w.stale_review_at }
    : null
  return row
}

interface BoardRow extends ProjectedFields {
  case_id: string
  version: number
  /** The case's lifecycle status, an INPUT to the stage derivation. */
  status: string
  projected_revision: number | null
  projection_fingerprint: string | null
}

function readBoard(
  db: Database.Database, domain: ProjectionDomain, caseId: string,
): BoardRow | undefined {
  return db.prepare(
    // `status` comes along because P3's stage is DERIVED from it. The status is
    // not engine state -- the case engine's transitions own it -- so the
    // projection reads it as an input rather than pretending it is canonical.
    `SELECT case_id, version, status, ${PROJECTED_COLUMNS.join(', ')},
            projected_revision, projection_fingerprint
       FROM ${caseTableFor(domain)} WHERE case_id = ?`,
  ).get(caseId) as BoardRow | undefined
}

/**
 * The fenced write, on its own so it can be driven red on its own.
 *
 * `projectCase` checks the revision before it computes anything, and this
 * statement checks it again in its WHERE clause. That is not belt-and-braces
 * for its own sake: the early check answers "is this projection stale as of my
 * read", and only the WHERE clause can answer "did somebody land a newer one
 * while I was working". A mutation that deletes either one alone is invisible
 * to a test that exercises only the first scenario, which is exactly what the
 * first version of this file's test suite did.
 *
 * Returns false when the fence refused, i.e. zero rows changed.
 */
export function writeProjection(
  db: Database.Database,
  domain: ProjectionDomain,
  caseId: string,
  want: ProjectedFields,
  rev: number,
  conflictReason: string | null,
  now: number,
): boolean {
  // THE SET CLAUSE IS BUILT FROM `PROJECTED_COLUMNS`, not typed out again.
  //
  // It used to list the six columns by hand while the READ a few lines above
  // built its list from the constant -- two definitions of the same set, and P3
  // walked straight into the gap: `proj_progress_stage` was added to the
  // constant, to the type, to the schema and to the deriver, the whole mapping
  // suite went green, and the column was never written, because the one place
  // that actually writes had its own copy of the list.
  //
  // Three tests caught it, and only because they read the DATABASE rather than
  // the returned object -- the same lesson the capability trail taught four
  // hours earlier, in a different file, on the same day.
  const info = db.prepare(
    `UPDATE ${caseTableFor(domain)}
        SET ${PROJECTED_COLUMNS.map(c => `${c} = @${c}`).join(',\n            ')},
            projected_revision = @rev,
            projection_fingerprint = @fingerprint,
            projection_conflict_reason = @conflictReason,
            last_reconciled_at = @now
      WHERE case_id = @caseId
        AND (projected_revision IS NULL OR projected_revision <= @rev)`,
  ).run({ ...want, rev, fingerprint: projectionFingerprint(want), conflictReason, now, caseId })
  return info.changes > 0
}

/**
 * Project one case's canonical state onto its board row.
 *
 * WHAT IT NEVER DOES, because "no side effects from reconciliation" is an
 * acceptance condition and not an aspiration: it does not change `status`, does
 * not bump the case `version` (so it cannot make a concurrent owner transition
 * lose its optimistic-concurrency race), does not schedule progression, does
 * not touch `next_wake_at`, `waiting_on` or `next_action`, and sends nothing.
 * The only event it may append is the conflict ingest below, which carries no
 * status change.
 *
 * THE FENCE. `projected_revision` on the board records which
 * `canonical_revision` the row reflects. A projection computed from an older
 * revision than the row already carries is REFUSED — that is a stale writer
 * racing a newer one, and letting it win would move the board backwards while
 * every counter said it had been reconciled.
 */
export function projectCase(
  db: Database.Database,
  domain: ProjectionDomain,
  caseId: string,
  now: number,
  opts: ProjectOptions = {},
): ProjectionResult {
  const dryRun = opts.dryRun === true
  const ingestConflicts = dryRun ? false : opts.ingestConflicts !== false

  const base: ProjectionResult = {
    domain, caseId, outcome: 'NO_CANONICAL',
    canonicalRevision: null, previousProjectedRevision: null,
    changedFields: [], foreignFields: [], conflictReason: null,
  }

  const canonical = readCanonical(db, domain, caseId)
  if (!canonical) return base
  const board = readBoard(db, domain, caseId)
  if (!board) return { ...base, outcome: 'NO_CASE', canonicalRevision: canonical.canonical_revision }

  const want = deriveProjection({
    ...canonical, status: board.status,
    progress_stage: stageForCase(db, domain, caseId, now),
  })
  const rev = canonical.canonical_revision
  const prevRev = board.projected_revision

  // FENCE. Strictly greater: a row already projected from a NEWER canonical
  // revision must not be walked backwards by a slower writer.
  if (prevRev !== null && prevRev > rev) {
    const reason = `STALE_PROJECTION: canonical_revision ${rev} < projected_revision ${prevRev}`
    if (!dryRun) {
      db.prepare(
        `UPDATE ${caseTableFor(domain)} SET projection_conflict_reason = ? WHERE case_id = ?`,
      ).run(reason, caseId)
    }
    return {
      ...base, outcome: 'FENCED', canonicalRevision: rev, previousProjectedRevision: prevRev,
      conflictReason: reason,
    }
  }

  // FOREIGN WRITE. What is on the row now, versus what this projection last
  // wrote. A mismatch means a writer other than this one touched an owned
  // column. Only meaningful once we have written the row at least once —
  // before that, a difference is simply "not projected yet".
  const current: ProjectedFields = {
    proj_next_action: board.proj_next_action,
    proj_next_action_kind: board.proj_next_action_kind,
    proj_next_action_step: board.proj_next_action_step,
    proj_wait_condition: board.proj_wait_condition,
    proj_next_review_at: board.proj_next_review_at,
    proj_blocked_reason: board.proj_blocked_reason,
    proj_progress_stage: board.proj_progress_stage,
  }
  const foreignFields: string[] = []
  if (board.projection_fingerprint && projectionFingerprint(current) !== board.projection_fingerprint) {
    for (const col of PROJECTED_COLUMNS) {
      // Compared against what WE last wrote is not possible from the row alone,
      // so the honest statement is field-level: these are the owned columns as
      // they stand, and the fingerprint says at least one of them moved.
      if (current[col] !== want[col]) foreignFields.push(col)
    }
    if (foreignFields.length === 0) foreignFields.push(...PROJECTED_COLUMNS)
  }

  const changedFields = PROJECTED_COLUMNS.filter((col) => current[col] !== want[col])
  const conflictReason = foreignFields.length
    ? `FOREIGN_WRITE: ${foreignFields.join(',')}`
    : null

  if (dryRun) {
    return {
      domain, caseId,
      outcome: changedFields.length ? 'PROJECTED' : 'UNCHANGED',
      canonicalRevision: rev, previousProjectedRevision: prevRev,
      changedFields, foreignFields, conflictReason,
    }
  }

  // The owner's edit becomes an INPUT to the engine rather than something the
  // projection erases. Append-only, no status change, no version bump — the
  // engine reads it on its next run and decides; the decision is what projects
  // back. This is the "ingest as command/event input" half of the architecture.
  if (ingestConflicts && foreignFields.length) {
    appendProjectionInputEvent(db, domain, caseId, board.version, current, foreignFields, now)
  }

  const landed = writeProjection(db, domain, caseId, want, rev, conflictReason, now)

  // The statement-level fence, which is the ONLY one that can see the race the
  // early check cannot: a concurrent projection landing a newer revision
  // BETWEEN our read and our write. Zero rows changed means we say FENCED
  // rather than report a success that did not happen.
  if (!landed) {
    return {
      ...base, outcome: 'FENCED', canonicalRevision: rev, previousProjectedRevision: prevRev,
      conflictReason: `STALE_PROJECTION: lost the write race at revision ${rev}`,
    }
  }

  return {
    domain, caseId,
    outcome: changedFields.length ? 'PROJECTED' : 'UNCHANGED',
    canonicalRevision: rev, previousProjectedRevision: prevRev,
    changedFields, foreignFields, conflictReason,
  }
}

/** Record a user-authored change to an engine-owned column as an input event.
 *
 *  `case_version` is read from the row rather than incremented: this is not a
 *  transition and must not consume the optimistic-concurrency version an owner
 *  action is holding. Nothing here touches `last_event_id`, which the §10.8
 *  trigger contract hashes — an event that re-triggered progression would turn
 *  every reconciliation into a run storm. */
function appendProjectionInputEvent(
  db: Database.Database,
  domain: ProjectionDomain,
  caseId: string,
  caseVersion: number,
  observed: ProjectedFields,
  fields: string[],
  now: number,
): void {
  const table = domain === 'personal' ? 'personal_case_events' : 'zst_case_events'
  try {
    db.prepare(
      `INSERT INTO ${table}
         (case_id, case_version, actor, event_type, reason, payload, source_system, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      caseId, caseVersion, 'case-projection', 'CASE_INPUT_OBSERVED',
      `Az ügytáblán a motor tulajdonában lévő mező kívülről változott: ${fields.join(', ')}`,
      JSON.stringify({ fields, observed }), 'case-projection', now,
    )
  } catch {
    // An install without the event table must not lose the projection itself.
    // The conflict is still recorded on the row, which is the durable half.
  }
}

export interface SweepResult {
  at: number
  examined: number
  projected: number
  unchanged: number
  fenced: number
  noCanonical: number
  conflicts: number
  /** Cases whose canonical row was behind the board or otherwise refused,
   *  listed so a fenced sweep is never reported as a clean one. */
  fencedCases: Array<{ domain: ProjectionDomain; caseId: string; reason: string }>
  conflictCases: Array<{ domain: ProjectionDomain; caseId: string; reason: string }>
  dryRun: boolean
}

/**
 * Reconcile every active case in both domains.
 *
 * THIS IS ALSO THE RESTART RECOVERY. A crash between the canonical commit and
 * the projection leaves `projected_revision` behind `canonical_revision`; this
 * sweep is what deterministically closes that window, and because the write is
 * idempotent and fenced, running it after a restart cannot duplicate anything
 * or move a row that a live run has already advanced past.
 */
export function reconcileProjections(
  db: Database.Database,
  now: number,
  opts: ProjectOptions & { domains?: ProjectionDomain[] } = {},
): SweepResult {
  const out: SweepResult = {
    at: now, examined: 0, projected: 0, unchanged: 0, fenced: 0, noCanonical: 0,
    conflicts: 0, fencedCases: [], conflictCases: [], dryRun: opts.dryRun === true,
  }
  for (const domain of opts.domains ?? (['personal', 'zst'] as ProjectionDomain[])) {
    const terminal = terminalStatusesFor(domain)
    const ph = terminal.map(() => '?').join(',')
    let rows: Array<{ case_id: string }>
    try {
      rows = db.prepare(
        `SELECT case_id FROM ${caseTableFor(domain)}
          WHERE archived_at IS NULL AND status NOT IN (${ph})`,
      ).all(...terminal) as Array<{ case_id: string }>
    } catch (e) {
      if (isMissingTable(e, caseTableFor(domain))) continue
      throw e
    }
    for (const r of rows) {
      out.examined += 1
      const res = projectCase(db, domain, r.case_id, now, opts)
      if (res.outcome === 'PROJECTED') out.projected += 1
      else if (res.outcome === 'UNCHANGED') out.unchanged += 1
      else if (res.outcome === 'FENCED') {
        out.fenced += 1
        out.fencedCases.push({ domain, caseId: r.case_id, reason: res.conflictReason ?? 'FENCED' })
      } else if (res.outcome === 'NO_CANONICAL') out.noCanonical += 1
      if (res.conflictReason && res.outcome !== 'FENCED') {
        out.conflicts += 1
        out.conflictCases.push({ domain, caseId: r.case_id, reason: res.conflictReason })
      }
    }
  }
  return out
}

// ── Invariant A, on the surface the owner actually reads ────────────────────

export interface InvariantAViolation {
  domain: ProjectionDomain
  caseId: string
  status: string
  /** Why it fails, in the terms of the invariant rather than in column names. */
  reason: 'NO_NEXT_ACTION_AND_NO_WAIT' | 'WAIT_WITHOUT_REVIEW_TIME' | 'NO_PROGRESSION_STATE'
}

export interface InvariantAReport {
  active: number
  satisfied: number
  violations: InvariantAViolation[]
  /** Active cases the engine has never enrolled. Counted separately because
   *  "the engine has no opinion" and "the engine's opinion did not arrive" are
   *  different failures with different fixes. */
  unenrolled: number
}

/**
 * §10.2 Invariant A on the board: every active case carries a next action, OR a
 * wait condition together with a review time.
 *
 * Read off `proj_next_action_kind`, not `proj_next_action`. The invariant asks
 * whether an action EXISTS; the text is a rendering, and the one rendering the
 * engine produces is banned from owner-facing surfaces. Reading the text would
 * make a policy about language look like a missing action.
 */
export function evaluateInvariantA(
  db: Database.Database,
  domain: ProjectionDomain,
): InvariantAReport {
  const terminal = terminalStatusesFor(domain)
  const ph = terminal.map(() => '?').join(',')
  let rows: Array<{
    case_id: string; status: string
    proj_next_action_kind: string | null
    proj_wait_condition: string | null
    proj_next_review_at: number | null
    has_state: number
  }>
  try {
    rows = db.prepare(
      `SELECT c.case_id, c.status, c.proj_next_action_kind, c.proj_wait_condition,
              c.proj_next_review_at,
              (SELECT 1 FROM case_progression_state s
                WHERE s.domain = ? AND s.case_id = c.case_id) AS has_state
         FROM ${caseTableFor(domain)} c
        WHERE c.archived_at IS NULL AND c.status NOT IN (${ph})`,
    ).all(domain, ...terminal) as typeof rows
  } catch (e) {
    if (!isMissingTable(e, caseTableFor(domain))) throw e
    return { active: 0, satisfied: 0, violations: [], unenrolled: 0 }
  }

  const violations: InvariantAViolation[] = []
  let satisfied = 0
  let unenrolled = 0
  for (const r of rows) {
    if (!r.has_state) unenrolled += 1
    if (r.proj_next_action_kind) { satisfied += 1; continue }
    if (r.proj_wait_condition && r.proj_next_review_at !== null) { satisfied += 1; continue }
    violations.push({
      domain, caseId: r.case_id, status: r.status,
      reason: !r.has_state ? 'NO_PROGRESSION_STATE'
        : r.proj_wait_condition ? 'WAIT_WITHOUT_REVIEW_TIME'
          : 'NO_NEXT_ACTION_AND_NO_WAIT',
    })
  }
  return { active: rows.length, satisfied, violations, unenrolled }
}

// ── Drift: the board and the engine disagreeing, with a consumer ────────────

export interface DriftReport {
  at: number
  /** Board rows whose projection is older than the canonical revision. */
  behind: Array<{ domain: ProjectionDomain; caseId: string; projected: number | null; canonical: number }>
  /** Board rows nothing has ever reconciled. */
  neverReconciled: Array<{ domain: ProjectionDomain; caseId: string }>
  /** Board rows carrying a recorded conflict. */
  conflicted: Array<{ domain: ProjectionDomain; caseId: string; reason: string }>
  /** Active cases with no progression state at all — the engine is not merely
   *  behind on them, it has never been asked. */
  unenrolled: Array<{ domain: ProjectionDomain; caseId: string; status: string }>
  /** Active cases whose progression state exists but is SWITCHED OFF.
   *
   *  Its own bucket, and the reason is the outlier this packet was told to
   *  close. PRI-TRIP-2026-001 had a state row, zero runs, and
   *  `progression_enabled = 0`: nothing was behind, nothing was in conflict,
   *  nothing had ever been reconciled wrongly — the engine had simply been
   *  turned off for it, and every other bucket read that as health. "The engine
   *  has nothing to say" and "the engine was switched off" are opposite
   *  conditions that look identical from every surface that counts rows. */
  disabled: Array<{ domain: ProjectionDomain; caseId: string; status: string; runs: number }>
  total: number
}

/**
 * Read-only. Answers the question the store could not answer at all before this
 * packet: WHERE do the two views of a case disagree, and since when.
 *
 * `neverReconciled` is deliberately its own bucket. A row that has never been
 * projected looks identical to one that agrees, and those are opposite
 * conditions — the first is a blind spot, the second is health.
 */
export function detectProjectionDrift(db: Database.Database, now: number): DriftReport {
  const out: DriftReport = {
    at: now, behind: [], neverReconciled: [], conflicted: [], unenrolled: [], disabled: [], total: 0,
  }
  for (const domain of ['personal', 'zst'] as ProjectionDomain[]) {
    const terminal = terminalStatusesFor(domain)
    const ph = terminal.map(() => '?').join(',')
    let rows: Array<{
      case_id: string; status: string
      projected_revision: number | null
      projection_conflict_reason: string | null
      last_reconciled_at: number | null
      canonical_revision: number | null
      progression_enabled: number | null
      runs: number
    }>
    try {
      rows = db.prepare(
        `SELECT c.case_id, c.status, c.projected_revision, c.projection_conflict_reason,
                c.last_reconciled_at, s.canonical_revision, s.progression_enabled,
                (SELECT COUNT(*) FROM case_progression_runs r
                  WHERE r.domain = ? AND r.case_id = c.case_id) AS runs
           FROM ${caseTableFor(domain)} c
           LEFT JOIN case_progression_state s
             ON s.domain = ? AND s.case_id = c.case_id
          WHERE c.archived_at IS NULL AND c.status NOT IN (${ph})`,
      ).all(domain, domain, ...terminal) as typeof rows
    } catch (e) {
      if (isMissingTable(e, caseTableFor(domain))) continue
      throw e
    }
    for (const r of rows) {
      if (r.canonical_revision === null) {
        out.unenrolled.push({ domain, caseId: r.case_id, status: r.status })
        continue
      }
      if (!r.progression_enabled) {
        out.disabled.push({ domain, caseId: r.case_id, status: r.status, runs: r.runs })
      }
      if (r.last_reconciled_at === null) {
        out.neverReconciled.push({ domain, caseId: r.case_id })
      } else if ((r.projected_revision ?? -1) < r.canonical_revision) {
        out.behind.push({
          domain, caseId: r.case_id,
          projected: r.projected_revision, canonical: r.canonical_revision,
        })
      }
      if (r.projection_conflict_reason) {
        out.conflicted.push({ domain, caseId: r.case_id, reason: r.projection_conflict_reason })
      }
    }
  }
  out.total = out.behind.length + out.neverReconciled.length
    + out.conflicted.length + out.unenrolled.length + out.disabled.length
  return out
}
