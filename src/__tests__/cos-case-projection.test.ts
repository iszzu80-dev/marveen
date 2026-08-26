// P1 §10.1/§10.2 — one case, one truth.
//
// MEASURED BEFORE ANY OF THIS EXISTED, on the live store, 2026-08-26:
// Invariant A ("every active case carries a next action, OR a wait condition
// plus a review time") held 166 of 167 inside `case_progression_state` and
// 0 of 146 on the case board. Nothing reconciled the two views and no row
// anywhere carried a `last_reconciled_at`, so the disagreement had no surface
// and no age.
//
// Every test below is written so it can go RED. Several of them exist
// specifically to fail if a later change makes the projection "helpful" in one
// of the three ways that would have broken something live -- see the
// near-misses block at the bottom.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { initProgressionSchema, initCaseProjectionSchema } from '../cos/schema.js'
import {
  projectCase, reconcileProjections, evaluateInvariantA, detectProjectionDrift,
  deriveProjection, projectionFingerprint, isOwnerSafeActionText,
  CANONICAL_PROJECTION_INPUTS, PROJECTED_COLUMNS,
} from '../cos/case-projection.js'
import { internalPlanLabels } from '../cos/progression-pipeline.js'

const T0 = 1_700_000_000

type Db = ReturnType<typeof getDb>

function fresh(): Db {
  initDatabase(':memory:')
  const db = getDb()
  initProgressionSchema(db)
  return db
}

/** A case on the board plus a canonical progression row, which is the shape
 *  production always reaches: the pipeline creates the state row. */
function seedCase(db: Db, caseId: string, canonical: Partial<{
  nba: unknown; nextProgressionAt: number | null; waitingOn: string | null
  blockedReason: string | null; waitSystemJson: string | null
}> = {}): void {
  createCase(db, { caseId, title: `T-${caseId}`, caseType: 'QUOTE' }, T0)
  db.prepare(
    `INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode, created_at, updated_at)
     VALUES ('personal', ?, 1, 'internal', ?, ?)`,
  ).run(caseId, T0, T0)
  setCanonical(db, caseId, canonical)
}

function setCanonical(db: Db, caseId: string, c: Partial<{
  nba: unknown; nextProgressionAt: number | null; waitingOn: string | null
  blockedReason: string | null; waitSystemJson: string | null
}>): void {
  const sets: string[] = []
  const args: unknown[] = []
  if ('nba' in c) { sets.push('next_best_action_json = ?'); args.push(c.nba === null ? null : JSON.stringify(c.nba)) }
  if ('nextProgressionAt' in c) { sets.push('next_progression_at = ?'); args.push(c.nextProgressionAt ?? null) }
  if ('waitingOn' in c) { sets.push('waiting_on = ?'); args.push(c.waitingOn ?? null) }
  if ('blockedReason' in c) { sets.push('blocked_reason = ?'); args.push(c.blockedReason ?? null) }
  if ('waitSystemJson' in c) { sets.push('wait_system_json = ?'); args.push(c.waitSystemJson ?? null) }
  if (!sets.length) return
  db.prepare(`UPDATE case_progression_state SET ${sets.join(', ')} WHERE domain='personal' AND case_id = ?`)
    .run(...args, caseId)
}

function revisionOf(db: Db, caseId: string): number {
  return (db.prepare(
    `SELECT canonical_revision AS r FROM case_progression_state WHERE domain='personal' AND case_id = ?`,
  ).get(caseId) as { r: number }).r
}

