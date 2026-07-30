# Card 585c056c Part 2 — Producer Report (devops)

**Addendum (same day, after marveen's gate).** Two rounds of marveen re-checking the delivered
guard found real gaps in the guard itself, not the value fix. Both addressed below, each proven
against real production data with marveen's own exact mutation. See "Gate addendum" near the end.

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

## Gate addendum 1 — "freshness" framing corrected to "no stored baseline" (commit `7822f8c`)

Marveen's re-check (via deliverylead) found the sonnet-5 claim was not a true number that went
stale — the comment (authored 2026-07-29 08:25, citing a 14-day window) was already disproven by
62,861 turns inside that exact window at the time it was written. Their stated concern: a
"freshness" check keyed to a remembered baseline would have recorded the false claim as its own
baseline and never caught it.

Checked before redesigning: `findContextWindowViolations`/`verify-context-window-assumptions.ts`
already has no stored baseline — the query has no date filter, nothing cached between runs, full
corpus every call. No functional change needed. Reworded the doc comments (the previous "freshness"
framing invited exactly this reading) and added a test proving the verdict depends only on
peak-vs-current-assumed-limit, never on turn count or "since when" (1 turn of disproving evidence
flags identically to 250,000 turns of it).

## Gate addendum 2 — the verifier was blind to its own origin case (commit `9d53af8`)

Marveen's own mutation (removing sonnet-5 from the family lists, making it exactly as unrecognized
as opus-5 was when it killed deliverylead) left the verifier GREEN — "SKIP, not this check's job" —
while a model with 74,898 real turns sat entirely outside the registry. `findContextWindowViolations`
only ever audits models `isRecognizedContextModel` already lets through, so it structurally could not
see this class.

Added `findUnrecognizedModelsInUse` (new, pure, exported): flags an unrecognized model with real
fleet usage, exempting only the `<synthetic>` aggregation artifact (`peak <= 0`, live-verified: 555
rows, 0 peak — not real usage regardless of row count) and negligible one-off probes (`turnCount`
below `MIN_TURNS_FOR_REQUIRED_RECOGNITION = 10`, set above haiku's 2 genuine probe turns and below
`deepseek-v4-flash`'s 89 genuine in-fleet-use turns, the smallest real figure measured on this host).
`verify-context-window-assumptions.ts` now exits 1 and prints a loud `REGISTRY-GAP` line for either
failure mode.

**Proven against real production data with marveen's own exact mutation**: removed sonnet-5 from
`ONE_MILLION_FAMILIES`, ran the script against the live `store/claudeclaw.db` — printed
`REGISTRY-GAP: claude-sonnet-5 ... peak 935,023 across 74,898 turns`, exit 1. Reverted (`diff`
clean), reran, exit 0. Plus 5 synthetic-fixture tests (the mutation scenario, the `<synthetic>`
exemption, the negligible-turn-count exemption, the at-threshold boundary, and confirming an
already-recognized model is left to the other function).

Final verification after both addenda: tsc 0, build 0, full suite **286 files / 3931 passed / 1
skipped**, 0 regressions across all three commits on this branch.

## What I did not do

- Did not merge to `develop`. Did not push. Did not move kanban card `585c056c` to `done`.
- Did not touch the live install or the running dashboard (this value fix needs the same
  rebuild+restart sequencing as part 1 before it takes effect, and marveen already owns that step).
- Did not wire `verify:context-windows` into a scheduled heartbeat -- flagged as a reasonable next
  step in `docs/testing.md`, not actioned, since creating a live recurring schedule is an operational
  decision I did not want to make unilaterally mid-branch.
