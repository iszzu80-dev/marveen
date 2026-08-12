// Progression heartbeat runner — called by a cron or scheduled task.
// Deploys schema (idempotent), seeds existing cases, then runs one heartbeat sweep.
//
// Usage: npx tsx scripts/progression-heartbeat-runner.ts
//
// SAFE to run repeatedly: deployAndSeedProgression is idempotent,
// runProgressionHeartbeat has atomic claim + lease.

import { getDb, initDatabase } from '../src/db.js'
import { deployAndSeedProgression } from '../src/cos/progression-migrate.js'
import { runProgressionHeartbeat } from '../src/cos/progression-heartbeat.js'

// getDb() returns a module-level handle that is only assigned by initDatabase().
// Inside the dashboard process that already happened at boot; a standalone
// runner must do it itself or getDb() hands back undefined and the first
// .prepare() throws. (Found by actually running this file, 2026-08-09 —
// the test suite never exercised the entry point.)
initDatabase()

const db = getDb()
const now = Math.floor(Date.now() / 1000)

// Step 1: Ensure schema + seed (idempotent)
const migration = deployAndSeedProgression(db, now, 'heartbeat-runner')
console.log('Migration:', JSON.stringify({
  tablesCreated: migration.tablesCreated,
  personalSeeded: migration.personalSeeded,
  zstSeeded: migration.zstSeeded,
  personalProgressed: migration.personalProgressed,
  zstProgressed: migration.zstProgressed,
  errors: migration.errors,
}))

// Step 2: Run one heartbeat sweep
const heartbeat = runProgressionHeartbeat(db, now, 50)
console.log('Heartbeat:', JSON.stringify({
  personal: heartbeat.personal,
  zst: heartbeat.zst,
  // §10.8: how many cases were due but had no reason to run. The number this
  // whole change exists to move, so it has to be visible.
  skippedNoTrigger: heartbeat.skippedNoTrigger,
  skippedClaimed: heartbeat.skippedClaimed,
  cycleErrors: heartbeat.cycleErrors,
  errors: heartbeat.errors,
}))

