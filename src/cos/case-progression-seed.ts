// Seeding a new case's progression state — one implementation for both domains.
//
// Extracted 2026-08-13. The block below was verbatim in intake.ts and
// zst-intake.ts, differing only in the string 'personal' / 'zst'. Two copies of
// a guarded INSERT is two places to remember when the guard or the defaults
// change, and the ZST copy exists only because the personal one was pasted.
//
// The table-existence guard is the load-bearing part: the progression schema is
// deployed separately, and on an installation that does not have it yet the
// intake path must behave exactly as it did before progression existed rather
// than throwing on every new case.

import type Database from 'better-sqlite3'

export type ProgressionDomain = 'personal' | 'zst'

/** Seed progression state for a freshly created case so it does not stagnate at
 *  NEW. INSERT OR IGNORE: re-seeding an existing case is a no-op, never a reset
 *  of a case already being progressed. */
export function seedCaseProgressionState(
  db: Database.Database, domain: ProgressionDomain, caseId: string, now: number,
): void {
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_progression_state'",
  ).get() as { 1: number } | undefined
  if (!tableExists) return
  db.prepare(
    `INSERT OR IGNORE INTO case_progression_state
     (domain, case_id, progression_enabled, progression_mode,
      next_progression_at, created_at, updated_at)
     VALUES (?, ?, 1, 'internal', ?, ?, ?)`,
  ).run(domain, caseId, now, now, now)
}
