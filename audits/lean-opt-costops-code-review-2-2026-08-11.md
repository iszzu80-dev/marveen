# Lean Optimization + CostOps — második teljes code review a repóbeli specifikációkkal szemben

**Alap:** `develop` @ `d32fa30`.
**Előzmény:** `audits/lean-optimization-es-costops-teljes-code-review-2026-08-10.md` (`dc11ca4`) — O-1..O-10, C-1..C-7, verdikt: `OPTIMIZATION DASHBOARD NO-GO`.
**Spec:** `docs/optimization/optimization-dashboard-implementation-spec.md` (§1–§27), `docs/optimization/lean-optimization-phase-1-execution-spec.md`, `docs/costops/core-functional-scope-v1.0.1.md` (§1–§23).

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run` a 67 CostOps + Optimization teszt-fájlon | **828/829 zöld, 1 bukó** — környezetfüggő, lásd Ó-4 |
| Az előző kör 17 találása közül javítva | **3** (O-1, O-2, O-7) |
| CostOps-oldali változás a `dc11ca4` óta | **nulla sor** — `git diff --stat dc11ca4 d32fa30 -- src/costops` üres |
| Új találás ebben a körben | 4 (Ó-1..Ó-4), mind a most javított kód körül |

---

## 0. Rövid álláspont

**Elöljáróban, mert a kérés erre vonatkozott:** a `dc11ca4` óta a két funkcióterületen összesen **két commit** született (`b10310a`, `44c6784`), és mindkettő az Optimalizálás-oldalt érinti. A **CostOps-ból egyetlen sor sem változott** — a C-1..C-7 tehát nem „ismét nyitva", hanem érintetlen. Ezt előre kimondom, hogy a lenti táblázatok ne olvasódjanak regressziónak.

Ami megtörtént, az viszont a lista **legfontosabb** eleme volt, és jól történt meg. Az O-1 az egyetlen P0 volt: a mesterkapcsoló, a modulkapcsolók és a vészleállító egy fájlt írtak, a runner pedig egy másikat olvasott, amit semmi nem írt — a mért állapot szerint `enabled: true` 2026-07-30 óta. A javítás nem egy `if`, hanem egy szándékosan **egyirányú** propagáció (csak KI, mert az élesítés tulajdonosi döntés), és — ez a lényeg — **két standing check** védi, egy a termelő és egy a fogyasztó oldalon:

> `it('STANDING CHECK: the optimization write path calls the setter')`
> `it('STANDING CHECK: the runner still gates on the flag this setter writes')`

Ez pontosan az a varrat-teszt, aminek a hiánya a COS válasz-útján ma egy nem működő láncot hagyott. Itt megvolt, mielőtt szóvá tettem volna.

A négy új találás mind a javítás **körül** van, és mind ugyanabból fakad: a propagáció a *write* try-blokkjába került, és senki nem nézte meg, mit mondanak a szomszédos felületek, amikor a mesterkapcsoló ki van kapcsolva. Egyik sem P0, de kettő közülük a vészleállító **jelentését** rontja el — vagyis pont azt a tulajdonságot, amiért az O-7-et javították.

---

# I. LEAN OPTIMIZATION

## I.1 A három javított találás — kódból visszamérve

### O-1 · **JAVÍTVA** · A kapcsoló eléri a runnert

Két új darab:

- `capacity-routing-store.ts:173` `setCapacityRoutingEnabled(enabled, path)` — **egy mezőt** ír, a `candidates` és a `enabledForRouting` bizalmi zászlók érintetlenek. Kétirányú védelem: (a) ha nincs config a lemezen és `enabled=true` érkezne, **nem hoz létre** engedélyezett configot („az élesítés tulajdonosi döntés, egy UI-akció nem fegyverezhet"); (b) `raw.enabled === enabled` esetén nem ír — idempotens.
- `optimization-config.ts:324-327` a propagáció:
  ```ts
  if (!opts.path) {
    const shouldRun = config.masterEnabled && config.modules.runtimeRouting === true
    if (!shouldRun) setCapacityRoutingEnabled(false)
  }
  ```

**Hogy tényleg hat-e, ellenőriztem a fogyasztó oldalán is:** `capacity-routing-runner.ts:305-307` a sweep **minden körben frissen olvassa** a configot (`const cfg = readCapacityRoutingConfig(); if (!cfg.enabled) return`), nem csak indításkor. A kikapcsolás tehát a következő sweepen érvényes, nem újraindításkor.

A `/emergency-disable` (`routes/optimization.ts:303-314`) `runtimeRouting: false` + `automaticFallback: false` párost ír, a `masterEnabled`-et **nem** bántja — a spec §164 pontosan ezt kéri: „azonnal runtime routing off; new fallback off; statikus primary mode. **Ne állítsa le a teljes Marveent.**"

### O-2 · **JAVÍTVA** · A mesterkapcsoló minden modul-kapunak része

`optimization-summary.ts:217` egy `on(module)` segéd, és mind az öt kapu ezen megy át. Az indoklás a kommentben pontos, és attól jó, hogy megnevezi, **miért volt ez rés és nem döntés**: a master-OFF írás nem kényszeríti a modulzászlókat hamisra (a `lastEnabledConfiguration`-be teszi őket), így a „master OFF, modulok true" egy hétköznapi állapot — a `/routing` végpont pedig már a `masterEnabled && modules.runtimeRouting` páron kapuzott. Az aszimmetria a két végpont között volt a hiba, nem a szándék.

### O-7 · **JAVÍTVA** · A vészleállító nem hazudik sikert

`routes/optimization.ts:321-324`: `if (!result.ok) json(res, {...}, 500)`. A kommentje kimondja a lényeget: „a legrosszabb hibamód, amit egy kill switch produkálhat, mert az operátor elsétál."

---

## I.2 Új találások

### Ó-1 · P2 · A propagáció push, nem pull — a két igazság még mindig kettő

**Amit mértem.** `setCapacityRoutingEnabled` egyetlen produkciós hívója az `optimization-config.ts:326`, a `writeOptimizationConfig`-on belül. Nincs kiegyenlítés **bootkor**, nincs a **sweep** elején, és nincs a summary olvasásakor.

Következmény: a `store/capacity-routing-config.json` marad a runner egyetlen igazsága, és a dashboard csak **abban a pillanatban** nyúl hozzá, amikor valaki ír egyet az optimalizálás-configon. Amit ez nem fed le:

- **A mért drift maga.** A commit indoklása szerint az `enabled` 2026-07-30 óta `true` volt. Ha a javítás óta senki nem nyomott meg egy kapcsolót a felületen, az az érték **ma is `true`** — a javítás nem hozza szinkronba a meglévő állapotot, csak a következő írást propagálja. Egy egyszeri kiegyenlítés (bootkor, vagy a summary olvasásakor) ezt lezárná.
- **A visszaállítás.** A `writeOptimizationConfig` a saját fájljáról `.bak` mentést készít (`:308`), a capacity-routing configról nem — egy kézi visszaállítás vagy egy backup-restore újra `enabled: true`-t hozhat, mesterkapcsoló-OFF mellett.

**A felület pedig egyszerre tudja mutatni mindkét igazságot.** A `runtime_routing_config` a summaryban **feltétel nélkül** a valódi fájlból olvas (`optimization-summary.ts:254-258`), a `system_state` viszont az optimalizálás-configból (`:385`). Így a payload — és a képernyő (`web/optimization/optimization-overview.js:185,198`) — konzisztens állapotként jeleníti meg azt, hogy

```
system_state: "disabled"            (a mesterkapcsoló szerint)
runtime_routing_config.enabled: true (a runner szerint)
```

Az igazság tehát látszik, csak nincs megnevezve, hogy ellentmondás. Egy „drift" jelzés az `attention_queue`-ban olcsó, és pont abba a hagyományba illik, amit ez a kódbázis máshol követ.

### Ó-2 · P2 · Ha a propagáció elbukik, a vészleállító a rosszabb irányba hazudik

**Amit a kód mond.** A propagáció a **write try-blokkjában** van, a fájl kiírása UTÁN (`optimization-config.ts:307-327`). Ha a `setCapacityRoutingEnabled` dob — read-only `store/`, tele lemez, jogosultság —, a `catch` ág ez:

```ts
return { ok: false, config: current, error: ... }
```

`current` a **write ELŐTTI** config. Vagyis:

| ami valóban történt | amit a hívó lát |
|---|---|
| az optimalizálás-config **kiíródott** (master OFF) | `ok: false` + a **régi** config (master ON) |
| a routing-flag **nem** lett kikapcsolva | HTTP **500** a `/emergency-disable`-től |

Ez a vészleállítónál a legkellemetlenebb: az operátor „a leállítás nem sikerült" üzenetet kap, a saját fele viszont megtörtént, a másik fele nem — és a válaszban visszakapott config a régit mutatja, tehát a felület sem tudja, melyik fele landolt. Az O-7 javítása („jelentsd, ami történt, ne azt, amit megpróbáltál") itt nem ér el a saját új kódjáig.

**Javaslat.** A propagáció kerüljön a `return { ok: true }` **elé**, saját `try`-ral, és a hibája külön mezőben utazzon (`{ ok: true, routingFlagPropagated: false, warning: ... }`) — vagy, ha a szigorúbb irány a kívánt, a config-írás gördüljön vissza a `.bak`-ból. Amit nem szabad: egy megtörtént írást „nem történt meg"-ként jelenteni.

### Ó-3 · P3 · A blokkoló-szövegek nem tudnak a mesterkapcsolóról

Az `on()` helyesen kapuz, de a `blocker` szövegek a kapu **előtt** vannak beállítva, és változatlanok:

```ts
kpi = { available: false, report: null, blocker: 'measurement module disabled' }
if (on(config.modules.measurement)) { ... }
```

Master-OFF esetén tehát a válasz ugyanabban a payloadban tartalmazza a `modules: { measurement: true, ... }`-t **és** a `blocker: "measurement module disabled"`-et. Aki ezt olvassa, egy már bekapcsolt modult fog keresni, hogy bekapcsolja.

Egy sor: a blokkoló szövege mondja meg, **melyik** kapcsoló zárta be — `'master switch off'`, ha a master a felelős. Ugyanaz az elv, amit az O-7-nél alkalmaztak: a jelentés arról szóljon, ami történt.

### Ó-4 · P3 · Az új negatív teszt uid-függő, és root alatt megbukik

`optimization-master-and-emergency.test.ts:69-78` egy `chmodSync(dir, 0o500)`-zal teszi írhatatlanná a könyvtárat, hogy bizonyítsa: az `if (!result.ok)` ág elérhető.

**Root alatt a 0500 nem akadály.** Ezt a review-környezetben ki is mértem (uid 0, írás egy `0500` könyvtárba: sikerül), és a teszt itt meg is bukik — ez az egyetlen piros a 829-ből:

```
FAIL src/__tests__/optimization-master-and-emergency.test.ts
  > writeOptimizationConfig reports ok:false when the write cannot land
