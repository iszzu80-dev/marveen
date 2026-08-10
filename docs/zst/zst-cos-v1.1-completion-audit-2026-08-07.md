# ZST Radio Kft. Chief of Staff v1.1 — Completion Audit vs the Original Spec

**Date:** 2026-08-07 · **Author:** Marveen · Honest status of what was built against `marveen-zst-radio-chief-of-staff-v1.1`.

## Headline

**Built + live + tested:** the operational spine (Slice 0), the read-side ingest (Slice 1 read-half), the finance domain (Slice 2), and the full business SCHEMA for Slices 2-5. **69 COS tests green** (39 ZST + 30 personal regression), zero regression on the live personal COS. Write-scope OAuth is now live. **Not yet built:** the outbound Action Executor (send half), the domain LOGIC for Slices 3-5 (contracts/vendors/partners/product-lab beyond their tables), the procurement/product radar price-fetch engine, and Slice 6 proactive completeness. This is honest structure-first progress, not a Potemkin "done".

## Slice-by-slice

| Slice | Status | What's real | What's missing |
|---|---|---|---|
| **0 — engine + audit** | ✅ DONE, LIVE | Shared table-parameterized case engine over `zst_cases`/`_events`/`_claims`; optimistic concurrency + append-only audit + claim/fencing; ZST status set; workspace routing tag (replaced the heavy Scope Gate — connector identity is the boundary); ZST sensitivity policy (fail-closed); read API `/api/cos/zst-cases`+`zst-today`. | — |
| **1 — Gmail + Action Executor** | ◑ READ-HALF DONE, LIVE | Account-routed intake: ZST mail → `zst_cases` (never personal); `zst_email_processing` dedup ledger; sensitivity escalation + workspace + ZST case types; idempotent. Heartbeat updated. | **Write-half: the Action Executor / send** (accounting-package prepare→approve→send→readback). OAuth now unblocks it. Full batch/checkpoint/quarantine (§12) deferred (read-only uses a minimal ledger, same as personal). |
| **2 — finance** | ✅ DONE (local/read) | `zst_invoices` + duplicate detection (AT-ZF01); paid-needs-evidence CHECK (AT-ZF02); read-only bank match SUGGESTED only (AT-ZF03), one txn ≠ two invoices (AT-ZF04); accounting-package roll-up. Tested. | The accounting-package **SEND** (needs the executor). Real bank-statement import (parser) — the model is ready, the ingest is not. |
| **3 — contracts/vendors/licenses/procurement** | ◔ SCHEMA ONLY | Tables: `zst_contracts`, `zst_obligations`, `zst_vendors`, `zst_licenses`, `zst_procurement_radar_items`+`_offers`. | Domain logic: renewal-due watch, obligation tracking, license cancellation-candidate detection, and the **procurement radar price-fetch engine** (next build). |
| **4 — partners/commercial** | ◔ SCHEMA ONLY | Tables: `zst_partners`, `zst_opportunities` (full status machine in CHECK). | Domain logic + the commercial campaign (needs the executor for outreach). |
| **5 — Product Lab gateway** | ◔ SCHEMA ONLY | Tables: `zst_products` (data-driven, not enum), `zst_product_milestones`, `zst_product_escalations`. | Gateway logic (ZST↔product escalation flow), portfolio projection, GitHub summary. |
| **6 — proactive completeness** | ✗ NOT STARTED | — | Daily reconcile, weekly operating review, monitoring metrics, Control Tower Sheet cutover (needs the new `spreadsheets` scope), autonomy switches. |

## Acceptance tests (spec §32)

