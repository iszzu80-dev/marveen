import { initDatabase, getDb } from '../src/db.js'
import { projectIntelligence } from '../src/cos/intelligence/project.js'
initDatabase('/home/iszzu/marveen/store/claudeclaw.db'); const db = getDb()
const now = Math.floor(Date.now() / 1000)
for (const ns of ['personal', 'zst'] as const) {
  const t = ns === 'personal' ? 'personal_cases' : 'zst_cases'
  const p = projectIntelligence(db, ns, now)
  const unk = p.commitments.filter((c: any) => c.status === 'UNKNOWN')
  const tiers: Record<string, number> = {}
  for (const c of unk as any[]) tiers[c.closureEvidence ?? 'null'] = (tiers[c.closureEvidence ?? 'null'] ?? 0) + 1
  console.log(`=== ${ns}: ${unk.length} COMPLETION_UNVERIFIED`, JSON.stringify(tiers))
  const none = (unk as any[]).filter(c => c.closureEvidence === 'NONE')
  for (const c of none) {
    const r = db.prepare(`SELECT title,status FROM ${t} WHERE case_id=?`).get(c.caseId) as any
    console.log(`   NONE  ${r.status.padEnd(10)} ${c.caseId.slice(0, 32).padEnd(34)} ${(r.title || '').slice(0, 46)}`)
  }
  // total terminal cases, for the denominator
  const term = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE archived_at IS NULL AND status IN ('COMPLETED','CANCELLED','ARCHIVED')`).get() as any
  console.log(`   (lezart ugyek osszesen: ${term.n})`)
  console.log(`   attention: interrupt ${p.attention.interrupt.length}, quiet ${p.attention.quiet.length}`)
  console.log(`   interrupt savok: ${p.attention.interrupt.map((i: any) => i.band).join(', ')}`)
}
