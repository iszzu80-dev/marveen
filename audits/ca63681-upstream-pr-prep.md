# Upstream PR/Issue prep -- ca63681 dispatch/context-saturation guard

Status: PREP ONLY -- nothing pushed, no PR/issue opened yet. Prepared 2026-07-02.
Local commit: `ca63681b731d531cd45dad7b7443f26d43c94abe` (on `main`, 1 ahead of `origin/main` @ v1.18.5, 0 behind).
Upstream repo: `Szotasz/marveen`.

> Goal (explicit, Istvan 2026-07-02): the point of upstreaming this patch is to keep the local
> deployment cleanly UPDATABLE (`update.sh` is `git pull --ff-only`, which breaks on a divergent
> local commit). We do NOT want to maintain a permanent fork. Getting ca63681 accepted upstream
> means future `update.sh` runs fast-forward cleanly with zero local divergence.

---

## 1. Technical summary -- what ca63681 fixes

An agent's tmux pane can be at **100% context ("context saturation")** while still presenting a
visually **idle, ready-looking footer** (empty prompt box, `bypass permissions` footer). The
existing `isSessionReadyForPrompt()` only checked `paneLooksIdle()`, so it classified a saturated
pane as dispatchable. Result: the inter-agent message-router AND the scheduled-task runner both
inject new work into a session that cannot actually process it -- the task silently strands.

Observed live 2026-06-30/07-01: multiple fleet agents hit 100% context back-to-back and kept
receiving dispatches that went nowhere. The commit closes the gap in one central place
(`isSessionReadyForPrompt`) so both dispatch paths are covered, and adds an auto-recovery hook.

What it adds:
- `paneShowsContextSaturation()` -- a pure, zero-import predicate (mirrors `paneLooksIdle`), scoped
  to the live footer region so a scrollback quote of "100% context used" (a QA report, a kanban
  comment, even this very diff) does NOT false-positive.
- `isSessionReadyForPrompt()` returns `false` on a saturated pane (both message-router + scheduler).
- On detection, auto-triggers `scripts/dispatch-guard.sh`: evidence capture (pane scrollback, git
  status/diff, recent files) -> loop-guard (quarantine after repeated recoveries) -> fresh restart
  -> recovery-context brief. Debounced 5 min per session so polling ticks don't spawn concurrent
  recoveries.

Known gap (documented in the commit, NOT closed): `forceSend=true` scheduled tasks bypass
`isSessionReadyForPrompt()` entirely, so they also bypass this guard. That is deliberate (forceSend's
contract is "inject regardless, never silently drop") and tracked separately (fleet kanban #129,
parked on branch `feat/forcesend-ctxsat-instrumentation`).

## 2. Affected files (5 files, +303 / -3)

| File | +/- | What |
|------|-----|------|
| `src/pane-state.ts` | +25 | new `paneShowsContextSaturation()` predicate + `CTX_SAT_RX` / footer-region constant |
| `src/web/agent-process.ts` | +59 / -? | `isSessionReadyForPrompt()` CTX_SAT check (both capture samples) + `maybeTriggerContextRecovery()` (debounced spawn of dispatch-guard.sh) |
| `src/web/schedule-runner.ts` | +17 | documents the forceSend+CTX_SAT bypass gap at the readiness-check call site (comment only; no behaviour change) |
| `scripts/dispatch-guard.sh` | +147 (new) | evidence-capture -> loop-guard -> fresh restart -> recovery brief; also runnable standalone `dispatch-guard.sh <agent>` |
| `src/__tests__/pane-state.test.ts` | +58 | 5 new unit tests incl. a real captured-incident fixture + self-referential-scrollback false-positive guard |

## 3. Why NOT redundant with the v1.18.1-v1.18.5 upstream fixes

The upstream `fix/parked-escalation-stale-frame-guard` line (v1.18.1-1.18.5) and this commit solve
**different problems** in the same file neighbourhood:

- Upstream (parked-input line): handles a **stale/parked input line** stuck in the box -- the
  `clearStaleParkedInput` / `unwedgeAttempts` / dim-frame-guard / main-agent escalation logic. It is
  about *non-submitted text sitting in the prompt box*.
