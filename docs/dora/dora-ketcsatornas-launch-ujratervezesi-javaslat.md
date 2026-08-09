# DORA projekt – teljes, kétcsatornás launch-újratervezési javaslat

**Dátum:** 2026. július 17.  
**Döntési javaslat:** feltételes GO, jelentős újrapozicionálással  
**Javasolt terméktípus:** közvetlenül használható és tanácsadó által vezethető compliance delivery platform  
**Első két végügyfél-use case:**

1. közvetlenül NIS2-kötelezett kis- és középvállalatok;
2. NIS2- vagy DORA-érintett nagyvállalatok kisebb beszállítói.

---

# 1. Vezetői összefoglaló

A DORA projekt jelenlegi funkcionális alapjai értékesek:

- Scope Checker;
- kontroll-, követelmény-, dokumentum- és evidenciakezelés;
- interjúszerű ChatWizard;
- nyolcterületes Evidence Pack;
- beszállítói kérdőívkövetés;
- Service Register;
- szerződés-checklist;
- Trust Profile;
- Audit Package;
- valódi OSCAL-validáció;
- jóváhagyási workflow;
- workspace-alapú több-bérlős működés.

A jelenlegi termékdefiníció azonban túl sok, jelentősen eltérő piacot fog össze:

- NIS2-kötelezett magyar vállalatok;
- DORA-hatályú pénzügyi szervezetek;
- szabályozott nagyvállalatok ICT-beszállítói;
- egyéb nagyvállalati beszállítók;
- compliance- és információbiztonsági tanácsadók;
- auditorok;
- általános GRC-felhasználók.

Ezek eltérő problémát vásárolnak meg, és eltérő szintű szakértelemmel rendelkeznek.

## Javasolt stratégiai megoldás

Ne válasszunk kizárólag a direct KKV és a tanácsadói modell között. Épüljön egyetlen közös platform, három használati móddal:

### 1. Direct Guided

A KKV önállóan használja a rendszert:

- vezetett interjúkkal;
- közérthető magyarázatokkal;
- előre elkészített módszertannal;
- biztonságos blokkolásokkal;
- opcionális szakértői segítséggel.

### 2. Consultant Managed

A butik tanácsadó:

- saját ügyfél-workspace-eket kezel;
- interjúkat oszt ki;
- evidence-et ellenőriz;
- findingokat és intézkedéseket hagy jóvá;
- saját módszertant és brandinget használ;
- recurring compliance szolgáltatást ad el.

### 3. Hybrid / Expert Assisted

A KKV önállóan indul, de:

- egy kérdésnél;
- egy findingnál;
- egy dokumentumnál;
- a végső review-nál;
- vagy a teljes projekt során

meghívhat tanácsadót.

A három mód ugyanazt az adatot és workflow-t használja. Nem három külön terméket kell építeni.

## Javasolt publikus termékpozíció

Nem:

> „Teljes DORA- és NIS2-megfelelési platform minden KKV-nak.”

Hanem:

> **„Vezetett megfelelési platform NIS2-kötelezett vállalkozásoknak és nagyvállalati beszállítóknak – önálló használatra vagy szakértői támogatással.”**

Tanácsadói változata:

> **„White-label compliance delivery platform, amellyel több ügyfelet kezelhet egységes módszertannal, kevesebb manuális adminisztrációval.”**

---

# 2. Miért indokolt a kétcsatornás modell?

## 2.1 Van közvetlen KKV-igény

A közvetlen felhasználó jellemzően nem GRC-rendszert keres. Ezeket a kérdéseket akarja megoldani:

- Érint minket a szabályozás vagy az ügyfélkövetelmény?
- Mit kell dokumentálnunk?
- Mi van már meg?
- Mi hiányzik?
- Mit kell ténylegesen bevezetni?
- Melyik dokumentum vagy bizonyíték fogadható el?
- Mikorra kell elkészülnünk?
- Mit adhatunk át a megrendelőnek vagy auditornak?
- Mikor avul el egy korábbi bizonyíték?

## 2.2 Van erős tanácsadói igény

A butik tanácsadó problémája más:

- ugyanazokat a kérdéseket teszi fel több ügyfélnél;
- Excelben és Wordben dolgozik;
- emailben üldözi a dokumentumokat;
- manuálisan készít státuszriportot;
- a senior szakértő ideje az adatgyűjtésre fogy;
- egyedi minőséget nehéz egységesen fenntartani;
- a projektbevételt recurring szolgáltatássá szeretné alakítani.

## 2.3 A két csatorna erősíti egymást

A direct ügyfél:

- alacsonyabb belépési küszöböt kap;
- saját tempóban haladhat;
- később szakértőt vásárolhat;
- nem kényszerül az első naptól nagy tanácsadási projektre.

A tanácsadó:

- leadet kaphat az elakadt direct ügyfelekből;
- saját ügyfélportált használhat;
- nem veszti el a módszertanát;
- recurring bevételt építhet;
- nagyobb ügyfélszámot kezelhet.

