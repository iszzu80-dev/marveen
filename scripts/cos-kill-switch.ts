#!/usr/bin/env npx tsx
/**
 * The COS kill switch, from a terminal.
 *
 *   npx tsx scripts/cos-kill-switch.ts status
 *   npx tsx scripts/cos-kill-switch.ts engage "why"      [--actor istvan]
 *   npx tsx scripts/cos-kill-switch.ts release "why"     [--actor istvan]
 *
 * WHY A SCRIPT AND NOT ONLY AN ENDPOINT. A stop button that lives only inside
 * the dashboard is unavailable in exactly the situation it exists for: the hour
 * the dashboard is wedged, or serving stale code, or the thing misbehaving. This
 * path needs nothing but the database file.
 *
 * ENGAGE takes a reason and stores it. Not bureaucracy: the reason is what tells
 * the next person (or the next me, at 3am) whether it is safe to release.
 */
import { getDb, initDatabase } from '../src/db.js'
import { engageKillSwitch, releaseKillSwitch, killSwitchState } from '../src/cos/kill-switch.js'

const argv = process.argv.slice(2)
const cmd = argv[0]
const reason = argv.find((a, i) => i > 0 && !a.startsWith('--')) ?? ''
const actorIdx = argv.indexOf('--actor')
const actor = actorIdx >= 0 ? argv[actorIdx + 1] : 'cli'
const now = Math.floor(Date.now() / 1000)

initDatabase(process.env.MARVEEN_DB ?? 'store/claudeclaw.db')
const db = getDb()

if (cmd === 'engage') {
  if (!reason) {
    console.error('engage needs a reason: npx tsx scripts/cos-kill-switch.ts engage "why"')
    process.exit(2)
  }
  const r = engageKillSwitch(db, { reason, actor }, now)
  console.log(JSON.stringify({ ...r, ...killSwitchState(db) }, null, 1))
} else if (cmd === 'release') {
  console.log(JSON.stringify(releaseKillSwitch(db, { actor, reason: reason || undefined }, now), null, 1))
} else if (cmd === 'status' || !cmd) {
  const s = killSwitchState(db)
  const recent = db.prepare(
    `SELECT engaged, reason, actor, tickets_revoked, created_at FROM cos_kill_switch_events
     ORDER BY event_id DESC LIMIT 5`
  ).all()
  console.log(JSON.stringify({ ...s, recent }, null, 1))
} else {
  console.error(`unknown command: ${cmd} (status | engage | release)`)
  process.exit(2)
}
