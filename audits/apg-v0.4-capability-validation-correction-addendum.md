# APG v0.4-lean — Capability Validation Correction Addendum

Date: 2026-07-16 · Mode: READ-ONLY (no implement, no commit, no dispatch, no deploy). Does NOT overwrite the original 5 deliverables.
Purpose: resolve the summary's internal contradictions, correct 4 misclassifications, honest-label the token result, add a second (full-stack) shadow replay, and define the minimal Pilot Kernel.

## 0. What was wrong in the first pass (owned)
- **Two different UPSTREAM_GAP lists** (capability-count said intel/staging/authenticated-identity; the P0 list said token-origin/CostOps-resolver/overclaim). Those were two framings never reconciled. Fixed below into ONE canonical table.
- **Intel registry called UPSTREAM_GAP — WRONG.** It EXISTS: `scripts/intel_db.py` (schema + Python API + argparse CLI), `store/intel.db`, `docs/intel-registry.md`, tests, `intel-collector`/`intel-daily-brief` scheduled tasks. 4 tables: `known_facts_registry` (dedup via UNIQUE `fact_hash` + deterministic fact-id; lifecycle new→evolving→stable→closed; priority_score; expires_at), `watchlist`, `decision_log` (recommendation/reasoning/assumption/evidence/what_would_falsify/outcome), `active_focus`. Reclassified AVAILABLE.
- **Overclaim gate put at P0 — WRONG.** It is an OPTIONAL_IMPROVEMENT / profile capability, not a Pilot-Kernel prerequisite. Renamed `claim-provenance-and-overclaim-review`.
- **Token "AS-IS ~1500 = APG ~1500" implied a saving — it does not.** Relabeled MEASURED/ESTIMATED/UNKNOWN below; the fresh-input-reduction claim is RETRACTED to UNKNOWN pending instrumentation.
- Dropped the "3 full + 3 partial" fudge; capabilities are atomic below.

## 1. Canonical capability table (atomic; one primary category each)

| Capability | Local evidence | Category | Reason | APG prio | Target | Pilot-Kernel? |
|---|---|---|---|---|---|---|
| kanban-artifact-store (create/update/comment/event) | `kanban_cards/comments/card_events/card_labels`, `/api/kanban*` | AVAILABLE | full CRUD + events present | P0 | local | YES |
| agent-dispatch | `/api/messages` (+origin_note) | AVAILABLE | live bus | P0 | local | YES |
| agent-readiness | `/api/agents` runState/contextTokens | AVAILABLE | live | P0 | local | YES |
| token-raw-usage (input/output/cache_read/cache_creation) | `token_usage` table + CostOps ledger.ts | AVAILABLE | aggregate captured | P0 | local | YES (measurement) |
| token-origin-decomposition (system/inherited/apg-fresh/on-demand split) | NOT tagged today | ADAPTER | raw exists, origin-tag layer missing | P0 | local | YES (else no budget proof) |
| costops-cost-limits-ledger | CostOps full ledger + collectors (+codex rate-limit) | AVAILABLE | live | P1 | local | no |
| costops-capacity-resolver (capability-class→provider) | CostOps exists; resolver interface missing | ADAPTER | thin exposure of existing data | P1 | local | no |
| intel-registry (facts/dedup/lifecycle/decision-log) | `scripts/intel_db.py`, `store/intel.db`, 4 tables | AVAILABLE | full system exists | P2 | local | no |
| intel-APG-reference-query-adapter (get-by-id/domain for context-packet) | `get_active_registry` exists; APG-contract query missing | ADAPTER | references-first needs a bounded query API | P2 | local | no |
| git-commit-evidence | git (local+origin) | AVAILABLE | live | P0 | local | YES |
| build-deploy-evidence | Render deploy-history API | AVAILABLE | live | P0 | local | YES |
| runtime-evidence | `/health` | AVAILABLE | live | P0 | local | YES |
| execution-receipt-chain (commit→build→deploy→runtime link) | sources exist, NOT auto-linked | ADAPTER | release_ready gate needs one linked receipt | P0 | local | YES (S2 replay) |
| generic-release-strategy+evidence-contract | ad-hoc today | ADAPTER | formalize the contract, provider-agnostic | P1 | upstream(generic) | no |
| provider-deployment-adapter (Render) | Render API exists | ADAPTER | generic deploy-adapter interface over it | P1 | local (NOT core-infra) | no |
| staging/canary-infrastructure | Render preview (cost-excluded); no systematic canary | UPSTREAM_GAP | genuinely absent; do NOT add provider-infra to core | P2 | upstream | no |
| apg-test-identity-contract (actor/tenant/data/test_run/env + KPI-exclude/suppress/cleanup) | origin_note seed only | ADAPTER | generic contract missing; S2 auth/tenant needs isolation | P0 | upstream(generic) | YES (S2 replay) |
| marveen-service/agent-authentication | bus is self-declared/unauth (card 06f062e4) | UPSTREAM_GAP | real hardening, separate from the APG contract | P2 | upstream | no |
| product-local-auth/tenant/analytics-marker | per-product JWT/tenant (e.g. Eskuvo JWT-tenant migration) | PRODUCT_LOCAL | per-product shape, not shared | P1/product | product | per-product |
| per-product-surface-state-model | landing/demo/(pre)reg/login/app per product | PRODUCT_LOCAL | varies per product | P1/product | product | per-product |
| claim-provenance-and-overclaim-review | standing red-flag list (manual tonight) | OPTIONAL_IMPROVEMENT | valuable profile check, NOT a kernel prereq | opt | local (profile) | no |

