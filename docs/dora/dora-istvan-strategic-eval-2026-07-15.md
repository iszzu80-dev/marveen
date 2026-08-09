# DORA üzleti és versenypiaci szakértői felülvizsgálat

**Döntési státusz:** Feltételes GO, újrapozicionálással  
**Javasolt elsődleges termékirány:** Magyar NIS2 folyamatos megfelelési és auditkészenléti platform  
**Másodlagos termékirány:** DORA Supplier Assurance ICT-beszállítók számára  
**Nem javasolt jelenleg:** általános DORA/NIS2 all-in-one platformként történő piacra lépés

---

## 1. Vezetői összefoglaló

Az eredeti üzleti és versenypiaci értékelés **kód- és funkcióauditként erős**, de **piaci és üzleti döntési dokumentumként több lényeges korrekciót igényel**.

A feltételes GO döntés megtartható, de nem a jelenlegi, túl tág:

> „DORA/NIS2 compliance platform KKV-knak”

pozicionálással.

### Összesített értékelés

| Terület | Értékelés | Fő probléma |
|---|---:|---|
| Kód- és funkcióállapot feltárása | 8/10 | Józanul jelzi a hibákat és stubokat |
| Célpiac meghatározása | 5/10 | Összemossa a DORA közvetlen, DORA beszállítói és NIS2 piacot |
| Versenytárselemzés | 5/10 | Kimarad jelentős magyar és nemzetközi konkurencia |
| Funkcionális versenyképesség | 6/10 | Sok funkció van, de a legfontosabb flow nem élesképes |
| Árazás | 5/10 | Nincs fizetési hajlandósággal validálva, a csomagok rosszul szegmentáltak |
| Értékajánlat | 4/10 | Túl sok szabályozást és túl nagy eredményt ígér egyszerre |

Az eredeti dokumentum helyesen azonosítja:

- az Evidence-feltöltés hibáját;
- a landing és a backend pricing mismatch-et;
- a hiányzó billinget;
- a nem kész NIS2 Scope Checkert;
- a proxyként működő RoI-funkciót;
- a félkész CCM-connectorkészletet;
- a white-label és egyéb landing-overclaim problémákat.

Ezek értékes, őszinte és döntésre alkalmas megállapítások.

---

## 2. A legfontosabb célpiaci probléma

A jelenlegi három célcsoport valójában **három különálló termékpiac**.

## 2.1 Közvetlen DORA-hatályú pénzügyi szervezetek

Ide tartoznak többek között a DORA-rendeletben felsorolt pénzügyi entitások:

- bankok;
- biztosítók;
- befektetési vállalkozások;
- pénzforgalmi szolgáltatók;
- elektronikuspénz-kibocsátók;
- egyes alapkezelők;
- egyéb szabályozott pénzügyi szervezetek.

Számukra a fő problémák:

- ICT third-party register és Register of Information;
- beszállítói szerződések DORA-megfelelősége;
- ICT-kockázatkezelés;
- incidensjelentés;
- rezilienciatesztek;
- beszállítói koncentráció;
- exit stratégiák;
- kritikus szolgáltatások és függőségek kezelése.

Ez nem elsősorban „evidence pack” piac, hanem **szabályozott működési, adatmodell- és beszállítókezelési probléma**.

A korábbi 3–5 ezer magyar, közvetlenül DORA-hatályos KKV becslés nem tűnik kellően megalapozottnak. A DORA meghatározott pénzügyi entitásokra vonatkozik, és több mikrovállalati vagy közvetítői kategória kivételt is élvezhet.

**Következmény:** a közvetlen DORA-piacot nem szabad összemosni a teljes magyar KKV-piaccal.

## 2.2 ICT-beszállítók

Egy átlagos banki ICT-beszállító nem válik automatikusan teljes körű, közvetlen DORA-kötelezetté.

A követelmények jellemzően a pénzügyi intézmény:

- szerződéses feltételein;
- auditjogain;
- incidensbejelentési elvárásain;
- üzletmenet-folytonossági követelményein;
- biztonsági kérdőívein;
- bizonyítékbekérésein

