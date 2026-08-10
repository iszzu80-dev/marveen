# CompliFlow Phase 2 – Tűzvédelem scope-javaslat a Phase 1 post-build architektúrájára építve

**Verzió:** 3.0  
**Dátum:** 2026-08-08  
**Bázisok:**
- `2026-07-31-compliflow-f1-requirements-spec.md`
- `compliflow-phase1-post-build-prd-valtoztatasi-ajanlas-v3.0.md`
- `2026-08-08-compliflow-f2-requirements-spec.md`
- Phase 1 és Phase 2 piaci / versenytársi / jogi critique

**Cél:** meghatározni, hogyan épüljön a tűzvédelmi Phase 2 a már megépült Phase 1-re és a Phase 1 post-build hardening során bevezetendő horizontális platformrétegre.

> **Alapelv:** Phase 2 ne egy második, különálló compliance-terméket építsen. A tűzvédelem legyen az első valódi bizonyíték arra, hogy a CompliFlow közös platformmodellje több szabályozási domainre újrahasznosítható.

> **Jogi megjegyzés:** a dokumentum termék- és architektúra-ajánlás, nem tűzvédelmi szakvélemény. A konkrét applicability-, ciklus-, jogosultsági és dokumentumtartalmi szabályokat production előtt szakjogász és megfelelő tűzvédelmi szakember validálja.

---

# 1. Executive recommendation

A tűzvédelem **jó Phase 2 domain**, de az eredeti F2-specifikációt nem javasolt változtatás nélkül megépíteni.

A Phase 1 post-build stratégia után a CompliFlow alapmodellje:

```text
RULE
  ↓
APPLICABILITY
  ↓
TASK / RECURRING ROUTINE
  ↓
OWNER
  ↓
EXPERT
  ↓
EVIDENCE
  ↓
REVIEW
  ↓
AUDIT
  ↓
DOSSIER / EXPORT
```

A tűzvédelemnek ugyanerre kell ráülnie.

## 1.1 Mit jelent ez?

Phase 2-ben **nem újraépítjük**:

- a felhasználókezelést;
- employee registryt;
- dokumentumtárat;
- import engine-t;
- calendar/reminder engine-t;
- task engine-t;
- expert membershipet;
- review workflow-t;
- audit logot;
- dossier engine-t;
- RLS-t.

Ezek Phase 1 platform capability-k.

Phase 2 elsősorban hozzáadja:

1. a **tűzvédelmi rule/applicability contentet**;
2. a **tűzvédelmi szakember capability-ket**;
3. a **tűzvédelmi oktatási record type-okat**;
4. a **tűzvédelmi eszköz és üzemeltetési eseményeket**;
5. az **egyedi / általános tűzvédelmi szabályzat workflow-t**;
6. a **Tűzriadó Terv / gyakorlat workflow-t**, ahol releváns;
7. a **tűzvédelmi evidence és export scope-ot**.

## 1.2 A legfontosabb stratégiai különbség az eredeti F2-höz képest

**Eredeti F2:**

> Tűzvédelem = új wizard + új training + új equipment cycles + calendar + dossier.

**Javasolt F2:**

> **Tűzvédelem = applicability-driven domain layer a CompliFlow közös expert/task/evidence platformján.**

---

# 2. Miért jó Phase 2 a tűzvédelem?

A Phase 1 után a CompliFlow még értelmezhető úgy, mint egy munkavédelmi SaaS.

A második domain után viszont először válik hitelessé a platformtézis:

> **„Nem egy munkavédelmi alkalmazás vagyunk, hanem a vállalat ismétlődő compliance-operációjának közös rendszere.”**

A tűzvédelem jó második domain, mert sok alapentitás közös:

| Platform entitás | Munkavédelem | Tűzvédelem |
|---|---|---|
| Company | igen | igen |
| Site | igen | igen |
| Employee | igen | igen |
| Training | igen | igen |
| Equipment | igen | igen |
| Expert | igen | igen |
| Task | igen | igen |
| Recurrence | igen | igen |
| Evidence | igen | igen |
| Document | igen | igen |
| Review | igen | igen |
| Audit | igen | igen |
| Dossier/export | igen | igen |

A domain-specifikus szabályok különböznek, de a működési modell ugyanaz.

Ez a platformismétlődés a Phase 2 legfontosabb sikerkritériuma.

---

# 3. Phase 2 stratégiai design principle

## 3.1 Nem „mindent mindenkinek”

A tűzvédelmi követelmények nem azonosak minden munkáltatónál.

Ezért F2 első képernyője ne:

> „Készítsd el a Tűzvédelmi Szabályzatodat.”

hanem:

> **„Állítsuk be, milyen tűzvédelmi működés vonatkozik erre a telephelyre.”**

A rendszer először applicabilityt kezel.

## 3.2 Nem „fiREG-lite”

A CompliFlow ne próbáljon a tűzvédelmi eszköz-karbantartás legmélyebb vertikális rendszerévé válni.

A fiREG már:

- karbantartói Expert terméket;
- vállalati Enterprise terméket;
- eszköznyilvántartást;
- üzemeltetési naplót;
- telephely-megosztást;
- beépített rendszereket;
- helyszíni/karbantartói működést

kezel.

