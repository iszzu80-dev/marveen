# Lean Optimization Phase 2-4 — Program State (live working doc)

Owner GO: full Phase 2-4 execution, no intermediate approval while acceptance holds.
Phase 1 is CLOSED — do not reopen unless a real regression/security bug appears.
Orchestrator: marveen (owns spec, baseline, gates, acceptance, docs, card lifecycle).
Producers build in worktrees; marveen gates independently and never accepts on report alone.

## Cards
| Phase | Card | Status |
|---|---|---|
| Phase 2 — CostOps Attribution & Context Efficiency | `f601e50b` | in_progress |
| Phase 3 — Capacity-Aware Runtime Routing | `59b383a9` | planned |
| Phase 4 — Package Portfolio & Market Optimization | `4e2c31ef` | planned |

Only ONE phase card may be in_progress. Next phase starts only after the previous is
acceptance-green + documented + rollback-proven + card `done`.

## Baseline
- Program start baseline: local `develop` @ `97413de` (= Phase 1 Block B shipped + live).
- Dashboard: systemd user service `marveen-dashboard.service`, runs compiled `dist/index.js`.
- Test suite refuses to run in the live install by design
  (`src/__tests__/setup/assert-not-live-install.ts`) — always run tests in a worktree.

## CRITICAL base trap (cost us one full rebuild)
`Agent(isolation:'worktree')` bases the worktree off **origin/develop (upstream Szotasz tip)**,
NOT our local develop. Our fork is ~143 commits ahead, so an isolated agent silently builds
against a base missing `src/costops/schema.ts`, `pricing.ts`, Block B, etc. **Always** create the
worktree yourself (`git worktree add <path> -b <branch> develop`), verify a fork-local marker
(`ls src/costops/schema.ts`), and tell the producer to work in that exact path. **At gate time,
check the base first:** `git merge-base --is-ancestor <first-commit>~1 develop`.

## AS-IS divergence from the Phase 1 as-built doc (spec section 1: live code wins)
`docs/optimization/lean-optimization-phase-1-as-built.md` describes branch
`feat/lean-opt-phase1-gate`, **not develop**. On develop the data-sensitivity gate is the
PRE-Phase-1 3-category version with ONE call site (`message-router.ts:631`); it is NOT relocated
to `sendPromptToSession` and NOT the 4-category ENFORCE version. Block A stays parked.
Therefore `sendPromptToSession` (`agent-process.ts:~1634`) was greenfield for dispatch metadata.

Other grounded AS-IS facts: no dispatch_id existed anywhere (only `trace_id/span_id` on the
message-router path); `token_usage` tails Claude Code transcript JSONL (session-grained, task link
was only a fuzzy time-window heuristic); CostOps DDL seam is `initCostOpsSchema`
(`src/costops/schema.ts`); migrations are idempotent boot DDL; context guard live thresholds are
`actPct 0.90` / `hardPct 0.97` + pane-saturation net (NOT 85/90/92/97).

## Progress

