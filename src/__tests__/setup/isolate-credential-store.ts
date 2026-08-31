// GLOBAL SUITE ISOLATION: every worker gets its OWN credential store directory.
//
// 2026-08-31, the twenty-run final-candidate sweep: run 10 failed on
// w13-egress-and-credential-criteria.test.ts §7.6 ("the PLAINTEXT never lands in
// the config"). Nothing was wrong with the product. vault.json and
// vault-bindings.json lived at a fixed path under the checkout, so every test
// file in the suite shared one mutable copy. w13-known-secret-boundary.test.ts
// does twelve setSecret/deleteSecret calls, each a read-modify-write of the
// WHOLE file, and vitest runs it in a different worker at the same time. When
// the two read-modify-writes interleaved, the egress test's secret vanished
// between its own write and its own read, syncSecret found nothing to write,
// and the assertion on the .mcp.json failed.
//
// Owner's instruction (2026-08-31): "Ne serializálással rejtsd el a race-et;
// szüntesd meg a shared mutable fixture-t." Serialising the two files would
// have made the symptom go away while leaving the next pair of tests to
// rediscover it. There is no shared file left to race over.
//
// Loaded via vitest `setupFiles`, so it runs in every worker before any test
// module is imported -- a per-file opt-in is a thing someone forgets.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const workerStoreDir = mkdtempSync(join(tmpdir(), 'marveen-credstore-'))

// Read per call by credentialStoreDir(), so setting it here is enough: no
// module has captured a path yet, and none of them capture one at all.
process.env.MARVEEN_CREDENTIAL_STORE_DIR = workerStoreDir

afterAll(() => {
  rmSync(workerStoreDir, { recursive: true, force: true })
})
