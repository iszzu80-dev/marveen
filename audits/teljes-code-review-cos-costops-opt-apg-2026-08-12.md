# Teljes code review — COS (personal + céges + autonómia), CostOps, Lean Optimization, APG

**Alap:** `marveen-private` `develop` @ `2d3c662` · `marveen-apg-kernel` @ `1ae89c8` (`wp1-slice1-executor-registry`)
**Előzmények:** COS #1–#6, lean-opt/CostOps #1–#2, APG 0.4 (+ kernel) — összesen kilenc korábbi review.
**Specifikációk:** COS v4.2.1 · progression v1.3.1 · `docs/optimization/optimization-dashboard-implementation-spec.md` (§1–§27) · `docs/costops/core-functional-scope-v1.0.1.md` (§1–§23) · `docs/apg/apg-0.4-lean-ui-integration-spec.md` · `design/apg-v0.4-pilot-kernel-implementation-spec.md`

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run` (teljes) | **5893/5901 zöld, 473 fájlból 4 piros** — hármat lásd K-1, egy a review körén kívül |
| COS: az #6 kör négy találása | **H-1, H-2, H-3 javítva; H-4 részben** |
| COS: az #5 kör öt találása | **Ö-1 fele lezárva a javasolt módon; Ö-2, Ö-3, Ö-4, Ö-5 javítva** |
| Optimization: az #2 kör négy találása | **Ó-2 javítva; Ó-1, Ó-3, Ó-4 változatlan** |
| Optimization: az #1 kör tíz találása | **O-1, O-2, O-7 javítva; hét változatlan → NO-GO** |
| CostOps: C-1..C-7 | **mind a hét változatlan** (egy másik, valódi javítás mellett) |
| APG 0.4: F-1..F-16 | **F-3, F-5, F-6, F-8, F-9, F-10 javítva; tíz nyitva** |
| APG kernel: K-1..K-3 | **változatlan** |
| Új találás ebben a körben | **7** (T-1..T-5, K-1, A-1) |

---

## 0. Rövid álláspont

Ez a legnagyobb remediációs kör a kilenc review alatt, és a COS-oldalon **kiváló**. A válasz-út, amit az #6 körben három egymás utáni ajtóval nem működőnek mértem — nincs hívó, nincs `source_reference`, és nem ébreszti fel az ügyet —, ma végigmegy: saját Telegram-bot, kimenő sor, bejövő poll, `progression_run_id` a kérdés mellett, `last_event_id` + `updated_at` az ügyön. Mind a három ajtót maguk találták meg, élesben, egymás után, és a kommentek megnevezik az órát is.

Két dolgot érdemes külön kimondani, mert ritkák:

1. **A mis-attribúciós incidenst nem elrejtették, hanem szabállyá tették.** 16:40-kor a Wizz Air-válasz a NAV-ügyre került, mert a szabály „a legfrissebb nyitott kérdés" volt. A javítás nem egy jobb tipp, hanem az, hogy **a többértelműséget jelenti, nem oldja fel**. Egy rendszer, ami megtanulja, hogy a rossz válasz rosszabb a semmilyennél, ritka.
2. **A CostOps-oldali `0020533` a nap fordítottja:** kilenc komment azt állította, hogy öt modul nincs bekötve, közben mind az öt élt — és egy felhasználónak látszó mező (`sync_cadence`) épült a hazugságra. A javítás nem egy jobb komment, hanem a `buildCollectorPlan()` mint egyetlen igazságforrás.

Ami viszont ebben a körben is előjött, **ugyanabban a modulban, ugyanabban a ciklusban**:

- **T-1 (P1):** a `goal-enrichment`-ben megtalálták és megjavították azt a hibát, hogy a ZST vokabulárium a personal coercerrel HIGHLY_SENSITIVE-re lapul — és a modult, ahonnan a `routeFor`-t **szó szerint átmásolták** (`reader-cycle.ts`), nem nézték meg. Ott ma is lapul: **a teljes céges domain minden ügye HIGHLY_SENSITIVE-nek minősül adathiányból, nem tartalomból.** Visszamérve.
- **T-2 (P1):** a bejövő poll ciklusában a „visszakérdezés nem válasz" ág **eldobja Istvan szavait** — miközben három sorral lejjebb a többértelműségi ág pontosan az ellenkezőjét csinálja, azzal a kommenttel, hogy „HOLD THE WORDS, not just the count". Hét realisztikus magyar válaszból hatot eldob. Visszamérve.
- **T-3 (P2):** a visszatartott üzeneteknek (`cos_channel_held`) **nincs olvasójuk**: a szavak megmaradnak egy táblában, amit semmi nem kérdez le, és Istvan nem kap visszajelzést arról, hogy nem értették.

---

# I. COS — personal, céges és az autonómia

## I.1 A #6 kör négy találása

| # | Találás | Állapot | Bizonyíték |
|---|---|---|---|
| **H-1** | A válasz-útnak nincs ajtaja | **JAVÍTVA** | `scripts/cos-channel-poll.ts:79` hívja a `recordOwnerAnswer`-t; a lépés a ciklusban van (`scripts/cos-cycle.ts:41`) |
| **H-2** | A válasz-esemény `source_reference` nélkül íródik | **JAVÍTVA, és két további ajtóval együtt** | lásd I.2 |
| **H-3** | „István" ékezettel nem `ISTVAN` | **JAVÍTVA** | `owner-question.ts:41,64` `foldName(...)`, mindkét összehasonlításban |
| **H-4** | A válasz-út domain-vak | **RÉSZBEN** | a hívó ma a `matchAnswerTarget` sorából veszi a domaint, tehát a gyakorlatban helyes — de a `recordOwnerAnswer` nyitott-kérdés lekérdezése és `UPDATE`-je (`:495-505`, `:514`) továbbra is `WHERE case_id = ?`, domain nélkül, és a `cos_owner_questions` PK-jában sincs benne |

## I.2 A válasz-út — három ajtó, mindhárom megtalálva

Ez a kör legjobb munkája, és a módszer benne a lényeg. Az #6 kör után **egy** hibát jelentettem (`source_reference`); a javítás közben **kettő továbbit** találtak, élesben, húsz perc különbséggel:

| ajtó | mit csinált | bizonyíték |
|---|---|---|
| `source_reference` | a `consumeOwnerAnswer` avultnak minősítette és eldobta | `owner-question.ts:533` most beírja `open.progression_run_id`-ből |
| `last_event_id` | **nulla ügyön 106-ból** volt beállítva, író nem is volt — tehát egy csak-eseményes változás nem tette futásra jogosulttá az ügyet | `:576` |
| `updated_at` | a Reader avultsági őre a 08:32-es olvasathoz hasonlított egy 18:10-es választ, és az ügysor két napja nem mozdult | `:577`, ugyanabban az `UPDATE`-ben |

A `last_event_id` beállítása **szándékosan itt** történik, nem a közös esemény-hozzáfűzőben: „a motor a futása közben maga is ír eseményeket, tehát minden eseményre ébreszteni azt jelentené, hogy minden futás ütemezi a következőt". Ez a fajta önkorlátozás — megnevezni, mi a helyes általános szabály, és nem azt implementálni nyomás alatt — ismétlődő minta ebben a körben, és jó.

**Ellenőriztem a végpontokat is:** a kérdés írása (`askPendingOwnerQuestions`) és a kiküldése (`scripts/cos-channel-send.ts`) **szándékosan két lépés**, „mert egybeolvasztva egy kézbesítési hiba úgy nézne ki, mint »nincs mit kérdezni«". A kimenő sor minden konfigurált csatornát ürít, nem csak azt, amelyikre a kérdések mennek — a harmadik (radar-) bot különben egy soha nem ürített sor mögé került volna.

## I.3 Új találások

### T-1 · P1 · A céges (ZST) vokabulárium a Reader kapujában HIGHLY_SENSITIVE-re lapul

**Amit mértem.** `reader-cycle.ts:47-54` `contextSensitivity` a **personal** `effectiveSensitivity`-t hívja minden kontextus-elemre. Egy ZST-ügynél az elemek `sensitivity` mezője a `zst_cases` saját vokabuláriumából jön (`ZST_INTERNAL`, `ZST_FINANCIAL`, …), amit a personal `coerceSensitivity` nem ismer → fail-closed `HIGHLY_SENSITIVE`. A saját moduljaikkal lefuttatva:

```
zst_cases.sensitivity=PUBLIC             -> a Reader tierje: PUBLIC             | deepseek mehet: IGEN
zst_cases.sensitivity=ZST_INTERNAL       -> a Reader tierje: HIGHLY_SENSITIVE   | deepseek mehet: NEM
zst_cases.sensitivity=ZST_CONFIDENTIAL   -> a Reader tierje: HIGHLY_SENSITIVE   | deepseek mehet: NEM
zst_cases.sensitivity=ZST_FINANCIAL      -> a Reader tierje: HIGHLY_SENSITIVE   | deepseek mehet: NEM
zst_cases.sensitivity=ZST_LEGAL          -> a Reader tierje: HIGHLY_SENSITIVE   | deepseek mehet: NEM
zst_cases.sensitivity=ZST_PERSONAL_DATA  -> a Reader tierje: HIGHLY_SENSITIVE   | deepseek mehet: NEM
zst_cases.sensitivity=ZST_HIGHLY_SENSITIVE -> a Reader tierje: HIGHLY_SENSITIVE | deepseek mehet: NEM
zst_cases.sensitivity=UNKNOWN            -> a Reader tierje: HIGHLY_SENSITIVE   | deepseek mehet: NEM
```

**Miért ez a legfontosabb új találás.** Nem azért, mert veszélyes — fail-closed irányba téved —, hanem azért, mert **ugyanezt a hibát ebben a körben megtalálták és megjavították a testvér-modulban**, és a javítás kommentje szó szerint ezt írja:

> „My first version of this gate did exactly that and would have silently stopped all corporate enrichment; a pre-existing test (»covers the corporate namespace too«) caught it."
> — `goal-enrichment.ts:122-135`, a `tierFor()` fölött

És a mellette álló `routeFor` kommentje: *„Byte-for-byte the Reader's rule (reader-cycle routeFor)."* Az útválasztást átmásolták; a vokabuláriumot nem hozták vissza.

Három következmény:

1. **Költség.** Minden céges ügy a kontraktált (drága) útra megy, a saját politikájuk szerint is fölöslegesen: a `tierFor` leképzése szerint `ZST_INTERNAL` a hétköznapi tier, ami PERSONAL-ként az olcsó utat is használhatná.
2. **Hamis indoklás.** Egy blokkolt `ZST_INTERNAL` ügy tárolt `refusal_reason`-je azt mondaná: „§10: HIGHLY_SENSITIVE content needs a provider cleared for it" — **állítás a tartalomról, ami nem igaz**. A rendszer egyik legjobb tulajdonsága, hogy a visszautasításai megmondják az okot; itt az ok téves.
3. **Egyetlen ponton múló céges leállás.** Ha az Anthropic- és OpenAI-kulcs is kiesik, a `general` (deepseek) útvonal a **teljes céges domaint** `SENSITIVITY_BLOCKED`-ba viszi, miközben a `PUBLIC`-on kívül semmi nem indokolná.

**Javaslat.** A `goal-enrichment.ts:136-142` `tierFor` már megírva, tesztelve és tulajdonosi politikára hivatkozva létezik. Emelni kell közös helyre (`provider-data-policy.ts` vagy `sensitivity.ts`), és a `contextSensitivity`-nek domaint kell kapnia. Plusz egy standing check, ami a két útvonal tier-számítását **ugyanarra a bemenetre** hasonlítja össze — a másolás ténye maga a bizonyíték, hogy erre szükség van.

---

### T-2 · P1 · A „visszakérdezés nem válasz" ág eldobja Istvan szavait

**Amit a kód mond.** `scripts/cos-channel-poll.ts:57`:

```ts
if (looksLikeAQuestionBack(u.text)) { result.notAnAnswer++; continue }
```

Nincs `holdOwnerMessage`. A ciklus alján `writeOffset(highest + 1)` fut, és a modul saját kommentje mondja ki, mit jelent ez: *„Telegram drops an update once a higher offset is requested."* **A mondat elveszett.**

Három sorral lejjebb, a többértelműségi ágon ugyanez a helyzet helyesen van kezelve:

```ts
// HOLD THE WORDS, not just the count. The cursor moves below and Telegram
// will not serve this update again.
holdOwnerMessage(db, { ... })
```

Ugyanaz az érv, ugyanaz a ciklus, három sor különbség.

**És a szűrő tág.** `looksLikeAQuestionBack` (`cos-telegram.ts:213-222`) záró kérdőjelre vagy egy magyar/angol kérdőszó-kezdetre tüzel. Lefuttatva realisztikus válaszokon:

```
valasz   | Igen, mehet.
ELDOBVA  | Hogy őszinte legyek, inkább 12 milliót kérek.
ELDOBVA  | Mennyi az annyi, fizessük ki.
ELDOBVA  | Milyen jó, hogy szóltál — elfogadom az ajánlatot.
ELDOBVA  | Ki kell fizetni a szamlat.
ELDOBVA  | Rendben, de kerdezd meg az ugyvedet is?
ELDOBVA  | Van-e mas valasztas? Nincs. Menjunk bele.
```

Hétből hat. A `hogy`, a `ki`, a `mennyi` és a `milyen` a magyarban kötőszóként és határozóként legalább olyan gyakori, mint kérdőszóként.

**Amit külön ki kell mondani: maga a fail-closed döntés helyes.** A modul indoklása pontos — egy hamis `OWNER_DECISION` az append-only ügynyilvántartáson rosszabb, mint egy elmaradt válasz, és ez az ág egy valódi incidensből született (Istvan „Ez melyik számla?" kérdését a poller válaszként rögzítette és lezárta az ügyet). **Nem a döntés a hiba, hanem az elhelyezés:** aki visszautasít, annak meg kell tartania a szöveget, mint a szomszédos ág.

**Javaslat.** `holdOwnerMessage(..., reason: 'visszakerdezesnek tunt, nem valaszkent dolgoztuk fel')` ezen az ágon is — és megfontolandó az `unmatched` ágon is (ott ma sem hold, sem visszajelzés nincs). A szűrő szigorítása (csak záró kérdőjel, kérdőszó csak akkor, ha a mondat kérdőjelre végződik) külön, kisebb kérdés.

---

### T-3 · P2 · A visszatartott üzeneteknek nincs olvasójuk

`holdOwnerMessage` ír a `cos_channel_held` táblába. A táblát a teljes produkciós kódbázisban **semmi nem olvassa**: a `heldOwnerMessages` (`owner-question.ts:645`) exportált és teszten kívül nincs hívója, a `resolved_at` oszlopnak nincs írója, HTTP route és CLI sincs.

Ehhez jön, hogy a poll **nem válaszol Istvannak**: egy többértelműnek ítélt üzenetre nem megy vissza semmi. Az ő oldaláról a folyamat így néz ki: válaszol → nem történik semmi → nincs visszajelzés. A `ambiguous: N` számláló a ciklus JSON-jában van, a **mondat** sehol.

A modul saját kommentje meg is fogalmazza a hiányzó lépést — *„one needs a question back to him"* —, csak nem építette meg. Ez a hibaosztály hatodik-hetedik előfordulása, most a legfrissebb kódon: a mentés megvan, a felolvasás nincs.

**Javaslat.** A legolcsóbb változat egyetlen sor a `cos-channel-send.ts`-ben: a nyitott `cos_channel_held` sorokra menjen vissza egy rövid üzenet („ezt nem tudtam ügyhöz kötni: »…« — melyikre vonatkozik?"), és a válasz állítsa a `resolved_at`-ot. Ez egyszerre zárja a visszajelzés-hiányt és adja meg a tábla olvasóját.

---

### T-4 · P3 · A tulajdonos azonosítója be van drótozva a forrásba

`scripts/cos-channel-poll.ts:26`: `const OWNER_ID = '8942301795'`.

Ez az **engedélyezési határ** ezen az úton — a szkript saját fejléce mondja: „only the owner's own user id is accepted … an owner-answer is an authorisation-bearing act — it closes questions and writes OWNER_DECISION events onto cases". A `chatId` konfigból jön (`loadCosBotConfig`), a jogosult feladó azonosítója viszont nem. Ez ugyanaz a deployment-local érték a követett forrásban, amit az APG-review K-1-ként jelzett a kernelnél, és amit az optimization-spec §24 kifejezetten „deployment-local"-ként sorol fel.

Nem titok és nem sebezhetőség — de a jogosultsági szabály helye a config, nem a kód, és a következő telepítésnél ez az a sor, amit senki nem fog megtalálni.

---

### T-5 · P3 · `recordOwnerAnswer` domain-vaksága (H-4 maradéka)

A nyitott kérdés keresése és lezárása (`owner-question.ts:495-505`, `:514`) `WHERE case_id = ?` — domain nélkül; a `cos_owner_questions` elsődleges kulcsa `(case_id, question_hash)`. Ma a hívó a `matchAnswerTarget` sorából veszi a domaint, tehát helyes érték érkezik, és ez elfedi a rést. Egy második hívó (HTTP route, CLI) viszont ugyanígy nem lesz köteles helyeset küldeni, és rossz domain esetén a kérdés **lezárul, esemény nélkül** — a válasz eltűnik, a kérdés „megválaszoltnak" látszik.

## I.4 A #5 kör öt találása

| # | Találás | Állapot | Bizonyíték |
|---|---|---|---|
| **Ö-1** | A Reader kimenetét senki nem olvassa | **A javasolt első fele LEZÁRVA** | `progression-pipeline.ts:1201-1205` — `final_decision`, `decided_by`, `conflict_reason`, `confidence`, `created_at` a Mission Control projekcióban, `web/coscontrol.js`-ben kirakva. A `packet_id`-re kötött join a `created_at`-döntetlent is kezeli. A második fél (a döntés beengedése a pipeline-ba) helyesen marad §13.1 tulajdonosi kérdés — a komment ezt ki is mondja |
| **Ö-2** | A `goal-enrichment` kapu nélkül küld ki | **JAVÍTVA, és a személyes/céges vokabuláriummal együtt** | `goal-enrichment.ts:28,136-155` |
| **Ö-3** | Az `/api/cos/interpret-answer` nem látja a vaultot | **JAVÍTVA** | `routes/cos.ts:583` `resolveInterpreter(getSecret)` |
| **Ö-4** | Olvasatlan `profile` mező | **JAVÍTVA (törléssel)** | `interpreter-provider.ts:40` — „There used to be an `INTERPRETER_PROFILE` map…" |
| **Ö-5** | A standing checkek csak a `src/cos`-t pásztázzák | **JAVÍTVA** | `cos-gate-permit.test.ts:33` rekurzív bejárás |

## I.5 Az autonómia — amit a spec felől nézve mérni lehet

A §10.4 Writer, a válasz-út és a csatorna-szétválasztás együtt **működő zárt hurkot** ad: olvasás → arbitráció → kérdés → kézbesítés → válasz → ébresztés → újraolvasás. Ez hat kör alatt először igaz.

Ami az autonómiából **még nem** hurok:

- a `final_decision` továbbra sem hat a döntésre (Ö-1 második fele, tudatosan);
- a visszatartott és a visszakérdezésnek ítélt üzenetek nem térnek vissza Istvanhoz (T-2, T-3) — vagyis a hurok akkor szakad meg, amikor a válasz nem illeszkedik a sablonba;
- N-4 (`approval_version` = `campaign_version`, `approval-core.ts:354`) és N-5 (`setMode` hívó nélkül, `connector-health.ts:96`) változatlan.

---

# II. LEAN OPTIMIZATION

| # | Találás | Állapot |
|---|---|---|
| **Ó-2** | A propagáció hibája teljes írás-hibaként jelentődött | **JAVÍTVA, jól** — `optimization-config.ts:278-302` `routingFlagPropagated: boolean \| null` + `propagationNote`, saját `try`-ral, és a propagáció injektálható, hogy **mindkét** kimenet tesztelhető legyen |
| **Ó-1** | Push, nem pull: nincs kiegyenlítés | **VÁLTOZATLAN** — a `setCapacityRoutingEnabled` egyetlen hívója továbbra is a `writeOptimizationConfig` |
| **Ó-3** | A blokkoló-szövegek nem tudnak a mesterkapcsolóról | **VÁLTOZATLAN** — `optimization-summary.ts:222,242,282,354` |
| **Ó-4** | Uid-függő negatív teszt | **VÁLTOZATLAN** — nincs `getuid`-őr, és a teszt ebben a futásban is piros |
| O-3 | A `recommendations` GET ír | **VÁLTOZATLAN** |
| O-4 | Configváltozás nincs auditálva | **VÁLTOZATLAN** |
| O-5 | Érvénytelen dependency némán javítva | **VÁLTOZATLAN** |
| O-6 | Az optimistic concurrency opcionális | **VÁLTOZATLAN** |
| O-8, O-9, O-10 | szűrők, hatás-mezők, auto-frissítés | **VÁLTOZATLAN** |

**Verdikt a spec §27 szerint: `OPTIMIZATION DASHBOARD NO-GO`** — a §21 négy tétele („GET nem ír", „minden configváltozás auditált", „érvénytelen dependency nem menthető", „recommendation kártyából érthető … milyen hatás") továbbra sem teljesül. A kapcsolókra vonatkozó két tétel viszont — az #1 kör óta — teljesül.

---

# III. COSTOPS

**Változás a `dc11ca4` óta a C-találások körében: nincs.** Mind a hetet újra a kódból ellenőriztem:

| # | Állapot | Bizonyíték most |
|---|---|---|
| **C-1** | **VÁLTOZATLAN** | `grep -rn "checkPeriodWritable" src/costops/collectors/` → **0 találat**. A manuális utak (invoice, manual-entry, email-ingest) őrzöttek, az automatikus nem. **§23 AC-9** („Closed hónap nem változik csendben") |
| **C-2** | **VÁLTOZATLAN** | `'partial'`/`'rate_limited'` producere nincs; a `ledger.ts:728` viszont szűr rájuk. **§23 AC-12** |
| **C-3** | **VÁLTOZATLAN** | `collectors/runner.ts:16` — a hibaosztály a felfelé utazó kivétel alakjától függ |
| **C-4** | **VÁLTOZATLAN** | `rate_source`/`rate_date` sehol. **§23 AC-4** |
| **C-5, C-6, C-7** | **VÁLTOZATLAN** | a tesztek a valódi configot írják; a `.example` önjavító ág; 20 elnyelt `ALTER TABLE` |

**Ami viszont javult, és említést érdemel:** a `0020533` commit kilenc hazug kommentet javított — öt modul fejléce azt állította, hogy „not mounted anywhere", miközben a `schema.ts:116-129` mind az ötöt meghívja. És a hazugságra **egy felhasználónak látszó mező** épült: az `inventory.ts` a `sync_cadence`-t `manual | config_driven`-re drótozta egy 2026-07-15-ös „verified" komment alapján, ami azóta hamis — így a dashboard **minden automatikusan szinkronizált szolgáltatót kézinek mutatott**. A javítás a `buildCollectorPlan()`-t teszi egyetlen igazságforrássá, nem egy jobb kommentet ír.

Ez pontosan az a hibaosztály, amit a `sync_cadence` felől nem lehet észrevenni, csak a hívási lánc felől — és megtalálták.

---

# IV. APG

## IV.1 A 0.4 lean UI (marveen-private)

| # | Találás | Állapot | Bizonyíték |
|---|---|---|---|
| **F-3** | Az Aktivitás-végpont produkcióban mindig hibát ad | **JAVÍTVA** | a `globalThis.BetterSqlite3` várakozás helyett a már importált driver és a meglévő read-only nyitó |
| **F-5** | A döntési végpont kihagyja az önjóváhagyás-ellenőrzést | **JAVÍTVA, őszintén** | `routes/apg.ts:445-458` — és a komment kimondja, hogy ez best-effort, mert a `resolved_by` önbevallás és a flotta egy bearer tokenen osztozik |
| **F-6** | Négy kapcsolóból három semmit nem csinál | **JAVÍTVA a helyes módon** | `routes/apg.ts:173-179` `apg_enforcement_wired` — nem talál ki enforcement-szemantikát, hanem **kimondja az igazságot**, standing checkkel a hívási helyekre, és a UI ki is rakja (`web/apg.js:124,1071`) |
| **F-8** | `NOT_APPLICABLE` → `EXCLUDED`, két repó két igazsága | **JAVÍTVA** | a régi név bent marad az illesztésben (a kernel nem tesz CHECK-et, tehát a történet nem íródik át); a szerződés-teszt a kernel saját `RESULT_VALUES` listájából olvas |
| **F-9** | Sérült tábla „nincs adat"-ként | **JAVÍTVA** | a hibák gyűlnek, a summary kimondja, hogy részleges |
| **F-10** | Enforced fail-open a sidecar kiesésekor | **JAVÍTVA** | |
| **F-1** | `spec_ready` PASS „igazolt ténnyé" minősít | **NYITVA** | |
| **F-2** | Az „elfogadva" egy kapu-eredmény, nem elfogadás | **NYITVA** | `ui-projection.ts:162-171` — `latestCheckpointResult === 'PASS'` → `'accepted'` |
| **F-4** | A döntés nem hagy nyomot a sidecarban | **NYITVA** | `routes/apg.ts:472` `writeApgAuditEvent` lokálisan ír; a kernel felé semmi |
| **F-7** | `mode_source` minden munkaelemen hamis | **NYITVA** | `ui-projection.ts:699` `mode_source: 'global'` — konstans |
| **F-11..F-16** | próza a frontendre, hat tábla teljes beolvasása, `?mode=` felülírás, natív dialógusok, idempotencia-store, a11y | **NYITVA** | |

### A-1 · P2 · Az F-8 javítás visszafelé kompatibilis, előrefelé nem

A projekció most mindkét nevet (`NOT_APPLICABLE` és `EXCLUDED`) illeszti, mert „a kernel migrációja nem tesz CHECK-et a `result` oszlopra, tehát a történet nem íródik át egy átnevezéstől". Ez helyes döntés a múltra.

A jövőre viszont a szerződés továbbra is **egy tesztben él, nem a sémában**: a kernel `RESULT_VALUES` listája (`src/checkpoints.py:16`) öt értéket sorol fel, és semmi nem akadályozza meg, hogy a tábla hatodikat kapjon. A K-2 találás (nincs CHECK a `result` oszlopon) tehát nem csak a kernel belügye — ez a **két repó közötti szerződés hordozója**, és ma egy Python-lista meg egy TypeScript-teszt tartja össze. Amíg a `CHECK`-et nem lehet felvenni (mert az átírná a történetet), egy `apg_result_values` metaadat-sor a sidecar sémájában, amit a projekció olvas, ugyanazt adná anélkül.

## IV.2 A kernel (marveen-apg-kernel @ `1ae89c8`)

| # | Találás | Állapot |
|---|---|---|
| **K-1** | A kernel forrása a tulajdonos gépéhez van drótozva | **VÁLTOZATLAN** — `profiles.py:12`, `sources/*.py`, `receipt_chain.py:162`, `adapters/a1_pilot.py:34`: `/home/iszzu/...` tíz helyen, default paraméterértékként |
| **K-2** | Nincs CHECK a `result` oszlopon | **VÁLTOZATLAN** — lásd A-1 |
| **K-3** | Két kisebb pontatlanság a forrásadapterekben | **VÁLTOZATLAN** |

Új munka a `wp1-slice1-executor-registry` ágon: `6a3771e` **Gate Executor Registry (§7.3)** — az APG **1.8** specifikációhoz, nem a 0.4-hez. Ezt nem vontam a 0.4-es verdikt alá; annyit érdemes megjegyezni, hogy a 0.4 tíz nyitott találása mellett indult egy következő szakasz, és a K-1 (a be nem drótozható telepíthetőség) mindkettőt terheli.

---

# V. Keresztmetsző megállapítások

### K-1 (kereszt) · P2 · Uid-függő negatív tesztek — ez már minta, nem egyedi eset

A teljes futás négy piros teszt-fájlja közül **három** ugyanabba az osztályba tartozik: `chmod 0500`-zal próbálnak írhatatlan könyvtárat előállítani, és root alatt (konténeres CI a szokásos eset) ez nem akadály.

```
FAIL src/__tests__/channels-never-started-backoff.test.ts
     > an unwritable store/ does not fake success
FAIL src/__tests__/optimization-master-and-emergency.test.ts
     > writeOptimizationConfig reports ok:false when the write cannot land
FAIL src/__tests__/installer-start-and-fallback.test.ts
     > the ERR-trap abort is real
```

A repóban **már ott a helyes minta**: `dispatch-session-resolution.test.ts:137,150` `if (process.getuid?.() === 0) return`. Uid-független alternatíva még jobb: a cél útvonal legyen egy létező **könyvtár**, akkor az írás `EISDIR`-rel bukik mindenkinek.

Ez azért P2 és nem P3: három állandó piros teszt egy 5901-es zöld szvitben ahhoz szoktat hozzá, hogy a piros normális.

### A negyedik piros — a review körén kívül

`src/__tests__/schedule-runner-retry-missing.test.ts > still deletes the row when the retry finally fires` — determinisztikusan piros (kétszer futtatva), nem chmod-alapú, és nem a négy vizsgált funkcióhoz tartozik. Nem vizsgáltam ki; jelzem, mert egy „5893/5901 zöld" összefoglaló különben elfedné.

### A hibaosztály állása kilenc review után

A mondat, ami mind a kilencet végigkíséri — *a mechanizmus megépül, és nem kerül a forgalomba* — ebben a körben **először szorult ki a fő útvonalról**. A COS zárt hurokja működik; az optimalizálás kapcsolói kapcsolnak; az APG kapcsolói megmondják magukról, hogy nem kapcsolnak. Ami maradt belőle, az a **peremeken** van: a visszatartott üzenet (T-3), a `final_decision` (Ö-1 második fele), a `partial` import-státusz (C-2), a `setMode` (N-5).

Amit viszont ez a kör újként mutat, az egy **másik** osztály, és érdemes külön nevet adni neki: **a javítás nem néz vissza a forrásra, ahonnan másolt.** A T-1 ennek a tiszta esete — a `routeFor` átmásolva, a vokabulárium-hiba a másolatban megtalálva és megjavítva, az eredetiben nem. A T-2 ugyanennek a rövid távú változata: a helyes viselkedés három sorral lejjebb, ugyanabban a ciklusban, kommenttel együtt.

Erre van olcsó eljárás, és a kódbázis már használja máshol: **a standing check, ami két utat hasonlít össze**, nem egyet ellenőriz. A `cos-gate-permit.test.ts` mintája (számold össze a mintázókat, buktasd el a harmadikat) átvihető ide: számold ki mindkét úton a tiert ugyanarra a bemenetre, és bukjon, ha eltérnek.

---

# VI. Javasolt sorrend

1. **T-1** — a `tierFor` közös helyre, a `contextSensitivity` kapjon domaint, és egy összehasonlító standing check a két útvonalra. Ez zárja a céges domain hibás besorolását.
2. **T-2** — `holdOwnerMessage` a visszakérdezés-ágon is (egy sor), és a szűrő szigorítása külön.
3. **T-3** — a visszatartott üzenetek visszajelzése a csatornán; ez egyszerre adja a tábla olvasóját és zárja a néma hurkot.
4. **C-1** — a `collectors/runner.ts` kapuzzon `checkPeriodWritable`-lel, `status: 'locked'`-kal (a mechanizmus létezik). §23 AC-9.
5. **K-1 (kereszt)** — a három uid-függő teszt.
6. **Ó-1**, **Ó-3** — a kiegyenlítés és a blokkoló-szövegek.
7. **O-3**, **O-4** — a §21 két legkönnyebben zárható tétele.
8. **F-4**, **F-7**, majd **F-1**, **F-2** — az APG projekció négy pontja, ahol a felület mást mond, mint a sidecar.
9. **T-4**, **T-5**, **C-2**, **A-1**, a maradék.
