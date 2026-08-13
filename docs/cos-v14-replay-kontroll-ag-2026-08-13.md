# v1.4 — replay-főkönyv és a kontroll-ág

**Mi ez:** a §26 implementációs sorrend **26.** pontja (`reactive baseline independent replay/persistence
capability`), a §1.4.6 öt feltétele szerint.

**Miért ez volt a soron következő:** a §1.4 teljes value gate egyetlen állításon áll — *„a reaktív
baseline ezt nem hozta volna fel"*. A §1.4.6 mondja meg, mitől elfogadható ez az állítás, és az utolsó
sora az, ami vág:

> *Emlékezetből, kézi visszatekintéssel vagy a proactive output ismeretében rekonstruált baseline
> **nem elfogadható kontroll**.*

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6556 | **6578** (+22) |
| Bukó teszt | 0 | **0** |
| `tsc --noEmit` | tiszta | tiszta |

Négy állítás pirosra járatva, plusz egy végponttól végpontig futtatott élesítési próba.

---

## 1. Amit az audit talált

A `scripts/cos-dryrun-progression.ts` **valódi** live-safe replay driver: másolaton fut, névre
megtagadja az éles adatbázist, N ciklust hajt végre. De **stdoutra jelent és semmi másra.** Nincs run
azonosító, nincs konfiguráció-verzió, nincs perzisztált kimenet.

És egy szinttel mélyebben nincs **kontroll-ág fogalom** sem: ma egy motor van, nem két
összehasonlítható konfiguráció.

Egy scrollback-puffer a §1.4.6 öt feltételéből nullát teljesít.

---

## 2. A sorrend-kényszer, ami a modul lényege

Egy baseline-t, amit **azután** futtatsz, hogy láttad, mit talált a proaktív oldal, nem lehet
bizonyítéknak tekinteni — akármilyen becsületesen készül. Nem lehet **nem tudni** a választ, miközben
eldöntöd, mit mérsz.

Ez nem fegyelmi kérdés, amit „legyünk óvatosak" megold. **Sorrendi kényszer**, és a modul így is
kezeli:

> Ha egy korpuszon már futott `PROACTIVE_SHADOW` ág, a `beginRun` **megtagadja** a `REACTIVE_CONTROL`
> létrehozását ugyanarra a korpuszra.

A kontroll megy előbb, vagy nem számít kontrollnak.

A szabály **szándékosan egyirányú**: a kontroll utáni proaktív futás a kívánt sorrend; a proaktív
utáni kontroll a hiba. Mindkettőt tiltani csak annyit jelentene, hogy a második ágat soha senki nem
tudná lefuttatni.

És a megtagadás **erre a korpuszra** vonatkozik, nem arra, hogy a főkönyv valaha látott-e proaktív
futást — különben egyetlen kísérlet megmérgezné az összes későbbit.

---

## 3. Az immutabilitás triggerekkel, nem ígérettel

A §1.4.6 azt kéri, hogy a kontroll kimenete **függetlenül és megváltoztathatatlanul**, az adjudikáció
**előtt** rögzüljön. Egy lezárás, amit alkalmazásrétegbeli ellenőrzés véd, olyan lezárás, amit a
következő megírandó script véletlenül átír.

Ezért a `replay_outputs` tábla `UPDATE`/`DELETE` triggerekkel append-only, a lezárt futásba való
`INSERT` abortál, a lezárt futás fejléce fagyott, és futást törölni egyáltalán nem lehet. Ugyanaz a
tartás, amit a case-eseménynapló már használ.

**A lezárás a driverben történik, nem egy későbbi lépésben.** Egy nyitva hagyott futás pontosan
addig maradt szerkeszthető, ameddig valaki rá nem nézett — és a §1.4.6 pont ezt zárja ki.

---

## 4. Két tervezési döntés, amit érdemes kimondani

### A főkönyv KÜLÖN adatbázis a korpusztól

