#!/usr/bin/env -S npx tsx
// verify-context-window-assumptions.ts
//
// Card 585c056c part 2. src/context-guard.ts's contextLimitForModel assigns
// each model family a context-window limit, and every non-obvious one is
// justified in a comment by a STATED, checkable observation (e.g. "sonnet-5
// max 197,885 across 14 days"). Nothing enforced that the observation still
// held -- it silently went stale (real peak 935,023, 4.7x the claim) until
// marveen re-measured it by hand while gating an unrelated card.
//
// This is the check that should have existed the first time: re-measure
// every RECOGNIZED model's real peak context from live token_usage and fail
// loud the moment a family's assumed limit no longer covers it. The pure
// comparison (findContextWindowViolations) is unit-tested with synthetic
// data in src/__tests__/context-guard.test.ts; this script supplies the real
// numbers and is what an operator (or a scheduled heartbeat) actually runs.
//
// Read-only. No writes, no LLM, no network beyond the local sqlite file.
//
// Usage: npx tsx scripts/verify-context-window-assumptions.ts
//    or: npm run verify:context-windows
//
// Exit 0 = every recognized model's real peak is within its assumed window
//          (plus the same accounting-overshoot tolerance the rest of the
//          context guard already uses).
// Exit 1 = at least one assumption in src/context-guard.ts has gone stale --
//          update the family list/limit from the printed evidence.

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findContextWindowViolations, isRecognizedContextModel, type ModelPeakObservation } from '../src/context-guard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const DB_PATH = join(PROJECT_ROOT, 'store', 'claudeclaw.db')

if (!existsSync(DB_PATH)) {
  console.log(`verify-context-window-assumptions: no database at ${DB_PATH} -- nothing to check (fresh worktree/install)`)
  process.exit(0)
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

interface Row { model: string | null; peak: number | null; cnt: number }

const rows = db.prepare(`
  SELECT model,
         MAX(input_tokens + COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)) AS peak,
         COUNT(*) AS cnt
  FROM token_usage
  WHERE model IS NOT NULL AND model != ''
  GROUP BY model
`).all() as Row[]

db.close()

const observations: ModelPeakObservation[] = rows
  .filter((r): r is Row & { model: string; peak: number } => typeof r.model === 'string' && typeof r.peak === 'number')
  .map((r) => ({ model: r.model, peak: r.peak, turnCount: r.cnt }))

const violations = findContextWindowViolations(observations)

let checked = 0
let skipped = 0

for (const obs of observations) {
  const v = violations.find((x) => x.model === obs.model)
  if (v) {
    console.error(
      `VIOLATION: ${v.model} -- assumed limit ${v.assumedLimit.toLocaleString()} (tolerated up to ${Math.round(v.toleratedLimit).toLocaleString()}), `
      + `but real peak is ${v.peak.toLocaleString()} across ${v.turnCount.toLocaleString()} turns. `
      + `src/context-guard.ts's stated assumption for this model no longer holds.`,
    )
  } else if (isRecognizedContextModel(obs.model)) {
    checked++
    console.log(`OK: ${obs.model} peak=${obs.peak.toLocaleString()} (${obs.turnCount.toLocaleString()} turns)`)
  } else {
    // Not this script's job: isRecognizedContextModel(false) means
    // contextLimitForModel would fall through to its 200k default for this
    // model -- flagging THAT is fleet-context-guard.sh's UNKNOWN-MODEL path
    // at runtime, not a "this assumption went stale" finding here.
    skipped++
    console.log(`SKIP: ${obs.model} not a recognized family (peak=${obs.peak.toLocaleString()}, ${obs.turnCount.toLocaleString()} turns) -- not this check's job`)
  }
}

if (violations.length > 0) {
  console.error(
    `\nverify-context-window-assumptions: FAILED -- ${violations.length} model(s) exceed their assumed context window. `
    + `Update src/context-guard.ts's family lists/limits from the evidence above (same shape as card 585c056c part 2).`,
  )
  process.exit(1)
}

console.log(`\nverify-context-window-assumptions: OK -- ${checked} recognized model(s) checked (${skipped} unrecognized skipped), all within their assumed window.`)
process.exit(0)
