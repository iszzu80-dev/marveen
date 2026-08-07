# COS Document / Attachment Store — design (2026-08-07)

Istvan (msg 7997): store files/images/invoices/attachments for NEW incoming items
at BOTH chiefs of staff (personal + ZST). He will also send images directly ("deal
with this") that I must store, possibly RECOGNIZE something from, and possibly EMAIL
to someone. Design well first, then build.

## Why the existing tables aren't enough
- `case_attachments` (content blob + checksum + content_purged_at) and `case_documents`
  (metadata + drive_url) are BOTH `FK -> personal_cases(case_id)` → **personal-only**;
  a ZST document would violate the FK. And `case_documents` deliberately holds NO
  content (drive-referenced) — the opposite of "self-contained, no Drive dependency".
- So: build ONE namespace-agnostic store used by both CoS, holding LOCAL content.

## Use cases (what this is for)
1. **Inbound email attachment** → store + link to case + extract (invoice amount/number
   from the PDF — this is also what fills the empty invoice amounts). Personal + ZST.
2. **Istvan sends a Telegram image/doc + a task** ("intézd el ezt") → store it, RECOGNIZE
   it (vision/OCR), then act (create/attach a case, answer, or prepare an outbound send).
3. **Recognition**: PDF text extraction + image OCR/vision → `extracted_text` + classify
   `doc_kind` + pull financial fields (issuer/amount/due_date) where present.
4. **Outbound**: attach a stored document to an email via the send executor — sensitivity
   + per-payload approval gated (never auto-send a sensitive doc; UNKNOWN fail-closed).
5. **Retention / sensitivity**: every doc carries a sensitivity tier + `external_share_allowed`;
   content can be purged after retention (`content_purged_at`) while metadata stays.
6. **Backfill**: link the 16 Drive-pulled files (store/personal-cos-drive-archive/) to their
   personal cases by the PRI-* case id in the folder name.

## Data model — `cos_documents` (new, namespace-agnostic)
| column | meaning |
|---|---|
| document_id | PK `doc-<sha8>` |
| namespace | 'personal' \| 'zst' (scope boundary, like the case engine) |
| case_id | links personal_cases/zst_cases; NULLABLE (a doc can arrive before a case) |
| source | 'email' \| 'telegram' \| 'drive' \| 'manual' \| 'web' |
| source_ref | email message_id / telegram file_id / drive_file_id / url |
| filename, mime_type, byte_size, sha256 | file identity + integrity |
| stored_path | LOCAL content-addressed `store/cos-documents/<sha[:2]>/<sha>` (dedup) |
| doc_kind | invoice \| contract \| receipt \| statement \| photo \| id_doc \| other |
| issuer, amount, due_date | financial extraction (nullable) |
| extracted_text | PDF text / OCR / vision description (nullable) |
| sensitivity | tier; UNKNOWN → fail-closed for send |
| external_share_allowed | 0/1 gate for outbound attach |
| received_at, created_at, content_purged_at | provenance + retention |

- **Content-addressed local storage**: `store/cos-documents/<sha256[:2]>/<sha256>`; identical
  bytes dedup to one file; original filename kept in metadata. Gitignored (personal/company docs).
- Big files on disk (NOT DB blob) → SQLite stays small. `content_purged_at` marks purged content.
- Case link: write `document_id` into `zst_invoices.document_id` etc. and append to
  `personal_cases.related_document_ids` / `zst_cases.related_document_ids`.

## Ingestion adapters (one store, several inlets)
- `storeDocument(db, {namespace, caseId?, source, sourceRef, filename, mime, bytes, sensitivity})`
  → content-address + write file + insert row + link. Idempotent per (namespace, sha256, case).
- **email**: on intake, if the message has attachments, fetch each (Gmail attachment API,
  read-only), storeDocument(source='email'). Invoice PDFs → run extraction → fill amount.
- **telegram**: when Istvan sends a photo/doc, download_attachment → storeDocument(source='telegram');
  then recognition + act.
- **drive backfill**: walk store/personal-cos-drive-archive/, storeDocument(source='drive',
  stored_path=existing) linked by PRI-* case id.
- **manual/web**: generic add path.

## Recognition
- PDF: stdlib text extract (reuse `_pdf_text`); font-encoded PDFs → OCR fallback later.
- Image: OCR (tesseract if available) and/or agent vision (Read the image → describe/extract).
- Output → extracted_text + doc_kind + financial fields. Runs on ingest (best-effort) or on demand.

## Outbound (send an attached doc)
- Extend the send executor / GmailApiTransport to attach a stored document by document_id
  (multipart MIME, base64). HARD GATE: sensitivity + `external_share_allowed` + per-payload
  approval + recipient allowlist. No autonomous send of a document.

## Safety invariants
- Read-only when fetching (Gmail/Telegram/Drive) — download only, never modify the source.
- Local + self-contained: no Google Drive dependency for the go-forward store.
- Sensitivity-first: UNKNOWN → fail-closed for any external share; secrets never stored as
  shareable; per-payload approval for outbound.
- Namespace isolation: personal and zst documents never mix (same as the case engine).

## Build phasing
- **P1 (now)**: cos_documents table + storeDocument (content-addressed) + case linking +
  PDF text extraction + the Drive-archive backfill linker. Tests.
- **P2**: email-attachment ingestion wired into intake (personal + zst); invoice-amount fill.
- **P3**: Telegram-image ingestion + recognition (OCR/vision).
- **P4**: outbound attach capability (gated) in the send executor.