function boardRow(db: Db, caseId: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM personal_cases WHERE case_id = ?`).get(caseId) as Record<string, unknown>
}

/** An owner-readable action. Deliberately NOT one of the planner's labels. */
const SAFE_NBA = { planStep: 2, description: 'Hívd fel a szervizt a garanciáról', kind: 'EXECUTE' }

describe('P1 — canonical source is versioned', () => {
  beforeEach(() => { fresh() })

  it('every field the projection reads bumps canonical_revision', () => {
    const db = getDb()
    seedCase(db, 'c1')
    expect(revisionOf(db, 'c1')).toBe(0)

    let expected = 0
    for (const change of [
      { nba: SAFE_NBA },
      { nextProgressionAt: T0 + 600 },
      { waitingOn: 'a szerviz válaszára' },
      { blockedReason: 'nincs alkatrész' },
      { waitSystemJson: '{"kind":"EVENT"}' },
    ]) {
      setCanonical(db, 'c1', change)
      expected += 1
      expect(revisionOf(db, 'c1')).toBe(expected)
    }
  })

  it('a no-op write does NOT bump the revision', () => {
    // Otherwise every heartbeat would make every board row look stale, and
    // "behind" would stop meaning anything.
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    const before = revisionOf(db, 'c1')
    setCanonical(db, 'c1', { nba: SAFE_NBA })
    expect(revisionOf(db, 'c1')).toBe(before)
  })

  it('a NULL transition in either direction bumps it', () => {
    // `!=` would miss both of these, because NULL != NULL is NULL. This test is
    // the reason the trigger uses `IS NOT`.
    const db = getDb()
    seedCase(db, 'c1', { waitingOn: 'valakire' })
    const r1 = revisionOf(db, 'c1')
    setCanonical(db, 'c1', { waitingOn: null })
    expect(revisionOf(db, 'c1')).toBe(r1 + 1)
    setCanonical(db, 'c1', { waitingOn: 'megint valakire' })
    expect(revisionOf(db, 'c1')).toBe(r1 + 2)
  })

  it('a canonical field the projection does NOT read leaves the revision alone', () => {
    const db = getDb()
    seedCase(db, 'c1')
    const before = revisionOf(db, 'c1')
    db.prepare(`UPDATE case_progression_state SET goal = 'új cél' WHERE domain='personal' AND case_id='c1'`).run()
    expect(revisionOf(db, 'c1')).toBe(before)
  })

  it('ORACLE: the trigger watches exactly the set the module declares', () => {
    // The instrument and the thing it measures must not be allowed to drift
    // apart. A projection reading a field the trigger does not watch would go
    // stale while the revision said it was current -- silent drift wearing the
    // badge of freshness. Derived from sqlite_master, not from a list retyped
    // here: this is the TEST_ORACLE_DEFECT rule (2026-08-26) applied.
    const db = getDb()
    const sql = (db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_cps_canonical_revision'`,
    ).get() as { sql: string }).sql
    const watched = [...sql.matchAll(/NEW\.([a-z_]+)\s+IS NOT OLD\./g)].map(m => m[1]).sort()
    expect(watched).toEqual([...CANONICAL_PROJECTION_INPUTS].sort())
  })
})

