# CostOps v1.0 — Integrált véglegesítési kérés

## Cél

A CostOps modult egyetlen, product-first sprintben kell befejezni, több belső ellenőrzési körrel.

Ez nem ügyfélnek készülő rendszer, ezért nem szükséges apró PR-fázisokra bontani. A cél egy ténylegesen használható belső költségkontroll-dashboard, amely egyszerre rendezi:

- a valódi adatforrásokat;
- a múlt–jelen–forecast pénzügyi modellt;
- a tételes drill-downt;
- a csomagban foglalt használatot és limiteket;
- a token/model/agent attribúciót;
- a manuális fallback használhatóságát;
- a dashboard UX-et;
- az automatikus frissítést és az adatminőség-jelzést.

## Source of truth

- `audits/costops-current-state-and-finish-gap.md`
- `audits/costops-v08-cost-control-spec.md`
- `audits/costops-dashboard-v2-ux-plan.md`

---

# 1. Végső termékcél

A dashboardról 10 másodperc alatt meg lehessen válaszolni:

1. Mennyi volt az előző lezárt hónap teljes költése?
2. Mennyit költöttünk eddig az aktuális hónapban?
3. Mennyi várható a hónap végére?
4. Mi alkotja ezeket a számokat tételesen?
5. Mely adat jött provider API-ból, emailből, manuálisan vagy becslésből?
6. Melyik provider, termék, csomag, modell vagy agent hajtja a költséget?
7. A megvásárolt csomagokban foglalt használatból mennyit használtunk el?
8. Mennyi keret maradt, mikor resetel, és várható-e limit- vagy overage-probléma?
9. Mennyire teljes és megbízható az adat?
10. Van-e budget-, számla-, limit-, renewal- vagy adatfrissességi teendő?

A warningok és teendők az alap-költségkontroll fölött legyenek, ne helyettesítsék azt.

---

# 2. Munkamód

Egy integrált build készüljön, de több belső ellenőrzési körrel:

1. adat és számítás;
2. első használható dashboard;
3. böngészős UX-teszt és javítás;
4. végső pénzügyi és adatminőségi acceptance.

A körök között ne várjon külön GO-ra. A talált hibákat javítsa, majd menjen tovább.

Csak akkor álljon meg és kérdezzen, ha:

- új provider credential vagy jogosultság kell;
- provider-side write kellene;
- nem additív vagy destruktív DB-változás kellene;
- nem dönthető el biztonságosan, hogy egy tétel billed actual vagy becslés;
- PII- vagy secret-kockázat van.

---

# 3. Egységes múlt–jelen–forecast modell

## 3.1 Három fő időnézet

A főoldalon három külön pénzügyi nézet legyen.

### Múlt — előző lezárt hónap

Mutassa:

- tényleges actual költés;
- hónap státusza: `complete`, `partial`, `no_data`;
- actual/API/email/manual/estimate arány;
- adatlefedettség;
- csomagban foglalt használat tényleges fogyása;
- esetleges overage;
- provider-, kategória- és tételbontás.

### Jelen — aktuális hónap MTD

Mutassa:

- eddig ismert operational spend;
- ismert fix havi költségek;
- eddigi usage-költség;
- aktuális prepaid/balance;
- csomagban foglalt használat fogyása;
- felhasználási százalék és maradék;
- adat eddig dátuma;
- adatminőség és frissesség.

### Forecast — várható hó vége

Mutassa:

- várható teljes havi költés;
- fix előfizetések;
- provider saját forecastja;
- usage run-rate;
- token/model/agent alapú kiegészítő forecast;
- várható overage;
- `no_forecast` tételek;
- forecast coverage és confidence;
- budgethez viszonyított várható eltérés.

A három nézet vizuálisan és szemantikailag különüljön el.

Ne legyen automatikusan:

```text
forecast = MTD
```

Ha nincs érdemi forecast, jelenjen meg inkább:

- `Nincs megbízható forecast`;
- vagy `X HUF ismert fix költség + Y provider usage forecastja nem elérhető`.

## 3.2 Mindhárom nézet tételig bontható legyen

A Múlt, Jelen és Forecast kártyák mind legyenek kattinthatók.

Mindhárom ugyanazt a hierarchiát használja:

1. kategória;
2. provider;
3. termék / előfizetés / csomag;
4. cost source;
5. konkrét line item:
   - provider API usage;
   - billing export;
   - email invoice;
   - prepaid top-up;
   - manuális tétel;
   - lokális estimate;
   - overage;
   - plan comparison.

Példa:

```text
Forecast
  → AI / LLM
    → Anthropic
      → Claude Max
        → fix havi előfizetés
        → csomagban foglalt tokenhasználat
        → heti limit forecast
      → Anthropic API
        → MTD usage
        → run-rate forecast
        → model bontás
        → agent bontás
```

Kötelező reconciliation:

```text
headline total == sum(selected line items)
```

Ha nem egyezik, az acceptance hiba.

## 3.3 Időbeli összehasonlíthatóság

Egy provider vagy tétel részletében egymás mellett legyen látható:

- előző hónap actual;
- aktuális MTD;
- aktuális forecast;
- változás;
- változás oka;
- adatforrás;
- coverage;
- csomaghasználat előző hónapban és most.

A `partial` hónap soha ne tűnjön teljes hónapnak.

---

# 4. Valódi adatforrások

## 4.1 Provider inventory

Minden ténylegesen használt szolgáltatás külön source legyen.

Minimum vizsgálandó:

- Claude Max
- Claude Pro
- Anthropic API
- ChatGPT előfizetés
- OpenAI API
- DeepSeek API
- Google AI
- Render
- Google Workspace
- AWS
- GitHub
- Vercel
- Cloudflare
- PostHog
- Wispr Flow
- Twilio
- Barion
- domainek
- minden egyéb tényleges fizetős SaaS

Állapotok:

- `active_paid`
- `active_free`
- `not_used`
- `no_data`
- `pending_permission`

Az `other`, `monitoring`, `other SaaS` gyűjtősorokat bontsa fel, amennyire bizonyítható.

Nincs fake 0.

## 4.2 Forrásprioritás

Minden költséghez:

1. hivatalos provider API / billing / cost / balance;
2. email számla, receipt, order, payment notice;
3. manuális felvétel;
4. lokális estimate csak végső fallbackként.

Tételenként:

- `actual_source`;
- `source_freshness`;
- `source_confidence`;
- `last_updated`;
- `source_status`.

Felhasználói címkék:

- Providerből lekérdezve
- Email/számla alapján
- Manuálisan felvéve
- Helyi becslés
- Nincs adat
- Jogosultság szükséges

## 4.3 Provider API-k

Aktiválja a meglévő official read-only collectorokat, ahol a szolgáltatás aktív és a Vaultban megvan a megfelelő credential.

### DeepSeek

- total balance;
- topped-up balance;
- granted balance;
- available status;
- napi snapshot;
- burn-rate csak ismert top-up eseményekkel;
- egyébként balance actual, spend unknown.

### OpenAI

- official costs/usage;
- MTD cost;
- modell/project bontás, ha elérhető;
- currency és időbucket;
- hiányzó jogosultságnál `pending_permission`.

### Anthropic

- official Admin Usage/Cost API csak megfelelő admin credentialdel;
- Max/Pro tokenhasználat nem API-billed actual;
- hiányzó admin hozzáférésnél `pending_permission`.

### Render

- plan API advisory/comparison;
- actual elsősorban email invoice;
- build minutes és plan usage külön entitlement-adat.

### GitHub és egyéb

- csak aktív fizetős szolgáltatásra;
- csak hivatalos read-only endpointtal.

Nincs scraping és nincs private API.

## 4.4 Email-ingest és history backfill

Futtassa ténylegesen a Gmail read-only invoice sweepet legfeljebb 6 hónapra.

Minimum:

- Anthropic / Claude;
- OpenAI / ChatGPT;
- Render / Stripe;
- DeepSeek;
- Google Workspace / Google Play;
- domain registrar;
- AWS;
- tényleges SaaS-ok.

Tárolandó:

- provider;
- product/plan;
- invoice/payment date;
- charge period;
- original amount/currency;
- HUF érték;
- FX rate/date/source;
- status;
- actual_source;
- dedup hash.

Ha nincs összeg:

- lifecycle vagy warning adat lehet;
- költséget ne találjon ki.

History státusz:

- `complete`
- `partial`
- `no_data`

## 4.5 Manuális fallback UI

