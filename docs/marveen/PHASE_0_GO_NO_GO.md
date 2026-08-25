# Phase 0 — GO / NO-GO

```text
MIP-v1.0 §9. One document, written at the end of W14.
Written:  2026-08-26, night
Author:   Marveen
Verdict:  NO-GO — on one gate, for one reason, with a one-line fix that is the
          owner's to make. Everything else is PASS.
```

---

## 0. The verdict, up front

**NO-GO**, and not because a gate's work is missing. Every P0 gate below has its
evidence and eight of nine are PASS. The code is now merged into `develop`
(§4), so the blocker is narrower than when this document was drafted — but it is
the same blocker.

The blocker is that **none of it is running.** W10–W13 are committed on feature
branches; `develop` does not have them, and the live store proves it:

```text
live store: /home/iszzu/marveen/store/claudeclaw.db   (read-only measurement)
  cos_disclosure_records   → table does not exist
  cos_recovery_queue       → table does not exist
  migration_ledger         → table does not exist
  store_schema             → table does not exist
```

So every acceptance in this series is an acceptance **on a branch**. The running
system is the pre-W10 code: no recovery queue, no disclosure decision, no log
redaction, no durable schema version, no run ledger.

A production-readiness verdict is about what runs. Until the branches are merged
and the dashboard runs the built result, the honest answer is NO-GO — and the
work required to change it is a merge and a go-live, not another packet.

---

## 1. The gate table (§9)

