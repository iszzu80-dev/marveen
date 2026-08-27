# Phase 1 / P4 — confidence and risk, so Invariant E is an invariant

```text
PACKET: P4 (MIP-v1.0 §10, plan P4; audit §3.5)
Status: DONE — local, owner closure included. Not released: no push, no CI round.
Commits: 0153d999 (build), + this closure
```

## What the audit actually found

Not that Invariant E was being violated. That it was **not enforceable**: personal
cases carried neither a confidence nor a risk, so the sentence lived in a document
while the approval bind and the send ceilings did the protecting. Those are real
protections and they are *different rules that happen to overlap*. "Enforced by
something else that overlaps" and "enforced" are not the same claim.

## Implemented

`decision_confidence` and `decision_risk` on `case_progression_state`, by real
`ALTER` migration, written on **every** decision — not only refusals. A field
populated only on refusals is a refusal log wearing a judgement's name, and
"how often would a different threshold have fired" becomes unanswerable from data.

Named `decision_*` deliberately: two other `confidence` fields already exist
(`answer-interpretation`'s — how unambiguous Istvan's sentence was; `adjudication`'s
— how sure an origin guess is). A third bare `confidence` would be the
`next_wake_at` mistake again: one name, three meanings.

---

## The owner's closure, 2026-08-27, and what each part changed

### 1. HIGH confidence is now EARNED

> *"Confidence ne legyen »HIGH, amíg nem találtunk problémát« bizonyíték nélkül. […]
> A »nem detektáltunk doubt flaget« önmagában ne legyen bizonyíték a magas
> bizonyosságra."*

He was right, and the defect has a shape worth naming: the first version started
at HIGH and subtracted for named doubts, so **a case nobody had looked at scored
exactly the same as one where every input had been checked and found good.**
Absence of evidence was scoring as evidence of absence, on the permissive side.

HIGH is now closed by a **required-input proof set**. Seven inputs, each mapped to
the fact that settles it, each answered against the live store:

| owner's condition | input | instrument |
|---|---|---|
| required fact/input missing | `required_evidence_declared` | `success_evidence_requirements_json` / `dod_verification_json` |
| canonical state contradictory | `canonical_state_consistent` | P1's `projection_conflict_reason` |
| canonical state stale | `canonical_state_fresh` | latest evidence packet's watermark vs the case's version and event stream |
| unresolved external outcome / UNVERIFIED | `external_outcome_settled` | outbound ledger `APPLIED_UNVERIFIED` / `OUTCOME_UNKNOWN` / `RECOVERY_REQUIRED` |
| conflicting evidence | `evidence_non_conflicting` | latest `case_evidence_packets.conflict_reason` |
| required capability degraded or unknown | `required_capabilities_known` | this run's capability verdict + degradation count |
| required field value UNKNOWN | `no_unknown_required_field` | literal `UNKNOWN` in the fields the decision reads |

**`UNKNOWN` is not `FAIL` and is not `PASS`.** It caps confidence exactly as FAIL
does and spends no point, because "we could not check" and "we checked and it is
bad" are different facts. Every gather is guarded, and **a guard returns UNKNOWN** —
the tempting `catch { return PASS }` reads as robustness and is the permissive
answer to a question nobody managed to ask.