describe('P1 — the projection itself', () => {
  beforeEach(() => { fresh() })

  it('projects the canonical decision onto the board and stamps last_reconciled_at', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA, nextProgressionAt: T0 + 600, waitingOn: 'a szervizre' })
    const r = projectCase(db, 'personal', 'c1', T0 + 10)
    expect(r.outcome).toBe('PROJECTED')
    const b = boardRow(db, 'c1')
    expect(b.proj_next_action).toBe('Hívd fel a szervizt a garanciáról')
    expect(b.proj_next_action_kind).toBe('EXECUTE')
    expect(b.proj_next_review_at).toBe(T0 + 600)
    expect(b.proj_wait_condition).toBe('a szervizre')
    expect(b.last_reconciled_at).toBe(T0 + 10)
    expect(b.projected_revision).toBe(revisionOf(db, 'c1'))
  })

  it('IS IDEMPOTENT: the second projection changes nothing', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA, nextProgressionAt: T0 + 600 })
    projectCase(db, 'personal', 'c1', T0 + 10)
    const after1 = boardRow(db, 'c1')
    const r2 = projectCase(db, 'personal', 'c1', T0 + 20)
    expect(r2.outcome).toBe('UNCHANGED')
    expect(r2.changedFields).toEqual([])
    const after2 = boardRow(db, 'c1')
    for (const col of PROJECTED_COLUMNS) expect(after2[col]).toEqual(after1[col])
    expect(after2.projection_fingerprint).toBe(after1.projection_fingerprint)
    // Only the reconciliation timestamp moves, which is the point of it: it
    // records when the two views were last confirmed to agree.
    expect(after2.last_reconciled_at).toBe(T0 + 20)
  })

  it('FENCES a stale writer instead of walking the board backwards', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    projectCase(db, 'personal', 'c1', T0 + 10)
    // A newer projection landed (concurrent runner), and now an older one
    // arrives carrying revision N while the row already reflects N+5.
    db.prepare(`UPDATE personal_cases SET projected_revision = ? WHERE case_id='c1'`)
      .run(revisionOf(db, 'c1') + 5)
    const before = boardRow(db, 'c1')
    const r = projectCase(db, 'personal', 'c1', T0 + 20)
    expect(r.outcome).toBe('FENCED')
    expect(r.conflictReason).toContain('STALE_PROJECTION')
    const after = boardRow(db, 'c1')
    for (const col of PROJECTED_COLUMNS) expect(after[col]).toEqual(before[col])
    expect(after.last_reconciled_at).toBe(before.last_reconciled_at)
  })

  it('records a CONFLICT REASON and ingests the foreign write as an input event', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    projectCase(db, 'personal', 'c1', T0 + 10)
    // Somebody edits an engine-owned column by hand.
    db.prepare(`UPDATE personal_cases SET proj_next_action = 'kézzel átírva' WHERE case_id='c1'`).run()

    const eventsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM personal_case_events`)
      .get() as { n: number }).n
    const versionBefore = (boardRow(db, 'c1') as { version: number }).version

    const r = projectCase(db, 'personal', 'c1', T0 + 20)
    expect(r.foreignFields).toContain('proj_next_action')
    expect(r.conflictReason).toContain('FOREIGN_WRITE')

    // Canonical wins -- but never silently.
    expect(boardRow(db, 'c1').proj_next_action).toBe('Hívd fel a szervizt a garanciáról')
    expect(boardRow(db, 'c1').projection_conflict_reason).toContain('FOREIGN_WRITE')

    const ev = db.prepare(
      `SELECT event_type, payload FROM personal_case_events ORDER BY event_id DESC LIMIT 1`,
    ).get() as { event_type: string; payload: string }
    expect(ev.event_type).toBe('CASE_INPUT_OBSERVED')
    expect(JSON.parse(ev.payload).observed.proj_next_action).toBe('kézzel átírva')
    expect((db.prepare(`SELECT COUNT(*) AS n FROM personal_case_events`).get() as { n: number }).n)
      .toBe(eventsBefore + 1)
    // The ingest must not consume the optimistic-concurrency version an owner
    // action might be holding.
    expect((boardRow(db, 'c1') as { version: number }).version).toBe(versionBefore)
  })

  it('a DRY RUN writes nothing at all', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA, nextProgressionAt: T0 + 600 })
    const before = boardRow(db, 'c1')
    const r = projectCase(db, 'personal', 'c1', T0 + 10, { dryRun: true })
    expect(r.outcome).toBe('PROJECTED')      // it says what WOULD happen
    expect(r.changedFields.length).toBeGreaterThan(0)
    expect(boardRow(db, 'c1')).toEqual(before)  // and leaves no trace, not even a stamp
  })

  it('HAS NO SIDE EFFECTS: no status change, no version bump, no events, no runs', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA, nextProgressionAt: T0 + 600, waitingOn: 'valakire' })
    const before = boardRow(db, 'c1')
    const eventsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM personal_case_events`).get() as { n: number }).n
    const runsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM case_progression_runs`).get() as { n: number }).n

    reconcileProjections(db, T0 + 10)

    const after = boardRow(db, 'c1')
    expect(after.status).toBe(before.status)
    expect(after.version).toBe(before.version)
    expect(after.completed_at).toBe(before.completed_at)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM personal_case_events`).get() as { n: number }).n).toBe(eventsBefore)
    expect((db.prepare(`SELECT COUNT(*) AS n FROM case_progression_runs`).get() as { n: number }).n).toBe(runsBefore)
  })
})

