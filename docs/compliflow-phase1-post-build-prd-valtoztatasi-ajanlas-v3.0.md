# CompliFlow Phase 1 – post-build PRD változtatási ajánlás

**Verzió:** 3.0 – post-build recommendation  
**Dátum:** 2026-08-08  
**Bázis:** `2026-07-31-compliflow-f1-requirements-spec.md`  
**Kiindulási feltétel:** a Phase 1 eredeti scope-ja lényegében már megépült.  
**Cél:** nem új MVP-t definiálni, hanem meghatározni, hogyan érdemes a már elkészült terméket **biztonságosabbá, piacképesebbé, jobban pozicionálhatóvá és Phase 2-re skálázhatóvá** tenni.

> **Fontos alapelv:** ami már megépült és működik, azt nem javasolt törölni pusztán azért, mert ma már nem építenénk meg ugyanúgy. A fejlesztési költség sunk cost. A döntés alapja most az, hogy egy meglévő funkció:  
> 1. ad-e ügyfélértéket;  
> 2. okoz-e jogi vagy UX-kockázatot;  
> 3. mennyi további karbantartást húz maga után;  
> 4. erősíti-e a CompliFlow hosszú távú platformstratégiáját.

---

# 1. Executive decision

A Phase 1-et **nem kell újravágni**.

A jelenlegi M1–M8, onboarding, import, AI-assisted entry és prototípus AI hazard funkciók megtarthatók. A post-build stratégia háromféle beavatkozást igényel:

## A. Korrigálni kell
Azokat a részeket, ahol a jelenlegi terméklogika vagy jogszabályi adat hibás / túl merev.

## B. Köré kell építeni
A már elkészült funkciók köré olyan workflow-t, amely növeli a bizalmat és a használati értéket:

- munkavédelmi szakember;
- review;
- task;
- evidence;
- audit trail;
- rule source/version.

## C. Át kell pozicionálni
A CompliFlow ne „digitális munkavédelmi szakértőként”, hanem:

> **a munkáltató és a munkavédelmi szakember közös compliance workspace-eként**

jelenjen meg.

A már elkészült risk-assessment wizard és AI funkciók így **nem elveszett fejlesztés**, hanem értékes intake/assistance layer lesznek egy erősebb workflow-ban.

---

# 2. Mit NEM javasolt most csinálni

Mivel a scope már elkészült:

## 2.1 Ne töröljük a week calendar view-t
Ha működik, maradjon. Nem prioritás továbbfejleszteni, de eltávolítása nem hoz érdemi megtakarítást.

## 2.2 Ne töröljük a manual compliance event funkciót
Hasznos escape hatch. Maradhat, csak ne ez legyen a termék központi története.

## 2.3 Ne töröljük az AI-assisted importot
A fejlesztési költség már felmerült. Inkább:
- gate;
- limit;
- audit;
- pontosabb prioritás;
- usage analytics.

## 2.4 Ne töröljük a risk-assessment wizardot
A wizard maga értékes. A változtatás nem a funkció eltávolítása, hanem annak meghatározása, hogy:
- mit állít róla a UI;
- milyen státuszban van a generált dokumentum;
- mikor kér expert review-t;
- milyen jogi szabályt használ.

## 2.5 Ne töröljük az AI hazard prototype-ot
Maradjon feature flag mögött és kontrollált pilotban. Az eddigi fejlesztésből tanulni kell.

## 2.6 Ne építsük újra az adatmodellt csak „szebbség” miatt
Ahol a jelenlegi séma működik, kompatibilis migrációval bővítsünk. Nagy refactor csak akkor indokolt, ha Phase 2 vagy valós ügyfélhasználat blokkolja.

---

# 3. Új döntési elv: REMOVE helyett négy állapot

A meglévő Phase 1 funkciókat ezentúl négy kategóriába soroljuk.

