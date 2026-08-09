# APG v0.4-lean Pilot Kernel — Implementation Specification

Date: 2026-07-16 · Status: READ-ONLY design (no implement/commit/dispatch/deploy/upstream-issue).
Companion files: `-component-contracts.yaml`, `-store-schema.sql`, `-work-items.yaml`, `-pilot-acceptance-and-measurement-plan.md` (all under `design/`).

## 1. Goal and non-goal
**Goal:** the smallest removable, SIDECAR Pilot Kernel that uses the existing Marveen substrate and, on TWO historical shadow replays, proves: (1) the evidence/provenance chain; (2) test-identity handling; (3) token+context measurement; (4) deterministic checkpoint operation; (5) that APG ceremony overhead < the benefit it buys.
**Non-goal (explicit OUT OF SCOPE):** autonomous Lifecycle Runner; live agent dispatch; Kanban write-back; production deploy; progressive-rollout infra; full Product LCM; automatic market research; pricing/marketing publish; claim-provenance/overclaim profile; Ralph loop; frontend/backend agent routing; dashboard UI; ANY Marveen core DB or core-source modification.

## 2. Component diagram
```
                       ┌─────────────────── APG Pilot Kernel (sidecar: apg-kernel/) ───────────────────┐
 Marveen sources        │                                                                              │
 (READ-ONLY):           │   ┌─ Profile Registry (W2) ──┐        ┌─ Deterministic Checkpoint          │
  kanban DB  ───────────┼──▶│ config: profiles/*.yaml   │──────▶│  Evaluator (W6)  [NO LLM]           │
  git log    ───────────┼─┐ └───────────────────────────┘        │  spec/verif/release/runtime_accept │
  Render deploy-hist ───┼┐│                                       └──────────────┬─────────────────────┘
  /health    ───────────┼┼┼─▶ Execution Receipt Chain (W3) ──▶ receipts+evidence │
  token_usage ──────────┼┼┼─▶ Token Origin Instrumentation (W4) ──▶ measurements  │
  product auth/tenant ──┼┼┴─▶ Test Identity Contract (W5) ──▶ identity assertions │
                        │└──────────────▼──────────────────────────────▼──────────▼                    │
                        │        Minimal Sidecar Store (W1)  store/apg-kernel.db (append-only)          │
                        │        Replay runners: S1 landing (W7), S2 JWT-migration (W8) ─▶ report (W9)  │
                        └──────────────────────────────────────────────────────────────────────────────┘
   core DB writes: NONE.  external state changes in shadow mode: NONE.
```

## 3. Directory / module structure
```
apg-kernel/                        # sidecar; NOT in Marveen core src/
  store.py                         # W1: sidecar store (init + append-only + dedup upsert)
  profiles.py                      # W2: config-driven profile registry
  receipt_chain.py                 # W3: execution receipt reconstruction
  token_origin.py                  # W4: token origin instrumentation
  test_identity.py                 # W5: generic test-identity contract
  checkpoints.py                   # W6: deterministic checkpoint evaluator
  sources/                         # read-only adapters behind interfaces (no provider hardcode in core)
    git_source.py  render_source.py  health_source.py  kanban_source.py
  adapters/
    lumaseat_identity.py           # W5: the ONE product-local identity adapter for the pilot
  replays/
    s1_landing.py  s2_jwt_migration.py   # W7/W8
  report.py                        # W9
profiles/ …                        # reused from the methodology pack (base + 4)
store/apg-kernel.db                # gitignored sidecar DB
```

## 4. Sidecar store schema
See `design/apg-v0.4-pilot-kernel-store-schema.sql` (10 tables: canonical_artifact_versions, lineage_heads, edges, execution_receipts, evidence_references, checkpoint_results, token_measurements, profile_activations, replay_runs). SQLite, append-only for integrity-bearing rows, dedup keys for idempotent replay. NOT a general graph DB.

## 5–6. Adapter interfaces + I/O contracts
See `design/apg-v0.4-pilot-kernel-component-contracts.yaml` (all 6 components: interface signatures, input/output shapes, rules, which Marveen source each READS). Every adapter is a generic interface + a thin swappable concrete adapter; no provider hardcode in the generic layer.

