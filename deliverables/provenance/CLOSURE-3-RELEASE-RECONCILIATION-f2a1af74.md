# Closure 3 — release-time reconciliation

**Verdict: `RELEASE_CANDIDATE_REPRODUCES_LIVE_DERIVED_STATE`**
**Candidate SHA: `f2a1af741f923d351b3edf162fe3680a09bad106`**
**Run: 2026-09-07, from a clean worktree at that SHA**

Istvan's condition, 2026-09-07: *"Ne legyen olyan release, amely egyszeruen
'orokbe fogadja' a live DB-ben levo, korabbi unreleased koddal letrehozott
derived state-et bizonyitas nelkul."* No release may adopt the derived state
that unreleased code created, without proof.

This is that proof, and it is a **re-derivation** rather than an inspection.
Reading the live rows and finding them plausible would establish nothing; the
question is whether the code we are about to release *produces* them.

## What was run

| step | command | result |
|---|---|---|
| seed | `cp claudeclaw.pre-extract.db clone.db` | `d298916e3c89543613aee251…` — the pre-mutation reference, unchanged since the incident |
| 1 | `MARVEEN_DB=clone.db tsx scripts/cos-classify-extractions.ts --apply` | 83 written |
| 2 | `MARVEEN_DB=clone.db tsx scripts/cos-extract-text-documents.ts --apply` | 110 EXTRACTED_VALID, 6 LOW_QUALITY, 1 NOT_ATTEMPTED, 60 skipped |
| 3 | `tsx scripts/cos-reconcile-extraction.ts --expected ~/marveen/store/claudeclaw.db --actual clone.db` | **236 of 236 identical, 0 differing** |
| 3b | same, against `claudeclaw.post-extract.snapshot.db` | **236 of 236 identical, 0 differing** |

The comparison covers the three derived content columns — `extracted_text`,
`extraction_state`, `extraction_note`. `extraction_attempted_at` and
`updated_at` are excluded and the tool says so in its own output: they are wall
clocks, a re-run necessarily writes a later value, and demanding they match
would fail every honest reconciliation while proving nothing about content.

Step 3 compares against the **live database**, not only the snapshot. Before
the run, live was checked against the post-extract snapshot and still matched it
exactly (236/236), so nothing had drifted in those columns since 23:58 and the
stronger comparison was available.

## Why the comparison can be believed

A comparator that always says "reproduced" would produce this same page. It was
driven red and green first:

| control | expectation | observed |
|---|---|---|
| pre-extract vs post-extract | must NOT reconcile | `NOT_REPRODUCED`, **385** column differences across 138 documents, exit 1 |
| a byte-identical copy at a different path | must reconcile | `REPRODUCED`, 0 differences, exit 0 |
| a file compared against **itself** | must refuse | `sameFile: true`, `reproduced: false` — a perfect match that proves nothing is reported as a failure |

## What this closes, and one thing it settles that was open

Apply 3 in the mutation record has **no exact source SHA** — the Office/`.ics`
extractor was still uncommitted when it ran, and was committed 20 seconds later
as `3c710213`. That gap cannot be closed by argument.

It is closed by measurement here. The committed code re-derives those rows
identically, so whatever was in the working tree at 23:55:47 was equivalent *in
effect* to what is committed. That is the claim that matters for a release, and
now it rests on a run rather than on a plausible story about a 20-second gap.

## What this does not establish

- It does not extend to documents nobody has extracted yet: 57 images, 4 PDFs
  with no text layer, 2 `.rar`, 1 legacy `.doc`. Those need OCR or a reader that
  does not exist, and the OCR question is a cost decision for Istvan.
- It does not make the pre-run `cp` a backup. It never was one, and the
  `PRE_RUN_REFERENCE` label stays.
- It proves reproducibility at `f2a1af74`. A later candidate has to re-run this,
  which now costs two commands.