- ca63681 (this commit): handles **context saturation** -- the pane is idle with an EMPTY box but
  the model is out of context window. Completely orthogonal condition; the box is empty, nothing is
  parked.

They touch `agent-process.ts` in adjacent regions but do not overlap functionally. Verified with
`git merge-tree` (write-tree simulation, no mutation) against both `origin/main` and the fix branch:
**both merge cleanly, zero conflicts**, and the resulting tree contains dispatch-guard.sh AND the
upstream parked-input changes together. ca63681 does not duplicate, revert, or supersede any
v1.18.1-1.18.5 change, and vice-versa.

## 4. Tests that verify it

- `npm run build` (tsc): PASS -- clean typecheck (verified at commit time 2026-07-01 and again on the
  rebased tree by the operator 2026-07-02: build PASS).
- `npx vitest run`: PASS -- full suite green on the rebased tree (operator report 2026-07-02:
  103 test files, 1521 passed, 1 skipped).
- Targeted re-run 2026-07-02 08:15 (this prep, read-only):
  - `src/__tests__/pane-state.test.ts` -- 192 passed (incl. the 5 new `paneShowsContextSaturation` cases)
  - `src/__tests__/send-prompt-force-send-gate.test.ts` -- 4 passed
  - `src/__tests__/schedule-runner-autostart.test.ts` -- 4 passed
  - `src/__tests__/schedule-runner-heartbeat-prefix.test.ts` -- 4 passed
  - `src/__tests__/schedule-run-now.test.ts` -- 4 passed
  - Total targeted: 208 passed, 0 failed.
- Live smoke (commit-time evidence, `store/deploy-rollback/20260701-103737/`): controlled dashboard
  restart, synthetic saturated-session block confirmed in dashboard.log
  ("dispatch-guard: context saturation detected, auto-recovery triggered"), normal inter-agent
  delivery still worked, watchdog health clean.

## 5. Suggested PR title

```
feat(dispatch): block context-saturated agent sessions before prompt injection
```

## 6. Suggested PR description (markdown)

```markdown
## Problem

An agent's tmux pane can sit at 100% context ("context saturation") while its footer still looks
idle and ready (empty prompt box, `bypass permissions` footer). `isSessionReadyForPrompt()` only
checked `paneLooksIdle()`, so a saturated session was treated as dispatchable -- both the
inter-agent message-router and the scheduled-task runner would inject new work that the session
cannot process. The task silently strands. Observed live across several fleet agents on 2026-06-30/07-01.

## Fix

- Add `paneShowsContextSaturation()` to `pane-state.ts`: a pure, zero-import predicate (same shape as
  `paneLooksIdle`) scoped to the live footer region, so a scrollback quote of "100% context used"
  (a report, a comment, this diff) does not false-positive.
- `isSessionReadyForPrompt()` now returns false when the pane is saturated -- one central fix covering
  both dispatch paths.
- On detection, auto-trigger `scripts/dispatch-guard.sh` (evidence capture -> loop-guard -> fresh
  restart -> recovery-context brief), debounced 5 min per session.

## Not covered (intentional)

`forceSend=true` scheduled tasks bypass `isSessionReadyForPrompt()` by design ("inject regardless,
never silently drop"), so they also bypass this guard. Documented at the call site; a follow-up
(observation-first instrumentation + optional safe-mode behind a default-OFF flag) is tracked
separately and not part of this PR.

## Tests

- `tsc` clean, full `vitest` suite green (1521 passed / 1 skipped).
- 5 new unit tests in `pane-state.test.ts`, including a real captured-incident fixture and a
  self-referential-scrollback false-positive guard.
- Live smoke: controlled dashboard restart + synthetic saturated-session block confirmed in logs +
  normal delivery unaffected.

## Files

`src/pane-state.ts`, `src/web/agent-process.ts`, `src/web/schedule-runner.ts` (comment only),
`scripts/dispatch-guard.sh` (new), `src/__tests__/pane-state.test.ts`.
```

## 7. Suggested upstream ISSUE description (markdown) -- if an issue is wanted before a PR

