# CoS v4.4 / ZST v1.2 / ACP v1.4.5 — hardening continuation

Date: 2026-08-16
Branch: `agent/cos-v44-acp145-replay-hardening`
PR: #20 (draft)
Baseline: PR #19 / Clean Replay & Reconciliation Gate v1.0

## Executive status

This continuation does **not** declare unattended readiness. It closes additional
runtime seams, turns several paper-only invariants into live gates, and records
the remaining blockers explicitly.

No production database was rebuilt or corrected. No email was sent by this work.
No payment, investment action or legal commitment was executed. No progression
mode was promoted. No PR was merged.

## CI billing incident — resolved

The earlier GitHub Actions failure was infrastructure-only: GitHub refused to
start runners because of account billing/spending-limit state. The account was
upgraded and the same workflow was re-run successfully on real runners.

The first real full suite after billing recovery reached:

- kernel contract: PASS;
- dependency install: PASS;
- TypeScript typecheck: PASS;
- full Vitest suite: executed;
- result: 4 failing tests out of 7,290, all localized.

The four real failures were:

1. a standing source scan treated the Actionability class named `WAIT_SYSTEM` as
   a progression decision producer;
2. three legacy scope-gate tests still expected the withdrawn rule that content
   could override connector identity and route a private-mailbox message to ZST.

Corrections:

- Actionability preserves the external `WAIT_SYSTEM` class but no longer contains
  the engine-only decision literal in a way the standing decision-producer scan
  can mistake for authority;
- scope-gate tests now prove the v1.2 rule: connector identity decides the
  automatic namespace, content can only flag mismatch/review, never cross-route.

Subsequent CI runs are required to be fully executed and green before release.

## Stage 1 — shared hardening status

### Implemented

- strict connector-identity Personal/ZST routing;
- provenance-bound `case_temporal_facts`;
- TSCG primitive with semantic-kind checking;
- TSCG now also requires the **same temporal occurrence**, not merely the same
  kind (a verified decision next Tuesday cannot satisfy an explicit decision
  deadline today);
- live progression heartbeat evaluates TSCG after a real trigger is identified
  and **before** calling progression policy;
- heartbeat reports `temporalBlocked` and bounded `temporalBlockReasons` rather
  than misclassifying policy refusals as engine crashes;
- Hertz/Sixt runtime regression fixtures, including:
  - decision date only in prose;
  - pickup date cannot satisfy decision deadline;
  - same kind / wrong timestamp cannot satisfy claim;
  - matching kind + occurrence permits progression;
- shared Actionability classifier with fail-closed ORPHAN;
- CPP consumer manifest and explicit zero vocabulary;
- `cos-cycle` now attaches standardized CPP telemetry to every subprocess step:
  `examined / matched / acted / failed / outcome / reason`;
- legacy steps that expose no reliable counters become `UNKNOWN`, never invented
  `NO_DATA=0`;
- generic evidence watermark primitive;
- final owner-question delivery now reconstructs a watermark from the exact
  evidence packet + progression run and validates both case version and event
  sequence before Telegram delivery;
- an owner event arriving later in the **same second** as the evidence packet is
  intentionally excluded from the old evidence horizon and therefore blocks the
  stale question (the second-granularity version of the real 37-second bug);
- stale/unknown owner delivery is not marked sent and is surfaced through a
  `staleBlocked` counter;
- ZST new-intake operational projection remains in place: next action + owner +
  semantic temporal evidence + actionability validation.

### Still release-blocking

1. **Central schema registration**
   - new shared tables still bootstrap idempotently from their feature modules;
   - they are not yet registered directly in the root `initCosSchema()` seam;
   - intentionally not hidden inside unrelated `ensureLadderSchema()` ownership.

2. **TSCG on non-heartbeat/direct progression entry points**
   - the production scheduled heartbeat is gated;
   - the invariant is not yet structurally guaranteed for every hypothetical
     direct/manual caller of `runProgressionCycle`.

3. **External outbound evidence freshness**
   - owner-question final delivery is gated;
   - email dispatch still needs the same generic freshness invariant at the
     shared outbound chokepoint;
   - the shared executor has the correct structural location: every first/retry
     delivery transitions `PLANNED|FAILED_RETRYABLE -> SENDING` immediately before
     `adapter.send()`; recovery paths return before that point and must remain
     available because they send nothing.

The intended implementation is therefore a shared outbound evidence watermark
plus an admission-time freshness check at that chokepoint, not duplicated logic
in Personal and ZST send flows. It must be installed together with the central
schema seam so a new caller cannot route around it.

## Stage 2 — Clean Replay status

Tooling remains implemented:

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

Additional read-only discovery performed during this continuation:

- connected Google Drive was searched for `claudeclaw.db`, Marveen backup and
  broader Marveen/backup artifacts;
- no usable Marveen SQLite/production-store backup was found;
- the Drive contains specifications and the legacy ZST Control Tower, which are
  not substitutes for current production authority.

Therefore the real production-vs-shadow replay remains `BLOCKED/UNKNOWN` until a
query-only snapshot is exported on the Marveen host.

## Stage 3 — correction / ZST canary status

Implemented tooling remains:

- authority-aware correction manifest;
- source-derived / production-authoritative / review-conflict classification;
- all corrections `autoApplyAllowed=false`;
- ZST migration planner:
  `DRY_RUN -> CANARY_2 -> CANARY_5 -> CANARY_10 -> REMAINDER`;
- safety refusal for send/payment/transfer/sign/automatic-close proposals.

No Personal production correction and no ZST canary mutation has been executed.
Starting either before a successful real Clean Replay + zero unresolved P0/P1
reconciliation finding would violate the agreed gate.

## Release interpretation

Current state is **supervised hardening / draft only**.

A release/readiness claim requires all of the following:

1. fully executed green CI on the final head;
2. central shared schema registration;
3. TSCG structural coverage for every progression entry;
4. generic evidence freshness at owner-facing **and external outbound** first
   delivery chokepoints;
5. real Personal + ZST Clean Replay against a query-only production snapshot;
6. zero unresolved P0/P1 reconciliation findings;
7. controlled ZST canary evidence;
8. only then may the 7-day stability window start.
