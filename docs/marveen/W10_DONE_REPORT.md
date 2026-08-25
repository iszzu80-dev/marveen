# W10 — Done report

```text
PACKET: W10 — Identity, Actor & Data Sensitivity Boundary
Status: VERIFIED_DONE  (coverage pass 3; all nine of Istvan's criteria met 2026-08-25)
```

> **Update 2026-08-24, after Istvan's `DECISION: APPROVED – narrow enforcement`.**
> Coverage work landed on three more surfaces and the no-regression claim is now
> proven against a measured baseline. Enforcement has **not** been switched on,
> because Istvan's own condition for activating it — coverage complete and proven
> on the relevant execution paths — is not yet met. §8 below is the current,
> honest scorecard against his six VERIFIED_DONE criteria.

**Status is PARTIAL, not DONE, and the reason is a single unmet acceptance
criterion**, stated plainly in §5 below. Per §1.5 Step 7 a PARTIAL packet does
not auto-continue to W11, so I have not started W11.

---

## Implemented

**`src/identity/execution-identity.ts`** — the vocabulary the system did not have.
Closed `ActorType` set (`HUMAN_USER / AGENT / SERVICE / SYSTEM_AUTOMATION /
LEGACY_UNKNOWN`), closed `Capability` set, `ExecutionIdentity` carrying
`actorId / actorType / onBehalfOf / runId / capabilityScope / policyContext`,
and `effectiveScope()` — the delegation rule that a delegate never exceeds its
principal. Zero imports, so the policy, store and format layers can all take it
without dragging dependencies.

Three decisions worth naming:

- `resolveIdentity` returns **null rather than a partial object**. A
  half-resolved identity is what gets waved through, because every call site
  that only checks for presence sees an identity.
- An unrecognised capability is **dropped, never mapped to a neighbour**. The
  caller ends up with less authority than it asked for, which is the safe
  direction to be wrong in.
- `LEGACY_UNKNOWN_IDENTITY` holds an **empty scope**, so §4.8's legacy rule needs
  no special case anywhere in the policy code — absence denies structurally.

**`src/identity/sensitivity-scale.ts`** — one canonical 6-level scale above the
three taxonomies that already exist, with **total, monotone** mappings from each.
Mapping is one-directional (domain → canonical) on purpose: a canonical → domain
mapping would let a policy written here silently relabel a case in a domain
store, which is how a `HIGHLY_SENSITIVE` case quietly becomes `PERSONAL`.
Orthogonal tags (`PII / CREDENTIAL / FINANCIAL / LEGAL / HEALTH / AUTH_TOKEN`)
are derived from the **existing** matcher's pattern names, so tagging reuses the
one matching engine rather than adding a second.

The ZST taxonomy encodes `FINANCIAL` / `LEGAL` / `PERSONAL_DATA` as *levels*,
which forces a choice between "confidential" and "financial" when the answer is
both. The mapping splits them into level + tag, so no information is lost and no
existing enum changed.

**`src/identity/authorize-action.ts`** — the §4.3 sequence in one pure function.
Order is load-bearing: never-external tags are checked **before** the capability
check, so a caller holding a wide scope still cannot push a credential out. A
capability is permission to try, not permission to succeed.

**`src/identity/policy-metrics.ts`** — §4.7's counters, aggregated per hour so
rows grow with time and not with traffic (500 decisions → 1 row, asserted).

**Wired live** into `src/web/data-sensitivity-gate-runner.ts`: every decision now
increments a counter, the audit record carries `actor_id / actor_type /
on_behalf_of / run_id`, and the liveness check asks a presence question first.

---

## Existing capability reused (not rebuilt)

- `src/cos/dispatch-gate.ts` — already a genuine single choke point for COS
  sends, fail-closed, tested. Untouched.
- `src/cos/sensitivity.ts`, `zst-sensitivity.ts`, `provider-data-policy.ts`,
  `model-routing.ts` — all correct in their domains. Untouched; the canonical
  scale sits above them.
