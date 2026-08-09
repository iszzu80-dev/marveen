# CoS ZST Case Lifecycle Gap Survey

**Survey SHA**: `7233147` (develop, 2026-08-08)
**Scope**: read-only code survey, no source changes
**Card**: `3c49e670`

All 27 `zst_cases` sit in status `NEW` — none has ever progressed. The personal
namespace (52 open cases) has real statuses, deadlines, next actions, and owners
by contrast. This survey answers why.

---

## 1. Why do zst_cases never leave NEW?

**Short answer**: `transitionZstCase()` exists but has zero callers anywhere in
the codebase. There is no API endpoint, no dashboard action, no scheduler job,
and no progression pipeline that invokes it.

### Existence

- `src/cos/zst-case-store.ts:83-84` — `transitionZstCase()` is defined. It wraps
  `engine.transitionCase()`.
- `src/cos/zst-case-store.ts:101-106` — the `zstCaseStore` convenience object
  exposes `.transition()` for direct dashboard use.

### Zero callers (exhaustive search against SHA 7233147)

| Search target | Scope | Result |
|---|---|---|
| `transitionZstCase` (import/use) | entire `src/` excluding tests, defs | 0 hits |
| `zstCaseStore` (import/use) | entire `src/` excluding tests, defs | 0 hits |
| `caseStore` (import/use) | entire `src/` excluding tests, defs | 0 hits |
| `.transition(` (call syntax) | entire `src/` excluding tests, defs | 0 hits |
| `PUT\|PATCH` with `/case\|/close\|/complete\|/transition` | `src/web/routes/cos.ts` | 0 hits |

All 17 COS API endpoints (`src/web/routes/cos.ts:46-227`) are either `GET`
(read-only) or `POST` (intake / documents / skill-validate). No endpoint
accepts a case status change.

### How cases are created

- `src/cos/zst-intake.ts:76` — `ingestTriagedZstEmail()` is the sole intake path.
  It calls `createZstCase()` (line 111) with the engine default `status: 'NEW'`
  (`src/cos/zst-case-store.ts:42`).
- After creation, the case is linked to its email thread and the intake returns
  — no follow-up transition is queued, scheduled, or triggered.

### Personal namespace is in the same position

`transitionCase()` (`src/cos/case-store.ts:66-68`) and `caseStore`
(`src/cos/case-store.ts:84-87`) also have zero callers. The intake
(`src/cos/intake.ts:104-106`) sets `NEW` or `WAITING_EXTERNAL` (for outbound)
at creation time and never transitions afterward. So personal cases get their
single initial status during intake and remain there — ZST cases happen to all
get `NEW` because ZST intake has no outbound concept.

**Conclusion**: the transition code exists in the library layer but the wiring
layer (API endpoint, scheduler trigger, or dashboard action) was never built.
This is true for BOTH namespaces — ZST is not uniquely broken, it just has a
less diverse intake (no outbound → all cases land on `NEW`).

---

## 2. Personal vs ZST: what moves a case, and what's missing?

### Personal case lifecycle

| Step | File:line | Mechanism |
|---|---|---|
| Case created | `src/cos/intake.ts:100-112` | `createCase()` with `NEW` or `WAITING_EXTERNAL` |
| Follow-up date set | `src/cos/intake.ts:116` | Outbound only: `follow_up_at` = now + 3 days |
| Status read | `src/web/routes/cos.ts:121-128` | `listActiveCases()` / `listTodayCases()` for dashboard |
| Status changed | **NOWHERE** | No caller for `transitionCase()` |

The personal dashboard view (`/api/cos/today`, `/api/cos/cases`) reads case
statuses for display, but the write-back path does not exist. The 52 personal
cases showing "real statuses" get those statuses exclusively from their intake
moment — their diversity (e.g. `NEW` vs `WAITING_EXTERNAL`) comes from the
intake's own logic, not from post-creation lifecycle transitions.

### ZST equivalent

| Component | Personal | ZST | ZST status |
|---|---|---|---|
| Intake | `intake.ts:76` ingestTriagedEmail | `zst-intake.ts:76` ingestTriagedZstEmail | **Present, wired to `/api/cos/intake`** |
| Read API | `case-store.ts` listActiveCases | `zst-case-store.ts:77` listActiveZstCases | **Present, wired to `/api/cos/zst-cases`** |
| Today API | `case-store.ts` listTodayCases | `zst-case-store.ts:80` listTodayZstCases | **Present, wired to `/api/cos/zst-today`** |
| Transition function | `case-store.ts:66` transitionCase | `zst-case-store.ts:83` transitionZstCase | **Present, zero callers (SAME as personal)** |
| Transition API endpoint | **MISSING both** | **MISSING both** | **Gap (shared)** |
| Scheduler integration | `next_wake_at` column exists (`schema.ts:72`) | `next_wake_at` column exists (`schema.ts:638`) | **Present in schema, never written (shared)** |
| Progression pipeline | `progression-pipeline.ts` (E.1-E.4 branch, not on develop) | **None** | **Gap — progression is personal-only even on feature branch** |

