# v1.4 — replay/eval instrumentáció és a value gate

**Mi ez:** a §26 implementációs sorrend **32.** pontja (`replay/eval instrumentation including
independent reactive control comparison`), és rajta a §24.2 value-gate metrikák.

**Miért most jött:** ez a **hiányzó láncszem**. A 26. pont után van két lepecsételt, megváltoztathatatlan
replay-futás. A 29. után van kanonikus adjudikációs csomag és vakítás-teszt. **Semmi nem kötötte
össze őket:** nem volt mód két ágból előállítani azt a vak sessiont, amiből a value gate mérődik, és
nem volt metrika, ami az eredményből kiszámolható lett volna.

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6600 | **6618** (+18) |
| Bukó teszt | 0 | **0** |
| `tsc --noEmit` | tiszta | tiszta |

Négy állítás pirosra járatva.

---

## 1. A szabály, ami minden metrikát felülír

A §24.2 kimondja:

> *A value gate csak `VALID` blinding-effectiveness státusz mellett minősíthető PASS-nak.*

Tehát a kapu nem az, hogy „elég dolgot elkaptunk-e". Hanem: **elég dolgot elkaptunk-e ÉS meg tudjuk-e
mutatni, hogy a bíráló nem a csomag formájáról olvasta le az eredetet.**

Egy elkapás-szám, ami elromlott vakítás mellett született, nem gyengébb eredmény — **nem eredmény.**

Ezért az `evaluateValueGate` **a vakítást ellenőrzi először**, még mielőtt az elkapásokat megszámolná.
Ez ellentétes az intuitív sorrenddel, és szándékosan: a számot a bukott vakítás-státusz mellé kiírva
pontosan az az olvasat kínálkozik, amit a spec tilt — *„hetet elkaptunk, igaz, a vakítás kicsit
gyenge volt."*

**A vakítás-verdikt csak vétózni tud.** Nincs olyan út, amin egy jó elkapás-szám elfogadhatóvá tenne
egy törött vakot.

---

## 2. Egy mapper, mindkét ág

A §1.4.3 paritás-követelménye a két csomag-**halmaz** tulajdonsága, és a legolcsóbb módja elrontani
az, hogy írunk egy proaktív és egy reaktív mappert, majd kézzel tartjuk őket szinkronban.

Ezért a `buildSessionFromRuns` **egy** mappert kap, és mindkét ág kimenetére azt alkalmazza. A mapper
**nem kap arm argumentumot** — így nem is tud különbözni a két oldal között. Egy mező csak akkor
jelenhet meg az egyik oldalon, ha a mapper feltételesen bocsátja ki, és azt a paritás-ellenőrzés
ugyanabban a futásban elkapja, mielőtt adjudikátor bármit látna.

---

## 3. A megtagadás olcsó, a hiánya drága

A `buildSessionFromRuns` **bármit tenne, előbb** ellenőrzi a §1.4.6 összehasonlíthatóságot: eltérő
korpusz, lezáratlan ág, átfedés. Ha nem megy át, egyetlen csomag sem íródik ki.

Ez azért van így, mert az alternatíva a legrosszabb módon drága: egy adjudikátor délutánja olyan
csomagokon, amelyek soha nem voltak elfogadhatók — és a végén egy szám, ami **pontosan úgy néz ki,
mint egy érvényes.**

---

## 4. Az összehasonlítás nem ítél

A `compareArms` megmondja, ki mit ért el: mit ért el csak a proaktív ág, mit csak a kontroll, és mit
mindkettő. **Nem mondja meg, hogy ez jó-e.**

Hogy egy proaktív-only találat ért-e valamit, pontosan az a kérdés, amit a §1.4.3 vak emberhez küld.
Itt megválaszolni — heurisztikával, ugyanabból a kódbázisból, ami a kimenetet előállította — annyi
lenne, hogy a rendszer **saját magát osztályozza.**

Egy dolgot érdemes külön kiemelni: a `controlOnly` legalább annyira fontos, mint a `proactiveOnly`.
Egy proaktív ág, ami **elmulasztja**, amit a baseline elkapott, az a hiba, amit senki nem keres —
mert a release-t arra hivatkozva adjuk el, amit *hozzátesz.*

---

## 5. Az inkrementális találat definíciója — kimondva, hogy operacionalizálás

A §24.2 megnevezi az `incremental_material_catch_count` metrikát, de a join-t nem írja le. Az itteni
olvasat a **legszűkebb**: egy PROAKTÍV csomag, amit egy vak bíráló **materiálisnak és időszerűnek**
ítélt, olyan ügyön, **amit a kontroll ág soha nem ért el.**

Azért a legszűkebb, mert a lazább olvasat azt a számot fújná fel, amit a release gate olvas — és a
release gate az, amiért ez az egész készült. Egy teszt külön rögzíti, hogy a **közös** ügyek, még ha
materiálisnak ítélik is őket, nem számítanak bele.

---

## 6. A metrikák, amik nem hagyják magukat meghamisítani

**Egyetlen kontroll-futásnak nincs reprodukálhatósági rátája — `null`, nem `1.0`.** Egy tökéletes
pontszám arról, hogy sosem próbáltuk meg, pontosan az a metrika-alak, aminek a megszüntetéséért ez az
egész release készül.

**A §21.1 metrikák, amikhez ground truth kell, meg vannak nevezve elérhetetlenként, nem nullázva.**
A `true_positive_rate`, a `false_positive_rate` és a `missed_material_signal_rate` mind emberi
ítéletet igényel — ez az, amiért a vak adjudikáció létezik —, és 0-ként jelenteni őket
**capability gap lenne metrika ruhájában.** A §22 fixture-set elfogadása ezt név szerint zárja ki:

> *any capability gap is reported as a capability gap rather than a false zero/green metric*

**A lefedettség (`blind_adjudication_coverage_rate`) mindig jelentődik**, hogy egy félig elbírált
session ne látszódjon teljesnek.

---

## 7. A négy kimenet, és hogy melyik nem PASS

| Kimenet | Mikor |
|---|---|
| `PASS` | vakítás VALID **és** elég megfigyelés **és** elég inkrementális találat |
| `FAIL` | törött vakítás, vagy elég megfigyelés mellett kevés találat |
| `EVALUATION_WINDOW_DEGRADED` | a vakítás-minta nem gyűlt össze |
| `NO_EVIDENCE_DUE_TO_LOW_VOLUME` | kevesebb megfigyelés a regisztrált minimumnál |

Az utolsó kettő **nem PASS**, és nem is FAIL: az ablak nem tudta feltenni a kérdést. A kettő
összemosása — „nem találtunk semmit, tehát nem ér semmit" — pont az a következtetés, amit alacsony
volumenen nem szabad levonni.

---

## 8. Mi jön ezután

A §26-ból kódolható maradék: 8. (Reader evidence extension), 11. (Initiative → Case promóció),
14–16. (proaktív sweep — a határidő-index és a continuation-jelzés megvan hozzá), 17–18.
(stall/anomália), 20. (belső előkészítés-tervező), 22. (`PreparedInitiative` perzisztencia),
33. (`V4-F*` fixture-ök).

**A mérési lánc innentől teljes, csak adat nincs benne:** befagyasztott korpusz → két lepecsételt ág
→ kanonikus vak csomagok → ítélet + origin-tipp → vakítás-teszt → value gate. Amit ez a konténer nem
tud hozzátenni, az továbbra is a 3–5. pont (éles adat a kalibrációhoz, a shadow **előtt**) és a 31.
(nevesített, független **ember** adjudikátor).