describe('P1 — drift is detectable', () => {
  beforeEach(() => { fresh() })

  it('a case nothing has ever reconciled is its OWN bucket, not silent agreement', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    const d = detectProjectionDrift(db, T0)
    expect(d.neverReconciled.map(x => x.caseId)).toEqual(['c1'])
    expect(d.behind).toEqual([])
  })

  it('canonical moving without a projection shows up as BEHIND', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    projectCase(db, 'personal', 'c1', T0 + 10)
    expect(detectProjectionDrift(db, T0 + 10).total).toBe(0)

    setCanonical(db, 'c1', { nba: { ...SAFE_NBA, description: 'Küldd el a számlát' } })
    const d = detectProjectionDrift(db, T0 + 20)
    expect(d.behind.map(x => x.caseId)).toEqual(['c1'])
    // ...and the sweep closes it.
    reconcileProjections(db, T0 + 30)
    expect(detectProjectionDrift(db, T0 + 30).total).toBe(0)
  })

  it('RED PROOF: with the revision trigger dropped, the same drift becomes invisible', () => {
    // The trigger is the whole reason drift is detectable at all. A guard
    // nobody has watched fail is a belief, so here it fails on purpose.
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    projectCase(db, 'personal', 'c1', T0 + 10)
    db.exec('DROP TRIGGER trg_cps_canonical_revision')
    setCanonical(db, 'c1', { nba: { ...SAFE_NBA, description: 'Küldd el a számlát' } })
    expect(detectProjectionDrift(db, T0 + 20).behind).toEqual([])   // blind
    // Put it back and the same change is seen again.
    initCaseProjectionSchema(db)
    setCanonical(db, 'c1', { nba: { ...SAFE_NBA, description: 'Küldd el a számlát ma' } })
    expect(detectProjectionDrift(db, T0 + 30).behind.map(x => x.caseId)).toEqual(['c1'])
  })

  it('an active case the engine was never asked about is UNENROLLED, not merely behind', () => {
    // The 166/167 outlier on the live store was exactly this: a case created
    // outside the intake path, progression disabled, zero runs, silent.
    const db = getDb()
    createCase(getDb(), { caseId: 'orphan', title: 'Nincs motor', caseType: 'TRAVEL' }, T0)
    const d = detectProjectionDrift(db, T0)
    expect(d.unenrolled.map(x => x.caseId)).toEqual(['orphan'])
    expect(evaluateInvariantA(db, 'personal').violations[0].reason).toBe('NO_PROGRESSION_STATE')
  })
})

