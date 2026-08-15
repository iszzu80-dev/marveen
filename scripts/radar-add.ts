// Add ONE radar item — the Telegram path's hands (2026-08-15, Istvan's card).
//
// Istvan says what to watch and for how much; a model turns that sentence into
// these flags. The INTERPRETATION is the model's, the RULE is not: this script
// calls the same intake every other path calls, and prints the refusal reason
// when there is one.
//
// It prints the reason rather than throwing on purpose. A chat request that
// fails with a stack trace in a log looks, from Istvan's side, exactly like
// nothing happening — the silence this card exists to remove, coming back
// through the door we just built.
//
// Usage:
//   npx tsx scripts/radar-add.ts --id BUY-HOFF-BANKS --kind PRODUCT \
//     --label "HOFF Banks" --target 35000 --terms "HOFF Banks cipo" [--case PRI-SHOP-2026-003]
//   npx tsx scripts/radar-add.ts --id R-VLC --kind RENTAL --label "VLC->AGP" \
//     --target 85000 --search '{"pickup":"VLC","dropoff":"AGP"}'

import { getDb, initDatabase } from '../src/db.js'
import { addRadarItem, addRadarItemForCase, type RadarIntakeRequest } from '../src/cos/radar-intake.js'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const id = flag('id'); const kind = flag('kind'); const label = flag('label')
if (!id || !kind || !label) {
  console.error('usage: radar-add.ts --id <id> --kind PRODUCT|RENTAL --label <label> [--target N] [--terms "..."] [--search JSON] [--case <caseId>] [--interval SEC]')
  process.exit(2)
}

const targetRaw = flag('target')
const req: Omit<RadarIntakeRequest, 'caseId'> = {
  radarId: id, kind, label,
  // NOT defaulted. An absent --target must reach the gate as absent, so the
  // refusal says "nincs celar" instead of a number nobody chose being watched.
  targetPrice: targetRaw != null ? Number(targetRaw) : undefined,
  terms: flag('terms'),
  search: flag('search') ? JSON.parse(flag('search')!) : undefined,
  currency: flag('currency') ?? 'HUF',
  checkIntervalSec: flag('interval') ? Number(flag('interval')) : undefined,
}

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)
const caseId = flag('case')

const res = caseId
  ? addRadarItemForCase(db, caseId, req, now)
  : addRadarItem(db, req, now)

console.log(JSON.stringify(
  res.ok
    ? { ok: true, radarId: res.item.radar_id, label: res.item.label, targetPrice: res.item.target_price, nextCheckAt: res.item.next_check_at }
    : res,
))
// A refusal is a normal outcome, not a crash — but the exit code has to differ
// from success so a caller that only checks the code does not read "refused" as
// "watched".
process.exit(res.ok ? 0 : 1)
