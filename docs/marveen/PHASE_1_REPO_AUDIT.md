# Phase 1 — repo audit and gap matrix

```text
MIP-v1.0 §10, Reliable Case Autonomy.
Written: 2026-08-26, after the Phase 0 cutover and GO.
Author:  Marveen
Method:  the LIVE store first, the code second. Every "exists" below is a row
         count or a measured fill rate, not a file that compiles.
```

---

## 0. The headline, before the tables

**Phase 1's engine is largely built and running.** Not planned, not merged —
running, on the store, tonight:

```text
case_progression_state    167 rows   every active case in both domains
case_progression_runs   17 343 runs  with a real decision distribution
cos_owner_questions        49 rows   the Writer reaches Istvan
```

Coverage is total, not partial:

| domain | active cases | with progression state | progression_enabled |
|---|---|---|---|
| personal | 77 | **77** | 76 |
| ZST | 70 | **70** | 70 |

So the Phase 1 question is not *"can we build this"*. It is the one the owner
actually asked: **is it ONE coherent state machine, or two systems that happen to
share a case id?**

The audit's answer is the second, and §3 is the evidence.

---

## 1. §10.1 Canonical Case — where the fields actually live

The canonical fields are **not** in `personal_cases` / `zst_cases`. They are in
`case_progression_state`, and that is why a naive column check on the case table
reports a catastrophe that is not real.

| §10.1 field | lives in | fill |
|---|---|---|
| case_id | both tables | 100% |
| domain / type | `case_type`, `category`, `domain` | 100% |
| **case_goal** | `case_progression_state.goal` | **166/167** |
| status | `cases.status` | 100% |
| progress_stage | — *conflated with `status`* | **GAP** |
| priority / attention | `cases.priority` | 100% |
| ball_holder | `next_action_owner`, `waiting_on` | partial (47/122 personal) |
| next_action | `next_best_action_json` (engine) + `cases.next_action` (board) | 166/167 vs 50/122 |
| next_action_type | inside `next_best_action_json` | not a first-class field |
| deadline | `cases.due_at` | 18/122 personal |
| wait_condition | `waiting_on` (free text), `wait_system_json` | see §3.1 |
| next_review_at | `next_progression_at` (engine) / `next_wake_at` (board) | **166/167 vs 0/122** |
| **completion_criteria** | `definition_of_done_json` | **166/167** |
| **evidence requirements** | `success_evidence_requirements_json` | **166/167** |
| confidence | — | **GAP** |
| risk | ZST: `financial_exposure`, `legal_exposure`; personal: — | **GAP (personal)** |
| approval_gate | ZST: `approval_required`; personal: — | **GAP (personal)** |
| source_links | `source_references`, `*_ids` columns | 100% |
| last_event | `last_event_id` (board) / `last_event_seen` (engine) | 17/122 vs engine-side |
| last_reconciled_at | — | **GAP** |

**Verdict:** the model is ~75% present and populated. What is missing is not
storage — it is `confidence`, `risk` on the personal side, an explicit
`progress_stage`, and `last_reconciled_at`.

---

## 2. §10.4 / §10.8 — what the engine actually decides

17 343 runs, and the distribution is the proof that this is a real decision
engine and not a scheduler that logs:

| decision | runs |
|---|---|
| CONTINUE_AUTONOMOUSLY | 10 825 |
| WAIT_EXTERNAL | 4 457 |
| REQUEST_DECISION | 1 296 |
| RECOVERY_REQUIRED | 462 |
| ASK_INFORMATION | 219 |
| COMPLETE | 83 |
| **WAIT_TIME** | **1** |

| trigger | runs |
|---|---|
| SCHEDULED | 16 563 |
| NEW_RELEVANT_EVENT | 315 |
| FOLLOW_UP_DUE | 287 |
| INTAKE | 166 |
| MANUAL | 12 |

Test coverage is substantial and specific — 25 files across
progression / wake / completion / questions, including `cos-progression-trigger`'s
"an unchanged case does NOT reason again" and "a WAITING case still wakes on its
deadline, though nothing changed", and `progression-checkpoint-e4`'s DoD
verification.

---

## 3. The gap matrix

Ordered by what it would cost to be wrong, not by effort.

### 3.1 `wait_system_json` — 0 of 167. A wake system with no writer.

```sql
SELECT count(*) FROM case_progression_state WHERE wait_system_json IS NOT NULL;
-- 0
```

Every neighbouring column in the same table is 166/167. This one is declared and
never written, and it sits **exactly on §10.4, the Waiting/Wake Engine** — the
structured wait condition (event / evidence / date / deadline / commitment /
external response / policy) that §10.4 enumerates.

Corroborating: `WAIT_TIME` appears **once** in 17 343 runs while `WAIT_EXTERNAL`
appears 4 457 times. Waiting is happening; *typed* waiting is not.

