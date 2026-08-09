# APG v0.4-lean — Token Baseline (AS-IS vs APG fresh input)

Date: 2026-07-16 · Mode: measure-or-estimate, read-only

## Measurement fields (context-budget.yaml)
system_and_tools_input · inherited_context_input · apg_packet_fresh_input · on_demand_fresh_input · cache_creation_input · cache_read_input · output · cost_amount

## What CAN be measured today vs what needs the adapter
- **Measurable now (aggregate):** input / output / cache_creation / cache_read — the Claude API returns these per turn (e.g. a Codex app-server probe this session showed `input_tokens: 12271, cached_input_tokens: 9984, output_tokens: 14`). CostOps `token_usage` also aggregates volume.
- **NOT measurable now (needs GAP-APG-01 adapter):** the SPLIT of input into `system_and_tools` vs `inherited_context` vs `apg_packet_fresh` vs `on_demand_fresh`. Today it is one opaque `input` number; APG needs it decomposed by origin to enforce the 3000/5000 budget.

## AS-IS baseline (tonight's flow, the LumaSeat couple-facing change as the unit)
- The change was executed INSIDE one very long fleet session (this one). Characteristic: **inherited_context_input dominates** — every decision sits on the full accumulated conversation (many thousands of tokens of prior fleet coordination), most of it served from cache (high cache_read, which is cheap) but still occupying the context window.
- apg_packet_fresh for the actual LumaSeat decision was SMALL (~1200–1800 tokens: the requirement + scope + overclaim list). The cost was not the fresh input — it was carrying the mega-context.
- Cost shape: low marginal $ per decision (cache_read is ~10% the price of fresh input) but HIGH occupied-context (drives the context-accumulation / memory-RSS behavior noted in `sonnet-context-accumulation-memory-driver`).

## APG target for the same change (S1)
- `apg_packet_fresh_input` target: ≤ **3000** (S1). Estimated actual: **~1500** for the LumaSeat change — comfortably under.
- `inherited_context_input`: bounded to the stable cacheable prefix (methodology + ui-fullstack profile + product ref), NOT the whole session.
- `on_demand_fresh_input`: ≤ 1500 per pull (prior landing copy fetched just-in-time by reference, not preloaded).
- Net delta: **same decision, same fresh-input, but decoupled from a multi-thousand-token inherited session** → large occupied-context saving, and the change becomes independently replayable/auditable.

## Key insight
The 3000/5000 budget is not really about the FRESH input (which is already small for most changes) — it is about **not carrying a mega-session as inherited context**. Tonight proved the failure mode: excellent decisions, but all riding one enormous accumulating context. APG's "stable cacheable prefix + bounded fresh packet + references-first" directly targets exactly this. The measurement gap (GAP-APG-01) is the prerequisite: you cannot enforce a budget you cannot decompose.

## Cache mechanics (already true, keep)
- Cache_creation is paid once; cache_read is ~10% cost — so a stable cacheable prefix is cheap to re-read. APG's "stable prefix precedes variable context" rule is aligned with how the billing actually works (measure cache-savings and occupied-context SEPARATELY — context-budget.yaml rule).
