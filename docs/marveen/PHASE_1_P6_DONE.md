# Phase 1 / P6 — the end-to-end proof, and restart

```text
PACKET: P6 (MIP-v1.0 §10, plan P6; §10.8 scenarios 1-10)
Status: DONE — local. Not released: no push, no CI round.
```

## What the packet is for

The audit's standing table said **four covered, four partial, one gap, one
unknown** — and every "covered" was covered by a *different file*, with a
*different fixture*, on a *different shape of case*. That is ten proofs that ten
mechanisms work. It is not a proof that they compose.

`src/__tests__/cos-p6-lifecycle.test.ts` drives the arc against **one real,
file-backed store**: intake → actionable → wait → wake → completion with evidence
→ contradictory evidence → reopen, then a process killed mid-flight and restarted.
A scenario that only passes on its own fixture fails here.

## The ten scenarios, and where each stands now

| # | scenario | in this harness | red-driven by |
|---|---|---|---|
| 1 | actionable case advances | durable run row + stored NBA | M9 (NBA not stored) |
| 2 | wakes on EVENT | typed condition, control before the event | M4 (event stops satisfying) |
| 3 | wakes on REVIEW DATE | clock satisfies, control while waiting | M3 (clock stops satisfying) |
| 4 | a wait nothing satisfies EXPIRES | EVENT_ONLY + stale review | M2 (stale review removed) |
| 5 | one consolidated question | second run does not re-ask | — |
| 6 | high-risk low-confidence → NO side effect | Invariant E refusal + empty ledger | M5 (gate disabled) |
| 7 | completion needs evidence **and a case-specific DoD** | both, with a control that opens the gate | M1 (provenance rule removed) |
| 8 | contradictory evidence → reopen | reopen + completion preserved in the log | M6 (`completed_at` not cleared) |
| 9 | duplicate event → no duplicate progression | trigger contract, with a real-change control | M8 (unchanged short-circuit removed) |
| 10 | consistent after restart | **a real process, SIGKILLed mid-transaction** | M7 (the kill itself removed) |

Nine of the ten have a named mutation that drives them red. Scenario 5 does not,
and that is stated rather than implied: its no-re-ask guard is covered by the
question suite's own tests, and I did not add a second mutation for it here.

## Scenario 10, which is the packet

> *"The restart case kills the process BETWEEN the decision and the write, which
> is where a state machine actually breaks — a restart between runs proves
> nothing."*

A thrown error is not that. A throw unwinds, runs `finally`, lets better-sqlite3
roll back cleanly and gives every guard a chance to behave. So this is a **real
child process** that **SIGKILLs itself** at a named SQL statement — the
progression run INSERT, with the decision made, the row being written and the
transaction uncommitted.

Three things make it a test rather than a demonstration:

* **The seam is a statement, not a timer.** `prepare` is intercepted in the
  child, so the kill lands in the same place on every machine. A timing-based
  kill hits somewhere different each run, and a test whose failure point moves is
  not a test of anything.
* **The kill is asserted.** `expect(killed.signal).toBe('SIGKILL')`. A clean exit
  would mean the seam never fired, and the "no rows" assertion after it would be
  passing for the wrong reason.
* **There is a control.** The same child, same code path, `seam: 'none'` — writes
  exactly one run. Without it, "no rows after the kill" is indistinguishable from
  "the child never worked at all", which is the failure mode a crash test is most
  likely to have and least likely to notice.

And the restart must *work*, not merely not corrupt: after the crash the harness
runs the child again and asserts **exactly one** run row. A store that survives a
crash but cannot make progress afterwards is consistent and useless.

**A defect in my own first version, caught by the assertion above:** the child
was spawned via `npx tsx`, so the process that killed itself was a *grandchild*
and `spawnSync` reported npx's ordinary exit with `signal: null`. It now spawns
`node --import tsx` directly.

## Two findings the arc produced

**1. `canCompleteCase` reported criteria as unmet that it had just watched being
met.** Driving scenario 7 for real showed a generic-template DoD with **all three
criteria met with evidence** still refusing — correctly, on provenance — while
returning all three labels in `unmet`. The refusal was right and the payload
lied: a reader of `unmet` would conclude the criteria were the blocker. Fixed to
`[]`, matching the two sibling refusals that already return nothing. The blocker
is the provenance, and now the field says so.

**2. Two of my own scenario expectations were backwards, and one was
tautological.**

* Scenarios 3 and 4 asserted `EXPIRED` where the engine returns `SATISFIED`. The
  engine is right: reaching a wait's `expected_by` *is* the wake it was armed
  for. `EXPIRED` is reserved for the stale review passing with nothing having met
  the condition — so scenario 4 now uses an `EVENT_ONLY` wait, which is the only
  shape where that distinction is observable.
* Scenario 9 originally drove two cycles and asserted two run rows with two
  trigger references — true of a system that duplicates work as readily as one
  that does not. It now asserts the **trigger contract**: after a run consumed the
  state it saw, an unchanged case is not due; and a case that genuinely changed
  is. The control needed a real `transitionCase`, not a hand-written status
  UPDATE, because the trigger's identity is built from the case *version* — my
  first control changed something the trigger cannot see and read as a failure of
  the trigger.

## Evidence

593 test files, **8019 passed**, 4 skipped, `tsc` clean. Nine mutations driven
red, each named above. Run in a fresh worktree against a temporary file-backed
store.

## Known limitations

1. Scenario 4 remains **partial by design**: §11's commitment model is Phase 2,
   so what is proven is the wait's stale safety, not a promise ledger. Asserting
   more would be a green test over an unbuilt feature.
2. Scenario 5 has no dedicated mutation in this file (see the table).
3. The crash seam is one seam. A kill *after* the commit and *before* the
   projection would exercise a different window, and the reconcile sweep is what
   closes that one — proven in P1, not re-proven here.

## Next

Phase 1's six packets are built. The remaining owner-facing question is release:
nothing from P3, P4 or P6 has been pushed, and the runtime is still pinned at
`f645e8f4`.