- `matchSensitivityPatterns` — the one matching engine. Tags derive from its
  output rather than from a second matcher.
- `src/cos/gate-permit.ts`, `src/prompt-safety.ts`, `store-security.ts` — kept.

---

## The finding this packet actually turned on

The fleet gate's liveness check had been reporting **FAILED for fifteen days**,
and it was wrong. Only non-allow verdicts are persisted, so an empty audit log is
what a healthy quiet gate produces — and also what an unwired gate produces
forever. The check could not answer its own question in either direction.

I settled it with evidence rather than reasoning: replayed the **shipping**
classifier over the **actual stored bodies** of all 52 inter-agent messages
delivered in that window, assuming the worst case (untrusted target model).

```
messages replayed (to non-marveen agents): 52
verdict tally (worst-case untrusted target): {"allow":52}
non-allow count: 0
```

The gate was alive the whole time. **The defect was the check.** It is now a
presence claim ("this gate decided N things"), which can actually be false — and
the same counters make `policy_allow_count` measurable, which it structurally
was not. One root cause, two symptoms, one fix.

---

## Tests added

`src/__tests__/w10-identity-boundary.test.ts` — 31 tests
`src/__tests__/w10-policy-metrics.test.ts` — 9 tests

Unit: every sensitivity class, every actor type, the full allowed/denied matrix
over all six actions, unknown actor, unknown sensitivity, missing policy context.
Totality of the COS and ZST mappings is proven by **iterating the domain's own
exported enum**, so adding a value there turns the test red instead of silently
falling through to a default.

### Negative tests

- secret / `AUTH_TOKEN` to an external tool, with a **full** capability scope → DENY
- agent scope wider than the principal it acts for → DENY, and the same agent
  *without* a principal → ALLOW, proving the test measures delegation rather than
  a permanently missing capability
- service impersonation via `policyContext` → DENY, context recorded, grants nothing
- missing identity → DENY + `identityResolutionFailed`
- malformed classification → DENY (see below)
- unknown action → DENY
- audit record never contains raw content

### A hole found while writing the tests, then closed

`levelRank` of a string outside the scale returns `-1`, so a malformed level read
as **less restricted than SECRET** and slid past the fail-closed check. The first
version of the test papered over this with a tautological assertion
(`expect(a || b).toBe(true)`), which proved nothing. Both were fixed: the boundary
now re-derives the level itself instead of trusting callers to coerce, and the
test asserts the specific verdict and basis.

### Mutation proof

| Mutation | Result |
|---|---|
| never-external tag check disabled | 3 tests RED |
| missing identity granted a full scope | 2 tests RED |
| delegation narrowing removed | 1 test RED |
| unknown level mapped to PUBLIC instead of the ceiling | 9 tests RED |

Reverted; 40/40 green.

---

## Migration

Additive only. New tables (`policy_decision_counters`) are created lazily on
first use; no existing table, column or enum changed. `GateCheckInput.identity`
is optional so every existing call site compiles unchanged — and its absence is
**counted** as `identity_resolution_failure` rather than treated as "no identity
needed", so the remaining gap is a number rather than an impression.

Legacy records need no backfill (§4.8): anything without an identity resolves to
`LEGACY_UNKNOWN`, which holds no capabilities.

## Rollback

Revert the commit. The new tables become unread; nothing references them. No data
migration to undo, no config to restore.

## Security impact

Net positive, with one honest caveat: **no existing path became more permissive.**
The counters and audit fields are additive. `authorizeAction` is not yet the sole
authority on any path, so it cannot yet *loosen* anything either — which is also
why W10 is PARTIAL.

---

## Acceptance traceability

