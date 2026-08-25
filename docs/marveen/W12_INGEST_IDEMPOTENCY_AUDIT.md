# W12 — Ingest Idempotency, Transactions & Recovery: repo audit

```text
PACKET: MIP-v1.0 / §6 / W12_INGEST_IDEMPOTENCY
Audit date: 2026-08-25 (evening)
Status:     AUDIT + GAP MATRIX only — no implementation yet
Method:     read the shipped code and the shipped tests; one race reproduced by hand
```

The headline is the opposite of what a fresh packet usually looks like: **most of
W12 is already built, and built well.** The COS outbound path is the most mature
part of this codebase, and §6 describes it almost line for line. So this audit's
job is to say precisely which criteria are already *proven*, and which are
*assumed* — because a packet that rebuilds a working idempotency layer would be
worse than one that leaves it alone.

---

## 1. What already exists, measured

### 1.1 Canonical identity (§6.2)

| surface | key | enforcement |
|---|---|---|
| outbound | `internal_idempotency_key` | `UNIQUE` on `outbound_ledger` |
| outbound → provider | `external_idempotency_marker` | embedded in the message body (`COS-Ref:`) and searched on readback |
| ingest | `(gmail_account_id, message_id)` | `UNIQUE` on `email_processing` |
| ingest content | `content_hash` | resend / self-echo dedup |

### 1.2 Processing states (§6.3)

`outbound_ledger.status` CHECK: `PLANNED, SENDING, APPLIED_UNVERIFIED,
OUTCOME_UNKNOWN, VERIFIED, FAILED_RETRYABLE, FAILED_TERMINAL, CANCELLED,
RECOVERY_REQUIRED`.

`email_processing.status` CHECK: `DISCOVERED, CLAIMED, LOCAL_APPLIED,
SOURCE_COMMITTED, SOURCE_COMMIT_SKIPPED, RECOVERY_REQUIRED, EXCLUDED, DUPLICATE,
QUARANTINED`.

§6.3's real requirement — *"az outcome uncertainty first-class állapot legyen"* —
is met twice over: `OUTCOME_UNKNOWN` **and** `APPLIED_UNVERIFIED` are distinct,
because "we do not know" and "it landed but we could not confirm it" are
different facts with different safe actions.

`SOURCE_COMMIT_SKIPPED` deserves a line of its own: it exists because the code
used to write `SOURCE_COMMITTED` — the terminal SUCCESS state — for messages it
had *not* marked at the source, and put the truth in `last_error`. A state name
that says the opposite of what happened poisons every later query.

### 1.3 Ambiguous outcome protocol (§6.5) — proven, not asserted

`src/__tests__/cos-executor.test.ts` already contains the exact sequence §6.5
prescribes, as named tests:

- provider received it but we errored → recovery **VERIFIES without a second send**
- crash after `SENDING` was persisted → recover, **no double-send**
- a freshly-`SENDING` row is **not** recovered — an in-flight send is not an abandoned one
- unknown outcome → `OUTCOME_UNKNOWN` → recovery → safe resend
- provider accepted but readback **unavailable** → `APPLIED_UNVERIFIED`, never resent
- a **thrown** readback is treated as unavailable, not absent (no resend)
- confirmed absence → `RECOVERY_REQUIRED`; a marker arriving in the grace window verifies instead of alarming

### 1.4 Cursor rule (§6.6) — implemented and tested

`src/cos/email-ingest.ts`: the account's history cursor advances **only** when a
whole batch is terminal. Tested in `cos-email-ingest.test.ts`: does not advance
while any message is non-terminal; advances on mixed terminal states; a poison
message quarantined lets the batch terminalise; an out-of-order close does not
pull the cursor **backwards**; history ids compare **numerically**, not as text.

This is also visible in production every ten minutes: the cycle reports
`batches: 4, closed: 0, reasons: ["a köteg nem minden eleme terminális"]`.

---

## 2. Gap matrix

