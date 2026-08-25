# W11 — Done report

```text
PACKET: MIP-v1.0 / §5 / W11_DURABLE_SCHEMA_MIGRATION
Status: VERIFIED_DONE
Date:   2026-08-25
```

---

## The one idea

A migration ledger of *successes* cannot tell **"never ran"** from **"started and
died"**, because both leave no row. Every other gap in this packet is a variation
on that: a store with no version cannot tell "written by older code" from
"written by newer code"; a `catch { /* exists */ }` cannot tell "already applied"
from "failed"; a migration with no `verify()` cannot tell "it worked" from "it
returned".

So the packet adds the things that make those pairs distinguishable, and nothing
else.

---

## What was reused, not rebuilt

`runOnce()` (marker written inside the body's transaction), `ensureColumns()`
(idempotent by *looking*), `widenCheckConstraint()` (row-count check plus a
foreign-key **delta** against a baseline, because this store already carries 20
pre-existing violations), and the encrypted backup with its restore exercise.
Details and evidence in `W11_SCHEMA_MIGRATION_AUDIT.md` §1.

---

## What landed

**`src/schema/store-schema.ts`** — the §5.5 source of truth: `STORE_SCHEMA_VERSION`,
the single-row `store_schema_state` (a `CHECK (id = 1)`, because a version table
with two rows is one nobody can trust and the failure is silent), the migration
ledger table, the gate, and the read-only latch.

**`src/schema/migration-runner.ts`** — three things `runOnce` structurally cannot do:

1. **Partial failure is detectable.** An in-flight marker is written *before* the
   body and cleared after. A transactional failure rolls back and clears it; a
   **non-transactional** failure keeps it, because there the store really may be
   half-migrated. The gate then refuses writes until a human repairs it.
2. **Verification is mandatory.** A migration with no `verify()` is refused
   *before it runs* — the failure lands on the author at development time instead
   of on the data at 3am. `verify()` returns a **string**, not a boolean: a
   boolean records that something was checked, a string records *what*, and the
   ledger keeps it.
3. **Pre-migration compatibility check and a backup before anything destructive.**
   A destructive migration with no backup path is refused; a *failed* backup
   refuses it too, rather than proceeding.

**Wired into `initDatabase`**, last, after every `CREATE TABLE`: adopt → check →
latch.

### Two decisions worth arguing with

**Read-only, not a crash.** Refusing to boot is also fail-closed, and it is the
wrong trade: a dashboard that will not start takes the owner's entire case board
away to protect it from a write nobody was making. Read-only keeps every read
working and refuses exactly the operations that could corrupt a schema this build
does not understand.

**An unversioned store is ADOPTED, not rejected.** Every database written before
this file reads as version 0 — which is every existing installation. Failing
closed on that would have been a fail-closed gate that takes the system down on
first contact with reality. Adoption stamps the current version, because the
tables were created by this same code: there is no migration to run, only a fact
to record.

---

## Proof

**Tests: 23, covering all eight §5.6 scenarios** — empty state, n-1 → n, retry,
interruption, duplicate execution, malformed legacy state, newer-than-supported
schema, and the repair path. Every denial test asserts on observable state (was
the column added, is the store latched), not only on the runner's return value: a
runner that lied about what it did would pass the weaker kind of test.

**Staging proof (§5.7 criterion 5).** `scripts/w11-staging-migration-proof.ts`
takes a copy of the live store with SQLite's own `backup()` (so a concurrent
writer cannot produce a torn file) and runs the real thing against it:

```json
{ "tables": 128, "totalRows": 277136, "integrity": "ok",
  "gate": { "verdict": "OK", "version": 1, "readOnly": false },
  "firstRun":  [{ "result": "APPLIED", "verification": "store_schema_state.w11_probe present on the real schema" }],
  "secondRun": [{ "result": "SKIPPED", "reason": "already in the ledger as APPLIED" }],
  "futureGate": { "verdict": "FUTURE_UNSUPPORTED", "readOnly": true },
  "problems": [] }
```

There is no staging environment, so "staging" is defined as a copy of the live
store — the most faithful staging available for a schema change, because it has
the real tables, the real row counts and the real accumulated oddities. A
hand-built fixture would prove the migration works on a database nobody has.

**Mutation proof — nine mutations, all RED, all reverted:**

| Mutation | Result |
|---|---|
| future-version check disabled | 1 RED |
| in-flight marker never set | 3 RED |
| `verify()` requirement removed | 2 RED |
| a FAILED ledger row counts as applied | 1 RED |
| destructive migration proceeds with no backup | 3 RED |
| `ensureColumnStrict` swallows a missing table | 1 RED |
| store version allowed to move backward | 1 RED |
| read-only latch made a no-op | 1 RED |
| partial-migration verdict removed from the gate | 1 RED |

### A false green I caught in my own evidence

The last mutation first came back **GREEN**, and I nearly recorded that as
"the gate's partial-migration branch is not covered". It was not a gap in the
tests — the mutation had never applied: I matched on four spaces of indentation
where the file has two, so the edit was a no-op and the "result" measured
nothing. Re-run with an assertion that the file actually changed, it goes RED
like the rest.

A mutation battery that does not verify the mutation landed is a battery that
can only produce good news. Every mutation above was re-checked for a non-zero
diff.

---

## No regression (criterion 7), measured

Full suite: **563 files, 7572 passed, 4 skipped, 2 failed.**

The two failures are `memory-performance.test.ts` — the known pre-existing pair
(a live Ollama plus a hardcoded 100 ms per row against a 5 s vitest timeout, so
they fail under load). Run in isolation they pass 11/11, both with W11 and with
W11 stashed.

I did not leave it at "known flaky", because W11 touches `db.ts` and a slower
`initDatabase` would be a real cause with an innocent-looking symptom. Measured
directly: the gate costs **0.0935 ms** per init (200 iterations). The 2.4 s
difference between two runs of that file is Ollama latency, not the gate.

---

## Against §5.7

| # | Criterion | Verdict |
|---|---|---|
| 1 | All durable core state versioned | **MET** — store-level version + registry; entity-level where a row needs its own migration state (scope decision stated in the audit §4) |
| 2 | Migration runner idempotent | **MET** — proven on the real 277k-row store, not only in memory |
| 3 | Partial failure detectable | **MET** — in-flight marker; 3 mutations RED |
| 4 | Unsupported future schema fail-closed / read-only | **MET** — gate + latch, proven on the real schema |
| 5 | Migration proof on staging | **MET** — copy of the live store, exit 0 |
| 6 | Restore or forward-repair documented and tested | **MET** — `clearInFlightAfterRepair` is explicit and human-driven, never automatic, and the ledger keeps the repair note; the encrypted backup+restore exercise it builds on is already live |
| 7 | No W11-caused regression | **MET, measured** |

---

## Named limitation, carried forward

`db.ts` still has 21 `try { ALTER TABLE ... } catch { /* exists */ }` sites. The
catch swallows every error, so a real failure is indistinguishable from "already
applied". `ensureColumnStrict()` is the replacement and migrating those call
sites is a separate job with its own proof — doing it inside this packet would be
the big-bang §5.4 warns against. Named here so it is a work item and not an
invisible weakness.