// Step 3: Lazy LLM goal enrichment (card ca33eb4b, wired 2026-08-10).
//
// Until today the interpreter existed and nothing called it, so every case's
// goal came from the per-status template and the engine could not say what any
// case was FOR. Bounded to a few per cycle: each case is interpreted once, ever
// -- it leaves the candidate set permanently -- so this is a one-time cost per
// case, not a per-cycle one.
//
// Failure here must never take the heartbeat down with it. The engine's job is
// to keep the cases moving; a missing API key or a model timeout degrades the
// goals to the old template and nothing else.
const ENRICH_PER_CYCLE = Number(process.env.COS_ENRICH_PER_CYCLE ?? 5)
const READ_PER_CYCLE = Number(process.env.COS_READ_PER_CYCLE ?? 3)
if (ENRICH_PER_CYCLE > 0 || READ_PER_CYCLE > 0) {
  try {
    const { enrichPendingGoals } = await import('../src/cos/goal-enrichment.js')
    const { resolveInterpreter } = await import('../src/cos/interpreter-provider.js')
    const { getSecret } = await import('../src/web/vault.js')
    const interp = resolveInterpreter(getSecret)
    if (!interp) {
      // No key anywhere. Say so every cycle rather than logging a quiet zero:
      // "nothing to interpret" and "nothing can interpret" are different facts.
      console.log('GoalEnrichment:', JSON.stringify({
        enriched: 0, failed: true, error: 'no interpreter configured (no ANTHROPIC key in env, no DEEPSEEK_API_KEY in vault)',
      }))
      // Same fact, stated once per subsystem: without an interpreter the Reader
      // cannot run either, and a silent zero here would read as "no case needed
      // reading" rather than "nothing could read them".
      console.log('Reader:', JSON.stringify({
        reader: { read: 0, failed: true, error: 'no interpreter configured' },
      }))
    } else {
      if (ENRICH_PER_CYCLE > 0) {
        // §10 / review #5 Ö-2: hand the sweep the ROUTE PAIR, not one client.
        // `interp` is whatever resolveInterpreter happened to find, and its
        // order ends in DeepSeek — so passing interp.client alone let the same
        // email thread the Reader refuses in this very cycle go out here. The
        // pair is resolved once and shared with the Reader below.
        const { resolveReaderInterpreters, READER_MAX_TOKENS } =
          await import('../src/cos/interpreter-provider.js')
        const enrichRoutes = resolveReaderInterpreters(getSecret, { maxTokens: READER_MAX_TOKENS })
        const enrich = await enrichPendingGoals(db, enrichRoutes, ENRICH_PER_CYCLE)
        console.log('GoalEnrichment:', JSON.stringify({
          general: enrichRoutes.general?.provider ?? null,
          contracted: enrichRoutes.contracted?.provider ?? null,
          ...enrich,
        }))
      }

      // Step 4: §10.1 → §10.2 → §12 → §13.1, on the live path (2026-08-11).
      //
      // The chain was built and committed the night before with no caller. This
      // import is the route in, and `read` in the cycle output is the evidence
      // that it is taken — a number that stays 0 while cases are running is the
      // island coming back, and it is visible every ten minutes instead of on
      // the day someone thinks to grep for callers.
      //
      // Bounded to a few per cycle: unlike goal enrichment a case does NOT leave
      // the candidate set for ever, it leaves until it next progresses, so this
      // is a recurring cost and the bound is the budget.
      if (READ_PER_CYCLE > 0) {
        const { runReaderPass } = await import('../src/cos/reader-cycle.js')
        const { READER_MAX_TOKENS, resolveReaderInterpreters } = await import('../src/cos/interpreter-provider.js')
        // A SEPARATE client, for the ceiling only. The Reader emits a whole
        // evidence packet and reasons at length before it; enrichment returns
        // three short fields. Sharing enrichment's 2048 is what made every live
        // Reader call die inside a thinking block on the first night.
        // TWO readers: one cleared for sensitive content and one cheap for the
        // rest (Istvan's decision, 2026-08-11). The sweep picks per case from
        // the context's effective tier — the §10 gate IS the routing here, not
        // a veto bolted on the front.
        const readers = resolveReaderInterpreters(getSecret, { maxTokens: READER_MAX_TOKENS })
        const route = (r: typeof readers.general) =>
          r ? { client: r.client, provider: r.provider, model: r.model } : null
        const read = await runReaderPass(db, {
          general: route(readers.general),
          contracted: route(readers.contracted),
        }, { limit: READ_PER_CYCLE, now })
        // NESTED under `reader`, not spread. cos-cycle.ts merges every JSON line
        // of this runner into ONE object, so a top-level `remaining`/`failures`
        // here overwrote GoalEnrichment's — the cycle report then showed one
        // subsystem's number under both names. Found by reading my own first
        // live output and being unable to say which subsystem `remaining: 98`
        // belonged to.
        // Step 5: §10.4 Writer, first slice — turn the readings into a question
        // on Istvan's own channel. Without this the whole chain ends in a table
        // nobody reads, which is precisely what he asked about on 2026-08-11.
        //
        // Bounded to two per sweep on purpose: a burst of twelve questions at
        // 3am is indistinguishable from spam, and a muted channel is the same
        // as no channel.
        const { askPendingOwnerQuestions } = await import('../src/cos/owner-question.js')
        const asked = askPendingOwnerQuestions(db, { limit: 2, now })

        console.log('Reader:', JSON.stringify({
          reader: {
            questions: asked,
            // Which provider is available for what, so the routing split in
            // `byProvider` can be read against what was possible.
            contracted: readers.contracted?.model ?? null,
            general: readers.general?.model ?? null,
            maxTokens: READER_MAX_TOKENS, ...read,
          },
        }))
      }
    }
  } catch (e) {
    // One catch for both, and it names neither as healthy. Reporting only
    // GoalEnrichment here would have let a Reader failure surface under the
    // other subsystem's name.
    console.log('GoalEnrichment:', JSON.stringify({
      enriched: 0, failed: true, error: String((e as Error)?.message ?? e),
    }))
    console.log('Reader:', JSON.stringify({
      reader: { read: 0, failed: true, error: String((e as Error)?.message ?? e) },
    }))
  }
}
