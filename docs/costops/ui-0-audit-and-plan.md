# CostOps Command Center — Phase UI-0: audit és implementációs terv

**Készítette:** architect (Atlas) | **Dátum:** 2026-07-15 | **Forrás:** `docs/costops/command-center-ui-spec-v1.0.md` (§16 szerinti feladat)

**Fázis:** UI-0 — audit és terv. Ebben a fázisban NEM történt implementáció, push vagy PR (lásd 13. szakasz).

---

## 1. AS-IS UI és API audit

### 1.1 Jelenlegi frontend állapot — két külön nézet, egy dead-code csapda

A `web/app.js`-ben **két** CostOps nézet él egymás mellett:

| Nézet | `data-page` | Függvény | Sorok | Státusz |
|---|---|---|---|---|
| Legacy v1 | `costs` | `loadCosts()` | ~8865 **és** ~11711 (lásd alább) | elavult, csak rollback-link célpont |
| v1.0.1 (jelenlegi production) | `costs-v2` | `loadCostsV2()` | ~12278-12855 | **ez a rollback-cél (9. szakasz)** |

**Fontos hiba, amit találtunk:** a `loadCosts()` függvény **kétszer van definiálva** — egyszer ~8865-nél (kicsi, ez a "hivatalos" legacy v1), egyszer ~11711-nél (jóval nagyobb, egészen a `cv2FilterProviders`-ig fut). Mivel mindkettő sima `function` deklaráció, a második csendben felülírja az elsőt — futásidőben a `data-page="costs"`-hoz ténylegesen a 11711-es verzió van kötve, nem a 8865-ös. Ez nem UI-0 hatókörébe tartozó hiba (nem CostOps-backend, nem a v1.0.1 nézet), de UI-1 indulásakor tisztázni kell, hogy a legacy `#costs` rollback-link ténylegesen melyik kódra mutat — **kártyázva UI-1 alá** (13. szakasz kártyalistája).

### 1.2 `loadCostsV2()` (v1.0.1) blokk-térkép

| Blokk | Tartalom | Endpoint(ek) | Kliens-oldali számítás |
|---|---|---|---|
| Topbar | hónap, freshness | `summary` | — |
| KPI-kártyák (5) | Előző hó / MTD-hero / Forecast / Budget / Data-Quality | `summary` (`operational_spend`, `budget.*`, `previous_month`, `month_over_month_delta`) | — |
| Forecast-basis + baseline-incomplete | minőségi jelzősor | `summary.all_sources` + `previous_month.by_provider` | igen (heurisztika, <50% lefedettségnél tompít) |
| Reconciliation-csík | headline vs. Σ sortételek | `summary` | igen (`lineSum` vs `operational_spend`) |
| Egységes költségtábla | minden forrás, rendezve | `summary.all_sources` + `prev.by_line_item` | join `provider|source_id` kulcson |
| Kategória-akkordeon (3 szint) | Kategória → Provider → Source | `summary.all_sources` | **igen — hardkódolt `CAT()` provider→kategória map, a backendnek nincs kategória-fogalma** |
| Teendők (warnings) | top-3 + összecsukott többi | `warnings` | dedup |
| Csomagok és keretek | entitlement tábla | `limits` + `subscriptions` | merge + súlyozott súlyosság-rendezés |
| Havi trend (bar chart) | 6 hónap | `period?months=6` | skálázás |
| Opportunity-cost drawer | unbilled token-equiv + unused entitlement % | `subscriptions` + `limits` | igen |
| Manual-entry form | kézi cost/entitlement | — (POST/PATCH/DELETE `/api/costs/manual*`) | — |
| Rollback-link | `#costs`-ra mutat | — | — |

**Kritikus, nem backend-mezőként létező kliens-logika** (ezt bármelyik UI-1..UI-3 komponensnek reprodukálnia kell, ha újraírjuk):

- `effSrc()` — a `confidence` és `actual_source` két különálló backend-mezőt egyetlen "effektív forrás" jelvénnyé olvasztja. Ez **pontosan** a memóriában rögzített `costops-confidence-vs-actual-source` megállapítás — a badge-eknek a `confidence`-t kell hitelesnek tekintenie, nem az `actual_source`-ot.
- `CAT()` — hardkódolt provider→kategória map. A backend `source_type` mezője **nem** ugyanaz, mint a spec 5.2 "költségkategória" bontása.
- `dqByBucket` — spend-súlyozott adatbizalom-százalék, kliens-oldali aggregáció `all_sources`-ból.
- `entSev`/`isStale` — 24 órás staleness-küszöb `fetched_at`/`last_sync`-ből, nincs ilyen backend-mező.
- `fcByBasis` — forecast-basis run-rate-arány (≥67%) aggregáció.
- `movers` (top-5 provider-delta) — kiszámolva, de **gyanúsan halott kód**: nincs HTML-ben felhasználva. UI-1 tervezéskor ellenőrizni kell, hogy ez szándékos-e vagy elfelejtett funkció.

### 1.3 CSS / service worker / routing megállapítások

