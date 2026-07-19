# CostOps Core — v1.0.1 AS-IS → Target GAP Analysis

**Dátum:** 2026-07-15  
**Baseline:** CostOps v1.0.1 Simplify & Trust  
**Target:** CostOps Core teljes költségkezelési végállapot

---

## 1. A dokumentum célja

Ez a dokumentum a CostOps v1.0.1 jelenlegi működését hasonlítja össze a jóváhagyott CostOps Core funkcionális céllal.

A dokumentum:

- nem újratervezi a CostOpsot;
- nem kér új dashboard-koncepciót;
- nem indít implementációt;
- nem terjeszti ki a scope-ot agent-, task-, product- vagy routingirányba;
- elkülöníti a már elkészült, részleges és hiányzó képességeket;
- meghatározza a hiányok függőségi és prioritási sorrendjét.

---

## 2. Scope lock

### In scope

- teljes deployment-szintű költségnyilvántartás;
- subscription, API, hosting, SaaS, domain, email és storage költségek;
- ledger és accounting integrity;
- source lifecycle és provenance;
- provider collectorok és manual fallback;
- freshness és data quality;
- forecast;
- budget;
- deterministic alerting;
- invoice reconciliation;
- credits, refunds és corrections;
- period close/reopen;
- subscription és entitlement követés;
- összköltség-szintű optimalizációs javaslatok;
- havi riport és export;
- auditálhatóság;
- upgrade-elhetőség és upstreamelhetőség.

### Out of scope

- agentenkénti költségattribúció;
- agent-role szintű bontás;
- task/card szintű bontás;
- product/project szintű bontás;
- prompt- és session-ROI;
- task-level cost-per-success;
- model routing;
- provider routing;
- capacity-aware routing;
- #517 implementáció;
- automatikus modell- vagy providerváltás;
- automatikus provider top-up;
- automatikus subscription upgrade/downgrade/cancel.

---

## 3. Státuszjelölések

- **DONE** — a v1.0.1-ben működő és verifikált képesség.
- **PARTIAL** — működik, de nem éri el a végső funkcionális vagy accounting szintet.
- **MISSING** — még nincs használható implementáció.
- **VERIFY** — valamilyen rész létezhet, de a pontos szerződését vagy lefedettségét source-, schema- és tesztvizsgálattal igazolni kell.
- **OUT OF SCOPE** — tudatosan kizárt fejlesztési terület.

---

## 4. Vezetői összefoglaló

A CostOps v1.0.1 már jó, használható operátori felületet és működő havi költség-összefoglalót ad.

A legnagyobb hátralévő hiányok nem vizuálisak, hanem:

1. accounting integrity;
2. teljes source coverage;
3. source lifecycle és provenance normalizálása;
4. durable és auditálható provider sync;
5. forecast pontosság mérése;
6. period close/reopen;
7. invoice, credit, refund és correction kezelése;
8. több szintű budget és determinisztikus riasztás;
9. auditálható manual cost workflow;
10. havi snapshot, export és vezetői riport;
11. összköltség-szintű optimization advisor.

A jelenlegi élő adatoknál a pénzügyi összeg jelentős része továbbra is manual vagy estimate eredetű. A dashboard ezt már őszintén jelzi, de a target állapothoz több tényleges invoice/provider adat és erősebb accounting workflow kell.

---

## GAP-01 — Dashboard és információs hierarchia

**Státusz:** DONE

### AS-IS

A CostOps v1.0.1:

- az alapértelmezett Költségek-nézet;
- megmutatja az előző hónapot;
- megmutatja az aktuális MTD-t;
- megmutatja a forecastot;
- megmutatja a budgetet;
- amount-weighted Data Quality mutatót használ;
- elkülöníti a fontos változásokat;
- tartalmaz egységes költségtáblát;
- külön kezeli az entitlement információt;
- összecsukva tartja a másodlagos részleteket;
- mobilon és desktopon verifikált;
- megtartja a legacy v1 rollback lehetőségét.

### GAP

Nincs lényegi funkcionális gap az alap-UX-ben.

A későbbi accounting, close, alerts és export funkciókat a meglévő v1.0.1 információs hierarchiába kell illeszteni.

### Target

- nincs teljes dashboard-redesign;
- az új funkciók külön drill-down vagy secondary section formájában jelennek meg;
- a fő MTD/forecast/budget headline szemantikája stabil marad.

### Acceptance

