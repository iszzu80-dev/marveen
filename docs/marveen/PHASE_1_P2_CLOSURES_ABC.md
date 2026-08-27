# P2 closures A, B, C

Owner's review 2026-08-27: capability hardening **PARTIAL**, three closure items.
This is what each one turned out to be, including the three places I was wrong.

```text
candidate      8e52d6d2 (develop)
local proof    589 files / 7925 tests / 4 skipped / 0 failures, tsc clean
released       NOT YET -- gated on the GitHub Actions budget raise
```

---

## A. `enforcementReady=false` must never mean fail-open

**He was right about a defect I had also argued for.** The first implementation
skipped `enforceCapabilityContract` entirely when coverage was incomplete, and I
defended it in a code comment: *"a partly-enforced gate is the worst of the three
states: it looks on."*

That reasoning inverts the rule it claims to serve. Adding ONE undeclared
high-risk kind makes coverage incomplete, which under that code turned the DENY
off for **every** action — including the new undeclared one. A rollout gate that
fails OPEN is not a rollout gate; it is a switch an attacker or an absent-minded
author can flip by *adding* work.

**Now:** per-action enforcement runs unconditionally. Incomplete coverage is a
readiness/health/release fact and nothing else:

```text
operationalHealth().capabilityCoverage -> { riskyDeclared, riskyTotal,
                                            undeclaredRisky: [names],
                                            status: PASS | DEGRADED | FAIL }
operationalHealth().clean               -> consults it
```

`undeclaredRisky` names the kinds rather than counting them, because "2/3" tells
nobody which one to go and declare.

**His negative test, and its third leg.** A new undeclared high-risk kind makes
neither itself nor any other high-risk action executable — and a *declared,
satisfiable* action still proceeds. Without that third assertion the test would
also pass on a gate that had simply become "refuse everything", which is a
different failure wearing the same green.

There is also a structural check: `enforceCapabilityContract` never receives the
coverage, so it *cannot* consult it. A verdict-only test could be defeated by
re-introducing the coupling one level up; a standing check pins the call site.

---

## B. The concrete execution dependency

`RUN_LEDGER` is a floor — what *recording* an action needs — and the owner's
objection was that a floor is not a dependency list.

`src/cos/capability-resolution.ts` maps a planned action to what *performing* it
needs, deterministically and read-only, and the chain lands on the run:

```text
planned action -> resolved target -> required capability -> preflight verdict
```

carried in its own `capabilityTrail` field, present on **every** successful run
including the ones that proceeded.

Executor policy is not duplicated: the dispatch gate, the quota, the sensitivity
profile and the approval all still run, unchanged. What changes is that the
answer to *"what will this need"* exists before the executor opens.

### Two defects of mine, both caught by tests that already existed

**1. I treated every `EXECUTE` as external.** A case with no outbound history
resolved `UNRESOLVED` → `DENY_UNDECLARED`, which would have denied ordinary local
progression on **every case in the store**. Six existing tests went red, and they
were right: most `EXECUTE` steps here are local or shadow work that never opens a
channel. Refusing them would have been the loudest possible way to be safe about
nothing.

What makes an `EXECUTE` external is a **pending outbound row** — evidence, not a
property of the kind. `PLANNED` or `FAILED_RETRYABLE`; a `VERIFIED` row has
already gone and the next step is not driving it.

**2. I pushed the audit trail into `safetyViolations`,** so every healthy run
looked like a violated one. A safety violation means an assertion **broke**; a
trail means a check **ran**. Same signal-destroying move this whole packet keeps
finding elsewhere, committed by me while writing the fix for it.

### The five proofs

| leg | shape |
|---|---|
| `COMMUNICATE` | → `CONNECTOR_WRITE:gmail` / `:gmail-zst`, by namespace |
| `EXECUTE` | → the pending outbound row's tool, or `NOT_REQUIRED` when none |
| missing capability | → typed `WAIT_CAPABILITY`, floor preserved alongside |
| unresolved high-risk | → `DENY_UNDECLARED` (pending `SMS_SEND`, unknown here) |
| optional missing | → `PROCEED` with an audited degradation |

Plus the one the two capability names exist for: a `READ_ONLY` connector fails a
`CONNECTOR_WRITE` requirement, `retryable=false`, because that is an owner
decision and not something waiting can fix.

---

## C. Wake throughput — and the premise I got wrong

**The premise was mine, and it was false.** I told him the poller takes *one case
per cycle* and called a 64-case queue a ten-hour drain. `runProgressionHeartbeat`
takes **fifty per domain**. I read `limit: 1` out of the progression block of the
cycle report and attributed it to the sweep; it belongs to **GoalEnrichment**,
whose canary throttle lands in the same merged payload — the exact collision this
runner's history is built around, walked into while documenting it.

**The starvation is real and comes from the ORDERING.** The due page sorts
`next_progression_at ASC`, and *arming* a wait pushes that value FORWARD. So a
wait that has just been satisfied sorts to the BACK of the queue it most needs
the front of. Measured live before the fix:

```text
personal  49 due, oldest 561s      both active typed waits:
zst       50 due, oldest 561s      49 cases sorting AHEAD of each
```

The manual `next_progression_at = 1` nudge I needed at 09:22 to get an EXPIRED
condition looked at is the same finding from the other side.

**Why this mattered:** a bigger limit would not have helped. The wrong diagnosis
pointed at the wrong fix.

### Bounded priority

Three bands, each with a share of the page, leftovers cascading downward so an
empty band cannot idle the page:

```text
WOKEN     0.50   a typed wait evaluating SATISFIED or EXPIRED right now
DEADLINE  0.25   due_at or follow_up_at has passed
NORMAL    0.25   ordinary due progression
```

`WOKEN` is computed by **asking the evaluator**, not by reading a flag: a cached
boolean would be a fourth place for the wake to be true, and this codebase has
paid for those.

**The band travels with the case.** The first version relabelled woken cases as
`NORMAL` in the spare-capacity pass, which made two things false at once — the
audit field said a freshly woken case ran as ordinary work, and `starvedWoken`
counted it as left behind when it had been selected. A test caught it (35 vs 30)
and the *number* was right; the labelling was wrong.

### Six metrics, taken at selection time

`backlog`, `oldestDueAgeSec`, `selected` per band, `due` per band,
`starvedWoken`, `wakeLatencySec` — per domain, surfaced in the cycle report.

At **selection** time deliberately: a metric gathered after the loop cannot see
what the page did not choose, and what it did not choose is the whole question.

### The test, and its control

64 older due cases plus one freshly satisfied wait; the woken case is selected
and lands inside the first band's share. The control asserts that
`next_progression_at ASC` **alone** leaves it out of the first fifty — without
that, the test could pass on a board where the woken case happened to be old
enough anyway, and would prove nothing about bands.

Also pinned: fairness (a flood of 100 woken cases does not shut the ordinary
queue out), no duplicate selection, and a quiet board behaving exactly as it did
before the bands existed.

---

## What is still not proven

Everything above is **local**. The live proof — A, B and C measured on the real
store through the pinned release — comes after the cutover, which is gated on the
GitHub Actions budget. Until then P2 is not VERIFIED_DONE, and saying otherwise
would be the kind of claim this document spends three sections correcting.
