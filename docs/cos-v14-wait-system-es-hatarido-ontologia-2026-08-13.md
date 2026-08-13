# v1.4 — WAIT_SYSTEM és a határidő-ontológia

**Mi ez:** a §26 implementációs sorrend **28.** és **13.** pontja. Mindkettő blokkoló volt:
a 28. az auditban **M0** (nincs állapot képességhibára), a 13. pedig a §11.2 E pont teljes
rendezésének és a §17.6 escape hatch-nek az előfeltétele.

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6512 | **6556** (+44) |
| Bukó teszt | 0 | **0** |
| `tsc --noEmit` | tiszta | tiszta |

Hat állítás pirosra járatva valódi szimulált sértéssel.

---

## 1. §19 — capability preflight és a WAIT_SYSTEM állapot

**A védett mondat:** *rendszerhiba ne legyen „Needs István".* Egy halott konnektor, egy hiányzó
kulcs, egy olvashatatlan tábla nem olyasmi, amivel a tulajdonos kezdeni tud. Elé tenni a
legszűkösebb erőforrást költi semmire — és másodszorra már nem olvassa el.

**Miért ez volt a 31 auditpont közül a legfélrevezetőbb.** A `CAPABILITY_RECOVERED` benne van a
§10.8 trigger-szókincsben és a run-főkönyv `CHECK`-jében, amióta megírták őket. Egy audit, ami a
szókincset grepeli, „meglévőnek" olvassa és továbbmegy. A `WAIT_SYSTEM` grep viszont **nulla
találat** volt: **csengő, ajtó nélkül.** Trigger arra, hogy „visszajött a képesség", egy állapotra,
amibe soha nem lehetett belépni, mert semmi nem rögzítette, hogy a képesség elment.

### Amit tartalmaz

- **`capability-preflight.ts`** — determinisztikus, side-effect-free próbák. Konnektor olvasás és
  írás **külön néven** (`CONNECTOR:` / `CONNECTOR_WRITE:`), mert a „tudok-e Gmailt olvasni" és a
  „tudok-e Gmailről küldeni" különböző kérdés különböző válasszal, és összevonva egy READ_ONLY
  telepítés egészen a visszautasítás pillanatáig küldésre képesnek látszik.
- **WAIT_SYSTEM állapot** a `case_progression_state`-en. **Oszlop, nem új tábla:** ez még egy dolog,
  amit a motor tud egy ügyről, amit már nyilvántart, és a §3 a teljes hosszában azt a párhuzamos
  alrendszert tiltja, aminek egy `case_capability_waits` tábla lenne az első téglája.
- **A `WAIT_SYSTEM` döntés a motor szókincsében — de nem a Readerében.** Ez nem elnézés. Egy Reader,
  ami WAIT_SYSTEM-et javasolhat, ki tudná menteni magát egy ügyből egy hiba állításával, és lentebb
  semmi nem ellenőrizné. Álló teszt rögzíti, hogy a Reader listája **szigorú részhalmaz** marad.
- **Determinisztikus recovery trigger.** A parkolt ügy akkor és csak akkor ébred, ha **ugyanaz** a
  capability újra egészséges.

### Két döntés, amit érdemes kiemelni

**Az ismeretlen capability blokkol, és nem újrapróbálható.** A csábító alternatíva — „ismeretlen,
akkor jó lesz" — egy elgépelt követelménynevet csendben azonossá tesz azzal, hogy nem deklaráltunk
semmit; pontosan az a hibamód, ami ellen az egész fájl készült. Nem újrapróbálható, mert a várakozás
nem fog megtanítani a rendszernek egy nevet, amivel nem rendelkezik: ez **telepítési** hiba, és
telepítési hiba a run-főkönyvbe való, nem az ügy döntésébe.

**A WAIT_SYSTEM futás `COMPLETED`, nem `FAILED`.** A motor pontosan azt tette, amit kellett:
ellenőrzött, hibát talált, parkolt, és megnevezte, mire vár. A `FAILED` egy rendszerkimaradást
ugyanabba a vödörbe tenné, mint egy motorhibát, és a reconcile `cycleErrors`-a — ami motorhibák
megtalálására való — időjárással telne meg.

### A sorrend, ami a javítás lényege

A capability-ág a **határidő-szabály előtt** fut. Egy parkolt ügy effektív állapota nem változik,
amíg vár — ugyanaz a case-verzió, ugyanazok a határidők, ugyanaz a hash —, tehát a „nem változott
semmi" szabály örökre azt válaszolná, és az ügy a konnektor visszatérése után is parkolva maradna.
És egy lejárt határidő **nem** ránthatja ki: a még halott képességgel futni csak újraparkol,
sweepenként egyszer, a kimaradás teljes hosszán.

**Opt-in.** Üres `requiredCapabilities` esetén egyetlen ág sem fut le és egyetlen sor sem olvasódik
— minden meglévő út bitre ugyanaz. Ez teszi biztonságossá az élő motorba kötni aznap, amikor
megíródik.

---

## 2. §10.1–10.3 — a határidő-ontológia és az index