- a v1.0.1 fő nézet nem válik újra túlzsúfolttá;
- a headline értékek az új accounting funkciók mellett is változatlan jelentésűek;
- a legacy v1 rollback legalább a stabilizáció lezárásáig megmarad.

---

## GAP-02 — Operational spend és nem számlázott értékek szétválasztása

**Státusz:** DONE / PARTIAL

### AS-IS

A rendszer már külön kezeli:

- operational spend;
- token usage-equivalent opportunity cost;
- subscription entitlement információ.

Az opportunity cost nem kerül bele a számlázott MTD-be vagy a budgetbe.

### GAP

Ellenőrizni és formalizálni kell, hogy ez a szétválasztás:

- API-szerződésben is stabil;
- exportokban is stabil;
- historikus hónapokra is stabil;
- monthly close során is változatlan;
- minden új provider és invoice workflow esetén megmarad.

Az unused subscription value és a token usage-equivalent továbbra sem keverhető egy mezőbe vagy összegbe.

### Target

Legalább négy különálló fogalom:

1. operational spend;
2. forecast;
3. usage-equivalent opportunity cost;
4. entitlement utilization / unused subscription value.

### Acceptance

- egyik nem operational érték sem növeli az MTD-t;
- egyik nem operational érték sem növeli a budget used százalékát;
- exportban külön mezők és egyértelmű megnevezés szerepel;
- minden új funkció regressziós teszttel őrzi a szétválasztást.

---

## GAP-03 — Source registry és lifecycle modell

**Státusz:** PARTIAL

### AS-IS

Létezik költségforrás-regiszter és a dashboard minden ismert source-ot képes megjeleníteni.

Jelenleg többek között kezelt:

- Anthropic Max;
- Anthropic Pro;
- Anthropic API;
- ChatGPT/Codex;
- OpenAI API;
- DeepSeek API;
- GitHub;
- Render;
- AWS;
- domain;
- email;
- storage;
- egyéb SaaS és manual source-ok.

### GAP

A source lifecycle és az adat provenance részben összekeveredhet.

Példa:

- az OpenAI API jelenleg nem aktívan használt;
- ezért nem credential_error a helyes üzleti állapot;
- lifecycle szinten inactive vagy not_configured;
- provenance csak akkor értelmezhető, ha van pénzügyi adat.

Hiányzik vagy formalizálandó:

- egységes lifecycle enum;
- egységes collection method;
- owner;
- blocker;
- expected sync cadence;
- expected invoice cadence;
- operational inclusion rule;
- manual fallback státusz;
- last successful sync;
- last attempted sync;
- next expected update.

### Target

Lifecycle:

- active;
- inactive;
- not_configured;
- unsupported;
- blocked;
- deprecated.

Provenance:

- provider_api_actual;
- invoice_actual;
- imported_actual;
- manual_actual;
- calculated_estimate;
- unknown.

### Acceptance

- minden source pontosan egy lifecycle állapotot kap;
- minden pénzügyi adat pontosan egy provenance típust kap;
- lifecycle és provenance külön mező;
- nincs félrevezető credential_error nem használt source-nál;
- a source inventory megmutatja a következő szükséges emberi vagy technikai lépést.

---

## GAP-04 — Teljes költségforrás-lefedettség

**Státusz:** PARTIAL

### AS-IS

A rendszerben körülbelül 15 előre definiált source szerepel, és több valós költség már rögzített.

Aktív vagy részben aktív integráció:

- Render invoice actual;
- Render plan advisory;
- DeepSeek balance és balance-delta;
- GitHub billing;
- Anthropic Pro invoice;
- Anthropic Max manual;
- további manual subscription és SaaS tételek.

Nyitott vagy korlátozott:

- AWS permission;
- OpenAI API jelenleg nem alkalmazandó vagy nincs aktív API usage;
- egyes hosting/SaaS tételek manual vagy estimate eredetűek.

### GAP

Nem bizonyított még, hogy:

- minden ténylegesen fizetett szolgáltatás szerepel;
- minden éves díj havi szinten megfelelően allokált;
- minden domain és hosting account fel van véve;
- minden egyszeri költség kezelhető;
- nincs elfelejtett vagy duplikált source;
- az inactive és unsupported source-ok teljes listája dokumentált.

### Target

Minden ismert költség:

- automatikusan importált;
- invoice alapján importált;
- manual actualként rögzített;
- calculated estimate-ként jelölt;
- vagy explicit inactive/unsupported.

### Acceptance