```markdown
### Bug: context-saturated agent sessions are treated as dispatchable

**Environment:** fleet with multiple agent tmux sessions, main dashboard message-router + scheduler.

**Symptom:** when an agent pane reaches 100% context, its footer still renders as idle/ready (empty
prompt box). `isSessionReadyForPrompt()` (used by both the inter-agent message-router and the
scheduled-task runner) only checks `paneLooksIdle()`, so it classifies the saturated pane as
dispatchable. New tasks are injected into a session that cannot process them and strand silently.

**Repro:** drive an agent to 100% context, leave the prompt box empty; observe that the router /
scheduler still deliver to it and the work is never processed.

**Impact:** silent task loss / stalled inter-agent delivery on busy days; hard to notice because the
pane looks healthy.

**Proposed direction:** a footer-region-scoped saturation predicate feeding
`isSessionReadyForPrompt()` (so the pane is treated as not-ready), plus an optional recovery hook
(evidence capture + fresh restart). Happy to open a PR (local implementation exists and is tested).
```

## 8. Exact local git commands for a later push / PR flow

```bash
# (run when GitHub network + gh auth are available -- gh API timed out from the current sandbox)
cd /home/iszzu/marveen
git switch main
git switch -c pr/dispatch-ctx-saturation-guard ca63681   # dedicated PR branch off the commit
git push -u origin pr/dispatch-ctx-saturation-guard       # publish branch
gh pr create \
  --repo Szotasz/marveen \
  --base main \
  --head pr/dispatch-ctx-saturation-guard \
  --title "feat(dispatch): block context-saturated agent sessions before prompt injection" \
  --body-file audits/ca63681-upstream-pr-prep.md   # or paste the section 6 body
# If an issue-first flow is preferred:
gh issue create --repo Szotasz/marveen \
  --title "Context-saturated agent sessions are treated as dispatchable" \
  --body "<section 7 body>"
```

Note: `main` currently already contains ca63681 as its tip (1 ahead of origin). The dedicated
`pr/...` branch above keeps the PR history clean and lets `main` fast-forward to upstream once the
PR merges (see rollback/patch workflow).

## 9. Rollback / local-patch workflow if upstream does NOT accept

The whole point is updatability, so if upstream declines or stalls:

1. **Keep the change as a local patch, not a divergent commit.** Export it:
   ```bash
   git format-patch -1 ca63681 -o backups/patches/   # -> 0001-feat-dispatch-...patch
   ```
2. **Un-diverge main** so `update.sh` (`git pull --ff-only`) works:
   ```bash
   git switch main
   git reset --hard origin/main    # main == upstream, zero divergence
   ```
   (dispatch-guard.sh is a standalone script + the pane-state/agent-process edits are the patch;
   nothing else depends on the commit being in main history.)
3. **Re-apply after each update** as a post-update step:
   ```bash
   git apply backups/patches/0001-feat-dispatch-*.patch   # or keep it applied on a local-only branch
   npm run build && npx vitest run
   ```
4. Alternatively keep a permanent local branch `local/ctx-saturation-guard` rebased onto each new
   upstream release and run the dashboard from it -- but this is the fork we are trying to AVOID
   (see goal). The patch-reapply flow is preferred because it keeps `main` == upstream.

Backups already on disk: `backup-before-update-divergence-20260702-072201` tag (pre-rebase state),
`store/deploy-rollback/20260701-103737/dist-backup.tar.gz` (pre-guard dist).

## 10. Why upstream, not a permanent fork

`update.sh` runs `git pull --ff-only`. A local-only commit on `main` (ca63681) makes main divergent,
which BREAKS `--ff-only` and blocks all future upstream updates (this already happened: the local
commit went 1-ahead/10-behind before the operator rebased). Maintaining a fork means manually
rebasing every upstream release and re-verifying -- exactly the maintenance burden we want to avoid.
Upstreaming the patch means: once merged, `main` fast-forwards to each new `Szotasz/marveen` release
with zero divergence, zero manual rebase, and the guard ships to every other Marveen deployment too.
The rollback/patch workflow (section 9) is the fallback ONLY if upstream declines.
```