`canonical_state_fresh` was a timestamp comparison in my first attempt
(`last_reconciled_at` vs the case row's `updated_at`) and that question is
unanswerable mid-run by construction: the run bumps `updated_at` at its own upsert
and projects at its own end, so every run that changed anything would have called
its own inputs stale. It would have measured *did this run do something*, not *is
what we know current*. It now uses the evidence watermark, which is the instrument
that already existed for exactly this question.

### 2. Risk coverage is the Phase 0 policy surface

Five classes, and the refusal names which one fired:
`FINANCIAL_CONTRACTUAL`, `CREDENTIAL_SECURITY`, `DESTRUCTIVE`, `ACCESS_CONTROL`,
`IRREVERSIBLE_EXTERNAL`.

`FINANCIAL_CONTRACTUAL` **is** §24's `PAYMENT_ACTION_TYPES` + `LEGAL_ACTION_TYPES`,
imported rather than re-spelled, with a test asserting the sets are identical —
two spellings of one policy is how the ladder and the assertions drifted apart
before. `IRREVERSIBLE_EXTERNAL` is not a list: it is the `HIGH_RISK` side-effect
class, which already carries "this reaches outside".

**Honest state, stated rather than implied by a green suite:** the executor only
ever writes `EMAIL_SEND` today, so the destructive / access-control / credential
action-type lists match nothing in production. They are READY, not exercised — the
same posture §24's lists carry — and a test asserts exactly that rather than
letting coverage flatter itself.

### 3. The execution invariant widened

| rule | code |
|---|---|
| HIGH risk + confidence that is not HIGH | `invariant_e_high_risk_unproven_confidence` |
| LOW confidence + any non-READ_ONLY action | `invariant_e_low_confidence_side_effect` |

Two codes, not one: "Invariant E refused" would otherwise be one fact where there
are two, and a regression in one rule would hide behind the other passing.

A LOW-confidence READ_ONLY step is **allowed and restricted**: `assertionRestricted`
says it may keep reasoning and may not turn that reasoning into a completion or a
claim about the outside world. The completion half is enforced where it already
was — `canCompleteCase` as ENGINE requires evidence per criterion — and a test
proves it rather than a second gate being built beside it.

HIGH confidence never permits anything. The gate has no branch that returns
`allowed: true` for something another gate refused; the ladder still denies
`PAYMENT` and `SHARE_BEYOND_APPROVED` whatever the numbers say.

---

## THE DEFECT THIS CLOSURE FOUND, which was the packet's own

Found by probing, not by reading. **The gate fired into a variable nothing read.**

The run row is INSERTed at step 9. A comment above it says "the decision is NOT
final here" and names two later places that change it — both completion paths,
both of which UPDATE the row themselves. But two more gates run after the insert
and change `decision` in a local variable only: the §19 capability enforcement
(`WAIT_SYSTEM` / `MANUAL_ACTION_REQUIRED`) and Invariant E.

Measured on a real run, before the fix:

```text
RETURNED  decision=MANUAL_ACTION_REQUIRED   violations=[INVARIANT_E_REFUSAL]
DB ROW    decision=CONTINUE_AUTONOMOUSLY    safety_assertions_json: no refusal
```

And the production caller — `progression-heartbeat` — **discards the return value
entirely**. So the refusal existed for the length of one function call and then did
not. A gate whose verdict reaches no durable surface is the sentence this packet
was supposed to stop being.

Fixed with **one** finalisation write at the single point every path passes
through, rather than a write at each gate — four gates each remembering to persist
is the shape that produced the defect. It repairs the capability path in the same
stroke.

**Status is deliberately not changed to FAILED.** A refusal is the engine working,
not the run failing, and a FAILED status would put every correct refusal into the
cycle's `problems` — an alarm that fires on correct behaviour teaches the reader to
stop looking.

## The second finding, which the suite found and I did not

Widening the gate turned six existing tests red, all one shape: the engine asks,
Istvan answers, the plan cursor advances past the `AWAIT_DECISION` step, and the
next action is the EXECUTE that acts on his answer — HIGH risk, engine confidence
below HIGH, refused. The refusal's remedy is "a person must decide", which the
person had just done. **Ask → answer → ask again is not a safety property, it is a
loop.**

The owner's rule is about *autonomous* execution, and a step running on an answer
consumed by that very run is not autonomous. So the gate does not apply to it —
and it is RECORDED that it did not (`INVARIANT_E_OWNER_AUTHORISED`, with both
numbers), because a bypass nobody can see is worse than no bypass. It cannot become
a standing hole: `consumeOwnerAnswer` refuses an event any run of the case already
named, so the exemption is single-use, and a test drives exactly that — the next
run with no fresh answer is refused.

**This is a judgement call I made rather than one he specified, and it is the one
line of this packet worth his disagreement.**

## Measured on the live store (read-only snapshot, 168 active cases)

| confidence / risk | cases |
|---|---|
| HIGH / LOW | 16 |
| MEDIUM / LOW | 55 |
| MEDIUM / HIGH | 32 |
| MEDIUM / MEDIUM | 6 |
| LOW / LOW | 36 |
| LOW / HIGH | 23 |

**Refused by the widened gate: 55. By the old LOW+HIGH rule: 23.** The gate is
neither inert nor total: HIGH confidence is reachable today on 16 cases, so the
bar is not one nothing can clear.

Dominant demoter: `evidence_non_conflicting` FAILs on **141 of 168** — the reader
and the deterministic policy reached different decisions on the latest packet.
That is contradictory evidence in the literal sense the owner named, and it caps
at MEDIUM rather than LOW, so read-only work continues.

`canonical_state_fresh`: 97 PASS / 58 FAIL / 13 UNKNOWN. The 13 are cases with no
evidence packet at all — a case nobody has read cannot be a high-confidence
decision, which is the whole point.

## Tests added

`src/__tests__/cos-invariant-e.test.ts`, 34 tests. Every one of the owner's
mandatory counter-examples is a test **by name**:

* high-risk + high-confidence + other gates PASS → passes *this* gate only;
* high-risk + missing required evidence → block;
* low-risk + low-confidence read-only → continues, restricted;
* high-confidence PAYMENT → still DENY;
* confidence/risk persisted on an ordinary PROCEED, proven by readback.

Plus: each of the seven required inputs blocks HIGH on its own; UNKNOWN and FAIL
land in different places; each of the five risk classes reaches HIGH and says which
it was; the refusal codes are read off the **real** ladder rather than a remembered
list; and the durability regression above.

## Negative / mutation proof

Eight mutations, each driven red separately:

| # | mutation | result |
|---|---|---|
| M1 | proof-set cap removed | RED (9 tests) |
| M2 | gate rule 1 narrowed back to LOW-only | RED (7) |
| M3 | gate rule 2 deleted | RED (1) |
| M4 | UNKNOWN freshness scored as PASS | RED (5) |
| M5 | sensitivity risk class dropped | RED (1) |
| M6 | run finalisation deleted | RED (4) |
| M7 | owner exemption made permanent | RED (3) |
| M8 | degradation no longer fails the capability input | RED (1) |

## Migration

`ALTER TABLE case_progression_state ADD COLUMN decision_confidence / decision_risk /
decision_assessment_json`. No backfill: these are judgements about a decision, and
a backfill would invent judgements for runs that never made them.

## Rollback

Drop the three columns and revert the gate block. The approval bind, the ladder and
the send ceilings are untouched and keep protecting exactly what they protected
before this packet existed.

## Security impact

Strictly restrictive. The gate can only refuse; it adds no permission and no
egress. The finalisation write makes previously-invisible capability refusals
visible in the durable record.

## Evidence

592 files / 7986 tests / 0 failures, `tsc` clean, run in a fresh worktree at
`0153d999`. Live measurement above taken against a read-only snapshot of
`store/claudeclaw.db`; the live store was not written.

## Known limitations

1. The destructive / access-control / credential action-type lists are READY, not
   exercised — no production action type falls in them yet.
2. The gate reads `sensitivity` from the case row; the personal namespace records
   `PERSONAL` / `SENSITIVE_PERSONAL` only, so `CREDENTIAL_SECURITY` cannot fire
   there today.
3. The measurement above approximates a real run at its optimistic end
   (capability verdict PROCEED, no degradations, no pending action types). A real
   run can only be more restrictive, never less.

## Next packet readiness

P5 is closed (`PHASE_1_P5_DISCOVERY.md`). P6 — the end-to-end lifecycle harness and
the mid-flight restart — is the remaining packet, and it now has a durable decision
record to assert against, which it did not have an hour ago.

---

# Addendum — owner's policy correction, 2026-08-27 (P4 = VERIFIED_LOCAL)

> *"A human answer önmagában NEM teszi az utána következő high-risk actiont
> non-autonomous / exempt állapotúvá."*

He overturned the one judgement call this packet flagged as worth his
disagreement, and he was right. My version exempted a step whenever the run
consumed **any** owner answer. The argument — a step running on his answer is not
autonomous — holds for exactly one of the three things an answer can be.

## The three classes

| class | example | what it authorises |
|---|---|---|
| `HUMAN_INFORMATION` | "Igen, a cím 12/B." | nothing |
| `HUMAN_DECISION` | "Az A opciót választom." | reasoning — **not** an external side effect |
| `HUMAN_ACTION_APPROVAL` | "Igen, küldd el EZT az emailt ENNEK a címzettnek EZZEL a tartalommal." | this action, once |

**The intent decides, not the event label.** The first version had both — an
`OWNER_INFORMATION` special case *and* the intent — and the mutation harness
proved the consequence: deleting the label branch changed nothing any test could
see, because every fixture's `OWNER_INFORMATION` also carried `INFORM`. Two
guards, neither proven. It was **deleted** rather than propped up with a test:
this engine already rules that the choice decides when there is one, and
classifying by envelope would contradict the rule the rest of it follows.

## No parallel approval system

His instruction was explicit, and none was needed. `action_authorizations`
(§22.2) already carries every field he required, as columns:

| his requirement | the column |
|---|---|
| concrete action / type | `action_id`, `action_type` |
| target / recipient | `target_reference`, `recipient` |
| payload / parameters or hash | `payload_hash` |
| case / run | `case_id`, `case_version`, `goal_version` |
| single use | `single_use` + `consumed_at`, via an atomic conditional UPDATE |
| expiry / freshness | `expires_at` |
| not reusable for another action | `policy_evaluation_hash` — all of the above in one comparison, re-derived at consumption |

A progression step is bound as `personal:<case>:plan-step:<n>`, with the step's
own text inside the payload hash — so a re-planned step does not inherit an old
approval.

**The approval is CONSUMED, not peeked at.** A check that looked without spending
would let one approval authorise every later run, which is precisely his fourth
counter-example.

**The stricter rules survive it.** `APPROVAL_CANNOT_WAIVE` —
FINANCIAL_CONTRACTUAL, CREDENTIAL_SECURITY, DESTRUCTIVE, ACCESS_CONTROL — refuse
*before* consumption, so a payment attempt cannot silently burn a live approval.
`IRREVERSIBLE_EXTERNAL` is deliberately absent: "this reaches outside" is the one
class an explicit action approval exists for.

## The honest state

**Nothing currently issues such a ticket for a progression step.** An
`OWNER_DECISION` payload carries one field, the choice. `HUMAN_ACTION_APPROVAL`
is a built and tested path with no live producer, and in practice every high-risk
step stays gated after an answer. That follows from the owner's rule, he was told
before this was written, and building a producer is separate work not smuggled in
here.

## Contradiction: a health metric and an execution blocker

Per his instruction, P4 does **not** try to fix the 141-of-168 contradiction
population. Two things instead:

* `/api/cos/monitoring` now reports `contradictions: {active, contradicted,
  clean, share}` — latest packet per case only, so a settled old disagreement is
  history rather than a permanent emergency.
* A third Invariant E rule, `invariant_e_unresolved_contradiction`, refuses any
  non-READ_ONLY action while the contradiction stands. It runs **first**, before
  the confidence rules, so a HIGH/HIGH pair cannot walk past it. Read-only
  reasoning continues — his explicit carve-out.

## Pre-existing tests I edited, and why

Six assertions in `progression-owner-answer.test.ts` and one in
`progression-answer-semantics.test.ts` asserted `CONTINUE_AUTONOMOUSLY` after an
owner answer. Under the corrected policy the step still **advances** — which is
what those tests are about — but the EXECUTE step it advances to is gated. Each
now asserts `MANUAL_ACTION_REQUIRED` **and** `INVARIANT_E_REFUSAL`, so a
regression in answer *handling* still shows up as `REQUEST_DECISION` rather than
hiding behind the new expectation.

One of them was **not** re-pointed: the `REQUEST_APPROVAL via AWAITING_APPROVAL`
path still expects `CONTINUE_AUTONOMOUSLY`, because the step it advances to is
not outward-classed. It is the control proving the gate is not blanket — and I
had over-patched it on the first pass, which the suite caught.

## Evidence

592 test files, **8007 passed**, 4 skipped. Ten mutations driven red across the
two rounds; the one that SURVIVED (the redundant classifier branch) is documented
above and was removed rather than tested around.

One unrelated failure in a full-suite run:
`db-fresh-boot-single-writer > RED: with the lock disabled, the same race breaks
the boot again`. It is a probabilistic race *reproducer* — it asserts the race
still breaks an unlocked bootstrap — and it passes on its own and passed in the
full run six minutes earlier. It touches nothing this packet changed. Reported
rather than re-run until green.
