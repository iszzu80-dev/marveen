// Surface the PLANNED outbound queue once a day (2026-08-15).
//
// A drafted letter waits in outbound_ledger as PLANNED until Istvan approves it.
// Nothing used to push that queue in front of him: the recovery alert only looks
// at RECOVERY_REQUIRED and the scheduler deliberately excludes PLANNED. One real
// letter sat there for two days before anyone noticed, and only because he asked.
//
// The zero case is reported too. A daily signal that goes quiet when the queue is
// empty cannot be told apart from one that broke.
//
// Usage: npx tsx scripts/cos-planned-digest.ts [--dry]

import { getDb, initDatabase } from '../src/db.js'
import { buildPlannedDigest, reportPlannedOutbound } from '../src/cos/outbound-alert.js'

const dry = process.argv.includes('--dry')

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)

if (dry) {
  const d = buildPlannedDigest(db, now)
  console.log(JSON.stringify({ dry: true, count: d.count, oldestAgeDays: d.oldestAgeDays, text: d.text }))
} else {
  const r = reportPlannedOutbound(db, now)
  console.log(JSON.stringify(r))
}
