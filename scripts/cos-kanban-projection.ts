// PHASE 3 (P3-C) -- project the cases that need Istvan's hands onto the Kanban.
//
// One-way, by construction: this step reads cases and writes board rows, and
// there is no path back. A card moved on the board changes no case; the next
// refresh finds the need still open and says so, which is the honest behaviour
// for a view.
//
// Usage: npx tsx scripts/cos-kanban-projection.ts [--dry]

import { getDb, initDatabase } from '../src/db.js'
import { humanActionNeeds, syncKanbanProjection } from '../src/cos/kanban-bridge.js'

const dry = process.argv.includes('--dry')

initDatabase()
const db = getDb()

const out: Record<string, unknown> = { dry }
const problems: string[] = []

for (const ns of ['personal', 'zst'] as const) {
  try {
    if (dry) {
      const needs = humanActionNeeds(db, ns, Math.floor(Date.now() / 1000))
      out[ns] = { needs: needs.length, cases: needs.map((n) => `${n.caseId}:${n.reason}`) }
      continue
    }
    const r = syncKanbanProjection(db, ns)
    out[ns] = r
    // A refused card is not a crash and not a success: our deterministic id
    // already belongs to something this bridge does not own, so a human-action
    // need has NO card and nothing on the board would show that.
    if (r.refusedForeign.length) {
      problems.push(`${ns}: ${r.refusedForeign.length} card id(s) already exist and are not ours: ${r.refusedForeign.join(', ')}`)
    }
  } catch (e) {
    out[ns] = { failed: true, error: e instanceof Error ? e.message : String(e) }
    problems.push(`${ns}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

out.problems = problems
console.log(JSON.stringify(out))
if (problems.length) process.exit(1)