- teljes source inventory elkészül;
- inventory és ledger között nincs hiányzó aktív source;
- nincs `unknown` ismert költség;
- minden hiányzó source-hoz owner és következő lépés tartozik;
- source coverage jelentés havi close előtt futtatható.

---

## GAP-05 — Kanonikus ledger és accounting schema

**Státusz:** PARTIAL

### AS-IS

Létezik:

- `cost_sources`;
- `cost_line_items`;
- dedup key;
- confidence;
- data freshness;
- billed/effective cost alap;
- billing period jellegű mezők;
- idempotens upsert bizonyos importoknál;
- deterministic monthly summary.

### GAP

A végső accounting modellhez hiányzik vagy ellenőrzendő:

- lifecycle mezők;
- külön provenance;
- billing period és service period tiszta szétválasztása;
- FX rate, FX source és FX date;
- invoice reference;
- correction relationship;
- original/superseded/voided státusz;
- import run lineage;
- immutable close snapshot kapcsolat;
- updated_at és actor/audit metadata;
- tax, discount, credit és refund konzisztens modellje.

A jelenlegi config-alapú fixed-cost upsert csendben felülírhat egy korábbi összeget. Ez nyitott hónapnál elfogadható lehet, de lezárt időszaknál nem.

### Target

Egyetlen kanonikus ledger, amelyből minden headline és export származik.

### Acceptance

- minden dashboard-összeg konkrét ledger-sorokra vezethető vissza;
- minden ledger-sor eredete és időszaka azonosítható;
- nincs külön, párhuzamos második pénzügyi source of truth;
- closed hónapban nincs silent overwrite;
- korrekció auditált correction/void/supersede műveletként jelenik meg.

---

## GAP-06 — Dupla számolás és reconciliation

**Státusz:** PARTIAL

### AS-IS

A jelenlegi operational selection megakadályozza, hogy:

- manual és provider adat;
- invoice és estimate;
- subscription és usage-equivalent

egyszerre növelje ugyanazt a headline összeget.

A jelenlegi reconciliation delta 0.

### GAP

A reconciliation jelenleg főleg az aktuális summary belső egyezését igazolja.

Hiányzik a formális reconciliation:

- invoice ↔ provider API;
- invoice ↔ ledger;
- manual actual ↔ később érkező invoice;
- estimate ↔ actual;
- provider plan ↔ billed amount;
- credit/refund ↔ original charge;
- FX converted value ↔ original currency total.

### Target

Minden source-nál külön legyen:

- expected amount;
- observed provider amount;
- invoice amount;
- operationally selected amount;
- variance;
- variance reason;
- reconciliation status.

### Acceptance

- minden eltérés látható;
- nincs unexplained delta;
- manual/provider variance külön trust-metrika;
- invoice érkezése nem okoz dupla számlálást;
- egy késői correction visszavezethető az eredeti tételre.

---

## GAP-07 — Collector framework és sync durability

**Státusz:** PARTIAL

### AS-IS

Létezik:

- collector framework;
- import run;
- provider-preferred selection;
- scheduled sync;
- freshness;
- provider-specifikus collectorok;
- hibatűrő fallback bizonyos source-oknál.

### GAP

Teljesen bizonyítani vagy fejleszteni kell:

- durable checkpoint;
- idempotencia minden collectornál;
- retry/backoff policy;
- rate-limit kezelés;
- timeout kezelés;
- partial success;
- per-source lock;
- concurrent sync védelem;
- crash utáni folytatás;
- duplicate import detection;
- stale good data preservation;
- failed run ne írjon felül jó actual adatot;
- import lineage az összes ledger-sorig.

### Target

Minden collector ugyanazt a megbízhatósági szerződést teljesíti.

### Acceptance

- ugyanaz az import kétszer futtatva nem duplikál;
- félbeszakadt import után biztonságosan újraindítható;
- egy provider hibája nem blokkolja a többi providert;
- stale actual nem válik nullává;
- minden import runnak van státusza, időtartama és eredménye;
- nincs provider-side write.

---

## GAP-08 — Freshness és data quality

**Státusz:** PARTIAL, de az UX-alap DONE

### AS-IS

Már működik:

- freshness-gate;
- stale provider megkülönböztetése;
- amount-weighted data quality;
- provider/invoice/manual/estimate arány;
- stale DeepSeek adatból nem képződik hamis blocked állítás.

### GAP

Hiányzik vagy formalizálandó:

- providerenkénti freshness SLO;
- fresh/aging/stale/unknown küszöbök;
- missing expected invoice;
- completeness score;
- stale amount súlyozása;
- hiányzó source becsült pénzügyi hatása;
- data-quality időbeli trend;
- close-blocking quality szabályok.

