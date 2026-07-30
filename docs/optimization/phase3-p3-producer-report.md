# Lean Optimization Phase 3 — Producer Report (devops)

Card `59b383a9`. This is a **producer report, not the as-built** — per the program's own rule
(`lean-optimization-phase2-4-program-state.md`: "marveen gates independently and never accepts on
report alone"), I build on a branch and report evidence; marveen verifies independently and writes
the as-built after gating. Branch `feat/lean-opt-phase3`, worktree `/home/iszzu/marveen-wt/p3`, base
verified against local `develop` (fork-local marker `src/costops/schema.ts` present — not built
against `origin/develop`). **Not merged. Not pushed.**

Context packet: `docs/optimization/phase3-context-packet.md`.

## What I built

| File | Role |
|---|---|
| `src/capacity-routing.ts` (new) | Pure decision layer: 5-state capacity registry, error classification, sticky-routing predicate, fallback ceilings, primary-retry climb-back, subscription-first resolver. Zero I/O, mirrors `model-fallback.ts`'s dependency-free shape. |
| `src/web/capacity-routing-store.ts` (new) | I/O: runtime overlay (`store/runtime-model-overlay.json`) + deployment-local routing config (`store/capacity-routing-config.json`). `resolveRuntimeModel()` is the choke point — reads the overlay, re-checks `enabled_for_routing` at READ time (defense in depth against a stale/tampered entry), else falls through to the caller-supplied configured model. Never writes agent config. |
| `src/web/capacity-routing-runner.ts` (new) | 60s sweep (55s initial delay). Reuses `capturePane`/`paneLooksIdle`/`restartAgentProcess`/`detectsUsageLimit` (not re-implemented). Computes each agent's configured (model, provider, authProfile) via the existing Phase 2 machinery (`resolveAgentModelDetailed`, `deriveProvider`, `resolveAuthProfile`), derives capacity state from P2-C's subscription/capacity data + the pane-scrape signal, applies the resolver's decision as an overlay write/clear, and records a `routing_events` row (reusing `insertRoutingEvent` — no parallel ledger). |
| `src/web/agent-process.ts` (edited) | The two local + remote spawn call sites now call `resolveRuntimeModel(name, readAgentModel(name))` instead of `readAgentModel(name)` directly. This is the "runtime overlay changes the running model" wiring. |
| `src/web/model-fallback-runner.ts` (deleted) | Its action was `writeModelFor`/`writeMainModel` — a straight config-persistence write, exactly the violation this phase forbids. Retired rather than patched: nothing else called its exports once `web.ts` was repointed at the new runner. |
| `src/web.ts` (edited) | Registers `startCapacityRoutingRunner()` instead of the deleted runner. |
| `src/model-fallback.ts` (comment only) | Header updated to record the retirement; `detectsUsageLimit`/`decideModelAction`/chain constants are untouched and still tested (`model-fallback.test.ts`, unchanged, still green) — nothing calls the chain-walk path at runtime any more, but deleting tested pure logic was not required by this phase, only the config-write action was. |
| `src/__tests__/main-restart-platform.test.ts` (edited) | Removed the deleted file from its `RUNNERS` list, with a comment recording why. |
| 3 new test files | `capacity-routing.test.ts` (34 tests), `capacity-routing-store.test.ts` (15), `capacity-routing-no-config-write.test.ts` (5). |

## Two honest scope gaps (not silently dropped)

1. **Main agent (marveen) is not routed.** It launches via `hardRestartMarveenChannels()` /
   channels.sh, which reads `.claude/settings.json` inside the `claude` binary itself — there is no
   TS-side `--model` flag construction to intercept the way there is for sub-agents in
   `agent-process.ts`. Extending it means either touching channels.sh or writing that config file
   (the latter being exactly what is forbidden). Left exactly as configured, which was already the
   live behaviour (the old runner's main path was config-write and never actually fired — `store/
   model-fallback.json` never existed). Sub-agents only, this pass.
2. **Capacity figures are per-provider, not per-(provider, authProfile).** P2-C's subscriptions
   config has no per-auth-profile granularity yet, so two auth profiles under one provider currently
   share one capacity figure. The registry key stays `(provider, authProfile)` throughout so this can
   be sharpened later without a shape change — only today's figure *source* is coarser than the key.

## Verification (mine, as producer — marveen's own independent gate is separate and pending)

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0.
- **Full suite: 281 files, 3875 passed / 1 skipped, exit 0.** Baseline (Phase 2 P2-C acceptance, this
  program-state doc): 278 files / 3821 passed / 1 skipped. Delta: **+3 files, +54 tests, 0 regressions**
  — exactly the 3 new test files and their 54 tests; nothing else moved.
- Mutations run by me and reverted clean (verified via `diff` against a pre-mutation backup, not
  just `git status`):
  1. `capacity-routing-runner.ts`: reintroduced a `writeAgentModel(...)` call on the apply path →
     `capacity-routing-no-config-write.test.ts` red (source-level scan catches it in either of the
     two live routing modules, not just the deleted file).
  2. `capacity-routing-store.ts`: injected a `writeFileSync` inside `resolveRuntimeModel`'s own body
     → the same suite's "resolveRuntimeModel only ever READS" test red. This is **the single most
     important guard in the phase**, per the context packet, and it demonstrably catches a
     reintroduced write inside the exact function that matters, not just an unrelated file.
  3. `capacity-routing.ts` `deriveCapacityState`: changed the unknown-guard from `||` to `&&` →
     a `usageConfidence:'unknown'` + numeric value now read `'available'` — the exact failure mode
     the invariant exists to prevent → 1 test red.
  4. `capacity-routing.ts` `canAutoFallback`: `<` → `<=` → a 2nd automatic fallback on the same
     package was allowed instead of refused → 2 tests red (including the dedicated ceiling test).
  All four reverted (`diff` against the pre-mutation backup = clean) and the suite re-verified green
  afterward. Not exhaustive — sticky-routing, staleness-degrades-confidence, error-classification
  default-deny, and `enabled_for_routing` exclusion are unit-tested but I did not personally mutate
  each of those; the method is demonstrated on 4 different guards across both the pure and I/O
  layers, and marveen's own stated practice is to mutate producer guards independently regardless.

## Rollback

Deleting `store/runtime-model-overlay.json` (or it simply never existing, which is the state today)
makes every `resolveRuntimeModel` call fall through to the configured model, unconditionally — proven
directly by a test (`capacity-routing-store.test.ts`, "ROLLBACK PROOF"). `store/
capacity-routing-config.json` defaults `enabled:false`, so the runner's sweep is a no-op until an
operator turns it on — same safe-by-default shape as the old `model-fallback.json`.

## Upstream candidacy (documented only — no PR/issue opened)

`src/capacity-routing.ts` is marveen-fleet-agnostic (no hardcoded agent names, no fleet-specific
paths) and could be a candidate for the upstream fork the same way `model-fallback.ts`'s pure layer
was. Per the standing program rule, this is a note for a separate owner GO, not an action taken.

## What I did not do

- Did not merge to `develop`. Did not push. Did not move kanban card `59b383a9` to `done` — leaving
  it for marveen per the program's gate process (and my own prior correction on card `320c477a`,
  where I self-merged a gated branch and was corrected: the producer's job stops at commit + report).
- Did not touch the live install or the running dashboard.
- Did not enable the feature (`store/capacity-routing-config.json` does not exist on this worktree;
  the runner is inert by default exactly like its predecessor).
