# CostOps Command Center — fókuszált, egyfüles UI-specifikáció

**Cél:** a már teljes funkcionális scope-pal rendelkező CostOps korszerű, gyorsan áttekinthető és jól drill-downolható megjelenítése a Marveen dashboard egyetlen `Költségek` fülén.

**Kiindulás:** a CostOps backend, ledger, provider coverage, budget, alerts, invoice reconciliation, credits/refunds/corrections, monthly close, entitlement/subscription kezelés, optimalizációs ajánlások és export már elkészült.

**Nem cél:** új CostOps funkciók fejlesztése, új accounting logika, routing, agent/task/product költségbontás vagy teljes dashboard-framework migráció.

---

## 1. Végső UX-koncepció

A Marveen oldalsávjában továbbra is pontosan egy CostOps-menüpont marad:

```text
Marveen
├── Áttekintés
├── Kanban
├── ...
├── Költségek        ← egyetlen főmenüpont
├── ...
└── Beállítások
```

A `Költségek` fülön belül három belső nézet működik:

```text
KÖLTSÉGEK

[ Áttekintés ] [ Elemzés ] [ Havi zárás ]
```

A három nézet nem kerül külön a Marveen oldalsávjába.

A részletes információk nem külön főoldalakon, hanem egy univerzális jobb oldali panelben vagy mobilon bottom sheetben nyílnak meg.

```text
Költségek
├── Áttekintés
├── Elemzés
├── Havi zárás
└── Részletpanel
    ├── source
    ├── invoice
    ├── ledger-sor
    ├── alert
    ├── ajánlás
    └── audit history
```

---

## 2. Fő tervezési elvek

### 2.1 Egy képernyő egy elsődleges kérdésre válaszoljon

- Áttekintés: **Mi történik, és kell-e valamire figyelnem?**
- Elemzés: **Mi okozza a költséget?**
- Havi zárás: **Mi hiányzik a biztonságos lezáráshoz?**

### 2.2 Progressive disclosure

A háttérben minden CostOps-funkció elérhető, de az első képernyőn csak a legfontosabb információk jelenjenek meg.

### 2.3 Operational spend az alapértelmezett

Az alapnézet mindig a ténylegesen kifizetett vagy fizetendő operational spend.

A következők secondary detailben maradnak:

- opportunity cost;
- entitlement utilization;
- unused subscription value.

Ezek funkcionálisan fontosak, de nem versenyezhetnek az elsődleges költségszámokkal.

### 2.4 Nincs BI-builder

Nem szükséges:

- szabadon konfigurálható dashboard;
- chart-típus választó;
- tetszőleges többdimenziós group-by;
- Power BI-szerű szerkesztő;
- korlátlan cross-filtering.

A CostOps előre meghatározott, jól használható nézeteket ad.

### 2.5 Nincs új frontend-framework csak a CostOps miatt

A megoldás illeszkedjen a meglévő Marveen dashboardhoz.

A CostOps kerüljön külön modulokba, de ne induljon teljes React/Vue/Svelte migráció.

---

# 3. Belső navigáció

## 3.1 Desktop

