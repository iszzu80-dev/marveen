Capacity-aware model profile routing for Marveen

1. Executive summary

This document proposes a provider-agnostic model routing framework for Marveen.

The goal is to let each agent use a configurable "modelProfile" instead of hardcoded provider/model choices. A model profile defines a primary model candidate and an optional fallback policy. Fallback decisions are informed by a deterministic capacity-state layer, not by an always-running LLM monitor.

This design is intentionally independent from any specific deployment’s subscriptions or providers. It should support Claude, OpenAI/Codex, DeepSeek, Gemini, Vertex AI, local models, and future providers through the same abstractions:

- "modelProfile"
- "authProfile"
- "quotaScope"
- "capacityState"
- "fallbackPolicy"
- "runtimeActiveModel"
- "capacitySignal"

The primary design rule is:

Fallback is runtime-only and must never overwrite the configured primary model.

This is important because other agent frameworks have seen fallback bugs where the fallback model permanently replaced the primary configuration, causing the system never to retry the original primary after recovery.

This proposal is separate from Marveen PR #516, which is a concrete dispatch safety bugfix for context-saturated sessions. PR #516 can be referenced as related prior work, but it should not be mixed with this larger model-routing design.

---

2. Problem statement

Marveen can run many agents with different roles, priorities, costs, privacy expectations, and runtime patterns. A single global model choice is not enough.

Different agents may need different model policies:

- high-volume routine workers may prefer cheap/fast models;
- senior reasoning agents may need stronger reasoning;
- legal/security/privacy-sensitive agents may require stricter provider boundaries;
- final review may require a premium/manual-only model;
- coding agents may benefit from CLI tools such as Claude Code, Codex CLI, Gemini CLI, or API-based fallbacks.

At the same time, model capacity is not static. Providers can become unavailable or limited due to:

- rate limits;
- quota exhaustion;
- prepaid balance exhaustion;
- monthly spend limit;
- project budget;
- CLI subscription usage limit;
- workspace/license quota;
- regional cloud quota;
- timeouts;
- temporary 5xx errors;
- local model resource pressure.

The current desired capability is not simply “fallback model if primary fails”. The more general need is:

agent → model profile → capacity-aware model candidate selection → runtime-only fallback → audit trail → retry primary later.

---

3. Source basis and current reality

Marveen is already a multi-agent framework with agents, skills, scheduled tasks, dashboard-oriented operation, and fleet-level capabilities. That makes agent-level model policy a natural extension, but the design must remain role-agnostic and deployment-agnostic.

Claude Code with Pro/Max plans exposes usage status through the CLI "/status" command and plan usage/reset behavior rather than a simple generic quota API; official Claude docs also distinguish Claude Code plan usage from API-key usage, where API-key usage is pay-as-you-go through the relevant account.

DeepSeek API has strong deterministic error signals: official docs define "402" as insufficient balance and "429" as rate limit reached, which map naturally to "blocked" and "limited" capacity states.

Codex exposes current limits in the Codex usage dashboard and "/status" during an active Codex CLI session; Codex API-key authentication uses standard API pricing rather than included ChatGPT plan credits.

Gemini must be split by surface: Gemini Developer API, Vertex AI Gemini, and Gemini CLI / Gemini Code Assist have different quota scopes. Gemini API rate limits are tied to project usage tier, while Gemini Code Assist and Gemini CLI quotas are documented together and can share limits.

Other agent/router projects show the same design pressure: OpenCode has feature requests for agent-level model pools and fallback policies; OpenClaw documents model failover concepts and has seen bugs around sticky fallback state.

Based on current local Marveen audits, Marveen has partial model concepts such as agent-level model fields and active model state, but not a complete provider-agnostic, quota-scope-aware, capacity-state-driven model profile and fallback framework.

---

4. Relationship to PR #516 and #129

PR #516

PR #516 is a concrete bugfix:

fix(dispatch): refuse prompts to context-saturated sessions

It prevents dispatch into agent sessions that visually look idle but are already at 100% context. This is a dispatch safety primitive.

It should remain separate from this design.

#129 forceSend + CTX_SAT

The #129 work concerns forceSend behavior when a task targets a context-saturated agent. This is a policy follow-up and should remain separate.

