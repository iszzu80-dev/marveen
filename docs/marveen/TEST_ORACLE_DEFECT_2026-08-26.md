# TEST_ORACLE_DEFECT — the acceptance oracle named tables that never existed

```text
Recorded on the owner's instruction, 2026-08-26.
Class:    TEST_ORACLE_DEFECT
Impact:   a FALSE RED on a healthy production cutover, on the single check whose
          standing remedy is "roll back, do not fix in place".
Author of the defect: Marveen.
```

---

## 1. What happened

The post-cutover acceptance asserted that four Phase 0 tables exist:

```text
cos_disclosure_records   PRESENT
cos_recovery_queue       PRESENT
migration_ledger         MISSING   ← never existed
store_schema             MISSING   ← never existed
```

It reported **FAIL (2 of 4)** on a cutover that was, in fact, entirely healthy.
The real tables — created by the very code that had just been deployed — are
`store_schema_state`, `store_schema_migrations` and `cos_schema_migrations`, and
all three were present, with `store_schema_state` carrying version 1.

```bash
grep -rn "migration_ledger|'store_schema'" src/ scripts/   # → no matches
```

The two names appear nowhere in the codebase and never did.

## 2. Where the bad names came from

`PHASE_0_GO_NO_GO.md` §0, the NO-GO verdict's own evidence block. I wrote that
list by hand and never checked it against the code that creates the tables
(`src/schema/store-schema.ts:89,99`; `src/cos/schema.ts:239`). The acceptance
script then copied it.

So the defect is older than the acceptance script: **half of the evidence for
the original NO-GO was fictional.** The verdict survived only because the other
two names were real and genuinely absent.

## 3. Why an absence check is the worst place for this

A presence check that names a wrong table fails loudly and gets fixed in
minutes. An **absence** check that names a wrong table *passes* — it "proves"
something is missing, and the proof is free, because a name with no referent is
absent everywhere and always.

That is what made this dangerous in both directions:

* before the cutover it produced a **false green** on the NO-GO's evidence (two
  of four legs proved nothing, silently);
* after the cutover it produced a **false red**, on the one check whose standing
  remedy is to roll back a healthy release.

## 4. What was done, and the judgement call inside it

I did **not** roll back. I first established *which* two were missing, found the
names had no referent anywhere in `src/` or `scripts/`, and corrected the
instrument rather than the system.

That reasoning — "the test is wrong, not the code" — is exactly the reasoning
that must never be accepted on someone's say-so. It is recorded here, and in
`PHASE_0_GO_NO_GO.md` §0, in a form that can be overruled, and its whole proof
is one grep anybody can re-run.

## 5. The rule this produces (owner, 2026-08-26)

> **Acceptance FAIL → progression stop.**
>
> Rollback may be omitted **only** if it can be shown, without modifying product
> or runtime, that the oracle alone is at fault. The corrected oracle must then
> re-run the **entire** affected acceptance, not just the failing line.

Followed here: no product or runtime change was made to reach green; the whole
ten-line acceptance was re-run after the fix, not the one case.

## 6. The engineering rule, so this cannot recur the same way

**Expected schema-object names must be derived from the canonical
schema/migration manifest, or verified by a test to exist in the release code.
A hand-copied list in a document must never be the only source of truth.**

Concretely, the safe forms are:

```ts
// derive: the names come from the code that creates them
import { STORE_SCHEMA_TABLES } from '../schema/store-schema.js'

// or verify: the oracle's own names are asserted to exist in the source
expect(readFileSync('src/schema/store-schema.ts', 'utf8')).toContain(name)
```

and the unsafe form is a literal list typed from prose.

**This is not yet implemented as a manifest.** Building one is a Phase 1 item
(§Phase-1 backlog), and until it exists the acceptance script carries the real
names with an explicit source comment naming the file and line that creates each
one — which is weaker than a manifest and stronger than a document.

## 7. The related Phase 1 engineering item, recorded here so it is not lost

The readback fallback (`src/cos/adapters/gmail-send.ts`, F-12) fires only when
the idempotency-marker search **cannot run**. When the search runs, honestly
finds nothing, and an authoritative `external_ref` exists, the provider-ID
verification path must also be attempted. Owner's decision, 2026-08-26. This is
what forced three legacy sends to be settled by a human instead of by the
machine, despite the machine holding the evidence.
