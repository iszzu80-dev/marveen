# W12 — Ingest Idempotency, Transactions & Recovery: done report

```text
PACKET: MIP-v1.0 / §6 / W12_INGEST_IDEMPOTENCY
Audit:  docs/marveen/W12_INGEST_IDEMPOTENCY_AUDIT.md (2026-08-25, evening)
Build:  2026-08-25, night
Owner decision that shaped this packet: Istvan, Telegram, 2026-08-25 23:17
```

## 0. What the owner decided, and what it changed

The audit ended with a four-item plan and one open question: whether §6.7's
recovery queue should be a derived view over `RECOVERY_REQUIRED` rows or durable
state of its own. Istvan settled it before the build started, and the decision
made the packet bigger than the audit's plan:

- retry policy, `attempt_count`, `next_attempt_at`, `last_error`, `retry_class`,
  `max_attempts` / `escalate_after` are **explicit data**, never hidden hardcoded
  behaviour;
- on reaching the threshold the record moves to a **NEEDS_HUMAN** state;
- the **existing** internal UI/brief surfaces it;
- W12 opens **no new automatic email/push/outbound notification channel**;
- the cross-process claim must have exactly one atomic winner, the loser must get
  a clean `ALREADY_CLAIMED`/`ALREADY_PROCESSED` rather than a generic DB
  exception, the UNIQUE constraint stays as the last-resort data integrity net,
  and a **real multi-process race test** must prove it;
- all three missing fault injections are mandatory.

The last constraint is the one worth calling out as *implemented rather than
promised*: the recovery step's scheduled-task grant is `READ + WRITE_LOCAL` with
**no `EXTERNAL_EFFECT`**. A later edit that tries to notify from that step fails
at the capability boundary instead of succeeding quietly.

## 1. Cross-process ingest claim (§6.9)

**The defect, at its real size.** `ingestTriagedEmail` read
`email_processing` and then wrote, with nothing holding the two together. In one
process that is safe by accident — the function performs its own read, so the
second call always sees the first one's committed row. Across processes (the
ten-minute cycle plus a hand-run script, which happens on this machine) both
readers could see nothing and both proceed.

**The fix.** The idempotency read and every write it authorises are now one
`IMMEDIATE` transaction. Deferred would not do: a deferred transaction takes its
write lock at the first write, which is *after* the read, leaving exactly the
window it is meant to close. The corporate path (`ingestTriagedZstEmail`) got the
same change in the same commit rather than "later, on a separate code path" —
that gap is how the personal namespace ended up protected alone twice before.

**The claim is now a compare-and-swap** on `DISCOVERED`, and a lost swap raises a
typed `MessageStatusConflictError` naming expected and actual status. Zero rows
changed has two causes — a missing row (a caller bug) and a mismatched row (a
concurrency outcome) — and they used to be one message that named the wrong one.

**The evidence.** `src/__tests__/cos-w12-ingest-cross-process.test.ts`: two real
`tsx` processes against one store file, meeting at a **file rendezvous** (not a
wall clock), walking the same forty keys in the same order. Asserted: no error
from either process, exactly one `CASE_CREATED` and one `ALREADY_PROCESSED` per
message, exactly one row / case / batch per message, no row stranded in
`CLAIMED`, and — separately — that the two processes really overlapped.

**Mutation check (this is the part that changed the test).** The first version
raced a SINGLE message and **passed against the pre-fix code**: the processes
overlapped in wall-clock time but did not happen to interleave in the unprotected
window. A concurrency test that cannot go red on the defect it names is
decoration. With forty keys the pre-fix shape fails deterministically — two
consecutive runs, both processes:

```text
SqliteError: UNIQUE constraint failed: cos_triage_provenance.receipt_id
```

The audit predicted the collision would land on
`email_processing_batches.batch_id`. It lands one step earlier, on the triage
receipt, because the receipt is written before the batch is opened. Same defect,
different first casualty — recorded as measured, not as predicted.

## 2. A startup defect found by trying to test concurrency

The two-process test could not run at first. Both workers died at boot:

```text
SqliteError: database is locked
  at initDatabase (src/db.ts:75)   // PRAGMA journal_mode = WAL
```