### Target

A Data Quality ne csak jelenlegi badge legyen, hanem accounting kontroll.

### Acceptance

- minden source-nak van expected freshness;
- a rendszer külön jelzi a stale és a missing állapotot;
- stale adat nem ad erős operatív következtetést;
- close előtt látható, mely source akadályozza a megbízható zárást;
- a score reprodukálható és tesztelt.

---

## GAP-09 — Deviza és FX-kezelés

**Státusz:** PARTIAL / VERIFY

### AS-IS

A rendszer több devizát és HUF-ra konvertált összegeket képes kezelni.

Valós költségek között EUR, USD és HUF is szerepelnek.

### GAP

Nem teljesen formalizált vagy igazolt:

- FX source;
- FX date;
- FX method;
- invoice-date vs service-date árfolyam;
- záráskori árfolyam freeze;
- historikus újrakonvertálás tiltása;
- késői correction FX-kezelése;
- deviza rounding policy.

### Target

Minden konvertált összeghez tartozik:

- original amount;
- original currency;
- FX rate;
- FX source;
- FX date;
- HUF amount;
- conversion method.

### Acceptance

- ugyanaz a ledger-sor reprodukálható HUF-értéket ad;
- closed hónap nem változik későbbi FX-frissítés miatt;
- original currency mindig megmarad;
- rounding szabály tesztelt és dokumentált.

---

## GAP-10 — Forecasting

**Státusz:** PARTIAL

### AS-IS

A rendszer mutat hónap végi forecastot.

A forecast:

- fix havi költségeket teljes havi értéken kezeli;
- usage jellegű tételeket időarányosan becsülhet;
- a dashboardon külön jelenik meg az MTD-től.

### GAP

Hiányzik:

- forecast snapshot history;
- forecast method per source;
- forecast confidence;
- forecast-vs-actual;
- forecast error;
- fix és variable cost külön magyarázata;
- balance-delta alapú módszer formalizálása;
- invoice cadence-alapú forecast;
- egyszeri költségek kezelése;
- incomplete source hatás a forecastra.

### Target

A forecast mérhető modell, nem csak aktuális szám.

### Acceptance

- naponta vagy fontos változáskor snapshot készül;
- minden snapshot reprodukálható;
- hónapzáráskor kiszámítható a forecast error;
- provider- és kategóriaszintű pontosság mérhető;
- a dashboard megmagyarázza a nagy változást;
- fix-költség dominancia nem jelenik meg téves „hónap majdnem kész” állításként.

---

## GAP-11 — Budgeting

**Státusz:** PARTIAL

### AS-IS

Működik:

- teljes havi budget;
- warning threshold;
- hard threshold;
- used százalék;
- forecast százalék;
- display-only státusz.

### GAP

Hiányzik vagy nem teljes:

- provider budget;
- költségkategória budget;
- subscription/API/hosting/SaaS budget;
- budget owner;
- időszakos budget history;
- budget change audit;
- variance explanation;
- rollover policy;
- budget close snapshot.

Nem szükséges:

- agent budget;
- task budget;
- product budget.

### Target

Többszintű, de kizárólag összköltség-scope-ú budgetmodell.

### Acceptance

- global/provider/category budget működik;
- budget változtatás auditálható;
- current és forecast variance látható;
- hard threshold nem hajt végre automatikus leállítást;
- budget snapshot része a havi close-nak.

---

## GAP-12 — Alerts és anomaly detection

**Státusz:** MISSING / PARTIAL

### AS-IS

A dashboard már megjelenít warning jellegű állapotokat, például:

- budget warning;
- stale data;
- credential vagy source problémák;
- entitlement állapot.

### GAP

Nincs teljes, tartós alert lifecycle:

- alert record;
- first_seen;
- last_seen;
- severity;
- evidence;
- acknowledgement;
- cooldown;
- deduplication;
- resolved state;
- recurrence;
- owner.

Hiányzó alerttípusok:

- forecast breach;
- balance exhaustion forecast;
- sync failure;
- missing invoice;
- reconciliation mismatch;
- manual/provider variance;
- unusual spend growth;
- new unknown source;
- estimate-only source hosszú ideig;
- underused subscription.

### Target

Deterministic, nem LLM-alapú alert engine.

### Acceptance

