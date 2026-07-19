# CostOps Core — teljes funkcionális scope

**Baseline:** CostOps v1.0.1 Simplify & Trust  
**Cél:** a Marveen deployment teljes, auditálható költségkezelő rendszere  
**Scope-korlát:** nincs agent-, task-, product-szintű költségattribúció és nincs routing

---

## 0. Kiinduló állapot

A CostOps v1.0.1 Simplify & Trust az alapértelmezett Költségek-nézet.

Jelenlegi stabil baseline:

- default route: `#costs-v2`;
- legacy v1 nézet egy kattintással elérhető rollbackként;
- aktuális hónap, előző hónap, forecast, budget és adatminőség látható;
- provider-, invoice-, manual- és estimate-források megkülönböztethetők;
- az operational spend és a token opportunity cost külön kezelt;
- reconciliation delta 0;
- freshness-gate működik;
- nincs szükség újabb teljes dashboard-redesignra.

A további fejlesztés erre a baseline-ra épüljön, backward-compatible módon.

---

## 1. A CostOps Core célja

A CostOps Core legyen a Marveen deployment teljes, auditálható költségkezelő rendszere.

A rendszer válaszolja meg megbízhatóan:

1. Mennyit költünk jelenleg?
2. Milyen szolgáltatónál és milyen szolgáltatásra költünk?
3. Mely költség tényleges számla vagy provider-adat, és melyik manual vagy estimate?
4. Mennyit várunk a hónap végére?
5. Hogyan állunk a budgethez képest?
6. Mi változott az előző hónaphoz képest?
7. Mely adat hiányos, elavult vagy bizonytalan?
8. Mely subscription, API, hosting vagy SaaS költség csökkenthető?
9. Lezárható és később reprodukálható-e egy adott hónap pénzügyi állapota?
10. Minden dashboardon szereplő összeg visszavezethető-e a ledger konkrét soraira?

A CostOps nem általános telemetriai vagy routing platform. Elsődleges tárgya a teljes deployment pénzügyi költsége és annak kontrollja.

---

## 2. Kifejezetten out of scope

A következők nem részei a CostOps Core fejlesztésének:

- agentenkénti költségattribúció;
- agent-role szintű költségbontás;
- task/card szintű költségattribúció;
- termék/project szintű költségattribúció;
- prompt- vagy session-szintű ROI;
- taskonkénti cost-per-success;
- modellminőség-benchmark;
- automatikus modellválasztás;
- automatikus providerválasztás;
- capacity-aware routing;
- #517 implementáció;
- primary/fallback routing;
- automatikus API/subscription átterelés;
- automatikus provider top-up;
- automatikus előfizetés-váltás vagy lemondás.

Ezek későbbi, különálló fejlesztési scope-ok.

A CostOps később exportálhat szabványos költség- és budget-jeleket más moduloknak, de most nem építünk ilyen integrációt, és nem kapcsoljuk össze a routinggal.

---

## 3. Költségfogalmak kötelező szétválasztása

### 3.1 Operational spend

A ténylegesen kifizetett vagy fizetendő költség:

- előfizetés;
- API usage;
- hosting;
- domain;
- email;
- storage;
- SaaS;
- invoice;
- provider által számlázott díj;
- adó vagy díj, ha releváns;
- credit/refund/correction hatása.

Ez az elsődleges headline és budget-alap.

### 3.2 Forecast

A hónap végére várható operational spend.

A forecast ne keveredjen a jelenlegi MTD összeggel, és minden forecastnak legyen:

- számítási módszere;
- snapshot időpontja;
- confidence-e;
- később mérhető forecast-vs-actual eltérése.

### 3.3 Usage-equivalent opportunity cost

Az előfizetésben felhasznált token vagy kapacitás elméleti API-egyenértéke.

Ez:

- nem számlázott költség;
- nem része az operational spendnek;
- nem része a budgetnek;
- külön, összecsukott információként jelenhet meg;
- mindig egyértelmű „nem fizetett költség” jelölést kap.

### 3.4 Entitlement utilization / unused subscription value

A megvásárolt előfizetési kapacitás kihasználtsága.

Ez különbözik az opportunity costtól.

Példák:

- havi vagy heti limit kihasználtsága;
- fennmaradó balance;
- becsült kihasználatlan előfizetési érték;
- csomag túlságosan alacsony vagy magas kihasználtsága.

