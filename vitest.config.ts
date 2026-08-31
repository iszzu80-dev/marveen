import { defineConfig, configDefaults } from 'vitest/config'

// The Playwright smoke suite (tests/smoke/**) is driven by `npm run smoke`
// (playwright.config.ts), not by `vitest run`. Playwright's test() API throws
// when collected under vitest, which fails the unit gate. Keep all vitest
// defaults; only carve out the e2e directory.
export default defineConfig({
  test: {
    // '.claude/**' is ours: agent worktrees under .claude/worktrees/ carry their
    // own copies of the test files, and without this exclude vitest collects
    // them and runs each suite several times over stale trees.
    // '**/*.stress.test.ts' is the release gate's boundary, made mechanical.
    // FRESH_BOOT_NEGATIVE_CONTROL (owner, 2026-08-27): a load-dependent race
    // must not gate a release, because its green is indistinguishable from a
    // green off fixed code and its red is often just a busy machine. Those
    // suites are REPRODUCERS, run deliberately with `npm run test:stress`, and
    // the gate keeps the deterministic proofs instead. Naming the convention in
    // the config rather than in a comment is what stops the next such test from
    // drifting back into the gate.
    exclude: [
      ...configDefaults.exclude, 'tests/smoke/**', '.claude/**',
      '**/*.stress.test.ts',
      // Pinned release copies (releases/cos-cycle-<sha>/) carry their own copies
      // of every test file. Collecting them runs the suite several times over
      // frozen trees whose failures nobody can fix.
      'releases/**',
    ],
    // Hard gate: refuse to run inside a live install (see the setup file header
    // for the 2026-07-27 incident this prevents). Runs in every worker before
    // any test module is imported.
    setupFiles: [
      './src/__tests__/setup/assert-not-live-install.ts',
      // Per-worker credential store. See the file header for the run-10 race.
      './src/__tests__/setup/isolate-credential-store.ts',
    ],
  },
})
