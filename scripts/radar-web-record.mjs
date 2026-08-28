#!/usr/bin/env node
// Record ONE web-search-found product price into the radar (agent-driven daily
// sweep). The COS radar's write primitive is recordObservation; this script is
// the thin bridge from a price the agent found via plain web search to that
// primitive, so the "wide web search" mode reuses the same dedup / HIT / notify
// logic as the adapter path — no parallel bookkeeping.
//
// Usage:
//   node scripts/radar-web-record.mjs <radar_id> <priceMajor> <shop> <url> [YES|NO|UNKNOWN]
// The 5th argument is what the sweep could ESTABLISH about delivery to Hungary.
// Omit it when the page did not say — it defaults to UNKNOWN, which keeps the
// find visible on the daily "not verified" line without turning it into a deal.
// priceMajor is the price in the item's currency major unit (e.g. 60990 for HUF).
// Prints a JSON line: {hit, isNewLow, status, bestPrice, notify, offerId, delivered}.
//
// IT SENDS THE ALERT ITSELF. This line used to read "Does NOT send any alert —
// the caller (the daily sweep) decides that from `notify`", and that caller was
// a model reading this stdout. Measured 2026-08-15: three at-target product
// observations were recorded here (08-07 Shopsy 27 990, 08-07 About You 11 745,
// 08-09 ecipo.hu 34 120) and NOT ONE reached Istvan — the only radar alert ever
// posted to the bus came from the tick's own code path. `markNotified` was never
// called on this path either, so the per-shop dedup the sweep skill advertises
// did not exist here at all.
//
// Delivery is therefore no longer the caller's to forget. The record+deliver
// chain lives in src/cos/radar-web.ts, NOT here: this file hardwires the live
// store path, so anything implemented in it can only be tested against the real
// database. A step that cannot be tested is how the previous version shipped.
// This script is now argv parsing and nothing else.
import { initDatabase, getDb } from '../dist/db.js'
import { recordWebObservation } from '../dist/cos/radar-web.js'

const [, , radarId, priceRaw, shop = 'web', url = '', shippableRaw] = process.argv
if (!radarId || priceRaw == null) {
  console.error('usage: radar-web-record.mjs <radar_id> <priceMajor> <shop> <url>')
  process.exit(2)
}
const price = Number(priceRaw)
if (!Number.isFinite(price)) { console.error('priceMajor must be a number'); process.exit(2) }

// THROUGH `initDatabase`, NOT A PRIVATE HANDLE, and this is the third act of the
// same defect. The header above says delivery "is therefore no longer the
// caller's to forget" -- and it still failed, one layer further in. This file
// opened its own better-sqlite3 handle and passed it down, so
// `recordWebObservation` wrote observations correctly while the alert it then
// calls reached `createAgentMessage`, which reads the MODULE-LEVEL db singleton
// in db.js. That singleton is set only by `initDatabase`, which nothing on this
// path ever called. So every HIT recorded through this script died at
// "Cannot read properties of undefined (reading 'prepare')", was caught, and
// logged "NOT marked notified, will retry next tick" -- a retry that runs this
// same script and fails identically. A permanent drop wearing a retry message.
// Measured live 2026-08-28 on BUY-SHOE-005 at 34 120 HUF: notify.should=true,
// delivered=false, and neither the bus post nor the daily-log line nor the
// outbox row was written, because the first of the three threw.
//
// One handle now, shared by the write and by the delivery that follows it.
initDatabase(new URL('../store/claudeclaw.db', import.meta.url).pathname)
const db = getDb()
const now = Math.floor(Date.now() / 1000)
const item = db.prepare("SELECT radar_id, currency FROM radar_items WHERE radar_id=? AND kind='PRODUCT'").get(radarId)
if (!item) { console.error(`no PRODUCT radar item ${radarId}`); process.exit(1) }

const SHIPPABLE = new Set(['YES', 'NO', 'UNKNOWN'])
const shippableHu = shippableRaw ? String(shippableRaw).toUpperCase() : 'UNKNOWN'
// A typo must not silently become a guarantee: an unrecognised value is
// rejected outright rather than falling back to YES (or, worse, being passed
// through to the DB's CHECK-less TEXT column).
if (!SHIPPABLE.has(shippableHu)) {
  console.error(`shippable must be YES, NO or UNKNOWN (got: ${shippableRaw})`); process.exit(2)
}

const res = recordWebObservation(db, {
  radarId, price, shop, url, currency: item.currency || 'HUF', shippableHu,
}, now)
db.close()
console.log(JSON.stringify(res))