### Phase 2
**P2-A — dispatch/outcome/CostOps attribution: DONE. GATE PASSED, MERGED to develop (ff-only,
12 commits, develop head `872d7d7`).** My verification: tsc 0, build 0, FULL suite 3623 passed /
1 skipped / 265 files. FOUR guards proven red-able by mutation (billing heuristic → 4 red;
fault-isolation removed → red; session resolver → null → 9 red; correlation call removed → 3 red);
all reverted, grep MUTATION = 0. NOTE: the correlation does not run in the LIVE process until a
dashboard rebuild+restart — deliberately deferred to the Phase 2 acceptance step (P2-C) so the fleet
is not churned mid-program. Outcome writers live: accepted/failed/retry. `cancelled` has NO live
writer (no cancellation signal exists in the codebase — left `unknown` per spec 7.2, not invented;
a test asserts no writer exists).
- Branch `feat/lean-opt-phase2-p2a`, worktree `/home/iszzu/marveen-wt/p2a`, base verified `97413de`.
- Commits: `cccc7f3` (core on the CostOps seam), `87cfbae` (thread dispatch_id from every origin
  through the funnel), `3f02b73` (tests), `14d4ab9` (billing-map example), `902ccad`
  (marveen's gate fix — fault-isolation guard made red-able).
- New: `src/costops/dispatch.ts` (dispatches / routing_events / dispatch_outcomes, window
  correlation, `resolveBillingMode`, `costPerAcceptedTask` marginal-vs-allocated),
  `config-examples/billing-map.example.json`.
- Integrated with the REAL seam (`initCostOpsSchema` → `initDispatchSchema`; db.ts installs nothing
  separately) and REUSES `pricing.ts` (`estimateModelCost` extracted, behaviour-neutral).
- My independent verification: base check OK; `tsc --noEmit` exit 0; targeted 32/32; FULL suite
  **3565 passed / 1 skipped / 262 files, 0 failed**.
- Mutation evidence: injecting a provider-name billing heuristic turned **4 tests red** incl. the
  dedicated guard → load-bearing.
- **Gate finding (fixed by me):** `createDispatchSafe`'s try/catch (program principle 20 — a
  measurement fault must never block a send) was implemented but NOT test-covered; removing it left
  the suite green. Added two tests + proved by mutation they now go red (`902ccad`).