`PRAGMA journal_mode = WAL` needs brief exclusive access and, unlike ordinary
statements, does **not** wait on the connection's busy timeout — it returns
`SQLITE_BUSY` at once. Two processes opening a store not yet in WAL (a fresh
database, or one whose schema another process is still creating) left the loser
dead before a line of its own work ran.

Narrow in production — once a store is in WAL the pragma is a no-op — but it made
§6.8's "two workers, same input" criterion impossible to even *ask*. `db.ts` now
retries the mode change under a bounded synchronous spin and re-throws if it
cannot get it: a store stuck in a mode we cannot change is a startup failure, not
something to continue past quietly.

## 2b. A second startup defect, and one behaviour the CAS exposed

**`ensureColumns` is check-then-act.** `PRAGMA table_info` then `ALTER TABLE ADD
COLUMN`: two boots against the same fresh store both see the column missing, both
alter, and the loser dies with `duplicate column name: channel`. It now treats
that specific error as its own post-condition already being true — and re-throws
everything else, because a failed ALTER that is not this is a schema problem and
must not be swallowed.

**The intake had a re-entry it never noticed.** Making the claim a
compare-and-swap turned up a pre-existing behaviour: calling `ingestEmail` twice
for the SAME message used to re-claim unconditionally and walk the whole flow
again, overwriting a `LOCAL_APPLIED` row's status with `DUPLICATE` on the way.
The bridge's pre-read hides this in production, so it was never a live defect —
but "safe because the only caller happens to check first" is the shape of the
cross-process bug this packet is about, one layer up. `ingestEmail` now reports a
seen message instead of reprocessing it (`LINKED_DUPLICATE` with the linked case,
or the newly added `ALREADY_PROCESSED` when there is none) and writes nothing.

## 3. The recovery queue (§6.7)

Two tables, and the split is the design:

| table | holds |
|---|---|
| `cos_retry_policy` | the policy **as data**, one row per retry class: `max_attempts`, `base_backoff_sec`, `escalate_after_attempts`, description |
| `cos_recovery_queue` | one durable row per `(surface, ref)`: pending action, input ref, idempotency key, last known outcome, retry class, attempt count, the ceilings **materialised onto the row**, `next_attempt_at`, `last_error`, status, escalation reason |

**Why the queue has its own status instead of widening the source enums.** Adding
`NEEDS_HUMAN` to `email_processing.status` and `outbound_ledger.status` would have
changed the meaning of every consumer of those enums at once — the scheduler's
work query, the approval LIVE filter, the terminal-status sets that decide
whether the **cursor** may move. And the two facts are orthogonal: "what state is
the work in" and "has recovery given up on it" are different questions. Collapsing
them is the mistake `SOURCE_COMMIT_SKIPPED` exists to remember.

Seeded classes:

| class | max | backoff | escalate after | why |
|---|---|---|---|---|
| `INGEST_LOCAL_APPLY` | 5 | 60s | 3 | local state only; no provider is touched |
| `OUTBOUND_READBACK` | 0 | 0 | 0 | provider claimed success, marker provably absent: a retry **is** a second send, so it is NEEDS_HUMAN from the first breath |
| `OUTBOUND_SEND` | 5 | 30s | 5 | mirrors executor-core's F-15 constants deliberately (see §6 below) |

`seedRetryPolicies` is `INSERT OR IGNORE`, never `UPDATE`: an operator's edit to
`max_attempts` survives the next boot, or the table is decoration and the constant
is still the policy. A test asserts exactly that.

### 3.1 The gap the audit did not see

An `email_processing` row in `RECOVERY_REQUIRED` is **non-terminal**, so under
P0.2 it pins the account's history cursor — and **nothing in the codebase read
those rows**: no retry, no listing, no alert, no test. One parked message would
have stopped inbound mail from advancing, and the only visible symptom would have
been the cycle reporting "batch not terminal", which the healthy case reports too.

`reconcileRecoveryQueue` (cycle step `scripts/cos-recovery-queue.ts`, wired into
`cos-cycle.ts`) is that missing reader.

### 3.2 Surface

