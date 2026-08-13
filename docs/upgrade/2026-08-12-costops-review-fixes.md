# CostOps — a review C-1…C-3, C-5…C-7 javításai és az éles frissítés menete

**Ág:** `claude/costops-review-fixes-qe1z7m` (a `develop` @ `2d3c662` tetejéről)
**Testvér-ágak:** `claude/cos-review-fixes-qe1z7m`, `claude/apg-review-fixes-qe1z7m` (ugyanez a repó), `marveen-apg-kernel` → `claude/apg-kernel-review-fixes-qe1z7m`
**Forrás:** `audits/lean-optimization-es-costops-teljes-code-review-2026-08-10.md` (C-1…C-7), `audits/lean-opt-costops-code-review-2-2026-08-11.md`

---

## 0. Amit az éles frissítésnél meg kell csinálni

**Kötelező kézi lépés: nincs.** Se konfiguráció, se adatmigráció.

**Egy dolgot viszont tudni kell, mert az első bootnál derülhet ki.**

A séma-migrációk (`ALTER TABLE … ADD COLUMN`) eddig **minden hibát elnyeltek**; mostantól csak a „ez az oszlop már megvan"-t nyelik el, minden mást **kivétellel megállítanak**. Ha valamelyik migráció eddig csendben bukott, a frissítés utáni első indulásnál ez most **hangosan** fog kiderülni:

```
CostOps schema: ALTER TABLE <tábla> ADD COLUMN <oszlop> failed: <ok>
```

Ez nem regresszió — ez a hiba, ami eddig is megvolt, csak nem látszott. Ha ilyet látsz, **ne told vissza a frissítést**: az az `ALTER` eddig sem futott le, tehát az oszlop hiányzik, és minden rá épülő olvasás eddig is rossz választ adott. A hibaüzenet megnevezi a táblát, az oszlopot és az okot.

Ellenőrizni előre lehet, adatbázis-írás nélkül:

```bash
npx tsx -e "
const { initDatabase, getDb } = await import('./src/db.js')
initDatabase(':memory:')
console.log('a sema hibatlanul felepult egy ures adatbazison')
"
```

### Frissítés

```bash
cd ~/marveen
git fetch origin
git merge origin/claude/costops-review-fixes-qe1z7m
npx tsc --noEmit                                 # elvárás: néma
npx vitest run src/__tests__/costops-*.test.ts   # elvárás: 792 zöld / 61 fájl
```

**Visszaállítás:** `git revert` a merge commitra. Nincs séma-változás (csak a meglévő `ALTER`-ek hibakezelése szigorodott), nincs adatmigráció.

### Amit érdemes megnézni az első szinkron után

```bash
sqlite3 store/claudeclaw.db \
  "SELECT provider, status, error_code, imported_count
     FROM import_runs ORDER BY started_at DESC LIMIT 10;"
```

Két új dolog jelenhet meg, és mindkettő szándékos:

| Amit látsz | Mit jelent |
|---|---|
| `status='partial'`, `error_code='period_closed'` | a szinkron egy **lezárt hónapra** is hozott sort, azokat nem importálta. A többit igen. |
| `status='rate_limited'` | a szolgáltató visszafogott. **Nem hiba**, amit javítani kell — a következő ütemezett futás a megoldás. |
| `error_code` mostantól osztály (`auth`, `timeout`, `network`, …) a nyers kód helyett | a nyers kód átkerült az üzenet elejére, nem veszett el |

---

## 1. Mi változott, és miért

### 1.1 C-1 (P1) — a lezárt hónapot az automatikus út sem írja át

**Ami volt.** A `checkPeriodWritable` saját docstringje **megnevezi a három utat**, amire való:

> „Guard for any direct-write path (manual entry, email ingest, **collector upsert**) that might target a closed month."

Hívók:

```
invoice.ts:160        ✓
manual-entry.ts:67    ✓
manual-entry.ts:125   ✓
manual-entry.ts:176   ✓
email-ingest.ts:112   ✓
collectors/           ✗   nulla találat
```