This is this codebase's signature defect, third instance in three weeks, and the
first one found before it cost anything.

### 3.2 Two representations, and the owner reads the weaker one

Invariant A (§10.2) — every active case has `next_action` **or**
`wait_condition + next_review_at` — measured on the **case board**:

| domain | active | satisfy | **violate** |
|---|---|---|---|
| personal | 77 | 46 | **31** |
| ZST | 70 | 11 | **59** |

Measured on the **engine**: `next_best_action_json` is 166/167.

The invariant holds where the engine looks and fails where Istvan looks. The
board is not wrong about a case; it is *silent* about it. Nothing reconciles the
two, and there is no `last_reconciled_at` to notice.

**This is the central Phase 1 gap.** Not a missing capability — a missing
identity between two views of the same case.

### 3.3 `next_wake_at` — 0 of 122, beside a populated twin

`personal_cases.next_wake_at`: 0/122. `case_progression_state.next_progression_at`:
166/167. Two columns for one concept; the board's copy has no writer.

### 3.4 Status vocabulary vs §10.3 progress stages

§10.3 asks for `ACTIONABLE / WAITING / NEEDS_USER / COMPLETED` (+`MONITORING`)
and warns explicitly against status explosion. Live: **10 personal statuses and
9 ZST statuses**, with no `progress_stage` column and no declared mapping.

`INFO_REQUIRED` vs ZST's `INFORMATION_REQUIRED` is the same stage under two
spellings — which is what a missing canonical stage looks like from the outside.

### 3.5 Invariant E has no inputs on the personal side

> Low-confidence high-risk action nem hajtható végre automatikusan.

There is no `confidence` and no `risk` on personal cases. ZST has
`financial_exposure` / `legal_exposure` / `approval_required`. So Invariant E is
today enforced by the approval bind and the send ceilings — real protections, but
**not the invariant as written**, and not measurable.

### 3.6 Declared-and-empty tables (candidates, not verdicts)

`cos_channel_outbox` 0, `cos_autonomy_global` 0, `cos_kill_switch_events` 0,
`cos_thread_fetch_failures` 0. Some of these are legitimately empty (nothing has
gone wrong yet); each needs the same one question asked separately: *is there a
writer at all?* Answering it is a Phase 1 packet, not an assumption here.

### 3.7 §10.7 Reopen — mechanism not located

`reopen` appears in test files, but no `reopen` path in the progression modules
was identified in this audit. Recorded as **UNKNOWN, to be established**, not as
absent — the difference matters, and today's TEST_ORACLE_DEFECT is why I am
writing it this way.

---

## 4. What must NOT be rebuilt

Explicitly, so no packet wastes itself:

* the progression pipeline, resolver, interpreter and scheduler (Checkpoints B–E5)
* DoD-based semantic completion and its guard (`guardCaseCompletion`)
* the owner-question Writer, its no-re-ask and supersede rules
* the deadline index (§10.1–10.3 ontology, already unified)
* claim/lease concurrency on progression
* the recovery queue and retry policy
* the trigger contract ("an unchanged case does not reason again")

---

## 5. The ten §10.8 acceptance scenarios — current standing

| # | scenario | standing |
|---|---|---|
| 1 | actionable case advances | **covered** — `progression-stagnation-detector`, live CONTINUE_AUTONOMOUSLY 10 825 |
| 2 | waiting case wakes on event | **partial** — NEW_RELEVANT_EVENT 315 live; typed wait conditions absent (§3.1) |
| 3 | waiting case wakes on review date | **covered** — `cos-progression-trigger`, `next_progression_at` 166/167 |
| 4 | overdue promise generates follow-up | **partial** — FOLLOW_UP_DUE 287 live; no commitment model yet (that is §11, Phase 2) |
| 5 | one consolidated question | **covered** — Writer live, 49 questions, no-re-ask + supersede tested |
| 6 | high-risk low-confidence → no side effect | **GAP** — enforced by approval bind, not by the invariant (§3.5) |
| 7 | completion only after evidence | **covered** — DoD verification 166/167, `guardCaseCompletion` |
| 8 | contradictory evidence → reopen | **UNKNOWN** (§3.7) |
| 9 | duplicate event → no duplicate progression | **covered** — W12 idempotency + trigger contract |
| 10 | state consistent after restart | **partial** — claim/lease tested; no end-to-end restart proof |

**Four covered, four partial, one gap, one unknown.**

---

## 6. What this audit does not claim

It does not claim the engine is correct — it claims it exists, runs, and decides,
with the numbers above. Correctness per scenario is what Phase 1's packets must
prove.

It does not claim §3.6's empty tables are defects. It claims nobody has asked.

And it does not claim §3.7 is missing. It says I did not find it, which is a
statement about my search and not about the code.