```text
┌──────────────────────────────────────────────────────────────┐
│ Költségek                                      2026. július ▾│
│                                                              │
│ [ Áttekintés ] [ Elemzés ] [ Havi zárás ]                   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                   AKTUÁLIS BELSŐ NÉZET                       │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## 3.2 Mobil

```text
[ Áttekintés ] [ Elemzés ] [ Zárás ]
```

A belső nézetváltó vízszintesen görgethető segmented control lehet.

## 3.3 URL-állapot

Javasolt route-ok:

```text
#costs/overview
#costs/analyze
#costs/close
```

Szűrt elemzés:

```text
#costs/analyze?month=2026-07&group=provider&provider=anthropic
```

Követelmény:

- újratöltés után a nézet maradjon meg;
- a böngésző vissza gombja működjön;
- a nézet megosztható legyen;
- az URL ne tartalmazzon secretet vagy érzékeny accountazonosítót.

---

# 4. Áttekintés nézet

Az Áttekintés legyen az alapértelmezett CostOps-oldal.

A cél nem minden funkció bemutatása, hanem az azonnali döntéstámogatás.

## 4.1 Elrendezés

```text
┌──────────────────────────────────────────────────────────────┐
│ KÖLTSÉGPOZÍCIÓ                                               │
│ MTD | Forecast | Budget | MoM eltérés | Confidence           │
├──────────────────────────────────────────────────────────────┤
│ KUMULÁLT KÖLTSÉGTREND                                        │
│ Actual | Forecast | Budget | Előző hónap                     │
├───────────────────────────────┬──────────────────────────────┤
│ FIGYELMET IGÉNYEL             │ TOP KÖLTSÉGFORRÁSOK          │
│ maximum 5 tétel               │ rendezett sáv/lista          │
├───────────────────────────────┴──────────────────────────────┤
│ ADATBIZALOM                                                   │
│ actual | manual | estimate | stale                           │
├──────────────────────────────────────────────────────────────┤
│ TOP 3 MEGTAKARÍTÁSI LEHETŐSÉG                               │
└──────────────────────────────────────────────────────────────┘
```

## 4.2 Költségpozíció

Egyetlen összefüggő hero-panel legyen, ne öt egyenrangú KPI-kártya.

```text
┌──────────────────────────────────────────────────────────────┐
│ JÚLIUSI KÖLTSÉGPOZÍCIÓ                                       │
│                                                              │
│ Aktuális költés       Hónap végi forecast                    │
│ 99 217 Ft             118 400 Ft                             │
│ +10 226 Ft MoM        59,2% a budgetből                      │
│                                                              │
│ Budget: 200 000 Ft                                          │
│ ███████████████░░░░░░░░░░░░░░                              │
│                                                              │
│ Forecast-kockázat: alacsony   Bizonyosság: magas             │
└──────────────────────────────────────────────────────────────┘
```

Mutassa:

- current MTD;
- month-end forecast;
- teljes havi budget;
- forecast/budget arány;
- előző hónaphoz képesti eltérés;
- forecast confidence;
- period status: open/provisional/closed.

A Previous month ne külön KPI-kártya legyen, hanem összehasonlítási alap.

## 4.3 Kumulált költségtrend

Egyetlen fő grafikon:

- aktuális hónap kumulált actual;
- forecast folytatás;
- budget-vonal;
- előző hónap azonos napi pályája.

```text
200k ───────────────────────────────── Budget

150k                              ··· Forecast
                              ···
100k                     ●────
                    ●────
 50k          ●────
         ●────
  0  1. hét   2. hét   3. hét   Ma   Hónap vége
```

Tooltip:

- actual amount;
- forecast amount;
- forecast method;
- snapshot time;
- confidence;
- előző havi összehasonlítás.

Nem szükséges:

- chart-típus választó;
- tíznél több idősor;
- minden provider külön vonalként.

## 4.4 Figyelmet igényel

Maximum öt valódi teendő jelenjen meg.

Rangsorolás:

1. pénzügyi hatás;
2. sürgősség;
3. confidence;
4. szükséges emberi döntés.

Példa:

```text
FIGYELMET IGÉNYEL

Magas    Render invoice eltérés             8 200 Ft hatás
         Provider adat és számla nem egyezik
         [Megnyitás]

Közepes  Anthropic Max renewal 6 nap múlva   40 359 Ft/hó
         [Részletek]

Alacsony 2 manual tétel nincs igazolva        12 800 Ft
         [Ellenőrzés]
```

Ne jelenjen itt meg:

- tisztán technikai debug;
- olyan warning, amely nem igényel emberi lépést;
- egyszerre ötven alert.

## 4.5 Top költségforrások

Rendezett vízszintes sávdiagram vagy kompakt lista.

```text
KÖLTSÉGFORRÁSOK                          MTD       Forecast

Claude Max       █████████████████       40 359     40 359
Anthropic API    ███████                 17 655     22 300
DeepSeek API     ██████                  15 450     19 800
ChatGPT          ████                     8 990      8 990
Hosting          ██                       4 014      4 014
```

Minden sor:

- source neve;
- MTD;
- forecast;
- MoM változás;
- provenance badge;
- freshness;
- alert jelölés, ha van.

A sorra kattintás megnyitja a részletpanelt.

## 4.6 Adatbizalom

Egyetlen kompakt, 100%-os szegmentált sáv:

```text
ADATBIZALOM