| §4.9 criterion | Status | Evidence |
|---|---|---|
| Every tool/action passes a central policy boundary | **NOT MET** | The boundary exists and is wired to the fleet dispatch surface. COS sends still gate independently (correctly, but not through it). Dashboard API writes, scheduled scripts and MCP calls remain ungated |
| Missing identity cannot cause a side effect | **MET** | `LEGACY_UNKNOWN_IDENTITY` empty scope + negative test; mutation RED |
| Unknown high-risk sensitivity fail-closed | **PARTIAL** | MET in the boundary and in COS. NOT met on the fleet dispatch path, which is `observe-only` — see DECISION REQUIRED |
| Secret/credential leakage negative test blocks | **MET** | Denied with a full capability scope; mutation RED |
| Audit log contains actor + decision | **MET structurally, EMPTY in practice** | Fields added and populated; callers do not pass identity yet, so live values are `LEGACY_UNKNOWN`, and `identity_resolution_failure` counts it |
| Legacy compatibility documented | **MET** | §4.8 handling above |
| No direct bypass path | **PARTIAL** | Inherited limit: in a single-process TS codebase anything importable is callable (`gate-permit.ts` says so plainly). Unchanged, not worsened |

---

## Known limitations

1. **Coverage is the gap.** The boundary is built, proven and wired to one
   surface. "Every tool/action" is not true yet, and I will not report it as
   true. Remaining surfaces, in the order I would do them: COS send gate
   delegation → dashboard API write routes → scheduled scripts → MCP tool calls.
2. **The audit's actor is `LEGACY_UNKNOWN` in production today**, because no
   caller passes an identity yet. The field exists and the gap is counted, which
   is the difference between a known gap and an invisible one.
3. **Bus sender authentication is unchanged and out of scope.** Any holder of the
   shared token can still send as any `from` (CLAUDE.md card 06f062e4). W10 makes
   the claim structured and recorded; it does not make it proven.
4. **The fleet gate remains `observe-only`.** Deliberately not flipped by me.

## Next packet readiness

**Not ready.** W10 is PARTIAL, so per §1.5 Step 7 I have not auto-continued to
W11. Two things gate it, one of which is yours:

- the coverage work in limitation 1 (mine, no decision needed);
- the `observe-only` decision (yours, DECISION REQUIRED in the audit doc §5).

I am continuing with the coverage work. The safe default described in the audit
is what shipped: **nothing in production changed behaviour.**

## Verification

- `tsc --noEmit`: clean
- W10 tests: 40/40
- Full suite: **555/556 files, 7466 passed**, 4 skipped. The single failing file
  is `memory-performance.test.ts` (`backfillEmbeddings`), unrelated and
  previously named: a live Ollama plus a hardcoded 100 ms per row against a 5 s
  vitest timeout, so it fails under load. Not touched, per the standing backlog
  instruction.


---

# 7. Coverage pass 2 — what landed after the decision

| Surface | Before | Now | Evidence |
|---|---|---|---|
| Fleet inter-agent dispatch | counted, identity optional | unchanged | `policy_decision_counters` surface `fleet_dispatch` |
| **COS send gate** (`evaluateDispatch`) | not consulted | **fourth independent veto**, ANDed with the existing three | `w10-cos-gate-boundary.test.ts`, 10 tests, 4 mutations RED |
| **COS send flow** (`dispatchApprovedSend`) | no identity | threads `identity` / `principal` to the gate | `cos-send-flow.test.ts` green |
| **Dashboard API writes** | no boundary | identity resolved **once** in the dispatcher, before any handler; mutating `/api/` requests counted | `src/web.ts` route-context construction |
| Scheduled tasks | none | `scheduledTaskIdentity()` built and tested; **not yet threaded** into the cycle steps | `w10-principal-adapter.test.ts` |
| MCP / agent tool calls | none | **architecturally out of reach** — see §9 | — |

## The migration rule, and why it is asymmetric

A caller that **supplies** an identity is **BOUND** by the verdict. A caller that
does not gets an **ADVISORY** verdict: recorded, surfaced on the decision, and
counted — but not vetoing.

