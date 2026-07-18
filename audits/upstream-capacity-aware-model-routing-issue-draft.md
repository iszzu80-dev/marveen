# Upstream issue draft: capacity-aware model profile routing

> Draft only. Not pushed, no issue opened. Condensed from
> `audits/upstream-capacity-aware-model-routing-design.md` for direct paste into a GitHub issue.

---

## Suggested issue title

`Proposal: provider-agnostic, capacity-aware model profile routing`

---

## 1. Problem summary

Marveen runs many agents with different roles, costs, privacy expectations, and runtime patterns, but model selection is effectively a single/hardcoded choice per agent. Two gaps:

1. **No per-agent model policy abstraction** — cheap workers, senior reasoning, privacy-sensitive, and final-review agents all need different primary/fallback rules, without hardcoding a provider.
2. **No capacity awareness** — providers go `limited`/`blocked` from rate limits, quota/balance exhaustion, spend caps, CLI subscription limits, regional cloud quota, or local resource pressure. Today there is no deterministic way to notice this, fall back for one task, audit it, and retry the primary later.

The general need is: `agent → model profile → capacity-aware candidate → runtime-only fallback → audit → retry primary later`.

## 2. Why this is upstream-compatible

- It adds **generic abstractions and schema**, not deployment secrets. All provider/account/subscription details stay deployment-local.
- It is **backward compatible**: existing `{"model": "..."}` config keeps working; `modelProfile` is opt-in. Unknown profile = validation error, never silent fallback.
- It builds on what Marveen already is (multi-agent, skills, scheduled tasks, dashboard), so agent-level model policy is a natural extension.
- It ships as a **small PR series**, so maintainers can accept the schema without committing to probes or routing changes.

## 3. Why it is NOT provider-specific

- Core logic never names a vendor. Providers/accounts are bound through `authProfile` + `quotaScope` in deployment-local config.
- Vendor differences (CLI vs API vs cloud-project) are handled by **adapter interfaces**, not core branching.
- All vendor references in this proposal are **non-normative examples** to prove the abstractions generalize.

## 4. Main abstractions

- **`modelProfile`** — an agent's model needs by name (e.g. `cheap_worker`, `senior_reasoning`, `privacy_sensitive`, `final_review`), not a hardcoded provider. Any agent name maps to any profile.
- **`authProfile`** — abstracts credentials/accounts/keys/subscriptions/local runtimes; core logic stays vendor-neutral.
- **`quotaScope`** — the unit of capacity consumption (account, api_key/project, project+region+model, workspace/license, subscription, local_machine, unknown). Needed because provider ≠ account ≠ key ≠ project ≠ region ≠ subscription (critical for Gemini/Vertex).
- **`capacityState`** — `available | degraded | limited | blocked | unknown`, each carrying a `confidence` of `observed | inferred | manual | unknown`.
- **fallback mode** — `none | auto | ask | manual_only`. Privacy-sensitive profiles default to `ask`/`manual_only`, never `auto`.
- **`runtimeActiveModel`** — separate from `configuredPrimary`. **Fallback is runtime-only and must never overwrite the configured primary.** Primary is retried after `retryPrimaryAfter` or on next task. All fallback events are auditable.

## 5. Why a deterministic opsmonitor (not a light LLM agent)

Separation:

- `capacity-monitor` = deterministic signal collector (error codes, CLI warnings, reset hints, auth mode, recent success/failure, latency/timeout, queue depth, health probes, manual override).
- `capacity-router` = deterministic decision engine.
- `ops-summary` = optional LLM explanation, triggered **only after** deterministic signals flag an issue.

Guiding rule: **do not spend LLM quota to monitor LLM quota.** An always-on LLM monitor is cost, a failure mode, and non-determinism where a rules engine suffices.

## 6. Subscription/CLI limits vs prepaid/API quotas

Both are first-class, but treated with different confidence:

- **Prepaid / pay-as-you-go API** — usually **`observed`**: HTTP error codes, usage/billing APIs, spend limits are programmatically checkable. Balance/spend exhausted → `blocked`; rate limit → `limited`; 5xx/timeout → `degraded`; recent success → `available`.
- **Subscription / CLI** — usually **`inferred`/`manual`**: signals are `/status` output, warning text, reset hints, usage dashboards, operator override. Treated conservatively; `unknown` follows a conservative policy.

