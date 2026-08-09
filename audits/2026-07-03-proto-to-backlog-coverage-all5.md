# Proto → backlog coverage view (all 5 products)

Unified coverage of Istvan's hand-built prototypes vs the Phase-2 development backlog.
Assessed 2026-07-03 (evidence-based). This is the single cross-product view that was previously missing
(the AC-coverage matrices covered only 4 protos; DORA was reviewed separately; the two Esküvő tracks were never cross-referenced).

## Summary table

| Product | Proto source | Systematic feature extraction | Mapped to backlog | Verdict |
|---|---|---|---|---|
| MikroKönyv | `mikrokonyv-proto-thick/` | AC matrix §1 (MK-1..11), persona §1, proto-finomító, QA mk-domshim 22/22 | Phase-2 scope §1, arch spec §1, kanban 72210b8e | **FULL** |
| QuickQuote | `quickquote-proto-thick/` | AC matrix §2 (QQ-1..12), persona §2, QA qq-domshim 8/8 + qq-blockers 29/29 | Phase-2 scope §2, kanban b200539d | **FULL** (photo/voice = conscious defer) |
| Bölcsi/Zsibongó | `bolcsi-proto-thick/` | AC matrix §4 (ZS-1..20), tier-mapping, feature-tiers, QA bolcsi-domshim 17/17 + 2 feature-verify | Phase-2 scope §3, kanban 6a6f6d40 | **FULL** (deepest) |
| Esküvő/LumaSeat | 3 fleet protos + Istvan's seating-AI original | 2 non-reconciled tracks (thick-proto AC §3 + seating-AI elemzés) | **PARTIAL** — deepest solutions analyzed, not carded | **PARTIAL → being closed** |
| DORA | OneDrive SPA + `shared-dev/dora-app/` | dora-proto-review (18 features, PORT/FRESH lists, gap matrix) | Phase-2 scope §5, kanban 73bffd28 | **FULL** (most rigorous mapping) |

## Overall verdict

4 of 5 (MK, QQ, Bölcsi, DORA) are systematically reviewed AND mapped into the Phase-2 backlog through a documented, independently-verified chain (AC matrix → persona → proto-finomító → QA domshim/feature-verify → Phase-2 scope → architecture spec → kanban). Esküvő was the single gap: most proto material, least uniform mapping.

## Esküvő gap closure (Istvan GO 2026-07-03)

The deepest Esküvő proto solutions were analyzed (`agents/business/deliverables/2026-06-28-eskuvo-proto-elemzes-MVP-first.md`, `2026-06-28-eskuvo-feature-tiers.md`) but had no build cards. Created 2026-07-03 (project=Eskuvo, assignee=architect for tech spec → build):

- **ea18817f** — roomAnalysis physical-constraint engine (chair-pullout, service corridor, emergency-exit blocking, nominal-vs-actual capacity). *high*
- **2b8dccf4** — AiProposal auto-move/rebalance seating engine (beyond generic AI-explain). *high*
- **0fdd8072** — export/add-on catalog A1-A4 (AI) + N1-N8 (non-AI: QR/NFC cards, table-number generator, vendor exports, handover-ZIP, multilingual). *normal*
- **66d90b14** — teremtervező floorplan-AI / DXF import + v3 multi-table view + venue objects. *low*

Still open (spec-level, for architect/business): reconcile the RSVP-first (EW1-A) vs seating-AI-first MVP framings into one Esküvő backlog; resolve the coverage-matrix EW1 "Spec-frissítési igények" (per-microservice paywall AC, export-artifact spec, à-la-carte UX).

## Note

DORA is absent from the AC-coverage matrices (entered after 2026-06-24) but has its own dedicated, arguably superior proto-review, so this is not a real gap. This document now provides the end-to-end proto→backlog completeness assertion across all five that no single prior document carried.
