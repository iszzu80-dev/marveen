// HISTORICAL REPLAY for CASE_PARENT_CANDIDATE.
//
// Owner's measurement list (2026-09-04): recall, precision / false candidate
// rate, top-1 and top-3 usefulness, confidence distribution, ambiguous
// candidates, namespace leakage = 0. And: "Nem várom el a 14/14-et, ha az csak
// false positive-okkal lenne elérhető."
//
// THREE BUCKETS, NOT TWO, and this is the load-bearing decision in the file.
// The historical labels are INCOMPLETE. `case-private-1a00ebd416dad445`
// (Hertz/DiscoverCars D014889443) was never attached to the Spanish trip, yet
// it shares a booking reference with cases that were. Scored as a two-class
// problem it is a false positive, and the engine is punished for being right.
// So proposals that are neither labelled-positive nor labelled-control are
// reported as UNLABELLED for a person to read, and are never silently counted
// as errors in either direction.

import { initDatabase, getDb } from '../src/db.js'
import {
  parentCandidates, CANDIDATE_THRESHOLD, algorithmFingerprint,
  type CandidateInput, type RelationCandidate,
} from '../src/cos/semantic/relation-candidates.js'

const LIVE_DB = process.env.REPLAY_DB ?? '/home/iszzu/marveen/store/claudeclaw.db'
const TOP_N = 3

interface Row {
  case_id: string; parent_case_id: string | null; title: string
  description: string | null; next_action: string | null; created_at: number
}

