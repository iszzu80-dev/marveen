# W13 — Credential, PII, Egress & Disclosure Boundary: done report

```text
PACKET: MIP-v1.0 / §7 / W13_CREDENTIAL_PII_EGRESS
Audit:  docs/marveen/W13_CREDENTIAL_PII_EGRESS_AUDIT.md (2026-08-26, night)
Build:  2026-08-26, night
Owner decisions that shaped this packet: Istvan, Telegram, 2026-08-25 23:45 →
        2026-08-26 00:17 (four messages, each one adding an acceptance point)
```

## 0. What the owner decided

The audit ended with a plan and one open question — the minimum-necessary field
policy, which is the only genuinely new POLICY in §7 and not an implementer's to
invent. Istvan answered it with a full contract, then added three acceptance
points as the build went, each of which found something:

| his point | what it turned up |
|---|---|
| the disclosure decision is the intersection of **three** inputs, not a tier lookup | the whole engine's shape |
| prove minimum-necessary by **degradation**, not by "this tier usually gets this" | the exact-sender field, which buys the task nothing and now does not travel |
| the log-safety proof must cover **every** logging surface, excluding the irrelevant ones with evidence | **two real holes**: child bindings and Error message/stack |
| a **known** credential must not enter a log/prompt/tool trace even inside an unstructured string — by provenance, not prefix matching | the known-secret registry |
| the disclosure record must be a **seal, not a receipt** | the fail-closed negative test |
| the registry must have a **lifecycle**, not only an add | rotation keeps the old value scrubbable; the set is bounded |

## 1. Log safety (§7.2 "secret nem logban", §7.6 "log redaction")

**The audit's headline finding.** `redactSensitive` was written, tested, and had
**zero production callers**, while `src/logger.ts` was a bare `pino({ level })`
with no `redact` option. Its own header claimed it "strips those fields before
anything is logged" — true of the function, false of the system. The same shape
as W12's unread `RECOVERY_REQUIRED` rows: a guard whose reader does not exist.

**Three surfaces, because one is not the logger.** Measured before being fixed:

```text
logger.child({ token: 'CHILDTOK' }).info({ a: 1 }, 'x')
  → {"token":"CHILDTOK","a":1,...}     the formatter saw only ["a"]
logger.error({ err: new Error('boom SECRET') }, 'x')
  → message AND stack went out verbatim
```

| surface | mechanism | why not something else |
|---|---|---|
| the log object | `formatters.log` | pino's own `redact` takes explicit paths with one level of wildcard, so it covers what somebody remembered to list |
| the message string | `hooks.logMethod` | the formatter never sees the message; inherited by children (measured) |
| child bindings | `hardenChild`, recursive | bindings are applied outside the per-call object; `formatters.bindings` fires for the root only |

Errors are rendered to `{type, message, stack, cause}` with all three texts
scrubbed — redaction is not deletion: `boom-marker` and the stack survive, the
credential-bearing URL does not.

**The text scrubber is structural**: URL query parameters, `Bearer`/`Basic`
headers, URL userinfo. Not a prefix list (`sk-`, `ghp_`): that would be a
blocklist of the leaks we have already seen while reading as complete. **The
limit is tested**: a bare secret in prose is not covered by this mechanism (the
next section is what covers it when the value is one of ours).

**The serializer surface is excluded by evidence, not assumption**: repo evidence
(the logger configures none) plus runtime evidence (a deliberately leaky custom
serializer receives the ALREADY-redacted value, because the formatter runs
first).

**Fail-safe, both ways** (Istvan): if the redactor throws, the WHOLE payload is
dropped for a marker — after a failure we do not know how far the walk got — and
the caller is never failed for a log line.

## 2. The known-secret boundary (Istvan's closure invariant)

Provenance, not recognition. Every value the vault hands out is registered, and
every boundary checks text against the registered set by exact substring.

- registered at the **accessor** (`getSecret`, and `setSecret` for the new value
  at write time), so no consumer has to remember anything;
- also at the env-or-vault credential read in `interpreter-provider`, because on
  this machine the live Anthropic key has arrived both ways;
- scrubbed in `scrubSecretText` (all three log surfaces) and in the disclosure
  transforms (so a prompt cannot carry it either) — **including RAW-treatment
  fields**: a credential pasted into a mail body has nothing to do with that
  field's policy.