## 7. Provider examples (NON-NORMATIVE)

Illustrations only; core must not hardcode any of this:

- **DeepSeek API** — strongest mapping: `402` insufficient balance → `blocked` (observed), `429` → `limited` (observed), 5xx/timeout → `degraded`.
- **Claude / Claude Code** — API surface gives observed rate/spend signals; Pro/Max CLI exposes usage via `/status` + reset behavior rather than a generic quota API, so confidence is typically `inferred`/`manual`.
- **OpenAI / Codex** — API key usage follows standard API pricing (prepaid credits/project budget = capacity scope); Codex CLI shows limits via usage dashboard and `/status`, best-effort `inferred`.
- **Gemini** — must split by surface: Developer API (project usage tier), Vertex AI (quota keyed by project+region+model+service account), Gemini CLI / Code Assist (documented together, can share quota). Good stress test for `quotaScope`.

## 8. Suggested PR series (not one large PR)

- **PR1 — schema + resolver**: `modelProfile` field, fallback modes, legacy `model` string compatibility, resolver that selects the configured primary. No probes, no routing change unless explicitly configured.
- **PR2 — capacity state registry**: `capacityState`, `confidence`, `quotaScope`, TTL, reason, `lastSeen`, `resetHint`; read-only API/dashboard surface.
- **PR3 — capacity-aware fallback resolver**: primary capacity check, fallback chain, runtime-only `activeModel`, `retryPrimaryAfter`, fallback event logging; no persistent primary overwrite.
- **PR4 — deterministic provider probes / opsmonitor**: DeepSeek error classifier, Claude CLI warning parser interface, Codex status adapter, Gemini/Vertex/CLI adapter interfaces, local-model probe interface; no always-on LLM monitor.

## 9. Non-goals (MVP)

No cost optimizer, no peak/off-peak scheduler, no fleet-wide model migration, no vendor-specific subscription logic, no automatic privacy downgrade, no always-on LLM opsmonitor, no UI editor, no prompt-quality-based switching, no benchmarking, no automated provider top-up, no automatic API overflow spend without operator policy.

## 10. Open questions

1. Where do profiles live: repo config, `store/`, or deployment-local config (and are local overrides gitignored by default)?
2. Is a fallback decision task-, session-, or time-window-scoped?
3. Default behavior for `capacityState = unknown`?
4. Does `ask` mode create a dashboard decision, a chat/Telegram prompt, or both?
5. Capacity-state TTL: global or provider-specific?
6. Provider probes on by default or opt-in?
7. How to represent API spend limits without exposing billing secrets?
8. Are local models providers or separate runtime resources?
9. Profile changes: restart required, or hot-reloadable?

## 11. Relationship to existing work

- **PR #516** (`fix(dispatch): refuse prompts to context-saturated sessions`) is a narrow dispatch-safety bugfix. Reference it as related capacity-safety prior art only; do **not** fold it into this design.
- **#129** (forceSend + CTX_SAT policy) is a separate follow-up. Keep separate.

---

## Verdict

- **Suitable to open as a GitHub issue?** Yes, as a **discussion/proposal issue** scoped to PR1 (schema + resolver). It is generic, backward-compatible, and clearly bounded by non-goals. It is not yet an implementation ticket.
- **Needs more shortening?** For the issue body itself, consider trimming §7 to one line per provider and dropping the §5 signal enumeration; the four-PR breakdown, non-goals, and the runtime-only guardrail are the parts maintainers most need. The full design doc can be linked rather than pasted.
- **Wait for #516 review first?** Recommended. #516 is the concrete, in-flight change and shares the "capacity safety" framing. Opening this large proposal before #516 lands risks conflating the two in review and diluting #516. Open this once #516 is merged/closed, referencing it as prior art.

*Draft prepared 2026-07-03. Source: audits/upstream-capacity-aware-model-routing-design.md. Nothing implemented, no source/config changes, no push.*