keresztül jutnak el hozzá.

A kritikusnak minősített ICT third-party providerekre ennél közvetlenebb felügyeleti rezsim is vonatkozhat, de ez nem az átlagos magyar KKV-beszállító helyzete.

Ezért nem szerencsés az alábbi pozicionálás:

> „DORA compliance platform beszállítóknak.”

Pontosabb:

> **DORA Supplier Assurance és banki ügyfélkérésekre felkészítő platform.**

A szegmens fő értékei:

- újrahasznosítható beszállítói bizonyítéktár;
- szerződéses követelmény-checklist;
- banki kérdőívek gyorsabb megválaszolása;
- incidens-, BCP-, DR- és tesztbizonyítékok kezelése;
- ügyfelenként átadható trust package;
- verziózott és lejáratkezelt dokumentumkészlet.

## 2.3 NIS2 és a magyar kiberbiztonsági szabályozás hatálya alá tartozó szervezetek

Ez a legjobban meghatározható magyar célpiac.

Az SZTFH 2026. július 10-i közlése szerint:

- 2 520 auditköteles szervezet szerepelt a nyilvántartásban;
- közülük 2 132 teljesítette a június 30-i auditkötelezettséget;
- további, még nem regisztrált érintettek létezése is valószínű.

Ebből azonban nem vezethető le automatikusan az eredeti elemzésben szereplő 5–8 ezres piac.

Üzletileg fontos változás, hogy 2026 júliusában már nem elsősorban az a kérdés:

> „Hogyan készüljek fel az első auditra?”

hanem:

> **„Hogyan maradjon naprakész a megfelelésem az audit után, és hogyan készüljek fel a következő ciklusra?”**

Ez kifejezetten jól illik a Dora meglévő funkcióihoz:

- követelmények;
- kontrollok;
- bizonyítékok;
- eltérések;
- remediation;
- lejáratok;
- incidensek;
- auditcsomag;
- VMI/SZEKI előzetes szimuláció;
- tanácsadói multi-tenant működés.

---

## 3. Javasolt elsődleges termékirány

A Dora fő pozícióját így érdemes módosítani:

> **Magyar NIS2 folyamatos megfelelési és auditkészenléti platform KKV-knak és tanácsadóknak.**

A DORA két külön termékvonalként jelenjen meg:

1. **DORA Supplier Assurance** – ICT-beszállítók számára.
2. **DORA Financial Entity** – pénzügyi intézmények számára, későbbi, magasabb árszintű termékként.

Ez nem csak marketingváltozás.

A három termékvonalhoz eltér:

- a vásárló;
- a fizetési hajlandóság;
- a jogi felelősség;
- az adatmodell;
- a szükséges workflow;
- a riportálás;
- a sales folyamat;
- a bevezetési igény.

---

## 4. Szabályozási és szakmai korrekciók

## 4.1 VMI és SZEKI elnevezése

Az eredeti dokumentumban a VMI „Védelmi Maturity Index”-ként szerepel.

A hivatalos megnevezések:

- **VMI: védelmi megfelelési index**
- **SZEKI: szervezet ellenálló-képességi index**

Ezek hivatalos értékét az auditor állapítja meg az audit eredményeként.

A Dora ezért csak az alábbiakat kommunikálhatja:

- előzetes szimuláció;
- várható érték;
- audit-readiness mutató;
- felkészültségi becslés.

Nem kommunikálhatja úgy, mintha a rendszer hivatalos VMI- vagy SZEKI-eredményt állapítana meg.

### Javasolt elnevezés

> **VMI/SZEKI előzetes szimuláció**

vagy:

> **Audit előtti VMI/SZEKI felkészültségi becslés**

## 4.2 OSCAL-állítás

Az OSCAL valódi és fontos differenciátor.

Az SZTFH az auditoroktól géppel feldolgozható, OSCAL Assessment Results struktúrájú jelentést vár. Ugyanakkor a hivatalos auditjelentést nyilvántartott auditor készíti és nyújtja be.