const toInput = (r: Row): CandidateInput => ({
  id: r.case_id,
  namespace: 'personal',
  text: [r.title, r.description ?? '', r.next_action ?? ''].join('\n'),
  createdAtDay: Math.floor(r.created_at / 86_400),
})

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`
}

function main(): void {
  initDatabase(LIVE_DB)
  const db = getDb()
  const cases = db.prepare(
    `SELECT case_id, parent_case_id, title, description, next_action, created_at
       FROM personal_cases WHERE archived_at IS NULL`,
  ).all() as Row[]
  if (!cases.length) throw new Error(`no cases in ${db.name} -- refusing to report on an empty store`)

  const byId = new Map(cases.map((c) => [c.case_id, c]))
  const corpus = cases.map((c) => toInput(c).text)

  // UMBRELLAS: cases that actually have children. A parent is proposed from
  // among known umbrellas; inventing new ones is a different feature.
  const umbrellaIds = [...new Set(cases.map((c) => c.parent_case_id).filter((x): x is string => !!x))]
  const umbrellas = umbrellaIds.map((id) => byId.get(id)).filter((x): x is Row => !!x).map(toInput)

  // Each umbrella's existing children, which are the evidence it carries. A
  // two-line umbrella naming a window and three cities has no booking
  // reference of its own; its children have several.
  const childrenOf = new Map<string, CandidateInput[]>()
  for (const c of cases) {
    if (!c.parent_case_id) continue
    const list = childrenOf.get(c.parent_case_id) ?? []
    list.push(toInput(c))
    childrenOf.set(c.parent_case_id, list)
  }

  // LEAVE-ONE-OUT. A positive's own row must not be in the sibling set used to
  // find it, or the bridge would match the case against itself-by-another-name
  // and the recall number would be a memory test.
  const siblingsExcluding = (caseId: string): Map<string, CandidateInput[]> => {
    const m = new Map<string, CandidateInput[]>()
    for (const [k, v] of childrenOf) m.set(k, v.filter((c) => c.id !== caseId))
    return m
  }

  const positives = cases.filter((c) => c.parent_case_id && byId.has(c.parent_case_id))

  console.log(`store: ${db.name}`)
  console.log(`cases: ${cases.length}   umbrellas: ${umbrellas.length}   labelled positives: ${positives.length}`)
  console.log(`algorithm: ${algorithmFingerprint()}   threshold: ${CANDIDATE_THRESHOLD}   topN: ${TOP_N}\n`)

  let top1 = 0, top3 = 0, missed = 0
  const confidences: number[] = []
  const missedRows: string[] = []
  const wrongParentAtTop1: string[] = []

  console.log('--- POSITIVES: does the engine find the parent a human chose? ---')
  for (const p of positives) {
    const cands = parentCandidates(toInput(p), umbrellas, corpus, TOP_N, siblingsExcluding(p.case_id))
    const ranked = cands.map((c) => c.targetCaseId)
    const at = ranked.indexOf(p.parent_case_id!)
    const hit = cands.find((c) => c.targetCaseId === p.parent_case_id)
    if (hit) confidences.push(hit.confidence)
    if (at === 0) top1++
    else if (at > 0) top3++
    else {
      missed++
      missedRows.push(`  MISS  ${p.case_id.slice(0, 30).padEnd(31)} wanted ${p.parent_case_id}`
        + (ranked.length ? `, got ${ranked.join(', ')}` : ', got nothing'))
    }
    if (at > 0 || (at === -1 && ranked.length)) {
      wrongParentAtTop1.push(`  ${p.case_id.slice(0, 28).padEnd(29)} top1=${ranked[0]} wanted=${p.parent_case_id}`)
    }
  }
  console.log(`  top-1 correct: ${top1}/${positives.length} (${pct(top1, positives.length)})`)
  console.log(`  in top-${TOP_N}:      ${top1 + top3}/${positives.length} (${pct(top1 + top3, positives.length)})`)
  console.log(`  missed:        ${missed}/${positives.length}`)
  for (const m of missedRows) console.log(m)
  if (wrongParentAtTop1.length) {
    console.log('  ranked, but not first:')
    for (const w of wrongParentAtTop1) console.log(w)
  }

  if (confidences.length) {
    const sorted = [...confidences].sort((a, b) => a - b)
    const q = (f: number): number => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]
    console.log(`\n  confidence on correct hits: min ${sorted[0].toFixed(2)} `
      + `p25 ${q(0.25).toFixed(2)} median ${q(0.5).toFixed(2)} p75 ${q(0.75).toFixed(2)} `
      + `max ${sorted[sorted.length - 1].toFixed(2)}`)
  }

  // CONTROL: a labelled case must not be proposed under a DIFFERENT umbrella.
  // These are real hard negatives -- most are travel cases, and the wrong
  // umbrella for a travel case is another travel umbrella.
  console.log('\n--- CONTROL: proposals under an umbrella the human did NOT choose ---')
  let falseCandidates = 0, controlPairs = 0
  const falseRows: string[] = []
  for (const p of positives) {
    const cands = parentCandidates(toInput(p), umbrellas, corpus, TOP_N, siblingsExcluding(p.case_id))
    for (const u of umbrellas) {
      if (u.id === p.parent_case_id) continue
      controlPairs++
      const bad = cands.find((c) => c.targetCaseId === u.id)
      if (bad) {
        falseCandidates++
        falseRows.push(`  FALSE ${p.case_id.slice(0, 28).padEnd(29)} -> ${u.id} `
          + `(${bad.confidence}) :: ${bad.reasons[0] ?? ''}`)
      }
    }
  }
  console.log(`  control pairs: ${controlPairs}`)
  console.log(`  false candidates: ${falseCandidates} (${pct(falseCandidates, controlPairs)} of control pairs)`)
  for (const f of falseRows) console.log(f)

  // UNLABELLED: parentless cases the engine would propose a parent for. NOT
  // errors. This is where the incompleteness of the historical labels lives.
  console.log('\n--- UNLABELLED: parentless cases the engine proposes a parent for ---')
  const parentless = cases.filter((c) => !c.parent_case_id && !umbrellaIds.includes(c.case_id))
  const proposals: Array<{ c: Row; cand: RelationCandidate }> = []
  for (const c of parentless) {
    const [best] = parentCandidates(toInput(c), umbrellas, corpus, 1, childrenOf)
    if (best) proposals.push({ c, cand: best })
  }
  proposals.sort((a, b) => b.cand.confidence - a.cand.confidence)
  console.log(`  parentless cases: ${parentless.length}   proposals: ${proposals.length}`)
  for (const { c, cand } of proposals) {
    console.log(`  ${cand.confidence.toFixed(2)}  ${c.case_id.slice(0, 30).padEnd(31)} -> ${cand.targetCaseId}`)
    console.log(`        ${c.title.slice(0, 76)}`)
    for (const r of cand.reasons) console.log(`        · ${r.slice(0, 100)}`)
  }

  // AMBIGUOUS: more than one umbrella proposed for the same case.
  let ambiguous = 0
  for (const c of parentless) {
    if (parentCandidates(toInput(c), umbrellas, corpus, TOP_N, childrenOf).length > 1) ambiguous++
  }
  console.log(`\n  ambiguous (more than one umbrella proposed): ${ambiguous}`)

  // NAMESPACE LEAKAGE: must be 0. Everything above is 'personal'; the check is
  // run against a deliberately ZST-namespaced probe so a 0 here means the guard
  // fired, not that nothing was tried.
  const zstProbe: CandidateInput = { ...toInput(positives[0]), id: 'ZST-PROBE', namespace: 'zst' }
  const leaked = parentCandidates(zstProbe, umbrellas, corpus, TOP_N, childrenOf).length
  console.log(`  namespace leakage: ${leaked} (probe: a ZST-namespaced copy of a personal case)`)
}

main()
