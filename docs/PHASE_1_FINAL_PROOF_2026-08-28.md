# Phase 1 — final proof report

```text
Status:        VERIFIED_DONE (owner, 2026-08-27 23:20 CEST)
Final runtime: 62c3a39da6aec860bed735ab73040b30965596a3
Acceptance:    17/17 PASS, with one recorded reopen condition
Written:       2026-08-28
```

This report says what was proven, **where it was proven**, and what is still
open. The distinction in the middle is the point: some acceptance items were
measured against the LIVE store on the running runtime, others against the test
suite at the exact pinned SHA, and a report that blurs the two is telling you it
checked something it did not.

---

## 1. What shipped, and in what order

| candidate | what it carried | fate |
|---|---|---|
| `f645e8f43` | P2 closure B (capability audit trail) | superseded, rollback artefact retained |
| `555602c6` | first cut of the Phase 1 candidate | **refused by CI** — a type error in a new test file; recut rather than patched on top, so the candidate SHA names exactly what CI tested |
| `db62bbf4` | P3 + P4 + P6 + both pre-release blocker closures | cut over 2026-08-27 23:17, superseded |
| `62c3a39d` | the two final-gate closures + the legacy exception + the triage trim fix | **live** since 2026-08-28 00:26 |

No intermediate release was cut for P3/P4/P6 — the owner's instruction was one
common candidate, and that is what happened.

---

## 2. The 17 acceptance points

`LIVE` = measured against the running runtime and the production store.
`SUITE@SHA` = proven by the test suite at the exact pinned SHA, because the
scenario has to be constructed (a crash, a forged ticket, a contradictory
packet) and cannot be staged on real data.

| # | acceptance | verdict | proven where |
|---|---|---|---|
| 1 | release SHA = runtime SHA = feeder SHA, guard/preflight PASS | PASS | LIVE — all three `62c3a39d…`, guard `bb1c086f…`, store inode `36036` |
| 2 | canonical case → projection automatic, drift 0 | PASS | LIVE — drift 0 before and after live progression runs |
| 3 | Invariant A on every active case | PASS | LIVE — personal 82/82, ZST 73/73, zero violations |
| 4 | typed WAIT parks on a real case and wakes once | PASS | LIVE — 6 live waits; every resolved wait has exactly one `resolved_run_id`, no duplicates |
| 5 | no duplicate progression / notification storm after a wake | PASS | LIVE — no case ran more than twice in an hour, zero outbox messages, zero new questions |
| 6 | `progress_stage` from canonical facts, not status mapping | PASS | LIVE — the same status maps to different stages: `WAITING_EXTERNAL` → 18 ACTIONABLE + 4 WAITING, `NEW` → 26 ACTIONABLE + 1 NEEDS_USER |
| 7 | `progress_stage = null` visible and monitored | PASS *(was the one FAIL)* | LIVE — see §3 |
| 8 | decision confidence/risk actually persisted | PASS | LIVE — **0/176 filled before the cutover**, because P4 had never run in production; MEDIUM/LOW and LOW/LOW with 1195- and 1156-byte assessments after |
| 9 | contradictory evidence blocks non-read-only execution | PASS | SUITE@SHA — `cos-invariant-e.test.ts` |
| 10 | high-risk action without scoped approval → MANUAL_ACTION_REQUIRED | PASS | SUITE@SHA + **LIVE** (§4) |
| 11 | explicit approval → exact matching authorization → single use | PASS | SUITE@SHA — `cos-action-approval-producer.test.ts`, the owner's seven proofs |
| 12 | payload/target mismatch or second use → DENY | PASS | SUITE@SHA — proofs 3a/3b/3c/3d and 5a/5b/5c |
| 13 | after a rejection the plan cursor does not step past the refused step | PASS | SUITE@SHA — and see §5, this was a real live defect |
| 14 | four crash boundaries, consistent and progressing after restart | PASS | SUITE@SHA — see §6 |
| 15 | ambiguous external outcome → W12 readback/recovery, never a blind resend | PASS | SUITE@SHA — including a **fresh, valid** approval failing to buy a resend |
| 16 | fresh-boot lock safety | PASS | SUITE@SHA — deterministic rendezvous proof, plus the stress reproducer |
| 17 | no new regression in full release health | PASS | LIVE + SUITE@SHA — 597 files / 8065 tests / 0 failures; cycle `problems: []` |