A platform:

- több akvizíciós csatornát kap;
- termékhasználati adatból tanulhat;
- nem függ kizárólag hosszú partnerértékesítéstől;
- direct ügyfélből assisted ügyfelet;
- tanácsadói ügyfélből később self-managed ügyfelet alakíthat ki.

---

# 3. Piaci és szabályozási helyzet

## 3.1 A NIS2-piac a folyamatos megfelelés szakaszába lépett

A magyar kiberbiztonsági audit első jelentős határideje 2026. június 30-án lezárult. A következő keresleti hullám egyre inkább a megállapítások, intézkedések és bizonyítékok folyamatos fenntartásáról szól.

A termék ezért ne kizárólag ezt kommunikálja:

> „Készüljön fel az első auditra.”

Hanem ezt is:

> **„Tartsa fenn a megfelelést az audit után: kezelje a feladatokat, bizonyítékokat, változásokat és következő felülvizsgálatokat.”**

## 3.2 A NIS2 közvetett beszállítói piacot hoz létre

A szabályozott megrendelő:

- kérdőívet küld;
- szerződéses követelményeket ír elő;
- dokumentumot és bizonyítékot kér;
- incidensértesítési feltételeket szab;
- auditjogot tart fenn;
- időszakos újraértékelést végez.

A terméknek ezt a közvetett követelményfolyamot kell kezelnie anélkül, hogy a beszállítónak hamisan „NIS2-megfelelőséget” ígérne.

## 3.3 A DORA beszállítói use case szintén valós

A kisebb ICT-szolgáltató számára a közvetlen probléma:

- mit kér a bank;
- milyen szolgáltatást nyújtunk;
- hol vannak az adatok;
- kik az alvállalkozóink;
- milyen biztonsági kontrolljaink vannak;
- milyen bizonyítékot tudunk átadni;
- mit kell még pótolnunk.

---

# 4. A két elsődleges use case

## 4.1 Use case A – közvetlenül NIS2-kötelezett KKV

### Tipikus helyzet

- van belső IT-felelős, de nincs teljes compliance-csapat;
- audit előtt vagy audit után áll;
- dokumentumai szétszórtak;
- nem egyértelmű, melyik kontrollhoz milyen bizonyíték kell;
- a hiányosságoknak nincs felelőse és határideje;
- vezetői státusz nehezen állítható elő.

### Fő eredmény

> **A szervezet a vezetett felmérésből eljut egy bizonyítékokkal alátámasztott gap listáig, remediation tervig, dokumentációig és audit-ready csomagig.**

### Fő workflow

```text
Érintettségi és scope profil
→ szerepkörös interjú
→ rendszerek és szolgáltatások
→ kontrollállítások
→ evidence requestek
→ gap/finding
→ remediation
→ dokumentáció
→ jóváhagyás
→ audit-ready csomag
→ folyamatos felülvizsgálat
```

## 4.2 Use case B – nagyvállalati beszállító

### Tipikus helyzet

- bank, biztosító, telco vagy más nagyvállalat kérdőívet küld;
- biztonsági szabályzatokat kér;
- subprocesszorlistát, BCP-t vagy pentestet kér;
- a beszállító nem tudja, mi releváns;
- ugyanazt az információt több ügyfél más formában kéri;
- nincs naprakész, jóváhagyott válasz- és dokumentumtár.

### Fő eredmény

> **A beszállító egyszer összeállítja ellenőrzött biztonsági profilját, majd ügyfélspecifikusan újrahasznosítható válasz- és bizonyítékcsomagot készít.**

### Fő workflow

```text
Megrendelői kérés vagy kérdőív
→ követelmények strukturálása
→ beszállítói szolgáltatási profil
→ vezetett interjú
→ jóváhagyott állítások
→ evidence
→ hiányzó intézkedések
→ ügyfélspecifikus válaszcsomag
→ megosztás
→ visszakérdezés
→ frissességkövetés
```

---

# 5. A három működési mód részletesen

## 5.1 Direct Guided mód

### Kinek való?

- kisebb KKV;
- van motivált belső felelőse;
- a scope nem túl komplex;
- szeretne költséghatékonyan elindulni;
- nem akar azonnal teljes tanácsadási projektet.

### Mit kap?

- előre konfigurált NIS2 vagy Supplier Readiness sablon;
- közérthető onboarding;
- szerepkörös interjúk;
- bizonyítékpéldák;
- feladatlista;
- dokumentumvázlatok;
- readiness dashboard;
- export;
- opcionális expert review.

### Kötelező korlát

A rendszer ne hozzon önállóan végleges döntést:

- jogi érintettségről;
- kontroll megfelelőségéről;
- kockázatelfogadásról;
- auditor számára tett nyilatkozatról;
- dokumentum tényleges bevezetettségéről.

Az eredmény státuszai:

- ügyfél által megadott;
- bizonyítékkal alátámasztott;
- szakértő által felülvizsgált;
- nem ellenőrzött;
- ellentmondásos;
- hiányos.

