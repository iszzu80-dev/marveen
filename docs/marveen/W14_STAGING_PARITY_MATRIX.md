# Staging parity — the six dimensions, mapped to W14 acceptance

```text
Phase 0 owner gate, 2026-08-26:
  "Az öt hiányzó dimenziót tételesen mapeld a canonical MIP/W14 acceptance
   criteria-ra. Nem fogadom el önmagában azt az állítást, hogy 'Phase 1 méretű'.
   ami W14 acceptance criterionhoz szükséges -> Phase 0 closure;
   ami ténylegesen új Phase 1 capability -> külön backlog, nem blocker."
```

---

## 0. The two things being mapped

**§8.4 — staging parity.** Staging must be close enough to production to be
testable on: *auth path, migrations, policy engine, tool execution,
observability, release flow*. With one explicit relaxation:

> Nem kell minden external side effectet élesben végrehajtani; fake/sandbox
> adapter megengedett.

**§8.8 — W14 acceptance.** Exactly one criterion depends on §8.4:

> staging release proof sikeres

So the question this document answers, dimension by dimension, is narrow:
**does a successful RELEASE proof require exercising this dimension outside
production, and is it exercised?** Not "is there a staging environment" — there
is none, and building one is not what §8.8 asks for.

The previous claim ("the other five are Phase 1 sized") was rejected for being
a size estimate where a mapping was owed. It is replaced below.

---

## 1. The matrix

| # | §8.4 dimension | verdict | required by §8.8's release proof? | evidence |
|---|---|---|---|---|
| 1 | **migrations** | **PASS** | **Yes.** A release can change the schema; a wrong migration damages the store and rollback is expensive | `scripts/w11-staging-migration-proof.ts` + `scripts/w14-merge-migration-proof.ts` against a **copy of the live store** (189 MB, 119 cases, every new table created, no row lost, integrity ok) |
| 2 | **release flow** | **PASS** *(new, 2026-08-26)* | **Yes — it IS the release proof** | `scripts/w14-rollback-drill.ts`: real `git archive` releases, all three consumers moved, the **real guard** run on a 180 MB copy of live; accept AND refuse both exercised; drill proven able to fail (§3b of `W14_ROLLBACK_PROOF.md`) |
| 3 | **auth path** | **PARTIAL** | **Partly.** The auth *logic* must be proven; proving it in a deployed staging instance is a different thing | `auth-routes`, `auth-gate`, `auth-sessions`, `auth-device-keys`, `auth-recovery` tests drive the real route handlers and the real session/throttle code. What is missing is exercising them against a **deployed** artifact. Mitigation carried into the cutover: post-cutover auth readback (§2.1) |
| 4 | **policy engine** | **PARTIAL** | **Partly, and the risk is wiring rather than logic** | The gates are heavily tested (`cos-egress-tier`, `data-sensitivity-gate`, `w13-disclosure-precedes-egress`, `cos-*-sensitivity-gate`). W13's own finding is the relevant risk: a correct function **with no caller**. That is checkable on the shipped artifact by its OUTPUT, not by a staging environment. Mitigation carried into the cutover: `cos_disclosure_records` must gain rows (§2.2) |
| 5 | **observability** | **PARTIAL** | **Partly.** The criterion needs a release to be *observable*, not a staging telemetry stack | `src/cos/operational-health.ts` (incl. the two §8.6 metrics closed on 2026-08-26), `/api/cos/monitoring`, `cos_feature_runs` written by `scripts/cos-cycle.ts`, unit-tested. The release-level check is the **post-cutover readback**, which is part of cutover acceptance (§2.3) — after the release rather than before it |
| 6 | **tool execution** | **ACCEPTED_EXCEPTION** — *no implicit side effect during release* (owner, 2026-08-26) | **No** — see §3 | Executor is approval-bound: `makeApprovalEngine` refuses with `campaign_not_approved` / "no APPROVED approval for this template + rendered payload at the campaign current version". A release cannot silently perform new outbound side effects. A sandbox-adapter staging harness is new capability |

**Score: 2 PASS, 3 PARTIAL with named cutover mitigations, 1 ACCEPTED_EXCEPTION
whose justification is a mechanism and not an estimate (§3b).**

---

## 2. The three PARTIALs, and exactly what closes each

