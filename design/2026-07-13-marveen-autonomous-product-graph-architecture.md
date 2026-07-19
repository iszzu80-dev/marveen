# Marveen Autonomous Product Graph (APG) — TO-BE Target Architecture

**Date:** 2026-07-13 | **Type:** DESIGN ONLY (TO-BE target; no implementation, no core changes) | **Owner:** Istvan
**Grounds in:** `audits/2026-07-13-development-and-product-lifecycle-as-is-audit.md` (17 critical gaps)
**Companion files:** the canonical schema `design/2026-07-13-product-graph-artifact-schema-draft.json` (this doc's object/edge names are load-bearing and stay identical to it); the lifecycle **transition-table** + **context-packet-contract** authored by a peer agent (referenced, not authored here).

Direction is fixed by Istvan: Marveen-native, TypeScript + SQLite; KEEP Kanban, scheduler, agent fleet, CostOps, intel registry; BORROW patterns (OpenSpec deltas + dependency graph; Spec Kit constitution + progressive disclosure + convergence loop; LangGraph checkpoint/retry/timeout/error-routing/idempotency/human-interrupt; CrewAI event-driven transitions + persisted typed state); stay OFFICIAL-UPDATE-COMPATIBLE (sidecar + adapter, never fork core).

---

## 0. The 9 principles as the backbone

Every component below is a mechanism to enforce one or more of these. They are the constitution (Spec Kit pattern), stored as an object and injected verbatim into every gate/context packet.

1. **Deterministic check ALWAYS precedes the LLM verifier.**
2. **The producing agent may NEVER finally accept its own work.**
3. **No re-read/re-verification when the hash is unchanged.**
4. **Memory and conversation-summary are NOT source of truth.**
5. **Embedding/knowledge-graph only as a secondary search index.**
6. **Kanban status must NOT be used as a lifecycle state.**
7. **Every side effect runs with an idempotent execution ID.**
8. **The next step is normally auto-created and auto-started.**
9. **Human interrupt only at a pre-defined owner decision.**

The AS-IS audit found the inverse of #1, #2, #6, #8-as-single-LLM, and no #7 on lifecycle transitions. APG makes each principle a code gate, not a convention.

---

## 1. Components & responsibilities

All new components live in a **sidecar process** (`src/apg/*`) and a **separate SQLite DB** (`store/product-graph.db`). They call the *existing* dashboard/Kanban HTTP API and read the *existing* `store/claudeclaw.db` read-only. Core Marveen source, `claudeclaw.db` schema, CLAUDE.md, skills, and the scheduler are **never modified** — APG registers itself as one more scheduled task + one adapter surface, so an official update overwrites nothing of APG's and APG overwrites nothing of core's.

| Component | Responsibility | Borrowed pattern | Fixes (AS-IS) |
|---|---|---|---|
| **Graph Store** (`store/product-graph.db`) | Persist the 19 canonical object types as typed nodes + typed edges; one row = one immutable object version. Source of truth for the whole lifecycle. | OpenSpec artifacts | keystone: authoritative structured state instead of self-declared `done` |
| **Object Registry + Schema Validator** | Ajv-validate every write against `product-graph-artifact-schema-draft.json`; reject malformed objects; compute `content_hash`. | Spec Kit spec-as-data | FM-10 done-without-evidence |
| **Event Ledger** (`pg_events`, append-only) | One row per side effect / transition / gate result, stamped with `execution_id`. Never updated, only appended. The audit trail + replay log. | LangGraph checkpoint log | FM-01 agreed-not-recorded, dispatch silent-drop |
| **Graph Runner** (deterministic Flow engine) | The state machine that drives lifecycle transitions: reads object+gate state, decides the next step, creates+starts it. Replaces the single `maestro-backlog-review` LLM prompt as the *decider*; the LLM only *produces content*, never *routes*. | CrewAI Flows event-driven + LangGraph graph | #6/#8, single-LLM-point-of-failure |
| **Gate Engine** | Runs deterministic checks, then (only if pass) the semantic LLM verifier by a *different* agent, then (only if the phase is owner-gated) the human gate. Writes `gate_status`. | Spec Kit convergence loop | #1, #2, FM-05/06/09 |
| **Context Router** | Assembles a role- & phase-scoped context packet (3-5k tokens) per dispatch; hash/delta-aware so unchanged upstreams are referenced by id+hash, not re-inlined. | Spec Kit progressive disclosure | token bloat (~45-50% dead-weight, ~28,580 tok tail dup) |
| **Projection Generator** | Renders human Markdown/HTML (kanban card body, briefs, roadmap docs, dashboard views) FROM canonical objects on demand. Projections are disposable; never edited back. | — | FM-12 memory/doc-as-source |
| **Measurement Layer + Adapters** | `metric_definition`/`metric_observation` fed by PostHog, revenue-ledger, CostOps, runtime adapters; KPI-gap analysis; auto-propose optimization/repricing/sunset. | — | keystone gap §14/§16/§17 |
| **Kanban Bridge** | Two-way sync: `task` object ⇄ `kanban_cards` row via `POST /api/kanban`, `/move`, `/comments`. Kanban = dispatch + visualization; APG = truth. | — | #6 |
| **Approval Broker** | Detects autonomy-matrix human-gated actions, creates an `approval` object, escalates to Istvan (Telegram/dashboard), holds the transition, runs the escalation-clock. | LangGraph human interrupt | #9, FM-15 no escalation-clock |
| **CostOps / Analytics / Revenue adapters** | Read-only bridges from existing systems into `metric_observation` + per-product COGS for cost-aware pricing. | — | FM-24 pricing-not-cost-aware |

---

## 2. Canonical Product Graph data model (nodes + edges)

**Nodes** = the 19 object types (schema deliverable). Every node shares one envelope: `id, type, schema_version, version, lineage_id, content_hash, status, lifecycle_phase?, provenance{created_by, execution_id, created_at, source_refs, model_tier, tokens}, edges[], gate_status, supersedes, superseded_by, invalidated, invalidation_reason, payload{...}`.

**Storage (Graph Store, `store/product-graph.db`):**
```
objects(id PK, type, lineage_id, version, content_hash, status, lifecycle_phase,
        created_by, execution_id, created_at, invalidated, superseded_by, payload_json)
edges(from_id, rel, to_type, to_id, PRIMARY KEY(from_id, rel, to_id))
pg_events(event_id PK, execution_id, object_id, kind, from_state, to_state,
          actor_role, gate_layer, detail_json, created_at)      -- append-only
checkpoints(execution_id PK, phase, cursor_json, status, created_at, updated_at)
leases(dedup_key PK, task_id, holder_execution_id, leased_at, expires_at, attempt)
```
`objects` is append-only per (`lineage_id`,`version`): a change produces a NEW row (new `id`, `version`+1, `supersedes` = old id), and the old row gets `superseded_by`. Nothing is edited in place — this is what makes principle 3 (hash-stable = skip) and cascade invalidation reliable.

**Edges** are typed and directional (`from THIS object → referenced object`), enumerated legal-triples in the schema's `legalEdges`. Core edges (identical names in schema + peer transition-table):

```
market_fact ─supported_by─◄ hypothesis        opportunity ─derives_from─► market_fact
opportunity ─belongs_to─► product              business_definition ─for─► product
business_definition ─justified_by─► opportunity
change ─advances─► product     change ─realizes─► business_definition
requirement ─part_of─► change  requirement ─traces_to─► business_definition
scenario ─specifies─► requirement    design_node ─designs─► requirement
task ─implements─► requirement       test ─verifies─► requirement   test ─covers─► scenario
build ─builds─► change   deployment ─deploys─► build
runtime_evidence ─observed_on─► deployment    runtime_evidence ─evidences─► requirement
metric_definition ─measures─► product|business_definition
metric_observation ─instance_of─► metric_definition   metric_observation ─on─► deployment
product_review ─reviews─► product   product_review ─cites─► metric_observation
decision ─resolves─► change|requirement   decision ─steps_back_to─► business_definition|design_node
approval ─gates─► change|decision|deployment    <any> ─supersedes─► <same type>
```

This gives full forward *and backward* traceability: from a `metric_observation` you walk `instance_of → metric_definition → measures → product`, and from a failing `runtime_evidence` you walk `evidences → requirement → part_of → change` to route the failure precisely (§8).

---

## 3. Artifact types & edge types

Two orthogonal vocabularies, both frozen in the schema so the peer agent's transition-table and context-packet-contract key off identical strings:

- **`objectType`** — the 19 (`product` … `approval`).
- **`edgeRel`** — 30 relations (`belongs_to, derives_from, about, supported_by, contradicted_by, for, justified_by, advances, realizes, part_of, traces_to, specifies, resolves, triggers, designs, implements, verifies, covers, builds, deploys, observed_on, evidences, measures, instance_of, on, reviews, cites, gates, steps_back_to, supersedes`).

Writers may only create (from_type, rel, to_type) triples present in `legalEdges`; the Object Registry rejects the rest. This is the graph's referential integrity.

---

## 4. Versioning, hash, invalidation & supersede

- **`content_hash`** = `sha256` over the canonical (sorted-key) serialization of `payload` + `edges` (excluding `provenance` and `gate_status`, which are metadata). Two objects with equal `content_hash` are semantically identical inputs.
- **Versioning:** a change to any object mints a new `id`, `version = prev+1`, same `lineage_id`, `supersedes = prev.id`; prev gets `superseded_by = new.id`, `status = superseded`.
- **Cascade invalidation:** when object X is superseded, the Graph Runner walks *inbound* `source_refs`/edges; any downstream Y whose `provenance.source_refs` includes an X of a now-changed hash is marked `invalidated = true` with `invalidation_reason`. Invalidated objects are excluded from context packets and gates until re-derived by their producing phase. This is how "stale-downstream" (AS-IS FM-11: the "6 QQ tenants" stale claim propagating) is caught deterministically instead of by memory hygiene.
- **Supersede vs invalidate:** *supersede* = intentional new version; *invalidate* = an input moved under me and I must be re-derived. Both are recorded as `pg_events`.
- **Hash-stable skip (principle 3):** the Gate Engine stores `verified_hash` on `gate_status.semantic`. On any later pass, if the object's `content_hash == verified_hash`, the semantic verifier is **skipped** (`state = skipped_hash_unchanged`) and no LLM tokens are spent. Same for the Context Router: unchanged upstreams are passed as `{id, type, content_hash, one_line}` references, not re-inlined.

---

## 5. Append-only execution/event ledger

`pg_events` is the single append-only truth of "what happened". Every transition, gate result, dispatch, adapter run, and approval writes exactly one row, always carrying its `execution_id`. Nothing is ever updated or deleted. This gives:

- **Replay/debug:** reconstruct any object's history without trusting memory (principle 4).
- **Idempotency ledger:** a side effect first checks `pg_events` for its `execution_id`; if present, it is a no-op replay (principle 7).
- **The audit's missing record:** the "agreed-but-not-recorded" class (FM-01, the live nav-drift) cannot happen — a `decision` object + its `pg_event` is the *only* way a choice becomes real.

---

## 6. Checkpoint & resume, task lease & duplication-guard

**Checkpoint (LangGraph pattern).** Every phase execution writes a `checkpoints` row (`execution_id, phase, cursor_json, status`). If an agent dies, saturates, or the WSL VM reboots (a real AS-IS failure mode), the Graph Runner resumes from the last checkpoint instead of restarting the phase. `status ∈ {running, waiting_gate, waiting_approval, done, failed}`; `cursor_json` holds partial output refs.

**Task lease + duplication-guard.** Each `task` carries a `lease{holder_execution_id, leased_at, lease_expires_at, attempt, dedup_key}`. Rules:
- Only the live lease-holder may transition the task. This stops the AS-IS "two uat sub-sessions produce indistinguishable, un-resolvable duplicate work" (the 07-12 self-fill-sweep) at the data layer, not by convention.
- `dedup_key = <change_lineage>:<requirement_lineage>:<task_kind>`; a second `create` with the same key is rejected → no duplicate cards.
- Lease expiry (timeout, LangGraph) allows safe re-dispatch: `attempt+1`, new `execution_id`, but the same `dedup_key` guarantees the retry replaces rather than clones.
- Retries and catch-up reuse the existing hardened dedup primitives (`pending_task_retries`, catch-up map) — APG adds the *graph-level* dedup the AS-IS layer lacked.

---

## 7. Lifecycle state machine (overview)

The lifecycle_phase axis (16 phases) lives on `product` and on each `change` (the delta unit). The Graph Runner is a deterministic state machine over phases:

```
market_scouting → opportunity → business_definition → product_definition → design
   → implementation → verification → build → deploy → runtime_evidence → measurement
   → optimization → { repricing | scaling | pivot | sunset }
        ▲                                                    │
        └──────────── decision.steps_back_to ◄───────────────┘   (auto step-back)
```

Each transition has an **entry gate** (what must be true to enter), a **producer** (which agent role produces the phase's canonical object), and an **exit gate** (deterministic + semantic + human). A transition fires only when the source object's exit-gate is `pass` (and human `approved` where required). **The detailed transition table — every phase's entry condition, producer role, exit gate profile, auto-next, and step-back target — is authored as a SEPARATE file by a peer agent; this document only defines the axes and the gate model it keys off.** Backward transitions (`optimization → design/business_definition/market_scouting`) are first-class and are triggered by a `decision.steps_back_to` created from a failed gate or a KPI-gap, never by an LLM's free choice.

---

## 8. The four separated status axes (principle 6)

The AS-IS system conflated everything into `kanban_cards.status`. APG splits it into four independent axes that live in different places and answer different questions:

| Axis | Where it lives | Values | Answers |
|---|---|---|---|
| **task-status** | `kanban_cards.status` (existing) + `task.payload.state` | planned/in_progress/testing/waiting/done ; created/dispatched/in_progress/produced/accepted/returned/abandoned | "is this unit of *work* moving?" (dispatch + visualization only) |
| **lifecycle-phase** | `product.lifecycle_phase`, `change.lifecycle_phase` | the 16 phases | "where is the *product/change* in its life?" |
| **gate-status** | `object.gate_status{deterministic, semantic, human}` | pending/pass/fail/… per layer | "is this artifact *accepted*, and by which independent check?" |
| **decision-status** | `decision.payload.decision_status` | open/decided_auto/decided_owner/deferred/reversed | "has this *choice* been made, by whom?" |

A kanban card being `done` now means only "the worker finished their turn". It grants nothing: the `change` advances only when the *gate-status* is pass on the produced objects. Self-declared done is thereby stripped of authority (fixes db.ts:1426 semantics without touching db.ts — the Bridge treats kanban `done` as an *input signal*, not a lifecycle fact).

---

## 9. Deterministic / semantic / human gates (principles 1 + 2)

Every phase exit runs the Gate Engine in strict order:

1. **Deterministic gate (always first, principle 1).** Pure code, no LLM. Named checks per `gate_profile`, each writing a `checks[]` result with an `evidence_ref`:
   - `schema_valid` (Ajv), `artifact_hash_present`, `edges_legal`, `source_refs_live` (no invalidated upstream).
   - phase-specific: `tsc_build` (build phase), `test_exit_code == 0` (verification), `route_reachable_200` + `feature_reachable` (runtime_evidence), `fe_be_wired` (requirement.surface includes both `ui` and `backend` → a produced object must exist for each — directly kills FM-06 implemented-not-integrated), `commit_contains_change` (source-vs-build), `rollback_ref_present` (deploy).
   - If any check fails → gate `fail`, Graph Runner routes to failure-return (§10). The LLM verifier never runs on un-built/un-tested work.
2. **Semantic gate (only if deterministic pass).** An LLM verifier of a **different agent role** than `provenance.created_by` reviews for intent-fidelity, proto-parity, requirement coverage. Enforced: `verifier_agent != created_by` and `verifier_execution_id != provenance.execution_id` (principle 2 — the producer can never accept its own work). If `content_hash == verified_hash` from a prior pass → **skipped** (principle 3, zero tokens).
3. **Human gate (only for owner-gated phases, principle 9).** Present only when the transition is in the USER-APPROVAL bucket (§14). The Approval Broker creates an `approval`, holds the transition, escalates, runs the escalation-clock. All other phases have `human.state = not_required` and flow automatically (principle 8).

Producer role vs accepter role per phase is fixed in the peer transition-table; e.g. `fullstack` implements → `qa` + deterministic tests verify → `uat` produces runtime_evidence → never the implementer.

---

## 10. Failure-routing & retry (LangGraph patterns)

A failed gate is a routed event, not a dead end:

- **Retry with backoff + timeout.** Deterministic-fail from a transient cause (build flake, network) → same `dedup_key`, `attempt+1`, new `execution_id`, capped attempts; per-phase timeout moves a stuck execution to `failed` and re-leases.
- **Error-routing by edge walk.** A semantic-fail or a contradicting `runtime_evidence` creates a `decision.steps_back_to` targeting the *right* upstream phase, found by walking edges: reachability fail → `evidences→requirement→part_of→change` re-enters `implementation`; requirement-coverage fail → re-enters `design`; a business-intent miss → `steps_back_to business_definition`. This replaces "everything routed by one maestro LLM prompt" (AS-IS FM-16: only missing-file had a deterministic return).
- **Idempotent side effects (principle 7).** Every retry/route runs under a fresh `execution_id` but re-checks `pg_events` first, so a re-fire of an already-completed deploy/build is a no-op.
- **Dead-letter / escalation-clock.** Repeated failure past cap, or a stalled owner approval, arms a deterministic escalation-clock (`approval.escalation_deadline`) that re-pings Istvan and freezes the branch — the determinstic escalation net the AS-IS system lacked (FM-15).

---

## 11. Build / deploy / runtime provenance

The chain `change → build → deployment → runtime_evidence` is fully typed so "the running bundle actually contains the merged change and the feature is reachable" is checkable — the highest AS-IS risk (FM-09 deployed-not-reachable, FM-07/08):

- `build{commit_sha, build_command, artifact_digest}` — records exactly what was built from what commit (handles `pnpm --filter @suite/web` filtered builds where `packages/core/dist` isn't guaranteed).
- `deployment{service_ref, build_ref, commit_sha, rollback_ref}` — deploy to `preapproved_render` is AUTOMATIC (existing Render autoDeploy stays the mechanism); `production_public`/new-cost targets need an `approval`.
- `runtime_evidence{kind: feature_reachable, target_url, http_status, result}` — a real post-deploy reachability probe (curl/Playwright smoke), which the AS-IS suite-web static site never had. Only a *passing* `runtime_evidence` flips the requirement to `reachable` and lets the `change` reach `measurement`.

---

## 12. Product LCM measurement layer (the keystone gap)

The AS-IS audit's central finding: cost is measured, **value is not**. APG makes value a first-class, adapter-fed part of the graph.

- **`metric_definition`** per product KPI with `baseline/target/threshold/window/direction/adapter` — one authoritative definition, superseded not edited.
- **`metric_observation`** written by scheduled adapter runs (idempotent `adapter_run_id`, dedup by window):
  - **PostHog adapter** → visits/signups/activation/conversion/retention/feature_adoption (uses a `phx_` read key; guards the broken PostHog IIFE / CSP-block issues the AS-IS audit flagged so measurement isn't silently dead at launch).
  - **Revenue adapter** → revenue/MRR from the product's payment source (kept separate from the company/personal-finance agents, which are *not* product-LCM).
  - **CostOps adapter** → per-product `cost_per_month`/`gross_margin` by joining `cost_line_items` (existing) to a product tag — enabling cost-aware pricing (FM-24).
- **KPI-gap analysis (deterministic).** After each observation, `gap_vs_target` is computed; a `threshold` breach deterministically creates a `product_review` + an auto-`change` proposal (optimize/reprice/scale/pivot/sunset). The optimization loop finally runs on *measured* signals, not qualitative ones (fixes §16).
- **`hypothesis` evaluation.** Open hypotheses with a `predicted_metric` are auto-resolved supported/refuted against observations, closing the discovery→build→measure→learn loop.

---

## 13. Intel-registry ↔ products & hypotheses linkage

The existing intel registry (research/business `deliverables/`, `idea_box`, `memories`) is bridged into the graph as **`market_fact`** nodes (`source_kind = intel_registry`, `source_uri` back to the deliverable/idea). This makes competitor knowledge **delta-based** (OpenSpec): each fact is a discrete, timestamped, `stale_after`-bearing node, so scouting accretes and re-scouts only stale facts instead of full re-research (fixes AS-IS §9 "full re-research every time", prompt-fragile 39-line scout). `market_fact`s feed `opportunity` (via `derives_from`) and `hypothesis` (via `supported_by`/`contradicted_by`), giving a maintained opportunity pipeline instead of June-only one-shots. Memory stays a *search index* (principle 4/5), never a source: an object is only authoritative once it is a validated graph node.

---

## 14. Autonomous vs human-approval decision matrix

The Graph Runner runs everything in the AUTOMATIC column with no human gate (principle 8). The Approval Broker inserts a human gate (principle 9) **only** for the USER-APPROVAL bucket. Encoded as the `gate_profile.requires_owner` flag per phase-transition and the `approval.gated_bucket` enum.

| AUTOMATIC (no human gate) | USER-APPROVAL REQUIRED (Approval Broker) |
|---|---|
| research; business & requirement draft; design; task breakdown; implementation; review; QA-return; build; deploy to a **pre-approved** env; runtime smoke; measurement; KPI-gap analysis; roadmap & pricing **PROPOSAL**; marketing-material **draft**; step-back to research/business/design | new or increasing recurring cost; pricing **go-live**; external **publish**; legal/privacy commitment; destructive prod/data deletion; product **pivot**; product **sunset**; material change of accepted business intent |

Each right-column action maps 1:1 to an `approval.gated_bucket` value. The `business_definition.accepted_intent_hash` detects "material change of accepted business intent" deterministically: if a new business_definition's intent-hash differs from the owner-accepted one, a `material_business_intent_change` approval is required before it becomes live.

---

## 15. Pricing / pivot / kill / sunset / zombie-service process

Entirely absent AS-IS (FM-27/28). APG:

- **Repricing:** a `cost_per_month`/`gross_margin`/competitor `market_fact` signal → `product_review(proposed_action=reprice)` → auto-`change(kind=repricing)` that drafts new pricing automatically; **going live** needs a `pricing_go_live` approval.
- **Pivot / sunset:** a `product_review(verdict=zombie|at_risk)` (0 signups + non-trivial `cost_per_month`, or a `kill_criteria` metric breach) → auto-`change(kind=pivot|sunset)` **proposal**; enacting it needs a `product_pivot`/`product_sunset` approval, and destructive prod/data deletion needs the separate `destructive_prod_data_deletion` approval (gated BEFORE any dispatch, per the existing irreversible-delete standing rule).
- **Zombie-service detection (deterministic):** the CostOps adapter joins per-service cost to per-product usage metrics; a service with `cost_per_month > 0` and `feature_adoption/visits ≈ 0` over its window auto-produces a sunset proposal — the "X service, 0 users, $Y cost → sunset" rule the AS-IS system only did manually.

---

## 16. Context Router, role/phase-scoped context, hash/delta re-verification

The Context Router assembles each dispatch's context packet deterministically instead of broadcasting everything (AS-IS: ~16,850 static tokens, ~45-50% dead-weight, 86-skill broadcast, agent-tail dup ~28,580 tok fleet-wide). A packet contains only:

1. **Constitution slice** — the 9 principles + the phase's gate profile (small, cached).
2. **Role card** — just the acting agent's role responsibilities (not the shared infra tail; the `fleet-descriptor-slim` extraction the AS-IS audit found unused is assumed applied).
3. **Phase-scoped objects** — the exact upstream objects this phase needs, resolved by edge walk (e.g. implementation gets its `requirement`s + `design_node`s + `scenario`s, nothing else).
4. **Delta/reference-only upstreams** — objects whose `content_hash` is unchanged since the agent last saw them are passed as `{id, type, content_hash, one_line}` stubs, not re-inlined (principle 3). Only *changed* objects are inlined in full.
5. **Scoped skills** — only skills relevant to the role/phase (Context Router filters the level-0 broadcast).

**The exact field-by-field context-packet contract is authored by the peer agent**; this doc fixes the assembly rules and the token budget it must hit. Embedding/KG search (principle 5) is used only to *find candidate* objects for step 3, never to supply authoritative content.

---

## 17. Per-phase token budgets & the ≥60% reduction method

**Target:** normal agent-start context **3,000–5,000 tokens** (vs ~16,850 AS-IS static + dispatch/search/skill-body on top).

Reduction levers (compounding, no quality loss because nothing *needed* is dropped — it is scoped or referenced-by-hash):

| Lever | AS-IS cost | APG cost | Saved |
|---|---|---|---|
| Agent-tail dedup (apply `fleet-descriptor-slim`) | ~1,437 tok/agent (28,580 fleet) | ~0 | ~1,437 |
| Role/phase skill-scoping (not 86-broadcast) | 8,396 tok | ~1,000–1,500 | ~7,000 |
| SOUL/persona only on spawn, not per dispatch | ~1,125 tok | 0 at dispatch | ~1,125 |
| Hash/delta reference for unchanged upstreams | full re-inline | id+hash stub | varies, large on re-verify |
| Phase-scoped objects (not whole-board) | broad search recall | exact edge-walk set | large |

Static per-dispatch: constitution+gate (~600) + role card (~800) + phase objects (~1,500–2,500) + scoped skill stubs (~500) ≈ **3,400–4,400 tokens** — inside target, a **>60% cut** vs ~16,850. Re-verification of an unchanged artifact costs **0** LLM tokens (skipped by hash), the single biggest recurring saving.

---

## 18. Model tiering

`modelTier ∈ {deterministic_no_llm, cheap_deepseek, mid_sonnet, high_opus}`, chosen per phase/gate and recorded in `provenance.model_tier`:

- **deterministic_no_llm** — all deterministic gates, hash/dedup/route, adapters, projections. No model at all (principle 1 makes most gating LLM-free).
- **cheap_deepseek** — high-volume, low-sensitivity drafting (scenario expansion, marketing-copy draft, market_fact normalization). **Never receives sensitive DATA in context** (existing data-sensitivity routing rule); classification is by data-in-context, not task type.
- **mid_sonnet** — implementation, most producing agents, semantic verification of routine artifacts.
- **high_opus** — hard architecture/spec, security review, ambiguous KPI-gap judgment, and the semantic gate on high-risk changes (pricing/pivot/sunset proposals).

Because the *router* is deterministic (Graph Runner), the expensive models only *produce/verify content*, never *decide flow* — the reliability + cost win the AS-IS single-LLM decider gave up.

---

## 19. Human-readable projection generation

Canonical objects are AI-first structured data; humans read **projections** generated on demand by the Projection Generator (principle: docs are never authoritative):

- **Kanban card body** ← projected from `task`/`change` (title, intent, acceptance, gate status).
- **Business brief / roadmap / PRD** ← projected from `business_definition` + `requirement`s + `product_review`.
- **Dashboard lifecycle view** ← projected from `product.lifecycle_phase` + gate/metric state.
- **Owner approval message** ← projected from the `approval` object.

Projections carry a `generated_from: {id, content_hash}` header; if edited by hand, the edit is discarded on next regen — the object must change instead. This structurally prevents the AS-IS "agent worked from a landing/memory/doc instead of the proto/repo" (FM-12) and stale-copy edits.

---

## 20. LOCAL PILOT — "APG-Pilot-Zero: LumaSeat Live Seat-Fill Badge" (LSFB)

A single real LumaSeat change, driven end-to-end by a *thin* APG sidecar, proving quality + autonomy + token wins without touching Marveen core.

**The change (touches UI + backend + integration + build + deploy + runtime):** add a **live seat-fill badge** to the LumaSeat seating dashboard — "42 / 120 seats confirmed" — computed from real RSVP data.
- **UI:** a badge component on the seating screen (frontend/Pixel).
- **Backend:** a `GET /seating/:eventId/fill` aggregate endpoint (fullstack/Mason).
- **Integration:** wires the endpoint to the existing RSVP/guest data source (the `fe_be_wired` deterministic check has real teeth here — exactly the FM-06 class).
- **Build:** `pnpm --filter @suite/web build` + api build (Anvil).
- **Deploy:** existing Render autoDeploy to the pre-approved LumaSeat service (AUTOMATIC — no approval, it is a pre-approved env).
- **Runtime:** a `feature_reachable` smoke probe (badge renders + endpoint 200 with a real number).

**How the pilot exercises the architecture:**
- Full object chain instantiated: `product(lumaseat) → change(LSFB) → requirement(surface=[ui,backend,integration]) → design_node → task(×N, kanban-mirrored) → build → deployment → runtime_evidence`, then a `metric_definition(feature_adoption)` + first `metric_observation`.
- All three gate layers fire; the deterministic `fe_be_wired` + `feature_reachable` checks must pass before `done` means anything; the semantic gate is run by a different agent than the implementer (principle 2).
- Uses the **current Kanban API** (`POST /api/kanban`, `/move`, `/comments`) via the Kanban Bridge for every `task`; the epic mirrors the `change`.
- **Does NOT modify `store/claudeclaw.db`** — all APG state in `store/product-graph.db`; the Bridge only *calls the existing HTTP API* and reads claudeclaw read-only.
- **Removable & rollbackable:** the sidecar is one process + one DB file + one scheduled task; deleting them + the LumaSeat commit (via `deployment.rollback_ref`) fully reverts. No core file touched.

**Measures (pilot success = all three):**
- **Quality:** did the deterministic gates catch a real defect the AS-IS flow would have passed? (target: the badge-not-wired / not-reachable case is caught pre-done.)
- **Autonomy:** how many transitions ran with **zero** human touch vs the AS-IS single-LLM path? (target: only pre-approved-env deploy + any real owner decision stop it.)
- **Token:** agent-start context and total-token-per-change vs an AS-IS baseline change (§22).

**Local-pilot vs upstream split.** The pilot ships as a *local sidecar* (LumaSeat-specific adapters, local scheduled task). The general result — Graph Store, Object Registry, Gate Engine, Graph Runner, Context Router, the schema, and the gate model — is written product-agnostic so it becomes an **upstream-proposal-ready** contribution (a generic "autonomous product graph" sidecar any Marveen install can enable), with LumaSeat-specific wiring kept in a thin local layer that is NOT part of the upstream proposal.

---

## 21. Local vs official split (update-compatibility)

- **Upstream-general (proposal-ready):** `src/apg/*` engine, `store/product-graph.db` schema, the artifact JSON schema, gate/router/runner, Kanban Bridge (uses only the public HTTP API).
- **Local-only:** LumaSeat adapters, the pilot scheduled task, per-product tags, RENDER/PostHog credentials (stay out of tracked files, as today). All host-cron/untracked machinery stays local.
- **Compatibility rule:** APG never edits core source, `claudeclaw.db` schema, CLAUDE.md, skills, or the scheduler. It registers as one scheduled task + one adapter and talks to core only over the existing dashboard API + read-only DB reads. An official `update.sh` run overwrites none of APG, and APG breaks nothing of core.

---

## 22. Token-measurement methodology

Measured per change, baseline (AS-IS-style flow) vs APG-pilot, using the existing `token_usage` table + APG's `provenance.tokens`:

- **Per-object accounting:** every produce/verify writes `provenance.tokens{fresh_input, cache_read, output, total}`.
- **fresh_input** = prompt tokens NOT served from cache (the number the 3-5k budget targets); **cache_read** = cache-served prompt tokens; **output** = completion tokens; **total** = sum.
- **total-token-per-change** = Σ over all objects sharing the `change.lineage_id` (walk `part_of`/`implements`/`builds`/`deploys`/`evidences`).
- **token-per-completed-requirement** = per-change total ÷ count of requirements reaching `reachable`.
- **Baseline capture:** run one representative change through the AS-IS path (kanban + maestro + broadcast context) and sum its agents' `token_usage`; run the LSFB pilot through APG; compare `fresh_input/total` per change and per requirement.
- **Targets:** agent-start `fresh_input` 3,000–5,000; ≥60% reduction in per-dispatch fresh_input vs AS-IS ~16,850 static; measurable drop in total-token-per-change driven by hash-skip re-verification and phase-scoped packets. Report the baseline-vs-pilot delta as the pilot's token verdict.

---

### Coherence anchors for the peer agent
- Object type names, `edgeRel` names, envelope fields, and the four status axes (§8) are **identical** to the schema file and MUST be reused verbatim in the transition-table + context-packet-contract.
- The transition-table owns: per-phase entry condition, producer role, exit `gate_profile`, auto-next, step-back target. This doc owns: axes, gate model, components, measurement, pilot.
- The context-packet-contract owns: the exact packet field layout; this doc fixes only its assembly rules + token budget (§16-17).
