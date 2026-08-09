# APG v0.4-lean — Local Capability Map (Marveen)

Date: 2026-07-16
Methodology version: 0.4.0 (apg-methodology-v0.4-lean.zip)
Conformance verdict: **PASS** (`python3 conformance/validate_pack.py` — 0 errors; 12/12 valid + 12/12 invalid artifact fixtures, graph/edge/reference checks pass, agent-budget policy pass, no-vendor-hardcode pass).
Mode: READ-ONLY. No implementation, no cards, no dispatch, no commit/PR/upstream, no CLAUDE.md/skill/scheduler/service change, no deploy.
Predecessor: this pack is the lean refinement of `design/2026-07-13-marveen-autonomous-product-graph-architecture.md` + `product-graph-artifact-schema-draft.json`.

## Classification legend
- **AVAILABLE** — Marveen has a live, usable capability that maps directly.
- **ADAPTER** — capability exists but needs a thin semantic mapping layer to APG's contract (no new infra).
- **UPSTREAM_GAP** — genuinely missing; belongs in the shared/upstream layer, not a per-product hack.
- **PRODUCT_LOCAL** — exists but varies per product; APG must read it per-product, not assume one shape.
- **BLOCKED** — cannot proceed without an external unblock (owner/AWS/etc.).

## Map

| # | APG capability | Marveen reality | Class |
|---|---|---|---|
| 1 | Kanban create/update/comment/event API | `store/claudeclaw.db`: `kanban_cards`, `kanban_comments`, `kanban_card_events`, `kanban_card_labels`; `/api/kanban`, `/api/kanban/labels`, `/api/kanban/assignees`, `/api/kanban-projects`, `/api/kanban/archived`. Create/update/comment/event all present. | **AVAILABLE** |
| 2 | Agent dispatch + readiness | `/api/messages` (bus dispatch, incl. `origin_note`), `/api/agents` (running-state, runState, contextTokens, activeModel). | **AVAILABLE** |
| 3 | Scheduled runner hook | `~/.claude/scheduled-tasks/*` (file-based SKILL.md + task-config.json), `/api/schedules`, 60s runner, `type: task|heartbeat|command`. | **AVAILABLE** |
| 4 | Token usage: system/tool, inherited, fresh-APG, cache-write, cache-read, output | Raw usage (input/output/cache_creation/cache_read) IS captured (Claude API usage + CostOps `token_usage`). The APG-specific decomposition (inherited-context vs **fresh-APG-packet** vs on-demand-pull) is a FINER split than Marveen records today. | **ADAPTER** (raw dims available; APG-origin tagging is the thin layer) |
| 5 | CostOps + intel registry adapter | CostOps: full local cost ledger + collectors (render/openai/github/deepseek + new **codex rate-limit** metadata collector), limits/threshold ladder, forecast, email-ingest (actual_invoice). **Intel registry: does NOT exist** — research/market output is ad-hoc deliverable files, not a queryable registry. | CostOps **AVAILABLE**; intel registry **UPSTREAM_GAP** |
| 6 | Git/commit/build/deployment/runtime evidence | Sources exist: git commits (local + origin), Render deploy-history API, `/health` runtime. NOT auto-linked into one commit→build→deploy→runtime evidence chain per change. | Raw evidence **AVAILABLE**; chain-linking **ADAPTER** |
| 7 | Identity marker propagation | `origin_note` on the bus is the seed, but it is **self-declared, NOT authenticated** (card 06f062e4). APG P0.A wants structured `actor_class/tenant_class/data_class/test_run_id/environment` propagated through the trace. | **ADAPTER** (origin_note → structured identity fields; auth is a separate hardening) |
| 8 | Per-product landing/demo/preregistration OR registration/login/app | Every product has real surfaces: standalone `*-landing` repos, demo/mock, app with registration/login. Launch-state differs (some waitlist/preregistration, some full registration). | **PRODUCT_LOCAL** (read per-product; do not assume one shape) |
| 9 | Preview/staging/production + rollback | Render production + preview envs (preview is cost-excluded in CostOps ledger) + manual rollback (redeploy/suspend, reversible). No systematic **staging or canary** release stage. | production+rollback **AVAILABLE**; staging/canary **UPSTREAM_GAP** |

## Counts by class
- AVAILABLE: 3 full (kanban #1, dispatch+readiness #2, scheduler #3) + 3 partial-heads (CostOps #5, raw evidence #6, prod+rollback #9)
- ADAPTER: 4 (token-origin split #4, evidence-chain #6, identity-marker #7, and the CostOps↔APG control-plane mapping)
- UPSTREAM_GAP: 3 (intel registry #5, staging/canary #9, authenticated identity marker #7-hardening)
- PRODUCT_LOCAL: 1 class (product surfaces #8 — N per-product shapes)
- BLOCKED: 0 (nothing hard-blocked; all gaps are adapter or upstream, none require an external unblock to START the shadow work)

## Headline finding
Marveen already has the **control-plane substrate** APG assumes (kanban+events, dispatch, readiness, scheduler, cost/limits, git/deploy/runtime, product surfaces). The work is NOT greenfield — it is (a) a set of thin ADAPTERS that tag existing signals into APG's contract shapes (token-origin, evidence-chain, identity fields, CostOps↔control-plane), and (b) a small number of genuine UPSTREAM_GAPS (intel registry, canary stage, authenticated identity). No capability is BLOCKED, so the side-effect-free shadow replay can proceed today.