**Amit az audit talált:** határidő-adat **tizenegy oszlopnéven, tizennégy táblában, három tárolási
konvencióban** (epoch INTEGER, ISO TEXT, és egy SQL-ben számított „+N nap" relatív ablak), öt
indexszel négy össze nem függő fogalomra, és nulla nézettel arra, hogy *mi esedékes*. A §11.2 E pont
határidő-elsőségű kérdésrendezését pontosan ezért lehetett ma csak félig megépíteni: **nem volt
mihez rendezni.**

### Az index egy projekció, nem negyedik igazságforrás

A §10.2 ezt kimondja, és a fájl ehhez van írva: **semmi nem ír határidőt.** Minden rekord olvasáskor
áll elő abból az oszlopból, ami már a gazdája — nincs másolat, ami elcsúszhat, nincs backfill, amit
ütemezni kell, és nincs migráció, amit el lehet rontani. Álló teszt a `CREATE TABLE` / `INSERT` /
`UPDATE` hiányát állítja, nem ezt a bekezdést hiszi el.

### A §10.3 leltár: fogalmanként pontosan egy státusz

**Tizenkettő `ADAPTED_TO_INDEX`, öt `INTENTIONALLY_DISTINCT`, egy `SUBSUMED`, egy `DEPRECATED`.**

A §10.3 azon záradéka, ami a valódi munkát végzi, az `INTENTIONALLY_DISTINCT`-hez kért **kifejezett
indoklás**. Mert „több határidő-mezőnk van" és „többféle határidőnk van" különböző helyzet különböző
javítással, és csak a leírás választja szét őket. **Öt a huszonegyből egyáltalán nem határidő:**

- `next_progression_at` — a motor saját kadenciája. Senki nem késik el vele. Ha bekerülne, a rendszer
  ötpercenkénti önellenőrzése megjelenne azon a listán, amit a tulajdonos „mire vagyok elmaradva"
  néven olvas — és mivel a motor minden érintett ügyre beállítja, **a teljes állomány rajta lenne.**
- `claim_expires_at`, `progression_claim_expires_at` — lease TTL. Kizárási mechanizmus.
- `action_authorizations.expires_at` — egyszer használatos jegy élettartama.
- `campaign_approvals.valid_until` — a **jóváhagyás** lejárata, nem az ügyé.
- `zst_partners.next_follow_up_at` — CRM-kadencia egy **partnerre**, nem egy ügyre.

A precedencia **kötelemerősség szerint** van kiosztva, nem közelség szerint: a felmondási határidő
jogi szirt, a számla fizetési határideje szankcionált vállalás, az ébresztő egy cetli, amit a
rendszer hagyott magának.

### Amit a teszt saját fixture-je bukkantott ki

A leltár-ellenőrző első mintája `deadline|due|expires`-re keresett — és a
`zst_contracts.expiry_date` **egyikre sem illett.** Valódi szerződéses határidő, TEXT-ben tárolva,
amit semmi nem rendezett. Egy nem odatartozó `INSERT` bukott el egy hiányzó oszlopnéven, és onnan
került elő.

Ez a leltár-ellenőrzés lényege egy mondatban: **egy betűvel szűkebb minta teljes leltárt jelent.**
A minta most `expir`, és a `zst_contracts.expiry_date` külön fogalom — a **felmondási határidő** az
utolsó nap, amikor még nyilatkozni lehet, a **lejárat** az a nap, amikor a szolgáltatás megszűnik.
Egy fogalomba vonva az egyik mindig eltűnne.

### A dátum-normalizálás

Szigorú `YYYY-MM-DD`, és semmi más. A megengedő változat — add oda a `Date.parse`-nak és fogadd el,
ami jön — az, ahogy a `'2026. 09. 01.'` egy másik év érvényes dátumává válik, és ahogy az üres
sztringből 1970 lesz. Van **oda-vissza ellenőrzés** is: a `Date.UTC` boldogan elfogadja a
`2026-02-31`-et és átgörgeti márciusba; egy dátum, ami nem önmagaként jön vissza, sosem volt az a
dátum.

**A nem értelmezhető dátum jelentődik, nem tűnik el.** Egy felmondási határidő, amit az index nem
tud elolvasni, olyan határidő, amit senki nem követ — ez rosszabb, mint egy, ami késik. Nullának
számolni a lehető legcsendesebb módja lenne elmulasztani egy jogi szirtet.

---

## 3. Mi jön ezután

A §26 sorrendből kódolható maradék: 8. (Reader evidence extension), 11. (Initiative → Case
promóció), 14–16. (proaktív sweep, most már van mire rendezni), 17–18. (stall/anomália), 20.
(előkészítés-tervező), 22. (`PreparedInitiative`), 26. (a dryrun-driver perzisztenciája — a
kontroll-ág előfeltétele), 33. (a `V4-F*` fixture-ök egy része).

Változatlanul **nem** kezdhető el itt: a 3–5. (éles adatot igénylő kalibráció és a value-gate
befagyasztás, a shadow **előtt**) és a 31. (nevesített független ember adjudikátor).