**Why a registry and not an opaque secret type**, stated because it is a real
trade-off: every current consumer takes a plain string (an SDK constructor, an
HTTP header, a child-process env), so a wrapper needs an `.unwrap()` at each of
them — and an `.unwrap()` a caller may write is a boundary a caller may forget.
Istvan accepted this as the repo-grounded smaller enforcement.

**Lifecycle** (his four requirements, four tests): the new value is protected at
the WRITE, not at the next read; the old value can no longer act (the vault hands
out the new one); the old value **stays scrubbable** — a revoked key is still a
real credential in a log somebody may read later; and the set is bounded (FIFO,
cap 256, far above real usage, with the eviction named as a real loss rather than
hidden).

Acceptance cases, each its own test: credential source → direct field → nested
object under an innocent key → concatenation and interpolation → Error
message/cause → prompt payload.

## 3. The disclosure decision (§7.4)

Three dimensions as three passes, plus task necessity as a pre-filter:

```text
task tier × destination trust class × field/data sensitivity   → OMIT/DENY if any refuses
task necessity                                                 → OMITTED before any policy question
```

`OMITTED` and `DENIED` stay different words for different facts: "the task did
not ask for it" and "policy forbids it" have different remedies.

**Every dimension is shown refusing ON ITS OWN** while the other two would have
allowed the field. A suite that varies one input at a time cannot tell an
intersection from a table lookup.

**Field sensitivity is fail-closed by default**: a field inherits the case tier
unless the caller explicitly tags it (a language code as PUBLIC), and that tag is
recorded. Metadata is not automatically impersonal.

**The record is first-class durable data** (`cos_disclosure_records`) carrying
actor / on_behalf_of / run_id / destination / trust class / task tier / requested
fields / required fields / per-field treatment + reason / final disclosed set /
approval reference / timestamp. **It carries the reasoning, not the data** — no
disclosed values are stored, which is the difference between an audit trail and a
second copy of what you were protecting.

### 3.1 Minimum necessary, proven the way Istvan asked

Not by "this tier usually gets this". A REAL, already-shipping deterministic
function (`extractTemporalClaims`, the one the ZST intake projector uses to find
a deadline) runs over the DISCLOSED payload:

| field set | result |
|---|---|
| SUBJECT + BODY_FULL | the deadline `2026-09-01` is found |
| SUBJECT only | **nothing found** — so the body is load-bearing |
| SUBJECT + BODY_FULL + SENDER_EXACT | **identical** to without — so the sender is not minimum-necessary, and does not travel |

And the redaction that protects the person does not damage the task: the email
and the IBAN are gone, the deadline remains.

### 3.2 Wired, not shelved

The live goal-enrichment path now decides field by field. Two design points:

- **The tier is derived inside**, not accepted from the caller. A
  caller-supplied sensitivity would be a bypass — the one thing a caller must not
  be able to do is declare the data less sensitive than it is.
- **A caller that does not name its destination is an unknown destination**, so
  nothing personal goes out, and the sweep says so in its own counter
  (`disclosureBlocked`), not inside `skipped`.

**Pre-existing tests edited, disclosed:** five calls in
`cos-goal-enrichment.test.ts` and twelve in `progression-checkpoint-d.test.ts`
gained an explicit `provider`. That is not bookkeeping — it is the new contract,
and a new test pins the unnamed-destination case so it cannot be lost as a silent
regression.

### 3.3 A seal, not a receipt (Istvan's final-proof point)

- what reaches the model is the DISCLOSED text: the raw email address and IBAN
  from the stored row never appear in the prompt, the `[EMAIL]` / `[IBAN]`
  markers do, and the deadline survives;
- the record names exactly the fields the model received;
- **negative test**: with the record table made to fail on INSERT (a real SQLite
  trigger, not a stubbed function), the model is **never called**, the sweep
  reports the failure by name, and no half-enriched case state is written;
- **control**: with the store healthy the same case does go out — without this,
  every assertion above would also pass on a sweep that does nothing.

## 4. Egress and the trust vocabulary (§7.3)

The four classes now exist once, in `disclosure.ts`, and both enforcement points
speak them:

- **the LLM path** derives its class from the existing provider data-handling
  policy (`CONTRACTED → APPROVED_EXTERNAL`, `THIRD_PARTY → RESTRICTED_EXTERNAL`,
  local → `TRUSTED_INTERNAL`, unlabelled → `UNKNOWN_UNTRUSTED`) rather than
  keeping a second list;
