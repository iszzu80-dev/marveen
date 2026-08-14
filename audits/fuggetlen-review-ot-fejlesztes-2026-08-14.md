# Független code review — CostOps · APG · Lean Optimization · CoS (privát + céges) · Autonomous Case Progression

**Dátum:** 2026-08-14
**Mérési alap:** `marveen-private` @ `509ace1` (= `origin/develop`) · `marveen-apg-kernel` @ `79613ab` (= `origin/main`) · `marveen-suite` @ `cb99550` (= `origin/main`), frissen klónozva, **nem** István gépén.
**Módszer:** minden állítás vagy futtatott parancs kimenete, vagy fájl:sor hivatkozás. Ahol csak dokumentumra tudtam támaszkodni, ott ezt kiírom.
**Viszony a 2026-08-14-i Marveen-riporthoz:** azt a riportot (`audits/belso-fejlesztes-teljes-review-2026-08-14.md`, commit `560dff9`) **nem tudtam elolvasni — egyik repó egyetlen ref-jén sincs meg**, csak az összefoglalóját kaptam meg. Az alábbi az önálló mérésem; a 9. fejezet veti össze a kettőt.

---

## 0. Egymondatos álláspont

Az öt fejlesztés kódminősége magas és őszinte, a mérési és merge-fegyelme viszont nem — és **ma ez a második dolog a szűk keresztmetszet, nem az első**. Két repóban nulla CI fut, az APG kernel default ágán a saját tesztszvitje futtathatatlan, és ~45 000 sor kész, zöld APG 1.9-munka egyetlen mergeletlen ágpáron áll.

---

## 1. Amit ténylegesen lefuttattam

| Kapu | Eredmény |
|---|---|
| `marveen-private` @ `origin/develop` · `npx vitest run` | **6811 zöld / 1 piros / 4 kihagyott** (513 fájlból 1 piros) |
| `marveen-apg-kernel` @ `origin/main` · `python3 -m unittest discover` | **504 teszt · 10 bukás + 123 hiba** |
| `marveen-apg-kernel` @ `claude/costops-agp-lean-review-mksxlj` · ugyanaz | **1066 teszt · 0 bukás · 33 indokolt skip** |
| `marveen-private` · `scripts/cos-acceptance.py` (élő store nélkül) | 16 PASS / 3 FAIL / 16 ERROR (35 kritérium) |

Ez a négy sor önmagában megadja a riport gerincét.

---

## 2. A két legélesebb lelet (mindkettő új, és mindkettő mért)

### 2.1 · P0 · Az APG kernel **default ága** nem futtatható — a javítás mergeletlen

`origin/main` @ `79613ab`, friss klón, saját gép:

```
Ran 504 tests in 5.659s
FAILED (failures=10, errors=123)
AssertionError: required Marveen core database is missing or unreadable:
    /home/iszzu/marveen/store/claudeclaw.db
```

A 133 törés nagy része egyetlen okra megy vissza: **bedrótozott `/home/iszzu/...` abszolút utak a tesztekben**. Ez a K-1 találás, amit a 2026-08-13-i kör „NYITVA"-ként zárt le.

Ugyanez a szvit a `claude/costops-agp-lean-review-mksxlj` ágon:

```
Ran 1066 tests in 48.801s
OK (skipped=33)
```

Vagyis: **a gépfüggetlenné tétel kész, bizonyítottan működik, és nincs a default ágon.** Ez nem vélemény és nem dokumentum-olvasás — két parancs, két kimenet, ugyanaz a konténer.

Ennek a következménye túlmutat az APG-n. A `marveen-private` produkciós UI-ja ennek a kernelnek az SQLite-fájlját olvassa. Ma a kernel „kész, kiadható állapotára" a válasz egy olyan ág, aminek a tesztszvitje sehol nem fut le.

### 2.2 · P0 · Nulla CI két repóban — a „zöld szvit" senkin kívül nem reprodukálható

```
marveen-private/.github/     → csak pull_request_template.md, workflows/ NINCS
marveen-apg-kernel/.github/  → nem létezik
marveen-suite/.github/workflows/ → mk-golden.yml, rls-lint.yml
```

Az öt vizsgált fejlesztésből **öt** a két CI nélküli repóban él. Három konkrét következmény:

1. A `6811 zöld` és az `1066 zöld` értékek egyetlen ember gépén keletkeztek, és minden merge-döntés ezekre hivatkozik. A 2.1 pont pontosan azt mutatja, mi történik, ha ezt senki nem méri máshol.
2. `APG_REQUIRE_KERNEL_CONTRACT=1` — a kétrepós szerződés-teszt kikényszerítő kapcsolója — **a teljes kódbázisban sehol nincs beállítva**. Az 1.9-es javítás a *jelentést* javította (látható skip a néma `return` helyett), a *kikényszerítést* nem, mert nincs futtató, ami beállítsa.
3. A `.github/pull_request_template.md` létezik, tehát a PR-folyamat szándéka megvan; a kapu, ami mögé állhatna, nincs.

