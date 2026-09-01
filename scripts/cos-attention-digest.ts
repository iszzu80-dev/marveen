// PHASE 3 (P3-A) -- the scheduled reader of the Phase 2 projection.
//
// Until this step existed, `projectIntelligence` had exactly one class of
// caller: probe scripts run by hand. The surfaces were true and nobody read
// them, which on 2026-09-01 meant a NAV "elfogado nyugta" with ten days left on
// its deletion window was found by a manual run and would not have been raised
// again the next morning.
//
// This is an EVENT alert, not a daily summary. It is silent on a cycle where
// nothing is new, nothing changed band, nothing changed its sentence and no
// high-band item is due to come back -- which is most cycles. The zero case is
// therefore NOT announced here, deliberately and unlike the PLANNED and radar
// digests: those speak daily so that silence cannot be mistaken for a stopped
// job, while this one runs 144 times a day and its own step result is the
// receipt that it ran.
//
// The two namespaces are read in separate passes and posted as separate
// messages. Connector identity is the scope boundary, and one message listing
// both would be a cross-scope data path invented for a message layout.
//
// Usage: npx tsx scripts/cos-attention-digest.ts [--dry]

import { getDb, initDatabase } from '../src/db.js'
import { runProjectionReader } from '../src/cos/intelligence/reader.js'

const dry = process.argv.includes('--dry')

initDatabase()
const db = getDb()

const out: Record<string, unknown> = { dry }
const problems: string[] = []

for (const ns of ['personal', 'zst'] as const) {
  try {
    // A dry run must not mark anything as told. Replacing the POSTER is not
    // enough -- that silences the message and still writes the ledger, spending
    // the one utterance an unread notice gets on nobody. The reader takes an
    // explicit dryRun for exactly this reason.
    const now = Math.floor(Date.now() / 1000)
    const r = dry
      ? runProjectionReader(db, ns, now, () => {}, undefined, undefined, true)
      : runProjectionReader(db, ns)
    out[ns] = {
      posted: r.posted,
      spoke: r.spoke.length,
      triggers: r.spoke.map((s) => `${s.band}:${s.trigger}`),
      promotedByChange: r.promotedByChange,
      stillQuiet: r.stillQuiet,
      quiet: r.quiet,
      opportunityInSpoken: r.opportunityInSpoken,
      anomalies: r.anomalies,
      ...(dry ? { text: r.text } : {}),
    }
    // The projection reporting a cross-surface anomaly is not a reason to stay
    // silent about the attention, but it IS a reason the cycle should hear about
    // it -- the runner turns a non-empty `problems` into a visible failure.
    if (r.anomalies > 0) problems.push(`${ns}: projection reported ${r.anomalies} anomaly/anomalies`)
  } catch (e) {
    // A namespace that throws must not take the other one down with it, and it
    // must not look like "nothing to say".
    out[ns] = { failed: true, error: e instanceof Error ? e.message : String(e) }
    problems.push(`${ns}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

out.problems = problems
console.log(JSON.stringify(out))
if (problems.length) process.exit(1)