Provider / invoice actual    68%
Manual actual                24%
Estimate                      8%
Stale                         0%
```

Kattintásra az Elemzés nézet nyíljon meg a megfelelő szűréssel.

Nem kell külön nagy Data Quality dashboard.

## 4.7 Top 3 megtakarítási lehetőség

Csak a három legnagyobb, bizonyított lehetőség jelenjen meg.

```text
MEGTAKARÍTÁSI LEHETŐSÉGEK            14 600 Ft/hó

Unused storage                         3 900 Ft/hó
Annual billing lehetőség               4 200 Ft/hó
Alulhasznált subscription              6 500 Ft/hó
```

Minden ajánlás:

- becsült havi megtakarítás;
- confidence;
- kockázat;
- részletek link.

Nem szükséges külön recommendation dashboard az első verzióban.

---

# 5. Elemzés nézet

Az Elemzés szándékosan korlátozott, előre definiált költségelemző.

## 5.1 Alapszerkezet

```text
[ Időszak ] [ Bontás ] [ Összehasonlítás ]

┌──────────────────────────────────────────────────────────────┐
│                         GRAFIKON                             │
├──────────────────────────────────────────────────────────────┤
│                     RÉSZLETES TÁBLA                         │
└──────────────────────────────────────────────────────────────┘

Kiválasztás esetén:
┌────────────────────────────────────────┬─────────────────────┐
│ Elemzés / tábla                        │ Részletpanel        │
└────────────────────────────────────────┴─────────────────────┘
```

## 5.2 Kötelező vezérlők

Pontosan három elsődleges vezérlő:

1. Időszak
2. Bontás
3. Összehasonlítás

### Időszak

- aktuális hónap;
- előző hónap;
- utolsó 3 hónap;
- utolsó 6 hónap;
- utolsó 12 hónap;
- lezárt hónapok.

### Bontás

- provider;
- source;
- költségkategória;
- szolgáltatástípus;
- provenance.

Szolgáltatástípus:

- subscription;
- API;
- hosting;
- SaaS;
- domain;
- email;
- storage;
- other.

### Összehasonlítás

- nincs;
- előző időszak;
- előző hónap;
- budget;
- forecast vs actual.

Nem szükséges első körben:

- tetszőleges második vagy harmadik group-by;
- chart-type választó;
- saját dashboard összeállítása;
- egyedi képletek.

## 5.3 Előre rögzített vizualizációk

| Kérdés | Megjelenítés |
|---|---|
| Időbeli alakulás | vonaldiagram |
| Provider/source összehasonlítás | vízszintes sáv |
| Kategória összetétel | stacked bar |
| Időszakos eltérés | variance/waterfall |
| Forecast vs actual | kétvonalas trend |
| Adatbizalom | 100%-os szegmentált sáv |
| Budgethelyzet | progress/bullet jellegű sáv |

A CostOps válassza ki a megfelelő grafikont.

A felhasználó ne válasszon chart-típust.

## 5.4 Cross-filtering

Csak a következő szükséges:

- grafikon elemre kattintás szűri a táblát;
- aktív szűrők chipként látszanak;
- chip egy kattintással törölhető;
- táblázatsor megnyitja a részletpanelt;
- „Minden szűrő törlése” gomb.

Példa:

```text
2026. július ×   Anthropic ×   API ×   Actual only ×
```

Nem szükséges:

- minden chart minden más chartot szűrjön;
- többszintű selection model;
- dashboard-szerkesztő.

## 5.5 Részletes költségtábla

Alaposzlopok:

- source;
- provider;
- category;
- operational cost;
- forecast;
- variance;
- original currency;
- provenance;
- freshness;
- reconciliation status.

Támogatandó:

- rendezés;
- egyszerű lapozás vagy virtualizáció;
- oszlopok ki-/bekapcsolása;
- export;
- sor megnyitása;
- aggregált total.

Nem szükséges:

- Excel-szerű cellaszerkesztés;
- komplex pivot builder;
- drag-and-drop oszlopcsoportosítás.

---

# 6. Univerzális részletpanel

Egyetlen általános drawer-komponens kezelje a részleteket.

Desktop:

```text
┌───────────────────────────────────────┬────────────────────────┐
│ Fő nézet                              │ Részletpanel           │
│                                       │                        │
└───────────────────────────────────────┴────────────────────────┘
```

Mobilon bottom sheet vagy teljes képernyős panel.

## 6.1 Kötelező tartalom

A kiválasztott entitástól függően:

- név;
- típus;
- operational cost;
- forecast;
- original amount/currency;
- provenance;
- confidence;
- freshness;
- invoice/import reference;
- reconciliation;
- kapcsolódó alert;
- kapcsolódó ajánlás;
- audit history.

## 6.2 Source-példa

```text
CLAUDE MAX

