# Phase 4 Market Snapshot -- Structure & Sourcing

**Date:** 2026-07-30
**Agent:** research (agent_id: research)
**Requested by:** marveen (Lean Optimization Phase 4 INPUT DATA gathering)
**Deliverable:** Read-only factual snapshot of LLM/agent-runtime packages for the Phase 4 portfolio recommendation engine.

## Scope

Providers captured, divided into two groups:

### Active fleet cost centers (verified)
- **Anthropic** -- Claude subscriptions (two accounts) + API PAYG. Primary cost driver.
- **OpenAI** -- ChatGPT Plus, used for Codex CLI delegation. Secondary cost.
- **DeepSeek** -- API PAYG only. No subscription exists. Secondary/fallback model provider.

### Market comparison (not currently used by fleet)
- **Google Gemini** -- Consumer subscriptions + API PAYG. Full model range from $0.10/1M to $2.00/1M input.
- **GitHub Copilot** -- $10-39/month individual plans. Usage-based credit model since June 2026.
- **Cursor** -- $20-200/month individual plans. Credit-based with BYOK escape hatch.
- **Windsurf (Codeium)** -- $20-200/month individual plans. Daily/weekly quota model since March 2026 restructure.

## Package dimensions captured

For each package in the JSON:

| Dimension | Description |
|-----------|-------------|
| Provider | Company name |
| Package name | Product/plan identifier |
| Monthly price + currency | As published, not converted |
| Quota/limit | What the user actually gets (messages, tokens, credits, rate windows). Where not published: `NOT PUBLISHED` |
| Overage/credits | Whether usage beyond quota is possible and how it's billed |
| Contract granularity | Monthly, annual, or both |
| Source URL | The page the number came from |
| Read date | 2026-07-30 for all entries |

## Sourcing method

1. **Anthropic API pricing**: From the `claude-api` skill (bundled Claude Code skill, cache date 2026-06-24). This is the authoritative source for first-party API rates -- the skill is maintained against `platform.claude.com/docs/en/about-claude/models/overview.md`.

2. **Anthropic subscription pricing**: WebSearch against `support.claude.com` (official help center) and third-party pricing aggregators (`spendhound.com`, `morphllm.com`, `cloudzero.com`). Cross-referenced across multiple sources.

3. **OpenAI subscription pricing**: WebSearch against `chatgpt.com/pricing` and third-party aggregators (`morphllm.com`, `pricepertoken.com`).

4. **DeepSeek API pricing**: WebSearch against `api-docs.deepseek.com/quick_start/pricing` (official docs) and `morphllm.com`.

5. **Google Gemini**: WebSearch against `ai.google.dev/gemini-api/docs/pricing` (official API pricing) and `pricepertoken.com` (consumer subscription details).

6. **Coding-tier alternatives**: WebSearch against official pricing pages and aggregators (`cloudzero.com`, `morphllm.com`, `amnic.com`).

**Egress limitation note**: Direct WebFetch to pricing pages was blocked by the egress gate (domains not on main-agent or quarantine-reader allowlists). All data was collected via WebSearch, which queries indexed/cached content. Numbers were cross-referenced across 2-3 independent aggregator sources per provider. Where sources conflicted, the official provider page (as reflected in search snippets) was preferred.

## What's NOT in this snapshot

- **OpenAI API pricing**: Not fetched. Fleet uses ChatGPT Plus subscription for Codex CLI, not direct API. A separate API account would have its own per-token pricing.
- **Actual fleet consumption**: This is a price list, not an invoice. Monthly spend data lives in CostOps.
- **Render/Infrastructure costs**: Out of scope -- this is LLM/agent-runtime pricing only.
- **Currency conversion**: All prices as published in USD. EUR/HUF conversion is not applied (card 08b2ff9e).

## Data file

The full structured snapshot with all prices is at `store/market-snapshot-2026-07-30.json` (gitignored by program rule -- `store/` is in `.gitignore`).

---

## marveen's gate notes (added by the orchestrator, not the producing agent)

### What I verified myself
31 source URLs, 37 read-date fields, **13 literal `NOT PUBLISHED` markers**, and no fabricated
figures on inspection. Every package entry carries its own `source_url` + `read_date`, so provenance
is per-row: one stale entry cannot borrow a fresher one's credibility. The discipline held.

### The confidence ceiling this snapshot must carry into Phase 4
The producer's own "egress limitation note" above is the most important line in this document and
must not be lost when the numbers are consumed. **No figure here was read off a vendor pricing page
directly** -- WebFetch was blocked by the egress gate, so everything came from WebSearch snippets and
third-party aggregators (`spendhound`, `morphllm`, `cloudzero`, `pricepertoken`, `amnic`),
cross-referenced 2-3 sources per provider.

Consequence for Phase 4: these are **`inferred`-grade inputs, not `measured`**. Aggregators go stale,
mis-tier plans, and copy each other's errors, so agreement between two of them is weaker evidence than
it looks. The recommendation engine must not present a KEEP/UPGRADE/DOWNGRADE/CANCEL conclusion that
rests on these numbers as though the price were established fact; any such recommendation carries at
most `inferred` confidence and should name the aggregator it came from. Before a recommendation drives
real money, the specific figure it hinges on gets re-confirmed against the vendor's own page.

Also note the Anthropic API rates came from the bundled `claude-api` skill with a **cache date of
2026-06-24** -- roughly five weeks stale as of this snapshot. Fine for ranking, not for billing.

### Provenance caveat about the producing agent
`research` resolves via `modelProfile: analysis_efficient` to **`deepseek-v4-pro`**, an external
non-trusted provider. Starting it violated this program's own standing rule ("never restore a DeepSeek
agent"); I did it by misreading a `model: None` config field as "default Claude" instead of resolving
the profile through `store/model-profile-map.json`. The agent was stopped as soon as its deliverables
landed. Cost ≈ $0.21 (deepseek balance 8.95 → 8.74 USD, sole traffic in that window). Reported to the
owner the same hour.

The **deliverable itself carries no confidentiality problem** -- it is public vendor pricing. The
violation was on the *input* side: our provider topology (two Claude accounts, ChatGPT Plus for Codex,
DeepSeek as api_payg) went out in the task text. No credentials, keys, customer data or PII were
involved. Recorded here so a future reader knows which agent produced this and under what conditions,
instead of inheriting it as unattributed fact.

### Owner-supplied gaps that block our own headroom (not the market view)
- Which Claude/ChatGPT plans are live, their status and next renewal. `costops_invoices` has **0 rows**,
  so there is nothing verified to derive it from and I did not invent it.
- Optionally a manual usage-percent reading off the Claude UI: **Anthropic exposes no quota/usage API
  (re-verified 2026-07-30)**, so subscription capacity stays honestly `unknown` until a human reads it.
- `anthropic_admin_key` in the vault, if the `anthropic-cost-report` collector should work.

Until those land, Phase 4 can rank *market* options but cannot compute our own subscription headroom,
and must answer `INSUFFICIENT_EVIDENCE` rather than guess.
