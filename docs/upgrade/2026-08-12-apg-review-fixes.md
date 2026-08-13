# APG dashboard — a 0.4 review F-1/F-2/F-7/F-13 javításai és az éles frissítés menete

**Ág:** `claude/apg-review-fixes-qe1z7m` (a `develop` @ `2d3c662` tetejéről)
**Testvér-ágak:** `claude/cos-review-fixes-qe1z7m` (ugyanez a repó), `marveen-apg-kernel` → `claude/apg-kernel-review-fixes-qe1z7m`
**Forrás:** `audits/apg-0.4-lean-teljes-code-review-2026-08-10.md`

---

## 0. Amit az éles frissítésnél meg kell csinálni

**Kötelező kézi lépés: nincs.** Se konfiguráció, se migráció, se újraindításon túli teendő.

**Amit tudni kell viszont: a képernyő két helyen MÁST fog mutatni ugyanarra az adatra.** Ez a javítás lényege, nem mellékhatása — de ha a frissítés után „elromlottnak" néz ki valami, valószínűleg ez az.

| Hol | Eddig | Ezután |
|---|---|---|
| Kanban jelvény | „**Függetlenül elfogadva**" (zöld) | „**Kapuk rendben · még nincs elfogadva**" (zöld) |
| Bizonyíték-címke | „Aktuális, igazolt tényként idézhető" | többségük: „Bizonyítékkal támogatott, de futásidőben nem igazolt" |
| `?mode=enforced` az URL-ben | felülírt mindent | globális OFF mellett nem hat |

Egyik sem hiba: **eddig több zöld volt a képernyőn, mint amennyit az adat megengedett.** A számok ettől rosszabbnak fognak látszani, miközben a rendszer ugyanaz.

### Frissítés

```bash
cd ~/marveen
git fetch origin
git merge origin/claude/apg-review-fixes-qe1z7m
npx tsc --noEmit                            # elvárás: néma
npx vitest run src/__tests__/apg-*.test.ts  # elvárás: 68 zöld / 6 fájl
```

Se séma, se `store/` fájl nem változik. **Visszaállítás:** `git revert` a merge commitra, nincs mit visszabontani.

### Egy dolog, amit ellenőrizni érdemes

Ha bármi a dashboardon kívül fogyasztja az `/api/apg/work-items` választ, két mező bővült:

- **`acceptance_status`** két új értéket vehet fel: `gates_passed`, `needs_input`
- **`mode_source`** egy új értéket: `request`

Ezt a repóban ellenőriztem: az egyetlen fogyasztó a `web/apg.js`, és az ebben az ágban frissült. Ha van külső integráció (script, riport, export), azt neked kell tudnod.

---

## 1. Mi változott, és miért

Mind a négy találás ugyanaz az alak: az APG-felület a sidecar **projekciója** (spec §1.4), és mindegyik a sidecar egy tényét egy **erősebb** ténnyé fordította a képernyőn — hibaüzenet nélkül.

### 1.1 F-1 (P0) — a zöld pipa most futásidejű bizonyítékot kér

**Ami volt.** A `VERIFIED_CURRENT` így jelenik meg: **„Aktuális, igazolt tényként idézhető"** — ez a legerősebb állítás ezen a képernyőn. Akkor járt, ha a bizonyíték-sor `PRESENT` volt **és ugyanabban a replay-futásban bármelyik** checkpoint átment.

A `spec_ready` PASS azt jelenti, hogy a *specifikáció* kész. Semmit nem mond arról, hogy a dolog fut-e. Így egy „a fájl létezik" szintű bizonyíték kapta a futásidőben igazolt címkét. A §11.1 hat módot sorol fel a hamis zöldre; ez az egy ág kettőt közülük magától előállított.

**Ami lett.** Két feltétel, mert két különböző félét válaszolnak meg:

1. **futásidejű kapu** ment át ugyanabban a futásban (`runtime_acceptance` vagy `release_ready`) — *az ellenőrzés lefutott és rendben találta*;
2. a nyugta `runtime_status`-a **`OBSERVED`** — *a dolgot tényleg látták futni*. (Ez a kernel saját szava: `migrations/0001` → `OBSERVED | UNKNOWN | MISSING`.)

Minden más, aminek valódi bizonyíték van mögötte, azt a **már létező** őszinte címkét kapja, amit pont erre az esetre írtak: `SUPPORTED_BUT_NOT_RUNTIME_VERIFIED`. Ez nem „tagadjunk meg mindent" — erre külön ellenpróba-teszt van.

### 1.2 F-2 (P0) — az „elfogadva" elfogadót kér

**Két állítás volt itt, amit semmi nem támasztott alá.**

**(a) Az `accepted` egy ÁTMENT KAPUBÓL jött.** Egy zöld `release_ready` azt jelenti, hogy az ellenőrzések lefutottak és egyetértettek; nem azt, hogy bárki elfogadta a munkát. Az `accepter_agent` szerkezetileg `null` volt, és a Kanban mégis azt írta rá, hogy „**Függetlenül elfogadva**". A spec §9.2 szó szerint ezt tiltja: *„SOHA ne mutasd acceptance-ként pusztán a done státuszt"*, a §24 „a producer nem tudja magát elfogadni" követelménye pedig **nem is ellenőrizhető**, amíg senki nincs elfogadóként rögzítve.

