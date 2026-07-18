# Verification Evidence Standard (fleet rule)

**Status:** standing fleet rule. Approved by marveen 2026-07-18, from five independent findings in a single evening (a sixth was the author of this document repeating the mistake within the hour).
**Owner:** deliverylead (Maestro). Applies to every product, every agent, every go/no-go gate.
**Where it binds:** go/no-go gate item 19 on all four launch gates (MK `a95d001d`, Zsibongő `1c851714`, DORA `f2d02f82`, LumaSeat `ce44b24c`).

---

## The rule, in one sentence

For any safety mechanism, ask **what it emits when it fails**, and whether that is distinguishable
from what it emits when it works. If it is not, the mechanism is unverifiable no matter how correct
the code is.

---

## Why this exists

On 2026-07-18 the fleet found five defects in one evening, across five products, written by five
different authors. They looked unrelated. They are one shape.

| # | Mechanism | What it emitted | What was true |
|---|---|---|---|
| 1 | LumaSeat 30-guest free cap | HTTP 201, guest created | Cap never fires — count runs outside `withTenant()` on a FORCE-RLS table, returns 0, `0 >= 30` is never true |
| 2 | MK rule-expiry cron | `checked=0 expired=0 — all VALIDATED profiles current`, exit 0 | Filters `status='VALIDATED'`, a value the CHECK constraint forbids. Matches zero rows forever |
| 3 | QQ SMS dispatch | HTTP success + a row in `sms_log` | The `sms_log` row has no discriminator: the dev stub and the real provider write identical rows, so the audit trail cannot answer "did the customer get a text". *(Note: the original write-up of this case also claimed prod SMS was unwired. That claim was false — see case 6.)* |
| 4 | DORA workspace RESTRICTIVE policies | A clean live verification run | Policies inert — app pool connects as table owner, and owner bypasses RLS without FORCE |
| 5 | GDPR dietary-consent diagnostic | "remediation complete" | Bare `pool.query()` on FORCE-RLS `eskuvo_guests` outside `withTenant()` returns 0, and 0 pending reads as success. Structurally incapable of reporting a gap (`ba7012ba`) |
| 6 | **This document's own case 3** | "confirmed in code" + a board search returning zero hits | QQ SMS *is* live in production (all three `TWILIO_*` set on suite-api-08wb, live-verified). The "no real TWILIO_* values exist" comment in `backends.ts` is stale and was already known to be stale; the board search silently excluded 676 archived cards, two of which settled the question. Cost: one spurious istvan-döntés card and a recommendation to drop a working paid feature from launch |

None of these is bad code. Each one is a correct-looking mechanism paired with an **evidence surface
that cannot tell working from not-working**. A passing log line, a success response, a stored audit
row, a clean verification run — every one produced reassurance while doing nothing.

That is the failure mode. Not the bug: the *unfalsifiability*.

A monitor that cannot fail is worse than no monitor. Absence is visible; false green manufactures
confidence and points investigators away from the cause. In case 3 the `sms_log` row is actively
harmful: it is evidence that we *tried*, indistinguishable from evidence that the customer
*received*, so the first place anyone looks during a complaint confidently tells them the wrong thing.

---

## The three checks

### 1. Reading is not evidence — drive it

Reading proves a mechanism **exists**. It does not prove it **fires**. Every claim that a gate,
guard, limit or block works must come from driving it and observing the response, not from reading
the code that implements it.

This rule was written after marveen read the LumaSeat guest-cap code, quoted it as a working paywall,
and was wrong.

### 2. Driving as the wrong role is not evidence either

The companion to check 1, and the one that catches people who are already doing check 1 properly.

Two independent instances in one evening. **Neither was "the wrong amount of privilege" — both were
a failure to match production**, and that distinction is the whole rule:

- **DORA.** architect verified the new RESTRICTIVE policies live, as a non-owner role. That is the
  *correct default* for RLS testing almost everywhere, and it is right for marveen-suite. It was
  wrong here only because `dora-app`'s pool connects **as the table owner** — unusual, and the
  reason owner-bypass could not manifest in the test.
