# Context Packet — Phase 2 / P2-B (Context Packet & Session Efficiency)

> Owner GO: full Phase 2 execution. Producer builds; marveen owns the gate.
> This packet is itself an instance of the format it asks you to build.

## Goal
Cut wasted **fresh input tokens** on fleet dispatch, and stop large work
packages from being sent into sessions that cannot safely hold them. Two
deliverables: (1) a fleet-wide **Context Packet** format + metadata, (2) an
extended **session saturation guard**. Measurement/efficiency only — NO runtime
model routing, NO fallback, NO LLM used for any decision here.

## Canonical references (live code is truth — cite file:line in the as-built)
- P2-A (its branch is the base you build on): `src/costops/dispatch.ts` — dispatch rows,
  `createDispatchSafe`, outcomes, correlation. Dispatch metadata is the natural carrier for
  packet metadata. Read `docs/optimization/phase2-p2a-context-packet.md` for its contract.
- Saturation/context guard — pure logic `src/context-guard.ts`, I/O in
  `src/web/context-guard-runner.ts`. **Live defaults are `actPct: 0.90` and `hardPct: 0.97`
  (`context-guard.ts:54-55`) plus an always-on pane-saturation net (`:53,83`) — NOT the
  85/90/92/97 the older audit implies. `pct` is measured against a per-(agent,model)
  calibrated limit, not a static 200k (`:104-142`).** Phases: `idle`, `await-handoff`,
  `await-ready`, `cooldown` (`:287-397`). Do NOT dogmatically rewrite these numbers; extend.
- The dispatch funnel every path goes through: `sendPromptToSession()` `src/web/agent-process.ts`
  (~:1634), now carrying `opts.dispatchId` from P2-A.
- Dispatch origins to attach packet metadata at: `src/web/routes/kanban.ts`,
  `src/web/message-router.ts`, `src/web/schedule-runner.ts`, `src/web/agent-worker.ts`.
- Existing handoff/checkpoint prompt machinery to reuse, not duplicate:
  `context-guard-runner.ts` (`handoffPrompt` ~:263, `resumePrompt` ~:300); the `handoff` skill
  (`~/.claude/skills/handoff/SKILL.md`) is the established HANDOFF.md shape.
- Migration pattern: idempotent boot DDL (`CREATE TABLE IF NOT EXISTS`, `try{ALTER TABLE ADD COLUMN}catch{}`);
  CostOps DDL via the `initCostOpsSchema` seam in `src/costops/schema.ts`. Nullable, forward-only, no backfill.

## Build

### 1. Fleet Context Packet format
A small, documented, reference-based structure for dispatch bodies:
`Goal` / `Canonical references` / `Relevant constraints` / `Data sensitivity` / `Done when`.
For large material carry **path + commit-or-version + content hash + a short relevant excerpt** —
never re-inline an unchanged full document, full audit, full spec, long log, or an existing artifact.
Provide a builder function (e.g. `buildContextPacket()`) + a validator, plus a committed example.
Target: normal fresh packet **~3000 tokens**. Complex tasks MAY exceed it when documented —
this is a target, NOT a quality-destroying hard cap. **Do NOT introduce a 12000-token cumulative cap.**

### 2. Packet metadata (at least optional on a dispatch)
`packetVersion`, `referencedArtifacts`, `contentHashes`, `estimatedFreshTokens`,
`taskSize` (`small|normal|large`), `contextBudgetClass`. `estimatedFreshTokens` may be an
estimate but its **confidence must be marked** (never present a guess as measured).
Persist alongside the P2-A dispatch row (nullable columns, or a linked table — justify which).
No prompt text, PII, or secrets in metadata; hashes and paths only.

### 3. Session saturation guard extension
Add the required states: `warning`, `no_new_large_task`, `checkpoint_required`, `hard_stop`.
Thresholds must be **configurable** (deployment-local config + committed example), defaulting to
today's live behaviour so this is behaviour-neutral until tuned.
**The load-bearing function:** a `large` work package MUST NOT be dispatched into a session whose
configured threshold says it can no longer safely hold it. `taskSize` comes from explicit dispatch
metadata or a simple workflow policy (e.g. kanban label / card type) — **never LLM-estimated.**
Unmarked task ⇒ treat as the agent's default (do not guess `large`).

### 4. Checkpoint / fresh session
A short, reference-based, durable checkpoint artifact containing: card/dispatch ID, goal, work done,
files changed, commit/diff, decisions, open questions, and the next executable step. Reuse the
existing handoff machinery rather than inventing a parallel one.

## Constraints (hard)
- Agent default + modelProfile stays the normal path; no per-task re-optimization; **no LLM** for
  packet sizing, task sizing, or any decision. Deterministic rules + explicit metadata only.
- CostOps stays the single measurement system — no second usage/ledger stack.
- Additive and behaviour-neutral on the normal path; if this layer faults, the static configured
  default path must still work (program principle 20 — and it must be TEST-COVERED, see below).
- Rollback: new columns nullable / new config optional, so disabling leaves it inert, no data loss.
- Upstream-friendly: the packet metadata shape and a generic saturation guard are upstream
  candidates; concrete thresholds/config stay deployment-local.

## Data sensitivity
Packets reference artifacts by path/commit/hash. No secrets, no credentials, no PII, and no
restricted content pulled inline. `Data sensitivity` is an explicit packet field so a dispatch
declares its class rather than leaving it implicit.

## Done when (P2-B gate — I verify independently, and I WILL mutate your guards)
- Context Packet builder + validator exist, with a committed example; large material is carried by
  reference (path+commit+hash+excerpt), proven by a test that fails if a full document were inlined.
- Packet metadata persists on/next to the dispatch row; `estimatedFreshTokens` carries a confidence marker.
- In a representative dispatch sample the majority of fresh packets are **under ~3000 tokens**; show the
  measured numbers. No 12k cumulative cap anywhere (assert its absence).
- Saturation guard has all four states, thresholds configurable, defaults behaviour-neutral vs today's
  0.90/0.97 + pane-saturation net.
- **A `large` task is refused into a saturated session** — with a test, AND a mutation showing that test
  goes RED if the refusal is removed. An `unmarked` task is NOT treated as large.
- taskSize/packet decisions provably contain no LLM call (assert no model invocation on these paths).
- Fault isolation is TEST-COVERED: if this layer throws, the dispatch still goes out (mirror P2-A's
  `createDispatchSafe` pattern and its red-able test — a guard that cannot go red does not count).
- `npx tsc --noEmit` exit 0; targeted tests green; FULL suite green (baseline: 3565 passed / 1 skipped
  / 262 files on the P2-A branch — must not regress); `npm run build` exit 0.
- Rollback proven: disabling/ignoring the new config+columns leaves the normal path working, no data loss.
