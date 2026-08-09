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

## 3. Live-data assumption check (`npm run verify:context-windows`)

`scripts/verify-context-window-assumptions.ts` re-measures every recognized model's REAL peak
context (from `token_usage`) against what `src/context-guard.ts`'s `contextLimitForModel` currently
assumes for it. Unlike the other two surfaces, this one reads the LIVE production database, not a
worktree fixture — it only means something run against the real install.

Card `585c056c` part 2 (2026-07-30): `contextLimitForModel`'s sonnet-5 assumption (200k) was
justified by a comment stating a specific observation ("never observed above 198k across 14 days").
That claim silently went 4.7x stale (real peak 935,023) before anyone re-checked it, and — because a
different fix (part 1) started trusting this exact registry where it previously hadn't — the stale
assumption briefly created a live false-restart band for a running model. An empirical constant whose
justification is a stated observation must have something that re-checks the observation, or the
comment becomes a lie nobody notices. This script is that check; the pure comparison
(`findContextWindowViolations`) is unit-tested with synthetic data, this is the live-data wrapper.

Run it (read-only, no writes, safe against the live install):

```bash
npm run verify:context-windows
```

Exit 0 = every recognized model's real peak still fits its assumed window (with the same
accounting-overshoot tolerance the context guard already uses elsewhere). Exit 1 = an assumption in
`src/context-guard.ts` has gone stale — the printed evidence names exactly which model and by how
much; update the family list/limit from it, the same way part 2 of card 585c056c did.

This is not currently on an automatic schedule — running it is a manual/operator step today. Wiring
it into a periodic heartbeat (so drift is caught without anyone remembering to run it by hand) is a
reasonable next step and is exactly the class of gap this whole card was about — noted here rather
than silently left undone.

## Where this fits in the release routine

Run all three (`npm test`, `npm run test:scripts`, and — against the real install only —
`npm run verify:context-windows`) before:
- merging a feature/fix branch to `develop`,
- rebuilding and restarting the live dashboard (`npm run build` + `systemctl --user restart
  marveen-dashboard.service`),
- accepting a producer's build report on a gated work item.

`npm run test:scripts` is intentionally fast (well under a minute) and side-effect-free in its
default mode, so there is no excuse to skip it.
