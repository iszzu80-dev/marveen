# A §25 audit három nyitott találata — javítva

**Mit zár le:** a `v14-proactive-core-capability-audit-2026-08-13.md` 3., 4. és 13. pontját.
Mindhárom olyan találat volt, amit az audit **mért**, de a javítás nem tartozott a
korábbi megbízásba.

**Egy mondatban:** a kurzor-ellenőrzés mostantól számként hasonlít számokat, a két bekötetlen
söprés kimondja, mennyit hagyott a bound mögött, és a kérdés-sor határidő szerint áll, nem
olvasási sorrendben.

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6078 | **6100** (+22) |
| Bukó teszt | 4 | **4 — ugyanaz a négy** |
| `tsc --noEmit` | tiszta | tiszta |

Mind a 22 új állítás pirosra van járatva: a javítás kikapcsolásával a hozzá tartozó tesztnek
bizonyítottan buknia kell, és ez le is futott. Ahol egy teszt **nem** bukott a régi kódon, azt
alább kimondom.

---

## 1. A kurzor-ellenőrzés szövegként hasonlított számokat (audit 3.)

`reconcile.ts`, `cursorBatchMismatch` — a `§19 KRITIKUS` ellenőrzés, amelynek az a dolga, hogy
kimondja: *a rendszer azt hiszi, feldolgozott olyan levelet, amit nem.*

```sql
-- előtte
AND cp.history_cursor >= b.cursor_after
```

Mindkét oszlop `TEXT`, a Gmail historyId viszont decimális egész. Így a **számjegyek darabszáma**
döntött, nem a pozíció:

- `'9999999' >= '10000000'` szövegként **igaz** → kitalált adatvesztés-riasztás, valahányszor a
  kurzornak kevesebb számjegye volt, mint a kötegnek.
- `'10000' >= '9999'` szövegként **hamis** → néma maradt a valódi esetre. Ez a veszélyes irány:
  a CRITICAL ellenőrzés pont akkor hallgatott, amikor lett volna miről szólnia.

Mostantól `CAST(... AS INTEGER)` összehasonlítás, két őrrel: mindkét oldal csak akkor kerül a
mérlegre, ha tényleg pozíció. Egy triage-köteg `cursor_after`-je `triage-1755000000`, amit az
SQLite `CAST`-ja csendben **0**-nak olvas — őr nélkül minden szintetikus köteg nulla pozíciónak
látszana, és minden fiók „túllépettnek".

A számjegy-teszt (`numericCursorSql`) nem új: az `email-ingest.ts`-ben már ott volt, privátként,
és a `cursorRank` doc-kommentje **név szerint leírta**, hogy a `reconcile.ts`-nek pontosan ez a
hibája van. Egy ismert hiba, megírt javítással, egy fájlnyira. Ezért most exportált, közös
definíció: egy hely mondja meg, mi számít összehasonlítható pozíciónak, vagy egy sem.

**Tesztek** (`cos-reconcile.test.ts`): a két irány külön, plusz a triage-őr. A triage-teszt a
régi kódon **nem** bukik — az a *javítás saját* hibalehetőségét zárja ki, és a GLOB-őrök
kivételével bukik, amit külön lemértem.

---

## 2. A csendes vágás (audit 4.)

Az audit egyetlen helyet talált a `src/cos/` alatt, amely kimondja, hogy a bound betelt
(`followup-autodraft`, `scan_window_exhausted`). A többi söprés csendben döntötte el, mit nem néz
meg — és a jelentés utána megkülönböztethetetlen volt egy teljes körtől.

Ez nem jelentési szépséghiba. Mindkét alábbi söprés a sor **elejéről** vesz egy stabil rendezésben,
tehát ha a sor hosszabb a boundnál, minden ciklus ugyanazt a fejet dolgozza fel, a farok pedig
soha nem kerül sorra — nem „később", hanem soha. Az egyetlen jel, ami ezt elárulná, egy szám.

**A progression-söprés** (`findDuePage` → `HeartbeatResult.remainingDue` + `truncated`, és a runner
kiírja). A `personal: 50` sor eddig ugyanúgy nézett ki akkor is, ha ötven ügy volt esedékes, és
akkor is, ha négyszáz — csak a második backlog.