This design

This document proposes a broader model/capacity routing framework. It can reference PR #516 as related capacity-safety prior art, but it should not include PR #516 implementation or #129 forceSend policy.

---

5. Core concepts

5.1 modelProfile

A "modelProfile" describes the model needs of an agent without naming a hardcoded provider.

Example profile names:

cheap_worker
senior_reasoning
coding_assistant
privacy_sensitive
final_review
default

These are examples only. Marveen should not hardcode these role names.

An agent can be mapped to a profile:

agents:
  jogasz:
    modelProfile: privacy_sensitive

  architect:
    modelProfile: senior_reasoning

  codeworker:
    modelProfile: coding_assistant

  any_custom_agent:
    modelProfile: cheap_worker

The mapping must work for any agent name.

5.2 authProfile

An "authProfile" abstracts credentials, accounts, API keys, subscriptions, service accounts, or local runtimes.

It should not encode vendor-specific assumptions in core logic.

Examples:

authProfiles:
  premium_default:
    description: "High-quality cloud account"

  economical_default:
    description: "Low-cost API budget pool"

  coding_cli_account:
    description: "CLI-based coding assistant account"

  api_budget_pool:
    description: "Prepaid or project-budgeted API account"

  local_default:
    description: "Local model runtime"

A deployment can bind these to Claude, OpenAI, DeepSeek, Gemini, Vertex AI, Ollama, or another provider locally.

5.3 quotaScope

"quotaScope" is the unit of capacity consumption.

This is necessary because provider, model, account, API key, project, region, and subscription are not the same thing.

Examples:

quotaScope:
  type: account

quotaScope:
  type: api_key_or_project

quotaScope:
  type: project_region_model
  project: my-gcp-project
  region: europe-west4
  model: gemini-2.5-pro

quotaScope:
  type: workspace_license

quotaScope:
  type: subscription

quotaScope:
  type: local_machine

quotaScope:
  type: unknown

This is especially important for Gemini and Vertex AI, where quota can depend on project, tier, region, and model.

5.4 capacityState

A provider/auth/model/quota-scope combination has a capacity state:

type CapacityState =
  | "available"
  | "degraded"
  | "limited"
  | "blocked"
  | "unknown";

Meaning:

- "available": usable normally;
- "degraded": usable but recently slow, overloaded, or flaky;
- "limited": rate limited, near limit, or quota constrained;
- "blocked": hard stop, balance exhausted, auth failure, billing block;
- "unknown": no reliable current signal.

5.5 confidence

Every capacity signal should include confidence:

type CapacityConfidence =
  | "observed"
  | "inferred"
  | "manual"
  | "unknown";

Examples:

- DeepSeek "402" → "blocked", confidence "observed";
- DeepSeek "429" → "limited", confidence "observed";
- Claude Code warning text → "limited", confidence "inferred";
- Codex dashboard status → "available" or "limited", confidence "observed" or "inferred";
- manual operator override → confidence "manual".

5.6 fallback mode

Each fallback policy has an explicit mode:

type FallbackMode =
  | "none"
  | "auto"
  | "ask"
  | "manual_only";

Meaning:

- "none": no fallback;
- "auto": automatically select fallback if policy allows;
- "ask": create operator approval request;
- "manual_only": never fallback automatically.

Privacy-sensitive profiles should default to "ask" or "manual_only", not "auto".

5.7 runtimeActiveModel

The configured primary model and the runtime active model must be separate.

configuredPrimary:
  provider: premium
  model: strong
  authProfile: premium_default

runtimeActiveModel:
  provider: economical
  model: fallback_reasoning
  authProfile: api_budget_pool
  source: auto_fallback
  persisted: false

Rules:

- fallback must not overwrite configured primary;
- runtime fallback can apply for one task/session/window;
- primary should be retried after "retryPrimaryAfter" or on next task, depending on policy;
- fallback events must be auditable.

---

6. Schema proposal

Example generic schema:

modelProfiles:
  default:
    primary:
      provider: default
      model: default
      authProfile: default
    fallback:
      mode: none

  cheap_worker:
    primary:
      provider: economical
      model: fast
      authProfile: economical_default
    fallback:
      mode: auto
      whenPrimaryState:
        - degraded
        - limited
        - blocked
      chain:
        - provider: economical
          model: reliable
          authProfile: economical_default
      retryPrimaryAfter: 15m
      persistRuntimeFallback: false

  senior_reasoning:
    primary:
      provider: premium
      model: strong
      authProfile: premium_default
    fallback:
      mode: ask
      whenPrimaryState:
        - limited
        - blocked
      chain:
        - provider: standard
          model: strong_alt
          authProfile: standard_default
      retryPrimaryAfter: 30m
      persistRuntimeFallback: false

  privacy_sensitive:
    primary:
      provider: trusted
      model: strong_private
      authProfile: trusted_default
    fallback:
      mode: ask
      allowCrossProvider: false
      allowLowerPrivacyTier: false
      chain: []
      persistRuntimeFallback: false

  final_review:
    primary:
      provider: premium
      model: strongest
      authProfile: premium_default
    fallback:
      mode: manual_only
      persistRuntimeFallback: false

Provider examples:

providers:
  premium:
    surface: cli
    type: generic_cli_oauth

  economical:
    surface: api
    type: generic_http_api

  vertex:
    surface: cloud_project
    type: generic_cloud_project_api

  local:
    surface: local
    type: local_runtime

Capacity signal example:

{
  "provider": "economical",
  "surface": "api",
  "authProfile": "api_budget_pool",
  "quotaScope": "api_account_balance",
  "model": "fast",
  "state": "limited",
  "confidence": "observed",
  "reason": "rate_limit",
  "lastSeen": "2026-07-03T12:00:00Z",
  "resetHint": "unknown"
}

Fallback event example:

{
  "timestamp": "2026-07-03T12:00:00Z",
  "agent": "qa",
  "configuredProfile": "cheap_worker",
  "configuredPrimary": {
    "provider": "economical",
    "model": "fast",
    "authProfile": "economical_default"
  },
  "selectedActiveModel": {
    "provider": "economical",
    "model": "reliable",
    "authProfile": "economical_default"
  },
  "fallbackReason": "rate_limit",
  "capacityState": "limited",
  "confidence": "observed",
  "persisted": false,
  "retryPrimaryAfter": "15m"
}

---

7. Provider and surface examples

These examples are non-normative. Core Marveen should not hardcode vendor-specific subscription logic.

7.1 Anthropic Claude Code / Claude Pro-Max style CLI/OAuth

Surface: "cli"

Signals:

- CLI "/status";
- usage warning;
- reset hint;
- account plan metadata where available;
- manual baseline.

Capacity confidence is usually "inferred" or "manual", not fully observed. Claude Code plan docs explicitly point users to "/status" and reset behavior rather than a generic quota API.

7.2 Anthropic API

Surface: "api"

Signals:

- rate limit errors;
- spend limits;
- usage/cost API where available;
- billing/account status.

Anthropic API usage can be pay-as-you-go or cloud-account billed, so it should be represented as an "authProfile" with an API/spend quota scope rather than as a Pro/Max subscription.

7.3 DeepSeek API

Surface: "api"

Signals:

- "402" insufficient balance → "blocked";
- "429" rate limit → "limited";
- "500" / "503" / timeout → "degraded";
- recent success → "available".

DeepSeek’s official error code page directly supports this mapping.

7.4 OpenAI API

Surface: "api"

Signals:

- project budget;
- prepaid credits;
- rate limit;
- billing/spend controls;
- HTTP errors.

OpenAI prepaid billing lets API users pre-purchase credits that are applied to API usage, so prepaid/API balance should be part of the capacity design.

7.5 OpenAI Codex CLI / Codex usage surface

Surface: "cli" or "subscription_app"

Signals:

- Codex usage dashboard;
- "/status" inside active Codex CLI sessions;
- optional analytics/governance APIs for enterprise/workspace environments.

Codex docs say current limits are visible in the Codex usage dashboard and "/status" can show remaining limits during an active CLI session.

If Codex is authenticated with an API key, usage follows standard API pricing rather than included ChatGPT plan credits.

7.6 Gemini Developer API / AI Studio API

Surface: "api"

Signals:

- rate limit;
- quota tier;
- model/project-specific limits;
- API errors;
- AI Studio visible limits.

