# `progression_mode` — döntési papír

**Kártya:** `fa36dc4b` (high, Marveen)
**Ez a dokumentum:** a döntés bemenete, nem a megvalósítás. Minden állítás alatt mérés van, a `develop`-on (`e054112`).

---

## 1. A lelet, egy mondatban

A `progression_mode` oszlopnak öt értéke van, **egyetlen produkciós kódsor sem ágazik el az értékére**, és a valódi kapcsoló a `progression_enabled`. Ma ez ártalmatlan, mert nincs kimenő út — de úgy néz ki, mint a biztonsági kapcsoló, és nem az.

### A mérés

```
progression_mode  értékre hivatkozó összehasonlítás produkciós kódban:  0
  (a négy találat mind TESZT, és mind azt nézi, hogy az OSZLOP LÉTEZIK-e:
   `c.name === 'progression_mode'` — progression-gate0-eval.test.ts:593,
   progression-checkpoint-a-regression.test.ts:406)

progression_enabled  valódi döntés produkciós kódban:
  progression-pipeline.ts:1484    `(existing?.progression_enabled ?? 0) === 1`
  progression-scheduler.ts:78     `AND progression_enabled = 1`
  progression-scheduler.ts:142    `WHERE domain = ? AND progression_enabled = 1`
```

**Következmény:** a `shadow` és a `live` között ma **nulla** viselkedésbeli különbség van.

---

## 2. Két dolog, ami a leletnél is rosszabb

### 2.1 Az öt szó sehol nincs meghatározva

Végigmérve az összes specen — `v1.0`-tól `v1.5`-ig, 4500+ soron — az `external_shadow` szóra **nulla találat**. Az öt értékű vocabulary kizárólag a séma `CHECK` feltételében létezik (`schema.ts:1717`).

Ez azt jelenti, hogy a kártya nem „kössük be a specet". **A spec nem létezik.** Előbb el kell dönteni, mit jelentenek a szavak.

### 2.2 Két érték soha nem íródik

Kimérve, hogy melyik értéket melyik kódút írja be:

| érték | ki írja | mikor |
|---|---|---|
| `off` | `schema.ts:1701` DEFAULT | minden új sor alapállása |
| `internal` | `intake.ts:195`, `progression-migrate.ts:79` | új személyes ügy, magolt ügy — **`enabled=1`-gyel** |
| `shadow` | `progression-eval.ts:548`, `progression-pipeline.ts:723`, `progression-scheduler.ts:318` (default paraméter) | eval-sorok, új állapotsor |
| `external_shadow` | **senki** | soha |
| `live` | **senki** | soha |

Az öt szóból **kettő elérhetetlen**. Nem „még nincs használatban" — nincs kódút, ami beírná őket.

### 2.3 És a tesztek ezt megerősítik, nem megfogják

Két teszt hivatkozik a `progression_mode`-ra, és mindkettő azt állítja, hogy **az oszlop létezik**. Egyik sem állítja, hogy bármit csinál. Ez rosszabb, mint a teszt hiánya: egy olvasó, aki a teszt nevét látja, azt hiszi, hogy az oszlop őrizve van.

---

## 3. Mi ellen kellene védenie

A mai állapot, mérésből:

- a `personal-case-wake` ütemezett feladat **tízpercenként fut**, `enabled: true` (`ops/scheduled-tasks/personal-case-wake/task-config.json`)
- a saját leírása szerint „esedékes ügyek belső köre, **külső művelet nélkül**"
- a `web.ts:484` naplósora: *„no outbound adapter → no autonomous send"*

Tehát a „nem megy ki semmi" tulajdonságot ma **nem a `progression_mode` tartja fenn, hanem az, hogy nincs kimenő adapter.** Amint az első adapter bekerül, ez a garancia megszűnik, és a helyére semmi nem lép.

---

## 4. A döntés, három lehetséges alakban

### (A) Vágjuk le háromra — `off` / `internal` / `live`

A `shadow` és az `internal` ma ugyanaz; az `external_shadow` sosem létezett.

| mód | jelentés |
|---|---|
| `off` | a pipeline hozzá sem nyúl (ma ezt a `progression_enabled=0` csinálja) |
| `internal` | belső haladás, terv, döntés — **kifelé semmi** |
| `live` | külső műveletek is engedélyezettek |

**Mellette:** a legkevesebb szó, mindegyik jelent valamit, és a `CHECK` maga lesz a dokumentáció.
**Ellene:** migráció kell a meglévő `shadow` sorokra, és elveszítjük a „külső művelet, de csak próbaképp" fokozatot.

### (B) Tartsuk meg az ötöt, de mindegyik kapjon viselkedést

| mód | jelentés |
|---|---|
| `off` | nem fut |
| `shadow` | fut, dönt, de **semmit nem ír** az ügyre — csak naplóz |
| `internal` | fut, ír, belső átmenetek — kifelé semmi |
| `external_shadow` | a kimenő műveletet **megfogalmazza és naplózza**, de nem küldi el |
| `live` | küld is |

**Mellette:** az `external_shadow` pontosan az a fokozat, ami az első adapter bevezetésekor kell — élesben látod, mit küldene, mielőtt küld.
**Ellene:** öt viselkedés öt tesztet jelent, és a `shadow` (ír-e vagy sem) érdemi különbség a mai kódhoz képest.

### (C) Töröljük az oszlopot

Ha a `progression_enabled` elég, a `progression_mode` felesleges, és egy felesleges biztonsági kapcsoló rosszabb a semminél.

**Mellette:** a legőszintébb állapot ma. Nincs több hamis kapcsoló.
**Ellene:** a kimenő műveletek felé menve **valamilyen** fokozat kelleni fog, és akkor újra be kell vezetni.

---

## 5. Amit javaslok: **(B)**, de csak akkor, ha a kimenő út napirenden van

Az érv az `external_shadow` mellett szól, és ez a mérésből jön, nem elvből. A mai rendszer legnagyobb kockázata nem az, hogy rosszul dönt — hanem hogy az első kimenő adapter napján **először éles körülmények között** derül ki, mit küldene. Az `external_shadow` pontosan ezt a napot választja szét kettőre.

Ha viszont a kimenő út **nincs napirenden a következő hetekben**, akkor (C) az őszinte válasz, és (B) később, a valódi igénnyel együtt. Öt szót fenntartani viselkedés nélkül a legrosszabb a háromból, és ma pont ott állunk.

**Amit tehát el kell döntened:** megyünk-e a kimenő műveletek felé a következő hetekben. Ha igen → (B). Ha nem → (C), és (B) akkor, amikor az adapter valóban jön.

---

## 6. Ami a döntés után jön (bármelyik ág)

1. A `CHECK` feltétel és a kódutak összehangolása (migráció a meglévő sorokra).
2. **A tesztek cseréje**: ne az oszlop létezését állítsák, hanem azt, hogy egy `shadow` ügy tényleg nem ír, egy `internal` tényleg nem küld. Ez a mai két teszt legfontosabb hibája, és bármelyik ág választásakor javítandó.
3. Egy pozitív kontroll: a teszt bizonyítsa, hogy a kapcsoló **át tud billenni** — különben egy mindig-`off` rendszeren is zöld lenne.
