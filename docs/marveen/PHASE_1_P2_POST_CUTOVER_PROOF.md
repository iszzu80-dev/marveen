# Phase 1 / P2 — post-cutover proof

Owner GO 2026-08-27. Every number below was measured on the **live store** after
the cutover, through the pinned release, not on a copy and not in a fixture.

```text
pin            50a6b5659745cab81a59e8259714459564784429
release sha    = runtime sha = feeder sha = 50a6b5659
guardSha256    bb1c086f61cbeffe… (UNCHANGED from a6174a5bb — neither gate script
               moved between the candidates, and that is checked, not assumed)
preflightSha256 0839cd3504f8703d…
CI at this exact sha, BOTH events: tests/push 33044377095, tests/pull_request
               33044431499 (PR #26); kernel-contract success on both
local suite    587 files / 7870 tests / 4 skipped / 0 failures, tsc clean
```

**The release is not P2-only, and that is declared in the pin itself.** Two
commits landed on develop overnight after P2 and ride this cutover: `f55553f2`
and `50a6b565`, the `recoveryQueue` step's missing counters and the extraction of
the CPP normaliser to `src/cos/cycle-cpp.ts`. First measurable effect of that
change, on the first pinned cycle after the cutover:

```text
recoveryQueue  runStatus UNKNOWN  →  SUCCESS,  surfacesScanned: 3
```

That step had reported UNKNOWN on every pinned cycle since 2026-08-24.

---

## The seven conditions

### 1. A real WAIT_EXTERNAL case receives a typed condition

`case-private-1a03ebafc5167240` — one of the three spare-part enquiries Istvan
sent on 2026-08-26, genuinely waiting on a supplier. Its recorded effective-state
hash was cleared (what the trigger contract means by *changed*, the same
technique accepted in the P1 proof), and a normal pinned cycle was run. Nothing
else was touched.

```json
{ "kind": "EXTERNAL_RESPONSE",
  "subject": "reply from info@piscinericambi.it",
  "expected_by": 1788019336,
  "evidence_predicate_json": "{\"test\":\"CASE_EVENT_AFTER_ARM\",\"from\":\"reply from info@piscinericambi.it\"}",
  "resolution_mode": "EITHER",
  "stale_review_at": 1788019336,
  "armed_event_id": 672,
  "armed_run_id": "eda031c0-…" }
```

The subject is **read from the case's own `waiting_on`**, not invented. The
decision that produced it was `WAIT_EXTERNAL`, reason "Case is waiting for
external response".

### 2. The next ordinary cycle does not reason about it again

```text
trigger  →  shouldRun: false, reason: "waiting on a typed condition (EXTERNAL_RESPONSE)"
progression runs for the case, before two further full cycles:  4
progression runs for the case, after:                           4
```

### 3. Evidence or timeout wakes it exactly once

Two wakes, on two different cases, each exactly one run:

| leg | case | trigger | reference | resolution |
|---|---|---|---|---|
| satisfied | `…1a03ebafc5167240` | `NEW_RELEVANT_EVENT` | `wait:c24b9f15` | `SATISFIED` |
| expired | `…1a03ebb4887098a8` | `FOLLOW_UP_DUE` | `wait-expired:be7d9260` | `EXPIRED` |

Each wake produced exactly one new progression run, the resolved row carries
`resolved_run_id`, and the case re-armed a fresh condition because it is still
waiting.

**Said plainly, because it matters:** the SATISFIED leg was driven by moving
`expected_by` into the past — a **clock edit, declared**. No reply has arrived
from the supplier, and I did not fabricate one. The evidence leg proper (a new
case event after `armed_event_id`) is proven by the unit suite and by mutation,
not yet live. Inventing an inbound event to claim otherwise is exactly the fake
backfill the owner's acceptance forbids.

### 4. Two workers, one resolution

Two separate OS processes, same condition row, same instant:

```text
W1  {"resolved":true,  "alreadyResolved":false, "resolution":"SATISFIED"}
W2  {"resolved":false, "alreadyResolved":true,  "resolution":"SATISFIED"}
```