Állapot                  Active
Típus                     Subscription
Havi költség              40 359 Ft
Eredeti összeg            114,30 EUR
Forecast                  40 359 Ft

ADATBIZALOM
Provenance                Manual actual
Freshness                 1 nap
Confidence                Medium
Reconciliation            Not applicable

ELŐFIZETÉS
Renewal                   2026. augusztus 2.
Billing cadence           Monthly
Utilization               87%

KAPCSOLÓDÓ
1 ledger row
1 invoice reference
0 nyitott alert
1 ajánlás
```

## 6.3 Audit history

Egyszerű idővonal:

```text
Júl. 14.  Invoice importálva
Júl. 14.  Provider actual kiválasztva
Júl. 15.  Manual estimate superseded
Júl. 15.  Reconciliation completed
```

Nem szükséges külön drawer minden entitástípushoz.

---

# 7. Havi zárás nézet

A zárás egy egyszerű, lineáris workflow legyen.

## 7.1 Szerkezet

```text
2026. JÚLIUS                         PROVISIONAL

Close readiness: 92%

1. Readiness checklist
2. Reconciliation
3. Nyitott eltérések és estimate-ek
4. Zárási összefoglaló
5. Close + export
```

## 7.2 Readiness checklist

Négy csoport:

### Adatlefedettség

- minden aktív source jelentett;
- minden várt invoice beérkezett;
- nincs unknown source;
- freshness követelmények teljesültek.

### Accounting

- reconciliation kész;
- nincs duplikált invoice;
- credits/refunds feldolgozva;
- FX-adatok rögzítve;
- manual tételek igazolva.

### Kontroll

- nincs unresolved high alert;
- budget variance megmagyarázva;
- estimate-ek elfogadva vagy kiváltva;
- korrekciók jóváhagyva.

### Output

- snapshot generálható;
- riport generálható;
- export elkészíthető;
- actor és close note megadható.

## 7.3 Reconciliation tábla

```text
SOURCE            LEDGER      INVOICE     PROVIDER     DELTA     STATUS

Claude Max        40 359      40 359      —              0       Egyezik
Render             4 014       4 014       4 014          0       Egyezik
GitHub             8 200       8 150       8 200         50       Vizsgálandó
DeepSeek          15 450      —           15 450          0       Provider actual
```

Sor megnyitásakor a részletpanel mutassa:

- eltérés oka;
- forrásdokumentum;
- korrekciók;
- audit;
- szükséges jóváhagyás.

## 7.4 Zárási összefoglaló

```text
JÚLIUSI ZÁRÁSI ÖSSZEFOGLALÓ

