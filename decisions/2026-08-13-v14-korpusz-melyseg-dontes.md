# Döntés: a v1.4 kalibrációs korpusz — a 90 nap nem létezik

**Dátum:** 2026-08-13
**Kiváltó mérés:** Marveen, éles store mélysége
**Érinti:** `marveen-autonomous-case-progression-spec-v1.4-proactive-core.md` §26/3–5., §1.4.1, V4-F14

---

## 1. A mérés

| Tábla | Sor | Mélység |
|---|---|---|
| `personal_cases` | 73 | **8 nap** |
| `personal_case_events` | 356 | 52 nap |
| `zst_cases` | 42 | **6 nap** |
| `zst_case_events` | 157 | 6 nap |
| evidence packetek | 177 | 2 nap |
| kanban kártyák | 1629 | 56 nap |

A leghosszabb sorozat 56 nap, és az sem ügy-adat. **A Case-réteg maga 8 napos, a ZST-oldal 6.**

Ez nem hozzáférési probléma. A 90 napos korpusz **nem máshol van — még nem létezik.**

---

## 2. A döntés

**A 90 nap soha nem volt a követelmény. A VOLUMEN volt az, és a 90 nap egy proxy volt hozzá —
akkor választva, amikor a volument még senki nem mérte meg.**

A §1.4.1 kalibráció célja egyetlen kérdés megválaszolása: *egy 30/60/90 napos shadow ablakban hány
elfogadható megfigyelés lesz?* — hogy a value gate ne olyan küszöbbel legyen regisztrálva, ami
elérhetetlen, és hogy a `BLINDING_EVIDENCE_INSUFFICIENT` **előre jelzett** legyen, ne utólag
felfedezett.

Ehhez a **jövőbeli** ráta kell, nem a történeti. A proxy elromlott; a helyettesítése nem
engedmény, hanem a mögötte lévő dolog visszaállítása.

### A regisztráció kettéválik

**Most befagyasztható, nulla adattal:**

- a rubrika és annak verziója;
- az adjudikációs csomag kanonikus sémája;
- a vakítás-teszt teljes terve — `p0=0.5`, `p1=0.7`, `alpha=0.05`, power ≥ 0.80, minimum 40 csomag
  (**levezetve**, nem kézzel beírva);
- **mi számít elfogadható megfigyelésnek** — a definíció;
- az adjudikátorok neve és a kadencia;
- a kontroll-futás azonosítója és konfiguráció-verziója;
- a döntési szabály és a fail-closed kimenetek.

**Mérést igényel, tehát később fagy be:**