`/api/cos/monitoring` carries `recovery.needsHuman` / `recovery.pendingRetry` /
counts, and COS Control renders a "Helyreállítási sor (§6.7)" block with the
policy numbers (`3/5`, threshold), not just a flag. **The zero case speaks**: an
empty queue is written out, because a block that vanishes when the queue is empty
cannot be told apart from one whose data stopped arriving — and noticing that
something stopped is this queue's whole job.

**The endpoint does not reconcile.** A GET that silently rebuilt the queue would
make the UI its own source of truth: the page would always agree with itself,
whether or not the step that maintains it ever ran. A queue that is stale because
the cycle stopped is a fact worth being able to see. Tested.

## 4. The three fault injections (§6.8)

Injected with SQLite **triggers**, not stubs: a stub proves what the code does
when a mock throws; a trigger makes the real statement fail inside the real
transaction, which is the thing being asked about.

| fault | asserted |
|---|---|
| **state write failure** | no case, no processing row, no batch, no triage receipt — and the same message then ingests cleanly, exactly once |
| **cursor write failure** (INSERT path) | cursor unmoved **and the batch not closed either**; a retry after the fault clears advances exactly once |
| **cursor write failure** (UPDATE path) | the second advance is the dangerous one: a test that only injects on INSERT stops testing anything after the first batch |
| **two workers, same input** | §1 above |

The state-write mutation check is the one that shows the stakes. Without the
transaction, the failed attempt leaves the message id taken, so the retry answers
`ALREADY_PROCESSED` — the mail is lost behind a success-shaped answer:

```text
× leaves NO partial state            → expected 1 to be +0
× the SAME message ingests cleanly   → expected 'ALREADY_PROCESSED' to be 'CASE_CREATED'
```

## 5. Istvan's VERIFIED_DONE criteria, each with its evidence

| criterion | evidence |
|---|---|
| no duplicate side effect under crash/retry/timeout/race | cross-process test (40 keys, 2 processes); state-write fault injection; existing `cos-executor.test.ts` §6.5 set |
| `OUTCOME_UNKNOWN` retry ≠ resend | queue test: `OUTCOME_UNKNOWN` → `VERIFY_READBACK`, never a resend; `RECOVERY_REQUIRED` → `OUTBOUND_READBACK`, `max_attempts = 0`, NEEDS_HUMAN immediately, never in `listDueForRetry` |
| cursor moves only after a proven terminal state | existing five cursor-rule tests + both cursor-write fault injections (close and cursor write roll back together) |
| recovery deterministic | reconcile is idempotent and never resets the attempt count; backoff is computed from the policy row; thresholds decided on the same write as the counter |
| retry exhaustion → explicit human escalation state | `NEEDS_HUMAN` with `escalated_at`, `escalation_reason`, `next_attempt_at = NULL`, and an escalated record is never touched by the loop again (tested) |
| no W12 regression | full suite, §7 |

## 6. Named, deliberate gaps

1. ~~**Two definitions of the outbound send ceiling.**~~ **CLOSED — see §9.**
   This was filed as a deliberate gap and Istvan refused that closure the same
   night, correctly: a duplicated policy source-of-truth is not a smaller
   version of the defect this packet is about, it is the same one.
2. **The queue schedules retries; it does not execute them.** `listDueForRetry`
   returns due rows and nothing consumes it yet — the ingest re-apply path is
   W13-adjacent work. What exists today is the durable state, the thresholds, the
   escalation and the surface. Stated here rather than left for a reader to
   discover that the "retry policy" retries nothing on its own.
3. **`progression-escalation.ts` stays shadow-only.** Untouched by W12, by the
   owner's standing decision.
4. **Concurrent FIRST boot of a fresh store is still not safe.** Two processes
   bootstrapping the same brand-new store produced three distinct startup errors
   before either did any work: `database is locked` at the WAL pragma,
   `duplicate column name: channel` / `dispatch_id` from check-then-act column
   adds, and `no such table: main.memories` from an index created against a table
   the other process had not made yet. The first two are fixed (§2, §2b); the
   third and whatever else the ~2000-line bootstrap hides are NOT. Hardening the
   whole bootstrap is not W12's subject and would be a large change to shared
   startup code made at night, so the cross-process test serialises the boot in
   its parent and this stays a named gap. It affects a fresh store only: an
   existing store re-boots without altering anything. **A flaky test proves
   nothing on the run where it is green**, which is why this is written down
   rather than retried until it passed.

