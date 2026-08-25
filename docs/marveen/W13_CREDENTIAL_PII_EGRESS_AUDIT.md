# W13 — Credential, PII, Egress & Disclosure Boundary: repo audit

```text
PACKET: MIP-v1.0 / §7 / W13_CREDENTIAL_PII_EGRESS
Audit date: 2026-08-26 (night, after W12 closed)
Status:     AUDIT + GAP MATRIX only — no implementation yet
Method:     read the shipped code and the shipped tests; every claim below names
            the file it was read from, and two suspicions were checked and
            DROPPED rather than reported
```

Like W12, most of §7 exists — but the balance is different. §7.5 (prompt
injection) is the strongest area in this repository and needs nothing. §7.2 and
§7.3 exist as working mechanisms with no written lifecycle. §7.4 (the disclosure
decision) does not exist as a record at all, and one §7.2 requirement is in the
worst state a requirement can be in: **built, tested, and never called.**

---

## 1. What already exists, measured

### 1.1 Secret storage (§7.2)

| requirement | state | where |
|---|---|---|
| not in plain config | **MET** | `src/web/vault.ts`: AES-256-GCM, per-entry salt+iv+tag, master key in macOS Keychain or a 0600 file |
| retrieval scoped | **MET, and better than expected** | `src/web/vault-bindings.ts`: a secret is bound to `(envVar, mcpFilePath, serverName)` targets — not a global read for whoever imports the module |
| rotation supported | **MECHANICALLY MET** | `setSecret` overwrites in place, `updatedAt` moves |
| revocation | **MECHANICALLY MET** | `deleteSecret` |
| not in durable agent memory | not audited here | the memory guardrail is a separate subsystem |
| **not in logs** | **GAP — see 2.1** | |

Store permissions have their own enforcement and their own tests:
`assertStorePermissions` (file ≤ 0600, dir ≤ 0700, `missing` reported rather
than skipped), `src/__tests__/cos-store-security.test.ts`.

### 1.2 Egress (§7.3)

There is no single egress policy. There are **three separate two-valued
decisions on three different paths**, each defensible on its own:

| path | decision | fail-closed? | evidence |
|---|---|---|---|
| agent `WebFetch` | on the allowlist or DENIED | yes, deny-by-default | `scripts/hooks/egress-gate.mjs` + `egress-gate-port-validation.test.ts` (runs the real hook as a subprocess) |
| LLM provider (reading path) | `CONTRACTED` vs `THIRD_PARTY` per sensitivity tier | yes, on BOTH axes | `src/cos/provider-data-policy.ts`, `cos-reader-sensitivity-gate.test.ts`, `cos-enrich-sensitivity-gate.test.ts`, `cos-egress-tier.test.ts` |
| quarantine-reader fetch target | `isPublicFetchHost` — rejects IP literals, single-label names, internal suffixes, loopback/RFC1918/link-local | yes | `src/web/agent-scaffold.ts`, `quarantine-allowlist-render.test.ts` |

The LLM path is genuinely strong: a sensitive case with no contracted provider
is **blocked and recorded**, never downgraded — "no provider at all means
nothing is sent" is a named test, and content escalates the tier even when the
case is labelled PERSONAL.

The `WebFetch` gate states its own scope limit in its header, and it is a real
one: it covers the WebFetch tool only — **not WebSearch, not Bash/curl, not MCP
server outbound**.

### 1.3 Prompt injection boundary (§7.5) — the strongest area, needs nothing

`src/prompt-safety.ts` wraps external content in `<untrusted source="...">`,
scrubs **every** known security tag from every payload (so a nested tag cannot
resurface as a secondary opener), and sanitises the source attribute itself.
`src/cos/scope-gate.ts` makes connector identity — not content — the storage
boundary, deliberately superseding an earlier rule where corporate-looking text
could move an item into the corporate store.

`src/__tests__/cos-reader-injection.test.ts` proves §7.5's five bullets as seven
named tests: the injection arrives as delimited source data; the Reader has **no
write capability, structurally**; the decision vocabulary is closed so an
instruction cannot become an authority; the validator refuses a packet citing a
source it was never given; a financial instruction reaches no gate because
nothing on that path can send; no external action results; and the source and
the decision are reconstructible from the audit trail.

### 1.4 Audit trail (§7.7's last criterion)

Three surfaces exist, and together they answer *that* something left, not
*which fields* did:

- `store/mcp-call-log.jsonl` — `{at, server, tool, argKeys, ok}`, **argument
  keys only, never values**. Built 2026-08-25 morning; it recorded that evening's
  private-Google token revocation and recovery end to end.
- `action_authorizations` + `delegation_envelope` decisions — why a send was
  allowed without asking.
- The reader's block rows — a refusal names the tier and what WOULD have been
  allowed.

---

## 2. Gap matrix