## 7. Idempotency and replay semantics
- Every write carries a deterministic dedup key (see schema). Re-running a shadow replay UPSERTs the same rows → no duplication.
- Shadow mode is pure: reads Marveen sources, writes only the sidecar DB, changes zero external state.
- `run_timestamp` is passed IN as an arg (never `now()` inside the kernel) so a replay is byte-reproducible.
- A re-run with the same (change, commit-set, run_id) yields an identical receipt + checkpoint set.

## 8. Checkpoint algorithm (deterministic, no LLM)
For each checkpoint in {spec_ready, verification_ready, release_ready, runtime_acceptance}:
1. Resolve active profiles (W2) → risk tier (low/standard/high/critical) from complexity class + signals.
2. Run the checkpoint's DETERMINISTIC checks from `gate-profiles.yaml` (schema+reference integrity, evidence-chain completeness for that stage, identity-isolation when identity-test-data profile active).
3. Any required evidence MISSING/UNKNOWN → checkpoint result UNKNOWN (never FAIL, never invented PASS). All required PRESENT+valid → PASS. A present-but-inconsistent check (e.g. commit mismatch) → FAIL.
4. `NOT_APPLICABLE` when the checkpoint's precondition profile isn't active.
5. `implementation_ready` is evaluated ONLY if a replay's authentic execution needs it (decided empirically in W7/W8); otherwise it is not in the P0 loop.
Semantic review (the `semantic_by_risk` tier) is NOT run in the shadow pilot (no LLM); it is recorded as `NOT_APPLICABLE (shadow)` and reserved for live mode.

## 9. Profile activation
Config-driven (`profiles/<name>/profile.yaml`), never if/else. `active_for(class, signals)` returns the overlay set; the pilot supports base + ui-fullstack + identity-test-data + product-surface-launch + safe-release. Adding a profile = a config file, no code change (tested in W2).

## 10. Token measurement model
Per replay, `token_measurements` rows for: stable_prefix, apg_packet_fresh, on_demand_retrieval, failed_gate_feedback, output, cache_creation, cache_read, provider_aggregate_input/output, and **unattributed_input**. Each labelled MEASURED/ESTIMATED/UNKNOWN. The kernel's OWN controllable placements (prefix vs fresh packet vs on-demand pull) are MEASURED because the kernel authored them; the remainder is `unattributed_input`/UNKNOWN and is explicitly NOT called inherited_context. No fresh-input-reduction number is emitted without a MEASURED baseline for the same change. `cost_amount` and `occupied_context_estimate` are separate. A provider that doesn't expose system/tool split leaves that UNKNOWN and does NOT block the pilot.

## 11. Test-identity propagation model
The generic contract (actor/tenant/data/test_run/environment/analytics/billing/communication/cleanup) is resolved via the product-local `lumaseat_identity.py` adapter for the pilot. The 6 mandatory checks (identifiable / KPI-excludable / billing-suppressible / comms-blockable / data-isolated / cleanup-verifiable) each emit PASS/FAIL/UNKNOWN/MISSING. For a HISTORICAL change where a field can't be reconstructed → MISSING/UNKNOWN, never invented. Propagation in shadow = reconstruction only; in future live mode = the same contract carried on the actual request/event.

## 12. Two shadow-replay run plans
**S1 — LumaSeat couple-facing landing** (baseline): profiles ui-fullstack + product-surface-launch + safe-release(low), agent_budget 1. Chain: change→work_item→landing commit→(deterministic overclaim/served-copy check as the review)→build→landing deploy→/health(200). Expected checkpoints: spec_ready PASS, verification_ready PASS-or-UNKNOWN (served-copy evidence), release_ready PASS (rollback = prior commit), runtime_acceptance OBSERVED-or-UNKNOWN. Token: small fresh; occupied-context ESTIMATED.
**S2 — Eskuvo JWT tenant-id migration + stale-session fix** (full-stack): commits 2dcd216c/e292a853/edf55863, profiles ui-fullstack + identity-test-data + safe-release, agent_budget 2. Chain adds: DB migration evidence + per-product smoke-test evidence (edf55863) + tenant/auth identity assertions (W5) — the point of S2. Expected: identity-isolation checks exercised, MISSING where historically unprovable; commit_chain across the migration commits; release_ready requires migration-reversibility evidence (likely UNKNOWN historically → surfaced, not invented). Both replays are side-effect-free.

