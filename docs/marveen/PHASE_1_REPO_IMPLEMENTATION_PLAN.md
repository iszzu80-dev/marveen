# Phase 1 — repo implementation plan (Reliable Case Autonomy)

```text
MIP-v1.0 §10. Written 2026-08-26, on the audit in PHASE_1_REPO_AUDIT.md.
Owner:   "Ne implementáld újra azt, ami már működik."
Goal:    prove that Canonical Case -> Next Action -> Waiting/Wake ->
         Completion+Evidence -> Confidence Escalation -> Stale/Reopen is ONE
         coherent, durable, autonomous state machine.
Packets: P1..P6, gated per packet, no separate go-ahead between them.
```

---

## 0. The shape of the work, in one paragraph

The engine exists and runs (17 343 progression runs, every active case covered).
What does not exist is **identity between the engine's view of a case and the
owner's view of it**: Invariant A holds 166/167 in `case_progression_state` and
fails 90 times out of 147 on the case board. So Phase 1 is mostly *closing*, not
*building* — and the one genuinely new mechanism is the typed wait condition that
§10.4 requires and `wait_system_json` has been reserving a column for, unwritten,
since it was declared.

Each packet below therefore starts from a **measured** gap, and ends with a check
that would have caught that gap.

---

## P1 — Reconciliation: one case, one truth

**Closes:** audit §3.2, §3.3, §1's `last_reconciled_at`.

The board and the engine disagree, and nothing notices. Two changes:

1. **A projection**, run at the end of every progression run: the engine's
   `next_best_action_json`, `next_progression_at` and wait condition are
   projected onto the case row (`next_action`, `next_wake_at`, `waiting_on`),
   with `last_reconciled_at` stamped. One direction only — the engine is the
   source, the board is the view. Two writers on one fact is how the two
   representations drifted in the first place.
2. **An invariant check with a consumer**: Invariant A evaluated per active case,
   surfaced on `/api/cos/monitoring` next to the §8.6 metrics, and counted in the
   cycle's `problems` when it regresses.

**Acceptance**
* Invariant A violations on the board drop to 0 for cases with progression state,
  measured on the live store before and after (today: 31 personal, 59 ZST).
* `next_wake_at` fill goes from 0/122 to match `next_progression_at`.
* RED proof: break the projection, the invariant check goes non-zero and the
  cycle reports it.
* The check must fail when the two sides disagree — not merely when the board is
  empty. A projection that overwrites without comparing would pass a weaker test.

**Do not rebuild:** the progression pipeline. This adds a write at its edge.

---

## P2 — Typed wait conditions (the §10.4 wake engine, completed)

**Closes:** audit §3.1 — `wait_system_json` 0/167, `WAIT_TIME` 1 in 17 343.

§10.4 enumerates seven wake triggers: event, new evidence, scheduled review,
deadline proximity, commitment due, external response, policy change. Today the
wait reason is free text in `waiting_on`, and the typed column is empty.

1. Define the wait-condition record (kind, subject, expected-by, evidence
   predicate, wake policy) and write it into `wait_system_json` on every
   WAIT_* decision.
2. Make the wake path read it: a case wakes when its condition is *satisfied or
   expired*, not only when a timer fires.
3. Keep the timer as the floor. §10.2 Invariant C: `WAITING` without
   `next_review_at` is allowed only under an explicit event-only wake policy that
   carries its own stale review — so the policy must be recorded, not implied.

**Acceptance**
* `wait_system_json` fill matches the number of WAITING cases; a WAIT decision
  that writes no condition fails the run.
* Scenario 2 (wake on event) and 3 (wake on review date) each have a test that
  goes red when the corresponding trigger is disabled.
* The event-only wake policy, if used at all, appears in a list that a human can
  read — an implicit one is indistinguishable from a forgotten timer.

**This is the one packet that adds a mechanism rather than closing a seam.**

---

## P3 — Progress stage, separated from status

**Closes:** audit §3.4 — 10 + 9 statuses, no `progress_stage`, `INFO_REQUIRED`
vs `INFORMATION_REQUIRED`.

Add `progress_stage` as a derived, canonical column
(`ACTIONABLE | WAITING | NEEDS_USER | COMPLETED | MONITORING`) with an explicit
mapping table from each domain status. Do **not** collapse the existing statuses:
they carry operational meaning the owner reads. Derive, do not replace.