**Ez a legolcsóbb tétel a listán:** két `.github/workflows/test.yml`, összesen ~30 sor.

---

## 3. Keresztmetsző lelet: a merge-sorrend kényszerített

### 3.1 · P1 · A `develop` szerződés-tesztje **pirosra megy** az APG 1.9 kernellel

Reprodukálva: kernel kicsekkolva az 1.9 ágra, `marveen-private` a `develop`-on:

```
FAIL src/__tests__/apg-projection-contract.test.ts
  > HEADLINE: the UI list matches the kernel RESULT_VALUES
  expected [ 'ERROR', 'EXCLUDED', 'FAIL', 'PASS', 'UNKNOWN' ] to deeply equal []
```

Ugyanez a teszt a kernel `main`-jével zöld (9/9). **A vokabulárium nem tér el** — mindkét ágon `PASS, FAIL, UNKNOWN, ERROR, EXCLUDED`. A hiba a parserben van:

`src/__tests__/apg-projection-contract.test.ts:61` (develop):
```ts
const line = readFileSync(kernel!, 'utf8').split('\n').find(l => l.includes('RESULT_VALUES'))
```

Az 1.9 kernelben a `checkpoints.py:47` egy **komment**: `#: EXECUTOR_RESULT_VALUES.` — ez az első `RESULT_VALUES`-t tartalmazó sor, idézőjeles token nincs benne, a regex `[]`-t ad. Hamis piros.

A hibaosztály fontosabb a példánynál: **ugyanez a parser hamis ZÖLDET is tud adni** — ha egy komment megelőz egy *megváltozott* vokabuláriumot, a teszt a kommentet hasonlítja össze, és átmegy.

Az 1.9-es privát ág ezt is javítja (`kernelTokenList()`: `src.indexOf(`${name} = `)`, tehát csak értékadásra illeszkedik). **De a javítás ugyanazon a mergeletlen ágon van.**

**Következmény, és ez a legfontosabb művelet-szintű megállapítás a riportban:**

> A `marveen-private` és a `marveen-apg-kernel` `claude/costops-agp-lean-review-mksxlj` ágait **együtt** kell mergelni, vagy a privátot előbb. Ha a kernel megy előre egyedül, a `develop` szvitje pirosra vált egy olyan hibáért, ami nem létezik.

### 3.2 · P2 · A szerződés őre alapértelmezésben továbbra sem fut

Az 1.9-es változat becsületesen jelenti, ha kimarad (`it.skipIf`, nevesített ok, `APG_REQUIRE_KERNEL_CONTRACT=1` opció) — ez valódi javulás a néma `return`-höz képest. De alapértelmezésben **skip**, és a 2.2 miatt nincs hely, ahol a kapcsoló bekapcsolna. A „két repó, egy kontraktus" garancia tehát ma is csak azon a gépen érvényes, ahol mindkét checkout megvan.

---

## 4. Munkafolyamatonként

### 4.1 APG 1.8 → 1.9

**A legtöbb új kód, a legmagasabb minőség, a legnagyobb merge-adósság.**

| | privát | kernel |
|---|---|---|
| mergeletlen commit | 7 | 14 |
| érintett fájl | 52 | 104 |
| hozzáadott sor | **+12 158** | **+33 064** |

A `docs/apg/apg-1.9-...-2026-08-13.md` (4650 sor) és a `audits/apg-1.8-full-spec-conformance-2026-08-13.md` az 1.8-ról azt mérte: *„nyolc munkacsomagból nulla elfogadva"*. Az 1.9 ág erre válasz, és a válasz jó.

**Amit visszamértem, és stimmel:**

