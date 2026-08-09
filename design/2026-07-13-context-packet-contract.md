# Context Packet Contract (TO-BE)

**Type:** DESIGN-ONLY target architecture. Not implemented, not wired.
**Date:** 2026-07-13
**Companion files:** `design/2026-07-13-product-lifecycle-transition-table.yaml` (state machine), the peer's `design/2026-07-13-product-graph-artifact-schema-draft.json` (19 canonical objects) and `architecture.md`.
**Grounds against:** `audits/2026-07-13-development-and-product-lifecycle-as-is-audit.md` §27–29 (context-loading map; ~16,850-tok static load; ~45–50% dead-weight).

---

## 0. Reconciliation note (schema not yet present)

The peer's canonical schema draft did not exist at authoring time. This contract references the 19 canonical object names from the shared brief: `product, opportunity, market_fact, hypothesis, business_definition, change, requirement, scenario, decision, design_node, task, test, build, deployment, runtime_evidence, metric_definition, metric_observation, product_review, approval`. **Field-name reconciliation required:** field tokens below (`change.id`, `content_hash`, `task.kanban_status`, `product.lifecycle_state`, `metric_observation.source`, etc.) are the author's proposed names; reconcile against the schema draft when it lands. Object **names** are already aligned.

---

## 1. Purpose and target

Replace the current **static, broadcast, always-on ~16,850-token** agent-start context with a **dynamic, role- and phase-scoped Context Packet of 3,000–5,000 tokens**, sourced from **canonical objects**, achieving **≥60% reduction** of fresh input at agent start.

The packet is the *only* thing an agent receives to start a unit of work. It is assembled deterministically by the packet-builder (a code service, not an LLM) from the Product Graph, and it is **schema-shaped input in, schema-shaped object out**.

Two principles govern *sourcing* (not just size):
- **P4 (memory/summary is NOT source of truth):** every fact in the packet is projected from a canonical object with a `content_hash`. Memory and daily-log summaries are never packet inputs; at most they are a Level-2 on-demand lookup an agent may *request*, clearly labelled non-authoritative.
- **P6 (kanban status is NOT a lifecycle state):** the packet carries **both** `product.lifecycle_state` (the FSM position, drives which gates/artifacts matter) **and** `task.kanban_status` (the work-item tracker). They are distinct fields; the packet never conflates them. The lifecycle phase — not the kanban column — selects the ROLE CAPSULE's active duties and the relevant artifact set.

---

## 2. Packet structure and token budget

The packet has five components. Budget sums to **~4,150 tok (3.0–5.0k envelope)**.

| # | Component | What it is | Budget (tok) | Cadence |
|---|-----------|-----------|:------------:|---------|
| A | **INVARIANTS** | The constitution: minimal core principles every agent obeys, always | **550** | static, cache-shared across all agents |
| B | **ROLE CAPSULE** | Role-scoped duties + the object types this role produces/accepts + role-relevant skill *references* | **900** | per-role, cache-shared across that role's sessions |
| C | **WORK PACKET** | Only the current work's objects: the active `product` header, `lifecycle_state`, the driving `change`/`requirement`/`design_node`/`task`, and their directly-linked objects | **1,900** | per-work-item, delta-loaded |
| D | **GATE-FEEDBACK** | Previous gate failures + prior `product_review` verdicts on this exact `content_hash` (so the agent sees what to fix) | **450** | per-work-item, present only after a failure |
| E | **OUTPUT CONTRACT** | The expected structured output: which canonical object(s) to emit, schema-validated, with required fields | **350** | per-work-item, derived from the FSM state |
| | **TOTAL** | | **~4,150** | |

On-demand artifact bodies (full skill bodies, full prior deliverables, sibling objects, memory lookups) are **NOT** in the packet — they are pulled by explicit request (Level 2, §5), so the *start* budget stays in the 3–5k envelope even for complex work.

### A. INVARIANTS (constitution) — ~550 tok
The irreducible rules, ~12–15 lines. Not the whole root CLAUDE.md. Contents:
- The 9 design principles (one line each) — the backbone the agent cannot violate.
- Source-of-truth hierarchy: canonical objects > repo/DB > (memory = non-authoritative index).
- "You never finally accept your own work" (P2) and "emit a schema-valid object, not prose" (points to component E).
- Secret-handling floor (never emit secrets on the bus).
This is **cache-shared across the entire fleet** (one cache entry, N readers) — see §3.