Ezért túl erős az alábbi állítás:

> „SZTFH-konform OSCAL audit export.”

Pontosabb változat:

> **Auditor-kompatibilis OSCAL-alapú audit-előkészítő adatcsomag.**

vagy:

> **OSCAL Assessment Results formátumra előkészített export nyilvántartott auditor számára.**

A termék csak akkor állíthatja, hogy hivatalos, SZTFH-nak benyújtható auditjelentést generál, ha:

- az export teljes körűen megfelel az aktuális hatósági sémának;
- az üzleti validációk is teljesülnek;
- auditor validálja;
- a teljes hatósági folyamat támogatott.

## 4.3 Register of Information

A Register of Information nem egyszerű kiegészítő export, hanem a közvetlenül DORA-hatályos pénzügyi entitások egyik alapkötelezettsége.

A Dora jelenlegi QuickQuote-proxy megoldása nem megfelelő alap egy komoly DORA Financial Entity ajánlathoz.

A landingről ezért le kell venni a:

> „RoI Generator”

állítást, amíg nincs saját:

- RoI-adatmodell;
- teljes xBRL-CSV csomaggenerálás;
- séma-validáció;
- üzletiszabály-validáció;
- helyi fallback;
- verzió- és referenciaidőpont-kezelés.

Átmeneti megfogalmazás:

> **RoI-adatok előkészítésének támogatása**

de csak akkor, ha a flow valóban használható és a QuickQuote-függőség kezelve van.

---

## 5. Versenytárselemzés – fő hiányosságok

## 5.1 Jelentős magyar versenytárs létezik

Az az állítás, hogy:

> „A magyar piacon nincs DORA/NIS2 compliance platform, a Dora az első”

nem tartható.

A **SIREN** magyar és angol nyelvű GRC-rendszer, amely többek között az alábbi területeket kommunikálja:

- NIS2;
- DORA;
- magyar kiberbiztonsági szabályozás;
- MNB-elvárások;
- ISO 27001;
- kockázatkezelés;
- BIA;
- incidenskezelés;
- sérülékenység-kezelés;
- BCP/DRP;
- szabályzat- és feladatkezelés.

A kereskedelmi modellje nem feltétlenül azonos a Dora modelljével: inkább moduláris, on-premises és enterprise-jellegű.

Ettől még jelentős magyar versenytárs, főleg közepes és nagyobb szervezeteknél.

### Javasolt pontos állítás

> **A Dora az egyik első magyar nyelvű, felhős, self-service és KKV-árazású NIS2/DORA readiness megoldás lehet.**

Ez kellően erős, de nem bizonyíthatatlan.

## 5.2 Hiányzó nemzetközi versenytársak és helyettesítők

Az eredeti elemzés túl nagy súlyt ad az enterprise GRC-platformoknak.

Az OneTrust és Archer jó ár-összehasonlítási horgony, de nem feltétlenül azok a megoldások, amelyekkel egy magyar KKV ténylegesen összehasonlítja a Dorát.

Közvetlenebb összehasonlítási csoport:

- Formalize;
- Copla;
- Drata;
- SureCloud;
- CyberUpgrade;
- Secfix;
- 3rdRisk;
- dedikált DORA RoI- és TPRM-eszközök;
- SIREN és más magyar GRC-megoldások;
- tanácsadó vagy auditor + Excel/SharePoint;
- meglévő ISO 27001 tool NIS2-kiegészítéssel.

A legfontosabb valós helyettesítő gyakran nem egy másik SaaS, hanem:

> **tanácsadó + Excel + SharePoint + Word-sablonok**

A Dora számára ezt kell legyőzni egyszerűségben, átláthatóságban és teljes költségben.

## 5.3 A mobilalkalmazás nem jelentős versenyhátrány

A Kinderpedia és Famly említése vélhetően más termékelemzésből bent maradt szöveg.

Egy NIS2/DORA GRC-terméknél a natív mobilapp nem elsődleges elvárás.

