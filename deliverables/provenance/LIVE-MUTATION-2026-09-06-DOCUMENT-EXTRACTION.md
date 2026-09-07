# Live mutation record — document text extraction, 2026-09-06/07

Durable provenance for a live mutation of `store/claudeclaw.db` performed by
**unreleased candidate code, before the owner's release-boundary instruction
existed**. Written at the owner's requirement so the event stays auditable
rather than surviving only in a chat log.

This creates no new truth store. It lives beside the existing release
provenance artifacts in `deliverables/provenance/` and is referenced from the
canonical work item (kanban `b9794f63`).

**Verdict: `NO_DOWNSTREAM_CANONICAL_OR_EXTERNAL_EFFECT_OBSERVED`**
**State: `LIVE_DERIVED_STATE_AHEAD_OF_RELEASE`** (owner ruling, 2026-09-07)

---

## A correction to the first report

My containment audit told the owner that **four** pinned cycles had run over the
changed data. The store says **three**. Cycles at 23:45 and 23:50 ran *before*
the mutation window and I counted them as after. The conclusion does not change
— zero downstream canonical state either way — but the number was wrong, and it
is corrected here with the run ids rather than left to stand.

---

## The applies

| # | operation | when | source SHA | rows |
|---|---|---|---|---|
| 1 | `tsx scripts/cos-classify-extractions.ts --apply` | 2026-09-06 ~23:52 | `634b5dbf` | 83 |
| 2 | `tsx scripts/cos-extract-text-documents.ts --apply` | 2026-09-06 23:53:12 | `634b5dbf` | 108 |
| 3 | `tsx scripts/cos-extract-text-documents.ts --apply` | 2026-09-06 23:55:47 | **none — see below** | 9 |

**Apply 3 has no exact source SHA.** The Office/`.ics` extractor was still
uncommitted in the working tree when it ran; the identical content was committed
20 seconds later as `3c710213` (23:56:07). That commit is evidence of what the
code *was*, and it is not the same claim as having run a committed SHA. Stated
rather than smoothed over, because "which code did this" is the question this
record exists to answer.

Apply 1 writes no `extraction_attempted_at`, so its 83 rows are reconstructed
from the state transition below rather than from a timestamp.

- **Database:** `/home/iszzu/marveen/store/claudeclaw.db` (WAL mode)
- **Table:** `cos_documents` — and only this table
- **Columns:** `extracted_text`, `extraction_state`, `extraction_note`,
  `extraction_attempted_at`, `updated_at`
- **Actor:** marveen, session `015HDX2xPs9u6B9nyG4ekiRm`

## Rows

- before: 236 documents, **58** carrying usable text
- after: 236 documents, **168** carrying usable text
- changed: **138** rows (no inserts, no deletes — 236 before and after)

**A second correction, 2026-09-07.** This line said 137. Re-measured against the
two reference databases, it is 138. The number 137 counts the rows whose
`extraction_state` changed; one more row was written without its state moving:

    doc-614a8cf05237207d  NaBi_Solo2_datasheet_EN_2026.pdf  application/pdf
    state  NOT_ATTEMPTED -> NOT_ATTEMPTED   (unchanged)
    note   "no text (letterRatio 0.000, 0 words, 0 chars)"
        -> "no text (letterRatio 0.000, 0 chars)"
    extraction_attempted_at  NULL -> 1788731747

It is one of the image-only PDFs that still need OCR. The classifier reworded
its note, so the row was rewritten while its verdict stayed the same. Counting
state transitions and calling the result "rows changed" is the kind of shortcut
that makes a provenance record quietly wrong, which is why it is corrected here
with the row named rather than adjusted in place.

State transitions measured against the pre-run reference:

| from | to | rows |
|---|---|---|
| NULL | EXTRACTED_VALID | 60 |
| NOT_ATTEMPTED | EXTRACTED_VALID | 50 |
| NULL | NOT_ATTEMPTED | 21 |
| NOT_ATTEMPTED | EXTRACTION_LOW_QUALITY | 4 |
| NULL | EXTRACTION_LOW_QUALITY | 2 |

## References

| role | artifact | sha256 (first 24) | notes |
|---|---|---|---|
| `PRE_RUN_REFERENCE` | `claudeclaw.pre-extract.db` | `d298916e3c89543613aee251` | plain `cp` of a WAL database. `integrity_check` ok, readable, 432 schema objects, all six relevant tables match. **NOT a verified backup** — it is the last checkpoint, which is precisely its defect. |
| `RESTORE_REFERENCE` | `claudeclaw.post-extract.snapshot.db` | `52be734cacf4a448e4962f39` | `VACUUM INTO`. `integrity_check` ok, 433 objects, all six tables match live. This is the consistent restore point. |