- Session_id closeout DONE + gated: `7414b63` (resolve + wire at every origin), `9dd1c27` (e2e proof).
  New `src/web/transcript-sources.ts` holds the transcript-dir→agent mapping in ONE place
  (token-usage.ts's private copy deleted — no duplicated rule), with injectable roots for testability.
  Rule: newest-mtime top-level `*.jsonl` in the agent's project dir, `sessionId` from first line,
  basename fallback, deterministic tie-break, try/catch → null. My verification: base OK, tsc 0,
  FULL suite **3588 passed / 1 skipped / 263 files**; mutation (force resolver → null) turned
  **9 tests red** incl. the e2e, restored mutation-free.
- **Gate finding #2 (attribution accuracy), fix in progress:** the correlation window was
  OPEN-ENDED for a session's last dispatch — it absorbed every later token row for that session
  indefinitely (a human typing in the pane hours later, unrelated self-initiated work), inflating
  `cost_per_accepted_task`, the phase's headline KPI. Reporting that would be false precision.
  Bounding it deterministically with BOTH: a terminal outcome (accepted/failed/cancelled) closes the
  window, AND a configurable `maxWindowSeconds` cap (default committed, missing config ⇒ default,
  never unbounded). `retry`/`unknown` are not terminal.
- Documented remaining attribution limits (honest, not fixed): session-restart mid-package →
  later tokens carry a new session id and stay UNATTRIBUTED (under-attribution, silently low);
  kanban queue lag can make the recorded session id stale from the start; remote agents and
  `targetSession` tasks stay NULL by design (never guessed); the worker link is INERT (its project
  dir is outside the token_usage collection mapping — resolving it via MAIN_AGENT_ID would have
  mis-attributed the main pane's tokens, so inert was the correct trade and a test pins it out).
  Sub-agent transcripts carry the parent sessionId, so their tokens fold into the parent package.

**P2-B — Context Packet & session efficiency: IN PROGRESS**
Spec: `docs/optimization/phase2-p2b-context-packet.md`. Branch `feat/lean-opt-phase2-p2b`
(based on the P2-A branch), worktree `/home/iszzu/marveen-wt/p2b`. Delegated to a producer.

**P2-C — collectors, subscription visibility, capacity observation, KPI read surface: GATE PASSED,
MERGED (ff-only, develop head `48377de`), and LIVE (dashboard rebuilt + restarted 12:28:22).**
See `docs/optimization/lean-optimization-phase-2-as-built.md` for the full acceptance record.
My verification: base OK, tsc 0, build 0 (worktree AND live install), FULL suite **278 files /
3821 passed / 1 skipped** (baseline 3623/1/265 → +198 tests, no regression), plus **three mutations
of my own choosing** (not the producer's three) each proven RED and reverted clean.

Recovery note: the producer's first run died on a transient 529 with ~2900 lines **uncommitted**, and
this doc previously recorded that the agent had been "resumed to commit + verify". It had not — the
work was still dirty hours later and a branch switch would have destroyed it. I checkpointed it
myself (`37c7e06`). A resumed agent's stated intent is not evidence that it acted.

**Canary — the spec's `buildfejleszto` + `research` pair is only half-usable, and that is now settled.**
`research` carries `modelProfile: analysis_efficient`, which resolves to **`deepseek-v4-pro`** — an
external non-trusted provider. Starting it violated this program's own standing rule ("never restore a
DeepSeek agent"); I did it by reading the config's `model: None` as "default Claude" instead of
resolving the profile. Reported to the owner, agent stopped, cost ≈ $0.21 (deepseek balance 8.95 →
8.74 USD, sole traffic in that window). **Do not restart `research` for this program.**
The one dispatch it produced is nonetheless the exact evidence the profile path needed and must not be
repeated: `model_profile=analysis_efficient / configured_model=deepseek-v4-pro / provider=deepseek /
billing_mode=api_payg`. Remaining canary volume comes from Claude-backed agents only.
**Before starting any agent: resolve the model through `store/model-profile-map.json` and confirm the
actual launch command** (`tmux list-panes -t agent-<n> -F '#{pane_start_command}' | grep -o "--model '[^']*'"`).
Claude-backed: architect, buildfejleszto, codeworker, deliverylead, devops, frontendfejleszto,
frontendfejleszto2, fullstackfejleszto, qa. The other 12 are deepseek.

### Phase 3 / Phase 4
Not started. Cards `planned`. Specs live in the owner's program brief (sections 12-24 / 25-39).

## Owner corrections to the brief
- **2026-07-30: brief section 4 was WRONG per Istvan.** "Minden aktiv agent trusted Claude
  runtime-on marad" does NOT hold — the existing model split STAYS (12 fleet agents keep their
  `deepseek-v4-pro` config). Do NOT move them to Claude. This does not change the dev rules
  (still provider-agnostic; external providers stay `enabled_for_routing:false` in Phase 3
  production routing until a separate GO) — only the CONFIGURED agent models are the owner-set
  split. No real conflict existed (the deepseek agents were not running).

## Progress addendum (Phase 2, P2-C in progress)
- Identity stamping (model/profile/provider/auth_profile/billing_mode on dispatches): GATED + MERGED
  to develop (`3a78855`+`3cad439` → develop head `3cad439`), dashboard rebuilt+restarted so it is LIVE.
  Live proof: an inter-agent dispatch stamped `claude-opus-5 / anthropic / configdir:.claude-personal
  / subscription_included`. `store/billing-map.json` written from VERIFIED live (provider,auth_profile)
  pairs (deepseek = api_payg, not subscription). `size:large` label created + `store/session-efficiency.json`
  so the P2-B admission guard is armed and proven firing on the live config.
- P2-C infra (collectors + subscription visibility + KPI read surface): producer build; first run
  terminated on a transient 529 with work uncommitted in `/home/iszzu/marveen-wt/p2c-collect`
  (12 modified + 7 new test files) — agent resumed to commit + verify + report. Then: canary
  evidence, acceptance, as-built doc.

## Standing rules for this program
- No LLM for routing/cost/capacity/task-size decisions — deterministic rules + explicit metadata.
- CostOps is the ONLY measurement stack; never build a parallel ledger.
- Phase 2 introduces NO runtime routing or fallback (measurement only).
- External/non-trusted providers stay `enabled_for_routing: false`; never restore a DeepSeek agent;
  never activate an untrusted provider; no automatic privacy downgrade.
- configuredPrimary is never overwritten by runtime fallback (Phase 3).
- Every guard must be provably able to go RED; a green test that survives mutation proves nothing.
- Upstream candidates are documented per phase; **no PR/issue without a separate owner GO.**
- Concrete accounts, packages, prices, model maps, trust policy, TTLs, thresholds stay
  deployment-local (gitignored `store/`); only schema/examples get committed.
