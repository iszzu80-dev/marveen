# MikroKönyv launch-értékelés — 2026. július 19.

## Vezetői ítélet

**Nyilvános, fizetős launchra jelenleg: NO-GO.**

**Meghívásos, kontrollált termékpilotként: feltételes GO**, de csak úgy, ha a NAV-integráció hiánya egyértelműen látszik, a hibás publikus állításokat azonnal eltávolítjátok, és a pilot nem a teljes kontrollközpont-ígérettel fut.

A termék két, egymástól nagyon eltérő készültségi szinten áll:

| Terület | Becsült készültség |
|---|---:|
| Adószámítási és szabálykezelési mag | **75–85%** |
| Biztonságos blokkolási architektúra | **70–80%** |
| Valós felhasználói értékajánlat | **35–45%** |
| UI és felhasználói folyamat | **40–50%** |
| Kereskedelmi launchképesség | **20–30%** |
| **Összesített fizetős public-launch readiness** | **kb. 40–45%** |

A legfontosabb megállapítás:

> **A MikroKönyv számítási motorja közelebb van a launchhoz, mint maga a termék.**

A korábbi launch-javaslat helyesen az adatlefedettséget, a biztonságos blokkolást, az érthető cockpitot és a validációt tette középpontba. A jelenlegi állapot alapján viszont kiderült, hogy a fő megkülönböztető képesség, a valós NAV-behúzás még csonk, az adatlefedettség nincs megépítve, az app UI-ja nem követi a landing ígéretét, és több bizalmi hibát tartalmaz.

---

# 1. A célmeghatározás értékelése

## A jelenlegi célcsoport túl széles

A „könyvelő nélkül vagy minimális könyvelői támogatással dolgozó átalányadózó egyéni vállalkozók” jó hosszú távú piac, de **nem megfelelő launch-célcsoport**.

Az első launch ideális ügyfele ennél lényegesen szűkebb:

> **Magyarországi, 45%-os költséghányadot alkalmazó, egyszerű szolgáltatói tevékenységet végző egyéni vállalkozó, aki főállású vagy folyamatos heti 36 órás munkaviszony mellett vállalkozik, nem szünetelt, nincs évközi jogviszonyváltása, nincs összetett kedvezménye, és saját maga intézi az adminisztrációját.**

További jó ICP-feltételek:

- számlás, nem elsősorban nyugtás vagy pénztárgépes bevétel;
- nincs jelentős külföldi vagy nehezen besorolható bevétel;
- kevés manuális korrekció;
- fontos neki, hogy számlázóprogramtól független ellenőrzést kapjon;
- nem teljes könyvelést, hanem kontrollt és előrejelzést keres.

A 45%-os költséghányad, az 1 936 800 forintos adómentes jövedelemrész, a 38 736 000 forintos általános bevételi határ, valamint a negyedéves, havi bontású 2658-as bevallási logika valóban a 2026-os szabályok része. A főállású, 36 órás munkaviszony melletti és nyugdíjas státuszok kezelése viszont eltérő járuléklogikát igényel.

## Fontos szakmai korrekció: a diákútvonal

A termékleírás szerint a diákútvonalon egy ideiglenes **17%-os TB-érték** szerepel. Ez nem helyes általános 2026-os kulcs: a nappali tagozatos tanulmányok mellett vállalkozó esetében 18,5% tb-járulék és 13% szocho alkalmazandó a megfelelő alapra. Jó, hogy ez az útvonal jelenleg `NEEDS_REVIEW`, de mindaddig blokkolva is kell maradnia.

## Helyes célmeghatározás

Nem ezt javaslom:

> „Adózási alkalmazás minden átalányadózó egyéni vállalkozónak.”

Hanem:

> **„Független átalányadó-kontroll egyszerű élethelyzetű egyéni vállalkozóknak.”**

Az „egyszerű élethelyzet” nem hátrányos megfogalmazás, hanem bizalmi elem. Megmutatja, hogy a termék tudja, hol vannak a saját határai.

---

# 2. A funkcionális válaszok szakmai ellenőrzése

## Ami kifejezetten jó

A jelenlegi megoldás legerősebb részei:

- verziózott adószabályprofil;
- primary source-okra hivatkozó szabálykezelés;
- minimumalap- és naparányos számítás;
- `validated:false` visszavonási lehetőség;
- nem támogatott esetben zárt bukás;
- adószám kiszivárgásának tiltása;
- könyvelői ellenőrző csomag;
- auditálhatóság és változásnapló;
- sztornós pénzforgalmi nyilvántartás szerkezete.