## 2. Corrected capability count by category
- AVAILABLE: 9 (kanban, dispatch, readiness, token-raw, costops-ledger, intel-registry, git, build-deploy, runtime)
- ADAPTER: 7 (token-origin, capacity-resolver, intel-APG-query, execution-receipt-chain, release-strategy-contract, provider-deploy-adapter, test-identity-contract)
- UPSTREAM_GAP: 2 (staging/canary-infrastructure, service/agent-authentication)
- PRODUCT_LOCAL: 2 (product-auth-marker, per-product-surface)
- OPTIONAL_IMPROVEMENT: 1 (claim-provenance-and-overclaim-review)
- BLOCKED: 0

**Canonical UPSTREAM_GAP list (the single authoritative one):** `staging/canary-infrastructure`, `marveen-service/agent-authentication`. (Intel registry removed — AVAILABLE. Token-origin & CostOps-resolver are ADAPTER. Overclaim is OPTIONAL_IMPROVEMENT.)

## 3. Token result — MEASURED / ESTIMATED / UNKNOWN
- **MEASURED**: per-turn aggregate `input / output / cache_read / cache_creation` — Claude API usage + `token_usage` table + CostOps ledger. Real sample this session (Codex probe): input 12271, cache_read 9984, output 14.
- **ESTIMATED**: the ~1500 "fresh-input" for the landing decision — an estimate, NOT instrumented (no origin tagging exists).
- **UNKNOWN**: (a) the inherited mega-session size expressed in APG-origin terms; (b) the fresh-vs-inherited split of any turn's `input` (today it is one opaque number); (c) whether `system_and_tools` is separable from `inherited` (bundled today); (d) occupied-context vs cache-read are conflated in the single `input` figure.
- **Instrumentation required in the first pilot**: origin-tag input tokens into system_and_tools / inherited_context / apg_packet_fresh / on_demand_fresh. WITHOUT it, no fresh-input-reduction claim is provable.
- **Corrected hypothesis (unproven, to test in pilot)**: APG's benefit is NOT lower fresh input (already small) — it is lower **occupied/inherited context** by decoupling a change from a mega-session. "AS-IS ~1500 = APG ~1500" proves nothing; it must be measured with the instrumentation above. Claim RETRACTED to UNKNOWN.

