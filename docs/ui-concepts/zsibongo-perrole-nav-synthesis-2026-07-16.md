# Zsibongó per-role mobile nav — SYNTHESIS (Istvan ChatGPT-5.6 + in-house gpt-5.6-sol)

Date: 2026-07-16. Two independent gpt-5.6 design runs merged. Sources:
- Istvan (ChatGPT-5.6): `docs/ui-concepts/zsibongo-perrole-nav-istvan-chatgpt-2026-07-16.html`
- In-house (uxuidesigner, gpt-5.6-sol high, 8451 tok): `agents/uxuidesigner/deliverables/2026-07-16-zsibongo-mobile-nav-gpt56sol-v2-4roles-desktop.md`

**Convergence:** both independently produced the SAME 4-role structure, the "state/exception vs operational" split, and the mobile-first-with-desktop-notes framing. High agreement = high confidence in the shape. Below is the merged proposal; the few real divergences are called out with a recommendation.

## Shared principle (both agree)
Not one shared bottom-nav with hidden items — a shared COMPONENT system with per-role priority, language, and primary action.

## 1. Fenntartó / üzemeltető — DESKTOP-PRIMARY on mobile a supervisory glance
- Bottom nav: **Áttekintés · Teendők/Eltérések · Működés · Üzenetek · Továbbiak**
- Primary one-tap: **"Mai eltérések"** (Istvan's crisp naming) → opens the critical/decision items (capacity, missing staff, KENYSZI/OJR deviation, expired doc, approval).
- Merge note: in-house's state/exception mobile framing + Istvan's domain depth. On MOBILE the nav is state-first (Áttekintés+Teendők); the domain areas Istvan surfaced (Megfelelés, Pénzügy, kapacitásmátrix, e-képviselő, riport) live under **Továbbiak** on mobile and become full left-nav workflows on DESKTOP (both agree the fenntartó is desktop-primary for finance/reports/capacity/e-képviselő).
- NOT in mobile nav: detailed finance/booking, capacity-matrix editing, e-képviselő report authoring, per-child daily log.

## 2. Gondozó / kisgyermeknevelő — MOBILE-PRIMARY, operation-centric
- Bottom nav: **Ma · Csoportom · Gyógyszer · Üzenetek · Továbbiak**
- Primary one-tap: **"+ Rögzítés"** floating quick-action on Ma (Istvan's idea — jelenlét/étkezés/alvás/jegyzet/gyógyszer in one fast menu, context-varying by time of day), WITH instant "Megérkezett/Távozott" toggle inline in the Ma névsor (in-house).
- **KEY MERGE DECISION:** keep BOTH the dedicated **Gyógyszer** nav tab (in-house) AND the "+Rögzítés" quick-action (Istvan). Rationale: meds are safety-critical and need a persistent "what's due + confirm + warning" surface, not only a record-action buried in a quick-menu; the quick-action handles the high-frequency multi-type recording. (Istvan's version folded gyógyszer into the quick-menu; I recommend surfacing it as its own tab for the safety-visibility.)
- NOT in nav: finance, normatíva/fenntartó reports, staff admin, telephely/org, helyettes-search, onboarding, separate Étkezés/Alvás/Gyógyszer top menus (the quick-action covers recording).

## 3. Egyéb — NOT one menu; split by actual role + assignment (in-house's stronger treatment)
### Helyettes — MOBILE-PRIMARY
- Bottom nav: **Ma · Jelenlét · Gyógyszer · Csoport · Üzenetek**
- One-tap: attendance toggle in the assigned group. Only the current shift's telephely/group/scope shown (narrower permission than gondozó; make telephely+csoport+felelősség explicit on Ma).
### Irodai admin — DESKTOP-PRIMARY
- Bottom nav: **Áttekintés · Teendők · Személyek · Üzenetek · Továbbiak**
- One-tap: open the next deadline/missing-data task.
- If someone is BOTH admin and helyettes: an explicit **role/mode switcher** (do NOT grow the bottom nav to 6–7 items). (in-house)

## 4. Szülő — MOBILE-PRIMARY (both agree)
- Bottom nav: **Gyermekem · Üzenetek · Étkezés · Befizetések · Továbbiak**
- One-tap: **"Lemondom"** on the next cancelable meal (with undo; after cutoff show a clear status instead of the button).
- Multi-child: child-switcher in the HEADER, not a separate nav item.
- NOT in nav: institutional group list, staff admin, capacity, compliance, e-képviselő, internal carer data entry.

## Desktop follow-up (both agree)
Mobile is the design target now; desktop is a fast-follow that REUSES these role priorities (desktop = superset). Desktop-primary roles (fenntartó, irodai admin) get the full workflow surfaces; mobile-primary roles (gondozó, helyettes, szülő) keep the same IA with more shown at once.

## The one decision for Istvan
Gondozó gyógyszer: **dedicated tab (recommended, safety) vs folded into the +Rögzítés quick-action (Istvan's version)**. Everything else converged. Recommend: dedicated tab.