The alternative was to make identity mandatory today, which would have vetoed
every send in the system until the last call site was migrated. That is not
caution, it is an outage in the shape of a principle.

**What stops this from becoming a permanent bypass:** the advisory path is
counted (`identity_resolution_failure`, per surface). "How much of this gate is
still advisory" is therefore a number anyone can read, and W10 cannot be reported
VERIFIED_DONE while it is above zero on a live path. An unmeasured exemption
rots; a measured one is a work item.

**The exception to the exception:** a never-external tag (CREDENTIAL /
AUTH_TOKEN) vetoes **even without an identity**. "We do not know who you are" is
not a reason to let a secret leave. Asserted directly, and mutation-proven.

## Reusing rather than rebuilding, again

The dashboard identity is derived from `resolveApgPrincipal`, which already
answers *which credential authenticated this request* and is unusually careful
about what that does not prove ("'operator' is not proof of a human" — its own
header). A second resolver for the same requests would be a second answer to one
question, and the two would disagree the first time either changed.

The adapter **adds no authority**. Asserted: no principal class can reach
`EXTERNAL_EFFECT` through it, the shared fleet token gets neither `ADMIN` nor
`EXTERNAL_EFFECT`, and it never invents an `onBehalfOf`.

---

# 8. Against Istvan's six VERIFIED_DONE criteria

| # | Criterion | Verdict | Evidence / what is missing |
|---|---|---|---|
| 1 | Every in-scope action passes the central boundary | **NOT MET** | 4 of 5 surfaces wired. Scheduled-task identity is built but not threaded; MCP tool calls are outside the process (§9) |
| 2 | Actor identity / capability context actually propagates | **PARTIAL** | Dashboard: yes, resolved once at the dispatcher. COS send: yes when the caller passes it. Scheduled: not yet |
| 3 | Restricted credential / auth-token case fail-closed | **MET** | Vetoes on the real gate with a full capability scope, and **without any identity**. Mutation RED |
| 4 | Unknown / high-risk classification fail-closed | **MET** | `UNKNOWN_LEVEL = SECRET`; unrecognised level re-derived **inside** the boundary; `HIGHLY_SENSITIVE` cannot leave. Mutation: 9 tests RED |
| 5 | Runtime decision counters prove the gate works | **MET** | Three surfaces counting (`fleet_dispatch`, `cos_send`, `dashboard_api_write`); liveness is now a presence claim that can be false |
| 6 | No W10-caused regression | **MET, measured** | See §10 |

**Therefore W10 is not VERIFIED_DONE, and narrow enforcement is not activated.**
Istvan's condition was explicit: enforcement may be switched on only once coverage
is complete and proven. Flipping it now would satisfy the letter of the approval
while breaking the condition attached to it.

---

# 9. The gap I cannot close from here, stated plainly

**MCP / agent tool calls are outside any in-process boundary.**

The dashboard is a Node process. MCP tool calls — `calendar_create_event`,
`gmail_read`, a Telegram reply — are made by the *agent*, in a different process,
through servers the dashboard neither hosts nor proxies. No function in this
repository sits between the agent and those tools, so no code I write here can
gate them. Claiming otherwise would be the worst kind of false green: a
"boundary" with a documented scope that quietly excludes the surface with the
most real-world reach.

What actually constrains them today: the scheduled-task SKILL rules (read-only
Gmail, never send, the three calendar rules), the agent's own discipline, and the
approval ladder for sends that go through the COS. Those are real, and none of
them is an enforced boundary.

Closing it properly needs one of:

1. **an MCP proxy** the agent is configured to use, which applies
   `authorizeAction` before forwarding — real enforcement, new moving part;
2. **capability narrowing at the credential** — e.g. an OAuth token without
   `calendar.events` — which is enforcement by the provider and needs no trust in
   our code at all (and is the direction the W13 least-privilege work points);
3. **accepting it as out of scope for W10** and carding it, with the boundary
   covering everything in-process.

