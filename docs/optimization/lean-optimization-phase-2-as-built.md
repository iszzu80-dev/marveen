# Lean Optimization Phase 2 — AS-BUILT

Card `f601e50b`. Owner GO: full Phase 2-4 execution to production acceptance.
Orchestrator/gate: marveen. Producers built; **every claim below was verified by me independently,
never accepted on a producer's report.** Where something is unproven or blind, it says so.

Program state doc: `docs/optimization/lean-optimization-phase2-4-program-state.md`.
Context packets: `phase2-p2a-context-packet.md`, `phase2-p2b-context-packet.md`, `phase2-p2c-context-packet.md`.

**Scope discipline honoured: Phase 2 introduced NO runtime routing and NO fallback.** It is a
measurement phase. No LLM is used for any cost, capacity, sizing or routing decision anywhere in it.

## Shipped (develop head `48377de`)

| Block | What | Merged |
|---|---|---|
| P2-A | dispatch / routing_event / outcome attribution + `cost_per_accepted_task` | `872d7d7` (12 commits, ff-only) |
| P2-A' | dispatch identity stamping (model/profile/provider/auth_profile/billing_mode) | `3a78855`+`3cad439` |
| P2-B | Context Packet + session-efficiency saturation guard | via `35c1230` |
| P2-C | collectors, subscription visibility, capacity observation, KPI read surface | `37c7e06`+`48377de` (ff-only) |

New modules: `src/costops/dispatch.ts`, `dispatch-identity.ts`, `kpi.ts`, `capacity.ts`,
`capacity-snapshots.ts`, `saturation-events.ts`, `collectors/anthropic-usage.ts`,
`collectors/scheduled-sync.ts`, `src/context-packet.ts`, `src/costops/packet-metadata.ts`,
`src/web/transcript-sources.ts`. DDL rides the single `initCostOpsSchema` seam
(`src/costops/schema.ts`), idempotent boot DDL, nullable, forward-only, no backfill.

## My independent verification of the final state

- Base check: our local develop tip `3cad439` is an ancestor of the P2-C branch — the producer did
  NOT build against `origin/develop` (which is ~143 commits behind our fork). Checkpoint `37c7e06`
  preserved, not squashed.
- `npx tsc --noEmit` exit 0 (worktree) and `npm run build` exit 0 (worktree **and** the live install).
- FULL suite, run by me in `/home/iszzu/marveen-wt/p2c-collect`: **278 files, 3821 passed / 1 skipped,
  exit 0.** Baseline at `3cad439` was 3623 / 1 / 265 → **+198 tests, +13 files, zero regressions.**
  (The suite refuses to run in the live install by design — `src/__tests__/setup/assert-not-live-install.ts`.)
- **Three mutations of my own choosing** (deliberately NOT the three the producer tested), each
  turning the suite RED and each reverted clean (`git status` empty, `grep -rn MUTATION-MARVEEN` = 0):
  1. `kpi.ts` fallback_rate: no-evidence branch → `measured(0,0)` (a confident zero on zero
     evidence) → 1 test red.
  2. `capacity.ts` `freshnessOf`: `stale` hardcoded `false` (stale data reading fresh) → 1 test red.
  3. `kpi.ts` tokens_per_accepted_task: unknown branch → `measured(0, …)` (a silent under-count
     presented as a real zero) → 1 test red.
  The guards are load-bearing beyond the producer's own three.
- Producer's own three, re-read and accepted as sound: collector fault isolation, confidence marker,
  marginal-vs-allocated split.

### One producer decision I audited rather than trusted
The tsc fix widened `PacketMetadata.estimateConfidence` from the single literal `'estimated'` to
`EstimateConfidence | string` (`src/context-packet.ts:441-447`). My packet had told the producer NOT
to widen a type to silence an error, so I checked it on the merits instead of on the instruction:
the safety property ("a heuristic must never be presented as measured") is **structural, not
type-borne** — `context_packet_fresh_tokens` is hardcoded to `estimated(...)`
(`src/costops/kpi.ts:327-333`) and the stored marker only ever appears as provenance text inside the
blocker string. The persisted column is `TEXT NOT NULL` and the read side was already
`EstimateConfidence | string`. **The widening was correct**; the field is provenance, not an enum.
Nit, not a defect: `EstimateConfidence | string` collapses to `string` in TypeScript, so the union
is documentation rather than a constraint — the comment carries the meaning.

