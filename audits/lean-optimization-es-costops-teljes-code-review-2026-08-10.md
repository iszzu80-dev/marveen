# Lean Optimization + CostOps — teljes funkcionális és minőségi code review a repóbeli specifikációkkal szemben

**Dátum:** 2026-08-10 · **Ág:** `claude/marveen-cos-code-review-qe1z7m` (`develop` HEAD `106c813`)
**Kérte:** Istvan — „teljes code review a marveen lean optimisation és CostOps funkcióján a repóban található specifikációval szemben, teljes funkcionális és quality review".

**Mérce (a repóban található specifikációk):**

| Terület | Specifikáció |
|---|---|
| CostOps | `docs/costops/core-functional-scope-v1.0.1.md` (§1–§23, 22 acceptance kritérium) |
| CostOps UI | `docs/costops/command-center-ui-spec-v1.0.md` |
| Lean Optimization (Phase 1) | `docs/optimization/lean-optimization-phase-1-execution-spec.md` (Block A/B/C, §8 acceptance) |
| Optimization dashboard | `docs/optimization/optimization-dashboard-implementation-spec.md` (§1–§27, §21 acceptance, verdikt-követelmény) |
| Kontextus | `docs/costops/core-v1.0.1-gap-analysis.md` (GAP-01…GAP-21), `docs/optimization/*-as-built.md` |

