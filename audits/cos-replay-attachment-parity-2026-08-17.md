# Attachment/document processing parity — shadow replay vs production

**Verdict: PARITY FAILS. Stage 2 must not proceed to Clean Replay on this code.**

Measured 2026-08-17 by reading the shipped code, not the design intent.

## The claim under test

> The shadow replay uses the same production attachment/document extractors from
> which invoice / contract / document-derived state can arise.

It does not. The shadow replay reaches **none** of them.

## What production actually runs

`POST /api/cos/intake` → `ingestTriagedZstEmail` (`src/cos/zst-intake.ts`):

| step | module | state it can create |
|---|---|---|
| temporal claims | `extractTemporalClaims` (`temporal-consistency-gate.ts`) | `*_temporal_facts` |
| invoice extraction, gated on `INVOICE_CASE_TYPES` = {`INVOICE_INCOMING`, `INVOICE_OUTGOING`} | `ingestZstInvoiceEmail` → `extractInvoice` → `upsertZstInvoice` (`zst-invoice-extract.ts`) | `zst_invoices` |
| contract extraction, gated on `CONTRACT_CASE_TYPES` = {`CONTRACT`, `LICENSE_SUBSCRIPTION`} | `ingestZstContractEmail` → `extractContract` (`zst-contract-extract.ts`) | `zst_contracts` |
| actionability | `classifyActionability` (`actionability.ts`) | case status/orphan rejection |
| documents | `storeDocument` (`cos-documents.ts`), called from `gmail-thread-read.ts` and `scripts/cos-attachment-ingest.py` | `documents`, case↔document links |

## What the shadow replay runs

`src/cos/replay/shadow-replay.ts` imports exactly three production modules:
`classifyScope`, `classifyActionability`, `extractTemporalClaims`. It creates four
tables: `replay_runs`, `replay_messages`, `replay_cases`, `replay_temporal_facts`.

For attachments it does one thing (line 185):

```ts
const attachmentManifest = JSON.stringify((m.attachments ?? []).map(a => ({
  filename: a.filename, mimeType: a.mimeType ?? null,
  sha256: a.sha256 ?? null, sizeBytes: a.sizeBytes ?? null })))
```

…and stores `sha(attachmentManifest)` in `attachment_manifest_hash`. That is a
fingerprint of the *metadata*, not an extraction. No attachment byte, no document
row, no invoice row, no contract row is ever produced.

## The three gaps, in the order they bite

1. **No invoice/contract extraction.** `ingestZstInvoiceEmail` and
   `ingestZstContractEmail` are never imported. A reconciliation between shadow
   and production therefore cannot surface an invoice or contract difference —
   **the shadow has no such rows to differ in.** This is the dangerous shape: the
   comparison reports agreement because one side never attempted the work.

2. **No document ingest.** `storeDocument` is never called, so document-derived
   state is absent by construction, and the sidecar blobs retrieved on 2026-08-17
   feed nothing.

3. **A different classifier decides whether extraction would even fire.**
   Production gates extraction on the `caseType` supplied at intake. The shadow
   invents its own with a private regex, `inferCaseType` (line 106):
   `/invoice|számla|szamla|fizet/ → INVOICE_INCOMING`. Even after gaps 1–2 are
   closed, the gate would fire on a **different set of threads** than production,
   so the two sides would still not be comparable.

## Minimal parity fix

Smallest change that makes the comparison mean something. No new capability, no
schema invention, no change to the extractors themselves.

1. **Give the shadow DB the real tables.** Call the existing
   `initZstSchema` / `initZstFinanceSchema` / `initZstContractsSchema` /
   `initCosDocumentsSchema` on the shadow database. They already exist; the shadow
   simply never called them.
2. **Call the production extractors, unchanged.** In the per-thread projection,
   invoke `ingestZstInvoiceEmail` and `ingestZstContractEmail` under the same
   `INVOICE_CASE_TYPES` / `CONTRACT_CASE_TYPES` gates, and `storeDocument` for each
   attachment, keyed by the sha256 the sidecar corpus already carries. Import them;
   do not re-implement them — a second copy of an extractor is a second answer.
3. **Delete `inferCaseType`, and make the case type an explicit input.** The
   production type is decided at intake by the triaging agent, not by a function,
   so it is **not derivable from the corpus**. Pretending otherwise is what makes
   gap 3 invisible. Either feed the type recorded in the production snapshot (and
   label it `EXTERNAL_INPUT` in the reconcile output), or classify the thread as
   `TYPE_NOT_REPLAYABLE` and exclude its extraction-derived state from the
   agreement figures — never silently count it as agreement.

Until at least (1)+(2) land, any Clean Replay reconciliation figure covering
invoices, contracts or documents is an artefact of the shadow's silence, not
evidence of agreement.

---

## Addendum — where the 41 overlapping hashes came from (read-only, same day)

Istvan asked for this before any shadow ingest, and the answer changes what a
document-parity figure may claim.

Of the **257 distinct attachment hashes** in the sidecar corpus, **41** exist in
production `cos_documents` (42 rows — one hash is stored twice):

| route into production | distinct hashes |
|---|---|
| Gmail attachment path (`source='email'`, `source_ref` = a Gmail messageId) | **27** |
| Drive migration path (`source='drive'`, `source_ref='chatgpt-cos-drive'`) | **14** |
| reached the store by both routes | **0** |
| **never ingested at all** | **216** |

Row-level breakdown of the 42: zst/email/other 13, zst/email/photo 7,
zst/email/invoice 4, personal/email/other 3, personal/email/photo 1 (=28 via the
Gmail script) and personal/drive/photo 7, personal/drive/other 4,
personal/drive/invoice 3 (=14 via the Drive migration), across 20 distinct cases.

Two consequences:

1. **Fourteen of the forty-one never came through the attachment pipeline at
   all.** They are the same bytes arriving by a different road (the ChatGPT-side
   Drive migration). A replay of the *email* path can neither produce nor take
   credit for them.
2. **216 attachments were never ingested, and that is production's actual
   behaviour**, not a defect to be repaired by the shadow. Ingesting all 638 into
   the shadow would manufacture a state production never had — which is the same
   error as the shadow's silence, only pointed the other way.
