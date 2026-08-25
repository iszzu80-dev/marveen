# Stage 2H — provenance audit of the 13 ZST threads with no production extractor row

**Read-only.** No case created, no correction, no canary, no Gmail write, no Stage 2G
activation, no conditional replay. The only production access was SQLite in
`mode=ro` and Gmail `messages.get?format=metadata`.

Question asked (Istvan, 2026-08-18): *was an extractor row expected when the
production state was created, and if so, why is there none?*

---

## 0. Verdict first

**Zero `HISTORICAL_EXTRACTION_GAP_CANDIDATE`.** All 13 are
`HISTORICAL_NO_ROW_IS_VALID_OUTPUT`: the extractor demonstrably ran and writing
no row was the correct behaviour of the code path that actually executed.

But the audit found something the question did not ask for, and it is the more
important result:

> **The production extractor input carried no `From` and no `Subject` for the
> 2026-08-07 batch.** Sixteen ZST cases were created in that batch; the extractor
> saw the snippet and nothing else. Seven invoices therefore extracted to the
> *same empty fingerprint* and the store, correctly, kept one row and deduplicated
> the other six into it. Three contracts did the same. The single invoice row in
> production is not "the one invoice that worked" — it is a placeholder standing
> for seven.

And a consequence for Stage 2H:

> **No thread in the 15 is suitable for a FULL_BODY conditional parity run.** Every
> production extraction ran on the ~200-character Gmail snippet. A FULL_BODY replay
> is a different input for all 15, not a comparable one.

---

## 1. Evidence base

| what | how it was established |
|---|---|
| case/ledger timestamps | `zst_cases`, `zst_email_processing`, `zst_case_events`, read-only |
| deployed code | `dist.bak-prefloor-20260808-081049/` — a dist snapshot taken 2026-08-08 08:10, the earliest surviving artifact that contains `zst-intake.js` |
| production input | Gmail `messages.get?format=metadata` (From/Subject/Date/To + snippet), today, read-only |
| historical behaviour | the deployed v1 extractors executed against reconstructed inputs |

**Two bulk batches, not a live per-mail path.** Sixteen of the nineteen
invoice/contract-typed ZST cases were created in a single second,
**2026-08-07 08:21:28**; two more at **2026-08-09 21:04:11** and one at
**2026-08-09 23:07:37**. The route was the `mailbox-backfill-to-cos-intake`
procedure, which drives `POST /api/cos/intake` — i.e. the running dashboard
`dist/`, not a source-mode script.

---

## 2. Was the capability present? Yes, and it ran.

| claim | evidence |
|---|---|
| invoice extractor deployed and executing at 08-07 08:21:28 | `zst_invoices` row `zst-inv-be5be69f55e9` has `created_at` = **08-07 08:21:28**, the same second as the batch |
| contract extractor deployed and executing at 08-07 08:21:28 | `zst_contracts` row `zst-ctr-676a89754d19`, same second |
| still executing at 08-09 21:04:11 | `zst_contracts` row `zst-ctr-8fa1cad34e7a`, same second as batch 2 |
| the historical gate is the same gate | the deployed `zst-intake.js` carries `INVOICE_CASE_TYPES = {INVOICE_INCOMING, INVOICE_OUTGOING}` and `CONTRACT_CASE_TYPES = {CONTRACT, LICENSE_SUBSCRIPTION}` — byte-identical membership to today's `routeZstExtractor` |

So `HISTORICAL_EXTRACTOR_NOT_PRESENT` = **0** and
`HISTORICAL_ROUTE_NOT_APPLICABLE` = **0**. All 13 routed to an extractor that was
live and running.

---

## 3. What the extractor actually received — proven by content-addressed keys

Both extractor tables key their primary id off a duplicate fingerprint computed
from the *extracted values* (`zst-inv-<sha256(supplier|number|gross|issueDate)>`,
`zst-ctr-<sha256(counterparty|title|expiry)>`). That makes the stored primary key
a checkable function of the input. Two reconstructions were run against the
deployed v1 extractors:

- **headerless**: `from = ""`, `subject = "(nincs tárgy)"`, `body = snippet`
- **headered**: real `From`, real `Subject`, `body = snippet`

| production row | batch | headerless reproduces | headered reproduces |
|---|---|---|---|
| `zst-inv-be5be69f55e9` | 1 | **yes, exactly** | no (`zst-inv-c1a15a01a4d0`) |
| `zst-ctr-676a89754d19` | 1 | **yes, exactly** | no (`zst-ctr-685b1cb4d13a`) |
| `zst-ctr-8fa1cad34e7a` | 2 | no | **yes, exactly** |

Three independent checks agree with the headerless reading of batch 1:

1. **exact key match** on both batch-1 rows, and only under the headerless input;
2. **row count**: the headerless reconstruction predicts exactly 2 distinct
   batch-1 rows (1 invoice + 1 contract). Production holds exactly 2;
3. **collapse pattern**: 7 batch-1 invoices reduce to the single fingerprint
   `be5be69f55e9`, 3 contracts to `676a89754d19`, and 6 invoices produce no row at
   all. That is precisely the shape of the store.