A CompliFlow előnye ne az legyen:

> „jobb tűzoltókészülék-karbantartó rendszer”.

Hanem:

> **„a tűzvédelmi feladatot ugyanabban a vállalati compliance rendszerben látod, ahol a munkavédelmet és később a többi domain-t is.”**

## 3.3 Expert-first, nem expert-later

A Phase 1 post-build iránnyal összhangban:

**tűzvédelmi szakember Phase 2-ben first-class user.**

Nem pusztán design partner.

---

# 4. A Phase 1 horizontális platformréteg, amire F2 épít

A Phase 2 csak akkor induljon el érdemben, ha a következő Phase 1 post-build capability-k legalább minimum szinten rendelkezésre állnak.

## 4.1 Required platform dependencies

### Tenant membership

```text
tenant_membership
```

### Professional capability model

```text
professional_capability
```

### Compliance task

```text
compliance_task
```

### Review

```text
review
```

### Rule engine

```text
obligation_rule
```

### Audit

```text
audit_event
```

### Evidence/document

meglévő document library + versioning.

## 4.2 Nem blocker minden Phase 1 hardening

Nem kell megvárni például:

- advanced expert cockpit;
- partner billing;
- white label;
- multi-site UI;
- advanced dossier designer.

A minimum horizontális platform elég.

---

# 5. Professional model – Phase 2 capability extension

Ne legyen külön „munkavédelmi user” és „tűzvédelmi user” adatmodell.

## 5.1 User

```text
user
```

## 5.2 Tenant membership

```text
tenant_membership
  tenant_id
  user_id
  role
```

## 5.3 Capability

```text
professional_capability
  user_id
  capability
  verification_status
  valid_from
  valid_to
  evidence_document_id
```

Példák:

```text
WORK_SAFETY
FIRE_SAFETY
FIRE_REGULATION_PREPARATION
FIRE_EQUIPMENT_MAINTENANCE
FIRE_ALARM_MAINTENANCE
```

## Miért?

Mert ugyanaz a szolgáltató több területet is elláthat, de nem szabad automatikusan feltételezni, hogy minden capabilityvel rendelkezik.

---

# 6. Új F2-M0 – Fire Applicability Setup

Ez legyen a Phase 2 belépési pontja.

## Story

> Mint munkáltató, szeretném megadni a telephelyem tűzvédelmi működéséhez szükséges alapadatokat, hogy a CompliFlow csak azokat a tűzvédelmi workflow-kat jelenítse meg, amelyek nálunk relevánsak.

## Cél

Nem compliance judgment.

Hanem:

- adatgyűjtés;
- rule matching;
- rendszerjavaslat;
- employer/expert confirmation.

## Javasolt input

A végleges mezőlista jogi validációt igényel, de termékoldalról például:

```text
employee_count
site_occupancy
premises_type
commercial_accommodation_capacity
special_activity_flags
limited_mobility_persons_present
fire_alarm_present
fire_extinguishing_system_present
safety_lighting_present
fire_extinguishers_present
fire_risk_document_available
existing_fire_regulation_available
existing_fire_drill_plan_available
landlord_or_facility_managed_fire_systems
```

## Output

Nem:

> „100%-ban ez vonatkozik rád.”

Hanem:

```text
APPLICABILITY CANDIDATES

- General fire regulation path
- Individual fire regulation path
- Fire safety training
- Recurrent annual training candidate
- Fire drill plan candidate
- Extinguisher operation
- External building-managed systems
```

Mindenhez:

```text
rule_source
rule_version
status
confirmed_by
```

---

# 7. Saját Tűzvédelmi Szabályzat vs Általános Tűzvédelmi Szabályzat

Ez legyen az F2 egyik fő UX-ágazása.

A hatályos Ttv. a saját szabályzat-kötelezettséget feltételekhez köti; többek között a munkavállalói létszám, a helyiség befogadóképessége és bizonyos szálláshelyi működés is releváns lehet. Az erre nem kötelezett kör esetében az általános tűzvédelmi szabályzat logikája releváns.

## 7.1 Path A – General Regulation

### Célcsoport

Az applicability szerint saját szabályzatra nem kötelezett ügyfél.

### UX

Ne vezessük végig egy hosszú szabályzat-generáló wizardon.

Mutassuk:

> **„A megadott adatok alapján nálatok várhatóan az általános tűzvédelmi szabályzat szerinti működés releváns. Szakemberrel ellenőrizheted ezt a besorolást.”**

Capability:

- current rule reference;
- acknowledgment;
- employee access / training evidence;
- site-specific operational data;
- equipment/task tracking.

### Expert CTA

> „Kérem szakember ellenőrzését.”

---

# 8. Path B – Individual Fire Regulation

Az egyedi Tűzvédelmi Szabályzat wizard **megmarad**, de expert-assisted workflow-vá válik.

## 8.1 Employer intake

A munkáltató összegyűjti a tényadatokat.

## 8.2 CompliFlow draft

A wizard strukturált draftot készít.

## 8.3 Professional review/preparation

A megfelelő capabilityvel rendelkező szakember:

- áttekinti;
- módosítja;
- kiegészíti;
- saját szakmai adatait rögzíti.

## 8.4 Finalization

A dokumentum csak a megfelelő lifecycle után lesz:

```text
FINALIZED
```

## State machine

```text
DRAFT
GENERATED_DRAFT
READY_FOR_PROFESSIONAL
IN_PROFESSIONAL_REVIEW
CHANGES_REQUESTED
PROFESSIONALLY_PREPARED
ISSUED_BY_EMPLOYER
SUPERSEDED
```

Ez sokkal jobban illik a Phase 1 review modellhez.

---

# 9. A tűzvédelmi wizardból kiveendő A–E osztályozás

Az eredeti F2 A–E `tuzveszelyessegi_osztaly` modellt használ.

Ezt **nem javasolt továbbvinni**.

A jelenlegi OTSZ kockázati osztálylogikája nem ilyen egyszerű A–E employer dropdown.

## Javasolt modell

```text
fire_risk_classification
  classification_value
  classification_system
  source_document_id
  classified_by_user_id
  classification_date
  rule_version
```

A Phase 2:

- képes meglévő értéket tárolni;
- dokumentumhoz kötni;
- expert által rögzíteni;
- később workflow-ban felhasználni.

Nem kell az employerrel műszaki klasszifikációt végeztetni.

---

# 10. Fire Training – a Phase 1 training engine kiterjesztése

Nem új training engine.

## 10.1 Existing employee entity

Ugyanaz az employee.

## 10.2 Training domain

```text
domain = FIRE_SAFETY
```

## 10.3 Training rule source

A tűzvédelmi ismétlődés ne legyen minden rekordnál hard-coded `+1 year`.

```text
training_date
next_due_date
rule_id
rule_version
set_by
evidence_document_id
```

## 10.4 Applicability

A rendszer csak olyan ismétlődést generáljon automatikusan, amelyhez:

- validált rule;
- applicability;
- vagy expert-set schedule

tartozik.

---

# 11. Training UX – unified employee timeline

Ez az egyik legerősebb cross-domain payoff.

Employee detail:

```text
Kovács Béla

TRAINING HISTORY
────────────────────────────────────
2026-06-12  Munkavédelem
2026-04-03  Tűzvédelem
2025-06-14  Munkavédelem
2025-04-05  Tűzvédelem
```

Filter:

- All
- Work Safety
- Fire Safety

A Phase 2 nem készít második employee registryt.

---

# 12. Training import – Phase 1 import engine reuse

A Phase 1 post-build ajánlás training importot ad hozzá.

A Phase 2 ugyanazt használja.

## Egyetlen import schema

```text
employee_identifier
domain
training_type
training_date
next_due_date
provider
notes
```

Domain:

```text
WORK_SAFETY
FIRE_SAFETY
```

Ez fontos platformteszt:

> **nem kell külön „tűzvédelmi importot” építeni.**

---

# 13. Fire Equipment – scope

A tűzvédelmi eszközmodul szükséges, de Phase 2-ben tudatosan sekélyebb legyen, mint a fiREG.

## Phase 2 core equipment

### Tűzoltó készülék
**CORE**

### Fire alarm
**REFERENCE / EXTERNAL-MANAGED CAPABLE**

### Safety lighting
**REFERENCE / EXTERNAL-MANAGED CAPABLE**

## Továbbiak

- smoke extraction;
- sprinkler;
- fire doors;
- lightning protection;
- hydrants;

adatmodellben támogathatók, de csak validált igény alapján kapjanak mély workflow-t.

---

# 14. Equipment responsibility model

A Phase 2-ben minden tűzvédelmi assethez legyen kezelési felelősség.

```text
responsibility_scope
```

Értékek:

```text
EMPLOYER
LANDLORD
FACILITY_MANAGER
EXTERNAL_SERVICE_PROVIDER
SHARED
```

Továbbá:

```text
managed_externally
provider_name
provider_contact
external_system_reference
```

## Miért?

Sok KKV bérelt épületben működik.

A CompliFlow-nak nem kell olyan maintenance workflow-t generálnia, amelyet valójában a landlord/FM végez.

---

# 15. Tűzoltó készülék: két külön workflow

Ne legyen minden `inspection_record`.

## 15.1 Operational Check

Employer-side recurring task.

```text
FIRE_EXTINGUISHER_OPERATOR_CHECK
```

Owner:

- employee;
- facility person;
- admin.

Evidence:

- checklist;
- timestamp;
- optional photo;
- note.

## 15.2 Professional Maintenance

External professional/service-provider event.

```text
FIRE_EXTINGUISHER_MAINTENANCE
```

Evidence:

- maintenance record;
- provider;
- certificate / log;
- date;
- next date/source.

A jogszabály külön kezeli a készenlétben tartói ellenőrzést és a jogosult karbantartó által végzett karbantartást; a termékmodellnek is ezt kell tükröznie.

---

# 16. Fire extinguisher recurrence – ne generáljunk hamis határidőt

Az eredeti F2 több ciklust automatikusan commissioning date-ből számol.

Ezt nem javasolt változatlanul átvenni.

## Required date model

```text
manufacture_date
placed_in_service_date

last_operator_check
last_basic_maintenance
last_medium_maintenance
last_full_maintenance
```

Plusz:

```text
date_source
source_document_id
set_by
```

## Onboarding

Ha nincs elég információ:

> **„A következő karbantartási dátum nem számítható megbízhatóan a megadott adatokból. Add meg a legutóbbi karbantartás dátumát, vagy töltsd fel a dokumentumot.”**

Ez jobb, mint egy látszólag pontos, de hibás deadline.

---

# 17. Rule engine fire extension

A Phase 1 `obligation_rule` táblája legyen domain-agnostic.

Példa:

```text
domain = FIRE_SAFETY
obligation_type = FIRE_EXTINGUISHER_OPERATOR_CHECK
```

Rule fields:

```text
effective_from
effective_to
trigger_type
interval
legal_source
applicability_expression
professional_capability_required
version
```

A tűzvédelmi ciklusok ne külön hard-coded TypeScript feltételek legyenek.

---

# 18. Routine vs deadline – új platform distinction

Ez a Phase 2 egyik fontos platformtanulsága.

Nem minden ismétlődő eseményt kell calendar eventként kezelni.

## 18.1 Deadline

Példák:

- éves review;
- professional maintenance;
- fire drill;
- training renewal.

→ `compliance_task` + calendar.

## 18.2 Routine

Példák:

- napi rendszerellenőrzés;
- gyakori üzemeltetői check.

→ `recurring_routine`.

## Új entity

```text
recurring_routine
  id
  tenant_id
  domain
  title
  frequency
  owner
  source_entity
  active
```

Completion:

```text
routine_completion
  routine_id
  date
  completed_by
  evidence
```

## Dashboard

Ne legyen 365 zöld calendar entry.

Mutassuk:

> Napi tűzjelző ellenőrzés  
> Ma: kész / nincs rögzítve  
> Utolsó 7 nap: 7/7

Csak exception kerüljön az attention listába.

---

# 19. Tűzvédelmi Üzemeltetési Napló

Jó döntés, hogy ne külön kézzel szerkesztett wizard-dokumentum legyen.

## Javaslat

Derived view/export:

```text
FIRE OPERATIONS LOG
```

Forrás:

- operator checks;
- routine completions;
- maintenance events;
- related evidence;
- provider information.

A CompliFlow eseményt tároljon; a naplót abból állítsa elő.

Ez pontosan illeszkedik az evidence-first architektúrához.

---

# 20. Tűzriadó Terv

Az eredeti Phase 2 text-only subsectionként kezeli.

Javasolt:

## Applicability-driven

Először:

```text
FIRE_DRILL_PLAN_APPLICABLE?
```

## Ha nem

Nincs fölösleges wizard.

## Ha igen

Phase 2-ben:

- existing document upload;
- expert preparation/review task;
- versioning;
- acknowledgment;
- annual/required drill task;
- evidence.

## Amit Phase 2-ben nem kell

Grafikus alaprajz-editor.

Ha jogilag szükséges plan van:

> upload / professional workflow.

---

# 21. Fire Drill workflow

Ez legyen explicit recurring task.

```text
fire_drill
  site_id
  plan_version_id
  scheduled_date
  performed_date
  responsible_user
  professional_user
  evidence_document
  notes
```

Timeline:

```text
Scheduled
→ Performed
→ Evidence attached
→ Reviewed
→ Closed
```

Ez sokkal erősebb operational feature, mint egy dokumentum egyik text mezője.

---

# 22. Document taxonomy – domain + document type

Ne csak free-text tag proliferáció legyen.

A meglévő `tags` maradhat backward compatibility miatt.

De adjunk strukturált metaadatot:

```text
domain
document_type
```

Példák:

```text
FIRE_REGULATION
FIRE_DRILL_PLAN
FIRE_TRAINING_RECORD
FIRE_EQUIPMENT_MAINTENANCE
FIRE_OPERATIONS_LOG
FIRE_RISK_CLASSIFICATION
```

A free tags maradnak secondary taggingre.

Ez Phase 3-nál sokkal skálázhatóbb lesz.

---

# 23. Expert review – ugyanaz az engine

A Phase 1 review flow változtatás nélkül használható.

Entity type lehet:

```text
RISK_ASSESSMENT
FIRE_REGULATION
FIRE_DRILL_PLAN
FIRE_CLASSIFICATION
TRAINING_CONTENT
```

Review:

```text
READY_FOR_REVIEW
IN_REVIEW
CHANGES_REQUESTED
REVIEWED
```

Domain nem változtatja meg a review engine-t.

Ez pontosan az a fajta újrahasznosítás, amit Phase 2-nek bizonyítania kell.

---

# 24. Expert cockpit – cross-domain

A szakember cockpit ne két külön alkalmazás legyen.

## Client view

```text
Ügyfél      Munkavédelem        Tűzvédelem       Tőlem vár
----------------------------------------------------------------
ABC Kft     2 upcoming          1 review          2
XYZ Kft     OK                  3 upcoming         1
```

Filter:

- all;
- work safety;
- fire safety;
- waiting for me.

## Ha ugyanaz a szakember mindkettőt tudja

ugyanabban a tenantban dolgozik.

## Ha két külön szakember

mindkettő csak a saját capability-jéhez tartozó workflow-t látja/módosítja a permission modell szerint.

---

# 25. Dashboard – Phase 2 után

A dashboard ne tele legyen domain tile-okkal.

Ne:

```text
Munkavédelem
Tűzvédelem
Munkavédelem
Tűzvédelem
...
```

Első nézet:

## Attention

```text
3 tétel tőled vár
2 tétel szakemberre vár
4 határidő 30 napon belül
1 rutin nincs ma rögzítve
```

Mindenhez domain badge:

- Munkavédelem
- Tűzvédelem

Ez skálázódik Phase 3/4-re.

---

# 26. Calendar – cross-domain, de ne legyen event wall

A meglévő calendar marad.

## Beletesszük

- meaningful deadlines;
- renewals;
- scheduled expert events;
- training;
- fire drill;
- maintenance.

## Nem tesszük bele

minden napi routine completiont.

## Filter

```text
All
Work Safety
Fire Safety
```

Később új domain automatikusan bekerülhet.

---

# 27. Dossier → Export Center

A Phase 1 dossier megmarad.

A Phase 2 után viszont érdemes scope-választást adni.

## Export options

### Work Safety Pack

csak munkavédelem.

### Fire Safety Pack

csak tűzvédelem.

### Full Compliance Archive

minden domain.

### Custom

kiválasztott modulok.

## Miért?

Nem minden inspector ugyanazt kéri.

A master archive megmarad, de nem kényszerítünk minden dokumentumot minden exportba.

---

# 28. Fire Safety Pack tartalom

Példa:

```text
1. Employer / site information

2. Fire regulation
   - applicable general/custom path
   - current regulation
   - version/review metadata

3. Training
   - employee fire training records
   - evidence

4. Fire equipment
   - registered employer-managed equipment
   - operator checks
   - professional maintenance evidence

5. Fire drill
   - plan
   - exercises
   - evidence

6. Other fire documents

7. Manifest / audit metadata
```

A tartalom applicability szerint változik.

Ne legyen üres Section 5 olyan kötelezettségről, amely eleve nem alkalmazandó.

---

# 29. „Missing” vs „Not applicable”

Phase 2-nél ez különösen fontos.

Minden expected item állapota:

```text
APPLICABLE
NOT_APPLICABLE
UNKNOWN
NEEDS_CONFIRMATION
```

És csak `APPLICABLE` esetben lehet:

```text
RECORDED
NOT_RECORDED
OVERDUE
```

Így a rendszer nem nevezi „hiányzónak” azt, ami nem is kötelező.

Ez platformszinten is javítja a Phase 1-et.

---

# 30. External-managed tűzvédelmi rendszer

Sok ügyfélnél a landlord/FM vagy karbantartó kezeli az eszközt.

## UX

> Ki kezeli ezt?

- Mi
- Épületüzemeltető
- Külső karbantartó
- Megosztott

## Ha external

A CompliFlow feladata:

- evidence request;
- next expected document/date;
- provider;
- contact;
- received evidence;
- reminder.

Nem kell részletes field-service workflow.

---

# 31. fiREG coexistence strategy

A CompliFlow ne állítsa, hogy ki kell dobni a fiREG-et.

## Phase 2

Manual coexistence:

- fiREG/exportból származó PDF/dokumentum feltölthető;
- source = `EXTERNAL_SYSTEM`;
- `external_system = FIREG`.

## Phase 2.x

Ha üzletileg valid:

- CSV import;
- data mapping;
- API/integration, ha elérhető és értelmes.

## Positioning

> **„Ha a karbantartód fiREG-et használ, nem baj. CompliFlow a vállalati compliance-képben kezeli az eredményt.”**

Ez csökkenti a switching resistance-t.

---

# 32. Import – Phase 2 scope

## MUST

### Fire training import
A közös training import engine használatával.

### Fire equipment import
Egyszerű asset + known date import.

## SHOULD

### Maintenance evidence import
CSV/PDF metadata.

## KEEP/GATED

AI document extraction reuse:

- maintenance certificate;
- training sheet;
- operations log.

Nincs új AI engine.

---

# 33. AI Phase 2

Nem javasolt Phase 2-ben új, tűzvédelmi AI „hazard intelligence” scope-ot építeni.

A Phase 1 AI hazard experimentből előbb tanuljunk.

## Használható meglévő AI

### Data extraction

- dokumentum típus;
- dátum;
- provider;
- serial number;
- equipment reference.

### User confirmation

ugyanaz a staging gate.

## Ne legyen Phase 2 Core

> „AI megmondja, hogy tűzvédelmileg mi veszélyes.”

Nem azért, mert technikailag nem lehetne, hanem mert nincs szükség még egy jogilag érzékeny kísérleti területre, amíg a Phase 1 experiment nincs validálva.

---

# 34. Site model Phase 2 dependency

A tűzvédelem erősen telephelyhez / épülethez kötött.

Ezért itt válik a `site` entity valódi architekturális dependency-vé.

## Phase 2 előtt javasolt

```text
site
  id
  tenant_id
  name
  address
  status
```

A meglévő Phase 1 tenant:

- kap egy default site-ot;
- minden meglévő rekord hozzá migrálható.

## UI Phase 2-ben

Továbbra is engedélyezhető csak egy site, ha a multi-site nincs kész.

De az adatmodell már site-aware legyen.

---

# 35. Fire-specific site profile