| §6 requirement | Verdict | Evidence / what is missing |
|---|---|---|
| 6.2 canonical dedupe key | **MET** | UNIQUE on both surfaces |
| 6.3 processing states incl. uncertainty | **MET** | two distinct uncertainty states |
| 6.4 business-level exactly-once (outbound) | **MET** | "send called exactly once"; duplicate plan trips UNIQUE |
| 6.5 ambiguous outcome protocol | **MET** | seven named tests, listed above |
| 6.6 cursor rule | **MET** | five named tests + live evidence |
| 6.7 recovery **queue** | **GAP** | see 2.1 |
| 6.8 fault injection: duplicate input | MET | |
| 6.8 crash during processing | MET | |
| 6.8 side effect success + response timeout | MET | |
| 6.8 side effect failure | MET | |
| 6.8 readback timeout | MET | |
| 6.8 restart with pending state | MET | recovery tests |
| 6.8 **DB/state write failure** | **GAP** | no test injects a failing state write |
| 6.8 **cursor write failure** | **GAP** | the cursor is tested for *rules*, never for a failing write |
| 6.8 **two workers, same input** | **PARTIAL** | see 2.2 |
| 6.9 concurrent claim safe | **PARTIAL** | outbound yes; ingest rests on a constraint, not on the check |

### 2.1 The recovery queue is a status, not a queue (§6.7)

§6.7 asks for a durable queue carrying: exact pending action, input reference,
idempotency key, last known outcome, **retry policy**, **max attempts**, **human
escalation threshold**.

What exists: `RECOVERY_REQUIRED` as a *status* on both tables, `attempt`
counters, `last_error`, and one narrow max-attempts constant
(`THREAD_FETCH_MAX_ATTEMPTS`, for Gmail thread fetches only).

What does not exist: a retry policy and an escalation threshold as data. And the
escalation machinery that does exist — `src/cos/progression-escalation.ts` — is
**SHADOW-ONLY by its own header: escalations are logged, never delivered to the
owner.** So the "human escalation threshold" §6.7 asks for currently terminates
in a table nobody is paged from.

### 2.2 Ingest claim: safe by constraint, not by check

`ingestTriagedEmail` is read-then-write:

```ts
const existing = db.prepare('SELECT status FROM email_processing WHERE ...').get(...)
if (existing) return { outcome: 'ALREADY_PROCESSED', ... }
// ... then open the batch, claim, apply
```

and `claimMessage` is an **unconditional** `UPDATE ... SET status='CLAIMED'` with
no compare-and-swap on the previous status. The outbound path, by contrast, has a
real fenced claim (`acquireClaim` + `claim_fence` + optimistic `WHERE version =`).

**I tried to reproduce a duplicate and could not**, and the honest report is that
result rather than the suspicion that prompted it. Staging both workers' reads
before either write does not produce one, because the function performs its own
read internally and, in a single synchronous process, the second call always sees
the first one's committed row:

```text
A saw: undefined | B saw: undefined
worker A: CASE_CREATED
worker B: ALREADY_PROCESSED
email_processing rows: 1 | personal_cases created: 1
```

So the finding is narrower than "duplicate ingest is possible", and is stated at
its real size: **the safety rests on `UNIQUE(gmail_account_id, message_id)`, not
on the status check.** Under genuine cross-process concurrency (the ten-minute
cycle plus a hand-run script — which happens on this machine) the loser of the
race gets a constraint *exception* rather than a clean `ALREADY_PROCESSED`. That
is safe for the data and untidy for the caller, and it is untested either way.

Settling it needs a **cross-process** test, not an in-process one. That is the
first implementation item.

---

## 3. Plan (implementation, next session)

1. **Cross-process claim test** for ingest — two real processes against one
   store file, asserting exactly one case and no lost message. Settles 2.2 with
   evidence instead of argument.
2. **Compare-and-swap claim** for ingest (`WHERE status = 'DISCOVERED'`), so the
   check does the work the constraint is currently doing by accident.
3. **Recovery queue** (§6.7): retry policy + max attempts + escalation threshold
   as data, over the existing `RECOVERY_REQUIRED` rows rather than a new table.
   Escalation delivery stays out of scope — it is deliberately shadow-only and
   turning it on is an owner decision, not an implementer's.
4. **Three missing fault injections**: state write failure, cursor write failure,
   two workers same input.

No code was written for W12 in this session. The audit is the deliverable.