Batch 2 reproduces only under the headered input, and the Oracle row
(`zst-ctr-8fa1cad34e7a`) is reproduced identically by the deployed v1 extractor,
by today's extractor on the snippet, and by today's extractor on the full body —
a three-way agreement that serves as the positive control for the whole method.

### What is NOT proven

The *mechanism* of the header loss. The case titles and descriptions read today
carry real subjects and senders, so the intake was not blind end-to-end. But every
one of those rows is at `version = 2` and was updated on 08-09/08-11 by later
enrichment (`INFORMATION_ADDED`, "a levél TÖRZSE beolvasva"), so today's title is
not the value the intake received. No dist snapshot survives from before
2026-08-08 08:10, and the backfill script was a scratchpad file that no longer
exists. Whether the headers were lost in the backfill's own metadata fetch or on
the way to the extractor is **UNKNOWN** — the *effect* is proven, the *cause* is not.

(The same defect is easy to make and was made again during this audit: the first
metadata fetch here passed `metadataHeaders` as a list to `urlencode`, which sends
one literal `['From', ...]` parameter. Gmail answered HTTP 200 with a snippet and
**no headers**, so the run looked healthy and every downstream value was empty.)

---

## 4. Disposition of the 13

| thread | batch | route | deployed v1 on production-shaped input | disposition |
|---|---|---|---|---|
| 19edae46460029b4 | 1 | INVOICE | row, collides with `be5be69f55e9` | NO_ROW_IS_VALID_OUTPUT (dedup) |
| 19ef4dd5b1809912 | 1 | INVOICE | row, collides | NO_ROW_IS_VALID_OUTPUT (dedup) |
| 19f69bcffd4ae1d2 | 1 | INVOICE | row, collides | NO_ROW_IS_VALID_OUTPUT (dedup) |
| 19fad7ccdabe0c66 | 1 | INVOICE | row, collides | NO_ROW_IS_VALID_OUTPUT (dedup) |
| 19f1de141333b3b1 | 1 | CONTRACT | row, collides with `676a89754d19` | NO_ROW_IS_VALID_OUTPUT (dedup) |
| 19f7dd321140c2e9 | 1 | CONTRACT | row, collides | NO_ROW_IS_VALID_OUTPUT (dedup) |
| 19ead3e033debd68 | 1 | INVOICE | no row | NO_ROW_IS_VALID_OUTPUT (declined) |
| 19f1e80f71ea2947 | 1 | INVOICE | no row | NO_ROW_IS_VALID_OUTPUT (declined) |
| 19f60f99265f3ad6 | 1 | INVOICE | no row | NO_ROW_IS_VALID_OUTPUT (declined) |
| 19f7dd307c878cae | 1 | INVOICE | no row | NO_ROW_IS_VALID_OUTPUT (declined) |
| 19fa4a7d49b58261 | 1 | INVOICE | no row | NO_ROW_IS_VALID_OUTPUT (declined) |
| 19fe22a42031867a | 2 | CONTRACT | no row (headered) | NO_ROW_IS_VALID_OUTPUT (declined) |
| 19fe8546ea244250 | 3 | CONTRACT | no row (headered) | NO_ROW_IS_VALID_OUTPUT (declined) |

**`HISTORICAL_EXTRACTION_GAP_CANDIDATE`: 0.** Not one thread shows the required
shape — same extractor, same gate, same input, structured value today, no
production row. Where today's extractor does produce a row (7 of the 13), it does
so from the **full body**, which production never saw.

---

## 5. Parity suitability — the answer that changes the plan

Per-thread equivalence of the production input, not batch-level:

| | threads |
|---|---|
| suitable for a genuine conditional parity run (input reproducible per thread) | **3 of 15** — `19fe22a42031867a`, `19fe2dc16448b92a`, `19fe8546ea244250` (batch 2/3, real headers + provider snippet) |
| `HISTORICAL_INPUT_NOT_EQUIVALENT` for per-thread parity | **12 of 15** — every batch-1 thread; the headerless input is proven at batch level but not reconstructible per thread |
| suitable for a FULL_BODY parity run | **0 of 15** — production extracted from the snippet in every case |
| retrospective / current-extractor evaluation only | 12 |
| UNKNOWN (disposition) | 0 |
| UNKNOWN (cause of the header loss) | 1 finding, batch-wide |

The out-of-corpus invoice row (`zst-zst-19c7b68af5cb7da8`) is used here **only** as
a positive control and is **not** in the 15-thread denominator.

**No aggregate PASS is stated**, because the denominator is now known to be wrong
for the surface as built: a FULL_BODY conditional parity has zero eligible targets.

---

## 6. What this is, and what it is not

This is a **migration / legacy-coverage finding**, not a replay mismatch. Punishing
it as a parity failure would be measuring a historical input defect with an
instrument built for a different question.

Two separable items for the owner:

1. **The batch-1 extraction is placeholder state.** One invoice row and one
   contract row stand in for ten cases. Nothing is wrong with the extractor or the
   dedup; the input was empty, and identical empty inputs are supposed to collapse.
   Whether to re-extract those ten (with real headers and, if wanted, full bodies)
   is an owner decision — it is a correction, and correction is STOP.
2. **The conditional parity surface needs its input basis decided before it runs.**
   FULL_BODY has no eligible target. Snippet-based parity has three.
