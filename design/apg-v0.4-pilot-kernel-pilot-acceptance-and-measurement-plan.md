# APG v0.4-lean Pilot Kernel — Pilot Acceptance & Measurement Plan

Date: 2026-07-16 · READ-ONLY design artifact.

## Pilot acceptance criteria (the 5 goals; each → MET / UNMET / UNKNOWN)

### Goal 1 — Evidence/provenance chain
- **MET when:** both replays produce an execution_receipt with all 7 links classified (PRESENT/UNKNOWN/MISSING) and `commit_chain_status` computed from real shas; every gap is explicit; zero invented evidence.
- **UNMET when:** any link is silently assumed, or a receipt claims PRESENT without a digest.
- Metric: % of links resolved PRESENT vs UNKNOWN/MISSING per replay (reported, not a pass/fail threshold — honesty is the criterion, not coverage).

### Goal 2 — Test-identity handling
- **MET when:** the 6 mandatory checks run on S2 and each returns PASS/FAIL/UNKNOWN/MISSING; a historically-unprovable field is MISSING (not invented); the generic contract carries zero product hardcode.
- **UNMET when:** any check is skipped, or a field is asserted without reconstructable evidence.

### Goal 3 — Token + context measurement
- **MET when:** the kernel-controllable token fields are MEASURED, the remainder is `unattributed_input`/UNKNOWN (never relabelled inherited), and NO fresh-input-reduction number is emitted without a MEASURED baseline. `cost_amount` and `occupied_context_estimate` reported separately.
- **UNMET when:** any savings claim appears without a baseline, or `unattributed_input` is called inherited.
- Explicit: at pilot end the token-reduction hypothesis is expected to remain PARTIALLY UNKNOWN — that is an ACCEPTABLE outcome; the criterion is honest labelling, not a proven saving.

### Goal 4 — Deterministic checkpoint operation
- **MET when:** the 4 P0 checkpoints evaluate on both replays with PASS/FAIL/UNKNOWN/NOT_APPLICABLE, using zero LLM calls, and re-running yields identical results (determinism).
- **UNMET when:** any checkpoint needs an LLM, or two runs of the same input disagree.

### Goal 5 — Ceremony overhead < benefit
- **MET when:** the per-replay ceremony overhead (records created + kernel tokens spent) is reported WITH each record's consumer, and the benefit (gates made deterministic + provenance proven + measurement enabled) is judged to outweigh it — with any record lacking a consumer already excluded by construction (§ceremony-defense in the spec).
- **UNMET when:** the kernel materializes any record nothing consumes, or overhead exceeds the value on either replay.
- Metric per replay: `records_written`, `kernel_tokens (ESTIMATED until W4 measures live)`, `runtime_seconds`, and a one-line benefit statement per component.

## Measurement plan
- **MEASURED (available now):** provider aggregate input/output/cache_read/cache_creation per turn (token_usage table); commit shas (git); deploy ids (Render deploy-history); /health runtime snapshot; kanban card/event evidence.
- **ESTIMATED:** fresh-input per replay (S1 ~1500, S2 ~2500–3500) until the W4 origin-tagging runs live; occupied_context_estimate; kernel ceremony-token overhead.
- **UNKNOWN (carried, not invented):** the fresh-vs-inherited split of a turn's input; the inherited mega-session size in APG-origin terms; system/tool separability (provider-dependent); historically-unreconstructable identity fields on S2.
- Ceremony overhead is measured per replay as: (records_written across the sidecar tables) + (kernel token spend, ESTIMATED now / MEASURED once W4 is live) + (source-read runtime). Each is attributed to a consuming checkpoint/report; unconsumed → not built.

## Go / no-go for a later LIVE pilot
**GO to a live pilot only if ALL:**
1. Both shadow replays completed with honest, gap-explicit receipts (Goal 1 MET).
2. Deterministic checkpoints proven reproducible + LLM-free (Goal 4 MET).
3. Test-identity contract proven on S2 with real PASS/MISSING (Goal 2 MET).
4. Token instrumentation proven to label correctly (Goal 3 MET as honesty, even if reduction stays UNKNOWN).
5. Ceremony overhead judged < benefit on BOTH replays (Goal 5 MET).
6. Uninstall verified: deleting the sidecar leaves zero Marveen-core residue.

**NO-GO (stay in shadow / revise) if any:** a checkpoint needs an LLM; evidence had to be invented to complete a chain; the kernel wrote to Marveen core DB; ceremony overhead exceeded benefit; or the token model produced an unbacked savings claim.

**Live-pilot delta (what changes shadow→live, NOT built now):** the source adapters gain authenticated write/event paths; the identity contract rides the real request; checkpoints may add the `semantic_by_risk` review tier (one independent verifier, still no homogeneous voting). Everything OUT OF SCOPE (runner, dispatch, kanban write-back, prod deploy, dashboard) stays out until a separate owner decision.
