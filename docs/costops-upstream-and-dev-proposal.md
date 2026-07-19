# CostOps: Upstream Proposal + Development Suggestion

Analysis of `costops-core-functional-scope-v1.0.1.md` + `costops-core-v1.0.1-gap-analysis.md` (Istvan, 2026-07-15). Companion to `fork-upstream-policy.md` and `v1220-merge-plan.md`.

## 1. Analysis — where CostOps v1.0.1 actually stands

**DONE (verified, keep):** default Simplify & Trust dashboard; ledger base (`cost_sources`/`cost_line_items`, dedup, confidence, freshness); operational-spend vs usage-equivalent-opportunity-cost vs entitlement separation; forecast + budget baseline; amount-weighted data-quality; freshness-gate; reconciliation delta 0; legacy v1 rollback; browser+API verification.

**The real gaps are accounting integrity, not visuals** (gap-analysis §4). Grouped:
- **PARTIAL:** source lifecycle/provenance normalization (GAP-03), canonical ledger schema — FX/service-vs-billing-period/correction/audit lineage (GAP-05), double-counting/formal reconciliation (GAP-06), collector durability — idempotency/checkpoint/retry/partial-failure (GAP-07), FX provenance/freeze (GAP-09), forecast accuracy measurement (GAP-10), multi-level budget (GAP-11), subscription/entitlement detail (GAP-16), manual void-vs-delete (GAP-15), exports (GAP-18), security/permission formalization (GAP-19).
- **MISSING:** deterministic alert lifecycle (GAP-12), period close/reopen (GAP-13), invoice/credit/refund/correction workflow (GAP-14), aggregate optimization advisor (GAP-17).
- **OUT OF SCOPE (do not build):** agent/task/product cost attribution, prompt/session ROI, model/provider routing, #517, auto model/provider switching.

## 2. Upstream proposal (this is the key refinement)

The docs (scope §21, gap GAP-20) are explicit and **revise our earlier "finish upstreaming CostOps now" stance**:

- **Local-first.** Stabilize the product locally through the phases FIRST. Upstream is **Phase 6**, after stabilization — not now.
- **Do NOT bloat the existing #524 PR.** Further upstreaming is **separate, small, independently-reviewable PRs**, one generic slice at a time.
- **Upstream only the 7 generic slices** (no product, no pricing, no config):
  1. provenance / confidence / freshness data model
  2. import-run / durable checkpoint / idempotency
  3. generic collector contract (interface)
  4. correction + reconciliation model
  5. period close / reopen
  6. budget + alert data model
  7. normalized export
- **Stays local forever:** credentials, real accounts, real pricing, concrete subscriptions, local budgets, provider account mapping, local adapter config, local cost policy.

**Sequencing of the upstream slices** = follows the phase dependency; a slice only upstreams once it has stabilized locally. First candidate is slice (1) provenance/lifecycle/freshness — it is foundational, fully generic, and aligns with upstream's existing token-monitor direction (#573) — but only after Phase 0-1 harden it.

**Interaction with the v1.22.0 merge:** unchanged and confirmed — CostOps files resolve **take-ours** (our local is the superset of the upstreamed #524 base; upstream's token-monitor #573/#583 by *Jónás Gergő* is the one genuine graft). So: do the v1.22.0 merge (Stage 2, take-ours) FIRST to get current + absorb the token-monitor, THEN build Phase 0 on the merged base. This satisfies `fork-upstream-policy.md`: continuously updatable, generic slices contributed back incrementally.

## 3. Development suggestion — next sprint

**Phase 0 — Baseline Formalization & Source Lifecycle** (the docs' explicit recommendation; low risk, high value, foundational — everything downstream depends on it):

1. **OpenAI API lifecycle fix (immediate, do first).** GAP-03/P0.1: OpenAI must be `inactive`/`not_configured`, NOT `credential_error`. **Verified 2026-07-15: the key WORKS (org Costs API HTTP 200, ~$0 spend)** — so the "invalid/401" state is doubly wrong. This also closes card **7f5a7fc9**. One concrete win that de-risks the whole source model.
2. Unified lifecycle enum (`active|inactive|not_configured|unsupported|blocked|deprecated`), separated from provenance (`provider_api_actual|invoice_actual|imported_actual|manual_actual|calculated_estimate|unknown`).
3. Full source inventory API/report; per-source owner/blocker/freshness/cadence/inclusion-rule/manual-fallback.
4. `73e8914a` decision: **recommend audited void/archive, not hard DELETE** for financial rows.
5. Start the 7-day reliability observation; baseline semantics regression tests.
- Explicitly NOT in Phase 0: dashboard redesign, close/reopen, big ledger migration, optimization advisor, attribution, routing, upstream PR.

**Owner:** fullstackfejleszto/Mason (built CostOps, has the upstream/costops-pr worktrees) with the two docs as the spec; Marveen coordinates + verifies. Sequence: v1.22.0 merge (take-ours) → Phase 0 → Phase 1 …; upstream generic slices land as small PRs from Phase 6 (and opportunistically once a slice is stable).

**Priority ladder (from gap-analysis):** P0 baseline formalization → P1 accounting integrity → P2 monthly accounting (invoice/close) → P3 cost control (budgets/alerts) → P4 optimization advisor.