| Állapot | Jelentés |
|---|---|
| **CORE** | aktívan értékesítjük és továbbfejlesztjük |
| **KEEP** | marad és támogatott, de nem ez a következő befektetési fókusz |
| **GATED** | megmarad, de feature flag / jogi / expert gate mögött |
| **LEGACY-SUPPORTED** | működik a jelenlegi ügyfeleknek, de új capability nem épül rá, amíg nincs rá bizonyított igény |

Ez jobb post-build szemlélet, mint a „MUST / DEFER / OUT OF SCOPE”.

---

# 4. Funkciók új besorolása

| Funkció | Jelenlegi állapot | Post-build státusz | Teendő |
|---|---|---|---|
| Employer profile | megépült | **CORE** | jogi besorolás/logika korrekció |
| Obligation map | megépült | **CORE** | rule source + expert confirmation |
| Risk assessment wizard | megépült | **CORE / GATED finalization** | expert workflow köré |
| AI hazard suggestion | megépült proto | **GATED** | pilot + legal + audit |
| Employee list | megépült | **CORE** | lifecycle mezők |
| Training records | megépült | **CORE** | rule source + nullable next due |
| Bulk training | megépült | **CORE** | megtartani |
| Employee XLSX/CSV import | megépült | **CORE** | training importtal kiegészíteni |
| AI-assisted import | megépült | **KEEP / GATED** | usage mérés + GDPR gate |
| Equipment register | megépült | **CORE** | lifecycle + ownership/source |
| Compliance calendar | megépült | **CORE** | task view-val kiegészíteni |
| Week view | megépült | **KEEP** | nincs további prioritás |
| Manual events | megépült | **KEEP** | marad |
| Document library | megépült | **CORE** | verziózás |
| Inspection dossier | megépült | **CORE** | copy + scoped export később |
| RLS | megépült | **CORE / NON-NEGOTIABLE** | expert cross-tenant modelhez bővíteni |
| Onboarding wizard | megépült | **CORE** | expert invite + import-first módosítás |

---

# 5. P0 – jogi és rule-logikai korrekciók

Ezeket nem azért kell megcsinálni, mert új feature-t akarunk, hanem azért, mert a már megépült rendszer **ne generáljon túlzottan magabiztos vagy hibás rendszerállapotot**.

## 5.1 A jogszabályi ciklusokat ki kell venni a hard-coded product logicból

A jelenlegi Phase 1 több helyen fix jogi időszakokat tárol közvetlenül az AC-kben és a rendszerlogikában.

Javasolt új entitás:

```text
obligation_rule
  id
  domain
  obligation_type
  jurisdiction
  effective_from
  effective_to
  trigger_type
  interval_value
  interval_unit
  legal_source
  professional_review_required
  config_version
  status
```

Minden rendszer által számolt határidőhöz:

```text
rule_id
rule_version
due_rule_source
set_by
```

`set_by`:

```text
system_rule
employer
safety_professional
import
```

### Post-build migrációs elv

- korábbi adatot **nem törlünk**;
- a meglévő határidőket megtartjuk történeti értékként;
- újraszámolást csak validált rule alapján végzünk;
- ahol a korábbi rule hibás, ott a UI jelezheti:
  - „A határidő korábbi szabály alapján került kiszámításra.”
  - „Ellenőrzés javasolt.”

---

# 6. P0 – kockázatértékelési ciklus korrekció

A korábbi PRD fix 3 éves review date-et tartalmazott. A korábbi jogi ellenőrzés alapján ezt **nem szabad változatlanul hard-code-olni**; a jelenlegi szabályozást a production rule-setben aktuális forrás alapján kell rögzíteni.

## Javasolt post-build megoldás

A már létező:

```text
review_date
```

mező maradhat.

Új mezők:

```text
review_rule_id
review_rule_version
review_date_source
review_date_confirmed_by
```

### Meglévő rekordok

Ne töröljük és ne írjuk át vakon.

Migration:

1. megjelölni, hogy milyen korábbi rendszer-rule generálta;
2. az aktuális, jogilag validált rule alapján számított új dátumot ajánlásként előállítani;
3. employer vagy expert megerősítés;
4. audit logban megőrizni a változást.

---