Gemini API rate limits are tied to a project’s usage tier and can change as usage/spending changes.

7.7 Vertex AI Gemini

Surface: "cloud_project"

Quota scope should include:

- project;
- region;
- model;
- auth profile / service account.

This is different from a simple account-level subscription.

7.8 Gemini CLI / Gemini Code Assist

Surface: "cli" or "subscription_app"

Signals:

- CLI quota;
- Code Assist quota;
- account/license edition;
- shared usage with agent mode or Code Assist surfaces.

Google documents Gemini Code Assist and Gemini CLI quotas together, and Gemini CLI quota can be shared with Gemini Code Assist agent mode.

7.9 Local model / Ollama

Surface: "local"

Signals:

- local service reachable;
- GPU/CPU memory;
- queue depth;
- process health;
- recent success;
- timeout.

Possible state mapping:

- local runtime down → "blocked";
- local runtime overloaded → "degraded";
- recent success → "available".

---

8. Prepaid/API capacity monitoring

Prepaid and pay-as-you-go API connections are first-class capacity scopes.

Examples:

authProfiles:
  deepseek_prepaid_main:
    provider: deepseek_api
    quotaScope:
      type: api_account_balance

  openai_project_main:
    provider: openai_api
    quotaScope:
      type: project_monthly_budget

  anthropic_workspace_main:
    provider: anthropic_api
    quotaScope:
      type: workspace_spend_limit

  gemini_api_project:
    provider: gemini_developer_api
    quotaScope:
      type: api_key_or_project

  vertex_eu:
    provider: vertex_ai_gemini
    quotaScope:
      type: project_region_model
      region: europe-west4

Mapping:

- API balance exhausted → "blocked";
- spend limit reached → "blocked";
- rate limit → "limited";
- 5xx / timeout → "degraded";
- recent success → "available";
- no signal → "unknown".

API signals are often more deterministic than subscription/CLI signals because HTTP errors, usage APIs, billing controls, and spend limits are easier to observe programmatically.

---

9. CLI/subscription capacity monitoring

CLI/subscription surfaces should be treated more conservatively.

Examples:

authProfiles:
  claude_code_personal:
    provider: anthropic_claude_code
    quotaScope:
      type: subscription

  codex_cli_workspace:
    provider: openai_codex_cli
    quotaScope:
      type: workspace_user

  gemini_cli_account:
    provider: gemini_cli_code_assist
    quotaScope:
      type: account_or_workspace_license

Signals may include:

- CLI "/status";
- warning text;
- reset hint;
- usage dashboard;
- manual operator override;
- recent success/failure.

Confidence is often "inferred" or "manual".

---

10. Deterministic opsmonitor design

The capacity monitor should not be an always-running LLM agent.

Proposed separation:

capacity-monitor = deterministic signal collector
capacity-router = deterministic decision engine
ops-summary = optional LLM summary only when human explanation is needed

Principle:

Do not spend LLM quota to monitor LLM quota.

The capacity monitor can collect:

- provider error codes;
- CLI warnings;
- usage/reset hints;
- auth mode;
- recent success/failure;
- timeout/latency;
- queue depth;
- pending task count;
- retry count;
- last successful model call;
- manual override state;
- provider health probes.

Optional LLM summary can be triggered only after deterministic signals identify an issue.

Example summary use case:

Primary coding CLI is limited. Economical API is available. Privacy-sensitive profiles are blocked from cross-provider auto fallback. Suggested action: move routine tasks to cheap_worker profile and ask operator before routing legal/security work.

---

11. Fallback resolver behavior

The resolver should use both policy and capacity state.

Example flow:

1. Agent has modelProfile = senior_reasoning.
2. Resolver finds configured primary.
3. Capacity registry says primary = available.
4. Use primary.

Fallback flow:

1. Agent has modelProfile = cheap_worker.
2. Primary capacityState = limited.
3. fallback.mode = auto.
4. Resolver picks first available fallback from chain.
5. activeModel is set runtime-only.
6. Fallback event is logged.
7. configuredPrimary remains unchanged.
8. retryPrimaryAfter controls when primary is tried again.

Ask/manual flow:

1. Agent has modelProfile = privacy_sensitive.
2. Primary capacityState = blocked.
3. fallback.mode = ask or manual_only.
4. System creates operator decision request or stops.
5. No automatic cross-provider fallback occurs.

No fallback should occur on:

- validation error;
- tool permission error;
- missing file;
- bad input;
- safety refusal;
- user confirmation required;
- deterministic test failure.

These are not provider-capacity failures.

---

12. Privacy and security considerations

Provider fallback can move data across providers. This must be explicit.

Policy fields:

fallback:
  allowCrossProvider: false
  allowLowerPrivacyTier: false
  mode: ask

Recommended defaults:

- routine workers: auto fallback can be allowed within same privacy tier;
- coding agents: ask or auto depending on repo/data sensitivity;
- legal/security/finance/privacy-sensitive agents: ask or manual_only;
- final review: manual_only.

Secrets must never be logged. "authProfile" names can be logged, but raw tokens, API keys, OAuth tokens, account emails, and billing identifiers should not appear in fallback logs.

---

13. Dashboard and API proposal

Dashboard should show:

- configured profile;
- configured primary;
- current active model;
- whether active model is fallback;
- capacity state;
- confidence;
- fallback reason;
- retry-primary timer;
- ask/manual approval queue.

API endpoints could include:

GET /api/model-profiles
GET /api/model-capacity
GET /api/model-fallback-events
POST /api/model-fallback-decisions/:id/approve
POST /api/model-fallback-decisions/:id/reject

These endpoints should be read-only by default except explicit operator decisions.

---

14. PR series breakdown

This should not be one large PR.

PR1 — model profiles + fallback schema + resolver

Suggested title:

feat(models): add model profiles and fallback policy schema

Scope:

- config schema;
- "modelProfile" field;
- fallback modes;
- legacy model string compatibility;
- resolver that selects configured primary;
- no provider probes yet;
- no automatic routing change unless explicitly configured.

PR2 — capacity state registry

Suggested title:

feat(models): add provider capacity state registry

Scope:

- "capacityState";
- "confidence";
- "quotaScope";
- TTL;
- reason;
- lastSeen;
- resetHint;
- read-only API/dashboard surface.

PR3 — capacity-aware fallback resolver

Suggested title:

feat(models): route fallbacks using provider capacity state

Scope:

- primary capacity check;
- fallback chain;
- runtime-only "activeModel";
- "retryPrimaryAfter";
- fallback event logging;
- no persistent primary overwrite.

PR4 — deterministic provider probes / opsmonitor integration

Suggested title:

feat(ops): add deterministic provider capacity probes

Scope:

- DeepSeek error classifier;
- Claude CLI warning parser interface;
- Codex best-effort status adapter;
- Gemini API / Vertex / CLI adapter interface;
- local model probe interface;
- no always-on LLM monitor.

---

15. Backward compatibility

Existing config must continue to work.

Examples:

{
  "model": "deepseek-v4-pro"
}

should remain valid.

New config is optional:

{
  "modelProfile": "senior_reasoning"
}

Precedence proposal:

1. explicit per-task model override
2. explicit agent model object
3. agent modelProfile
4. global default modelProfile
5. legacy agent.model string
6. system default

Unknown "modelProfile" should be a validation error, not a silent fallback.

---

16. Test plan

Minimum tests:

1. legacy "model" string continues to resolve;
2. agent "modelProfile" resolves to configured primary;
3. unknown "modelProfile" raises validation error;
4. auto fallback triggers only on allowed capacity states;
5. no fallback on validation/tool/safety/input errors;
6. "manual_only" never falls back automatically;
7. "ask" mode creates operator decision;
8. runtime active model does not overwrite configured primary;
9. "retryPrimaryAfter" retries primary later;
10. "unknown" capacity follows conservative policy;
11. DeepSeek "402" classifies as "blocked";
12. DeepSeek "429" classifies as "limited";
13. Claude warning parser returns "inferred" capacity;
14. Codex CLI status adapter includes confidence;
15. Gemini CLI / Code Assist adapter models shared quota scope;
16. Vertex AI adapter keys quota by project/region/model;
17. fallback events are logged without secrets;
18. privacy-sensitive profile blocks automatic cross-provider fallback.

---

17. Risks