Vagyis a három közül **kettő** kapuzott. A harmadik — az egyetlen, ami **magától fut, ütemezetten, nézők nélkül** — nem. A §23 AC-9 („lezárt hónap nem változik csendben") pontosan azon az úton nem teljesült, ahol a „csendben" a legszó szerintibb.

**Ami lett.** `runner.ts` `upsertProviderLines`: minden sor a saját (UTC) hónapkulcsa alapján ellenőrződik, és a lezárt hónapra szólók kimaradnak, hónaponként megszámlálva.

**Miért soronként és nem futásonként.** Egy szinkronablak folyamatosan átnyúlik hónaphatáron — egy elsejei futás a tegnapot is lehozza. Az egész futás visszautasítása eldobná a jogos aktuális havi adatot egy lezárt előző hónap miatt. Soronként: ami mehet, az megy; a többiről jelentés készül.

**A lezárt hónap valódi megváltoztatásának útja változatlan:** `createCorrection`. A visszautasítás üzenete ezt ki is mondja.

**Teljesítmény:** a lezártság-lekérdezés futásonként cache-elt. Egy szinkron több száz sort hoz, mind egy-két hónapba esik — soronként lekérdezni több száz azonos query lenne az írási tranzakción belül.

### 1.2 C-2 (P1) — a `partial` és a `rate_limited` végre íródik is

**Ami volt.** Az `ImportStatus` unió hét értéket sorol fel, a `lifecycle.ts` típusol rájuk, és a `ledger.ts:728` **szűr is rájuk**:

```sql
SELECT MAX(started_at) t FROM import_runs
 WHERE provider = ? AND status IN ('error','failed','partial','rate_limited')
```

Ebből a négyből **kettőt semmi nem írt**. Vagyis a „mikor bukott ez a szolgáltató utoljára" lekérdezés két állapotra sohasem találhatott, és a §23 AC-12 („a collectorok tolerálják a részleges hibát") kívülről nem volt megfigyelhető.

**Ami lett — két valódi termelő:**