**Acceptance**
* Every live status in both domains maps to exactly one stage — proven by a test
  that reads the *live* status vocabulary rather than a hard-coded list, so a new
  status added later fails loudly instead of silently becoming unmapped.
* The mapping is derived from the code that defines the statuses, not from a
  document. (This is the TEST_ORACLE_DEFECT rule applied.)

---

## P4 — Confidence and risk, so Invariant E is an invariant

**Closes:** audit §3.5.

Personal cases have neither. Add `confidence` and `risk` to the progression
state (not the case row — they are engine judgements), populate them on every
decision, and make Invariant E a gate the executor consults rather than a
sentence in a document.

**Acceptance**
* A high-risk low-confidence action is refused **by the invariant**, with the
  refusal naming confidence and risk — distinguishable in the log from a refusal
  by the approval bind, otherwise the test cannot tell which gate fired.
* Fill rate on both fields matches the decision count.
* The existing protections (approval bind, send ceiling) stay; this is a third
  gate, not a replacement.

---

## P5 — Reopen, and the two questions the audit could not answer

**Closes:** audit §3.6 and §3.7 — the honest-unknowns.

1. Establish whether a reopen path exists (§10.7). If it does, prove it with a
   test that produces contradictory evidence after COMPLETED and asserts: case
   reopened, previous completion preserved in history, reopen reason recorded,
   new next action set. If it does not, build exactly that.
2. For each declared-and-empty table (`cos_channel_outbox`,
   `cos_autonomy_global`, `cos_kill_switch_events`,
   `cos_thread_fetch_failures`), answer one question in writing: **is there a
   writer?** Empty-because-nothing-happened and empty-because-nobody-writes look
   identical and are opposite conditions.

**Acceptance**
* Scenario 8 covered by a red-capable test.
* A one-line verdict per empty table, with the grep or the caller that settles it.

---

## P6 — The end-to-end proof, and restart

**Closes:** scenario 10, and turns the §10.8 list into a suite.

One harness that drives a case through the full lifecycle against a real store:
intake → actionable → action → waiting → wake → completion with evidence →
contradictory evidence → reopen. Then kill the process mid-flight and restart,
and assert the state is consistent and no work is duplicated.

**Acceptance**
* All ten §10.8 scenarios green in one run, each one red-capable.
* The restart case kills the process *between* the decision and the write, which
  is where a state machine actually breaks — a restart between runs proves
  nothing.

---

## Sequencing, and why

```text
P1 ─┬─> P3 ──┐
    └─> P2 ──┼─> P6
P4 ──────────┘
P5 (independent, cheap, do early to remove two unknowns)
```

P1 first because every later measurement is read off a board that currently
disagrees with the engine — measuring against a lying surface wastes the packets
after it. P5 early because two of its answers are single greps and both are
currently guesses.

---

## Standing rules for every packet

Carried from Phase 0, because all three earned it the hard way:

1. **Name the consumer.** For every new field or table, the packet states who
   writes it and who reads it, and the acceptance checks the *output*, not the
   code. Three Phase 0 defects were correct code with no consumer.
2. **Expected names come from the code**, never from a document
   (`TEST_ORACLE_DEFECT_2026-08-26.md`). Derive from the module that creates the
   thing, or assert in a test that the name exists in the source.
3. **Every guard is driven red once**, deliberately, and the red run is recorded.
   A guard nobody has seen fail is a belief.
4. **Acceptance FAIL → stop.** Rollback may be skipped only if the oracle alone
   is provably at fault without touching product or runtime, and then the whole
   acceptance re-runs.
5. **Measure the live store before claiming a gap**, and say what the instrument
   covered. An absence proved with the wrong name is free and worthless.

---

## What this plan deliberately does not do

* It does not touch Phase 2's commitment/promise tracker (§11). Scenario 4 is
  marked *partial* in the audit for that reason, and closing it properly needs
  the commitment model, which is not Phase 1's.
* It does not restructure the case tables. The canonical model lives in
  `case_progression_state` and works; P1 makes the board agree with it rather
  than migrating either one.
* It does not add statuses.
