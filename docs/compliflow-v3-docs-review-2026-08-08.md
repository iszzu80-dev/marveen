# CompliFlow v3.0 dokumentumok — Marveen review + javaslat

**Dátum:** 2026-08-08
**Tárgy:** `compliflow-phase1-post-build-prd-valtoztatasi-ajanlas-v3.0.md` + `compliflow-phase2-tuzvedelem-phase1-postbuild-alapjan-v3.0.md`
**Kérés (Istvan):** "chekkold és javasolj, majd ha végeztél a CoS mérföldkővel [menjünk tovább ezekkel]."

> **KORREKCIÓ (2026-08-08, e review első kiadása után):** Az első kiadás §1-e azt állította, hogy a Phase 1 backend nincs perzisztálva a repóban ("false-done, elkallódott"). **Ez TÉVES volt** — csak a `/home/iszzu/marveen` repóban kerestem, és nem néztem meg, hogy a CompliFlow-nak SAJÁT repója van a `/home/iszzu/marveen-projects/compliflow`-ban (a DORA testvére). A Phase 1 M1-M8 build ott TELJESEN megvan és commitolva van (69 commit, tiszta working tree, 19 migráció 0001-0019 [10-ben RLS/FORCE RLS], 18 tesztfájl ~320 teszt, 14 route). A v3.0 docs "Phase 1 megépült" premisszája IGAZ. §1-et alább visszavontam; a stratégiai értékelés (§2-§7) áll.

---

## 0. Verdikt egy mondatban

A két dokumentum **stratégiailag kiváló, mint build-spec**, és az alapfeltevésük (**a Phase 1 lényegében megépült**, tehát sunk-cost-aware, additív, ne írjuk át, migráljuk a meglévő adatot) **HELYTÁLLÓ** — a build valóban kész és commitolva van a `marveen-projects/compliflow` repóban. A helyes lépés: **fogadjuk el a docs-ot a következő fejlesztési fázis specifikációjaként**, és a P0 korrekciók + horizontális platformréteg + expert-loop mentén építsünk rá, RLS-t és legal-gate-et végig komolyan véve.

---

## 1. ~~Kritikus lelet — a "Phase 1 megépült" premissza hibás~~ [VISSZAVONVA — a premissza IGAZ]

**VISSZAVONVA.** Az első kiadásban itt azt állítottam, hogy a Phase 1 backend nincs perzisztálva a repóban ("false-done, elkallódott munka"). Ez tévedés volt: **csak a `/home/iszzu/marveen` repóban + worktree-jeiben kerestem, és nem néztem meg, hogy a CompliFlow-nak saját dedikált repója van.**

A valóság (leellenőrizve `/home/iszzu/marveen-projects/compliflow`-ban):
- **Saját git repó** (a `marveen-projects/` a standalone termékeket tartja: compliflow, dora). 69 commit, `master`, tiszta working tree (0 nem-commitolt).
- **Teljes M1-M8 build history:** M1 employer profile + obligation map, M2 risk-assessment wizard + accident report, M3 employee/training, M4 equipment + inspection, M5 calendar + reminders, M6 dossier PDF, M7 document upload, M8 multi-tenant isolation guardrail.
- **19 migráció** (0001-0019), ebből 10-ben RLS/FORCE RLS (köztük a `0019_employer_profiles_rls` amit gate-eltem). **18 tesztfájl, ~320 teszt. 14 API route.** Fastify + TS + pg + withTenant RLS. Frontend proto + docs is a repóban. QA Postgres = pg-qa (5433).

**Következmény:** a docs "Phase 1 megépült / sunk-cost-aware / additív / ne írd át / migráld a meglévő adatot" keretezése **helytálló**. Nincs "recovery" teendő. A tanulság a MÓDSZEREMRŐL szól, nem a docs-ról: egy hiány-megállapítást minden lehetséges helyen ellenőrizni kell (standalone terméknél a `marveen-projects/<termék>` + saját git-history), mielőtt "elkallódott"-at mondok.

---

## 2. Ami stratégiailag helyes a docs-ban (fogadjuk el build-specként)

Ezek genuine jó döntések, nem gumibélyegzem őket — mindet megnéztem:

- **Horizontális platformréteg** (rule engine, `tenant_membership`, `compliance_task`, `review`, `audit_event`, `recurring_routine`, evidence) mint közös spine, amire a domainek (munkavédelem, tűzvédelem) ráülnek. Ez a helyes architektúra és a Phase 2 elő is feltételezi.
- **Applicability-driven tűzvédelem** ("állítsuk be, mi vonatkozik a telephelyre", nem "mindenki kitölti a szabályzat-wizardot"). Illik a magyar Ttv valósághoz + elkerüli a fölös wizardokat.
- **Routine vs deadline distinction** (napi üzemeltetői check → routine ledger; éves review/maintenance/drill → task+calendar). Elkerüli a 365 zöld naptár-entry falat. Erős product-instinct.
- **"Missing" vs "Not applicable" state-modell** (APPLICABLE/NOT_APPLICABLE/UNKNOWN/NEEDS_CONFIRMATION, és csak APPLICABLE-nél RECORDED/OVERDUE). Ez egyszerre platform-javítás ÉS jogi overclaim-védelem — nem nevez "hiányzónak" amit nem is kötelező.
- **Nincs compliance-score / "82% compliant" / "megfelel"** — helyes, kerüli a jogi felelősség-átvállalást.
- **Expert (szakember) mint first-class cross-tenant user, KIZÁRÓLAG explicit `tenant_membership` alapján** (nem `if role==safety_professional: allow all`). Security-helyes.
- **Nem versenyzünk a fiREG-gel vertikális mélységben** — reális pozicionálás, coexistence (external-managed responsibility modell).
- **Feature flag + kill switch domainenként** — egy domain rule-hibája ne állítsa le az egész terméket.

Az A–E `tuzveszelyessegi_osztaly` dropdown eltávolítása + source-aware klasszifikáció szintén helyes (az OTSZ nem ilyen egyszerű).

---

## 3. Kockázatok és hiányok, amiket hozzáteszek

1. **Állapot-audit ELŐSZÖR (nem blokkoló, de első lépés).** A Phase 1 kész és commitolva van (`marveen-projects/compliflow`), de a v3.0 P0 korrekciók (rule-versioning, lifecycle, copy) csak akkor pontosak, ha tudjuk milyen ÉRETTSÉGŰ ami kész: melyik M mock vs valós, teszt-zöld-e minden, RLS/FORCE minden tenant-táblán. Fél napos read-only audit a repón (§5) rögzíti ezt, hogy a hardening a valós hiányokra menjen.

2. **RLS a biztonsági kulcskő.** A cross-tenant expert-membership az EGYETLEN pont, ahol egy bug = ügyfelek közti adatszivárgás. Day-1-től FORCE RLS, a production-runtime role-lal tesztelve, cross-tenant leak RED-proofokkal. Ez a legmagasabb gate-szigor (ld. a DORA/RLS incidenseket: FORCE hiánya = leak).

3. **A rule-engine bevezetése valódi migráció (van mit migrálni).** A meglévő M1-M8-ban vannak hard-coded jogi ciklusok + a pg-qa-ban teszt-adat; a versioned `obligation_rule` bevezetése + a `rule_id/version/source/set_by` felvétele non-destruktív, reverzibilis, auditált migráció legyen (a docs helyesen írják). RED-proof: a meglévő deadline-ok megmaradnak történeti értékként, az újraszámolás csak validált rule alapján, ajánlásként.

4. **A legal gate KÜLSŐ, kemény függőség, nem checkbox.** A konkrét rule-content (intervallumok, applicability-küszöbök, Ttv/OTSZ/BM-rendelet szövegek) valódi tűzvédelmi szakember + szakjogász sign-offot igényel production előtt. Ezt korán kell beindítani (beszerzés/idő), különben launch-blocker lesz. A docs helyesen jelzik, de kezeljük timeline-tételként.

5. **Enforce a DATA rétegben, ne csak copyban.** A "nincs compliance-score" akkor biztos, ha a rendszer SOSEM SZÁMOL scoret (nem tud kiszivárogni, amit sose képez). A copy-tiltás önmagában UI-only gate = ismert bug-osztály (backend-enforcement nélkül megkerülhető).

