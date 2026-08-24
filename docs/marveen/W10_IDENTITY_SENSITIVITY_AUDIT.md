# W10 — Identity, Actor & Data Sensitivity Boundary: repo audit

**Packet:** W10
**Date:** 2026-08-24
**Auditor:** marveen (staff engineer / implementation agent / verification owner)
**Contract:** `MARVEEN_IMPLEMENTATION_PLAN_WAY_OF_WORKING_v1.0_2026-08-24.md` §4
**Repo state audited:** `agent/cos-v44-acp145-replay-hardening` @ `0011de92`, plus the LIVE
store `store/claudeclaw.db` and `store/data-sensitivity-gate.json`.

Per §1.3, every requirement below carries exactly one status, and `VERIFIED_DONE`
is given only against a test or direct repo/runtime evidence. A comment or a
document is not evidence here, and neither is my own summary.

---

## 0. Headline

The repo is **much further along than a greenfield reading of §4 would suggest**,
and further along in one direction than the other. The *sending* path inside the
COS has a real, fail-closed, single-choke-point gate. What is missing is the
thing §4.2 asks for first: **there is no notion of WHO is acting.** `actor` exists
as a free-text string on case events, and nothing anywhere carries actor type,
on-behalf-of, capability scope or policy context.

So W10 is not "build a policy engine". It is:

1. give the system an identity vocabulary it currently does not have;
2. put the two good gates behind ONE boundary that also takes identity;
3. make the fleet gate's `observe-only` and its unmeasurable `allow` path honest.

Two live findings (§3) came out of running the classifier against production data
rather than reading the code, and one of them reverses what the code comments
would lead you to believe.

---

## 1. What exists today

| Module | Role | Quality |
|---|---|---|
| `src/data-sensitivity-gate.ts` | Fleet inter-agent dispatch: classify content `public/internal/restricted`, decide provider trust. Pure, dependency-free. | Solid, well-tested engine |
| `src/web/data-sensitivity-gate-runner.ts` | Config load, provider-trust resolution, audit persistence, liveness check | Wired live at `message-router.ts:670` |
| `src/cos/sensitivity.ts` | COS 4-tier personal taxonomy + model-profile allowlist. Escalate-only, fail-closed unknown → `HIGHLY_SENSITIVE`. Reuses the gate's ONE matching engine. | Strong |
| `src/cos/zst-sensitivity.ts` | ZST 8-value taxonomy incl. `UNKNOWN` at the most-restricted rank | Strong |
| `src/cos/provider-data-policy.ts` | Which PROVIDER may see which tier (reading path) | Strong |
| `src/cos/model-routing.ts` | Pick a profile *within* the sensitivity-allowed set | Strong, honest about its geo limit |
| `src/cos/dispatch-gate.ts` | **The single send choke point.** ANDs connector health + sensitivity + send authorization; any veto blocks; fail-closed | This is what §4.3 asks for — for sends |
| `src/cos/gate-permit.ts` | A permit may only be minted by the gate module (WeakSet) | Honest about what it cannot enforce in-process |
| `src/prompt-safety.ts` | Untrusted/trusted-peer wrapping against indirect injection | Strong |
| `src/cos/store-security.ts` | `redactSensitive` + store file-mode enforcement | Present |
| `src/execution-role.ts` | `producer / verifier / executor / owner` | **A different axis** — APG separation-of-duties, not §4.2 actor types |

---

## 2. Gap matrix (§1.5 Step 2)

