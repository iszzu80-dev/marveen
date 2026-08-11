# Négy review remediációja egy sweepben — COS #4, lean optimization, CostOps, APG 0.4

**Dátum:** 2026-08-11 (05:45–06:45 CEST) · **Ág:** `feat/cos-reader-live-wire` → `develop`
**Előzmény:** `audits/cos-reader-live-wire-2026-08-11.md` (az éjszaka első fele: a Reader-lánc élesítése)
**Kérte:** Istvan — „javítsd a COS review találásait, utána a CostOps és lean opt, majd az APG 0.4-et"

---

## 0. A minta, ami mind a négy review-ban ugyanaz

Ez a sweep tizenkét találást zárt le négy különböző rendszerben. Egy alakzat
ismétlődött bennük, és érdemes néven nevezni, mert nem egy hiba, hanem egy
hibaosztály:

> **Egy felület olyan állapotot jelent, amit nem ellenőrzött.**

- a vészleállító sikert jelentett, és nem állított le semmit (O-1);
- a vészleállító sikert jelentett akkor is, ha az írás elbukott (O-7);
- a summary mindent élőnek jelentett master-OFF állapotban (O-2);
- az Aktivitás-feed „nincs aktivitás"-t mutatott, mert egy globálisra várt,
  amit senki nem állít be (F-3);
- egy olvashatatlan tábla „nincs adat"-ként jelent meg (F-9);
- három enforcement kapcsoló bekapcsolható volt, és nem kényszerített ki semmit (F-6);
- egy soha nem futott kapu „Végrehajtás alatt"-ként látszott (F-8);
- és az egyetlen valódi blokkoló kapu KINYÍLT, amikor a sidecar kiesett (F-10).

Mindegyik zöldnek látszik. Egyik sem hazudik szándékosan. Mindegyik ugyanazt a
kérdést kerüli meg: **honnan tudod, hogy az, amit mutatsz, megtörtént?**

---

## 1. COS review #4

### N4-1 (P1) — a Reader kapu nélkül küldött ki teljes ügy-tartalmat

A bekötés maga hozta létre az adatáramlást. Amíg a lánc sziget volt, a kérdés nem
létezett; abban a pillanatban, hogy útvonal lett belőle, létezik.

Az érzékenységi szint végigutazott a rendszeren, kiíródott a promptba címkeként,
és soha nem döntött semmiről.

**Egy mérés, ami megváltoztatta a tervet.** Az első változat 40-ből 36 ügyet
blokkolt volna — és nem a tartalmuk miatt: mind a 92 dokumentum-sor az élő
tárban a literál `'UNKNOWN'` szintet hordozza, amit a fail-closed coerce
`HIGHLY_SENSITIVE`-ra fordít. Egy kapu, ami mindenre tüzel, megtanítja az embert
kikapcsolni. Ezért a dokumentum az ÜGY deklarált szintjét örökli, ha sajátja
nincs — ez nem lazítás: az `'UNKNOWN'` azt jelenti, NINCS DEKLARÁLVA.

### Istvan kérdése, ami átírta a szabályt

> „Miért nem lehet cheap modellel olvasni a szenzitív adatokat?"

Jogos, és a válasz az volt, hogy technikailag nem is kellene tiltani. A §10 tábla
ÁRKATEGÓRIÁRA szűrt, mert amikor íródott, `premium_reasoning` = Opus = Anthropic,
a cheap tier meg DeepSeek volt. Az árkategória **véletlenül** egybeesett a
szolgáltatóval, és a szabály erre a véletlenre épült. A véletlen aznap megszűnt.

**Istvan döntése:** szenzitív tartalom adatkezelési szempontból megfelelő
szolgáltatóhoz (Anthropic), a többi mehet DeepSeek v4-re.

Ebből nem kapu lett, hanem **útválasztás**. Élő bizonyíték, 06:43:

```
byProvider: { deepseek: 2, anthropic: 1 }
```

