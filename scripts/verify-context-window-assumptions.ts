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
// GATE ADDITION (marveen, same day): the check above only ever audits a
// model isRecognizedContextModel already lets through -- it was structurally
// blind to the exact failure that started this card (claude-opus-5 ran
// thousands of turns unrecognized, silently defaulting to 200k). Proven by
// marveen's own mutation: removing sonnet-5 from the family lists left this
// script green ("SKIP, not this check's job") while a model with 74,898 real
// turns sat outside the registry. findUnrecognizedModelsInUse closes that:
// an unrecognized model with real fleet usage (not the <synthetic>
// aggregation artifact, not a negligible one-off probe) now fails this
// script too, naming the model and its peak.
//
// Read-only. No writes, no LLM, no network beyond the local sqlite file.
//
// Usage: npx tsx scripts/verify-context-window-assumptions.ts
//    or: npm run verify:context-windows
//
// Exit 0 = every recognized model's real peak is within its assumed window
//          (plus the same accounting-overshoot tolerance the rest of the
//          context guard already uses), AND no unrecognized model has real
//          fleet usage.
// Exit 1 = either a stale assumption (a recognized model's real peak now
//          exceeds its assumed limit) or a registry gap (an unrecognized
//          model with real usage) -- the printed evidence says which.

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findContextWindowViolations,
  findUnrecognizedModelsInUse,
  isRecognizedContextModel,
  type ModelPeakObservation,
} from '../src/context-guard.js'

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
const registryGaps = findUnrecognizedModelsInUse(observations)

let checked = 0
let skipped = 0

for (const obs of observations) {
  const v = violations.find((x) => x.model === obs.model)
  const gap = registryGaps.find((x) => x.model === obs.model)
  if (v) {
    console.error(
      `VIOLATION: ${v.model} -- assumed limit ${v.assumedLimit.toLocaleString()} (tolerated up to ${Math.round(v.toleratedLimit).toLocaleString()}), `
      + `but real peak is ${v.peak.toLocaleString()} across ${v.turnCount.toLocaleString()} turns. `
      + `src/context-guard.ts's stated assumption for this model no longer holds.`,
    )
  } else if (gap) {
    console.error(
      `REGISTRY-GAP: ${gap.model} -- not recognized by src/context-guard.ts's family lists, `
      + `but has REAL fleet usage: peak ${gap.peak.toLocaleString()} across ${gap.turnCount.toLocaleString()} turns. `
      + `This is the exact shape of the original defect (an in-use model absent from the registry) -- add it to a family list.`,
    )
  } else if (isRecognizedContextModel(obs.model)) {
    checked++
    console.log(`OK: ${obs.model} peak=${obs.peak.toLocaleString()} (${obs.turnCount.toLocaleString()} turns)`)
  } else {
    // Exempt: <synthetic>-shaped artifact (peak<=0) or negligible turn count
    // (see findUnrecognizedModelsInUse) -- not enough real usage to demand
    // registry recognition.
    skipped++
    console.log(`SKIP: ${obs.model} not a recognized family, but negligible/artifact (peak=${obs.peak.toLocaleString()}, ${obs.turnCount.toLocaleString()} turns) -- not enough real usage to matter`)
  }
}

if (violations.length > 0 || registryGaps.length > 0) {
  if (violations.length > 0) {
    console.error(
      `\nverify-context-window-assumptions: ${violations.length} model(s) exceed their assumed context window. `
      + `Update src/context-guard.ts's family lists/limits from the evidence above (same shape as card 585c056c part 2).`,
    )
  }
  if (registryGaps.length > 0) {
    console.error(
      `verify-context-window-assumptions: ${registryGaps.length} model(s) have real fleet usage but no registry entry -- `
      + `the original card 585c056c defect, unfixed for that model. Add it to src/context-guard.ts's family lists.`,
    )
  }
  console.error('\nverify-context-window-assumptions: FAILED')
  process.exit(1)
}

console.log(`\nverify-context-window-assumptions: OK -- ${checked} recognized model(s) checked (${skipped} negligible/artifact skipped), all within their assumed window, no registry gaps.`)
process.exit(0)
