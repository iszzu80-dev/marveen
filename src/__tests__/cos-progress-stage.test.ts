// P3 — the progress stage, derived from status and never replacing it.
//
// The owner's constraint: "P3-ban ne próbáld a meglévő 9-10 státuszt négyre
// összevonni." So these tests check two things that pull in opposite directions:
// that EVERY status has a stage, and that NO status lost its identity to one.
//
// The acceptance criterion is unusually specific about method, and it is the
// reason this file exists in the shape it does:
//
//   "proven by a test that reads the LIVE status vocabulary rather than a
//    hard-coded list, so a new status added later fails loudly instead of
//    silently becoming unmapped"
//   "the mapping is derived from the code that defines the statuses, not from a
//    document"
//
// A `Record<CaseStatus, ProgressStage>` already makes the compiler refuse an
// unmapped status. That is the strongest guard and it costs nothing at runtime --
// but it only checks the map against the TYPESCRIPT union. The DATABASE enforces
// its own CHECK constraint, and those two are different artefacts that can drift.
// So the headline tests below read the constraint out of `sqlite_master` and
// compare against the map: the one place a hard-coded list could still hide.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { createZstCase } from '../cos/zst-case-store.js'
import { seedCaseProgressionState } from '../cos/case-progression-seed.js'
import { projectCase } from '../cos/case-projection.js'
import { CASE_STATUSES, ZST_CASE_STATUSES } from '../cos/schema.js'
import {
  PROGRESS_STAGES, PERSONAL_STAGE, ZST_STAGE, stageFor, statusVocabulary,
  type CaseDomain,
} from '../cos/progress-stage.js'

const NOW = 1_700_000_000

/** The status vocabulary the DATABASE will actually accept, parsed out of the
 *  live CHECK constraint. Deliberately not imported from anywhere: the point is
 *  to compare the map against something that is NOT another copy of the map. */
function liveVocabulary(table: string): string[] {
  const ddl = (getDb().prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table) as { sql: string }).sql
  const m = /status[^,]*?IN\s*\(([^)]*)\)/is.exec(ddl)
  if (!m) throw new Error(`no status CHECK found on ${table}`)
  return m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

describe('P3 — every LIVE status maps to exactly one stage', () => {
  beforeEach(() => { initDatabase(':memory:') })

  for (const [domain, table] of [
    ['personal', 'personal_cases'], ['zst', 'zst_cases'],
  ] as Array<[CaseDomain, string]>) {
    it(`HEADLINE (${domain}): the live CHECK vocabulary is fully mapped`, () => {
      const live = liveVocabulary(table)
      expect(live.length).toBeGreaterThan(10)   // it parsed something real
      const unmapped = live.filter(s => stageFor(domain, s) === null)
      expect(unmapped).toEqual([])
      // ...and every mapped value is a declared stage, not free text.
      for (const s of live) expect(PROGRESS_STAGES).toContain(stageFor(domain, s)!)
    })

    it(`(${domain}) the code vocabulary and the live constraint are the SAME set`, () => {
      // The drift this catches: adding a status to the TypeScript union without
      // the CHECK, or to the CHECK without the union. Either way the map would
      // look total against one artefact and be missing a value against the
      // other, and only one of the two decides what a row may contain.
      expect([...statusVocabulary(domain)].sort()).toEqual(liveVocabulary(table).sort())
    })
  }

  it('a status NOT in the vocabulary gets null, never a plausible stage', () => {
    // The counter-case for the two above. A lookup with a default would make an
    // unmapped status indistinguishable from a deliberately-ACTIONABLE one, and
    // both headline tests would still pass.
    expect(stageFor('personal', '__NO_SUCH_STATUS__')).toBeNull()
    expect(stageFor('zst', '__NO_SUCH_STATUS__')).toBeNull()
    expect(stageFor('personal', 'TRIAGE_REQUIRED')).toBeNull()   // ZST spelling
    expect(stageFor('zst', 'TRIAGE')).toBeNull()                 // personal spelling
  })
})