### B. ROLE CAPSULE — ~900 tok
Role-scoped, one per fleet role (`architect, ba, business, research, marketing, uxuidesigner, jogasz, frontendfejleszto, fullstackfejleszto, buildfejleszto, qa, uat, devops, deliverylead`). Contents:
- This role's responsibilities *as they appear in the transition table* (which states name it `responsible_agent` / `accept_agent`).
- The canonical object types this role **produces** and **accepts** (e.g. qa produces `test`, accepts `runtime_evidence`; qa never accepts its own `test` — P2).
- **Skill references only** (name + one-line trigger) for the ~6–12 skills relevant to this role — not all 86, and not full bodies. Full body is Level-2 on-demand (§5). This replaces the 8,396-tok all-86 broadcast.
The capsule is **cache-shared across all sessions of that role**.

### C. WORK PACKET — ~1,900 tok
The current work only. Deterministically selected by walking the Product Graph from the active `task`:
- `product` header + `product.lifecycle_state` (drives which gates apply) + `task.kanban_status` (P6: distinct field).
- The driving object(s) for this state (e.g. in `implementation`: the `design_node` + its `requirement` + `scenario`; the open `change`).
- **Directly-linked** objects only (one hop), each as a compact projection with its `content_hash`. No transitive closure, no sibling products, no history.
This is where P4 bites: these are live objects, not a memory recollection of them.

### D. GATE-FEEDBACK — ~450 tok
Present only when the work re-enters after a failure edge (transition table `failure_destination`). Contains the prior `product_review`/`decision` verdict(s) keyed to the object's previous `content_hash`, i.e. *exactly what the deterministic or semantic gate rejected*. This is what makes error-routing productive instead of blind retry.

### E. OUTPUT CONTRACT — ~350 tok
The expected agent output as a **schema-validated object spec**, derived from the FSM state's `produced_here` list. E.g. for `design`: "emit `design_node` objects covering every `requirement` id in the packet; set `carries_legal_commitment` if you introduce external data collection." The agent returns objects, not prose (the prose MD/HTML is a downstream projection, never authoritative).

---

## 3. Cache key, content hash, delta

**Content hash.** Every canonical object carries `content_hash = hash(canonical_serialization(object))`. The packet-builder never re-summarizes an unchanged object; it reuses the prior projection (P3: no re-read/re-verify when hash unchanged).

**Cache key.** The packet is assembled from cache fragments, each with its own key:
```
INVARIANTS      cache_key = "inv:" + constitution_version
ROLE CAPSULE    cache_key = "role:" + role + ":" + capsule_version
WORK PACKET     cache_key = "work:" + task_id + ":" + composite_hash
                 where composite_hash = hash(sorted(content_hash of every object in the packet))
GATE-FEEDBACK   cache_key = "gate:" + task_id + ":" + rejected_content_hash
OUTPUT CONTRACT cache_key = "out:" + lifecycle_state + ":" + schema_version
```
A/B/E fragments are **shared across sessions** (one cache entry serves many agents), which is why their per-*agent* marginal cost trends to ~0 after the first assembly.

**Delta (P3).** On re-dispatch of the same `task`, the builder compares the new `composite_hash` to the last packet's. It ships **only the objects whose `content_hash` changed** plus a one-line "unchanged: [ids]" manifest. If nothing changed, the packet is a delta header + GATE-FEEDBACK only — the agent does not re-receive the full WORK PACKET. This directly kills the AS-IS "re-read everything every turn" waste and enforces P3 at the transport layer.

---

## 4. The ≥60% reduction mechanism (before → after)

The AS-IS static load and its TO-BE replacement, component by component:

| AS-IS static source | AS-IS tok | Replaced by | TO-BE tok (per agent-start) | How |
|---|:---:|---|:---:|---|
| root CLAUDE.md (broadcast, cwd-ancestry) | 3,827 | INVARIANTS (A) + deterministic runtime | ~550 | Operational boilerplate (memory API, scheduler, bus, morning-briefing) is **not prose the agent needs** — it is either a code service or a role-scoped skill ref. Only the constitution stays as prose. |
| agent CLAUDE.md (incl. agent-tail dup of root) | ~3,300 | ROLE CAPSULE (B) | ~900 | Drop the ~1,437-tok agent-tail duplication of root entirely (P-source: it re-stated inherited root). Keep only role duties + produce/accept object types + skill refs. |
| all-86 level-0 skill descriptions (broadcast) | 8,396 | role/phase-scoped skill **references** inside B | ~250 (of the 900) | Ship name+trigger for only the ~6–12 skills relevant to this role and current lifecycle phase. Full bodies are Level-2 on-demand (§5), not at start. A jogász no longer carries render-deploy/chromium descriptions. |
| SOUL.md | 1,125 | (removed from work packets) | ~0 | Persona is a *user-facing-channel* concern (marveen's Telegram voice), not a dev-work concern. Dev agents doing schema-in/schema-out work do not need melancholic persona tokens. Loaded only on user-channel turns. |
| per-cwd memory preamble | ~200 | (removed; memory is on-demand, non-authoritative) | ~0 | P4: memory is never a start-time input. |
| — | — | WORK PACKET (C) + GATE-FEEDBACK (D) + OUTPUT CONTRACT (E) — *new*, but scoped to the one work item | ~2,700 | This is the actual signal the agent needs and mostly did NOT get before (AS-IS had no AC field, no gate-feedback object, no output contract). |
| **TOTAL static/start** | **~16,850** | | **~4,150** | **−75% vs static baseline; −60%+ even counting the new WORK/GATE/OUTPUT signal that AS-IS lacked.** |

Two ways to read the ≥60% target, both satisfied:
- **Like-for-like (framing/boilerplate only):** 16,850 → 1,450 (A+B) = **−91%**. The pure overhead collapses.
- **Whole-packet (incl. the new per-work signal):** 16,850 → 4,150 = **−75%**, comfortably past the ≥60% floor, *and* the 4,150 is now mostly task-relevant signal instead of ~45–50% dead-weight broadcast.

The reduction is structural, not a summarization trick: A/B are cache-shared fragments (marginal per-agent cost ~0 after first build), the 86-skill broadcast becomes a role-scoped reference list, SOUL and memory leave the work path, and C/D/E are one-hop-scoped and delta-loaded.

---

## 5. On-demand loading (progressive disclosure, Level 2)

The packet is the **Level-0/1** surface (name + scoped detail). Anything heavier is pulled explicitly:
- **Full skill body:** agent requests `skill.body(name)` → returns the SKILL.md (borrowed Spec-Kit progressive-disclosure pattern).
- **Deeper graph:** agent requests `graph.expand(object_id, hops=1)` → returns the next hop of canonical objects (still objects, still hashed).
- **Memory lookup:** agent may request `memory.search(q)` → returns matches **flagged `non_authoritative` (P4)** and **flagged `secondary_index` if embedding/KG-sourced (P5)**. Never auto-injected; never a gate input.
Each on-demand pull is itself hash-cached (P3) so a repeated pull in the same session is free.

---

## 6. Sourcing rules (why this is correct, not just small)

- **From objects, not memory (P4):** the WORK PACKET, GATE-FEEDBACK, and OUTPUT CONTRACT are all projections of canonical objects with `content_hash`. If it is not an object in the graph, it does not enter the packet as fact. This removes the AS-IS failure class where agents worked from a stale memory/summary/landing instead of the source object.
- **Lifecycle drives scope, not kanban (P6):** the packet-builder selects artifacts and gates by `product.lifecycle_state` (the FSM), and carries `task.kanban_status` separately as tracking metadata. A card sitting in a kanban column never *implies* a lifecycle position.
- **Producing agent gets no accept authority (P2):** the ROLE CAPSULE encodes produce-vs-accept object types; an agent's OUTPUT CONTRACT never lists "accept your own prior object."
- **Deterministic assembly:** the packet-builder is code. The LLM only ever sees the assembled packet; it does not decide what goes in it. This keeps context-loading itself off the single-LLM-point-of-failure path flagged in the AS-IS audit.

---

## 7. Expected agent output (closing the loop)

Agent start = receive packet (§2). Agent finish = emit the object(s) named in the OUTPUT CONTRACT (E), schema-validated. The FSM (transition table) then runs the **deterministic gate first (P1)**, then the **semantic verifier only on changed hashes (P3)**, then routes success/failure per the state's edges. Prose (MD/HTML) an agent may also write is a **projection**, never the authoritative artifact — the object is.
