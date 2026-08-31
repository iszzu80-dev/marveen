import { statSync } from 'node:fs'
import { initDatabase, getDb } from '../src/db.js'
import { projectIntelligence } from '../src/cos/intelligence/project.js'

const DB = '/home/iszzu/marveen/store/claudeclaw.db'
const st = statSync(DB)
console.log(`db=${DB} inode=${st.ino}`)
initDatabase(DB)
const db = getDb()
const now = Math.floor(Date.now() / 1000)

const before = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as { n: number; m: number }

for (const ns of ['personal', 'zst'] as const) {
  const p = projectIntelligence(db, ns, now)
  console.log(`\n=== ${ns} ===`)
  console.log(`commitments ${p.commitments.length}  decisions ${p.decisions.length}  opportunities ${p.opportunities.length}`)
  const byStatus = new Map<string, number>()
  for (const c of p.commitments) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1)
  console.log('commitment status:', [...byStatus].map(([k, v]) => `${k}=${v}`).join(' '))
  console.log(`attention: interrupt ${p.attention.interrupt.length}  quiet ${p.attention.quiet.length}  suppressed ${p.attention.suppressed.length}`)
  for (const i of p.attention.interrupt) {
    console.log(`  [${i.band}] ${i.element.caseId} :: ${i.why.slice(0, 90)}`)
  }
  const breaches = p.anomalies.filter(a => a.includes('INVARIANT BREACH'))
  console.log(`anomalies ${p.anomalies.length} (invariant breaches: ${breaches.length})`)
  for (const a of p.anomalies.slice(0, 3)) console.log(`  - ${a.slice(0, 120)}`)
}

const after = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as { n: number; m: number }
console.log(`\nREAD-ONLY CHECK: rows ${before.n}->${after.n}, max updated_at ${before.m}->${after.m} ` +
  `(${before.n === after.n && before.m === after.m ? 'UNCHANGED' : 'CHANGED -- THIS IS A BUG'})`)