Fontosabb:

- reszponzív webes felület;
- mobilról dokumentum- és fotófeltöltés;
- egyszerű jóváhagyási flow;
- e-mailes vagy Teams-értesítések;
- evidence request workflow;
- határidők és felelősök kezelése.

A mobilalkalmazást P3-prioritásra érdemes tenni.

---

## 6. Funkcionális versenyképesség

### Összegzés

A Dora **potenciálisan versenyképes**, de jelenlegi production állapotában még nem tekinthető teljesen piacérettnek.

A 17 funkcióterület létezése önmagában nem jelenti azt, hogy a termék 17 területen versenyképes.

A vásárló számára a teljes végponttól végpontig működő ügyfélút számít.

| Terület | Jelenlegi állapot | Piaci jelentőség |
|---|---|---|
| Scope/pre-assessment | Hasznos, NIS2-ben hiányos | Jó lead generation |
| Evidence workflow | A fő fájlfeltöltés törik | Launch-blocker |
| Requirements | NIS2-katalógus van, DORA nincs | NIS2-höz jó alap |
| Remediation | Jó irány | Erős recurring value |
| Incident orchestrator | Kiforrott | Fontos, de nem elsődleges vásárlási ok |
| VMI/SZEKI | Jó előzetes szimuláció | Erős magyar differenciátor |
| OSCAL | Értékes, de helyesen kell pozicionálni | Erős audit/advisor feature |
| Consultant portal | Részleges | White-label és bulk nélkül még nem teljes ajánlat |
| CCM | 1/5 connector valós | Nem kommunikálható fő differenciátorként |
| DORA RoI | Proxy, nem natív | Financial Entity ajánlathoz elégtelen |
| Billing/entitlement | Nincs | Kereskedelmi launch-blocker |

## 6.1 A „LIVE” státusz pontosítása

A dokumentációban legalább négy külön státuszt érdemes használni:

1. **Kódban létezik**
2. **Integrált és automatikusan tesztelt**
3. **Stagingben végponttól végpontig működik**
4. **Productionben végponttól végpontig használható**

Az Evidence például nem lehet egyszerre:

- „LIVE + S3 storage”

és:

- „productionben nem tölthető fel fájl”.

A pontos státuszkezelés a business és a landing overclaim elkerüléséhez is szükséges.

---

## 7. Javasolt fejlesztési prioritások

## P0 – eladhatóság és hitelesség

1. Evidence fájlfeltöltés javítása.
2. Fájlverziózás, jogosultság és letöltés végponttól végpontig.
3. Valós entitlement- és előfizetés-kezelés.
4. Trial lejárat és paywall.
5. Minden landing-állítás egyeztetése a production flow-val.
6. VMI/SZEKI és OSCAL jogilag pontos átnevezése.
7. Felhasználói szerepkörök és navigáció egyszerűsítése.
8. Production státuszmonitor bevezetése.
9. BUILD-SPEC és más technikai dokumentáció frissítése.

## P1 – NIS2 Continuous Compliance termék

A fő termékvonalhoz:

- EIR-nyilvántartás;
- követelmény–kontroll–bizonyíték kapcsolatok;
- evidence owner és reviewer;
- dokumentumérvényesség és lejárat;
- ismétlődő felülvizsgálatok;
- finding és remediation lifecycle;
- audit trail;
- auditcsomag;
- auditor-kompatibilis OSCAL export;
- Excel/import lehetőség;
- tanácsadói multi-tenant;
- ügyfelenkénti izoláció;
- white-label riport;
- ügyfélátadás és teljes export.

A recurring érték az audit utáni fenntartásból jön, nem a Scope Checkerből.

## P1 – DORA Supplier Assurance

Külön modulként:

- DORA szerződéses checklist;
- standard beszállítói evidence room;
- banki kérdőív és request tracker;
- szolgáltatás-, alvállalkozó- és adatkezelési nyilvántartás;
- BCP/DR/incident/test evidence;
- ügyfelenként megosztható assurance pack;
- verziózott trust profile;
- dokumentumlejáratok;
- jóváhagyási workflow.

