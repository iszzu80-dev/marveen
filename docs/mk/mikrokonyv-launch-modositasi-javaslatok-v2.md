# MikroKönyv – egyértelmű launch-módosítási javaslatok

**Dátum:** 2026-07-17  
**Cél:** A MikroKönyv kontrollált és hiteles piacra viteléhez szükséges termék-, jogi/számítási, UX-, technikai és go-to-market módosítások összefoglalása.

---

## Vezetői álláspont

Az MK-t **nem javasolt általánosan „minden átalányadózónak” megnyitni** az első launchban. A kontrollált indulás megfelelő, de csak szűken meghatározott, accountant-validált élethelyzetekkel.

A jelenlegi termék jó alapjai:

- NAV-adatok behúzása;
- átalányadó-számítás;
- 14 kérdéses onboarding;
- határidő-naptár;
- export;
- KATA–átalányadó összehasonlító;
- reason-code-os blokkolás, ha nincs validált eredmény;
- 3 500 Ft/hó ár.

A fő probléma nem az, hogy kevés a funkció, hanem hogy a piacvezető számlázók már adóteher-számítást, határidőfigyelést, negyedéves 2658-as bevallástámogatást és SZJA-bevallási segítséget is kínálnak.

Ezért az MK launch-pozíciója nem lehet egyszerűen:

> „NAV-ból behúzott adatokkal kiszámítjuk az átalányadódat.”

Hanem:

> **„Megmutatjuk, hogy teljesek-e az adataid, mennyit kell félretenned, mit kell következőként megtenned, és minden számnál láthatod, miből és milyen szabály alapján készült.”**

---

# 1. A launch által támogatott élethelyzetek szűkítése

## Jelenlegi probléma

Az átalányadózás nem egyetlen kalkuláció. A végeredményt többek között befolyásolja:

- főállású vagy mellékállású jogviszony;
- nyugdíjas vagy tanulói státusz;
- évközi kezdés vagy megszűnés;
- szüneteltetés;
- táppénz és más ellátások;
- alkalmazott költséghányad;
- adókedvezmények;
- tevékenységváltás;
- több párhuzamos jogviszony.

## Javasolt launch-corridor

Az első nyilvános verzió csak az alábbi két „zöld útvonalat” támogassa teljes számítással.

### A. Főfoglalkozású, folyamatosan működő EV

- egész évben vagy egyértelmű kezdőnappal aktív;
- nincs szünetelés;
- nincs speciális ellátás;
- nincs jogviszonyváltás a negyedévben;
- 45%-os költséghányad;
- nincs összetett vagy részben érvényesíthető kedvezmény;
- nincs külföldi vagy nehezen besorolható bevétel.

### B. Legalább heti 36 órás munkaviszony mellett működő EV

- a jogviszony a teljes vizsgált időszakban fennáll;
- nincs szünetelés;
- 45%-os költséghányad;
- nincs összetett kedvezmény vagy évközi státuszváltás.

A többi felhasználó regisztrálhat, adatot tölthet be és megtekintheti az előzetes helyzetét, de pontos adóösszeg helyett ezt kapja:

> „Ez az élethelyzet még könyvelői ellenőrzést igényel. Nem mutatunk olyan összeget, amelynek a helyességét nem tudjuk garantálni.”

## Következő támogatási sorrend

1. 80%-os és 90%-os költséghányad;
2. nyugdíjas EV;
3. nappali tagozatos hallgató;
4. évközi indulás;
5. szüneteltetés;
6. jogviszonyváltás;
7. speciális adókedvezmények;
8. több jogviszony kombinációja;
9. ellátásokkal érintett időszakok.

---

# 2. A 2026-os szabálycsomag verziózott termékkomponensként

2026-ban több lényeges szabály változott:

- az általános költséghányad 40%-ról 45%-ra emelkedett;
- az adómentes jövedelemrész 1 936 800 Ft;
- az általános átalányadó-bevételi határ 38 736 000 Ft;
- az alanyi adómentesség határa 20 millió Ft;
- a járulék- és szochobevallás havi helyett negyedéves lett;
- a 2026-os nyomtatvány a 2658, külön 2658-EV lappal;
- a szocho mértéke 13%;
- a tb-járulék mértéke 18,5%;
- a főfoglalkozású vállalkozók minimum-szochoalapjának szabálya is módosult.

