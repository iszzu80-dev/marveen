# W11 — Durable Schema, Versioning & Migration: repo audit

```text
PACKET: MIP-v1.0 / §5 / W11_DURABLE_SCHEMA_MIGRATION
Audit date: 2026-08-25
Method: measured against the LIVE store, not read off the code
```

Istvan's instruction was explicit: *"Repo auditból indulj, tehát ami már valóban
létezik, azt bizonyítsd és reuse-old; ne építsd újra."* So this document leads
with what already exists and works.

---

## 1. What already exists, and is good

**`src/cos/schema.ts` — `runOnce(db, migrationId, body)`.** A migration ledger
(`cos_schema_migrations`) whose marker is written **in the same transaction as
the body**, so a crash cannot leave a migration applied-but-unmarked. Its header
records why it exists: a one-time `UPDATE ... SET scope='MIGRATED_UNVERIFIED'`
had been written in the shape of a recurring one, and was silently demoting cases
Istvan had personally reviewed, on every restart. That is the correct instinct
and this packet reuses it rather than replacing it.

**`ensureColumns(db, table, defs)`.** Reads `PRAGMA table_info` and adds what is
missing. Idempotent **by looking**, not by catching an error — the distinction
that the whole of §5.3 turns on.

**`widenCheckConstraint`.** A table rebuild that (a) uses the caller's `createSql`
rather than reading `sqlite_master` back, because the caller's
`CREATE TABLE IF NOT EXISTS` was a no-op and the stored definition is the narrow
one; (b) compares row counts before and after and refuses to drop the original on
a mismatch; (c) diffs `foreign_key_check` against a **baseline** rather than
against zero, because this store already carries 20 pre-existing violations in
tables the migration never touches. Failing on the absolute count would abort
every rebuild forever over someone else's orphans.

**`cos-maintenance.ts` backup.** Encrypted backup with an integrity check and a
`restoredCases` count — a restore that is actually *exercised*, not merely
written. Measured this morning: 178 MB, `integrity: "ok"`, 118 cases restored.

None of that was rebuilt.

---

## 2. Measured state of the live store (2026-08-25)

```text
tables                                  128
tables carrying `schema_version`          2   (cos_provenance_epoch, cos_triage_provenance)
PRAGMA user_version                       0
cos_schema_migrations rows                1   (2026-08-13-s17-mark-drive-imports-unverified)
total rows (staging copy)           277,136
```

Per-entity field coverage on the core tables:

| table | id | schema_version | created_at | updated_at | status | version |
|---|---|---|---|---|---|---|
| personal_cases | – | **–** | Y | Y | Y | Y |
| zst_cases | – | **–** | Y | Y | Y | Y |
| kanban_cards | Y | **–** | Y | Y | Y | – |
| memories | Y | **–** | Y | – | – | – |
| outbound_ledger | – | **–** | Y | Y | Y | – |
| radar_items | – | **–** | Y | Y | Y | – |