---

## 3. Closure 1 — the empty cell got a counter

`deriveStage` returns null for a real state: nothing closed, nobody owes
anything, no wait, nothing monitored, no executable next action. The board
showed an empty cell and **no number anywhere mentioned it**.

`/api/cos/monitoring` now carries `activeStageNullCount`,
`totalStageNullCount`, the cases by domain and id, a per-case reason naming
*which progression fact is missing* (`NOT_ENROLLED`, `NO_NEXT_BEST_ACTION`,
`NEXT_ACTION_NOT_EXECUTABLE`), and a `clean` health signal. They are **not**
mapped to ACTIONABLE.

**Live proof, by mutation and repair.** A count that only ever reads zero is
indistinguishable from a dead instrument, so the instrument was moved:

1. a real active case had its stored stage nulled → the endpoint went `0 → 1`,
   `clean` went false, the case was named, and the reason was exactly the
   condition created: *"the stored stage is null but a fresh derivation would
   give one: the projection is behind"*;
2. the projection sweep was run → `projected: 1, unchanged: 154` → the counter
   returned to `0`.

**A number I had to correct.** The "10 active null-stage cases" I reported at
23:26 was measured with an ad-hoc status filter of my own, not with the
codebase's terminal set. The true picture: 28 null-stage cases, **all
terminal** (24 CANCELLED, 4 COMPLETED), and the projection sweep does not touch
terminal cases — so those nulls are historical residue, not a live gap. Active
null-stage: **0**. The counter uses the same terminal set as the sweep, so the
two cannot drift apart.

---

## 4. Closure 2 — the refusal got a door, and the door opened by itself

`human-answer-class.ts` shipped with its own confession: HUMAN_ACTION_APPROVAL
was *"a built and tested path with no live producer today"*. Invariant E's only
allow-branch for a high-risk step was unreachable by any real sequence of
events.

The arc now runs end to end: a HIGH-risk refusal opens a scoped request and a
question naming the concrete action, the target and the payload fingerprint; an
explicit yes runs a deterministic gate and issues the **existing**
`action_authorizations` ticket; the next run consumes it, once. No second
approval system — the request row records what was asked, the ticket is the only
authority.

**It fired on its own, on a live case, 44 minutes after the cutover.**
Request `d04cf68f…`, case `zst-zst-1a0453a3a08a76c1`, plan step 3, risk
`IRREVERSIBLE_EXTERNAL`, delivered on `telegram:cos`, undecided. Nothing staged
it. That is the difference between a path that is tested and a path that is
alive.

**A quality finding from that same firing.** The question reads
*"Művelet: Identify required actions and dependencies"* — an internal plan
label, which `isUsableRecommendation` exists to keep off owner-facing surfaces
and which this codebase has already paid for once. The binding is correct (the
action, target, payload hash and risk are all named), so this is not a safety
defect; the sentence a person reads is machine vocabulary. **Open, for the next
candidate.**

---

## 5. What the work found on the way

Three defects were found by building the gate rather than by reading the code.

**The plan cursor walked through refusals.** `completed_plan_step` is advanced
a few hundred lines *before* Invariant E runs, so the engine refused a
high-risk step and recorded it as completed in the same run. The next run
picked the step after it: the refused step was silently skipped, and a case
could reach COMPLETE by walking straight through a refusal. Found because the
new approval gate refused every genuine approval with *"the step was completed
in the meantime"* — the gate was right and the state was wrong. Four
pre-existing tests asserted the old behaviour and were updated; two more now
reach plan exhaustion the way production will, by having the owner approve the
step.

**The triage seen-list trimmed a set.** `save_state` kept "the most recent 500"
with `list(ids)[-500:]` over a **set**, which has no order. Once at the cap,
every mark evicted twelve *arbitrary* ids. Measured, not reasoned about: a
notification marked at 22:14 came back as an unseen candidate at 23:01. The
case store was protected throughout by the intake's per-message idempotency —
which is worth stating plainly, because *"the store did not corrupt"* is not
the same claim as *"the system worked"*.