I recommend **2 for writes and 1 for the rest**, but this is an architecture
decision with a cost, so it is not mine to take unilaterally. It is the one thing
between the current state and criterion 1.

---

# 10. No-regression proof (criterion 6)

Measured, not asserted. `git diff --name-only` first: W10 touched **none** of
`memory-performance.test.ts`, `db.ts` or `memory.ts`.

Then the full suite at the pre-W10 baseline `0011de92`, W10 absent:

```
BASELINE (0011de92)   Test Files  1 failed | 553 passed (554)
                      Tests       2 failed | 7426 passed | 4 skipped (7432)
                      × backfillEmbeddings > returns 0 when ... Ollama is unreachable  → Test timed out in 5000ms
                      × backfillEmbeddings > processes rows without embeddings ...      → Test timed out in 5000ms
```

And with W10 present:

```
WITH W10              Test Files  1 failed | 557 passed (558)
                      Tests       1 failed | 7486 passed | 4 skipped (7491)
                      same file, same test, same cause
```

Same failing file, same tests, same cause (`Test timed out in 5000ms` — a live
Ollama plus a hardcoded 100 ms per row against a 5 s vitest timeout, so it is
load-dependent and has flipped between 1 and 2 failures across runs all evening).

**+4 test files, +60 tests, zero new failures.** The failure is pre-existing and
not a W10 regression.

---

# 11. Updated next-packet readiness

Still **not ready**, and now for exactly two reasons, both named above:

- **mine:** thread the scheduled-task identity into the cycle steps;
- **yours:** the MCP decision in §9.

Nothing in production changed behaviour in this pass either. The fleet gate is
still `observe-only`; narrow enforcement is built but **not switched on**.

---

# 12. Coverage pass 3 — Istvan's HYBRID EXTERNAL ACTION BOUNDARY decision (2026-08-25)

His decision changed the invariant rather than the goal: every side-effecting
action must have a Marveen-controlled, actor-aware enforcement point, and that
point need not live in one process. Two layers are mandatory (provider-side
least privilege as the outer guard, a Marveen broker in front of every external
mutating action), direct broker-less external WRITE stops being a supported path,
and read-only direct access stays direct on four stated conditions.

## What landed

**`src/identity/action-broker.ts`** — the broker. Its one design decision worth
naming: the caller hands the effect IN as a thunk, and the broker decides whether
it is ever invoked. The alternative shape — `if (allowed) { doIt() }` — has failed
in this repository before, because the check and the call are two statements and a
later edit can separate them while the code still reads as gated. Here a denial is
a function that was never called. Every denial test asserts on a call counter, not
on the returned verdict: a verdict is what the broker says, the counter is what the
outside world saw.

Gates, in order: connector must be in the inventory → a read-only credential may
not be used for a write → the inventory's risk ceiling overrides a caller that
declares a gentler one → mutating needs an actor and a run id → high-risk needs an
authorisation basis, an attributable human and a readback → then `authorizeAction`,
which remains the only place any authority question is answered.

**`src/identity/external-capability-inventory.ts`** — every way this system reaches
outside itself, as data the broker reads at runtime. An undeclared connector is
denied, which is the only thing that keeps an inventory true: if forgetting an
entry were free, the inventory would be fiction within a release.

**`src/identity/scheduled-task-identity.ts`** — the propagation Istvan asked to be
finished. The non-obvious part is that the COS cycle does not *run* its steps, it
*spawns* eleven of them, so an identity built in the parent and never crossing the
process boundary is an identity the acting code does not have. The environment
carries **identifiers only**; the capability scope is re-derived in the child from
a declaration in code. A step cannot widen its own grant by editing an env var
before spawning something else, and a forged task name gets the unknown-task
scope. Both proven by mutation.

**Brokered surfaces:** COS mail send, ZST mail send, CoS Telegram channel, Gmail
labelling (source-commit), fleet Telegram alerts, and the five-provider channel
abstraction. Plus, from pass 2: dashboard API writes, fleet dispatch.