A 2026-os szabályváltozások miatt különösen fontos a szabályprofil és a kill switch. A 2027-től várható költséghányad-változás miatt a hatályosság lejáratának automatikus figyelése nem elméleti mérnöki igény, hanem közeli valós termékkockázat.

## Amit nem lehet még szakmailag késznek tekinteni

### 1. A NAV auto-pull nem működik

Ez a legsúlyosabb termékhiány, mert **nem egy kiegészítő funkció, hanem a teljes pozicionálás belépési pontja**.

A NAV Online Számla rendszer technikai felhasználóval és gép–gép kapcsolattal lehetővé teszi a számlaadatok lekérdezését, tehát a koncepció technikailag reális. Az Online Számla-adatok azonban nem egyenlők automatikusan a vállalkozás teljes bevételével: különösen a nyugtás és más nem számlás bevételek maradhatnak ki.

A megfelelő termékállítás ezért:

> **„Behúzzuk a NAV-nál elérhető számlaadatokat, és megmutatjuk, milyen további bevételeket kell még ellenőrizned.”**

A jelenlegi formában a landing egy olyan képességet ad el, amely a kódellenőrzés szerint stubon fut. Ez önmagában public-launch blocker.

### 2. Az adatlefedettség hiányzik

A korábbi launch-javaslat egyik legfontosabb eleme volt a háromállapotú adatlefedettség:

- teljes;
- ellenőrzést igényel;
- hiányos.

Ez jelenleg nincs implementálva, miközben az analitika képes teljes adatlefedettséget jelenteni valódi ellenőrzés nélkül. Ez egyszerre:

- UX-hiba;
- számítási biztonsági hiba;
- analitikai adathiba;
- hamis termékbizalom.

A `data_coverage_complete` eseményt addig nem szabad elsütni, amíg tényleges lefedettségi döntés nem történt.

### 3. A demó nem ugyanazzal a motorral számol

Ez súlyos architekturális hiba.

Egy adózási termék demója:

- ugyanazt a production calculation API-t használja;
- vagy ugyanazokat a verziózott számítási függvényeket hívja;
- vagy kizárólag előre generált, production motorból származó fixture-öket mutat.

Külön frontendképlet nem elfogadható. A jelenlegi demó a leírás szerint a teljes jövedelemre számol járulékot, így lényegesen túlszámít.

### 4. A sztornó- és módosítószámla-kezelés még nem bizonyított

A struktúra megvan, de az algoritmust nem hajtották meg valós esetekkel. Ezért ezt nem „kész”, hanem **implementált, validálásra vár** státuszúnak tekinteném.

Kötelező tesztesetek:

- eredeti számla + teljes sztornó;
- részleges módosítás;
- több módosító számla lánca;
- tárgyidőszakon átnyúló módosítás;
- devizás számla;
- hibás technikai érvénytelenítés;
- duplikált NAV-adat;
- kiegyenlítés és teljesítési dátum eltérése.

---

# 3. Versenytársi helyzet

## A legfontosabb közvetlen versenytárs: Billingo

A Billingo Átalányadó Asszisztens Plusz erős közvetlen versenytárs. Tartalmaz többek között SZJA-, TB- és szochokalkulációt, keretjelzést, automatikus kalkulációt, ’58-as XML bevallástervezetet, adókedvezményeket, HIPA-segédletet, szüneteltetést, részfizetéseket és SZJA-bevallási segédletet. Mobilalkalmazásból is elérhető.

**Következmény:** funkciószélességben a jelenlegi MK egyértelműen mögötte van.

Az MK csak akkor tud nyerni, ha nem ugyanazt próbálja olcsóbban nyújtani, hanem valóban hozza ezt a hármast:

1. számlázórendszertől független NAV-kontroll;
2. tényleges adatlefedettség;
3. minden szám magyarázhatósága és biztonságos blokkolása.

Jelenleg e három közül a harmadik részben működik, az első kettő nem.

## Számlázz.hu Keret- és adófigyelő

A Számlázz.hu megoldása erős teljes ökoszisztéma: bevallás-varázsló, keretfigyelő, adókalkuláció, bevételi nyilvántartás, áfapozíció és értesítések. A negyedéves ’58-as bevallás is elkészíthető a rendszerből.

Ez drágább az MK-nál, de:

- számlázás is jár hozzá;
- ismert és bizalmi márka;
- működő bevallási folyamat;
- szakmai ügyfélszolgálat;
- meglévő adatokra és felhasználói rutinokra épül.

## Taxo