## Live proof (dashboard rebuilt + `systemctl --user restart marveen-dashboard.service`, 12:28:22)

Deliberately deferred to this acceptance step so the fleet was not churned mid-program.

- Dashboard healthy (`http 200`); `GET /api/costs/kpi` returns a real report with **honest unknowns**
  (e.g. `"state":"unknown"`, `"blocker":"no accepted dispatch in this group, so there is no per-task
  cost to divide"`) rather than confident zeros.
- **Collectors genuinely ran in-process 2 seconds after boot** — `import_runs` ids 75-78 at
  `1785407304`: `codex-ratelimit` **ok**, `deepseek-balance` **ok**, `anthropic-usage-snapshot`
  **skipped** (precise reason), `anthropic-cost-report` **error** (precise reason).
  `startCostOpsBackgroundTasks()` is the only in-process caller (`src/web.ts:432`) and the source
  itself documents why that matters: without it the collectors are "dead code that a dashboard read
  cannot distinguish from a working measurement path."
- `provider_ratelimit_snapshots` received its **first row ever** (codex, `used_percent` 5.0,
  window 10080 min, `plan_type` plus, real `resets_at`) — the new capacity table is written by a real
  collector, not by a fixture.
- Identity stamping live and correct across both resolution paths:
  explicit-model (`claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8[1m]` → anthropic /
  subscription_included) **and** the profile path (`analysis_efficient` → `deepseek-v4-pro` →
  deepseek / **api_payg**). Billing mode comes from `store/billing-map.json` (verified live pairs),
  never inferred from a provider name.

## Honest gaps — measured, not hidden