**Two mutations survived and changed the code.** The single-use latch had a
read-check in front of it, so deleting the conditional `UPDATE` changed nothing
any test could see — two guards, neither proven. And a gate refusal at answer
time would have thrown out through `recordOwnerAnswer`, losing the owner's
message; it is now a recorded decision.

---

## 6. The four crash boundaries

All four are real child processes killed with `SIGKILL`, with the signal
**asserted** rather than assumed, each with a control run on the same path.

| boundary | seam | restart proves |
|---|---|---|
| decision → durable write | the progression-run `INSERT`, mid-transaction | nothing committed, store consistent, restart writes exactly one run |
| approval → use | after the ticket commits, before consumption | the ticket survives unconsumed and is still spendable |
| the send's side effect | inside `adapter.send`, after **and** before the provider took it | no blind resend; `VERIFIED` by asking; `OUTCOME_UNKNOWN` when the provider cannot be asked; back to delivery only on a **proven** absence, ending with exactly one message at the provider |
| bootstrap | while **holding** the bootstrap lock | the lock dies with the process and the next boot acquires it without waiting |

The provider lives in a file so its state survives the process that talked to
it; the send counter is a file for the same reason, because *"did the restart
send again?"* is a claim about two processes.

---

## 7. The three historical `policy_bypass` rows

No retroactive authorization, no weakened detector — both were ruled out and
both would have been worse than the alarm.

```text
ob-mv-case-iszzu80-19fcbd3b431aa3c0-EMAIL_SEND-1   VERIFIED   created 2026-08-06
ob-mv-PRI-CLAIM-2026-001-EMAIL_SEND-1              VERIFIED   created 2026-08-10
ob-mv-case-private-19fe78e382f4c02c-EMAIL_SEND-1   VERIFIED   created 2026-08-10
```

Mail the owner sent by hand from Gmail, recorded in the ledger afterwards, from
before §22.2 tickets existed. First reported by the assertion 2026-08-15 19:00;
five occurrences in the fourteen days to 2026-08-27.

Recorded as exceptions bound to the **row id** and to the **state the row was
examined in**. A rule ("rows older than X") would cover a row written tomorrow
by a bug with an old timestamp; a row id covers exactly the row somebody
examined. If an excused row moves, it is no longer the thing that was excused
and the alarm returns on its own. A fourth, un-whitelisted row still fires
immediately — there is a test for exactly that.

Live proof: a real progression run on the case that alarmed at 23:26 now
reports `policy_bypass: passed`.

---

## 8. The open item: one unidentified flaky failure

One of seven full-suite runs at the pinned SHA failed, and **I cannot name
which test**, because my own command truncated the output. The six runs after
it and both exact-SHA CI events were green. The instrument was mine, not the
suite's; full output is now captured to a file on every run.

The owner's reopen condition, recorded here so it survives this conversation:

> If the full suite fails again on the same runtime line: do not rerun blindly
> to green; preserve the full output; classify as deterministic defect / flaky
> test / infrastructure issue; and if safety or state integrity is implicated,
> **reopen Phase 1 automatically**.

---

## 9. Evidence index

```text
CI            iszzu80-dev/marveen-private PR #32, branch phase1-rc/62c3a39d
              push run 33121443104, pull_request run 33121464399 — both SUCCESS
              (PR #31 / db62bbf4: runs 33110819714 + 33110848680, both SUCCESS)
suite         597 files / 8065 tests / 4 skipped / 0 failures at 62c3a39d
              npm run test:stress 2/2 · npx tsc --noEmit clean
mutation      27 mutations driven red across the packet set
              (18 for the two pre-release blockers, 9 for the final-gate closures)
checkpoints   backups/claudeclaw-20260827-231642.tar.gz (before db62bbf4)
              backups/claudeclaw-20260828-002548.tar.gz (before 62c3a39d)
rollback      tag prod-runtime/db62bbf41 + bundle sha256 e649239c…, extraction-verified
              predecessors f645e8f43 and 0011de922 retained
pin           releases/dashboard-runtime-pin.json
```