# 7. P0 – Employer Profile / veszélyességi besorolás

A meglévő `industry → hazard_category` logikát nem kell kidobni, ha technikailag működik.

Viszont **ne legyen láthatatlan, autoritatív jogi igazság**.

## Javasolt evolúció

A meglévő mező marad backward compatibility miatt:

```text
hazard_category
```

Új mezők:

```text
hazard_category_source
classification_status
classification_confirmed_by
classification_confirmed_at
```

### classification_status

```text
system_suggested
employer_confirmed
expert_confirmed
needs_review
```

### UI

Ahelyett, hogy a rendszer csendben besorol:

> „A megadott tevékenység alapján a rendszer ezt a besorolást használja a határidők előkészítéséhez.”

CTA:

- **Megerősítem**
- **Szakemberrel ellenőrzöm**

Ez megtartja a már elkészült mappinget, de csökkenti a kockázatát.

---

# 8. P0 – Safety Professional legyen valódi platform-user

Ez továbbra is a legfontosabb új fejlesztés.

Nem azért, hogy kiváltsa a meglévő scope-ot, hanem hogy **értékesebbé tegye az egészet, amit már megépítettünk**.

## Új role

```text
safety_professional
```

## Új membership modell

```text
tenant_membership
  id
  tenant_id
  user_id
  role
  capability_set
  status
  invited_by
  created_at
```

A szakember több ügyfél tenantjának lehet tagja.

## Miért különösen jó post-build befektetés?

Mert az összes meglévő modul értékét növeli:

- M1 besorolás → review;
- M2 wizard → expert-assisted;
- M3 training → expert visibility;
- M4 equipment → expert visibility;
- M5 calendar → közös task;
- M6 dossier → reviewed evidence;
- M7 document → review/comment.

Egyetlen új capability sok már elkészült modul ROI-ját javítja.

---

# 9. P0 – Review workflow

A risk-assessment wizardot **nem vesszük ki**.

Helyette a generált dokumentum lifecycle-ja erősödik.

## Javasolt state machine

```text
DRAFT
GENERATED
READY_FOR_REVIEW
IN_REVIEW
CHANGES_REQUESTED
REVIEWED
FINALIZED
SUPERSEDED
```

## Fontos

A `REVIEWED` jelentése:

> „A meghívott szakember áttekintette.”

Nem jelenti automatikusan:

- hatósági jóváhagyás;
- jogszabályi megfelelőség garantálása;
- biztonságosság tanúsítása.

## Post-build előny

A jelenlegi document generation megmarad. Csak a **következő lépés** változik.

---

# 10. P0 – Risk Assessment Wizard új szerepe

A már megépült M2 legyen:

> **structured intake + document preparation + review workspace**

és ne csak:

> „wizard → kész compliance dokumentum”.

## Employer-led mode

A jelenlegi workflow működik tovább.

## Expert-assisted mode

A felhasználó bármikor:

> „Küldés szakembernek áttekintésre”

CTA-val bekapcsolhatja a szakembert.

## Production gate

Konfiguráció:

```text
risk_assessment_wizard_enabled = true
expert_review_available = true
expert_review_required_for_finalization = configurable
```

Így nem kell visszabontani a már működő flow-t.

---

# 11. P0/P1 – AI hazard suggestion: megtartani, nem visszabontani

A funkció megépült, ezért a helyes stratégia:

## Megtartani mint kísérleti capability

```text
ai_hazard_suggestions_enabled
```

tenant / environment szinten.

## Kötelező kontroll

- AI model version;
- generated timestamp;
- suggestion source;
- user accept/modify/reject;
- user confirmation;
- audit;
- kill switch.

## Expert workflow-val összekötni

```text
AI_SUGGESTED
USER_ACCEPTED
USER_MODIFIED
USER_REJECTED
EXPERT_REVIEWED
```

## Amit ne tegyünk

Ne állítsuk le automatikusan csak azért, mert jogilag érzékeny.

Helyette:

> **controlled feature → evidence collection → legal/domain validation → production decision**