A manuális adat kezelhető legyen a dashboardból:

- új tétel;
- szerkesztés;
- archiválás;
- törlés megerősítéssel;
- provider;
- termék/csomag;
- kategória;
- egyszeri/ismétlődő;
- összeg;
- deviza;
- időszak;
- renewal;
- megjegyzés PII nélkül.

Automata actual érkezésekor a manual comparison/fallback legyen, ne duplázódjon.

---

# 5. Csomagban foglalt használat és entitlement-modell

Ez kötelező, elsőrangú CostOps-dimenzió.

Nem elég azt látni, hogy egy előfizetés havonta mennyibe kerül. Látszódjon az is, hogy ezért mit kapunk, mennyit használtunk el, és várható-e kifutás vagy többletdíj.

## 5.1 Entitlement adatséma

Additív modell:

```text
provider
product
plan_name
billing_period
entitlement_type
included_limit
included_unit
usage_to_date
remaining
usage_pct
reset_at
usage_source
usage_confidence
forecast_usage_period_end
forecast_exhaustion_at
overage_supported
overage_unit_price
forecast_overage_quantity
forecast_overage_cost
status
last_updated
```

Állapot:

- ok
- warning
- high
- critical
- exhausted
- blocked
- unknown
- pending_permission
- unlimited
- not_applicable

Ha a keret nem ismert:

- `unknown`;
- source = `manual`, `local_observed` vagy `pending_permission`.

## 5.2 Követendő csomaghasználatok

### AI és fejlesztői szolgáltatások

Claude Max / Pro:

- 5 órás/session ablak, ha megbízhatóan mérhető;
- heti usage;
- reset idő;
- lokálisan megfigyelt token/model/agent használat;
- limit forecast;
- nincs kamu hivatalos limit;
- cost = fix subscription;
- token opportunity-cost külön.

ChatGPT:

- előfizetési csomag;
- ismert message/model limit, ha megbízható forrásból mérhető;
- reset;
- `unknown`, ha nincs hozzáférhető adat;
- API usage ettől külön.

GitHub Copilot:

- csomagban foglalt usage/premium request, ha releváns és elérhető.

DeepSeek:

- prepaid balance;
- consumption;
- burn-rate;
- várható kifogyás.

OpenAI/Anthropic API:

- nem included package, hanem billed usage;
- model/token usage;
- MTD cost;
- forecast;
- provider/model/agent bontás.

### Hosting/cloud/SaaS

Render:

- build/pipeline minutes;
- compute plan;
- bandwidth/storage, ha csomaglimitált;
- usage%;
- remaining;
- reset;
- várható kifutás;
- overage vagy deploy-block kockázat.

GitHub:

- Actions minutes;
- storage;
- included vs overage.

Vercel:

- build minutes;
- bandwidth;
- function usage;
- included quota, ha fizetős.

Cloudflare:

- request, worker, storage vagy más csomaglimit, ha releváns.

PostHog:

- event/session/replay quota;
- included events;
- projected overage.

Google Workspace:

- seat count;
- storage;
- renewal/payment lifecycle.

Twilio:

- prepaid credit;
- message/usage;
- burn-rate.

Wispr Flow és egyéb SaaS:

- használati keret, seat vagy perc, ha a csomag tartalmaz ilyet.

Domain/SSL:

- nem entitlement usage;
- renewal/expiry külön lifecycle.

Csak ténylegesen használt szolgáltatást implementáljon.

## 5.3 Költségszemantika

Különítse el:

1. `fixed_subscription_cost`
2. `actual_billed_usage`
3. `actual_overage_cost`
4. `included_usage_no_incremental_cost`
5. `subscription_usage_equivalent`
6. `opportunity_cost`
7. `forecast_billed_cost`
8. `forecast_overage_cost`

A csomagban foglalt használat:

- ne növelje az operational spendet;
- csak akkor generáljon plusz költséget, ha valós overage-price és forecast van;
- a token/API-equivalent érték ne legyen számlázott költségnek látszó szám.

## 5.4 Múlt–jelen–forecast entitlement bontás

Minden csomagnál legyen:

### Múlt

- előző időszak tényleges usage;
- kifutott-e;
- volt-e overage;
- maradt-e kihasználatlan keret.

### Jelen

