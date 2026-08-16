# CoS v4.4 / ZST v1.2 / ACP v1.4.5 — hardening continuation

Date: 2026-08-16
Branch: `agent/cos-v44-acp145-replay-hardening`
PR: #20 (draft)
Baseline: PR #19 / Clean Replay & Reconciliation Gate v1.0

## Executive status

Stage 1 shared hardening is now **STRUCTURAL PASS / supervised only**. The three
previously release-blocking seams — root schema registration, structural TSCG
coverage for direct/manual progression, and shared external-outbound evidence
freshness — are implemented and covered by deterministic acceptance and full
regression proof.

This does **not** declare unattended readiness. Stage 2 still requires a real
Personal + ZST Clean Replay against a query-only snapshot of the live Marveen
store, and Stage 3 remains blocked until that authority-aware reconciliation is
green.

No production database was rebuilt or corrected. No email was sent by this work.
No payment, investment action or legal commitment was executed. No progression
mode was promoted. No PR was merged.

## CI / proof history

The earlier GitHub Actions billing/spending-limit incident was infrastructure-only
and was resolved before the final proof runs.

After billing recovery, the first real full suite exposed four localized legacy
regressions: one standing-source false positive around Actionability
`WAIT_SYSTEM`, plus three stale scope-gate tests that still expected content to
override connector identity. Those were corrected without weakening the new
namespace policy.

A later structural candidate exposed two additional fixture/gate-order classes:

1. low-level outbound executor tests bypassed the production send-flow and
   therefore lacked the production `case_version + OUTBOUND_DRAFTED` evidence
   horizon required by the new freshness gate;
2. a central TSCG check ran before domain ownership in a direct progression path,
   masking a cross-domain security assertion with a temporal refusal.

The fixes preserve the intended policy:

- low-level tests now construct the same evidence horizon as production rather
  than bypassing freshness;
- domain/case ownership is established before temporal reasoning, so a wrong
  domain is still recorded as `CROSS_DOMAIN_LEAKAGE`;
- every legitimate progression entry then reaches the shared TSCG before
  outcome-contract, resolver, planning or policy decisions;
- missing/invalid outbound authorization is refused before evidence diagnostics;
- a valid authorization is consumed only after the exact draft evidence horizon
  has been revalidated, so stale evidence neither calls the provider nor burns
  otherwise valid authority.

### Proven candidate

Structural commit:
`c655570d95659e416c6b718bbe974f85f04d0154`

Proof against the exact same repair workspace used for that commit:

- dependency install: PASS;
- TypeScript typecheck: PASS;
- deterministic hardening acceptance: **14 PASS / 0 FAIL / 0 UNKNOWN**;
- targeted proof for the four previously failing areas:
  **4 files / 67 tests PASS**;
- full Vitest regression:
  **548/548 test files PASS; 7,299 passed + 9 skipped = 7,308 total; 0 failed**;
- kernel contract: PASS on verification runs.

One fully green proof run created the structural commit locally but its push was
rejected non-fast-forward because the branch advanced while the long suite was
running. That was not a code/test failure. A subsequent run successfully
materialized the same proven candidate on the branch.

The temporary one-shot proof workflows and patcher were removed atomically in
`4c2ded8d6d91ddeb5b822d9f3c1f859df5d7e18d`; they are not part of the final PR
diff.

## Stage 1 — shared hardening status

### Implemented and structurally closed

- strict connector-identity Personal/ZST routing;
- provenance-bound `case_temporal_facts`;
- TSCG primitive with semantic-kind **and same-occurrence** checking;
- Hertz/Sixt semantic-deadline regression coverage;
- live heartbeat TSCG before progression policy;
- shared direct/manual progression TSCG coverage after domain ownership and
  before resolver/planning/policy;
- temporal-block telemetry separate from engine failures;
- shared Actionability classifier with fail-closed `ORPHAN`;
- CPP consumer manifest and explicit zero vocabulary;
- standardized `examined / matched / acted / failed / outcome / reason`
  telemetry, with unavailable counters represented as `UNKNOWN` rather than
  invented zero;
- generic evidence watermark primitive;
- final owner-question delivery freshness using exact packet/run watermark,
  case version and event sequence;
- same-second post-packet owner-event stale-evidence regression;
- shared Personal/ZST outbound evidence freshness using plan-time case version
  plus exact `OUTBOUND_DRAFTED` event horizon;
- shared freshness check at the common first/retry delivery chokepoint;
- central root `initCosSchema()` registration for temporal-fact and feature-run
  schema;
- ZST new-intake operational projection: next action + owner + semantic temporal
  evidence + actionability validation;
- deterministic `scripts/cos-v145-hardening-acceptance.py` release gate.

### Stage-1 interpretation

The previous three Stage-1 release blockers are closed. Stage 1 is therefore
**STRUCTURAL PASS**, but operation remains supervised because the historical/live
state has not yet passed Clean Replay and reconciliation.

A structural pass is not permission to increase autonomy. Progression mode,
action authorization, approval, finance/legal restrictions and external-effect
safety remain independent gates.

## Stage 2 — Clean Replay status

Tooling is implemented:

- immutable source contracts;
- isolated shadow SQLite;
- 60-day anchor + full-thread expansion;
- deterministic message/body/attachment hashes;
- deterministic multi-run replay history;
- authority-aware reconciliation;
- `autoApplyAllowed=false` for every correction proposal;
- query-only live SQLite snapshot exporter;
- fail-closed private + ZST Gmail corpus exporter using the runtime's existing
  local Google MCPs;
- operator CLI has no `--apply` or production-write option.

Read-only discovery already performed:

- private Gmail source census found 2,474 messages in the
  2026-06-17–2026-08-16 anchor, spam/trash excluded;
- connected Google Drive was searched for `claudeclaw.db`, Marveen backup and
  broader Marveen/backup artifacts;
- no usable current Marveen SQLite/production-store snapshot was found;
- specifications and the legacy ZST Control Tower are not substitutes for
  current production authority.

### Remaining Stage-2 gate

The real production-vs-shadow replay remains **BLOCKED / UNKNOWN** until the
Marveen runtime provides:

1. the normalized Personal + ZST immutable source corpus;
2. a query-only snapshot of the live Marveen store;
3. a real replay + authority-aware reconciliation report.

No production correction may be inferred from the absence of that runtime data.

## Stage 3 — correction / ZST canary status

Implemented tooling remains:

- authority-aware correction manifest;
- source-derived / production-authoritative / review-conflict classification;
- all corrections `autoApplyAllowed=false`;
- ZST migration planner:
  `DRY_RUN -> CANARY_2 -> CANARY_5 -> CANARY_10 -> REMAINDER`;
- safety refusal for send/payment/transfer/sign/automatic-close proposals.

No Personal production correction and no ZST canary mutation has been executed.
Starting either before a successful real Clean Replay and zero unresolved P0/P1
reconciliation finding would violate the agreed gate.

## Release interpretation

Current state is **Stage-1 structural green / supervised / draft only**.

Unattended-readiness still requires all of the following:

1. normal repository CI remains green on the clean implementation head;
2. real Personal + ZST Clean Replay against a query-only production snapshot;
3. zero unresolved P0/P1 reconciliation findings;
4. controlled, audited correction proposals with no automatic apply;
5. controlled ZST canary evidence (`2 -> 5 -> 10 -> remainder` only after the
   previous gate is green);
6. no new critical CPP, temporal, namespace, freshness or safety violation;
7. only then may the required 7-day stability window start;
8. any later promotion remains an explicit owner/admin decision, never an
   automatic consequence of passing these checks.
