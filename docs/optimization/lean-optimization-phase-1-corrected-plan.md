# Lean Optimization Phase 1 — corrected execution plan

**Card:** Lean Optimization Phase 1 — Privacy Gate & Neutral Model Profiles
**Date:** 2026-07-20 CEST
**Status:** PLAN ONLY. No source, config, commit, restart or enforcement change was made.
**Baseline:** live `develop`, not the 2026-07-17 audit's G4 state.

> **Read this first — a branch trap.** The shared checkout currently sits on
> `costops-rebased`. On that branch `src/web/message-router.ts` has **no** gate call
> site, and the 2026-07-17 audit document does not exist at all. Both are present on
> `develop`. Every claim below was verified against `develop` via `git show`/`git grep`,
> never against the working tree. Anyone re-checking this plan from the working tree
> will conclude the gate is dead code. It is not.

## 1. Current state

### What `src/data-sensitivity-gate.ts` implements today

288 lines, pure: no LLM call, no side effects, no I/O. It exposes
`isProviderTrusted`, `parseTrustedProviders`, `classifyContent` and `evaluateDispatch`.

- **Categories:** `public | internal | restricted`. There is **no `unknown`**.
- **Classification:** deterministic regex families (`restricted`, `internal`) with a
  context-proximity check, restricted evaluated first.
- **Trust:** prefix match of the resolved target model against a trusted set;
  `claude-*` is trusted.
- **Dispatch rule:** only `public` is in `ALLOWED_CATEGORIES_FOR_UNTRUSTED`, so both
  `internal` and `restricted` already block toward a non-trusted provider.

### The two commits

| commit | what it did |
|---|---|
| `97aaf3c` | `feat(gate): data-sensitivity dispatch gate — classify+block restricted content to non-trusted providers (card 6bf535bf)` — created the module |
| `0e9759d` | `feat(monitor): P0 C+D — memory-pressure monitor, gate, health, data-sensitivity gate` — carried it in the P0 bundle |

### Where it is active

`src/web/message-router.ts` on `develop`:

- line 28 — imports `checkDispatchGate`, `checkGateLiveness`
- line 590 — `checkDispatchGate({...})` on the dispatch path
- line 598 — BLOCKED log branch
- line 605 — observe-only branch (audit already written by the runner)
- lines 256, 278 — `checkGateLiveness()`

The liveness check exists **because a previous merge silently dropped the call site
(card `aaabd99c`)**. It queries the audit log directly and therefore does not depend on
`checkDispatchGate` being wired — a deliberate independent-observer design. Keep it.

### Mode

`store/data-sensitivity-gate.json`: `"mode": "observe-only"`, `"enabled": true`.

So: **OBSERVE**. Not off, not enforcing. Nothing is being blocked today; verdicts are
recorded as `would_block`.

The file is **untracked and gitignored** (`.gitignore:11` ignores `store/`). The
deployment-local requirement for the config is therefore **already satisfied** — but see
§6, because the *trust map* lives somewhere else.

### Tests and canary evidence

`src/__tests__/data-sensitivity-gate.test.ts`, 392 lines, covering `classifyContent`,
`isProviderTrusted`, `parseTrustedProviders` and `evaluateDispatch`. Unit-level,
fixture-driven. No live canary evidence exists yet for the dispatch path.

### What changed since the 2026-07-17 audit

The audit's G4 state predates the module. Since then the gate was written, wired into
`message-router`, given a liveness guard after a merge dropped its call site, and put
into observe-only with a deployment-local config. Any G4 recommendation phrased as
"build a gate" is satisfied; the open work is the classification model, not the gate.

## 2. Keep / change / retire / duplication risk

### Unchanged

- The pure-function design of `data-sensitivity-gate.ts`. No LLM in the gate.
- The regex content detector and its context-proximity check — **retained as the second
  safety layer**, per owner instruction. It is not being removed.
- `checkGateLiveness` and its independent audit-log query.
- The three-mode config shape and its gitignored, deployment-local location.
- Restricted-first evaluation order.

### Requires change

1. **`SensitivityCategory` gains `unknown`.** Today the type has three members.
2. **`classifyContent` must stop returning `public` for "nothing matched".**
   Line 181 returns `public` on no-match. Under the target model, absence of signal is
   `unknown`, never `public`. This is the single most important code change in Phase 1.
3. **`evaluateDispatch` must accept metadata** and apply the precedence chain. Today its
   signature is `(content, targetModel, config, trustedPrefixes)` — there is no channel
   for a declared sensitivity at all.
4. **The trusted-provider short-circuit must stop mislabelling the audit.** Today a
   trusted provider returns early with `category: 'public'` regardless of the actual
   content. The audit row then claims the payload was public when it may have been
   restricted. Classification should still run (or the category be recorded as
   `not_evaluated`) so the observe data is honest.
