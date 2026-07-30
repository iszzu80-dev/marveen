# Testing

Marveen has two separate test surfaces. Both must be green before a merge to `develop` and before
a live install is rebuilt/restarted.

## 1. TypeScript unit/integration suite (`npm test`)

`vitest run` over `src/__tests__/*.test.ts`. Covers the dashboard, web routes, CostOps, agent
config resolution, and most pure decision logic. Refuses to run against a live install by design
(`src/__tests__/setup/assert-not-live-install.ts`) — always run it in a worktree, not `~/marveen`
itself.

## 2. Shell/Python script contract tests (`npm run test:scripts`)

`scripts/__tests__/*.{sh,py}` — integration/contract checks against real files, tmux state, and
subprocess behavior for the shell/Python side of the fleet (channel watchdogs, disk-space guard,
telegram fallback, the intel registry CLI, etc.). These are deliberately **not** TypeScript/vitest:
they exercise real shell scripts and Python hooks against real filesystem/tmux state, which is a
legitimate reason to live outside the TS suite.

Card `de8c7cad` (2026-07-30): these 17 files existed with no runner anywhere — no `package.json`
script, no CI workflow, no shell loop discovering them. They ran only when a human happened to type
the exact path. Several of them guard subsystems that fail **silently** in production
(`channel-inbox-drain`, `telegram-watchdog-wedged`, `stuck-modal-guard`, `disk-space-guard`,
`channels-auth-probe`, the inter-agent evidence gate) — a guard that never runs is worse than no
guard, because its existence gets read as coverage.

Run it:

```bash
npm run test:scripts
# or directly:
bash scripts/run-script-tests.sh
```

The runner:
- discovers every `.sh`/`.py` file directly under `scripts/__tests__/` (asserts the discovered
  count is `> 0` — a runner that silently finds nothing would recreate this exact problem one layer
  up),
- runs each one (`bash` for `.sh`, `python3` for `.py`) and reports PASS/FAIL per file,
- exits non-zero if any executed test fails,
- **skips, with a written reason printed on every run**, any test unsuitable for a routine sweep —
  today that is `test-voice-install.sh` (spins up a real Docker container, pulls `ubuntu:24.04`,
  takes minutes, and leaves the container running afterward for manual inspection by design). Run
  it explicitly (`bash scripts/__tests__/test-voice-install.sh`) or pass `--include-slow` to the
  runner to include it in a sweep.

A skip is not a substitute for a fix: if a test in the default sweep starts failing, triage it —
fix the regression, or add a *specific, written* skip reason. Never delete a failing test file to
make the runner green; that converts a known gap into a hidden one.

## Where this fits in the release routine

Run both (`npm test` and `npm run test:scripts`) before:
- merging a feature/fix branch to `develop`,
- rebuilding and restarting the live dashboard (`npm run build` + `systemctl --user restart
  marveen-dashboard.service`),
- accepting a producer's build report on a gated work item.

`npm run test:scripts` is intentionally fast (well under a minute) and side-effect-free in its
default mode, so there is no excuse to skip it.
