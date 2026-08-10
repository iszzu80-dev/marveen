# ZST Radio Kft. Chief of Staff v1.1 — Feasibility & Implementation Analysis (v2, revised)

**Date:** 2026-08-06 · **Analyst:** Marveen · **Spec:** marveen-zst-radio-chief-of-staff-v1.1 (greenfield)
**Baseline the spec cites:** Personal Chief of Staff v4.2 + v4.2.1 — *now fully built and live* ([[cos-slice0-case-store-build]]).

> **v2 changes (after review with Istvan, msgs 7919-7923):** (1) The heavyweight **Scope Gate is removed** — ZST is a *separate Google account* and the mailbox is *purely ZST*, so connector identity is the physical boundary; what remains is a thin internal Operations/Product routing tag, not an isolation gate. (2) **Products are data-driven** (`zst_products` table), not a hardcoded enum — the list will grow. (3) The **ZST landing website** is placed (Slice 4/5: a tracked web-property, and an automatic lead source *if* its form emails the ZST inbox). These shrink Slice 0 and the whole program.

## Verdict

**Feasibility: HIGH, and the scope is smaller than the spec implies.** Two independent reasons:

1. **The engine already exists.** The spec's §3 matrix marks most of the correctness machinery `MISSING`/`VERIFY`, but its author did not know the personal COS build already landed those exact primitives. Against the real `src/cos/` tree, **~90% of the hard correctness machinery exists** (state machine, versioning, claim/fencing, Action Executor + outbound ledger, campaign/approval store, Gmail batch/checkpoint/quarantine, sensitivity fail-closed, radar, connector-health + adapter-contract, atomic quota, backup/retention, per-tool timeout).
2. **The scope boundary is free.** The spec front-loads a large Scope Gate to keep PRI/ZST/ONE apart. But ZST runs on a *separate Google account* (`google-zst` connector) and the ZST mailbox is *purely ZST* (confirmed by Istvan). So "no personal data in ZST store" (AT-ZS01) is guaranteed **at the source by which connector ingested the data**, with no classifier. ONE has no connector wired at all, so it cannot be auto-ingested. The Scope Gate collapses to a thin routing tag.

**This is still a multi-slice program** (Slice 0-6, business domains: finance/banking/contracts/procurement/commercial/product-lab) — not a session. But the foundation is a *generalization* of the live personal engine plus new business tables, and **Slice 0 is buildable immediately with no write scopes and no consent.**

## Requirement → real-capability matrix (corrects spec §3 against the actual repo)

| Spec capability | Spec label | REAL status | Evidence in repo |
|---|---|---|---|
| Corporate Case Engine | MISSING | **EXISTS (personal)** → generalize | `case-store.ts`, `personal_cases`/`_events`/`case_claims`, version + claim/fencing |
| Action Executor (single external writer) | MISSING/ÚJ | **EXISTS (personal)** | `executor.ts`, `outbound_ledger` (PLANNED→SENDING→APPLIED_UNVERIFIED→VERIFIED, OUTCOME_UNKNOWN) |
| Campaign & Approval Store | ÚJ | **EXISTS** | `campaigns` + `campaign_approvals`, `send-flow.ts`, `rendered_payload_hash`, `template_hash` |
| Gmail batch/checkpoint ledger | MISSING | **EXISTS** | `email_processing` + `email_processing_batches` + `email_source_checkpoints`, `email-ingest.ts` (batch/cursor/quarantine) |
| Static Sensitivity Gate + fail-closed | ÚJ | **EXISTS (personal)** | `sensitivity.ts`, `dispatch-gate.ts`, `CASE_SENSITIVITIES` (UNKNOWN→highest) |
| Procurement/vendor radar | MISSING | **EXISTS (personal shopping)** → generalize | `radar.ts`, `radar_items`/`radar_observations`, FX + notify-dedup |
| Connector health + adapter contract | VERIFY | **EXISTS** | `connector-health.ts`; `gmail-api-transport.ts` = prepare/execute/readback/verify + searchable marker |
| Per-tool timeout | VERIFY | **EXISTS** | `TOOL_TIMEOUTS` |
| Backup / retention / store-security | ÚJ (§29) | **EXISTS** | `backup.ts`, `retention.ts`, `store-security.ts` |
| Atomic quota reservation | (§10.5) | **EXISTS** | `send_quotas`, `quota.ts` |
| ~~ZST Scope Gate (PRI/ZST/ONE isolation)~~ | MISSING | **NOT NEEDED as isolation** — account identity is the boundary | separate `google-zst` connector; pure ZST mailbox; no ONE connector exists |
| ZST Operations/Product routing tag | (part of §4) | **THIN NEW** (a classifier, not a gate) | small; tags a case OPERATIONS vs PRODUCT_LAB for routing/label |
| **Finance/contract/vendor/commercial/bank tables** | MISSING | **MISSING** (new tables) | new CRUD *on top of the existing case engine* |
| **Product Lab Gateway** (escalation) | MISSING | **MISSING** | new |
| ZST Product portfolio | (§24) | **NEW as a TABLE, not an enum** | `zst_products` with seed rows (MARV/QQ/ZSIB/WEB/SHARED); add a product = INSERT, no code change |
| **ZST Gmail/Calendar/Drive WRITE** | VERIFY | **READ-ONLY — hard dependency** | `google-zst-mcp.py` exposes only gmail_read/search, calendar list, drive_search |
| Google Sheets projection (Control Tower) | VERIFY | **MISSING** | no sheets tool in the ZST connector |
| GitHub read/write | VERIFY | **PARTIAL** | `gh` CLI available fleet-wide, not in the ZST connector |