A Taxo nem egyszerű szoftveres versenytárs, hanem **helyettesítő megoldás**: teljes digitális átalányadózó könyvelést, bevallásokat, NAV-kapcsolatot, adóegyenleget és ügyfélszolgálatot kínál.

Ez meghatározza az MK árplafonját is. A felhasználó fejében a kérdés az lesz:

> „3 500 forintért én intézem a bevallást egy alkalmazással, vagy valamivel többért valaki el is végzi?”

Ezért az MK-nak nem elég „számolnia”. Sokkal jobb kontrollt és átláthatóságot kell adnia, mint egy általános kalkulátornak.

## Versenyhelyzet összefoglalva

| Szempont | MK jelenleg | Billingo Plus | Számlázz.hu | Taxo |
|---|---|---|---|---|
| Adókalkuláció | Erős motor | Erős | Erős | Szolgáltatás része |
| ’58-as bevallási segítség | Nincs kész | XML-tervezet | Varázsló | Elvégzik |
| NAV-független kontroll | Ígéret, de nem működik | Korlátozottabb | Saját számlákra épít | NAV-hozzáférés |
| Adatlefedettség | Nincs | Részleges | Saját adatökoszisztéma | Könyvelési folyamat |
| Magyarázhatóság | Potenciálisan kiváló | Átlagos | Átlagos | Emberi szolgáltatás |
| Biztonságos blokkolás | Jó alap | Nem ez a fő pozíció | Nem ez a fő pozíció | Könyvelő kezeli |
| Ár | 3 500 Ft bruttó | Hasonló árszint | Magasabb | Magasabb |
| Bizalmi háttér | Új termék | Erős márka | Erős márka | Könyvelési szolgáltatás |

---

# 4. Az ár és az értékajánlat értékelése

## A 3 500 Ft/hó ár önmagában reális

**A kész céltermékhez a 3 500 Ft bruttó/hó jó ár.**

Nem javasolnám tartósan lejjebb vinni. A Számlázz.hu-nál jóval kedvezőbb, a Taxónál körülbelül feleannyi, és a Billingo Pluszhoz közel van.

Viszont a jelenlegi termékállapothoz az ár **még nem indokolható**, mert:

- a fő NAV-wedge nem működik;
- nincs adatlefedettség;
- nincs ’58-as bevallási output;
- nincs fizetési infrastruktúra;
- a dashboard nem hozza a landing ígéretét;
- a demó hibás;
- nincs bizonyított valós pilot.

### Javasolt kereskedelmi modell

**Pilot:**

- ingyenes;
- meghívásos;
- 20–30 kiválasztott egyszerű élethelyzetű EV;
- egy teljes negyedéves zárásig.

**Public beta a működő NAV-kapcsolat után:**

- 60 nap ingyen;
- bankkártya nélkül;
- majd 3 490 vagy 3 500 Ft bruttó/hó;
- 34 900–35 000 Ft/év.

Nem javaslok több csomagot launchkor. A túl korai „Basic / Plus / Pro” csomagosítás csak elfedi, hogy a fő értékút még nincs kész.

## A jelenlegi értékajánlat kritikája

A „mennyit tegyél félre és mi a következő teendőd” jó, de önmagában már nem különleges. A nagy számlázók ugyanezt vagy ennél többet ígérnek.

A valódi megkülönböztető értékajánlat legyen:

> **„A MikroKönyv a NAV-nál látható számláidból és az általad megerősített további bevételekből függetlenül ellenőrzi az adózási helyzetedet. Megmutatja, teljesek-e az adataid, mennyit érdemes félretenned, és mi a következő teendőd. Minden számnál láthatod a forrást és a szabályt; bizonytalan esetben pedig nem találgat.”**

Rövidebb hero:

> **„Lásd, teljesek-e az adataid, mennyit tegyél félre, és mi a következő adózási teendőd.”**

Bizalmi alcím:

> **„Független kontroll a NAV-nál látható számlák és a hatályos adószabályok alapján.”**

A „könyvelők ellenőrizték” mondatot azonnal törölni kell. Nem szabad „szakértők ellenőrizték” formára puhítani sem. Helyette kizárólag bizonyítható állítás használható, például:

> „A számítási szabályokat elsődleges jogszabályi és NAV-forrásokhoz kötjük, és minden eredményt becslésként jelölünk.”

---

# 5. UI-versenyképesség

## Jelenlegi értékelés

| UI-terület | Értékelés |
|---|---:|
| Landing információs szerkezete | 7/10 |
| Landing hitelessége | 3/10 |
| Onboarding alapkoncepció | 7/10 |
| Dashboard | 4/10 |
| Blokkolt eredmény | 2/10 |
| Bizalom és magyarázhatóság | 5/10 |
| Demo | 2/10 |
| Összesített app UX | **kb. 4,5/10** |