## Kötelező módosítás

A szabályok ne szétszórt konstansok legyenek a kódban. Minden számítás használjon verziózott szabályprofilt:

```text
tax_rule_profile
├── jurisdiction: HU
├── tax_year: 2026
├── effective_from: 2026-01-01
├── effective_to: 2026-12-31
├── status: VALIDATED
├── validated_by: accountant/legal reviewer
├── source_refs
├── formula_version
└── golden_test_suite_version
```

A `tbRate=18.5%` és `szochoRate=13%` értékek önmagukban nem teszik validálttá a teljes számítást. A minimumalapok, naparányosítás, státuszok és kivételek ugyanilyen fontosak.

## Launch-gate

Nyilvános eredményt csak olyan számítás adhat, amelynél:

- a szabályprofil `VALIDATED`;
- minden input rendelkezésre áll;
- az élethelyzet támogatott;
- a golden tesztcsomag zöld;
- az alkalmazott szabály hatályos a számított időszakra.

Más esetben kötelező a blokkolt eredmény.

---

# 3. A NAV auto-pull állításának pontosítása

## Jelenlegi kockázat

A „NAV-ból automatikusan behúzzuk az összes bevételt” állítás túl erős lehet.

Az Online Számla-adatok önmagukban nem feltétlenül bizonyítják minden vállalkozás teljes bevételét. Ez különösen fontos lehet:

- pénztárgépes értékesítésnél;
- nyugtás bevételnél;
- külföldi bizonylatoknál;
- nem számla jellegű bevételnél;
- hibás, módosított vagy sztornózott számláknál.

## Javasolt kommunikáció

Ne:

> „A NAV-ból automatikusan behúzzuk minden bevételedet.”

Hanem:

> **„Automatikusan behúzzuk a NAV Online Számla rendszerben elérhető számláidat, majd megmutatjuk, milyen további bevételi adatokat kell még ellenőrizned.”**

## Kötelező adatlefedettségi blokk

Minden számítás előtt legyen egyértelmű státusz.

### Teljesnek jelölt

- NAV-kapcsolat működik;
- a lekérdezési időszak teljes;
- a módosító és sztornószámlák feldolgozottak;
- a felhasználó nyilatkozott az egyéb bevételről;
- nincs feldolgozatlan bizonylat.

### Ellenőrzést igényel

- van kézi számla;
- van külföldi bevétel;
- van pénztárgépes vagy nyugtás értékesítés;
- az időszak egy része hiányzik;
- NAV-kapcsolati hiba történt;
- duplikáció vagy ellentmondás található.

### Hiányos

- nincs sikeres NAV-lekérdezés;
- nincs megadva az egyéb bevétel;
- nem oldható fel egy módosító vagy sztornó kapcsolat.

**Hiányos adatból ne jelenjen meg „fizetendő adó” egyetlen biztos számként.**

---

# 4. A fő termékígéret módosítása

## Nem javasolt

> NAV auto-pull alapú átalányadó-kalkulátor.

Ez technikai és könnyen másolható állítás.

## Javasolt

> **Mindig lásd, mennyit kell félretenned, mi a következő adózási teendőd, és teljesek-e az adataid.**

Másodlagos üzenet:

> **Minden szám visszavezethető a bevételeidre és a hatályos adószabályra. Ha valami bizonytalan, a MikroKönyv nem találgat.**

A versenyelőny három pillére legyen:

1. **Teljesség:** nemcsak összeadja a számlákat, hanem megmutatja, mi hiányozhat.
2. **Magyarázhatóság:** minden szám eredete megtekinthető.
3. **Biztonságos blokkolás:** bizonytalan élethelyzetre nem ad hamis pontosságú eredményt.

---

# 5. Az onboarding rövidítése és rétegezése

A jelenlegi 14 jogosultsági kérdés szakmailag indokolható, de egyetlen hosszú kérdőívként nagy lemorzsolódást okozhat.

## Javasolt onboarding

### 1. Jogosultsági gyorsszűrés

Legfeljebb öt kérdés:

- Egyéni vállalkozó vagy?
- Átalányadózó vagy?
- Főállásban vagy legalább 36 órás munkaviszony mellett vállalkozol?
- Szünetelt-e a vállalkozásod az adott évben?
- Van-e speciális kedvezményed vagy ellátásod?

Ebből azonnal derüljön ki:

- **teljesen támogatott**;
- **részben támogatott**;
- **egyelőre könyvelői ellenőrzést igényel**.

### 2. Adózási profil

Csak a támogatott útvonalhoz szükséges kérdések:

- kezdőnap;
- tevékenység;
- költséghányad;
- jogviszony;
- áfastátusz;
- kedvezmény.

### 3. NAV-kapcsolat

- érthető magyarázat;
- lépésről lépésre setup;
- kapcsolat tesztelése;
- lekérdezési eredmény;
- adatlefedettségi összegzés.

### 4. Első eredmény

Ne az összes funkciót mutassa be, hanem:

- mennyi bevételt lát a rendszer;
- teljesek-e az adatok;
- mennyit javasolt félretenni;
- mi a következő teendő;
- mikor kell újra belépni.

## UX-szabály

Minden kérdés mellett legyen:

> „Miért kérdezzük?”

Példa:

> „A heti 36 órás munkaviszony azért fontos, mert befolyásolja a minimum járulékfizetést.”

---

# 6. A dashboard újratervezése bizalmi cockpitként

A kezdőképernyő négy kérdésre válaszoljon.

## 1. Teljesek az adataim?

Például:

> **Adatlefedettség: ellenőrzést igényel**

- 36 NAV-számla feldolgozva;
- 2 sztornó kezelve;
- január–június lekérdezés teljes;
- egyéb bevételről még nem nyilatkoztál.

CTA:

> „Adatok teljessé tétele”

## 2. Mennyit tegyek félre?

Ne csak egy szám jelenjen meg:

> **Javasolt adótartalék: 286 400 Ft**

Alatta:

- SZJA;
- tb-járulék;
- szocho;
- már befizetett összeg;
- következő fizetési időpont;
- biztonsági státusz.

## 3. Mi a következő teendő?

Például:

> „A III. negyedéves 2658-as bevallás előkészítése október 12-ig.”

A termék napi értéke nem egy havi bevallási folyamat, hanem az év közbeni tartalékképzés és a negyedéves zárás előkészítése.

## 4. Megbízható az eredmény?

Jelölések:

- **Ellenőrzött**
- **Becsült**
- **Hiányos adat**
- **Nem támogatott élethelyzet**

A reason-code maradhat technikai háttéradat, de a felhasználó emberi nyelvű magyarázatot kapjon.

---

# 7. A blokkolt eredmény legyen megoldható feladat

## Nem megfelelő

> `CALCULATION_BLOCKED: RELATIONSHIP_STATUS_UNVALIDATED`

## Javasolt

> **Egy adat hiányzik a járulék kiszámításához**

> Nem tudjuk, hogy 2026. áprilisban legalább heti 36 órás munkaviszonyban álltál-e. Ez befolyásolja a minimum járulékot.

Gombok:

- **Jogviszony megadása**
- **Megkérdezem a könyvelőmet**
- **Könyvelői ellenőrzésre küldöm**

Minden blokkhoz tartozzon:

- érthető ok;
- érintett időszak;
- érintett adónem;
- szükséges adat vagy dokumentum;
- közvetlen megoldási CTA.

---

# 8. A könyvelői workflow előrehozása

A termék továbbra is a vállalkozót célozhatja, de a launchot könyvelői bizalmi csatornával kell megtámasztani.

## Launchra szükséges minimum

A vállalkozó egy gombbal készíthessen:

> **Könyvelői ellenőrző csomagot**

Tartalma:

- adózási profil;
- jogviszony-idővonal;
- NAV-ból betöltött bizonylatok összegzése;
- manuális korrekciók;
- adatlefedettségi nyilatkozat;
- alkalmazott szabályverzió;
- részletes számítás;
- blokkolt vagy bizonytalan pontok;
- változásnapló.

## Kontrollált launch-modell

- 3–5 könyvelői design partner;
- 20–30 valódi EV;
- legalább két negyedéves zárási folyamat;
- minden eltérés kategorizálása;
- kritikus eltérés esetén public launch stop.

A könyvelő ne elsődleges felhasználó legyen, hanem:

- validátor;
- referral partner;
- bizalmi csatorna;
- összetett esetek kezelője.

---

# 9. A banki szinkron időzítése

A banki tranzakció-szinkron üzletileg értékes lehet, de launch előtt nem előzheti meg:

- az adatlefedettséget;
- a jogviszony-kezelést;
- a számítási bizonyíthatóságot;
- a könyvelői review-flow-t.

## Launch utáni helyes sorrend

### Első lépés

Read-only bankszinkron:

- beérkező számlakifizetések párosítása;
- adófizetések felismerése;
- be nem folyt számlák jelzése;
- duplikációjelzés.

### Második lépés

Kategorizálási javaslat:

- javaslatként;
- confidence értékkel;
- felhasználói jóváhagyással;
- teljes változásnaplóval.

### Nem javasolt launchra

- automatikus, felülvizsgálat nélküli kategorizálás;
- banksorból közvetlen adóalap-módosítás;
- teljes pénzügyi könyvelési ígéret.

---

# 10. A KATA-összehasonlító átpozicionálása

A KATA–átalányadó összehasonlító hasznos akvizíciós eszköz, de ne legyen azonos súlyú fő navigációs elem a napi adózási teendőkkel.

## Javasolt szerepe

- landing kalkulátor;
- onboarding előtti lead-generation;
- éves adózási döntési modul;
- „mi történne, ha” szimulátor.

## Fontos korlát

Az összehasonlító világosan különítse el:

- jelenlegi tényleges adat;
- évesített becslés;
- feltételezett bevétel;
- nem támogatott vagy nem számszerűsített szempont;
- jogosultsági feltétel.

Ne jelenjen meg kategorikus ajánlásként:

> „Neked az átalányadó jobb.”

Hanem:

> „A megadott feltételezések mellett az átalányadó becsült éves terhe ennyivel alacsonyabb. A jogosultsági és egyéni körülményeket külön ellenőrizni kell.”

---

# 11. Árazás és trial módosítása

## Havi díj

A **3 500 Ft/hó** tartható belépő árként.

Az MK nem elsősorban árban fog nyerni, hanem:

- több forrásból történő adatellenőrzéssel;
- magyarázható számítással;
- biztonságos blokkolással;
- könyvelőfüggetlen exporttal.

## Trial

Az egy hónapos próba nem ideális, mert a 2658-as bevallási folyamat negyedéves. Egy felhasználó úgy is végigmehet a trialon, hogy nem tapasztalja meg a legfontosabb zárási folyamatot.

## Javaslat

> **Első negyedéves zárás ingyen, maximum 60 napig.**

Egyszerűbb alternatíva:

> **60 napos próba, bankkártya nélkül.**

A trial sikerkritériuma ne a belépés legyen, hanem:

- sikeres NAV-kapcsolat;
- teljes adózási profil;
- első ellenőrzött eredmény;
- első teendő teljesítése;
- könyvelői csomag elkészítése vagy negyedéves zárás.

---

# 12. Launch-analitika

## Minimum mérendő események

1. regisztráció elindult;
2. jogosultsági gyorsszűrés befejeződött;
3. támogatott vagy nem támogatott élethelyzet;
4. NAV-kapcsolat elindult;
5. NAV-kapcsolat sikeres;
6. adatlefedettség teljes vagy hiányos;
7. első ellenőrzött számítás elkészült;
8. blokkolt számítás;
9. blokkolás feloldva;
10. teendő teljesítve;
11. könyvelői csomag elkészült;
12. negyedéves zárás megtörtént;
13. fizetővé vált;
14. második hónapban visszatért.

## Elsődleges launch KPI

> **A regisztrálók hány százaléka jut el hét napon belül teljes adatlefedettségű, ellenőrzött eredményig?**

## Javasolt kezdeti célértékek

| Mutató | Kezdeti cél |
|---|---:|
| Gyorsszűrés befejezése | ≥80% |
| Támogatott profil → NAV-kapcsolat | ≥65% |
| NAV-kapcsolat → első ellenőrzött eredmény | ≥75% |
| Teljes onboarding medián ideje | <10 perc |
| Blokkolás feloldása 7 napon belül | ≥50% |
| 30 napos visszatérés | ≥50% |
| Trial → fizető ügyfél | ≥15–20% |
| Kritikus számítási eltérés | 0% |