Ez eladhatóbb és pontosabb ajánlat, mint az általános „DORA compliance KKV-knak”.

## P2 – DORA Financial Entity

Csak akkor érdemes teljes termékként piacra vinni, ha megvan:

- saját RoI-adatmodell;
- teljes xBRL-CSV csomaggenerálás;
- séma- és üzletiszabály-validáció;
- ICT contract register;
- szolgáltatás- és entity-hierarchia;
- TPRM;
- koncentrációs kockázat;
- exit strategy;
- DORA-követelménykatalógus;
- resilience testing;
- teljes incident reporting workflow;
- auditálható változáskezelés;
- enterprise security és SLA.

## 7.1 Connector-prioritások

A jelenlegi AWS–Azure AD–GitHub–Cloudflare–Render lista technológiai, nem ügyfélérték-alapú.

Javasolt sorrend:

1. Microsoft 365 / Entra ID
2. Azure
3. AWS
4. Microsoft Defender vagy más endpoint/security export
5. GitHub/GitLab
6. Jira/ServiceNow
7. Google Workspace

Cloudflare és Render csak szűkebb technológiai vállalati körben elsődleges.

---

## 8. Árazási értékelés

## 8.1 NIS2 Essentials – 24 900–34 900 Ft/hó

Ez reális belépő árszint, ha:

- valóban self-service;
- minimális supportot igényel;
- nem tartalmaz tanácsadói szolgáltatást;
- az ügyfél maga tölti fel és tartja karban az adatokat;
- egyszerű a bevezetés.

A compliance szoftvereknél ugyanakkor az onboarding és az adatbetöltés jelentős supportköltséget okozhat.

Javaslat:

- éves előfizetés;
- külön onboarding díj;
- havi fizetés csak 20–25%-os felárral.

## 8.2 NIS2 Continuous – 69 900–99 900 Ft/hó

Ez az árszint akkor védhető, ha a csomag valódi folyamatos működési értéket ad:

- teljes evidence lifecycle;
- több felhasználó;
- remediation;
- recurring review;
- auditcsomag;
- OSCAL-előkészítés;
- integrációk;
- érdemi support;
- határidők;
- jóváhagyások;
- változáskövetés.

A jelenlegi törött evidence upload és félkész connectorok mellett a felső árszint még nem indokolható.

## 8.3 Consultant csomag

A fix 199 000 Ft/hó:

- túl magas lehet 1–3 ügyféllel dolgozó kis tanácsadónak;
- túl alacsony lehet 30–50 ügyfelet kezelő nagyobb tanácsadónak.

Jobb modell:

> **alapdíj + aktív ügyfél díj**

| Csomag | Javasolt nettó ár |
|---|---:|
| Advisor Base | 49 900 Ft/hó |
| Aktív ügyfél | 15 000–25 000 Ft/ügyfél/hó |
| Advisor 5 | 149 000 Ft/hó, 5 aktív ügyféllel |
| Advisor 15 | 249 000 Ft/hó, 15 aktív ügyféllel |
| Nagyobb partner | Egyedi megállapodás |

A „végtelen ügyfél” csomagot kerülni kell.

## 8.4 DORA Financial Entity ár

Ne kerüljön ugyanabba az ártáblába, mint az SMB NIS2 termék.

Natív RoI, TPRM, szerződéskezelés és pénzügyi csoportstruktúra esetén:

- 250 000–600 000 Ft/hó;
- egyszeri implementációs díj;
- éves szerződés;
- egyedi support és SLA.

Ebben a szegmensben a „nincs contact sales” nem előny.

Egy pénzügyi szervezeti vásárlás jellemzően eleve igényel:

- security review-t;
- DPA-t;
- SLA-t;
- procurementet;
- jogi és kockázatkezelési jóváhagyást.

---

## 9. Javasolt végleges csomagstruktúra

