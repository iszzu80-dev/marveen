# Marveen — Lean Model, Capacity & Cost Optimization audit

Status: READ-ONLY AUDIT (2026-07-17). No source, config, model, process, commit, PR or issue was
touched. Decision support only. Scope: the local Marveen deployment (`~/marveen`, official
`Szotasz/marveen`) + the `~/marveen-local/apg-kernel` / `apg-methodology-v0.4-lean` sidecar.

All evidence paths are absolute and were verified live on 2026-07-17. Where a target-model premise did
not match reality (e.g. the "12000 cumulative token ceiling", the "75/80/85/90" saturation ladder),
the audit reports the *actual* implemented value and marks the divergence explicitly rather than
rubber-stamping the premise.

---

## 1. Executive summary

### What is already done (the good news)

The deployment already has most of the *primitives* the lean target model needs — just not composed
into a single profile/capacity layer:

- **Stable per-agent default model** (target principle 1). Every agent stores one concrete model in
  `agents/<name>/agent-config.json`; resolved once by `src/web/agent-config.ts` at launch. There is no
  per-task re-optimization. This IS agent-default routing, only without the profile *names*.
- **`model` vs account (`CLAUDE_CONFIG_DIR`) cleanly separated** (area 8) — two independent
  agent-config fields; `~/.claude`/`~/.claude-personal` = freemail Max, `~/.claude-deepseek` = gmail
  private; DeepSeek agents route inference to `api.deepseek.com/anthropic` and consume zero Claude
  quota.
- **`activeModel` (runtime) vs `model` (configured) already exist as distinct fields** in
  `/api/agents` — the runtime-only-fallback data model is present.
- **Canary-first is real** — `fleet-agent-model-switch` and `agent-second-claude-account` skills both
  mandate one-agent-first, verify, then roll out (target principle 14).
- **A large, mature CostOps subsystem** (`src/costops/`, ~40 modules, `token_usage` = 113,415 rows,
  6 provider collectors, limits/balance/reset normalizer, advisory recommendation engine, all
  deterministic / no-LLM / no-autonomous-action).
- **APG token-origin measurement + a 3000-fresh Context-Packet budget that is conformance-enforced**
  (in the sidecar).