Ezt nem szabad összeadni az operational spenddel vagy a usage-equivalent opportunity costtal.

---

## 4. Költségforrások funkcionális modellje

Minden költségforrás szerepeljen egy központi source registryben.

Példák:

- Anthropic Max;
- Anthropic Pro;
- Anthropic API;
- ChatGPT/Codex subscription;
- OpenAI API;
- DeepSeek API;
- GitHub;
- Render;
- AWS;
- Vercel;
- Cloudflare;
- domain;
- email;
- storage;
- monitoring;
- további hosting és SaaS;
- other/manual.

Minden source-nál külön mezőként kezelendő:

- provider;
- service;
- account vagy billing context helyi azonosítója;
- költségkategória;
- subscription/API/hosting/SaaS típus;
- lifecycle status;
- collection method;
- provenance;
- confidence;
- freshness;
- currency;
- billing period;
- sync cadence;
- manual fallback;
- operational spend inclusion;
- owner;
- aktuális blocker;
- utolsó sikeres adatfrissítés.

### Lifecycle status

- `active`;
- `inactive`;
- `not_configured`;
- `unsupported`;
- `blocked`;
- `deprecated`.

### Adatprovenance

- `provider_api_actual`;
- `invoice_actual`;
- `imported_actual`;
- `manual_actual`;
- `calculated_estimate`;
- `unknown`.

A lifecycle és a provenance nem keverhető.

Példa:

- az OpenAI API source lehet `inactive`, mert jelenleg nincs tényleges API-használat;
- ettől nem `credential_error`;
- később aktiválható, amikor tényleges API organization és usage lesz.

---

## 5. Teljes költségforrás-lefedettség

A végállapotban minden ismert, rendszeresen vagy alkalomszerűen felmerülő költség:

- automatikusan importált;
- számlából importált;
- manuálisan rögzített;
- vagy explicit inactive/unsupported.

Nem maradhat olyan ismert költség, amely egyszerűen hiányzik a rendszerből.

Minden forráshoz szükséges:

- havi összeg;
- eredeti deviza;
- HUF-konverzió;
- billing period;
- service period, ha eltér;
- számla vagy adatforrás hivatkozása;
- adatminőség;
- freshness;
- inclusion/exclusion indok;
- manual fallback, ha az automatizálás nem lehetséges.

A forráslefedettséget külön inventory nézet vagy riport mutassa.

---

## 6. Ledger és accounting integrity

A CostOps rendelkezzen egyetlen kanonikus költségledgerrel.

Minden ledger-sor tartalmazza legalább:

- source;
- provider;
- service;
- category;
- billing period;
- usage/service period;
- amount;
- currency;
- HUF amount;
- FX rate;
- FX date;
- provenance;
- confidence;
- freshness;
- invoice/import reference;
- correction relationship;
- created/updated timestamp;
- audit metadata.

Kötelező accounting szabályok:

- nincs dupla számolás;
- ugyanaz a költség invoice és provider API formában csak egyszer számíthat bele;
- a superseded manual vagy estimate sor összehasonlításra megmaradhat, de operational spendbe nem számíthat bele kétszer;
- minden dashboard headline a ledgerből legyen levezethető;
- a reconciliation delta legyen mindig 0 vagy egyértelműen megmagyarázott;
- a ledger módosítása auditálható legyen;
- destruktív felülírás helyett korrekciós sorok preferáltak.

---

## 7. Import, collector és sync megbízhatóság

Minden automatizált collector a közös collector frameworköt használja.

Kötelező tulajdonságok:

- idempotens import;
- ugyanazon időszak ismételt importja ne generáljon duplikációt;
- import run azonosító;
- checkpoint;
- last successful sync;
- retry/backoff;
- partial failure kezelése;
- provider rate-limit kezelése;
- credential error és permission error külön állapot;
- timeout és network error külön állapot;
- stale adat ne nullázza a korábbi hiteles értéket;
- hibás sync ne írja felül a jó adatot;
- manuális fallback legyen lehetséges;
- minden sync auditálható.

Provider-side write nem szükséges és nem megengedett.

A collectorok kizárólag költség-, számla-, balance-, entitlement- és usage-adatot olvassanak.

---