## 5.2 Consultant Managed mód

### Kinek való?

- compliance boutique;
- vCISO-szolgáltató;
- információbiztonsági tanácsadó;
- ISO 27001- vagy NIS2-felkészítő;
- több ügyfelet kezelő IT-biztonsági szolgáltató.

### Mit kap?

- multi-client cockpit;
- saját módszertan;
- saját kérdéssablon;
- saját dokumentumsablon;
- white-label ügyfélportál;
- ügyfélinterjúk;
- evidence review;
- gap és remediation;
- portfólióriport;
- recurring compliance workflow.

### A tanácsadónál maradó döntések

- scope véglegesítése;
- nem alkalmazhatóság jóváhagyása;
- finding súlyossága;
- kockázati minősítés;
- szabályzat jóváhagyása;
- evidence elfogadása;
- végső ügyfélriport;
- auditor számára átadott állítás.

## 5.3 Hybrid / Expert Assisted mód

### Lehetséges szakértői szolgáltatások

- 60 perces scope review;
- interjúeredmény-review;
- gap validation;
- dokumentum-review;
- supplier questionnaire review;
- auditcsomag-review;
- teljes projektátvétel;
- havi vCISO/compliance retainer.

### Működési szabály

A KKV ugyanabban a workspace-ben marad. Nem kell adatot exportálni és más rendszerbe költözni.

A tanácsadó:

- meghívást kap;
- hozzáférési szintet kap;
- review-t végez;
- megjegyzést és approvalt ad;
- később eltávolítható vagy lecserélhető.

---

# 6. Javasolt termékarchitektúra

## 6.1 Közös platformmag

Minden csatorna ugyanazokat az objektumokat használja:

```text
Organization
├── Legal and scope profile
├── Services
├── Systems / EIR
├── Roles and people
├── Interview campaigns
├── Statements
├── Requirements
├── Controls
├── Evidence requests
├── Evidence
├── Findings
├── Risks
├── Remediations
├── Tasks
├── Documents
├── Approvals
├── Assurance requests
├── Response packages
└── Audit log
```

## 6.2 Munkaterületek

### Organization Workspace

A direct KKV saját megfelelési környezete.

### Consultant Portfolio

A tanácsadó ügyfélportfóliója.

### Client Portal

A tanácsadó ügyfelének egyszerű felülete.

### Expert Partner Directory

Launchkor ne nyílt piactér legyen. Elegendő:

- platform által ajánlott partner;
- ügyfél által meghívott tanácsadó;
- review-csomag megvásárlása;
- partner hozzárendelése.

### External Assurance Portal

Megrendelőnek vagy auditornak átadható korlátozott nézet.

---

# 7. A jelenlegi funkciók szükséges módosítása

## 7.1 Scope Checker

### Új szerep

- use case kiválasztása;
- előzetes érintettségi profil;
- megfelelő sablon elindítása;
- expert review felajánlása;
- verziózott scope-nyilatkozat.

### Kimeneti státuszok

- valószínűleg közvetlenül érintett;
- további adatok szükségesek;
- valószínűleg nem közvetlenül érintett, de supplier assurance követelmény várható;
- szakértői felülvizsgálat javasolt.

Ne jelenjen meg kategorikus jogi tanácsként.

## 7.2 ChatWizard → Guided Compliance Interview

Ez legyen a termék központi motorja.

### Kötelező képességek

- szerepkörönkénti kérdéscsomag;
- adaptív kérdéságak;
- több válaszadó;
- részleges mentés;
- kérdés delegálása;
- „nem tudom” lehetőség;
- „miért kérdezzük?” magyarázat;
- válaszhoz csatolt evidence;
- follow-up kérdés;
- válaszverzió;
- válasz bizonyossági státusz;
- ellentmondásfelismerés;
- self-service és consultant review mód.

### Kimeneti lánc

```text
Válasz
→ szervezeti állítás
→ kontrollkapcsolat
→ bizonyítékigény
→ hiányosság
→ intézkedés
→ dokumentumban felhasználható tény
```

## 7.3 Evidence Pack → Evidence Request Plan

Minden evidence request tartalmazza:

- mit kérünk;
- miért kérjük;
- melyik kontrollhoz kell;
- milyen példák fogadhatók el;
- melyik időszakból kell;
- ki a felelős;
- mikor esedékes;
- milyen bizalmasságú;
- ki review-zza;
- mikor jár le.

## 7.4 Evidence Freshness

Ez legyen P0 launch-funkció.

Minden bizonyítéknál:

- keletkezési dátum;
- érintett időszak;
- forrás;
- tulajdonos;
- verzió;
- reviewer;
- érvényesség;
- következő felülvizsgálat;
- kapcsolódó rendszer;
- kapcsolódó kontroll;
- újrafelhasználhatóság.

Állapotok:

- friss;
- felülvizsgálat közeleg;
- lejárt;
- forrásváltozás miatt újraellenőrizendő;
- nem igazolja megfelelően az állítást.

