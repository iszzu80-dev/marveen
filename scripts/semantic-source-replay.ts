// SOURCE_CASE_CANDIDATE acceptance: does a conversation find the dossier it
// belongs to, when no reply chain connects them?
//
// Owner's acceptance (2026-09-04): the Neon cross-mailbox example. The Neon
// billing threads arrive on the ZST account; the dossier that wants them,
// CORP-CLOUD-2026-001, lives in the personal store. Plus "legalább néhány
// negative source, amelyek hasonló témájúak, de más case-hez tartoznak" — and
// this store supplies an unusually cruel set of those: a dozen startup-credit
// cases across Databricks, Cloudflare, OVHcloud, Oracle, Vercel and Datadog,
// all written in the same words, all about credits, all in the same fortnight.
//
// CROSS-MAILBOX IS NOT CROSS-NAMESPACE. Which account received a message is
// evidence; which store a case lives in is authority. The proposals below cross
// the first freely and the second never.

import { initDatabase, getDb } from '../src/db.js'
import {
  sourceCaseCandidates, CANDIDATE_THRESHOLD, algorithmFingerprint,
  type CandidateInput,
} from '../src/cos/semantic/relation-candidates.js'

const LIVE_DB = process.env.REPLAY_DB ?? '/home/iszzu/marveen/store/claudeclaw.db'

interface CaseRow {
  case_id: string; title: string; description: string | null
  next_action: string | null; created_at: number
}

const text = (r: CaseRow): string => [r.title, r.description ?? '', r.next_action ?? ''].join('\n')

function main(): void {
  initDatabase(LIVE_DB)
  const db = getDb()

  const personal = db.prepare(
    `SELECT case_id, title, description, next_action, created_at
       FROM personal_cases WHERE archived_at IS NULL`,
  ).all() as CaseRow[]
  const zst = db.prepare(
    `SELECT case_id, title, description, next_action, created_at
       FROM zst_cases WHERE archived_at IS NULL`,
  ).all() as CaseRow[]
  if (!personal.length) throw new Error(`no personal cases in ${db.name}`)

  const corpus = [...personal, ...zst].map(text)

  // TARGETS: the personal dossiers a source could belong to.
  const targets: CandidateInput[] = personal.map((r) => ({
    id: r.case_id, namespace: 'personal', mailbox: 'private',
    text: text(r), createdAtDay: Math.floor(r.created_at / 86_400),
  }))

  // SOURCES: ZST-mailbox conversations, offered into the PERSONAL store. That
  // is the cross-mailbox shape, and the namespace is the target store's --
  // which account carried the mail does not decide where the case lives.
  const asSource = (r: CaseRow): CandidateInput => ({
    id: r.case_id, namespace: 'personal', mailbox: 'zst',
    text: text(r), createdAtDay: Math.floor(r.created_at / 86_400),
  })

  console.log(`store: ${db.name}`)
  console.log(`personal targets: ${targets.length}   zst sources available: ${zst.length}`)
  console.log(`algorithm: ${algorithmFingerprint()}   threshold: ${CANDIDATE_THRESHOLD}\n`)

  const NEON_ACCEPT = zst.filter((r) => /neon/i.test(r.title))
  const NEGATIVES = zst.filter((r) =>
    !/neon/i.test(r.title)
    && /(cloudflare|ovhcloud|oracle|vercel|datadog|databricks|startup|kredit|credit)/i.test(r.title))

  console.log('--- ACCEPTANCE: Neon sources on the ZST account, offered to the personal store ---')
  let accepted = 0
  for (const r of NEON_ACCEPT) {
    const [best] = sourceCaseCandidates(asSource(r), targets, corpus, 1)
    const ok = !!best
    if (ok) accepted++
    console.log(`  ${ok ? 'PROPOSED' : 'none    '} ${r.case_id.slice(0, 26).padEnd(27)} ${r.title.slice(0, 52)}`)
    if (best) {
      console.log(`             -> ${best.targetCaseId}  (${best.confidence})`
        + `${best.crossMailbox ? `  [cross-mailbox: ${best.crossMailbox.sourceMailbox}]` : ''}`)
      for (const why of best.reasons) console.log(`             · ${why.slice(0, 96)}`)
    }
  }
  console.log(`  proposed for ${accepted}/${NEON_ACCEPT.length} Neon sources`)

  console.log('\n--- NEGATIVES: same topic, same fortnight, different vendor ---')
  let wrongToNeon = 0
  const neonish = new Set(personal.filter((p) => /neon|cloud/i.test(p.title)).map((p) => p.case_id))
  for (const r of NEGATIVES) {
    const [best] = sourceCaseCandidates(asSource(r), targets, corpus, 1)
    const landed = best?.targetCaseId ?? null
    const bad = landed !== null && neonish.has(landed) && !/databricks/i.test(r.title)
    if (bad) wrongToNeon++
    console.log(`  ${bad ? 'WRONG   ' : 'ok      '} ${r.case_id.slice(0, 26).padEnd(27)} `
      + `${r.title.slice(0, 44).padEnd(45)} -> ${landed ?? '(none)'}`)
  }
  console.log(`  landed on a Neon/cloud dossier despite being another vendor: ${wrongToNeon}/${NEGATIVES.length}`)

  // The hard boundary, probed rather than assumed: the SAME source declared in
  // the zst namespace must produce nothing against personal targets.
  const probe = NEON_ACCEPT[0]
  if (probe) {
    const leak = sourceCaseCandidates(
      { ...asSource(probe), namespace: 'zst' }, targets, corpus, 3,
    ).length
    console.log(`\n  namespace leakage: ${leak} (same source declared in the zst NAMESPACE)`)
  }
}

main()