Idempotent **by the WHERE clause**, not by check-then-act. The loser is told it
did not wake the case rather than being allowed to believe it did.

### 5. The stale review is reachable, and load-bearing

Deadline pushed out, review time pulled back (declared clock edit), so nothing
could satisfy the condition and only the stale review could speak:

```text
evaluate →  EXPIRED   "a várakozás felülvizsgálati ideje lejárt … anélkül, hogy bármi teljesítette volna"
trigger  →  FOLLOW_UP_DUE, wait-expired:be7d9260
```

`EXPIRED` is deliberately not `SATISFIED`: they mean opposite things to the
engine, and the row records which one happened.

### 6. Semantic drift = 0

After all the arming, waking and expiring above:

```text
invariantA  personal 76/76   zst 70/70   violating 0
drift       behind 0  neverReconciled 0  conflicted 0  unenrolled 0  disabled 0
reconcile   examined 146  projected 0  unchanged 146  fenced 0  conflicts 0
```

### 7. No mass notification, no follow-up side effect

| ledger | before | after |
|---|---|---|
| `outbound_ledger` | 4 | 4 |
| `zst_outbound_ledger` | 1 | 1 |
| `personal_case_events` | 683 | 683 |
| `zst_case_events` | 280 | 281 |
| followups drafted | — | `[]` on every cycle |
| channel sent / outbox | — | 0 / 0 |
| wakeAlert posted | — | `false`, `woken: []` |

**The one `zst_case_events` row is declared, not glossed.** Making
`zst-zst-19fe23c0d248e086` (AWS Activate) due surfaced that its external wait is
genuinely 15 days old, so the engine escalated it — `RECOVERY_STARTED`. That is
the engine doing its job on a real overdue case; I changed *when* it noticed, not
*what* it found. The case status itself is unchanged.

---

## Two things this run found that were not in the plan

### A. A cycle error that does not reach `problems`

Running two cycles concurrently produced SQLite contention — my own doing — and
the report was:

```json
"progression": { "cycleErrors": 1,
                 "errors": ["personal/case-private-1a03ebafc5167240: database is locked"] },
"problems": []
```

The contention is a test artefact. **The blindness is not.** The runner's failure
detection reads `failed: true` and a `failures` array, at two depths. The
progression step reports per-case errors under `errors`, and a count under
`cycleErrors`. Neither is read, so a step can report one error and the cycle
still prints `problems: []` and `runStatus: SUCCESS`.

This is the third door into the same room: 2026-08-11 was the unread `failures`
array, 2026-08-26 was the unparseable payload, and this is the unread `errors`
array. Every `problems: []` in this document is weaker than it looks until it is
closed, and it is being closed in the hardening release rather than quietly.

### B. A satisfied wait sorts to the BACK of the due queue

**CORRECTED 2026-08-27 12:05, and the original error is left visible because it
is the more useful half of this entry.** This section first said "the poller
takes ONE case a cycle" and called a 64-case queue a ten-hour drain. That is
wrong. `runProgressionHeartbeat(db, now, 50)` takes **50 per domain**, so a cycle
examines up to a hundred cases.

Where the wrong number came from: the cycle report carries `limit: 1` inside the
progression block, and I attributed it to the sweep. It belongs to
**GoalEnrichment** — a different subsystem whose canary throttle lands in the
same merged payload. That is precisely the merged-payload collision this
runner's own history is built around, and I walked into it while documenting it.

**The problem is real; the mechanism is different.** The due page is ordered
`next_progression_at ASC`, and arming a wait pushes that value FORWARD. So a
freshly satisfied wait sorts to the BACK of the queue it needs to be at the front
of. Measured on the live store at 12:04:

```text
personal   49 due,  oldest due age 561s
zst        50 due,  oldest due age 561s
both active typed waits: 49 cases sort AHEAD of each
```

The manual `next_progression_at = 1` nudge needed at 09:22 to get an EXPIRED
condition examined at all is the same finding from the other side: freshness
ordering starves the freshly woken.

Owner's closure C addresses this with bounded priority rather than a bigger
limit — a bigger limit would not have helped, which is exactly why the wrong
diagnosis mattered.