Így az eddigi fejlesztés valódi tanulási asset marad.

---

# 12. P0 – Training record logika korrigálása

A már meglévő training module marad.

A `next_renewal_date` azonban ne kényszerítse a rendszer minden esetben saját jogi periodicitásra.

## Backward-compatible módosítás

A meglévő:

```text
next_renewal_date
```

marad.

Új:

```text
next_due_date_source
rule_id
rule_version
set_by
```

A későbbi schema-cleanup során a mező átnevezhető, de nem szükséges most migration-risket vállalni.

## Új UI-logika

Következő dátum:

- rendszer javasolta;
- employer adta meg;
- expert adta meg;
- importból jött.

A felhasználó lássa a forrást.

---

# 13. P0 – Employee lifecycle

A már elkészült employee module egyik fontos hiánya, hogy a kilépett dolgozókat életciklus szerint kell kezelni.

## Additív mezők

```text
employment_status
termination_date
active
```

## Viselkedés

`active = false`:

- történeti rekordok megmaradnak;
- új recurring reminder ne keletkezzen;
- dossier snapshotban kérésre szerepelhet;
- employee list alapértelmezésben aktívakat mutat.

Ez kis fejlesztés, nagy adatminőség-hatás.

---

# 14. P0 – Equipment lifecycle

Ugyanez az eszközöknél.

## Additív mezők

```text
active
commissioned_at
decommissioned_at
```

Az inaktív eszköz:

- történetben marad;
- új reminder nem készül;
- régi inspection record nem vész el.

---

# 15. P0 – Training XLSX/CSV import hozzáadása

Az employee import már megépült, tehát most a legnagyobb onboarding-gap a kapcsolódó training adatok bevitele.

Ez **nem az employee import helyett**, hanem ráépítve készüljön.

## Import módok

### Employee + current training

Egy sor:

```text
employee
position
training_type
training_date
next_due_date
```

### Training-only

```text
employee_identifier
training_type
training_date
next_due_date
instructor
notes
```

## Matching

1. internal ID;
2. exact name;
3. ambiguous name → manual mapping;
4. no match → create employee / skip.

Ez nagyobb valós ügyfélértéket ad, mint bármely meglévő import-feature visszavágása.

---

# 16. P0 – Compliance Task layer hozzáadása

A calendar megépült – **nem kell lecserélni**.

Viszont a calendar „dátumot” kezel, miközben a napi működés „feladatot” kezel.

## Új entity

```text
compliance_task
  id
  tenant_id
  title
  description
  source_entity_type
  source_entity_id
  owner_user_id
  owner_role
  due_date
  status
  evidence_document_id
  created_by
  completed_at
```

## Status

```text
OPEN
IN_PROGRESS
WAITING_FOR_EMPLOYER
WAITING_FOR_EXPERT
READY_FOR_REVIEW
DONE
CANCELLED
```

## Kapcsolat a calendarhoz

- a calendar tovább működik;
- a task due date megjelenhet benne;
- a calendar entryből megnyitható a task;
- a dashboard elsődlegesen a taskokat mutatja.

Így a már megépült calendar **többet ér**, nem kevesebbet.

---

# 17. M5 Calendar – megtartani, de átpozicionálni

## Megmarad

- month view;
- week view;
- urgency colors;
- manual events;
- reminder emails.

## Új default UX

A dashboardon elsőként:

### Teendők

1. lejárt;
2. következő 7 nap;
3. következő 30 nap;
4. később.

A full calendar továbbra is külön nézet.

## Miért?

Nem kell kidobni egy elkészült UI-t, csak a felhasználó döntési sorrendjét javítjuk.

---

# 18. M6 Dossier – megtartani, csak a claimet pontosítani

A dossier az egyik legerősebb meglévő payoff.

## Megtartani

- snapshot;
- PDF;
- sections;
- manifest;
- expiry indicators.

## Copy-változtatás

Kerülendő:

> „teljes ellenőrzésre kész dokumentáció”

Javasolt:

> **„Ellenőrzési csomag a CompliFlow-ban rögzített adatokból és dokumentumokból.”**

## Új metaadat

```text
dossier_generation
  id
  tenant_id
  generated_at
  generated_by
  scope
  manifest_hash
```

Ha a jelenlegi rendszer már tárol korábbi dossier-kat, ezt evolúciós migrációval lehet formalizálni.

---

# 19. M7 Document Library – verziózás hozzáadása

A meglévő dokumentumtár megmarad.

## Additív mezők

```text
version
supersedes_document_id
status
```

`status`:

```text
active
superseded
archived
```

## UX

Dokumentum detail:

> Aktuális verzió  
> Korábbi verziók

Nem kell külön DMS-t építeni.

Ez főleg azért fontos, mert a Phase 2-től több domain dokumentumai ugyanabban a rendszerben élnek majd.

---

# 20. AI-assisted import – post-build ajánlás

Mivel elkészült:

## Ne vegyük ki.

Hanem mérjük:

- hány user indítja;
- milyen inputtípusra;
- extraction success;
- correction rate;
- abandon rate;
- time saved;
- low-confidence share.

## Funkció-specifikus prioritás

A meglévő capabilityből először a legjobban értékelhető use case-eket promotáljuk:

1. strukturált dokumentumból mezők;
2. inspection certificate;
3. training sheet;
4. messy Excel;
5. generic auto-classification.

A prioritás nem azt jelenti, hogy a már működő többi use case-et törölni kell.

---

# 21. GDPR AI objection – megtartani, de legal gate

Ha a mechanizmus már elkészült, ne bontsuk vissza.

Viszont:

- ne kommunikáljuk úgy, mint végleges jogértelmezést;
- GDPR szakjogász validálja;
- legyen konfigurálható;
- auditáljuk az objection állapotváltozásokat.

Ha később kiderül, hogy bizonyos use case-eknél nem szükséges, a capability maradhat mint privacy-control.

---

# 22. Onboarding – meglévő flow evolúciója

A Phase 1 onboarding már elkészült.

Nem új wizard kell, hanem néhány célzott módosítás.

## Javasolt sorrend

### Step 1 – Company
marad.

### Step 2 – Import
az employee import kapjon erősebb CTA-t:

> **„Van Excel-listád? Töltsd fel, nem kell kézzel begépelned.”**

### Step 3 – First operational record
marad.

### Step 4 – Document
marad.

### Step 5 – ÚJ: Expert

> **„Dolgozol munkavédelmi szakemberrel?”**

- Meghívom most
- Később
- Nincs szakemberem

### Step 6 – Dashboard
marad.

A meglévő onboarding kód nagy része újrahasznosítható.

---

# 23. Dashboard – minimális, nagy hatású módosítás

A már megépült dashboardot nem kell lecserélni.

## Elsődleges blokkok

### Következő teendők
- tőled vár;
- szakemberre vár;
- közelgő.

### Lejárt dátumok
A meglévő logicból.

### Recent changes
- dokumentum;
- training;
- equipment;
- expert review.

### Setup / import
Csak új ügyfélnek.

## Ne legyen

- compliance score;
- „82% compliant”;
- „munkavédelmileg megfelelő”;
- „certified”.

---

# 24. Copy-rule korrekció

A jelenlegi globális szótiltásokat ne tartsuk szó szerinti blacklistként.

A „hiány” például normális adatállapotot is jelenthet.

## Új elv

**Tiltott a jogi/szakmai következtetés, nem maga a szó.**

### Megengedett

- „Ehhez az eszközhöz nincs feltöltött vizsgálati dokumentum.”
- „3 dolgozóhoz nincs rögzített oktatási rekord.”
- „Nincs következő dátum megadva.”

### Kerülendő

- „3 dolgozó kötelező oktatása hiányzik.”
- „Nem felelsz meg.”
- „Szabálytalan állapot.”
- „Munkavédelmileg megfelelő.”

---

# 25. RLS és expert access

A meglévő RLS **nem változhat gyengébbé** az expert funkció miatt.

## Új elv

