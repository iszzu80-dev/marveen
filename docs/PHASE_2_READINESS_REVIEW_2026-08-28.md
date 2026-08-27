# Phase 2 readiness review

```text
Written:        2026-08-28, immediately after Phase 1 = VERIFIED_DONE
Runtime:        62c3a39d
Verdict:        NOT READY to enter Phase 2 implementation.
                Four entry conditions are unmet, and one of them is structural.
```

The owner's instruction was explicit: produce this review before starting Phase
2, and do not start Phase 2 without it. This is that review, and it says no —
with reasons that are measurements rather than opinions.

---

## 1. What Phase 2 is

Per the implementation plan (`marveen-autonomous-case-progression-implementation-plan-v1.1.md`,
§29), the engineering checkpoints after full internal autonomy are:

```text
D — Full internal autonomy    wait/wake/completion/escalation with no side effect   ← Phase 1 reached this
E — External-action shadow    policy + Action Executor + readback dry-run
F — Canary readiness          only here may an external action be allowed
```

So Phase 2 is the move from *the engine reasons and asks* to *the engine acts
outward*, under approval. That is the boundary the whole Phase 1 packet set was
built to make survivable — and the Phase 1 evidence is precisely what says
whether it is time.

---

## 2. Where the system actually stands

Measured on the live store, 2026-08-28.

| fact | value | reading |
|---|---|---|
| progression mode | `internal` on all 177 enrolled cases | nothing is in external mode; the shadow rung has not been entered |
| autonomy ladder | `EXECUTE_WITH_APPROVAL` for ADMIN, QUOTE, HOME_REPAIR, TRAVEL; none paused | the rung that Phase 2 needs is already set, and unused |
| delegation envelopes | `pri-email-v1`, `zst-email-v1` defined in code, 0 revocations | standing delegation exists and has never been exercised |
| connectors | gmail + gmail-zst `READ_WRITE`/`OK`; rental, emag `READ_ONLY`/`OK` | the write path is technically open |
| outbound ledger | 3 VERIFIED + 1 PLANNED (personal), 1 VERIFIED (ZST) | five outbound rows in the system's whole history |
| the PLANNED row | composed **14 days ago**, never approved, never sent | the approval path has an untouched backlog of one |
| kill switch | never engaged | no incident has required it |
| Invariant A | 82/82 personal, 73/73 ZST | the state machine is sound |
| projection drift | 0 | the board and the engine agree |
| active null-stage | 0 | nothing the engine has no answer for |
| contradictions | **146 of 174 active cases (84%)** | see §3.1 |
| open owner questions | 6, ceiling 5 | see §3.2 |

Nothing in the machinery is broken. Every reason below is about whether turning
it outward would *mean* anything yet.

---

## 3. The four unmet entry conditions

### 3.1 84% of active cases carry contradictory evidence — BLOCKING

`contradictions: {active: 174, contradicted: 146, clean: 29, share: 0.84}`

Invariant E refuses any non-read-only action on a case whose evidence
contradicts itself. That rule is correct and it is doing its job. But it means
that if external actions were enabled today, **they would be refused on 84% of
the population**, and the 16% that got through would be the cases the reader and
the deterministic policy happened to agree about — a selection nobody designed.

This is not an argument for relaxing Invariant E. It is an argument that the
contradiction population must be *understood* before external action means
anything: is 84% a real disagreement rate, or is the comparison itself
mis-specified? Until that question has an answer, "external actions are enabled"
and "external actions are blocked" are the same system.

**Entry condition:** a measured explanation of the contradiction population, and
either a reduced share or a documented reason why the current share is correct.

### 3.2 The owner-facing question channel is full — BLOCKING

Six open questions against a ceiling of five. While it is full, **no new
question can go out about any case** — including an approval request, which is
the exact mechanism Phase 2 depends on.

An external-action phase is an approval-driven phase. Its throughput is the
question channel's throughput, and the question channel is currently at a
standstill with a fourteen-day-old composed message behind it. Enabling external
actions on top of a blocked approval channel would produce a queue, not
autonomy.

**Entry condition:** the open questions drained, and a considered answer to what
the ceiling should be when approvals compete with reader questions for the same
five slots.

### 3.3 The approval question is written in machine vocabulary — BLOCKING

The first live approval request, raised 44 minutes after the Phase 1 cutover,
asks the owner to approve:

```text
Művelet: Identify required actions and dependencies
```

That is an internal plan label — one of the closed set `isUsableRecommendation`
exists to keep off owner-facing surfaces, after such a string reached the owner
once already. The *binding* is correct: the action id, target, payload
fingerprint and risk class are all named and all enforced. The **sentence a
person reads** is not fit for a flow whose whole premise is that a human
understands what they are approving.

Approving an action you cannot read is not approval. This is a small fix and a
hard prerequisite.

**Entry condition:** the approval question passes the same usability rule the
reader questions already pass, proven by a test over the closed label set.

### 3.4 The unidentified flaky failure — CONDITIONAL

One of seven full-suite runs at the pinned SHA failed unidentified (see the
Phase 1 final proof report, §8). The owner ruled it a non-blocker for Phase 1
with a standing reopen condition, and that judgement was right: six subsequent
runs and both CI events were green, and no invariant or safety failure
reproduced.

It is listed here because Phase 2 changes the stakes. A flaky test in a phase
with no external side effects costs a rerun; the same flake in a phase that
sends mail means an unexplained red on the gate that stands between the engine
and the outside world.

**Entry condition:** either the flake is identified and classified, or a full
suite run at the Phase 2 candidate is clean across enough runs to say the
line is quiet — with the full output preserved either way.

---

## 4. What is genuinely ready

Stated as plainly as the blockers, because a review that only lists problems is
as useless as one that only lists successes.

- **The state machine.** Invariant A holds on all 155 active cases, drift is 0,
  and the projection repairs itself — proven by nulling a live value and
  watching the sweep fix exactly one case.
- **The refusal path has an exit.** High-risk steps no longer terminate; they
  raise a scoped, single-use, exactly-bound approval request. It has fired on a
  real case unprompted.
- **The plan cursor no longer walks through refusals.** The defect that let a
  case reach COMPLETE through a refusal is closed.
- **The send path survives a crash around the side effect.** No blind resend, an
  explicit unresolved state when the provider cannot be asked, and delivery only
  on a proven absence.
- **The audit trail is real.** Confidence and risk are persisted per run (they
  were not, before this release); the capability trail is written; every
  outbound row without a consumed ticket is either reported or explicitly,
  row-boundly excused.
- **Rollback is proven, not assumed.** Three generations of tagged, bundled,
  extraction-verified artefacts.

---

## 5. Recommended sequence

1. **Drain the question channel** and answer the fourteen-day-old composed
   outbound. This is the owner's, not the engine's, and it is the cheapest of
   the four.
2. **Fix the approval question wording.** Small, testable, and a prerequisite
   for anything approval-driven.
3. **Explain the contradiction population.** The largest piece of work and the
   one that decides whether Phase 2 is a real capability or a gate that refuses
   everything.
4. **Then, and only then, Checkpoint E** — external-action shadow: policy +
   executor + readback in dry-run, with the ledger and the readback proving
   themselves against real recipients before anything leaves.

Checkpoint F (canary) should not be scoped until E has produced evidence.

---

## 6. What this review deliberately does not do

It does not propose enabling anything. The plan's own rule is that a software
upgrade may never switch on external behaviour, and this document is a software
artefact. Every gate named above stays where it is until the owner moves it.
