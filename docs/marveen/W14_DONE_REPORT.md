# W14 — Backup, Restore, Staging, Canary & Operational Proof: done report

```text
PACKET: MIP-v1.0 / §8 / W14_OPERATIONAL_PROOF
Audit:  docs/marveen/W14_OPERATIONAL_PROOF.md (2026-08-26, night)
Build:  2026-08-26, night
Runbook: docs/marveen/W14_ROLLBACK_RUNBOOK.md
```

## 0. The finding that framed the packet

The audit's first line is still the most important one: **W10–W13 are on feature
branches and nothing from them runs.** Measured on the live store —
`cos_disclosure_records`, `cos_recovery_queue`, `migration_ledger` and
`store_schema` do not exist there. W14 is the packet about release control, so it
could not treat that as a footnote. It is carried into the GO/NO-GO as its own
line rather than resolved here: the merge decision is the owner's.

The second finding shaped the work itself. `cos_feature_runs` existed,
`recordFeatureRun` was exported and tested, and **nothing called it** — 0 rows in
the live store, created on every boot, written never. That is the third instance
of one shape in three packets (W12's unread `RECOVERY_REQUIRED` rows, W13's
uncalled `redactSensitive`, this), which is why the GO/NO-GO names the pattern
and not only the instances.

## 1. Run integrity (§8.7)

**Wired at the choke point.** The cycle records one row per step, in the parent,
because that is the one place every step passes through — a new step is recorded
without its author remembering to. The parent only sees what a step PRINTS, so
the cursor and verification fields are read out of the step payload rather than
invented.

**§8.7's central rule is now a constraint, not a convention.** "SUCCESS only
after readback/verification": an ACTED run that was not verified is PARTIAL. Two
levels — `deriveRunStatus` computes it and says why, and the table refuses a
`SUCCESS` row whose verification is `UNVERIFIED` through a cross-column CHECK, so
the rule stands even if a future writer skips the helper. A test inserts that row
by hand and asserts SQLite rejects it.

**Verification is derived from the GRANT, not from optimism.** A step whose
scheduled-task grant has no `EXTERNAL_EFFECT` has nothing to read back
(`NOT_APPLICABLE`). A step that may act outside and did act, without saying it
verified, is `UNVERIFIED` — so the send steps will show PARTIAL until they report
a readback. That is not a defect in the reporting; it is the state nobody was
measuring.

The old table shape is rebuilt with row counting, and pre-W14 rows are marked
`UNKNOWN` / `NOT_APPLICABLE`: nothing recorded whether those runs were verified,
and inventing a verdict for them is exactly the lie the column exists to prevent.

Also added: the §8.7 envelope — capability result, input and final cursor,
processed ids, pending writes, side effects.

## 2. Backup: the policy half (§8.2)

The database backup carried every case and **none of the rules**. A restore
would have produced a store that looks complete and behaves differently,
including an **empty egress allowlist** — a security control.

Two declared lists and a rule:

| | |
|---|---|
| `POLICY_FILES` | what is backed up, by name, so the set is auditable |
| `SECRET_FILES` | what is deliberately NOT (§8.2 puts secrets under a separate policy) — by name, so the exclusion is a decision on the record |
| `isRuntimeState()` | the pattern for what is recomputable |

**The third status is the design.** A store file matching none of the three is
reported `UNCLASSIFIED` on every run until somebody classifies it. A declared list
rots as the system grows, and a rot nobody sees is exactly how the egress
allowlist would have fallen out of a future backup.

Same crypto, same 30-day retention, same restore test (decrypt → parse → every
file the manifest calls `BACKED_UP` is present AND parses), and pruning by the
filename timestamp rather than mtime — mtime is a property of the copy.

## 3. The restore drill (§8.3)

`scripts/w14-restore-drill.ts` runs all six steps against a COPY, never writing
to the live store:

1. staging backup (database + policy)
2. **clean target** — refuses to continue if it is not empty
3. restore, both halves
4. consistency: integrity check, foreign keys reported (the live store carries 20
   pre-existing violations — failing on them would fail every drill for a
   condition the drill did not cause), row counts against the source
