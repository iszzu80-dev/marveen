# COS — hatodik code review: a Writer, a válasz-út, és ami a válasszal történik

**Alap:** `develop` @ `d32fa30` (7 commit az #5 kör `e0bb1bb` alapja óta).
**Előzmény:** review #1 (18), #2 (N-1..N-5), #3 (Ú-1..Ú-5), #4 (N4-1, N4-2), #5 (Ö-1..Ö-5).
**Spec:** COS v4.2.1, progression v1.3.1 — ebben a körben főleg §10.1, §10.2, **§10.4**, §10.8, §13.1.

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run` a COS teszt-fájlokon | **824/824 zöld, 97 fájl** (#5-ben 802 / 96) |
| Ö-1 (a packet olvasója) | **RÉSZBEN javítva** — van olvasó, de nem a §13.1 arbitrációra |
| Ö-2, Ö-3, Ö-4, Ö-5 | **VÁLTOZATLAN** |
| A válasz-út hívó-követése | **nulla produkciós hívó** — lásd H-1 |
| Reprodukció: válasz → esemény → pipeline | **a válasz elveszik, a kérdés újra kimegy** — lásd H-2 |
| Reprodukció: `whoHasIt: "István"` | **ékezettel nem István** — lásd H-3 |

---

## 0. Rövid álláspont

Ez a kör a lánc legfontosabb hiányzó darabját építette meg: a Reader csomagja most **kérdéssé válik Istvan saját csatornáján**, és a kérdés tényleg ki is megy — a `progression-heartbeat-runner.ts:127` hívja, standing checkkel a hívó-oldalra. Ezzel az #5 kör fő találása (Ö-1) félig megoldódott, és a jobbik felével.

A hozzá tartozó **válasz-út viszont nem működik**, két egymástól független okból, és mindkettőt visszamértem:

1. **Nincs hívója.** `recordOwnerAnswer` és `outstandingOwnerQuestions` produkciós hívó nélkül áll. Istvan Telegramon válaszol; semmi nem köti a Telegramot ehhez a függvényhez.
2. **Ha lenne, akkor is eldobódna.** A beírt esemény `source_reference` nélkül készül, a `consumeOwnerAnswer` pedig pontosan ezen a mezőn bukik el (`progression-pipeline.ts:382`). A commit és a sweep-dokumentum állítása — „case-eventet ír, amit a pipeline meglévő owner-answer feldolgozása olvas" — a kódból nem igaz.

A kettő együtt nem semleges, hanem **hurok**: a válasz lezárja a nyitott kérdést, az ügyön viszont semmi nem változik, a következő Reader-kör ugyanazt a csomagot állítja elő, ugyanazt a lenyomatot számolja, és **ugyanaz a kérdés megy ki újra**. Ezt lefuttattam: két azonos szövegű üzenet, a válasz után.

És egy harmadik, kisebb, de éles: **`"István"` ékezettel nem `ISTVAN`.** A prompt kifejezetten magyarul kéri a `missingRequirements`-et, a `whoHasIt` szabad szöveg, az összehasonlítás viszont ékezet nélküli. Ugyanazon az ügyön, csak az ékezettől függően: vagy konkrét kérdés, vagy általános kérdés, vagy — ha a `ballHolder` nem `ISTVAN` — **egyáltalán semmilyen kérdés**.

---

## 1. Ami megépült, és jól

### 1.1 A tárolt bájtok is tartalom (`7b6f603`)

A legjobb javítás ebben a körben, mert a méréssel kezdődött: mind a 22 tárolt levélszál `extracted_text`-je NULL volt, miközben a lemezen ott a sima szöveg. A Reader tehát azt jelentette, hogy „a szál nem olvasható", és a labdát EXTERNAL-ra tette — **helyes válasz egy olyan kérdésre, amit egy soha nem látott levélről tettek fel**. A gondolkodó réteg sosem volt a szűk keresztmetszet.

`context-builder.ts:88` `documentContent`: kinyert szöveg → tárolt bájtok → címke. Két szándékos korlát, mindkettő indokolt: csak szöveg-szerű mime (`text/plain`, `message/rfc822`, `application/json`), és a `�` jelenléte esetén elutasítás — „egy Reader, aminek mojibake-t adunk, a mojibake-ről fog jelenteni".

**Ellenőriztem, hogy a javítás tényleg tüzel:** a levélszálakat a `gmail-thread-read.ts:185` `mimeType: 'text/plain'`-nel tárolja, tehát a mime-szűrő átengedi őket. Ez nem magától értetődő — egy `application/octet-stream` default mellett a javítás egy sort sem változtatott volna.

### 1.2 A Writer (§10.4, első szelet)

`owner-question.ts`, 313 sor, determinisztikus. Az indoklás ugyanaz, mint a tervezőnél, és helytálló: az ítélet már megtörtént, a csomag tényei már magyarul vannak, már forráshoz kötve és validálva — egy második modellhívás csak egy második helyet adna, ahol egy részlet elcsúszhat.

Három tulajdonság viszi a súlyt, és egyik sem a megfogalmazás:

- **Csak azt kérdezi, ami tényleg az övé** (`:57`) — egy harmadik félre váró ügy nem kérdés. Az élő mérés ezt igazolja is: 55 olvasott ügyből 18 EXTERNAL, ezek mind kimaradnak.
- **A lenyomat az ASK-ot fedi, nem a csomagot** (`:106-109`) — egy új tény, ami nem változtat a válaszolandón, nem pingel újra. Ugyanaz a doktrína, mint a §10.8 trigger contract.
- **A rögzítés az üzenetküldés ELŐTT történik** (`:212-220`) — egy összeomlás a kettő között egy elmaradt kérdésbe kerül, a másik sorrend egy duplikátumba minden sweepen.

A globális plafon (`:157`, `maxOutstanding = 5`) érve is helyes, és a `heldBacklogFull` számláló nélkül nem érne semmit: „egy csatorna, ami a plafon miatt hallgat, nem nézhet ki úgy, mint egy rendszer, aminek nincs mit kérdeznie". Az első éles kör `heldBacklogFull: 30`-cal indult — a plafon nélkül ez harminc üzenet lett volna.

A saját hiba megtalálása és kimondása (`(case_id, question_hash)` PK ütközés a saját történettel, upsertre javítva) az a fajta, amit egy teszt hozott ki és nem egy incidens.

### 1.3 Ö-1 — félig javítva, a jobbik felével

A `case_evidence_packets` táblának **van produkciós olvasója** (`owner-question.ts:174`). A csomag tényei, hiányzó tételei és a `ballHolder` eljutnak Istvanhoz.

Ami **nem** változott: a `final_decision`, `conflict_reason`, `reader_candidate`, `safe_fallback_decision` és `decided_by` oszlopok továbbra is írás-only, a `runProgressionCycle` pedig továbbra is `buildRollingPlan`-t hív. A §13.1 arbitráció eredménye tehát még mindig nem éri el a motort — de a §10.4 út megnyitása volt az #5 kör 1. javaslata, és az meglett.

---

## 2. Új találások

### H-1 · P1 · A válasz-útnak nincs ajtaja

**Amit mértem.**

```
$ grep -rn "recordOwnerAnswer" src/ scripts/ web/ ops/ | grep -v owner-question.ts
src/__tests__/cos-owner-question.test.ts: (6 találat)

$ grep -rn "outstandingOwnerQuestions" src/ scripts/ web/ ops/ | grep -v owner-question.ts
src/__tests__/cos-owner-question.test.ts: (3 találat)
```

Nulla produkciós hívó mindkettőre. A kérdés-oldal be van kötve (`progression-heartbeat-runner.ts:127`), és van rá standing check (`cos-owner-question.test.ts:139`) — a válasz-oldalra nincs sem hívó, sem standing check.

A commit ezt írja: *„Istvan Telegramon valaszol, es itt lesz abbol valami, amit a motor fel tud dolgozni."* A `src/web/telegram.ts` létezik, de semmi nem köti a `recordOwnerAnswer`-hez. Az `outstandingOwnerQuestions` docstringje szerint „a »mit kérdezett tőlem?« egy query legyen, ne egy visszagörgetés a Telegramban" — de a query-nek nincs se HTTP route-ja, se CLI-je, tehát ma is visszagörgetés.

**Miért ez a legfontosabb.** A kérdés-oldal bekötése pont azért volt a kör érdeme, mert a lánc addig egy táblában ért véget. A válasz-oldal most **ugyanabban az állapotban van, egy réteggel arrébb** — és a modul saját fejléce mondja ki, hogy „egy kérdés, aminek nincs hova a válasza, fél csatorna".

---

### H-2 · P1 · A válasz-esemény olyan alakban íródik, amit a fogyasztója eldob — a kérdés pedig újra kimegy

**Amit a kód mond.** `owner-question.ts:290-298` az eseményt így írja:

```sql
INSERT INTO ${events} (case_id, case_version, actor, event_type, reason, payload, source_system, created_at)
VALUES (?, ?, 'istvan', ?, ?, ?, 'telegram', ?)
```

`source_reference` nincs benne. A fogyasztó, `consumeOwnerAnswer` (`progression-pipeline.ts:382`):

```ts
// 2. Look up the run that the answer references (source_reference = run ID).
//    If source_reference is missing or the run is gone, we cannot verify
//    question identity — treat as stale.
if (!answerEvent.source_reference) return null
```

Összehasonlításul a működő út, a Mission Control owner-action végpont (`routes/cos.ts:612`): `sourceReference`, `caseVersion` és `idempotencyKey` **kötelező**, plusz egy avultsági és egy idempotencia-őr. Az új út egyiket sem adja.

**Reprodukció** (in-memory DB, a saját moduljaikkal):

```
1. elso sweep      : {"asked":1,"alreadyAsked":0,"nothingToAsk":0,"heldBacklogFull":0}
2. valasz rogzitve : {"caseId":"c1","eventType":"OWNER_DECISION","choice":"YES"}
3. a beirt esemeny : {"event_type":"OWNER_DECISION","source_system":"telegram","source_reference":null,...}
4. kovetkezo sweep : {"asked":1,"alreadyAsked":0,"nothingToAsk":0,"heldBacklogFull":0}
5. kikuldott uzenetek: 2 | azonos szoveg: true
```

A lánc, ami ebből következik: a válasz `answered_at`-et ír → a `cos_owner_questions` sor felszabadul (a modul ezt szándékosan „release"-nek hívja) → a pipeline az eseményt eldobja, tehát az ügyön **semmi nem változik** → a következő Reader-kör ugyanazt a csomagot állítja elő → ugyanaz az ASK-lenyomat → `isOutstanding` hamis → **ugyanaz a kérdés megy ki másodszor**. A „release" mechanizmus arra épül, hogy a válasz megmozdítja a helyzetet; H-2 miatt nem mozdítja meg.

**Egy második, súlyosabb következmény, ha H-1 előbb lenne javítva, mint ez.** A `consumeOwnerAnswer` első lépése:

```sql
... WHERE event_type IN ('OWNER_DECISION','OWNER_INFORMATION','OWNER_CONFIRMATION')
ORDER BY created_at DESC LIMIT 1
```

Csak a **legutolsó** tulajdonosi eseményt nézi, és ha annak nincs `source_reference`-e, a függvény a 2. lépésnél `null`-t ad. Egy Telegramról érkezett válasz tehát nemcsak önmagában hatástalan: **elárnyékol egy korábbi, érvényes Mission Control-választ**, amit a pipeline még nem dolgozott fel. A sorrend ezért nem mindegy — **H-2-t H-1 előtt kell javítani**, különben a bekötés nem hatástalan lesz, hanem regresszió.

**Javaslat.** A `recordOwnerAnswer` írja be a `source_reference`-et: annak a `case_progression_runs` sornak az azonosítóját, ami a kérdést kiváltotta. Ehhez a `cos_owner_questions` sornak el kell tárolnia a `progression_run_id`-t az `asked_at` mellett — egy oszlop, és a kérdés identitása onnantól ugyanaz a `(decision, nbaStep)` pár, amit a §10.8 és a Mission Control már használ. Amíg ez nincs meg, a válasz-út bekötése nem javítás.

---

### H-3 · P2 · „István" ékezettel nem `ISTVAN`

**Amit a kód mond.** A `whoHasIt` **szabad szöveg a modelltől**: a séma csak `String(m.whoHasIt ?? 'UNKNOWN')`-t csinál belőle (`reader.ts:166`), és a prompt 7. pontja kifejezetten ezt kéri: *„Write facts, uncertainty and missingRequirements in HUNGARIAN."* A `ballHolder` ezzel szemben szigorú enum, négy szóra kényszerítve — ott a védelem megvan.

Az összehasonlítás viszont ékezet nélküli, két helyen:

| hely | kód |
|---|---|
| `owner-question.ts:60` | `m.whoHasIt.toUpperCase().includes('ISTVAN')` |
| `owner-question.ts:41` | `(s.blockedBy ?? '').toUpperCase() === 'ISTVAN'` |

`'István'.toUpperCase()` = `'ISTVÁN'`, ami nem tartalmazza az `'ISTVAN'`-t. A `blockedBy` ráadásul a `whoHasIt`-ből származik (`evidence-planner.ts:79`), és ott **pontos egyenlőség** van, ami minden díszítést is kizár.

**Reprodukció**, ugyanaz a csomag, csak a `whoHasIt` változik:

```
whoHasIt="ISTVAN"              -> • A vetelar megallapodasa — a szerzodeshez kell
whoHasIt="István"              -> • döntés arról, hogyan tovább — ez akadályozza: • A vetelar megallapodasa (István)
whoHasIt="Istvan Szabo"        -> • A vetelar megallapodasa — a szerzodeshez kell
whoHasIt="ISTVAN (tulajdonos)" -> • A vetelar megallapodasa — a szerzodeshez kell
```

És a súlyosabb eset, ahol a `ballHolder` nem `ISTVAN` (pl. `UNKNOWN`), de a hiányzó tétel helyesen neki van tulajdonítva:

```
ballHolder=UNKNOWN, whoHasIt="ISTVAN"  -> kerdes keszult
ballHolder=UNKNOWN, whoHasIt="István"  -> NINCS KERDES (null)
```

Ugyanaz az ügy, ugyanazok a tények, egyetlen ékezet — és a különbség a kérdés és a **csend** között van. A csend az a hibamód, amiről egy értesítő-csatorna nem tud jelenteni.

**Miért érdemes ezt megnézni a `5c7d089` javítás fényében.** Az a commit egy valódi élő tünetet javított („az első négy éles kérdésből kettőnél ez állt: *Ami Tőled kell: Istvan döntése szükséges*"), és a diagnózis az volt, hogy *„a Reader ISTVAN-ra tette a labdát, de a hiányzó tételeket másnak tulajdonította"*. A fenti reprodukció mutat egy másik lehetséges okot ugyanarra a tünetre: a Reader **neki** tulajdonította, ékezettel írva, és az összehasonlítás nem vette észre. A hozzáadott tartalék jó — használható kérdést csinál — de ha az ok ez, akkor a tünetet fedi el.

Ez ellenőrizhető: a sweep-dokumentum szerint a 34 Istvanra tett ügyből 27-nél tudja megnevezni, mi hiányzik (79%). Elég megnézni a maradék 7 csomag `whoHasIt` értékeit.

**Javaslat.** Egy normalizáló a modelltől jövő nevekre (ékezet-hajtogatás + `includes`), egy helyen, mindkét összehasonlításban. Vagy — tisztább — a `whoHasIt` is kapja meg ugyanazt a szigorú enumot, amit a `ballHolder` már kapott, hiszen ugyanarra a négy szereplőre hivatkozik.

---

### H-4 · P3 · A válasz-úton a domain nem számít, csak az esemény írásánál

`recordOwnerAnswer` (`owner-question.ts:271-283`) a nyitott kérdést és a lezárását **domain nélkül** keresi:

```sql
SELECT question_hash FROM cos_owner_questions WHERE case_id = ? AND answered_at IS NULL ...
UPDATE cos_owner_questions SET answered_at = ?, answer_text = ? WHERE case_id = ? AND question_hash = ?
```

Az eseményt viszont a `domain` szerinti táblába írja, és csak akkor, ha az ügy ott megvan (`if (row)`). Egy rossz domainnel érkező hívás tehát **lezárja a kérdést és nem ír eseményt** — a válasz eltűnik, a kérdés pedig „megválaszoltnak" látszik. A `cos_owner_questions` PK-jában sincs benne a domain (`schema.ts:1765`), pedig a tábla tárolja.

Ma nem tud elsülni (nincs hívó), de a bekötés pillanatában a domain a hívó oldaláról fog jönni — érdemes előbb bezárni.

---

## 3. Az #5 kör találásainak állása

| # | Találás | Állapot | Bizonyíték |
|---|---|---|---|
| **Ö-1** | A Reader kimenetét senki nem olvassa | **RÉSZBEN** | van olvasó (`owner-question.ts:174`), de a §13.1 arbitrációs oszlopok és a `plan_json` döntési útja továbbra sem éri el a pipeline-t (`buildRollingPlan` a `:786, :835, :859`) |
| **Ö-2** | A `goal-enrichment` érzékenységi kapu nélkül küld ki | **VÁLTOZATLAN** | `grep -n "provider\|sensitivity\|isProviderAllowed" src/cos/goal-enrichment.ts` → nincs találat |
| **Ö-3** | Az `/api/cos/interpret-answer` nem látja a vaultot | **VÁLTOZATLAN** | `routes/cos.ts:563` `new AnthropicLlmClient()` |
| **Ö-4** | Két érzékenységi tábla + olvasatlan `profile` mező | **VÁLTOZATLAN** | `INTERPRETER_PROFILE` négy értékadás, nulla olvasó |
| **Ö-5** | A standing checkek csak a `src/cos`-t pásztázzák | **VÁLTOZATLAN** | `cos-gate-permit.test.ts:80, 89` |
| N-4 | `approval_version` = `campaign_version` | **VÁLTOZATLAN** | `approval-core.ts:354` |
| N-5 | A marker-kapu hívó nélküli függvényen ül | **VÁLTOZATLAN** | `connector-health.ts:96` |

Egy megjegyzés az Ö-4 mellé, mert ez a kör újratermelte a mintát: a `gmail-thread-read.ts:182-187` a levélszálat **anélkül** tárolja el, hogy a `storeDocument` már meglévő `extractedText` (és `sensitivity`) paraméterét használná, pedig a szöveg ott van a kezében (`const text = renderThread(messages)`). Az olvasás-oldali javítás (1.1) helyes, mert ott harapott a hiba — de az `extracted_text` oszlop továbbra is NULL marad minden új szálra, és a következő fogyasztó, aki ezt az oszlopot olvassa, ugyanabba fut bele. Egy paraméter.

---

## 4. Javasolt sorrend

1. **H-2** — a `source_reference` beírása, és a `progression_run_id` eltárolása a kérdés mellett. **Ez H-1 előtt**, különben a bekötés regresszió.
2. **H-1** — a Telegram-válasz bekötése, standing checkkel a hívó-oldalra (a kérdés-oldalnak már van egy, ugyanaz a minta).
3. **H-3** — névnormalizálás vagy enum a `whoHasIt`-re; és nézzük meg a 7 csomagot, amelyiknél nem sikerült megnevezni a hiányzót.
4. **Ö-2** — továbbra is a legolcsóbb nyitott adat-kimeneti rés (tíz sor).
5. **H-4**, majd **Ö-3**, **Ö-4**, **Ö-5**, **N-4**, **N-5**.

---

## 5. A minta állása hat kör után

Az #5 kör végén ezt írtam: *a hibaosztály a bemenetről a kimenetre költözött.* Ez a kör a kimenet felét megnyitotta — a kérdés tényleg megérkezik Istvanhoz, és ez a legnagyobb egyetlen lépés a hat kör alatt, mert egy rendszer, ami gondolkodik és nem szól, nem megkülönböztethető attól, amelyik nem gondolkodik.

A minta viszont pontosan a következő szakaszhatáron újratermelődött: **a válasz-út megépült, teszteket kapott, dokumentálva lett — és nincs bekötve, ráadásul olyan alakban ír, amit a saját fogyasztója eldob.** Ez a hibaosztály hatodik előfordulása, és most először **két** rétegben egyszerre: hiányzik a hívó, ÉS nem illeszkedik a szerződés.

Ebből egy általánosabb dolog következik, amit érdemes eljárássá tenni. A hívó-oldali standing check (amit a #1 kör után vezettek be, és ami azóta három szigetet fogott meg) csak a *kapcsolat meglétét* méri. Ami itt hiányzott, az a másik fele: **egy teszt, ami a termelő és a fogyasztó közé áll** — beírja az eseményt a termelővel, és a fogyasztóval olvassa vissza. Egy ilyen teszt a `recordOwnerAnswer` → `consumeOwnerAnswer` párosra ma az első futáson megbukott volna, és a `source_reference` hiánya nem jutott volna el a dokumentumig, ami azt állítja, hogy működik.
