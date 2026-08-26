# FRESH_STORE_CONCURRENT_BOOT_SAFETY — closure proof

```text
Phase 0 owner gate, 2026-08-26. Closed under option (B): a proven
infrastructure-level single-writer bootstrap, not a documentation claim.
Author: Marveen
```

---

## 0. What the gate asked

> Zárd az alábbi két mód valamelyikével:
> **A)** concurrent first boot determinisztikusan safe; vagy
> **B)** bizonyított infrastructure-level single-writer bootstrap garantálja, hogy
> concurrent first boot nem lehetséges.
> Dokumentációs állítás önmagában nem proof.

Closed under **(B)**, and §2 explains why (A) is not closable in a way anyone
could check.

---

## 1. The defect, measured before it was fixed

Four processes, one brand-new store, no pre-created schema. Each process calls
`initDatabase(<path>)` and reports success or the error it died on. The harness
is a plain shell loop over N rounds; nothing in it is stubbed.

### 1a. Against the PINNED LIVE RUNTIME (`dist/`, sha `0011de922`, built 2026-08-24)

```text
ROUNDS=15 PROCS=4 OK=47 FAIL=13
  4x  database is locked
  2x  no such table: main.memories
  2x  duplicate column name: allowed_variable_sources
  1x  duplicate column name: triage_receipt_id
  1x  duplicate column name: outbound_count
  1x  duplicate column name: rendered_payload_hash
  1x  duplicate column name: thread_ref
  1x  duplicate column name: revoked_at
```

**Almost one boot in four dies at startup**, before a line of its own work runs.

### 1b. Against `develop` @ `1adf2a23` (W10–W14 merged, W12's two fixes in place)

```text
ROUNDS=12 PROCS=4 OK=47 FAIL=1
  1x  duplicate column name: trace_id
```

W12's WAL retry and `ensureColumns` tolerance removed most of it. **One
remained**, from `src/db.ts:742`:

```ts
if (!toolLogCols.includes('trace_id')) db.exec('ALTER TABLE tool_call_log ADD COLUMN trace_id TEXT')
```

Read `PRAGMA table_info`, then `ALTER` — with no catch, and with another process
free to run between the two.

---

## 2. Why (A) was rejected, in one paragraph

`initDatabase` is ~970 lines of DDL. The failures above are not eight different
bugs; they are one shape — check-then-act between two processes — at eight of
the sites that happen to lose the race on a given night. Patching `trace_id`
would move the next failure to the next unpatched site, and **the absence of a
failure in the following run would not be evidence that none remained.** That is
the trap W12 refused to walk into and named instead. A boot whose safety rests
on "we ran it again and it was green" cannot be handed to an owner as proof.

---

## 3. The mechanism (`src/db-bootstrap-lock.ts`)

The whole bootstrap — connection open, WAL pragma, every `CREATE`/`ALTER`, the
schema gate — runs inside `withBootstrapLock(dbPath, …)`.

* The lock is a **sidecar SQLite database**, `<dbPath>.bootlock`, held under
  `BEGIN IMMEDIATE` for the duration.
* `BEGIN IMMEDIATE` takes SQLite's RESERVED lock at once, and only one
  connection on a database may hold it. The mutual exclusion is therefore an
  **OS file lock**, not a convention, a claim, or a lockfile heuristic.
* Contenders wait on `busy_timeout` (30 s, env-overridable) and then run their
  own bootstrap — which by then finds every table present and does nothing.
* **Fails closed.** If the lock cannot be acquired within the timeout the error
  propagates and the boot dies. A process that could not get the lock must not
  proceed to race; continuing would silently restore the exact defect.

Two deliberate choices, both about failure modes rather than taste:

* **Not a `wx` lockfile.** A lockfile survives a killed process and then needs
  stale-lock heuristics. This lock lives on an open file descriptor, so a crash
  releases it and rolls the transaction back with nothing to clean up.
