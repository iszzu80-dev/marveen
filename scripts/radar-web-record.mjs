#!/usr/bin/env node
// Record ONE web-search-found product price into the radar (agent-driven daily
// sweep). The COS radar's write primitive is recordObservation; this script is
// the thin bridge from a price the agent found via plain web search to that
// primitive, so the "wide web search" mode reuses the same dedup / HIT / notify
// logic as the adapter path — no parallel bookkeeping.
//
// Usage:
//   node scripts/radar-web-record.mjs <radar_id> <priceMajor> <shop> <url>
// priceMajor is the price in the item's currency major unit (e.g. 60990 for HUF).
// Prints a JSON line: {hit, isNewLow, status, bestPrice, notify, offerId}.
// Does NOT send any alert — the caller (the daily sweep) decides that from `notify`.

import Database from '../node_modules/better-sqlite3/lib/index.js'
import { recordObservation } from '../dist/cos/radar.js'

const [, , radarId, priceRaw, shop = 'web', url = ''] = process.argv
if (!radarId || priceRaw == null) {
  console.error('usage: radar-web-record.mjs <radar_id> <priceMajor> <shop> <url>')
  process.exit(2)
}
const price = Number(priceRaw)
if (!Number.isFinite(price)) { console.error('priceMajor must be a number'); process.exit(2) }

const db = new Database(new URL('../store/claudeclaw.db', import.meta.url).pathname)
const now = Math.floor(Date.now() / 1000)
const item = db.prepare("SELECT radar_id, currency FROM radar_items WHERE radar_id=? AND kind='PRODUCT'").get(radarId)
if (!item) { console.error(`no PRODUCT radar item ${radarId}`); process.exit(1) }

const res = recordObservation(db, radarId, {
  bestPrice: Math.round(price),
  currency: (item.currency || 'HUF').toUpperCase(),
  offerCount: 1,
  // Stable per-shop id so the SAME shop's standing price does not re-alert daily
  // (P1.6 dedup); a new cheaper shop is a new offer and DOES alert.
  offerId: `websearch|${shop}`,
  offerRef: { shop, url, price: Math.round(price) },
}, now)
db.close()
console.log(JSON.stringify({ radarId, ...res }))