- azonos probléma nem generál riasztási zajt;
- minden alerthez konkrét evidence tartozik;
- alert acknowledgement és resolution működik;
- stale adat önmagában nem okoz erős vagy hibás üzleti alertet;
- nincs automatikus provider-side action.

---

## GAP-13 — Period close és reopen

**Státusz:** MISSING

### AS-IS

A rendszer meg tud jeleníteni korábbi hónapot, de nincs formális accounting close workflow.

A historikus adatok részlegesek:

- egyes hónapok `no_data`;
- egy korábbi hónap csak egyetlen invoice/source alapján ismert;
- az aktuális hónap partial MTD.

### GAP

Hiányzik:

- open/provisional/closed/reopened státusz;
- close readiness check;
- immutable close snapshot;
- explicit reopen;
- actor és reason;
- close után correction-only változtatás;
- expected invoice checklist;
- unresolved alert checklist;
- estimate disclosure.

### Target

Auditálható havi zárási folyamat.

### Acceptance

- closed hónap nem változik csendben;
- close előtt minden hiány és estimate látható;
- reopen csak indokkal és audittal történik;
- close snapshot később reprodukálható;
- késői invoice correctionként kerül be.

---

## GAP-14 — Invoice, credit, refund és correction

**Státusz:** PARTIAL / MISSING

### AS-IS

Létezik invoice-alapú actual adat, például Render és Anthropic esetében.

Manual/provider összevetés részben elérhető.

### GAP

Hiányzik az egységes accounting workflow:

- invoice entity vagy invoice metadata;
- invoice status;
- invoice service period;
- gross/net/tax;
- credit;
- refund;
- discount;
- late charge;
- duplicate invoice detection;
- correction relationship;
- void/supersede;
- invoice-to-provider reconciliation.

### Target

Minden számlázási változás auditált ledger-eseményként kezelhető.

### Acceptance

- credit és refund csökkenti a net costot;
- eredeti charge megmarad;
- correction nem törli az előzményt;
- duplicate invoice nem számítódik kétszer;
- provider API és invoice eltérés látható;
- close után érkező invoice auditált correction.

---

## GAP-15 — Manual cost management

**Státusz:** PARTIAL

### AS-IS

Van manual cost létrehozási és kezelési lehetőség.

A manual fallback fontos része a jelenlegi rendszernek.

Nyitott kártya:

- `73e8914a` manual-entry DELETE endpoint.

### GAP

A hard DELETE valószínűleg nem helyes alapművelet pénzügyi adatoknál.

Hiányzik vagy formalizálandó:

- edit;
- recurring manual item;
- one-time item;
- effective date;
- invoice reference;
- owner;
- reason;
- void;
- archive;
- supersede;
- correction;
- audit trail.

### Target

Manual actual elsőrangú, auditálható accounting adat.

### Acceptance

- pénzügyi előzmény nem tűnik el nyomtalanul;
- void/archive az alapértelmezett eltávolítás;
- hard delete csak hibás, még nem használt draft esetén lehetséges;
- minden módosításhoz actor, időpont és reason tartozik;
- recurring cost következő hónapban determinisztikusan megjelenik.

### Döntési gap

A `73e8914a` implementációja előtt dönteni kell:

- hard DELETE kell-e egyáltalán;
- vagy void/archive/supersede legyen a végleges szerződés.

**Javaslat:** hard DELETE helyett auditált void/archive.

---

## GAP-16 — Subscription és entitlement management

**Státusz:** PARTIAL

### AS-IS

A rendszer már követ bizonyos subscription és entitlement információkat:

- fix havi díj;
- balance;
- weekly/manual capacity;
- freshness;
- utilisation jellegű állapot.

### GAP

Hiányzik vagy nem egységes:

- billing cadence;
- renewal date;
- annual commitment;
- notice period;
- cancellation deadline;
- plan name;
- entitlement unit;
- usage period;
- unused value módszer;
- downgrade candidate;
- duplicate subscription detection;
- utilisation history.

### Target

A CostOps pénzügyi döntéstámogatást adjon subscription-szinten.

### Acceptance

- látható minden aktív subscription;
- renewal és billing cadence kezelhető;
- utilisation és unused value elkülönül;
- stale entitlement nem okoz hamis következtetést;
- lemondás/downgrade csak ajánlás, nem automatikus végrehajtás.

---

## GAP-17 — Aggregate Cost Optimization Advisor

**Státusz:** MISSING

### AS-IS

A dashboard megmutat költségváltozásokat és bizonyos entitlement információkat, de nincs formalizált optimalizációs ajánlásmotor.

### GAP