```text
fire_site_profile
  site_id
  applicability_answers
  applicability_status
  existing_regulation_document_id
  regulation_path
  landlord_managed
  facility_manager
  updated_at
```

Ne tegyük ezeket az employer_profile-ba.

A tűzvédelem épület-/telephely-specifikus.

---

# 36. Data model – javasolt additív F2 entitások

```text
fire_site_profile

fire_regulation
fire_drill_plan
fire_drill

recurring_routine
routine_completion

equipment_responsibility

professional_capability
```

A többihez meglévő platformtábla:

```text
employee
training_record
equipment
document
compliance_task
review
audit_event
obligation_rule
tenant_membership
```

---

# 37. Amit az eredeti F2-ből megtartanék

## KEEP / REUSE

- cross-obligation calendar concept;
- unified employee timeline;
- same document library;
- same dossier/export engine;
- data-driven cycles;
- multi-cycle capability;
- RLS guardrail;
- inspection history;
- import extension;
- derived operations log;
- conditional system flags;
- same onboarding shell.

---

# 38. Amit az eredeti F2-ből módosítanék

## MODIFY

### „Tűzvédelem universal”
→ applicability-driven.

### „Tűzvédelmi Szabályzat mindenkinek”
→ general/custom path.

### „A–E classification”
→ remove; store professional/source classification.

### „annual training universal”
→ rule/applicability-driven.

### „expert not user”
→ expert first-class.

### „all routines in calendar”
→ routine ledger.

### „text-only fire drill plan”
→ expert/upload workflow.

### „commissioning date generates all cycles”
→ source-aware date model.

### „one dossier for any inspector”
→ scoped export center.

---

# 39. Amit az eredeti F2-ből nem építenék meg mélyen

Nem azért, mert ezek haszontalanok, hanem mert fiREG és más vertikális rendszerek mellett rossz ROI lehet.

## Phase 2-ben ne mélyítsük:

- field-service dispatch;
- technician route;
- QR-based maintenance operations;
- full fire-device catalog workflow;
- maintenance company billing;
- spare parts;
- device service history specialist workflow;
- tűzjelző technikai teszt-specifikus app;
- graphical floor plan editor.

Ha később validált igény van, integráció vagy partner megoldás jöhet.

---

# 40. Phase 2 activation flow

Nem a teljes F1 onboarding ismétlése.

## Step 1 – Fire Setup

> „Állítsuk be a telephely tűzvédelmi működését.”

Applicability questions.

## Step 2 – Existing documents

> „Van már tűzvédelmi szabályzatod / dokumentumod?”

- feltöltöm;
- nincs;
- nem tudom.

## Step 3 – Professional

> „Ki segít a tűzvédelemben?”

- meglévő szakember meghívása;
- később;
- nincs.

## Step 4 – Equipment responsibility

> „A tűzvédelmi eszközöket ki kezeli?”

## Step 5 – First operational item

- extinguisher/operator check;
- training;
- evidence.

## Done

Dashboardon az első fire task.

### Target

**10–15 perc első valós fire taskig.**

Nem kell az egész szabályzat wizardot onboardingban befejezni.

---

# 41. Phase 2 success metric

Az eredeti:

> „30 perc alatt egy fire deadline.”

Ezt javítanám.

## Activation success

A fire module-t aktiváló ICP ügyfelek 60%-a 7 napon belül:

1. befejezi az applicability setupot;
2. legalább egy site fire workflow-t aktivál;
3. feltölt vagy létrehoz legalább egy fire document/evidence recordot;
4. létrehoz legalább egy valódi fire task/routine-t;
5. meghív expertet **vagy** external provider-t rögzít;
6. visszatér legalább még egyszer.

## Cross-domain success

A Phase 2 igazi platform metricje:

> **A Phase 1 + Phase 2 aktív ügyfelek hány százaléka használ ugyanazon 30 napon belül legalább két compliance-domainből taskot/evidence-et?**

Ez bizonyítja a platformtézist.

---

# 42. North Star candidate

> **Active Compliance Loops per Tenant**

Egy loop:

```text
Applicable obligation
→ owned task/routine
→ completed action
→ evidence
→ review/audit
```

Phase 1 után pl. 3 loop.

Phase 2 után 7 loop.

Ez jobb, mint dokumentum- vagy calendar-event szám.

---

# 43. Phase 2 Core scope

## P0 – platform dependency

- Site entity.
- Professional capability.
- Applicability state.
- Rule extension.
- Routine vs task distinction.

## P0 – fire domain

- Fire applicability setup.
- General/custom regulation path.
- Expert-assisted fire regulation workflow.
- Fire training domain.
- Fire extinguisher register.
- Operator check.
- Professional maintenance evidence.
- External-managed responsibility.
- Fire document taxonomy.
- Fire scoped export.

## P1

- Fire drill plan workflow.
- Fire drill recurring task.
- Fire alarm reference tracking.
- Safety-lighting reference tracking.
- Fire equipment import.
- Derived operations log.
- Expert cockpit fire filters.

## P2 / validation dependent

- More equipment categories.
- fiREG import/integration.
- additional automation.
- advanced fire document generation.

---

# 44. Release gates

## Build gate

- domain model valid;
- RLS;
- site migration;
- task/routine separation;
- rule versioning.