5. **`ALLOWED_CATEGORIES_FOR_UNTRUSTED` must handle `unknown`** — `unknown` is not
   allowed toward a non-trusted provider.

### Becomes redundant

- The "FAIL-SAFE: unknown → restricted" defensive branch in `evaluateDispatch`. Its own
  comment admits `classifyContent` never returns unknown, so **it is dead code today**.
  Once `unknown` is real, that branch must become a live, tested path — not a comment.

  This is the same defect class as MK-GATE-02 (kill-switch queries a status the CHECK
  constraint forbids) and Zsibongo `43f3897d` (rule-profile has no write path): a guard
  that is present, reads correctly, and can never fire. Phase 1 must not add a fourth.

### Dangerous duplication to avoid

- A second classifier alongside `classifyContent`. Metadata resolution and content
  detection are **different stages of one pipeline**, not two classifiers.
- A second trust list. One resolver, one source.
- Re-deriving sensitivity at more than one call site. The gate is the only place.

## 3. Final classification model

Categories: `public`, `internal`, `restricted`, `unknown`.

Precedence:

1. explicit Kanban/dispatch `dataSensitivity`
2. task or workflow policy
3. deterministic content detector
4. `unknown`

The content detector may only **tighten**:

| metadata | content signal | result |
|---|---|---|
| explicit `restricted` | any | `restricted` |
| explicit `public`/`internal` | restricted signal | **conflict** → ASK, else `restricted` |
| absent | restricted signal | `restricted` |
| absent | no reliable signal | `unknown` |
| any | weaker than metadata | metadata stands — **never downgrade** |

Hard invariants: the detector can never lower a category, and uncertain content is never
automatically `public`.

## 4. Unknown and conflict rules

- `unknown` + non-privacy-approved provider → **ASK/BLOCK**.
- **Unattended/background context: ASK == BLOCK.** No prompt exists to answer, so a
  pending ASK must fail closed. This must be an explicit runtime input to the gate, not
  inferred, because getting it wrong silently converts a block into a pass.
- Metadata/content conflict → ASK where a human is present; `restricted` otherwise.
  The conflict must be recorded as its own audit reason, distinct from a plain block.
- Automatic tightening is allowed in exactly one direction: upward.
- Human/owner approval is required to move anything downward, and to enable ENFORCE.
- Downgrade prevention is a **code invariant with its own test**, not a convention.

## 5. Metadata data path

```
Kanban card (dataSensitivity)
  → API / schema
  → dispatch payload
  → policy resolution (precedence 1-2)
  → content detector (precedence 3, tighten-only)
  → provider trust check
  → PASS / ASK / BLOCK
  → metadata-only audit event
```

Files: `src/data-sensitivity-gate.ts` (model + evaluation),
`src/web/data-sensitivity-gate-runner.ts` (config, trust, audit),
`src/web/message-router.ts` (call site), the Kanban card schema and its API surface.

- **Schema/API:** one new optional field, `dataSensitivity`, enum of the four values.
- **Backward compatibility:** absent field is a first-class value meaning "no metadata",
  which resolves to precedence 3 then 4. Absent must **not** be read as `public`.
- **Existing cards:** left alone. **No retroactive sensitivity is invented for them** —
  they simply have no metadata and fall through to the detector.
- **Default:** none. Not `public`, not `internal`. Absence is absence.
- **DB migration:** required only to persist the column on cards; the gate itself needs
  none. The audit log already exists.
- **Updatability:** config and trust map stay deployment-local and gitignored, so a
  deployment can retune without a code release.

## 6. Provider trust policy

Generic decision logic stays in `data-sensitivity-gate.ts`; the concrete provider list
must be **deployment-local and gitignored**.

Today the trust map comes from `process.env.TRUSTED_PROVIDERS`, cached in
`readTrustedProviders()`. Env is deployment-local, but it is **cached for process
lifetime** and has no fail-safe story — an unset variable yields an empty trusted set.

Required fail-safe behaviour, to be designed explicitly:

| trust map state | behaviour |
|---|---|
| missing | fail **closed** — treat every provider as non-trusted |
| malformed | fail closed + loud warning; never fall back to "trust everything" |
| unreadable | fail closed + loud warning |

An empty trusted set must be distinguishable from "not configured". Failing closed with
everything on DeepSeek would block the whole fleet — which is precisely why this must be
proven in OBSERVE first, where a wrong answer is only logged.

Audit rows carry **metadata only**: category, verdict, reason, matched pattern *names*,
target model, mode, timestamp. Never the prompt, never PII, never the matched substring,
never a credential.

## 7. Feature flag and rollout

