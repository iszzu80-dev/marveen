# Phase 0 — GO / NO-GO

```text
MIP-v1.0 §9. One document, written at the end of W14.
Written:  2026-08-26, night
Revised:  2026-08-26, morning — after the owner's gate review, which accepted
          W12 and W13 as VERIFIED_DONE, held W14 at PARTIAL, and named five
          closure items. This revision answers them.
Author:   Marveen
Verdict:  NO-GO — unchanged, and for the same single reason: none of it is
          running. What changed is that the reasons which were NOT that one are
          now closed with evidence rather than deferred.
```

---

## 0. The verdict, up front

**NO-GO.** The blocker is unchanged and narrow: **the merged code is not the
running code.** W10–W14 are on `develop`; the live runtime is pinned to
`0011de922`, and the live store still proves it:

```text
live store: /home/iszzu/marveen/store/claudeclaw.db   (read-only, 2026-08-26)
  cos_disclosure_records   → table does not exist
  cos_recovery_queue       → table does not exist
  migration_ledger         → table does not exist
  store_schema             → table does not exist
```

Every acceptance in this series is therefore an acceptance **on a branch**. A
production-readiness verdict is about what runs.

The change since the first draft is that the verdict now rests on **one** item
instead of one plus a tail of PARTIALs. The tail is closed below.

---

## 1. Closure matrix — the owner's five items

| # | item | status | evidence |
|---|---|---|---|
| 1 | **CONTROLLED CUTOVER + LIVE ACCEPTANCE** | **PREPARED, NOT EXECUTED** — awaiting explicit go-live | `PHASE_0_CUTOVER_READINESS.md`: seven artefacts, the procedure, runtime-evidence acceptance (§5), stop condition, and **two owner decisions about the guard** (§3) |
| 2 | **FRESH_STORE_CONCURRENT_BOOT_SAFETY** | **CLOSED** under option (B) | `W14_FRESH_BOOT_PROOF.md`: cross-process bootstrap lock; 6 processes, 6 ledger rows, **zero overlapping intervals**, 5 measurably blocked; RED-capable and mutation-checked |
| 3 | **STAGING PARITY** | **MAPPED** — 2 PASS, 3 PARTIAL with named cutover mitigations, 1 OUT-OF-SCOPE by mechanism | `W14_STAGING_PARITY_MATRIX.md` |
| 4 | **ROLLBACK PROOF** | **DRILLED in isolation**, 11 steps, 0 failed | `W14_ROLLBACK_PROOF.md`: real releases, real guard, a **180 MB copy of the live store**; accept AND refuse exercised; drill proven able to fail |
| 5 | **LIVE RECONCILIATION** of the APPLIED_UNVERIFIED rows | **PLANNED for after the cutover**, with the readback evidence already gathered — and **the count corrected from two to three** | `PHASE_0_CUTOVER_READINESS.md` §7 |

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
| **RELEASE** | merged into `develop`; **not cut over.** The live runtime is pinned to `0011de922` and the live store has none of the new tables | **FAIL — the whole of the NO-GO** |

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

## 6. What would make this a GO

One thing: **the cutover, accepted on runtime evidence.**

`PHASE_0_CUTOVER_READINESS.md` carries the procedure and the acceptance. The
short form:

1. the owner decides §3.1 and §3.2 (the guard);
2. the closure branch passes the §1.5 merge gate;
3. a candidate sha with CI green **on that sha**;
4. all three consumers and the pin move together; guard exits 0;
5. restart;
6. **the live store shows the four tables, and `cos_feature_runs` gains rows
   within one cycle.**

Step 6 is the acceptance. Steps 1–5 are logistics.

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