**Promoted to durable storage, 2026-09-07 02:07.** Both had been sitting in the
session scratchpad under `/tmp`, which is tmpfs here -- so they were not merely
impermanent, they were holding ~390 MB of fleet RAM. They now live at:

    ~/marveen-provenance/2026-09-06-document-extraction/

outside the repository on purpose. The root `deliverables/` directory is
untracked but *not* gitignored (`git check-ignore` says so), so a stray
`git add -A` would stage a 200 MB copy of Istvan's personal store. Beside the
files is `SHA256SUMS.txt`.

The move was verified rather than assumed:

| check | pre-extract | post-extract snapshot |
|---|---|---|
| sha256 unchanged by the move | yes | yes |
| `integrity_check` | ok | ok |
| `sqlite_master` objects | 432 | 433 |
| `cos_documents` rows | 236 | 236 |
| rows carrying usable text | **58** | **168** |

Those two text counts are the before/after this record claims, read back out of
the artifacts themselves. The state histogram reconciles exactly against the
transition table above: NULL 83 = 60+21+2, NOT_ATTEMPTED 94 = 50+4+40, and
40+21 = 61 remaining, 58+60+50 = 168 valid, 1+4+2 = 7 low-quality.

The pre-extract reference is load-bearing for closure 3, not just history: it is
the only image of the pre-mutation column values, so it is what a release-time
reconciliation has to re-derive from.

Both files are now mode `400` — read-only, owner only. Reading a WAL-mode
database leaves a `-shm` beside it and can replay a `-wal` into the main file,
which is not a thing an evidence artifact should permit; the empty sidecars left
by this session's own verification runs were removed and the digests re-checked
after (`sha256sum -c SHA256SUMS.txt`, both OK). Anyone who needs to open one
should copy it first, which is the right discipline for evidence anyway.

## Downstream containment audit

**Readers of the mutated columns in the pinned live release** (`releases/cos-cycle-current`):

- `extracted_text` — `dossier-traversal.ts`, `pre-question-evidence.ts`,
  `context-builder.ts`, `cos-documents.ts`, `document-extraction.ts`
- `extraction_state` — `dossier-traversal.ts`, `pre-question-evidence.ts`,
  `context-builder.ts`
- `extraction_note`, `extraction_attempted_at` — declared in `schema.ts` only,
  read nowhere

**A path to canonical state exists and is not denied here.**
`progression-heartbeat-runner` is a cycle step; it imports `reader-cycle` and
`owner-question`, which reach those columns through the evidence gate and the
context builder. This mutation *could* have produced owner questions or claims.

**Nothing came of it.** Since the window opened at 23:53:12:

| table | new rows |
|---|---|
| `cos_owner_questions` | 0 of 70 |
| `structured_claims` (created or changed) | 0 of 352 |
| `personal_case_events` | 0 |
| `outbound_ledger` | 0 of 14 |

Every table carrying a creation timestamp was swept. Six had new rows and all
six are accounted for as this session's own activity: `agent_messages` (two
inbox notifications from cos-outbound and cos-radar), `dispatches` (three,
`source=scheduler`, the heartbeat launches), `conversation_log`, `daily_logs`,
`kanban_comments`, `tool_call_log`.

## Post-mutation cycles

Three pinned cycles ran over the changed data, each `problems: []` with all four
guard checks verified:

| cycle | window | run id |
|---|---|---|
| 10 | 00:07:40 – 00:08:04 | `cos-cycle-a17e6d25-aa69-42f8-b142-f3af0027ae79` |
| 11 | 00:10:25 – 00:10:48 | `cos-cycle-6a3644e5-e2e3-47e2-b18f-8f129cd40da2` |
| 12 | 00:20:25 – 00:20:46 | `cos-cycle-16407238-c2c9-4901-847a-23b2cf0f3c11` |

That is the load-bearing evidence: not "nothing could have happened", but the
reader path actually executed over the changed data three times and produced no
canonical state.

## What this does not establish

- It does not show the derived state is *reproducible* by a released candidate.
  That is the release-time reconciliation the owner required before
  `READY_FOR_RELEASE`, and it has not been done.
- It does not make apply 3 attributable to a commit. It was uncommitted.
