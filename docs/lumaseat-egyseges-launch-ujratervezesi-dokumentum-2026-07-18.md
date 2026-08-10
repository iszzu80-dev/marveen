# LumaSeat – egységes launch-újratervezési és megvalósítási dokumentum

**Dátum:** 2026. július 18.  
**Döntési státusz:** **FELTÉTELES GO**  
**Dokumentum célja:** a jelenlegi LumaSeat termékből hitelesen piacra vihető B2C és B2B termék kialakításához szükséges üzleti, funkcionális, UI/UX-, adatvédelmi, technikai és validációs módosítások egységes specifikációja.  
**Elsődleges B2C termék:** **LumaSeat Event** – egy esküvő vendég-, RSVP-, terem- és ültetéskezelése.  
**Elsődleges B2B termék:** **LumaSeat Venue Pro** – egy konkrét esküvői helyszín több esküvőjének terem-, seating- és operatív együttműködési rendszere.  
**Későbbi, nem launchtermék:** általános, több helyszínen dolgozó esküvőszervezői Planner Pro és teljes venue-management rendszer.

---

# Tartalom

1. [Vezetői döntés](#1-vezetői-döntés)  
2. [Jelenlegi igazolt állapot](#2-jelenlegi-igazolt-állapot)  
3. [Piaci és versenypiaci korrekciók](#3-piaci-és-versenypiaci-korrekciók)  
4. [Végleges termékstruktúra](#4-végleges-termékstruktúra)  
5. [Célcsoportok, szerepek és értékajánlatok](#5-célcsoportok-szerepek-és-értékajánlatok)  
6. [A termék központi értéklánca](#6-a-termék-központi-értéklánca)  
7. [Guided Setup Interview – multimodális onboarding](#7-guided-setup-interview--multimodális-onboarding)  
8. [Importarchitektúra](#8-importarchitektúra)  
9. [Vendéglista és RSVP](#9-vendéglista-és-rsvp)  
10. [Teremrajz és seating canvas](#10-teremrajz-és-seating-canvas)  
11. [AI seating és constraint engine](#11-ai-seating-és-constraint-engine)  
12. [Együttműködés, jóváhagyás és verziózás](#12-együttműködés-jóváhagyás-és-verziózás)  
13. [Exportok és célzott operatív csomagok](#13-exportok-és-célzott-operatív-csomagok)  
14. [LumaSeat Venue Pro](#14-lumaseat-venue-pro)  
15. [Day-of Mode](#15-day-of-mode)  
16. [AI használati és felelősségi modell](#16-ai-használati-és-felelősségi-modell)  
17. [UI/UX célarchitektúra](#17-uiux-célarchitektúra)  
18. [Adatmodell és objektumkapcsolatok](#18-adatmodell-és-objektumkapcsolatok)  
19. [Adatvédelem, biztonság és adatmegőrzés](#19-adatvédelem-biztonság-és-adatmegőrzés)  
20. [Fizetés és fogyasztóvédelem](#20-fizetés-és-fogyasztóvédelem)  
21. [Árazási javaslat](#21-árazási-javaslat)  
22. [Go-to-market és terjesztési modell](#22-go-to-market-és-terjesztési-modell)  
23. [Pilot- és validációs terv](#23-pilot--és-validációs-terv)  
24. [Launchanalitika és KPI-k](#24-launchanalitika-és-kpi-k)  
25. [P0–P2 roadmap](#25-p0p2-roadmap)  
26. [AS-IS → launch változtatási mátrix](#26-as-is--launch-változtatási-mátrix)  
27. [Go/no-go launch gate](#27-gono-go-launch-gate)  
28. [Javasolt Marveen-munkacsomagok](#28-javasolt-marveen-munkacsomagok)  
29. [Végső pozicionálás](#29-végső-pozicionálás)  
30. [Források](#30-források)  

---

# 1. Vezetői döntés

## 1.1 A termék alapötlete életképes

A LumaSeat valós és érzelmileg jelentős problémát kezel:

- a vendégadatok több forrásból érkeznek;
- a párok társasági és családi kapcsolatokat próbálnak fejben követni;
- a terem fizikai korlátai és az asztalkapacitások nehezen áttekinthetők;
- az ültetésrend többször változik;
- a helyszín, a catering, a dekoros és a szervező eltérő listákat kap;
- az esküvő előtti utolsó napokban a változások papíron, Excelben, üzenetekben és fejben követhetők.

A LumaSeat azonban csak akkor lesz piacképes, ha nem pusztán „AI által generált ülésrendet”, hanem **teljes, végigvihető és manuálisan kontrollálható munkafolyamatot** biztosít.

## 1.2 A launchhoz szükséges stratégiai korrekció

A jelenlegi „AI seating + vendor CRM” pozicionálás túl széles és nem védhető.

A javasolt B2C pozíció:

> **A LumaSeat az RSVP-válaszokból, a vendégek kapcsolataiból és a pár szabályaiból magyarázható ültetési tervet készít, megmutatja a konfliktusokat, és segít biztonságosan véglegesíteni az ülésrendet.**

A javasolt B2B pozíció:

> **A LumaSeat Venue Pro segítségével a helyszín egyszer felépíti és hitelesíti termeit, asztalait és működési szabályait, majd minden pár ugyanabban a vezetett rendszerben készíti el vendéglistáját és ültetési tervét.**

## 1.3 A végleges termékszerkezet

```text
LumaSeat platform
├── LumaSeat Event
│   └── Egy pár / egy esküvő
│
├── LumaSeat Venue Pro
│   └── Egy helyszín / több esküvő
│
├── Venue Backstage
│   └── Belső operatív réteg a Venue Pro-n belül
│
└── Day-of Mode
    └── Venue Pro eseménynapi mobil/PWA mód
```

Az esküvőszervező launchkor nem önálló előfizetői termék tulajdonosa, hanem:

- a pár által meghívott együttműködő; vagy
- a helyszín által meghívott eseményszintű partner.

Az általános többügyfeles Planner Pro csak későbbi, külön validálandó irány.

---

# 2. Jelenlegi igazolt állapot

A 2026. július 17-i termékleírás alapján a LumaSeat teljes stackje éles, de rejtett regisztrációval működik, és még nincs fizető tenant.

## 2.1 Élő vagy igazoltan meglévő képességek

- AI-alapú seating generálás;
- RSVP-folyamat;
- vendéglista-kezelés;
- szolgáltatói/vendor oldal;
- a pár meghívhat esküvőszervezőt;
- planner workspace-szintű hozzáférés;
- DXF teremrajz-import valós backenddel;
- workspace-szintű Premium hard gate;
- multi-tenant alapok;
- jelenlegi elegáns app és LumaSeat-branding;
- rejtett regisztráció;
- Barion-integráció előkészítve, de még nem production-ready.

## 2.2 Jelenlegi roadmap vagy hiányzó elem

- teljes drag-and-drop RoomCanvas;
- PDF seating export;
- read-only megosztási link;
- AI „explain”;
- RSVP → seating konverziós/upsell flow;
- planner B2B2C bővítés;
- vendor CRM automatizmusok;
- e-signature;
- marketplace;
- teljes production payment flow.

## 2.3 Jelenlegi kritikus launchgap

A jelenlegi prioritás fordított:

- az összetettebb DXF-import már létezik;
- a hétköznapi XLSX/CSV vendégimport nincs igazoltan kész;
- a teljes drag-and-drop szerkesztő nincs kész;
- a használható PDF/link export nincs kész;
- a Barion production nincs kész;
- az AI magyarázhatósága és determinisztikus hard-constraint gate nincs igazoltan lezárva.

A launch szempontjából a **manuális szerkeszthetőség, egyszerű import és export fontosabb**, mint az AI-generálás vagy a CAD-import önmagában.

---

# 3. Piaci és versenypiaci korrekciók

## 3.1 Kerülendő állítás

Nem használható:

> „Egyedülálló magyar AI seating és vendor CRM.”

Magyar nyelven is elérhetők:

- vendéglisták;
- RSVP-rendszerek;
- drag-and-drop ültetésrendek;
- PDF-exportok;
- együttműködési funkciók.

Nemzetközileg pedig elérhető:

- CSV-vendégimport;
- AI-alapú kép/PDF teremimport;
- DXF-import;
- venue template;
- több esemény kezelése;
- vendég-check-in;
- read-only link;
- venue és catering riport;
- mobil hozzáférés.

## 3.2 A valódi differenciátor

A LumaSeatnek nem funkciólistával, hanem egyedi probléma-megoldási lánccal kell különböznie:

1. magyar nyelvű, természetes adatfelvétel;
2. társasági és családi kapcsolatok strukturálása;
3. hard és soft seating szabályok;
4. magyarázható AI;
5. látható constraint-konfliktusok;
6. minimális változtatású javítás;
7. pár–planner–helyszín együttműködés;
8. hitelesített helyszínsablonok;
9. egységes venue/catering/decor export;
10. eseménynapi aktuális változáslista.

## 3.3 Piaci elhatárolás

A LumaSeat ne próbáljon launchkor versenyezni:

- teljes esküvőszervező platformokkal;
- CRM-ekkel;
- foglalás- és szerződéskezelő rendszerekkel;
- venue ERP-kkel;
- cateringrendszerekkel;
- általános rendezvényplatformokkal.

A védhető scope:

> **Vendég → RSVP → terem → seating → együttműködés → operatív átadás.**

---

# 4. Végleges termékstruktúra

## 4.1 LumaSeat Event

A pár által közvetlenül használt, egy esküvőre szóló termék.

### Fő képességek

- guided onboarding;
- vendéglista;
- RSVP;
- kapcsolatok és szabályok;
- terem/canvas;
- manuális seating;
- AI seating;
- konfliktusok;
- lock és verziók;
- planner/helyszín meghívása;
- PDF és linkexport;
- cateringlista;
- esemény utáni archívum/törlés.

## 4.2 LumaSeat Venue Pro

Egy konkrét esküvői helyszín több eseményét kezelő B2B termék.

### Fő képességek

- több esküvő dashboardon;
- termek és sablonok;
- asztal- és székkészlet;
- standard elrendezések;
- esemény létrehozása és klónozása;
- pár meghívása;
- planner opcionális meghívása;
- venue-team jogosultságok;
- venue review;
- belső és ügyfélnek látható jegyzetek;
- readiness;
- venue/catering/decor export;
- eseménynapi változáskezelés;
- co-branding.

## 4.3 Venue Backstage

Nem külön termék, hanem a Venue Pro belső operatív munkaterülete.

### Tartalma

- belső megjegyzések;
- setupkorlátozások;
- operatív változások;
- catering és dekor információ;
- jóváhagyási státusz;
- „mi változott az előző export óta?”;
- eseménynapi nézet;
- belső checklist.

## 4.4 Nem launchtermék

### Planner Pro

A több helyszínen, sok párnak dolgozó általános esküvőszervező külön B2B terméke csak később indokolt.

### Teljes Venue Operations

Nem tartozik a launch-scope-ba:

- lead CRM;
- ajánlat;
- szerződés;
- számlázás;
- fizetési ütemezés;
- teljes BEO;
- készlet;
- személyzeti beosztás;
- hotel/szobafoglalás;
- teljes catering ERP.

---

# 5. Célcsoportok, szerepek és értékajánlatok

## 5.1 Pár

### Probléma

- szétszórt vendégadatok;
- bizonytalan RSVP;
- bonyolult társasági kapcsolatok;
- nehéz teremtervezés;
- konfliktusos ültetés;
- sok manuális módosítás.

### Értékajánlat

> **Egy helyen kezelhetitek a vendégeket, az RSVP-t és a termet, a LumaSeat pedig segít olyan ültetési tervet készíteni, amely érthető, javítható és végig a ti kontrollotok alatt marad.**

## 5.2 Venue Admin

### Probléma

- ugyanazokat a termeket újra és újra felépítik;
- több Excel/PDF-verzió kering;
- nincs egységes ügyfélfolyamat;
- nehéz látni, melyik esemény hol tart;
- a catering és operáció eltérő adatot kap.

### Értékajánlat

> **Építse fel egyszer a helyszín hitelesített termeit, majd minden esküvőhöz ugyanazt a vezetett, ellenőrzött folyamatot használja.**

## 5.3 Venue Event Manager

- esemény létrehozása;
- pár meghívása;
- terem kiválasztása;
- venue review;
- readiness;
- export;
- Day-of Mode;
- esemény lezárása.

## 5.4 Esküvőszervező

Eseményszintű együttműködő:

- vendéglista;
- seating;
- komment;
- review;
- export;
- nincs hozzáférése más eseményekhez.

## 5.5 Catering és venue operáció

Célhoz kötött, adatminimalizált hozzáférés:

- asztalonkénti létszám;
- menü;
- szükséges allergéninformáció;
- gyermekadag;
- mobilitási igény;
- setupinformáció;
- társasági konfliktusok és privát megjegyzések nélkül.

## 5.6 Vendég

- RSVP;
- szükséges adat megadása;
- később saját asztal keresése;
- nincs regisztrációs kényszer;
- csak a saját adatát és szükséges információt látja.

---

# 6. A termék központi értéklánca

```text
Guided Setup Interview
→ esemény és helyszín
→ vendéglista/import
→ RSVP
→ háztartások és társasági csoportok
→ hard és soft szabályok
→ terem és asztalok
→ manuális vagy AI seating
→ constraint-validáció
→ konfliktusok és javítás
→ planner/venue review
→ jóváhagyott verzió
→ célzott exportok
→ Day-of baseline
→ eltérés- és változáskezelés
→ esemény lezárása
```

A termék nem lehet csak AI-generátor. AI nélkül is végig használhatónak kell lennie.

---

# 7. Guided Setup Interview – multimodális onboarding

## 7.1 Cél

Az új workspace ne üres dashboarddal induljon.

Nyitóüzenet:

> **Meséljetek az esküvőről, és segítünk felépíteni a vendéglistát, a termet és az ültetési szabályokat.**

A felület legyen beszélgetésszerű, de strukturált wizard, ne végtelen chatbot.

## 7.2 Fő szakaszok

1. Esemény  
2. Helyszín  
3. Vendéglista  
4. RSVP  
5. Terem  
6. Kapcsolatok  
7. Együttműködők  
8. Ellenőrzés és import  

## 7.3 Támogatott inputtípusok

- egyválasztós gomb;
- többválasztós gomb;
- dátum;
- szám;
- rövid szöveg;
- hosszú szöveg;
- név- vagy vendégválasztó;
- mikrofonos diktálás;
- fájlcsatolás;
- kép készítése;
- Excel/CSV feltöltés;
- PDF/DXF/SVG feltöltés;
- táblázat beillesztése;
- „nem tudom”;
- „később”;
- „delegálom a helyszínnek/plannernek”.

## 7.4 Adaptív kérdések

### Vendéglista

> Hol van most a vendéglistátok?

- Excel;
- Google Sheets;
- más rendszer;
- jegyzet;
- még nincs;
- bediktálom.

### Terem

> Van alaprajzotok?

- venue template;
- PDF;
- kép;
- DXF;
- SVG;
- papírrajz fotója;
- nincs;
- a helyszíntől kérem.

### Társasági szabály

> Vannak olyan vendégek, akik mindenképpen együtt üljenek?

- személyek kiválasztása;
- csoport;
- szabad szöveg;
- diktálás.

## 7.5 „Amit eddig tudunk” összefoglaló

- dátum;
- helyszín;
- várható vendégszám;
- import állapota;
- RSVP állapota;
- terem státusza;
- csoportok;
- kritikus hiányok;
- következő lépés.

## 7.6 Gyors és részletes út

### Gyors indulás

- esemény;
- vendéglista;
- terem;
- első manuális/AI terv.

### Részletes beállítás

- kapcsolatok;
- étkezés;
- hozzáférhetőség;
- térbeli preferenciák;
- együttműködők;
- exportok.

## 7.7 Diktálás

Jó use case-ek:

- társasági csoportok;
- együtt/külön szabályok;
- helyszíni sajátosságok;
- utolsó pillanatos változások.

Példa:

> „Peti és Kata együtt ülnek, a nagymama legyen közel a kijárathoz, a két nagybácsi pedig ne kerüljön egy asztalhoz.”

A rendszer ezt javasolt strukturált szabályokká alakítja, de commit előtt jóváhagyást kér.

## 7.8 Kötelező provenance

Minden beállításnál tárolandó:

- forrás;
- importbatch;
- felhasználó;
- venue template;
- RSVP;
- planner;
- AI-javaslat;
- jóváhagyó;
- módosítás ideje.

---

# 8. Importarchitektúra

## 8.1 Alapelv

Az import ne fájlfeltöltés legyen, hanem vezetett migráció:

```text
forrás kiválasztása
→ fájl vizsgálata
→ mapping
→ előnézet
→ validáció
→ merge-stratégia
→ dry run
→ commit
→ audit
→ rollback
```

## 8.2 P0 vendégimport

- XLSX;
- CSV;
- Excel/Google Sheets copy-paste;
- manuális hozzáadás;
- RSVP-ból automatikus létrehozás;
- asztalhozzárendelés frissítése XLSX/CSV-ből.

## 8.3 Vendégmezők

- teljes név;
- keresztnév;
- vezetéknév;
- email;
- telefon;
- háztartás;
- kísérő;
- gyermek/felnőtt;
- társasági csoport;
- RSVP-státusz;
- menü;
- speciális étrend;
- allergén;
- megjegyzés;
- asztal;
- ülőhely;
- fix hely;
- nyelv.

## 8.4 Mapping

| Importált fejléc | LumaSeat mező | Bizonyosság |
|---|---|---:|
| Meghívott neve | Teljes név | magas |
| Jön? | RSVP-státusz | magas |
| Plusz egy | Kísérő | közepes |
| Kaja | Menü/speciális étrend | ellenőrzendő |
| Asztal nr. | Asztal | magas |

## 8.5 Merge-szabály

Matching prioritás:

1. külső stabil azonosító;
2. email;
3. telefonszám;
4. név + háztartás;
5. név + kísérő;
6. manuális döntés.

Merge-opciók:

- csak új;
- csak üres mezők;
- meglévők frissítése;
- import felülír;
- soronként döntés.

## 8.6 Dry run

> 136 új vendég  
> 12 frissítés  
> 3 lehetséges duplikáció  
> 2 kihagyott sor  
> 8 érzékeny adat consent nélkül  

## 8.7 Rollback

Minden import kapjon:

- batch ID;
- forrásfájl-hash;
- létrehozott/módosított rekordlista;
- commit időpont;
- végrehajtó;
- visszavonási lehetőség.

## 8.8 Teremimport

### P0

- manuális canvas;
- PDF háttér;
- PNG/JPG/WebP háttér;
- DXF-import hardening;
- manuális skálakalibrálás;
- venue template klónozása.

### P1

- SVG;
- AI-alapú PDF/képfelismerés;
- kész seating chart felismerése;
- venue CRM CSV/API.

## 8.9 DXF-folyamat

1. fájl;
2. egység;
3. layerek;
4. előnézet;
5. falak/ajtók/oszlopok;
6. skála;
7. import;
8. manuális korrekció;
9. venue template.

A geometriai feldolgozás determinisztikus legyen, nem LLM-alapú.

## 8.10 PDF/kép import

P0-ban háttérként:

- oldal kiválasztása;
- crop;
- forgatás;
- perspektíva;
- átlátszóság;
- skála;
- lock.

P1-ben AI javasolhatja:

- falak;
- ajtók;
- oszlopok;
- asztalok;
- székek;
- tánctér;
- színpad;
- felirat.

Minden elem felülvizsgálandó.

---

# 9. Vendéglista és RSVP

## 9.1 A vendéglista központi adatmodell

Szükséges csoportosítás:

- háztartás;
- pár;
- család;
- baráti csoport;
- munkahely;
- egyetem;
- nyelv;
- gyermek;
- külön meghívási egység.

## 9.2 RSVP-adatok

- részt vesz;
- nem vesz részt;
- bizonytalan;
- még nem válaszolt;
- kísérő;
- gyermek;
- menü;
- speciális étrend;
- allergén;
- mobilitási igény;
- megjegyzés;
- válasz ideje;
- válaszverzió.

## 9.3 RSVP szerepe

Az RSVP nem önálló wedge, hanem:

- adatgyűjtő csatorna;
- viral belépő;
- seating readiness input;
- vendégstátusz forrás;
- utolsó módosítások forrása.

## 9.4 Adatvédelem az RSVP-ben

Allergia vagy egészségügyi jellegű adatnál:

- külön mező;
- cél;
- címzett;
- megőrzés;
- explicit, nem előre bejelölt consent;
- visszavonás;
- alternatív kapcsolat.

Ne kérjünk diagnózist. Csak az operatív célhoz szükséges információt.

## 9.5 RSVP-link biztonság

- magas entrópiájú token;
- rate limiting;
- expiry/revoke;
- más vendég adatához nincs hozzáférés;
- érzékeny mező külön védelem;
- auditált módosítás;
- email/telefon verifikáció csak akkor, ha szükséges.

---

# 10. Teremrajz és seating canvas

## 10.1 P0 launch-blocker

A teljes drag-and-drop canvas kötelező. AI seating nélkül is teljes értékűen használhatónak kell lennie.

## 10.2 Teremelemek

- kerek asztal;
- hosszú asztal;
- U alak;
- főasztal;
- székek;
- tánctér;
- színpad/DJ;
- bár;
- svédasztal;
- bejárat;
- mosdó;
- oszlop;
- fal;
- tiltott zóna;
- kiszolgálási út;
- akadálymentes útvonal.

## 10.3 Szerkesztési funkciók

- drag-and-drop;
- forgatás;
- méretezés;
- zoom/pan;
- snap;
- alignment;
- undo/redo;
- autosave;
- versioning;
- rétegek;
- lock;
- multi-select;
- másolás;
- kapacitásvalidáció.

## 10.4 Desktop és mobil

### Desktop-first

- teljes canvas;
- tömeges vendégmozgatás;
- importkalibrálás;
- verzió-összehasonlítás;
- exportpreview.

### Mobilon

- review;
- vendégkeresés;
- asztalnézet;
- AI-javaslat;
- approval;
- komment;
- Day-of Mode.

---

# 11. AI seating és constraint engine

## 11.1 Hard constraint-ek

Soha nem sérülhetnek észrevétlenül:

- asztalkapacitás;
- fix vendég;
- fix asztal;
- kötelező együtt;
- kötelező külön;
- gyermek–szülő;
- hozzáférhetőség;
- venue által zárolt elem;
- már megérkezett vendég Day-of módban;
- vendég duplikált leültetése;
- résztvevő vendég észrevétlenül ülés nélkül.

## 11.2 Soft preference-ek

- lehetőleg együtt;
- hasonló társaság;
- társaságok keverése;
- nyelv;
- életkor;
- érdeklődés;
- főasztal közelsége;
- hangfaltól távol;
- kijárathoz közel;
- legalább két ismerős az asztalnál.

## 11.3 AI-output utáni gate

Az AI vagy optimizer outputját külön determinisztikus validátor ellenőrizze.

Nem jelenhet meg „kész” terv, ha:

- hard constraint sérül;
- kapacitás hibás;
- vendég duplikált;
- vendég hiányzik;
- lock sérült.

## 11.4 Eredménymegjelenítés

Ne legyen „94% tökéletes”.

Helyette:

- kötelező szabály: 24/24;
- preferencia: 31/37;
- 0 kapacitási konfliktus;
- 3 review-javaslat;
- 4 vendég még nincs leültetve;
- 2 adat bizonytalan.

## 11.5 Magyarázhatóság

> Anna a 4. asztalhoz került, mert a párjával együtt maradt, három közeli ismerőse ott ül, a különültetési szabályok nem sérülnek, és teljesül a hangfaltól való távolsági preferencia.

A magyarázat strukturált döntési adatokból készüljön. AI nem találhat ki indokot.

## 11.6 Lock és részleges újratervezés

Lockolható:

- vendég;
- szék;
- asztal;
- csoport;
- venue elem;
- jóváhagyott tervrész.

Újrageneráláskor csak a nem zárolt rész változhat.

## 11.7 Tervváltozatok

- család-központú;
- baráti csoportokat tartó;
- társaságokat keverő;
- minimális konfliktusú;
- minimális változtatású.

Összehasonlítás:

- hány vendég mozog;
- hány asztal változik;
- mely preferencia javul/romlik;
- mely konfliktus marad.

---

# 12. Együttműködés, jóváhagyás és verziózás

## 12.1 Szerepek

### Pár – Owner

- teljes esemény;
- meghívás;
- fizetés;
- vendégadat;
- seating;
- export;
- törlés.

### Partner

- párhoz hasonló szerkesztés;
- billing nélkül.

### Planner

- eseményszintű;
- vendéglista;
- seating;
- komment;
- review;
- export.

### Venue Event Manager

- venue template;
- fizikai validáció;
- venue approval;
- operatív export;
- Day-of baseline.

### Catering/Decor

- célzott read-only nézet;
- csak szükséges adatok.

## 12.2 Megjegyzéstípusok

- párnak látható;
- planner/venue közös;
- venue belső;
- cateringnek címzett;
- decor címzett;
- privát személyes jegyzet.

## 12.3 Státuszok

- draft;
- pár szerkeszti;
- planner review;
- venue review-ra kész;
- venue módosítást kér;
- venue-approved;
- finalized;
- Day-of baseline;
- Day-of változás;
- archived.

## 12.4 Változástörténet

Tárolandó:

- ki;
- mikor;
- mit;
- előző érték;
- új érték;
- forrás;
- online/offline;
- melyik verzióhoz képest;
- jóváhagyás.

## 12.5 Jóváhagyás

- pár jóváhagyás;
- venue fizikai review;
- cateringexport jóváhagyás;
- Day-of módosítás jóváhagyás.

A venue ne írhassa át észrevétlenül a pár tervét.

---

# 13. Exportok és célzott operatív csomagok

## 13.1 Venue Operations Pack

- teremrajz;
- asztalok;
- kapacitás;
- fix elemek;
- kiszolgálási út;
- mobilitási információ;
- operatív megjegyzés;
- verzió;
- időbélyeg.

## 13.2 Catering Pack

- végleges létszám;
- asztalonkénti létszám;
- menü;
- speciális étrend;
- szükséges allergéninformáció;
- gyermekadag;
- változáslista;
- adatminimalizált névlista.

## 13.3 Decor Pack

- teremrajz;
- asztaltípus;
- számozás;
- dekorzónák;
- fix/tiltott területek;
- installációs megjegyzés;
- setupidő.

## 13.4 Pár csomagja

- teljes seating;
- asztalonkénti névsor;
- alfabetikus lista;
- konfliktusriport;
- nem leültetett vendég;
- végleges verzió.

## 13.5 Vendég nézet

- saját asztal;
- opcionális QR;
- szükséges térképrészlet;
- más vendégek érzékeny adatai nélkül.

## 13.6 Integritásteszt

Export előtt automatikusan ellenőrizendő:

- canvas vendégszám = export vendégszám;
- nincs duplikáció;
- minden résztvevő szerepel vagy külön listázott;
- asztalkapacitás nem sérül;
- érzékeny adat csak jogosult csomagban;
- verzió és időbélyeg jelen van.

---

# 14. LumaSeat Venue Pro

## 14.1 Scope-határ

A Venue Pro ott kezdődik, amikor az esküvő már a helyszínhez került, és ott ér véget, amikor a jóváhagyott terem-, seating- és vendéginformáció átadható az operatív csapatnak.

## 14.2 Venue dashboard

- következő esküvők;
- readiness;
- hiányzó vendégadat;
- lezáratlan terem;
- kapacitási konfliktus;
- venue review;
- hiányzó export;
- utolsó módosítás;
- Day-of státusz.

## 14.3 Termek és sablonok

- terem;
- kapacitás;
- asztal-/székkészlet;
- fix elemek;
- tiltott zónák;
- standard elrendezés;
- kültéri/beltéri változat;
- venue hard constraint;
- verzió és jóváhagyó.

## 14.4 Esemény klónozása

### Másolható

- terem;
- asztalok;
- számozás;
- venue-elemek;
- exportbeállítás;
- operatív checklist;
- jogosultság-sablon;
- venue constraint.

### Nem másolható alapból

- vendég;
- RSVP;
- allergia;
- társasági konfliktus;
- pár elérhetősége;
- privát jegyzet;
- előző dokumentum.

## 14.5 Readiness

Mérföldkövek:

1. esemény létrejött;
2. terem kiválasztva;
3. pár meghívva;
4. vendéglista elindult;
5. RSVP kiküldve;
6. első terv;
7. venue review;
8. vendégszám lezárva;
9. cateringlista;
10. teremterv jóváhagyva;
11. operatív csomag;
12. esemény lezárva.

## 14.6 Branding

Launchkor co-branding:

- venue logó;
- venue név;
- saját meghívó szöveg;
- kapcsolattartó;
- co-branded client portal.

Később:

- saját domain;
- teljes white-label.

---

# 15. Day-of Mode

## 15.1 Döntés

A teljes offline-first, automatikus újraültető mobilplatform nem B2C P0.

A hasznos scope:

> **Day-of Lite a Venue Pro részeként: mobilra optimalizált, előre letöltött operatív nézet, jelenléti és eltérésnaplóval, minimális változtatású repair javaslatokkal, card change listtel és catering delta exporttal.**

## 15.2 Day-of baseline

Az esemény előtt például 48 órával a Venue Event Manager rögzíti a végleges alapverziót:

- vendéglista;
- terem;
- seating;
- menü;
- operatív jegyzet;
- exportverzió.

## 15.3 Mobil főképernyő

- várható vendég;
- megérkezett;
- késik;
- no-show;
- váratlan vendég;
- sync status;
- gyors keresés;
- változások;
- catering frissítés.

## 15.4 Vendégstátusz

- megérkezett;
- még nem érkezett;
- késik;
- biztos no-show;
- váratlan vendég;
- bizonytalan.

A „még nem érkezett” nem automatikusan no-show.

## 15.5 Seating impact

Módosítás után:

- kell-e bármit tenni;
- kritikusan kiürült-e asztal;
- sérül-e pár/család;
- változik-e speciális étkezés helye;
- érint-e már megérkezett vendéget;
- hány kártya változik;
- felszabadítható-e teljes asztal.

## 15.6 Repair eredmény

### Nincs teendő

> Két üres hely maradhat, nincs szükség átrendezésre.

### Egyszerű művelet

> Vegye ki a két névkártyát.

### Repair proposal

> Egy asztal háromfősre csökkent. Két minimális változtatású megoldás lehetséges.

## 15.7 Card Change List

- eltávolítandó;
- áthelyezendő;
- új kézi kártya;
- végrehajtó;
- kész állapot.

## 15.8 Catering delta

- eredeti létszám;
- aktuális létszám;
- no-show;
- extra vendég;
- menüváltozás;
- érintett asztal;
- jóváhagyó;
- időbélyeg.

## 15.9 Offline kompromisszum

Offline legyen:

- snapshot;
- vendégkeresés;
- státusz;
- ideiglenes extra vendég;
- megjegyzés;
- változáslista;
- egyszerű impact check;
- queue.

Offline ne legyen P0-ban:

- teljes canvas;
- új PDF;
- tényleges emailküldés;
- nagy AI-modell;
- teljes reoptimization;
- billing;
- user admin.

## 15.10 Single-writer P0

Egy aktív koordinátor módosíthat. Mások read-only vagy korlátozott check-in nézetet kapnak.

Ez csökkenti az offline conflict resolution komplexitását.

## 15.11 Day-of roadmap

### Day-of Lite

- PWA;
- snapshot;
- single writer;
- status;
- delta;
- card list;
- offline queue.

### Day-of Pro

- több eszköz;
- multi-user merge;
- QR check-in;
- printer;
- staff notification;
- cateringintegráció.

---

# 16. AI használati és felelősségi modell

## 16.1 AI használható

### Onboarding

- intent;
- szabad szöveg;
- diktálás;
- adaptív kérdés;
- összefoglaló;
- hiányfelismerés.

### Import

- oszlopmapping;
- normalizálás;
- fuzzy duplicate javaslat;
- jegyzet strukturálása;
- PDF/kép objektumfelismerés.

### Seating

- soft preference optimalizálás;
- tervváltozat;
- conflict repair;
- minimális módosítás;
- magyarázat.

### Day-of

- diktálás bontása;
- magyarázat;
- staff/catering summary draft.

## 16.2 AI nem dönthet önállóan

- bizonytalan vendégmerge;
- hard constraint;
- RSVP-státusz;
- érzékeny adat jogalapja;
- terem kapacitása;
- venue fizikai jóváhagyás;
- váratlan vendég elfogadása;
- cateringküldés;
- payment;
- permission;
- offline merge;
- adat törlése;
- meghívó kiküldése.

## 16.3 Determinisztikus területek

- XLSX/CSV parsing;
- malware scan;
- DXF geometria;
- mértékegység;
- kapacitás;
- seat uniqueness;
- hard constraint;
- permission;
- consent;
- export-integritás;
- payment state;
- import commit/rollback;
- auditlog.

## 16.4 AI provenance

Minden AI-javaslatnál:

- inputok;
- forrás;
- modell/verzió;
- confidence;
- output;
- jóváhagyó;
- módosítás;
- timestamp.

---

# 17. UI/UX célarchitektúra

## 17.1 B2C fő navigáció

1. Áttekintés  
2. Vendégek  
3. RSVP  
4. Terem  
5. Ültetés  
6. Megosztás  

Másodlagos:

- Szolgáltatóim;
- Beállítások.

## 17.2 Áttekintés

> **Már csak három lépés van a végleges ültetési tervig**

- meghívott;
- részt vesz;
- még nem válaszolt;
- leültetett;
- hely nélkül;
- konfliktus;
- teremkapacitás;
- következő lépés.

Fő CTA:

> **Ültetési terv folytatása**

## 17.3 Vendéglista UI

Nézetek:

- minden vendég;
- háztartás;
- csoport;
- RSVP;
- leültetett;
- étkezés;
- konfliktus;
- hiányzó adat.

## 17.4 Seating desktop UI

### Bal panel

- eszközök;
- asztalok;
- teremelemek;
- layers;
- template.

### Canvas

- terem;
- vendégek;
- konfliktusok;
- zoom;
- undo/redo.

### Jobb panel

- kijelölt objektum;
- kapacitás;
- vendégek;
- constraint;
- note;
- AI suggestion.

### Alsó sáv

- nem leültetett;
- csoport;
- filter;
- keresés.

## 17.5 AI panel

Nem chatbot, hanem strukturált ajánlási panel:

- probléma;
- miért;
- javuló constraint;
- mellékhatás;
- elfogadás;
- elutasítás;
- másik megoldás.

## 17.6 Venue Pro navigáció

1. Esküvők  
2. Termek és sablonok  
3. Readiness  
4. Riportok  
5. Backstage  
6. Csapat  
7. Beállítások  

## 17.7 Day-of mobil UX

- nagy tap target;
- minimális adat;
- always-visible sync;
- gyors keresés;
- egyképernyős státusz;
- card change checklist;
- érzékeny társasági megjegyzés nélkül.

## 17.8 Accessibility

- megfelelő kontraszt;
- billentyűzet;
- focus;
- screen reader;
- szín mellett ikon/szöveg;
- touch target;
- drag-and-drop alternatíva;
- zoom;
- redukált mozgás.

---

# 18. Adatmodell és objektumkapcsolatok

```text
Account
├── Organization / Venue
├── User
└── Workspace / Event
    ├── Couple
    ├── Venue
    ├── Room
    ├── VenueTemplate
    ├── LayoutVersion
    ├── Table
    ├── Seat
    ├── Guest
    ├── Household
    ├── Group
    ├── RSVP
    ├── DietaryRequirement
    ├── Relationship
    ├── Constraint
    ├── SeatingPlan
    ├── SeatingDecision
    ├── Conflict
    ├── Suggestion
    ├── Approval
    ├── Comment
    ├── ExportPackage
    ├── ImportBatch
    ├── DayOfBaseline
    ├── AttendanceEvent
    ├── DayOfChange
    └── AuditLog
```

## Kritikus kapcsolatok

- Guest → Household;
- Guest → RSVP;
- Guest → Group;
- Guest ↔ Guest Relationship;
- Constraint → Guests/Groups/SpatialObject;
- SeatingPlan → LayoutVersion;
- SeatingDecision → Constraint;
- Suggestion → Decision provenance;
- ExportPackage → Plan version;
- DayOfChange → Baseline;
- AttendanceEvent → Guest;
- ImportBatch → affected records.

---

# 19. Adatvédelem, biztonság és adatmegőrzés

## 19.1 Controller/processor modell

A jelenlegi „háztartási kivétel + platform adatkezelő” leegyszerűsített modell jogi újravalidálást igényel.

Feldolgozási célonként külön kell meghatározni:

- account;
- billing;
- analytics;
- vendéglista;
- RSVP;
- érzékeny adat;
- Venue Pro;
- planner;
- cateringexport;
- törlés.

## 19.2 Érzékeny adat

- explicit consent;
- cél és címzett;
- minimális tartalom;
- role-based access;
- exportfilter;
- retention;
- revoke;
- audit.

## 19.3 Adatmegőrzés

Javasolt alap:

- esküvő után 30 nap teljes szerkesztés;
- 90 nap read-only/export;
- utána törlés vagy anonimizálás;
- előzetes értesítés;
- számlázási adat külön megőrzés.

Venue Pro esetén a venue template marad, de eseményvendégadat nem.

## 19.4 Biztonsági P0

- tenant/workspace isolation;
- RBAC;
- secure invite;
- token revoke;
- MFA venue adminnál;
- encryption;
- KMS;
- malware scan;
- backup;
- restore;
- auditlog;
- export permission;
- session revoke;
- rate limit;
- secret management;
- incident process;
- security contact.

## 19.5 Privacy-by-design export

- role-specific;
- purpose-specific;
- minimum data;
- watermark/version;
- expiry;
- revoke;
- download log.

---

# 20. Fizetés és fogyasztóvédelem

## 20.1 Barion P0

- payment start;
- redirect;
- callback/IPN;
- payment state query;
- idempotent entitlement;
- failed/cancelled flow;
- duplicate protection;
- refund;
- billing details;
- invoice;
- support lookup.

A callback önmagában ne aktiváljon vakon előfizetést: a szerver kérdezze le a fizetés aktuális állapotát.

## 20.2 Fogyasztói folyamat

- ÁSZF;
- adatkezelés;
- csomagtartalom;
- ár;
- teljesítési idő;
- elállási tájékoztató;
- express consent, ahol szükséges;
- refund;
- panasz;
- support.

## 20.3 Entitlement

Workspace-szinten:

- free;
- trial;
- paid;
- refund;
- expired;
- grace;
- venue included;
- venue sponsored.

A venue által fizetett eseménynél a párnak ne kelljen újra fizetnie ugyanazért a seating funkcióért.

---

# 21. Árazási javaslat

Az árak validálandó hipotézisek.

## 21.1 LumaSeat Free

- egy esemény;
- vendéglista;
- RSVP;
- csoport;
- egyszerű terem;
- korlátozott AI preview;
- nincs végleges export.

## 21.2 LumaSeat Event

**4 990 Ft bruttó / esemény – launchár**

- teljes canvas;
- AI;
- conflict;
- lock;
- planner invite;
- PDF;
- cateringexport;
- read-only link;
- 90 nap archívum.

Később tesztelhető:

- 5 990;
- 6 990;
- 7 990 Ft.

## 21.3 Venue Starter

**19 900–29 900 Ft + áfa / hó**

- egy helyszín;
- 1–2 terem;
- 5 aktív esemény;
- template;
- pármeghívás;
- seating;
- export;
- 3 munkatárs.

## 21.4 Venue Pro

**49 900–69 900 Ft + áfa / hó**

- több terem;
- magasabb/korlátlan aktív esemény;
- csapat;
- co-branding;
- venue approval;
- klónozás;
- readiness;
- Backstage;
- Day-of Lite;
- priority support.

## 21.5 Venue Network

Egyedi:

- több helyszín;
- központi template;
- network dashboard;
- közös branding;
- szerepkörök;
- riport.

---

# 22. Go-to-market és terjesztési modell

## 22.1 B2C keresési wedge

- esküvői ültetési rend;
- ülésrend készítő;
- vendéglista;
- RSVP;
- asztalrend;
- teremrajz;
- AI seating;
- Excel helyett.

## 22.2 Viral loop

1. pár eseményt hoz létre;
2. RSVP-link;
3. vendégek találkoznak a márkával;
4. seating egyre pontosabb;
5. QR/table finder;
6. más jegyes vendég felfedezi.

Ne legyen agresszív reklám vagy vendégregisztráció.

## 22.3 Venue channel

- venue létrehozza eseményt;
- pár ingyen/venue-sponsored hozzáférést kap;
- helyszín template-et ad;
- venue review;
- venue fizet recurring díjat.

## 22.4 Venue template moat

Hosszú távú adatvagyon:

- helyszín;
- terem;
- méret;
- kapacitás;
- standard layout;
- asztalkészlet;
- fix elem;
- venue approval;
- verzió.

## 22.5 Planner channel

A planner meghívható minden eseménybe, így megismeri a platformot. Később külön Planner Pro validálható, de nem szükséges a Venue Pro launchhoz.

---

# 23. Pilot- és validációs terv

## 23.1 B2C pilot

- 20–30 pár;
- 50+ vendég;
- kerek/hosszú/vegyes asztal;
- komplex családi eset;
- hozzáférhetőségi igény;
- last-minute változás.

## 23.2 Venue pilot

- 5–8 helyszín;
- több eltérő terem;
- partnerenként 2–3 esküvő;
- event manager;
- catering;
- venue review;
- operatív export.

## 23.3 Day-of kutatás

- 5–8 venue event manager;
- 5 koordinátor;
- 3 cateringvezető;
- legalább 10 konkrét esemény retrospektív.

Mérendő:

- no-show gyakoriság;
- extra vendég;
- ki dönt;
- változtatnak-e;
- mikor zárják le;
- hogyan kommunikálnak;
- mobilinternet;
- papír vs app;
- fizetési hajlandóság.

## 23.4 Concierge pilot

Az első eseményeken:

- csapat segíti az importot;
- figyeli az AI-outputot;
- szükség esetén kézzel készít repairt;
- mérjük, mi használható;
- csak utána automatizálunk.

## 23.5 Fázisok

1. concierge;
2. assisted self-service;
3. hidden paid;
4. public launch;
5. Venue Pro pilot;
6. Day-of Lite pilot.

---

# 24. Launchanalitika és KPI-k

## 24.1 Események

- event_created;
- onboarding_started/completed;
- guest_import_started/completed;
- import_rollback;
- first_guest;
- rsvp_created/sent/responded;
- room_created/imported;
- first_table;
- first_constraint;
- first_ai_plan;
- ai_suggestion_accept/reject;
- conflict_resolved;
- manual_move;
- plan_locked;
- planner_invited;
- venue_invited;
- venue_approved;
- export_generated;
- payment_started/completed/refunded;
- dayof_baseline;
- attendance_changed;
- repair_requested/accepted;
- catering_delta_generated;
- event_archived/deleted.

## 24.2 Elsődleges B2C KPI

> **Az 50+ vendéget importáló workspace-ek hány százaléka jut el konfliktusmentes és exportált seating planig?**

## 24.3 Elsődleges Venue KPI

> **A Venue Pro események hány százaléka jut el határidőre venue-approved, operatív exporttal rendelkező állapotba?**

## 24.4 Elsődleges Day-of KPI

> **Hány eseménynapi eltérés kezelhető úgy, hogy nincs teljes újratervezés és legfeljebb minimális számú vendéget kell mozgatni?**

## 24.5 Pilotcélok

| Mutató | Kezdeti cél |
|---|---:|
| Regisztráció → import | ≥60% |
| Import → terem | ≥65% |
| Terem → első terv | ≥70% |
| AI terv → fizetés | ≥15–25% |
| Fizető → export | ≥80% |
| Hard constraint sérülés | 0 |
| Canvas/export eltérés | 0 |
| Planner/venue meghívás | ≥15% |
| Venue esemény → approval | ≥80% |
| Day-of rögzített változás → sikeres sync | ≥99% |
| Kritikus adatvesztés | 0 |
| Jogosulatlan hozzáférés | 0 |

---

# 25. P0–P2 roadmap

## 25.1 P0 – nyilvános Event launch

### Kötelező

- Guided Setup Interview alap;
- XLSX/CSV/copy-paste import;
- dry run és rollback;
- RSVP;
- háztartás/csoport;
- hard/soft constraint;
- manuális canvas;
- drag-and-drop;
- AI seating;
- deterministic gate;
- explain;
- lock;
- partial regenerate;
- conflict list;
- planner invite;
- PDF;
- cateringexport;
- read-only link;
- Barion;
- consent;
- retention;
- analytics;
- security gate.

## 25.2 P0.5 / Venue Pro pilot

- venue org;
- multi-event dashboard;
- venue template;
- room inventory;
- event create/clone;
- pair invite;
- venue review;
- internal/public notes;
- readiness;
- venue/catering/decor pack;
- co-branding;
- venue pricing.

## 25.3 P1

- AI PDF/image import;
- SVG;
- improved explain;
- plan compare;
- QR table finder;
- place card export;
- last-minute repair;
- mobile approval;
- multilingual RSVP;
- venue library;
- Day-of Lite;
- offline snapshot;
- catering delta;
- own export template.

## 25.4 P2

- Day-of Pro;
- multi-device check-in;
- printer;
- staff notification;
- Venue Network;
- Planner Pro;
- full white-label;
- additional event types;
- API/integrations;
- limited venue operations extensions.

## 25.5 Tudatosan parkolt

- vendor marketplace;
- full CRM;
- e-signature;
- quote/invoice;
- full wedding timeline;
- full budget;
- 3D;
- complete BEO;
- inventory/HR;
- hotel room blocks.

---

# 26. AS-IS → launch változtatási mátrix

| Terület | AS-IS | Launch target | Prioritás |
|---|---|---|---:|
| Pozicionálás | AI seating + vendor CRM | Explainable seating + Venue Pro | P0 |
| Célcsoport B2B | általános vendor/planner | konkrét helyszín | P0 |
| Onboarding | részleges/nem egységes | multimodális guided interview | P0 |
| Vendégimport | nem igazolt | XLSX/CSV/paste + rollback | P0 |
| Teremimport | DXF él | manuális + PDF/kép + DXF | P0 |
| Canvas | részleges/lista/SVG | teljes drag-and-drop | P0 |
| AI | generálás | explain + deterministic gate | P0 |
| Constraint | nem igazolt teljesen | hard/soft + conflict | P0 |
| Lock | nem igazolt | guest/table/plan lock | P0 |
| Export | roadmap | PDF/link/catering | P0 |
| Payment | hold | Barion production | P0 |
| Vendor CRM | élő irány | Szolgáltatóim lite | P0-szűkítés |
| Planner | pár meghívja | collaborator only | P0 |
| Venue Pro | nincs teljesen | multi-event + template + approval | P0.5 |
| Internal notes | részleges | visibility-scoped notes | P0.5 |
| Readiness | nincs egységes | venue milestones | P0.5 |
| Day-of | nincs | Lite pilot | P1 |
| Offline | hosszú távú | scoped offline snapshot | P1 |
| GDPR | döntési modell | legal matrix + consent + retention | P0 |
| Analytics | nem teljes | funnel + runtime metrics | P0 |

---

# 27. Go/no-go launch gate

## 27.1 Pozicionálás

- [ ] Nem állítunk piaci egyedülállóságot bizonyíték nélkül.
- [ ] Nem ígérünk tökéletes/optimális seatinget.
- [ ] A vendor CRM nem dominál.
- [ ] A Venue Pro egy helyszínnek szól.

## 27.2 Onboarding/import

- [ ] Guided Setup működik.
- [ ] XLSX/CSV import működik.
- [ ] Mapping és preview működik.
- [ ] Dry run működik.
- [ ] Rollback működik.
- [ ] Duplicate review működik.
- [ ] Fájl malware scan működik.

## 27.3 RSVP

- [ ] Secure link.
- [ ] Consent record.
- [ ] Reminder.
- [ ] Delivery monitoring.
- [ ] Guest isolation.
- [ ] Sensitive field access.

## 27.4 Canvas

- [ ] Drag-and-drop.
- [ ] Undo/redo.
- [ ] Autosave.
- [ ] Capacity.
- [ ] PDF/image background.
- [ ] DXF.
- [ ] Desktop usability.
- [ ] Mobile review.

## 27.5 AI/seating

- [ ] Hard constraint gate.
- [ ] Explain.
- [ ] Lock.
- [ ] Partial regeneration.
- [ ] Conflict list.
- [ ] No duplicate guest.
- [ ] No hidden unseated attendee.
- [ ] Manual correction always possible.
- [ ] AI nélkül is usable.

## 27.6 Export

- [ ] PDF.
- [ ] Link.
- [ ] Catering.
- [ ] Canvas/export parity.
- [ ] Data-minimization.
- [ ] Version/timestamp.

## 27.7 Collaboration

- [ ] Partner invite.
- [ ] Planner invite.
- [ ] Venue invite.
- [ ] Revoke.
- [ ] Notes visibility.
- [ ] Activity history.
- [ ] No cross-workspace access.

## 27.8 Payment

- [ ] Barion production.
- [ ] Callback + status query.
- [ ] Idempotent entitlement.
- [ ] Refund.
- [ ] Invoice.
- [ ] Terms.
- [ ] Withdrawal process.
- [ ] Support lookup.

## 27.9 Privacy/security

- [ ] Legal role matrix.
- [ ] Privacy notice.
- [ ] Special-data consent.
- [ ] Retention/delete.
- [ ] Tenant isolation tested.
- [ ] Backup restore.
- [ ] Auditlog.
- [ ] No critical security issue.

## 27.10 Piaci validáció

- [ ] 20 pár végigment.
- [ ] 10 teljes export.
- [ ] 5 valódi fizetés.
- [ ] 5 planner/venue invite.
- [ ] 1000 vendégrekord.
- [ ] 100 komplex constraint teszt.
- [ ] 3–5 venue pilot.
- [ ] Hard constraint eltérés: 0.
- [ ] Kritikus adatvesztés: 0.
- [ ] Kritikus access incident: 0.

---

# 28. Javasolt Marveen-munkacsomagok

## W1 – Business definition és scope freeze

- Event és Venue Pro külön definíció;
- planner collaborator;
- non-goals;
- pricing hypothesis;
- terminology.

## W2 – AS-IS code verification

- route;
- API;
- schema;
- actual UI;
- DXF;
- AI;
- RSVP;
- payment;
- permissions;
- analytics.

## W3 – Core data model

- guest;
- household;
- group;
- constraint;
- layout;
- plan version;
- approval;
- import batch;
- venue template.

## W4 – Importer P0

- XLSX;
- CSV;
- paste;
- mapping;
- preview;
- duplicate;
- dry run;
- rollback.

## W5 – Guided Setup

- structured flow;
- attachment;
- dictation;
- AI extraction;
- source tracking;
- summary.

## W6 – Canvas P0

- objects;
- editing;
- autosave;
- undo;
- capacity;
- background;
- DXF hardening.

## W7 – Seating integrity

- hard/soft;
- validation;
- explain;
- conflict;
- lock;
- partial regenerate;
- plan compare base.

## W8 – RSVP and consent

- secure token;
- form;
- reminders;
- sensitive data;
- audit;
- deletion.

## W9 – Collaboration

- couple;
- planner;
- venue;
- notes;
- approval;
- activity;
- revoke.

## W10 – Export

- venue;
- catering;
- decor;
- couple;
- guest;
- parity tests.

## W11 – Payment and entitlement

- Barion;
- callback;
- state;
- idempotency;
- refund;
- invoice;
- consumer flow.

## W12 – Venue Pro pilot

- organization;
- dashboard;
- templates;
- event clone;
- readiness;
- co-branding;
- pricing.

## W13 – Day-of Lite

- baseline;
- PWA;
- offline snapshot;
- single writer;
- status;
- repair;
- delta;
- sync.

## W14 – Security, privacy and launch gate

- legal review;
- RLS/tenant tests;
- backup;
- retention;
- auditlog;
- incident;
- pen test.

## W15 – Analytics and pilot

- event schema;
- funnel;
- KPI;
- pilot cohort;
- feedback;
- go/no-go report.

---

# 29. Végső pozicionálás

## B2C

> **Átgondolt ülésrend. Boldog vendégek. Nyugodt szervezés.**

Részletesen:

> **A LumaSeat az RSVP-válaszokból, a vendégek kapcsolataiból és a ti szabályaitokból javasolt ültetési tervet készít, megmutatja a konfliktusokat, és végig segít a helyszínnek is átadható végleges tervig.**

## Venue Pro

> **Építse fel egyszer a helyszín termeit, és minden esküvőn ugyanazt az ellenőrzött, együttműködő seating-folyamatot használja.**

## Day-of

> **Az esemény napján is egyetlen aktuális igazságforrás – megmutatja, kell-e változtatni, és ha igen, a legkisebb biztonságos módosítást vezeti végig.**

## Végső döntés

A LumaSeat launchja javasolt, ha:

- a fókusz a seating workflow;
- a manuális canvas production-ready;
- az AI magyarázható és determinisztikusan validált;
- az import hétköznapi formátumokból működik;
- a Venue Pro nem növekszik teljes venue CRM-mé;
- az export és fizetés production-ready;
- az adatvédelmi modell lezárt;
- a Day-of funkció lépcsőzetesen, valós venue-pilottal épül.

---

# 30. Források

## Belső forrás

- Marveen fleet – Az 5 termék teljes leírása, 2026. július 17.

## Versenypiaci források

- SeatPlan.io – Seating Chart Maker  
  https://seatplan.io/

- SeatPlan.io – Event Manager  
  https://seatplan.io/event-manager

- SeatPlan.io – AI Floor Plan Import  
  https://seatplan.io/ai-floor-plan-import

- Planning.Wedding magyar oldal  
  https://planning.wedding/hu

- Planning.Wedding magyar seating chart  
  https://planning.wedding/hu/seating-chart

- Prismm – Event Design Software  
  https://www.prismm.com/solutions/event-design-software

- Prismm – Floor Planning for Venues and Planners  
  https://www.prismm.com/solutions/event-design-software/floor-planning-software-venues-planners-vendors

## Technikai és jogi források

- Barion Payment Start v2  
  https://docs.barion.com/Payment-Start-v2

- Barion Callback Mechanism  
  https://docs.barion.com/Callback_mechanism

- Barion Refund v2  
  https://docs.barion.com/Payment-Refund-v2

- Web.dev – Offline Data for PWA  
  https://web.dev/learn/pwa/offline-data

- Web.dev – Service Workers  
  https://web.dev/learn/pwa/service-workers

- EUR-Lex – GDPR, Regulation (EU) 2016/679  
  https://eur-lex.europa.eu/eli/reg/2016/679/oj

- EUR-Lex – Consumer Rights Directive 2011/83/EU  
  https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0083
