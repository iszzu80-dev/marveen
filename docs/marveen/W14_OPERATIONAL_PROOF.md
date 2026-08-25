# W14 — Backup, Restore, Staging, Canary & Operational Proof: repo audit

```text
PACKET: MIP-v1.0 / §8 / W14_OPERATIONAL_PROOF
Audit date: 2026-08-26 (night, after W13 was delivered for review)
Status:     AUDIT + GAP MATRIX only — no implementation yet
Method:     read the shipped code, the shipped scheduled tasks, and the LIVE
            store; every count below was measured, not estimated
```

This audit opens with the finding that changes what every other line in it means.

---

## 0. THE HEADLINE: nothing from W10–W13 is live

W10, W11, W12 and W13 were built on feature branches:

```text
feat/w10-identity-sensitivity-boundary
feat/w11-durable-schema-migration     ← W11, W12, W13 all sit here
```

Neither is merged into `develop`. Measured against the LIVE store
(`/home/iszzu/marveen/store/claudeclaw.db`, read-only):

| table | live rows |
|---|---|
| `cos_disclosure_records` | **table does not exist** |
| `cos_recovery_queue` | **table does not exist** |
| `migration_ledger` | **table does not exist** |
| `store_schema` | **table does not exist** |

So every acceptance this packet series has passed is an acceptance **on a
branch**. The running system is the pre-W10 code: no recovery queue, no
disclosure decision, no log redaction, no durable schema version.

This is not a defect in those packets — they were built and gated exactly as
asked. It is a fact about what "done" currently means, and W14 is precisely the
packet whose subject is release control, so it belongs at the top of this
document rather than in a footnote. **The Phase 0 GO/NO-GO cannot be answered
from the branches; it has to be answered about what runs.**

---

## 1. What already exists, measured

### 1.1 Backup (§8.2) — the strongest area

`src/cos/backup.ts`: AES-256-GCM over the DB file, scrypt-derived key, salt + iv
+ tag in the header, passphrase supplied by the caller and never stored or
logged. `pruneBackups` enforces a 30-day retention window.

`verifyEncryptedBackup` is a genuine restore test, not a round-trip check, and
its header says why the difference mattered: the earlier version compared
decrypted bytes with source bytes, which proves the encryption round-trips and
says nothing about whether the encrypted thing was a usable database — the exact
failure a WAL-mode raw copy produces. It now decrypts to a probe file, OPENS IT
AS A DATABASE, runs SQLite's `integrity_check`, and counts `personal_cases`,
because a backup that opens cleanly and holds no cases proves nothing either.

**It is wired and it has a live receipt.** `scripts/cos-maintenance.ts` runs
daily at 04:30 (`~/.claude/scheduled-tasks/cos-maintenance`), and the task's own
description records the day it went live: a 173 MB backup was created,
decrypted, and **64 cases were read back out of it**.

### 1.2 Staging (§8.4) — one real proof, and it names its own limits

`scripts/w11-staging-migration-proof.ts` states the honest position in its
header: *this system has no staging environment*, so "staging" is a COPY of the
live store taken with SQLite's own `backup()` (so a concurrent writer cannot
produce a torn file), opened read-only, with every write landing on the copy.

That is the most faithful staging available here — real tables, real row counts,
real accumulated oddities including 20 pre-existing foreign-key violations a
hand-built fixture would never have. It covers ONE of §8.4's six parity
dimensions (migrations). Auth path, policy engine, tool execution, observability
and release flow have no equivalent.

### 1.3 Health metrics (§8.6) — five of nine, spread across three surfaces

| §8.6 metric | where | verdict |
|---|---|---|
| run success/failure | `cos-cycle`'s `problems` + exit code | **PARTIAL** — per cycle, not per feature |
| partial failure | `cos-cycle` isolates each step, reports each failure | MET |
| policy deny | `cos_disclosure_records.any_denied` (W13) | MET **on the branch** |
| duplicate suppression | `email_processing` DUPLICATE rows; `LINKED_DUPLICATE` outcomes | **PARTIAL** — countable, never counted |
| unknown outcome | `outbound_ledger.status` counts in `/api/cos/monitoring` | MET |
| recovery queue size | `cos_recovery_queue` counts (W12) | MET **on the branch** |
| migration errors | `migration_ledger` (W11) | MET **on the branch** |
| stale runs | — | **GAP** |
| unverified completion | — | **GAP** |