- §3.1 (az „enforced" mód egyetlen blokkolója böngésző-oldali JS) — **javítva**. `src/web/apg-archive-gate.ts` + `routes/kanban.ts:546` szerveroldali kapu, a §25 három foka külön szemantikával, a kliens-check UX-ként megmarad.
- §3.2 (scope-override önlefokozás) — **javítva**. Operator principal kötelező, a flotta-token elutasítva, producer-önlefokozás tiltva, TTL-korlát, audit-sor.
- §3.3 (az emberi jóváhagyás nem emberi) — **javítva a helyes irányba**: nem hazudik emberi principalt, hanem `human_principal_proven: false`-t rögzít, és `human_required` esetén fail-closed elutasít. A `apg-principal.ts` fejléce külön kimondja, mi az, amit **nem** bizonyít.

**Egy pontosítás az „WP1–6 kész" megfogalmazáshoz.** A saját as-built dokumentum (`audits/wp1-wp8-as-built-2026-08-13.md`) táblázatában az „Exit-kód igényelhető?" oszlop **mind a nyolc csomagnál `nem`**. A „leszállítva" a szállítást állítja, nem az elfogadást; a §34 acceptance-mintát még senki nem futtatta le rájuk. Ez nem szőrszálhasogatás: pontosan az a különbség, amit az egész 1.9-es szerkezetátalakítás meg akart őrizni. Az összefoglalókban érdemes a doksi saját szóhasználatát tartani.

**A három keresztmetsző blokkoló** (§18 kockázati profil hiánya; hitelesített emberi principal hiánya; élő feed forrás nélkül) a doksi szerint valós, és a §18 valóban négy blokkot old egyszerre — ez a legjobb hozamú következő fejlesztési tétel.

### 4.2 CostOps

**Él, merge-adóssága nincs, a 08-13-i kör C-találásai lezárva.** Visszamérve:

- **C-1 javítva.** `src/costops/collectors/runner.ts:158` `upsertProviderLines()` — soronkénti lezárt-hónap kapu, `refusedByClosedPeriod` kimenettel. A fejléc-komment megőrzi a hiba történetét (a `grep`-et, ami nulla találatot adott), és megindokolja, miért soronként és nem futásonként. Ez példaértékű.

**A funkcionális hiány, amit kód-oldalról meg tudok erősíteni:** a költségvetés-túllépés riasztás konstrukció szerint per-budget-sor tüzel — `src/costops/alerts.ts:86,89,106` mindhárom ága `s.budget_id`-re épül. **Nulla beállított költségvetés mellett a riasztás nem hogy nem tüzelt: nem is tüzelhetett.** A táblák tartalmát ebből a konténerből nem látom (nincs store), de az állítás szerkezeti része igazolt.

- ~~**P3:** a scope-dokumentum §2 out-of-scope listája ellentmond a Lean Optimizationnek.~~ **Visszavonva — a javítás már bent van.** A `docs/costops/core-functional-scope-v1.0.1.md:73-77` egy 08-13-i, `review R-14` jelzésű korrekciós blokkot tartalmaz, ami pontosan ezt tisztázza: a mondat a CostOps modulhatárára vonatkozik, nem a deploymentre, és a routing a fölötte lévő `src/optimization/`-ban él.

  Miért hagyom benne áthúzva: a `:71` sort megnéztem és nem olvastam tovább. Ez ugyanaz a hibaosztály, amit ez a riport végig mér — **a mérőeszköz egy sort nézett, nem a dokumentumot** —, csak ezúttal a mérő tévedett. A többi találás grep-, teszt- vagy parancskimenet-alapú; ez volt az egyetlen, ami egyetlen sor elolvasásán állt.

### 4.3 Lean Optimization

Itt találtam a legnagyobb **dokumentum ↔ kód** eltérést, és élesebb, mint amit az összefoglaló állít.

`docs/optimization/lean-optimization-phase-1-as-built.md` az A blokkról (data-sensitivity gate) három dolgot állít:

| Az as-built állítása | A `develop` valósága |
|---|---|
| `:86` „The gate now runs inside `sendPromptToSession` (`src/web/agent-process.ts`)" — kifejezetten azért, mert egyetlen hívási hely kevés volt | `agent-process.ts`-ben **nulla** hivatkozás a kapura. Egyetlen hívó: `message-router.ts:670`. |
| `:104` „reported by `GET /api/security/gate-health`" | `grep -rn "gate-health" src/ web/` → **0 találat**. |
| `:138` „removing the gate call fails 3 wiring tests" | Az egyetlen teszt (`src/__tests__/data-sensitivity-gate.test.ts`) tiszta unit-teszt: `isProviderTrusted`, `parseTrustedProviders`, `classifyContent`, `evaluateDispatch`. **Wiring-teszt nincs.** A `checkDispatchGate` hívás törlése `message-router.ts`-ből egyetlen tesztet sem buktat. |

**Utólagos korrekció (2026-08-14, Marveen visszajelzése után, ellenőrizve).** A táblázat jobb oldala igaz, a belőle levont következtetésem nem volt az. A `feat/lean-opt-phase1-gate` ág azóta fel van töltve, és mindhárom állítás **igaz rá**:

- `src/web/agent-process.ts:24` importálja a `checkDispatchGate`-et, és `:1683` a tmux-injekció **előtt** állítja meg a dispatchet;
- `src/web/routes/security.ts:37` a `GET /api/security/gate-health`;
- a három rögzítő teszt (`-canary`, `-no-dispatch`, `-wiring`) ott van.

Tehát **nem a doksi képzelte oda a kódot — a doksi landolt a kód nélkül.** A különbség számít: az első hanyag dokumentálás, a második egy szállítási sorrend-hiba, és a javítása is más (az ág landolása, nem a doksi átírása). Amit a riport eredetileg állított — hogy a `develop`-on nincsenek meg —, változatlanul igaz, és amíg az ág nem landol, **egy élő biztonsági kapu fut az egyetlen hívási helyén, a rögzítői nélkül.**

**Amit viszont a javára kell írni, és ez komoly:** `src/web/data-sensitivity-gate-runner.ts:138–180` egy futásidejű **liveness-szonda**, ami az **audit-logot** olvassa, nem a hívást — vagyis kifejezetten azt az esetet fogja meg, amikor egy merge elejti a hívási helyet (card `aaabd99c`, ez már megtörtént egyszer). Ez helyes és ritka minta. De futásidejű probe, nem regressziós kapu: **CI nélkül (2.2) semmi nem akadályozza meg, hogy a hívás megint eltűnjön** — csak utólag derül ki.

### 4.4 CoS — privát és céges

**A legérettebb vonal, és a 08-13-i kör P1-es találásai lezárva.** Visszamérve a `develop`-on:

- **R-2 javítva** — `zst-send.ts:307`: `const caseType = zstCaseTypeOf(db, req.ledgerId) ?? req.caseType`. A típus a store-ból jön, nem a hívó állításából.
- **R-1 javítva** — `zst-send.ts:350` `approvalId: auth.approvalId, limits: auth.limits`, `:314` `outboundKind: zstOutboundKindOf(...)`, `:385` claim-út. A négy réteg bekötve.

Vagyis a *„a javítás nem néz vissza a forrásra, ahonnan másolt"* hibaosztály legnagyobb élő példánya lezárult.

**Az acceptance gate-ről, saját futtatásból.** 35 kritérium, élő store nélkül: 16 PASS / 3 FAIL / 16 ERROR. A 16 ERROR helyes viselkedés (nincs adatbázis, a script becsületesen ERROR-t ad, nem PASS-t — pont a saját §3.7 szabálya szerint). **A 3 FAIL viszont a gate saját őszinteség-hibája:**

```
[ERR ] SD-1  a scheduled-tasks könyvtár nem érhető el
[FAIL] SD-2  az ugy-ebreszto feladat nincs
[FAIL] SD-3  a bejovo levelfigyelo feladat nincs
```

**Ugyanaz a hiányzó előfeltétel, két különböző verdikt.** SD-1 helyesen ERROR-t ad rá, SD-2/SD-3 FAIL-t. A FAIL azt jelenti, hogy *„a check tényleg lefutott és bizonyított hiányt talált"* — itt nem futott le, mert nincs mit olvasnia. Ez hamis piros, és pontosan a hamis zöld tükörképe: a szvit, ami a „No Silent Unknown" szabályt hordozza, maga sérti meg lefelé. Ugyanez `LV-3`-nál (`a SKILL.md nem olvashato` → FAIL).

Élő gépen ez a három PASS-ra vált, tehát a 34/1 jelentés hihető — de a gate ma **nem tud különbséget tenni „nincs beállítva" és „nem tudtam megnézni" között**, és ez a különbség az egész vokabulárium értelme.

### 4.5 Autonomous Case Progression

**Az E.1 / E.2 / E.5 kérdés — megerősítve, és határozottabb válasszal.**

```
git log --all --diff-filter=A -- '**/progression-planner.ts'      → 0
git log --all --diff-filter=A -- '**/progression-controller.ts'   → 0
git log --all --diff-filter=A -- '**/progression-escalation.ts'   → 0
git grep -l "progression-planner" origin/develop                  → 0
```

Nem csak a `develop`-ról hiányoznak: **a `marveen-private` egyetlen ref-jén sem léteztek soha**, és a kernel/suite repókban sincs rájuk hivatkozás. A kártya-azonosítók (`1ef39b00`, `ff0ee545`, `59c06cbc`) **egyetlen fájlban sem fordulnak elő** — se kódban, se doksiban, se commit-üzenetben. Összehasonlításul: az E.3 (`b29f99d2`) és az E.4 (`25e06d97`) kártyaszáma ott van a `progression-scheduler.ts:2`-ben és a `schema.ts:1787`-ben.

**A valószínű magyarázat, és ez eldönthető olvasásból:** a funkció beleolvadt a pipeline-ba, nem külön modulba került. `progression-pipeline.ts:6-13` a stage-listája:

```
3. Rolling Plan       — ordered steps to reach the outcome   ← a "planner"
4. Next Best Action   — the very next thing to do
6. Decision           — one of 10 valid progression decisions (§13)
```

plusz `progression-scheduler.ts` + `capability-preflight.ts` (a controller-szerep), és `owner-question.ts` + `decision-package.ts` (az eszkaláció). Tehát **nem az a helyzet, hogy három kártya olyat állít késznek, ami nem fut** — sokkal inkább az, hogy három kártya olyan *modulneveket* nevez meg, amik sosem születtek meg, mert a megvalósítás más szeleteléssel ment. Ez kártya-higiéniai kérdés, nem funkcionális lyuk. **De ellenőrizni kell**, mert ha a kártyák szövegében van olyan acceptance-pont, amit a pipeline nem fed, akkor az valóban kiesett.

**Kiegészítés (2026-08-14): a `progression_mode` egy ötállású biztonsági tárcsa, amit semmi nem olvas.** Marveen E.2-es leletét visszamértem a `develop`-on, és áll:

`schema.ts:1701` — `progression_mode TEXT NOT NULL DEFAULT 'off'`, `:1717` — `CHECK (progression_mode IN ('off','shadow','internal','external_shadow','live'))`. Ez a fokozatos élesítés létrája. Az összes előfordulása a produkciós kódban **INSERT-oszloplista, UPDATE SET vagy séma** (`case-progression-seed`, `intake`, `progression-eval:547`, `progression-migrate:77,95`, `progression-pipeline:721,1284`, `progression-scheduler:325`). **Egyetlen elágazás sincs az értékére.** A `mode === 'off'` minták a `develop`-on mind az APG-hez (`apg/ui-projection.ts:1007,1116`, `web/apg-archive-gate.ts:109`) vagy a data-sensitivity kapuhoz tartoznak.

Az árnyalat, ami a súlyt behatárolja: **a `progression_enabled` viszont OLVASÓDIK** — `goal-enrichment.ts:62`, `owner-question.ts:796`, `progression-completion.ts:493`. A biztonsági tulajdonság tehát ma nagyrészt áll, csak nem attól, amitől a séma állítja.

Mert a `schema.ts:1682` ezt mondja: *„progression_enabled=0 + progression_mode='off' means legacy behavior unchanged."* Ez egy **konjunkció, aminek csak az első tagja létezik kódban.** A második egy CHECK-constraint olvasó nélkül. Aki a tárcsát `'live'`-ra vagy `'off'`-ra állítja, egyik irányban sem változtat semmin.

**Amit külön érdemes kiemelni:** a `progression-pipeline.ts:36-44` fejléce leírja, hogy a **régi fejléc hazudott** („ZERO side effects", „progression_mode stays 'shadow'"), miközben a fájl a Checkpoint E óta BLOCKED/READY/COMPLETED átmeneteket ír, és ezt a rendszer legnagyobb blast radius-ú fájlján tette. Ez a fajta önkorrekció a kódbázis legjobb tulajdonsága, és ugyanannak a hibaosztálynak a példánya, amit a 4.3-ban a lean-opt as-built-nál most találtam meg — csak ott még nincs javítva.

---

## 5. Repók, ágak, merge a default felé

### 5.1 Default ágak (GitHub API, ma)

| Repó | Default | `main` létezik? |
|---|---|---|
| `iszzu80-dev/marveen-private` | **`develop`** | **NEM** — a remote-on nincs `main` ref |
| `iszzu80-dev/marveen-apg-kernel` | **`main`** ✅ | igen (`79613ab`) |
| `iszzu80-dev/marveen-suite` | `main` | igen |

A 2026-08-13-i riport zárása két emberi lépést kért. **Az egyik megtörtént** (kernel default → `main`, a `wp1-slice1-executor-registry` már csak egy azonos mutató). **A másik nem:** a `marveen-private`-on a `main` ág nem hogy nem default — **nem létezik**. A riportban hivatkozott `208b61c` commit létezik és a `develop` őse, tehát a *tartalom* landolt; az ág maga vagy sosem lett push-olva, vagy törölték. Aki a 08-13-i riport zárófejezetét olvassa, ma egy nem létező ágra hivatkozik.

### 5.2 Mergelendő tartalom — pontosan két ág

**`marveen-private`, `origin/develop` fölött:**

| Ág | ahead | eltérő fájl | Döntés |
|---|---|---|---|
| `claude/costops-agp-lean-review-mksxlj` | 7 | **52 (+12 158 sor)** | **MERGELENDŐ** — APG 1.9 privát oldal |
| `claude/apg-review-fixes-qe1z7m` | 0 | 0 | törölhető |
| `claude/cos-autonom-code-review-qv04y2` | 0 | 0 | törölhető |
| `claude/cos-review-fixes-qe1z7m` | 0 | 0 | törölhető |
| `claude/costops-review-fixes-qe1z7m` | 0 | 0 | törölhető |
| `claude/marveen-code-review-rizx4k` | 0 | 0 | törölhető |
| `claude/marveen-cos-code-review-qe1z7m` | 0 | 0 | törölhető |
| `claude/progression-v131-fixes-qe1z7m` | 0 | 0 | törölhető |
| `cos-review-fixes-2026-08-10` | 0 | 0 | törölhető |

**`marveen-apg-kernel`, `origin/main` fölött:**

| Ág | ahead | eltérő fájl | Döntés |
|---|---|---|---|
| `claude/costops-agp-lean-review-mksxlj` | 14 | **104 (+33 064 sor)** | **MERGELENDŐ** — APG 1.9 kernel |
| `claude/apg-kernel-review-fixes-qe1z7m` | 0 | 0 | törölhető |
| `claude/marveen-code-review-rizx4k` | 0 | 0 | törölhető |
| `claude/marveen-cos-code-review-qe1z7m` | 0 | 0 | törölhető |
| `wp1-slice1-executor-registry` | 0 | 0 | törölhető (régi default) |

Vagyis a „halott ág" jelenség valós, és **12 ágat érint** a két repóban: nulla egyedi fájl, mind teljes egészében benne a defaultban. Ugyanaz a verem többszörös rebase-elt másolatban. (A `pr/costops-ui-command-center` és `rb/costops-660` neveket a három remote **egyikén sem** találtam — ezek szerint lokálisak.)

### 5.3 `marveen-suite` — hat nyitott PR, hat gazdátlan ág, hat árva történet

**Nyitott PR-ek (mind `main` alapra):**

| PR | Cím | Nyitva |
|---|---|---|
| #20 | Art.17 GDPR purge endpoint (cherry-pick) | **ma**, 08-14 |
| #18 | P0 GDPR — `pool_active` defaults FALSE + backfill | 07-20 → **25 nap** |
| #17 | zsibongo rule-profile write path + expiry kill-switch | 07-20 → 25 nap |
| #15 | qq: disable auto-follow-up cron | 07-19 → 26 nap |
| #14 | CI: migration duplicate-prefix collision guard | 07-18 → **27 nap** |
| #13 | lint: `check-bare-pool-query-rls` a `lint:db`-be | 07-18 → 27 nap |

Két megjegyzés. **#18 P0-nak van jelölve és GDPR** — 25 nap egy P0-n a jelölés jelentését üríti ki. **#13 és #14 pedig maguk kapuk** (RLS-lint és migrációs ütközés-őr): a `main`-ben már van `rls-lint.yml`, tehát a téma él — az a két PR, ami szigorítaná, negyedik hete áll.

**Hat ág valós tartalommal, PR nélkül:** `feat/eskuvo-dietary-visibility-c7d991be` (6 commit / 9 fájl), `feat/venue-pro-frontend-352923b6-cddd2a4e` (3/9), `qa/mk-modifying-test-coverage` (2/2), `fix/commit-before-reply-send-eskuvo`, `fix/guided-setup-reload-6b7ece8a`, `frontendfejleszto/zsibongo-cta-restore-medication-dock-75bd7693` (1/1 mind). Ezek se PR-ben, se `main`-ben.

**Hat ág, aminek nincs közös őse a `main`-nel** (`no merge base`): `chore/commit-rls-gap-checker`, `devops/fix-eskuvo-access-log-comment`, `feat/qq-photo-upload-ui`, `feat/qq-voice-first-ui`, `frontend/mk-fs04-validation-badge`, `landing-deploy`. Utolsó commitjaik 07-04 és 07-18 között. Ezek egy átírt/újraindított történet maradványai; nem mergelhetők, csak cherry-pickelhetők vagy törölhetők. **A `chore/commit-rls-gap-checker` (RLS gap linter) és a `frontend/mk-fs04-validation-badge` (NJT-pin adójogszabály-hivatkozásokkal) tartalmilag nem közömbösek** — érdemes eldönteni, kell-e belőlük valami, mielőtt törlődnek.

### 5.4 Egyetlen fájl, aminek sehol nincs git-forrása

Ez a `releases/` téma pontos alakja. A minta **szándékos és jó**: `releases/` gitignore-olt, hogy branch-váltás ne rángassa az ütemezett feladatok függőségeit (card `d3f9fd90`), és `scripts/sync-scheduled-scripts.sh` `git show`-ból pinneli be őket. Ellenőrizve, mi van git-ben:

| Fájl | Trackelve |
|---|---|
| `email-triage-fetch.py` | ✅ |
| `skill-index.sh` | ✅ |
| `install-monitor.sh`, `limit-monitor.sh` | ✅ |
| **`dispatch-guard.sh`** | ❌ **0 trackelt, 0 találat bármely ref-en, valaha** |

A `ops/scheduled-tasks/context-watchdog/check.sh:27` szerint ez a `GUARD` — a proaktív, dispatch előtti kontextus-telítettség kapu. A 08-09-i kanban-bejegyzés maga írja: *„dispatch-guard.sh (intentionally untracked locally) via disk-copy"*.

Tehát nem az a baj, hogy „egy kapu gitignore-olt könyvtárból fut" — az a terv.

**Utólagos korrekció (2026-08-14, Marveen mérése után).** Azt írtam, „pontosan egy fájl van". **Három van**, és kettőt a cron percenként futtat:

| Szkript | Állapot a mérésekor | Cron |
|---|---|---|
| `dispatch-guard.sh` | van története, de a `develop`-en nem volt | — |
| `fleet-resume-guard.sh` | **semelyik refen nem volt** | 3 percenként |
| `suite-checkout-ff-guard.sh` | **semelyik refen nem volt** | 5 percenként |

És az ok, amiért az én keresésem nem találta meg őket: mindhárom a **`.git/info/exclude`**-ban ült, ami **gép-lokális** lista — nem a verziókövetett `.gitignore`-ban. Egy `git status` tehát tisztát mutatott, és az én `git log --all --diff-filter=A` keresésem nulla találatot adott, amit én bizonyítéknak olvastam. Ez ugyanaz a hibaosztály, amit ez a riport végig mér, most a saját műszeremen: **a nulla találat nem bizonyíték, ha a műszer nem tudta megnézni a helyet.** Mindhárom bent van azóta (`29ce2ba`, `git add -f`).

---

## 6. Az öt fejlesztés mint egy lánc

```
CostOps (mérés) ──→ Lean Optimization (döntés a mérésből) ──→ model routing
     │
     └──→ APG (bizonyíték-kapuk magán a fejlesztésen)
              │
CoS privát + céges (ügyintézés) ──→ Autonomous Case Progression
```

Három valódi csatolás, amit érdemes együtt látni:

1. **CostOps → Lean Optimization.** A függés iránya helyes és egyirányú, csak a CostOps scope-doksi tagadja (4.2).
2. **APG kernel ↔ APG UI.** Egyetlen szerződés (`RESULT_VALUES`) két repóban, egyetlen teszt őrzi, és az a teszt alapértelmezésben nem fut (3.2). Ez a leggyengébb keresztmetsző pont a rendszerben.
3. **CoS → Progression.** A privát küldési út mint referencia-megvalósítás, a céges mint másolat. Ez a másolás-hibaosztály (`R-1..R-3`) most **lezárult** — és pont ezért érdemes rögzíteni: a javítás mintája (egy összehasonlító standing check a két úton átadott `ExecuteOpts` kulcshalmazára) az a fajta kapu, ami megakadályozza az újranyílást. Ha még nincs meg, ez az egy teszt megéri.

**A negyedik csatolás pedig maga a probléma:** mind az öt fejlesztés ugyanabban a két, CI nélküli repóban él, és mind az öt ugyanazon az egy gépen mért „zöld"-re hivatkozik.

---

## 7. Amit ebből a környezetből NEM tudok megítélni

Becsületesen elhatárolva, mert az összefoglaló jelentős része erre épül:

- **Bármilyen adatbázis-tartalom.** Nincs `store/claudeclaw.db` és nincs APG kernel store. A „nulla valós számla", „nulla beállított költségvetés", „34 PASS / 1 FAIL", „négy ZST-ügy WAITING_EXTERNAL", „6380 sor token_usage" — ezeket nem tudtam megnézni. A költségvetés-riasztásnál a *szerkezeti* részt igazoltam (4.2), a többinél nem.
- **Kanban-kártyák állapota és prioritása.** Az `a6a7dd66` vészleállítós kártya és az E.1/E.2/E.5 kártyák „done" státusza a store-ban van. Amit meg tudtam nézni: a kártya-azonosítók nyoma a kódban (4.5).
- **Futásidejű események.** A „nyolc órán át néma bukás, 6 óra 47 perc a javításig" időadatok naplókból származnak, nem repóból.
- **A Marveen-riport maga.** `audits/belso-fejlesztes-teljes-review-2026-08-14.md` és a `560dff9` commit **egyik repó egyetlen ref-jén sincs meg** — csak az összefoglalót láttam. Ez önmagában is adat: a mai munka nagy része nincs push-olva.

---

## 8. Javasolt sorrend

**Ma, egyben (a kettő nem választható szét — 3.1):**

1. **`claude/costops-agp-lean-review-mksxlj` merge mindkét repóban**, privát előbb vagy egyszerre. Utána mindkét szvit lefuttatása, `APG_REQUIRE_KERNEL_CONTRACT=1`-gyel.
2. **A mai, csak lokálisan meglévő munka push-olása** — beleértve a `belso-fejlesztes-teljes-review-2026-08-14.md`-t.

**Ezen a héten:**

3. **CI mindkét repóba.** `marveen-private`: `npx tsc --noEmit && npx vitest run`, `APG_REQUIRE_KERNEL_CONTRACT=1` + kernel checkout. `marveen-apg-kernel`: `python3 -m unittest discover -s tests`. Ez a tétel teszi az összes többi „zöld" állítást ellenőrizhetővé.
4. **`git add ops/.../dispatch-guard.sh`** (5.4). Egy parancs.
5. **A `main` kérdés a `marveen-private`-on** — vagy létrehozni és átállítani a defaultot, vagy kimondani, hogy a `develop` marad a mainline, és a 08-13-i riport zárófejezetét felülírni. A mai állapot a legrosszabb: egy lezárt riport egy nem létező ágra hivatkozik.
6. **12 halott ág törlése** (5.2). Ez az, ami a két valódi merge-et láthatóvá teszi.

**Utána:**

7. **Lean-opt A blokk:** vagy be kell fejezni (áthelyezés `sendPromptToSession`-be, `gate-health` végpont, wiring-teszt), vagy az as-built dokumentumot kell a valósághoz igazítani. A kettő közül a második az olcsóbb és azonnal őszintébb; az elsőt a CI (3. pont) után érdemes.
8. **`cos-acceptance.py`: FAIL → ERROR**, ahol az előfeltétel hiányzik (4.4). Három sor, és visszaadja a gate saját vokabuláriumának a jelentését.
9. **E.1/E.2/E.5 kártyák:** végigolvasni az acceptance-pontjaikat, és megnézni, fedi-e őket a `progression-pipeline.ts` 3./4./6. stage-e. Ha igen — a kártyák lezárása helyes, csak a modulnevek elavultak. Ha nem — az a maradék a valódi lyuk.
10. **`marveen-suite` PR-triázs**, #18-cal kezdve (P0 GDPR, 25 nap), majd #13/#14 (a két kapu, ami a többit védené).
11. **APG §18 kockázati profil** — a következő érdemi fejlesztési tétel, négy blokkot old egyszerre.

*(A korábbi 12. tétel — a CostOps scope-doksi mondata — törölve: a javítás már a `develop`-on van, lásd 4.2.)*

---

## 9. Az összevetés a Marveen-összefoglalóval

**Amit egymástól függetlenül ugyanúgy mértünk:**

| Állítás | Státusz |
|---|---|
| Az E.1/E.2/E.5 kód nincs a `develop`-on | **Megerősítve, erősebben** — egyetlen ref-en sem, soha nem is volt, és a kártyaszámok sem szerepelnek sehol |
| Halott, mergelt ágak rejtik a valódi hiányt | **Megerősítve** — 12 ág a két repóban, nulla egyedi fájllal |
| CostOps él, merge-adóssága nincs; a budget-riasztás nem tüzelhetett | Megerősítve (a szerkezeti része) |
| APG: a legtöbb kód, a legnagyobb kockázat, három keresztmetsző blokkoló | Megerősítve |
| A lean-opt 1. fázis kapuja bizonyítói nélkül fut | Megerősítve |
| CoS a legérettebb; a `suite` PR-jei ~25 napja állnak | Megerősítve (öt régi PR + egy mai = hat) |
| `releases/` + gitignore | Megerősítve, de szűkítve — lásd lent |

**Ahol pontosítanék:**

1. **A „hat halott CostOps-ág" nevei nem léteznek a remote-okon.** `pr/costops-ui-command-center` és `rb/costops-660` egyik repóban sincs. A jelenség valós, de a remote-okon **12 másik ágon** jelentkezik. Ha a nevezett ágak lokálisak, akkor a takarítás fele lokális művelet — és a távoli 12-ről külön kell dönteni.

2. **A `releases/` lelet szűkebb, mint ahogy hangzik.** A minta szándékos (`d3f9fd90`), van sync-szkript, és négy pinnelt fájlból három git-ben van. **Pontosan egy fájl** — `dispatch-guard.sh` — az, aminek sehol nincs forrása. Ez egy `git add`, nem egy architekturális probléma. A különbség számít, mert az első cselekvést hív, a második vitát.

3. **A „WP1–6 kész" félrevezető rövidítés.** A saját as-built-ja mind a nyolc csomagnál `nem`-et ír az „Exit-kód igényelhető?" oszlopba. „Leszállítva" ≠ „elfogadva", és a §34 acceptance-mintát még nem futtatták le. Az 1.9-es szerkezetátalakítás egésze erről a különbségről szól — kár elveszíteni az összefoglalóban.

**Amit hozzáteszek (az összefoglalóban nem szerepel):**

4. **Nulla CI két repóban** (2.2). Ez a keret, amiben a többi lelet keletkezik: nincs hely, ahol az „öt munkafolyamat zöld" állítás megkérdőjeleződhetne. Nem is véletlen, hogy a legélesebb leletek mind ugyanazt a formát öltik.

5. **A kernel `main` ága futtathatatlan** (2.1). 504 teszt, 133 törés, bedrótozott `/home/iszzu/...` utak — miközben a javítás (1066 zöld) az ágon van. Ez a legerősebb egyetlen érv a merge mellett, és nem dokumentumból jön, hanem két parancsból.

6. **A merge-sorrend kényszerített** (3.1). Ha a kernel megy előre egyedül, a `develop` szvitje pirosra vált egy nem létező szerződéssértésért. A hibás parser hamis zöldet is tud adni. Ez a legkonkrétabb „részletek közötti összefüggés" a mai anyagban.

7. **A `marveen-private`-on nincs `main` ág** (5.1). A 08-13-i riport azt írja, létrehozta; a remote-on nincs. A kernelnél ugyanez a lépés sikerült. Egy lezárt riport zárófejezete ma egy nem létező ágra hivatkozik.

8. **A lean-opt as-built három állításából egy sem igaz a `develop`-on** (4.3) — nem csak a tesztek hiányoznak, hanem az áthelyezés és a health-végpont is.

9. **A `cos-acceptance.py` ugyanarra a hiányzó előfeltételre hol ERROR-t, hol FAIL-t ad** (4.4). A szvit, ami a „No Silent Unknown" szabályt hordozza, lefelé sérti meg — hamis pirossal.

10. **Az E.1/E.2/E.5 kérdésre van olvasásból adódó válasz** (4.5). A pipeline stage-listája a planner-, controller- és eszkalációs szerepet is tartalmazza. A valószínű igazság nem „három kártya hazudik", hanem „három kártya elavult modulneveket nevez meg". Ez ellenőrizhető, és sokkal olcsóbb, mint újraépíteni.
