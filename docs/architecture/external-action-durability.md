# External action durability

**Version 1.0 — 2026-09-06. Status: DESIGN + SURVEY. Nothing in here is deployed.**

Owner spec: Istvan, 2026-09-06 (Telegram 10105/10107). This document is the
written form of that spec plus the producer survey he asked for. It is versioned
because the correction it records — that a pre-call record does *not* buy
exactly-once — is the kind of thing a later reader will otherwise re-invent
wrongly.

---

## 0. The one correction that governs everything below

> A pre-call attempt record is **NECESSARY** but does **NOT** make the external
> operation exactly-once.

There is no atomic commit between our SQLite database and a provider's servers.
Whatever we write locally, the window between "we decided to call" and "we know
what the call did" cannot be closed, only *narrowed and made honest*. What the
ledger buys is **attributability and honest recovery**: after a crash we can say
which operations were in flight, and for each one either prove the outcome or
declare that we do not know it.

Anything in this design that reads as "and then it is exactly-once" is wrong and
should be deleted rather than believed.

---

## 1. Where the gap is

`src/identity/action-broker.ts`, `brokerExternalAction`. Read the body: in
**every** branch the audit row is written *after* the call.

- denied → `finish(... outcome 'DENIED')`, before any call. Fine.
- `await execute()` throws → `finish(... outcome 'FAILED')`.
- `await execute()` returns → optional readback → `finish(... outcome 'EXECUTED')`.

There is no record written *before* `await execute()`. So a process death inside
that await leaves **no durable trace that the attempt ever happened**. The audit
log will look exactly like a run that never reached the broker at all.

This matters more than it would at any single call site, because the broker is
the declared choke point for every external mutating action (Istvan's HYBRID
EXTERNAL ACTION BOUNDARY, 2026-08-25). One missing pre-call write is missing at
every site that uses it.

### 1.1 The pattern already exists — at one producer

`src/cos/executor-core.ts` already implements almost exactly what is proposed
here, and has since E1 (2026-08-13):

- `SENDING` is written **before** `await adapter.send(...)`, deliberately and
  with a comment saying so (see `SENDING_RECOVERY_GRACE_SEC`).
- Statuses `PLANNED | SENDING | APPLIED_UNVERIFIED | OUTCOME_UNKNOWN | …`.
- `NON_RESENDABLE_STATUSES = ['APPLIED_UNVERIFIED', 'RECOVERY_REQUIRED']`.
- The `SENDING` write shares the transaction with the claim check and the quota
  reservation, so a lapsed claim cannot race it.
- Recovery is a real path (`recoverAction`), not an inference from age.

So this design is **not new engineering**. It is lifting a proven producer-level
pattern into the layer that every other producer already passes through.

---

## 2. Producer survey (2026-09-06)

Istvan: *"Ne wrapperből következtess; menj le a tényleges producerig."* Every row
below was read at the producer, not inferred from a wrapper.

### 2.1 Brokered, with a durable pre-call record — 2 sites

| Producer | Path | Pre-call durability |
|---|---|---|
| Personal mail send | `src/cos/send-flow.ts:497` → `executeAction` (executor-core) | **YES** — `SENDING` before `adapter.send` |
| ZST corporate mail send | `src/cos/zst-send.ts:515` → `zstExecutor.executeAction` | **YES** — same executor pattern |

### 2.2 Brokered, with NO durable pre-call record — 4 sites

| Producer | Path | What a crash mid-call leaves behind |
|---|---|---|
| Gmail label write | `src/cos/adapters/gmail-label-api.ts:106` | nothing |
| COS Telegram send | `src/cos/cos-telegram.ts:236` | nothing |
| Channel provider send | `src/channel-provider.ts:59` | nothing |
| Dashboard Telegram send | `src/web/telegram.ts:135` | nothing |

None of these four writes any row before the call. Their only durable trace is
the broker's post-hoc `external_action_log` row, which by construction does not
exist if the process died in the await.