- **DONE + tested:** AT-ZS01 (no personal data in ZST store — namespace + connector-identity), AT-ZS02 (ONE excluded — no connector), AT-ZF01-04 (finance).
- **DONE structurally (engine):** claim/fencing (AT-ZG06/07 equivalent proven in the case engine), idempotent ingest (AT-ZG01 equivalent per (account,message)).
- **NOT yet:** AT-ZA01-10 (outbound/approval — needs executor), AT-ZD01-03 (attachments), AT-ZC01-04 (contracts logic), AT-ZP01-04 (procurement — needs the radar engine), AT-ZL01-04 (product lab). AT-ZG02-05 (full batch/cursor/quarantine) — deferred with the authoritative history-sync.

## Deviations from the spec (deliberate, with reasons)

1. **Scope Gate removed as a security component.** The spec front-loaded a heavy PRI/ZST/ONE classifier; but ZST is a separate Google account with a pure mailbox, so connector identity is the physical boundary (AT-ZS01 at the source). Reduced to a thin OPERATIONS/PRODUCT_LAB routing tag. (Agreed with Istvan.)
2. **Products are a data-driven table, not the spec's fixed enum** — the list grows (agreed).
3. **Shared engine, not a parallel platform** (spec principle #4): the ZST case engine IS the personal engine over different tables. Same for the intake pattern.
4. **Read-first, write-gated.** Everything that touches the outside (send, bank write, label write) is deliberately deferred behind the write executor + per-payload approval — nothing sends autonomously.

## UPDATE (overnight, commits 387478b + 5a3d861)

- **Slice 1 write-half DONE** — approval-gated ZST send executor. Extracted the crash-safe outbound state machine to `executor-core.ts` (`makeExecutor(ledgerTable)`); personal executor delegates (39 send-stack tests green = zero regression). `zst-send.ts`: draft→approve(exact payload hash + recipient allowlist)→dispatch through the full gate (connector write-usable + ZST sensitivity + approval). Reuses the ZST write-scope OAuth (live). **9 AT-ZA tests green** (AT-ZA01/02/04/05/06/09/10 + happy path + reject). Nothing sends autonomously.
- **Slice 3/6 proactive DONE (read side)** — `zst-watch.ts` common due-item runner (§27): contract renewal/termination windows, license 30/60/90d renewals, obligations, decision-stage opportunities. Products seeded (MARV/QQ/ZSIB/WEB/SHARED, data-driven). Read APIs `/api/cos/zst-due` + `/api/cos/zst-business`. 4 tests. Live (22 zst_ tables, 5 products).

**Revised acceptance-test status:** AT-ZA01/02/04/05/06/09/10 now GREEN (send gates). AT-ZF01-04, AT-ZS01/02 green. Structural: all engine + send + finance + watch invariants tested.

## The honest remaining gap (why it is not "all done")

The full v1.1 STRUCTURE is now built, live, and tested — but the business tables are EMPTY, and filling them needs **data-extraction logic** that is a large, per-document-type effort, not an overnight job:
- Parse a ZST invoice email/PDF → `zst_invoices` fields (supplier, number, net/vat/gross, dates).
- Detect a contract/renewal from a thread → `zst_contracts`.
- Import a bank statement → `zst_bank_transactions`.
- Extract vendor/license/partner/opportunity facts from mail.
This is real NLP/parsing per source type; doing it hastily would be Potemkin. The engine is ready to receive the data the moment each extractor lands. Also deferred: the **Control Tower Sheet cutover** (an external Sheets write of currently-empty data — the `spreadsheets` scope is live, but writing empty projections has no value yet) and the mechanical CRUD helpers for the Slice 3-5 entities.

## What's next (in order)

1. **Radar price-watch engine** (Istvan's next ask): the missing product/procurement price-fetch + observation + notify orchestration (personal BUY-* radar and ZST procurement radar both need it).
2. **ZST Action Executor (send half):** generalize the proven personal executor/campaigns/dispatch-gate/quota to the zst namespace — safety-critical (real company email), built carefully with the AT-ZA gates, NOT rushed. OAuth is ready.
3. Slices 3-5 domain logic (renewal watch, vendor/license, partner/opportunity, product-lab gateway) — mechanical.
4. Slice 6 proactive + Control Tower Sheet cutover.
