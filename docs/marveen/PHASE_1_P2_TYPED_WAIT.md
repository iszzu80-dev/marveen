# Phase 1 / P2 — typed wait conditions (§10.4)

```text
Owner's condition, 2026-08-26: "Ne pusztán wait_system_json mezőket tölts fel. A
typed wait akkor kész, ha van writer + durable condition + wake
evaluator/trigger + idempotent wake + stale safety. Fake backfill nem
acceptance."
Status: built, tested, mutation-proven, MEASURED on a copy of the live board.
Merged on develop. NOT pinned -- see §5.
```

---

## 1. The audit was wrong about this, and how it was wrong is the design

The P1 audit's headline for P2 was: *`wait_system_json` is 0/167, a wake system
with no writer, this codebase's signature defect, third instance*, corroborated
by *WAIT_TIME appearing once in 17 343 runs against WAIT_EXTERNAL's 4 457*.

**Both halves were wrong.**

`wait_system_json` has a writer, a reader and a clearer, all in
`capability-preflight.ts`, and it means one specific thing: this case is parked
because a CAPABILITY is unavailable — a dead connector, a missing credential. It
is empty because **that branch is unreachable**: `preflight` returns `ok`
immediately when no capabilities are declared, and **no caller anywhere declares
any**. So it is the signature defect after all — built at both ends, inert in
the middle — just not the defect that was written down. That distinction
matters, because the fix for "no writer" is to write, and the fix for
"unreachable" is to wire the caller.

And `WAIT_TIME` is rare for an unrelated reason. `decide()` returns it only when
`context.nextWakeAt !== null`, and `next_wake_at` is **0 of 122**. That is the
same column P1 already found is an owner appointment the wake alert posts and
clears, AND part of the §10.8 dedup hash. So the decision engine's discriminator
between "a clock we hold" and "the world" was a field nothing fills — a fourth
consumer of a column that already had three meanings.

**Consequence.** Waiting on the machine and waiting on the world resolve
differently, wake differently, and mean different things to the owner. Putting
both in `wait_system_json` would be the same conflation this phase has now found
four times. So the typed condition gets its own table.

---

## 2. The five properties

| property | how |
|---|---|
| **writer** | every `WAIT_EXTERNAL` / `WAIT_TIME` decision arms one, in the pipeline's own transaction. A failure to arm is recorded on the run as a `WAIT_WITHOUT_TYPED_CONDITION` safety violation, not swallowed. |
| **durable condition** | `case_wait_conditions`: kind, subject, expected-by, evidence predicate, resolution mode, stale review, the event id at arming, and the resolution with the run that consumed it. A row, so a wait can be counted and audited after it ends. |
| **evaluator** | `evaluateWaitCondition` → `SATISFIED` / `EXPIRED` / `WAITING` / `NONE`, with the evidence that settled it. **Read-only**: the trigger asks on every sweep, and a query with a side effect would make the answer depend on who asked first. |
| **wake trigger** | `decideTrigger` consults it BEFORE the deadline rule and before the hash — a case waiting on the world does not change its own effective state while it waits, and an expiry is not an event at all, so the hash rule alone can never see one. |
| **idempotent wake** | resolution is by `UPDATE ... WHERE resolved_at IS NULL`. Two runners seeing the same satisfied condition: exactly one changes a row, the other is told so. `resolved_run_id` records which. |
| **stale safety** | §10.2 Invariant C, enforced at arm time: every condition carries a `stale_review_at`, including event-only ones, and a review time already in the past is refused. An event that never arrives cannot park a case in silence. |

**Kinds with no evaluator are REFUSED, not faked.** `COMMITMENT` needs the §11
promise tracker, which is Phase 2's and does not exist; `POLICY_CHANGE` has no
source at all. Arming either would put a row in the table that nothing could
ever resolve — a silent park with better paperwork, which is the owner's "fake
backfill" one layer down.

---

## 3. What it does to the board Istvan reads

`proj_next_review_at` finally has a real source. The P1 proof recorded, as a
thing that was still not true, that this column carried the poller's five-minute
re-check wearing the name of a review appointment. When a case has a typed
condition, the board now shows **that condition's own deadline**, and
`proj_wait_condition` shows `EXTERNAL_RESPONSE: a szerviz` instead of free text.

Two triggers on the wait table bump `canonical_revision`, because the projection
reads a table the canonical trigger does not watch — without them the board
would go stale while the revision insisted it was current, which is the one
failure `case-projection`'s own oracle test exists to make impossible.

---

## 4. What it was measured to DO, on a copy of the live board

Four full heartbeat passes over every active case, against a real copy taken
tonight:

```text
WAIT_EXTERNAL decisions        7
typed conditions armed         7   (EXTERNAL_RESPONSE / EITHER)
arm failures                   0
cases held by their condition  7   on the next cycle
```

So the live delta is bounded and is exactly the intent: seven cases stop being
re-reasoned every five minutes and start waiting for a named thing with a
deadline and a review date. Nothing else changes.

**Tests: 24, and 13 deliberate mutations, all 13 red.** Three survived the first
pass, each inside one of the five named conditions: the idempotency test
exercised the lookup-first early return and never reached the WHERE clause that
is the actual race guard; the EVENT_ONLY test armed with no deadline, so the
clock branch could not fire whatever the policy said; the TIMER test used a kind
with no event predicate, so the policy was never what enforced it. Same shape as
the P1 fence — a test that exercises the cheap guard and reports the expensive
one as proven.

Full suite: **586 files, 7850 tests, 0 failures.**

---

## 5. What is NOT done

**This is merged, not pinned.** P2 changes what the DECISION ENGINE does to live
cases — it holds a waiting case back instead of re-reasoning it — so the cutover
is the owner's gate, not a side effect of finishing the packet. The release
procedure is the Phase 0 one and takes one CI round.

**The capability preflight is still inert**, and this packet did not arm it. No
caller supplies `requiredCapabilities`, so a dead connector does not park
anything: the engine keeps reasoning over whatever context the resolver can
still return. That is a safety gate that exists and does not fire, it is
adjacent to P2 rather than part of it, and turning it on changes when the engine
refuses to run — an owner-visible change that should be decided rather than
slipped in.

**`waiting_on` is still the source of the subject.** The typed condition names
what it waits for by reading the case's own free text. Better than nothing and
honest about where it came from, but the real source is the outbound record of
what we actually sent and to whom.