Három szabály, amit külön kiírok:
- új szolgáltató alapból `THIRD_PARTY` — a **kimaradás** által, nem egy
  bejegyzés által, amire valakinek emlékeznie kell;
- ha nincs cleared szolgáltató, a szenzitív ügy **blokkolt**, nem degradálódik
  az olcsó útra;
- van ellenpár-teszt: egy `PERSONAL` ügy az OLCSÓRA megy. Enélkül a szabály nem
  útválasztás lenne, hanem „költsünk többet".

### N4-2, Ú-4, Ú-5

- **N4-2**: a `case_evidence_packets` felkerült a retention-politikába (90 nap).
  A SOR marad az arbitrációs audittal, a TARTALOM megy — ugyanaz az alak, mint a
  melléklet-purge: megőrizzük a bizonyítékot, hogy egy döntés megtörtént és
  miért, és eldobjuk azt, amiről szólt.
- **Ú-4**: a jogosítás-jegyet mostantól csak a kapu bocsáthatja ki. Egy
  modul-privát WeakSet + két feltétel (a döntés a kaputól való ÉS igent mondott).
  Amit ez NEM tud, kiírva a modul fejlécébe: egy azonos processzben futó, elszánt
  hívó importálhat és mintázhat. A másik fele ezért standing check: pontosan két
  modul mintázhat.
- **Ú-5**: a trigger-szótár szinonimái összeérnek az ÍRÁS határán. A régi sorok
  értéke változatlan — a történet átírása egy riport kedvéért az, amitől a
  történet megszűnik bizonyíték lenni. **Az `INTAKE`-et a review javaslata
  ellenére NEM olvasztottam a `NEW_RELEVANT_EVENT`-be**: az egyik azt jelenti,
  hogy egy ügy létrejött, a másik azt, hogy egy létezővel történt valami.

---

## 2. Lean Optimization

### O-1 (P0) — a vezérlőpult nem vezérelt

A review azt írta, hogy ez ma ártalmatlan, mert a routing úgyis ki van kapcsolva.
**Lemértem: nem.** Az `enabled` `true` volt, 2026-07-30 óta, és a runner fut a
dashboard processzben (`web.ts:411`).

Vagyis a vészleállító megnyomása sikert jelentett volna, és a sweep megy tovább.

Két dolgot építettem a javításba:
- a propagálás **csak az OFF irányba** automatikus. Az armolás tulajdonosi
  döntés; egy dashboard-kapcsoló megállíthatja a routingot, elindítani soha;
- ha nincs config a lemezen, az `enabled: true` kérés visszautasítódik ahelyett,
  hogy létrehozna egy armolt configot.

A két állapot a bekötés pillanatában egyezett, ezért ez nem változtatott élő
viselkedést. Ez volt a jó pillanat rá.

### O-2, O-7

- **O-2**: a summary minden ága csak a modul-flageket nézte; a `masterEnabled`
  szó a fájlban egyszer sem szerepelt — miközben a `/routing` végpont már
  `masterEnabled && runtimeRouting`-ra kapuzott. Az aszimmetria a két végpont
  között mutatta, hogy elmaradás, nem döntés. Minden modul-kapu egyetlen
  segédfüggvényen megy át, hogy ne lehessen később olyat hozzáadni, ami csendben
  kihagyja a master kapcsolót.
- **O-7**: a vészleállító meg sem nézte az írás eredményét. A teszt nem csak az
  ellenőrzést állítja, hanem azt is, hogy a feltétel ELÉRHETŐ: egy írhatatlan
  könyvtáron a write ténylegesen `ok: false`-t ad.

---

## 3. APG 0.4

