// Surface the radar's UNVERIFIED finds once a day (2026-08-15, Istvan's card).
//
// A hit alerts immediately. This is the other half: offers that met the target
// price but whose delivery to Hungary could not be confirmed. They are not
// deals, so they must not alert — but if they vanish, "nothing was cheap
// enough" and "three were, and we could not check" look identical, and that
// ambiguity is what hid a week of radar silence.
//
// The zero case is reported too, for the same reason the PLANNED digest reports
// its own: a signal that only speaks when something is wrong is indistinguishable
// from one that stopped running.
//
// Usage: npx tsx scripts/cos-radar-digest.ts [--dry]

import { getDb, initDatabase } from '../src/db.js'
import { buildRadarDigest, reportUnverifiedFinds } from '../src/cos/radar-digest.js'

const dry = process.argv.includes('--dry')

initDatabase()
const db = getDb()

if (dry) {
  const d = buildRadarDigest(db)
  console.log(JSON.stringify({ dry: true, count: d.count, text: d.text }))
} else {
  console.log(JSON.stringify(reportUnverifiedFinds(db)))
}
