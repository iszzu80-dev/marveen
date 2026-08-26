# Phase 1 / P1 — Reconciliation: one case, one truth

```text
MIP-v1.0 §10.1/§10.2. Owner GO: 2026-08-26 18:33, with the acceptance list below.
Branch:  feat/p1-case-projection, fast-forwarded onto develop.
Runtime: STILL PINNED to 3d0cbcd1. See §7 — this is merged, not live.
```

---

## 0. The architecture, as the owner stated it

> the progression/state-machine state is the source of truth; the dashboard/case
> table is a projection. Do not build bidirectional field sync. If a
> user-authored change happens on the projection surface, ingest it as a
> command/event input, and let the canonical engine's decision project back.

Implemented literally. One direction, one writer per column, and a foreign write
becomes a `CASE_INPUT_OBSERVED` event rather than something the projection
erases.

---

## 1. THE PART THAT CHANGED THE DESIGN: three columns that were not twins

The audit that opened P1 named three board columns as the engine's unwritten
twins and proposed filling them. **All three were wrong**, each differently, and
each would have broken something live and quiet. This is the single most
important finding of the packet, because the naive P1 was already approved.

**`next_wake_at` (0/122) is not the board's copy of `next_progression_at`.**
It is an APPOINTMENT. `alertWokenCases` posts every due case to Istvan and then
CLEARS the column, by design ("a wake is an appointment, not a property: once
kept, it is over"). `next_progression_at` is a five-minute engine poll cadence
that is usually in the past. Copying one into the other would have alerted ~120
cases in a single sweep, cleared them, and re-armed them on the next — a
permanent alert loop, created by the reconciliation whose whole purpose was to
end drift. Worse: `next_wake_at` is part of `effectiveStateHash`, the §10.8
dedup key, so writing it would have made every case a NEW effective state and
put back the run storm the trigger contract exists to stop.

**`waiting_on` is not the board's copy of the engine's wait reason.**
`followup-autodraft.ts:179` regexes an EMAIL ADDRESS out of it and uses it as
the RECIPIENT of a drafted follow-up; intake writes `reply from <address>` there
for exactly that purpose. Overwriting it with the engine's free-text wait reason
disarms follow-up drafting silently, and a bad overwrite would address a draft
to the wrong party.

**`next_action` cannot carry the engine's next-best-action text.**
Two independent reasons. It is in `case-link`'s `TRUSTED_CASE_FIELDS` —
identifiers found there auto-link a stranger's incoming mail to a case,
precisely because the owner or the system wrote them. And the text the engine
would put there is exactly what `isUsableRecommendation` REFUSES to show the
owner: `nextBestAction.description` is copied verbatim from `buildRollingPlan`'s
closed set of internal English plan labels, and "Javaslatom: Execute first
recovery action" reached Istvan once already.

**Consequence for the design.** The projection gets its own engine-owned
`proj_*` columns, and **Invariant A is carried by the action KIND, not its
text**. Whether a next action EXISTS is a fact; the English label is a
rendering, and a rendering we are not allowed to show does not make the fact
absent. This changes what "Invariant A holds on the board" MEANS, which is why
it is stated here first rather than buried in a table.

---

## 2. What was built

| piece | where | one line |
|---|---|---|
| projection columns + `canonical_revision` + two triggers | `src/cos/schema.ts` (`initCaseProjectionSchema`) | additive; engine-owned columns only |
| the projection, the fence, drift, Invariant A | `src/cos/case-projection.ts` | new module |
| inline projection at the one choke point | `src/cos/progression-pipeline.ts` step 14 | inside the run's transaction |
| sweep = restart recovery | `reconcileProjections` | idempotent, fenced |
| cycle step | `scripts/cos-reconcile-projection.ts`, wired 2nd in `cos-cycle.ts` | right after `progression`, before every reader of the board |
| daily diagnostic | `projectionDrift` check in `src/cos/reconcile.ts` | four buckets, never one number |
| owner surface | `/api/cos/monitoring` → `projection` | numbers, not only alerts |
| backfill | `scripts/cos-projection-backfill.ts` | dry run by default |
| enrollment | `scripts/cos-enroll-case-progression.ts` | dry run by default |

**`canonical_revision` is a TRIGGER, not application code.** There are eleven
canonical writers across seven modules today, and the twelfth written next month
would silently not bump — which is the exact failure this column exists to
catch. A trigger is the table's choke point: it covers writers that do not exist
yet. It watches ONLY the fields the projection reads, so the revision means "the
projection's input changed", not "the row was touched". It uses `IS NOT` rather
than `!=` because half these columns are NULL most of the time and
`NULL != NULL` is NULL.

---

## 3. The owner's acceptance list, item by item

| # | condition | evidence |
|---|---|---|
| 1 | canonical source versioned | `canonical_revision`, trigger-maintained. Tests: every watched field bumps it; a no-op write does not; NULL transitions in both directions do; an unwatched field does not. |
| 2 | projection idempotent | Live: first apply projected 145, second projected **0**, unchanged 146. Test asserts every owned column and the fingerprint are byte-identical on the second pass. |
| 3 | stale write fenced | TWO fences, tested SEPARATELY — see §5. Pre-check refuses a projection stale as of its read; the statement's WHERE clause refuses one that lost the race after it. |
| 4 | drift detectable | `detectProjectionDrift`, five buckets. RED proof in the suite: with the revision trigger dropped, the same drift becomes invisible; restored, it is seen again. |
| 5 | `last_reconciled_at` | Column on both case tables; its ABSENCE is its own bucket (`neverReconciled`), because a row nothing ever projected looks identical to one that agrees. |
| 6 | conflict reason | `projection_conflict_reason` on the row, plus a `CASE_INPUT_OBSERVED` event carrying the observed values. Canonical wins — never silently. |
| 7 | backfill dry-run | Default mode. Test asserts a dry run leaves the row byte-identical, not even a `last_reconciled_at` stamp. |
| 8 | no side effects | Live, measured against a pre-P1 backup: case version sums 326/118 **unchanged** across 235 projections, `next_wake_at` fill 0 **unchanged**, and **zero** events written by the projection. (The event count moved 680 → 683: one PROGRESSION_ENABLED I wrote deliberately, and two the ENGINE wrote during the outlier's first run. Each one identified, none from the sweep.) |
| 9 | all active cases satisfy Invariant A | Live board, before: **0 of 146**. After: **146 of 146**, drift 0, both namespaces. |
| 10 | the 166/167 outlier identified and closed | §4. |

---

## 4. The outlier: PRI-TRIP-2026-001

**Identified.** The Spanish trip 2026-08-11 → 08-23. Status `EXECUTING`, created
2026-08-16, two events (CREATED, CALENDAR_EVENTS_LINKED) and nothing since.
`case_progression_state` row exists with `progression_enabled = 0`,
`progression_mode = 'off'`, **zero progression runs**. Every canonical field
NULL, which is why it and only it was the 1 in 166/167.

**Why it was invisible, which is the part worth keeping.** It is not unenrolled
(a state row exists). Nothing is behind (zero runs, so the revision never
moved). Nothing is in conflict (the projection of an all-NULL canonical row is
exact). Every counter read healthy while the engine had never once looked at the
case. So `progression_enabled = 0` on an ACTIVE case is now its own drift
bucket, carrying the run count so a case frozen after working is
distinguishable from one the engine was never switched on for. Measured on the
live store: **exactly one case matches**, so the new CRITICAL is precise rather
than noisy.

**Who disabled it is NOT established.** All four enrollment paths in `src/`
(`intake.ts`, `case-progression-seed.ts`, `progression-migrate.ts`,
`progression-eval.ts`) name `progression_enabled` and `progression_mode`
explicitly; this row carries the schema DEFAULTS, so whatever inserted it named
neither. That is evidence about the SHAPE of the writer, not its identity, and
it is recorded as unknown rather than inferred from absence.

**Closed** by enrolling it (`progression_enabled = 1`, mode `internal`, wake
now), with a `PROGRESSION_ENABLED` event recording the reason. The engine, not
this packet, decides what happens to the case. Rehearsed on a copy of the live
store first: one run, `CONTINUE_AUTONOMOUSLY`, **status untouched** (no
surprise auto-close), Invariant A violations 0, drift 0.

**Closed on live, and it worked.** The pinned engine picked the case up on its
next cycle and gave it its first-ever progression run. Invariant A on the board
is now **146 of 146** in both namespaces, drift 0, engine-off 0.

**One thing for Istvan, not for the engine:** the trip ended on 2026-08-23 and
the case is still `EXECUTING`. Whether it is finished is his call, not mine.

---

## 4b. The drift detector, proven on live data by accident

Between the first backfill and the second, one pinned CoS cycle ran. The pinned
release (`3d0cbcd1`) does not contain the projection, so it advanced the
canonical state of 90 cases and the board could not follow.

The detector reported exactly **90 BEHIND**, and the sweep closed all 90.

That is the packet's whole thesis demonstrated on the live store without being
staged: before P1 those 90 cases would have diverged in silence, because nothing
compared the two views and no row carried a timestamp saying when they last
agreed.

---

## 4c. A finding that is NOT closed: 0 of 76 next actions are readable

Measured after reconciliation, live:

```text
personal_cases.proj_next_action_kind IS NOT NULL   76 of 76
personal_cases.proj_next_action      IS NOT NULL    0 of 76
```

Every single next-action text the engine currently produces is an internal
English plan label that `isUsableRecommendation` forbids showing the owner. Not
most of them — all of them.

Two things follow. First, it retroactively settles §1: the naive P1 would have
written 76 rows of banned machine text onto Istvan's board, which is not a
judgement call but a measurement. Second, and this is the open part: **Invariant
A now holds as a FACT while the board still cannot show Istvan a sentence he can
read.** The kind and the review time are there; the words are not. Turning
`kind` into Hungarian is a rendering problem, it is small, and it belongs in
Phase 1 — I am recording it here rather than quietly satisfying the invariant
and calling the surface finished.

---

## 5. What the tests are worth, measured rather than asserted

Thirty-three tests, and then a **mutation harness**: ten deliberate defects
introduced one at a time into the committed code, each run against the suite.

The first pass killed eight of ten. **Both survivors were fence removals** — the
pre-check and the statement WHERE clause covered the same scenario in the only
test that exercised staleness, so deleting either one alone left the suite
green. That is a real gap in exactly the acceptance item the owner named
("stale write fenced"), and a green suite would have reported it as proven.

The write was extracted so the statement fence can be driven on its own, and the
pre-check now asserts its exact refusal sentence instead of accepting either.
**Second pass: ten of ten red**, each caught by a specific named test.

Full suite at develop head: **583 files, 7805 tests, 0 failures.**

---

## 6. The defect this packet produced, and how it was caught

The FIRST live dry run of this module printed `active 0, satisfied 0,
violations []` against a board holding 146 active cases, and I was one step from
reporting it as a clean result.

The script only called `initDatabase` when `--db` was passed, so the default
(live) invocation queried an undefined handle. Every query threw — and
`evaluateInvariantA`, `reconcileProjections` and `detectProjectionDrift` each
wrapped their query in a bare `catch` that returned zeros. **A broken instrument
reported perfect health**, which is precisely the failure class this packet
exists to end, produced by the packet's own code.

The catch now NAMES what it forgives (`no such table: <the case table>`, the one
condition it was written for) and rethrows anything else. Two tests hold the
line and both go red if the catch widens again. A check that cannot run must not
be able to pass.

---

## 7. What is NOT true yet

**This is merged, not live.** develop moved from `768bfa1a` to the P1 head; the
release guard still reports `3d0cbcd1` for both the release and the runtime SHA,
verified after the merge. That is the Phase 0 control working as designed, and
it means the running CoS cycle does NOT yet execute the reconcile step or the
inline projection.

What IS live: the schema (columns + triggers, additive) and the backfilled data,
applied deliberately to the live store with a pre-change backup taken first.

Going live needs a re-pin of the cycle release, the guard and the preflight,
which is a Phase 0 gated action and the owner's call.

---

## 8. Ordering, per the owner's 2026-08-26 instruction

> Investigate the reopen-path UNKNOWN after P1, before P2. If any
> declared-and-empty table could be a case/progression state or transition
> writer, bring its writer-discovery forward too. UNKNOWN may stay UNKNOWN until
> there is evidence; do not infer it from absence.

Next: P5's two questions, before P2.