The transition gap is symmetric — both namespaces lack the wiring. The
progression gap is asymmetric: the E.1-E.4 pipeline (`progression-pipeline.ts`
on `cos-e3-wait-wake` branch) handles personal cases only; ZST cases are never
enumerated by the progression scheduler. Even when the progression layer lands,
ZST cases will remain untouched unless ZST is explicitly added to the
scheduler's domain scope.

---

## 3. What states would be meaningful for ZST case types?

The ZST namespace has no CHECK constraint on `case_type`
(`src/cos/schema.ts:621-668` — the `zst_cases` CREATE TABLE has `CHECK` on
`workspace` and `scope` only, not on `case_type`). By contrast, personal_cases
has a strict `CHECK (case_type IN (...))` (`src/cos/schema.ts:83`).

### Existing ZST case types (observed in code)

| Type | Where used | Intake behavior |
|---|---|---|
| `GENERAL_OPERATION` | `zst-intake.ts:111` (default) | Default fallback |
| `INVOICE_INCOMING` | `zst-intake.ts:20,132` | Routes to invoice extractor |
| `INVOICE_OUTGOING` | `zst-intake.ts:20` | Routes to invoice extractor |
| `CONTRACT` | `zst-intake.ts:21,142` | Routes to contract extractor |
| `LICENSE_SUBSCRIPTION` | `zst-intake.ts:21,142` | Routes to contract extractor |

These types exist only in the intake routing constants — the schema itself
enforces nothing, so any string passes.

### Where the personal state machine would NOT fit

The personal case state machine (inferred from `PERSONAL_STATUS_SETS` at
`src/cos/case-engine-core.ts:46-50`) includes states like `INFO_REQUIRED`,
`CALL_REQUIRED`, and `AWAITING_SELECTION`. These are owner-facing action
prompts designed for a single Chief of Staff operator. ZST cases represent
company-internal processes where:

- **Financial cases** (`INVOICE_INCOMING`, `INVOICE_OUTGOING`) need states
  around verification and payment: `PENDING_VERIFICATION`, `APPROVED_FOR_PAYMENT`,
  `PAID`, `DISPUTED`. `INFO_REQUIRED` is too vague — a disputed invoice and a
  missing-amount invoice are different blockers.
- **Contract cases** (`CONTRACT`, `LICENSE_SUBSCRIPTION`) need renewal-timeline
  states: `RENEWAL_DUE`, `UNDER_REVIEW`, `RENEWED`, `TERMINATED`. The personal
  `FOLLOW_UP_DUE` captures "something is due" but loses the distinction between
  "renewal deadline approaching" and "legal review in progress."
- **Compliance cases** (`REGULATORY_DEADLINE` — not yet implemented in intake
  routing but the `legal_exposure` column exists at `schema.ts:644`) need
  evidence-collection states: `EVIDENCE_GATHERING`, `SUBMITTED`, `ACKNOWLEDGED`.
  The personal machine's `RECOVERY_REQUIRED` partially overlaps but the
  regulator-facing directionality is different — compliance is about proving
  something to an external party, not recovering an internal state.
- **Operational cases** (`GENERAL_OPERATION`) map most closely to the personal
  machine: `NEW` → `IN_PROGRESS` (not yet a defined status in either engine) →
  `WAITING_EXTERNAL` → `COMPLETED`. But even here, the ZST workspace split
  (`OPERATIONS` vs `PRODUCT_LAB` at `zst-case-store.ts:25`) implies different
  workflows — a Product Lab case probably needs `PROTOTYPE` / `PILOT` /
  `LIVE` states that make no sense for Operations.

### What the existing ZST_STATUS_SETS already hint at

`src/cos/zst-case-store.ts:48-51` defines ZST-specific attention states:
`INFORMATION_REQUIRED` (note: different spelling from Personal's
`INFO_REQUIRED`), `REVIEW_REQUIRED`, `AWAITING_INTERNAL_INPUT`. These were
clearly chosen with ZST's internal-company context in mind — `REVIEW_REQUIRED`
suggests a legal/finance review step, `AWAITING_INTERNAL_INPUT` suggests a
colleague is blocking. These statuses are defined but never assigned by any
code path (the default is always `NEW`).

---

## 4. Evidence of stalled prior work

### Unwired modules (fully implemented, zero callers)

| Module | Lines | Purpose | Last commit |
|---|---|---|---|
| `src/cos/zst-bank-import.ts` | 206 | CSV bank statement importer with auto-detect, idempotent per (account,date,amount,ref) | `415c017` — "closes finance loop" |
| `src/cos/zst-productlab.ts` | 109 | Product Lab escalation gateway with state machine (9 states, `ALLOWED` transition map at line 86-94) | `43d6465` — "Slice 5 Product Lab escalation gateway" |
| `src/cos/zst-send.ts` | 166 | Approval-gated ZST email send executor with sensitivity checks | `387478b` — "Slice 1 write-half — approval-gated ZST send executor" |

