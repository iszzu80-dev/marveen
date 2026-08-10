# Upstream PR curation for Szotasz/marveen (card 83fa7f43)

Prepared 2026-07-29 by fullstackfejleszto (Mason). Nothing has been pushed,
no PR opened, no branch deleted. This is the gated report.

## Premise correction

The dispatch assumed #628 and #660 were **already merged**. They are not.

| PR | State | Head branch |
|---|---|---|
| #524 | **MERGED** 2026-07-11 | upstream/costops-pr1-ledger-summary |
| #628 | **OPEN** | upstream/costops-pr-b-forecast-fx |
| #660 | **OPEN** (stacked on #628) | costops-rebased |
| #663 | **CLOSED** ("DO NOT MERGE, SCOPE CONTAMINATED") | worktree-monitor-cd-rework |
| #555 | **OPEN** (maintainer's own) | fix/dashboard-eventloop-block-reconnect |

This does not change the supersession conclusion (content already submitted
must not be re-PR'd) but it changes sequencing: the CostOps UI slice below
depends on #660 landing first.

`rb/costops-660` (28d7a04, authored today) is the full 19-commit #628+#660
stack already rebased onto near-fresh develop. It is the current best version
of the submitted work and card 48a3dcae's rebase is effectively done.

## Method

Commit counts are direction-blind and rebase-blind, so nothing here is based
on them. For every branch: the set of files changed since its merge-base with
`origin/develop`, then a **blob-SHA comparison** of each file against the
baseline `origin/develop` UNION `rb/costops-660`, classifying each file as
new / modified / identical. Fork-local trees (`agents/`, `store/`,
`deliverables/`, `audits/`, `.claude*/`) are excluded from upstream relevance.

## PR candidates (built, rebased, verified)

All three are local branches in this checkout. None pushed.

### 1. `pr/process-lock-worktree-scope` — 560423d

Base: `origin/develop` (03c5c5b), 1 commit, applies clean.

Scopes `findOwnBinaryMatches` to the process's own project root. The matcher
keyed on the trailing argv segment (`dist/index.js`), which is identical for
every git worktree of the repo by construction, so booting the dashboard from
any worktree SIGTERMed every other checkout's process, including a live
production instance on a different port. Confirmed live 2026-07-15.

- `tsc --noEmit`: exit 0
- full suite: **213 files / 2920 passed / 1 skipped**
- **guard proven red**: reverting only `src/process-lock.ts` turns the three
  new cross-worktree tests to FAIL (3 failed / 58 passed), and restoring it
  returns 61/61. The tests fail for the intended reason.

Strongest candidate: generic, small, incident-backed, independently mergeable.

### 2. `pr/memory-pressure-monitor` — 6bcd3f5

Base: `origin/develop` (03c5c5b), 1 commit, applies clean.

Out-of-process memory-pressure monitor (systemd user timer, zero LLM calls,
reads /proc, atomic state file, hysteresis state machine) plus a fail-closed
agent-start gate at the single `startAgentProcess` choke point. Self-contained:
no package.json or installer changes.

- `tsc --noEmit`: exit 0
- full suite: **217 files / 2918 passed / 1 skipped**
- caveat to flag on review: the four test files each wrap a self-reporting
  harness in one vitest case ("PASS 28 / FAIL 0"), so vitest reports 4 tests,
  not 28. They do assert, but the shape is unusual and a maintainer may ask
  for them to be split.

### 3. `pr/costops-ui-command-center` — 253d5ac

Base: `origin/develop`, **20 commits** = the 19-commit #628+#660 stack plus
the UI commit. Rebased cleanly onto fresh `origin/develop` (exit 0).
**Depends on #660**: open it against #660's branch, or after #660 merges.

Adds the CostOps Command Center: 9 browser modules under `web/costops/`
(byte-identical to what runs in our develop), an exact-filename allowlist in
`routes/static.ts` (same shape as `/lang/`, not a directory serve), the page
mount, and a new `nav.costsCc` key in both languages.

**Design decision made deliberately, flag it to the maintainer:** this is
built **additive**. Upstream's `#costsPage` keeps its sidebar entry and the
Command Center gets its own next to it. Our fork instead *replaces* the Costs
nav entry (Istvan's 2026-07-19 ruling, commit 96b4d4b). I did not upstream the
replace variant because it removes something upstream ships. The trade-off is
honest: the additive wiring is what I verified green, not what we run in
production.

Also deliberately **excluded** from this slice, all of which the fork's
`web/app.js`/`index.html` delta contains:
- the `Archivált` and `Csapat` nav links, both already marked `LOCAL-FORK: keep on merge`
- the deletion of `costsSyncBtn` / `costopsSyncNow` / the provider-sync freshness
  table. Upstreaming that would **revert #660's own feature**.
- `web/style.css` `--qq-accent` brand variables (a separate brand module, not CostOps)

- `tsc --noEmit`: exit 0
- full suite after rebase: **253 files / 3412 passed / 1 skipped**
- `node --check` clean on every touched browser file
- allowlist verified to match the 9 files on disk exactly
- **not click-verified in a browser.** Booting a dashboard from a second
  checkout would trip the exact cross-worktree kill that candidate 1 fixes,
  and this base does not carry that fix. Refusing to boot was the safe call.

## Explicitly NOT to PR

- **eventloop / `delay.ts`** (`port/pr555-eventloop-fix`). This is a *port of
  the maintainer's own open PR #555*. Re-PRing it would hand zollak back his
  own work. If we want it to land, comment on #555.
- **`src/web/auth-gate.ts`** `/api/settings` exemption: self-labelled
  `LOCAL-FORK: keep on merge`.
- **`src/config-registry.ts`** re-adds `claude-sonnet-4-6` to the model list.
  Upstream deliberately renamed that to `claude-sonnet-5` in #751, which is
  `origin/develop`'s tip commit. Upstreaming this would be a regression.
- All of `docs/`, `audits/`, `deliverables/`, `design/`, `decisions/`,
  `agents/`, plus `_qq_insert_tmp.js` and a stray
  `.claude-deepseek/.../*.md` that got committed to our develop. The 7 "new"
  docs every superseded CostOps branch carries (`docs/fork-upstream-policy.md`,
  `docs/v1220-merge-plan.md`, `docs/costops/phase0-*`) are fork-process notes,
  not upstream material.

## Qualified candidate, recommend asking before building

**data-sensitivity dispatch gate** (`feat/data-sensitivity-dispatch-gate-6bf535bf`,
already merged into develop). ~910 lines: 288 core + 392 test + 190 runner + 42
router wiring. The mechanism is genuinely generic and clean (deterministic,
dependency-free, no LLM, fail-safe to `restricted`, observe-only by default,
boot plus periodic liveness check against the audit log). But it ships a
**policy default** about which providers may receive restricted content
(Anthropic trusted, hosted DeepSeek never), and that is the maintainer's call,
not ours. Recommend an issue first, not an unsolicited 900-line PR.

## Safe to delete

**A. Ancestors of `develop` (32).** Content preserved by construction.

architect/costops-ui1, backup/before-costops-live-dashboard,
backup/costops-dashboard-clean-v1.19.0, backup/costops-v1.19.0-integrated,
devops/message-router-hardening, feat/costops-ledger-token-estimates,
feat/data-sensitivity-dispatch-gate-6bf535bf, fix/costops-provenance-summary-d2631bad,
fix/monitor-release-local-deps, local/costops-gapfill, local/costops-live-dashboard,
local/costops-v07, main, mason-costops-phase0, mason-v1220-merge,
p0-memory-pressure-guard, p0-monitor-release-health, port/pr555-eventloop-fix,
port/pr555-eventloop-fix-v2, pr-b-forecast-fx-accounting,
worktree-agent-a51e44734a770b70e, worktree-codeworker+costops-en-translate

(`main` is on this list because it is an ancestor of develop. Deleting the
local `main` is almost certainly not wanted; listed for completeness, exclude.)

**B. Superseded CostOps predecessors.** Not ancestors, but every path they
touch is carried by the rebased #628/#660 stack, and their versions are
strictly earlier iterations of that same series. Zero net-new source files.

buildfejleszto-costops-{alerts, alerts-capture, export, forecast, fx, invoice,
optimization, optimization-capture}, mason-costops-{phase1, phase2, phase3-budgets},
costops-{core, collectors, monitoring, config-hygiene, financial},
upstream/costops-{slices, pr1-ledger-summary, pr2-collector-framework,
pr-c-alerts-budgets, pr-d-period-export, pr-e-optimization},
fix/pr524-slice-level-blockers (#524 merged), rb/prb-backup,
devops/devops-upstream-merge-v122x + mason-v1220-merge (upstream merges long
since in origin/develop), codeworker/restore-costops-cc-ui,
salvage/codeworker-memory-pressure-wip-20260720, mason-binpattern-scope-fix
(superseded by candidate 1), p0-monitor-release-scoped and p0-monitor-cd-clean
(superseded by candidate 2), worktree-monitor-cd-rework (#663 closed),
feat/kanban-move-audit (its test file is byte-identical to develop's, so the
feature landed; verify before deleting).

**PR-E is confirmed superseded**, matching marveen's finding: zero net-new files.

## Do NOT delete

- `upstream/costops-pr-b-forecast-fx` and `costops-rebased` — **heads of open
  PRs #628 and #660**.
- `rb/costops-660`, `rb/costops-prb` — today's rebases, the current best
  version of that stack and the base for candidate 3.
- `upstream/costops-pr-f-ui-command-center` — keep until candidate 3 is accepted.
- **Un-landed work that exists in no other ref.** Deleting these destroys it:
  - `scripts/dispatch-guard.sh` plus `src/pane-state.ts` / `schedule-runner.ts`
    changes, carried ONLY by `backup-pre-v1186-update`,
    `backup/local-dispatch-guard-20260702-071659`,
    `backup/local-dispatch-guard-20260702-072201`,
    `backup/pre-origin-main-sync-a6e8ac8-20260703-182221`,
    `feat/forcesend-ctxsat-instrumentation` and
    `pr/context-saturation-dispatch-guard`. The file is in neither develop nor
    upstream. This is the context-saturation dispatch guard; it needs a keep
    or drop decision, not a sweep.
  - `scripts/dependency-closure-check.sh` and
    `src/web/memory-pressure-release-regression.test.ts`, carried only by
    `monitor-p0-cd-clean` and `pr663`. Possibly extra coverage worth folding
    into candidate 2 before those branches go.
  - `feat/fleet-hardening-batch` — 11 files, differs from develop on every one
    sampled, never merged. Un-landed variant, needs a look.
  - `fix/wsl-host-stability` — uniquely carries an `install-linux.sh` change
    that is in neither develop nor upstream.

## Recommended order

1. Land #628, then #660 (both already rebased as `rb/costops-660`).
2. Open candidate 1 — standalone, smallest, strongest evidence.
3. Open candidate 2 — standalone, independent of the CostOps stack.
4. Open candidate 3 once #660 is in.
5. Comment on #555 rather than re-PRing the eventloop work.
6. Decide keep-or-drop on the dispatch-guard family and
   `feat/fleet-hardening-batch` **before** any branch deletion sweep.