## Design partner gate

- fire applicability flow;
- regulation wizard;
- training rule;
- equipment workflow.

## Legal gate

- applicability rules;
- regulation preparation/finalization;
- training recurrence;
- professional capability;
- wording.

## Pilot gate

- 3–5 employer + expert pairs.

## Public production gate

- no unresolved critical legal rule;
- rule source/version;
- feature flags;
- audit;
- support procedure.

---

# 45. Feature flags

```text
fire_module_enabled

fire_regulation_wizard_enabled
fire_regulation_professional_required

fire_training_enabled

fire_equipment_enabled
fire_routines_enabled

fire_drill_enabled

fire_external_system_import_enabled
```

Nem azért, hogy sokáig kikapcsolva legyenek, hanem hogy egy domain rule hiba esetén ne kelljen az egész CompliFlow-t leállítani.

---

# 46. Phase 2 commercial positioning

Ne:

> „Most már tűzvédelmet is tud.”

Hanem:

> **„A munkavédelmis, a tűzvédelmis, az üzemeltető és a saját csapatod ugyanabban a rendszerben látja, mi a következő feladat és hol van a bizonyíték.”**

## Fire-specific message

> **„Nem még egy tűzvédelmi eszköznyilvántartás. A tűzvédelmi feladataid ugyanabban a vállalati compliance-rendszerben élnek, mint a munkavédelem.”**

## fiREG mellett

> **„A karbantartód használhat saját szakmai rendszert. CompliFlow összefogja az eredményt a teljes vállalati compliance-képpel.”**

---

# 47. ICP

A CompliFlow elsődleges ICP-je maradhat:

> **20–99 fős KKV fizikai működéssel / eszközparkkal és külső szakemberekkel.**

A Phase 2 érték azonban applicability szerint különbözik.

## Fire deep-flow ideal ICP

- 51–99 fő;
- vagy más trigger miatt saját tűzvédelmi szabályzat;
- fizikai telephely;
- employer-managed extinguishers;
- külső tűzvédelmi szakember / karbantartó.

## Fire light-flow ICP

20–50 fő:

- általános szabályzati path;
- training/evidence;
- equipment responsibility;
- external provider evidence.

Nem kell ugyanazt a UI-t erőltetni mindkettőre.

---

# 48. GTM

## Expert-led

A Phase 1 szakemberpartneri csatorna Phase 2-ben tovább erősödik.

Különösen érdekes partner:

> **olyan munkavédelmi/tűzvédelmi szolgáltató, amely mindkét domaint kezeli.**

Egyetlen partnerrel:

- több domain;
- több ügyfél;
- erősebb platform fit;
- kisebb vendor fragmentation.

## Pilot cohort

### 3 dual-domain expert
Munkavédelem + tűzvédelem.

### 5 employer
20–99 fő.

### 2 landlord/FM-heavy case
hogy az external-managed modelt is validáljuk.

---

# 49. Phase 2 piaci versenystratégia

## Ne versenyezzünk frontálisan:

### E-Munkabiztonsággal
mint LMS.

### ServiceLeaf-fel
mint CMMS.

### fiREG-gel
mint fire maintenance system.

### denxperttel
mint enterprise EHS/legal platform.

## Saját pozíció

> **SMB cross-domain compliance operating layer + professional collaboration.**

Ez a kombináció a védhető irány.

---

# 50. Architecture quality test

A Phase 2 akkor jó, ha az architect válasza ezekre többnyire:

> „ugyanaz az engine, új config/content”

és nem:

> „új modult kell nulláról építeni.”

## Elvárt reuse

| F2 use case | Reused capability |
|---|---|
| Fire training | training |
| Fire review | review |
| Fire expert | membership/capability |
| Fire deadline | task/calendar |
| Fire recurring routine | generic recurring routine |
| Fire document | document |
| Fire evidence | evidence link |
| Fire export | dossier/export |
| Fire legal rule | obligation rule |
| Fire audit | audit event |

Csak domain-specifikus viselkedés legyen új.

---

# 51. Platform implication Phase 3-ra

Ha F2 így készül, a következő domain sokkal olcsóbb lehet.

Például occupational-health vagy más recurring compliance:

```text
new applicability rules
+ new expert capability
+ new record types
+ new documents
+ new recurrence
```

és nem:

> új product vertical.

Ez Phase 2 stratégiai ROI-jának jelentős része.

---

# 52. Javasolt implementációs sorrend

## Increment F2.0 – Platform readiness

1. Site.
2. Applicability status.
3. Professional capability.
4. Routine engine.
5. Fire rule namespace.

## Increment F2.1 – Fire foundation

6. Fire setup.
7. Existing document upload.
8. General/custom regulation path.
9. Expert invite/capability.
10. Fire document taxonomy.

## Increment F2.2 – Operational fire

11. Fire training.
12. Fire extinguisher.
13. Operator checks.
14. External maintenance evidence.
15. Responsibility model.
16. Calendar/task integration.

## Increment F2.3 – Professional workflow

17. Fire regulation wizard.
18. Expert review/preparation.
19. Finalization.
20. Audit/export.

## Increment F2.4 – Extended value

21. Fire drill.
22. Operations log.
23. Equipment import.
24. external-system source / fiREG coexistence.

