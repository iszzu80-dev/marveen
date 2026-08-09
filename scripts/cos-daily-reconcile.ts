// COS daily reconcile runner (§14 personal-daily-reconcile).
//
// Deterministic: prints findings or nothing, and the exit code follows. The
// scheduled task escalates only when this exits non-zero, so a good day is
// genuinely silent rather than a daily paragraph nobody reads.
//
// Usage: npx tsx scripts/cos-daily-reconcile.ts [--json]
// Exit 0 = clean, 1 = findings, 2 = the reconcile itself could not run.

import { getDb, initDatabase } from '../src/db.js'
import { runDailyReconcile, formatReconcileReport } from '../src/cos/reconcile.js'

// getDb() only returns a handle after initDatabase(); a standalone runner has to
// do that itself (the dashboard process does it at boot). Found by running the
// progression runner, 2026-08-09 — the test suite never exercises entry points.
try {
  initDatabase()
} catch (e) {
  console.error(`COS napi egyeztetés: a store nem nyitható meg — ${(e as Error).message}`)
  process.exit(2)
}

try {
  const report = runDailyReconcile(getDb())
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 1))
  } else {
    const text = formatReconcileReport(report)
    if (text) console.log(text)
  }
  process.exit(report.clean ? 0 : 1)
} catch (e) {
  // A reconcile that crashes must not look like a clean day.
  console.error(`COS napi egyeztetés HIBÁRA FUTOTT: ${(e as Error).message}`)
  process.exit(2)
}