### 2.3 External mutations that DO NOT pass the broker at all

| Producer | Line | Effect | Note |
|---|---|---|---|
| `src/graph-mail.ts` `sendMail()` | `:231` | Microsoft Graph `/sendMail` — a real outbound email | **Un-brokered.** Reachable today only through the `scripts/graph-mail.ts send` CLI, i.e. a human at a terminal. Still an external mail send outside the declared choke point. |
| `src/web/federation/bridge.ts` | `:131` | `POST {peer}/api/federation/inbox` — writes into another system | **Un-brokered.** Has peer backoff, but no attempt ledger. |

### 2.4 Checked and NOT a durability concern — stated so it is not re-surveyed

| Producer | Why not |
|---|---|
| `src/cos/adapters/emag.ts` | **GET only.** Implements `ShoppingAdapter`, whose contract has no checkout surface; `assertNoCheckoutSurface` enforces this at registration. Read-only at the producer. |
| `src/cos/adapters/discovercars.ts:90` | `POST /api/v2/search/create-search` creates a *search session* and returns a guid. Provider-side ephemeral state, no business effect, freely re-issuable. Idempotency class **B** by nature, no ledger needed. |
| `src/graph-mail.ts:151`, `gmail-api-transport.ts:208`, `google-api.ts:127`, `gmail-thread-read.ts:55`, `source-commit-capability.ts:92` | OAuth token mints. POST, but no provider state we care about. |
| `src/channel-coordinator/telegram-client.ts:153/206` | `getUpdates` long-poll. POST, read-only. |
| `src/web/channel-request-watcher.ts:73` | `conversations.info`. Read-only. |
| `src/cos/openai-interpreter.ts:80` | Chat completion. Costs money, creates no provider state we later read back. Out of scope for *durability*; in scope for cost accounting, which is elsewhere. |

**Survey verdict:** 6 producers need the broker ledger (4 brokered-but-blind, 2
un-brokered), 2 already have an equivalent, and the rest are read-only or
token-mint traffic.

---

## 3. The broker action ledger

A durable record, committed **before** the external call.

| Column | Why it exists |
|---|---|
| `operation_id` | Stable identity for this *intent*. Survives retries; a retry must not mint a new one. |
| `action_type` / `capability` | What kind of effect, and under which capability it was permitted. |
| `target` | Resource identity at the provider. |
| `request_fingerprint` | Enough to recognise the same request later. **Never the secret, never the payload body.** |
| `idempotency_class` | A / B / C — see §5. Decided at the call site, recorded, not guessed at recovery time. |
| `readback_capability` | Whether the provider can be asked, later, whether this happened. |
| `attempt` | Attempt number under the same `operation_id`. |
| `status` | See §4. |
| `started_at` / `completed_at` | Unix seconds. |
| `provider_ref` | Provider message id / response reference, where one exists. |
| `failure_reason` | Explicit failure or explicit unknown reason. Never an empty string standing in for "fine". |

---

## 4. States

```
PREPARED ──► IN_FLIGHT ──┬──► SUCCEEDED
                         ├──► FAILED_RETRYABLE
                         ├──► FAILED_FINAL
                         └──► DELIVERY_UNKNOWN
```

- **PREPARED** — row committed, call not yet made.
- **IN_FLIGHT** — committed immediately before `await execute()`. *This is the
  write that does not exist today.*
- **SUCCEEDED** — provider acknowledged, or readback proves it.
- **FAILED_RETRYABLE** — the provider explicitly refused **before** mutating.
- **FAILED_FINAL** — refused, and retrying cannot help.
- **DELIVERY_UNKNOWN** — we cannot prove either way. A first-class terminal
  state, not a temporary label.

**The rule that carries the whole design:** `DELIVERY_UNKNOWN` must never be
silently promoted to `FAILED_RETRYABLE`. "We do not know whether it went out" is
a different fact from "it did not go out", and only the second one licenses a
retry.