---

# 53. Mit kell megváltoztatni az eredeti F2 PRD-ben?

## Section 1 – Business Goal

Átírni:

> nem „minden 40 fős cég kitölti a fire regulation wizardot”,

hanem:

> **„A Phase 1 ügyfél applicability alapján beállítja a tűzvédelmi domainjét, és ugyanabban a task/expert/evidence rendszerben kezeli a rá releváns fire workflow-kat.”**

## Section 2 – Actors

Hozzáadni:

- Fire Safety Professional.
- External Maintenance Provider.
- Facility Manager / Landlord mint external responsibility actor.

## Section 3 – Boundary

Megtartani, de:

- expert workflow-val;
- ne blanket szótiltás legyen;
- valódi hatósági fogalmak használhatók, ahol jogilag azok.

## Section 4 – Applicability

**Teljesen újraírni.**

Nem universal list.

## F2-M1

Custom regulation wizard → conditional + expert-assisted.

## F2-M2

Training → conditional rule recurrence.

## F2-M3

Equipment → responsibility + operator/professional distinction.

## F2-M4

Calendar → deadlines only; routine exceptions.

## F2-M5

Dossier → scoped export.

## F2-M6

RLS megtartani.

## Import

A shared Phase 1 import engine extensionje.

---

# 54. Final recommendation

A tűzvédelmi Phase 2 **ne legyen az eredeti F2-spec szerint egy második vertikális feature-stack**.

A Phase 1 post-build irány után sokkal jobb lehetőség nyílik:

> **A Phase 2 legyen a CompliFlow platformarchitektúra első valódi bizonyítása.**

A helyes szerkezet:

```text
                  COMPLIFLOW PLATFORM
┌──────────────────────────────────────────────────┐
│ Company / Site                                   │
│ Employee                                         │
│ Professional Membership                          │
│ Applicability / Rules                            │
│ Tasks / Routines                                 │
│ Documents / Evidence                             │
│ Review                                           │
│ Calendar / Attention                             │
│ Audit                                            │
│ Export                                           │
└─────────────────┬────────────────┬───────────────┘
                  │                │
       ┌──────────▼───────┐ ┌─────▼──────────────┐
       │   MUNKAVÉDELEM   │ │     TŰZVÉDELEM     │
       │                  │ │                    │
       │ Risk assessment  │ │ Regulation path    │
       │ Training         │ │ Fire training      │
       │ Equipment        │ │ Fire equipment     │
       │ PPE / accident   │ │ Fire drill         │
       └──────────────────┘ │ Operations log     │
                            └────────────────────┘
```

## Egy mondatban

> **A tűzvédelem ne új termék legyen a CompliFlow mellett, hanem ugyanannak a compliance operating systemnek a második domainje.**

Ez egyszerre:

- kisebb fejlesztési duplikáció;
- koherensebb UX;
- jobb expert-disztribúció;
- jobb cross-sell;
- kevesebb jogi overclaim;
- jobb fiREG melletti pozíció;
- és erősebb alap Phase 3-ra.

---

# 55. Elsődleges külső források / validációs alap

A konkrét production rule-setet launch előtt újra kell validálni az aktuális hatályos szövegek alapján.

- **1996. évi XXXI. törvény** a tűz elleni védekezésről, a műszaki mentésről és a tűzoltóságról  
  https://njt.hu/jogszabaly/1996-31-00-00

- **101/2023. (XII. 29.) BM rendelet** a tűzvédelmi szabályzatról, a tűzvédelmi házirendről, valamint a tűzvédelmi oktatásról  
  https://njt.hu/jogszabaly/2023-101-20-0A

- **54/2014. (XII. 5.) BM rendelet – OTSZ**  
  https://njt.hu/jogszabaly/2014-54-20-0A

- **50/2011. (XII. 20.) BM rendelet** – tűzvédelmi szolgáltatási / karbantartási szabályok releváns részei  
  https://njt.hu/jogszabaly/2011-50-20-0A

- **fiREG** – Expert és Enterprise tűzvédelmi üzemeltetési / karbantartási platform  
  https://fireg.hu/

---

# 56. Döntési pontok

A jelen ajánlás az alábbi stratégiai döntéseket feltételezi:

1. **A Phase 1 professional collaboration valóban platform capability lesz**, nem munkavédelem-specifikus feature.
2. **A Phase 2 applicability-driven lesz**, nem minden tűzvédelmi funkció jelenik meg minden ügyfélnek.
3. **A Tűzvédelmi Szabályzat wizard megmarad**, de egyedi szabályzatnál professional workflow-ba kerül.
4. **Nem építünk fiREG-versenytársat teljes vertikális mélységben.**
5. **A napi/gyakori üzemeltetési események routine ledgerbe kerülnek**, nem a fő calendarba.
6. **A tűzvédelmi szakember Phase 2-ben first-class user.**
7. **A landlord/FM/external provider felelősségi modell Phase 2 core.**
8. **A dossierből scoped Export Center fejlődik.**

Ezekkel a döntésekkel a Phase 2 egyszerre tud érdemi új ügyfélértéket adni és jelentősen csökkenteni annak kockázatát, hogy a CompliFlow minden új compliance-domainnel újraépítse saját magát.