- usage MTD;
- remaining;
- usage%;
- reset idő;
- jelenlegi státusz.

### Forecast

- várható időszak végi usage;
- várható usage%;
- várható kifutás dátuma;
- várható overage;
- várható extra költség;
- forecast basis.

Ez is legyen kattintható:

```text
provider → csomag → entitlement → usage source
```

## 5.5 Alertküszöbök

Alapértelmezett:

- 70% warning;
- 80% alert;
- 90% high;
- 100% exhausted/critical/blocked.

Időalapú forecast-alert is kell:

- várhatóan a reset előtt elfogy;
- várható overage;
- várható deploy-block;
- várható prepaid kifogyás.

---

# 6. Forecast modell

## 6.1 Tételenkénti forecast

Minden költségsorhoz:

- actual MTD;
- forecast;
- forecast basis;
- forecast source;
- confidence;
- adatablak;
- rövid számítási magyarázat.

Típusok:

- provider forecast;
- provider usage run-rate;
- fixed subscription;
- email full-period invoice;
- prepaid burn-rate;
- token run-rate;
- manual forecast;
- `no_forecast`.

## 6.2 Teljes forecast összetétele

A headline forecast legyen bontható:

```text
Fix előfizetések
+ tényleges usage run-rate
+ várható overage
+ manuális forecast
+ ismert egyszeri költségek
= várható hó végi költés
```

Külön mutassa:

- covered forecast;
- uncovered/no_forecast providers;
- providerből származó forecast;
- saját extrapoláció;
- confidence.

## 6.3 Budget

Globális havi budget:

```text
200 000 HUF
```

Mutassa:

- MTD/budget;
- forecast/budget;
- várható eltérés;
- budget alert.

---

# 7. Token-, modell- és agentattribúció

## 7.1 Billed státusz

Minden tokenhasználat:

- `api_billed`
- `subscription_not_billed`
- `unknown`

Subscription usage:

- opportunity-cost;
- külön nézet;
- nem operational spend.

API-billed:

- csak hiteles provider/account/session hozzárendeléssel;
- dupla számolás nélkül.

## 7.2 Pricing és attribúció

- minden aktív modell legyen árazva;
- Opus, Sonnet és egyéb tényleges modellek;
- pricing source/date/version;
- cél: legalább 90% provider+model attribúció;
- történelmi unknown adatot ne találjon ki.

## 7.3 Drill-down

Provider → model → agent:

- input;
- output;
- cache read/write;
- actual usage;
- MTD cost vagy opportunity-cost;
- forecast;
- billed status;
- pricing coverage;
- csomagban foglalt vagy API-billed használat;
- limit/entitlement kapcsolat.

---

# 8. Dashboard UX

## 8.1 Főnézet

Felső kártyák:

1. Előző lezárt hónap
2. Aktuális MTD
3. Várható hó vége
4. Budget és adatminőség

Mind kattintható és tételig bontható.

Minden kártyán:

- összeg;
- `complete` / `partial` állapot;
- actual/API/email/manual/estimate arány;
- adatfrissesség;
- forecast coverage, ahol releváns.

## 8.2 Két fő kontrollblokk

### Költségek

- múlt;
- jelen;
- forecast;
- budget;
- havi trend;
- egységes cost table.

### Csomagok és felhasználási keretek

- csomag díja;
- included limit;
- usage;
- remaining;
- reset;
- expected exhaustion;
- overage forecast;
- status.

A kettő legyen összekapcsolva, de ne legyen összekeverve.

## 8.3 Egységes tételtábla

Minden sorban:

- provider;
- product/plan;
- category;
- previous actual;
- current MTD;
- forecast;
- forecast basis;
- actual source;
- original currency → HUF;
- included usage;
- remaining;
- reset;
- forecasted overage;
- freshness;
- warning/action.

Alapnézetben csak a fontos oszlopok.
Részletekben minden technikai adat.

## 8.4 Havi trend

3–6 hónap:

- actual;
- forecast, ha értelmes;
- budget;
- `complete` / `partial` / `no_data`;
- API/email/manual/estimate arány;
- entitlement usage;
- overage.

Hónapra kattintva tételbontás.

## 8.5 Szűrés

- hónap;
- múlt/jelen/forecast;
- kategória;
- provider;
- product/plan;
- API/email/manual/estimate;
- complete/partial/no_data;
- fixed/usage/overage;
- entitlement status.

