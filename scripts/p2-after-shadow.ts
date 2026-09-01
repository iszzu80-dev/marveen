import { statSync } from 'node:fs'
import { initDatabase, getDb } from '../src/db.js'
import { projectIntelligence } from '../src/cos/intelligence/project.js'
const DB = '/home/iszzu/marveen/store/claudeclaw.db'
initDatabase(DB); const db = getDb()
const now = Math.floor(Date.now() / 1000)
const before = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
const out: any = { inode: statSync(DB).ino, ns: {} }
for (const ns of ['personal', 'zst'] as const) {
  const p = projectIntelligence(db, ns, now)
  const bands: Record<string, number> = {}
  for (const g of ['interrupt', 'quiet', 'suppressed'] as const)
    for (const i of (p.attention as any)[g]) { const it = g === 'suppressed' ? i.item : i; bands[`${g}:${it.band}`] = (bands[`${g}:${it.band}`] ?? 0) + 1 }
  const tiers: Record<string, number> = {}
  for (const c of p.commitments) if (c.status === 'UNKNOWN') tiers[(c as any).closureEvidence ?? 'null'] = (tiers[(c as any).closureEvidence ?? 'null'] ?? 0) + 1
  out.ns[ns] = { interrupt: p.attention.interrupt.map((i: any) => ({ band: i.band, cid: i.element.caseId, why: i.why.slice(0, 80) })),
    bands, unknownTiers: tiers, anomalies: p.anomalies.length }
}
const after = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
out.readOnly = (before.n === after.n && before.m === after.m) ? 'UNCHANGED' : 'CHANGED-BUG'
console.log(JSON.stringify(out, null, 1))