- **`web/style.css`-ben nulla CostOps-specifikus szabály van.** A teljes v1.0.1 megjelenítés egy futásidőben, JS-ből injektált `<style id="cv2Style">` tag — semmi nincs a globális stíluslapban.
- Van két újrahasznosítható **generikus** minta, amit a v1.0.1 nem használt ki: `.overview-stat*` (KPI-kártya rács az Áttekintés oldalon) és `.badge*` (pill/chip készlet) — a v1.0.1 helyette saját `.cv2-card`/`.cv2-chip` variánst talált fel.
- Van egy pontos precedens **szélesebb workspace**-re: `main.kanban-active { max-width: none; }` — ez a minta közvetlenül átvehető a spec 11.3 `wide-workspace`/`costs-active` igényére.
- `.drawer` osztály **nem létezik** sehol — a jelenlegi összecsukható szekciók natív `<details>/<summary>`-t használnak, nincs modal/drawer komponens-előzmény.
- **Service worker (`web/sw.js`) semmit nem cache-el** — a fájl gyakorlatilag egy kill-switch (töröl minden létező cache-t, nincs `fetch` handler). A CostOps JSON endpointok (`summary`, `warnings`, `limits`, `subscriptions`, `period`) egyike sem küld `Cache-Control` fejlécet. **Ez tiszta lap — a lazy-loading tervnek nem kell semmilyen meglévő cache-réteggel megküzdenie.**
- **Nincs belső routing/state a costs-v2-ben.** Az egyetlen "állapot" egy DOM-lokális szűrő-toggle (`cv2FilterProviders`), ami CSS-osztályt kapcsol, nincs URL-ben vagy JS-változóban perzisztálva, minden újratöltéskor elvész. `location.hash`/`history.pushState` sehol nincs a CostOps kód közelében — csak az app-szintű generikus lap-router létezik (`switchPage(pageId)`).

### 1.4 Backend API-felület — teljes lista (`src/web/routes/costs.ts`)

| Endpoint | Metódus | Jelenleg hívja-e a frontend? |
|---|---|---|
| `/api/costs/summary` | GET | **igen** (v1.0.1 fő adatforrás) |
| `/api/costs/sync` | POST | igen (Render-gomb + napi cron) |
| `/api/costs/email-ingest` | POST | nem (agent-oldali Gmail sweep hívja) |
| `/api/costs/sources` | GET | nem |
| `/api/costs/source-inventory` | GET | **nem** |
| `/api/costs/reliability-snapshots` | GET/POST | **nem** (a POST-ot Marveen review-ja szerint a boot-time seam is hívja `startCostOpsBackgroundTasks()`-on át, nem csak ez az on-demand endpoint — lásd 11. szakasz) |
| `/api/costs/forecast-snapshots` | GET | **nem** |
| `/api/costs/reconciliation` | GET | **nem** |
| `/api/costs/period-close` (+`/close`, `/reopen`) | GET/POST | **nem — a teljes Havi zárás backend érintetlen** |
| `/api/costs/corrections` | GET/POST | nem |
| `/api/costs/alerts` (+`/acknowledge`, `/resolve`) | GET/POST | **nem** |
| `/api/costs/budgets` (+history) | GET/POST/PATCH/DELETE | **nem** (a v1.0.1 csak a `summary.budget`-en belüli EGY aktuális budgetet mutatja, a teljes többbudgetes `/budgets` listát nem) |
| `/api/costs/recommendations` (+accept/dismiss) | GET/POST | **nem** |
| `/api/costs/invoices` (+adjust/void/reconciliation) | GET/POST | **nem** |
| `/api/costs/period` | GET | igen |
| `/api/costs/subscriptions` | GET | igen |
| `/api/costs/limits` | GET | igen |
| `/api/costs/warnings` | GET | igen |
| `/api/costs/workspace-alerts` | POST | nem (agent-oldali sweep) |
| `/api/costs/export` (+`/export/*`) | GET | nem (nincs export UI a v1.0.1-ben, csak backend) |
| `/api/costs/manual`, `/api/costs/entitlements/manual` | POST/PATCH/DELETE | igen (kézi form) |

**Összegzés:** a backend API-felület kb. 60%-a **teljesen frontend-dark** — ez pontosan megerősíti a spec kiinduló állítását ("a CostOps backend elkészült, csak a megjelenítés hiányzik"), de a hiány mértéke nagyobb, mint amit az Elemzés/Havi zárás blokk-listája sejtetne: a Havi zárás nézetnek gyakorlatilag **semmilyen** meglévő UI-előzménye nincs.

---

## 2. Capability → UI mapping

Jelölés: 🟢 közvetlenül felhasználható | 🟡 adaptert igényel | 🟠 aggregációt igényel | 🔴 hiányzó API-contract, de meglévő adatból előállítható

### 2.1 Áttekintés

| UI-elem | Forrás | Jelölés | Megjegyzés |
|---|---|---|---|
| Költségpozíció hero | `GET /api/costs/summary` | 🟢 | `operational_spend`, `operational_forecast_month_end`, `budget.*`, `month_over_month_delta` közvetlenül megvannak |
| Kumulált költségtrend | `GET /api/costs/period?months=1` (aktuális hó, napi bontásban) | 🟠 | **a `/period` jelenleg havi granularitású pontokat ad (`MonthlyPeriod[]`), nem napi kumulált pályát egy hónapon belül.** A spec 4.3 "1. hét, 2. hét, 3. hét, Ma" napi/heti kumulált görbét kér — ez ma **nincs** ilyen bontásban a backendben. Ledger-sorokból (`ledger.ts`) származtatható lenne egy új napi-kumulált nézet, de ez **hiányzó API-contract** (🔴 lenne, ha az endpoint nem is derül a meglévő táblákból egyszerű SQL-aggregációval — itt igen, tehát 🔴, nem új backend-funkció, csak egy meglévő tábla új vetülete) |
| Figyelmet igényel (max 5) | `GET /api/costs/alerts` | 🟢 | endpoint + séma megvan, ÉS a store ténylegesen fel van töltve (lásd 11. szakasz — a capture-pipeline a boot-seamen keresztül fut, nem csak on-demand). Rangsoroláshoz (pénzügyi hatás → sürgősség → confidence) kliens-oldali sort kell az `evidence`/`severity` mezőkre — 🟡-hoz közeli 🟢, nem adathiány, csak rendezési logika |
| Top költségforrások | `summary.all_sources` rendezve spend szerint | 🟢 | maga a v1.0.1 már csinálja |
| Adatbizalom sáv | `summary.all_sources` + `confidence_breakdown` | 🟡 | a `confidence_breakdown` mező már **létezik** a summary válaszban (spend by confidence key) — ez **közvetlenül** leváltja a v1.0.1 kliens-oldali `dqByBucket` újraszámolását! (🟢-höz közeli 🟡, csak a meglévő mezőt kell használni ahelyett hogy újraszámolnánk) |
| Top 3 megtakarítási lehetőség | `GET /api/costs/recommendations` | 🟢 | endpoint + séma megvan, store feltöltve (lásd 11. szakasz). Jelenleg 1 nyitott ajánlás él élőben — ez valós adat, nem hiány; a UI a "top 3"-at ne 3 elemre paddelje, mutassa amennyi ténylegesen van |