A szakember cross-tenant user lehet, de mindig explicit membership alapján.

```text
user
  └─ tenant_membership
       ├─ tenant A / safety_professional
       ├─ tenant B / safety_professional
       └─ tenant C / safety_professional
```

## Nem megengedett

```text
if user.role == safety_professional:
    allow all tenants
```

A Phase 2 és későbbi domain-ek miatt ez platform-szintű P0.

---

# 26. Audit Trail – additív platform capability

Mivel AI + expert review + rule-generated deadline is van, érdemes közös audit eseményt bevezetni.

```text
audit_event
  id
  tenant_id
  actor_id
  actor_role
  entity_type
  entity_id
  action
  source
  before_json
  after_json
  created_at
```

`source`:

```text
manual
import
ai_assisted
system_rule
safety_professional
migration
```

Ez később Phase 2-ben is újrahasznosítható.

---

# 27. Site model – ne kényszerítsünk most nagy refactort

A korábbi ajánlás külön `site` entitást P0-nak tekintett.

Post-build helyzetben ezt finomítanám.

## Ha a Phase 2 schema megköveteli

Akkor vezessük be kompatibilis migrációval:

- minden meglévő tenant kap egy default site-ot;
- meglévő rekordok `site_id`-ja erre mutat;
- UI továbbra is single-site;
- nincs user-facing multi-site még.

## Ha Phase 2 nem blokkolódik nélküle

Ne refaktoráljuk pusztán elméleti tisztaságért.

**Prioritás: architectural dependency, nem önálló business feature.**

---

# 28. Mit tekintsünk „már jó, ne nyúljunk hozzá” funkciónak?

Ha production quality rendben van, az alábbiakat csak valós usage-data alapján módosítsuk:

- week calendar;
- manual calendar event;
- document drag-and-drop;
- filter/sort;
- employee CRUD;
- equipment CRUD;
- bulk training;
- basic reminder schedule;
- PDF layout;
- CSV/XLSX employee import mapping.

A product csapat ne generáljon új munkát csak azért, hogy a PRD „szebb” legyen.

---

# 29. Mit ne fejlesszünk tovább, amíg nincs usage evidence?

Megmaradhatnak, de további feature depth ne kapjanak automatikusan:

## Week calendar
Ne építsünk új calendar interactionöket bizonyított igény nélkül.

## Generic manual events
Ne váljon general project-management moduľlá.

## AI generic import
Ne adjunk új inputtípusokat csak azért, mert technikailag lehet.

## Dossier formatting
Ne építsünk komplex designer/export editort.

## Equipment QR
Csak valós ügyféligénnyel.

Ez valódi megtakarítás: **nem a kész kód törlése, hanem a további befektetés leállítása.**

---

# 30. Revised Phase 1 roadmap – post-build

## P0 – production correctness / strategic enablement

1. Jogi/rule adatbázis és rule-versioning.
2. Risk-assessment review rule korrekció.
3. Employer classification source/status.
4. Safety professional role + invitation.
5. Tenant membership / RLS extension.
6. Review workflow.
7. Employee lifecycle.
8. Equipment lifecycle.
9. Training import.
10. Compliance task layer.
11. Copy/claim korrekció.
12. AI/risk feature flag + kill switch.
13. Audit trail minimum.

## P1 – commercial readiness

14. Expert cockpit.
15. Document versioning.
16. Dossier metadata/versioning.
17. Dashboard task-first view.
18. Onboarding expert invite.
19. Usage analytics az AI/import/wizard flow-kra.
20. Pricing/plan entitlement.

## P2 – bizonyított igény alapján

21. Site migration / multi-site preparation, ha Phase 2 megköveteli.
22. Scoped dossier export.
23. Advanced expert collaboration.
24. Partner pricing.
25. Integrációk.

---

# 31. Javasolt implementációs sorrend

A cél nem újabb hosszú rewrite.

## Increment 1 – Safe Production

- rule source/version;
- copy;
- feature flags;
- employee/equipment lifecycle;
- audit minimum.

