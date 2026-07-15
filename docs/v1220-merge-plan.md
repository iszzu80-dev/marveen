# v1.22.0 Full-Merge Plan (grounded in the real conflict map)

Companion to `fork-upstream-policy.md`. Authored 2026-07-15.

## Accurate conflict inventory

A real `git merge 6856fe7` (v1.22.0) into the current work branch conflicts in **13 files**
(the earlier "28" was conflict *hunks* estimated on a different branch, not files):

| Group | Files | Upstream driver |
| --- | --- | --- |
| **Cost ledger collision** | `src/costops/ledger.ts`, `src/costops/config.ts`, `src/web/routes/costs.ts`, `src/__tests__/costops-{api,ledger}.test.ts`, `src/costops/README.md` | **#524** upstream built its OWN `src/costops/` local cost ledger, in the SAME paths as ours (ours: c93060d). Two parallel cost-ledger implementations. |
| **Token-monitor overlap** | `src/web/token-usage.ts`, contributes to `src/db.ts`, `web/app.js`, `web/lang/en.js` | **#573/#583** upstream token-monitor: per-model cost accuracy, MCP cost columns. Overlaps our CostOps dashboard. |
| **Core DB/wiring** | `src/db.ts` (also #579 security guards, #545 memory recency), `src/web.ts` (#599/#570/#569/#565 hooks+fleetq) | schema + route-registration collisions |
| **Dashboard frontend** | `web/app.js`, `web/lang/en.js` (#596 BOT_NAME, #568 macOS channel) | our CostOps v1.0.1 dashboard vs upstream dashboard edits |
| **Fleet scripts (trivial)** | `scripts/host-restart-watchdog.sh`, `scripts/unit-fail-notify.sh` | **#530** WSL host stability |

**Headline:** the merge is dominated by a **cost/token subsystem collision** — upstream independently
built a cost ledger + token-monitor overlapping our (much richer) CostOps. That is the real work.
Everything else (2 scripts, db/web wiring, dashboard) is mechanical.

## The one real decision

Our CostOps (v1.0.1: live collectors, email-invoice ingest, period/subscription/warnings/export,
Simplify-and-Trust dashboard) is far more built-out than upstream's #524 (local ledger + monthly
summary) and #573 (token-monitor). Options:

- **(Recommended) Keep-ours + graft:** our CostOps stays the product; take upstream's genuinely useful
  bits (token-monitor per-model accuracy, MCP cost columns) as complementary data, drop/merge the
  overlapping ledger scaffolding in favour of ours. Resolve shared files toward our implementation.
- Adopt-upstream: throw away our richer CostOps for upstream's simpler one. Rejected (loses months of work).

**And do the CostOps refactor here:** as part of this merge, move CostOps behind a thin mount seam in
isolated modules (per `fork-upstream-policy.md` section 2), so future upstream pulls stop conflicting on it.

## Staged execution

- **Stage 1 (low risk, do first):**
  - Resolve the 2 trivial fleet-script conflicts against upstream #530.
  - Push our generic fleet fixes as small upstream PRs (message-router hardening, inter-agent
    `origin_note`, kanban label-alias, message `delivered_at` backfill, agent-cap default). Shrinks
    our local delta so the core merge is smaller.
- **Stage 2 (the hard core):** cost/token reconciliation + CostOps refactor into isolated modules.
  Owner: fullstackfejleszto/Mason (built our CostOps, already has `upstream/costops-pr1/pr2` +
  `local/costops-*` worktrees staged) with architect/Atlas oversight. Isolated worktree, tested.
- **Stage 3:** reconcile core wiring (`src/db.ts` schema, `src/web.ts` routes) + dashboard
  (`web/app.js`, `web/lang/en.js`). Adopt upstream security guards (#579) and hooks fixes.
- **Stage 4:** full `vitest run` green + boot dashboard on a scratch port + smoke test → land →
  push. Keep prior commit as instant rollback. Dashboard restart announced.

## Not started yet — awaiting Istvan's greenlight on: the split above + the keep-ours+graft principle.