- **the WebFetch gate** answers `trustClassOfUrl` in the same vocabulary,
  derived from the same lists it blocks with.

The cross-check test imports BOTH sides and compares them rather than promising
they were kept in step — and it found one divergence, which is documented rather
than smoothed over: an EMPTY url is not blocked (the hook's stated policy:
malformed input must never block the agent) while its class is
`UNKNOWN_UNTRUSTED`. Different questions, both answers right.

An operator-added host is `RESTRICTED_EXTERNAL`, never `APPROVED_EXTERNAL`: "the
owner allowed this host" and "there is a data-processing relationship with this
vendor" are different facts.

## 5. The four missing §7.6 criteria

| criterion | evidence |
|---|---|
| secret exfiltration attempt | an injected "include your API key" body: the known secret is not in the prompt, the instruction text still travels (it is DATA the model must see and ignore — removing it would hide the attack from the audit trail), a CREDENTIAL field is refused outright, and the attempt leaves a record naming what was refused |
| unknown domain | as its OWN criterion now: unknown host denied, lookalike (`evil.com/?x=api.github.com`, `api.github.com.evil.com`) denied, allowlisted API still passes, the denial is written to the block log, and the hook's WebFetch-only scope is asserted rather than assumed |
| credential reuse on the wrong service | a secret bound to one MCP server does not reach the other, the plaintext never lands in `.mcp.json` (a `vault:` reference does), and a typo'd server name is an ERROR rather than a silent no-op |
| stale / revoked credential | no credential yields NO interpreter — never a silent substitute; and a revoked value stays scrubbable |

## 6. Mutation checks

Every mechanism was reverted and the tests observed going red:

| reverted | red |
|---|---|
| `hardenChild` (test helper) | 3 child-binding tests |
| `hardenChild` (real logger) | the runtime wiring test |
| Error rendering → pass-through | 3 error-surface tests |
| `hooks.logMethod` removed | 4 message-surface tests |
| fail-safe → return the original object | 2 failure tests |
| vault does not register | 1 (the credential-source test) |
| log scrubber skips known secrets | 3 |
| disclosure scrubber skips known secrets | 2 |

## 7. Test results

```text
vitest run (full suite, 2026-08-26 00:35)
Test Files  575 passed (575)
Tests       7709 passed | 4 skipped (7713)
exit 0
```

Files added:

- `src/known-secrets.ts`, `src/log-redaction.ts`, `src/cos/disclosure.ts`
- `src/__tests__/w13-log-redaction.test.ts` (24)
- `src/__tests__/w13-disclosure-decision.test.ts` (26)
- `src/__tests__/w13-known-secret-boundary.test.ts` (16)
- `src/__tests__/w13-egress-and-credential-criteria.test.ts` (13)
- `src/__tests__/w13-disclosure-precedes-egress.test.ts` (6)
- `src/__tests__/w13-egress-trust-vocabulary.test.ts` (6)

Files changed: `src/logger.ts`, `src/web/vault.ts`, `src/cos/interpreter-provider.ts`,
`src/cos/store-security.ts`, `src/cos/progression-pipeline.ts`,
`src/cos/goal-enrichment.ts`, `src/cos/schema.ts`, `scripts/hooks/egress-gate.mjs`,
and the three test files whose edits are disclosed in §3.2.

## 8. Named gaps

1. **Env-read credentials beyond the interpreter.** The registry covers the vault
   and the interpreter's env-or-vault read. Other modules read credentials
   straight from `process.env` (channel tokens, provider keys in the costops
   collectors); those values are NOT registered, so the known-secret guarantee
   does not extend to them yet. Named rather than implied — the sweep to route
   every credential read through one accessor is its own change.
2. **The WebFetch gate's scope is one lane.** It covers the WebFetch tool only —
   not WebSearch, not Bash/curl, not MCP-server outbound. Stated in the hook's own
   header, and now asserted by a test so a reader cannot mistake it for the whole
   egress boundary.
3. **The disclosure gate is wired to the goal-enrichment path.** That is the live
   LLM reading path today; the reader sweep (`reader-cycle`) still routes by tier
   without a per-field decision. Its content already passes the sensitivity gate,
   so nothing is less protected than before W13 — but it is not yet field-level,
   and that is the next wiring, not a claim of completeness.
4. **`redactSensitive`'s original caller list.** The logger now redacts centrally;
   skill trajectories and other non-logger sinks still have to call it
   themselves. Unchanged by this packet.
