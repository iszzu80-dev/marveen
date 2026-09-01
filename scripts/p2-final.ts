import { statSync } from 'node:fs'
import { initDatabase, getDb } from '../src/db.js'
import { projectIntelligence } from '../src/cos/intelligence/project.js'
const DB = '/home/iszzu/marveen/store/claudeclaw.db'
initDatabase(DB); const db = getDb()
const now = Math.floor(Date.now() / 1000)
const before = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
const out: any = { inode: statSync(DB).ino, ns: {} }
for (const ns of ['personal', 'zst'] as const) {
  const t = ns === 'personal' ? 'personal_cases' : 'zst_cases'
  const p = projectIntelligence(db, ns, now)
  const byStatus: Record<string, number> = {}
  const byEvidence: Record<string, number> = {}
  for (const c of p.commitments as any[]) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
    byEvidence[c.obligationEvidence] = (byEvidence[c.obligationEvidence] ?? 0) + 1
  }
  const byReason: Record<string, number> = {}
  for (const a of p.caseAttention as any[]) byReason[a.reason] = (byReason[a.reason] ?? 0) + 1
  out.ns[ns] = {
    commitments: p.commitments.length, byStatus, byEvidence,
    caseAttention: p.caseAttention.length, byReason,
    opportunities: p.opportunities.length,
    interrupt: p.attention.interrupt.map((i: any) => ({ band: i.band, cid: i.element.caseId, why: i.why.slice(0, 100) })),
    quiet: p.attention.quiet.length, suppressed: p.attention.suppressed.length,
    opportunityInInterrupt: p.attention.interrupt.filter((i: any) => i.band === 'OPPORTUNITY').length,
    falseOverdue: (p.commitments as any[]).filter(c => c.status === 'EXPIRED' && c.obligationEvidence !== 'EXPLICIT_DEADLINE').length,
    anomalies: p.anomalies.length, breaches: p.anomalies.filter((a: string) => a.includes('INVARIANT BREACH')).length,
  }
}
const after = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
out.readOnly = (before.n === after.n && before.m === after.m) ? 'UNCHANGED' : 'CHANGED-BUG'
console.log(JSON.stringify(out, null, 1))