**(b) A `returned` a VÁRAKOZÁSBÓL jött.** Egy bizonyítékra vagy tisztázásra váró elemet **senki nem küldött vissza** — nincs ilyen esemény, és a szó egy meg nem történt cselekvést nevez meg.

**Ami lett.** Két új állapot mondja a valóságot:

| állapot | jelentés |
|---|---|
| `gates_passed` | minden kapu rendben. **Nem elfogadás** — senki nem fogadta el. |
| `accepted` | egy megnevezett fél elfogadta. **Kötelező hozzá az `accepter_agent`.** |
| `needs_input` | bizonyítékra / döntésre / tisztázásra vár. Nem ugyanaz, mint a `returned`. |

Az `acceptanceStatusFor` mostantól megkapja az elfogadót, és **amíg a kernel nem rögzít elfogadó-identitást** (ez az 1.8 gap map WP3-ja), ez `null`, tehát a felület soha nem mond „elfogadva"-t. Ez a **helyes bemenet** ahhoz a döntéshez, hogy megépüljön-e a hiányzó fél — egy címke, ami elfedi a hiányt, épp ezt lehetetleníti el.

### 1.3 F-7 (P1) — a `mode_source` a valóságot mondja

A `mode_source` **minden valaha projektált munkaelemen** a `'global'` literál volt. Így egy kártya-szintű kivétel láthatatlan volt azon a képernyőn, ami épp azt hivatott megmutatni, hogy a kivétel érvényesült-e.

A feloldó eddig is visszaadta, melyik hatókör döntött, és a hívó eddig is a kezében tartotta — csak ezt a mezőt nem mondta meg neki senki.

### 1.4 F-13 (P2) — a `?mode=` plafonozva

**Ami volt.** A query paraméter felülírt mindent, tehát `?mode=enforced`-dal az egész funkció visszakapcsolt egy olyan telepítésen, ahol a tulajdonos kikapcsolta. Egy vészkapcsoló, aminek dokumentált megkerülője van a címsorban, nem vészkapcsoló. Ráadásul `source: 'global'`-t állított magáról, miközben se nem globális, se nem feloldott hatókör — ugyanaz a hazugság, amiről az F-7 szól.

**Ami lett: PLAFON, nem tiltás.**

| kérés | globális beállítás | eredmény |
|---|---|---|
| `?mode=enforced` | `off` | `off` / `global` — a kapcsoló nyer |
| `?mode=observe` | `enforced` | `observe` / **`request`** — kevesebbet nézni szabad |
| `?mode=enforced` | `enforced` | `enforced` / `request` |
| `?mode=banana` | bármi | HTTP 400 |

Egy előnézet, ami csak a beállított módot tudja mutatni, nem előnézet — ezért plafon és nem tiltás.

---

## 2. Amit ez az ág NEM old meg

A tizenhat találásból hatot korábban javítottak (F-3, F-5, F-6, F-8, F-9, F-10), négyet ez az ág. **Hat marad:**

| # | Találás | Miért nem itt |
|---|---|---|
| **F-4** (P0) | a tulajdonosi döntés nem hagy nyomot a sidecarban | keresztrepós írási út; a sidecar ma append-only és a dashboard read-only — ez tervezési döntés, nem javítás |
| **F-11** (P2→P3) | a háttér magyar prózát ad vissza enum helyett | a legrosszabb esete (nyers próza a listán) már eltűnt; a maradék a „következő lépés" és a bizonyíték-címkék |
| **F-12** (P2) | minden listázás hat tábla teljes tartalmát beolvassa | valódi lapozás a lekérdezésbe; érdemi átalakítás append-only táblákon |
| **F-14** (P2) | natív `confirm`/`prompt`, háromból egy kötelező indok | saját dialógus-komponens kell hozzá (fókusz-csapda, §12.5 szöveg) |
| **F-15** (P2) | az idempotencia-fájl read-modify-write versenyzik és korlátlanul nő | tárolási forma cseréje + prune |
| **F-16** (P3) | akadálymentesség és mobil a spec alatt | önálló feladat |

Az `apg_enforcement_wired` (F-6) továbbra is három `false`-ot jelent — ez **helyes**: azok a kapcsolók valóban nem kényszerítenek ki semmit, és a felület ezt kimondja ahelyett, hogy kitalált szemantikát adna nekik.

---

## 3. Mérés

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run src/__tests__/apg-*.test.ts` | **68 zöld / 6 fájl** (előtte 54 / 5) |
| Új teszt-fájl | `apg-honest-projection.test.ts` (14 eset) |
| Séma-változás | **nincs** |
| Kötelező kézi lépés | **nincs** |

Az F-13 tesztje **viselkedés-alapú**: a `requestedMode` exportálva lett, mert a plafon ezen a fájlon a biztonsági szempontból érdemi viselkedés, és egy olyan végponton keresztül állítani, ami nem adja vissza a módot, csak a végpontot tesztelné.

A többi három tesztje **forrás-szintű** (a javított ág megléte és a régi alak hiánya), mert a projekció valódi sidecar-adatot igényelne — és az a kernel egyetlen gépre drótozott adatbázisában van, amit a testvér-ág (`marveen-apg-kernel` K-1) old meg. Ezt korlátnak tekintem, nem lezártnak.
