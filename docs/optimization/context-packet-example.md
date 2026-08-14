<!-- GENERATED from src/context-packet-example.ts (EXAMPLE_PACKET) via renderExamplePacketDoc().
     Do not hand-edit: src/__tests__/context-packet.test.ts asserts byte equality.
     Regenerate with: npx tsx scripts/render-context-packet-example.ts -->

# Context Packet -- card a1b2c3d4

> packetVersion: p2b-1 | executionRole: producer | taskSize: normal | contextBudgetClass: standard

## Goal
Raise the dashboard token-usage page from per-agent totals to per-agent, per-model totals, reading from the existing token_usage rows. Measurement only: no new collector, no schema change.

## Canonical references
- `docs/optimization/marveen-lean-optimization-audit-2026-07-17.md` @ 9dd1c27 (sha256 8fea93350442, 57 bytes)
  - Section "Token accounting" states the requirement. Read that section only; the rest is out of scope.
  - excerpt:
    > Per-agent totals hide which model burned the budget: two agents on the same profile can differ 10x.
- `src/context-guard.ts` @ 9dd1c27 (sha256 3ab57e1000ab, 41 bytes)
  - Live thresholds are actPct 0.90 / hardPct 0.97 at :54-55 -- do not "restore" the older 85/90/92/97 numbers.
  - excerpt:
    > actPct: 0.90,
    > hardPct: 0.97,

## Relevant constraints
- Additive only: no change to how token_usage rows are written or ingested.
- CostOps stays the single measurement system -- no second usage ledger.
- Unpriced models must render as unknown, never as a fabricated 0.
- No LLM on the aggregation path; deterministic SQL only.

## Data sensitivity
- class: internal
- Aggregates only. No prompt text, no transcript content, no account identifiers in the output.
- Referenced artifacts are carried by path + commit + hash; open them locally rather than quoting them.

## Done when
- The page shows one row per (agent, model) with input/output/cache tokens and estimated cost.
- A model with no pricing row renders "unknown", proven by a test.
- npx tsc --noEmit exits 0 and the full vitest suite stays green.
