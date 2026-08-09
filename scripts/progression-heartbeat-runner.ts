// Progression heartbeat runner — called by a cron or scheduled task.
// Deploys schema (idempotent), seeds existing cases, then runs one heartbeat sweep.
//
// Usage: npx tsx scripts/progression-heartbeat-runner.ts
//
// SAFE to run repeatedly: deployAndSeedProgression is idempotent,
// runProgressionHeartbeat has atomic claim + lease.

import { getDb } from '../src/db.js'
import { deployAndSeedProgression } from '../src/cos/progression-migrate.js'
import { runProgressionHeartbeat } from '../src/cos/progression-heartbeat.js'

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