- **LumaSeat.** qa's first paywall run connected as the local bootstrap superuser
  (BYPASSRLS + table owner) instead of `suite_app_runtime`. Under that role the broken guest cap
  *appeared to work* and the `tenants`-RLS landmine *did not reproduce* — both the opposite of the
  truth. qa caught this themselves and re-drove.

> Do **not** encode this as "use a more restricted role" or "use a less restricted role". Encode it
> as **match production, and check per application, because it differs**. A rule phrased as a
> privilege *level* will send the next person to the wrong one with full confidence.

The per-product mapping belongs in the harness header, where the person running it will see it —
qa has put it in both DORA harnesses for exactly this reason.

Neither test was sloppy. Both were methodologically sound and returned green.

**There are four privilege worlds, not two** (qa, from three separate catches in one evening):

| World | Behaviour | What a green result proves |
|---|---|---|
| **superuser** | bypasses everything | nothing about RLS |
| **BYPASSRLS role attribute** | ignores FORCE entirely — it is a *role attribute*, not an ownership question | nothing about RLS, in either direction |
| **plain table owner** | bypasses RLS *unless* FORCE is set | only what holds for owner-connected pools |
| **plain grantee** (e.g. `suite_app_runtime`) | fully subject to RLS | only what holds for non-owner pools |

Conflating superuser+BYPASSRLS with plain table-owner made an sms_log owner-control fail all 6 checks
and briefly look like FORCE RLS was broken — a false *positive* from the same root that produced the
false *negatives* above.

> **A drive is only evidence for the privilege it ran at.**

**The direction flip is the part people get wrong, so learn both examples or neither:**

- **False negative.** LumaSeat paywall audit: an over-privileged role made a *broken* guest cap
  look like it worked, and the `tenants` landmine fail to reproduce.
- **False positive.** `4b93f109` sms_log: an over-privileged role made *working* FORCE RLS look
  broken — an owner-control that failed all 6 checks.

Anyone who learns this as "the wrong role makes things look fine" will happily trust a bogus
finding. Anyone who learns it as "makes things look broken" will dismiss a real one. Neither is the
rule.

> The wrong role does not bias the result in a direction. It makes the result **meaningless**, in
> whichever direction happens to fall out.


Note this is *not* "always test as a non-owner". DORA's app pool **is** the table owner, so the
owner-level harness is the correct one there and the non-owner run was the misleading one. The
question is never "which role is most restrictive" — it is "which role does production connect as".

> For anything touching RLS, tenancy, or a permission boundary, the first question is not
> *"did I drive it"* but **"as which role does production connect, and did I drive it as that"**.

**Concrete consequence:** a regression test for RLS-dependent behaviour must run as **the role
production connects with, verified per-application** — not merely "a non-superuser". Non-superuser is
necessary but not sufficient: a plain grantee satisfies it and would reproduce the DORA error exactly,
while following the rule correctly. The mapping today is `marveen-suite` → `suite_app_runtime` (plain
grantee, via `DATABASE_URL_RUNTIME`); `dora-app` → the app pool **is the table owner**, so a
plain-grantee test there returns clean and proves nothing. And the test must itself assert the
connected role, or it decays back to false-green the first time someone simplifies the connection
string.

### 3. Prove it can go RED

Not that it runs. Not that it passes. That it is **capable of failing**.

Someone arms a failure condition and observes the mechanism actually fire. The regression test is
the artefact of having done so.

The strongest evidence produced on 2026-07-18 was of exactly this kind: qa proved the `isPremiumGated`
fail-open landmine by *applying* the `tenants` hardening and watching three premium gates open at
once (PDF 402→200, Share 402→201, RSVP 402→200). That demonstrated the failure rather than arguing
for it — and converted a theoretical design smell into a timing hazard against a rollout already in
progress.

Corollary for monitors: make `checked=0` a **distinct and noisy state** from `checked=N, found=0`.
A job that legitimately found nothing and a job whose filter can never match must not log the same line.

**Corollary for test harnesses — give the mechanism its own negative control.** The same move applies
one level down: do not assume your harness can detect the thing it is testing. There are **two
legitimate shapes**, and a *green* control can be the correct outcome:

- *Expect-different*: arm the failure and expect the assertions to **flip** — qa armed RLS on
  `tenants` and watched 402 become 200.
- *Expect-same-at-a-different-privilege*: same assertions, different role, expecting the **same
  green** — proving the mechanism is load-bearing rather than incidental. On `4b93f109` qa gave
  FORCE RLS its own control (a non-superuser owner, 6/6 clean) rather than assuming FORCE was in
  effect.

If a control that *should* have broken comes back clean, the harness is broken, not the security.
Describing only the first shape teaches people that a green control does not count.

---

## How to apply it

When accepting any guard, gate, monitor, limit or automatic remediation:

1. **Name the failure output.** What does this emit when it fails? Write it down.
2. **Compare it to the success output.** If they are indistinguishable, stop — the mechanism is
   unverifiable. Fix the evidence surface before accepting the mechanism.
3. **Drive it**, and drive it **as the role production connects with**.
4. **Arm a failure** and watch it go red. Keep that as the regression test.
5. **Check the discriminator persists.** If a stub and the real path can write the same audit row,
   add a field that says which one ran, or do not write the row at all.

### Smells that should trigger this immediately

- A status/enum literal duplicated across a module boundary (case 2 — the filter and the CHECK
  constraint drifted apart at a rename)
- A `if (!row) return false` / fail-open default on a permission or entitlement read (case 4… and
  case 1's sibling `isPremiumGated`)
- A provider-selection fallback with no warning on the unwired path (case 3)
- A comment or doc asserting that something is "handled automatically" — verify it, do not inherit
  the claim. MK migration 0125 claimed the 2027 cost-ratio ramp was auto-caught via `effective_to`.
  It was not, and that claim had a date attached: 2026-12-01.
- Green tests over a rule with no fixture. A suite is evidence about the cases it contains and
  nothing else. MK's suites were 33/33 and 15/15 green while the naparányos rule was not implemented
  at all.

---

## Companion rule: two searches that feel like verification and are not

Both of these were committed by this document's own author, within an hour of writing it. They are
listed first because they are the easiest to repeat.

### "Confirmed in code" is not confirmation of runtime state

architect reported "no real Twilio credentials exist anywhere in this fleet (confirmed in code)".
They had confirmed it in code — the comment in `backends.ts` reads *"No real TWILIO_* values exist
yet"*. That comment was stale, and a card had **already flagged it as stale**. All three `TWILIO_*`
values are set live on `suite-api-08wb`; `GET /health` returns `backends.sms:"twilio"`.

> **A source comment is not evidence of runtime state.** When the question is *"is X configured,
> live, enabled?"*, the answer comes from the running system — `/health`, an env query, an actual
> call — never from a comment, a README, or a card description. **Comments describe intent at write
> time; they do not update themselves.**

**The chain was four long, and each link added confidence instead of checking.** architect read the
stale comment; deliverylead relayed it; marveen relayed it *with an endorsement*; it reached the
owner as a decision to make — remove a working, paid-for, production-verified feature he had already
decided on. One HTTP request would have stopped it at any link. Relaying is not verifying, and an
endorsement attached to an unchecked claim is how a stale comment acquires the authority of four
people.

Worse: card `8b9c09fe` had **already flagged that comment as stale**. The correction existed and was
not found — the archived-cards problem and the stale-surface problem intersecting.

### A board search that excludes archived cards is biased against settled decisions

676 of 1361 cards on this board are archived, and the API's default query returns only the 685
active ones. **The better-settled a decision is, the more likely its card is archived** — so
"was this already decided?" is precisely the question the default query is worst at answering.

Two spurious escalations in one evening came from this, including a duplicate istvan-döntés card
asking Istvan to buy something he had already bought, wired and verified.

> When checking whether something is already decided, **query the database, not the API** —
> `store/claudeclaw.db`, `kanban_cards`, without filtering `archived_at`.

## Companion rule: a finding that lives only in a message does not exist

Twice on 2026-07-18 a **real defect** was invisible to the board because it existed only in prose:

- The QQ Twilio gap was one sentence in a verification report. A search across all 673 cards for
  "twilio" returned zero hits. It became `3c216b2c` / `f0bd4ef6` only because someone went looking.
- The GDPR consent diagnostic above existed only in a bus message from devops to marveen. Zero hits
  on title, description, the `file:line`, and every keyword combination tried. It became `ba7012ba`
  the same way.

**Why it happens, and it is not forgetfulness** (qa's formulation, better than the rule itself): *a
defect delivered inside a status update reads as HANDLED to the sender and as FYI to the receiver.*
Nobody forgets. Both parties think the other has it. That ambiguity is the mechanism — which is why
the countermeasure targets the ambiguity rather than anyone's diligence.

In both cases the finder was correct, was not being careless, and had simply moved on to the next
thing. That is the normal and expected behaviour of someone mid-task — which is exactly why the
process has to catch it rather than relying on discipline.

> **Whoever reports a defect in passing either cards it, or says explicitly that they are not carding
> it** — so the receiver knows to.

**And a claim that something is already tracked must name the card.** Card `e3e21526` described the
LumaSeat guest cap as *"KNOWN BROKEN, being fixed"* — with no link, and no fix card existed. That is
worse than silence: an unlinked assurance actively **stops the next reader from filing it**, because
the work appears to be in hand. It survived that way until someone searched and found nothing.

### And ask what was CLOSED on a broken instrument's output

When the defect is a *diagnostic, monitor, gate or limit*, fixing it is the smaller half. The
readings taken while it was broken are the actual exposure — **repairing the instrument does not
retroactively make the old readings true.**

- GDPR consent diagnostic (`ba7012ba`): if an Art.9 remediation was signed off because it reported
  "complete", that signature is worth nothing, and we need to know which one it was.
- LumaSeat guest cap (`4a21e491`): marveen told Istvan the cap was the binding paywall and built
  three further claims on it. Those were readings from an instrument that never fired; they have
  been retracted to him, and the card records it so the same false premise is not re-derived later.
- MK rule-expiry cron (`098a521b`): anything concluded to be "current" on its clean log line.

> Every broken-instrument card carries a second question: **what decisions were taken on its output,
> and do they still stand?**

**The base rate, as of 2026-07-18: two for two.** Every time we have actually asked this question, the
answer has been *something* — not "none found":

| Broken instrument | What was decided on its output |
|---|---|
| LumaSeat guest cap (`4a21e491`) | marveen told Istvan the cap was the binding paywall and built three further claims on it. Retracted. |
| GDPR consent diagnostic (`ba7012ba`) | Archived card `9ecb424b`, a **P1 Art.9 consent remediation**, was closed on `missingConsentStatusCount:0 / remediationComplete:true` — a zero the bug guaranteed. Re-verification carded as `44332476`. |

Two asks, two hits. This is not a theoretical risk we are being diligent about; it is the base rate.
**Whoever adds a case to this table updates the count** — a stale "two for two" is exactly the kind of
frozen claim this document is about.

> If a report says a defect is being handled, it must name the card. "Being fixed" without an id is
> an assertion, not a reference.

A finding that lives only in a message is one we will re-discover later at full cost, usually from a
customer, usually with the audit trail pointing the wrong way.

**The same hazard applies to corrections, and is easier to miss.** On DORA-SEC-06b the prepared
migration doc correctly covered all three no-FORCE tables from the start. The *correction message*
named only the two that had been live-tested, because the third was out of scope for that particular
finding. Both were accurate. But a correction carries the authority of the thing it corrects while
inheriting none of its scope, and a reader who sees only the message will scope the fix to what the
message named — here, a two-of-three fix landing while the card read done, with the credentials
table left exposed.

> **When you send a correction narrower than the underlying document, say what it does *not* cover.**

Caught here only because the three-vs-two discrepancy was noticed between a card description and a
message. That is luck, not process.

## Related

- Gate item 19 (all four go/no-go gates): *every monitor and automatic guard must be proven able to
  go RED, at the privilege level production actually uses.*
- Cards: `4a21e491` (LumaSeat cap + fail-open), `098a521b` (MK expiry cron), `f0bd4ef6` (QQ SMS
  fallback), `1dbdf27c` (DORA app-runtime role split), `cb7ad0ec` / `8494a668` (MK naparányos).
