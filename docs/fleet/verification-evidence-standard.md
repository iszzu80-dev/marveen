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

- **DORA (as of the night of 2026-07-18).** architect verified the new RESTRICTIVE policies live, as
  a non-owner role. That is the *correct default* for RLS testing almost everywhere. It was wrong
  **at that moment** only because `dora-app`'s pool was then connecting **as the table owner**, so
  owner-bypass could not manifest in the test.

  **And that mapping has since changed.** The role split shipped: `pg_stat_activity` now shows only
  `dora_app_runtime` (non-owner) with zero owner connections, so the correct harness role for DORA is
  now the *non-owner*, the opposite of what it was hours earlier.

  > **The per-product role mapping is a moving target, so do not hardcode it — including in this
  > document.** Any table of "product → role" goes stale the moment an infrastructure change lands,
  > and a stale mapping in a rule about stale evidence is the joke writing itself. The durable form
  > is a harness that **asserts the role it is actually connected as** and fails if it is not the one
  > production uses (qa's `assertRlsCapableRole()`), which stays correct across the change instead of
  > needing to be updated after it.
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

### A correct-but-incomplete finding is more dangerous than a wrong one

Every other case in this document is evidence that cannot distinguish working from broken. This one
is different, and it is worse in a specific way.

On 2026-07-18 we traced the MK naparányos rule to a primary source, correctly: NAV prorates a
partial month as `minimálbér/30*days` where our engine used whole months. Real finding, real source,
right reading. An independent adversarial re-extraction then reported that the rule is
**event-dependent** — day-prorated for start/end of activity, *not* prorated for a partial-month
suspension, zero for a full-month suspension — and that a separate cumulative-base layer correctly
uses whole months and must not be "fixed" at all.

If that holds, the uniform fix we were about to build would have **introduced a new bug while fixing
the old one**, in the part of the rule nobody had checked.

> A verified partial rule carries **earned confidence into the unchecked remainder**. That is what
> makes it more dangerous than an unverified one — nobody re-opens a finding that was already traced
> to a primary source.

**How to apply:** when a rule is confirmed against a source, state explicitly which *cases* the
source covered. "NAV prorates partial months" and "NAV prorates partial months *in the worked
example we read, which was a start-of-activity case*" are different claims, and only the second is
what the evidence supports. Ask what other event types the same rule might treat differently before
implementing it uniformly.

### The state that emits nothing: an agent waiting at an interactive prompt

On 2026-07-18 an agent looked stalled for six hours. It was not idle and not context-saturated — it
was **blocked on an interactive plan-approval prompt** (*"Ready to code? 1. Yes… 2. Yes… 3. Tell
Claude what to change"*). In that state it looks running, consumes nothing, processes no bus
messages, and emits nothing. Two dispatched messages sat undelivered for 56 and 147 minutes.

This is the one stall type invisible to every activity-based signal — last bus message, last commit,
last card comment — because the agent is **neither working nor failing: it is waiting**, and waiting
produces no events at all.

> Fingerprint: prolonged silence **plus** undelivered inbound messages. Detection is cheap —
> `capture-pane` and look for a numbered menu.

The general form, and it is the same disease as the rest of this document one layer up: *"the agent
is running"* is not distinguishable from *"the agent is working"* by any signal we were collecting.
A liveness check that cannot tell those apart is measuring the wrong thing.

### A display limit is not a filter — never `head` a search meant to prove a negative

On 2026-07-18 marveen grepped for `claimPlatformInvite` call sites and piped through `head -8`. The
eight lines shown were invite-auth, mk-registration-routes and eskuvo-auth. **QQ and Zsibongő were on
lines nine and ten.** The truncated list was read as a complete one, absence was concluded from it,
and three products were reported to the owner as missing a launch-criteria item — putting two of
them on his critical path for work that was already the reference implementation.

The search was correct. The command was correct. The *reading* treated a presentation choice as a
result.

> **Rules:** count before you list (`| wc -l` first). Never truncate a search whose purpose is to
> prove something is absent. And report **where you looked**, not that the thing does not exist —
> "no hits in `apps/api/src`" is checkable; "it isn't wired anywhere" is a claim about the world
> drawn from a window onto it.

Same family as *"confirmed in code" is not confirmation of runtime state* and *a board search that
excludes archived cards*: in all three, a **bounded view** was mistaken for the **whole domain**.
Absence is the hardest claim to make correctly, because every tool that answers it answers within a
scope, and the scope is the part that does not appear in the output.

### When you claim you changed an artefact, name the PATH

**This standard exists twice.** `~/.claude/skills/verification-evidence-standard/SKILL.md` (213
lines) and `docs/fleet/verification-evidence-standard.md` (420 lines) are both "the standard". They
are not copies of each other and an edit to one is invisible in the other.

**The case (marveen + deliverylead, 2026-07-18, ninth and tenth of the night, one message apart):**
marveen reported "I have added it to the standard". deliverylead grepped
`docs/fleet/verification-evidence-standard.md`, found nothing, and replied that the edit had not
landed — with some force. The edit *had* landed, at line 102 of the **skill** file. The grep was
correct; the conclusion was false; the scope was one of two artefacts sharing a name.

Both halves are instructive. **An ambiguous reference is an unfalsifiable claim** — "the standard"
cannot be checked because there is no single such thing, so the reader resolves the ambiguity
reasonably and gets a false negative. And the reader, holding a bounded view, read absence *there*
as absence *everywhere*.

> Naming the path is the cheapest possible way to make a claim checkable. Not "the standard", not
> "the doc", not "the config" — the path, and the line if you have it. Both of these errors
> dissolve if either party had done it. Corollary for the reader: before concluding an edit is
> missing, ask whether more than one artefact answers to the name you were given.

### A guard that lives in a migration only guards the migration path

DORA migration `0034` carries a runtime invariant that RAISES if FORCE RLS is ever re-applied to the
three pre-auth tables. It did not fire when exactly that happened on 2026-07-18, because the
statements were run **by hand against the live database** rather than through the migration runner —
and `0034` does not re-run once applied.

The same three tables had already been broken this way once before (card `7419ae2a`). A deliberately
invariant-protected design was undone **twice**, by the same mechanism, past a guard written
specifically to prevent it.

> **An invariant enforced only at migration time is not an invariant — it is a convention with good
> manners.** Out-of-band DDL walks past it silently, and the silence is total: no error, no log, no
> failed deploy, until something downstream returns zero rows.

Ask of any schema-level guard: *what happens if someone runs the DDL by hand?* If the answer is
"nothing", the guard covers the path least likely to be the one that hurts you.

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

## Companion rule: a test can only falsify along dimensions its fixture actually varies

Two of us reached this independently on 2026-07-18, at different levels of the same suite, which is
why it is a rule here rather than advice.

An isolation assertion compares what role A can see against what role B put there. If the fixture
contains **one** of something, every assertion about isolation *between two of them* passes
vacuously — the scenario the policy guards against could not be constructed, so the guard was never
asked the question. The suite is green, honest, and silent about the thing you care about.

**Row level (qa, DORA `0ff09ce1`).** A first pass came back 20/20. Three of those greens asserted
that `evidence` / `system_scopes` / `assessments` "stay isolated even under owner" — on tables
holding **zero rows**, because the control seeding sat in a silent `.catch()`. Nothing to leak, so
the assertion passed for the wrong reason. The follow-up error is worth as much: the first attempt
to *confirm* the fix counted rows as the owner with no GUC set — filtered by the very mechanism
under test — and reported 0 for tables that were correctly populated. **A false green and a false
red about the same tables inside one hour**, neither caught by the suite's colour.

**Dimension level (deliverylead, same suite).** The re-run passed 28/28 as a genuine non-owner role
— and still proved nothing about the boundary the card existed for. `mk()` created exactly **one
workspace per tenant**; A and B were two *tenants*; `app.workspace_id` was only ever set to each
tenant's own workspace. The RESTRICTIVE `workspace_id` policies on `assurance_packs` /
`assurance_request_inbox` were never exercised. Cross-tenant green does **not** transfer to
cross-workspace: different boundary, no inheritance.

Note the escalation. The row-level form leaves an empty table you can notice. The dimension-level
form leaves a fully populated, correct-looking, large green suite that simply never varies the
column — and a row-count integrity gate does **not** catch it, because "a row for both tenants in
every table" says nothing about whether two workspaces exist under one tenant.

> Ask of any isolation proof: **not "did it pass" but "what does the fixture contain TWO of?"**
> For every column a policy actually filters on, require two distinct values *under the same
> parent* before any isolation claim is made — not merely non-empty tables. Derive the required
> dimensions from the **policy**, not from the fixture, and fail closed when a policy grows a
> dimension the fixture lacks.

The cheap version, which cost one `grep`: **search the results write-up for the dimension's name.**
`RESULTS-0ff09ce1-runtime-role.md` contained zero occurrences of the string `workspace`. A green
suite whose report never mentions the dimension has not tested it.

#### Operational form: derive the fixture's required dimensions from the live policy

The rule above says *what* to require. This is *how*, because "remember to vary the right columns"
is advice, and advice does not survive the next harness written by someone in a hurry.

**A fixture cannot know what it is missing.** That is the whole problem, and it is not fixable by
building a better fixture — a bigger fixture only covers the dimensions its author happened to
think of, and stays green when the policy later grows one they did not. Adding a second workspace
fixes today's gap and leaves tomorrow's.

**Invert the direction.** Read the dimensions out of the live policy at test time, then require the
fixture to satisfy them:

1. Query `pg_policy` for every table under test and pull each policy's expression
   (`pg_get_expr(polqual, polrelid)`).
2. Intersect it with the table's real column list to get the columns the policy actually filters on.
3. Require **two distinct candidate values, each with a row behind it**, for every such column
   except the one deliberately held constant — and state that exception in the harness, so holding
   it constant is a declared choice rather than an omission.
4. If a policy filters on a column the harness supplies no values for, **fail with an actionable
   message** naming the column. Not a warning: a failure.

The test then fails when the policy outgrows it, instead of quietly passing. Note this also
produces the schema-scope check above for free: `dora_users` comes back `tenant_id`-only from its
own policy, so "not workspace-testable" is *derived* rather than remembered, and the category error
becomes structurally unavailable.

**Prove it goes RED, the same as any other guard.** Temporarily arm an extra filtered column onto a
policy (`ALTER POLICY ... USING (existing AND some_col = 1)`), re-run, confirm the fixture gate
fails and names `some_col`, then restore. A dimension gate nobody has watched fail is exactly the
kind of guard this document exists to distrust.

> **Known limit, so it is not inherited as complete:** matching `<column> =` against the policy
> expression is textual. A function call, a subquery, an `IN`-list, or any non-equality predicate
> can be missed. Strictly better than a hardcoded fixture, strictly worse than a real expression
> parse. Revisit when policies get more complex than equality.

Reference implementation: `agents/qa/deliverables/dora-rls-breakout-test/ws-runtime-role-breakout.mjs`,
Phase 0 — including the armed-RED run described above.

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

### Stale versus inverted — triage inverted first

Wording below is qa's, from the DORA run on 2026-07-19; marveen proposed the split.

The class underneath both: **authoritative-looking summary surfaces that nobody updates when the
state beneath them moves, load-bearing precisely because they read as settled.** That covers code
comments, card descriptions, README claims and acceptance texts in one sentence.

> **Stale vs inverted.** A stale surface has fallen behind; the cost is a wasted check. An
> INVERTED surface states a rationale that has become backwards, and it misleads precisely in
> the decision it exists to inform. Triage inverted ahead of stale.

**Worked example (DORA, 2026-07-19).** `backends.ts:11-18` explained the runtime role as existing
*"so FORCE RLS actually applies"*. After migration `0038` removed FORCE from those three tables, the
role matters **because FORCE is gone** — it is the only isolation left. Someone assessing whether
the `?? DATABASE_URL` fallback is safe reads that comment and concludes the opposite of the truth.
The same evening's Twilio comment above was merely stale; **this one is a trap.**

A second inversion sat in the same sentence, found while carding the first: it asserts *"this is the
connection almost every route in this codebase actually uses"* — which is exactly the claim the
night's testing explicitly left open (DB-level only, HTTP layer never touched). A surface can state
as settled fact the very thing the evidence declined to establish.

**How to find them:** when a mechanism is **removed or replaced**, grep the comments that explain
**why** the surrounding thing exists. Those are the ones that invert rather than merely age. A
comment describing *what* code does ages gracefully; a comment describing *why it is safe* becomes
a lie the moment the reason changes.

**The card-description half showed up the same night.** `65f8ef47`'s description said the card was
plan-only and awaiting an owner GO; the comment trail showed the pilot had been approved and the
work shipped. A reader trusting the description reported it as parked. Card descriptions are summary
surfaces too, and unlike comments they are the *first* thing read — so when a card moves, the
description is the part to fix, not just the trail beneath it.

### A board search that excludes archived cards is biased against settled decisions

676 of 1361 cards on this board are archived, and the API's default query returns only the 685
active ones. **The better-settled a decision is, the more likely its card is archived** — so
"was this already decided?" is precisely the question the default query is worst at answering.

Two spurious escalations in one evening came from this, including a duplicate istvan-döntés card
asking Istvan to buy something he had already bought, wired and verified.

> When checking whether something is already decided, **query the database, not the API** —
> `store/claudeclaw.db`, `kanban_cards`, without filtering `archived_at`.

### `origin/main` cannot tell you whether feature-branch work is pushed

At 23:39:45 on 2026-07-18, `frontendfejleszto` pushed `a43a5d9` (6 files, the Venue Pro contract
corrections) to `feat/venue-pro-frontend-352923b6-cddd2a4e`. Three minutes later, at 23:42, I sent
`marveen` a time-sensitive **DO NOT RESTART** hold, stating the work was sitting uncommitted and
would be lost — because I had checked `origin/main`, where the latest `apps/web/src/api.ts` commit
was still `9a871b1`. Every fact in my message was accurately read. The work had been safe on
`origin` for three minutes before I claimed it was at risk, and `origin/main` could never have
shown otherwise regardless of when I looked.

**Absence on one ref is not absence.** `git log origin/main` answers "is this merged", never "is
this pushed". Same family as the truncated grep and the archived-cards default: the query was
correct, the **scope** of the query was wrong, and the scope is the part that does not appear in
the output.

> To check whether work is pushed at all, search **every** ref:
> `git branch -r --contains <sha>`, or `git log --all --oneline -- <path>`. Ask the agent which
> branch they are on before concluding anything from a ref you picked yourself.

The cost here was a false alarm that would have **blocked a safe and desirable restart** of an
agent at 91 percent context — a hold is an action, and a hold placed on bad evidence does damage
in the opposite direction from the one you were worried about.

### Urgency needs a HIGHER evidence bar, because a false alarm is not neutral

The generalisation of the case above, and it runs against the instinct urgency creates.

A quiet wrong claim wastes a check. An **urgent** wrong claim spends someone else's attention and
can **veto the correct action**. Those are different cost structures, not different sizes of the
same one. The `origin/main` hold would not merely have failed to protect anything — it was
load-bearing *in the harmful direction*: urgency formatting made it hard to set aside, and the
action it blocked (restarting an agent at 91 percent on a time-sensitive channel) was the right
one.

So the bar moves the opposite way from how it usually moves. Time pressure normally *lowers* the
evidence bar — act now, confirm later. Here it must raise it:

> **Before marking something urgent, check it harder than you would otherwise.** The cost of a
> false urgent is paid by someone else, and it can block the right move. Ask specifically: *what
> action does this alarm cause or prevent, and what happens if I am wrong?* If being wrong is
> merely embarrassing, send it. If being wrong vetoes something safe, verify again first.

Two shapes this takes in practice, both observed on 2026-07-18:

- **Wrong scope, urgent framing** — the `origin/main` hold. The query was correct, the scope was
  wrong, and the urgency carried the error past the point where anyone would re-check it.
- **Wrong trigger, urgent framing** — a tax cross-check marked time-sensitive because something had
  shipped nearby, when the shipped thing was a *safe block*. Recency of a deploy is not evidence
  that current behaviour is wrong. See *Urgency triage* in the companion skill: decide urgency by
  what the CURRENT behaviour does on each branch, never by what shipped recently.

Note that the three-and-a-half-minute margin in the case above is **not** the point. The alarm was
never about a real window — `origin/main` could not have answered the question at any moment,
before or after the push. The timing only makes the structural error undeniable.

## Companion rule: when blocked on an answer, find the action that is safe under ALL answers

The constructive twin of the urgency-triage rule above. That one asks *what does the system do under
every branch of the dispute* in order to avoid a false alarm. This one asks the same question in
order to **convert a wait into a ship**.

**The move:** when work is blocked pending a ruling — legal, architectural, product — do not estimate
which answer is likeliest and build for it. Enumerate the possible answers and look for an action
that is correct under **every** one. It is available more often than it feels, and it is usually a
*refusal* rather than a computation.

**Worked example (MK, 2026-07-19).** The naparányos engine was blocked on an unresolved question
about a tax grandfather clause. The instinct was to wait for the lawyer. But the live risk was never
the missing branch — it was that the *implemented* branches would silently overreach into its
territory and hand an affected user a confidently wrong number, with no signal that anything was
uncertain. So: detect the case, refuse to answer, attach **no number**. Correct whichever way the
ruling lands, and it shipped without the ruling.

Note what makes it work: the blocked question was *which computation is right*, and the safe-under-all
action was *decline to compute, visibly*. An explicit `UNKNOWN` is almost always available, and it
beats both waiting and guessing.

> Before escalating a blocker, ask: **is there an action that is correct under every possible
> resolution?** If it exists, take it now and let the ruling arrive on its own schedule. Reserve
> escalation for blockers where every available action is wrong under some answer.

**Two guards this move needs, or it degrades into the thing it replaced:**

1. **Keep the refusal a refusal.** State on the card that the branch is a *gate that declines to
   answer*, not a partial implementation — and state it in the **description**, not a comment. Without
   that line the card grows into the implementation while the basis is still provisional, and you have
   built the thing you could not justify.
2. **Detect broadly, not tidily.** Where the trigger predicate is itself unsettled, detect across
   *every* candidate formulation rather than picking the clearest one. Over-refusing sends a few extra
   users to a human; under-refusing produces the wrong answer you were trying to avoid.

---

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