| Csomag | Ár | Célcsoport | Fő érték |
|---|---:|---|---|
| **Readiness Free** | 0 Ft | Érdeklődők | Előszűrés, mintaeredmény |
| **NIS2 Essentials** | 24 900–34 900 Ft/hó éves fizetéssel | Kis szervezet | Evidence, feladatok, remediation, alap riport |
| **NIS2 Continuous** | 69 900–99 900 Ft/hó éves fizetéssel | Auditköteles szervezet | EIR, kontrollok, recurring review, auditcsomag, OSCAL-előkészítés |
| **Advisor** | 49 900 Ft alap + aktív ügyfelek | Tanácsadók | Multi-tenant, white-label, ügyfélworkflow |
| **DORA Supplier Assurance** | 49 900–89 900 Ft/hó | ICT-beszállítók | Banki evidence room, szerződéses readiness |
| **DORA Financial Entity** | 250 000 Ft/hótól | Pénzügyi entitások | RoI, TPRM, szerződések, incidents, resilience |

### Javasolt egyszeri onboarding díjak

| Csomag | Onboarding |
|---|---:|
| NIS2 Essentials | 99 000–199 000 Ft |
| NIS2 Continuous | 250 000–500 000 Ft |
| Advisor | 250 000 Ft-tól |
| DORA Financial Entity | Egyedi implementáció |

## 9.1 Trial-stratégia

A 14 napos trial nem javasolt.

Egy compliance termékben két hét alatt az ügyfél sokszor még:

- az adatgazdákat;
- a dokumentumokat;
- a rendszerlistát;
- a felelősöket

sem tudja összegyűjteni.

Jobb lehetőség:

- előre feltöltött demo workspace;
- 30 napos guided pilot;
- 8–12 hetes fizetett pilot;
- a pilot díjának beszámítása az éves előfizetésbe.

---

## 10. Értékajánlat kritikája

A korábban javasolt:

> „DORA/NIS2 evidence pack 1 nap alatt, nem 2 hét alatt. Enterprise GRC ár tizedéért.”

négy okból gyenge:

1. Nem bizonyított az egy nap.
2. Összemossa a DORA és NIS2 termékeket.
3. Az „evidence pack” egyszeri projektértéket sugall, nem recurring SaaS-t.
4. Az „enterprise GRC ár tizedéért” árversenybe helyezi a terméket.

A Dora erősebb előnye nem az, hogy egyszerűen olcsóbb, hanem hogy:

- magyar szabályozási tartalmat ad;
- helyi workflow-kat ismer;
- auditorral használható adatstruktúrát készít;
- kisebb szervezetek számára is kezelhető;
- tanácsadói csatornában is működhet.

A döntéshozó nem OSCAL-fájlformátumot vásárol, hanem:

- kevesebb audit-előkészítési munkát;
- rendezett felelősségeket;
- naprakész bizonyítékokat;
- kevesebb eltérést;
- gyorsabb javítást;
- kisebb szabályozási kockázatot.

---

## 11. Javasolt új értékajánlatok

## 11.1 Elsődleges NIS2 pozicionálás

> **Folyamatos NIS2 auditkészenlét, nem újabb Excel-tábla.**  
> Egy helyen kezeli az EIR-eket, követelményeket, bizonyítékokat, eltéréseket és javító intézkedéseket – magyar szabályozási tartalommal és auditor-kompatibilis exporttal.

Eredményközpontú változat:

> **Az audit után is maradjon naprakész a megfelelés.**  
> A Dora összeköti a követelményeket, felelősöket, bizonyítékokat és remediation feladatokat, hogy a következő audit ne újrakezdés legyen.

## 11.2 DORA ICT-beszállítói pozicionálás

> **Válaszoljon a banki DORA-kérésekre napok helyett órák alatt.**  
> Újrahasznosítható, verziózott beszállítói bizonyítéktár, szerződéses checklist és ügyfelenként megosztható assurance pack.

## 11.3 Tanácsadói pozicionálás

> **Minden ügyfél megfelelési állapota egy dashboardon.**  
> Határidők, bizonyítékok, eltérések és riportok ügyfelenként – Excel-mappák és manuális státuszriportok nélkül.

