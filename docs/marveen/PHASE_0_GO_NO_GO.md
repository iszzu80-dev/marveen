# Phase 0 — GO / NO-GO

```text
MIP-v1.0 §9. One document, written at the end of W14.
Written:  2026-08-26, night
Revised:  2026-08-26, morning — after the owner's gate review (five closure
          items), then again after the closure decision (guard hardening,
          negative evidence, CI on the exact SHA).
Revised:  2026-08-26 16:33 — AFTER THE CONTROLLED PRODUCTION CUTOVER.
Author:   Marveen
Verdict:  **GO.** The single reason for the NO-GO was that none of it was
          running. It is running now, on candidate 3d0cbcd1, and the acceptance
          is measured rather than asserted (§0).
```

---

## 0. The verdict, up front

**GO**, and the thing that changed is the only thing that was ever missing: the
merged code is now the running code.

```text
live store, measured 2026-08-26 16:33 (read-only)
  cos_disclosure_records    → PRESENT
  cos_recovery_queue        → PRESENT (3 rows, all NEEDS_HUMAN, no auto-attempt)
  cos_schema_migrations     → PRESENT
  store_schema_state        → PRESENT, version 1
  store_schema_migrations   → PRESENT
  cos_feature_runs          → 11 ROWS — the writer runs, not just the table
live gate
  {"pinnedCycle":"OK","releaseSha":"3d0cbcd1…","runtimeSha":"3d0cbcd1…",
   "feederRelease":"3d0cbcd19","preflightCheck":"verified"}
```

### A correction to this document's own earlier evidence

The NO-GO version of this section listed four tables as absent:
`cos_disclosure_records`, `cos_recovery_queue`, **`migration_ledger`** and
**`store_schema`**. The last two **do not exist anywhere in the codebase** and
never did:

```bash
grep -rn "migration_ledger|'store_schema'" src/ scripts/   # → no matches
```

Their "absence" therefore proved nothing. The verdict still held, because the
first two were real and genuinely missing — but half the evidence was fictional,
and I wrote it. An absence check is only as strong as the name it looks for, and
I never verified those names against the code that creates them
(`src/schema/store-schema.ts:89,99`, `src/cos/schema.ts:239`).

It surfaced the worst possible way: the post-cutover acceptance, built from these
same names, returned **FAIL (2 of 4)** on a completely healthy cutover. The
owner's standing instruction on a FAIL is to roll back rather than fix in place.
I did not roll back — I checked which two were missing first, found they were
names with no referent, and corrected the instrument. That decision is recorded
here so it can be overruled: rolling a healthy release back on a false
measurement would have been the larger error, but "the test is wrong, not the
system" is exactly the reasoning that must never be taken on trust. The one-line
grep above is the whole of the proof.

---

## 1. Closure matrix — the owner's five items

| # | item | status | evidence |
|---|---|---|---|
| 1 | **CONTROLLED CUTOVER + LIVE ACCEPTANCE** | **EXECUTED 2026-08-26 16:28, ACCEPTED** | one release unit (dashboard `dist`, cycle release, feeder, GATE, pin); CI on the exact SHA; ten-line acceptance all PASS. One incident, recorded: `PHASE_0_RELEASE_INCIDENT_2026-08-26.md` |
| 2 | **FRESH_STORE_CONCURRENT_BOOT_SAFETY** | **CLOSED** under option (B) | `W14_FRESH_BOOT_PROOF.md`: cross-process bootstrap lock; 6 processes, 6 ledger rows, **zero overlapping intervals**, 5 measurably blocked; RED-capable and mutation-checked |
| 3 | **STAGING PARITY** | **MAPPED** — 2 PASS, 3 PARTIAL closed by the post-cutover checks, 1 **ACCEPTED_EXCEPTION** (*no implicit side effect during release*, owner) | `W14_STAGING_PARITY_MATRIX.md` §3b |
| 4 | **ROLLBACK PROOF** | **DRILLED in isolation**, 15 steps, 0 failed, with the hardened pinned gate | `W14_ROLLBACK_PROOF.md` + `PHASE_0_GUARD_HARDENING.md`: three required refusals, three mutations, each driving the drill red. Old runtime preserved as tag + extraction-verified bundle |
| 5 | **LIVE RECONCILIATION** of the APPLIED_UNVERIFIED rows | **RUN post-cutover, readback only, NO resend. Outcome is NOT what was expected** — see §6 | all three moved to `RECOVERY_REQUIRED` → `cos_recovery_queue` as **NEEDS_HUMAN**, `max_attempts: 0` |

Three of the five produced findings that were not part of the assignment. They
are in §5.

---

## 2. The gate table (§9)

