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
