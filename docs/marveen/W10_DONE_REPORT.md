# W10 — Done report

```text
PACKET: W10 — Identity, Actor & Data Sensitivity Boundary
Status: PARTIAL
```

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
