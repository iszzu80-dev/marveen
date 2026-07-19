# MK launch — APPROVED framework (Istvan GO, 2026-07-17)

Source proposal: `docs/mk/mikrokonyv-launch-modositasi-javaslatok-v2.md` (Istvan). Approved framework below (marveen recommendation, Istvan "Go" 2026-07-17).

## The decision
Adopt the QQ-style model (build fully launch-ready → controlled trial with a few entrepreneurs → full launch), **with one MK-specific rule** because an MK tax-error (user pays wrong amount to NAV) is high-stakes and not editable like a QQ quote:

1. **Broad build for the trial:** pull the "post-launch" life-situations into the BUILD scope now (80/90% költséghányad, évközi indulás, nyugdíjas/tanuló, szüneteltetés eleje), so the trial exercises the full feature set.
2. **Path-by-path validation-gated "green":** a life-situation path only shows a concrete tax number when ITS OWN golden matrix is accountant-validated. Until then → safe block with a solvable, human-language task. No non-validated tax number ever leaks (supported: főfoglalkozású folyamatos EV + ≥36h munkaviszony melletti EV @ 45% first).
3. **Safety architecture = non-negotiable floor:** versioned 2026 `tax_rule_profile` (VALIDATED status), data-coverage status (Teljes/Ellenőrzést igényel/Hiányos), explainability (every number traceable to bevétel + hatályos szabály), accountant review pack (1-button), auditable change log, NAV rule-change watcher + kill switch / `validated:false` revert.
4. **Reframe:** "NAV auto-pull kalkulátor" → "Átalányadózási kontrollközpont" (teljesség + magyarázhatóság + biztonságos blokkolás). Landing must NOT claim equal depth for all life-situations.
5. **Trial:** első negyedéves zárás ingyen, max 60 nap (not 1 month — the 2658 is quarterly; 1 month misses the close). Success = NAV-kapcsolat + teljes profil + első ellenőrzött eredmény + első teendő + könyvelői csomag/negyedéves zárás. Price 3 500 Ft/hó unchanged.
6. **Full public launch** gated on the doc's go/no-go checklist (3 könyvelő reviewed, 100+ számítási eset összevetve, 0 kritikus eltérés, 20-30 valódi EV, minden support/incident/kill-switch kész).

## Ownership (dispatch 2026-07-17)
- **architect** — CRITICAL PATH foundation: versioned `tax_rule_profile` component (jurisdiction/tax_year/effective_from/to/status/validated_by/source_refs/formula_version/golden_test_suite_version); path-by-path validation-gating mechanism (green-shows-number only if that path's golden matrix VALIDATED, else safe-block); NAV rule-change watcher + kill switch / `validated:false` revert. Everything "green" depends on this.
- **qa** — the accountant-validated golden test matrix expanded to the broad life-situations (owns MK-QA golden + blocking suites; the go/no-go gate is qa's validation authority). 100+ case comparison; 0 critical deviation.
- **deliverylead** — COORDINATE: break framework into cards + assign product/UX/build owners; own the accountant design-partner channel (3-5 accountants as validators/referral, NOT primary users) + controlled pilot (20-30 EV, ≥2 quarterly closes) + the go/no-go gate.
- **product/business + uxuidesigner** — positioning reframe; 5-question eligibility quickscreen + layered onboarding ("Miért kérdezzük?" microcopy); dashboard 4-question trust cockpit (Teljesek az adataim / Mennyit tegyek félre / Mi a következő teendő / Megbízható az eredmény); blocked-result-as-solvable-task UX; KATA-comparator repositioned to landing/lead-gen; launch analytics (14 events + primary KPI: % reaching full-coverage verified result within 7 days).
- **frontend/fullstack** — implementation once architecture is set.

## Explicitly deferred/out (per doc)
Full accounting-program direction; unlimited-life-situation claim; automatic bank categorization; non-validated kedvezmények as numbers; szüneteltetés/ellátások without test matrix; automatic bevallás submission; categorical tax advice; ágazati pótlék (not MK-domain, see agazati-potlek-belongs-to-bolcsi); generic AI-chat as a main feature.