6. **Scope-realizmus.** A P1 post-build P0 (13 tétel) + P1 (7) + a Phase 2 (24 increment) = több hónapos program. Ez rendben van, de kell egy RUTHLESS first-slice (lásd §5), nem az egész egyszerre.

---

## 4. Marveen-álláspont a Phase 2 §56 döntési pontjaira

1. Professional collaboration = platform capability → **IGEN.** Ez a Phase 2 elő is feltétele.
2. Applicability-driven Phase 2 → **IGEN.**
3. Szabályzat-wizard megmarad, egyedinél expert-workflow → **IGEN** (az M2 risk-wizard már kész, erre épül az expert-workflow).
4. Nem építünk fiREG-versenytársat mélységben → **IGEN.**
5. Napi/gyakori események routine ledgerbe → **IGEN.**
6. Tűzvédelmi szakember first-class → **IGEN**, RLS-keystone caveattal (§3.2).
7. Landlord/FM/external responsibility Phase 2 core → **IGEN.**
8. Dossier → scoped Export Center → **IGEN** (az M6 dossier PDF már kész, erre jön a scoped export).

Mind a 8-cal egyetértek irányként — a meglévő M1-M8-ra additívan.

---

## 5. Javasolt sorrend + első lépés (a CoS mérföldkő után)

**Első lépés (fél nap, read-only):** live állapot-audit a `marveen-projects/compliflow` repón → `audits/compliflow-phase1-state-audit.md`. Pontosan mi van kész és milyen érettségben (M1-M8 lefedettség, teszt-zöld, RLS/FORCE minden tenant-táblán, mi mock vs valós), hogy a v3.0 P0 korrekciók pontosan a valós hiányokra menjenek. (repo-audit-plan-doc mintám; a MISSING-eket a live ellen igazolom, most már a HELYES repóban.)

Utána a docs Increment-logikája jó:

- **F1 Increment 1 — Safe Core hardening:** rule-engine spine + rule versioning (a hard-coded jogi ciklusok kivezetése) + copy/claim korrekció + feature flags + kill switch + employee/equipment lifecycle + audit-minimum, a MEGLÉVŐ M1-M8 backendre additívan. Eredmény: a kész termék biztonságosan pilotolható.
- **F1 Increment 2 — Expert Loop:** safety_professional + `tenant_membership` + invitation + review workflow. **Ez egyszerre a Phase 1 kereskedelmi unlock ÉS a Phase 2 elő-feltétele → a legnagyobb tőkeáttétel, ezt priorizáljuk.**
- **F1 Increment 3 — Activation:** training import + onboarding expert-step + task-first dashboard.
- **F2 (tűzvédelem):** csak azután, hogy a platform-spine (membership+capability+rule+task+review+audit+RLS) éles és tesztelt. Applicability setup → general/custom path → fire training/equipment → operator vs professional maintenance → scoped export.

---

## 6. Nyitott döntések Istvannak

1. **Expert-first vs tűzvédelem-first** a Phase 1 hardening után (a docs expert-loop-first-et implikálnak, ezzel egyetértek, mert a P2 is ezt igényli).
2. **CompliFlow marad külön repóban** (`marveen-projects/compliflow`) vagy egy nagyobb suite alá kerül? Javaslatom: maradjon külön (saját 0001-0019 migration-sorozat, standalone, mint a DORA) — ez most is így van, nincs sürgős ok változtatni.
3. **Legal gate beindítása** — mikor keresünk tűzvédelmi szakembert + szakjogászt a rule-content validálásához (korán kell).
4. **Deploy/pilot cél:** mikor és hová deployoljuk az elkészült Phase 1-et (jelenleg csak lokálisan fut pg-qa ellen) — ez a "biztonságosan pilotolható" mérföldkő kimenete.

---

## 7. Egy mondatban

A Phase 1 valóban kész és commitolva van a saját repójában; a docs a helyes KÖVETKEZŐ fázist írják le kiválóan — **fogadjuk el őket a fejlesztési specifikációnak, és a meglévő M1-M8-ra építsük rá a P0 korrekciókat → platform-spine → expert-loop → tűzvédelem sorrendben, RLS-t és legal-gate-et végig komolyan véve.**
