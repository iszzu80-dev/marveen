# Card 73e8914a -- manual-entry DELETE: hard delete vs. auditable void/archive

**Decision date:** 2026-07-15
**Status:** Decided and implemented (CostOps Phase 0)
**Owner:** fullstackfejleszto/Mason, per Marveen's Phase 0 dispatch and the
gap-analysis's own recommendation (`core-v1.0.1-gap-analysis.md` GAP-15).

## The question

`DELETE /api/costs/manual` (card 73e8914a) originally hard-deleted the
`cost_line_items` row via `DELETE FROM cost_line_items WHERE dedup_key = ?`.
The card's own original comment argued this was correct: "a removed manual
entry has no ongoing meaning worth retaining a tombstone for."

The gap-analysis (`core-v1.0.1-gap-analysis.md`, GAP-15 "Manual cost
management") revisited this and recommended the opposite: **auditable
void/archive, not hard DELETE, for financial rows.**

## Decision

**Void/archive, not hard delete.** Reversed the original 73e8914a stance.

### Why

1. **Accounting integrity principle** (functional-scope doc §6, §15): "a
   pénzügyi előzmény nem tűnik el nyomtalanul" -- a financial history must
   not disappear without a trace. A hard DELETE on a cost row is
   irreversible by construction: if a manual entry is removed by mistake (or
   maliciously), there is no way to recover what it was, who entered it, or
   why it was later considered wrong.
2. **Future period-close and reconciliation phases depend on it.** Phase 1's
   correction/reconciliation model and Phase 5's monthly close both assume
   every ledger change is traceable. A hard-delete history gap would have
   forced re-litigating this decision later, under more time pressure and
   against live data.
3. **Low implementation cost, additive schema.** The fix is two nullable
   columns (`voided_at`, `void_reason`) plus a `dedup_key` rename on void --
   no migration of existing rows, no behavior change for anything that isn't
   a manual-cost delete. This fits Phase 0's "additive/low-risk" scope
   (functional-scope doc §21) rather than requiring Phase 1's "nagy ledger
   migration" (explicitly out of Phase 0 scope).
4. **User-visible behavior is unchanged.** A voided entry is excluded from
   every read path (`getCostSummary`, `getPeriodTrend`, `exportCostRows`,
   the `pending_permission` warning query) exactly like a hard-deleted row
   would be -- the dashboard, forecast, and export totals look identical
   before and after this change for a legitimate delete. Only the DB row's
   survival (for audit) and the ability to safely re-enter the same
   source/month afterward differ.

### What changed (implementation)

- `cost_line_items` gained `voided_at INTEGER` and `void_reason TEXT`
  (nullable, additive `ALTER TABLE`, no default -- NULL means "active",
  which is every existing row).
- `deleteManualCost()` (`src/costops/manual-entry.ts`) no longer runs
  `DELETE`. It sets `voided_at`/`void_reason` and renames `dedup_key` to
  `<original>|voided|<timestamp>`, freeing the original key for a fresh,
  independently-audited POST. Idempotency guard: voiding an already-voided
  entry 409s (`is already voided`) instead of silently re-voiding it.
- Every read path that aggregates `cost_line_items` now filters
  `voided_at IS NULL`: `getCostSummary`'s two queries (current + previous
  month), `getPeriodTrend`, `exportCostRows`, and the `billing_access_needed`
  pending-permission query in `warnings.ts`.
- `createManualCost()`'s existence check is unaffected by design: because
  voiding renames the row's `dedup_key`, a fresh POST for the same
  source/month naturally finds no conflict, without needing an explicit
  `voided_at IS NULL` filter there.

### What is explicitly NOT in this change (deferred to later phases)

- No `actor` field yet (who voided it) -- GAP-15's full audit-trail
  requirement ("minden módosításhoz actor... tartozik") is Phase 1 scope.
  `void_reason` alone is captured now; wiring a real actor identity through
  the Bearer-token layer is a separate, larger change.
- `deleteManualEntitlement()` (a different table, `entitlements`) is
  **unchanged, still a hard DELETE.** Entitlements are usage/quota facts, not
  monetary ledger rows -- the gap-analysis's "pénzügyi sorok" (financial
  rows) framing does not extend to them. Revisit only if a future gap
  analysis reclassifies entitlement history as financially significant.
- No UI surface for "show voided entries" / "un-void" yet -- this is a
  backend/data-model decision; a drill-down view is a dashboard-layer
  follow-up, not required for Phase 0's acceptance criteria.
- No supersede/correction relationship modeling (linking a void to whatever
  correct entry replaces it) -- that is Phase 1's "correction relationship"
  (GAP-05/GAP-14) work; today a void and its replacement POST are two
  independent rows, correlated only by matching `source_id`/`month` and
  timing, not an explicit foreign key.