Modes: `OFF` → `OBSERVE` (today) → `ENFORCE`.

1. unit + integration tests
2. observe-only soak
3. negative canary: public research task → must PASS
4. positive canary: synthetic restricted legal content → must show `would_block`
5. metadata/content conflict test
6. unattended `unknown` test → must fail closed
7. only then ENFORCE

Every step needs a written acceptance line and a rollback. Rollback for all of them is
one field: `mode` back to `observe-only` or `off`.

**Prerequisite for ENFORCE, non-negotiable:** the negative control. Break a guard, watch
the official test command go RED, restore it, watch it go GREEN. A gate that has never
been proven capable of failing is not evidence of anything.

## 8. Neutral model-profile layer

Profiles: `premium_reasoning`, `build_strong`, `analysis_efficient`, `routine_lowcost`.

Resolver precedence: explicit `model` → `modelProfile` → current default.

Requirements:

- the initial map resolves **exactly** to today's models
- zero model and zero account change
- an unknown profile is a **validation error**, never a silent fallback
- canary: `buildfejleszto` and `research`
- **the before/after resolved-model diff must be empty** — that is the acceptance test

This layer is pure indirection in Phase 1. If any agent's resolved model changes, the
change is wrong by definition.

## 9. Scope boundary

Still **not** in Phase 1: task-by-task dynamic optimization; capacity-aware fallback;
sticky card routing; CostOps schema extension; cost per accepted task; package
recommender; market screening; automatic provider or primary-model switching; upstream
PR or issue.

## 10. Execution blocks

### Block 1 — data-sensitivity metadata and gate correction

- **Scope:** add `unknown`; stop returning `public` on no-match; add the metadata
  parameter and precedence chain; tighten-only invariant; conflict handling;
  unattended-means-block; fix the trusted-provider audit mislabel; trust-map fail-safe.
- **Files:** `src/data-sensitivity-gate.ts`, `src/web/data-sensitivity-gate-runner.ts`,
  `src/web/message-router.ts`, Kanban card schema + API, one migration.
- **Tests:** every precedence row in §3; both conflict directions; unattended unknown;
  a **downgrade-attempt test that must fail**; trust map missing/malformed/unreadable;
  audit contains no prompt content.
- **Risk:** high. `unknown` replacing `public` as the no-match result will reclassify a
  large share of ordinary traffic. In OBSERVE this is only log volume; in ENFORCE it
  would halt the fleet. **This is the reason ENFORCE is not in Phase 1.**
- **Rollback:** `mode: off`.
- **Precondition:** none.
- **GO/NO-GO:** all tests green; negative control demonstrated; observe-log volume
  measured and understood; zero blocks in production because mode is unchanged.

### Block 2 — neutral model-profile layer

- **Scope:** the four profiles, the resolver, validation-error-on-unknown.
- **Files:** model resolution path, agent config schema.
- **Tests:** each profile resolves to today's exact model; unknown profile raises;
  precedence honoured.
- **Risk:** low, but silent if wrong — an agent could quietly move to another model.
- **Rollback:** remove `modelProfile`; explicit `model` still wins.
- **Precondition:** none. Independent of Block 1.
- **GO/NO-GO:** **empty before/after resolved-model diff across all 21 agents.**

### Block 3 — integrated canary, acceptance and rollback

- **Scope:** run the §7 canary ladder plus the Block 2 canaries; assemble evidence.
- **Files:** none — this block ships no code.
- **Tests:** the four canaries; liveness check confirms audit rows are actually landing.
- **Risk:** medium — the risk is *believing* a canary that never exercised the path.
  `checkGateLiveness` exists because that already happened once (card `aaabd99c`).
- **Rollback:** `mode: off`.
- **Precondition:** Blocks 1 and 2 accepted.
- **GO/NO-GO:** every canary produced a real audit row with the expected verdict, and
  the negative control went RED then GREEN.

## Summary

- **Document:** `docs/optimization/lean-optimization-phase-1-corrected-plan.md`
- **Current gate mode:** OBSERVE (`observe-only`, `enabled: true`), wired live at
  `message-router.ts:590` on `develop`
- **Components kept:** the pure gate module, the regex content detector as second layer,
  `checkGateLiveness`, the three-mode gitignored config
- **Migrations needed:** one, to persist `dataSensitivity` on Kanban cards
- **Three blocks:** metadata + gate correction; model-profile layer; integrated canary
- **Largest risk:** `unknown` replacing `public` as the no-match result reclassifies
  ordinary traffic — safe in OBSERVE, fleet-halting in ENFORCE
- **Suggested first block:** Block 2. It is independent, low-risk, and its acceptance
  test is objective (empty diff). Block 1 is the more valuable change but wants the
  observe-volume measurement first.
- **Any modification made:** **NO.**