describe('P1 — Invariant A on the board', () => {
  beforeEach(() => { fresh() })

  it('after reconciliation every active case with canonical state satisfies it', () => {
    const db = getDb()
    seedCase(db, 'a', { nba: SAFE_NBA })                                    // has an action
    seedCase(db, 'b', { waitingOn: 'a bankra', nextProgressionAt: T0 + 60 }) // waits, with a review time
    seedCase(db, 'c', { nba: SAFE_NBA, nextProgressionAt: T0 + 60 })
    expect(evaluateInvariantA(db, 'personal').satisfied).toBe(0)

    reconcileProjections(db, T0 + 10)
    const r = evaluateInvariantA(db, 'personal')
    expect(r.active).toBe(3)
    expect(r.satisfied).toBe(3)
    expect(r.violations).toEqual([])
  })

  it('a wait with NO review time is a violation, named as one', () => {
    const db = getDb()
    seedCase(db, 'b', { waitingOn: 'a bankra' })   // no next_progression_at
    reconcileProjections(db, T0 + 10)
    const v = evaluateInvariantA(db, 'personal').violations
    expect(v).toHaveLength(1)
    expect(v[0].reason).toBe('WAIT_WITHOUT_REVIEW_TIME')
  })

  it('RED PROOF: break the projection and the invariant goes non-zero', () => {
    const db = getDb()
    seedCase(db, 'a', { nba: SAFE_NBA })
    reconcileProjections(db, T0 + 10)
    expect(evaluateInvariantA(db, 'personal').violations).toEqual([])
    db.prepare(`UPDATE personal_cases SET proj_next_action_kind = NULL WHERE case_id='a'`).run()
    expect(evaluateInvariantA(db, 'personal').violations).toHaveLength(1)
  })

  it('the check must notice DISAGREEMENT, not merely emptiness', () => {
    // A projection that overwrote without comparing would pass a weaker test:
    // the board would never be empty, so an "is it filled in?" check would stay
    // green while the two sides said different things.
    const db = getDb()
    seedCase(db, 'a', { nba: SAFE_NBA })
    reconcileProjections(db, T0 + 10)
    db.prepare(`UPDATE personal_cases SET proj_next_action_kind = 'VERIFY' WHERE case_id='a'`).run()
    // Invariant A is still satisfied -- the board is FULL, just wrong. The
    // drift/conflict path is what has to catch this.
    expect(evaluateInvariantA(db, 'personal').violations).toEqual([])
    const r = projectCase(db, 'personal', 'a', T0 + 20)
    expect(r.foreignFields).toContain('proj_next_action_kind')
    expect(r.conflictReason).toContain('FOREIGN_WRITE')
  })
})

describe('P1 — the owner-facing text rule', () => {
  beforeEach(() => { fresh() })

  it('an internal planner label is NOT projected as text, but the action still EXISTS', () => {
    // `isUsableRecommendation` already refuses to show these strings to the
    // owner -- "Javaslatom: Execute first recovery action" reached Istvan once.
    // The invariant asks whether an action exists, which is a fact; the English
    // label is a rendering, and a banned rendering is not a missing action.
    const db = getDb()
    const label = [...internalPlanLabels()][0]
    seedCase(db, 'c1', { nba: { planStep: 2, description: label, kind: 'RECOVER' } })
    projectCase(db, 'personal', 'c1', T0 + 10)
    const b = boardRow(db, 'c1')
    expect(b.proj_next_action).toBeNull()
    expect(b.proj_next_action_kind).toBe('RECOVER')
    expect(evaluateInvariantA(db, 'personal').violations).toEqual([])
  })

  it('EVERY label the planner can emit is refused, not just the ones we remembered', () => {
    // Enumerated by driving the planner, so a label added tomorrow is covered
    // without anyone editing this file.
    for (const label of internalPlanLabels()) expect(isOwnerSafeActionText(label)).toBe(false)
    expect(isOwnerSafeActionText('Hívd fel a szervizt a garanciáról')).toBe(true)
  })

  it('a raw enum leaking into the description is refused too', () => {
    expect(isOwnerSafeActionText('WAIT_EXTERNAL')).toBe(false)
    expect(isOwnerSafeActionText('RECOVERY_REQUIRED')).toBe(false)
  })

  it('unparseable canonical JSON records the absence instead of inventing a shape', () => {
    const db = getDb()
    seedCase(db, 'c1')
    db.prepare(`UPDATE case_progression_state SET next_best_action_json = '{not json'
                WHERE domain='personal' AND case_id='c1'`).run()
    const p = deriveProjection({
      domain: 'personal', case_id: 'c1', canonical_revision: 1,
      next_best_action_json: '{not json', next_progression_at: null, waiting_on: null,
      blocked_reason: null, wait_system_json: null, progression_enabled: 1,
    })
    expect(p.proj_next_action_kind).toBeNull()
    expect(projectionFingerprint(p)).toEqual(projectionFingerprint(p))
  })
})