## 8.6 Manual UI

A dashboardból lehessen manuális költséget és entitlementet kezelni.

Példa manuális entitlementre:

- Claude heti usage százalék;
- csomag limit;
- reset;
- source = manual/local_observed.

Mindig egyértelmű manuális címkével.

## 8.7 Empty state

Használandó:

- Nincs adat
- Nem használt
- Jogosultság szükséges
- Részleges hónap
- Nincs megbízható forecast
- Ismeretlen csomaglimit
- Manuális adat
- Utolsó frissítés X napja

Nincs fake 0, NaN, undefined vagy HUF HUF.

## 8.8 Warnings

Felül maximum 3–5 valóban releváns teendő.

A warningok ne uralják a főoldalt.

A teljes lista drill-downban legyen.

---

# 9. Automatikus működés

Egy napi hibaszigetelt CostOps sync:

1. provider cost/usage collectorok;
2. provider entitlement/quota collectorok;
3. email invoice ingest;
4. balance snapshotok;
5. history recompute;
6. cost forecast;
7. entitlement forecast;
8. warnings;
9. import-run státusz.

Egy provider hibája ne állítsa le a többit.

Minden provider/product esetén:

- last success;
- last failure;
- rows imported;
- freshness;
- current status.

---

# 10. Négy belső ellenőrzési kör

A körök között ne várjon külön GO-ra.

## 10.1 Adat és számítás

Ellenőrizze:

- provider inventory;
- API-k;
- email-ingest;
- backfill;
- actual selection;
- dedup;
- no-double-count;
- original currency;
- budget;
- MTD;
- forecast;
- entitlement usage;
- overage calculation.

## 10.2 Első használható dashboard

Ellenőrizze:

- múlt/jelen/forecast külön;
- mindhárom tételig bontható;
- headline = line-item sum;
- partial hónap nem teljesként látszik;
- cost és entitlement külön;
- csomaghasználat és maradék látszik;
- source és forecast basis egyértelmű;
- token opportunity-cost külön;
- manual UI működik.

## 10.3 Böngészős UX

Deliverylead/Muse userland Chromiumból valódi kattintásos tesztet és screenshot-reviewt végezzen.

User journey-k:

1. Megnézem az előző lezárt hónap összegét és tételeit.
2. Megnézem az aktuális MTD-t és tételeit.
3. Megnézem a forecastot és annak tételes alapját.
4. Megnézem egy provider múlt/jelen/forecast változását.
5. Megnézem, API/email/manual adatból jött-e.
6. Megnézem egy csomag felhasznált és megmaradt keretét.
7. Megnézem, várható-e limitkifutás vagy overage.
8. Felveszek vagy szerkesztek egy manuális költséget.
9. Megnézem, mely modellek és agentek fogyasztanak sokat.
10. Mobil vagy keskeny nézetben is végigcsinálom az alapfolyamatot.

A talált UX-hibákat ugyanebben a sprintben javítsa.

## 10.4 Független QA

Ellenőrizze:

- DB;
- API;
- frontend;
- browser;
- timer;
- backfill;
- history;
- forecast;
- entitlement;
- overage;
- budget;
- dedup;
- supersede;
- token-szemantika;
- rollback.

Ne done-kártya alapján zárjon.

---

# 11. CostOps v1.0 DONE-kritérium

A sprint csak akkor kész, ha:

1. Minden aktív fizetős provider külön source.
2. Minden providernél API/email/manual/no_data státusz.
3. Legalább egy hivatalos provider cost/balance API él, ahol hozzáférés van.
4. Legalább egy valós invoice automatikusan emailből importálódik.
5. A mailbox által engedett history-backfill megtörtént.
6. Legalább 3 hónapos havi nézet van complete/partial/no_data állapottal.
7. A múlt, jelen és forecast három külön érték.
8. Mindhárom tételig bontható.
9. A headline összegek egyeznek a line-item összegekkel.
10. Usage-providernél run-rate vagy explicit no_forecast.
11. A 200 000 HUF budget működik.
12. Nem-HUF tétel original currency + FX adata látszik.
13. Manuális költség UI-ból kezelhető.
14. Minden releváns előfizetés/csomag entitlementként megjelenik.
15. Included usage, remaining és reset látszik, ahol adat van.
16. Unknown limit nem jelenik meg nullaként.
17. Várható kifutás/overage forecast látszik, ahol számítható.
18. Included usage nem kerül operational spendbe.
19. Overage csak valós pricing alapján kerül forecastba.
20. Tokenadat provider/model/agent bontásban látszik.
21. Billed/not_billed/unknown egyértelmű.
22. Opportunity-cost nem keveredik actual költséggel.
23. Nincs dupla számolás.
24. Desktop és mobil browser acceptance zöld.
25. Build, teljes teszt és live smoke zöld.