Operational spend        118 400 Ft
Budget variance          -81 600 Ft
MoM változás             +18,2%
Actual data              94%
Manual actual             6%
Estimate                  0%
Credits/refunds          -1 200 Ft
Nyitott eltérés               50 Ft
Megtakarítási potenciál   9 800 Ft/hó
```

A lezárás után immutable snapshotként jelenjen meg.

## 7.5 Close művelet

Close előtt:

- readiness státusz;
- blokkoló tételek;
- nem blokkoló figyelmeztetések;
- actor;
- megjegyzés;
- létrejövő snapshot és export rövid magyarázata.

Nem szükséges komplex többoldalas wizard.

---

# 8. Alert- és recommendation-kezelés

## 8.1 Alert

Nem szükséges teljes incident management rendszer.

Elégséges státuszok:

- open;
- acknowledged;
- resolved.

Minden alert:

- severity;
- evidence;
- pénzügyi hatás;
- first seen;
- last seen;
- kapcsolódó source;
- megnyitás a részletpanelben.

## 8.2 Recommendation

Elégséges státuszok:

- open;
- accepted;
- rejected;
- implemented.

Minden ajánlás:

- jelenlegi költség;
- becsült havi és éves megtakarítás;
- evidence;
- confidence;
- kockázat;
- szükséges emberi döntés;
- rollback lehetőség.

A UI sem alertnél, sem recommendationnél nem hajt végre provider-side változtatást.

---

# 9. Mobil scope

Mobilon elsődleges:

- költségpozíció;
- trend;
- figyelmet igényel;
- top source-ok;
- top ajánlások;
- data trust;
- close readiness;
- egyszerű acknowledgement vagy jóváhagyás.

Mobilon nem elsődleges:

- mély ledger-elemzés;
- összetett korrekció;
- többoszlopos reconciliation szerkesztés;
- teljes exportkonfiguráció.

A táblák mobilon sorlistává alakuljanak.

A részletpanel bottom sheetként vagy teljes képernyős nézetként működjön.

---

# 10. Vizuális stílus

## 10.1 Követelmények

- illeszkedjen a meglévő Marveen design tokenekhez;
- neutrális háttér;
- kevés kártyakeret;
- tabular numerals;
- pénzösszegek jobbra igazítva;
- light és dark mód;
- accessibility;
- billentyűzetes navigáció;
- kompakt, de olvasható táblák;
- minimális animáció.

## 10.2 Színhasználat

- piros: valódi hiba vagy túllépés;
- borostyán: emberi figyelmet igénylő helyzet;
- zöld: reconciled, closed vagy verified;
- manual/estimate: semleges badge, nem hibaszín;
- opportunity cost: külön, másodlagos információs stílus.

## 10.3 Kerülendő

- nagy gauge-ok;
- 3D chart;
- túl sok donut chart;
- minden provider külön színnel;
- túl sok KPI-kártya;
- technikai debug az első képernyőn;
- minden funkció azonos vizuális súllyal.

---

# 11. Technikai megvalósítási keret

## 11.1 Marveen-integráció

A globális Marveen navigáció számára a CostOps továbbra is egyetlen page:

```text
data-page="costs"
```

A CostOps saját modulja kezeli:

- belső view state;
- URL-szinkron;
- filter state;
- lazy loading;
- chart;
- table;
- drawer;
- close workflow.

## 11.2 Javasolt modulstruktúra

```text
web/
├── app.js
├── index.html
├── style.css
└── costops/
    ├── costops.js
    ├── costops-state.js
    ├── costops-overview.js
    ├── costops-analysis.js
    ├── costops-close.js
    ├── costops-drawer.js
    ├── costops-charts.js
    └── costops.css