## 7.5 Banki kérdőív-tracker → Assurance Request Inbox

### P0/P1 célkép

- Excel-, DOCX- és PDF-kérdőív feltöltése;
- kérdések strukturálása;
- határidő;
- felelős;
- kapcsolódó szolgáltatás;
- korábbi jóváhagyott válasz javaslata;
- evidence kapcsolat;
- ügyfélspecifikus eltérés;
- review;
- elküldés;
- visszakérdezés;
- lezárás.

## 7.6 Service Register

Kétféle nézet szükséges.

### NIS2 use case

- kritikus üzleti szolgáltatás;
- támogató rendszer;
- függőség;
- felelős;
- RTO/RPO;
- kockázat;
- kontroll;
- bizonyíték.

### Supplier use case

- megrendelőnek nyújtott szolgáltatás;
- adatkezelés;
- hosting;
- adatkezelési hely;
- alvállalkozó;
- kritikus funkció támogatása;
- SLA;
- incidenskapcsolat;
- BCP/exit.

## 7.7 Szerződés-checklist

Maradhat, de ne adjon automatikus jogi megfelelőségi minősítést.

Kimenetek:

- követelmény megtalálható;
- részben szerepel;
- hiányzik;
- nem alkalmazható;
- jogi review szükséges;
- javasolt tisztázó kérdés;
- javasolt klauzulavázlat.

## 7.8 Trust Profile

Opcionális külső réteg legyen.

Hozzáférési szintek:

- publikus;
- regisztrációhoz kötött;
- meghívott partner;
- NDA után;
- konkrét megrendelőnek;
- visszavonható.

Csak jóváhagyott és érvényes elemek jelenhessenek meg.

## 7.9 Audit Package és OSCAL

Javasolt megfogalmazás:

> **„Auditor-kompatibilis, strukturált audit-előkészítő csomag OSCAL-alapú exportlehetőséggel.”**

## 7.10 Approval workflow

Bővítendő:

- válaszjóváhagyás;
- evidence approval;
- finding validation;
- remediation lezárás;
- dokumentumjóváhagyás;
- risk acceptance;
- supplier response approval;
- dual approval;
- delegált jóváhagyó;
- lejáró approval;
- visszaküldési ok;
- bizonyítható approval record.

---

# 8. Direct KKV UX

## 8.1 Kezdőképernyő

Főcím:

> **A következő lépések a megfeleléshez**

Például:

- 6 kérdés megválaszolása;
- 3 dokumentum feltöltése;
- 2 hiányosság javítása;
- 1 dokumentum jóváhagyása;
- következő szakértői review: nincs lefoglalva.

## 8.2 Navigáció

Direct KKV-nál legfeljebb:

1. Áttekintés
2. Felmérés
3. Teendők
4. Dokumentumok
5. Bizonyítékok
6. Megosztás

A kontrollkatalógus és OSCAL ne legyen elsődleges navigáció.

## 8.3 Egyszerű nyelv

Ne:

> „A 4.3.2 kontroll implementációs státusza nem megfelelő.”

Hanem:

> **„Nincs bizonyíték arra, hogy rendszeresen felülvizsgálják a felhasználói hozzáféréseket.”**

Alatta:

- miért fontos;
- mit kell megtenni;
- milyen bizonyíték fogadható el;
- ki legyen a felelős;
- mikorra készüljön el;
- kérhető-e szakértői segítség.

## 8.4 Expert escalation

Minden jelentős objektumnál elérhető:

- „Kérek szakértői review-t”
- „Meghívom a tanácsadómat”
- „Nem tudom eldönteni”
- „Ezt a válaszomat ellenőrizze szakértő”

---

# 9. Consultant UX

## 9.1 Consultant Cockpit

Felső KPI-k:

- aktív ügyfelek;
- veszélyben lévő projektek;
- csúszó interjúk;
- lejárt evidence-ek;
- review-ra váró válaszok;
- nyitott supplier requestek;
- közelgő riportok.

## 9.2 Ügyfélportfólió

| Ügyfél | Use case | Fázis | Kockázat | Következő lépés | Határidő |
|---|---|---|---|---|---|
| Alfa Kft. | NIS2 | Evidence | Magas | IT-interjú lezárása | júl. 22. |
| Beta SaaS | Supplier | Kérdőív | Közepes | BCP feltöltése | júl. 24. |

## 9.3 Consultant-first képességek

- ügyfél indítása sablonból;
- saját kérdéssablon;
- saját dokumentumsablon;
- saját maturity modell;
- bulk feladatkiosztás;
- review queue;
- ügyfélközi portfóliónézet;
- white-label riport;
- white-label email;
- ügyfél státuszriport;
- recurring havi workflow.

## 9.4 Szakmai kontroll

A tanácsadó felülírhatja az automatikus javaslatot, de:

- indokolnia kell;
- a változás naplózott;
- látható az eredeti javaslat;
- látható a korábbi verzió;
- ügyféljóváhagyás kérhető.

---

# 10. Szerepkörök és jogosultságok