1. **The kanban origin was production-dead; now proven live. The `accepted` writer is still
   live-unobserved.** Verified root cause: **no dispatch row had ever carried a `card_id`** (16/16
   were `source` = `message` or `scheduler`). `fireKanbanDispatch()` only fires on a transition to
   `in_progress` **through the kanban API route** (`src/web/routes/kanban.ts:332`), it returns early
   when the card has no resolvable assignee, and it self-disarms afterwards via `card.dispatched_at`
   (`:93`). No card had made that transition through the route since stamping went live, so both the
   kanban origin and the `accepted` writer were test-proven and production-unproven — the same class
   as the P2-A finding where the cost correlation had zero real callers.
   **Closed with real work, not a synthetic ping:** backlog card `4c147e1c` ("Both Google MCP servers
   self-identify as google-zst" — a live bug affecting the owner's own email triage) was assigned to
   `devops` and moved through the route, producing the **first kanban-origin dispatch in the system's
   history**: `54974e59-d2aa-481c-8214-65854912fa6c`, `source` = `kanban`, `card_id` = `4c147e1c`,
   fully stamped (`claude-sonnet-5` / anthropic / `subscription_included`).
   *Gotcha worth keeping:* assignment is `PUT /api/kanban/:id` (not PATCH — PATCH answers
   "Not found"), and the assignee must be set BEFORE the move, or the move succeeds, fires nothing,
   and leaves no trace that measurement did not happen.
   **Now fully closed.** devops fixed the card (a real one-line defect) and moved it to `done`, which
   produced the **first `accepted` outcome in the system's history**:
   `0c7098e0-5ce3-4ad9-8cd2-2006630cecc4` → dispatch `54974e59`, `outcome` = `accepted`,
   `evidence` = `kanban:done`. So the Phase 2 attribution chain is now proven end-to-end **in
   production**, not only by test: a kanban move mints a stamped dispatch, and closing the card writes
   an accepted outcome against it.
   I did not accept devops's fix on its report either — I re-ran the stdio `initialize` handshake
   against both MCP servers myself and confirmed the names now differ (`google-private` vs
   `google-zst`). devops's own caveat also checks out: `git check-ignore` → `.gitignore:45:
   mcp-servers/`, 0 tracked files, so that fix is disk-local and would be lost on a reinstall. Carded
   separately as `d95ac444` rather than left as a footnote.
2. **Anthropic subscription capacity is honestly blind.** `anthropic-usage-snapshot` skipped with
   `no anthropic subscription in store/costops-subscriptions.json`; the second gate would then require
   a `usage_snapshot`, because **Anthropic exposes no quota/usage API (re-verified 2026-07-30)** and
   the code refuses to infer one ("capacity stays unknown, never inferred"). This is designed
   behaviour, not a defect. Unblocking needs **owner input only**: which plans exist, their status and
   renewal, and optionally a manual usage-percent reading off the Claude UI. I did NOT fabricate the
   file — `costops_invoices` has **0 rows**, so there is no verified amount to derive from either.
3. **`anthropic-cost-report` errors: `no Anthropic admin key in vault (anthropic_admin_key)`.**
   Owner-supplied credential; not chased, not worked around.
4. **`cancelled` outcome has no live writer** — no cancellation signal exists anywhere in the
   codebase. Left `unknown` per spec 7.2 rather than invented; a test pins that no writer exists.
5. **Attribution limits carried over from P2-A, unchanged and still true:** a session restart
   mid-package leaves later tokens UNATTRIBUTED (under-attribution, silently low); kanban queue lag
   can make a recorded session id stale from the start; remote agents and `targetSession` tasks stay
   NULL by design; the worker link is INERT (its project dir sits outside the token_usage mapping —
   resolving it via `MAIN_AGENT_ID` would have mis-attributed the main pane's tokens, so inert was
   the correct trade and a test pins it). Sub-agent transcripts carry the parent sessionId, so their
   tokens fold into the parent package.
6. **Canary: MET — 20 real dispatches / 20 routing events**, against the card's ">= 20" target,
   and **not one of them synthetic**. Coverage is complete: both resolution paths (explicit `model`
   AND `modelProfile`), both billing modes (`subscription_included` AND `api_payg`), and all three
   live origins (`scheduler` 10, `message` 6, `kanban` 4).
   The count was closed by dispatching genuine backlog work that needed doing anyway — the CostOps
   `data_freshness` under-count (`320c477a`, which understates operational spend by ~18k Ft and would
   have corrupted Phase 4's inputs), the shared-checkout scheduled-task breakage (`d3f9fd90`), and the
   dead MK Golden Suite CI (`908ebaf3`). **Padding the count with pings was available and deliberately
   not used**: a canary inflated with synthetic traffic measures nothing, and would have made this very
   number a lie.

## Process finding worth keeping
The P2-C producer's first run died on a transient 529 with **~2900 lines uncommitted**, and the
program-state doc recorded that the agent had been "resumed to commit + verify" — it had not. A
branch switch in that worktree would have destroyed the work. I found it still dirty hours later and
checkpointed it myself (`37c7e06`). **A resumed agent's stated intent is not evidence that it acted**;
check the tree, not the note.

## Rollback
Delete `store/session-efficiency.json` → the P2-B admission guard goes inert and the fleet behaves
exactly as before. New columns are nullable and new tables additive, so ignoring them costs no data.
`store/billing-map.json` absent ⇒ billing mode stays unknown rather than guessed. No routing exists
to roll back, by design.

## Upstream candidates (NO PR without a separate owner GO)
Generic and fork-neutral: the Context Packet format + validator, the packet-metadata shape, the
generic saturation-guard states, `costPerAcceptedTask`'s marginal-vs-allocated split, and the
KPI confidence vocabulary (`measured` / `estimated` / `unknown` with a mandatory blocker).
Fork-local, not upstreamable: `billing-map.json`, the transcript-source mapping, the concrete
collectors, and everything under `store/`.
