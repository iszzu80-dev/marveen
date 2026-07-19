# Proposal: provider-agnostic, capacity-aware model profile routing

## Problem summary

Marveen runs many agents with different roles, costs, privacy needs, and runtime patterns, but model selection is effectively hardcoded per agent. Two gaps:

1. **No per-agent model policy** — cheap workers, senior-reasoning, privacy-sensitive, and final-review agents need different primary/fallback rules without naming a provider.
2. **No capacity awareness** — providers go limited/blocked (rate limits, quota/balance exhaustion, spend caps, CLI subscription limits, regional cloud quota, local resource pressure) and there is no deterministic way to fall back for one task, audit it, and retry the primary later.

Desired shape: `agent → model profile → capacity-aware candidate → runtime-only fallback → audit → retry primary later`.

## Why this is upstream-compatible

- Adds **generic schema + abstractions only**; all provider/account/subscription details stay deployment-local.
- **Backward compatible**: existing `{"model": "..."}` keeps working; `modelProfile` is opt-in; unknown profile is a validation error, never silent fallback.
- Ships as a **small PR series**, so the schema can land without committing to probes or routing changes.
- Vendor differences live behind **adapter interfaces**, never in core.

## Core abstractions

- **`modelProfile`** — an agent's model needs by name (e.g. `cheap_worker`, `senior_reasoning`, `privacy_sensitive`, `final_review`), not a hardcoded provider. Any agent maps to any profile.
- **`authProfile`** — abstracts credentials/accounts/keys/subscriptions/local runtimes; core stays vendor-neutral.
- **`quotaScope`** — the unit of capacity consumption (account, api_key/project, project+region+model, workspace/license, subscription, local_machine, unknown). Provider ≠ account ≠ key ≠ project ≠ region ≠ subscription.
- **`capacityState`** — `available | degraded | limited | blocked | unknown`, each with a `confidence` (`observed | inferred | manual | unknown`).
- **fallback mode** — `none | auto | ask | manual_only`.
- **`runtimeActiveModel`** — kept separate from `configuredPrimary`; fallback is runtime-only.

## Deterministic opsmonitor

Split into `capacity-monitor` (deterministic signal collector) → `capacity-router` (deterministic decision engine) → optional `ops-summary` (LLM explanation only after a deterministic signal fires). Guiding rule: **do not spend LLM quota to monitor LLM quota** — no always-on LLM monitor.

## Subscription/CLI vs prepaid/API quotas (both first-class)

- **Prepaid / pay-as-you-go API** — usually `observed`: HTTP error codes, usage/billing APIs, spend limits. Balance/spend exhausted → `blocked`; rate limit → `limited`; 5xx/timeout → `degraded`.
- **Subscription / CLI** — usually `inferred`/`manual`: `/status`, warning text, reset hints, usage dashboards, operator override. Treated conservatively; `unknown` follows a conservative policy.

## Non-normative provider examples

Illustrations only; core hardcodes none of this.

- **Claude / Anthropic** — API gives observed rate/spend signals; Pro/Max CLI exposes usage via `/status` + reset (confidence `inferred`/`manual`).
- **DeepSeek** — `402` balance → `blocked`, `429` → `limited`, 5xx/timeout → `degraded` (all `observed`).
- **OpenAI / Codex** — API key = standard API pricing (prepaid/project budget as capacity scope); Codex CLI shows limits via dashboard + `/status` (`inferred`).
- **Gemini / Vertex** — split by surface: Developer API (project tier), Vertex (quota keyed by project+region+model+service account), Gemini CLI / Code Assist (documented together, can share quota).
- **Local models / Ollama** — local runtime down → `blocked`, overloaded → `degraded`, recent success → `available`.

## Guardrails

- Fallback is **runtime-only** and must **never overwrite the configured primary** (primary retried after `retryPrimaryAfter` or on next task).
- Privacy-sensitive profiles default to `ask`/`manual_only`, **never** `auto`.
- **No automatic privacy downgrade** — cross-provider / lower-privacy-tier fallback requires explicit policy.
- No fallback on validation / tool / safety / bad-input / test failures — those are not provider-capacity failures.
- Secrets never logged; `authProfile` names are fine, raw tokens/keys/billing identifiers are not.

## Suggested PR series (first MVP = PR1)

1. **PR1 — modelProfiles + fallback schema + resolver**: config schema, per-agent `modelProfile`, fallback modes, legacy `model`-string compatibility, resolver that selects the configured primary. No probes, no automatic routing change unless explicitly configured.
2. **PR2 — capacity state registry**: `capacityState`, `confidence`, `quotaScope`, TTL, reason, lastSeen, resetHint; read-only API/dashboard surface.
3. **PR3 — capacity-aware fallback resolver**: primary capacity check, fallback chain, runtime-only active model, `retryPrimaryAfter`, fallback event logging; no persistent primary overwrite.
4. **PR4 — deterministic provider probes / opsmonitor**: DeepSeek classifier + Claude/Codex/Gemini/Vertex/local adapter interfaces; no always-on LLM monitor.

## Non-goals (MVP)

No cost optimizer, no peak/off-peak scheduler, no fleet-wide migration, no vendor-specific subscription logic, no automatic privacy downgrade, no always-on LLM monitor, no UI editor, no prompt-quality-based switching, no benchmarking, no automated provider top-up.

## Open questions

1. Where do profiles live (repo config / `store/` / deployment-local), and are local overrides gitignored by default?
2. Fallback decision scope: task, session, or time-window?
3. Default behavior for `capacityState = unknown`?
4. `ask` mode: dashboard decision, chat prompt, or both?
5. Capacity-state TTL global or per-provider?
6. Provider probes on by default or opt-in?
7. How to represent API spend limits without exposing billing secrets?
8. Local models: providers or separate runtime resources?
9. Profile changes: restart-required or hot-reloadable?

## Related prior art

Dispatch-safety work landed in **#516** (`fix(dispatch): refuse prompts to context-saturated sessions`), merged and released in **v1.18.7** — reference it as a capacity-safety precedent. This proposal is **separate** from #516 and from the **#129** forceSend/CTX_SAT follow-up; both remain out of scope here. A longer local design note exists and can be turned into a PR/ADR if this direction looks useful.
