# Kártya: a radar valódi forrása a websearch legyen — és a kézbesítés kódban

**Állapot:** javasolt · **Prioritás:** high · **Készítette:** Claude, 2026-08-15
**Mérés helye:** `/home/user/marveen-private` (Claude checkoutja), ág `develop`, HEAD `fb931b6`, tiszta fa
**Az élő tárról szóló számok Marveen mérései** — külön jelölve, mert két külön fában és két külön gépen dolgozunk

---

## Egy mondatban

A radarnak két árforrása van: egy **kódolt** (eMAG, a hatóránkénti tick), ami a kilenc
tételből hetet **nem lát**, és egy **működő** (websearch), ami prompton múlik mind a
futásában, mind a kézbesítésében — és hét nap alatt egyszer futott le élesen. Ezért
nyolc napja egyetlen termék-találat sem jutott el Istvanhoz, holott három volt.

A javítás nem az, hogy a rosszabb forrást gyakrabban futtatjuk, hanem hogy **a
websearch lesz A forrás, és a kézbesítése kódba kerül.**

## A mérési alap

**Marveen mérései az élő táron** (2026-08-15):

```
78 megfigyeles / 9 tetel
  RENTAL (1)          DiscoverCars, mukodik, 30 megfigyeles
  laptop (1)          az eMAG minden ticken ad arat
  a masik 7 termek    az eMAG MINDEN ticken best=None -- 6 kotegen at, kivetel nelkul
                      (08-07, 08-08, 08-10, 08-11, 08-13, 08-14)

A harom celar alatti termek-eszleles MIND websearch-forrasu:
  Shopsy 27990 · About You 11745 · ecipo.hu 34120
  -- pontosan azok a boltok, amiket az eMAG nem lat

task_runs, 7 futas:  08-08 skipped · 08-09 FIRED · 08-10 skipped · 08-11 skipped
                     08-12 missed  · 08-13 skipped · 08-14 skipped
                     ok: skipIfBusy=true, a session szinte mindig foglalt
```

**A `best=None` nem magas ár, hanem vakság.** Marveen ezt maga vonta vissza: az a
mondat, hogy „azóta a célár felett van", hamis volt, és pont ez tette a hallgatást
megnyugtatóvá.

**Claude mérései a kódon** (`fb931b6`):

```
radar.ts:59      targetPrice: item.targetPrice ?? null       a celar ELHAGYHATO
radar.ts:181     hit = bestPrice != null && target_price != null && best <= target
                 -> celar nelkuli tetel SOHA nem tud talalatot adni
radar-runner.ts:99  const terms = q.terms ?? item.label      a keresokifejezes az ugy cime lehet
tick.ts:108      if (!canRental && !canProduct) continue     NEMA ugras, nincs szamlalo
schema.ts:823    check_interval_sec INTEGER NOT NULL DEFAULT 86400   ritmus MAR tetelenkenti
schema.ts:835    CHECK (status IN ('ACTIVE','PAUSED','HIT','CLOSED'))
```

A ritmus tehát nem új képesség: a mező megvan, csak ma senki nem állítja be tudatosan.

## AZ ÖT DÖNTÉS

Ezek nem implementációs részletek. Mindegyik olyan, ami egy hónap múlva nem lesz
nyilvánvaló, és ha nincs leírva, „azt hittem, úgy értetted" lesz belőle. A mai nap
legdrágább hibái mind ott keletkeztek, ahol egy döntés csak a beszélgetésben létezett.

### D1. A modell érzékelő, nem kapcsoló

A keresést végezheti modell — az árat a nyílt weben csak úgy lehet megtalálni. De az,
hogy ebből **értesítés lesz-e**, és hogy **elmegy-e**, legyen kódban:

```
sweep szkript (utemezett, NEM skipIfBusy)
  -> kereses (modell/web eszkoz)   ->  strukturalt talalatok
  -> recordObservation             ->  decideNotify
  -> alertRadarHit + markNotified  ->  outbox -> Telegram
```

A mai hiba pontosan az volt, hogy a lánc utolsó szeme prompt: a `radar-web-record.mjs`
saját fejléce mondja ki, hogy *„Does NOT send any alert — the caller (the daily sweep)
decides that from `notify`"*, és az a hívó egy modell, ami elolvassa a stdout JSON-t.

### D2. A szállíthatóság HÁROMÉRTÉKŰ, és a „nem tudom" látszik

Istvan kérése: a találat feltétele ne csak az ár legyen, hanem hogy **Magyarországról
megrendelhető és kiszállítják**. Ezért a megfigyelés hordozzon egy három értékű mezőt:

| érték | jelentés | találat lehet? |
|---|---|---|
| `igen` | igazoltan szállít MO-ra | **igen** |
| `nem` | igazoltan nem | nem |
| `nem tudom` | nem sikerült megállapítani | **nem**, DE meg kell jelennie |