Ezek tanulási célok, nem külső iparági benchmarkok.

---

# Javasolt végleges launch-scope

## Kötelezően benne

- támogatott élethelyzetek egyértelmű meghatározása;
- 2026-os validált és verziózott szabályprofil;
- NAV Online Számla kapcsolat;
- módosító és sztornószámla-kezelés;
- manuális és egyéb bevétel rögzítése;
- adatlefedettségi státusz;
- főállású és legalább 36 órás munkaviszony melletti zöld útvonal;
- 45%-os költséghányad;
- SZJA-, tb- és szochoszámítás;
- adótartalék-javaslat;
- negyedéves teendőlista;
- határidőfigyelés;
- emberi nyelvű blokkolás;
- részletes számítási levezetés;
- szabály- és forráshivatkozás;
- könyvelői ellenőrző csomag;
- auditálható változásnapló;
- alap termékanalitika;
- ügyfélszolgálati hibakezelés.

## Launch utáni első 30–60 nap

- 80%-os és 90%-os költséghányad;
- évközi indulás;
- nyugdíjas és tanulói státusz;
- 2658 XML-előkészítés;
- NAV-tervezet vagy beadott adatok összevetése;
- read-only bankszinkron;
- könyvelői megosztás;
- KATA–átalányadó éves szimuláció javítása.

## Kivenném vagy elhalasztanám

- teljes könyvelőprogram irány;
- korlátlan élethelyzet-támogatás állítása;
- automatikus banki kategorizálás;
- nem validált kedvezmények számszerű kezelése;
- szüneteltetés és ellátások megfelelő tesztmátrix nélkül;
- automatikus bevallásbeküldés;
- kategorikus adózási tanácsadás;
- ágazati pótlék – ez nem MK-domain;
- generikus AI-chat mint fő feature.

---

# Go/no-go launch gate

Az MK nyilvános launchja csak akkor javasolt, ha mind teljesül:

- [ ] A támogatott élethelyzetek pontosan dokumentáltak.
- [ ] A 2026-os szabályprofil primary source alapján validált.
- [ ] A tb 18,5% és szocho 13% mellett minden minimumalap és naparányos szabály validált.
- [ ] A 45%-os költséghányad és a 2026-os értékhatárok tesztelve vannak.
- [ ] A negyedéves 2658-as logika validált.
- [ ] Accountant-approved edge-case tesztmátrix elkészült.
- [ ] Minden támogatott golden teszt zöld.
- [ ] Nem támogatott esetből nem szivárog ki pontos adóösszeg.
- [ ] A NAV-adatlefedettség látható és értelmezhető.
- [ ] A sztornó- és módosítószámlák helyesen kezeltek.
- [ ] Legalább 20–30 valódi EV használta.
- [ ] Legalább 3 könyvelő átnézte a számításokat.
- [ ] Legalább 100 különböző számítási eset összevetése megtörtént.
- [ ] Kritikus eltérés: 0.
- [ ] A blokkolásokhoz megoldási út tartozik.
- [ ] A pricing és trial egyértelmű.
- [ ] Van support- és incidenskezelési folyamat.
- [ ] A szabályváltozásokhoz kill switch vagy `validated:false` visszaállítás tartozik.

---

# A legfontosabb termékdöntés

Az MK-t ebből:

> „NAV auto-pullos átalányadó-kalkulátor”

erre kell módosítani:

> **„Átalányadózási kontrollközpont, amely megmutatja, teljesek-e az adataid, mennyit kell félretenned, és mi a következő teendőd – minden számot visszakövethetően, találgatás nélkül.”**

A launch előtt a legfontosabb munka nem egy újabb feature, hanem:

1. a támogatott élethelyzetek szűkítése;
2. a teljes accountant-validált tesztmátrix;
3. az adatlefedettség láthatóvá tétele;
4. az onboarding rövidítése;
5. a blokkolt eredmények megoldható feladattá alakítása;
6. a könyvelői review-csatorna beépítése.

Ezek után az MK hitelesen elindítható. Ezek nélkül a „gate-green” technikai állapot ellenére is túl magas maradna a bizalmi kockázat.