5. **smoke tests** — `listActiveCases`, `listTodayCases`, `getCheckpoint`,
   `listNeedsHuman` against the restored store. A restored file that opens is not
   a restored system.
6. **RPO/RTO measured**. RPO is the age of the newest REAL backup, not the
   drill's own (that would be zero and meaningless); with no backup present it
   says the RPO is unbounded.

Nine tests run the real script as a subprocess. Including that it can go **red**:
a truncated database. Not a flipped byte — measured, a single flip often lands in
free space and `integrity_check` still says `ok`, which is why that first version
of the test was rewritten.

## 4. Canary (§8.5)

`src/cos/canary.ts`, wired to the behaviour W13 introduced: the per-field
disclosure decision on the enrichment path rolls out at **one case per cycle**
until ten consecutive VERIFIED-clean runs, then the full budget.

- **the metrics are the run ledger**, not private counters. A canary with its own
  opinion about health is a second opinion, and two opinions drift;
- **abort is checked first and looks at the latest run only**: a fresh FAILED (or
  PARTIAL — §8.7) outvotes any streak, because letting a clean history outvote a
  fresh failure is how a canary becomes decoration;
- an aborted canary does **zero** work, not less — that is the difference between
  an abort and a slowdown;
- an abort is cleared by a **human**; nothing automatic calls `resumeCanary`,
  because an abort that clears itself is a retry loop with a ceremony;
- restarting a running canary does not reset its promotion count, or a feature
  could live under canary forever and nobody would notice it never promoted.

## 5. Rollback runbook (§8.8)

`W14_ROLLBACK_RUNBOOK.md`: three layers, each row naming what proves it.

| layer | rollback | proven by |
|---|---|---|
| DATA | restore backup + policy bundle | the drill (§3) |
| BEHAVIOUR | canary abort, automatic or by hand | the canary tests (§4) |
| CODE | previous `dist` snapshot / `git reset` + rebuild + restart | **practice only — NOT exercised in this packet** |

The code layer is stated as the weaker evidence it is: exercising it means
restarting Istvan's live dashboard at 02:00, and a rollback drill that causes the
outage it prevents is not a drill. Closing it means one rehearsal in a quiet
window, announced.

## 6. Against §8.8

| criterion | verdict |
|---|---|
| restore dry-run successful | **MET** — six steps, nine tests, red-capable |
| staging release proof successful | **PARTIAL** — migrations only (W11's copy-of-live proof); auth path, policy engine, tool execution, observability and release flow have no staging equivalent |
| canary flow works | **MET** — limit, abort, promotion gate, human resume, all tested |
| run integrity re-checkable | **MET** — written by the cycle, with a DB-level rule |
| failure alert works | **MET (pre-existing)** — `alertOutboundRecovery`, the cycle's `problems` + exit code, the daily reconcile findings |
| rollback / forward-fix runbook exercised | **PARTIAL** — two layers drilled, the code layer not (§5) |
| production readiness checklist green | see `PHASE_0_GO_NO_GO.md` |

## 7. Named gaps

1. **Two §8.6 metrics are still missing**: stale runs and unverified completion.
   Both are now cheap — the run ledger has the data — and neither is written.
2. **Staging parity is one of six dimensions.** Named in the audit, unchanged.
3. **The code-rollback rehearsal** (§5).
4. **The canary covers one behaviour.** It is a mechanism with one subject today;
   nothing enrols a future behaviour automatically.

## 8. Test results

```text
vitest run (full suite, 2026-08-26 02:10)
Test Files  579 passed (579)
Tests       7752 passed | 4 skipped (7756)
exit 0
```

Added: `src/cos/canary.ts`, `scripts/w14-restore-drill.ts`,
`docs/marveen/W14_ROLLBACK_RUNBOOK.md`, and the tests
`w14-run-integrity.test.ts` (11), `w14-policy-backup.test.ts` (12),
`w14-restore-drill.test.ts` (9), `w14-canary.test.ts` (11).

Changed: `src/cos/consumer-manifest.ts`, `src/cos/backup.ts`,
`scripts/cos-cycle.ts`, `scripts/cos-maintenance.ts`,
`scripts/progression-heartbeat-runner.ts`.