## 4. Second shadow replay (full-stack, side-effect-free)
**Change:** Eskuvo/LumaSeat JWT-tenant-id migration + stale-session fix (cards 2dcd216c migrate tenant_id JWT-string→real UUID, e292a853 stale-session replication, edf55863 per-product smoke-test). A real, shipped full-stack change.
- Frontend journey: organizer login/session flow. Backend/API: JWT decode + tenant resolution. Mock/test data: smoke-test tenants. Auth/tenant context: YES (core of the change). Test: per-product smoke (edf55863). Build+deploy+runtime: suite-api-08wb deploy + health.
- **Complexity class: S2** — raise_risk signals present: `authentication_or_authorization` + `tenant_isolation` + `database_migration`. Max agents 2, semantic_review = one independent verifier.
- **Active profiles**: `ui-fullstack` + `identity-test-data` (auth/tenant → test-identity isolation MUST be active) + `safe-release` (migration = higher-risk tier: verify migration reversibility + smoke before/after).
- **Required artifact/evidence trace**: requirement→change→work_item→implementation(commit)→**execution-receipt (commit→build→deploy→runtime)**→verification(smoke matrix + identity-isolation pass)→release(rollback-ready)→review(one independent verifier, S2).
- **Max agent budget**: 2 (1 producer + 1 independent verifier for the auth/migration risk).
- **Missing evidence today**: (a) no linked execution-receipt (chain-linking ADAPTER); (b) no structured test-identity assertion (identity-contract ADAPTER) — critical here because auth/tenant is the change itself; (c) migration-reversibility not captured as a release artifact.
- **Test-identity handling**: the smoke tenants must carry actor/tenant/data/test_run/env markers with KPI-exclusion + billing/comms suppress + cleanup — TODAY origin_note only; the identity-contract ADAPTER is the P0 that this replay actually exercises.
- **Build→deploy→runtime provenance**: sources exist (git+Render+/health) but unlinked → the execution-receipt ADAPTER is the P0.
- **AS-IS vs APG context (ESTIMATED)**: AS-IS rode the fleet session (large inherited). APG S2 packet target ≤5000 fresh; ESTIMATED actual ~2500–3500 fresh (auth+tenant+migration context). Reduction claim UNKNOWN until instrumented (§3).

## 5. Minimal Pilot Kernel (only what's needed for ≥1 replay to run authentically)
The two replays (S1 landing, S2 JWT-tenant migration) run on the AVAILABLE substrate PLUS exactly three ADAPTERs:
- **P0 (first pilot — without these a replay cannot run authentically):**
  1. `execution-receipt-chain` (commit→build→deploy→runtime linking) — S2 release_ready gate is undeterminable without it.
  2. `token-origin-decomposition` instrumentation — without it the whole AS-IS-vs-APG comparison (the pilot's point) is unmeasurable.
  3. `apg-test-identity-contract` — S2 is an auth/tenant change; identity-isolation must be assertable.
  (The AVAILABLE substrate — kanban-artifact-store, dispatch, readiness, git/build/deploy/runtime evidence, token-raw — is prerequisite but already present.)
- **P1 (after the staging pilot):** costops-capacity-resolver, generic-release-strategy-contract, provider-deployment-adapter, product-local-auth-marker, per-product-surface-model, scheduler-hook.
- **P2 (later Product LCM):** staging/canary-infrastructure, service/agent-authentication, intel-APG-reference-query-adapter.
- **OPTIONAL_IMPROVEMENT:** claim-provenance-and-overclaim-review (high value/low cost, but NOT a kernel gate).

## 6. FINAL (per spec)
- **Addendum location:** `audits/apg-v0.4-capability-validation-correction-addendum.md`
- **Corrected capability count:** AVAILABLE 9 · ADAPTER 7 · UPSTREAM_GAP 2 · PRODUCT_LOCAL 2 · OPTIONAL_IMPROVEMENT 1 · BLOCKED 0
- **Canonical UPSTREAM_GAP list:** staging/canary-infrastructure; marveen-service/agent-authentication
- **P0 Pilot Kernel:** execution-receipt-chain; token-origin-decomposition instrumentation; apg-test-identity-contract (on the already-AVAILABLE kanban/dispatch/readiness/git-build-deploy-runtime/token-raw substrate)
- **Second shadow replay change:** Eskuvo/LumaSeat JWT-tenant-id migration + stale-session fix (2dcd216c/e292a853/edf55863)
- **Complexity class + profiles:** S2; ui-fullstack + identity-test-data + safe-release
- **Token data:** MEASURED = aggregate input/output/cache_read/cache_creation; ESTIMATED = ~1500 (S1) / ~2500–3500 (S2) fresh-input; UNKNOWN = fresh-vs-inherited split, inherited mega-session size, system/tool separability → fresh-input-reduction claim RETRACTED to UNKNOWN pending origin-tag instrumentation
- **Overclaim gate final classification:** OPTIONAL_IMPROVEMENT, renamed `claim-provenance-and-overclaim-review` (profile capability, not a kernel prerequisite)
- **Verdict:** **READY_FOR_PILOT_KERNEL_SPEC** — contradictions resolved, capabilities atomic + single-category, intel registry corrected to AVAILABLE, minimal P0 kernel = 3 adapters over an already-present substrate, second full-stack replay defined. Caveat carried into the spec: the token-reduction hypothesis stays UNKNOWN until the token-origin instrumentation (a P0 item) is built and the first pilot measures it.