### 2.2 Elemzés

| UI-elem | Forrás | Jelölés | Megjegyzés |
|---|---|---|---|
| Időszak-vezérlő (1/3/6/12 hó, lezárt hónapok) | `GET /api/costs/period?months=N` | 🟢 | a `monthsBack` paraméter már pontosan ezt csinálja (max 24) |
| Bontás: provider | `period.months[].provider_breakdown` | 🟢 | közvetlen |
| Bontás: source | `summary.all_sources` (csak aktuális hó) vagy `source-inventory` | 🟡 | többhavi source-szintű bontás **nincs** kész endpointként — a `/period` csak provider-szinten bont hónaponként. Egyhavi nézetnél 🟢, többhavi source-bontásnál 🔴 |
| Bontás: költségkategória | — | 🔴 | a backendnek **nincs** kategória-fogalma (csak `source_type`), a v1.0.1 kliens-oldali `CAT()` map-je ad ilyet. Meglévő adatból (source→provider mapping) előállítható egy statikus lookup-pal, de ez a lookup ma csak a frontend kódjában él, nincs API-contractja |
| Bontás: szolgáltatástípus | `source_type` mező (`all_sources`, `source-inventory`) | 🟢 | közvetlen |
| Bontás: provenance | `confidence` + `actual_source` | 🟡 | az `effSrc()` adapter-logika szükséges (lásd 1.2) — két mezőből kell egy koherens provenance-kategóriát képezni |
| Összehasonlítás: budget | `GET /api/costs/budgets` | 🟢 | jelenleg teljesen felhasználatlan endpoint, pontosan erre való |
| Összehasonlítás: forecast vs actual | `GET /api/costs/forecast-snapshots?month=` | 🟢 | felhasználatlan, de kész séma (`forecast_amount`, `actual_amount`, `forecast_error_percent`) |
| Részletes költségtábla | `summary.all_sources` + `source-inventory` (freshness/lifecycle) + `reconciliation` (status) | 🟠 | három endpoint kompozit join-ja szükséges egyetlen táblasorhoz (provenance, freshness, reconciliation status egyszerre) |
| Export | `GET /api/costs/export/*` (provider-summary, category-summary, reconciliation stb.) | 🟢 | kész, csak UI-gomb hiányzik |

### 2.3 Havi zárás

| UI-elem | Forrás | Jelölés | Megjegyzés |
|---|---|---|---|
| Readiness checklist | `GET /api/costs/period-close?month=` → `readiness.checks.*` | 🟢 | **a séma szó szerint megegyezik a spec 7.2 négy csoportjával** (adatlefedettség/accounting/kontroll/output négy `ok`+részletező almező) — ez a legjobb 1:1 egyezés a teljes auditban |
| Close readiness % | ugyanaz | 🟡 | a backend `ready: boolean` + részletes `checks`-et ad, a spec konkrét "92%" számot vár — a százalék kliens-oldali származtatás (teljesített/összes check aránya) |
| Reconciliation tábla | `GET /api/costs/reconciliation` vagy `GET /api/costs/invoices/reconciliation` | 🟢 | az invoice-os variáns **gazdagabb** (invoice gross/tax/discount/credit/refund/net is benne van) — ez legyen az elsődleges forrás, nem a puszta reconciliation |
| Zárási összefoglaló | `GET /api/costs/period-close?month=` → `snapshot` (ha van) vagy élő `summary`+`budgets` | 🟢 | zárás előtt élő adat, zárás után az immutable `snapshot` |
| Close / Reopen | `POST /api/costs/period-close/close` / `/reopen` | 🟢 | kész, `force` flag és `reason`/`actor` audit-mezőkkel |
| Export (záráshoz) | `GET /api/costs/export/monthly-snapshot` | 🟢 | kész |

### 2.4 Univerzális részletpanel (drawer)

| Entitástípus | Forrás | Jelölés | Megjegyzés |
|---|---|---|---|
| Source | `source-inventory` (lifecycle/freshness/owner) + `all_sources` (spend/forecast) | 🟠 | kompozit |
| Invoice | `GET /api/costs/invoices?source_id=` | 🟢 | közvetlen |
| Ledger-sor + audit | `GET /api/costs/corrections?chain=<lineId>` | 🟢 | ez ADJA az "audit history" idővonalat ledger-sorra |
| Alert | `GET /api/costs/alerts` (adott `dedup_key`) | 🟢 | |
| Ajánlás | `GET /api/costs/recommendations` (adott `dedup_key`) | 🟢 | |
| Budget audit history | `GET /api/costs/budgets/history?id=` | 🟢 | külön audit-trail, entitástípusonként más endpoint |
| Audit history (általános) | *nincs egységes endpoint* | 🔴 | **nincs egyetlen "audit history bármely entitásra" endpoint** — minden entitástípusnak saját audit-trailje van (corrections chain / budget history / period-close history). Ez nem hiányzó backend-funkció, csak a drawernek entitástípus szerint kell elágaznia, melyik audit-endpointot hívja |

