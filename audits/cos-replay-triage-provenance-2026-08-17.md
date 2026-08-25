# Triage provenance + attachment consumer audit (read-only)

Measured 2026-08-17 against the live store and the shipped code. No writes, no
schema changes, no shadow run. This decides what a Clean Replay is *allowed to
claim*, before any code moves.

## 1. Where does the triage output come from — and what survives?

`ingestTriagedZstEmail` / `ingestTriagedEmail` receive `actionable`, `caseType`,
`title`, `workspace`, `priority`, `declaredSensitivity` from the caller: the
email-triage heartbeat, i.e. a model judgement made from the prompt's rules.

**What is persisted of that judgement: nothing.**

| candidate carrier | what it actually holds |
|---|---|
| `personal_case_events` / `zst_case_events`, `event_type='CREATED'` | `payload` is **NULL** for email-derived cases. Only `actor='marveen'`, `source_system='gmail'`, `source_reference=<messageId>`, `created_at`. |
| `email_processing` (42 rows) / `zst_email_processing` (55 rows) | account, message, thread, case_id, status, timestamps. **No verdict fields.** |
| `content_hash` on both ledgers | **NULL in 42/42 and 55/55 rows.** The code says so out loud: `gmail-history-guard.ts:23` — "nothing writes email_processing.content_hash". |
| the case row | the *result* (`case_type`, `title`, `priority`, `scope`) — the outcome, not the decision or its inputs |

So there is a producer (`marveen`) and a timestamp, but **no classifier
fingerprint, no model identity, no recorded input, and no recorded verdict.**

**Can the same production classifier be re-run deterministically? No — there is
none.** A search across `src/cos/*.ts` finds no production function that derives
`caseType` from message text. The only text→type function in the tree is the
shadow's own `inferCaseType` regex, which is precisely what must be deleted.

⇒ Preference order resolves to **(C) TYPE_NOT_REPLAYABLE**. Option A fails (no
historical evidence), option B fails (no deterministic production classifier).

## 2. How much of the corpus this touches

| measure | value |
|---|---|
| corpus threads | **2280** (private 2158, zst 122) |
| threads with **any** production case | **72** (personal 38, zst 34) |
| threads with **no** production case at all | **2208** (96.8%) |
| threads with historical triage evidence | **0** |
| TYPE_NOT_REPLAYABLE (source-derived) | **2280 / 2280** |

Under an explicit `PRODUCTION_AUTHORITY_OVERLAY` — current production
`case_type` fed in as `EXTERNAL_INPUT`, never as source-derived agreement:

| gate | replayable threads |
|---|---|
| `INVOICE_CASE_TYPES` (`INVOICE_INCOMING`/`INVOICE_OUTGOING`) | **9** (all ZST) |
| `CONTRACT_CASE_TYPES` (`CONTRACT`/`LICENSE_SUBSCRIPTION`) | **6** (all ZST) |
| total downstream extractor parity surface | **15 of 2280 threads** |

Every figure produced from those 15 must be labelled
`CONDITIONAL_ON_PRODUCTION_TYPE`. The overall Stage-2 verdict may not claim the
classification was re-proven, because it was not re-run — it was borrowed.

## 3. Which production consumer actually ingests attachments?

**No automatic one.**

| path | in the cycle? | what it stores |
|---|---|---|
| `scripts/cos-fetch-threads.ts` → `storeCaseThread` → `storeDocument` | **yes**, `cos-cycle.ts` step `threads`, `--limit 10` | the *rendered thread text*, `docKind='email_thread'`. **Attachments are not touched.** |
| `POST /api/cos/documents` ← `scripts/cos-attachment-ingest.py` | **no** — invoked from the email-triage heartbeat prompt, per triaged candidate | attachment bytes, `docKind` from a Python-side heuristic |

The data agrees with the code:

| measure | value |
|---|---|
| `cos_documents` rows | **113** (108 distinct sha256) |
| by kind | other 47, email_thread 41, photo 16, invoice 9 |
| by namespace/source | personal/drive 16, personal/email 43, zst/email 54 |
| distinct attachment hashes in the sidecar | **257** (638 instances) |
| **sidecar hashes that exist as production documents** | **41** |

So source attachment completeness (638/638, proven) and production
document-ingest state (41 of 257 distinct) are **different quantities**, and the
gap is not a defect — it is what the production design actually does. A replay
that ingests all 638 would not be reproducing production; it would be inventing
a state production never had.

**`docKind` for attachments exists only in the Python script** (`invoice` /
`photo` / else, by filename). The TS side takes `docKind` as a parameter and
`gmail-thread-read` passes the constant `'email_thread'`. A replay copy would be
a third implementation, so per instruction it must either be lifted into one
shared deterministic classifier called by both, or marked non-replayable.

## 4. What remains UNKNOWN

- **`title`, `priority`, `workspace`, `declaredSensitivity`** share the
  `caseType` provenance gap exactly: consumed at intake, never recorded, no
  classifier to re-run. They are non-replayable on the same evidence.
- **Attribution of the 41 overlapping hashes** — whether each arrived via the
  Python attachment path or the Drive path — is not decidable from the current
  columns without a further read (`source` is per row: drive 16, email 97, but
  the per-hash origin was not resolved here).
- **Whether the 2208 untriaged threads are *correctly* untriaged.** They have no
  case because the heartbeat judged them noise; that judgement is likewise
  unrecorded, so the replay cannot confirm or contradict it.

## 5. Consequence for Stage 2

A Clean Replay on this evidence can honestly measure **at most 15 threads** of
invoice/contract extractor parity, and only in an explicitly conditional mode.
It cannot re-prove classification for a single thread. Any headline agreement
figure that mixes the two would be measuring the shadow's silence again — the
same failure this audit exists to prevent.
