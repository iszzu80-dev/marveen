# Card 585c056c — Producer Report (devops)

`fleet-context-guard.sh` restarts agents at ~30% real context: `claude-opus-5` missing from its
own hand-maintained model→window map, silently falling through to a 200k default. HIGH priority,
actively firing on live agents (most recent: `deliverylead`, today 15:00:01, "150% context").

Branch `fix/context-guard-model-window`, worktree `/home/iszzu/marveen-wt/ctx-guard`, base verified
against local `develop` (fork-local marker `src/costops/schema.ts` present). **Not merged. Not
pushed. Not deployed** — see "What must happen before this actually takes effect" below; this is
important, not boilerplate.

## What I built (per the card's exact scope)

| Scope item | What I did |
|---|---|
| 1. Unknown model → no silent default, skip + log loud | `isRecognizedContextModel()` (new, `src/context-guard.ts`) returns false for anything not matched by an evidenced family. The shell script checks `contextLimitKnown` and, when false, prints a loud `UNKNOWN-MODEL` line to stderr (captured by the cron redirect into `store/logs/fleet-context-guard.log`) and produces NO reading for that agent — never computes or acts on a percentage. |
| 2. Assert pct ≤ 100; a violation is a bug signal, never a restart trigger | The shell script's embedded Python now checks `if pct>100` and prints a loud `IMPOSSIBLE-PCT` line, skipping the agent entirely (no `critical`/`warn` line emitted, so the bash while-loop below never sees it). |
| 3. Add `claude-opus-5`; derive the window from the config/registry the fleet already has | Did NOT add a second hardcoded entry. `claude-opus-5` was **already correctly handled** by the canonical TS registry (`contextLimitForModel` in `src/context-guard.ts`, via the existing `/opus-[5-9]\b/` regex family — confirmed by an EXISTING passing test, `context-guard.test.ts:74`, that already asserted `contextLimitForModel('claude-opus-5') === 1_000_000`). The bug was never "opus-5 is unknown to the fleet" — it was that the shell script kept its OWN second, hand-maintained, exact-string Python dict that never got this entry. Fixed by deleting that dict and having the shell script consume `contextLimit`/`contextLimitKnown`, two new fields on `/api/agents` (`src/web/routes/agents.ts`) computed server-side from the SAME canonical registry the TS-side `context-guard-runner.ts` already uses. One registry, two consumers, zero drift possible by construction. |
| 4. Audit the 174 | Done, see below — this is the actual measure of what the bug cost. |

### A related, smaller consolidation found while fixing this

`contextLimitForModel`'s own DEFAULT for an unmatched model was already 200k (safe for its ONE
existing consumer, `context-guard-runner.ts`, which self-corrects via `calibrateLimit`'s high-water
mark). But DeepSeek was ALSO falling through to that same 200k default in the canonical registry,
while the shell script's now-deleted second map had it correctly at 180k (its own comment: "empirically
... deepseek froze ~176k"). Consolidating the shell script onto the canonical registry would have
silently REGRESSED DeepSeek's accuracy (180k → 200k) had I not also fixed the canonical registry
itself. Added DeepSeek as an explicit, evidenced family (180k) to `contextLimitForModel`, updating
the one existing test that asserted the old (accidentally-wrong) 200k default for it, with a comment
recording why the expectation changed.

## The three guard tests the card asked for, each proven RED-able

1. **An agent on a model absent from the map produces NO restart and a loud log line.** Mutated
   `isRecognizedContextModel` to `return true` unconditionally (defeats the "unknown model" signal
   entirely) → `context-guard.test.ts` red (1 test, the one asserting `claude-opus-3` /
   `some-brand-new-model` are NOT recognized). Reverted, `diff` clean.