| # | Requirement (§4) | Repo evidence | Status | Gap | Planned change |
|---|---|---|---|---|---|
| R1 | Actor types `HUMAN_USER / AGENT / SERVICE / SYSTEM_AUTOMATION` | No such vocabulary. `actor` is a free-form `string` (`case-engine-core.ts:33,78,98,117`). `execution-role.ts` is separation-of-duties, not actor kind | **MISSING** | Nothing can distinguish a human from an automation | New closed vocabulary in a dependency-free module |
| R2 | Execution identity: `actor_id, actor_type, on_behalf_of, session/run_id, capability_scope, policy_context` | grep finds **zero** occurrences of any of these field names | **MISSING** | No action carries who/on whose behalf/with what scope | One `ExecutionIdentity` type threaded through the boundary |
| R3 | ≥6 sensitivity classes | THREE parallel taxonomies: fleet 3 (`public/internal/restricted`), COS 4 (`PUBLIC…HIGHLY_SENSITIVE`), ZST 8 | **PARTIAL** | Levels exist and are fail-closed, but there is no canonical scale, so a policy cannot be stated once | Canonical scale + total mappings from all three. Existing taxonomies keep their names and behaviour |
| R4 | Orthogonal tags `PII/CREDENTIAL/FINANCIAL/LEGAL/HEALTH/AUTH_TOKEN` | ZST has `ZST_FINANCIAL`, `ZST_LEGAL`, `ZST_PERSONAL_DATA` — but as *levels* on one axis, so a thing cannot be "internal AND financial" | **PARTIAL** | Tags collapse into levels and lose information | Orthogonal tag set, derived from the existing pattern matcher |
| R5 | Central tool/action boundary | `cos/dispatch-gate.ts` is a genuine choke point **for COS sends**. `checkDispatchGate` covers **inter-agent messages**. Dashboard API writes, scheduled scripts, MCP tool calls and file writes pass through **no** policy boundary | **PARTIAL** | Two good gates, no shared boundary, and most action classes are ungated | `authorizeAction()` boundary that both existing gates delegate to; reuse, do not replace |
| R6 | Unknown high-risk fail-closed | COS: yes, proven in `sensitivity.ts` + tests. Fleet: **`mode: "observe-only"` in the live store** → `would_block` still delivers | **CONFLICT** | The fleet path's enforcement is a log line | See §3.1 — needs an owner decision on enforce, so it is raised in DECISION REQUIRED |
| R7 | No raw secret in log/prompt/tool-trace | `redactSensitive` exists; gate patterns match tokens/keys; prompt-safety wraps external content | **PARTIAL** | Exists, but not proven to be on every log call site | Negative tests on the boundary + call-site proof |
| R8 | Audit log has actor + decision | `sensitivity_audit_log` has `verdict, category, matched_patterns, target_agent, target_model, mode, reason` — and **no actor, no actor_type, no on_behalf_of, no run/correlation id** | **PARTIAL** | You can see what was decided, not who asked | Extend the audit record with the identity fields |
| R9 | Counters: allow/deny/redact/unknown/identity-failure | None. And `allow` verdicts are **deliberately not persisted** (`data-sensitivity-gate-runner.ts:110-113`) | **MISSING** | `policy_allow_count` is structurally unmeasurable today | Counter rows (aggregate, not per-message) — this also fixes §3.2 |
| R10 | Legacy `LEGACY_UNKNOWN` + restricted replay | grep: zero occurrences | **MISSING** | Old records have no actor and nothing says so | Explicit marker + fail-closed policy for records lacking identity |
| R11 | No direct bypass path | `gate-permit.ts` makes minting take three reviewable steps and says plainly it cannot make forging impossible in one process | **PARTIAL (honest)** | Accepted limit of a single-process TS codebase | Keep; add a standing test that the mint set does not grow |

---

## 3. Live findings (from production data, not from reading code)

### 3.1 The fleet gate is in `observe-only`, so its enforcement is a log line

`store/data-sensitivity-gate.json` → `{"mode":"observe-only","enabled":true}`.

`checkDispatchGate` computes `shouldBlock = config.mode === 'enforce' && verdict === 'block'`.
In `observe-only` a restricted payload heading for an untrusted provider is
recorded and **delivered**.

This is a deliberate rollout state (the module docstring plans observe-first,
enforce-after-canary), not an accident. But §4.9 requires unknown high-risk to be
fail-closed, and on this path it is not. Flipping it is a policy decision with a
real failure mode — a false positive would silently stop fleet messages — so it
goes to DECISION REQUIRED rather than being flipped by me.

### 3.2 The liveness check cannot tell "healthy and quiet" from "dead" — and I proved which one is true

The runner keeps a liveness check whose stated purpose is to catch a gate that a
merge silently unwired. It reads the audit log and reports FAILED when the log is
empty or the last row is old.

**The last row is 2026-08-09T12:55:31Z — 15 days before this audit.** Since then
**173 inter-agent messages** were delivered, 53 of them to non-marveen agents.
On the face of it, that is a dead gate.

It is not. Only **non-allow** verdicts are persisted (a deliberate choice, so the
false-positive sample stays undiluted). I replayed the *actual* classifier over
the *actual* stored message bodies for all 52 deliverable messages in that window,
under the worst-case assumption that the target model is untrusted:

```
messages replayed (to non-marveen agents): 52
verdict tally (worst-case untrusted target): {"allow":52}
non-allow count: 0
```

So the empty log is fully explained by fifteen quiet days. The gate is alive.

**The defect is the check, not the gate.** An absence-based liveness check over a
log that only records violations fires on correct behaviour, and — worse — would
look exactly the same if the gate really had been unwired. It therefore cannot
answer the question it exists to answer, in either direction.