describe('P3 — derive, do NOT replace', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('the statuses are untouched: 17 personal, 21 ZST, all still distinct', () => {
    // The owner's actual instruction. A packet that quietly collapsed the
    // vocabulary would pass every mapping test above.
    expect(CASE_STATUSES).toHaveLength(17)
    expect(ZST_CASE_STATUSES).toHaveLength(21)
    expect(new Set(CASE_STATUSES).size).toBe(17)
    expect(new Set(ZST_CASE_STATUSES).size).toBe(21)
  })

  it('the stage is coarser than the status, and provably so', () => {
    // If every stage had exactly one status the mapping would be a rename, and
    // if every status mapped to one stage it would be a collapse. Neither.
    expect(new Set(Object.values(PERSONAL_STAGE)).size).toBeGreaterThan(1)
    expect(new Set(Object.values(PERSONAL_STAGE)).size).toBeLessThan(CASE_STATUSES.length)
    expect(new Set(Object.values(ZST_STAGE)).size).toBeGreaterThan(1)
    expect(new Set(Object.values(ZST_STAGE)).size).toBeLessThan(ZST_CASE_STATUSES.length)
  })

  it('the two namespaces are mapped separately, not by name-matching', () => {
    // ZST's REVIEW_REQUIRED and AWAITING_INTERNAL_INPUT have no personal
    // counterpart at all. A shared string-keyed table would have to invent one.
    expect(stageFor('zst', 'REVIEW_REQUIRED')).toBe('NEEDS_USER')
    expect(stageFor('zst', 'AWAITING_INTERNAL_INPUT')).toBe('NEEDS_USER')
    expect(stageFor('personal', 'REVIEW_REQUIRED')).toBeNull()
  })

  it('the two judgement calls are pinned, so a later edit is deliberate', () => {
    // BLOCKED is NEEDS_USER: stopped on something waiting cannot clear.
    expect(stageFor('personal', 'BLOCKED')).toBe('NEEDS_USER')
    // RECOVERY_REQUIRED is ACTIONABLE: §19's "a system fault must not read as
    // 'needs Istvan'". It reaches him through the recovery queue instead.
    expect(stageFor('personal', 'RECOVERY_REQUIRED')).toBe('ACTIONABLE')
    expect(stageFor('zst', 'FAILED_RECOVERABLE')).toBe('ACTIONABLE')
    expect(stageFor('zst', 'FAILED_TERMINAL')).toBe('COMPLETED')
  })
})

describe('P3 — the stage reaches the board', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('a real projection writes proj_progress_stage from the case status', () => {
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'c1', NOW - 100)
    db.prepare(`UPDATE personal_cases SET status='WAITING_EXTERNAL' WHERE case_id='c1'`).run()
    projectCase(db, 'personal', 'c1', NOW)
    expect((db.prepare(
      `SELECT proj_progress_stage AS s FROM personal_cases WHERE case_id='c1'`,
    ).get() as { s: string }).s).toBe('WAITING')
  })

  it('it FOLLOWS the status: a transition moves the stage on the next projection', () => {
    // Derived, not stamped once. A value that never moved again would look
    // identical on the first projection and be wrong for ever afterwards.
    const db = getDb()
    createCase(db, { caseId: 'c1', title: 'T', caseType: 'X' }, NOW - 100)
    seedCaseProgressionState(db, 'personal', 'c1', NOW - 100)
    db.prepare(`UPDATE personal_cases SET status='WAITING_EXTERNAL' WHERE case_id='c1'`).run()
    projectCase(db, 'personal', 'c1', NOW)

    db.prepare(`UPDATE personal_cases SET status='AWAITING_APPROVAL' WHERE case_id='c1'`).run()
    db.prepare(
      `UPDATE case_progression_state SET canonical_revision = canonical_revision + 1
        WHERE domain='personal' AND case_id='c1'`,
    ).run()
    projectCase(db, 'personal', 'c1', NOW + 10)
    expect((db.prepare(
      `SELECT proj_progress_stage AS s FROM personal_cases WHERE case_id='c1'`,
    ).get() as { s: string }).s).toBe('NEEDS_USER')
  })

  it('the ZST board gets ZST stages, from the ZST vocabulary', () => {
    const db = getDb()
    createZstCase(db, { caseId: 'z1', title: 'T', caseType: 'VENDOR' }, NOW - 100)
    seedCaseProgressionState(db, 'zst', 'z1', NOW - 100)
    db.prepare(`UPDATE zst_cases SET status='AWAITING_INTERNAL_INPUT' WHERE case_id='z1'`).run()
    projectCase(db, 'zst', 'z1', NOW)
    expect((db.prepare(
      `SELECT proj_progress_stage AS s FROM zst_cases WHERE case_id='z1'`,
    ).get() as { s: string }).s).toBe('NEEDS_USER')
  })
})