## 7. Test results

```text
vitest run (full suite, 2026-08-25 23:31)
Test Files  568 passed (568)
Tests       7611 passed | 4 skipped (7615)
exit 0
```

The run before the last two fixes had three failures, and all three are recorded
here rather than smoothed over:

1. `progression-checkpoint-a-regression.test.ts` — a REAL regression caused by
   the CAS claim, fixed by the intake re-entry check (§2b). It is the reason that
   check exists: the guard found a caller the audit had not looked at.
2. `cos-w12-ingest-cross-process.test.ts` — my own new test, flaky under
   full-suite CPU contention because both workers were bootstrapping a fresh
   store at once (§6.4). Fixed by serialising the boot in the parent, then run
   five times green and three times red against the pre-fix code.
3. `memory-performance.test.ts` — a 5-second timeout waiting for Ollama under
   load. Unrelated to W12, passes on its own and in the clean run above. Named,
   not claimed as mine and not claimed as fine.

Files added:

- `src/__tests__/cos-w12-ingest-cross-process.test.ts` (1 test, two processes)
- `src/__tests__/helpers/ingest-race-worker.ts` (child half, not collected)
- `src/__tests__/cos-w12-recovery-queue.test.ts` (11 tests)
- `src/__tests__/cos-w12-recovery-surface.test.ts` (4 tests, incl. jsdom render)
- `src/__tests__/cos-w12-fault-injection.test.ts` (8 tests)

Files changed: `src/cos/email-ingest.ts`, `src/cos/triage-bridge.ts`,
`src/cos/zst-intake.ts`, `src/cos/recovery-queue.ts` (new), `src/cos/schema.ts`,
`src/db.ts`, `src/web/routes/cos.ts`, `web/coscontrol.js`,
`src/identity/scheduled-task-identity.ts`, `scripts/cos-recovery-queue.ts` (new),
`scripts/cos-cycle.ts`.


## 9. Closure of gap 1 — one source of truth for the send ceiling

**Istvan's ruling (2026-08-25, Telegram):** W12 stays PARTIAL until the
duplicated send-ceiling policy source-of-truth closure is proven; do not mark it
DONE without that evidence.

**What changed.** `DEFAULT_MAX_SEND_ATTEMPTS` and `DEFAULT_SEND_BACKOFF_SEC` now
live in `recovery-queue.ts` — where policy lives — and `executor-core.ts`
re-exports them so existing importers are unaffected. `DEFAULT_RETRY_POLICIES`
seeds the `OUTBOUND_SEND` row FROM those constants by reference, and
`executeAction` reads the row (`getRetryPolicy(db, 'OUTBOUND_SEND')`) where it
applies the ceiling and the backoff. The dependency points one way: the executor
reads policy, policy never reads the executor.

An explicit `opts.retry` still wins. That is a caller stating a narrower budget
for one send, not a second definition of the default — and it has its own test
saying so.

**Evidence** (`src/__tests__/w12-send-ceiling-single-source.test.ts`, 6 tests):

| test | proves |
|---|---|
| lowering the row to 2 gives up on an attempt-2 row | the row decides; with the old constant this row had three attempts left and would have been re-sent |
| raising it to 9 keeps an attempt-6 row alive | both directions, not just the convenient one |
| a 3600s backoff on the row holds the send back one minute after the last attempt | the backoff comes from the row too |
| an explicit per-call `retry` still wins | the narrower ask is not a second default |
| STANDING CHECK: the seeded row equals the constants | seed and fallback cannot drift |
| STANDING CHECK: `executor-core` declares no numeric ceiling of its own | guards against a literal fallback being reintroduced next to the policy read, which would pass every behavioural test above |

**Mutation check:** with the executor reading the constants again instead of the
row, the first three go red; the standing checks stay green, which is exactly
why both kinds are here.

The fallback that remains in `sendRetryPolicy` is not a second definition: the
seed IS those constants, so the two paths cannot disagree on a value. It covers
a store whose policy table was never created, where refusing to send at all
would be the larger failure.