A maradék **számolva van, nem következtetve** a `cases.length === limit`-ből. A pontosan teli oldal
az egyetlen kétértelmű eset, és ott a tippelés egy egészséges rendszerre mondaná rá, hogy ismeretlen
méretű sor áll mögötte.

**A kérdés-söprés** (`AskResult.windowExhausted`). Minden eddigi számláló olyan ügyről szólt, amit a
söprés **látott** és elutasított; ez arról, amit meg sem nézett. A `LIMIT window + 1` trükk helyett
külön `COUNT`, mert a trükk csak annyit tud mondani, hogy „legalább még egy" — a szám viszont itt a
lényeg: három ügy az ablakon túl egy dolgozó bound, háromszáz egy sor, amit senki nem ürít.
A `COUNT` **szó szerint ugyanazt a jelöltklauzulát** használja, mint a lista (`QUESTION_CANDIDATES_SQL`),
mert két kézzel karbantartott másolat egy release-en belül eltér, és onnantól a „mennyi maradt" szám
más populációról szól, mint a lista, amit kísér.

A Reader (`reader-cycle`) és a goal-enrichment már korábban jelentett `remaining`-et; ezeket nem
kellett bántani.

---

## 3. A kérdés-sor olvasási sorrendben állt (audit 13. / `0d2121a9`)

`owner-question.ts`:

```sql
-- előtte
ORDER BY p.created_at DESC LIMIT 50
```

A `created_at` itt az **evidence packet** ideje, tehát a legfrissebben olvasott ügy kérdezett először.
Ez a „puszta latest read order", amit a §11.2 E pont név szerint kizár.

A söprés bounded (50 jelölt, 2 kérdés, 5 nyitott), tehát amelyik előre sorol, az költi el a keretet.
Egy ügy, aminek a múlt héten járt le a határideje, minden ma reggel olvasott ügy mögött állt —
**tartósan**, mert egy ügy, amit nem olvasnak újra, nem lép előre.

Az új rendezés: határidő-osztály → materialitás → legrégebbi due.

| osztály | mit jelent |
|---|---|
| 0 | lejárt — ezt semmi nem előzi |
| 1 | 72 órán belül esedékes |
| 2 | van határidő, nincs közel |
| 3 | nincs határidő |

Az osztály és nem a nyers időbélyeg azért, mert két határidő szinte soha nem egyezik másodpercre —
nyers `due_at`-re rendezve a materialitás holt súly lenne. Ismeretlen prioritás **hátra** sorol, nem
csendben középre: egy elgépelt érték ne kapjon előléptetést.

A `personal_cases` / `zst_cases` join **domain-re szűkített**. A kizáró alkérdések szándékosan nem
azok: egy kizárás, ami átüt a domainek között, csak elnyomni tud egy kérdést, kitalálni nem — ez a
biztonságos irány. A belső aliasokat átneveztem (`xp` / `xz`), mert a külső `pc`/`zc` árnyékolása
legális és olvashatatlan.

**Hat teszt**, mindegyikben az az ügy, amelyiknek kérdeznie *kell*, a **régebbi** packettel áll —
így az olvasási sorrend önmagában hátra tenné. Mind a hat bukik a régi `ORDER BY`-jal.

---

## 4. Amit szándékosan nem tettem meg

- **A `reconcile.ts` maradék `catch { return null }` blokkjai** változatlanok. Ugyanaz a vakság-osztály,
  de több közülük jogosan tapogat opcionális táblákat; táblánkénti döntés kell, nem vak söprés.
  (Ez a korábbi zárójelentésben is így szerepelt.)
- **A `QUESTION_SCAN_WINDOW` / `maxPerDomain` értékét nem emeltem.** A bound most már **elmondja**,
  mikor telt be — az, hogy mennyi legyen, mérési kérdés, és a mérés eddig nem létezett. Előbb
  legyen adat, aztán szám.
- **A §25 audit M0 pontjai** (adjudikációs apparátus, jóváhagyási csatorna, kontroll-ág) érintetlenek:
  azok nem hibajavítások, hanem a v1.4 megépítendő része.