This is the same shape as R9: `allow` is unmeasured, so both the metric and the
liveness proof are missing for the same reason. One fix serves both — record an
aggregate **evaluation counter** (how many decisions the gate made, by verdict),
not per-message allow rows. Then liveness is "it decided N things in the last
hour", which is a presence claim rather than an absence claim, and
`policy_allow_count` falls out of it.

### 3.3 `actor` today is a label, not an identity

Every case event carries `actor: string`, and the values in production are things
like `marveen`, `marveen-baseline-import`, `cos-wake`. They are useful for reading
history, and they are not authentication: any caller can pass any string, and
nothing records the actor's *type*, whose behalf it acted on, or what scope it
held. This matches the known inter-agent bus property (the `from` field is
unauthenticated, CLAUDE.md card 06f062e4). W10 does not fix bus authentication —
that is out of scope here — but it must stop *conflating* a label with an identity.

---

## 4. Assumption log (§1.4 step 6)

1. **The three taxonomies stay.** Collapsing COS/ZST/fleet into one enum would be
   a large, risky rewrite of working, tested code, and §1.2 forbids weakening
   behaviour. Instead a canonical scale is added *above* them with total mappings.
   Behaviour levels do not weaken; the mapping is monotone by construction and is
   tested that way.
2. **The boundary wraps, it does not replace.** `cos/dispatch-gate.ts` already
   satisfies §4.3 for sends and is proven. It will delegate the identity+policy
   decision to the new boundary rather than being rewritten.
3. **Bus sender authentication is out of scope** and stays a documented known
   limitation, not a silent one.
4. **`observe-only` is not flipped by me** (see DECISION REQUIRED).

---

## 5. DECISION REQUIRED

```text
DECISION REQUIRED
Context:
  The fleet inter-agent dispatch gate (src/data-sensitivity-gate.ts, wired at
  message-router.ts:670) is live, enabled, and in mode "observe-only". W10 §4.9
  requires unknown high-risk sensitivity to be fail-closed. On this path it is
  not: a restricted payload bound for an untrusted provider is logged and then
  delivered.

Conflict:
  The acceptance criterion cannot be met on this path without switching the mode
  to "enforce". Switching it is a behaviour change to live fleet messaging, not a
  code detail, so it is not mine to make silently.

Option A — switch to "enforce" now.
  Restricted content stops reaching untrusted providers immediately. Risk: a
  false positive silently stops a legitimate inter-agent message. Measured
  evidence for that risk: the false-positive sample is 80 rows total, and ZERO in
  the last 15 days, because nothing restricted has flowed. So the sample is thin
  by absence, not by review.

Option B — stay "observe-only", and make W10 honest about it.
  Record the gap explicitly as an accepted, dated exception with an owner and a
  review date, and let the ENFORCEMENT criterion be met on the COS send path
  (which is already fail-closed) while the fleet path remains observe-only.

Marveen recommendation: A, with a narrowing.
  Enforce, but only for the `restricted` category with a CREDENTIAL/AUTH_TOKEN
  tag — the classes where a false positive costs one retried message and a false
  negative costs a leaked secret. Keep `internal` in observe-only until the
  sample is real. This makes the strongest half fail-closed now, and leaves the
  ambiguous half measured rather than guessed.

Impact if no decision:
  W10 acceptance criterion "unknown high-risk fail-closed" stays PARTIAL, and the
  Phase 0 exit gate ("sensitivity/credential boundary fail-closed") cannot be
  reported as met. I will not report it met.

Safe default if allowed:
  Implement the narrowing above behind a config key, ship it defaulting to the
  CURRENT behaviour (observe-only everywhere), and hand you a one-line switch
  plus the evidence to decide with. Nothing changes in production until you flip
  it. This is what I will build unless told otherwise, because it is reversible
  and it does not pretend the gap is closed.
```

---

## 6. What W10 will implement (file-level plan follows in the DONE report)

- `src/identity/` — actor types, `ExecutionIdentity`, capability scope, policy
  context. Dependency-free, so the format and store layers can both import it.
- Canonical sensitivity scale + orthogonal tags, with total, monotone mappings
  from the fleet / COS / ZST taxonomies. Existing enums untouched.
- `authorizeAction()` — the §4.3 sequence in one place. The two existing gates
  delegate to it; neither is rewritten.
- Identity fields on the audit record; aggregate evaluation counters (fixes R9
  and §3.2 together); `LEGACY_UNKNOWN` for records with no identity.
- Tests: the full allowed/denied matrix, every actor type, every class, unknown
  actor, unknown sensitivity, missing policy context; negative tests for secret
  egress, credential in log, agent scope exceeding user scope, impersonation,
  missing identity, malformed classification; and one integration test that a
  REAL tool path blocks.
