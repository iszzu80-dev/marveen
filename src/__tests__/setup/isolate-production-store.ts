// GLOBAL SUITE ISOLATION: production-authoritative store files go to a per-worker
// temp directory, never to the checkout's store/.
//
// Owner's rule (2026-08-31, T5 TEST<->RUNTIME FILESYSTEM ISOLATION):
//
//   "A TEST MUST NOT MUTATE A REPO/STORE PATH THAT THE RUNNING / PRODUCTION
//    RUNTIME CAN READ AS REAL PERSISTENT STATE."
//
// It applies to config/override, scope/policy override, optimization/runtime
// configuration, credential, and checkpoint/cursor/state files.
//
// WHAT COUNTS AS PRODUCTION-AUTHORITATIVE is not a judgement call: the repo
// already declares it in src/cos/backup.ts POLICY_FILES, the set a policy backup
// captures because a restore needs it. Everything on that list which the suite
// was observed writing resolves through config.ts storePath() and lands here.
// Four files the suite writes are NOT on that list, and backup.ts calls such
// files "unclassified -- a question for the operator". Three of them are plainly
// in the owner's named categories and are isolated too:
//   apg-scope-overrides.json      scope/policy override
//   apg-decision-idempotency.json checkpoint/idempotency state
//   costops-subscriptions.json    runtime-read subscription state
// The fourth, apg-ui-audit.jsonl, is append-only and NOTHING reads it, so by the
// letter of the rule it is category B. It is isolated anyway because it shares a
// module with apg-scope-overrides.json, so isolating it costs nothing -- and a
// production audit trail carrying rows from a test run is not a thing worth
// defending later.
//
// The measured baseline this closes: over the 2026-08-31 twenty-run sweep the
// suite wrote store/config-overrides.json 99 times per run, apg-ui-audit.jsonl
// 48, costops-fx.json 24, costops-render-pricing.json 20, apg-scope-overrides
// 18, optimization-config.json 16. config-overrides.json is the file
// settings-store.test.ts rmSync'd out of the live install on 2026-07-27.
//
// Loaded via vitest `setupFiles`, so it runs in every worker before any test
// module is imported. A per-file opt-in is a thing someone forgets.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const workerStoreDir = mkdtempSync(join(tmpdir(), 'marveen-store-'))

// Read per call by config.ts storeDir(), so setting it here is enough.
process.env.MARVEEN_STORE_DIR = workerStoreDir

afterAll(() => {
  rmSync(workerStoreDir, { recursive: true, force: true })
})
