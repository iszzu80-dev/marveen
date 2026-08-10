// Progression layer live-DB migration + seeding (thin vertical slice, GATE 0-2).
// Card 52250c7f. Deploys the progression schema into an existing database and
// seeds case_progression_state for every existing case that doesn't have one yet.
//
// Idempotent: safe to re-run. initProgressionSchema uses CREATE TABLE IF NOT
// EXISTS, and seeding skips cases that already have a progression state row.
//
// After deployment:
//   1. case_progression_state + case_progression_runs exist in the live DB.
//   2. Every existing personal_case and zst_case has a progression state row
//      with progression_enabled=1, progression_mode='internal'.
//   3. A one-shot progression cycle runs for each newly-seeded case so that
//      no case remains NEW merely because nothing advances it.
import { initProgressionSchema } from './schema.js';
import { runProgressionCycle } from './progression-pipeline.js';
import { scheduleNextProgression } from './progression-scheduler.js';
/** Deploy the progression schema into a live database.
 *
 *  Idempotent: initProgressionSchema uses CREATE TABLE IF NOT EXISTS and
 *  ensureColumns, so it is safe to call on a DB that already has the tables.
 *
 *  After this call, case_progression_state and case_progression_runs exist
 *  regardless of whether they existed before. */
export function deployProgressionSchema(db) {
    const hadBefore = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_progression_state'").get() !== undefined;
    initProgressionSchema(db);
    const hasAfter = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_progression_state'").get() !== undefined;
    return hasAfter && !hadBefore;
}
/** Seed progression state for every existing case that doesn't have one yet.
 *
 *  Reads personal_cases and zst_cases, creates a case_progression_state row
 *  for each case missing one. Sets progression_enabled=1 and schedules the
 *  first progression run for immediately (now).
 *
 *  Returns the count of newly-seeded cases per domain. */
export function seedProgressionState(db, now) {
    let personalSeeded = 0;
    let zstSeeded = 0;
    // Personal domain
    const personalCases = db.prepare(`SELECT case_id FROM personal_cases
     WHERE archived_at IS NULL
       AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
       AND case_id NOT IN (SELECT case_id FROM case_progression_state WHERE domain = 'personal')`).all();
    for (const c of personalCases) {
        db.prepare(`INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode,
        next_progression_at, created_at, updated_at)
       VALUES ('personal', ?, 1, 'internal', ?, ?, ?)`).run(c.case_id, now, now, now);
        personalSeeded++;
    }
    // ZST domain
    const zstCases = db.prepare(`SELECT case_id FROM zst_cases
     WHERE archived_at IS NULL
       AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED','FAILED_TERMINAL')
       AND case_id NOT IN (SELECT case_id FROM case_progression_state WHERE domain = 'zst')`).all();
    for (const c of zstCases) {
        db.prepare(`INSERT INTO case_progression_state
       (domain, case_id, progression_enabled, progression_mode,
        next_progression_at, created_at, updated_at)
       VALUES ('zst', ?, 1, 'internal', ?, ?, ?)`).run(c.case_id, now, now, now);
        zstSeeded++;
    }
    return { personalSeeded, zstSeeded };
}
/** Run one deterministic progression cycle for every newly-seeded case.
 *
 *  This is the bridge between "schema exists" and "every case has been
 *  advanced by the engine." Each case gets one progression run that
 *  reads its current state and produces a decision + reason, stored in
 *  case_progression_runs. No LLM calls (enrichCaseGoal is skipped — the
 *  enriched goal runs lazily on the next cycle or via the heartbeat).
 *
 *  The deterministic path is: deriveOutcomeContract → resolveContext →
 *  buildRollingPlan → determineNextBestAction → decide. None of these
 *  call the LLM; the decision is based purely on the case's DB state.
 *
 *  Returns counts of successfully-progressed cases per domain. */
export function runInitialProgressionForAll(db, now, triggerRef) {
    let personalProgressed = 0;
    let zstProgressed = 0;
    const errors = [];
    // Find cases whose progression state was seeded but never progressed
    // (last_progressed_at is NULL or 0)
    const dueCases = db.prepare(`SELECT domain, case_id FROM case_progression_state
     WHERE progression_enabled = 1
       AND (last_progressed_at IS NULL OR last_progressed_at = 0)
     ORDER BY domain, case_id`).all();
    for (const dc of dueCases) {
        try {
            const opts = { triggerType: 'INTAKE', triggerReference: triggerRef };
            runProgressionCycle(db, dc.domain, dc.case_id, now, opts);
            // Schedule the next progression based on the decision
            scheduleNextProgression(db, dc.domain, dc.case_id, now, now);
            if (dc.domain === 'personal')
                personalProgressed++;
            else
                zstProgressed++;
        }
        catch (err) {
            errors.push(`${dc.domain}/${dc.case_id}: ${err.message}`);
        }
    }
    return { personalProgressed, zstProgressed, errors };
}
/** Full one-shot deployment: schema + seed + initial progression for all cases.
 *
 *  Idempotent — cases that already have progression state are skipped.
 *  After this returns successfully, criteria 1 and 2 of card 52250c7f are
 *  satisfied. */
export function deployAndSeedProgression(db, now, triggerRef = 'deploy') {
    const errors = [];
    const tablesCreated = deployProgressionSchema(db);
    const { personalSeeded, zstSeeded } = seedProgressionState(db, now);
    const { personalProgressed, zstProgressed, errors: runErrors } = runInitialProgressionForAll(db, now, triggerRef);
    errors.push(...runErrors);
    return {
        tablesCreated,
        personalSeeded,
        zstSeeded,
        personalProgressed,
        zstProgressed,
        errors,
    };
}
