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

const startedAt = Math.floor(Date.now() / 1000)
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
      heldByCadence: r.heldByCadence,
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

// THE CYCLE'S COUNTER VOCABULARY, spoken at the TOP LEVEL on purpose.
//
// The pinned cycle normalises `examined / matched / acted / failed` and, absent
// all three, records the step as UNKNOWN -- "ran, and we cannot say what it
// did". On the first post-cutover run both new steps landed exactly there. The
// normaliser was right and the fix belongs here: it is deliberately generic so
// that adding a step never means editing a per-step table, and the price of
// that design is that a new step has to speak the common vocabulary itself.
const sides = ['personal', 'zst'].map((k) => out[k] as Record<string, number> | undefined)
const sum = (f: (s: Record<string, number>) => number) =>
  sides.reduce((a, s) => a + (s && typeof s.spoke === 'number' ? f(s) : 0), 0)
// READBACK, because §8.7 does not accept "I posted it" as proof that anything
// landed. A step with EXTERNAL_EFFECT that acted and cannot say it verified is
// UNVERIFIED, and the run is PARTIAL -- correctly, on the first live cycle. The
// check is a query, not a flag: the digest text must be findable on the bus.
if (!dry) {
  const posted = ['personal', 'zst']
    .map((k) => out[k] as Record<string, unknown> | undefined)
    .filter((s) => s && s.posted === true).length
  if (posted > 0) {
    const found = db.prepare(
      `SELECT COUNT(*) n FROM agent_messages
        WHERE from_agent = 'cos-attention' AND created_at >= ?`,
    ).get(startedAt) as { n: number }
    out.readback = found.n >= posted ? 'VERIFIED' : 'MISSING'
    out.verified = found.n >= posted
    if (found.n < posted) {
      problems.push(`posted ${posted} digest(s) but only ${found.n} reached the bus`)
    }
  } else {
    out.readback = 'NOTHING_POSTED'
  }
}
out.examined = sum((s) => (s.spoke ?? 0) + (s.stillQuiet ?? 0) + (s.quiet ?? 0))
out.matched = sum((s) => (s.spoke ?? 0) + (s.stillQuiet ?? 0))
out.acted = sum((s) => s.spoke ?? 0)
out.failed = problems.length
out.problems = problems
console.log(JSON.stringify(out))
if (problems.length) process.exit(1)
