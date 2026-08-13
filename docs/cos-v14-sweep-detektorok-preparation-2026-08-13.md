# v1.4 — sweep, detektorok, előkészítés

**Mi ez:** a §26 implementációs sorrend **14–18., 20., 22. és 23.** pontja, egy blokkban, a kért
sorrendben.

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6618 | **6680** (+62) |
| Bukó teszt | 0 | **0** |
| `tsc --noEmit` | tiszta | tiszta |

Tizenkét állítás pirosra járatva.

Változatlanul **semmi nincs bekötve**: nincs cron, nincs értesítés, nincs Case-létrehozás,
nincs küldés. §27 Stage 0.

---

## 1. §11 — a Scheduled Proactive Sweep (14–16.)

A sweep dolga nem minden ügy újraelemzése, hanem azoknak az állapotoknak az észrevétele, amelyek
**esemény nélkül** változnak: egy beérkező határidő, egy megavult várakozás, egy megakadt ügy.
Egyik sem küld emailt — a reaktív motor pedig teljesen az köré épült, amik igen.

A §11.2 hat invariánsa a modul **szerkezete**, nem utólag ráaggatva:

| | Invariáns | Hogyan |
|---|---|---|
| A | fairness | közös `roundRobinByDomain`, plusz `starvationDetected` |
| B | monoton kurzor | `MAX()`, nem értékadás |
| C | nincs csendes vágás | `hasMore` + continuation kurzor + `domainLag` + backlog-kor |
| D | due-state előrelépés | a release **és** az előrelépés egy művelet |
| E | prioritás | a §10.2 index precedenciája öröklődik |
| F | claim idempotencia | feltételhez kötött `UPDATE`, lease-szel |

**A D az, ami könyvelésnek látszik és nem az.** Nélküle a sweep örökké ugyanazt a fejet foglalja
és engedi el. A reaktív motorban ez a két művelet külön volt, és a mért eredmény **10 716 futás
101 ügyön egy nap alatt** — a sweep ezt reprodukálná egy réteggel feljebb, futásonként egy
modellhívással.

**A B a legcsendesebb.** A védett alak: A sweep lease-e lejár, B elviszi, dolgozik, és T+2-kor
elengedi. A ekkor felébred és T+1-gyel elengedi. Sima értékadással a kurzor **visszamenne**, és
minden szabály, ami azt olvassa, hogy „mikor néztük meg utoljára", hazugságot olvasna.

**Az E-nél nem találtam ki új rendezést**, hanem a §10.2 határidő-index precedenciáját örököltem —
ami kötelemerősség szerint van kiosztva. Két külön „sürgős" fogalom a sweepben és a kérdés-sorban
előbb-utóbb eltérne, és az eltérés napokig láthatatlan maradna.

### A fairness-helper kiemelése — és miért nem másolás

A `roundRobinByDomain` a `reader-cycle.ts`-ben élt. A proaktív sweepnek ugyanaz a szabály kell —
**de a `reader-cycle` importálja a Readert, a Reader a modell-klienst, az pedig a §15.3 tiltólistán
van.** A `proactive/` onnan nem importálhat.

Két kiút volt, és csak az egyik őszinte: nyolc sort lemásolni, vagy áthelyezni oda, ahol mindkettő
eléri. A másolat két fairness-policy lenne, ami addig egyezik, amíg valaki az egyiket nem hangolja —
és a fairness pont az a fajta szabály, amit hangolni szoktak.

---

## 2. Amit a saját álló ellenőrzésem elrontott

A határidő-ontológia leltár-ellenőrzése **csak a `schema.ts`-t olvasta.** A `proactive/sweep.ts`-ben
deklarált `next_review_at` elsétált mellette: a leltár teljesnek jelentette magát, miközben egy
tizenkettedik határidő-alakú oszlop létezett egy könyvtárral arrébb.

**Az ellenőrzés egy fájlt őrzött, miközben az invariáns a kódbázisról szól.** Ugyanaz a hibaosztály,
mint a minta, ami egy betűvel volt szűkebb — és ugyanúgy derült ki: azzal, hogy hozzáadtam pont azt,
amit el kellett volna kapnia.

Kiterjesztve minden táblát deklaráló fájlra, és a nyomában **öt új fogalom** kapott státuszt:

- `proactive_initiatives.decision_deadline` → **ADAPTED_TO_INDEX**, saját típussal és projekcióval.
  Valódi határidő: el lehet késni vele.
- `proactive_signals.candidate_deadline` → INTENTIONALLY_DISTINCT. **Jelölt**, nem megállapított:
  az indexbe vonva minden gyanú tényleges kötelemnek látszana a listán.
- `proactive_initiatives.internal_safe_deadline` → INTENTIONALLY_DISTINCT. Belső önkorlátozás, sosem
  a tulajdonos felé mutatott dátum — és az index maga számolja, tehát két forrása lenne.
- `proactive_sweep_state.next_review_at`, `claim_expires_at` → INTENTIONALLY_DISTINCT: kadencia és
  lease.