None of the three is closed by "build a staging environment". Each has a
specific, mechanical check that belongs to the cutover's acceptance — which is
where the owner already put the bar ("A cutover elfogadása runtime evidence
legyen, ne merge-status").

### 2.1 auth path → post-cutover readback

```bash
# after the restart, before declaring the cutover accepted
curl -s -o /dev/null -w '%{http_code}\n' localhost:3420/api/kanban            # expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     localhost:3420/api/kanban                                                # expect 200
```

Two lines, and they discriminate: a release that broke the gate open shows 200
on the first; a release that broke it shut shows 401 on the second. This is the
whole of what a staging auth proof would have told us about *this* release.

### 2.2 policy engine → prove the caller exists, by its output

W13's defect was a correct redactor nobody called, found by a table with zero
rows. The same detector applies here, and it is the only one that would have
caught it:

```sql
SELECT count(*) FROM cos_disclosure_records;   -- must move off 0 within one cycle
SELECT count(*) FROM cos_recovery_queue;       -- table must exist post-migration
```

A source review would not have caught W13's bug. Neither would a staging
environment, unless it ran the same flow — which is the readback, in the place
where the flow actually runs.

### 2.3 observability → the readback IS the proof

```text
cos_feature_runs   gains rows within one cycle
/api/cos/monitoring returns staleRuns + unverifiedCompletions
```

`cos_feature_runs` is the sharpest of the three: **it held zero rows for months
while `recordFeatureRun` existed and had tests.** If it does not gain rows after
the cutover, the release is not observable regardless of what any dashboard
shows.

---

## 3. Tool execution — ACCEPTED_EXCEPTION, on a mechanism rather than a size

The gate rejected "Phase 1 sized" as an argument, correctly. The argument here
is different in kind:

1. **§8.4 permits fake/sandbox adapters** for external side effects, so what
   staging would add for this dimension is a set of fake Gmail/Calendar/Telegram
   adapters plus a harness to drive them.
2. **A release cannot change what executes.** Every outbound action is bound to
   an APPROVED approval for that exact template + rendered payload hash at the
   campaign's current version. A new build does not carry approvals, and it
   cannot inherit them: the engine refuses with `campaign_not_approved` or "no
   APPROVED approval for this template + rendered payload".
3. So the failure mode a staging tool-execution proof would catch — a release
   quietly performing side effects — **is already closed by the approval bind**,
   which is itself tested (`cos-approval-core`, `cos-executor`,
   `cos-action-authorization`).

What a sandbox harness would genuinely add is the ability to rehearse
*multi-step action flows* end to end without an owner in the loop. That is a
capability the system does not have and has never claimed, and it is worth
having — as Phase 1 work, on the backlog, not as a Phase 0 blocker.

### 3b. The exception, as the owner recorded it

```text
status:   ACCEPTED_EXCEPTION
claim:    no implicit side effect during release
decided:  Istvan, 2026-08-26 (Phase 0 closure decision)
```

The claim is not "we tested it enough". It is that a release **cannot** cause an
outbound side effect, and the evidence is two mechanisms in the code:

**1. The approval bind (payload-hash).** `makeApprovalEngine` resolves an
approval by `(template, rendered payload hash, campaign_version)` and refuses
otherwise:

```
refuse('campaign_not_approved', `campaign status ${c.status} (not APPROVED)`)
...
'no APPROVED approval for this template + rendered payload at the campaign current version'
```

A new build carries no approvals and cannot inherit them: the hash is of the
*rendered payload*, so even the same template with different content misses.

**2. The broker.** Every send is routed through `brokerExternalAction` with
`mutating: true`, a risk class, a classification, and `approval:
authorisationBasisFor(decision, …)` — *which* authorisation applied, read off
the decision rather than asserted. `DENIED` returns before the effect runs.

So the failure mode a staging tool-execution proof would catch — a release
quietly performing side effects — is closed by the binding, not by coverage.
That is what makes this an exception that can be *accepted* rather than a gap
that is merely tolerated.

**What the exception does NOT cover**, stated so it is not read wider than it
is: it says nothing about whether an action flow is *correct* end to end. It
says a release cannot fire one on its own.

**Backlog item (Phase 1):** sandbox adapter set + executor rehearsal harness for
Gmail / Calendar / Telegram, so an action flow can be driven end to end without
external side effects and without an approval per step.

---

## 4. What this matrix does not claim

- It does not claim this install has staging parity in the ordinary sense. It
  has no staging environment, and §5 of the GO/NO-GO says so plainly.
- It does not claim the three PARTIALs are harmless. It claims each one's
  *release-proof* obligation is dischargeable by a named check at cutover, and
  that the checks are ones which would actually have caught this codebase's
  characteristic defect — correct code with no consumer.
- It does not treat "PASS" on release flow as more than one drill on one night.
  The drill is re-runnable and committed; a claim that survives only in a
  document is the thing this whole exercise is against.