**Összegzés:** a három fő nézet (Áttekintés/Elemzés/Havi zárás) és a drawer **túlnyomó többsége** 🟢/🟡 — igazi 🔴 hiányzó-contract csak kettő van: (a) napi/heti kumulált trend egy hónapon belül, (b) kliens-oldali kategória-map API-contractba emelése. Egyik sem új CostOps-funkció, mindkettő meglévő ledger-adat új vetülete — összhangban a guardrail-lal ("nincs új CostOps backend funkció").

---

## 3. Egyfüles megvalósíthatósági verdict

**Igen, megvalósítható egyetlen `data-page="costs"` oldalon, belső routinggal.** Indoklás:

- A backend minden nézethez (Áttekintés/Elemzés/Havi zárás) elegendő, jórészt kész adatot szolgáltat — nincs olyan nézet, ami külön oldalt vagy külön API-domain-t igényelne.
- A meglévő app-szintű router (`switchPage(pageId)` + `location.hash`) egyetlen `pageId`-t kezel jelenleg (`costs-v2`); a spec belső `#costs/overview` stílusú route-jai egy **al-router** kérdése a CostOps modulon belül, nem az app-szintű routeren — ez pontosan a spec 11.1 elvárása ("A CostOps saját modulja kezeli: belső view state; URL-szinkron").
- Nincs technikai akadálya annak, hogy a három nézet ugyanazon az oldalon, lazy-loaded modulokban éljen — a jelenlegi monolitikus `loadCostsV2()` maga is bizonyítja, hogy egy függvény simán kezel 5+ blokkot; a modul-bontás (4. szakasz) ezt csak tisztábbá teszi.
- Nincs architekturális vagy adatpipeline-kockázat, ami az "egyfüles" döntést befolyásolná — az alerts/recommendations store-ok élő adattal feltöltöttek (lásd 11. szakasz, javítva Marveen review-ja alapján), UI-1 az eredeti terv szerint közvetlenül ezekre köthet.

---

## 4. Fájl/komponens terv

A repo **nem használ bundlert vagy ES modulokat** — minden `<script src="...">` sima globális scope-ban fut (lásd `index.html`: `/lang/hu.js`, `/lang/en.js`, majd `/app.js`, ebben a sorrendben). A CostOps modul-bontás ehhez a konvencióhoz igazodik: **plain script tag-ek, nem `type="module"`**, egy közös `Costops` globális namespace-objektummal (elkerülve a jelenlegi `cv2*`-prefixes lapos globális függvény-szennyezést).

