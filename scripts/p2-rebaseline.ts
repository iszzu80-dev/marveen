import { statSync } from 'node:fs'
import { initDatabase, getDb } from '../src/db.js'
import { projectIntelligence } from '../src/cos/intelligence/project.js'
const DB = '/home/iszzu/marveen/store/claudeclaw.db'
initDatabase(DB); const db = getDb()
const now = Math.floor(Date.now() / 1000)
const before = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
const out: any = { inode: statSync(DB).ino, now, ns: {} }
for (const ns of ['personal', 'zst'] as const) {
  const t = ns === 'personal' ? 'personal_cases' : 'zst_cases'
  const p = projectIntelligence(db, ns, now)
  const byStatus: Record<string, number> = {}
  for (const c of p.commitments) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
  const bands: Record<string, number> = {}
  for (const g of ['interrupt', 'quiet', 'suppressed'] as const)
    for (const i of (p.attention as any)[g]) { const it = g === 'suppressed' ? i.item : i; bands[`${g}:${it.band}`] = (bands[`${g}:${it.band}`] ?? 0) + 1 }
  const expired = p.commitments.filter(c => c.status === 'EXPIRED').map((c: any) => {
    const r = db.prepare(`SELECT title,status,due_at,created_at,priority FROM ${t} WHERE case_id=?`).get(c.caseId) as any
    return { cid: c.caseId, owner: c.owner, dueAt: c.dueAt, ageDays: +((now - c.dueAt) / 86400).toFixed(1),
      caseStatus: r.status, priority: r.priority, dueBeforeCreated: c.dueAt < r.created_at, title: (r.title || '').slice(0, 62) }
  }).sort((a, b) => b.ageDays - a.ageDays)
  const withWake = p.commitments.filter((c: any) => c.dueAt == null && c.reviewWakeAt != null).length
  out.ns[ns] = { commitments: p.commitments.length, byStatus, opportunities: p.opportunities.length,
    decisions: p.decisions.length, bands, expired,
    openWithReviewWake: withWake,
    interrupt: p.attention.interrupt.map((i: any) => ({ band: i.band, cid: i.element.caseId, why: i.why.slice(0, 70) })),
    anomalies: p.anomalies.length, breaches: p.anomalies.filter((a: string) => a.includes('INVARIANT BREACH')).length }
}
const after = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
out.readOnly = (before.n === after.n && before.m === after.m) ? 'UNCHANGED' : 'CHANGED-BUG'
console.log(JSON.stringify(out, null, 1))