## 8. Freshness, confidence és data quality

Minden pénzügyi adatnak legyen:

- provenance;
- freshness;
- confidence;
- completeness státusza.

A dashboard data-quality mutatója összeggel súlyozott legyen, ne egyszerű forrásszám-alapú.

Külön látszódjon:

- tényleges invoice/provider adat aránya;
- manual actual aránya;
- estimate aránya;
- stale adatok aránya;
- hiányzó források becsült pénzügyi hatása.

Freshness státusz például:

- `fresh`;
- `aging`;
- `stale`;
- `unknown`.

Stale entitlement vagy balance alapján nem szabad „blocked” vagy hasonló erős operatív állítást tenni.

---

## 9. Deviza- és árfolyamkezelés

Minden költség őrizze meg az eredeti devizát.

A HUF-konverzióhoz legyen:

- árfolyamérték;
- árfolyamforrás;
- árfolyamdátum;
- konverzió időpontja;
- konverziós módszer.

A már lezárt időszak HUF-értéke ne változzon automatikusan későbbi árfolyammal.

Támogatandó:

- HUF;
- EUR;
- USD;
- további devizák későbbi bővítése.

---

## 10. Forecasting

A forecast legyen reprodukálható és mérhető.

Forrástípustól függően támogassa:

- fix havi subscription;
- időarányos API usage;
- balance-delta alapú becslés;
- invoice cadence;
- recurring hosting/SaaS;
- manuális várható költség;
- egyszeri költség.

Kötelező:

- forecast snapshotok;
- snapshot dátuma;
- számítási módszer;
- forecast confidence;
- hónap végi actualhoz való összehasonlítás;
- forecast error;
- provider- és kategóriaszintű bontás.

A forecast ne állítsa, hogy „a hónap majdnem lezárult”, ha a kis MTD-forecast különbség valójában a fix költségek dominanciájából ered.

---

## 11. Budgetkezelés

Támogatandó budget-szintek:

- teljes havi CostOps budget;
- provider budget;
- költségkategória budget;
- subscription/API/hosting/SaaS budget.

Nem szükséges:

- agent budget;
- task budget;
- product/project budget.

Minden budgethez:

- időszak;
- keret;
- currency;
- soft threshold;
- hard threshold;
- current spend;
- forecast;
- variance;
- státusz;
- owner;
- megjegyzés.

A hard threshold ebben a scope-ban riasztási és governance funkció, nem automatikus szolgáltatás-leállítás.

---

## 12. Alerts és anomáliák

A CostOps determinisztikus riasztásokat adjon.

Riasztástípusok:

- budget threshold;
- forecasted budget breach;
- provider balance exhaustion;
- stale collector;
- failed sync;
- credential/permission error;
- missing invoice;
- reconciliation mismatch;
- manual/provider variance;
- szokatlan költségnövekedés;
- új, korábban nem látott költségforrás;
- hosszú ideje kizárólag estimate-ből működő source;
- subscription alul- vagy túlhasználtság.

Kötelező:

- severity;
- evidence;
- first seen;
- last seen;
- freshness;
- deduplication;
- cooldown;
- acknowledgement;
- resolved státusz.

A riasztás ne használjon folyamatos LLM-monitoringot.

---

## 13. Period close és havi accounting folyamat

A CostOps támogassa a havi zárást.

Egy hónap státusza:

- `open`;
- `provisional`;
- `closed`;
- `reopened`.

Close előtt ellenőrizendő:

- minden várt invoice megérkezett-e;
- minden collector friss-e;
- reconciliation rendben van-e;
- minden manual tétel igazolt-e;
- vannak-e estimate-ek;
- vannak-e unresolved alertok;
- FX adatok rögzítve vannak-e.

Closed időszak:

- nem változhat csendben;
- új adat csak explicit correctionként kerülhet be;
- reopen auditált művelet legyen;
- a záráskori snapshot reprodukálható maradjon.

---

## 14. Invoice reconciliation, credits és korrekciók

Támogatandó:

- invoice import vagy manuális invoice-rögzítés;
- provider API és invoice összevetése;
- credit;
- refund;
- discount;
- tax;
- late charge;
- retroactive correction;
- duplicate invoice detection;
- manual/provider variance.

A rendszer külön mutassa:

- gross cost;
- credit/refund;
- net billed cost;
- effective cost;
- reconciliation difference.

Invoice vagy korrekció törlése helyett auditált void/supersede/correction művelet preferált.

---

## 15. Manual cost management

A manuálisan kezelt költségforrás elsőrangú funkció, nem szükségmegoldás.

Szükséges:

- manual cost létrehozása;
- szerkesztése;
- void/supersede;
- biztonságos törlési vagy archiválási folyamat;
- recurring manual cost;
- egyszeri manual cost;
- invoice attachment/reference;
- megjegyzés;
- confidence;
- owner;
- audit trail.

A `73e8914a` manual-entry DELETE endpoint csak akkor készüljön el, ha a végleges accounting modell alapján valóban hard delete szükséges. Preferált az auditálható void/archive, ha pénzügyi sorokról van szó.

---

## 16. Subscription és entitlement kezelés

A CostOps kövesse a fizetett előfizetéseket és azok kihasználtságát.

Forrásonként:

- havi/éves díj;
- renewal date;
- billing cadence;
- csomag;
- entitlement;
- current usage;
- remaining capacity;
- utilization;
- freshness;
- manual vagy provider adat;
- lemondási/downgrade lehetőség;
- notice period, ha ismert.

Ez csak költségkezelés és döntéstámogatás.

Nem része:

- automatikus routing;
- automatikus accountváltás;
- automatikus subscription upgrade/downgrade.

---

## 17. Aggregate Cost Optimization Advisor

A CostOps adjon összköltség-szintű optimalizációs javaslatokat.

Megengedett ajánlások:

- alulhasznált subscription lemondása vagy downgrade-je;
- duplikált subscription;
- duplikált hosting vagy SaaS;
- éves előfizetésre váltás;
- nem használt domain vagy storage;
- tartósan manual/estimate source automatizálása;
- API-költség helyett már megvásárolt subscription jobb kihasználása, kizárólag magas szintű ajánlásként;
- provider credit vagy discount kihasználása;
- túl magas fix csomag;
- tartós manual/provider eltérés;
- fölösleges vagy elfelejtett szolgáltatás.

Minden ajánláshoz:

- jelenlegi költség;
- bizonyíték;
- becsült havi megtakarítás;
- becsült éves megtakarítás;
- egyszeri váltási költség;
- kockázat;
- confidence;
- szükséges emberi döntés;
- rollback vagy visszaállási lehetőség.

Tilos:

- automatikus végrehajtás;
- task/model szintű ajánlás;
- agent szintű optimalizálás;
- routing döntés.

---

## 18. Dashboard és riportálás

A v1.0.1 Simplify & Trust maradjon az UX alapja.

Fő nézet:

- Previous month;
- Current MTD;
- Forecast;
- Budget;
- Data Quality;
- legfontosabb változások;
- egységes költségtábla;
- entitlement állapotok;
- trend;
- secondary detail összecsukva.

További funkciók fokozatosan:

- provider szűrés;
- kategória szűrés;
- időszak;
- provenance/freshness drill-down;
- invoice/reconciliation nézet;
- budget és alert nézet;
- monthly close nézet;
- optimization recommendations;
- source inventory.

Nem kell új vizuális koncepció. Az új funkciók a v1.0.1 információs hierarchiájába illeszkedjenek.

---

## 19. Export és auditálhatóság

Szükséges exportok:

- ledger CSV;
- ledger JSON;
- havi close snapshot;
- provider summary;
- category summary;
- budget variance;
- source inventory;
- data-quality report;
- reconciliation report;
- alerts;
- optimization recommendations.

Az export:

- ne tartalmazzon secretet;
- személyes vagy provider account ID-kat csak szükséges és maszkolt formában;
- legyen reprodukálható;
- tartalmazza a generálási időt és a schema verziót.

---

## 20. Jogosultság és biztonság

A CostOps alapvetően read-mostly rendszer.

Kötelező:

- provider oldalon csak read-only műveletek;
- credentialek csak helyi Vaultban;
- secret nem kerülhet DB ledgerbe, logba, riportba vagy gitbe;
- dashboard write műveletek auditálva;
- manual correction és close/reopen jogosultsághoz kötve;
- destructive művelet kerülendő;
- nincs automatikus provider-side write;
- nincs automatikus vásárlás, top-up, lemondás vagy csomagváltás.