Hiányzik:

- recommendation entity;
- evidence;
- baseline cost;
- saving estimate;
- annualized saving;
- switching cost;
- risk;
- confidence;
- approval status;
- dismissed/accepted/resolved állapot;
- recommendation expiry.

### Target

Csak aggregált költségszinten javasoljon:

- alulhasznált subscription lemondás/downgrade;
- duplikált subscription;
- duplikált hosting/SaaS;
- éves billing lehetőség;
- nem használt domain/storage;
- elfelejtett szolgáltatás;
- túl magas fix package;
- manual/estimate automatizáció;
- provider discount/credit lehetőség.

### Tilos

- agent szintű ajánlás;
- task szintű ajánlás;
- product szintű bontás;
- model routing;
- automatikus végrehajtás.

### Acceptance

- minden recommendation pénzügyi adatra vezethető vissza;
- nincs bizonyítatlan LLM-ajánlás;
- saving estimate módszere látható;
- kockázat és emberi döntés szükségessége megjelenik;
- recommendation nem hajt végre provider-side változtatást.

---

## GAP-18 — Havi riportálás és export

**Státusz:** PARTIAL / MISSING

### AS-IS

Létezik:

- dashboard;
- monthly summary;
- previous month;
- MTD;
- forecast;
- provider/source breakdown;
- data-quality jelzés;
- closing report jellegű manuális dokumentáció.

### GAP

Hiányzó standard exportok:

- ledger CSV;
- ledger JSON;
- source inventory;
- monthly close snapshot;
- provider summary;
- category summary;
- budget variance;
- forecast history;
- reconciliation report;
- data-quality report;
- alerts;
- optimization recommendations.

Hiányzik az automatikus havi vezetői riport formátuma.

### Target

Egy adott hónap teljes állapota dashboard nélkül is auditálható.

### Acceptance

- export tartalmaz schema verziót és generated_at időt;
- nincs secret;
- account ID maszkolt;
- export és dashboard totals egyeznek;
- closed snapshot később újragenerálás nélkül visszanézhető;
- havi riport megmutatja a legfontosabb változásokat és döntési pontokat.

---

## GAP-19 — Jogosultság és biztonság

**Státusz:** PARTIAL

### AS-IS

Már működő elvek:

- bearer-gated API;
- provider credentialek Vaultban;
- secret nem kerül a ledgerbe;
- provider collectorok read-only módon működnek;
- dashboard-token rotáció gyakorlatban megtörtént;
- nincs automatikus provider-side write.

### GAP

Formalizálandó:

- CostOps write permission;
- manual correction permission;
- close/reopen permission;
- invoice upload permission;
- alert acknowledgement permission;
- audit actor;
- secret redaction;
- export redaction;
- destructive operation policy;
- credential lifecycle státusz.

### Target

Read-mostly rendszer, szűk és auditált write műveletekkel.

### Acceptance

- GET nem ír;
- provider adapter nem végez write műveletet;
- close/reopen és correction actorhoz kötött;
- secret nem jelenik meg logban vagy exportban;
- destructive hard delete kerülendő;
- minden pénzügyi write auditálható.

---

## GAP-20 — Upgrade-elhetőség és upstream stratégia

**Státusz:** PARTIAL, megfelelő irányban

### AS-IS

A helyi CostOps product-first módon fejlődött.

Az upstream alap külön, kis ledger + summary szeletként került be.

A helyi:

- valós config;
- credential;
- pricing;
- provider adapter;
- dashboard;
- operational semantics

nem lett egyetlen nagy upstream változtatásba összekeverve.

### GAP

A további fejlesztéseknél előre rögzíteni kell:

- mely schema generikus;
- mely adapter provider-specifikus;
- mely config deployment-local;
- hogyan történik migration;
- hogyan működik rollback/forward compatibility;
- mikor stabil egy rész upstream javaslathoz;
- hogyan kerüljük a core forkot.

### Target

Javasolt upstream szeletek:

1. provenance, confidence és freshness;
2. import runs és durable checkpoint;
3. generic collector contract;
4. correction és reconciliation modell;
5. period close/reopen;
6. budget és alert modell;
7. normalizált export.

Lokálisan marad:

- credential;
- valós account;
- valós pricing;
- konkrét subscription;
- helyi budget;
- provider account mapping;
- lokális adapter konfiguráció.

### Acceptance

- upstream update nem írja felül a helyi configot;
- nincs secret vagy valós pricing upstreamben;
- minden upstream PR kicsi és önállóan reviewzható;
- a meglévő CostOps upstream PR nem nő vegyes, nagy scope-pá;
- local deployment frissíthető marad.