---

## 5. Recovery is not a universal retry

Three classes, decided at the call site and recorded in the row:

**A — PROVIDER-IDEMPOTENT / IDEMPOTENCY KEY.** The provider accepts a stable key.
`operation_id` *is* that key on every attempt. Recovery may retry. Settles to
SUCCEEDED on the provider's response or on readback.

**B — NATURALLY IDEMPOTENT.** Re-applying the same Gmail label to the same
message is harmless. Recovery is RECONCILE / SAFE_RETRY, finalised by readback
where one exists. **But the audit must still not claim we know what the first
attempt did** — business-safe repetition is not evidence.

**C — NON-IDEMPOTENT, NO READBACK.** Telegram `sendMessage` is the canonical
case: no stable provider-side dedupe, no way to prove the earlier attempt.
A stale `IN_FLIGHT` here becomes `DELIVERY_UNKNOWN` and **no automatic retry is
ever issued**. A human decides.

### 5.1 Readback: two different jobs

Readback-after-success and crash-recovery readback are *not* the same use. The
recovery question is narrower and must be asked in its own words:

> Can we prove, from the provider's **current** state, that this operation
> happened?

Yes → reconcile to SUCCEEDED. No → `DELIVERY_UNKNOWN`, or a safe retry if and
only if the idempotency class allows one.

---

## 6. The local side is part of the same transaction

Where a producer has its own outbox/source state (COS `outbound_ledger` is the
live example), creating the broker operation and moving the local row to
"attempt started" belong in the **same DB transaction**, where the store's
transaction boundary allows it. No new window may open in which the local queue
says UNSENT while the broker ledger says IN_FLIGHT, or the reverse. The
executor-core `SENDING` write already demonstrates the shape.

---

## 7. Restart recovery

On start, find stale `IN_FLIGHT` rows.

- **Do not infer an outcome from age.** Age says how long ago we lost sight of
  it, nothing about what the provider did.
- Classify by the row's recorded `idempotency_class`: reconcile / safe retry /
  DELIVERY_UNKNOWN.
- Every decision writes its own audit row, naming which rule applied.
- Recovery is itself idempotent: running it twice must not mint a new
  `operation_id` and must not double-count an attempt.

---

## 8. Acceptance cases

These are the seven the owner named. They are the definition of done for the
local implementation.

1. **Telegram, provider succeeded, we died before the success write** →
   `DELIVERY_UNKNOWN`, **zero** automatic resends.
2. **Gmail `labels.modify`, label already present / ambiguous first attempt** →
   readback or naturally-idempotent reconciliation → no harmful duplicate.
3. **Explicit provider failure before the mutation** → `FAILED_RETRYABLE` where
   policy allows.
4. **Crash after PREPARED, before the provider call** → conservative recovery. It
   must **not** claim the call certainly did not go out unless that is provable.
5. **Normal success** → `SUCCEEDED` + provider reference and/or readback.
6. **Repeated recovery** → idempotent; no new operation identity.
7. **Broker audit** → no path may remain in which `execute()` performs an
   external mutation without a durable pre-attempt record.

Case 7 is the one that must be driven RED against today's code before it is
believed: on current `main`, it fails by construction.

---

## 9. Scope limits the owner set explicitly

- Do **not** build a general workflow engine for this.
- Do **not** build a per-channel state machine; the fix belongs in the shared
  broker layer.
- Do **not** deploy this standalone. It joins the A–H coherent hardening
  candidate.
- The scheduled follow-up autodraft stays **OFF** for the duration.

---

## 10. What this document does not yet have

Stated so nobody reads the absence as completeness:

- No implementation. No schema migration written. No tests written.
- The `request_fingerprint` construction is unspecified beyond "no secrets"; it
  needs a concrete rule per connector before it is implemented.
- Section 2.3's two un-brokered producers need an owner decision: bring them
  under the broker, or record why they stay outside it.