| állapot | mikor |
|---|---|
| `partial` | a futás **egy részét** beírta, a többit lezárt hónap miatt visszautasította (C-1) |
| `rate_limited` | a hiba osztálya `rate_limited` (429, „too many requests", „quota exceeded”) |

A `rate_limited` szétválasztása azért érdemi, mert **más választ igényel**: az `auth` hiba embert kíván a vaulttal, a `rate_limited` a következő ütemezett futást. Egy szóval jelölve a kettőt megkülönböztethetetlen volt.

### 1.3 C-3 (P2) — a hibaosztályok zárt halmaz

**Ami volt.** `error_code = String(e.code ?? e.status ?? e.name ?? 'error')` — vagyis **aminek épp látszott** a felfelé utazó kivétel. Ugyanaz a kiesés `ETIMEDOUT`, `ECONNRESET`, `AbortError`, `529` vagy `FetchError` néven érkezett attól függően, melyik réteg vette észre először. „Ugyanúgy bukik ez a szolgáltató egy hete?" nem volt olyan kérdés, amit a ledger meg tudott válaszolni.

**Ami lett.** Nyolc osztály, zárt halmazként exportálva:

`auth` · `rate_limited` · `timeout` · `network` · `provider_error` · `bad_response` · `config` · `unknown`

A besorolás sorrendje szándékos: **HTTP státusz → node hibakód → név → üzenetszöveg**. A szövegillesztés van a végén, mert az a jelzés, ami a legvalószínűbben elmozdul alólunk, amikor egy szolgáltató átfogalmaz valamit.

Az `unknown` **megmarad** külön osztálynak: egy osztályozó, ami sosem mondja azt, hogy „nem tudom", hazudik a farokrészről.

A **nyers kód nem veszett el** — az üzenet elejére került. Az osztály a számoláshoz való, a kód a hibakereséshez, és egyik sem helyettesíti a másikat.

### 1.4 C-5 (P2) + C-6 (P2) — a tesztek nem írják a valódi configot

**Ami volt.** A `loadCostopsConfig` és a `saveCostopsConfig` az **egyetlen valódi** `store/costops-config.json`-t olvasta és írta. A route-tesztek tehát a tulajdonos valódi config-fájljában hoztak létre és töröltek budgeteket — és ezt a teszt kommentje ki is mondta:

> „leaving an id behind would leak into unrelated test runs"

Ez olyan tesztkészlet, aminek a helyessége azon múlik, hogy a saját takarító kódja soha nem marad ki. Vitest párhuzamos futtatása mellett két fájl egy JSON-dokumentumon versenyfutás — így fordulhatott elő, hogy három teszt egyszer pirosat adott, majd változatlan kód mellett újrafuttatásra zöldet.

**Ami lett.** `COSTOPS_CONFIG_PATH` környezeti változó. Produkció **pontosan azt** az útvonalat olvassa, amit eddig; a teszt egy eldobható fájlra mutat, és közben a **valódi** olvasó/író kódot gyakorolja, nem egy mockot. A `costops-api.test.ts` át is lett állítva, tehát a hiba nem csak javíthatóvá vált, hanem meg is szűnt.

**C-6 ehhez tartozik.** A „nem létező config" és a „létező, de hibás config" két különböző tény, és eddig az utóbbi is nulla fix költséggel tért vissza. Most a `{ exists: true, errors: ['config is not valid JSON'] }` páros különbözteti meg őket — a felület hibát mutat, nem magabiztos nullát egy olyan config fölött, amit valaki épp elrontott egy vessző-vel.

### 1.5 C-7 (P2) — a törött migráció nem néz ki sikeres no-opnak

**Ami volt.** Húsz sor ebben az alakban:

```ts
try { db.exec(`ALTER TABLE token_usage ADD COLUMN model TEXT`) } catch { /* column already exists */ }
```

A `catch` **mindent** elnyelt. Az „ez az oszlop már megvan" és az „ez a migráció törött" ugyanazt a csendet adta: egy elgépelt oszloptípus, egy még nem létező tábla egy megváltozott sorrend miatt, egy lemezhiba — mind sikeres no-opnak látszott, és az a funkció, aminek az oszlop kellett volna, később bukott, valahol egészen máshol.

**Ami lett.** Egy `addColumn(db, table, columnDef)` segéd, ami **kizárólag** az SQLite egyetlen jóindulatú hibáját nyeli el (`duplicate column name: x`), minden mást pedig beszédes kivétellé alakít.

**Miért dobás és nem naplózás.** A boot-idejű séma az az egy hely, ahol a féllábon továbbmenés rosszabb, mint a megállás: onnantól minden olvasás **hihető, rossz** választ ad hibaüzenet helyett.

---

## 2. Amit ez az ág NEM old meg

| # | Találás | Miért nem itt |
|---|---|---|
| **C-4** (P2) | az FX-konverziónak nincs forrása/időpontja/módszere; a ledger-tételsornak nincs `updated_at`-ja (§23 AC-4) | **séma-változás**: új oszlopok a `cost_line_items`-en és az FX-íráson, plusz visszamenőleges adat. Külön, önálló változtatás, mert egy sémabővítés és egy hibakezelés-szigorítás egy commitban nem igazolható azzal, hogy „a tesztek zöldek" |

A többi C-találás ebben az ágban javítva.

**A `store/costops-config.json.example` önjavító ága** (a C-6 másik fele) szándékosan **megmaradt**: hiányzó config esetén továbbra is kiír egy placeholder példát. Ez nem elfedi a hibát — a hiányzó és a hibás configot most már megkülönbözteti a hívó —, és a példa az egyetlen dokumentáció arról, milyen alakú fájlt kellene odatenni.

---

## 3. Mérés

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run src/__tests__/costops-*.test.ts` | **792 zöld / 61 fájl** (előtte 770 / 60) |
| Új teszt-fájl | `costops-closed-period-and-error-class.test.ts` (22 eset) |
| `git status store/` a teszt-futás után | **tiszta** — a tesztek nem nyúlnak a valódi confighoz |
| Séma-változás | **nincs** (csak a meglévő `ALTER`-ek hibakezelése) |
| Kötelező kézi lépés | **nincs** |

Minden javításhoz tartozik ellenpróba is: a nyitott hónap ugyanúgy íródik, a valódi hiba továbbra is `error` (nem `rate_limited`), az ismeretlen hiba `unknown` marad, a séma újrafuttatása továbbra is biztonságos no-op, és override nélkül a config a valódi útvonalról jön.
