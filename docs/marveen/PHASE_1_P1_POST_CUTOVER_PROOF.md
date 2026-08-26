# Phase 1 / P1 — post-cutover proof

```text
Owner's closure conditions, 2026-08-26 19:18. Eight items, each measured on the
LIVE store after the cutover, not on a copy and not on a fixture.
Runtime: a6174a5bb948ac3dd2167e49d55c5c017a2e2d2a (third P1 release).
```

---

## 0. Three cutovers, because the first two pinned cycles found their own defects

This is the honest shape of the closure and it belongs at the top.

| release | what it shipped | what its first pinned cycle revealed |
|---|---|---|
| `086d6cf0` | P1, reopen, the Hungarian rendering | the reconcile step's payload was **unparseable by the runner** |
| `07d82809` | both fixes for the above | `projected: 89` on a cycle that ran **zero** progressions |
| `a6174a5b` | deferral and projection bound together | two clean cycles, then a third with a real progression |

**Defect one.** The reconcile step pretty-printed its JSON. The cycle runner
parses stdout LINE BY LINE, so nothing parsed, and its entire failure-detection
block sits inside `if (parsed)`. The step printed `failures: []` and the runner
never read it: a real reconcile failure would have exited 0 and said nothing.
That is the same class the 2026-08-11 "a non-empty failures array is also a
failure" fix was written to end, arriving through a different door. Fixed on
both sides — the step emits one line, and an unparseable payload from a
zero-exit step is now itself a problem, because it also means that step's
failure reporting is invisible.

**Defect two, and it contradicts my own P1 document.** I wrote that the ordinary
path could not produce the "canonical advanced, board did not" state at all. It
produced it on **every single run**. `deferProgression` moves
`next_progression_at`, which the projection reads and the revision trigger
watches — and it has THREE call sites in the heartbeat loop, two of which never
touch the pipeline. The first fix closed one door of three; cycle two then
reported 89 projections while running zero progressions, every one of them the
loop deferring a case it had decided not to reason about.

Nothing was broken either time. The sweep repaired everything within seconds and
drift ended at zero. What was broken was the **signal**: a `projected` counter
dominated by the poller's own five-minute re-check cannot also tell anyone that
canonical state moved somewhere unexpected, which is the only reason to read it.
Deferral and projection are now one function.

---

## 1. The eight conditions

### 1. The pinned runtime contains AND RUNS the projection writer

```text
releases/cos-cycle-current/.release-sha   a6174a5bb948ac3dd2167e49d55c5c017a2e2d2a
releases/cos-cycle-current/src/cos/case-projection.ts        present
  .../src/cos/progression-pipeline.ts:1752  projectCase(db, domain, caseId, now)
  .../scripts/cos-cycle.ts                  step 'reconcile', second, after 'progression'
preflight --verify-only  → releaseSha == runtimeSha == a6174a5b, exit 0
```

Ran, not merely present: four consecutive pinned cycles carry a parsed
`reconcile` block with `runStatus: SUCCESS` and `examined: 146`.

### 2. A real canonical progression change projects automatically, with no manual backfill

One case was armed to be genuinely due and genuinely changed (its recorded
effective-state hash cleared, which is what the trigger contract means by
changed), then a normal pinned cycle was run. Nothing else was touched, and the
backfill script was not invoked.

| | before the cycle | after |
|---|---|---|
| engine `next_best_action_json` | step 2, `EXECUTE` | step 3, `VERIFY` |
| board `proj_next_action_kind` | `EXECUTE` | `VERIFY` |
| board `proj_next_action_step` | 2 | 3 |
| `canonical_revision` | 8 | 10 |
| board `projected_revision` | 7 | **10** |

The cycle reported `progression: personal 1` and `reconcile: projected 0`. The
zero is the point: the sweep found nothing to do because the **inline**
projection had already followed the decision inside the run's own transaction.

### 3. `last_reconciled_at` actually moves

Same case: `1787775464` → `1787775659`. Every cycle stamps all 146 active cases;
`/api/cos/monitoring` reports the OLDEST rather than the newest, so a sweep that
silently stopped covering part of the board could not hide behind one fresh row.

### 4. A stale projection write cannot write back over newer canonical state

