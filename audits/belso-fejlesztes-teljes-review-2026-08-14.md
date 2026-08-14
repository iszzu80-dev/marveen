# Belső fejlesztések: teljes funkcionális és minőségi review

**Dátum:** 2026-08-14 · **Készítette:** Marveen · **Hatókör:** CostOps, APG 1.9, Lean optimalizálás, CoS (privát + ZST), autonóm ügy-progresszió

Minden állítás mögött mérés van, és a mérés módja is le van írva. Ahol nem mértem, ott az szerepel, hogy nem mértem.

---

## 0. Verdikt

**Az öt munkafolyamat mindegyikének működő magja van. Négynél a legfrissebb munka a futó rendszeren KÍVÜL áll.**

Nem kapacitás-probléma és nem minőségi probléma: a kód, amit az elmúlt héten építettünk, jó. A probléma a **leszállítás**. Három különböző igazság él egymás mellett, és a kártyán csak az első látszik:

1. a kártya **done**,
2. a kód **be van mergelve** a default ágba,
3. a kód **fut** az élő rendszerben.

Ma mind a háromra találtam ellenpéldát, ugyanabban a kódbázisban.

A második, ennél kellemetlenebb minta: **a zöld nem ott van, ahol a kockázat**. Ma három olyan ellenőrzés akadt, ami átment, miközben semmit nem mért (részletek a 6. szakaszban).

---

## 1. Repó-térkép és merge-állapot

| Repó | Távoli | Default | Állapot |
|---|---|---|---|
| `~/marveen` | `origin` = Szotasz/marveen (hivatalos), `fork` = iszzu80-dev/marveen, **`private` = iszzu80-dev/marveen-private** | `private/develop` | **a helyi `develop` 8 committal a `private/develop` ELŐTT** |
| `~/marveen-suite` | `origin` = iszzu80-dev/marveen-suite | `main` | 11 ág nyitott munkával, 6 nyitott PR |
| `~/marveen-local/apg-kernel` | `origin` = iszzu80-dev/marveen-apg-kernel | `main` | **13 commit a `main` előtt**, a teljes 1.9 a `main`-en KÍVÜL |
| `~/marveen-costops-slices` | a fork klónja | — | munkakönyvtár, nem önálló termék |

Ezen felül **32 git worktree** él a gépen.

### Amit ma merge-elni kell