**Amit ténylegesen futtattam (nem állítás, mérés):**

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run` az 59 CostOps teszt-fájlon | **767/767 zöld**, 25 s |
| `npx vitest run` a 3 optimization + a 135 COS/CostOps fájlos halmazon | **1397/1397 zöld** — ugyanaz a parancs egy korábbi futáson 3 hibát adott a `costops-api` budget-blokkban; a jelenség **flaky**, az okát megtaláltam (C-5) |
| Hívó-követés `grep`-pel `src/`, `web/`, `src/web/routes/` fákon | lásd O-1 |

---

## 0. Rövid álláspont

**CostOps: erős.** A könyvelési mag — a dupla számolás feloldása, a collector-keretrendszer, a period close, a riasztásmodell, az export-boríték — komoly, jól dokumentált munka, és a §23 huszonkét elfogadási kritériumának a nagy részét valóban teljesíti. Amit találtam, az öt konkrét rés, nem szerkezeti hiba.

**Lean Optimization: a vezérlőpult nem vezérel.** Az Optimalizálás oldal, az API-k, a presetek, a modulkapcsolók és a vészleállító mind megépültek és szépen néznek ki — de a konfigurációt, amit írnak, **futásidőben senki nem olvassa**. A `readOptimizationConfig` három hívója közül mindhárom read-model vagy maga a beállítás-végpont. A tényleges runtime routingot egy másik fájl (`store/capacity-routing-config.json` → `enabled`) kapcsolja, amit **a kódbázisban semmi nem ír** — kézzel szerkeszthető csak.

Ez a különbség fontos: a dashboard §21 acceptance-listája azt ígéri, hogy „az egész rendszer kikapcsolható", „modulok külön is", és „runtime routing külön vészkapcsolóval leállítható". Ezek ma a *megjelenítést* kapcsolják, nem a viselkedést. A rendszer ma azért nem routol magától, mert a kézzel írt `capacity-routing-config.json` `enabled: false` — nem azért, mert a vezérlőpult kikapcsolta.

A dashboard-spec §222 verdiktet kér. Az enyém: **`OPTIMIZATION DASHBOARD NO-GO`** — az O-1 miatt, ami önmagában négy acceptance-kritériumot dönt meg. A CostOps oldalra nem kér a spec verdiktet; az én értékelésem: **a §23-ból 17 teljesül, 5 részben** (részletek lent).

---

# I. LEAN OPTIMIZATION

## I.1 Funkcionális megfelelés — Phase 1 execution spec (Block A/B)

A Phase 1 két blokkja (privacy gate + neutral model profiles) **megvan és él**:

| Követelmény | Állapot | Bizonyíték |
|---|---|---|
| Block A: egyetlen mérvadó gate, nem második klasszifikátor | **IGEN** | `src/data-sensitivity-gate.ts` bővítve, nem duplikálva; a COS dispatch-kapu is ezt hívja (`cos/sensitivity.ts` a `matchSensitivityPatterns`-t újrahasználja, nem forkolja) |
| 3.2 Négy állapot, `unknown` saját állapotként, provider-jogosultságra fail-closed | **IGEN** | `data-sensitivity-gate.ts` + a COS oldali `coerceSensitivity` ugyanezt a fail-closed szabályt viszi tovább |
| 3.8 OFF/OBSERVE/ENFORCE egyetlen mérvadó flaggel, forrás-szerkesztés nélkül | **IGEN** | `store/data-sensitivity-gate.json`, futásidőben olvasva |
| 3.9 Audit log metadata-only | **IGEN** | `sensitivity_audit_log`; a reason code-ok nem tartalmaznak illesztett értéket |
| Block B: négy semleges profil + resolver precedencia | **IGEN** | `src/model-profiles.ts` (`MODEL_PROFILE_IDS`), a COS sensitivity-allowlist is ezekre épül |

Ez a rész **nem igényel javítást**, és a Phase 1 spec §8 privacy- és profil-kritériumai a kódból igazolhatók.

## I.2 Funkcionális megfelelés — optimization dashboard spec

| Követelmény | Állapot | Megjegyzés |
|---|---|---|
| §2 Navigáció: külön Optimalizálás menüpont, Költségek+Token Monitor érintetlen | **IGEN** | `web/index.html:183` `data-page="optimization"`, a STATISZTIKÁK csoportban (`app.js:448`) |
| §3 Négy belső nézet | **IGEN** | `web/optimization/` — shell, overview, routing, decisions, controls |
| §4.3 Öt preset | **IGEN** | `PRESET_MODULES` off/observation/advisory/active + a `custom` levezetése `presetForModules`-szal |
| §4.4 Globális kikapcsolás + külön vészkapcsoló | **CSAK A FELÜLETEN** | lásd **O-1** |
| §8.3 Hét modulkapcsoló | **CSAK A FELÜLETEN** | ua. |
| §8.4 Nem kapcsolható alapok (statikus modelProfile, privacy guard a master alatt NE legyen) | **IGEN** | a privacy gate saját flagjén van, az optimization config nem érinti — ez helyes |
| §8.5 Dependency-kezelés | **RÉSZBEN** | a szabályok megvannak (`validateModuleDependencies`), de a write némán javít — lásd **O-5** |
| §9 Verziózott, gitignored, atomikus, backupolt config + `lastEnabledConfiguration` | **IGEN** | `writeOptimizationConfig`: `copyFileSync` `.bak` + `atomicWriteFileSync`, verzió inkrementál, `lastEnabledConfiguration` a master ON→OFF átmenetnél mentődik |
| §10.1 Read endpointok, GET ne írjon | **RÉSZBEN** | hat végpont megvan; a `recommendations` GET **ír** — lásd **O-3** |
| §10.2 PATCH: version/ETag, optimistic concurrency, dependency validation, atomic write, backup, audit event, preview | **RÉSZBEN** | preview + atomic + backup megvan; **audit nincs**, a concurrency opcionális, a dependency-hiba nem blokkol — **O-4/O-5/O-6** |
| §10.2 `emergency-disable` | **NEM HAT** | **O-1** + **O-7** |
| §10.3 GET ne adjon vissza promptot/secretet/raw account ID-t | **IGEN** | az audit-végpont kommentje ki is mondja az invariánst, és a válasz csak `package_id` + státusz + eseménymetadata |
| §11 Adatállapotok: ne mutasson 0-t adat helyett | **IGEN** | a summary végig `{available, report, blocker}` hármassal dolgozik; a `blocker` mindig kitöltött, ha nincs adat |
| §16 Az oldal megnyitása ne indítson LLM-et/market screeninget/DB-írást | **RÉSZBEN** | LLM és hálózat nincs (a `market-watch.ts`-ben egyetlen `fetch` sincs), de a recommendations GET DB-t ír — **O-3** |
| §16 Auto-frissítés 60s, láthatatlan tabon ne polloljon, manuális Frissítés + utolsó frissítés | **NEM** | `grep setInterval|visibilitychange web/optimization/*.js` → nulla találat: nincs auto-frissítés |
| §15 HU+EN | **IGEN** | 170 `optimization.*` kulcs mindkét nyelvi fájlban, azonos darabszám |
| §23 As-built dokumentáció | **IGEN** | `docs/optimization/optimization-dashboard-as-built.md` |

### A §21 acceptance-lista, ami nem teljesül

1. „**az egész rendszer kikapcsolható**" — O-1.
2. „**modulok külön is**" — O-1.
3. „**runtime routing külön vészkapcsolóval leállítható**" — O-1.
4. „**érvénytelen dependency nem menthető**" — O-5 (menthető, csak némán javítva).
5. „**minden configváltozás auditált**" — O-4.
6. „**GET nem ír**" — O-3.

## I.3 Találások — Optimization

### O-1 · P0 · A master switch, a modulkapcsolók és a vészleállító nem hatnak a futásra

`grep -rn "readOptimizationConfig" src` az egész repóban **három** hívót ad:

```
src/optimization/optimization-summary.ts:203   (read-model)
src/web/routes/optimization.ts:90              (a /routing read-model gate-je)
src/web/routes/optimization.ts:213 és :304     (a settings és az emergency-disable végpont maga)
```

Egyik sem futásidejű útvonal. A tényleges runtime routing a `startCapacityRoutingRunner()` (`web.ts:411`), ami minden tickben ezt nézi:

```ts
if (!cfg.enabled) return          // capacity-routing-runner.ts:307
```

ahol `cfg` a `store/capacity-routing-config.json`. Erre a fájlra **nincs író a kódbázisban**: `grep -rn "writeCapacityRoutingConfig"` nulla találat, a `capacity-routing-store.ts` csak `readCapacityRoutingConfig` és `ensureCapacityRoutingConfigExample` függvényt exportál.

**Következmények, sorra a spec mondataival:**

- §4.4 „Globális kikapcsolás … atomikusan master OFF … új dispatch statikus default úton" — a master OFF beír egy JSON-mezőt, amit a dispatch nem olvas.
- §4.4 „Külön vészkapcsoló: **Routing azonnali leállítása**" és §10.2 `POST /api/optimization/emergency-disable`: „azonnal runtime routing off; new fallback off; statikus primary mode" — a végpont a `modules.runtimeRouting`-ot és az `automaticFallback`-et állítja `false`-ra az **optimization** configban. A runner ezt a fájlt nem ismeri.
- §8.3 D modul „Runtime routing … Kikapcsolás: új dispatch statikus configured primaryn … vészleállításnál új fallback azonnal tiltott" — nem valósul meg.
- §8.3 A/B/C/E/F/G modulok: a kapcsolók a summary *megjelenítését* szabályozzák (`config.modules.capacityMonitoring` stb.), nem a producereket. A capacity collector, a context guard és a market watch scheduler a saját útján fut tovább.

**Ma miért nem baj élesben:** a `capacity-routing-config.json` `enabled` alapértéke `false` (fail-safe), tehát a runtime routing eleve nem fut. A védelem tehát létezik — csak nem az, amit a felület mutat, és nem az, amit a vészkapcsoló nyom.

**Javaslat.** A legkisebb helyes lépés: a `startCapacityRoutingRunner` tick eleje olvassa be az optimization configot is, és `!masterEnabled || !modules.runtimeRouting` esetén lépjen ki — ugyanaz az egysoros minta, ami a `cfg.enabled`-re már ott van. Az `emergency-disable` pedig írja mindkét helyet, vagy a `capacity-routing-config.json` `enabled` mezője legyen a *kizárólagos* igazság, és az optimization config csak tükrözze.

### O-2 · P1 · A summary a `masterEnabled`-et nem nézi, csak a modulokat

`optimization-summary.ts:203-260` — minden ág `config.modules.X`-re épül; `config.masterEnabled` a fájlban **egyszer sem szerepel**. A `/api/optimization/routing` végpont viszont igen (`routes/optimization.ts:94`: `config.masterEnabled && config.modules.runtimeRouting`).

Mivel a `writeOptimizationConfig` master OFF-nál a `modules` mezőt **nem** kényszeríti `false`-ra (csak elmenti az előző állapotot `lastEnabledConfiguration`-be), egy „master OFF, modulok érintetlenül true" konfiguráció teljesen normális — és ilyenkor a summary mindent élőnek jelent. Az aszimmetria a két végpont között mutatja, hogy ez elmaradás.

### O-3 · P1 · A `recommendations` GET ír az adatbázisba

`routes/optimization.ts:154` — `upsertDecisionsFromRecommendations(db, recommendations, now)`, egy `// Deliberate GET exception` kommenttel.

A dashboard-spec két helyen tiltja: §10.1 „Ne írjon GET-re", és a §21 acceptance-lista szó szerint „**GET nem ír**". A szándék érthető (a friss ajánlás-pillanatképet perzisztálni kell, hogy a döntési státusz hozzáköthető legyen), de a megoldás egy `POST /api/optimization/recommendations/refresh`, vagy a döntés-írás elhalasztása az első tényleges döntésig — nem egy dokumentált kivétel egy explicit acceptance-kritérium alól.

### O-4 · P1 · Configváltozás nincs auditálva

`writeOptimizationConfig` a `.bak` mentésen kívül **semmit** nem naplóz. A `GET /api/optimization/audit` kizárólag a `optimization_decisions` eseményeit adja vissza, config-történetet nem — pedig a §10.1 „config- **és** döntéstörténet"-et kér, a §21 pedig „minden configváltozás auditált"-at, és a §8.1 a master kikapcsolásnál külön nevesíti az auditot.

Ez a master OFF és az `emergency-disable` esetén a legfájóbb: nincs nyoma annak, ki és mikor állította le a rendszert.

### O-5 · P1 · Az érvénytelen dependency-kombináció nem elutasítva, hanem némán javítva

`writeOptimizationConfig`:

```ts
const modules = validateModuleDependencies(next.modules).correctedModules
```

Az `errors` tömböt eldobja, a javított modulhalmazt elmenti, és `{ ok: true }`-t ad vissza. Egy `PATCH { runtimeRouting: true, measurement: false }` tehát **sikeresként** tér vissza, miközben a routing kikapcsolva mentődött.

A §8.5 ezt írja elő: „ne engedj érvénytelen kombinációt … Hiányzó előfeltétel → **ne kapcsolja be részlegesen; mutassa mi hiányzik**". A §21 acceptance: „érvénytelen dependency nem menthető".

**Enyhítő körülmény:** a frontend a preview→megerősítés→írás folyamatot használja (`optimization-controls.js:135-147`), és a preview válaszában megjeleníti a `dependencyErrors`-t, tehát a UI-ból ez látszik. A hazug rész az API-szerződés, nem a felület.

### O-6 · P2 · Az optimistic concurrency opcionális

`writeOptimizationConfig`: `if (opts.expectedVersion !== undefined && ...)`. `expectedVersion` nélküli PATCH ellenőrzés nélkül felülír. A §10.2 „config version/ETag; optimistic concurrency" feltétel nélkül fogalmaz. A frontend átadja — de az API-t nem csak a frontend hívja.

### O-7 · P2 · Az `emergency-disable` akkor is sikert jelent, ha az írás elbukott

`routes/optimization.ts:303-317` — a `writeOptimizationConfig` eredményének `ok` mezőjét meg sem nézi:

```ts
const result = writeOptimizationConfig(...)
json(res, { ok: true, config: result.config })
```

Egy csak-olvasható `store/` vagy lemezhiba esetén a vészleállító zölden nyugtáz. Egy vészkapcsolónál ez a legrosszabb hibamód.

### O-8 · P2 · Hiányzó szűrőparaméterek a spec API-listájához képest

- §10.1 `/routing`: kért `provider`, `time window`, `fallback` → nincs implementálva (megvan: `agent`, `state`, `problematicOnly`).
- §10.1 `/recommendations`: kért `action`, `confidence`, `provider` → nincs (megvan: `status`, `from`, `to`).

A §6.1 felső szűrősora ezekre épül, tehát a UI sem tudja kiszolgálni.

### O-9 · P2 · Az ajánlásmodell nem hordozza a „várható hatás" mezőket

`PackageRecommendation` (`costops/portfolio-recommendation.ts:75`): `package_id`, `verdict`, `evidence[]`, `confidence`, `blocker`, `window`, `generated_at`. **Nincs** becsült havi megtakarítás, éves megtakarítás, egyszeri váltási költség, kockázat, rollback.

Ezt két spec kéri egyszerre: a CostOps §17 („Minden ajánláshoz: jelenlegi költség; bizonyíték; becsült havi megtakarítás; becsült éves megtakarítás; egyszeri váltási költség; kockázat; confidence; szükséges emberi döntés; rollback"), és a dashboard §7.3 („Mekkora a várható hatás? Külön: közvetlen havi pénzügyi hatás; allokált költséghatás; minőségi hatás; kapacitáshatás; privacy/vendor risk"). A számok részben levezethetők az `evidence` figurákból, de a modell nem nevesíti őket, így a döntési kártya kötelező blokkja nem tölthető ki determinisztikusan.

### O-10 · P2 · Nincs auto-frissítés

`grep -n "setInterval\|visibilitychange" web/optimization/*.js` → nulla találat. A §16 60 másodperces alap-frissítést, láthatatlan tabon szüneteltetést, manuális Frissítés gombot és „utolsó frissítés" jelzést kér. A jelenlegi oldal egyszer tölt be, és onnantól kézi újratöltésig áll.

---

# II. COSTOPS

## II.1 Funkcionális megfelelés — core functional scope

| § | Követelmény | Állapot | Bizonyíték |
|---|---|---|---|
| 3.1–3.4 | Operational spend / forecast / opportunity cost / entitlement szétválasztása | **IGEN** | `resolveOperational` külön adja az `operational_spend`, `manual_spend`, `provider_derived_spend`, `operational_forecast_month_end` értékeket; az entitlement külön tábla |
| 4 | Source registry, lifecycle ≠ provenance | **IGEN** | `cost_sources` + `lifecycle.ts` (`active/inactive/not_configured/...`), a provenance a `confidence` oszlopon |
| 5 | Teljes forráslefedettség + inventory nézet | **IGEN** | `inventory.ts:buildSourceInventory` |
| 6 | Kanonikus ledger + accounting szabályok | **RÉSZBEN** | a dupla számolás feloldása kiváló (lásd lent); hiányzó mezők: **C-4** |
| 7 | Collector-keretrendszer: idempotencia, import run, checkpoint, retry, partial failure, rate limit, hibaosztályok | **RÉSZBEN** | idempotencia és lock kiváló; **C-2**, **C-3** |
| 8 | Freshness/confidence/completeness, amount-weighted data quality | **IGEN** | `getCostSummary` súlyozott bontást ad, nem forrásszámot |
| 9 | FX: érték, forrás, dátum, konverzió időpontja és módszere; lezárt időszak ne változzon | **RÉSZBEN** | `fx_rate`, `fx_date`, `original_amount/currency` megvan; **fx forrás, konverzió időpontja és módszere nincs** — **C-4** |
| 10 | Forecast snapshot + accuracy | **IGEN** | `forecast-capture.ts` + `forecast.ts`, snapshot-alapú, mérhető hibával |
| 11 | Budget szintek, küszöbök, státusz | **IGEN** | `limits.ts` + `budgets` tábla, soft/hard threshold, a hard csak riasztás |
| 12 | Alerts: severity, evidence, first/last seen, dedup, cooldown, ack, resolved | **IGEN** | `alerts-store.ts` mind a kilencet hordozza, `recurrence_count`-tal együtt — ez a spec egyik legpontosabban teljesített szakasza |
| 13 | Period close/reopen, closed hónap nem változik csendben | **RÉSZBEN** | a modell teljes és auditált; a kapu a collectorokra **nincs** rákötve — **C-1** |
| 14 | Invoice, credit, refund, correction, void/supersede | **IGEN** | `invoice.ts` + `correction.ts`, `corrects_line_id`, `voided_at`/`void_reason` |
| 15 | Manual cost első osztályú, void/archive preferált a hard delete-tel szemben | **IGEN** | `manual-entry.ts` a `checkPeriodWritable`-t is hívja; a `73e8914a` DELETE-döntés dokumentálva (`docs/costops/phase0-73e8914a-void-vs-delete.md`) |
| 16 | Subscription + entitlement, automatikus váltás nélkül | **IGEN** | `subscriptions.ts`, `entitlements` tábla; nincs provider-write |
| 17 | Aggregate Cost Optimization Advisor | **RÉSZBEN** | az evidence/confidence/blocker fegyelem kiváló, de a kötelező hatásmezők hiányoznak — **O-9** |
| 18 | Dashboard a v1.0.1 hierarchiában | **IGEN** | `web/costops/*` — nincs új vizuális koncepció |
| 19 | Export: secret nélkül, maszkolt account ID, reprodukálható, schema verzió + generálási idő | **IGEN** | `export.ts` `ExportMeta{schema_version, generated_at, scope}`, az inventory `account_ref`-et nem exportál |
| 20 | Read-mostly, provider-side write tilos | **IGEN** | a collectorok kizárólag olvasnak; nincs write-adapter |
| 21 | Additív séma, upstream-frissíthetőség | **IGEN** | `schema.ts` végig `CREATE TABLE IF NOT EXISTS` + `try { ALTER TABLE ... } catch {}` |

### A §23 huszonkét acceptance kritériuma

**Teljesül (17):** 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22 — közülük a 2. („nincs ismert dupla számolás") és a 13. („egy stale vagy hibás provider nem nullázza a jó adatot") kifejezetten jól bizonyított kóddal.

**Részben (5):**

- **9. „Closed hónap nem változik csendben"** — a manuális és invoice úton igen, a collector úton nem (**C-1**).
- **12. „A collectorok … részleges hibát tolerálnak"** — a `partial` státusz létezik és olvasva van, de sosem íródik (**C-2**).
- **17. „A rendszer provider/subscription/SaaS szintű megtakarításokat javasol"** — javasol, de a megtakarítás összegét nem nevesíti (**O-9**).
- **20. „A helyi deployment upstream frissítés mellett fenntartható"** — a séma additív, de a `try/catch` köré csomagolt `ALTER TABLE`-ök minden bootkor lefutnak és minden hibát elnyelnek: egy elrontott migráció csendben no-op lesz (**C-7**).
- **4. „Minden adatnak van provenance, freshness és confidence"** — az FX-konverziónak nincs (**C-4**).

## II.2 Találások — CostOps

### C-1 · P1 · A collectorok nem nézik, hogy a hónap le van-e zárva

`grep -rn "checkPeriodWritable" src` négy hívót ad: `invoice.ts:160`, `manual-entry.ts:67/125/176`, `email-ingest.ts:112`. A `collectors/runner.ts` **nincs köztük**, pedig ez az egyetlen automatikus író: `upsertProviderLines` `ON CONFLICT(dedup_key) DO UPDATE`-tel ír a `cost_line_items`-be, tetszőleges `charge_period`-ra.

Gyakorlati eset: a hónap lezárva, a snapshot elkészült; másnap a Render collector lefut, és a szolgáltató visszamenőleg pontosított egy sort. Az érték **csendben átíródik** a lezárt hónapban, a close-snapshot és az élő összeg elválik egymástól, és semmi nem jelzi.

A §13 szövege: „Closed időszak: nem változhat csendben; **új adat csak explicit correctionként kerülhet be**". A javításhoz a keret már megvan (`checkPeriodWritable` + `createCorrection`), csak a kaput kell a runnerre is rákötni — a nem-írható hónapra eső sorokból korrekció, vagy `status='skipped'` import run a pontos indoklással.

### C-2 · P1 · A `partial` és a `rate_limited` import-státusz sosem íródik

`collectors/types.ts:65` — `ImportStatus = 'ok' | 'partial' | 'rate_limited' | 'error' | 'dry_run' | 'locked' | 'skipped'`.

A `runCollector` (`runner.ts:186-220`) csak `'ok'`, `'error'` és `'locked'` értéket állít. A `'partial'` és `'rate_limited'` **olvasva van** — `ledger.ts:728` és `lifecycle.ts:47` mindkettőt figyeli a „mikor volt utoljára hiba" számításnál —, de nincs producer.

A §7 két külön követelménye marad így üresen: „partial failure kezelése" és „provider rate-limit kezelése". Egy 429-re futó collector ma közönséges `'error'`, ugyanabban a vödörben, mint egy lejárt kulcs — pedig az egyik magától rendeződik, a másik emberi beavatkozást kér.

### C-3 · P2 · A hibaosztályok nem állapotok, hanem egy szabad szöveges kód

A §7 négy dolgot kér külön állapotként: „credential error és permission error külön állapot; timeout és network error külön állapot".

`sanitizeError` (`runner.ts:14`) így képez kódot:

```ts
const code = String(e?.code ?? e?.status ?? e?.name ?? 'error').slice(0, 40)
```

Vagyis egy 401-ből `"401"`, egy 403-ból `"403"`, egy timeoutból `"ETIMEDOUT"`, egy DNS-hibából `"ENOTFOUND"` lesz — a megkülönböztetés tehát *létezik*, de egy szabad formájú stringben, providerenként más alakban. Az `import_runs.status` mindegyikre `'error'`. Egy determinisztikus riasztás (§12 „credential/permission error") így nem tud a státuszra szűrni, csak string-mintát illeszteni.

A `sanitizeError` redakciós része viszont **jó**: `sk-*`, `authorization|bearer` és a 32+ karakteres tokenszerű minták kimaszkolva.

### C-4 · P2 · Az FX-konverziónak nincs forrása, időpontja és módszere; a ledger-sornak nincs `updated_at`-ja

A §9 öt dolgot ír elő a HUF-konverzióhoz: „árfolyamérték; árfolyamforrás; árfolyamdátum; konverzió időpontja; konverziós módszer". A `cost_line_items` ebből kettőt hordoz (`fx_rate`, `fx_date`); `fx_source`, `converted_at` és `fx_method` nincs.

Ugyanitt a §6 kötelező ledger-mezői közül hiányzik az `updated_at` (csak `created_at` van) és a „usage/service period, ha eltér a billing periodtól" (csak `charge_period_start/end` van). A `provider`/`service`/`category` a `cost_sources`-on él, ami normalizálási döntésként rendben van.

Gyakorlati következmény: a §9 „A már lezárt időszak HUF-értéke ne változzon automatikusan későbbi árfolyammal" szabálya ma azon múlik, hogy a `fx_rate` be van-e írva a sorba — ami jó —, de utólag nem rekonstruálható, **melyik forrásból és mikor** került oda.

### C-5 · P2 · A tesztek a valódi `store/costops-config.json`-t írják → a suite flaky

A `costops-api.test.ts` budget-blokkja a saját kommentje szerint (`:264-267`) tudatosan a **valódi on-disk configot** használja, és a teszt végén takarít. A `costops-budgets.test.ts` ugyanezt a fájlt írja. A vitest a teszt-fájlokat párhuzamos workerekben futtatja, tehát a két fájl versenyezhet ugyanazon a JSON-on.

Mérve: egy 135 fájlos futáson három hiba (`POST /api/costs/budgets`, `PATCH`, `GET .../history`), ugyanaz a parancs megismételve **1397/1397 zöld**, az 59 CostOps fájl önmagában **767/767 zöld**, a `costops-api.test.ts` egyedül **31/31 zöld**.

Ez nem a budget-kód hibája, hanem teszt-izolációs hiba — de a hatása valódi: a suite véletlenszerűen pirosat ad, és a következő zöld futás „elintézi" a kérdést anélkül, hogy bárki megnézné. (Ezért pontosítottam a COS-review megfelelő sorát is.)

**Javaslat.** A budget-tesztek kapjanak külön config-útvonalat (a `loadCostopsConfig` már fogad path-paramétert a többi helyen), vagy fussanak `describe.sequential`-ben.

### C-6 · P2 · A `.example` fájl önjavító ága elfedheti a hibás configot

`config.ts` a hiányzó config helyett `store/costops-config.json.example`-t másol. Ez kényelmes, de a §12 „új, korábban nem látott költségforrás" riasztásával együtt azt jelenti, hogy egy elveszett config csendben egy példa-portfólióra vált, ahelyett hogy hangosan elbukna. Érdemes legalább egy `config_replaced_by_example` figyelmeztetést adni.

### C-7 · P2 · Minden bootkor lefutó, mindent elnyelő `ALTER TABLE`-ök

`schema.ts:90-113` és társai:

```ts
try { db.exec(`ALTER TABLE cost_line_items ADD COLUMN fx_rate REAL`) } catch { /* already exists */ }
```

A `catch` nemcsak a „már létezik" esetet nyeli el, hanem minden mást is: elgépelt típus, hiányzó tábla, zárolt adatbázis. Egy elrontott oszlop-hozzáadás csendben kimarad, és a hiba majd később, egy `no such column`-ban jelentkezik — pontosan az a hibaosztály, amit a COS oldalon egy `IF NOT EXISTS` trigger már okozott egyszer (dashboard boot-loop, 2026-08-09). Egy `PRAGMA table_info` alapú `ensureColumns` (a COS `schema.ts`-ben már létezik ilyen) ugyanezt idempotensen, néma elnyelés nélkül csinálja.

---

## III. Amit jónak találtam

- **`resolveSourceWinners` / `resolveOperational`** (`ledger.ts:163-265`). Ez a review legjobb kódja. Külön kezeli, hogy egy hónapban két valódi számla **összeadandó**, nem választandó; az azonos szintű ütközést az *elszámolási szabály* dönti el a frissesség előtt (top-up → fogyasztás nyer, csomag → a számla nyer); a jövőbe mutató időbélyeg nem jelenthet „frissebbet"; és a `provider_plan_estimate` proxy automatikusan kiesik, amint valódi számla érkezik ugyanarra a providerre. Mindegyik szabály mellett ott van, melyik hibából tanulta.
- **Collector-keretrendszer** (`runner.ts`). Per-provider import lock (a manuális „sync most" nem versenyezhet az ütemezettel), hibánál **semmit nem töröl**, minden futás `import_runs` sort hagy, a hibaüzenet redaktált, az import `dedup_key`-re upsertel. A §7 gerince tényleg megvan.
- **`alerts-store.ts`**. A §12 kilenc kötelező tulajdonságából kilenc, `recurrence_count`-tal megfejelve. Ritka, hogy egy riasztásmodell első nekifutásra ilyen teljes.
- **`period-close.ts`**. A close-snapshot a `CostSummary` mellett **minden budget állapotát** befagyasztja, a reopen kötelező indokot kér, és a történet külön eseménytáblában él.
- **Az advisor bizonyíték-fegyelme** (`portfolio-recommendation.ts`). A `weakestConfidence` szabály — „az aritmetika sosem javítja fel a bizonyítékot" — és a kötelező `blocker` minden nem-`measured` esetben pontosan az a viselkedés, amit a dashboard-spec §11 „insufficient evidence" pontja kér. Az FX-evidence gate inkább `unknown`-t ad, mint egy kitalált átváltott számot.
- **Az optimization config fail-safe iránya.** Hiányzó vagy sérült fájl → `DEFAULT_OPTIMIZATION_CONFIG` (`masterEnabled: false`, minden modul off), `valid: false` és a hibaüzenet. Atomikus írás, `.bak`, verzió-inkrementálás, `lastEnabledConfiguration`. A §9 és a §18 „invalid confignál fail-safe statikus mód" teljesül.
- **Az optimization frontend preview-folyamata.** A mentés előtt szerverről kért `wouldApply` + `dependencyErrors` megjelenítése pontosan az a „mutasd meg, mi fog történni" minta, amit a §8.1 és a §8.5 kér — kár, hogy az API a tényleges íráskor nem tartja ugyanezt.

---

## IV. Javasolt sorrend

**Most (mind kicsi, és mind egy acceptance-kritériumot hoz vissza):**

1. **O-1** — a `capacity-routing-runner` tick eleje olvassa az optimization configot is (`!masterEnabled || !modules.runtimeRouting` → kilép), az `emergency-disable` pedig írja a valódi kapcsolót. Amíg ez nincs meg, a Vezérlés tab és a vészgomb félrevezet.
2. **O-7** — az `emergency-disable` nézze meg a `result.ok`-ot, és hiba esetén 500-zal jelezzen.
3. **C-1** — `checkPeriodWritable` a collector-írási útra; a lezárt hónapra eső sor korrekció vagy `skipped` import run, indoklással.
4. **O-3** — a recommendations-perzisztálás átköltöztetése GET-ről egy explicit refresh/POST útra.

**Rövid távon:**

5. **O-4** — configváltozás-audit (ki, mikor, mit, előző→új diff) és a `/audit` végpont kiegészítése config-történettel.
6. **O-5 + O-6** — a dependency-hiba legyen 400 a write-on (a preview marad, ami ma), és az `expectedVersion` legyen kötelező.
7. **C-2 + C-3** — a `partial` és `rate_limited` státusz tényleges kiírása, és a hibaosztályok normalizálása (`credential` / `permission` / `timeout` / `network` / `other`) az `import_runs`-on.
8. **C-5** — a budget-tesztek saját config-útvonalra vagy szekvenciális futásra.

**Középtávon:**

9. **O-9** — az ajánlásmodell kiegészítése a §17 kötelező mezőivel (havi/éves megtakarítás, váltási költség, kockázat, rollback), hogy a döntési kártya kötelező blokkja determinisztikusan tölthető legyen.
10. **C-4** — `fx_source`, `fx_method`, `converted_at` és `updated_at` a ledger-sorra.
11. **O-8 + O-10** — a hiányzó szűrőparaméterek és az auto-frissítés.
12. **C-7** — az `ALTER TABLE` migrációk `ensureColumns` mintára (a COS `schema.ts`-ben már megvan a minta).

---

## V. Egy megjegyzés a két funkció viszonyáról

A CostOps és az Optimization ugyanazt a mintát mutatja két különböző stádiumban. A CostOps-ban a szabály és a végrehajtás egy helyen van: a `checkPeriodWritable` ott van az írási úton, az import lock ott van a collectorban, a dedup a DB-ben. Ahol rés van (C-1), az pontosan az az egy útvonal, ahová a kaput nem kötötték be.

Az Optimizationben a szabály és a végrehajtás **két külön fájlban** él: a `optimization-config.json` mondja meg, mit szeretnénk, a `capacity-routing-config.json` mondja meg, mi történik, és a kettő között nincs kód. Ez ugyanaz a hibaosztály, amit a COS- és az APG-review is megtalált — a kapu megépül, és nem kerül a forgalomba.

A közös, olcsó védekezés mindhárom területen ugyanaz: **egy hívó-számláló riport minden exportált modulfüggvényre és minden konfigurációs mezőre, a teszteken kívül.** Aminél nulla, az nem kész funkció, hanem könyvtár — és egy nulla hívójú *kapcsoló* rosszabb, mint egy hiányzó kapcsoló, mert azt ígéri, hogy hat.

*Marveen-review, 2026-08-10 — a spec a mérce, a kapcsoló akkor kapcsoló, ha valaki olvassa.*