## KKV-oldal

### Workspace Owner

- előfizetés;
- felhasználók;
- szervezeti adatok;
- megosztások;
- tanácsadó meghívása.

### Compliance Owner

- teljes workflow;
- finding;
- remediation;
- dokumentum;
- export.

### Management Approver

- vezetői jóváhagyás;
- risk acceptance;
- dokumentum hatályba helyezése.

### IT/HR/Legal/Process Owner

- saját interjú;
- saját evidence;
- saját feladat;
- korlátozott szervezeti nézet.

### External Consultant

- szerződés szerinti hozzáférés;
- review;
- szerkesztés;
- jóváhagyás;
- riport.

### Auditor/Customer Reviewer

- időben és scope-ban korlátozott read-only hozzáférés.

## Tanácsadói oldal

- Practice Owner;
- Lead Consultant;
- Consultant;
- Reviewer;
- Client Success/Admin;
- korlátozott külső szakértő.

---

# 11. AI és automatizáció felelősségi modell

## AI használható

- kérdések egyszerűsítésére;
- follow-up kérdés javaslatára;
- dokumentumból kérdések strukturálására;
- hasonló korábbi válasz keresésére;
- bizonyíték relevanciájának előszűrésére;
- ellentmondásjelzésre;
- dokumentumvázlat készítésére;
- remediation javaslatára;
- vezetői összefoglaló draftjára.

## AI nem dönthet önállóan

- jogi érintettségről;
- megfelelőségről;
- kockázatelfogadásról;
- evidence végleges elfogadásáról;
- kontroll tényleges működéséről;
- dokumentum hatályba helyezéséről;
- megrendelőnek vagy auditornak kiküldött végső válaszról.

## Kötelező provenance

Minden AI-javaslatnál:

- milyen forrásból készült;
- mely válaszokat használta;
- mely dokumentumot használta;
- mely szabályverzióra épül;
- ki hagyta jóvá;
- mikor módosult.

---

# 12. Biztonsági és bizalmi launch-gate-ek

## P0 követelmények

- production KMS;
- titkosítás átvitelkor és tároláskor;
- MFA tanácsadóknak és adminoknak;
- MFA-opció minden ügyfélnek;
- szigorú tenantizoláció;
- objektumszintű jogosultság;
- malware scan;
- session revoke;
- auditnapló;
- backup;
- restore teszt;
- incidenskezelési terv;
- DPA;
- alvállalkozói lista;
- adatmegőrzési beállítás;
- export;
- törlés;
- security contact;
- vulnerability disclosure folyamat.

## Nyilvános launch előtt

- független penetration test;
- tenant breakout teszt;
- privilege escalation teszt;
- fájlhozzáférési teszt;
- backup restore teszt;
- kritikus és magas hibák lezárása;
- incidens tabletop.

---

# 13. Árazási modell

Az árak pilothipotézisek, valódi fizetési hajlandósággal validálandók.

## 13.1 Direct Guided – NIS2

### Direct Starter

**29 900–49 900 Ft + áfa/hó**

- 1 jogi entitás;
- vezetett felmérés;
- feladatok;
- evidence;
- alap dokumentumok;
- audit-readiness;
- 5 belső felhasználó.

### Direct Continuous

**69 900–99 900 Ft + áfa/hó**

- evidence freshness;
- ismétlődő review;
- több rendszer/szolgáltatás;
- remediation;
- fejlettebb dokumentáció;
- vezetői riport;
- supplier assurance alapok;
- több felhasználó.

## 13.2 Direct Supplier

### Supplier Starter

**14 900–24 900 Ft + áfa/hó**

- 1 vállalkozás;
- 1 szolgáltatási profil;
- evidence pack;
- alap kérdőívkezelés;
- dokumentumprofil;
- korlátozott Trust Profile.

### Supplier Professional

**34 900–59 900 Ft + áfa/hó**

- több szolgáltatás;
- több ügyfélkérés;
- válasz-újrahasznosítás;
- approval;
- lejáratfigyelés;
- ügyfélspecifikus export;
- NDA-s megosztás később.

## 13.3 Expert review add-onok

- Scope review: 50–100 ezer Ft;
- Gap review: 100–250 ezer Ft;
- dokumentációs review: csomag szerint;
- supplier questionnaire review: kérdőívméret szerint;
- teljes assisted onboarding: 250 ezer–1 millió Ft+;
- havi vCISO/compliance: partneri ajánlat.

## 13.4 Consultant pricing

### Boutique Starter

**59 900–89 900 Ft + áfa/hó**

- 2 tanácsadó;
- 3 aktív ügyfél;
- két alap sablon;
- client portal;
- interview;
- evidence;
- remediation;
- riport.

### Boutique Professional

**149 900–249 900 Ft + áfa/hó**

- 5–10 tanácsadó;
- 10–15 aktív ügyfél;
- saját sablon;
- white-label;
- portfóliódashboard;
- Supplier Assurance;
- prioritásos support.

### További aktív ügyfél-workspace