## The genuinely-new work (revised, smaller)

1. **Business domain tables + logic** — invoices, accounting packages, bank reconciliation (read-only), contracts/obligations, vendors/licenses, partners/opportunities, `zst_products` (data-driven), procurement radar (generalize the shopping radar). New *tables and CRUD*, hanging off the case engine that already exists.
2. **Product Lab Gateway** — the ZST↔product-work escalation bridge (§23), projection-not-duplication of GitHub/PRD/backlog.
3. **ZST Mission Control views + Control Tower Sheet projection** — new dashboard views + a Sheets writer (no sheets capability on the ZST connector today).
4. **Thin Operations/Product routing tag** — replaces the Scope Gate; a lightweight classifier for case-type/label, not an isolation gate.

*(The Scope Gate as a security component is gone. Sensitivity tagging remains, but it already exists in the personal COS.)*

## Landing website placement

The ZST Radio landing site is **not** a Slice 0 concern. It lands in two places later:
- **Web-property record** — domain, hosting, cost → tracked in the `zst_vendors`/`zst_licenses`/`zst_products` tables (Slice 3/5).
- **Lead source (only if wired)** — *if* the landing's contact form emails the ZST mailbox, those leads flow through the **existing email ingest** and become ZST commercial-opportunity cases automatically (Slice 4). If the form is static / posts elsewhere, it is just a web-property to track. No new monitoring infra needed either way.

## Hard dependency / blocker (Istvan-gated, unchanged)

**`google-zst-mcp.py` is READ-ONLY.** Every ZST *external action* (Slice 1 accounting-package send, drafts, calendar invites, doc sharing, Sheets projection) needs WRITE scopes → an OAuth consent flow, like the personal Gmail-send re-auth. **Slice 0 needs none of this;** the write-scope consent gates Slice 1's first external write.

## Architecture recommendation (Istvan's call)

**Separate `zst_*` table namespace, SHARED engine code.** Parameterize the existing case-store/executor/email-ingest/radar over the table set, so business rows are *physically* separated from personal rows (clean, matches the spec's §6 table list) while the state-machine/fencing/executor logic is written once. This satisfies both the spec's table layout and principle #4 (reuse primitives, no parallel platform). The alternative (reuse `personal_cases` with a `scope` column) is DRY-est but mixes personal and business rows in one table — with the account already separating ingest, the physical-table split is the cleaner honest boundary.

## Slice plan (revised)

- **Slice 0 — now, no write scopes, no consent:** repo/deployment/connector audit (done, this doc) → `zst_cases` + `zst_case_events` + claim/fencing (generalized engine) → thin Operations/Product routing tag → static ZST sensitivity policy (reuse) → Mission Control "Ma"/"ZST Ügyek" (read-only) → backup base. **Buildable immediately.**
- **Slice 1 — after write-scope consent:** Gmail batch/checkpoint + Action Executor on ONE real pilot (accounting-package prepare→approve→send→readback). Proves the outbound spine end-to-end.
- **Slice 2:** invoices + duplicate detection + accounting package + bank read-only reconciliation.
- **Slice 3:** contracts/obligations/renewal-watch + vendors/licenses + procurement radar.
- **Slice 4:** partners + opportunities + commercial campaign + pricing/legal hard gates (+ landing-lead intake if wired).
- **Slice 5:** Product Lab gateway + `zst_products` portfolio projection (+ landing web-property).
- **Slice 6:** proactive completeness (daily reconcile, weekly review, monitoring, Control Tower Sheet cutover, autonomy switches).

Each slice DoD per spec §31: code + migration + API + UI + unit/integration test + run evidence + rollback + ops doc.

## Recommendation

Approve **separate namespace / shared engine**, and let me build **Slice 0 now** (no consent, no external action). Run the ZST write-scope OAuth consent when you're ready so Slice 1's pilot can execute. Nothing marked "done" that is prompt-only or mock (spec §33 #31); nothing goes out on ZST's behalf without your approval.