| # | Találás | Mit jelentett a képernyőn |
|---|---|---|
| **F-3** | Az Aktivitás-végpont egy `globalThis.BetterSqlite3`-ra várt, amit a repóban SEMMI nem állít be | „nincs aktivitás" |
| **F-8** | A kernel átnevezte `NOT_APPLICABLE` → `EXCLUDED` és bevezette az `ERROR`-t; a projekció a régi néven illesztett | egy soha nem futott és egy hibára futott kapu is „Végrehajtás alatt" |
| **F-9** | Minden olvasási hiba üres tömbbe nyelődött | egy sérült tábla „nincs adat", `projection_error` nélkül |
| **F-10** | Az egyetlen valódi blokkoló kapu fail-OPEN volt — enforced módban is | a sidecar kiesése kinyitotta a kaput |
| **F-5** | Az APG döntési út kihagyta az önjóváhagyás-guardot (§27 stop condition) | — |
| **F-6** | Négy enforcement kapcsolóból három semmit nem csinált | bekapcsolod, siker, a korlát nincs |

**F-8 a legtanulságosabb:** két repó, egy szerződés, két igazság. A javítás nem
csak az illesztés, hanem egy **szerződés-teszt**, ami a kernel saját
`RESULT_VALUES` listájából olvas — így egy jövőbeli átnevezés tesztet buktat
ahelyett, hogy csendben más állapotot mutatna a felület. A régi név bent marad:
a kernel migrációja nem tesz CHECK-et a `result` oszlopra, tehát a történet nem
íródik át egy átnevezéstől.

**F-6-nál döntést hoztam, és indokolom:** nem találtam ki enforcement-szemantikát
idő nyomás alatt. Ehelyett a summary közli, melyik kapcsoló van ténylegesen
bekötve. Egy hiányzó kapcsoló őszinte; egy hazudó kapcsoló rosszabb a semminél.
A standing check külön választja az OLVASÁST az ECHÓTÓL — pont az tette úgy,
mintha mind a négyet használná valaki, hogy a frontend átmásolta őket egy
állapotobjektumba.

---

## 4. Két saját hibám ebben a sweepben

**A teszt, ami zöld volt és nem azt mérte, amit állított.** Az F-8 fixture-je
kitalált mezőneveket adott a `deriveDisplayState`-nek. A vitest boldogan
elfogadta — nem typecheckel —, és a `tsc` mutatta meg. Javítva, és pirosra
járatva bizonyítva: az `EXCLUDED` és `ERROR` ág nélkül kettő elbukik nyolcból.

**A merge, ami magába mergelt.** Egy compound parancsban a worktree
könyvtárában maradtam, és a `git merge --ff-only` a saját branch-et mergelte
önmagába: „Already up to date", a develop nem mozdult, a push „Everything
up-to-date"-et írt. A skill fejezete pontosan erről szól, és mégis belesétáltam.
A javítás: a merge-parancs a fő checkoutból, `cd` nélkül.

---

## 5. Ami NINCS kész

1. **A `conflicts` arány.** Változatlanul a legfontosabb nyitott kérdés: a
   determinisztikus policy veri le a Reader javaslatát, szinte mindig ugyanazzal
   a `CONTINUE_AUTONOMOUSLY`-val. Tulajdonosi döntést igényel.
