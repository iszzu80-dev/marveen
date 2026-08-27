# §19 hardening — the capability dependency contract

Owner GO 2026-08-27, immediately after the P2 cutover: *"Ezt P2 után közvetlen
hardeningként megcsinálhatod. Ne várj külön engedélyre."*

```text
pin            0c86c593cd22a6da9c10568e36b3b0488e74a3b9
release = runtime = feeder sha, gate verified before the restart
CI, both events, same sha: tests/push 33048428199, tests/pull_request 33048443955 (PR #27)
local suite    588 files / 7898 tests / 4 skipped / 0 failures, tsc clean
guardSha256    bb1c086f61cbeffe… — UNCHANGED across three candidates now
```

Two things ship together, and the second is declared rather than folded in.

---

## 1. The contract

**The requirement is declared by the action, not inferred from what is
connected.** Deriving *"this needs Gmail"* from *"a Gmail connector is
registered"* means the requirement disappears when the connector does — so the
action that depended on it becomes an action that depends on nothing, and
proceeds. A declaration has to survive the disappearance of the thing it names.

Four fields, the owner's:

| field | question it answers |
|---|---|
| `requiredCapabilities` | without these the action cannot produce its result |
| `optionalCapabilities` | without these it produces a lesser result |
| `failurePolicy` | what to do when a required one is missing |
| `source` + `reason` | who said so, and why — the audit leg |

`source: UNDECLARED` is **not** the same as "requires nothing". Both carry an
empty list; they get different verdicts, and a test pins that they can never
collapse into each other. Collapsing them is how a forgotten declaration becomes
indistinguishable from a deliberate one.

### Enforcement, in the owner's order

```text
undeclared + HIGH_RISK/MUTATING  ->  DENY, MANUAL_ACTION_REQUIRED   (never silent)
undeclared + READ_ONLY           ->  CONTRACT_GAP, recorded, case NOT stopped
required missing                 ->  typed CAPABILITY wait, NOT a degraded continue
optional missing                 ->  proceed, degradation audited; the
                                     confidence/risk policy owns the blocking
```

The typed capability wait reuses P2 rather than being a second mechanism, so it
inherits the stale safety and the idempotent wake. Its recheck condition is a
**probe** — a third evaluator branch beside the clock and the event — and the row
carries all four of the owner's facts: which capability, which action it blocks,
what would end the wait, when it is next reviewed.

### Declared at the choke point

The contract is attached where `buildRollingPlan` returns, not at the twenty-five
`plan.push` sites. A per-site list is a list someone extends without it, and the
forgotten step would carry no contract while looking exactly like one that needs
nothing.

### Enforcement is gated on a measurement it READS

```text
GATHER_INFO     READ_ONLY  1/1        overall  7/7
AWAIT_EXTERNAL  READ_ONLY  1/1        risky    3/3
AWAIT_DECISION  READ_ONLY  1/1        enforcementReady: true
VERIFY          READ_ONLY  1/1
RECOVER         MUTATING   1/1
EXECUTE         HIGH_RISK  1/1
COMMUNICATE     HIGH_RISK  1/1
```

If a high-risk kind ever lands undeclared, enforcement switches **off** and the
run says so. A partly-applied gate is the worst of the three states, because it
looks on.

### The mutation that survived

Six mutations, five dead immediately. The sixth — `enforcementReady: true`
hardwired — left the entire suite green. That is the branch deciding whether
enforcement runs at all, in a module whose whole argument is that a gate must be
able to refuse.

The cause was a test shape, not an oversight about the rule: the incomplete case
was checked against a **hand-built object standing next to** the real function
instead of against it. `summariseCoverage` is now pure and takes its rows, so an
incomplete surface goes through the real gate. The same mutation now kills two
tests.

### Live proof, and what it is proof OF

Post-cutover runs carry no capability assertion — every declared dependency is
available, which is the correct and boring answer. **An absence is weak evidence,
so the instrument was named and driven** on the live store through the deployed
build, read-only:

```text
undeclared HIGH_RISK                           -> DENY_UNDECLARED
undeclared MUTATING                            -> DENY_UNDECLARED
undeclared READ_ONLY                           -> CONTRACT_GAP
required capability that does not exist        -> WAIT_CAPABILITY  [retryable=true]
required capability with a typo                -> WAIT_CAPABILITY  [retryable=false]
what an AWAIT_EXTERNAL step actually declares  -> PROCEED
what a COMMUNICATE step actually declares      -> PROCEED
```

A typo in a requirement list is `retryable=false`: waiting will not teach the
system a name it does not have, so that one needs a person and says so.

### The migration, on the live store

`CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so widening the
`kind` CHECK needed a rebuild. Tested by **downgrading** a store to the old
constraint, proving the downgrade actually bites, then booting. Measured on
production after the cutover:

```text
live CHECK carries CAPABILITY: true
wait rows preserved: 4     indexes: 2     triggers: 2     leftover tables: 0
```

---

## 2. The third door, closed

Three hours before this release, the P2 acceptance produced:

```json
"progression": { "cycleErrors": 1, "errors": ["…: database is locked"] },
"problems": []
```

The contention was a test artefact; the blindness was not. The detector read
`failed: true` and a `failures` array. `errors` and `cycleErrors` are different
words for the same thing and it knew neither.

Third occasion, same room — 2026-08-11 the unread `failures`, 2026-08-26 the
unparseable payload, now the unread `errors`. So the rule is stated once and
applied to every shape rather than patched onto whichever failed last: **a step
that says something went wrong must not read as clean, whatever word it uses.**

A count with no detail is still a failure: `cycleErrors: 3` with an empty array
is a step that failed three times and cannot say how, which is the shape a
truncated payload takes. It is reported — and not reported twice when a list
already spoke, because duplicates teach the reader to skim.

**Before and after, on the live runner, same contention deliberately reproduced:**

```text
08:25 (before)  cycleErrors 1, errors[1]  ->  problems: []                    exit 0
09:22 (after)   cycleErrors 1, errors[1]  ->  problems: ["progression: 1 failed: …"]  exit 1
```

Extracted to `src/cos/cycle-problems.ts` for the reason that keeps recurring:
the rule lived in an entry point that spawns thirteen processes on import, so
the test that covered it re-implemented it locally — a second definition of the
thing under test. That test now calls the real detector.

---

## 3. What is still not true

**The negative legs are proven by tests and by the probe above, not by a real
outage.** No connector is actually down in production, and taking one down to
produce a prettier document would be a self-inflicted outage.

**`EXECUTE` and `COMMUNICATE` declare only `RUN_LEDGER` today.** The specific
channel capability (`CONNECTOR_WRITE:<id>`) belongs to the executing path, which
has its own pre-flight, and is not yet folded into the step-level contract. The
step-level declaration is a floor, not the complete dependency list of the
operation — the comment on `declareForPlanStep` says so rather than letting the
coverage number imply otherwise.

**Coverage is measured over the KINDS the planner can emit, not over live rows.**
A count of cases would move with the board and would report 100% on a quiet day.