**Eredmény:** a meglévő termék biztonságosabban pilotolható.

## Increment 2 – Expert Loop

- safety professional;
- invitation;
- review;
- membership;
- RLS.

**Eredmény:** employer-only termékből collaborative workspace.

## Increment 3 – Activation

- training import;
- onboarding expert step;
- task-first dashboard.

**Eredmény:** jobb első érték és kevesebb kézi adatbevitel.

## Increment 4 – Commercial

- expert cockpit;
- document versioning;
- usage analytics;
- entitlement/pricing.

**Eredmény:** B2B2B GTM tesztelhető.

---

# 32. Új success metrics

A már megépült feature count nem releváns success metric.

## Activation

Egy ICP ügyfél 7 napon belül:

- legalább 10 employee vagy 3 equipment;
- legalább 5 dated record;
- legalább 3 document;
- legalább 1 task;
- szakember meghívása **vagy** review kezdeményezése;
- második session.

## Collaboration

- expert invite acceptance rate;
- review turnaround;
- % tenant expert connectionnel.

## Operational value

- completed tasks;
- reminder → action conversion;
- evidence attached rate;
- dossier generation.

## Import

- import started;
- import completed;
- correction rate;
- time to first real calendar/task item.

## AI

- AI usage rate;
- suggestion acceptance;
- modification;
- rejection;
- low-confidence;
- expert disagreement rate.

Az utolsó különösen értékes: megmutatja, tényleg segít-e az AI hazard funkció.

---

# 33. Új go/no-go kérdés

A Phase 1 esetében már nem az a kérdés:

> „Megépítsük-e ezt a funkciót?”

Hanem:

> **„A már elkészült funkció növeli-e a fizetési hajlandóságot, aktivációt vagy retentiont?”**

## Feature investment gate

További komoly fejlesztést csak akkor kapjon egy már meglévő funkció, ha legalább az egyik igaz:

1. usage magas;
2. conversiont javít;
3. expert workflow-hoz szükséges;
4. Phase 2 platform dependency;
5. legal/security correctness;
6. ügyfél kifejezetten fizetne érte.

---

# 34. Revised product architecture

A meglévő Phase 1 modulokat nem bontjuk le.

Ráépítjük a horizontális platformréteget:

```text
                    ┌─────────────────────┐
                    │      EMPLOYER       │
                    └──────────┬──────────┘
                               │
          ┌────────────────────▼────────────────────┐
          │              COMPLIFLOW                 │
          │                                         │
          │  Existing Phase 1                       │
          │  ├─ Employer Profile                    │
          │  ├─ Risk Assessment Wizard              │
          │  ├─ Employees / Training                │
          │  ├─ Equipment                           │
          │  ├─ Calendar                            │
          │  ├─ Documents                           │
          │  ├─ Dossier                             │
          │  └─ AI / Import                         │
          │                                         │
          │  New Horizontal Layer                   │
          │  ├─ Rule Engine / Version               │
          │  ├─ Tasks                               │
          │  ├─ Review                              │
          │  ├─ Expert Membership                   │
          │  ├─ Evidence                            │
          │  └─ Audit Trail                         │
          └────────────────────┬────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │ SAFETY PROFESSIONAL │
                    └─────────────────────┘
```

Ez Phase 2-ben ugyanúgy tovább használható tűzvédelmi specialistákkal.

---

# 35. Revised positioning

A már elkészült termékből nem kell feature-t kidobni ahhoz, hogy jobb legyen a pozicionálás.

## Ne ezt mondjuk

> „A CompliFlow megcsinálja helyetted a munkavédelmet.”

## Inkább

> **„A munkavédelem ne Excelben, e-mailben és papírmappákban éljen.”**

és:

> **„CompliFlow közös munkatér a céged és a munkavédelmi szakembered között: határidők, oktatások, gépvizsgálatok, dokumentumok és kockázatértékelési előkészítés egy helyen.”**

AI:

> **„Az AI gyorsítja az előkészítést és az adatbevitelt. A döntést és a szakmai felelősséget nem veszi át.”**