A legnagyobb UI-probléma nem vizuális, hanem információs:

> **A landing kontrollközpontot ígér, az alkalmazás funkciócsempéket mutat.**

## Javasolt mobil- és webes főnavigáció

Négy fő pont elegendő:

1. **Áttekintés**
2. **Bevételek**
3. **Teendők**
4. **Továbbiak**

A „Továbbiak” alatt:

- részletes számítás;
- nyugdíjszimulátor;
- KATA-összehasonlító;
- könyvelői export;
- beállítások;
- súgó.

A chatet nem tenném fő navigációba.

## Az új dashboard

### 1. Felső állapotsáv

> **2026. III. negyedév — ellenőrzést igényel**

Mellette:

- utolsó NAV-frissítés;
- szabályverzió;
- támogatott élethelyzet státusza.

### 2. Adatok teljessége

> **92% – egy nyilatkozat hiányzik**

- 42 NAV-számla feldolgozva;
- 2 módosító számla kezelve;
- 1 sztornó feldolgozva;
- egyéb bevételről még nem nyilatkoztál.

CTA:

> **Adatok befejezése**

### 3. Javasolt adótartalék

> **286 400 Ft**

Alatta külön:

- SZJA;
- tb;
- szocho;
- már befizetett összeg;
- következő fizetési dátum.

### 4. Következő teendő

> **III. negyedéves zárás előkészítése**

CTA:

> **Folytatás**

### 5. Eredmény megbízhatósága

- ellenőrzött adat;
- becslés;
- hiányos adat;
- nem támogatott élethelyzet.

## Blokkolt képernyő

A nyers technikai kód ne jelenjen meg főcímként.

Helyette:

> **Nem tudjuk még kiszámítani az áprilisi járulékodat**

> Hiányzik, hogy 2026 áprilisában legalább heti 36 órás munkaviszonyban álltál-e. Ez befolyásolja a minimum járulékalapot.

Gombok:

- **Jogviszony megadása**
- **Dokumentum feltöltése**
- **Könyvelői csomag készítése**

A technikai reason code csak a részletek vagy supportinformációk között szerepeljen.

## Demó

A demót nem javítanám külön képletmódosítással. **A külön demóképletet meg kell szüntetni**, és a demónak ugyanazt a motort kell hívnia, mint az alkalmazásnak.

---

# 6. A korábbi launch-kritériumok aktuális állapota

| Korábbi kritérium | Állapot | Értékelés |
|---|---|---|
| Támogatott élethelyzetek pontosan dokumentáltak | 🟡 | 6/12 útvonal megjeleníthető, de a két launch-corridor nincs eléggé explicit módon dokumentálva |
| 2026-os verziózott szabályprofil | ✅ | A termék legerősebb eleme |
| TB, szocho, minimumalap, naparányosítás validált | ✅/🟡 | A fő útvonalak jók; a diák 17%-os ideiglenes értéke javítandó |
| 45%-os költséghányad és értékhatárok tesztelve | ✅ | Megépült |
| Negyedéves 2658-as logika validált | ✅ | A számítási logika él; bevallási XML még nincs |
| Accountant-approved edge-case mátrix | ❌ | A Rev 4 döntéssel kivettétek |
| Minden támogatott golden teszt zöld | 🟡 | A kód több QA-kaput tartalmaz, de teljes bizonyítékcsomag nincs a dokumentumban |
| Nem támogatott esetből nincs adószám | ✅ | Külön QA fedi |
| NAV-adatlefedettség látható | ❌ | Nem épült meg |
| Sztornó/módosító számlák helyessége bizonyított | 🟡 | Kód létezik, valós meghajtás nincs bizonyítva |
| 20–30 valódi EV pilot | ❌ | Nincs bizonyíték |
| Legalább 3 könyvelő ellenőrizte | ❌ | Nem történt meg |
| 100 különböző eset összevetve | ❌ | Nincs bizonyíték |
| Kritikus eltérés 0 | ❌ | A demóban ismert, jelentős eltérés van |
| Blokkoláshoz megoldási út tartozik | ❌ | A jelenlegi blokkolt UI nem teljesíti |
| Pricing és trial egyértelmű | 🟡 | Az ár kommunikált, de nincs trial- és fizetési folyamat |
| Support- és incidenskezelés | ❌/ismeretlen | Nincs dokumentált evidencia |
| Kill switch működik | 🟡 | Manuális `validated:false` van, az automatikus cron nem fut |