Ha a futás sorai a korpuszba íródnának, **a korpusz megváltozna** — és a futás elején vett ujjlenyomat
onnantól nem azt írná le, amin a következő ág fut. A §1.4.6 első feltétele („ugyanazon a frozen
korpuszon") így **konstrukció szerint** lenne hamis, méghozzá láthatatlanul.

### Az ujjlenyomat TARTALOM, nem fájl

Egy SQLite-másolat eltér az eredetitől lapkiosztásban, WAL-állapotban és szabadlap-sorrendben. A fájl
hasheléséből két azonos korpusz különbözőnek látszana, és az egész összehasonlítás elérhetetlenné
válna olyan okból, aminek semmi köze az adathoz.

Az ujjlenyomatba beletartozik minden ügy `updated_at`-je is: két korpusz ugyanazokkal az ügyekkel,
ugyanazokban az állapotokban, de **más időpontban** nem ugyanaz a korpusz — a motor minden határidő- és
avultsági szabálya pontosan ezt olvassa.

És a „nincs zst ügy" nem ugyanaz, mint a „nincs zst tábla". Ez a csendes eset: egy hibára-átugró
ujjlenyomat a kettőt azonosnak mondaná, és egy ág, amit az egyiken hajtottak, összehasonlíthatóvá
válna egy másikon hajtottal.

---

## 5. Az összehasonlíthatóság verdikt, nem feltételezés

Az `assertComparable` a §1.4.6 feltételeit **ellenőrzi**, nem feltételezi. Azért, hogy a válasz
**azelőtt** érkezzen, hogy egy adjudikátor egy órát töltene olyan csomagokkal, amelyek soha nem
voltak elfogadhatók — és hogy a „összehasonlítottuk" állítás mögött verdikt legyen, ne egy
feltételezés, amit senki nem írt le.

Van benne egy ellenőrzés, amit a `beginRun` **nem** tud elvégezni: az **átfedés**. A `beginRun` azt
akadályozza meg, hogy egy kontroll *létrejöjjön* egy proaktív futás után. De egy proaktív ág, ami
akkor indult, amikor a kontroll még nyitva volt, a közös korpuszon keresztül befolyásolhatta —
és létrehozási idő szerint mindkettő helyesen rendezettnek látszana.

A modul azt is kimondja, amit **nem** tud ellenőrizni: hogy az ág „ugyanazokat a forrásadatokat kapta
meg" a driver hívásának tulajdonsága, nem ezeké a soroké. Amit lehet, ellenőrizve van; amit nem, az
meg van nevezve — nem csendben teljesítettnek számolva.

---

## 6. Amit az éles próba mutatott

Végigfuttattam a drivert egy háromügyes korpuszon. A kontroll-ág lefutott, lezárult
(`ctl-1`, 6 kimenet, digest `e9c60e30…`), a proaktív ág lefutott (`sh-1`, 3 kimenet), és egy **harmadik**
kontroll-futás ugyanarra a korpuszra megtagadva:

```
REFUSING: ezen a korpuszon már futott proaktív ág (sh-1), ezért a reaktív kontroll
most már nem hozható létre: a §1.4.6 szerint a proaktív kimenet ismeretében
előállított baseline nem elfogadható kontroll
```

**Amit ez a próba egyúttal kihozott, és amit tudni kell:** a driver **mutálja** a korpuszt. Ebben a
futásban a két ág ujjlenyomata megegyezett — a `CONTINUE_AUTONOMOUSLY` döntések nem változtattak
semmit, ami az ujjlenyomatba beletartozik —, tehát az `assertComparable` `comparable: true`-t adott.
Ez **véletlen, nem garancia.**

Ezért az üzemeltetési szabály: **minden ág friss másolatról induljon a befagyasztott korpuszról.** Az
ujjlenyomat az, ami az elfelejtett másolatot **megtagadássá** teszi ahelyett, hogy érvénytelen
összehasonlítássá — ha a kontroll bármi lényegeset megváltoztat, a két ujjlenyomat eltér, és az
`assertComparable` visszautasít.

---

## 7. Mi jön ezután

Ez a modul a **kontroll-ág infrastruktúrája**, nem maga a kontroll-ág. Ma egy motor van; a
`REACTIVE_CONTROL` és a `PROACTIVE_SHADOW` ugyanazt a pipeline-t hajtja, csak külön címkével és külön
főkönyvi sorral. **A két konfiguráció megkülönböztetése a következő lépés** — és a §26 sorrendje
szerint helyesen jön a detektor előtt: nincs értelme detektort építeni, amíg nincs mihez képest mérni.

A §26-ból kódolható maradék: 8. (Reader evidence extension), 11. (Initiative → Case promóció),
14–16. (proaktív sweep), 17–18. (stall/anomália), 20. (előkészítés-tervező), 22.
(`PreparedInitiative`), 29. (kanonikus adjudikációs csomag — most már van mit kanonizálni).

Változatlanul **nem** kezdhető el itt: a 3–5. (éles adat) és a 31. (nevesített független ember).