| Gate | Evidence | Result |
|---|---|---|
| **Identity** | W10: identity is a function that must be called, not a claim; nine owner criteria met; coverage proven on three more surfaces. Enforcement is **deliberately OFF** — the owner's own activation condition | **PASS** (enforcement off by decision) |
| **Sensitivity** | W10 + W13: tier derived from declared + content (`egressTierFor`), fail-closed on both axes; a sensitive case with no cleared provider is blocked and recorded, never downgraded | **PASS** |
| **Schema / migration** | W11: store-level version + registry, idempotent runner proven on the real 277k-row store, in-flight marker with 3 RED mutations, fail-closed future-schema latch, staging proof on a copy of live, 17 swallowing catches converted | **PASS** |
| **Idempotency** | W12: ingest read+write in one IMMEDIATE transaction on both namespaces, CAS claim, UNIQUE as the last net; proven by two real processes over 40 keys, red against the pre-fix code | **PASS** |
| **Recovery** | W12: `cos_recovery_queue` + `cos_retry_policy` as data; NEEDS_HUMAN on threshold; the parked-ingest rows that had NO reader now have one; single-source send ceiling, both directions tested | **PASS** |
| **Credential / PII** | W13: log redaction on three surfaces (two real holes found by the owner's acceptance point), known-secret provenance registry with lifecycle, three-dimension disclosure decision with a durable record, minimum-necessary proven by degradation, disclosure precedes egress and fails closed | **PASS** (owner gate pending) |
| **Backup / restore** | W14: encrypted DB backup with a live receipt (173 MB, 64 cases read back) + the policy half; six-step drill with clean target, smoke tests and measured RPO/RTO; red-capable | **PASS** |
| **Staging / canary** | W14: canary with abort, promotion gate and human resume, wired to W13's new behaviour. **Staging parity is one of six dimensions** (migrations) | **PARTIAL — see §2** |
| **Run integrity** | W14: the cycle writes `cos_feature_runs`; SUCCESS requires verification, enforced by a cross-column CHECK | **PASS** |
| **RELEASE** (not in §9's list, and the reason for the verdict) | merged into `develop` 2026-08-26 after the §1.5 gate; **not yet cut over** — the live runtime is pinned to `0011de922` and the live store still has none of the tables | **FAIL — pending cutover** |

---

## 2. What is honestly PARTIAL

**Staging parity.** §8.4 lists six dimensions — auth path, migrations, policy
engine, tool execution, observability, release flow. One is covered: migrations,
by W11's proof against a copy of the live store, which is the most faithful
staging available on a machine with no staging environment. The other five have
no equivalent, and building one is a Phase 1 sized piece of work, not a W14
oversight.

**The code-rollback rehearsal.** Data and behaviour rollback are drilled; the
code layer is documented and practice-proven only (see the runbook §4).

**Two §8.6 metrics** — stale runs, unverified completion — are unwritten.

---

## 3. The pattern worth carrying into Phase 1

Three packets, three instances of the same defect:

| packet | the thing that existed | the thing that did not |
|---|---|---|
| W12 | `RECOVERY_REQUIRED` rows on `email_processing` | any reader — no retry, no listing, no alert, no test, while the state was non-terminal and pinned the mail cursor |
| W13 | `redactSensitive`, exported and tested | any production caller; the logger had no `redact` at all, while the function's header claimed otherwise |
| W14 | `cos_feature_runs` + `recordFeatureRun` | any writer — 0 rows in the live store after months |

**This codebase's characteristic defect is not broken code. It is correct code
with no consumer.** Every one of the three passed review, had tests, and was
described in its own header as working.

The cheapest detector is not source review — it is the live store. A table that
exists with zero rows after months is a writer that does not exist. The habit
Phase 1 should carry: for every new capability, name its consumer, and check the
consumer's *output*, not its code.

---

## 4. What would make this a GO

**Step 1 is done.** `feat/w11-durable-schema-migration` (which carries W10
through W14) was merged into `develop` on 2026-08-26 after the §1.5 merge gate's
four conditions were met: full suite green (579 files / 7752 tests), integration,
security/failure tests, and a migration proof against a COPY of the live store —
189 MB, 119 cases, every new table created, no row lost, `cos_feature_runs`
rebuilt to the §8.7 shape, schema gate OK, integrity ok.

**The merge is not the release, and on this install that is enforced rather than
hoped.** The live runtime is pinned to an exact activation candidate
(`releases/dashboard-runtime-pin.json`, sha `0011de922`), and the scheduled
cos-cycle refuses to run unless the cycle release, the deployed runtime and the
triage feeder all report THAT sha. The merge does not touch any of them — which
is the pin's entire purpose. Measured after the merge: `dist/index.js` still
carries its 2026-08-24 19:31 build, matching the pin's `deployedAt`.

So the remaining work is a **cutover**, and it is a multi-consumer one:

1. **Build an activation candidate from the merged sha**, with CI evidence on
   THAT sha (the pin file records `ciEvidence` per candidate for exactly this
   reason).
2. **Move all three consumers together**: the dashboard `dist`, the cos-cycle
   release archive (`releases/cos-cycle-current`), and the pinned triage feeder.
   The pin file's own correction note records what happens otherwise — a first
   cutover advanced the feeder without rebuilding `dist`, two consumers ended on
   two SHAs, and the guard caught it on its first run. "Functionally equivalent"
   is not "the same sha".
3. **Re-measure the four tables on the live store.** The same read-only query
   that produced §0 is the acceptance: they must exist, and `cos_feature_runs`
   must start gaining rows within one cycle.
4. **Then re-run this document.** It is a snapshot, not a certificate.

Two further items are needed for a full green rather than for the GO itself: the
code-rollback rehearsal in a quiet window, and the two missing §8.6 metrics.

---

## 5. What this document does not claim

It does not claim the system is unsafe today. The pre-W10 code has been running
for months with its own protections — the approval-gated executor, the poison
quarantine, the cursor rule, the encrypted daily backup with a real restore test.
Phase 0 hardened what sits around them and has not yet reached them.

And it does not claim the branches are risky to merge: the suite is green at 579
files / 7752 tests, every packet has mutation proof, and W11's migration was
proven against a copy of the live store. What it claims is narrower and harder to
argue with — **unmerged is unproven in production**, and that is the whole of the
NO-GO.
