# P2 — VERIFIED_DONE

```text
pin            f645e8f43d98f049c440749cbca0a14ca8ae8371
release = runtime = feeder sha, gate verified before the restart
CI, both events, same sha: tests/push 33065137016, tests/pull_request 33065150068 (PR #29)
local          589 files / 7928 tests / 4 skipped / 0 failures, tsc clean
guardSha256    bb1c086f61cbeffe… — UNCHANGED across five candidates
```

Two release rounds, because the first one's own live proof failed closure B.

---

## The B proof the owner asked for, twice over

**1. A real `case_progression_runs` row carries the whole chain.**

```json
{ "action":     "Process response and decide next step",
  "kind":       "EXECUTE",
  "resolution": "RESOLVED",
  "target":     "gmail",
  "required":   ["RUN_LEDGER", "CONNECTOR_WRITE:gmail"],
  "verdict":    "PROCEED",
  "reason":     "EXECUTE -> gmail (EMAIL_SEND a kimenő főkönyvben, ledger ob-mv-4655682f…)" }
```

Every link he named: planned action → resolved target → required capability →
preflight verdict. The floor (`RUN_LEDGER`, what *recording* it needs) and the
concrete channel (`CONNECTOR_WRITE:gmail`, what *performing* it needs) both
survive, because they answer different questions.

**2. It persists on a NORMAL successful run, not only on DENY/WAIT.**
`status: COMPLETED`, `verdict: PROCEED`. Four trail rows now stand, across
`VERIFY`, `EXECUTE`, `WAIT_EXTERNAL` and `CONTINUE_AUTONOMOUSLY` decisions.

**What I had to do to reach a RESOLVED target, declared.** Every plan starts at
a `VERIFY` step, so an ordinary run records `NOT_REQUIRED` — a real value of the
link, but not the one worth showing. I moved the plan cursor (`completed_plan_step`)
past the wait so the next action was the `EXECUTE` that drives the case's pending
`EMAIL_SEND`. The case status, the typed wait and the ledger row were not
touched, and the ledger row is still `PLANNED / attempt 0` afterwards — checked,
not assumed.

---

## Release-health guards

```text
problems: []          every step SUCCESS
invariant A           personal 77/77   zst 71/71   violating 0
drift                 all five buckets 0        fenced 0   conflicts 0
side effects          followups drafted []   channel sent 0   wakeAlert not posted
capabilityCoverage    riskyDeclared 3/3, undeclaredRisky [], status PASS
```

`operationalHealth().clean` is **false**, and that is correct rather than a
failure: two runs are `UNVERIFIED` — external actions performed without a
readback. §8.7's rule biting exactly where it should, and a live counter-proof
that this morning's run-status fix did not weaken it.

---

## A and C

Passed their live proof on `6887e733` and are unchanged in this release. Their
evidence stands in `PHASE_1_P2_CLOSURES_ABC.md`.

---

## What this release actually corrected

The previous one built the capability trail, returned it on the run result, and
persisted it nowhere. Its own live proof caught it — `capability assertions:
none` on every real run — which is the useful part: **the acceptance found a
defect the whole test suite had agreed was fine**, because every test asserted on
the returned object and none asked the database.

Built and never consumed, committed inside the packet about built-and-never-
consumed, in the same hour I wrote *"a trail that only appears when something
goes wrong cannot show that the check ran."* A trail nothing writes down cannot
show it either.