## 11.4 Technikai bizonyítékok a landing második szintjén

- magyar követelménykatalógus;
- VMI/SZEKI előzetes szimuláció;
- auditor-kompatibilis OSCAL export;
- verziózott evidence;
- immutable audit trail;
- multi-tenant tanácsadói működés;
- DORA/NIS2/GDPR incidenshatáridők.

---

## 12. Végső döntési javaslat

## GO: NIS2 Continuous Compliance + Advisor

Ez a legjobb elsődleges irány, mert:

- a piac hivatalosan jobban számszerűsíthető;
- a 2026. június 30-i auditdeadline után recurring problémává vált a fenntartás;
- a Dora jelenlegi funkciói jól illeszkednek;
- a magyar szabályozási tartalom valódi előny;
- az OSCAL-előkészítés és a VMI/SZEKI-szimuláció differenciál;
- a tanácsadók hatékony disztribúciós csatornát adhatnak.

## GO, külön termékként: DORA Supplier Assurance

Ez valós és kezelhető KKV-probléma, de nem szabad „teljes DORA compliance”-ként értékesíteni.

## Halasztandó: teljes DORA Financial Entity platform

Amíg nincs:

- natív RoI;
- xBRL-CSV generálás és validáció;
- TPRM;
- DORA-követelménykatalógus;
- szerződés- és szolgáltatásnyilvántartás;
- koncentrációs kockázat;
- exit strategy,

addig a pénzügyi intézményi DORA-platform állítás nem versenyképes.

## Nem javasolt: általános DORA/NIS2 all-in-one launch

Ez:

- túl széles;
- nehezen érthető;
- szabályozásilag pontatlan;
- a jelenlegi termékállapotnál többet ígér;
- összekeveri a vásárlókat és a fizetési hajlandóságot.

### Stratégiai alapelv

A legfontosabb változtatás nem újabb hét funkció hozzáadása, hanem:

> **egy pontos elsődleges szegmens, egy végponttól végpontig működő workflow és egy mérhető recurring érték.**

---

## 13. Javasolt döntési sorrend

1. A Dora elsődleges pozíciójának elfogadása: NIS2 Continuous Compliance.
2. A DORA Supplier Assurance külön termékvonalként történő definiálása.
3. A DORA Financial Entity termékvonal leválasztása a jelenlegi MVP-ről.
4. Production-flow státuszok újraauditálása.
5. Evidence upload és billing P0 javítása.
6. Árcsomagok véglegesítése.
7. Landing újraírása a valós funkciók alapján.
8. 5–10 tanácsadói és 10–15 végfelhasználói interjú.
9. Fizetett pilot indítása.
10. A további connector- és AI-fejlesztések csak a pilot visszajelzései alapján.

---

## 14. Felhasznált fő források

- Eredeti Dora üzleti és versenypiaci értékelés
- DORA – Regulation (EU) 2022/2554  
  https://eur-lex.europa.eu/eli/reg/2022/2554/oj
- European Banking Authority – DORA preparation and RoI reporting  
  https://www.eba.europa.eu/activities/direct-supervision-and-oversight/digital-operational-resilience-act/preparation-dora-application
- SZTFH – Kiberbiztonsági auditok státusza  
  https://sztfh.hu/lezarult-a-kiberbiztonsagi-auditok-hatarideje/
- SZTFH – Auditjelentés gépi feldolgozásra alkalmas formátuma  
  https://sztfh.hu/downloads/kiberbiztonsag/kiberbiztonsagi_auditjelentes_gepi_feldolgozasra_alkalmas_formatuma_sztfh.pdf
- Nemzeti Jogszabálytár – kapcsolódó magyar szabályozás  
  https://njt.jog.gov.hu/
- SIREN GRC  
  https://siren.silentsignal.hu/
- Formalize DORA megoldás  
  https://formalize.com/en/dora
- Copla DORA megoldás  
  https://copla.com/dora-regulation/