(The `id` column is named per-entity — `case_id`, `ledger_id` — which satisfies
§5.2's *identity* requirement; the table above reports the literal column name.)

---

## 3. Gap matrix against §5

| §5 requirement | Before | Verdict | Closed by |
|---|---|---|---|
| 5.2 durable entities versioned | 2 of 128 tables | **GAP** | store-level version + registry (see §4) |
| 5.3 migration idempotent | `runOnce` (COS only) | **PARTIAL** | generalised to the whole store |
| 5.3 duplicate execution safe | yes, within COS | **OK** | reused, and re-proven on real data |
| 5.3 partial migration detectable | **no** | **GAP** | in-flight marker + gate verdict |
| 5.3 pre-migration compatibility check | no | **GAP** | `precheck` hook, refusal stops the run |
| 5.3 backup before destructive | manual, by convention | **GAP** | refused without a backup path |
| 5.3 post-migration verification | ad hoc | **GAP** | `verify()` is **mandatory**, enforced pre-run |
| 5.4 additive → dual-read → migrate → retire | followed in practice | **OK** | documented as the policy |
| 5.5 single source of truth | scattered | **GAP** | `src/schema/store-schema.ts` |
| 5.7/4 unsupported future schema fail-closed | **absent** | **GAP** | gate → read-only latch |
| 5.7/5 migration proof on staging | none | **GAP** | `scripts/w11-staging-migration-proof.ts` |
| 5.7/6 restore documented and tested | backup exists and is exercised | **PARTIAL** | forward-repair path added and tested |

---

## 4. The scope decision, stated rather than taken quietly

§5.2 asks for `schema_version` on "every durable entity". Retrofitting it onto
126 more tables is a single breaking change across the whole database — exactly
the "big-bang breaking migration" §5.4 tells us to avoid — and on most of them it
would buy nothing: a per-row version on `kanban_cards` cannot gate anything,
because nothing reads a row before deciding whether the process may run.

So versioning lives at **two** levels:

- **Store level.** One authoritative version plus the migration ledger. This is
  the only level at which "a newer-than-supported schema must fail closed" is
  expressible at all: that decision happens once, at open time, before any row is
  read.
- **Entity level.** A `schema_version` on rows only where a row carries its own
  migration state — records that outlive schema changes and may need per-row
  forward repair. The two provenance tables already do this and are the model.

A reader who disagrees should disagree with this paragraph, not discover the
narrowing by counting tables.

---

## 5. The `db.ts` pattern, named and deliberately NOT rewritten in this packet

`src/db.ts` contains **34 `ALTER TABLE`** statements, **21** of them wrapped in
`try { ... } catch { /* exists */ }`.

The defect is not the `ALTER`; it is that the catch swallows **every** error. A
locked table, a full disk, a constraint violation and "the column is already
there" all produce the same silent success. That is the precise shape of a
half-migrated store that reports health.

`ensureColumnStrict()` is the replacement — it asks `PRAGMA table_info` first, so
"already there" is answered by looking, and any error that then occurs is a real
error and propagates. Migrating 21 call sites is a separate, per-site job with
its own proof, and doing it inside this packet would be the big-bang §5.4 warns
about. It is named here so it is a work item rather than an invisible weakness.

---

## 6. Files

```text
src/schema/store-schema.ts              registry, state row, gate, read-only latch
src/schema/migration-runner.ts          runner, ledger, ensureColumnStrict, repair
src/__tests__/w11-schema-migration.test.ts   23 tests, all eight §5.6 scenarios
scripts/w11-staging-migration-proof.ts  §5.7/5 proof against a copy of the live store
```

---

# 7. Closure — the swallowing-catch inventory (Istvan's review, 2026-08-25)

Istvan refused the VERIFIED_DONE on the ground that carrying the pattern forward
"közvetlenül ugyanazt a hibát hagyja bent, amelyet W11-nek meg kell szüntetnie".
He was right: a *named* defect is still a defect, and naming it in a report is
not a mitigation. The verdict was withdrawn and the work done.

## 7.1 Inventory — measured, per line

`grep` for `catch { /* ... */ }` in `src/db.ts` returns **21** sites. They are
not 21 schema mutations; the breakdown matters more than the count:

| # | class | count | lines |
|---|---|---|---|
| 1 | `ALTER TABLE ... ADD COLUMN` | **13** | 460, 461, 462, 467, 535, 551, 616, 617, 657, 658, 753, 882, 958 |
| 2 | `ALTER TABLE ... DROP COLUMN` | **4** | 878, 879, 880, 881 |
| 3 | **not a schema mutation** | **4** | 54, 1025, 1042, 1043 |

**Schema-mutating: 17.** The other four are `db.close()`, two `renameSync()` of a
legacy JSON file, and the JSON-parse guard around a possibly-corrupt import.

## 7.2 Classification: executed core path / legacy reachable / dead-obsolete

Every one of the 17 sits inside **`initDatabase()`**, which runs on every process
start (dashboard, every script, every test that opens a store).

| class | count | evidence |
|---|---|---|
| **executed core path** | **17** | all inside `initDatabase`; enclosing-function map produced by parsing `src/db.ts`, not by reading |
| legacy reachable | 0 | — |
| dead / obsolete | 0 | — |

There is no dead path to remove. The "if some are provably not schema migration
or not reachable, do not rewrite them for the count" allowance applies only to
class 3, and those four are excluded for what they *are*, not to shrink a number:

- **line 54 `db.close()`** — closing a handle during re-init. No schema involved;
  "already closed" is the only failure mode and is genuinely benign.
- **lines 1025, 1042 `renameSync(legacyPath, ...)`** — renaming a consumed JSON
  file so the one-shot import does not repeat. Failing to rename costs a repeated
  no-op import (the function checks `task_runs` is empty first), not corruption.
- **line 1043** — the parse guard for that legacy JSON. A corrupt file is the
  documented, expected case.

## 7.3 What changed

All 17 converted to explicit inspection plus strict failure:

- **13 → `ensureColumnStrict(db, table, column, definition)`** — asks
  `PRAGMA table_info` first, so "already there" is a `false` return; every other
  error propagates.
- **4 → `dropColumnIfPresentStrict(db, table, column)`** — same inspection, and
  it splits the old comment's two facts. `catch { /* column absent or SQLite
  pre-3.35 */ }` shared one silence between "nothing to do" and "this build
  cannot do it". Absence is now a return value; an old SQLite is an explicit
  throw, because a build that cannot drop the column has **not** retired it and
  reporting success would leave a revoked column in place.

## 7.4 Proof

`src/__tests__/w11-strict-schema-mutation.test.ts` — 13 tests, each negative case
paired with its positive twin, because a helper that threw on everything would
pass half of them and break every restart.

| required by the review | test |
|---|---|
| permission failure | read-only handle → throws `readonly / attempt to write` |
| malformed DDL | `NOT_A_TYPE(((` → throws |
| unexpected DB error | closed handle → throws `not open` |
| **the motivating case** | `NOT NULL` with no default on a **non-empty** table → throws, **and the column is asserted absent afterwards** |
| already-exists stays success | add twice → `true` then `false`, no throw |
| retirement idempotent | drop twice → `true` then `false`, no throw |
| whole init replayable | the sequence run 3× yields the same columns |
| old SQLite | version branch forced → explicit throw, not a silent skip |

Plus a **pattern guard**: a test greps `src/db.ts` for any `catch { /* ... */ }`
on a line containing `ALTER TABLE` / `CREATE TABLE` / `CREATE INDEX` / `DROP`,
and requires the list to be empty. A new swallowing catch added next month turns
it red. It has a control assertion (the strict helpers are called ≥13 and =4
times) so it cannot pass by the calls simply vanishing.

## 7.5 The live path, exercised

Greps and unit tests do not prove the real boot survives. `initDatabase()` was
run against a **copy of the live store**, three times in a row:

```text
pass 1: ok, agent_messages has 14 cols, dispatch_id=true, {"version":1}
pass 2: ok, agent_messages has 14 cols, dispatch_id=true, {"version":1}
pass 3: ok, agent_messages has 14 cols, dispatch_id=true, {"version":1}
```

and against a brand-new empty file, twice: `121 tables, {"version":1}` both times.

## 7.6 A pre-existing test that was strengthened, disclosed

`dispatch-threading.test.ts` asserted `expect(DB).toMatch(/ALTER TABLE
agent_messages ADD COLUMN dispatch_id TEXT/)` — a grep for a string in a source
file. It could not tell whether the column ever appeared, and it passed
throughout the period when the surrounding catch could swallow a real failure.

The conversion removed the literal and the grep went red. It was rewritten to
assert the fact it was always trying to state: the column exists after the
helper runs, is nullable, and a second call is an idempotent no-op — plus a
check that `db.ts` really calls the strict helper, so the test measures the live
path and not a helper nobody uses.