- **Context-saturation guards + dispatch refusal to saturated sessions** already merged (PR #516).
- **The #517 design already exists and is excellent** — `audits/upstream-capacity-aware-model-routing-design.md`
  is essentially this target model minus the cost-optimizer layer.

### The 5 most important gaps

1. **Data-sensitivity gate is convention only, not enforced in code (P0).** Target principle 7
   (public/internal/restricted) has zero code enforcement. `securityProfile` is `"default"` for all 22
   agents; there is no `restricted → forbidden-provider` check in `dispatch-guard.sh` or
   `prompt-safety.ts`. Today `jogasz` (Aegis, legal) and other analysis roles run on DeepSeek
   (Chinese-hosted) purely by role convention. This is the one gap with a *privacy* blast radius, so
   it is the only P0.
2. **No model-profile abstraction and no sticky card→profile binding (P1, foundational).** Grep for
   `premium_reasoning|build_strong|analysis_efficient|routine_lowcost|modelProfile` = 0 hits. Agents
   hold concrete IDs; a Kanban card is routed to an *agent* (reassign) but nothing pins a
   profile/runtime to the card for its lifetime (principles 2, 3, 15; #517 PR1).
3. **CostOps cannot compute `cost_per_accepted_task`, and routing/fallback events are not joined to
   cost (P1).** `token_usage` has no outcome/retry/fallback/correction columns; the auto-fallback store
   writes only `store/model-fallback.json` with no cost link (principles 11, area 18).
4. **Runtime fallback is a disabled, Claude-only banner-scraper, not capacity-state driven (P1).**
   `src/model-fallback.ts` walks `opus→sonnet→haiku` by scraping a Claude usage banner; it is
   `enabled:false` and provider-specific. No `capacityState`/`quotaScope` layer exists (principles 4,
   6; #517 PR2-PR4).
5. **Context-Packet token discipline lives only in the APG sidecar, and the saturation ladder is
   partial (P1).** The 3000-fresh budget + token-origin measurement apply to APG work items, not
   fleet-wide dispatch; the saturation guards use 85/90/92/97%, missing the target's 80% "no new large
   task" gate and an explicit `BUDGET_BLOCKED` stop; `src/context-guard.ts` is `enabled:false` by
   default (principles 8, 9).

### What is NOT worth building

- **A dynamic per-task re-optimizer / prompt-quality-based model switching.** #517's own non-goals list
  says so; the fail-safe (agent-default profile) already covers >95% of cases. Dynamic routing costs
  more debugging + token overhead than it saves at fleet size ~22.
- **An always-on LLM capacity monitor.** "Do not spend LLM quota to monitor LLM quota" — keep the
  deterministic collector + optional-LLM-summary split that CostOps already enforces.
- **A "12000 cumulative token ceiling."** It does not exist and should not be built — the deliberate
  APG policy is adaptive/no-hard-cap with a non-blocking ~20k `CONTEXT_BUDGET_REVIEW`, quality-first.
  Do not regress that into a hard cap.
- **Auto-purchase / auto-cancel of packages.** Already correctly forbidden (principle 12);
  `optimization.ts` is advisory-only.
- **A second parallel measurement stack.** CostOps is the measurement substrate; extend it, do not
  duplicate it.

### Smallest safe MVP

Two LOCAL, single-revert changes, both fail-safe (default-deny / observe-only):

1. **A profile map that names the four generic profiles over the *existing* concrete models** — a
   config/doc artifact with **zero behavior change** (`build_strong = claude-sonnet-5`,
   `routine_lowcost = deepseek-v4-*`, `premium_reasoning = claude-opus-4-8[1m]`,
   `analysis_efficient = deepseek-v4-pro`). This is pure labeling; it makes principles 1-3 auditable
   and is the seam #517 PR1 slots into.
2. **A deterministic data-sensitivity dispatch guard** (principle 7) reusing the already-present
   `securityProfile` field: `restricted` agents' work is `default-deny` to DeepSeek/any non-trusted
   provider (mode `ask`), enforced in the existing `dispatch-guard.sh`/dispatch path. No new
   measurement, no LLM.

Everything else stays observe-only until the canary (§8) proves the profile map is harmless.

---

## 2. As-is architecture

### 2.1 Model / account resolution

```
agents/<name>/agent-config.json   ──►  src/web/agent-config.ts
  { model, claudeConfigDir,             readAgentModel()  → resolveModelId() (alias map) → concrete ID
    claudePlan(unused),                 readAgentClaudeConfigDir() → account root
    securityProfile(all "default"),     DEFAULT_MODEL = claude-opus-4-8[1m]
    authMode(all "shared") }            MODEL_ALIASES = { opus, sonnet, haiku, inherit } (legacy, tiny)
                                        (premium_reasoning/build_strong/... = 0 hits)
        │
        ▼
  src/web/agent-process.ts  (launch)
     model starts with "deepseek-"  ──►  export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
                                          ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY  (store/.deepseek-key)
                                          → inference goes to DeepSeek, NOT to a Claude subscription
     otherwise (claude-*)           ──►  runs under claudeConfigDir's Claude login (freemail Max)
```

Account map (verified from each config-dir's `.claude.json` email):
`~/.claude` + `~/.claude-personal` → **iszzu@freemail.hu (Max, main)**; `~/.claude-deepseek` →
**iszzu80@gmail.com (private)**. All *Claude* inference bills the freemail Max plan; the gmail account
only carries plugins/sessions for DeepSeek-routed agents.

### 2.2 Live agent inventory (from `/api/agents`, 2026-07-17)

| Agent | model (configured) | activeModel | account (config-dir) | running | ctxTokens |
|---|---|---|---|---|---|
| marveen (main) | claude-opus-4-8[1m] | — | freemail (~/.claude) | (channels) | — |
| architect (Atlas) | claude-sonnet-5 | claude-sonnet-5 | freemail (personal) | ✔ | 781k |
| ba (Lens) | claude-sonnet-5 | claude-sonnet-5 | freemail | ✔ | 91k |
| buildfejleszto (Anvil) | claude-sonnet-5 | claude-sonnet-5 | freemail | ✔ | 140k |
| deliverylead (Maestro) | claude-sonnet-5 | claude-sonnet-5 | freemail | ✔ | 306k |
| fullstackfejleszto (Mason) | claude-sonnet-5 | claude-sonnet-5 | freemail | ✔ | 130k |
| qa (Falcon) | claude-sonnet-5 | claude-sonnet-5 | freemail | ✔ | 739k |
| uat (Scout) | claude-sonnet-5 | claude-sonnet-5 | freemail | ✔ | 206k |
| frontendfejleszto2 (Vecta) | claude-sonnet-5 | — | freemail (~/.claude) | dormant | — |
| business (Compass) | deepseek-v4-pro | deepseek-v4-pro | freemail (personal)* | ✔ | 127k |
| devops (Helm) | deepseek-v4-pro | deepseek-v4-pro | freemail* | ✔ | 73k |
| frontendfejleszto (Pixel) | deepseek-v4-pro | deepseek-v4-pro | freemail* | ✔ | 148k |
| jogasz (Aegis) | deepseek-v4-pro | deepseek-v4-pro | freemail* | ✔ | 145k |
| marketing (Herald) | deepseek-v4-pro | deepseek-v4-pro | freemail* | ✔ | 166k |
| uxuidesigner (Muse) | deepseek-v4-pro | deepseek-v4-pro | freemail* | ✔ | 129k |
| research (Sonar) | deepseek-v4-pro | — | freemail* | ✔ | 120k |
| broker/bursar/codeworker/sentinel/steward/thrinintee | deepseek-v4-pro | — | gmail (deepseek) | dormant | — |

`*` config-hygiene inconsistency: these DeepSeek agents point `claudeConfigDir` at the freemail Max
root, not `~/.claude-deepseek`. Inference still goes to DeepSeek (launcher keys off the `deepseek-`
prefix), so this is not a billing leak — but it is inconsistent, and it means their gmail-account
plugin/session state diverges from the other DeepSeek agents. `agents/marketing/CLAUDE.md:6` also
carries a **stale** `Model: claude-sonnet-4-6` line that contradicts its JSON (`deepseek-v4-pro`).

Observation: `activeModel == model` for every running agent → **no runtime fallback is active**. Two
sonnet-5 agents are near the 1M window (qa 739k ≈ 74%, architect 781k ≈ 78%) — both already above the
target's 75% warn line but below the implemented 85% warn line.

### 2.3 Fallback / routing paths (as-is)

- **Auto model-fallback runner** — `src/model-fallback.ts` + `src/web/model-fallback-runner.ts` +
  `src/web/model-fallback-store.ts`. `DEFAULT_MODEL_FALLBACK.enabled = false`; no `store/model-fallback.json`
  present → **OFF**. Chain is Claude-only `claude-opus-4-8[1m] → claude-sonnet-4-6 → claude-haiku-4-5`,
  triggered by scraping a Claude usage-limit banner in the tmux pane, reverts up after ~330 min. This
  is merged PR #474. It is neither provider-agnostic nor capacity-state driven, and writes no cost row.
- **Manual skills** (all in `~/.claude/skills/`):
  - `fleet-agent-model-switch` — canary-first, **permanent** `agent-config.json` model edit + restart.
  - `agent-second-claude-account` — canary-first, **permanent** `claudeConfigDir` (account) edit.
  - `codex-delegate-coding` — **runtime** overflow valve (Codex CLI, ChatGPT Plus) for bulk codegen;
    Claude agent stays the gate; excludes secrets.
  - `analysis-delegate-gpt-sol` — **runtime** delegation of heavy analysis to `gpt-5.6-sol`; has an
    explicit hang→`pkill`→Claude-fallback rule; shares the ChatGPT Plus quota with Codex.
  - `deepseek-ccr-wire` — runtime env-var switch to a local claude-code-router.
  - `max-limit-deepseek-failover` — **not a skill**, a memory/directive: manual, evidence-based,
    revertible; "auto-fallback runner stays OFF".

### 2.4 CostOps (measurement substrate)

`src/costops/` — deterministic, no-LLM, no-autonomous-action. Ledger `src/costops/ledger.ts`
(`cost_sources`, `cost_line_items`, `budgets`, confidence ladder
`actual_invoice>provider_api>billing_export>local_usage>estimate>manual>provider_plan_estimate`).
`token_usage` (113,415 rows) captures input/output/cache-read/cache-creation/thinking tokens + model +
provider + model_source. Pricing `src/costops/pricing.ts` + gitignored `store/costops-pricing.json`
(per-model per-Mtok). Collectors: anthropic/openai/github (cost), render (plan-estimate), deepseek
(balance + derived spend), codex (rate-limit only). Limit/balance/reset normalizer
`src/costops/limits.ts` → `GET /api/costs/limits`. Advisory recommendation engine
`src/costops/optimization.ts` (9 subscription-portfolio types, advisory-only). Dashboard routes
`src/web/routes/costs.ts` (`/api/costs/*`). #517 hook documented but not wired (advisory reasonCodes
only).

### 2.5 Guards / gates (deterministic-first substrate)

`scripts/dispatch-guard.sh` (CTX_SAT refusal + quarantine, = PR #516), `scripts/fleet-context-guard.sh`
(WARN 85% / recover 92%, idle-only, skips marveen), `src/context-guard.ts` (act 90% handoff / hard 97%
force-restart, `enabled:false` opt-in), PreCompact hook in `~/.claude/settings.json`, plus
`fleet-memory-gate.sh`, `self-pace-gate.mjs`, `inter-agent-evidence-gate.py`, `email-send-gate.mjs`,
`suite-checkout-ff-guard.sh`.

### 2.6 APG token-budget (sidecar)

`~/marveen-local/apg-kernel/src/token_origin.py` (MEASURED/ESTIMATED/UNKNOWN token attribution;
`unattributed_input` naming invariant; `compute_fresh_input_reduction` refuses claims without a
baseline). Budget policy `~/marveen-local/apg-methodology-v0.4-lean/policies/context-budget.yaml`
(normal 3000 fresh, complex 5000, subagent-output 1200, on-demand 1500) + `complexity-budget.yaml`
(S0 1500 … S2/S4 5000) + `conformance/validate_pack.py:230` enforcing `normal ≤ 3000`. **No 12000
cumulative cap** — adaptive/no-hard-cap, ~20k non-blocking review, quality-first.

---

## 3. Target-state mapping

| Lean target principle | Closest existing element | Fit |
|---|---|---|
| 1 Agent-default routing | `agent-config.json` model + `readAgentModel()` | STRONG (needs profile names) |
| 2 Task-type defaults (1-3/agent) | — | MISSING |
| 3 Sticky routing (card→profile) | Kanban reassign routes to *agent*, not profile | MISSING |
| 4 Rare deterministic override | manual delegation skills | PARTIAL (manual, no rule engine) |
| 5 Subscription-first | ai-capacity proposal + Max-protection convention | PARTIAL (convention) |
| 6 Runtime-only fallback | `activeModel` vs `model` fields; runner OFF | PARTIAL (data model yes, path off/Claude-only) |
| 7 Data-sensitivity gate (public/internal/restricted) | `securityProfile` (all "default"); memory rule | MISSING in code |
| 8 Token-saving / Context Packet 3000 | APG sidecar (enforced there only) | PARTIAL (sidecar-scoped) |
| 9 Context saturation ladder | context-guard.ts + fleet-context-guard.sh (85/90/92/97) | PARTIAL (no 80% gate / BUDGET_BLOCKED) |
| 10 Deterministic-first before LLM verifier | guards + APG deterministic checkpoints + `verify` skill | PARTIAL (no unified policy) |
| 11 CostOps measurement set | `token_usage` + ledger + collectors | PARTIAL (missing outcome/retry/fallback/cost_per_accepted_task) |
| 12 Package portfolio recommend (advisory) | `optimization.ts` (9 types, advisory) | PARTIAL (sub-scope; not model-routing; missing UPGRADE/ADD/ENABLE_USAGE_CREDIT) |
| 13 Market screening cadence | limits/balance collectors + manual Max snapshot | PARTIAL (no weekly deterministic price-change screen) |
| 14 Canary-first | model-switch + second-account skills | IMPLEMENTED |
| 15 Upstream-frissíthetőség | #517 design + fork-upstream-policy.md | STRONG (design already generic) |

---

## 4. Gap matrix

Each item uses the required schema. Priorities: **P0** = privacy/correctness blast radius; **P1** =
core lean-value or foundational; **P2** = refinement.

---

**G1 — Model-profile abstraction (premium_reasoning/build_strong/analysis_efficient/routine_lowcost)**
- **Státusz:** MISSING
- **Bizonyíték:** `src/web/agent-config.ts` (concrete IDs + tiny `MODEL_ALIASES` opus/sonnet/haiku/inherit); grep of `src/`,`agents/`,`store/` for the four profile names = 0 hits.
- **Jelenlegi működés:** every agent stores a concrete model string; resolved verbatim.
- **Eltérés:** target wants agents mapped to *generic* profiles, provider names deployment-local.
- **Kockázat:** provider names leak into per-agent config; a fleet re-tier means editing 22 files; not upstream-portable.
- **Javasolt megoldás:** a profile→model map in local config (`store/model-profiles.json`), agent-config gains optional `modelProfile`, resolver precedence: explicit model > modelProfile > default. Zero behavior change if the map reproduces current assignments.
- **Megoldás típusa:** CONFIG + CODE (resolver)
- **Helye:** UPSTREAM_CANDIDATE (= #517 PR1)
- **Prioritás:** P1
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** ~0 runtime; one-time map file.
- **Frissíthetőségi hatás:** POSITIVE — this is the upstream seam; concrete IDs stay local.
- **Elfogadási kritérium:** with the map reproducing today's assignments, `/api/agents` shows identical resolved models for all agents; unknown profile = validation error, not silent default.

**G2 — Task-type defaults (≤1-3 profiles per agent)**
- **Státusz:** MISSING
- **Bizonyíték:** no task-type field in `agent-config.json`; dispatch routes by agent only.
- **Jelenlegi működés:** an agent uses its single model for every task.
- **Eltérés:** target allows a few per-agent task-type overrides, rest use default.
- **Kockázat:** low — mostly a missed savings opportunity (e.g. a build agent's trivial doc edits could route cheaper).
- **Javasolt megoldás:** OPTIONAL `taskProfiles` per agent keyed off kanban label/card-type; default when unmatched. Build only after G1.
- **Megoldás típusa:** CONFIG
- **Helye:** UPSTREAM_CANDIDATE
- **Prioritás:** P2
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** minimal.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** a labeled card resolves to the task profile; unlabeled cards resolve to agent default; verified in a dry-run resolver test.

**G3 — Sticky routing (card/work-package pinned to one profile+runtime)**
- **Státusz:** MISSING
- **Bizonyíték:** grep for card→model/session binding = none (only `src/costops/schema.ts` noise); kanban reassign changes *owner agent*, not a pinned profile.
- **Jelenlegi működés:** whichever agent holds the card uses its own current model; a mid-card model switch (e.g. context-guard restart to a different model) is invisible to the card.
- **Eltérés:** target wants one profile/runtime for a card's whole life, no per-subtask switching.
- **Kockázat:** inconsistent output quality/cost within one deliverable; hard to attribute cost to a card.
- **Javasolt megoldás:** record `resolvedProfile` on the kanban card at dispatch; the resolver reads it for the card's lifetime; only a §7-style override changes it (audited).
- **Megoldás típusa:** CODE (small; kanban card column + dispatch write)
- **Helye:** UPSTREAM_CANDIDATE
- **Prioritás:** P1
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** POSITIVE (feeds cost-per-card).
- **Elfogadási kritérium:** a card dispatched under profile X keeps X across restarts unless an override event is logged.

**G4 — Data-sensitivity gate (public/internal/restricted)**
- **Státusz:** MISSING (in code)
- **Bizonyíték:** `securityProfile` = `"default"` for all 22 agents (`/api/agents`); no `restricted`/provider-ban check in `scripts/dispatch-guard.sh` or `src/*prompt-safety*`; rule lives only in the `model-routing-data-sensitivity` memory + `audits/ai-capacity-and-model-routing-proposal.md §4-5,12` (listed as a *future* code candidate). `jogasz` (legal) currently on `deepseek-v4-pro`.
- **Jelenlegi működés:** which provider handles sensitive data is a role convention enforced by nothing.
- **Eltérés:** target requires 3 categories; restricted data must not reach a forbidden provider, no auto privacy downgrade, `ask`/`manual_only` when needed.
- **Kockázat:** HIGH / privacy — restricted personal or legal data can be sent to a Chinese-hosted API with no gate; this is the audit's only P0.
- **Javasolt megoldás:** give `securityProfile` real values (`public`/`internal`/`restricted`), a local provider-trust map, and a deterministic default-deny dispatch check (restricted → non-trusted provider = block/`ask`). Fail-safe: unknown = treat as restricted.
- **Megoldás típusa:** CODE (dispatch guard) + CONFIG (trust map)
- **Helye:** LOCAL now; UPSTREAM_CANDIDATE later (generic guard, provider list local)
- **Prioritás:** P0
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** ~0 (deterministic check).
- **Frissíthetőségi hatás:** POSITIVE.
- **Elfogadási kritérium:** a synthetic restricted-tagged dispatch to a DeepSeek agent is blocked (or routed to `ask`) with an audit row; a public dispatch is unaffected; zero false-positives on a one-day observation.

**G5 — Runtime-only capacity-aware fallback**
- **Státusz:** PARTIAL
- **Bizonyíték:** `activeModel` vs `model` fields exist (`/api/agents`); auto runner `src/model-fallback.ts` (`enabled:false`, Claude-only `opus→sonnet→haiku` banner-scrape, revert ~330 min); no `capacityState`/`quotaScope`/`confidence` layer anywhere.
- **Jelenlegi működés:** fallback is either OFF (auto runner) or a manual, permanent config edit (`fleet-agent-model-switch`) or a runtime delegation valve (codex/gpt-sol).
- **Eltérés:** target wants runtime-only fallback that never overwrites the primary, driven by a deterministic capacity state, with retry-primary-later.
- **Kockázat:** on a real Max/DeepSeek limit, recovery is manual (banner-scraper is Claude-only and off); permanent `fleet-agent-model-switch` edits risk sticky fallback (never retrying primary).
- **Javasolt megoldás:** capacity-state registry (DeepSeek 402→blocked/429→limited; Codex resetsAt; Claude banner→inferred) + resolver that sets runtime `activeModel` only, logs a fallback event, retries primary after TTL. = #517 PR2/PR3/PR4.
- **Megoldás típusa:** CODE
- **Helye:** UPSTREAM_REQUIRED (generic capacity layer) — provider probes LOCAL-configurable
- **Prioritás:** P1
- **Komplexitás:** HIGH
- **Token/működési többlet:** deterministic collector only; no LLM.
- **Frissíthetőségi hatás:** POSITIVE.
- **Elfogadási kritérium:** DeepSeek 402 in fixtures → `blocked`; fallback sets `activeModel` runtime-only, `model` unchanged; primary retried after TTL; no fallback on validation/tool/safety errors (design test list §16).

**G6 — Subscription-first / premium protection**
- **Státusz:** PARTIAL
- **Bizonyíték:** policy in `audits/ai-capacity-and-model-routing-proposal.md §5-8`; Max = interactive/emergency only (convention); DeepSeek = paid API used first for volume; no code enforcement.
- **Jelenlegi működés:** main (opus) on Max, workers on DeepSeek/sonnet; correct by convention, unmeasured.
- **Eltérés:** target wants paid-capacity-first with premium reserved, overflow to API by price-value.
- **Kockázat:** silent Max burn if an automated path ever puts a background agent on Max; not currently happening but not guarded.
- **Javasolt megoldás:** encode "Max = no unattended background runtime" as a dispatch rule + surface Max weekly-usage % (already a manual snapshot in `limits.ts`) as a first-class panel.
- **Megoldás típusa:** CONFIG + PROMPT (rule) ; measurement reuse CostOps
- **Helye:** LOCAL
- **Prioritás:** P1
- **Komplexitás:** LOW
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** neutral (account/plan facts stay local).
- **Elfogadási kritérium:** no background/scheduled agent resolves to a Max-billed Claude model without an explicit flag; Max weekly % visible on the dashboard.

**G7 — Context-Packet token discipline fleet-wide (3000 fresh)**
- **Státusz:** PARTIAL
- **Bizonyíték:** enforced only in the APG sidecar (`apg-methodology-v0.4-lean/policies/context-budget.yaml`, `conformance/validate_pack.py:230`); `token_origin.py` measures origin; the general fleet dispatch (`/api/messages`, kanban) has no packet-budget check.
- **Jelenlegi működés:** APG work items are packet-disciplined; ordinary inter-agent tasks are not.
- **Eltérés:** target wants Context Packet ≤3000 fresh, progressive disclosure, no re-inlining unchanged docs — as the fleet default.
- **Kockázat:** MEDIUM — ordinary dispatches can re-inline large docs, inflating input tokens (this is exactly why qa/architect ctx ballooned to ~740-780k).
- **Javasolt megoldás:** port the "reference+path+hash+excerpt, don't re-inline" packet convention into the standard dispatch prompt template; measure fresh-input via the existing `token_origin` approach at the fleet boundary (best-effort).
- **Megoldás típusa:** PROMPT (dispatch template) + optional CODE (measurement)
- **Helye:** LOCAL (convention) ; token-origin measurement UPSTREAM_CANDIDATE
- **Prioritás:** P1
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** NEGATIVE (saves tokens).
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** a sampled set of dispatches shows path/hash references instead of inlined unchanged docs; no functional regression.

**G8 — Context saturation ladder (75/80/85/90)**
- **Státusz:** PARTIAL
- **Bizonyíték:** `src/context-guard.ts` (act 90% handoff / hard 97%, `enabled:false`), `scripts/fleet-context-guard.sh` (warn 85% / recover 92%, idle-only), PreCompact hook. No 75% warn, no 80% "no new large task" gate, no explicit 90% `BUDGET_BLOCKED`.
- **Jelenlegi működés:** warn at 85%, auto-recover idle agents at 92%; saturated-session dispatch refused by `dispatch-guard.sh`.
- **Eltérés:** target ladder is 75 warn / 80 block-new / 85 checkpoint / 90 stop.
- **Kockázat:** MEDIUM — agents (qa 74%, architect 78%) already past the target 75/80 lines but under the 85 warn, so a large new task can still be dispatched into a nearly-full context.
- **Javasolt megoldás:** add an 80% "no new large task" check to `dispatch-guard.sh` (deterministic, reads `contextTokens`), lower warn to 75%, keep 85 checkpoint / 90 stop; make these env-configurable (they already are).
- **Megoldás típusa:** SCRIPT (threshold config) + small CODE (80% dispatch check)
- **Helye:** LOCAL ; the dispatch-refusal primitive is already upstream (PR #516)
- **Prioritás:** P1
- **Komplexitás:** LOW
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** a large dispatch to an agent at 82% is refused with a clear reason; warn fires at 75%.

**G9 — CostOps measurement completeness (outcome/retry/fallback/human-correction/cost_per_accepted_task)**
- **Státusz:** PARTIAL
- **Bizonyíték:** `token_usage` columns = id,agent,session_id,timestamp,input/output/cache_read/cache_creation/thinking tokens,content_preview,tool_name,task_title,project,model,provider,model_source. **Absent:** subscription-vs-API flag (hardcoded heuristic `provider==='anthropic'?'not_billed'` in `pricing.ts`), fallback marker, result/outcome, retry, per-row human correction, cost_per_accepted_task, per-row cost.
- **Jelenlegi működés:** volume + estimate-cost per model; no acceptance/quality dimension.
- **Eltérés:** target wants the full set incl. `cost_per_accepted_task`.
- **Kockázat:** cannot answer "is this profile worth it?" — the core lean question — from data.
- **Javasolt megoldás:** add nullable `outcome`, `retry_of`, `correction_of`, `fallback_event_id` to `token_usage` (forward-only, like the model/provider enrichment already did); derive `cost_per_accepted_task` in the summary from card-acceptance signals. Make subscription-vs-API a stored/config field, not a heuristic.
- **Megoldás típusa:** CODE (schema + ingest) + CONFIG (billed-status map)
- **Helye:** UPSTREAM_CANDIDATE (generic columns) ; billed-status map LOCAL
- **Prioritás:** P1
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** POSITIVE.
- **Elfogadási kritérium:** `GET /api/costs/summary` returns a `cost_per_accepted_task` per agent/profile for rows ingested after the change; existing rows stay `unknown` (no fake backfill).

**G10 — Routing/fallback events ↔ CostOps link**
- **Státusz:** MISSING
- **Bizonyíték:** `src/web/model-fallback-store.ts` writes only `store/model-fallback.json`; zero `INSERT`/`token_usage`/`cost` references; no routing-event table.
- **Jelenlegi működés:** a model switch is only visible as a later change in `token_usage.model`; the *event* (when/why/limit) is not cost-queryable.
- **Eltérés:** target principle 11 wants fallback as a measured dimension.
- **Kockázat:** overflow/fallback cost is invisible; can't evaluate whether fallbacks are helping or hurting.
- **Javasolt megoldás:** a `routing_events` table (agent, card, from_profile, to_profile, reason, capacityState, confidence, persisted, ts) appended by the fallback path; join key `fallback_event_id` on `token_usage` (G9).
- **Megoldás típusa:** CODE
- **Helye:** UPSTREAM_CANDIDATE
- **Prioritás:** P1
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** POSITIVE.
- **Elfogadási kritérium:** a simulated fallback writes one `routing_events` row with no secret; summary can attribute post-switch tokens to it.

**G11 — Capacity/limit/balance/reset collectors**
- **Státusz:** PARTIAL
- **Bizonyíték:** `src/costops/limits.ts` normalizes 6 sources; `provider_balance_snapshots` (DeepSeek) = 10 rows live; `provider_ratelimit_snapshots` (Codex) = **0 rows** (collector not run live); Claude Max = manual `usage_snapshot` only (no official quota API → honest `unknown` reset).
- **Jelenlegi működés:** DeepSeek balance is live; Codex rate-limit collector exists but idle; Max is a manual reading.
- **Eltérés:** target wants deterministic capacity signals feeding routing (principle 4/6).
- **Kockázat:** capacity-aware routing (G5) has no live signal for Codex/Claude yet.
- **Javasolt megoldás:** schedule the codex `account/rateLimits/read` collector (deterministic, metadata-only, no quota burn) as a `type:command` task; keep Claude as manual/inferred.
- **Megoldás típusa:** CONFIG (scheduled collector) — code already exists
- **Helye:** LOCAL
- **Prioritás:** P1
- **Komplexitás:** LOW
- **Token/működési többlet:** metadata call only.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** `provider_ratelimit_snapshots` gains rows on a schedule; `GET /api/costs/limits` shows a Codex reset date.

**G12 — Deterministic-first before LLM verifier**
- **Státusz:** PARTIAL
- **Bizonyíték:** many deterministic guards (`dispatch-guard`, `fleet-memory-gate`, `inter-agent-evidence-gate`, `self-pace-gate`) + APG deterministic checkpoints + the `verify` skill; but no single policy stating "low-risk = no LLM verifier, medium/high = ≤1 semantic verifier".
- **Jelenlegi működés:** determinism is practiced ad hoc per skill/agent, not codified as a routing rule.
- **Eltérés:** target principle 10 wants build/test/typecheck/lint/schema/policy/hash *before* any LLM verifier, and ≤1 semantic verifier.
- **Kockázat:** LOW — mostly already the culture; risk is redundant LLM verification burning tokens.
- **Javasolt megoldás:** a short DOC policy + a checklist in the QA/acceptance skill; no new code.
- **Megoldás típusa:** DOC + PROMPT
- **Helye:** LOCAL
- **Prioritás:** P2
- **Komplexitás:** LOW
- **Token/működési többlet:** NEGATIVE.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** the acceptance skill references the deterministic-first order; a low-risk task shows no LLM verifier call.

**G13 — Hash-stable skip / verification fingerprint**
- **Státusz:** PARTIAL
- **Bizonyíték:** APG `token_origin.py` + integrity/hash checks in `apg-kernel/src/store.py`; `costops` uses `dedup_key`/`raw_ref_hash`; memory `served-bytes-hash-must-match-stored-contenthash` / `verify-fix-live-via-bundle-grep` show hash-verification practice — but no general "skip re-processing if fingerprint unchanged" mechanism in fleet dispatch.
- **Jelenlegi működés:** hashing used for dedup and integrity, not for skipping unchanged work.
- **Eltérés:** target wants hash/fingerprint check as a deterministic gate to avoid re-doing unchanged work.
- **Kockázat:** LOW — occasional re-processing of unchanged artifacts.
- **Javasolt megoldás:** where a task re-processes an artifact, compare a stored content hash and skip if unchanged (opt-in, per skill).
- **Megoldás típusa:** SCRIPT/CODE (per-use)
- **Helye:** LOCAL
- **Prioritás:** P2
- **Komplexitás:** LOW
- **Token/működési többlet:** NEGATIVE.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** a re-run over an unchanged artifact is skipped with a logged hash match.

**G14 — Per-agent CLAUDE.md & skill progressive disclosure**
- **Státusz:** PARTIAL
- **Bizonyíték:** skills use 3-level progressive disclosure (index `~/.claude/skills/.skill-index.md`, 99 skills); `fleet-descriptor-slim` skill exists specifically to extract duplicated infra boilerplate from per-agent CLAUDE.md; `agents/marketing/CLAUDE.md:6` has a stale `Model:` line.
- **Jelenlegi működés:** skills are token-efficient; per-agent descriptors still carry duplicated boilerplate loaded every turn; the root CLAUDE.md is ancestor-inherited by all agents.
- **Eltérés:** target wants minimal per-turn descriptor cost.
- **Kockázat:** LOW — steady per-turn token overhead across 22 agents.
- **Javasolt megoldás:** run `fleet-descriptor-slim` to move shared infra prose into a shared skill; fix the stale marketing model line.
- **Megoldás típusa:** DOC/PROMPT (descriptor edit)
- **Helye:** LOCAL
- **Prioritás:** P2
- **Komplexitás:** LOW
- **Token/működési többlet:** NEGATIVE (per-turn saving ×22 agents).
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** measured per-turn descriptor tokens drop; no capability regression.

**G15 — Inter-agent bus language (English-only) + token impact**
- **Státusz:** PARTIAL
- **Bizonyíték:** memory `feedback-interagent-bus-english-only` — 2026-07-16 audit: all agents English except marveen (17/30 HU); convention, not code-enforced (no hook).
- **Jelenlegi működés:** English by convention; marveen is the residual offender.
- **Eltérés:** target wants consistent English bus (cheaper tokens, better cross-model comprehension).
- **Kockázat:** LOW — HU tokenizes worse; marveen's own bus posts cost more.
- **Javasolt megoldás:** keep it a prompt rule (marveen CLAUDE.md already implies it); optionally a lightweight non-blocking lint on `/api/messages` content. No hard gate.
- **Megoldás típusa:** PROMPT (+ optional SCRIPT lint)
- **Helye:** LOCAL
- **Prioritás:** P2
- **Komplexitás:** LOW
- **Token/működési többlet:** NEGATIVE.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** a follow-up bus-language sample shows marveen posting English.

**G16 — Package portfolio recommendations (KEEP/UPGRADE/DOWNGRADE/CANCEL/ADD/ENABLE_USAGE_CREDIT)**
- **Státusz:** PARTIAL
- **Bizonyíték:** `src/costops/optimization.ts` — 9 advisory recommendation types (underused_subscription_downgrade, duplicate_subscription, switch_to_annual_billing, unused_domain_or_storage, forgotten_service, …), advisory-only, no LLM, no auto-execute. Explicitly *subscription/hosting/SaaS scope, never model-routing*.
- **Jelenlegi működés:** advises downgrade/cancel/annual-switch on subscriptions; human executes.
- **Eltérés:** target's action vocabulary adds KEEP/UPGRADE/ADD/ENABLE_USAGE_CREDIT and wants it to also cover model-capacity packages.
- **Kockázat:** LOW — advisory only; correct guardrail (no auto-buy) already holds.
- **Javasolt megoldás:** extend the recommendation `action` enum to the 6 target verbs; keep the "advisory only, never execute" guarantee; a capacity-package recommendation type can reuse the same shape.
- **Megoldás típusa:** CODE (enum) + DOC
- **Helye:** UPSTREAM_CANDIDATE
- **Prioritás:** P2
- **Komplexitás:** LOW
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** a recommendation can carry `ENABLE_USAGE_CREDIT`; still no autonomous action.

**G17 — Market screening cadence + pricing-source discipline**
- **Státusz:** PARTIAL
- **Bizonyíték:** `limits.ts`/balance collectors + manual Max snapshot + `subscriptions.ts` (official-source/actual-invoice discipline); no scheduled *weekly deterministic price-change* screen; memories `deepseek-peak-valley-pricing`, `render-no-public-billing-api`, `provider-cost-api-401-check-url-not-key` show pricing-source rigor.
- **Jelenlegi működés:** invoices/balances tracked; price-change watching is ad hoc/manual.
- **Eltérés:** target wants weekly deterministic change-watch, monthly CostOps review, quarterly deep screen; official-source/invoice primary.
- **Kockázat:** LOW-MEDIUM — a provider price change (e.g. DeepSeek peak/valley) could go unnoticed.
- **Javasolt megoldás:** a `type:command` weekly job diffing a stored pricing snapshot vs a fetched public price page (deterministic, no LLM); alert on change; monthly review already possible from CostOps.
- **Megoldás típusa:** SCRIPT (scheduled)
- **Helye:** LOCAL
- **Prioritás:** P2
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** ~0 (no LLM).
- **Frissíthetőségi hatás:** neutral (prices stay local).
- **Elfogadási kritérium:** a simulated price change triggers a deterministic alert; no LLM used.

**G18 — Canary-first model change**
- **Státusz:** IMPLEMENTED
- **Bizonyíték:** `~/.claude/skills/fleet-agent-model-switch/SKILL.md` (change ONE, verify runState+model+clean boot, then roll out); `agent-second-claude-account` (drain-migration step 5 = 1 agent → verify → rest).
- **Jelenlegi működés:** exactly the target's canary → limited → full pattern, with reversible single-field revert.
- **Eltérés:** none material; not yet tied to KPI measurement (see canary §8).
- **Kockázat:** none.
- **Javasolt megoldás:** attach the CostOps KPI panel (§8) so a canary is measured, not just booted.
- **Megoldás típusa:** DOC (link measurement)
- **Helye:** LOCAL
- **Prioritás:** P2
- **Komplexitás:** LOW
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** already met for the mechanism; KPI attach is the refinement.

**G19 — `model` vs `CLAUDE_CONFIG_DIR` separation**
- **Státusz:** IMPLEMENTED (with a hygiene defect)
- **Bizonyíték:** two independent fields resolved by `readAgentModel()` / `readAgentClaudeConfigDir()` (`src/web/agent-config.ts`); account mapping verified; DeepSeek routing keys off model prefix (`src/web/agent-process.ts:735`).
- **Jelenlegi működés:** inference model and Claude account are fully decoupled.
- **Eltérés:** none conceptually; but 6 DeepSeek agents point `claudeConfigDir` at the freemail Max root instead of `~/.claude-deepseek` (inconsistent, not a billing leak); one stale `Model:` line in marketing CLAUDE.md; `claudePlan` indirection (`src/web/claude-plans.ts`) exists but is unused (`store/claude-plans.json` absent).
- **Kockázat:** LOW — config drift/confusion, no billing impact.
- **Javasolt megoldás:** normalize the DeepSeek agents' `claudeConfigDir`; delete the stale marketing line; either use or remove the `claudePlan` indirection.
- **Megoldás típusa:** CONFIG cleanup
- **Helye:** LOCAL
- **Prioritás:** P2
- **Komplexitás:** LOW
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** neutral.
- **Elfogadási kritérium:** all DeepSeek agents share one config-root convention; no stale model prose.

**G20 — Token-origin measurement (fleet-wide)**
- **Státusz:** PARTIAL (IMPLEMENTED in sidecar only)
- **Bizonyíték:** `~/marveen-local/apg-kernel/src/token_origin.py` (MEASURED/ESTIMATED/UNKNOWN, unattributed-input invariant); not wired to the general fleet.
- **Jelenlegi működés:** origin attribution exists for APG runs; fleet dispatch uses `token_usage` volume only.
- **Eltérés:** target wants token-origin awareness generally.
- **Kockázat:** LOW — reduced fresh-input reduction claims can't be proven fleet-wide.
- **Javasolt megoldás:** reuse `token_origin` concepts at the CostOps summary layer (best-effort; provider-aggregate remains UNKNOWN per the standing W10 ruling).
- **Megoldás típusa:** CODE (optional)
- **Helye:** UPSTREAM_CANDIDATE
- **Prioritás:** P2
- **Komplexitás:** MEDIUM
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** POSITIVE.
- **Elfogadási kritérium:** summary can label fresh vs cache-read for post-change rows without over-claiming.

**G21 — #517 alignment**
- **Státusz:** IMPLEMENTED (as a design; not yet built)
- **Bizonyíték:** `audits/upstream-capacity-aware-model-routing-design.md` + `...-issue-final.md`; issue #517 OPEN.
- **Jelenlegi működés:** the design covers modelProfile/authProfile/quotaScope/capacityState/fallbackMode/runtimeActiveModel + PR1-PR4 breakdown — essentially this target minus the cost-optimizer (which #517 lists as a *non-goal*).
- **Eltérés:** target's cost-optimization + task-type + sticky-card layers are NOT in #517's MVP scope.
- **Kockázat:** scope confusion — folding cost optimization into #517 would over-scope it (its stated top risk).
- **Javasolt megoldás:** keep #517 as the routing/capacity schema; put cost-optimization (G9/G10/G16/G17) in CostOps and a *separate* issue.
- **Megoldás típusa:** DOC (scope split)
- **Helye:** UPSTREAM_REQUIRED (issue hygiene)
- **Prioritás:** P1
- **Komplexitás:** LOW
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** POSITIVE.
- **Elfogadási kritérium:** the profile-map PR (G1) references #517 PR1; cost items reference a separate issue.

**G22 — Existing upstream overlap (dedup before building)**
- **Státusz:** IMPLEMENTED (mapped)
- **Bizonyíték:** PR #474 (MERGED, Claude-only model-fallback-on-limit — the disabled runner above); PR #652 (OPEN, OpenRouter provider models); PR #628 (OPEN, CostOps provider collectors/forecast/FX); PR #651/#648 (model-select UI / provider-aware onboarding); issue #209 (Anthropic limit).
- **Jelenlegi működés:** several implementation slices already exist upstream; #517 is the umbrella schema none of them duplicate.
- **Eltérés:** the slices are Claude-/provider-specific; the generic schema is unbuilt.
- **Kockázat:** rebuilding #474/#652 instead of generalizing them.
- **Javasolt megoldás:** generalize #474's fallback into #517's capacity resolver rather than a new mechanism; align #652 OpenRouter as one `authProfile`/provider under the same schema.
- **Megoldás típusa:** DOC (upstream plan) → CODE later
- **Helye:** UPSTREAM_REQUIRED
- **Prioritás:** P1
- **Komplexitás:** LOW (planning)
- **Token/működési többlet:** ~0.
- **Frissíthetőségi hatás:** POSITIVE.
- **Elfogadási kritérium:** the PR series (§7) cites #474/#652/#628 as the slices it unifies.

### Status counts (22 items)

- **IMPLEMENTED = 4** — G18, G19, G21, G22.
- **PARTIAL = 13** — G5, G6, G7, G8, G9, G11, G12, G13, G14, G15, G16, G17, G20.
- **MISSING = 5** — G1, G2, G3, G4, G10.

Priority split: **P0 = 1** (G4). **P1 = 11** (G1, G3, G5, G6, G7, G8, G9, G10, G11, G21, G22).
**P2 = 10** (G2, G12, G13, G14, G15, G16, G17, G18, G19, G20).

Upstream candidates (UPSTREAM_CANDIDATE or UPSTREAM_REQUIRED): **10** — G1, G2, G3, G5, G9, G10,
G16, G20 (candidates) + G21, G22 (required, planning/issue-hygiene).

---

## 5. Simplification recommendations

- **Do not invent a new state model — name what exists.** The four profiles should be a *labeling map*
  over the current concrete models (G1). No `capacityState` machine is needed for the MVP; add it only
  when a real limit event needs automation (G5, later).
- **Drop the "12000 cumulative ceiling" from the target.** It doesn't exist and contradicts the
  deliberate adaptive/quality-first APG policy. Keep only the 3000-fresh packet target.
- **Collapse the fallback surface.** Today there are ~5 partly-overlapping fallback paths (disabled
  Claude runner, `fleet-agent-model-switch` permanent edit, codex-delegate, gpt-sol-delegate,
  ccr-wire). Target state = ONE runtime resolver + the two delegation valves as explicit
  `manual/runtime` overrides. Retire the banner-scraper in favor of the capacity resolver.
- **One measurement stack.** Everything cost/quota goes through CostOps; do not build a parallel
  routing-metrics store — add columns/tables to CostOps (G9/G10).
- **Fields that can be dropped/deferred:** `claudePlan` indirection (unused — remove or use);
  per-task re-optimization (never build); prompt-quality-based switching (never build); a 4th
  DeepSeek "flash" tier is already effectively unused (all live agents on pro).
- **Where dynamic routing costs more than it saves:** at fleet size ~22 with stable roles, dynamic
  per-task routing adds debugging + attribution overhead. Keep agent-default + ≤3 task profiles +
  rare deterministic override. **Fail-safe:** if the resolver can't decide safely → run the agent's
  configured default profile; if data is `restricted` → `ask`.

---

## 6. P0/P1/P2 implementation plan (small, independently revertible)

Each step is one revert (single file / single flag). None changes a live model without a canary.

**Phase 0 — zero-behavior labeling + the one privacy gate (MVP)**
- **P0-1 (G4):** data-sensitivity gate. Add `securityProfile` values + local provider-trust map + a
  default-deny dispatch check (dry-run/observe first). Revert = remove the check + restore
  `securityProfile:"default"`.
- **P1-1 (G1):** `store/model-profiles.json` naming the 4 profiles over current models; resolver reads
  `modelProfile` if present. Seeded to reproduce today's assignments = zero behavior change. Revert =
  delete the file / ignore the field.

**Phase 1 — measurement completeness (observe-only)**
- **P1-2 (G9):** forward-only `token_usage` columns (outcome/retry/correction/fallback_event_id) +
  stored billed-status. Revert = stop populating (columns stay nullable).
- **P1-3 (G10):** `routing_events` table appended by the fallback path. Revert = drop table usage.
- **P1-4 (G11):** schedule the existing Codex rate-limit collector. Revert = unschedule.

**Phase 2 — saturation + packet discipline**
- **P1-5 (G8):** 75/80/85/90 thresholds in the guards + an 80% "no new large task" dispatch check.
- **P1-6 (G7):** packet convention in the dispatch prompt template.
- **P1-7 (G6):** "Max = no unattended background runtime" dispatch rule + Max weekly-% panel.

**Phase 3 — capacity resolver (the real routing change, upstream)**
- **P1-8 (G5/G3):** capacity-state registry + runtime-only resolver + sticky card→profile. This is the
  #517 PR2-PR4 body; canary first (§8). Revert = resolver flag off → back to static.

**Phase 4 — refinements (P2)**
- G12 (deterministic-first DOC), G13 (hash-skip), G14 (descriptor slim + stale line),
  G15 (bus-language), G16 (recommendation enum), G17 (weekly price screen), G19 (config hygiene),
  G20 (token-origin fleet-wide).

---

## 7. Upstream plan

**What fits #517 (provider-agnostic capacity-aware routing) directly:**
- G1 (modelProfile schema/resolver) = #517 **PR1**.
- G5 (capacity-state registry + runtime-only resolver) = #517 **PR2/PR3/PR4**.
- G3 (sticky card→profile) — a small extension consistent with #517.
- Generalize the MERGED **PR #474** (Claude-only banner fallback) INTO #517's resolver rather than
  leaving two mechanisms; represent **PR #652** OpenRouter as one provider/`authProfile`.

**What needs a SEPARATE issue (do NOT fold into #517 — over-scoping is #517's own stated top risk):**
- Cost-optimization layer: G9 (`cost_per_accepted_task`), G10 (`routing_events` cost link), G16
  (recommendation verbs), G17 (weekly pricing screen). These extend **CostOps** and overlap the OPEN
  **PR #628** — coordinate there. #517 explicitly lists "cost optimizer" as a non-goal.
- A generic **data-sensitivity dispatch guard** (G4) — a candidate upstream issue after it is proven
  locally; the provider list stays deployment-local.

**What stays strictly LOCAL:**
- Concrete account/plan/model/price mappings, the provider-trust map, Max-protection rule,
  config hygiene (G19), descriptor slimming (G14), bus-language prompt (G15), the marketing stale line.

**Suggested small PR series (upstream), each independently reviewable:**
1. `feat(models): model profiles + fallback schema + resolver` (G1; = #517 PR1).
2. `feat(models): provider capacity-state registry (read-only)` (G5a; #517 PR2).
3. `feat(models): capacity-aware runtime-only fallback resolver` (G5b; #517 PR3).
4. `feat(ops): deterministic provider capacity probes` (G5c/G11; #517 PR4).
5. `feat(costops): routing-event + acceptance columns, cost_per_accepted_task` (G9/G10; coordinate w/ #628).

---

## 8. Canary pilot

**Goal:** prove the profile map (G1) is behavior-neutral and the data-sensitivity gate (G4) has zero
false-positives — on exactly one build agent + one analysis/routine agent — before any fleet rollout.

**Canary agents (suggested first):**
- **Build agent: `buildfejleszto` (Anvil, claude-sonnet-5)** → `modelProfile: build_strong`
  (map resolves to the SAME `claude-sonnet-5`; no model change). Good pick: actively running, real
  build work, moderate context (~140k, safe).
- **Analysis/routine agent: `research` (Sonar, deepseek-v4-pro)** → `modelProfile: analysis_efficient`
  (resolves to the SAME `deepseek-v4-pro`). Good pick: running, DeepSeek so it also exercises the G4
  data-sensitivity gate in dry-run (research handles public/internal data — should PASS, proving no
  false-positive).
  - (Do NOT pick `jogasz` as the first data-sensitivity canary — it is the one that *should* trip the
    gate; validate the harmless case first, then test `jogasz` as the deliberate positive case.)

**KPIs to measure (from CostOps + guards, deterministic):**
- `cost_per_accepted_task` (G9) — must not worsen vs the pre-canary baseline.
- Retry count / human-correction count — must not increase.
- Tokens per accepted task (input/output/cache split) — watch for regression.
- Context-saturation events (fleet-context-guard warns/recoveries) — no increase.
- Fallback/routing events (G10) — should be zero during the neutral canary.
- Data-sensitivity gate: false-positive rate on the routine agent = **0**; deliberate `jogasz`
  positive case = correctly blocked/`ask`.

**Duration:** 48-72h of normal work per canary agent (not a synthetic benchmark — the audit forbids a
full-fleet benchmark).

**Rollback conditions (any one → revert immediately, single-field):**
- resolved model differs from the pre-canary model (labeling was not neutral) → delete
  `store/model-profiles.json` field.
- `cost_per_accepted_task` up >15% or retries/corrections up → revert.
- any false-positive block of a legitimate (public/internal) dispatch → disable the G4 gate flag.
- any agent boot failure / context anomaly after the change → `fleet-agent-model-switch` revert +
  restart.

**Rollback mechanism:** every canary change is one config field or one flag; revert = restore the
field + (if a restart is needed) the existing canary-first restart path. No fleet reset.

---

## 9. Go/no-go decision points

| Phase | Objective go-criteria (all must hold) |
|---|---|
| Phase 0 (MVP) | Profile map resolves to identical models for all agents (diff `/api/agents` before/after = empty). G4 gate in dry-run: 0 false-positives over 24h; deliberate restricted case correctly flagged. If either fails → STOP, do not proceed. |
| Phase 1 (measurement) | New `token_usage` columns + `routing_events` populate for new rows; old rows stay `unknown` (no fake backfill); `cost_per_accepted_task` computes for ≥1 agent; Codex collector produces rows. No dashboard regression. |
| Phase 2 (saturation/packet) | 80% "no-new-large-task" check refuses a test dispatch at 82%; warn fires at 75%; a sampled dispatch uses path/hash references not re-inlined docs; no functional regression. |
| Canary (Phase 3 gate) | Both canary agents meet all KPIs for 48-72h; 0 unexpected fallback events; rollback tested and works. Only then → limited rollout (3-5 agents), same KPIs, then full. |
| Phase 3 (resolver) | DeepSeek 402→blocked / 429→limited in fixtures; fallback sets `activeModel` only, `model` unchanged; primary retried after TTL; no fallback on validation/tool/safety errors; restricted profile never auto-crosses provider. |
| Upstream | G1 PR merges with legacy `model` string still valid + unknown profile = validation error; cost items land in a separate issue/PR, not folded into #517. |

**Global fail-safe (must hold at every phase):** if the optimization layer cannot decide safely, the
agent runs its configured default profile; for `restricted` data it asks for approval. No autonomous
purchase, cancel, model-switch of the primary, or privacy downgrade — ever.

---

*Audit produced read-only. No source, config, model, process, commit, PR, issue, package, credit, or
privacy policy was modified; no fallback triggered; no fleet benchmark run.*
