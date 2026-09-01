import { initDatabase, getDb } from '../src/db.js'
import { projectIntelligence } from '../src/cos/intelligence/project.js'
const DB = '/home/iszzu/marveen/store/claudeclaw.db'
initDatabase(DB); const db = getDb()
const now = Math.floor(Date.now() / 1000)
const before = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
const GENERIC = /^(Review the latest (company )?source and define the next concrete( operational)? step|Check for the external reply)/i
const out: any = { ns: {} }
for (const ns of ['personal', 'zst'] as const) {
  const t = ns === 'personal' ? 'personal_cases' : 'zst_cases'
  const p = projectIntelligence(db, ns, now)
  const rows = (c: any) => db.prepare(`SELECT title,status,priority,next_action,due_at,created_at FROM ${t} WHERE case_id=?`).get(c.caseId) as any
  const generic = p.commitments.filter((c: any) => { const r = rows(c); return r && GENERIC.test((r.next_action || '').trim()) })
  const authored = p.commitments.filter((c: any) => { const r = rows(c); return r && (r.next_action || '').trim() && !GENERIC.test((r.next_action || '').trim()) })
  // decision-ready: owner must act
  const OWNER_STATES = new Set(['AWAITING_SELECTION', 'AWAITING_APPROVAL', 'INFO_REQUIRED', 'INFORMATION_REQUIRED'])
  const decide = p.commitments.filter((c: any) => { const r = rows(c); return r && OWNER_STATES.has(r.status) })
    .map((c: any) => { const r = rows(c); return { cid: c.caseId, st: r.status, prio: r.priority, due: c.dueAt,
      ageDays: c.dueAt ? +((now - c.dueAt) / 86400).toFixed(1) : null, generic: GENERIC.test((r.next_action || '').trim()), title: (r.title || '').slice(0, 60) } })
  const blocked = p.commitments.filter((c: any) => { const r = rows(c); return r && ['WAITING_EXTERNAL', 'BLOCKED'].includes(r.status) }).length
  out.ns[ns] = {
    commitments: p.commitments.length,
    expired: p.commitments.filter((c: any) => c.status === 'EXPIRED').length,
    unknown: p.commitments.filter((c: any) => c.status === 'UNKNOWN').length,
    genericAction: generic.length, authoredAction: authored.length,
    decide, blocked,
    interrupt: p.attention.interrupt.map((i: any) => { const r = rows(i.element); return { band: i.band, cid: i.element.caseId,
      generic: r ? GENERIC.test((r.next_action || '').trim()) : null, title: r ? (r.title || '').slice(0, 55) : null } }),
    opportunityInInterrupt: p.attention.interrupt.filter((i: any) => i.band === 'OPPORTUNITY').length,
    anomalies: p.anomalies.length, breaches: p.anomalies.filter((a: string) => a.includes('INVARIANT BREACH')).length,
  }
}
const after = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m FROM personal_cases').get() as any
out.readOnly = (before.n === after.n && before.m === after.m) ? 'UNCHANGED' : 'CHANGED-BUG'
console.log(JSON.stringify(out, null, 1))