**10 000–25 000 Ft + áfa/hó**

## 13.5 Fontos kereskedelmi szabály

A tanácsadó által hozott ügyfélnél:

- a tanácsadó dönthessen, hogy ő vagy az ügyfél fizet;
- a tanácsadó adhasson saját csomagárat;
- a platformdíj ne kannibalizálja a szolgáltatási díját;
- legyen wholesale/partnerár.

---

# 14. Onboarding

## 14.1 Direct KKV onboarding

### 1. Miért használja?

- közvetlen NIS2;
- audit utáni remediation;
- nagyvállalati beszállító;
- banki/DORA supplier request;
- nem tudom.

### 2. Szervezeti gyorsprofil

- méret;
- ágazat;
- szolgáltatások;
- ügyféltípus;
- IT-modell;
- adatkezelés;
- szabályozási helyzet.

### 3. Használati mód

- önállóan;
- saját tanácsadóval;
- kérek szakértőt.

### 4. Első interjúkampány

A rendszer szerepkörönként meghívja a résztvevőket.

### 5. Első eredmény

Ne compliance százalékot mutasson, hanem:

- megválaszolt területek;
- alátámasztott állítások;
- hiányzó evidence;
- magas kockázatú gap;
- következő három lépés.

## 14.2 Tanácsadói onboarding

- tanácsadócég profilja;
- branding;
- saját módszertan;
- sablon kiválasztása;
- saját kérdések importja;
- saját dokumentumsablon;
- első mintaügyfél;
- jogosultsági modell;
- ügyfélmeghívó;
- első státuszriport.

---

# 15. Landing és kommunikáció

## 15.1 Közös főoldal

Hero:

> **A megfelelés nem egy Excel és nem egy egyszeri dokumentumcsomag.**

Alcím:

> Vezetett interjúk, bizonyítékok, hiányosságok, intézkedések és jóváhagyott dokumentáció egy rendszerben – önálló használatra vagy szakértői támogatással.

Fő választás:

- Vállalkozásként használom
- Tanácsadóként használom

## 15.2 KKV landing

Headline:

> **Lépésről lépésre a NIS2- és beszállítói biztonsági követelmények teljesítéséhez.**

CTA:

- Ingyenes előzetes felmérés
- Szakértővel szeretném

## 15.3 Beszállítói landing

Headline:

> **Nagyvállalati ügyfele biztonsági dokumentációt kér? Ne kezdje minden alkalommal elölről.**

CTA:

- Beszállítói profil indítása
- Kérdőív feltöltése

## 15.4 Tanácsadói landing

Headline:

> **Kezeljen több compliance ügyfelet egységesebb minőségben, kevesebb manuális adminisztrációval.**

CTA:

- Tanácsadói demo
- Mintaügyfél-workspace

## 15.5 Kerülendő állítások

- teljes DORA compliance;
- garantált NIS2-megfelelés;
- auditor helyettesítése;
- hatóságilag elfogadott automatikus export;
- AI által garantált szabályzat;
- automatikus jogi vélemény;
- minden framework teljes támogatása;
- bizonyítatlan költség- vagy időmegtakarítás.

---

# 16. P0 launch-scope

## Közös P0

- regulation-neutral platformpozíció;
- két use case;
- három működési mód;
- közös workspace-adatmodell;
- Guided Compliance Interview;
- több válaszadó;
- adaptív kérdések;
- válaszverzió;
- bizonyossági státusz;
- evidence request;
- evidence upload;
- evidence freshness;
- finding/gap;
- remediation;
- feladat;
- dokumentumlifecycle;
- approval;
- auditlog;
- audit-ready export;
- biztonsági launch-gate-ek;
- entitlement és pricing.

## Direct P0

- közérthető onboarding;
- önálló felmérés;
- egyszerű feladatnézet;
- dokumentumpéldák;
- biztonságos blokkolás;
- szakértő meghívása;
- expert review CTA;
- előfizetés;
- support.

## Consultant P0

- multi-client cockpit;
- ügyfélindítás sablonból;
- saját alap branding;
- client portal;
- review queue;
- saját kérdéskiegészítés;
- ügyfélriport;
- partnerárazás;
- consultant audit trail.

## Supplier P0

- szolgáltatási profil;
- kérdőív feltöltése legalább Excelből;
- evidence pack;
- válaszjóváhagyás;
- ügyfélspecifikus csomag;
- subprocesszorlista;
- korlátozott Trust Profile;
- megosztásnapló.

---

# 17. P1 – launch utáni 30–90 nap

- PDF/DOCX kérdőívimport;
- hasonló kérdések automatikus matchingje;
- korábbi válasz újrahasznosítása;
- NDA-gated megosztás;
- tanácsadói saját módszertan-szerkesztő;
- saját dokumentumsablon;
- white-label email és domain;
- Teams/Jira/Planner integráció;
- bulk evidence import;
- recurring havi compliance workflow;
- supplier request inbox;
- direct ügyfél–partner matching;
- szakértői szolgáltatás vásárlása;
- dokumentum- és evidence-review csomagok.