---

## GAP-21 — Tesztelés, megfigyelés és recovery

**Státusz:** PARTIAL, erős technikai alap

### AS-IS

A CostOps:

- nagy teljes tesztsuite mellett fut;
- API smoke teszttel rendelkezik;
- browser teszttel rendelkezik;
- több viewporton verifikált;
- reconciliation smoke-ot használ;
- legacy UI rollbacket tart fenn.

### GAP

Hiányzó end-to-end accounting tesztek:

- duplicate provider import;
- collector crash közben;
- retry;
- partial import;
- stale provider;
- invoice később érkezik;
- manual estimate supersede;
- credit/refund;
- close/reopen;
- FX freeze;
- closed period correction;
- export-vs-dashboard egyezés;
- DB restore;
- upstream update után local config megmaradása.

### Target

A CostOps nem csak unit szinten, hanem havi accounting lifecycle szinten tesztelt.

### Acceptance

Legalább egy teljes szimulált hónap:

1. open;
2. manual costs;
3. provider imports;
4. failed sync;
5. invoice arrival;
6. reconciliation;
7. forecast snapshots;
8. close;
9. late correction;
10. reopen vagy correction-only kezelés;
11. export;
12. restore.

---

## Out-of-scope gap matrix

### Cost Attribution

**Státusz:** OUT OF SCOPE

- agent cost;
- role cost;
- session cost;
- task cost;
- product cost;
- prompt cost;
- cost-per-success.

### Task/Product Cost Analytics

**Státusz:** OUT OF SCOPE

- task profitability;
- product unit economics;
- feature ROI;
- per-product budget.

### Capacity-aware Routing

**Státusz:** OUT OF SCOPE

- model profile;
- primary/fallback;
- quota routing;
- provider switching;
- cost-aware task routing;
- #517 runtime implementation.

Ezek különálló későbbi projektek.

Nem kell hozzájuk kártyát vagy implementation plan-t létrehozni a CostOps Core roadmap részeként.

---

## Összesített gap-prioritás

### P0 — Baseline formalization

1. OpenAI API lifecycle korrekció:
   - inactive/not_configured/not_applicable;
   - ne credential_error.
2. Teljes source inventory.
3. Manual DELETE vs void/archive döntés.
4. Hétnapos reliability observation.
5. Baseline headline és accounting semantics rögzítése.

### P1 — Accounting integrity

1. source lifecycle és provenance;
2. durable import;
3. idempotency és checkpoint;
4. retry és partial failure;
5. FX provenance;
6. forecast snapshot;
7. reconciliation modell;
8. correction/void/supersede;
9. audit lineage.

### P2 — Monthly accounting

1. invoice workflow;
2. credits/refunds;
3. period close;
4. reopen;
5. immutable snapshot;
6. monthly export;
7. forecast-vs-actual.

### P3 — Cost control

1. provider/category budget;
2. deterministic alerts;
3. anomaly detection;
4. missing invoice;
5. balance exhaustion;
6. subscription lifecycle.

### P4 — Optimization

1. aggregate cost recommendations;
2. saving estimate;
3. risk/confidence;
4. approval workflow;
5. no automatic execution.

---

## Függőségi sorrend

```text
Phase 0: Baseline formalization
  ↓
Phase 1A: Source registry + lifecycle + provenance
  ↓
Phase 1B: Durable imports + lineage + FX
  ↓
Phase 1C: Reconciliation + corrections
  ↓
Phase 2: Full source coverage
  ↓
Phase 3: Forecast accuracy + period close + reporting
  ↓
Phase 4: Budgets + alerts
  ↓
Phase 5: Aggregate optimization advisor
  ↓
Phase 6: Stabilization + upstream slices
```

---

## Következő konkrét implementációs sprint

### Javasolt sprint

**CostOps Phase 0 — Baseline Formalization & Source Lifecycle**

### Miért ez következik?

A jelenlegi UI stabil.

A következő legfontosabb probléma nem az új megjelenítés, hanem hogy minden source egyértelmű üzleti és technikai státuszt kapjon, mielőtt period close, reconciliation vagy alerts épül rá.

### Sprint scope

1. OpenAI API source lifecycle korrekció.
2. Egységes lifecycle enum.
3. Provenance és lifecycle szétválasztása.
4. Teljes source inventory API/riport.
5. Minden source owner/blocker/freshness/cadence feltöltése.
6. 7 napos reliability observation elindítása.
7. Manual hard DELETE helyett void/archive döntési specifikáció.
8. Baseline semantics regression tesztek.