**Narrow enforcement ARMED** on the fleet data-sensitivity gate, as a second field
rather than by flipping `mode`. A single global switch cannot express "RESTRICTED
credentials only", and the way a single switch usually gets used to express it is
by flipping the whole thing. `internal` matches production database names and
secret key NAMES, which appear constantly in legitimate fleet traffic; enforcing on
those would have broken inter-agent work the same night. A bearer token, JWT, DB
URL, Render key or private key heading for a non-trusted model now **blocks**.

## The finding this pass turned on

I measured what the Google credentials are actually allowed to do, instead of
reading what this repository says about them. `scripts/w10-verify-external-scopes.ts`
asks the provider's own tokeninfo endpoint and compares the answer to the inventory.

Its first run falsified two long-standing comments in this codebase:

| Claim in the code | Measured 2026-08-25 |
|---|---|
| `gmail-label-api.ts`: "Istvan granted gmail.modify on 2026-08-11 and the scope is confirmed by the provider" | The **private** account grants `gmail.readonly` only. No `gmail.modify`. |
| `gmail-api-transport.ts` sends personal mail with the private credential | The **private** account has no `gmail.send`. |

Both call sites load `store/.google-private-creds.json`, and `cos-close-batches.ts`
picks the labelling committer from **the file existing** rather than from a scope
check — so the committer is wired to a credential that cannot label, and the
personal send path is blocked at the provider regardless of what this code decides.
The ZST account holds both scopes, which is why the corporate path works.

This is a consent-side fact, not a code defect, and I have not touched it. It is
recorded as a `scopeGap` on both inventory entries and escalated to Istvan.

The same script then found something the per-connector view could not: the ZST
credential carried five write scopes (`gmail.send`, `gmail.modify`, `calendar.events`,
`drive.file`, `spreadsheets`) that **no inventory entry declared**. An undeclared
capability is one the broker cannot gate, because nothing tells it the connector
exists. All five are now declared, three of them marked `granted but no caller` —
worth naming, because a held-and-undocumented capability is the one nobody thinks
to revoke, and W13's least-privilege work should consider dropping them.

The script exits 1 on drift and **2 when it could not measure**, because "could not
ask" and "asked and it was fine" must not share an exit code.

## Deliberate edits to pre-existing tests, declared

Six existing test files dispatched sends as nobody, which was legal under pass 2's
advisory rule and is refused now. They were given an identity via
`src/__tests__/helpers/w10-identity.ts`. What each measures — double-send, quota
ceilings, claim contention, ledger audit fields — is unchanged; the refusal path
they never covered now has its own tests.

One assertion was **rewritten rather than adapted**, and it is the one to read:
`w10-principal-adapter.test.ts` asserted that *no* principal class could reach
`EXTERNAL_EFFECT` — "HTTP is not a send surface". That was already false when it
was written: `/api/cos/outbound/approve` is the button labelled "Elküldöm" and it
has sent mail since 2026-08-10. It passed because nothing on the send path
consulted the boundary, so nothing measured the contradiction. Wiring the broker
made it fail, which is the test doing its job late. The operator scope now holds
`EXTERNAL_EFFECT`; the **shared fleet token still does not**, and a new test
asserts that operator is the only class that gained it.

## Mutation proof — ten mutations, all RED, all reverted

| Mutation | Result |
|---|---|
| connector inventory check disabled | 1 RED |
| read-only credential check disabled | 2 RED |
| inventory risk ceiling removed | 1 RED |
| mutating-without-identity allowed | 1 RED |
| high-risk authorisation requirement removed | 1 RED |
| high-risk readback requirement removed | 1 RED |
| child trusts env scope instead of re-deriving it | 2 RED |
| env-claimed principal adopted instead of compared | 1 RED |
| narrow enforcement silently disabled | 6 RED |
| `mode:off` overridden by the narrow list | 1 RED |