---

# 18. P2 – későbbi terjeszkedés

- nagyvállalati buyer-side supplier assurance;
- beszállítói portfólió;
- buyer által indított request;
- automatikus evidence collectorok;
- Microsoft 365/Entra integráció;
- AWS/Azure/GCP;
- Defender;
- GitHub/GitLab;
- ServiceNow;
- teljes DORA Register of Information;
- DORA incident reporting;
- resilience testing;
- concentration risk;
- exit strategy;
- teljes DORA Financial Entity modul;
- további EU-országok lokalizációja.

---

# 19. Amit ki kell venni vagy hátrébb kell sorolni

## Kiveendő a launchígéretből

- teljes DORA platform;
- teljes enterprise GRC;
- minden framework;
- auditor helyettesítése;
- automatikus végső megfelelőségi döntés;
- hivatalos RoI generator megfelelő adatmodell nélkül;
- teljes incident management;
- teljes BCP/DR suite;
- generikus AI-chat;
- MCP-paritás mint buyer-facing érték.

## Hátrébb sorolandó

- nagy számú automated collector;
- enterprise buyer-side TPRM;
- teljes pénzügyi DORA-modul;
- globális framework-katalógus;
- komplex asset management;
- teljes auditorportál.

---

# 20. Pilotmodell

## 20.1 Pilotcsoportok

### Direct KKV pilot

- 3–5 közvetlenül NIS2-kötelezett KKV;
- 3–5 nagyvállalati beszállító;
- legalább egy banki vagy biztosítói ICT-beszállító;
- eltérő belső szakértelmi szint.

### Tanácsadói pilot

- 3–5 butik tanácsadó;
- partnerenként 2–3 ügyfél;
- NIS2 és supplier use case is;
- saját módszertan kipróbálása.

### Hybrid pilot

- legalább 3 direct ügyfél, aki menet közben kér expert review-t;
- legalább 2 ügyfél, aki saját tanácsadót hív meg.

## 20.2 Pilot sikerkritériumok

- direct ügyfél külső segítség nélkül eljut az első érdemi gap listáig;
- nem értelmezi a rendszer javaslatát auditor által jóváhagyott megfelelésnek;
- a tanácsadó ugyanabban a workspace-ben tud review-zni;
- csökken az emailes dokumentumvadászat;
- minden kritikus állítás mögött evidence vagy látható hiány van;
- a kérdőívválaszok újrahasznosíthatók;
- a tanácsadó hajlandó fizetni;
- a direct KKV hajlandó fizetni;
- nincs jogosultsági vagy tenantizolációs incidens.

---

# 21. Launch-KPI-k

## Direct funnel

1. előzetes felmérés;
2. regisztráció;
3. szervezeti profil;
4. első interjú;
5. első evidence;
6. első gap;
7. első remediation;
8. első dokumentum;
9. expert review vagy export;
10. fizetés;
11. második havi aktív használat.

## Consultant funnel

1. demo;
2. consultant workspace;
3. első ügyfél;
4. interjúkampány;
5. evidence review;
6. ügyfélriport;
7. második ügyfél;
8. fizetős partner;
9. aktív ügyfélszám növekedése.

## Elsődleges KPI-k

### Direct

> **A regisztrált KKV-k hány százaléka jut el 14 napon belül bizonyítékokkal alátámasztott első gap- és intézkedési tervig?**

### Consultant

> **Hány aktív ügyfelet tud egy tanácsadó ugyanazzal a senior kapacitással, azonos vagy jobb minőségben kezelni?**

### Supplier

> **Mennyivel csökken egy következő ügyfélkérdőív válaszideje a jóváhagyott válaszok és evidence-ek újrahasznosításával?**

## Javasolt pilotcélok

| Mutató | Kezdeti cél |
|---|---:|
| Direct onboarding befejezése | ≥70% |
| Első interjúkampány befejezése | ≥65% |
| Első evidence feltöltése | ≥70% |
| Első gap terv 14 napon belül | ≥50% |
| Expert review-t kérő direct ügyfelek | 15–35% |
| Direct trial → fizetés | ≥15% |
| Consultant pilot → fizetés | ≥50% |
| Ügyfél/workspace indítása tanácsadónál | <30 perc |
| Státuszriport-idő csökkenése | ≥50% |
| Második kérdőívnél újrahasznosított válaszok | ≥30% |
| Jóváhagyás nélkül végleges output | 0 |
| Kritikus tenantizolációs hiba | 0 |

---

# 22. Go/no-go launch gate

## Pozicionálás

- [ ] A termék nem állít teljes DORA- vagy NIS2-megfelelést.
- [ ] A direct és consultant út egyaránt látható.
- [ ] A két use case világosan elkülönül.
- [ ] Az önálló, szakértői és hybrid működés érthető.
- [ ] A tanácsadó szerepe nem kannibalizált.

## Direct működés