| §7 requirement | verdict | evidence / what is missing |
|---|---|---|
| 7.2 secret not in plain config | MET | vault |
| 7.2 retrieval scoped | MET | vault-bindings targets |
| 7.2 rotation / revocation | **PARTIAL** | the operations exist; the LIFECYCLE is undocumented and untested (2.3) |
| 7.2 **secret not in logs** | **GAP** | 2.1 |
| 7.3 four trust classes | **GAP** | three two-valued decisions, no shared vocabulary (2.2) |
| 7.3 unknown + sensitive = deny | **MET on the LLM path**, PARTIAL elsewhere | no place where destination trust and data sensitivity meet in one decision |
| 7.4 disclosure decision record | **GAP** | nothing produces the six-field record (2.4) |
| 7.5 prompt injection boundary | **MET** | seven named tests |
| 7.6 secret exfiltration attempt | **GAP** | the quarantine-reader template is tested; no test attempts an exfiltration |
| 7.6 prompt injection from external content | MET | |
| 7.6 PII unnecessary field disclosure | **GAP** | gates are by TIER, never by FIELD |
| 7.6 unknown domain | PARTIAL | denied by the real hook in another test's control case, not as its own criterion |
| 7.6 allowed domain + forbidden field | **GAP** | there is no field-level policy to violate |
| 7.6 credential reuse on the wrong service | **GAP** | bindings make it expressible; nothing checks it |
| 7.6 stale / revoked credential | **PARTIAL** | lived on 2026-08-25 (Google `invalid_grant`) and handled correctly; not a test |
| 7.6 log redaction | **GAP** | 2.1 |

### 2.1 `redactSensitive` is built, tested, and never called

`src/cos/store-security.ts` exports `redactSensitive`, and its own header says a
sensitive body "must never reach a debug log … `redactSensitive` strips those
fields before anything is logged", and that it "can be called from … every
logger call site".

**It has no production caller.** The only importer in the repository is its own
test. And `src/logger.ts` is a bare `pino({ level })` — **no `redact` option at
all**. So the statement is true of the FUNCTION and false of the SYSTEM, which
is the same shape as W12's `RECOVERY_REQUIRED` rows: a guard whose reader does
not exist.

**Sized honestly, by looking rather than assuming.** I swept the logger call
sites for values that are actually secret or personal:

- `src/web/channel-invites.ts:254` logs `token: tToken` — a pairing token. It is
  marked `used = true` a few lines above, so what reaches the log is a spent
  single-use token. Real, small.
- `src/web/routes/settings.ts:73` logs `oldValue` / `newValue` for any setting.
  **Suspicion dropped:** the same route refuses `secret: true` entries before
  reaching that line, and the v1 registry has none, so a secret cannot travel
  this path today.
- `src/google-api.ts` logs provider error bodies. Provider error JSON, not
  credentials.

So today's exposure is one spent token. The gap is not a leak to clean up — it
is that **nothing would catch the next log line that carries one**, and §7.6
names exactly that test.

### 2.2 §7.3's four trust classes do not exist

§7.3 asks for `trusted internal / approved external / restricted external /
unknown-untrusted` as one classification. What exists is three independent
binary decisions (1.2). Each is fail-closed and tested; none can express
"restricted external", and no caller can ask one question about a destination.

The honest reading is that the *behaviour* §7.3 wants is largely present and the
*vocabulary* is not. That matters for §7.4: a disclosure record cannot state a
policy outcome without a class to name.

### 2.3 The secret lifecycle is a set of functions, not a documented lifecycle

Rotation is `setSecret` called again; revocation is `deleteSecret`. Neither has
a written procedure, an owner, or a test. Two consequences are already visible in
this system's history: the 2026-08-25 Google revocation was diagnosed by hand,
and a key that lives in the env is invisible to the vault path (documented in
`interpreter-provider.ts`, where an env-only lookup would have kept reporting
"switched to Anthropic" while using DeepSeek).

### 2.4 The disclosure decision (§7.4) has no record

Nothing writes `requested fields / data classes / minimum necessary / policy
outcome / redactions / approval requirement`. The pieces that exist answer
neighbouring questions: `evaluateEnvelope` answers *may this go without asking
Istvan*, the reader block row answers *why this tier was refused*, the MCP call
log answers *which tool ran with which argument keys*.

**Minimum-necessary is the part with nothing behind it at all.** Every gate in
the system is tier-shaped: it decides WHETHER a case may go to a destination,
never WHICH FIELDS go. The context builder bounds size, not field set.

---

## 3. Plan (implementation, next session)

Ordered by "what would catch a real defect first", not by section number.

1. **Wire log redaction and prove it.** A pino `redact` configuration plus
   `redactSensitive` at the call sites that carry structured case data, and a
   test that fails when a known secret-shaped value reaches a log line. Fix the
   `channel-invites.ts` token line as its first case.
2. **One destination-trust vocabulary** (§7.3's four classes) with the three
   existing gates reading it, rather than a fourth gate beside them. No
   behaviour change intended — a rename with a shared table, so §7.4 has
   something to cite.
3. **The disclosure record** (§7.4) written wherever data crosses to an external
   destination, starting with the LLM reading path, which already computes half
   of it (tier, provider class, outcome, reason).
4. **Minimum-necessary field policy** for the LLM path: declare the fields a
   prompt may carry per tier, redact the rest, and record the redactions in the
   disclosure record. This is the only genuinely new POLICY in W13 and the one
   to bring to Istvan before building.
5. **The four missing §7.6 tests**: secret exfiltration attempt, unknown domain
   as its own criterion, credential reuse on the wrong service, stale/revoked
   credential (replaying the 2026-08-25 `invalid_grant` shape).

No code was written for W13 in this session. The audit is the deliverable.
