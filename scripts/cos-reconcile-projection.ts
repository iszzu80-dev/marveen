// Cycle step: reconcile the case board with the canonical progression state,
// then report where the two still disagree.
//
// P1, 2026-08-26. Before this step existed, Invariant A held 166/167 inside the
// engine and 0/146 on the board, and there was no `last_reconciled_at` anywhere
// for that to be noticeable. The gap was not a missing capability -- it was a
// missing identity between two views of one case.
//
// THE SWEEP IS ALSO THE RESTART RECOVERY. Every progression run projects inside
// its own transaction, so the ordinary path cannot leave the board behind. The
// window that remains is a crash, or a canonical writer that does not live in
// the pipeline (the scheduler, completion, the owner-question path). This step
// closes that window on the next cycle, idempotently and fenced: a re-run
// projects nothing and a stale writer is refused rather than allowed to walk
// the board backwards.
//
// WHAT COUNTS AS A PROBLEM HERE, and why the healthy case is not silent.
// `unenrolled` and Invariant A violations go into `failures`, which the cycle
// runner folds into `problems`. A case the engine has never been asked about
// looks exactly like a case it has nothing to say about, and only one of those
// is fine.
//
// Usage: npx tsx scripts/cos-reconcile-projection.ts [--dry-run]

import { getDb, initDatabase } from '../src/db.js'
import {
  reconcileProjections, evaluateInvariantA, detectProjectionDrift,
} from '../src/cos/case-projection.js'

initDatabase()
const db = getDb()
const now = Math.floor(Date.now() / 1000)
const dryRun = process.argv.includes('--dry-run')

const sweep = reconcileProjections(db, now, { dryRun })
const drift = detectProjectionDrift(db, now)
const personal = evaluateInvariantA(db, 'personal')
const zst = evaluateInvariantA(db, 'zst')

const failures: Array<{ caseId: string; error: string }> = []
for (const f of sweep.fencedCases) failures.push({ caseId: `${f.domain}/${f.caseId}`, error: f.reason })
for (const u of drift.unenrolled) {
  failures.push({
    caseId: `${u.domain}/${u.caseId}`,
    error: `aktiv ugy [${u.status}] progression state NELKUL -- a motor soha nem kapta meg`,
  })
}
// A KIKAPCSOLT motor sajat sor. Egy aktiv ugy, aminek van state-sora, de
// progression_enabled=0, minden szamlalon egeszsegesnek latszik: nincs lemaradva,
// nincs utkozese, a vetulete pontos -- csak eppen a motor nem gondolkodik rola.
// A 166/167 outlier (PRI-TRIP-2026-001) pontosan ez volt: nulla futas, mode='off'.
for (const d of drift.disabled) {
  failures.push({
    caseId: `${d.domain}/${d.caseId}`,
    error: `aktiv ugy [${d.status}] progression_enabled=0, ${d.runs} futas -- a motor KI VAN KAPCSOLVA ra`,
  })
}
for (const v of [...personal.violations, ...zst.violations]) {
  if (v.reason === 'NO_PROGRESSION_STATE') continue // already reported as unenrolled
  failures.push({ caseId: `${v.domain}/${v.caseId}`, error: `Invariant A: ${v.reason} [${v.status}]` })
}
// Drift AFTER the sweep is a real problem: the sweep just ran, so anything
// still behind was refused or could not be projected.
for (const b of drift.behind) {
  failures.push({
    caseId: `${b.domain}/${b.caseId}`,
    error: `a vetulet lemaradt: projected ${b.projected} < canonical ${b.canonical}`,
  })
}

console.log(JSON.stringify({
  dryRun,
  examined: sweep.examined,
  projected: sweep.projected,
  unchanged: sweep.unchanged,
  fenced: sweep.fenced,
  conflicts: sweep.conflicts,
  noCanonical: sweep.noCanonical,
  invariantA: {
    personal: { active: personal.active, satisfied: personal.satisfied, violating: personal.violations.length },
    zst: { active: zst.active, satisfied: zst.satisfied, violating: zst.violations.length },
  },
  drift: {
    behind: drift.behind.length,
    neverReconciled: drift.neverReconciled.length,
    conflicted: drift.conflicted.length,
    unenrolled: drift.unenrolled.length,
    disabled: drift.disabled.length,
  },
  failures,
}, null, 1))
