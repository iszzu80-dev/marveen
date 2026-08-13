# A kalibráció a fagyástól számol — és a három szabály, ami nélkül a fagyasztás papír

**Dátum:** 2026-08-13
**Döntő:** Marveen (a kérdésre, amit feltettem: mikortól számoljon a kalibrációs futás)
**Státusz:** kódban, piros-igazolva; spec v1.4.3

---

## 1. A döntés

**A kalibráció a fagyástól számol.** Ez egyszerre old meg hármat:

- a **migrációs csúcs kívül esik** — dátum-karbantartás nélkül;
- az **intake fagyott**, tehát a nevező nem mozdulhat a kísérlet alatt;
- a **triage által létrehozott ügyek bent maradnak**, ahol a helyük van.

---

## 2. Egy visszavont figyelmeztetés — és ez a rész a fontosabb

Marveen a saját korábbi figyelmeztetését pontosította, a saját szavaival: *„félrevezetőbb volt, mint
amennyire igaz."*

Az eredeti állítás — a mai ügyeket a saját email-triage heartbeat hozta létre, tehát a mérendő
rendszer és a mérés forrása nem független — **tényként igaz**, de rossz következtetést sugallt.

> **Az email-triage nem mérési műtermék. Az a termelési beviteli út, ami a kísérlet alatt is futni
> fog.**

Ha kizárnánk az általa létrehozott ügyeket, egy olyan populációt mérnénk, **ami nem létezik**, és a
küszöböt egy soha nem futó rendszerre méreteznénk. Az rosszabb hiba, mint amitől a figyelmeztetés
óvott.

**Hol marad érvényes:** az **organikus érkezési ráta** becslésénél, ahol eredetileg felmerült. A
kalibráció nem természetes rátát becsül, hanem a **jogosult megfigyelések volumenét abban a
rendszerben, ahogy ténylegesen működni fog.** A kettő nem ugyanaz.

**A valódi szennyeződés más, és korábbi:** 45 ügy 2026-08-06-án. Az migráció, nem érkezés, és soha
nem fog megismétlődni. Bármely ablak, ami átér rajta, felfelé torzít — **pont olyan mennyiséggel,
ami meggyőzőnek látszik.**

---

## 3. A három szabály és a betartatásuk

| # | Szabály | Hol áll |
|---|---|---|
| 1 | csak **teljes egészében** fagyás utáni ablak számít | `openCalibrationWindow` a **nyitásnál** utasít vissza, és `VOID_STARTED_BEFORE_FREEZE` állapotban rögzíti is |
| 2 | hash-elmozdulás → az ablak **egészben** elesik, nem levágva | `closeCalibrationWindow` → `VOID_CONFIG_CHANGED_MIDWINDOW`, `observation_count = null` |
| 3 | a bevitel bővülése **lejáratja** a küszöböt | `assertCalibrationStillValid` → a kapuban `CALIBRATION_EXPIRED` |

**Az 1. a nyitásnál utasít vissza, nem a záráskor.** Egy ablak, ami hetekig gyűjt, és csak a végén
derül ki róla, hogy sosem számított, pontosan az a fajta pazarlás, ami után a szabályt szeretnénk
meghajlítani.

**A 2. szerkezetileg is védve van:** a visszatérési értékben nincs `usableUntil`, nincs
`validPrefix`, nincs olyan mező, amiből egy hívó összerakhatna egy megtartható részt. Ez nem
hiányosság — egy részablak formájú mező előbb-utóbb megtalálná a maga hívóját. Van rá teszt, ami a
mezőnevek hiányát állítja.

**A 3. azért kellett előre kimondani, mert ettől semmi nem hibázik.** A küszöb különben tovább élne,
mint a rendszer, amire mérték, és senki nem venné észre.

---

## 4. Miért két ujjlenyomat

```text
detector_config_fingerprint   a KÓD tartalom-hashe (detektor + intake modulok)
intake_surface_fingerprint    a beviteli FELÜLET hashe (connector_id | kind | mode)
```

A forrás-hash kódot fed. **Egy új konnektor viszont adat, nem kód** — bekerülhet anélkül, hogy
egyetlen `.ts` fájl megváltozna, és pontosan azt a bővülést jelenti, amitől a küszöb lejár.

**A `status` szándékosan nincs benne.** Egy ma DOWN konnektor nem másik beviteli felület, csak egy
rosszul lévő ugyanaz. Ha a státusz benne lenne, minden átmeneti hiba lejárttá tenné a kalibrációt —
és egy kapu, ami naponta zajból tüzel, az a kapu, amit kikapcsolnak. Ennek is van **ellenpróbája**
tesztben: a DOWN-ra váltás nem járat le semmit.

A `mode` viszont benne van: `READ_ONLY → READ_WRITE` valódi felület-bővülés.

---

## 5. Amit a mutáns-próba talált

Nyolc mutáns, mind piros — de kettő **először zöld maradt**, és a második érdemi:

**(a) Rosszul megírt mutáns.** A „levágás" mutánst a `count = null` sor *elé* szúrtam, tehát a
javítás utána lefutott, és a mutáns semmit nem változtatott. A tesztben nem volt hiba; a próbában
volt.

**(b) Egy védelem, aminek a hiánya nem látszik.** Az összegzés `WHERE state = 'VALID'` feltételének
eltávolítása **nem változtatott semmin** — mert az első zár (`count = null`) miatt amúgy sincs mit
összeadni. Két zár ugyanazon az ajtón, és a második egyedül **nem volt tesztelve.**

Ez a fajta redundancia addig áll, amíg valaki „feleslegesként" ki nem veszi. Kapott saját tesztet,
ami egy **jövőbeli írót játszik el**: ráír egy számot egy eldobott ablakra, és állítja, hogy az
összeg akkor is nulla.

Nyolcból nyolc mutáns piros:

```text
1. szabaly — a fagyas-elotti nyitas engedve                       → 2 teszt
2. szabaly — az eldobott ablak MEGTARTJA a mert volument          → 1 teszt
2. szabaly — a VOID ablak is beleszamol a kalibralt volumenbe     → 1 teszt  (az uj)
2. szabaly — a kozbeni elmozdulas eszrevetlen                     → 4 teszt
3. szabaly — az intake bovulese NEM jaratja le a kalibraciot      → 3 teszt
3. szabaly — a status is bekerul az intake-hashbe                 → 1 teszt  (ellenproba)
a kapunal — a lejarat-ellenorzes eltavolitva                      → 1 teszt
a kapunal — a lejarat altalanos DEGRADED-be olvasztva             → 1 teszt
```

---

## 6. A kapunál

`CALIBRATION_EXPIRED` **saját kimenet**, nem `EVALUATION_WINDOW_DEGRADED`. Egy általános „degraded"
címke alá söpörve pont az észrevehetetlensége maradna meg — abból a fajtából való, amitől semmi nem
hibázik.

**A sorrend is számít:** a lejárat-ellenőrzés **megelőzi** a volumen-kérdéseket. A
`minimum_eligible_observations` egy adott fagyasztott készülékre volt méretezve; egy számot ehhez
mérni azután, hogy a készülék megváltozott, nem gyengébb válasz — **válasz egy kérdésre, amit senki
nem tett fel.**

Futáskori konfiguráció nélkül nincs ellenőrzés, ugyanazon az elven, mint az `assertFrozenConfig`-nál:
egy kapu, ami az első futást lehetetlenné teszi, nem kapu.