None of these modules are imported by any route, API handler, or scheduler:

- `zst-bank-import.ts`: `grep -rn 'zst-bank-import' src/ --include='*.ts'` (excl. self) → 0 hits
- `zst-productlab.ts`: `grep -rn 'zst-productlab' src/ --include='*.ts'` (excl. self) → 0 hits
- `zst-send.ts`: `grep -rn 'zst-send' src/ --include='*.ts'` (excl. self) → 0 hits

### Schema columns never written to

These columns exist in `zst_cases` (`src/cos/schema.ts:621-668`) but have zero
references in any ZST module (searched `src/cos/zst*.ts` at SHA `7233147`):

| Column | Line | Implied purpose | Status |
|---|---|---|---|
| `next_wake_at` | 638 | Progression scheduler wake time | Column exists, never SET by any code |
| `workflow_name` | 660 | Named workflow tracking | Never referenced |
| `workflow_version` | 661 | Workflow versioning | Never referenced |
| `kanban_card_ids` | 659 | Dashboard kanban link | Never referenced |
| `github_references` | 658 | Dev issue tracking | Never referenced |
| `parent_case_id` | 648 | Case hierarchy | Never referenced |
| `related_invoice_ids` | 654 | Invoice cross-reference | Never referenced |
| `related_contract_ids` | 655 | Contract cross-reference | Never referenced |
| `legal_exposure` | 644 | Compliance risk tag | Never referenced |
| `financial_exposure` | 642 | Monetary risk amount | Never referenced |
| `approval_required` | 641 | Gate flag | Never referenced |
| `blocked_reason` | 640 | Blocker description | Never referenced |

These columns were forward-designed when the ZST schema was created (commit
`496424c` — "Slice 2-5 business schema") but the code paths that would populate
them were either never built (bank import wiring, product lab wiring, send
wiring) or built on a feature branch that never landed (progression scheduler
using `next_wake_at`).

### Missing schema constraint

`zst_cases.case_type` has no CHECK constraint (`src/cos/schema.ts:626` — bare
`TEXT NOT NULL`). Personal cases equivalent (`personal_cases.case_type` at
`schema.ts:65`) also lacks a CHECK constraint in the SQL, but the TypeScript
layer enforces it through the `NewCaseInput` interface at
`case-engine-core.ts:69`. The ZST parallel (`NewZstCaseInput` at
`zst-case-store.ts:27`) extends `CoreNewCaseInput` so it inherits the TypeScript
`caseType: string` type — no enum, no union, no runtime guard. Any string is
accepted at both the type level and the SQL level.

### Commit timeline suggesting momentum loss

```
230445e  Slice 0 — ZST Corporate Case Engine (shared core)
3df9026  Slice 1 read-only ingest — ZST mailbox -> zst_cases
496424c  Slice 2-5 business schema + Slice 2 finance logic
387478b  Slice 1 write-half — approval-gated ZST send executor
5a3d861  Slice 3/6 proactive due-item runner + product seed + read APIs
426e588  Slice 2 invoice extractor (v1) + intake wiring
43d6465  Slice 5 Product Lab escalation gateway
df6bb57  Slice 3 contract/renewal extractor + intake wiring
415c017  Slice 2/18 bank statement importer (CSV) — closes finance loop
79cb34c  E.4 — Semantic Completion (progression, personal-only)
```

The ZST slices (0-5) built the engine, intake, read APIs, extractors, and write
executor in a concentrated burst, then stopped. The bank import ("Slice 2/18")
is the only module numbered beyond 5 — the numbering implies an 18-slice plan
of which 5.5 were built. The progression layer (E.1-E.4, commits `baafde8`
through `79cb34c` on `cos-e3-wait-wake`) was built exclusively for personal
cases and remains on an unmerged feature branch.

---

## Summary

| Question | Answer |
|---|---|
| Why do zst_cases never leave NEW? | `transitionZstCase()` has zero callers. No API endpoint, dashboard action, or scheduler invokes it. Cases are created via intake and never transitioned. |
| What moves a personal case? | Same situation — `transitionCase()` also has zero callers. Personal cases get their status exclusively at intake time (`NEW` or `WAITING_EXTERNAL`). |
| Missing ZST equivalent? | Transition wire-up is symmetrically missing for both namespaces. Progression pipeline is personal-only (even on the feature branch). |
| Meaningful ZST states? | Financial/contract/compliance case types need domain-specific states (verification, payment, renewal, evidence) that the personal machine doesn't cover. ZST attention-set already hints at this (`REVIEW_REQUIRED`, `AWAITING_INTERNAL_INPUT`). |
| Stalled prior work? | 3 fully-implemented modules (bank import, product lab, send executor) with zero callers. 12+ schema columns never written to. Slice numbering implies ~18 planned, ~5.5 built. Progression layer is personal-only. |