**Összesítés:**

- teljesen teljesült: **5**
- részleges vagy bizonyítatlan: **5**
- nem teljesült: **8**

A korábbi checklist alapján ez körülbelül **40%-os public-launch készültséget** jelent.

---

# 7. Az eredeti checklisten felüli új launch-blokkolók

A kódellenőrzött állapot olyan hibákat mutatott ki, amelyek a korábbi javaslatban nem vagy nem megfelelő súllyal szerepeltek:

1. **A valódi NAV M2M integráció hiánya.**
2. **A hamis könyvelői validációs állítás.**
3. **A demó eltérő és hibás képlete.**
4. **A KATA-összehasonlító kategorikus ajánlása.**
5. **A hibás adatlefedettségi analitikai esemény.**
6. **A kill-switch cron nincs beregisztrálva.**
7. **Nincs fizetési és trial-infrastruktúra.**
8. **Az app dashboardja nem valósítja meg a landing fő termékígéretét.**

Ezek közül az első hat **P0**, nem launch utáni finomhangolás.

---

# 8. Javasolt végleges launch-gate

## Kötelező a public launch előtt

- [ ] Valós NAV Online Számla M2M kapcsolat végponttól végpontig működik.
- [ ] Módosító, sztornó és technikailag érvénytelenített számlák tesztelve vannak.
- [ ] Megépült a teljes / ellenőrzést igényel / hiányos adatlefedettség.
- [ ] A támogatott launch-corridor explicit decision table-ben dokumentált.
- [ ] A diák- és minden ideiglenes szabályútvonal blokkolva vagy javítva.
- [ ] A demó ugyanazt a számítási motort használja, mint az éles termék.
- [ ] A hamis könyvelői állítás minden publikus felületről eltűnt.
- [ ] A KATA kategorikus ajánlás helyett feltételezéses összehasonlítás jelenik meg.
- [ ] A blokkolt eredményekhez közvetlen megoldási út tartozik.
- [ ] A kill-switch cron ténylegesen fut, riasztással.
- [ ] A hibás analitikai események javítva vannak.
- [ ] Legalább 10–20 valódi, támogatott profil végigment egy negyedéves folyamaton.
- [ ] Legalább 50, függetlenül számolt referenciaesettel egyezik a motor.
- [ ] Legalább 1–2 független könyvelő átnézte a támogatott útvonalak számítását.
- [ ] Van support-, incidens- és számítás-visszavonási folyamat.
- [ ] Működik a 60 napos trial és az előfizetés.

## Launch utánra hagyható

- 80%-os és 90%-os költséghányad;
- nyugdíjas és tanulói teljes támogatás;
- évközi kezdés és szüneteltetés minden esete;
- speciális kedvezmények;
- bankszinkron;
- automatikus kategorizálás;
- teljes bevallásbeküldés;
- teljes könyvelői workspace;
- generikus AI-chat.

## Erősen ajánlott az első 30–60 napra

- 2658 XML-tervezet;
- SZJA-bevallási segédlet;
- könyvelői megosztás;
- NAV-adószámla vagy befizetések összevetése;
- 80%-os költséghányad következő támogatott korridorként.

---

# Végső döntés

## A termékstratégia

**Helyes irány**, de csak akkor, ha az MK nem próbál Billingo- vagy Számlázz.hu-klón lenni.

A nyerő pozíció:

> **Számlázórendszertől független, magyarázható adózási kontrollréteg.**

## A funkciók

A számítási és szabálykezelési alap **meglepően erős**, de a felhasználó számára látható fő termékút nincs kész. A NAV, adatlefedettség, cockpit és megoldható blokkolás fontosabb most, mint bármely új kalkulátor vagy szimulátor.

## A UI

Koncepciójában versenyképes lehet, jelenlegi implementációjában **nem versenyképes**. A landing és az alkalmazás közötti ígéretkülönbséget meg kell szüntetni.

## Az ár

A **3 500 Ft bruttó/hó megtartható**, de csak a működő NAV-kontroll és adatlefedettség után. A jelenlegi állapotban csak ingyenes, meghívásos pilot indokolt.

## Launch-ítélet

> **Nem javaslom a nyilvános fizetős indulást.**  
> **Javaslom a kontrollált pilot azonnali előkészítését**, a publikus bizalmi hibák gyors javításával, majd a NAV-integráció és az adatlefedettség elkészülte után egy teljes negyedéves pilotot. A public launch csak ennek sikeres lezárása után legyen engedélyezett.