AssertionError: expected true to be false
```

A gondolat helyes — „a feltétel, amit a handler most néz, legyen elérhető, különben a fenti ág dekoráció" —, csak a mechanizmus uid-függő. **A helyes minta már a repóban van:** `dispatch-session-resolution.test.ts:137,150` `if (process.getuid?.() === 0) return`-nel lép ki. Egy uid-független alternatíva még jobb: a cél útvonal legyen egy létező **könyvtár**, akkor az írás `EISDIR`-rel bukik mindenkinek.

Ez nem elméleti: konténerben futó CI-k rendszeresen root alatt futnak, és egy uid-től függő teszt vagy pirosat ad ott, ahol nincs hiba, vagy zöldet ott, ahol az állítás nem is futott le.

---

## I.3 A többi hét találás — állapot

| # | Találás | Állapot | Bizonyíték |
|---|---|---|---|
| **O-3** | A `recommendations` **GET ír** az adatbázisba | **VÁLTOZATLAN** | `routes/optimization.ts:154` `upsertDecisionsFromRecommendations(db, ...)` egy GET kezelőjében. Spec §156: „Ne írjon GET-re", §21: „GET nem ír" |
| **O-4** | Configváltozás nincs auditálva | **VÁLTOZATLAN** | `/api/optimization/audit` (`:290-299`) csak `listOptimizationDecisions`-t képez le; a `writeOptimizationConfig` nem ír audit-eseményt. Spec §163: „audit event", §21: „minden configváltozás auditált" |
| **O-5** | Érvénytelen dependency némán javítva, nem elutasítva | **VÁLTOZATLAN** | `optimization-config.ts:184-191` `correctedModules` + `errors`, a write mégis lefut. Spec §21: „érvénytelen dependency **nem menthető**" |
| **O-6** | Az optimistic concurrency opcionális | **VÁLTOZATLAN** | `routes/optimization.ts:277-279` — `expectedVersion` hiánya esetén `undefined`, és a write elmegy. Spec §163: „config version/ETag; optimistic concurrency" |
| **O-8** | Hiányzó szűrőparaméterek | **VÁLTOZATLAN** | `/routing` kap `agent`, `state`, `problematicOnly`-t; a spec §157 `provider`, `time window`, `fallback`-et is kér. `/recommendations` (§158: `status; action; confidence; provider; time window`) csak `from`/`to`-t olvas (`:142-143`) |
| **O-9** | Az ajánlásmodell nem hordozza a „várható hatás" mezőket | **VÁLTOZATLAN** | `portfolio-recommendation.ts`-ben nincs `expected`/`impact`/`saving` mező. Spec §21: „recommendation kártyából érthető … **milyen hatás**" |
| **O-10** | Nincs auto-frissítés | **VÁLTOZATLAN** | `web/optimization/*.js`-ben nincs `setInterval`/`autoRefresh` |

### Verdikt a spec §27 szerint

A §21 lista **csak akkor** teljesül, ha MIND teljesül. Négy tétel továbbra sem: *„érvénytelen dependency nem menthető"* (O-5), *„minden configváltozás auditált"* (O-4), *„GET nem ír"* (O-3), *„recommendation kártyából érthető … milyen hatás"* (O-9).

**`OPTIMIZATION DASHBOARD NO-GO`** — változatlanul.

Egy fontos különbséggel az előző körhöz képest: a lista két legsúlyosabb tétele, *„az egész rendszer kikapcsolható"* és *„runtime routing külön vészkapcsolóval leállítható"*, **most már teljesül**. A NO-GO oka innentől nem az, hogy a kapcsolók nem működnek, hanem hogy a napló és a bemenet-ellenőrzés hiányzik.

---

# II. COSTOPS

## II.1 Változás: nincs

```
$ git diff --stat dc11ca4 d32fa30 -- src/costops
(üres)
```

A hét találás mindegyikét újra ellenőriztem a kódból, nem a korábbi dokumentumból.

| # | Találás | Állapot | Bizonyíték most |
|---|---|---|---|
| **C-1** | A collectorok nem nézik, hogy a hónap le van-e zárva | **VÁLTOZATLAN** | `checkPeriodWritable` hívói: `invoice.ts:160`, `manual-entry.ts:67/125/176`, `email-ingest.ts:112` — a `collectors/` könyvtárban **egy sem**. A `collectors/deepseek.ts:197` közvetlenül `INSERT INTO cost_line_items`-t hajt végre, a `runner.ts` pedig nem kapuz. **§23 AC-9** („Closed hónap nem változik csendben") a manuális utakon teljesül, az automatikuson nem — és épp az automatikus fut magától |
| **C-2** | A `partial` és a `rate_limited` import-státusz sosem íródik | **VÁLTOZATLAN** | `collectors/types.ts:65` mind a hetet felsorolja; a producerek `'ok' \| 'skipped' \| 'error' \| 'dry_run' \| 'locked'`-ot írnak. A `ledger.ts:728` viszont **lekérdez** rájuk (`status IN ('error','failed','partial','rate_limited')`) — egy szűrő, ami két értékre soha nem talál. **§23 AC-12** („részleges hibát tolerálnak") így nem megfigyelhető |
| **C-3** | A hibaosztályok szabad szöveges kód | **VÁLTOZATLAN** | `collectors/runner.ts:15-16` — `String(e?.code ?? e?.status ?? e?.name ?? 'error').slice(0, 40)`. Ami ebből `error_code` lesz, az a felfelé utazó kivétel alakjától függ, nem egy zárt halmaztól |
| **C-4** | Az FX-konverziónak nincs forrása/időpontja/módszere; a ledger-sornak nincs `updated_at`-ja | **VÁLTOZATLAN** | a `cost_line_items` írásainál nincs `rate_source`/`rate_date`; `updated_at` a `cost_sources`-on van (`ledger.ts:307`), a tételsoron nincs. **§23 AC-4** („minden adatnak van provenance, freshness és confidence") |
| **C-5** | A tesztek a valódi `store/costops-config.json`-t írják | **VÁLTOZATLAN** | `costops-api.test.ts:265-268` a kommentben ki is mondja: „loadCostopsConfig() reads the real on-disk store/costops-config.json … leaving an id behind would leak into unrelated test runs". Ebben a futásban zöld volt, de a takarítás továbbra is a teszt fegyelmén múlik, nem izoláción |
| **C-6** | A `.example` önjavító ága elfedheti a hibás configot | **VÁLTOZATLAN** | `config.ts:128,139,151` |
| **C-7** | Minden bootkor lefutó, mindent elnyelő `ALTER TABLE`-ök | **VÁLTOZATLAN** | 20 db `ALTER TABLE`, mind `catch { /* already exists */ }`-szel. Egy elrontott migráció ugyanúgy néma, mint egy már lefutott |

**A CostOps Core §23 huszonkét kritériuma közül** az AC-4, AC-9 és AC-12 a fentiek miatt továbbra sem teljesül; a többire nézve az előző kör értékelése áll, mert a kód nem változott.

---

## III. Amit jónak találtam ebben a körben

- **A varrat mindkét oldalát tesztelik.** `optimization-kill-switch-reaches-runner.test.ts:76` és `:84` — az egyik azt méri, hogy az író hívja a settert, a másik azt, hogy az olvasó még mindig azon a zászlón kapuz. Ez a párosítás az, aminek a hiánya a COS oldalon (review #6, H-2) egy nem működő láncot hagyott hátra. Itt magától megvolt.
- **Az egyirányúság szándékos és le van írva.** „Arming routing is an owner decision (Phase 3); a dashboard toggle may stop it, never start it." Egy javítás, ami tudja, meddig szabad mennie, ritkább, mint ami megoldja a feladatot.
- **A `setCapacityRoutingEnabled` egy mezőt ír.** A `candidates` és a `enabledForRouting` bizalmi zászlók érintetlenek maradnak, és erre külön teszt van (`:44`). Egy vészleállító, ami mellékesen bizalmi konfigurációt is átír, a következő incidens oka lenne.
- **Az O-2 kommentje megnevezi, miért volt rés.** Nem „elfelejtettük", hanem: a két végpont aszimmetriája, plusz az a tény, hogy a master-OFF nem kényszeríti hamisra a modulokat. Ez a fajta indoklás az, amiből a következő olvasó tanul.

---

## IV. Javasolt sorrend

1. **Ó-2** — a propagáció kerüljön ki a write try-blokkjából. Kicsi, és a vészleállító jelentését érinti.
2. **Ó-1** — egyszeri kiegyenlítés bootkor (vagy a sweep elején), plusz egy `attention_queue` tétel, ha a két fájl nem ért egyet. Ez zárja le ténylegesen az O-1-et.
3. **Ó-4** — `getuid`-őr vagy `EISDIR`-alapú negatív teszt. Egy piros teszt egy zöld kódbázison mindenkit hozzászoktat ahhoz, hogy elnézzen egy pirosat.
4. **C-1** — a `collectors/runner.ts` kapuzzon `checkPeriodWritable`-lel, és a lezárt hónapra `status: 'locked'` (a mechanizmus már létezik). Ez a `§23 AC-9`, és ma az automatikus út a védtelen.
5. **O-3** és **O-4** — a §21 két legkönnyebben zárható tétele: a GET ne írjon, és a configváltozás kapjon audit-eseményt.
6. **C-2** — vagy íródjon a `partial`/`rate_limited`, vagy tűnjön el a típusból és a `ledger.ts:728` szűrőjéből. Egy állapot, amit csak lekérdezni lehet, rosszabb, mint ami nincs.
7. **Ó-3**, majd O-5, O-6, O-8, O-9, O-10, C-3..C-7.

---

## V. Egy megjegyzés a mintáról

Az előző körben ezt írtam a két funkcióról: a kapcsolók megvannak, csak nem kapcsolnak. Ez most **megszűnt** — és a megszűnés módja a tanulságos: nem elég volt megírni a propagációt, kellett hozzá két teszt, ami a varrat két oldalát külön-külön rögzíti.

Az új találások viszont mind ugyanabból a forrásból jönnek: a javítás **a saját közvetlen környezetét** nem járta körbe. A propagáció bekerült egy try-blokkba, aminek a `catch`-e egy másik szerződést szolgál (Ó-2); a mesterkapcsoló bekerült a kapukba, de a kapuk mellett álló magyarázó szövegekbe nem (Ó-3); a negatív teszt megíródott, de nem futott le olyan felhasználóval, amilyennel a CI szokott (Ó-4). Mindhárom öt perc — és mindhárom ugyanazt kérdezi: *ha ez a sor változik, mi az a három dolog a látóterében, ami most mást mond?*
