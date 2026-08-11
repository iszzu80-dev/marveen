// Ú-5: one event, one name (review #3).
//
// When §10.8's eight trigger names arrived, the old six stayed legal, so the
// stored vocabulary is fourteen wide and half of it overlaps. An analysis of
// "what wakes cases" then counts the same event under two names and nobody
// notices, because both numbers look plausible.
//
// The de-duplication happens at the WRITE boundary only. Old rows keep their old
// values: rewriting history so a report reads better is how history stops being
// evidence.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { createCase } from '../cos/case-store.js'
import { canonicalTriggerType, TRIGGER_TYPES } from '../cos/progression-trigger.js'
import { runProgressionCycle } from '../cos/progression-pipeline.js'
import { runProgressionHeartbeat } from '../cos/progression-heartbeat.js'
import { initProgressionSchema } from '../cos/schema.js'

const T0 = 1_700_000_000

describe('trigger vocabulary', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    initProgressionSchema(getDb())
  })

  it('the synonyms collapse onto the §10.8 name', () => {
    expect(canonicalTriggerType('WAKE')).toBe('WAIT_WAKE_DUE')
    expect(canonicalTriggerType('MANUAL')).toBe('MANUAL_REVIEW_REQUEST')
    expect(canonicalTriggerType('RECOVERY')).toBe('CAPABILITY_RECOVERED')
  })

  it('INTAKE is NOT folded into NEW_RELEVANT_EVENT', () => {
    // Against the review's suggestion, on purpose. Intake is a case coming into
    // existence; a new relevant event happens to a case that already exists.
    // Folding them would answer "where do cases come from" with "what wakes
    // them" — and the live store has 101 rows that mean the first.
    expect(canonicalTriggerType('INTAKE')).toBe('INTAKE')
    expect(canonicalTriggerType('ESCALATION_RESOLVED')).toBe('ESCALATION_RESOLVED')
  })

  it('every §10.8 name is already canonical (the map cannot rename them)', () => {
    for (const t of TRIGGER_TYPES) expect(canonicalTriggerType(t)).toBe(t)
  })

  it('a run WRITES the canonical name', () => {
    createCase(getDb(), { caseId: 'c1', title: 'x', caseType: 'ADMIN' }, T0)
    runProgressionCycle(getDb(), 'personal', 'c1', T0 + 1, { triggerType: 'WAKE' })
    const row = getDb().prepare(
      `SELECT trigger_type FROM case_progression_runs WHERE case_id='c1' ORDER BY started_at DESC LIMIT 1`,
    ).get() as { trigger_type: string }
    expect(row.trigger_type).toBe('WAIT_WAKE_DUE')
  })

  it('HEADLINE: the heartbeat never writes SCHEDULED', () => {
    // §10.8's whole claim is that the clock coming round is not a reason. The
    // heartbeat used to fall back to 'SCHEDULED' when the trigger was missing,
    // which put the clock back into the record by another route.
    createCase(getDb(), { caseId: 'c1', title: 'x', caseType: 'ADMIN' }, T0)
    runProgressionHeartbeat(getDb(), T0 + 10, 50)
    runProgressionHeartbeat(getDb(), T0 + 20, 50)
    const scheduled = getDb().prepare(
      `SELECT COUNT(*) AS n FROM case_progression_runs WHERE trigger_type='SCHEDULED'`,
    ).get() as { n: number }
    expect(scheduled.n).toBe(0)
  })

  it('an existing SCHEDULED row stays legal — history is not rewritten', () => {
    // The CHECK constraint must keep accepting what is already stored, or a
    // migration would have to delete 16 563 rows of real history.
    expect(() => getDb().prepare(
      `INSERT INTO case_progression_runs
         (progression_run_id, domain, case_id, trigger_type, trigger_reference, started_at, status)
       VALUES ('r-old','personal','c1','SCHEDULED','legacy',?,'COMPLETED')`,
    ).run(T0)).not.toThrow()
  })
})