---

## 3. §12–13 — a detektorok (17–18.)

### A mondat, ami köré a §12 épül: **nem minden régi ügy stall**

Egy három hete ügyvédre váró ügy nem akadt meg — **vár, helyesen**, és a rendszernek nincs vele
hasznos dolga. Egy detektor, ami ezt nem tudja megkülönböztetni, minden régi ügy listáját állítja
elő — amit a tulajdonos egy oszlop rendezésével is megkap, és pontosan annyit is ér.

Ezért a §12.1 négy feltétele **ÉS**-sel áll, és a legitim várakozás-státuszok listája **adatként** van
kiírva, nem elrejtve egy `!==`-be.

**Egy dolog, amit a számláló-alapú szabály egyedül elvetne:** az az ügy, amin a motor **még sosem
járt.** Nem tizenkettő eredménytelen futása van, hanem nulla — ez ugyanannak a ténynek az *erősebb*
formája, és egy csak-számláló szabály tartósan vak lenne rá.

### §13: csak amihez már van belső evidence

Nincs lekérés, nincs újraolvasás, nincs kérdezés. Ez nem korlát, amit megkerülünk — **ettől lesz
minden találat idézhető**, és a §4.1 nem fogad el olyan signalt, ami nem az.

Három fajta épült meg (ütköző azonos típusú határidők; státusz és lejárt határidő ellentmondása).
A spec további példái — dokumentumbeli összeg eltérése, ígért válasz elmaradása — **nevesítve vannak
elérhetetlenként**, azzal együtt, mire várnak. A §22 szerint a capability gap capability gapként
jelentendő, nem tiszta nullaként.

És a §13 kimondja: **anomália → signal → kvalifikáció → meglévő Case frissítése, nem automatikus
riasztás.** Semmi nem értesít itt senkit.

---

## 4. §15.4–15.5, §16 — az előkészítés (20., 22., 23.)

### A terv esetspecifikus, nem típus-sablon

3–7 lépés, és a lépések az Initiative **saját** hiányából és feloldatlan követelményeiből
származnak, nem a típusából. Egy terv, ami minden DEADLINE-initiative-re ugyanaz, semmit nem mond
az olvasónak, amit a „DEADLINE" szóból ne tudott volna.

A tervező **soha nem tervez olyan osztályt, amit az Initiative nem kapott meg.** A promóció már
eldöntötte, mit tehet ez a konkrét initiative; itt kibővíteni annyi lenne, hogy megkerüljük azt a
döntést.

### A draft-kapu a legélesebb perem a v1.4-ben

Egy draft nem külső side effect — **egy jóváhagyásra van attól, hogy az legyen.** Ezért az
alapértelmezés **NEM approval-ready**, és a nevesített negatív fixture (V4-F12) egy rossz időalapból
számolt relatív idő.

Ez a hibafajta **láthatatlan a review-ban**: a „7 napja nem érkezett válasz" mondat pontosan
ugyanolyan jól olvasható akkor is, ha a helyes szám 2. Ezért a kapu nem elhiszi a levezetést, hanem
**újraszámolja** a megadott forrás-időbélyegből, és eltérésnél elutasít.

Van egy második, csendesebb hiba is, amit az első ellenőrzés nem lát: ha valaki a „7 nap"-ot
beleírja a prózába, és **senki nem rögzíti, honnan jött a 7**. Akkor nincs mit ellenőrizni — ezért a
kapu külön elutasítja a levezetés nélküli számított állítást.

### §16 — az artifact, ami az egész release-t mérhetővé teszi

A spec öt kérdést sorol: *mit vett észre, miért minősítette fontosnak, mit oldott fel magától, mit
készített elő, mikor és miért szakítaná meg Istvánt.* Mind az öt megválaszolható **a tárolt sorból
egyedül** — Mission Control UI nélkül is.

Kettőt könnyű kihagyással elrontani:

- **`remainingUnknowns`** — nélküle a „mit oldott fel magától"-nak nincs nevezője, és egy
  előkészítés, ami kilencből egyet oldott meg, ugyanúgy néz ki, mint amelyik kilencből kilencet.
- **`interruptionPriority` akkor is, ha NONE** — a „mikor szakítaná meg" kérdés azokról az esetekről
  is szól, ahol a válasz: soha.

---

## 5. Hol tart a §26 sorrend

**Kész:** 1–2. (audit), 6–7., 9–10., 13–18., 20–22., 23., 26., 28., 29., 30., 32.

**Kódolható maradék:** 8. (Reader evidence extension), 11. (Initiative → Case promóció),
12. (Outcome Contract integráció), 19. (resolve-before-ask core integráció),
24–25., 27. (interruption/approval csatorna), 33–34. (fixture-ök, adverzariális készlet).

**Nem kezdhető el itt, változatlanul:** 3–5. (éles adatot igénylő kalibráció és a value-gate
befagyasztás, a shadow **előtt**) és 31. (nevesített, független **ember** adjudikátor).