describe('P1 — the three columns the projection must NOT touch', () => {
  // Each of these was named in the P1 audit as the board's unwritten twin of a
  // canonical column, and each one has a live consumer that would have broken
  // quietly. The tests are here so a later "helpful" change has to argue with
  // something.
  beforeEach(() => { fresh() })

  it('next_wake_at is left alone -- it is an APPOINTMENT, cleared when kept', () => {
    // `alertWokenCases` posts every due case to the owner and then clears the
    // column. Filling it from `next_progression_at` (a five-minute cadence,
    // usually in the past) would have alerted ~120 cases in one sweep and
    // re-armed them on the next: a permanent alert loop.
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA, nextProgressionAt: T0 - 5 })
    projectCase(db, 'personal', 'c1', T0 + 10)
    expect(boardRow(db, 'c1').next_wake_at).toBeNull()
  })

  it('waiting_on is left alone -- follow-up drafting reads the RECIPIENT out of it', () => {
    // `followup-autodraft` regexes an address from this prose. Overwriting it
    // with the engine's wait reason disarms drafting silently.
    const db = getDb()
    db.prepare(`UPDATE personal_cases SET waiting_on = 'reply from anna@szerviz.hu' WHERE case_id='c1'`)
    seedCase(db, 'c1', { waitingOn: 'külső válaszra', nextProgressionAt: T0 + 60 })
    db.prepare(`UPDATE personal_cases SET waiting_on = 'reply from anna@szerviz.hu' WHERE case_id='c1'`).run()
    projectCase(db, 'personal', 'c1', T0 + 10)
    expect(boardRow(db, 'c1').waiting_on).toBe('reply from anna@szerviz.hu')
    expect(boardRow(db, 'c1').proj_wait_condition).toBe('külső válaszra')
  })

  it('next_action is left alone -- it is a TRUSTED field for auto-linking', () => {
    // `case-link`'s TRUSTED_CASE_FIELDS: identifiers found here auto-link a
    // stranger's incoming mail to a case, precisely because the owner or the
    // system wrote them.
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    db.prepare(`UPDATE personal_cases SET next_action = 'Rendelés 12345 átvétele' WHERE case_id='c1'`).run()
    projectCase(db, 'personal', 'c1', T0 + 10)
    expect(boardRow(db, 'c1').next_action).toBe('Rendelés 12345 átvétele')
  })

  it('ORACLE: the owned column list contains none of the three', () => {
    for (const forbidden of ['next_wake_at', 'waiting_on', 'next_action', 'status', 'version']) {
      expect(PROJECTED_COLUMNS as readonly string[]).not.toContain(forbidden)
    }
  })
})

describe('P1 — the sweep as restart recovery', () => {
  beforeEach(() => { fresh() })

  it('a canonical commit whose projection never ran is closed by the next sweep', () => {
    // This is the crash window the owner asked P6 to cover: canonical
    // committed, projection/wake scheduling not yet. Simulated here by moving
    // canonical without projecting -- which is exactly what a process death
    // between the two would leave behind.
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    projectCase(db, 'personal', 'c1', T0 + 10)
    setCanonical(db, 'c1', { nba: { ...SAFE_NBA, description: 'Küldd el a számlát' } })

    const sweep = reconcileProjections(db, T0 + 20)
    expect(sweep.projected).toBe(1)
    expect(boardRow(db, 'c1').proj_next_action).toBe('Küldd el a számlát')

    // ...and running it again duplicates nothing.
    const second = reconcileProjections(db, T0 + 30)
    expect(second.projected).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(detectProjectionDrift(db, T0 + 30).total).toBe(0)
  })

  it('the sweep reports what it refused instead of counting it as clean', () => {
    const db = getDb()
    seedCase(db, 'c1', { nba: SAFE_NBA })
    projectCase(db, 'personal', 'c1', T0 + 10)
    db.prepare(`UPDATE personal_cases SET projected_revision = 99 WHERE case_id='c1'`).run()
    const sweep = reconcileProjections(db, T0 + 20)
    expect(sweep.fenced).toBe(1)
    expect(sweep.fencedCases[0].caseId).toBe('c1')
  })
})