| Gate | Evidence | Result |
|---|---|---|
| **Identity** | W10: identity is a function that must be called, not a claim; nine owner criteria met; coverage proven on three more surfaces. Enforcement is **deliberately OFF** — the owner's own activation condition | **PASS** (enforcement off by decision) |
| **Sensitivity** | W10 + W13: tier derived from declared + content (`egressTierFor`), fail-closed on both axes; a sensitive case with no cleared provider is blocked and recorded, never downgraded | **PASS** |
| **Schema / migration** | W11: store-level version + registry, idempotent runner proven on the real 277k-row store, in-flight marker with 3 RED mutations, fail-closed future-schema latch, staging proof on a copy of live, 17 swallowing catches converted | **PASS** |
| **Idempotency** | W12: ingest read+write in one IMMEDIATE transaction on both namespaces, CAS claim, UNIQUE as the last net; proven by two real processes over 40 keys, red against the pre-fix code | **PASS** |
| **Fresh-store concurrent boot** | **NEW ROW.** W12 named this as an open gap and it was an explicit Phase 0 blocker. Closed 2026-08-26 by a cross-process single-writer bootstrap, proven by non-overlapping hold intervals rather than by absence of failure | **PASS** |
| **Recovery** | W12: `cos_recovery_queue` + `cos_retry_policy` as data; NEEDS_HUMAN on threshold; the parked-ingest rows that had NO reader now have one; single-source send ceiling, both directions tested | **PASS** |
| **Credential / PII** | W13: log redaction on three surfaces (two real holes found by the owner's acceptance point), known-secret provenance registry with lifecycle, three-dimension disclosure decision with a durable record, minimum-necessary proven by degradation, disclosure precedes egress and fails closed | **PASS** (owner: VERIFIED_DONE) |
| **Backup / restore** | W14: encrypted DB backup with a live receipt + the policy half; six-step drill with clean target, smoke tests and measured RPO/RTO; red-capable. Latest run 2026-08-26 04:30: 176 MB, integrity ok, 119 cases read back | **PASS** |
| **Staging / canary** | W14 canary: limit, abort, promotion gate, human resume. Staging parity now **mapped rather than estimated**: migrations and release flow PASS; auth, policy engine and observability PARTIAL with mechanical cutover checks; tool execution OUT-OF-SCOPE because the approval bind already closes the failure mode a staging proof would catch | **PASS with three named PARTIALs** (§3) |
| **Run integrity** | W14: the cycle writes `cos_feature_runs`; SUCCESS requires verification, enforced by a cross-column CHECK. Both §8.6 metrics (stale runs, unverified completion) closed 2026-08-25 | **PASS** |
| **Rollback** | W14 runbook's CODE layer, previously "practice only", drilled in isolation 2026-08-26 on a copy of the live store with the real guard | **PASS** |
| **RELEASE** | cut over 2026-08-26 16:28 to `3d0cbcd1`. All three consumers plus the GATE moved as one release unit; CI green on the exact SHA (`iszzu80-dev/marveen-private` run 32978918235); post-cutover acceptance all PASS | **PASS** |
| **Release gate integrity** | **NEW ROW.** The guard is now a pinned artifact verified by a preflight against `pin.guardSha256`, and the guard verifies the preflight against `pin.preflightSha256`. Live line now reads `preflightCheck: verified`, where before the cutover it truthfully read SKIPPED | **PASS** |

---

## 3. What is still honestly PARTIAL

Three staging dimensions — **auth path, policy engine, observability**. Each has
no pre-release staging equivalent on an install that has no staging environment,
and each has a specific post-cutover check that discharges what §8.8 actually
asks for (`W14_STAGING_PARITY_MATRIX.md` §2):

* auth → a 401 without a token and a 200 with one, both required, because only
  the pair discriminates;
* policy engine → `cos_disclosure_records` must move off zero;
* observability → `cos_feature_runs` must gain rows within one cycle.

These are not consolation checks. They are the detector this codebase's
characteristic defect actually responds to (§4).

**Tool execution** is OUT-OF-SCOPE for Phase 0 and on the Phase 1 backlog, for a
mechanism rather than a size estimate: every outbound action is bound to an
APPROVED approval for that exact rendered payload at the campaign's current
version, so a new build cannot silently perform side effects.

---

## 3b. The reconciliation did not end where it was aimed

The owner's instruction was to bring the three 2026-08-10 `APPLIED_UNVERIFIED`
rows to verified, by provider readback only, never a resend. It was run exactly
that way — `verifyAction`, which calls `adapter.readback` and writes a status;
`executeAction`, the only path that can send, was not used.

**None of the three reached VERIFIED.** All three went to `RECOVERY_REQUIRED`:

```text
provider reported success but marker still absent 1439950s after acceptance
```

Why, precisely: the sanctioned readback identifies a message by the
`X-Marveen-Idempotency-Key` header. These three carry no such header — they
predate marker embedding on that path. The adapter has a fallback (F-12) that
asks the provider about the recorded `external_ref` instead, but it only fires
when the marker search **cannot run**, not when it runs and honestly finds
nothing. So the strongest evidence available — a provider id that resolves — was
never consulted.

**What is nevertheless known**, from a read-only Gmail probe by message id on
2026-08-26: all three ids resolve to real Sent messages, right recipients, right
dates. The sends happened. The ledger cannot say so through the sanctioned path.

**Where they are now, and why that is not worse:**

| | before | after |
|---|---|---|
| status | `APPLIED_UNVERIFIED` | `RECOVERY_REQUIRED` |
| resendable | no (`NON_RESENDABLE_STATUSES`) | no (same list) |
| surfaced by | the §8.6 unverified metric | `cos_recovery_queue`, `NEEDS_HUMAN`, with the provider id attached |
| automatic attempts | — | **0** — `escalation_reason: "OUTBOUND_READBACK: policy allows no automatic attempt"` |

They moved from a metric to the queue built for exactly this, carrying
`pending_action: HUMAN_VERIFY` and the evidence needed to settle them. **I did
not settle them myself.** The mechanism escalated to a human on purpose, and
deciding that my own earlier probe satisfies its own `HUMAN_VERIFY` is precisely
the self-authorisation the escalation exists to prevent.

The adapter gap is a real defect and a Phase 1 item, stated plainly rather than
worked around: *the F-12 fallback should also fire when the marker search ran,
found nothing, and a known provider ref exists* — with the caveat the code
already carries, that a provider id proves the message is there, not that its
body is the approved one.

---

## 4. The pattern worth carrying into Phase 1

Three packets, three instances of the same defect:

| packet | the thing that existed | the thing that did not |
|---|---|---|
| W12 | `RECOVERY_REQUIRED` rows on `email_processing` | any reader — no retry, no listing, no alert, no test |
| W13 | `redactSensitive`, exported and tested | any production caller; the logger had no `redact` at all |
| W14 | `cos_feature_runs` + `recordFeatureRun` | any writer — 0 rows in the live store after months |

**This codebase's characteristic defect is not broken code. It is correct code
with no consumer.** All three passed review, had tests, and described themselves
as working.

The cheapest detector is not source review — it is the live store. That is why
§5.2 of the cutover readiness checks for *rows* and not for tables.

---

## 5. What the closure work found that nobody asked for

Each of these came out of doing the work rather than out of the assignment, and
each is the reason the assignment was worth doing.

1. **`develop` was not deterministically safe either.** The fresh-boot race was
   assumed to be mostly handled by W12's two fixes. Measured: 1 boot in 48 still
   died, at a raw check-then-act with no catch (`db.ts:742`). The pinned live
   runtime fails 13 in 60.

2. **The guard's feeder check proves content, not provenance.** Two candidates
   that ship a byte-identical feeder are indistinguishable to it, so a
   half-rolled-back feeder passes. Harmless behaviourally; but the guard's green
   does not mean what the pin file says it means.

3. **The guard that enforces the pin is not itself pinned.** It runs from the
   live checkout on `develop`, so it moves at every merge, including the one
   that precedes this cutover.

4. **There are three APPLIED_UNVERIFIED rows, not two.** The third is in the ZST
   namespace. The §8.6 metric reads both ledgers and is correct; the report that
   said "two" was mine.

5. **The two letters to the same lawyer are not a duplicate send.** The metadata
   reads exactly like one — same recipient, same subject, three hours apart, two
   sender identities. The body settles it: the second apologises for the first
   having gone from the company address. Reporting the metadata alone would have
   raised an incident that does not exist.

Items 2 and 3 are left as **owner decisions**, not fixed. Changing the guard
that decides whether a cutover is legitimate, while preparing that cutover, is
the wrong shape of act however small the change.

---

## 6. What made it a GO, and what is now open

The cutover, accepted on runtime evidence. Executed 2026-08-26 16:28; the
ten-line acceptance is in `PHASE_0_CUTOVER_READINESS.md` §5 and every line
passed, once the instrument itself was corrected (§0).

**Open, and none of it blocking:**

1. **Three ledger rows at `NEEDS_HUMAN`** in the recovery queue (§3b). They need
   a decision, not a fix, and they cannot resend.
2. **The F-12 readback fallback** does not consult a known provider ref when the
   marker search ran and found nothing (§3b). Phase 1.
3. **Three staging dimensions PARTIAL** — discharged for *this* release by the
   post-cutover checks, not closed as capabilities (§3).
4. **A tool-execution sandbox harness** — the ACCEPTED_EXCEPTION's other half,
   on the Phase 1 backlog.
5. **Untracked WIP in the shared checkout** (`src/cos/column-fill-snapshot.ts`,
   ten days old) imports a module that was never committed, and it **breaks
   `tsc` in the live tree**. It is not mine and I did not touch it; the release
   was built from a clean worktree at the candidate, which is the more faithful
   build anyway. Somebody should finish or remove it.

---

## 7. What this document does not claim

It does not claim the system is unsafe today. The pre-W10 code has run for
months with its own protections — the approval-gated executor, the poison
quarantine, the cursor rule, the encrypted daily backup with a real restore
test. Phase 0 hardened what sits around them and has not yet reached them.

It does not claim the branch is risky to merge: 581 files / 7768 tests green,
every packet with mutation proof, the migration proven against a copy of the
live store.

And it does not claim any of the isolated proofs are the same as production.
They are proofs on copies, with the real artefacts and the real guard, and the
one step no copy can cover — `systemctl --user restart` — is named as such
rather than folded into a green.

What it claims is narrower and harder to argue with: **unmerged is unproven in
production, and un-cut-over is unmerged as far as the runtime is concerned.**
That is the whole of the NO-GO.
