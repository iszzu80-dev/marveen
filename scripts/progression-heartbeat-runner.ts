// Progression heartbeat runner — called by a cron or scheduled task.
// Deploys schema (idempotent), seeds existing cases, then runs one heartbeat sweep.
//
// Usage: npx tsx scripts/progression-heartbeat-runner.ts
//
// SAFE to run repeatedly: deployAndSeedProgression is idempotent,
// runProgressionHeartbeat has atomic claim + lease.

import { getDb, initDatabase } from '../src/db.js'
import { deployAndSeedProgression } from '../src/cos/progression-migrate.js'
import { runProgressionHeartbeat } from '../src/cos/progression-heartbeat.js'

// getDb() returns a module-level handle that is only assigned by initDatabase().
// Inside the dashboard process that already happened at boot; a standalone
// runner must do it itself or getDb() hands back undefined and the first
// .prepare() throws. (Found by actually running this file, 2026-08-09 —
// the test suite never exercised the entry point.)
initDatabase()

const db = getDb()
const now = Math.floor(Date.now() / 1000)

// Step 1: Ensure schema + seed (idempotent)
const migration = deployAndSeedProgression(db, now, 'heartbeat-runner')
console.log('Migration:', JSON.stringify({
  tablesCreated: migration.tablesCreated,
  personalSeeded: migration.personalSeeded,
  zstSeeded: migration.zstSeeded,
  personalProgressed: migration.personalProgressed,
  zstProgressed: migration.zstProgressed,
  errors: migration.errors,
}))

// Step 2: Run one heartbeat sweep
const heartbeat = runProgressionHeartbeat(db, now, 50)
console.log('Heartbeat:', JSON.stringify({
  personal: heartbeat.personal,
  zst: heartbeat.zst,
  skippedClaimed: heartbeat.skippedClaimed,
  cycleErrors: heartbeat.cycleErrors,
  errors: heartbeat.errors,
}))

// Step 3: Lazy LLM goal enrichment (card ca33eb4b, wired 2026-08-10).
//
// Until today the interpreter existed and nothing called it, so every case's
// goal came from the per-status template and the engine could not say what any
// case was FOR. Bounded to a few per cycle: each case is interpreted once, ever
// -- it leaves the candidate set permanently -- so this is a one-time cost per
// case, not a per-cycle one.
//
// Failure here must never take the heartbeat down with it. The engine's job is
// to keep the cases moving; a missing API key or a model timeout degrades the
// goals to the old template and nothing else.
const ENRICH_PER_CYCLE = Number(process.env.COS_ENRICH_PER_CYCLE ?? 5)
if (ENRICH_PER_CYCLE > 0) {
  try {
    const { enrichPendingGoals } = await import('../src/cos/goal-enrichment.js')
    const { AnthropicLlmClient } = await import('../src/cos/progression-interpreter.js')
    const enrich = await enrichPendingGoals(db, new AnthropicLlmClient(), ENRICH_PER_CYCLE)
    console.log('GoalEnrichment:', JSON.stringify(enrich))
  } catch (e) {
    // Reported, not silent: "0 enriched" and "the enricher could not run" are
    // different facts, and only one of them means the goals are fine.
    console.log('GoalEnrichment:', JSON.stringify({
      enriched: 0, failed: true, error: String((e as Error)?.message ?? e),
    }))
  }
}