```text
web/
├── app.js                     (változatlan: csak a data-page="costs-v2" route hívja a Costops.mount()-ot)
├── index.html                 (5 új <script> tag a </body> előtt, /app.js UTÁN)
├── style.css                  (változatlan — a costops.css különálló marad, 11.2 szerint)
└── costops/
    ├── costops.css            (a jelenlegi cv2Style injektált CSS ide költözik + wide-workspace + drawer szabályok)
    ├── costops-state.js        (view-state: aktuális nézet, szűrők, URL-szinkron — Costops.State)
    ├── costops-shell.js        (Costops.mount(): tab-sáv, hónap-választó, lazy-load orchestráció, routing-elágazás)
    ├── costops-overview.js     (Áttekintés nézet: hero, trend, attention, top sources, data trust, top recs)
    ├── costops-analysis.js     (Elemzés nézet: 3 vezérlő, chart, tábla, filter chip-ek)
    ├── costops-close.js        (Havi zárás nézet: checklist, reconciliation, summary, close/reopen)
    ├── costops-drawer.js       (univerzális jobb oldali/bottom-sheet panel, entitástípus szerinti elágazással)
    ├── costops-charts.js       (megosztott chart-primitívek: vonaldiagram, vízszintes sáv, stacked bar, waterfall — natív Canvas/SVG, NINCS új chart-library)
    └── costops-api.js          (minden `/api/costs/*` fetch egy helyen, response-cache réteg a 8. szakasz lazy-loading tervéhez)
```

Ez 1:1 megfelel a spec 11.2 javasolt struktúrájának, egyetlen eltéréssel: külön `costops-api.js` a fetch-hívások és egyszerű in-memory cache összegyűjtésére, mert a jelenlegi kód endpoint-hívásokat közvetlenül a render-függvényekbe keveri — ez a szétválasztás teszi lehetővé a 8. szakasz lazy-loadingját anélkül, hogy minden view-modul újraírná a saját fetch-hibakezelését.

`index.html`-ben az 5 script tag sorrendje számít (state → api → charts → shell → view-modulok, vagy shell utolsóként ami már feltételezi hogy a többi be van töltve). A pontos betöltési sorrend UI-1 implementációs döntése, nem architekturális kérdés.

---

## 5. Wireframe-ek

### 5.1 Desktop (≥1400px, `costs-active` wide-workspace class)

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Költségek                                          2026. július ▾      │
│ [ Áttekintés ] [ Elemzés ] [ Havi zárás ]                              │
├────────────────────────────────────────────────────┬───────────────────┤
│ JÚLIUSI KÖLTSÉGPOZÍCIÓ                              │ RÉSZLETPANEL      │
│ Aktuális: 99 217 Ft   Forecast: 118 400 Ft          │ (csak ha nyitva,  │
│ Budget: ████████████░░░░  59,2%                     │ különben a fő     │
├──────────────────────────────────────────────────────┤ nézet a teljes   │
│ KUMULÁLT TREND (grafikon)                            │ szélességet       │
├───────────────────────────┬───────────────────────────┤ használja)       │
│ FIGYELMET IGÉNYEL (≤5)    │ TOP KÖLTSÉGFORRÁSOK       │                   │
├───────────────────────────┴───────────────────────────┤                   │
│ ADATBIZALOM  ████████████░░░░  68% / 24% / 8% / 0%    │                   │
├────────────────────────────────────────────────────────┤                   │
│ TOP 3 MEGTAKARÍTÁS                                     │                   │
└────────────────────────────────────────────────────────┴───────────────────┘
```

### 5.2 Laptop (1024-1399px)

Azonos szerkezet, de a Részletpanel **csak drawer-ként nyílik felül** (overlay, nem fix oszlop) — a fő tartalom nem szűkül a drawer miatt, ez a spec 6-os univerzális drawer alapviselkedése minden 1400px alatti szélességen.

```text
┌──────────────────────────────────────────────────┐
│ Költségek                        2026. július ▾ │
│ [ Áttekintés ] [ Elemzés ] [ Havi zárás ]        │
├────────────────────────────────────────────────────┤
│              (mint fent, teljes szélesség)         │
└──────────────────────────────────────────────────┘
                                    ┌─────────────────┐
                                    │ RÉSZLETPANEL    │ ← overlay drawer
                                    │ (átfedésben)    │
                                    └─────────────────┘
```

### 5.3 Mobil (<768px)

```text
┌───────────────────────────┐
│ Költségek        júl. ▾  │
│ [Átt.][Elemz.][Zárás]    │ ← vízszintesen görgethető segmented control
├───────────────────────────┤
│ JÚLIUSI KÖLTSÉGPOZÍCIÓ    │
│ 99 217 Ft → 118 400 Ft   │
│ ████████░░░  59,2%       │
├───────────────────────────┤
│ TREND (kompakt sparkline) │
├───────────────────────────┤
│ FIGYELMET IGÉNYEL         │
│ • Render eltérés  8 200  │
│ • Anthropic renewal      │
├───────────────────────────┤
│ TOP FORRÁSOK (sorlista)   │
├───────────────────────────┤
│ ADATBIZALOM (sáv)         │
├───────────────────────────┤
│ TOP MEGTAKARÍTÁS          │
└───────────────────────────┘
   (sor koppintásra teljes képernyős bottom sheet nyílik, nem oszlop)
```

Mobilon (spec 9. szakasz) az Elemzés/Havi zárás mélyebb funkciói (ledger-szerkesztés, többoszlopos reconciliation) desktop-first maradnak — mobilon csak megtekintés + egyszerű ack/close-approval.

---

## 6. Belső routing contract

```text
#costs/overview                                    (alapértelmezett, üres hash-nél is ez)
#costs/analyze?month=2026-07&period=6&group=provider&compare=budget&provider=anthropic&source_type=api
#costs/close?month=2026-07
#costs/overview?drawer=source:claude-max            (drawer állapot query-paraméterben, NEM külön hash-ágon,
#costs/analyze?...&drawer=alert:a1b2c3               hogy a fő nézet szűrői megmaradjanak drawer nyitás/zárás közben)
```

**Állapot-szerződés** (`Costops.State`):

```js
{
  view: 'overview' | 'analyze' | 'close',
  month: 'YYYY-MM',              // hiányzó = aktuális hónap
  analyze: {
    period: '1' | '3' | '6' | '12' | 'closed',
    group: 'provider' | 'source' | 'category' | 'source_type' | 'provenance',
    compare: 'none' | 'prev_period' | 'prev_month' | 'budget' | 'forecast_vs_actual',
    filters: { provider?, source_type?, confidence? }   // chip-ként megjelenő aktív szűrők
  },
  drawer: null | { type: 'source'|'invoice'|'ledger'|'alert'|'recommendation', id: string }
}
```

Követelmények (spec 3.3, mind teljesíthető a fenti szerződéssel):
- `popstate`-re a state-et vissza kell olvasni az URL-ből és re-render, nem csak a hash-változást figyelni előre.
- A drawer state külön query-param, hogy a "vissza" gomb először a drawert csukja be, csak utána lépjen ki a nézetből (natúr böngésző-történet viselkedés, ha a drawer nyitás egy `pushState`, nem `replaceState`).
- Az URL soha nem tartalmaz secretet vagy account-azonosítót — a fenti mezők mind CostOps-belső, nem-szenzitív azonosítók (source_id, dedup_key stb., amik amúgy is láthatók a UI-ban).

---

## 7. Endpoint contract (nézetenként)

### Áttekintés (`#costs/overview`)

| Hívás | Mikor |
|---|---|
| `GET /api/costs/summary?month=` | mount-kor azonnal |
| `GET /api/costs/alerts` | mount-kor azonnal (Figyelmet igényel, max 5, pénzügyi hatás szerint rendezve) |
| `GET /api/costs/period?months=6` | mount-kor azonnal (trend) |
| `GET /api/costs/recommendations?status=open` | mount-kor azonnal (jelenleg 1 nyitott elemet ad — valós adat, lásd 11. szakasz) |

### Elemzés (`#costs/analyze`)

| Hívás | Mikor |
|---|---|
| `GET /api/costs/period?months=<period>&month=` | nézet nyitásakor / vezérlő váltáskor |
| `GET /api/costs/source-inventory` | nézet nyitásakor (freshness/lifecycle oszlopokhoz) |
| `GET /api/costs/reconciliation?month=` | nézet nyitásakor (reconciliation status oszlophoz) |
| `GET /api/costs/budgets?month=` | csak ha `compare=budget` |
| `GET /api/costs/forecast-snapshots?month=` | csak ha `compare=forecast_vs_actual` |
| `GET /api/costs/export/<kind>?format=csv&month=` | export gombra kattintáskor |

### Havi zárás (`#costs/close`)

| Hívás | Mikor |
|---|---|
| `GET /api/costs/period-close?month=` | nézet nyitásakor (readiness + history + snapshot egyben) |
| `GET /api/costs/invoices/reconciliation?month=` | nézet nyitásakor |
| `POST /api/costs/period-close/close` | Close gombra |
| `POST /api/costs/period-close/reopen` | Reopen gombra |
| `GET /api/costs/export/monthly-snapshot?month=` | export gombra |

### Drawer (bármely nézetből)

| Entitás | Hívás |
|---|---|
| source | `GET /api/costs/source-inventory` (már betöltve az Elemzésből, cache-elve) + `summary.all_sources` szűrve |
| invoice | `GET /api/costs/invoices?source_id=` |
| ledger-sor | `GET /api/costs/corrections?chain=<lineId>` |
| alert | `GET /api/costs/alerts?status=all` (egy `dedup_key`-re szűrve) |
| ajánlás | `GET /api/costs/recommendations?status=all` (egy `dedup_key`-re szűrve) |

---

## 8. Lazy-loading / performance terv

A `costops-api.js` modul minden view-hoz **csak azt** tölti be, amit a spec 11.4 előír:

1. **Mount-kor** (bármelyik nézet): csak a shell (tab-sáv, hónap-választó) renderelődik szinkron, adat nélkül.
2. **Áttekintés aktiválásakor**: a 4 endpoint (`summary`, `warnings`, `period`, `recommendations`) **párhuzamosan** (`Promise.all`), egyszer, view-váltáskor cache-elve (nem tölt újra, ha vissza-oda váltunk ugyanazon a hónapon belül 60 mp-en belül — egyszerű in-memory TTL, nem service worker).
3. **Elemzés aktiválásakor**: csak akkor tölt `source-inventory`/`reconciliation`-t, ha még nincs cache-ben az adott hónapra; a `budgets`/`forecast-snapshots` **csak** akkor, ha a felhasználó ténylegesen az adott `compare` módot választja (nem előre).
4. **Havi zárás aktiválásakor**: `period-close` + `invoices/reconciliation`, semmi más.
5. **Drawer nyitásakor**: csak a kiválasztott entitás saját endpointja; a többi nézet adatai nem érintettek.
6. Nézetváltáskor a **korábban betöltött nézet DOM-ja elrejtve marad** (nem törölve), így oda-vissza váltás nem old ki felesleges re-fetchet — csak hónapváltás vagy explicit refresh üríti a cache-t.

Ez érdemben csökkenti a jelenlegi `loadCostsV2()` viselkedéséhez képest a kezdeti terhelést, ami **5 endpointot tölt be szinkron minden mountkor**, függetlenül attól, hogy a felhasználó melyik al-nézetet nézi meg ténylegesen (ma nincs is al-nézet, de az UI-1 utáni állapotban ez szignifikáns különbség lenne, ha nem vezetnénk be a lazy-loadingot).

---

## 9. Rollback terv

- A jelenlegi `data-page="costs-v2"` (`loadCostsV2()`) **változatlanul megmarad**, amíg UI-1..UI-4 el nem éri feature-paritást.
- Az új Command Center egy **harmadik** `data-page` érték alatt fejlesztendő (javaslat: `costs-cc` vagy közvetlenül a végleges `costs-v2` route felülírása egy feature-flaggel — Istvan-döntés, lásd 12. szakasz).
- A Marveen oldalsáv navigációja UI-1 alatt **továbbra is** a jelenlegi v1.0.1-re mutat; a váltás egy explicit, egysoros config-változtatás (`switchPage` cél-page módosítása), csak akkor, ha Istvan jóváhagyja a UI-2 (Elemzés) lezárását követően.
- A meglévő `#costs` (legacy v1, lásd 1.1-es dead-code lelet) linkje mindkét új és régi state alatt működőképes marad, nem érintjük UI-0..UI-4 alatt.
- Visszaállás bármikor: mivel a régi `loadCostsV2()` kódja nem törlődik, egyetlen commit-revert vagy a `switchPage` cél-page visszaállítása elég — nincs adatmigráció, mert egyik nézet sem ír semmit (a manual-entry formok kivételével, amik mindkét nézetben ugyanazt az endpointot hívják).

---

## 10. UI-1..UI-4 kártyák és sorrend

| # | Kártya | Fázis | Becslés | Blokkoló előfeltétel |
|---|---|---|---|---|
| 1 | CostOps moduláris shell + belső routing + wide-workspace | UI-1 | 2-3 nap | — |
| 2 | Áttekintés: hero + trend + top sources + data trust | UI-1 | 2-3 nap | #1 |
| 3 | Áttekintés: Figyelmet igényel + Top megtakarítás (`GET /api/costs/alerts` + `/recommendations`, ahogy eredetileg tervezve) | UI-1 | 1 nap | #2 |
| 4 | Legacy `loadCosts()` dead-code duplikáció tisztázása (1.1) | UI-1 | 0,5 nap | — (párhuzamosítható) |
| 5 | Elemzés: 3 vezérlő + egy chart + tábla | UI-2 | 2-3 nap | #1 |
| 6 | Elemzés: filter chip-ek + cross-filtering (chart→tábla) | UI-2 | 1-2 nap | #5 |
| 7 | Univerzális drawer (source/invoice/ledger/alert/recommendation + audit) | UI-2 | 2 nap | #1, részben #3 |
| 8 | Elemzés export gomb bekötése | UI-2 | 0,5 nap | #5 |
| 9 | Havi zárás: readiness checklist + reconciliation tábla | UI-3 | 2 nap | #1 |
| 10 | Havi zárás: összefoglaló + close/reopen workflow | UI-3 | 1-2 nap | #9 |
| 11 | Havi zárás: snapshot export | UI-3 | 0,5 nap | #10 |
| 12 | Mobil layout (segmented control, bottom sheet, sorlista-táblák) | UI-4 | 2 nap | #1-11 |
| 13 | Keyboard navigation + light/dark ellenőrzés | UI-4 | 1 nap | #1-11 |
| 14 | Browser smoke + regressziós tesztek | UI-4 | 1-2 nap | #1-13 |
| 15 | Dokumentáció frissítés | UI-4 | 0,5 nap | #14 |

Az összesített becslés (17-25 nap) a spec 15. szakaszával megegyezik; a fenti bontás csak kártyásítja, nem módosítja azt.

---

## 11. Kockázatok és Istvántól szükséges döntések

### 11.1 MEGJEGYZÉS — javítva Marveen review-ja alapján: a capture-pipeline valójában be van kötve

**Eredeti UI-0 draftban ez a szakasz tévesen CRITICAL/blokkolóként szerepelt** — Marveen review-ja (msg_id:14302) jelezte, hogy a keresésem nem volt teljes körű: a `captureReliabilitySnapshot()`/`POST /api/costs/reliability-snapshots` on-demand útvonalat találtam meg, de nem kerestem rá a boot-time seamre. Önállóan újraellenőriztem és megerősítem a javítást:

- `src/web.ts:381`: `const costOpsBackgroundInterval = webOnly ? undefined : startCostOpsBackgroundTasks()` — ez a szerver boot-jának része, nem opcionális/manuális lépés.
- `src/costops/reliability-observation.ts:99-101`: `startCostOpsBackgroundTasks()` azonnal meghívja `captureNowSafely()`-t, majd `setInterval`-lel 24 óránként (`SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000`).
- `captureNowSafely()` (60-89. sor) mind a négy capture-t lefuttatja egy körben: `captureForecastSnapshots`, `captureAlerts`, `captureRecommendations`, plusz a reliability-snapshot maga.
- Élő ellenőrzés (`store/claudeclaw.db`, 2026-07-15): `costops_alerts` = 22 sor (legfrissebb ~3.1 órás), `costops_recommendations` = 1 sor (~2.5 órás), `costops_reliability_snapshots` = 5 sor. A `GET /api/costs/alerts`/`GET /api/costs/recommendations` **ma valós adatot ad**, nem üres tömböt.

**Hatás a tervre:** nincs Istvan/Maestro-döntés szükséges. UI-1 kártya #3 az eredeti terv szerint közvetlenül `GET /api/costs/alerts` + `GET /api/costs/recommendations`-ra köthet (2.1/2.4/7. szakasz frissítve).

**Egy valódi, kisebb megjegyzés marad:** a frissítési ciklus 24 órás (boot + naponta) — ha egy magasabb súlyosságú alert 23 órát várna a következő capture-ig, ez UX-szempontból lassú lehet riasztásra. Ez **nem blokkoló**, csak egy jövőbeli finomítási javaslat (pl. gyakoribb capture-ciklus vagy esemény-triggerelt capture) — külön, kis kártyaként érdemes jelezni Mason/Anvil felé, nem UI-0/UI-1 hatókör. Hasonlóképp: a "Top 3 megtakarítás" blokk ma 1 elemet fog mutatni, mert ma 1 nyitott ajánlás van — ez valós állapot, a UI-nak nem szabad 3-ra paddelnie vagy hibaként kezelnie.

### 11.2 Napi/heti kumulált trend hiánya (spec 4.3)

A `/api/costs/period` havi granularitású; a spec explicit napi/heti kumulált görbét kér egy hónapon belül. Nem új CostOps-funkció (a ledger-adat megvan), de **ma nincs endpoint rá**. Kártyázva #2 alá tartozó al-feladatként, de ha a határidő szoros, a UI-1 hero-panel **mehet a havi trend nélkül is** (a spec 4.2 hero-panel maga nem igényli, csak a 4.3 külön trend-blokk).

### 11.3 Kategória-bontás (spec 5.2) csak kliens-oldali map

A `CAT()` map ma a frontendben él, hardkódolva. Ha új providert vagy sourcöt adnak hozzá a backendhez, ez a map **nem frissül automatikusan** — karbantartási kockázat, amit érdemes Istvannak jelezni, de nem UI-0 blokkoló.

### 11.4 Legacy `loadCosts()` dead-code duplikáció (1.1)

Nem biztonsági vagy funkcionális kockázat, de UI-1 előtt tisztázni kell, melyik verzió a "hivatalos" `#costs` rollback-cél, nehogy valaki a halott (8865-ös) függvényt módosítsa azt hívve, hogy az fut.

### 11.5 Generikus UI-shell munka elkülönítése

A wide-workspace (`main.kanban-active`-mintájú `costs-active` osztály) és a drawer-komponens **elviekben újrahasznosítható** más Marveen-oldalakon is (pl. Kanban is profitálhatna egy univerzális drawerből). A guardrail szerint ezt **nem** upstream-eljük most, de jelöljük külön upstream-jelöltként: *"generikus drawer-komponens és wide-workspace-osztály — jövőbeli, CostOps-on túli Marveen UI-shell fejlesztési kártya, NEM ebben a fázisban."*

---

## 12. Git status és megerősítés

```
$ git status --short
?? .claude-deepseek/
?? _qq_insert_tmp.js
?? audits/
?? deliverables/
?? design/
?? docs/costops/command-center-ui-spec-v1.0.md
?? scripts/inter-agent-evidence-gate.py
?? scripts/inter-agent-evidence-gate.sh
?? scripts/stale-instructions-detect.sh
?? scripts/stale-instructions-guard.sh
?? shared-dev/

$ git branch --show-current
devops/message-router-hardening
```

**Megerősítés:** ebben a UI-0 fázisban **kizárólag ez az audit-dokumentum jött létre** (`docs/costops/ui-0-audit-and-plan.md`). Nem történt UI-implementáció, nem került módosításra sem a `web/`, sem a `src/costops/`, sem a `src/web/routes/` alatt semmi. Nem történt `git add`, `git commit`, `git push` vagy PR. A fenti `git status` a repo teljes, ettől a dokumentumtól független állapotát mutatja (más, korábbi, nem CostOps-hoz kötődő munkafolyamatokból származó untracked fájlok — nem ennek a feladatnak a terméke, kivéve magát a spec-fájlt és ezt az audit-dokumentumot).

---

## 13. Implementációs státusz (UI-1..UI-4 lezárva, 2026-07-15)

A fenti tervet Istvan jóváhagyta, Marveen dispatch-elte UI-1→UI-4-et sorban architect-nek. Mind a négy fázis elkészült, additive módon (`data-page="costs-cc"`, a `costs-v2`/`loadCostsV2()` nézet érintetlen marad rollback-célként), külön git worktree-ben (`/home/iszzu/marveen-worktrees/architect-costops-ui1`, branch `architect/costops-ui1`). UI-1 és UI-2 és UI-3 Marveen empirikus review-ja után élesben landolt (batch-elt restart Istvan jelzésére); UI-4 ugyanígy landol.

| Fázis | Kártyák | Fő modul(ok) | Megjegyzés |
|---|---|---|---|
| UI-1 | #1-3 | `costops-state/api/charts/shell/overview.js` | Belső routing `location.search` + `pushState`-en, NEM a spec eredeti `#costs/overview` hash-sémáján -- app.js globális hash-routere teljes hash-egyezést vár, ez menet közben derült ki kódolvasásból |
| UI-2 | #5-8 | `costops-analysis.js`, `costops-drawer.js` | 'category' bontás szándékosan kimaradt (nincs backend-fogalom); drawer csak a ténylegesen elérhető belépési pontokra kötve (source/alert/recommendation, NEM invoice/ledger önállóan) |
| UI-3 | #9-11 | `costops-close.js` | Readiness checklist a 6 valós backend-check-re épül, nincs kitalált tétel |
| UI-4 | #12-15 | `costops.css` felülvizsgálat, `data-label` attribútumok | ld. lent |

### UI-4 részletek

- **Design-token hiba javítva:** a korábbi CSS egy nem-létező `var(--bg-secondary, ...)` egyéni tokent használt -- mivel a változó sosem létezett a valós `web/style.css`-ben, a fallback hex érték **feltétel nélkül, light/dark módtól függetlenül** érvényesült mindenhol. Lecserélve a valós `--bg-input` tokenre; a piros/zöld állapotszínek is a valós `--danger`/`--success` tokenekre lettek cserélve (a borostyán/warning szinthez nincs dedikált token a meglévő palettában, ott maradt egy dokumentált, szándékos kivétel).
- **Mobil táblázat → sorlista** (spec 9. szakasz): `data-label` attribútum minden `<td>`-n + CSS `::before` a fejléc rejtésekor (<640px).
- **Drawer mobilon bottom sheet**, háttér-elsötétítéssel (`cc-drawer-backdrop`), kattintásra és Escape-re is zár.
- **Billentyűzetes navigáció:** minden `role="button"` sor (bar/table/attention/savings) Enter/Space-re aktiválódik (egy delegált keydown-listener), látható fókusz-gyűrű `:focus-visible`-lel a meglévő app-konvenciót követve (`.tmux-copy-btn` mintája).
- **Empirikus ellenőrzés** (nem csak build-green): a `headless-viewport-verify` skill szerint valós headless Chromiummal, a tényleges CSS+markup-pal mérve, 3 viewporton (390×844, 360×740, 1440×900) -- nincs oldal-szintű horizontális overflow, a tabok sosem esnek off-screen, a táblázat ténylegesen `display:block`/sorlistává vált mobilon és `table`-ként maradt desktopon, a drawer ténylegesen a képernyő aljához rögzített teljes szélességű sheet mobilon és 340px-es oldalsó oszlop desktopon. A fókusz-gyűrűt **valódi Tab-billentyűs** navigációval mértem (nem szkriptelt `.focus()`-szal -- ez utóbbi hamis eredményt adott `role="button"` elemeknél, Chromium-specifikus `:focus-visible` heurisztika miatt, amit menet közben fedeztem fel és javítottam a mérési módszeremben, mielőtt jelentettem volna).
- **Partial-state következetesség:** a Havi zárás nézet korábban egyetlen Promise.all-ban futtatta mindhárom fetch-et, így egy másodlagos endpoint (invoice-reconciliation) hibája az EGÉSZ nézetet elhasajtotta volna -- igazítva az Áttekintés/Elemzés nézetek már meglévő konvenciójához (kritikus adat hibázik = teljes hiba, másodlagos adat hibázik = üres/részleges állapot, nem teljes vakulás).