## 13. Failure modes and recovery
- Missing Marveen source (Render API down / git unreachable) → the affected link is UNKNOWN, the run still completes with an honest partial receipt (never blocks, never invents).
- Malformed source data → the parser yields UNKNOWN for that field; a schema-check FAIL is recorded, not a crash.
- Sidecar DB locked (concurrent replay) → dedup keys make a retry safe; WAL mode reduces contention.
- Kernel bug → sidecar-only, so recovery = delete `store/apg-kernel.db` and re-run (idempotent). No Marveen state touched.

## 14. Security and credential boundary
- Kernel reads Marveen sources with EXISTING read access; it holds NO new secret. Render deploy-history read uses the existing RENDER_API_KEY path (devops-owned) via a read-only source adapter — the key never enters kernel code or the sidecar DB.
- Evidence stores DIGESTS + hashed locators, never raw payloads, never a secret (same discipline as CostOps' hashRef).
- No outbound calls except the read-only source fetches; no send/deploy/dispatch in shadow.
- The product-local identity adapter reads product auth/tenant data read-only; it does not persist PII.

## 15. Uninstall / rollback
Delete `apg-kernel/` and `store/apg-kernel.db`. Zero residue in Marveen core (no core-DB rows, no core-source edits, no seams added). This is the whole point of "removable sidecar".

## 16. Local vs upstream boundary
- **Local sidecar (this pilot):** the entire `apg-kernel/` + the LumaSeat product-local identity adapter.
- **Generic upstream candidates (later, NOT this pilot):** the adapter INTERFACES only — `release-strategy-and-deployment-evidence-adapter-interface` (renamed per correction; concrete staging/hosting/flags/canary/rollout stay provider/product-local), and the generic test-identity contract shape. The methodology pack itself stays upstream-of-Marveen (it is Istvan's methodology, not Marveen core).
- Nothing provider-specific goes into a generic layer; CostOps remains the capacity/cost resolver the methodology delegates to.

## 17–18. Work items (dependency-ordered, with per-item detail)
See `design/apg-v0.4-pilot-kernel-work-items.yaml` — 9 items W1..W9, each with goal/input/output/done_when/deterministic-tests/complexity_class/agent_budget/cost_estimate. Critical path W1→W3→W6→W8→W9; W2/W4/W5 parallelize off W1.

## 19–20. Acceptance criteria + go/no-go
See `design/apg-v0.4-pilot-kernel-pilot-acceptance-and-measurement-plan.md`.

## Ceremony- and cost-defense (per required component/record)
| Component/record | Consumed by | Without it | Why not from existing sources | Overhead |
|---|---|---|---|---|
| execution_receipts | release_ready + runtime_acceptance checkpoints; the acceptance report | release/runtime gates undeterminable; no provenance proof | git/Render/health exist but are UNLINKED — the linking IS the value | append-only rows; ~0 tokens (deterministic), medium runtime (source reads) |
| token_measurements | pilot goal #3 + ceremony-vs-benefit goal #5 | cannot prove/refute the token hypothesis (the pilot's core question) | token_usage aggregates only; origin split doesn't exist | small rows; ~0 tokens |
| test-identity assertions | verification_ready (identity-isolation) on S2; goal #2 | S2 auth/tenant change can't prove isolation | product auth exists but no isolation contract over it | small rows; ~0 tokens |
| checkpoint_results | pilot goal #4; go/no-go | no deterministic-gate evidence | gate logic is human today | small rows; ~0 tokens (no LLM) |
| profile_activations | checkpoint risk-tiering; audit | can't explain which overlay applied | profiles exist but activation isn't recorded | tiny rows |
| canonical_artifact_versions + edges | the whole lineage/receipt graph | no artifact identity/lineage | kanban/git have pieces, not the 12-kind canonical graph | bounded per replay |
Any record with no concrete consumer above is OUT of the P0 scope by construction. (E.g. no metric/roadmap/pricing artifacts are materialized — nothing consumes them in the pilot.)