### Nem része

- új dashboard redesign;
- close/reopen implementáció;
- nagy ledger migration;
- optimization advisor;
- agent/task/product attribution;
- routing;
- upstream PR.

---

## Phase 0 acceptance criteria

1. Minden ismert source inventoryban szerepel.
2. Minden source pontosan egy lifecycle állapotot kap.
3. Lifecycle és provenance külön mező.
4. OpenAI API source nem credential_error, ha nincs aktív API-használat.
5. Minden aktív source-nak van:
   - collection method;
   - provenance;
   - freshness;
   - sync cadence;
   - owner;
   - operational inclusion rule;
   - manual fallback.
6. Minden blocked source-nak van konkrét blocker és owner action.
7. Nincs unknown lifecycle.
8. Nincs headline szemantikai változás.
9. Reconciliation delta 0 marad.
10. Opportunity cost nem kerül operational spendbe.
11. A hétnapos observation window induló snapshotja elkészül.
12. A `73e8914a` kártyáról dokumentált döntés születik: hard DELETE vagy auditált void/archive.
13. Build és teljes tesztsuite zöld.
14. API és browser smoke zöld.
15. Nincs push vagy PR.
16. A meglévő upstream CostOps PR érintetlen.

---

## Becsült fázisméretek

### Phase 0 — Baseline formalization

- Érték: magas
- Kockázat: alacsony
- Méret: kicsi–közepes
- Schema-hatás: alacsony vagy additív
- API-hatás: kicsi
- UI-hatás: minimális
- Upstreamelhetőség: részleges

### Phase 1 — Reliability & Accounting Integrity

- Érték: nagyon magas
- Kockázat: közepes
- Méret: nagy
- Schema-hatás: közepes
- API-hatás: közepes
- UI-hatás: drill-down szint
- Upstreamelhetőség: magas a generikus részeknél

### Phase 2 — Full Cost Coverage

- Érték: nagyon magas
- Kockázat: közepes
- Méret: providerfüggő, közepes–nagy
- Schema-hatás: alacsony
- API-hatás: adapterenként változó
- UI-hatás: source inventory
- Upstreamelhetőség: collector framework igen, valós adapter/config nem

### Phase 3 — Budgeting & Alerts

- Érték: magas
- Kockázat: közepes
- Méret: közepes
- Schema-hatás: additív
- API-hatás: közepes
- UI-hatás: új nézet/drill-down
- Upstreamelhetőség: magas

### Phase 4 — Aggregate Optimization Advisor

- Érték: közepes–magas
- Kockázat: közepes
- Méret: közepes
- Schema-hatás: additív
- API-hatás: új recommendation endpoint
- UI-hatás: új recommendation nézet
- Upstreamelhetőség: részleges

### Phase 5 — Monthly Close & Reporting

- Érték: nagyon magas
- Kockázat: közepes–magas
- Méret: nagy
- Schema-hatás: közepes
- API-hatás: jelentős
- UI-hatás: close/report nézet
- Upstreamelhetőség: magas

### Phase 6 — Stabilization & Upstream

- Érték: magas
- Kockázat: alacsony–közepes
- Méret: közepes
- Schema-hatás: nincs új funkcióból eredő
- API-hatás: stabilizáció
- UI-hatás: polish
- Upstreamelhetőség: a fázis fő célja

---

## Végső gap-verdikt

A CostOps v1.0.1 nem prototípus és nem puszta dashboard.

Már kész:

- működő ledger-alap;
- havi költségösszesítés;
- valós és manual source-ok;
- operational selection;
- forecast baseline;
- budget baseline;
- amount-weighted data quality;
- freshness-gate;
- használható Simplify & Trust UI;
- browser és API verification;
- reconciliation delta 0;
- rollback lehetőség.

A CostOps Core azonban még nem teljes pénzügyi kontrollrendszer.

A befejezéshez elsősorban szükséges:

- accounting integrity;
- teljes source coverage;
- durable sync;
- invoice és correction workflow;
- period close;
- több szintű budget;
- deterministic alerts;
- havi export;
- aggregate optimization recommendations.

A következő helyes lépés:

**Phase 0 — Baseline Formalization & Source Lifecycle.**

Az agent/task/product és routing elemek tudatosan OUT OF SCOPE státuszúak, és nem részei a CostOps Core elkészültségének.