Driven live on `CORP-CLOUD-2026-001`:

```text
outcome                              FENCED
conflictReason                       STALE_PROJECTION: canonical_revision 3 < projected_revision 8
projected fields unchanged           true
last_reconciled_at unchanged         true
row restored byte-identical after    true
```

Two independent fences, tested separately after a mutation run showed that
removing either one alone left the suite green — see §2.

### 5. Restart between the canonical commit and the projection write

Simulated exactly: a canonical field committed, the projection never run.

```text
drift immediately after the commit    behind: [CORP-CLOUD-2026-001]
sweep                                 projected: 1
drift after the sweep                 total: 0
board now matches canonical           true
progression runs unchanged            true   ← no duplicate progression
case version unchanged                true
case status unchanged                 true
```

### 6. No wake alert, follow-up draft, or case-link fired through the old field semantics

Measured against the pre-P1 backup taken before the first schema write:

| column | pre-P1 | now |
|---|---|---|
| `personal_cases.next_wake_at` filled | 0 | **0** |
| `zst_cases.next_wake_at` filled | 0 | **0** |
| `personal_cases.waiting_on` filled | 28 | **28** |
| `personal_cases.next_action` filled | 50 | **50** |
| `zst_cases.waiting_on` filled | 6 | **6** |
| `case_links` | 0 | **0** |

The projection never wrote any of them, which is why none of their consumers
could fire. This is the design decision from §1 of the P1 acceptance document,
measured rather than asserted.

### 7. Live drift is 0 after reconciliation, and stays 0 across further normal cycles

| cycle | projected | unchanged | drift | Invariant A | problems |
|---|---|---|---|---|---|
| B | 0 | 146 | 0 | 76/76 + 70/70 | `[]` |
| C | 0 | 146 | 0 | 76/76 + 70/70 | `[]` |
| D (with a real progression) | 0 | 146 | 0 | 76/76 + 70/70 | `[]` |

### 8. No mass notification, and no other side effect, from the cutover or the backfill

| surface | pre-P1 | now |
|---|---|---|
| `agent_messages` | 21140 | **21140** |
| `outbound_ledger` | 4 | **4** |
| case `version` sum, personal | 326 | **326** |
| case `version` sum, ZST | 118 | **118** |

**Every event written since the backup, named:** `681 PROGRESSION_ENABLED` (mine,
closing the outlier), `682 GOAL_DEFINED` and `683 PLAN_CREATED` (the ENGINE's,
during that case's first-ever run). Zero ZST events. Zero
`CASE_INPUT_OBSERVED`. Progression runs 17343 → 17346, all three that case's.

---

## 2. What the tests are worth

**Nineteen deliberate mutations across the two modules, nineteen red** — but not
on the first pass. Ten mutations against the projection killed eight; both
survivors were fence removals, because the two fences covered the same scenario
in the only test that exercised staleness. Nine against the reopen path killed
seven; the survivors were the engine re-arm and the reopen's own projection.
Every one of those four gaps was in an acceptance condition, and a green suite
would have reported all four as proven.

Full suite at the released sha: **585 files, 7826 tests, 4 skipped, 0 failures**,
plus CI green on that exact sha for **both** `push` and `pull_request` — stricter
than the Phase 0 cutover itself, which had a push run only.

---

## 3. What is still not true

**`proj_next_review_at` is a poll timer, not a review appointment.**
`next_progression_at` carries two meanings written by two functions —
`scheduleNextProgression` ("arm this wait") and `deferProgression` ("come back
later") — and `WAIT_TIME` has fired **once in 17 000 runs**, so in practice every
value is the poller's five-minute re-check. Invariant A does not currently lean
on it: all 146 active cases satisfy the invariant on the action-kind leg alone,
so the wait-condition-plus-review-time leg is not load-bearing today. P2's typed
wait condition is what gives that column a real source.

**The reopen has an owner-initiated entry point and no detector.** Nothing
automatically notices contradicting evidence arriving on a closed case.

**The process correction is accepted.** The backfill went in ahead of its writer
on the first pass, and the system re-drifted on its own within one cycle — which
we then measured at 90 cases. The order used from the second cutover onward is
the owner's: writer, migration, immediate reconcile, and proof, in one
controlled release.