---

# 36. Revised Definition of Done a Phase 1 korrekcióhoz

Nem kell újra „Phase 1 kész”-nek nevezni az egész terméket.

Hozzunk létre egy:

> **Phase 1 Commercial Readiness / Post-Build Hardening**

gate-et.

## Gate

- [ ] Aktuális rule-set jogilag validált
- [ ] Hard-coded kritikus ciklusok versioned rule-ból jönnek
- [ ] Classification source/status látható
- [ ] Risk wizard production claim korrigálva
- [ ] Safety professional invite működik
- [ ] Expert review működik
- [ ] RLS expert membershipgel tesztelt
- [ ] Employee lifecycle működik
- [ ] Equipment lifecycle működik
- [ ] Training import működik
- [ ] Task layer minimum működik
- [ ] Dossier claim korrigálva
- [ ] AI feature flags + kill switch működik
- [ ] Audit minimum működik
- [ ] 3–5 valódi employer/expert pilot lefutott
- [ ] Usage/activation mérés bekötve

---

# 37. Mi változott a korábbi PRD-ajánláshoz képest?

A korábbi ajánlás build előtti gondolkodással készült, ezért több helyen scope-csökkentést javasolt.

A jelen dokumentum **sunk-cost-aware**.

## Korábban

> „week view defer”

## Most

> **marad; további befektetés nem prioritás**

---

## Korábban

> „AI import kisebb prioritás / később”

## Most

> **marad; mérjük és gate-eljük, de training importot mellé kell tenni**

---

## Korábban

> „MVP scope-ból bizonyos dolgokat kivenni”

## Most

> **nem veszünk ki működő capabilityt, kivéve ha jogi/security kockázata miatt le kell kapcsolni; ilyenkor feature flaggel deaktiváljuk, nem töröljük**

---

## Korábban

> „új architecture Phase 1-hez”

## Most

> **csak kompatibilis, additív platform-layer és szükséges migráció**

---

# 38. Végső ajánlás

A Phase 1 jelenlegi megépített scope-ja **asset, nem probléma**.

A stratégiai hiba az lenne, ha most:

- visszabontanánk elkészült funkciókat;
- hónapokat töltenénk architecture rewrite-tal;
- vagy továbbra is employer-only termékként próbálnánk értékesíteni.

A helyes következő lépés:

> **megtartani a teljes megépített Phase 1 feature-setet, kijavítani a kritikus rule/jogi logikát, majd ráépíteni az expert–task–review–audit horizontális réteget.**

Így:

- az eddigi fejlesztés nem vész el;
- a risk-assessment wizard értékesebb lesz;
- az AI funkcióból valódi pilot-tanulás lesz;
- a calendar/dossier magasabb értékű workflow része lesz;
- a munkavédelmi szakember disztribúciós partner lehet;
- és a Phase 2 tűzvédelem már egy közös platformra érkezik, nem egy újabb külön modulhalmazra.

## Egy mondatban

> **Nem scope-ot kell most már vágni a Phase 1-ből, hanem a megépített scope köré kell építeni azt a platformréteget és piaci működést, amitől a CompliFlow valóban eladható és skálázható lesz.**

---

# 39. Hivatkozási alap

A dokumentum a következőkre épül:

- `2026-07-31-compliflow-f1-requirements-spec.md`
- a CompliFlow Phase 1 piaci- és versenytárselemzésére;
- a korábbi `compliflow-prd-valtoztatasi-ajanlas-v2.0.md` ajánlásra;
- a Phase 2 elemzésből levont platformszintű tanulságokra;
- aktuális magyar munkavédelmi jogszabályok külön production legal gate melletti alkalmazására.

Elsődleges jogforrások:
- 1993. évi XCIII. törvény a munkavédelemről – Nemzeti Jogszabálytár: https://njt.hu/jogszabaly/1993-93-00-00
- 5/1993. (XII. 26.) MüM rendelet – Nemzeti Jogszabálytár: https://njt.hu/jogszabaly/1993-5-20-39
