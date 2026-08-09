# APG v0.4-lean — Upstream Candidates

Date: 2026-07-16 · Read-only. No upstream issue/PR opened (per request constraints).

## Principle
Generic layer carries **no provider/model/tool hardcode** (agent-routing.yaml: provider_resolution delegated to CostOps/capacity router; methodology stores capability class only). This matches Marveen's existing seam discipline (local-fork touches upstream-owned files only via marked seams). So an item is an UPSTREAM candidate only if it is generic (product- and provider-agnostic); anything product-specific stays PRODUCT_LOCAL.

## Candidates (generic, shared-layer)

| Candidate | From gap | Why upstream (generic) | Size | Priority |
|---|---|---|---|---|
| Token-origin decomposition | GAP-APG-01 | Every agent/change needs the fresh-vs-inherited-vs-cache split to enforce ANY context budget; provider-agnostic (works off the raw usage fields all providers return). | small | **P0** (prerequisite for budget enforcement) |
| CostOps ↔ control-plane / capacity resolver | GAP-APG-04 | CostOps is already the shared cost/limits layer; exposing it as the capability-class → provider resolver is the natural home. Keeps vendor choice OUT of the methodology. | small | **P0** (unblocks routing) |
| Overclaim/political-claim deterministic review gate | shadow-replay finding | Tonight this caught the MK-KATA political claim + DORA overclaims by hand; as a generic `review` deterministic check it is cheap and product-agnostic (a term/claim lint). | small | **P0** (high value / low cost) |
| Commit→build→deploy→runtime execution-receipt | GAP-APG-02 | Generic evidence-chain over git + Render + /health; every product's release_ready gate needs it. | small-medium | P1 |
| Structured identity marker (actor/tenant/data/test_run/env) | GAP-APG-03 | Generic; needed for test-identity isolation on ALL products. Authenticated-identity is a SEPARATE upstream hardening (bus sender-auth, card 06f062e4). | medium | P1 (auth part P2) |
| Intel registry | GAP-APG-05 | Generic reference-able market/competitor/VoC store; replaces loading full research docs (context-budget). | medium | P1 |
| Staging/canary release stage | GAP-APG-06 | Generic safe-release substrate (risk-based; low-risk stays smoke+rollback). | medium | P2 (only high-risk changes need it) |

## NOT upstream (stay local/product)
- **Per-product surface descriptor** (GAP-APG-07 / PRODUCT_LOCAL) — each product's launch-state/surface shape is product-specific; APG reads it per-product, it is not a shared artifact.
- Any provider/model choice (DeepSeek/Max/gpt-5.6-sol routing) — stays in CostOps/capacity resolver, never in the methodology (no-vendor-hardcode).

## Cost/benefit gate (methodology rule: measurable benefit + cost for each new complexity)
Recommended ordering by benefit/cost: (1) overclaim review gate — near-zero cost, prevents live public-claim incidents; (2) token-origin decomposition — small, unlocks budget enforcement; (3) CostOps capacity resolver — small, ends manual routing; then the P1/P2 evidence/identity/intel/canary items as real APG runs demand them. Do NOT build the full apparatus up front — each item earns its place when a change actually needs it (lean v0.4 intent).
