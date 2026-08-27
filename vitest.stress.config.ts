import { defineConfig, configDefaults } from 'vitest/config'

// The STRESS / REPRODUCER suite, run by `npm run test:stress` and by nothing
// else. FRESH_BOOT_NEGATIVE_CONTROL (owner, 2026-08-27): a load-dependent race
// must not gate a release, because its green is indistinguishable from a green
// off fixed code and its red is often just a busy machine. These suites still
// have a job -- they run the REAL subsystem rather than a model of it, which is
// what checks that the deterministic replicas in the gate stay faithful.
//
// A separate config rather than a CLI flag: vitest 2 has no `--include`, and a
// script that silently ran the wrong set would be worse than no script.
export default defineConfig({
  test: {
    include: ['src/__tests__/stress/**/*.stress.test.ts'],
    exclude: [...configDefaults.exclude, '.claude/**', 'releases/**'],
    setupFiles: ['./src/__tests__/setup/assert-not-live-install.ts'],
    // Reproducers race real processes; one at a time, or they race each other.
    fileParallelism: false,
    testTimeout: 600_000,
  },
})