2. **APG F-1, F-2, F-4, F-7, F-11 …** — a hamis zöld (`spec_ready` PASS mint
   „igazolt tény"), az „elfogadva", ami mögött nincs független elfogadó, a
   döntés, ami nem hagy nyomot a sidecarban, a hamis `mode_source`, és a magyar
   próza a backendből.
3. **CostOps C-1…C-7** — ebben a sweepben nem kerültek sorra.
4. **CompliFlow** — a P0-k ellenőrizve és megerősítve, javítás nem kezdődött.
5. **`cos-progression-mc-view.test.ts` 12 tesztje** továbbra sem futtatható
   (nincs `jsdom`). Környezeti hiány, de amíg így van, ez a 12 teszt egy nem
   működő műszer.

---

---

## 6. Utólag: a lánc bezárult (07:00–07:10)

Istvan kérdése — „ki gondolja végig, mit írt vissza az ügyvéd, és mi kell tőlem?
Ez Telegramon jött volna hozzám" — három hiányzó darabot mutatott meg, ebben a
sorrendben.

### 6.1 A levél szövege sosem jutott el a Readerhez

**Mérés:** mind a 22 tárolt email-szál `extracted_text`-je NULL, miközben a
fájlok a lemezen ott vannak, sima szöveggel. A ZST üzletrész-ügyön a Reader ezt
írta ki hiányzó tételként: *„az email_thread tartalma nem értelmezhető"*, és a
labdát EXTERNAL-ra tette. **Helyes válasz egy levélről, amit soha nem látott.**

Előtte-utána, ugyanaz az ügy, ugyanaz a modell:

| | Előtte | Utána |
|---|---|---|
| tények | 9, mind az ügy-kartonról | 22, köztük cégjegyzékszám, adószám, tulajdoni arány, a vételár nyitottsága, Panos külföldi tartózkodása |
| hiányzó tételek | „a szál nem olvasható" | ügyvédi szakvélemény · Panos okmányadatai · alapítási dokumentumok · a vételár megállapodása — **kinél van** mindegyik |

Két korlát szándékos: csak szöveg-szerű mime típus (egy PDF dekódolva zaj, és a
zaj a modellnek tartalomnak látszik), és a beolvasás sha256-ellenőrzött. Az első
teszt-fixture-öm helyőrző checksumot adott, az ellenőrzés visszautasította, és a
teszt a helyes okból bukott.

### 6.2 A Writer (§10.4, első szelet)

A csomag eddig egy táblában ért véget. Most kérdés lesz belőle Istvan saját
csatornáján — a meglévő busz→Telegram úton, amit az outbound-recovery riasztás
már használ. Egy tulajdonos-riasztó út, nem kettő.

Determinisztikus, nem második modell-hívás, ugyanaz az indoklás, mint a
tervezőnél: az ítélet már megtörtént.

Három szabály viszi a súlyt, és egyik sem a megfogalmazás:

1. **Csak akkor kérdez, ha a válasz tényleg az övé.** Egy harmadik félre váró ügy
   nem kérdés — így válik egy értesítő-csatorna zajjá, aztán némítva.
2. **Ugyanazt nem kérdezi kétszer.** A lenyomat az ASK-ot fedi, nem a csomagot:
   egy új tény, ami nem változtat a válaszolandón, nem pingel újra. Ugyanaz a
   doktrína, mint a §10.8 trigger contract — csak most a telefonján.
3. **Sweepenként kettő.** Tizenkét kérdés hajnali háromkor megkülönböztethetetlen
   a spamtől.

A rögzítés az üzenetküldés **előtt** történik: egy összeomlás a kettő között egy
elmaradt kérdésbe kerül, amit egy későbbi sweep újra levezet; a másik sorrend egy
duplikátumba kerül minden sweepen.

**Élő, 07:04:** `questions: {asked: 2, alreadyAsked: 0, nothingToAsk: 1}` — és a
két kérdés meg is érkezett a buszon.

### 6.3 A válasz-út

Egy kérdés, aminek nincs hova a válasza, fél csatorna. A válasz lezárja a nyitott
kérdést ÉS case-eventet ír, amit a pipeline meglévő owner-answer feldolgozása
olvas.

Amit szándékosan **nem** csinál: nem értelmezi a választ a legegyszerűbb
igen/nem-en túl. A 78e81155 kártya a valódi verzió (értelmezés válaszidőben,
javaslatként amit ő megerősít); a találgatás itt szavakat adna a szájába egy
append-only nyilvántartáson.

Egy válasz olyan ügyre, amiről senki nem kérdezett, **visszautasítódik**. Egy
esemény, amit a motor nem tud mihez kötni, rosszabb, mint az elveszett mondat:
úgy nézne ki, mint a válasz a következő kérdésre.

*Marveen, 2026-08-11 — tizenkét találás, egy hibaosztály: egy felület, ami olyan
állapotot jelent, amit nem ellenőrzött.*
