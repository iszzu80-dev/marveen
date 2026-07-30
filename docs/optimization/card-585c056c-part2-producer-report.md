# Card 585c056c Part 2 — Producer Report (devops)

Follow-up to the structural fix (part 1, merged `develop f424ee4`). Marveen re-measured live data
AFTER arming the structural fix and found the registry it now trusts had a stale value: sonnet-5 was
assumed 200k, real measured peak is 935,023 (4.7x). Worse: because part 1 correctly replaced the
shell script's own (accidentally correct, 1M) sonnet-5 entry with a read from this registry, the
stale 200k value created a live false-restart band (a sonnet-5 session at ~18-20% real usage would
be warned/restarted, come back low, climb, and be killed again — a restart loop).

Branch `fix/context-guard-sonnet-window`, worktree `/home/iszzu/marveen-wt/ctx-sonnet`, base verified
against local `develop` (`f424ee4`, confirmed to already carry the part 1 structural fix). **Not
merged. Not pushed.**

## Independent verification of the measurement (not accepted on report alone)

Queried `store/claudeclaw.db` directly before writing any code:

```
claude-opus-4-8       peak=999,621  (16,683 turns)
claude-sonnet-5       peak=935,023  (74,881 turns)   <- confirms marveen's number exactly
claude-opus-5         peak=887,621  (2,351 turns)
deepseek-v4-pro       peak=342,332  (17,513 turns)   <- a SECOND stale assumption, found independently
claude-sonnet-4-6     peak=173,237  (648 turns)
deepseek-v4-flash     peak=146,966  (89 turns)
claude-haiku-4-5-...  peak=43,406   (2 turns)
```

## What I built

| Change | Detail |
|---|---|
| `src/context-guard.ts`: sonnet-5 moved to the 1M family | `ONE_MILLION_FAMILIES` gains `/sonnet-[5-9]\b/` (mirrors the existing `/opus-[5-9]\b/` pattern). `TWO_HUNDRED_K_FAMILIES`'s sonnet entry narrowed from `/sonnet-\d/` to `/sonnet-4-\d/` so the OLDER sonnet-4-x line (measured peak 173,237, genuinely different model) is unaffected. |
| `src/context-guard.ts`: DeepSeek corrected 180k → 500k | Found while re-verifying every family, not just the one marveen flagged: 1,493 of 17,513 deepseek-v4-pro turns (8.5%) exceed the 180k this same card's part 1 set, with a genuine cluster at 339k-342k (not one outlier). Stepped to the next real `CONTEXT_LIMIT_TIERS` tier (500k) rather than hand-picking a number just above the peak. DeepSeek agents are not currently run (standing fleet rule), so this had zero live blast radius, but it sat wrong in the exact file this card is correcting. |
| `src/context-guard.ts`: `findContextWindowViolations` (new, exported, pure) | The transferable guard marveen asked for: given `{model, peak, turnCount}` observations, flags any RECOGNIZED model whose real peak exceeds `contextLimitForModel(model) * CALIBRATION_OVERSHOOT_TOLERANCE` (reusing the same accounting-overshoot tolerance already established elsewhere in this file, not a new invented threshold). Unrecognized models are out of scope for this function (that is `isRecognizedContextModel`'s job at the runner/script layer). |
| `scripts/verify-context-window-assumptions.ts` (new) | Thin I/O wrapper: reads real peaks per model from live `token_usage`, calls `findContextWindowViolations`, prints OK/SKIP/VIOLATION per model, exits 1 on any violation. Wired to `npm run verify:context-windows`. Read-only, no writes. |
| `docs/testing.md` | New "3. Live-data assumption check" section explaining what it is, why it exists, and that wiring it into a scheduled heartbeat (so drift is caught automatically) is a reasonable next step, not yet done. |
| `src/__tests__/context-guard.test.ts` | Updated the two existing assertions that had baked in the wrong sonnet-5/deepseek numbers, with comments explaining why the expectation changed. Added 5 new tests for `findContextWindowViolations`, including one that locks in the exact historical incident shape as a permanent regression test. |

## The guard proven against REAL production data, not just synthetic

This is the strongest form of proof available: I ran the actual script against the actual production
database, twice.

1. **Before fixing anything** (temporarily restored the stale `/sonnet-\d/` → 200k assumption in a
   throwaway mutation, ran `npx tsx scripts/verify-context-window-assumptions.ts` against the REAL
   `store/claudeclaw.db`):
   ```
   VIOLATION: claude-sonnet-5 -- assumed limit 200,000 (tolerated up to 250,000), but real peak is
   935,023 across 74,898 turns. src/context-guard.ts's stated assumption for this model no longer holds.
   ... FAILED -- 1 model(s) exceed their assumed context window.
   ```
   Exit code 1. This is not a synthetic fixture -- this is what the check would have printed the
   moment marveen's structural fix (part 1) went live, had it existed then.
2. **After the fix**, same real database, same script: all 7 recognized models OK (1 unrecognized
   `<synthetic>` row correctly skipped), exit 0.
3. Reverted the mutation (`diff` against a pre-mutation backup = clean) and re-ran to confirm the
   green state holds.

Synthetic-fixture tests in `context-guard.test.ts` additionally prove the mechanism generically
(a fabricated stale-haiku scenario, an in-tolerance non-violation, an unrecognized-model skip) so the
guard means something beyond today's one historical number.

## Verification

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0.
- **Full suite: 286 files, 3925 passed / 1 skipped, exit 0.** Clean baseline measured directly at
  this branch's base (`f424ee4`, my changes moved aside): **286 files / 3920 passed / 1 skipped.**
  Delta: **+0 files, +5 tests, 0 regressions** (the 5 new `findContextWindowViolations` tests; no new
  test FILE since they were added into the existing `context-guard.test.ts`).

## What I did not do

- Did not merge to `develop`. Did not push. Did not move kanban card `585c056c` to `done`.
- Did not touch the live install or the running dashboard (this value fix needs the same
  rebuild+restart sequencing as part 1 before it takes effect, and marveen already owns that step).
- Did not wire `verify:context-windows` into a scheduled heartbeat -- flagged as a reasonable next
  step in `docs/testing.md`, not actioned, since creating a live recurring schedule is an operational
  decision I did not want to make unilaterally mid-branch.