Over-scoping

The biggest risk is turning this into a cost optimizer, UI editor, or vendor-specific router too early.

Mitigation: start with schema/resolver only.

Privacy downgrade

Automatic fallback can move sensitive data to another provider.

Mitigation: default privacy-sensitive profiles to "ask" or "manual_only".

Sticky fallback

Fallback can become permanent accidentally.

Mitigation: runtime-only active model, never write fallback back to configured primary.

Unreliable capacity signals

CLI/subscription limits may be inferred rather than observed.

Mitigation: confidence field and conservative policy for "unknown"/"inferred".

Provider-specific complexity

Gemini, Codex, Claude, DeepSeek, Vertex, and local models all expose capacity differently.

Mitigation: adapter interfaces, not hardcoded core assumptions.

---

18. Non-goals

MVP should not include:

- cost optimizer;
- peak/off-peak scheduler;
- fleet-wide model migration;
- vendor-specific subscription logic;
- automatic privacy downgrade;
- always-on LLM opsmonitor;
- UI editor;
- prompt-quality-based model switching;
- model benchmarking;
- automated provider purchasing/top-up;
- automatic API overflow spending without operator policy.

---

19. Open questions

1. Should model profiles live in repo config, "store/", or deployment-local config?
2. Should local overrides be gitignored by default?
3. Should fallback decisions be task-scoped, session-scoped, or time-window-scoped?
4. What is the default behavior for "capacityState = unknown"?
5. Should "ask" mode create a dashboard decision, Telegram prompt, or both?
6. Should capacity state TTL be global or provider-specific?
7. Should provider probes be enabled by default or opt-in?
8. How should Marveen represent API spend limits without exposing billing secrets?
9. Should local models be treated as providers or separate runtime resources?
10. Should profile changes require restart, or can they be hot-reloaded?

---

20. Example upstream issue description

## Proposal: capacity-aware model profile routing

Marveen currently supports multi-agent workflows, but deployments may need different model policies per agent and per capacity state.

This proposal introduces provider-agnostic model profiles and capacity-aware fallback routing.

### Goals

- Assign agents to model profiles instead of hardcoded provider/model choices.
- Support primary model + fallback chain.
- Keep provider/subscription/API details deployment-local via authProfile and quotaScope.
- Track capacity state: available, degraded, limited, blocked, unknown.
- Support fallback modes: none, auto, ask, manual_only.
- Ensure fallback is runtime-only and never overwrites configured primary.
- Support deterministic non-LLM capacity monitoring.
- Allow optional LLM summary only for human explanation.

### Non-goals

- No cost optimizer in MVP.
- No fleet-wide migration.
- No vendor-specific subscription logic.
- No always-on LLM monitor.
- No automatic privacy downgrade.

### Suggested PR breakdown

1. modelProfiles + fallback schema + resolver
2. capacity state registry
3. capacity-aware fallback resolver
4. deterministic provider probes / opsmonitor integration

---

21. Example PR1 description

## Summary

Adds a provider-agnostic model profile schema and fallback policy configuration.

This is the first step toward capacity-aware model routing. It introduces modelProfiles, per-agent modelProfile assignment, fallback modes, and backward compatibility with legacy string-based model config.

## What is included

- modelProfile schema
- per-agent modelProfile field
- fallback modes: none, auto, ask, manual_only
- resolver for configured primary
- validation for unknown profiles
- tests for legacy config compatibility

## What is not included

- provider probes
- capacity-state registry
- automatic fallback execution
- vendor-specific provider logic
- UI editor
- cost optimization

## Design rule

Fallback state must be runtime-only. This PR does not persist fallback choices over configured primary models.

---

22. Verdict

This design is upstream-compatible if it stays generic.

The first MVP should be:

PR1: modelProfiles + fallback schema + resolver

The capacity monitor and provider probes should come later.

The design should explicitly support both:

- subscription/CLI quota signals;
- prepaid/pay-as-you-go API quota and spend signals.

The most important guardrails are:

- no hardcoded provider/subscription assumptions;
- fallback runtime-only;
- privacy-sensitive profiles do not auto downgrade;
- deterministic capacity monitor, not an always-on LLM agent;
- smaller PR series, not one large implementation.