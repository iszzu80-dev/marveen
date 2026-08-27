# Phase 1 / P3 — progress stage, separated from status

```text
PACKET: P3 (MIP-v1.0 §10, plan P3; audit §3.4)
Status: DONE — local. Not released: no push, no CI round.
Commits: 64d77125 (build), 2f078236 (owner closure)
```

## Implemented

`progress_stage` as a derived canonical column —
`ACTIONABLE | WAITING | NEEDS_USER | MONITORING | COMPLETED` — projected onto the
case board as `proj_progress_stage`. The 17 personal and 21 ZST domain statuses
are untouched: they carry operational meaning the owner reads, and the stage is a
second, coarser question asked of the same case.

**The stage is not a status lookup.** The first version was, and it passed every
test written for it. The owner's closure named the defect: *"a stage a canonical
progression facts összegzett állapota legyen. A status lehet egyik bemenet, de nem
az egyetlen."* Two cases with the same business status are not in the same place
if one has an active typed wait and the other does not. The precedence, in his
order:

| stage | when |
|---|---|
| `COMPLETED` | evidence-backed terminal completion only |
| `NEEDS_USER` | unresolved decision/approval, or a human-recovery gate |
| `WAITING` | an active, unresolved typed wait |
| `MONITORING` | an explicit monitoring state |
| `ACTIONABLE` | an executable next action, and none of the above |

Facts come from five canonical sources: `canCompleteCase` **as the ENGINE**
(the owner branch returns true unconditionally and would make every closed-looking
case structurally COMPLETED), `cos_owner_questions`, `case_escalations`, the
recovery queue, the typed wait condition, and the next-best-action kind.

Null when nothing can be claimed. An empty cell is honest; `ACTIONABLE` would be a
claim that something can be done.

## Existing capability reused

The P1 projection writer and `PROJECTED_COLUMNS`; P2's typed wait condition; the
completion gate; the recovery queue. No new table, no new status.

## What had to be built first

The ZST status vocabulary existed **only** as a literal inside the `zst_cases`
CHECK string, so anything that needed to know the ZST statuses re-declared them —
the exact duplication the comment above the personal `CASE_STATUSES` says it
exists to prevent. P3's acceptance requires the mapping to derive from the code
that defines the statuses; on the ZST side there was no such code. `ZST_CASE_STATUSES`
is now exported and the CHECK is **built from it**, so the two cannot drift.

## Tests added

`src/__tests__/cos-progress-stage.test.ts`. The mapping is total by TYPE
(`Record<Status, Stage>` per namespace: an unmapped status fails the build), and
the acceptance test reads the **live CHECK constraint out of `sqlite_master`**
rather than a hard-coded list, asserting the code vocabulary and the constraint
are the same set in both directions.

Negative tests: the owner's five counter-examples, three of which are the *same
business status* three times — the thing a status table cannot express. Plus a
`NEEDS_HUMAN` recovery row outranking a `RECOVERY_REQUIRED` status, with a control
asserting the same case IS actionable without that row, so the test measures the
fact and not the status.

Two judgements beyond his list, both pinned by test: a non-retryable CAPABILITY
wait is `NEEDS_USER` (no probe will ever end it, and the retryable one is the
control); `ACKNOWLEDGED` escalations count as unresolved — somebody has seen it,
which is not somebody having decided.

## Migration

`ALTER TABLE` for `proj_progress_stage`. No backfill: the column fills on each
case's next progression run, and a backfill would write today's derivation over
rows whose facts have not been re-read.

## Rollback

Drop the projected column. Nothing reads it as a precondition; the domain statuses
are unchanged, so the board degrades to what it showed before.

## Security impact

None. No new egress, no new capability, no sensitivity-class change.

## Evidence

590 files / 7951 tests / 0 failures, `tsc` clean. Six mutations driven red, one
per precedence rule.

**A second defect this packet found, and the reason its tests read the database:**
`writeProjection` typed its six SET assignments by hand while the READ built its
list from `PROJECTED_COLUMNS`. `proj_progress_stage` was added to the constant,
the type, the schema and the deriver, the whole mapping suite went green — and the
column was never written, because the one place that actually writes had its own
copy. Three tests caught it, and only because they read the DATABASE rather than
the returned object. The SET clause is now built from the constant.

## Known limitations

The stage is derived at progression time. A case whose facts change without a
progression run keeps its last stage until the next run or the reconcile sweep —
the same window `last_reconciled_at` exists to make visible, not a new one.

## Next packet readiness

P4 built on this; P6 needs it for the lifecycle assertions.