```

A pontos struktúrát a meglévő repository-konvenciókhoz kell igazítani.

Nem kötelező külön buildrendszer vagy framework.

## 11.3 Széles munkaterület

A CostOps Elemzés és Havi zárás nézet szélesebb munkaterületet igényelhet.

Javaslat:

- CostOps-specifikus `costs-active` vagy általános `wide-workspace` main class;
- Áttekintés: max. 1400–1500 px;
- Elemzés: max. 1600 px vagy rendelkezésre álló szélesség;
- Havi zárás: max. 1500–1600 px.

## 11.4 Lazy loading

### Áttekintés megnyitásakor

Csak:

- summary;
- trend;
- attention items;
- top sources;
- data trust;
- top recommendations.

### Elemzés megnyitásakor

- aggregált analysis;
- ledger;
- comparison data.

### Havi zárás megnyitásakor

- readiness;
- reconciliation;
- open corrections;
- snapshot preview.

### Drawer megnyitásakor

- konkrét source/invoice/alert/recommendation/audit adatok.

Nem szabad minden CostOps-adatot egyszerre lekérni és renderelni.

---

# 12. Kötelező acceptance criteria

## 12.1 Navigáció

1. Egyetlen `Költségek` menüpont marad.
2. Három belső nézet működik:
   - Áttekintés;
   - Elemzés;
   - Havi zárás.
3. A belső nézet URL-ben megmarad.
4. A böngésző vissza/előre működik.
5. Mobilon a belső navigáció használható.

## 12.2 Áttekintés

1. Az első képernyő öt fő blokkot mutat:
   - költségpozíció;
   - trend;
   - figyelmet igényel;
   - top source-ok;
   - adatbizalom.
2. Legfeljebb három megtakarítási ajánlás jelenik meg.
3. Operational spend az alapértelmezett.
4. Opportunity cost nem keveredik a headline összegekbe.
5. Legfeljebb öt figyelmet igénylő tétel jelenik meg.

## 12.3 Elemzés

1. Pontosan három fő vezérlő:
   - időszak;
   - bontás;
   - összehasonlítás.
2. Egy fő grafikon és egy részletes tábla.
3. A grafikon szűri a táblát.
4. A táblázatsor megnyitja a részletpanelt.
5. Az aktív szűrők chipként látszanak.
6. Export működik.
7. Nem kerül be BI-builder vagy chart-type selector.

## 12.4 Részletpanel

1. Egy univerzális panel kezeli a source, invoice, ledger, alert és recommendation részleteket.
2. Mutatja a provenance, freshness és reconciliation adatokat.
3. Mutatja az audit historyt.
4. Mobilon bottom sheet vagy teljes képernyős nézet.
5. Nem történik provider-side write.

## 12.5 Havi zárás

1. Readiness checklist működik.
2. Reconciliation tábla működik.
3. Nyitott eltérések és estimate-ek látszanak.
4. Zárási összefoglaló generálódik.
5. Close előtt a blokkolók egyértelműek.
6. Close után immutable snapshot megjelenik.
7. Reopen és correction auditálható.
8. Export elérhető.

## 12.6 Reszponzivitás és minőség

1. Desktopon, laptopon és mobilon használható.
2. Nincs vízszintes oldaloverflow.
3. Light/dark mód működik.
4. Billentyűzetes navigáció működik.
5. Pénzösszegek tabular numerals formában jelennek meg.
6. Loading, empty, partial, stale és error state-ek külön kezeltek.
7. A dashboard elsődleges nézete nem válik túlzsúfolttá.
8. Browser smoke és regressziós tesztek zöldek.

---

# 13. Kifejezetten out of scope

A UI-fejlesztés nem tartalmazza:

- új CostOps backend funkciók építését;
- új provider collectort;
- új accounting modellt;
- agentenkénti költségbontást;
- task/card költségbontást;
- product/project költségbontást;
- routingot;
- #517 implementációt;
- automatikus provider- vagy modellváltást;
- automatikus top-upot;
- provider-oldali subscription módosítást;
- teljes Marveen frontend-framework migrációt;
- szabad dashboard-buildert;
- tetszőleges pivot/BI-rendszert;
- külön főmenüpontot minden CostOps-funkciónak;
- teljes mobilos accounting szerkesztést;
- komplex alert management platformot;
- komplex recommendation management platformot.

---

# 14. Javasolt fejlesztési fázisok

## Phase UI-0 — Audit és terv

- jelenlegi CostOps UI és API audit;
- meglévő backend capability mapping;
- pontos component és endpoint contract;
- responsive wireframe;
- migration/rollback terv;
- implementációs kártyák.

Ebben a fázisban még nincs UI-implementáció.

## Phase UI-1 — Shell és Áttekintés

- CostOps moduláris shell;
- belső routing;
- wide-workspace kezelés;
- költségpozíció;
- trend;
- attention list;
- top sources;
- data trust;
- top recommendations.

## Phase UI-2 — Elemzés és részletpanel

- három fő szűrő;
- előre definiált chartok;
- részletes tábla;
- filter chip;
- univerzális drawer;
- export.

## Phase UI-3 — Havi zárás

- readiness checklist;
- reconciliation;
- open differences;
- close summary;
- close/reopen UI;
- snapshot és export.

## Phase UI-4 — Mobil, accessibility és stabilizáció

- mobil layout;
- bottom sheet;
- keyboard navigation;
- light/dark ellenőrzés;
- browser smoke;
- performance;
- regression;
- dokumentáció.

---

# 15. Fejlesztési becslés

A teljes CostOps backend funkcionális scope elkészültnek tekintendő.

A fókuszált, egyfüles UI becsült mérete:

| Terület | Becsült munka |
|---|---:|
| Audit, UX és technikai terv | 2–3 nap |
| Moduláris shell és belső routing | 2–3 nap |
| Áttekintés | 3–4 nap |
| Elemzés, tábla és drawer | 4–6 nap |
| Havi zárás | 3–4 nap |
| Mobil, accessibility és QA | 3–5 nap |

**Összesen: körülbelül 17–25 fejlesztői nap.**

A becslés nem tartalmaz új backend vagy API-fejlesztést.

---

# 16. Marveennek adandó végrehajtási instrukció

## Első lépés: csak audit és implementációs terv

```text
GO — CostOps fókuszált egyfüles Command Center: UI audit és implementációs terv