---

## 21. Frissíthetőség és upstream stratégia

A helyi Marveen deployment maradjon frissíthető.

Fejlesztési elvek:

- additív, backward-compatible schema;
- külön CostOps modul és adapter interfaces;
- provider-specifikus logika izolálva;
- deployment-local credential és account config;
- nincs core fork, ha extension vagy adapter elég;
- migration visszafordítható vagy biztonságosan forward-only;
- legacy v1 rollback legalább a stabilizáció végéig maradjon.

Upstreamre alkalmas generikus szeletek:

- provenance/confidence/freshness modell;
- generic collector interface;
- import run/checkpoint/idempotency;
- reconciliation és correction modell;
- period close/reopen;
- budget és alert adatmodell;
- normalizált export.

Lokálisan marad:

- credential;
- account;
- konkrét subscription;
- valós pricing;
- helyi budget;
- helyi provider adapter config;
- helyi cost policy.

A meglévő upstream CostOps PR-t ne bővítsd nagy, vegyes scope-pal. A további generikus fejlesztések külön, kis PR-javaslatok legyenek, csak a lokális implementáció stabilizálása után.

---

## 22. Fejlesztési fázisok

### Phase 0 — Baseline formalization

- OpenAI API source lifecycle korrekció;
- source inventory;
- 7 napos reliability observation;
- v1.0.1 baseline és headline semantics rögzítése;
- manual DELETE vs void/archive döntés.

### Phase 1 — Reliability & Accounting Integrity

- idempotent imports;
- durable checkpoints;
- retries;
- freshness SLO;
- forecast snapshots;
- forecast accuracy;
- period close/reopen;
- invoice reconciliation;
- credits/refunds/corrections;
- FX provenance;
- audit lineage.

### Phase 2 — Full Cost Coverage

- minden ismert subscription/API/hosting/domain/email/storage/SaaS source;
- manual és invoice workflow;
- normalizált cost taxonomy;
- no unknown;
- no double counting.

### Phase 3 — Budgeting & Alerts

- total/provider/category budget;
- thresholds;
- forecast breach;
- balance exhaustion;
- stale/missing data;
- sync/reconciliation/anomaly alerts;
- acknowledgement és cooldown.

### Phase 4 — Aggregate Cost Optimization Advisor

- subscription/provider/hosting/SaaS szintű megtakarítási javaslatok;
- bizonyíték és saving estimate;
- csak emberi jóváhagyás;
- nincs automatikus végrehajtás.

### Phase 5 — Monthly Close & Reporting

- havi close workflow;
- immutable snapshot;
- close/reopen audit;
- vezetői riport;
- trend és variance;
- CSV/JSON export.

### Phase 6 — Stabilization & Upstream Slices

- end-to-end reliability;
- restore/upgrade teszt;
- dokumentáció;
- generikus részek upstream javaslata;
- lokális specifikumok izolálása.

---

## 23. CostOps Core végső acceptance criteria

A CostOps Core akkor tekinthető késznek, ha:

1. Minden ismert költségforrás szerepel vagy explicit inactive/unsupported.
2. Nincs ismert dupla számolás.
3. Minden operational spend visszavezethető ledger-sorokra.
4. Minden adatnak van provenance, freshness és confidence.
5. A data-quality amount-weighted.
6. A forecast snapshotolt és a pontossága mérhető.
7. A budget breach előre jelezhető.
8. A havi close reprodukálható.
9. Closed hónap nem változik csendben.
10. Invoice, credit, refund és correction kezelhető.
11. A reconciliation eltérés mindig látható és indokolható.
12. A collectorok idempotensek és részleges hibát tolerálnak.
13. Egy stale vagy hibás provider nem nullázza a jó adatot.
14. A manuális költségkezelés auditálható.
15. A subscription kihasználtság és unused value külön látszik.
16. Az opportunity cost nincs összekeverve az operational spenddel.
17. A rendszer provider/subscription/SaaS szintű megtakarításokat javasol.
18. Nincs automatikus provider-side pénzügyi művelet.
19. CSV/JSON és havi snapshot export működik.
20. A helyi deployment upstream frissítés mellett fenntartható.
21. Nincs agent/task/product attribution.
22. Nincs routing vagy automatikus modellválasztás.
