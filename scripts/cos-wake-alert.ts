// Cycle step: surface the cases whose wake time has arrived.
//
// The wake mechanism had a writer and a reader and no consumer — the tick kept
// `dueCases(...).length` and dropped the rows, so `next_wake_at` stood at 0 of
// 61 open cases. This is the consumer. It posts to the bus and clears the wake,
// so a case is announced once, not every ten minutes.
//
// Silent when nothing woke: this is an event alert, not a digest. The daily
// digests (planned / radar) carry the zero case; a wake that did not happen is
// not news, and saying so every cycle would bury the wakes that did.
//
// Usage: npx tsx scripts/cos-wake-alert.ts

import { getDb, initDatabase } from '../src/db.js'
import { alertWokenCases } from '../src/cos/wake-alert.js'

initDatabase()
const r = alertWokenCases(getDb(), Math.floor(Date.now() / 1000))
console.log(JSON.stringify({ posted: r.posted, woken: r.woken.map((c) => c.case_id) }))