A `nem tudom` **nem eshet ki csendben.** A napi jelzésben külön sorként:
*„3 olcsóbb ajánlat, de a szállítás nem igazolt."* Enélkül visszaépítjük a mai
hallgatást egy szinttel arrébb — egy „nincs adat", ami „nincs jó ajánlat"-nak
olvasódik, pontosan az a hibaosztály, ami ezt a kártyát szülte.

### D3. A ritmust szabály dönti el, nem modell

Istvan azt kérte, a rendszer döntse el. **Nevesített szabállyal**, mert egy modell
által választott ritmust két hét múlva nem lehet megmagyarázni és nem lehet tesztelni.
A modell javasolhat; a tábla dönt.

| az ügy alakja | ritmus | vége |
|---|---|---|
| van határidő (pl. Groupama, szeptember) | hetente; a határidő előtt 2 héttel naponta | a határidő napján `CLOSED` |
| tartós vágy, nincs határidő (cipő) | naponta 2× | `HIT`, vagy Istvan zárja |
| egyszeri kérdés („van-e most olcsóbb") | egy futás | azonnal `CLOSED` |

**Az egyszeri keresésnél a „nem volt olcsóbb" IS jelentés.** Ha elhallgatjuk, nem lehet
megkülönböztetni attól, hogy le sem futott — és ma este pont ezt a különbséget kerestük
egy héten át.

### D4. Két bemenet, EGY létrehozó függvény

A Telegram-kérés és a CoS-ügyből származó tétel is ugyanazt a `createRadarItem`-et
hívja. Nem két külön út. Ez ma este négyszer volt a tanulság: minden új védelem a
személyes úton született, és a másik út egy külön kódúton, később, esetleg megkapta.

**Létrehozási kapu:** célár **és** keresőkifejezés nélkül **nem jön létre tétel.**
A `target_price` a sémában elhagyható, és e nélkül a `radar.ts:181` szerint a tétel
soha nem tud találatot adni — hívott, futó és szerkezetileg néma. A `q.terms` nélkül
pedig az ügy címével keresnénk, ami egy CoS-ügynél ritkán keresőkifejezés.
*(Marveen mérése: a mostani kilencnek mindegyikének van célára és terms-e, tehát ez
nem visszamenőleges gond, hanem kapu előre.)*

### D5. A szolgáltatás nem termék — lásd külön szakasz

---

## A SERVICE_QUOTE FAJTA — külön definiálva

### Mi ez

Egy **megújuló szolgáltatás-szerződés**, aminek lejár a határideje, és a kérdés az,
hogy van-e olcsóbb alternatíva: biztosítás, közmű, telefon/net, előfizetés, bank.
Istvan példája: a Groupama-hosszabbítás szeptemberi határidővel.

### Miért NEM `PRODUCT`

| | `PRODUCT` | `SERVICE_QUOTE` |
|---|---|---|
| az ár | egy listaár, ami kint van | **a te paramétereidtől függ** (életkor, autó, fedezet, cím) |
| „olcsóbb" | ár ≤ célár, mérhető | csak **ajánlatkérés** után valódi |
| a találat | egy konkrét ajánlat, kosárba tehető | **jelöltek**, amikből ajánlatot kell kérni |
| az idő | nyílt végű, amíg le nem csap | **határidőhöz kötött**, utána tárgytalan |
| a kézbesítés | riasztás („most vedd meg") | **kérdés Istvanhoz** („nézd meg ezt a hármat") |

Ha ezt egy kalap alá vesszük a cipővel, két rossz kimenet közül választunk: vagy soha
nem szólal meg (mert nincs `ár ≤ célár`), vagy értelmetlent mond (mert egy irányadó
kalkulátor-árat valódi ajánlatnak vesz).

### A találat definíciója

Nem `ár ≤ célár`. Hanem:

> **N (2–3) hihető alternatíva**, mindegyikhez: a szolgáltató neve, egy **irányadó**
> ár vagy ársáv, a forrás linkje, és hogy **mi kellene egy valódi ajánlathoz**.

Az „irányadó" szó load-bearing: a kimenetben is így kell megjelennie. Egy irányadó ár,
ami valódi ajánlatnak látszik, ugyanaz a hibaosztály, mint a `best=None`, ami „nincs jó
ajánlat"-nak olvasódik.

### A kézbesítés

**Nem riasztás, hanem tulajdonosi kérdés** — a meglévő `owner-question` csatornán, ami
már működik és amin ma 27 kérdés vár. Nem építünk hozzá új utat.

### Az életciklus

A `expires_at` a megújítás határideje. A tétel a határidő napján `CLOSED` lesz —
**akkor is, ha nem találtunk semmit, és akkor ezt ki is mondja.** Egy határidő, ami
csendben elmúlik, rosszabb, mint ha meg sem néztük volna.

### AMIT EZ A FAJTA SOHA NEM CSINÁL

**Nem kér ajánlatot magától.** Egy ajánlatkérés kimenő művelet egy harmadik félhez,
személyes adatokkal — vagyis a `mayCompose` / `mayApprove` mód-kapu hatálya alá esne,
és Istvan döntése ma az, hogy `external_shadow`, `live` nem. Ez a kártya azt a kérdést
**nem nyitja meg.** A `SERVICE_QUOTE` kimenete kizárólag egy kérdés Istvanhoz;
ajánlatot ő kér, vagy egy külön, saját kapuval rendelkező munka fog.

---

## A FELADAT, sorrendben

A sorrend nem ízlés: rossz sorrendben minden lépés csak több néma tételt gyárt.

### 1. A websearch-út kódba kötése *(ez a többi feltétele)*

- a sweep **ütemezett szkript** legyen, ne prompt-vezérelt feladat
- **`skipIfBusy` le** — hét futásból egy éles nem ütemezés, hanem elhalasztás
- a szkript maga hívja a `decideNotify` → `alertRadarHit` → `markNotified` láncot
- a `markNotified` a websearch úton ma **nem fut le senkinél** — emiatt a skill által
  ígért per-shop dedup ezen az úton nem létezik. Ez **túl-értesítés** lenne, nem alul.

### 2. A szállíthatóság mint találat-feltétel

- a megfigyelés hordozza a három értéket (D2)
- a `hit` feltétele bővül: `ár ≤ célár` **és** `szállít = igen`
- a `nem tudom` külön sorként a napi jelzésben, **a nulla esettel együtt**
  (ugyanaz az érv, amiért a `plannedDigest` akkor is megszólal, ha nincs mit mondania)

### 3. A két bemenet, közös létrehozóval

- **Telegram:** Istvan megmondja, mit és mennyiért → értelmezés → `createRadarItem`
- **CoS-ügy:** csak akkor keletkezik tétel, ha az ügyből **kiolvasható** a „mit" és az
  „mennyiért"; ha nem, **nem jön létre tétel** (D4)
- mindkettő ugyanazt a függvényt hívja — **nem másolat, hanem második hívó**

### 4. A ritmus-szabály és az `expires_at`

- a D3 tábla **kódban**, soronként teszttel
- `expires_at` oszlop a `radar_items`-re
- az egyszeri keresés `CLOSED`-del zárul, és a „nem volt olcsóbb" is jelentés

### 5. A `SERVICE_QUOTE` fajta

A fenti külön szakasz szerint, **utoljára**, mert más alak.

---

## ELFOGADÁSI FELTÉTELEK

1. **A kézbesítés kódban van.** RED-bizonyítás: az `alertRadarHit` hívást a sweepből
   kivéve **pontosan** a kézbesítési teszt vált pirosra.
2. **A szállíthatóság PÁRBAN van bizonyítva** — ez a kártya legfontosabb feltétele:
   - egy olcsóbb **és szállítható** ajánlat → **tüzel**
   - egy olcsóbb, de **nem szállítható** ajánlat → **nem tüzel**, DE megjelenik a
     „nem igazolt" sorban
   A második nélkül nem lehet megkülönböztetni a **helyes hallgatást** a **vakságtól** —
   és ez a különbség az, ami ma egy hétig nem látszott.
3. **A napi jelzés a nulla esetet is kimondja** a „szállítás nem igazolt" sorra.
4. **Az egyszeri keresés a „nem volt olcsóbb"-at is jelenti.**
5. **A ritmus-tábla minden sorára van teszt**, és a modell nem írhatja felül.
6. **Létrehozási kapu:** célár vagy `terms` nélkül a létrehozás **elutasít** — teszttel,
   ami az elutasítást állítja, nem a sikert.
7. **A `SERVICE_QUOTE` semmit nem küld ki.** Teszt, ami ezt állítja.
8. **Élesítve, nem csak commitolva:** build → restart → **a valódi végpont meghajtása**,
   és `scripts/running-code-check.sh` exit 0. A 2026-08-15-i lecke: egy javítás, ami
   nincs élesben, nem javítás.

## AMIT EZ A KÁRTYA NEM OLD MEG

- **A `tick.ts:108` néma `continue`-ját.** Ma nem ez okozta a bajt, de **három hibás
  magyarázat épült rá egy este alatt** (kettő Marveené, egy Claude-é), és mindet
  mellékhatásból kellett cáfolni. Külön, kicsi javítás: a kihagyott tételek
  számoljanak, és a szám jelenjen meg a tick jelentésében.
- **Az ajánlatkérést** — lásd a `SERVICE_QUOTE` szakasz utolsó bekezdését.
- **A `progression_mode` bekapcsolását.** Független döntés, Istvané, ügytípusonként.
