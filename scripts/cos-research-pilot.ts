// PHASE 3 (P3-B) -- the research pilot's MEASUREMENT run.
//
// Owner ruling 2026-09-01: "Eloszor merj: query/case; talalati hasznossag;
// false positive; latency; cost; milyen aranyban valtoztatott ténylegesen
// attention/decision/recommendation eredmenyen."
//
// So this does not search. It walks the cases that are in the pilot's scope,
// asks the gate what could be sent about each, and prints the answer. Nothing
// leaves the machine on this path -- `sanctionResearchQuery` only builds and
// records; execution is a separate, deliberate act.
//
// It is NOT wired into the ten-minute cycle, and that is the point of a pilot:
// a capability whose first measurement has not been read yet does not get to
// run 144 times a day.
//
// Usage: npx tsx scripts/cos-research-pilot.ts [--limit N]

import { getDb, initDatabase } from '../src/db.js'
import { sanctionResearchQuery, pilotMetrics, researchEligibility, type ResearchCase } from '../src/cos/research/case-research.js'

const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 25

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)

const out: Record<string, unknown> = {}

for (const ns of ['personal', 'zst'] as const) {
  const table = ns === 'personal' ? 'personal_cases' : 'zst_cases'
  const rows = db.prepare(
    `SELECT case_id, title, description, case_type, sensitivity, status
       FROM ${table} WHERE archived_at IS NULL AND status NOT IN ('COMPLETED','CANCELLED','ARCHIVED')
      ORDER BY updated_at DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>

  const eligible: string[] = []
  const refusedAt: Record<string, number> = {}
  for (const r of rows) {
    const c: ResearchCase = {
      namespace: ns, caseId: String(r.case_id), title: r.title as string | null,
      description: r.description as string | null, caseType: String(r.case_type),
      declaredSensitivity: r.sensitivity, status: String(r.status),
    }
    const e = researchEligibility(c)
    if (!e.eligible) {
      const key = e.reason.split(':')[0].slice(0, 48)
      refusedAt[key] = (refusedAt[key] ?? 0) + 1
      continue
    }
    eligible.push(c.caseId)
    // A sanction attempt on an eligible case, so the gate's verdict is measured
    // and not assumed. Still nothing sent.
    sanctionResearchQuery(db, c, `${e.scope} kerdes`, now)
  }
  out[ns] = { examined: rows.length, eligibleByTier: eligible.length, refusedBeforeGate: refusedAt }
}

out.metrics = pilotMetrics(db)
console.log(JSON.stringify(out, null, 1))