Kiindulás:
A CostOps teljes funkcionális backend scope-ja elkészült. Most kizárólag a
meglévő funkciók korszerű, fókuszált és drill-downolható megjelenítését tervezzük
meg a Marveen dashboard egyetlen Költségek fülén.

Kanonikus UI-scope:
Használd a „CostOps Command Center — fókuszált, egyfüles UI-specifikáció”
dokumentumot source of truthként.

Kötelező végállapot:

Költségek
├── Áttekintés
├── Elemzés
└── Havi zárás

+ egy univerzális jobb oldali részletpanel
+ belső URL-routing
+ lazy loading
+ reszponzív mobilnézet

Ebben a lépésben még NE implementálj.

Feladat:

1. Auditáld a jelenlegi CostOps UI-t, API-kat és teljes funkcionális backend scope-ot.
2. Készíts capability → UI mappinget:
   - mely meglévő endpoint/adat szolgálja az Áttekintést;
   - mely szolgálja az Elemzést;
   - mely szolgálja a Havi zárást;
   - mely szolgálja a részletpanelt.
3. Jelöld:
   - közvetlenül felhasználható;
   - adaptert igényel;
   - aggregációt igényel;
   - hiányzó API-contract, de meglévő backend adatból előállítható.
4. Ellenőrizd, hogy a három nézet egyetlen `data-page="costs"` oldalon,
   belső routinggal megvalósítható-e.
5. Készíts pontos file/component tervet a repository konvencióihoz igazítva.
6. Készíts desktop, laptop és mobil ASCII-wireframe-et.
7. Készíts endpoint és state contractot.
8. Készíts performance/lazy-loading tervet.
9. Készíts rollback tervet a jelenlegi CostOps v1.0.1 nézethez.
10. Bontsd a munkát UI-1–UI-4 implementációs fázisokra és kártyákra.

Guardrails:

- nincs új CostOps backend funkció;
- nincs routing;
- nincs agent/task/product költségattribúció;
- nincs frontend-framework migráció;
- nincs szabad BI-builder;
- nincs külön Marveen sidebar menüpont a belső CostOps funkcióknak;
- nincs provider-side write;
- nincs push vagy PR;
- a helyi deployment frissíthetősége elsődleges;
- generikus navigációs vagy UI-shell fejlesztést külön upstream-jelöltként jelölj,
  de még ne upstreameld.

Add vissza:

- AS-IS UI és API audit;
- capability → UI mapping;
- egyfüles megvalósíthatósági verdict;
- javasolt file/component struktúra;
- desktop/laptop/mobil wireframe;
- belső routing contract;
- endpoint contract;
- lazy-loading terv;
- rollback terv;
- UI-1–UI-4 kártyák és sorrend;
- kockázatok;
- Istvántól szükséges döntések;
- git status;
- megerősítés, hogy nem történt implementáció, push vagy PR.
```

---

# 17. Végső scope-verdikt

A fókuszált UI akkor megfelelő, ha:

- egyetlen Marveen-fülön marad;
- három belső nézetet használ;
- az első képernyő csak a döntéshez szükséges információkat mutatja;
- a teljes CostOps funkcionalitás drill-downban elérhető;
- nincs külön menüpont minden funkcióhoz;
- nincs BI-platform;
- nincs teljes frontend-migráció;
- mobilon az ellenőrzés és jóváhagyás kényelmes;
- a mély accounting munka desktop-first maradhat;
- a helyi deployment frissíthető marad;
- a jelenlegi CostOps nézetre egyértelmű rollback marad.