1. **`~/marveen`: a helyi `develop` push-olva nincs.** A mai merge (`ea6472a`, a CoS kalibráció + APG 1.9 összehozása) csak ezen a gépen létezik. Amíg nincs a `private`-on, egyetlen review-zó sem látja, és egy gépvesztés viszi.
2. **`apg-kernel`: az egész APG 1.9 a `main`-en kívül.** A `live_ingest.py` — az a fájl, amiben ma valós hiba volt — a `main`-ben **nem létezik**. Aki a `main`-t reviewzza, a hibás kódot sem látja.
3. **`marveen-suite`: öt PR 2026-07-18 és 07-20 óta nyitva**, köztük GDPR-tételek (#18 `pool_active` P0, #13 RLS-linter). Huszonöt nap.

### Amit NEM kell merge-elni (és ez a nagyobbik felfedezés)

Hat CostOps-ág — `pr/costops-ui-command-center` (17 commit), `rb/costops-660` (16), `upstream/costops-pr-f-ui-command-center` (12), `costops-rebased` (11), `rb/costops-prb` (11), `upstream/costops-pr-b-forecast-fx` (8) — **patch-id szerint mind „unmerged"-nek látszik, de egyetlen olyan fájlt sem tartalmaznak, ami a `develop`-en ne lenne meg.** Ugyanaz a 16-commites verem hat rebase-elt másolatban; a tartalom más úton már landolt.

```
develop costops-fájljai:                    202
pr/costops-ui-command-center costops-fájljai: 95
csak az ágon létező fájl:                     0
```

Ez nem ártalmatlan: hat halott ág **elrejti a négy valódi hiányt** (lásd 5. szakasz). Törlendők.

---

## 2. CostOps

**Állapot: él, és ez az egyetlen munkafolyamat, aminek nincs merge-adóssága.**

- Élő: `marveen-costops-sync.timer` naponta 06:15-kor futott ma is; a dashboard Costs oldala kiszolgál.
- Adat: `cost_sources` 18, `cost_line_items` 29, `provider_balance_snapshots` 341, `provider_ratelimit_snapshots` 325, `costops_reliability_snapshots` 139, `costops_alerts` 29, `costops_recommendations` 1.
- Kód: 202 fájl a `develop`-en, collector-keret öt providerrel (anthropic, openai, deepseek, codex, github, render).

**Két üres tábla, ami funkcionális hiányt jelöl, nem hibát:**

- `costops_invoices` = **0 sor**, pedig van `costops-szamla-ingest` ütemezett feladat és van invoice-ingest skill. A valós számla-út tehát soha nem termelt sort: minden költség becslés vagy manuális.
- `budgets` = **0 sor**, `costops_budget_audit` = 0. A költségvetés-funkció megépült, de nincs beállított költségvetés, tehát a túllépés-riasztás soha nem tüzelhetett.

**Nyitott kártya:** `48a3dcae` (waiting, high, 2026-07-29) — a PR-verem rebase-e a hivatalos develop-ra. A fentiek fényében ez a kártya valószínűleg tárgytalan; ellenőrzés után zárandó.

---

## 3. APG 1.9

**Állapot: a legtöbb új kód, a legnagyobb kockázat, és ma ez adta az egyetlen valódi termelési hibát.**

A csomagonkénti önértékelés (`audits/wp1-wp8-as-built-2026-08-13.md`) őszinte, és a mérésem megerősíti:

| WP | Állapot |
|---|---|
| WP1 Executable Verification Foundation | leszállítva (13/13) |
| WP2 Product Identity + Currentness | leszállítva (5/5) |
| WP3 Execution Identity + Provenance | leszállítva, humán principal nélkül |
| WP4 Context Router + Fresh Verifier | leszállítva, §12.4 nem feloldva |
| WP5 Change Runner | leszállítva |
| WP6 Kanban + Dispatch | leszállítva |
| WP7 Safe Delivery | **részleges** — kontraktusok igen, deploy nem |
| WP8 Product LCM Closed Loop | **nem kezdve** |

Három keresztmetsző blokkoló, mindegyik négy helyen üt: **a §18 kockázati profil nem létezik**, **a hitelesített emberi principal nincs meg**, és **a WP8 hurok négy tagja üres**.

### A mai nap, sorrendben

| Idő | Esemény |
|---|---|
| 01:13:03 | dashboard restart, a feed élesítve |
| 01:13:06 | `NO_SOURCE` — indulási versenyhelyzet |
| 02:13 – 09:13 | **nyolc egymást követő órás futás**: 230 tétel látva, 0 beemelve, 230 elbukva |
| 02:25 | a hiba megtalálva: `live_ingest.py:718` rossz import-csomag |
| 09:12 | javító commit (`97a5912`) |
| 10:05 | a javítás lemezen, függetlenül verifikálva (RED-bizonyítással) |
| 10:21:58 | első futás `OK` státusszal — **és a zöld hamis** |
| 10:55 | a feed leállítva tulajdonosi utasításra |
| 11:40 | a leállítás **mérve**: nincs új futás, az envelope-szám változatlan |

**Sebesség (a §29 KPI első valós adata): 6 óra 47 perc a megtalálástól a javító commitig, 7 óra 40 perc a futó rendszerig.**

### A hamis zöld anatómiája (kártya `3cde1e16`, urgent)

A run sor: `OK`, `FEED_COMPLETED`, 230 látva, 230 eligible, `items_ingested = 1 467 755`.
A tároló: 6735 envelope-sor, **356 egyedi `envelope_id`**, ebből egyetlen azonosító alatt 6380 sor, aminek a `source_event_id`-je a `"None"` **string**.

Az aritmetika pontos: `230 × 6380 + 355 = 1 467 755`.

Két ok, két rétegben:
1. **Tervezési:** egy egykártyás pilot belépési pont került kártyánkénti ciklusba, így a nem-kártya-hatókörű forrásokat (token-usage, és a teljes kanban-tábla) minden munkatételnél újraolvassuk.
2. **Azonosító:** `a1_pilot.py:491` a `row.get("rowid")`-ból építi az envelope identitását, de a `token_usage.id` `INTEGER PRIMARY KEY`, azaz a rowid **aliasa** — ezért a `SELECT rowid, id, …` egyetlen oszlopot ad `id` néven, és a dict-ben soha nincs `rowid` kulcs. Élőben reprodukálva: `row.get("rowid") is None`, `row.get("id") == 171181`. **Nem telepített-kód eltérés**: egyetlen `token_usage_source.py` van a gépen, és egyezik a `HEAD`-del.

Downstream kár: a `has_ingested_evidence` `True`-t ad az `5ef97220` kártyára, tehát az **hamisan ELIGIBLE**, valaki más token-költése alapján.

> **KORREKCIÓ (Marveen, 2026-08-15 02:00, mérve a live store-on).** A `True` igaz,
> **az indoklás nem áll.** Az `5ef97220` korrelációnak van **2 valódi
> `kanban_card_event` ACCEPTED sora** is a 6380 `token_usage` mellett, tehát a
> jogosultság a hibás sorok **nélkül is állna** — nem idegen token-költés tartja
> életben. Ellenkontroll az egész táblára: **nincs egyetlen** olyan korreláció sem,
> amit kizárólag `source_event_id = 'None'` sorok tartanának `ACCEPTED`-ben.
> A `reconstruct_live` szintén nem használja ezeket a sorokat (a `token_usage` a
> `LIVE_LINK_POLICY` egyetlen `qualifying` és `excluded` halmazában sem szerepel);
> a valódi függvényt lefuttatva a linkek: change/work_item PRESENT (a 2 kanban-sorból),
> implementation/test/build MISSING, deployment/runtime UNKNOWN.
> Az eredeti mondat szándékosan marad a helyén, hogy látszódjon, mit hittünk és mi
> volt a baj vele. Részletek: `~/marveen-local/apg-kernel/audits/errata-6380-token-usage-envelopes-2026-08-15.md`.

**Kapcsolódó hiány (kártya `54c27163`):** a 230 látva / 0 beemelve nyolc órán át `PARTIAL` maradt, és semmi nem riasztott. Ugyanaz a szó fedi az egy elbukott tételt és a 100%-os bukást.

---

## 4. Lean optimalizálás

**Állapot: a 2. fázis teljes egészében landolt; az 1. fázis kapuja ÉL, de a rögzítő tesztjei nem.**

- `feat/lean-opt-phase2-p2a`, `-p2b`, `-p2c`, `-stamp`: mind **0 unmerged commit** — bent van.
- `src/data-sensitivity-gate.ts`, `src/web/data-sensitivity-gate-runner.ts` és a `message-router` bekötés a `develop`-en **van**.
- `feat/lean-opt-phase1-gate`: **3 commit kint**, és pont a bizonyító réteg:
  - `data-sensitivity-gate-canary.test.ts`
  - `data-sensitivity-gate-no-dispatch.test.ts`
  - `data-sensitivity-gate-wiring.test.ts`
  - `config-examples/provider-trust-map.example.json`

Vagyis **egy élő biztonsági kapu fut a rögzítő tesztjei nélkül**. A kapu ma helyesen viselkedhet, és holnap egy refaktor csendben kiveheti a bekötésből — pontosan az a hiba, amit a `wiring` teszt kizárna.

**Nyitott kártya:** `a6a7dd66` (planned, normal, 2026-08-11) — „a vészleállító rossz irányba hazudik" (O-2) plusz három kisebb tétel. Egy vészleállító, ami rossz irányba téved, magasabb prioritást érdemel, mint amilyet kapott.

---

## 5. CoS — privát és céges

**Állapot: ez a legérettebb munkafolyamat. Mérőszáma van, és a mérőszám majdnem tiszta.**

`scripts/cos-acceptance.py`: **34 PASS, 1 FAIL.**

Az egyetlen bukás **nem kódhiány**:

```
[FAIL] WF-2  §21, §25/(4) legalább egy valós, többnapos kampány lezárult
             4 kampány összesen, 0 lezárt többnapos
```

Ez bizonyíték-hiány: a gépezet kész, de még nem futott végig rajta egy valódi, több napig tartó ügy.

- **Ciklus:** tízpercenként fut, ma egész nap `problems: []`.
- **Karbantartás:** éjjel lefutott, titkosított mentés integritás-ellenőrzéssel és 74 ügyes visszaállítási próbával.
- **Kalibráció (v1.4.2):** a befagyasztás kapuvá lett, a ledger `store/cos-ledger.db`, obs 1 rögzítve 10:07-kor, ujjlenyomat `e996087b…` (21 fájl, 4 deklarált infrastruktúra-kivétel, tranzitív zárás ellenőrizve). A fagyás az **első cselekvést igénylő levélre** vár, nem órára.
- **ZST namespace:** 4 ügy, **mind `WAITING_EXTERNAL`** — üzletrész-adásvétel, Panostól bekért adatok, Deepseek-számla kétszer. A céges oldal tehát él, de minden szál a külvilágra vár, tehát a motor nem dolgozik rajta.
- **Személyes namespace:** 40 nyitott ügy, 9 döntésre vár, 12 lejár 48 órán belül, 3 figyelmet igényel.

**Megjegyzés a ZST-ről:** négy ügy mind ugyanabban az állapotban azt is jelentheti, hogy a `WAITING_EXTERNAL` a rendszer alapértelmezett nyugvópontja, nem valódi megkülönböztetés. Érdemes megnézni, van-e olyan út, ami ebből az állapotból magától kimozdít.

---

## 6. Autonóm ügy-progresszió

**Állapot: az élő motor működik, DE három lezárt checkpoint kódja nincs a default ágon.**

A `develop` 12 progresszió-modult tartalmaz (`pipeline`, `eval`, `resolver`, `scheduler`, `trigger`, `heartbeat`, `completion`, `quality`, `interpreter`, `events`, `migrate`, `seed`), és ezek futnak.

**Ami hiányzik — és a kártyája mégis `done`:**

| Kártya | Cím | Kártya-státusz | Kód a `develop`-en |
|---|---|---|---|
| `1ef39b00` | Checkpoint E.1 — rolling planner + next-best-action | **done** (08-08) | `progression-planner.ts` **nincs** |
| `ff0ee545` | Checkpoint E.2 — Progression Controller | **done** (08-08) | `progression-controller.ts` **nincs** |
| `59c06cbc` | Checkpoint E.5 — strukturált eszkaláció | **done** (08-08) | `progression-escalation.ts` **nincs** |

A kód a `cos-gate0-eval-89c5e317` és `cos-e5-escalation` ágakon él, **hat napja**. A `develop`-en egyetlen hivatkozás sincs rájuk, tehát nem is „ott van más néven".

Két lehetőség van, és a különbség számít:
- **vagy** ezeket a `develop` újabb, §-számozott implementációja leváltotta, és akkor a kártyák jogosan `done`-ok, de az ágak törlendők és ezt ki kell mondani;
- **vagy** nem, és akkor három lezárt kártya olyan funkciót állít késznek, ami nem fut.

Ezt nem tudom eldönteni olvasásból — a két design-vonal (planner/controller vs. pipeline/eval/resolver) fedése tartalmi kérdés. **Ez az első számú eldöntendő tétel.**

---

## 7. Keresztmetsző minták

**(a) Három igazság, egy jelző.** A kártya `done`-ja nem mondja meg, hogy merge-elve van-e, és a merge nem mondja meg, hogy fut-e. Ma mindháromra van ellenpéldánk: E.1/E.2/E.5 (done, nincs mergelve), a mai CoS-merge (mergelve, nincs push-olva), a memória-monitor (fut, nincs verziókövetve).

**(b) Élő kód, követés nélkül.** A `marveen-memory-monitor.timer` húszmásodpercenként futtatja a `releases/monitor-current/memory-pressure-monitor.js`-t. A `releases/` **gitignore-olva van** (`.gitignore:14`), a `develop`-en **nulla** release-fájl van. Egy fail-closed indítási kapu fut úgy, hogy a forrása csak ezen a gépen létezik — és a `pr/memory-pressure-monitor` ág, ami be akarja tenni, pont olyan fájlokat ad hozzá, amiket a gitignore kizár. Ugyanez a minta az APG 1.9-nél egy szinttel nagyobban: a futó kód nincs a `main`-en.

**(c) Zöld, ami nem mér.** Három példa egyetlen napból:
- a feed `OK` státusza 6380 hamis identitású sor mellett;
- a saját zártsági ellenőrzésem, ami **egyetlen importot sem oldott fel** (ESM `./x.js` specifikátorok), és a nulla találatot bizonyítéknak olvastam;
- a builder záró-ellenőrzése, amin mutáció-teszttel kiderült, hogy elrontott regexszel is **hatból öt teszt zöld marad**.

Mindhárom ugyanaz: a hiányra épülő állítás akkor is átmegy, ha a műszer nem mér. Amit ebből érdemes szabállyá tenni: **minden zártsági/hiány-ellenőrzés első asszertje az legyen, hogy a műszer talált valamit.**

**(d) Halott ágak, amik elrejtik az élőket.** Hat superseded CostOps-ág mellett négy valódi hiány áll (E.1/E.2, E.5, lean-opt tesztek, memória-monitor). Ránézésre megkülönböztethetetlenek.

**(e) Nem kódhiány, hanem használat-hiány.** A CoS egyetlen bukása egy le nem zárt kampány; az APG WP8-hoz élő deploy-cél kell; a CostOps-nak nincs egyetlen valós számlája és egyetlen költségvetése sem. Mindhárom rendszer megvárja, hogy valaki tényleg használja.

---

## 8. Amit el kell döntened

| # | Döntés | Miért most |
|---|---|---|
| 1 | **E.1/E.2/E.5: leváltva vagy elmaradva?** | Három `done` kártya áll vagy bukik rajta |
| 2 | A helyi `develop` push-olható a `private`-ra? | A mai merge egy gépvesztésre van a semmitől |
| 3 | A hat superseded CostOps-ág törölhető? | A zaj elrejti a valódi hiányokat |
| 4 | A lean-opt 1. fázis három tesztje mehet be? | Élő biztonsági kapu rögzítés nélkül |
| 5 | A memória-monitor forrása verziókövetésbe kerüljön? | Ma csak ezen a gépen létezik |
| 6 | Az APG 1.9 vissza-merge-elhető a kernel `main`-be? | A reviewzó ma nem látja a futó kódot |
| 7 | A suite öt régi PR-je landoljon vagy záruljon? | Huszonöt napja nyitott GDPR-tételek |
| 8 | A feed visszakapcsolása | A beolvasás-számláló teszt megvan; a futás utáni ellenőrzés az `5ef97220` eligibility-jén dől el |

---

## 9. Sorrend, amit javaslok

1. **Döntés az E.1/E.2/E.5-ről** (1) — ez a legolcsóbb és a legnagyobb bizonytalanságot oldja.
2. **Push + a három lean-opt teszt** (2, 4) — percek, és két „élő, de nem bizonyított" tételt zár.
3. **Feed vissza, majd az első ciklus után az `5ef97220` ellenőrzése** (8).
4. **APG vissza-merge és a suite PR-ek** (6, 7) — mindkettő láthatósági adósság.
5. **Ág-takarítás** (3) és a monitor-forrás rendezése (5).

A WP8-at, a §18 kockázati profilt és a humán principalt szándékosan hagytam a végére: azok termék-döntések, nem karbantartás.