- [ ] A KKV önállóan létre tud hozni workspace-t.
- [ ] Közérthető onboarding működik.
- [ ] Guided Interview működik.
- [ ] Bizonytalan esetben a rendszer blokkol vagy review-t ajánl.
- [ ] Szakértő meghívható.
- [ ] Direct előfizetés és entitlement működik.

## Consultant működés

- [ ] Multi-client cockpit működik.
- [ ] Ügyfél sablonból indítható.
- [ ] Client Portal működik.
- [ ] Consultant review és approval működik.
- [ ] Alap white-label működik.
- [ ] Partnerár és ügyfélfizetési modell működik.

## Core workflow

- [ ] Több válaszadó kezelhető.
- [ ] Válaszverziózás működik.
- [ ] Bizonyossági státusz működik.
- [ ] Evidence request működik.
- [ ] Evidence upload productionben működik.
- [ ] Evidence freshness működik.
- [ ] Finding és remediation működik.
- [ ] Dokumentumlifecycle működik.
- [ ] Approval workflow működik.
- [ ] Assurance Pack exportálható.
- [ ] Audit Package exportálható.
- [ ] Emberi nyelvű validációs hibák vannak.

## Biztonság

- [ ] Production KMS működik.
- [ ] MFA működik.
- [ ] Tenantizoláció függetlenül tesztelt.
- [ ] Malware scan működik.
- [ ] Auditnapló védett.
- [ ] Backup restore teszt zöld.
- [ ] Penetrációs teszt megtörtént.
- [ ] Nincs nyitott critical/high sérülékenység.
- [ ] DPA és alvállalkozói lista elérhető.
- [ ] Incidensfolyamat dokumentált.

## Piaci validáció

- [ ] Legalább 5 direct KKV használta.
- [ ] Legalább 5 supplier KKV használta.
- [ ] Legalább 3 butik tanácsadó használta.
- [ ] Legalább 10 tanácsadó által kezelt ügyfél-workspace futott.
- [ ] Mindkét use case valós projektben végigment.
- [ ] Legalább 200 interjúválasz feldolgozva.
- [ ] Legalább 300 evidence-objektum kezelve.
- [ ] Legalább 50 finding/remediation végigment.
- [ ] Legalább 5 teljes átadási csomag elkészült.
- [ ] Direct és tanácsadói fizetési hajlandóság is igazolt.
- [ ] Kritikus adatvesztés és jogosultsági incidens: 0.

---

# 23. Végső prioritási sorrend

## Azonnal előrehozandó

1. Evidence upload productionjavítása.
2. Két use case és három működési mód véglegesítése.
3. Guided Compliance Interview újratervezése.
4. Direct KKV onboarding.
5. Consultant multi-client cockpit.
6. Válasz–állítás–evidence–gap–remediation lánc.
7. Evidence Freshness.
8. Expert invitation és hybrid workflow.
9. Assurance Request Inbox alap.
10. Pricing és entitlement.
11. Approval workflow bővítése.
12. Security launch-gate-ek.

## Megtartandó, de átpozicionálandó

- Scope Checker;
- Evidence Pack;
- ChatWizard;
- Service Register;
- szerződés-checklist;
- Trust Profile;
- Audit Package;
- OSCAL;
- banki kérdőív-tracker.

## Hátrébb sorolandó

- teljes DORA Financial Entity modul;
- natív teljes RoI;
- incident reporting;
- automated collectorok tömege;
- enterprise TPRM;
- MCP/AI agent paritás;
- generikus GRC-terjeszkedés.

---

# 24. Végső döntés

## GO – kétcsatornás platformként

A helyes launchmodell nem kizárólag consultant-first és nem kizárólag self-service.

A végleges pozíció:

> **„Vezetett compliance delivery platform NIS2-kötelezett KKV-knak és szabályozott nagyvállalatok beszállítóinak – közvetlen használatra, saját tanácsadóval vagy platformon keresztül igénybe vehető szakértői támogatással.”**

Tanácsadói pozíció:

> **„White-label platform, amely a butik tanácsadó módszertanát strukturált interjúvá, evidenciagyűjtéssé, gap- és remediation folyamattá, dokumentációvá és recurring ügyfélszolgáltatássá alakítja.”**

A platform fő értéklánca:

```text
Interjú
→ ellenőrzött állítás
→ bizonyíték
→ hiányosság
→ intézkedés
→ dokumentáció
→ szakértői vagy vezetői jóváhagyás
→ auditornak vagy megrendelőnek átadható csomag
→ folyamatos frissességkövetés
```

Ez a modell:

- megtartja a közvetlen KKV-piacot;
- kihasználja a tanácsadói értékesítési és bizalmi csatornát;
- nem kényszerít minden ügyfelet drága projektre;
- nem próbálja kiváltani a szakértőt;
- támogatja a NIS2-kötelezett és supplier use case-et;
- recurring SaaS használatot teremt;
- a jelenlegi funkcionális alapok jelentős részét újrahasznosítja;
- később természetesen bővíthető buyer-side supplier assurance és teljesebb DORA-modulok felé.