* **A sidecar, not the store itself.** Holding the store in a transaction for
  the length of the bootstrap would put ~970 DDL statements inside one
  transaction and change the crash semantics of every install. The sidecar
  changes nothing about how the store is written.

`:memory:` skips the lock: it is private to the process, so there is nothing to
serialise.

---

## 4. The proof

### 4a. The race, with the lock

```text
ROUNDS=12 PROCS=4 OK=48 FAIL=0
```

**This alone is not the proof.** Forty-eight green boots could be forty-eight
lucky interleavings, and that is exactly the reasoning §2 rejects.

### 4b. Mutual exclusion, from the lock's own ledger

The lock writes one row per holder **inside the critical section**, carrying the
interval it held the lock for. Six processes, one fresh store:

```text
rows: 6
  pid=3879556 start=…513268 end=…513493 dur=225ms waited=0ms
  pid=3879555 start=…513496 end=…513518 dur=22ms  waited=179ms
  pid=3879591 start=…513524 end=…513538 dur=14ms  waited=180ms
  pid=3879600 start=…513550 end=…513561 dur=11ms  waited=179ms
  pid=3879576 start=…513575 end=…513587 dur=12ms  waited=230ms
  pid=3879567 start=…513632 end=…513645 dur=13ms  waited=331ms

OVERLAPPING INTERVALS: 0
contenders that actually blocked (waited>0): 5
```

Three things are readable here and each is a separate claim:

1. **Six rows for six processes** — nobody bootstrapped outside the lock.
2. **Zero overlapping intervals** — they provably did not run at the same time.
   This is a statement about what the machine did, not about what failed to go
   wrong.
3. **Five of six measurably blocked** — the processes genuinely contended. Zero
   blocked workers would mean they never overlapped, which would make §4a a test
   of nothing. (That is precisely how W12's first race test passed against
   broken code.)

The first holder does the real work (225 ms); the rest find the schema present
and take 11–22 ms.

### 4c. RED capability — the guard driven into the red

`MARVEEN_BOOTSTRAP_LOCK_DISABLED=1` bypasses the lock. Same code, same
processes, same harness:

```text
ROUNDS=12 PROCS=4 OK=46 FAIL=2
  2x  no such table: main.memories
```

The defect returns. So §4a is green **because of the lock** and not for some
other reason.

### 4d. Mutation check on the guard itself

The two positive test cases were re-run with the lock disabled, to confirm they
are load-bearing rather than decoration:

```text
"four processes bootstrap one brand-new store"  → FAIL (locked === true)
"holds the lock mutually exclusively…"          → FAIL (bootstrap_holders absent)
```

Both go red. A test that stays green with the mechanism removed is not evidence
of the mechanism.

---

## 5. The permanent guard

`src/__tests__/db-fresh-boot-single-writer.test.ts`, three cases:

| case | asserts |
|---|---|
| four processes bootstrap one brand-new store | no worker dies; all agree on the table count; all report `locked` |
| holds the lock mutually exclusively | ledger has one row per process, **zero overlapping intervals**, ≥1 contender blocked; sidecar is mode 0600 |
| RED: with the lock disabled, the race breaks again | retries the unlocked race and **fails the test if the defect never reappears** |

```text
✓ src/__tests__/db-fresh-boot-single-writer.test.ts (3 tests) 3033ms
```

The third case matters as much as the first two: it fails if the race ever stops
being able to break the unlocked boot. Without it, a future change that makes
the race weaker would look like a strengthened guard.

---

## 6. What this does not claim

* It does not claim the ~970 lines of DDL are individually concurrency-safe.
  They are not, and §1b names one of the sites. The claim is narrower: **they
  are never executed concurrently**, and that is enforced below the level of the
  code that would otherwise have to be correct.
* It does not change anything for an existing store. An established install
  re-boots without altering anything; this gate was only ever about a fresh one.
* Timing numbers are from this machine on one night. The mutual-exclusion
  assertion does not depend on them — it depends on the intervals not
  overlapping, which is true at any speed.
