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