### 1.4 Alerting and reconciliation

`runDailyReconcile` produces findings with severities and feeds
`/api/cos/monitoring`; `alertOutboundRecovery` posts RECOVERY_REQUIRED rows to
the bus and the daily log; the PLANNED digest speaks once a day including the
zero case. These are real, live, and predate this packet series.

---

## 2. Gap matrix

| §8 requirement | verdict | evidence / what is missing |
|---|---|---|
| 8.2 backup scope: durable state | MET | whole-DB encrypted snapshot |
| 8.2 schema/migration metadata | MET by inclusion | it is in the same file — but only once W11 is live |
| 8.2 policy/config | **GAP** | `store/*.json` (autonomy config, egress allowlist, vault-bindings, source-commit policy) are NOT in the backup; the DB is |
| 8.2 secrets under a separate policy | MET by omission | the vault is deliberately not in the DB backup; there is no secret backup at all, which is a decision that should be stated rather than inherited |
| 8.3 restore drill (6 steps) | **PARTIAL** | steps 1–4 exist (snapshot, probe target, restore, integrity+row check). **Missing: smoke tests on the restored store, and a measured RPO/RTO** |
| 8.4 staging parity | **PARTIAL** | migrations only (1.2) |
| 8.5 canary | **GAP** | nothing for the COS. The `capacity-routing` canary is about model switching, not about a new critical behaviour's rollout |
| 8.6 health metrics | **PARTIAL** | 1.3 |
| 8.7 run integrity | **GAP** | 2.1 — the headline of this section |
| 8.8 rollback / forward-fix runbook | **GAP** | `docs/` holds runbooks for clean-replay and connectors; there is none for "a release went wrong" |

### 2.1 The run-integrity table has no writer

`cos_feature_runs` exists (`consumer-manifest.ts`), with run_id, feature_id,
domain, examined/matched/acted/failed, outcome, reason, started_at, finished_at.
`recordFeatureRun` is exported and tested.

**Nothing calls it.** Not one production caller in `src/` or `scripts/`. And the
live store agrees:

```text
cos_feature_runs: 0 rows
```

The table has been created on every boot and written to never. This is the third
instance of the same shape in three packets — W12's unread `RECOVERY_REQUIRED`
rows, W13's uncalled `redactSensitive`, and now this — which is itself the
finding worth carrying to the GO/NO-GO: **this codebase's characteristic defect
is not broken code, it is correct code with no consumer.**

Even once wired, the record is short of §8.7's list: no capability/preflight
result, no input cursor, no processed ids, no pending writes, no side effects, no
verification status, no final cursor. And §8.7's central rule — *`SUCCESS` only
after readback/verification* — has no representation at all: `outcome: ACTED`
says something happened, not that it was verified. The outbound executor already
does exactly this distinction (`APPLIED_UNVERIFIED` vs `VERIFIED`); the run
record does not inherit it.

### 2.2 The backup covers the database and not the policy

Everything the system decides with that is NOT in SQLite is outside the backup:
`store/autonomy-config.json`, `store/egress-allowlist.json`,
`store/vault-bindings.json`, `store/cos-source-commit-policy.json`,
`store/config-overrides.json`. A restore from a current backup would produce a
store with all the case data and none of the operator's policy — including the
egress allowlist, which is a security control.

---

## 3. Plan (implementation, next session)

Ordered by what would catch a real failure first.

1. **Wire run integrity, then widen it.** Make the cycle's steps record
   `cos_feature_runs` (they already produce `standardFeatureResult`), then add
   §8.7's missing columns — cursor in/out, verification status, and a
   `run_status` where SUCCESS requires verification rather than mere completion.
2. **Bring the policy files into the backup**, and prove it by restoring into a
   clean target and diffing the policy set.
3. **Finish the restore drill**: a clean restore target, smoke tests against the
   restored store (open the cycle's read paths, count what must be there), and a
   MEASURED RPO/RTO written down rather than estimated.
4. **The two missing health metrics** (stale runs, unverified completion), which
   are cheap once run integrity is written.
5. **Canary + rollback runbook**, which are the two items that only mean anything
   once the branches are merged and there is a release to canary.

And before any of it, the item that outranks the packet: **decide what happens to
the four unmerged branches.** Auditing release control while the audited work is
not released is a contradiction the GO/NO-GO cannot absorb.

No code was written for W14 in this session. The audit is the deliverable.