- az ablak hossza;
- a találat-küszöb (a „5 találat / 30 nap" jelölt).

### A kalibrációs futás

Egy **CALIBRATION** ág fut: a detektor dolgozik, a jelek és Initiative-ek rögzülnek, **semmi nem
kerül a tulajdonos elé**, és a futás **kizárólag a volument méri.**

Ezután a küszöb a mért felhalmozódásból választódik, és **csak azután** indul a tényleges,
befagyasztott ablak.

### Miért nem ez a V4-F14 tiltott „success-preserving edit"

A V4-F14 azt tiltja, hogy a küszöb **az eredmények ismeretében** változzon. Az „eredmény" a
value-gate eredménye: hogy a találatok materiálisak és inkrementálisak voltak-e — ez **adjudikációt**
igényel. Egy futás, ami csak a **volument** méri és amit **senki nem bírál el**, nem tár fel
eredményt.

A tűzfal ezért nem emlékezet kérdése, hanem kód:

- egy `CALIBRATION` futás kimenete **soha nem kerülhet adjudikációs sessionbe**
  (`assertComparable` megtagadja);
- egy korpusz, amin kalibrációs futás volt, **elveszti a jogát a kontroll-ághoz**
  (`beginRun` megtagadja) — mert a kalibráció proaktív kimenetet állít elő, és aki utána kontrollt
  épít, az látta.

Ebből kiesik egy tulajdonság, amit érdemes külön kimondani: **a kalibráció és a mérés nem oszthat
meg korpuszt.** Ez nem korlátozás, hanem pontosan az, ami helyes.

Mindkét szabály pirosra van járatva.

---

## 3. Miért nem a másik két út

### Nem a „várjunk 6 hetet"

Nem ingyenes. Az elmúlt napokban tíz modul landolt; a következő hat hétben is fog. **Egy változó
detektor mellett felhalmozott korpusz nem befagyasztott korpusz** — a késleltetésnek saját
érvényességi ára van. Ha várni kell, akkor **rögzített konfigurációval** kell várni, ami épp a
kalibrációs futás.

### Nem a kanban / üzenet-történet mint korpusz

Csábító, mert mélyebb. De a határidő-index, a stall-detektor és a sweep mind **Case-réteg állapotot**
olvas: `due_at`, `no_progress_run_count`, `status`. Egy kanban-kártyákból álló korpuszban ezek
nincsenek. Egy ilyen replay a detektort **olyan bemeneten mérné, amit élesben soha nem fog látni** —
és **pontos** számot adna **rossz dologról**. Ez rosszabb, mint egy pontatlan szám a helyes dologról,
mert a pontosság meggyőző.

**Amire viszont jó:** a régebbi levél- és dokumentum-történet legitim **priorként** használható —
hány határidőt hordozó dokumentum érkezik hetente. Nem korpuszként; épelméjűségi korlátként a
volumen-becslés mellé.

---

## 4. Amit a spec szövegében változtatni kell

A §26/3. „90 napos replay korpusz" megfogalmazása **proxyt ír elő a cél helyett.** Helyette:

> A kalibráció addig fut, amíg az elfogadható megfigyelések száma eléri a value-gate és a vakítási
> minta által megkívánt volument — vagy amíg kimondható, hogy nem éri el, és akkor az eredmény
> `NO_EVIDENCE_DUE_TO_LOW_VOLUME`, ami **nem PASS**.

Ez spec-verzió változás, nem csendes újraértelmezés. Rögzítendő.

---

## 5. Amit a mérés még mellékesen megmutat

A `personal_case_events` 52 nap mély, miközben a `personal_cases` 8. **Az ügyek fiatalok, a mögöttük
lévő bizonyíték régebbi** — vagyis a Case-réteg backfillel jött létre levél-történetből.

Ennek két következménye van, és mindkettőt tudni kell a kalibráció tervezésekor:

1. A 73 ügy **nem** 8 nap organikus érkezése. Egy ebből számolt ráta nem a nyugalmi rátát becsüli.
2. A rendszer **felfutásban** van, nem stacionárius. Felfutáson kalibrálva a ráta **felül**becsülhető
   — a kalibrációs futásnak ezt vagy meg kell várnia, vagy kimondottan **felső korlátként** kell
   kezelnie a becslést.

---

## 6. Az adjudikátor

Marveen előre kimondta, hogy ő nem lehet, és a flotta egyetlen ágense sem, mert ők állítják elő a
bírálandó kimenetet. **Ez pontosan a §26/31., és egyetértek.**

A modul rögzíti az `adjudicator_id`-t, de hogy az emberhez tartozik-e és független-e, **kód nem
tudja eldönteni.** Kell: egy primary és egy backup **név**, a kadencia, és egy konkrét
függetlenségi feltétel — az adjudikátor nem írta a detektor szabályait és nem látta a proaktív
kimenetet az ítélet előtt.

---

## 7. Az SDK-tiltás indoklása — javítva

Marveen javítása helytálló, és beépült.

A tiltás indoklása **nem** az volt, hogy „a policy determinisztikus, tehát nincs rá szüksége". Ez ma
igaz, és **rossz indok**, mert a tiltást egy *tulajdonságtól* teszi függővé. Amikor valaki eldönti,
hogy a policynak mégis kell modellhívás — amire joga van —, a tiltás onnantól nem határnak látszik,
hanem akadálynak, és az akadályokat a siető ember eltávolítja.

A helyes indoklás: **a Proactive Core-nak nincs joga modellhez fordulni.** Ez határ, nem tulajdonság.
Akkor is áll, ha a policy egyszer nem lesz determinisztikus, és a megváltoztatása **jog adományozása**
— olyan döntés, amit valakinek hangosan meg kell hoznia.