## Against Istvan's VERIFIED_DONE criteria (2026-08-25 list)

| # | Criterion | Verdict |
|---|---|---|
| 1 | In-process side-effecting actions on a common actor-aware boundary | **MET** — COS send, ZST send, CoS channel, Gmail label, fleet Telegram, channel abstraction, dashboard API writes, fleet dispatch |
| 2 | Scheduled identity propagation complete | **MET** — all 11 cycle steps; a drift test fails if a step loses its grant |
| 3 | A brokered enforcement path exists and is proven for external side-effecting actions | **MET** — broker + 42 tests + 10 mutations |
| 4 | No direct write bypass | **MET as far as a test can state it** — every module with a mutating provider endpoint imports the broker, checked in CI, with the one leaf exemption itself checked at its construction sites. The inherited limit stands: in one process, anything importable is callable |
| 5 | Read-only direct paths proven read-only at capability level **and audited** | **MET** — proven by measurement; audited by the connector itself since 2026-08-25 (see §13) |
| 6 | Credential/auth-token exfiltration fail-closed | **MET** — refused with a full capability scope and with no identity at all |
| 7 | Unknown / high-risk fail-closed | **MET** — unknown level re-derived inside the boundary; unknown connector, unknown task and unknown risk class all deny |
| 8 | Runtime counters / liveness measurable | **MET** — `policy_decision_counters` on six surfaces plus `external_action_log` rows carrying actor, principal, run, verdict, outcome, readback |
| 9 | No W10-caused regression | **MET, measured** — 562 files, 7547 tests, 0 failures |

## §13 — closing the last criterion: read-only calls are now audited

`gmail.read`, `gcal.read` and `drive.read` happen in the *agent's* process, through
MCP servers this Node process neither hosts nor proxies. Nothing here could record
them, and nothing did.

The fix is **not** the generic proxy Istvan ruled out. Those MCP servers are our
own Python, so the connector records its **own** calls: one JSONL line per tool
call into `store/mcp-call-log.jsonl` — timestamp, server, tool, argument KEYS,
whether it errored. Nothing sits in the path, nothing can refuse a call.

Three decisions inside those twenty lines:

- **Argument keys, never values.** A Gmail query string can carry a person's name
  or address. An audit log that leaks what it audits is a second copy of the data
  with none of the care around the first.
- **The log fails OPEN, and that is the opposite of the rule everywhere else in
  this packet.** A gate that fails open is not a gate. But a *log* that fails
  closed would take the owner's mailbox down to protect a log file, which is worse
  than the gap it was added to close. Logging is not gating, and the two get
  opposite answers.
- **Unknown-tool calls are logged too.** A call for a tool that does not exist is
  precisely the thing worth seeing.

Verified live: a real `calendar_list` call and a bogus tool call both produced
rows, with no argument values in either. The servers were then re-pinned
(`mcp-servers-20260825T055638Z`) so a reinstall does not silently lose the audit.

### A third stale scope claim, found while doing it

`google-private-mcp.py`'s own header claimed the token grants `gmail.modify`,
`gmail.send` and `spreadsheets`, "measured 2026-08-16 against Google". Re-measured
2026-08-25: those three are **gone** from that account. Something re-consented the
token in between.

That header exists because it already replaced one false claim — its own text says
"this header used to claim ... That was false, and the shape of the falsehood is
the point." It went stale again in nine days. That is the argument for
`scripts/w10-verify-external-scopes.ts` in one paragraph: a measurement written
into a comment is a measurement that expires silently, and only a script that
re-asks can notice.

## Verification

- `tsc --noEmit`: clean
- Full suite: **562 files, 7551 passed, 4 skipped, 0 failed**
- `scripts/w10-verify-external-scopes.ts`: exit 0, no undeclared write scopes,
  no falsified read-only claims, five declared and explained gaps
- Ten mutations red, all reverted