2. **A computed pct > 100 never triggers a restart.** Removed the `if pct>100: ... continue` block
   from the shell script's embedded Python and re-ran it against a synthetic 6-agent fixture
   (covering: healthy known model, unknown model, and a nonsense-token-count agent). Before the
   mutation: `UNKNOWN-MODEL` line + 2 `critical` lines for genuinely-95%-full agents, impossible
   reading silently skipped. After the mutation: the impossible-reading agent wrongly emitted
   `impossible-reading 555556 critical` — proof the removed check was the only thing stopping a
   restart on a mathematically-impossible number. Reverted, `diff` clean, re-verified.
3. **A known model at genuine 95% still triggers (do not break the working path).** Covered by the
   SAME synthetic-fixture run above: `healthy-sonnet` (190000/200000, a real 95%) and
   `critical-sonnet` both correctly emit `critical` in the un-mutated script. This is not a
   theoretical claim -- it is the actual output of running the real embedded Python against
   realistic JSON.

## The audit (scope item 4) — what this actually cost

```
find store/recovery -type d -iname "*proactive*" | wc -l          -> 174
... reason.txt values with pct > 100 (impossible, arithmetic proof)  -> 85
average impossible pct                                              -> ~131%
```

**85 of 174 proactive recoveries (49%) fired on an arithmetically impossible reading** — agents
destroyed and restarted with most of their real context still unused. The most recent instance is
`store/recovery/deliverylead/20260730-150001-proactive/reason.txt` = "150% context (proactive,
pre-freeze)", filed at 15:00:01 TODAY — this is not a historical-only defect, it was firing again
this afternoon, and will keep firing every 5 minutes (the cron interval) until this fix is deployed.
The other 89 recoveries had a plausible-looking (≤100%) reading and may still have been individually
wrong (a model whose real window differs moderately from the assumed one would not show as
impossible), but only the 85 are provable from the numbers alone without per-agent model history.

## Verification

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0. `bash -n scripts/fleet-context-guard.sh`: exit 0.
- **Full suite: 286 files, 3920 passed / 1 skipped, exit 0.** Clean baseline measured directly at
  this branch's base (`47c5fff`, my new files/edits moved aside): **285 files / 3917 passed / 1
  skipped.** Delta: **+1 file, +3 tests, 0 regressions.**
- Both mutations above reverted (`diff` against pre-mutation backups = clean) and re-verified green.
- Manually ran the FIXED shell script (`--dry-run`, read-only, no restarts) against the LIVE
  dashboard's real `/api/agents`. Result: every agent showed `UNKNOWN-MODEL` — **not because the
  models are unrecognized, but because the live dashboard is still serving the OLD compiled `dist/`,
  which does not yet have `contextLimit`/`contextLimitKnown` on its API response.** This is the
  correct, safe behaviour (absent field ⇒ treated the same as unrecognized ⇒ no silent guess), and
  it is also the reason this fix needs an explicit deploy step, not just a merge.

## What must happen before this actually takes effect (not boilerplate — read this)

Merging to `develop` is not enough. `/api/agents`'s new fields are served by the DASHBOARD's own
compiled `dist/`, so **the live dashboard must be rebuilt and restarted** before
`scripts/fleet-context-guard.sh` (a plain shell script, no build step of its own, picked up live by
the next cron tick) sees real `contextLimit`/`contextLimitKnown` values. Until that restart, the
fixed shell script will report every agent as `UNKNOWN-MODEL` -- safe (no wrong restarts) but also
no useful monitoring at all. Recommend sequencing as: gate + merge → rebuild + restart
`marveen-dashboard.service` → confirm one live `--dry-run` shows real `critical`/`warn`/silent
readings (not `UNKNOWN-MODEL` across the board) → the fix is actually armed.

## What I did not do

- Did not merge to `develop`. Did not push. Did not move kanban card `585c056c` to `done`.
- Did not rebuild or restart the live dashboard, and did not touch the live
  `scripts/fleet-context-guard.sh` (the one cron actually runs) — only this worktree's copy.
- Did not touch the separate attribution defect (card f4e83150, hardcoded `"from":"marveen"` on the
  recovery brief) -- out of this card's scope, left for its own card.
