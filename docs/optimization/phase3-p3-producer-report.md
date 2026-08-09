# Lean Optimization Phase 3 — Producer Report (devops)

**Round 2 (2026-07-30, responding to gate comment 8261).** Marveen's gate found one real
must-fix and one real decision, both addressed below (see "Gate fix — round 2"). Round-1 sections
are left below unedited except where superseded, so the finding trail stays legible.

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
| 4 new test files (round 2 total; see below) | `capacity-routing.test.ts` (34), `capacity-routing-store.test.ts` (15), `capacity-routing-no-config-write.test.ts` (5 at round 1, trimmed to 3 at round 2), `agent-config-write-allowlist.test.ts` (4, added round 2). |

## Gate fix — round 2 (comment 8261)

**Must-fix: the config-write guard gated modules I wrote, not the path the code takes.**
`capacity-routing-no-config-write.test.ts` hand-listed two files (`capacity-routing-runner.ts`,
`capacity-routing-store.ts`) and scanned only those. Marveen proved that insufficient by inserting
`writeAgentModel(name, model)` directly into `agent-process.ts`'s `startAgentProcess`, right after
the `resolveRuntimeModel` call — a file not on the hand-picked list. tsc 0, the 3 capacity-routing
files 54/54, full suite green: invisible.

**Fix, inverted to default-deny** (new file `src/__tests__/agent-config-write-allowlist.test.ts`):
scans every `.ts` file under `src/` (not a curated subset) for a call to
`writeAgentModel`/`writeAgentModelProfile`/`writeMainModel`/`writeModelFor`, and allowlists exactly
one legitimate site — `web/routes/agents.ts`, the operator-facing REST endpoint — with the reason
written inline. A new module anywhere on (or off) the routing path is covered by construction: it
either doesn't call these symbols, or does and must be consciously allowlisted. The old hand-listed
loop was removed from `capacity-routing-no-config-write.test.ts` (that file now only checks the
deleted-runner facts + a narrower, faster, explicitly-non-substitute check on
`resolveRuntimeModel`'s own body).

Three proofs, each mutated live and reverted clean (`diff` against a pre-mutation backup):
1. **Marveen's exact mutation** (import `writeAgentModel` + call it right after `resolveRuntimeModel`
   in `startAgentProcess`, `agent-process.ts`) → the new test goes RED, naming the exact file and
   symbol (`web/agent-process.ts: calls writeAgentModel(...)`).
2. **The legitimate operator write stays GREEN**: `web/routes/agents.ts` calls
   `writeAgentModel`/`writeAgentModelProfile` in 4 places (agent create + PATCH) and is correctly
   excluded — verified both by the "no unallowlisted violations" test passing and by a dedicated
   test asserting the allowlist entry is not decorative (it does genuinely match a real call).
3. **Removing the allowlist entry** (`ALLOWLIST = {}`) → the SAME `web/routes/agents.ts` calls are
   now correctly flagged as violations, RED — proving the entry is load-bearing, so the allowlist
   cannot silently grow (an entry that stops mattering would be caught the same way).

**Decision (not a to-do note): capacity granularity stays per-provider this pass, documented
precisely rather than extended.** The fleet genuinely runs two independent Anthropic auth profiles
today — `host_default` and `configdir:.claude-personal` — each its own quota pool; live
`dispatches.auth_profile` rows already distinguish them. This registry currently reads capacity
PER PROVIDER (P2-C's `store/costops-subscriptions.json` has one entry per provider, no `authProfile`
field), so both profiles read the SAME usage figure. **The exact mis-read this causes, named
precisely**: if `host_default` is near its limit while `configdir:.claude-personal` has headroom,
both report constrained (an agent on the healthy profile is wrongly denied/routed away) — or the
reverse, a genuinely exhausted profile reads healthy because the other profile's fresher reading is
what was last stored. Both directions are silent; nothing in the current data model distinguishes
them. **Why documented rather than fixed now**: closing this means adding a nullable `auth_profile`
column to `provider_ratelimit_snapshots` (idempotent ALTER, same pattern as the existing
`usage_confidence`/`snapshot_source` columns) plus an `authProfile` field per subscriptions-config
entry, and teaching every manual/collector reading which profile it is FOR — a P2-C (already-shipped,
already-live) schema extension, not a Phase 3 change, and doing it inside this branch would silently
widen this phase's blast radius onto merged, running code. Named as a follow-up item under P2-C, not
left implicit. Full statement lives in `capacity-routing-runner.ts`'s header comment (`CAPACITY
GRANULARITY DECISION`), which this report mirrors.

**Main-agent scope boundary, restated as accepted (not forgotten)**: marveen accepted this in comment
8261 — "the main session is service-managed and its model comes from `.claude/settings.json`, which
this phase must not write." Restated here and in the runner's header as a settled boundary, not a
pending gap.

## Verification after round 2

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0.
- **Full suite: 282 files, 3877 passed / 1 skipped, exit 0.** Baseline (Phase 2 P2-C acceptance):
  278 files / 3821 passed / 1 skipped. Delta: **+4 files, +56 tests, 0 regressions** — the 4 new test
  files (`capacity-routing.test.ts` 34, `capacity-routing-store.test.ts` 15,
  `capacity-routing-no-config-write.test.ts` 3 after trimming, `agent-config-write-allowlist.test.ts`
  4) and nothing else moved.
- Round-2 mutations (3, listed above) + round-1 mutations (4, listed below) = 7 total, all reverted
  clean and re-verified green.

## Verification — round 1 (superseded numbers, kept for the finding trail)

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0.
- Full suite at round 1: 281 files, 3875 passed / 1 skipped, exit 0 (before the round-2 guard
  replacement changed the test count to 282/3877 — see "Verification after round 2" above).
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