A külső API-korlát miatt megmaradó manual/unknown provider nem blokkolja a v1.0-t, ha:

- egyértelműen jelölt;
- UI-ból kezelhető;
- nem hamisít actual vagy forecast számot;
- a coverage mutatóban látszik.

---

# 12. Guardrails

- nincs push;
- nincs PR;
- PR1 érintetlen;
- local product-first sprint;
- csak additív schema;
- nincs provider-side write;
- nincs DNS/domain/cert módosítás;
- nincs scraping/private API;
- nincs automatikus kulcslétrehozás;
- nincs raw PII/email body/invoice/secret tracked fájlban;
- meglévő idegen módosítások ne kerüljenek a commitba;
- külön worktree vagy path-scoped commit;
- rollback maradjon.

Az általánosan hasznos fejlesztéseket később külön upstream-javaslatként kell kezelni.

---

# 13. Végső riport

A végén add vissza:

- implementált funkciók;
- provider/product coverage matrix;
- működő API-k;
- pending permissionök;
- email sweep/import számok;
- history hónaponként;
- complete/partial/no_data;
- previous actual;
- current MTD;
- forecast;
- forecast basis bontás;
- három headline tételes reconciliationje;
- budget;
- API/email/manual/estimate arány;
- original currency példa;
- csomag/entitlement lista;
- included usage/remaining/reset;
- forecast exhaustion/overage;
- manual UI;
- token provider/model/agent bontás;
- billed/not_billed/unknown;
- screenshotok;
- browser user journey;
- build/test/live smoke;
- commitok;
- git status;
- rollback;
- nincs push/PR/provider-write/PII megerősítés.

---

# Másolható prompt Marveennek

```text
GO — CostOps v1.0 integrált véglegesítési sprint

A részletes source of truth és acceptance-spec itt van:

audits/costops-v1-integrated-finish-request.md

Kérlek ezt kövesd teljes egészében.

A fő elvek:

1. Egyetlen product-first sprint legyen, ne apró külön fázisok.
2. A múlt, jelen és forecast külön érték és mindhárom tételig bontható legyen.
3. A headline összegek egyezzenek a kiválasztott line-itemek összegével.
4. Provider API az elsődleges forrás, email a második, manual a harmadik, estimate csak végső fallback.
5. A csomagban foglalt használat, remaining, reset, várható kifutás és overage külön entitlement-dimenzió legyen.
6. Included usage ne kerüljön az operational spendbe.
7. Tokenadat provider/model/agent bontásban jelenjen meg billed/not_billed/unknown státusszal.
8. A Cost és Entitlement nézet legyen összekapcsolva, de ne legyen összekeverve.
9. A dashboard legyen 10 másodperc alatt érthető, desktopon és mobilon is.
10. A warningok ne helyettesítsék az alap-költségkontrollt.

Munkamód:

- haladj végig egyben;
- a négy belső ellenőrzési kör között ne várj külön GO-ra;
- a talált adat-, számítási és UX-hibákat ugyanebben a sprintben javítsd;
- csak credential/jogosultság, provider-side write, destruktív schema, bizonytalan billed-szemantika vagy PII/secret-kockázat esetén állj meg.

Guardrails:

- nincs push;
- nincs PR;
- PR1 érintetlen;
- local product-first;
- additív schema only;
- nincs provider-side write;
- nincs scraping/private API;
- nincs automatikus kulcslétrehozás;
- nincs raw PII/email body/invoice/secret tracked fájlban;
- meglévő idegen módosítások ne kerüljenek a commitba;
- rollback maradjon.

A sprintet csak a dokumentumban szereplő CostOps v1.0 DONE-kritériumok és a teljes végső riport után tekintsd késznek.
```
