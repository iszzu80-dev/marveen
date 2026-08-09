# Zsibongó – szakértői üzleti, piaci és árazási értékelés

**Dátum:** 2026-07-15  
**Vizsgált anyag:** `zsibongo-business-concept.md`  
**Értékelési szempontok:** célpiac, szabályozási és működési relevancia, versenytársak, funkcionális versenyképesség, értékajánlat és árazás.

---

# Vezetői értékelés

A Zsibongó **kódból igazolt funkcióleltárként nagyon erős**, üzleti koncepcióként azonban még nem teljesen piacérett. A technikai termék szélesebb és érdekesebb, mint a legtöbb korai vertikális SaaS, de jelenleg három probléma gyengíti:

1. a célpiac és a jogi kategóriák részben rosszul vannak modellezve;
2. a legerősebb piaci fájdalomhoz, a kötelező szakmai dokumentáció kiváltásához még hiányzik néhány alapfunkció;
3. az értékajánlat túl sok funkciót sorol, és nem mondja el elég világosan, milyen konkrét kockázatot és munkát vesz le az üzemeltető válláról.

A dokumentumban szereplő funkcióállítások alapvetően következetesek, de a belőlük levont üzleti következtetések több helyen pontosításra szorulnak.

| Terület | Értékelés |
|---|---:|
| Technikai funkciókészlet | **8/10** |
| Célpiac meghatározása | **6/10** |
| Valós problémák lefedése | **7/10** |
| Versenyképesség családi bölcsődében | **7/10** |
| Versenyképesség magánóvodában | **4/10** |
| Jogi/compliance modell érettsége | **5/10** |
| Jelenlegi értékajánlat | **5/10** |
| Ár–érték arány egy egységnél | **9/10** |
| Ármodell hálózatnál | **5/10** |

---

# 1. A célcsoport legfontosabb korrekciója

## 1.1 Az „alapítványi bölcsőde” nem intézménytípus

A magyar szabályozás négy bölcsődei ellátási formát különböztet meg:

- bölcsőde;
- mini bölcsőde;
- munkahelyi bölcsőde;
- családi bölcsőde.

Az „alapítványi” ezzel szemben a **fenntartó típusa**, nem külön ellátási forma. Egy alapítvány fenntarthat például családi bölcsődét vagy más bölcsődei formát. A KSH is külön dimenzióként kezeli az ellátási formát és a fenntartó típusát.

Ezért a jelenlegi:

```text
csaladi_bolcsode
alapitvanyi_bolcsode
magan_ovoda
```

modell helyett legalább három külön attribútum kellene:

```text
service_form:
  bolcsode
  mini_bolcsode
  munkahelyi_bolcsode
  csaladi_bolcsode

maintainer_type:
  onkormanyzat
  nonprofit_alapitvany_egyesulet
  egyhazi
  gazdasagi_tarsasag
  egyeni_vallalkozo
  egyeb

operating_model:
  onallo
  halozati_tag
  halozati_fenntarto
  tarsulasi_feladatellatas
```

Ez nem pusztán terminológiai kérdés. Befolyásolja:

- a normatíva számítását;
- a létszám- és személyzeti szabályokat;
- a jelentési kötelezettségeket;
- az ágazati pótlékot;
- a dokumentumokat;
- a működési engedély és a finanszírozás kezelését.

A 2026-os költségvetési szabályok is külön kezelik például az önálló és társulási feladatellátást, valamint a nem állami fenntartók támogatási feltételeit. Az intézménytípus önmagában ezért nem elegendő a normatíva meghatározásához.

## 1.2 A magánóvoda ne legyen induló célcsoport

A magánóvoda más jogi, szakmai és adminisztratív világ, ráadásul az oviKRÉTA már gyermek-, csoport-, alkalmazotti, dokumentum- és riportkezelést biztosít, fejlődéskövetéssel és felhasználói támogatással.

A Zsibongó jelenlegi óvodai szabálycsomagja részleges, ezért a „magánóvodák számára is kész rendszer” állítás jelenleg nem védhető.

### Javasolt elsődleges célpiac

> Magyarországi, nem önkormányzati családi bölcsődék fenntartói, különösen a több szolgáltatási egységet működtető családi bölcsődei hálózatok.

Második fázisban jöhetnek a mini- és munkahelyi bölcsődék. A magánóvoda külön termék- vagy legalább külön szabályozási program legyen.

---

# 2. A piac elég nagy, de nem korlátlan

2024-ben Magyarországon:

- 1 218 családi bölcsőde;
- 8 232 működő férőhely;
- 7 886 beíratott gyermek volt.

A családi bölcsődék közül 959 nonprofit, 150 egyéb és csak 109 önkormányzati fenntartású volt. A számuk 2020 és 2024 között 963-ról 1 218-ra nőtt, de 2023 és 2024 között már csak körülbelül 4%-kal.

Ez jó, koncentrált vertikális piac, de önmagában nem óriási SaaS-piac.

A fájlban szereplő 4 990 Ft-os alapárral az összes 1 218 intézmény teljes megszerzése is csak körülbelül **73 millió Ft éves alap-előfizetési bevételt** jelentene. A korábban említett 3 500 Ft-os áron ugyanez nagyjából **51 millió Ft évente**. Ez természetesen csak elméleti plafon, és nem tartalmazza a hálózatokat, kiegészítő modulokat vagy más bölcsődei formákat.

Következmény:

- rendkívül alacsony ügyfélszerzési költség kell;
- az onboarding és ügyfélszolgálat nem lehet kézimunka-intenzív;
- fontos a több egységet működtető hálózatok megszerzése;
- a 3 500 Ft-os tartós listaár gazdaságilag túl alacsony lenne.

---

# 3. A problémameghatározás és a funkcionális válaszok ellenőrzése

## 3.1 KENYSZI: valós probléma, de az állítást szűkíteni kell

A napi jelenlét és a KENYSZI összhangja valódi és pénzügyileg kritikus probléma. A 2026-os költségvetési szabály szerint a napi nyilvántartási rendszer és a helyi jelenléti kimutatás adatainak egyezniük kell.

A Zsibongó azonban a leírás alapján:

- KENYSZI-sorokat készít;
- összesít;
- CSV-t exportál.

Nem derül ki, hogy közvetlenül beadná vagy szinkronizálná az adatokat a hatósági rendszerrel.

Ezért ne szerepeljen:

> „Automatizálja a KENYSZI-jelentést.”

Helyette:

> „A napi jelenlétből előállítja és ellenőrzi a KENYSZI-adatrögzítéshez szükséges adatokat.”

Ez kisebbnek hangzik, de pontos és hiteles.

## 3.2 Az OJR és más határidők nincsenek megfelelően előtérben

A napi KENYSZI mellett külön országos jelentési kötelezettség is van. Bölcsődei ellátásnál többek között:

- április 30-i és szeptember 30-i jelentés;
- március 15-i nyári zárvatartási jelentés;
- rendkívüli zárvatartás következő munkanapi jelentése szükséges.

A szabálycsomagban ugyan szerepelnek jelentési profiljelzők, de a koncepcióból nem látszik teljes, határidős végrehajtási folyamat.

### Szükséges új központi funkció: Compliance-naptár

Minden kötelezettséghez:

- határidő;
- felelős;
- szükséges adatok;
- státusz;
- emlékeztetés;
- beadás igazolása;
- dokumentum vagy képernyőkép csatolása;
- auditnapló.

Ez nagyobb ügyfélértéket adna, mint például az outbreak board.

## 3.3 A létszámarány-riasztás jelenlegi formájában szakmailag veszélyes

Családi bölcsődénél nem egyszerű gyermek/felnőtt arányt kell ellenőrizni.

A fő szabály:

- alaphelyzetben legfeljebb 5 gyermek;
- segítő személy alkalmazásával legfeljebb 8 gyermek;
- SNI vagy korai fejlesztésre jogosult gyermek esetén külön, csökkenő létszámkorlátok vannak.

Ez egy **állapotalapú megfelelési mátrix**, nem általános `gyermek/gondozó ≤ X` képlet.

A mostani „ratio engine” például azt a téves benyomást keltheti, hogy hat gyermek egy gondozóval megfelel egy 6:1 aránynak, holott hat gyermeknél már a segítő személy jelenléte is releváns feltétel.

Különösen komoly, hogy a UI-ban felkínált `segito` és `kisgyermeknevelo` címkék nincsenek egységesen összekötve az autentikációs és jogosultsági modellel. Ez nem „tisztázandó UI-részlet”, hanem **launch előtti P0 hiba**, mert a jogszerű kapacitás éppen a segítő jelenlététől függ.

A funkciót át kell nevezni és újra kell építeni:

> **Működési kapacitás- és személyzeti megfelelés**

Az engine bemenetei:

- ellátási forma;
- beírt és aznap jelen lévő gyermekek;
- SNI/korai fejlesztési státusz;
- szolgáltatást nyújtó személy jelenléte;
- segítő jelenléte és munkaideje;
- helyettes jogosultsága;
- működési engedélyben szereplő férőhely;
- időszak és nyitvatartás.

## 3.4 A helyettes-hálózat valóban erős megkülönböztető funkció

A jogszabály kifejezetten előírja, hogy a családi bölcsőde fenntartója igazolja a megfelelő képesítéssel rendelkező helyettesítés megoldását betegség vagy váratlan esemény esetére. Az egészségügyi nyilatkozat is releváns követelmény.

Ezért a helyettes-hálózat jó problémafelismerés, és valószínűleg a Zsibongó legnehezebben másolható funkciója.

A jelenlegi piactér azonban csak akkor oldja meg teljesen a problémát, ha tartalmazza:

- képesítés és tanfolyam ellenőrzését;
- egészségügyi nyilatkozat lejáratát;
- kizáró okokra vonatkozó nyilatkozatot;
- ellenőrzött profil státuszt;
- elérhetőségi naptárt;
- vállalási díjat és feltételeket;
- megbízási dokumentumot;
- lemondási és helyettesítési szabályokat;
- intézményenkénti előzetes elfogadást;
- a helyettesítés igazolható dokumentációját.

Enélkül ez egy jó kereső- és kapcsolatteremtő felület, de még nem teljes „helyettesítési garancia”.

Ráadásul piactérként hidegindítási problémája van: a funkció értéke városonként csak megfelelő számú aktív intézmény és helyettes után jelenik meg. Ezért induláskor nem szabad kizárólag erre építeni az értékajánlatot.

## 3.5 A normatíva-funkció nagy érték, de a modell finomításra szorul

A normatíva számítása az egyik legerősebb pénzügyi funkció lehet, mert akár egyetlen hibás hónap értéke is többszöröse lehet az éves szoftverdíjnak.

Viszont a számításhoz nem elég az ellátási forma. Szükséges lehet:

- fenntartó típusa;
- befogadási státusz;
- önálló vagy társulási feladatellátás;
- gyermekenkénti támogatható napok;
- párhuzamos ellátás;
- nyári zárvatartás;
- KENYSZI- és helyi jelenlét egyezése;
- adott évi költségvetési szabálycsomag.

A verziózott szabálycsomag jó architektúra, de a jelenlegi intézménytípus-modell miatt fennáll a veszély, hogy helyes képletet rossz jogi kategóriára alkalmaz.

## 3.6 Gyógyszeradás és allergia: értékes, de nem legyen „jogi garancia”

A hozzájárulás, a napló és a szerveroldali kapuk jó biztonsági megoldások. Ugyanakkor érdemes egyértelműen „biztonsági dokumentációs folyamatként” pozicionálni, nem pedig jogszerű gyógyszeradás automatikus igazolásaként.

Kiegészítendő:

- orvosi utasítás vagy dokumentum csatolása;
- dózis és időpont módosításának verziózása;
- beadás elmulasztása vagy visszautasítása;
- kétlépcsős ellenőrzés;
- rendkívüli esemény és értesítési folyamat;
- gondozói visszaigazolás;
- szülői értesítés és olvasási státusz.

## 3.7 A pénzügyi modulnál tisztázni kell, hogy valódi számlázásról van-e szó

A dokumentum számlák, sztornózás és sorszámozott befizetési bizonylatok kezelését írja le, de NAV Online Számla integrációt nem említ.

Minden áfatörvény szerinti számláról kötelező adatot szolgáltatni a NAV Online Számla rendszerébe; számlázóprogram esetén az adatszolgáltatást automatikusan kell teljesíteni.

Ezért két biztonságos irány van:

1. **díjnyilvántartásként** működik, és nem állít ki adójogi számlát;
2. integrálódik Billingo, Számlázz.hu vagy közvetlen NAV Online Számla rendszerhez.

Amíg ez nincs lezárva, a „számlázás” helyett a következő elnevezés biztonságosabb:

> Díjak, befizetések és hátralékok nyilvántartása.

---

# 4. A jelentős versenytársak

## 4.1 MINIPED – a legfontosabb közvetlen versenytárs

A MINIPED erőssége nem elsősorban az általános intézményüzemeltetés, hanem a kötelező és szakmai bölcsődei dokumentáció:

- módszertani elvárásokhoz igazított csoportnapló;
- fejlődési napló;
- anamnézis;
- családlátogatás és beszoktatás;
- fejlődésértékelés;
- percentilis táblák;
- pedagógiai jellemzés;
- családi füzet;
- mobilalkalmazás.

A BDDSZ értékelése szerint a MINIPED dokumentációja a törzslapot és csoportnaplót is beleértve képes kiváltani a kézzel írt adminisztrációt. Ez komoly szakmai hitelességet ad neki.

A MINIPED nyilvános listaár helyett ajánlatkérést használ, ezért pontos, általánosan érvényes ár-összehasonlítás nem készíthető.

## 4.2 oviKRÉTA – az óvodai szegmensben strukturális versenytárs

Az oviKRÉTA:

- kezeli a gyermekeket, csoportokat és alkalmazottakat;
- gyermek- és csoportnaplókat állít elő;
- dokumentumokat tárol;
- riportokat biztosít;
- követi a gyermek fejlődését;
- képzést és ügyfélszolgálatot nyújt.

Ezért a magánóvodai szegmensben nem elég egy általános „jobb UI” vagy néhány pénzügyi funkció. Markáns kiegészítő érték kellene, például:

- szülői fizetés;
- prémium kommunikáció;
- több telephelyes üzleti irányítás;
- személyzeti piactér;
- speciális magánóvodai CRM.

## 4.3 Nemzetközi benchmarkok

A Famly és a Kinderpedia nem közvetlen magyar megfelelési versenytársak, de megmutatják a felhasználói elvárásokat:

- szülői és dolgozói mobilalkalmazás;
- push értesítések;
- stabil üzenetkezelés;
- gyermekfejlődés;
- digitális dokumentumtár;
- pénzügy és online fizetés;
- napi naplók;
- több telephely;
- támogatott onboarding.

A Kinderpedia induló ára évi fizetésnél €49/központ/hó, a Famlyé £79/hó, tehát a Zsibongó lényegesen alacsonyabb árszinten indul.

---

# 5. Funkcionális versenyképesség

A nyilvánosan látható versenytársi funkciók alapján:

| Terület | Zsibongó helyzete |
|---|---|
| Jelenlét, napi működés | **Erős** |
| KENYSZI-előkészítés | **Erős magyar specializáció** |
| Normatíva és megfelelési figyelmeztetés | **Potenciálisan nagyon erős, de pontosítandó** |
| Helyettes-hálózat | **Egyedi megkülönböztető funkció** |
| Allergia, gyógyszer, elvitel | **Erős biztonsági csomag** |
| Több telephely és szervezet | **Erős** |
| Pénzügyi követés | **Versenyképes, de számlázási státusz tisztázandó** |
| Kötelező szakmai dokumentáció | **Jelentős lemaradás a MINIPED mögött** |
| Gyermekfejlődés dokumentálása | **Jelentős hiány** |
| Családi füzet | **Hiány vagy nem igazolt** |
| Szülői mobilélmény és értesítések | **Nem elég erősen igazolt** |
| Üzenetkezelés | **Éretlen, specifikálatlan** |
| Dokumentumkezelés | **Hiányos vagy nem igazolt** |
| Ágazati szakmai hitelesség | **Még kiépítendő** |
| Ügyfélszolgálat és onboarding | **Üzleti koncepcióban hiányzik** |

**Összességében:** a Zsibongó funkcióban rendben van egy **családi bölcsődei működési és compliance rendszerként**, de még nem állítható róla hitelesen, hogy teljes egészében kiváltja a bölcsődei adminisztrációt.

A legnagyobb funkcionális rés nem az AI vagy az elemzés, hanem:

> a törzslap, fejlődési dokumentáció, teljes csoportnapló és családi füzet ellenőrzésálló digitális kiváltása.

---

# 6. Az ár–érték arány

## 6.1 A fájl szerinti jelenlegi ár

A dokumentum szerint:

- alap: 4 990 Ft/hó;
- extra telephely: 3 900 Ft/hó;
- extra csoport: 2 900 Ft/hó;
- pénzügyi modul: 1 990 Ft/hó.

Egyetlen egységnél ez **kifejezetten jó ár–érték arány**. Már egy elkerült normatívahiba, néhány óra adminisztráció vagy egy gyorsan megoldott helyettesítés többszörösen visszahozhatja az éves díjat.

## 6.2 A 3 500 Ft-os ár

A 3 500 Ft/hó:

- jó pilot- vagy „alapító ügyfél” ár;
- jó lehet az első 30–50 intézmény megszerzésére;
- tartós listaárként azonban túl alacsony.

Ekkora piacon ebből nehéz finanszírozni:

- a jogszabályfrissítést;
- az információbiztonságot;
- a támogatást;
- az adatimportot;
- az onboardingot;
- a helyettes-hálózat működtetését.

## 6.3 A jelenlegi addon-modell hálózatnál kedvezőtlen

A jelenlegi logika alapján egy két telephelyes, három csoportos ügyfél pénzügyi modullal:

```text
4 990 alap
3 900 extra telephely
5 800 két extra csoport
1 990 pénzügy
--------------------
16 680 Ft/hó
```

Ez még lehet reális, de az ügyfél szemében bünteti a természetes növekedést. Ráadásul egyszerre számláz telephely és csoport szerint, miközben családi bölcsődénél a releváns egység inkább az engedélyes vagy szolgáltatási egység.

## 6.4 Javasolt ármodell

Ne legyen egyszerre telephely- és csoportalapú számlázás. Egyetlen, könnyen érthető metrikát érdemes használni:

> **engedélyes családi bölcsődei szolgáltatási egység**

Javasolt ársávok:

| Csomag | Javasolt ár | Tartalom |
|---|---:|---|
| Alapító ügyfél | **3 500–3 990 Ft/egység/hó**, legfeljebb 12 hónapig | pilot, visszajelzés, referencia |
| Alap | **5 990 Ft/egység/hó** | gyermekek, jelenlét, KENYSZI-előkészítés, compliance-naptár, szülői adatfelvétel |
| Működés | **7 990–8 990 Ft/egység/hó** | pénzügy, beosztás, gyógyszer, kommunikáció, dokumentumok |
| Hálózat | **minimum 14 990 Ft/hó**, mennyiségi kedvezménnyel | központi dashboard, több egység, helyettes-hálózat, riportok |

A pénzügyi modult az emelt csomagba érdemes tenni, nem külön 1 990 Ft-os addonként. A túl sok kis addon rontja az érthetőséget és mesterségesen korlátozza az aktív használatot.

---

# 7. Az értékajánlat kritikája

A jelenlegi koncepció lényegében ezt mondja:

> „Van 19+ funkciónk.”

Ez termékbemutatás, nem értékajánlat.

Az intézményvezető nem outbreak boardot, AI-importot vagy rule pack architektúrát akar venni. A következő kérdések foglalkoztatják:

1. Rendben lesznek-e az adataim egy ellenőrzéskor?
2. Elveszíthetek-e támogatást egy rossz vagy elfelejtett jelentés miatt?
3. Mi történik, ha holnap reggel kiesik a gondozó?
4. Mennyi papírt és Excelt tudok megszüntetni?
5. Használni fogják-e a dolgozók és a szülők?

## 7.1 Javasolt jelenlegi értékajánlat

> **Zsibongó a családi bölcsődék napi működési rendszere. A jelenlétből előkészíti a KENYSZI-adatokat, jelzi a létszám- és határidőkockázatokat, egyszerűsíti a szülői adminisztrációt, és segít gyorsan megfelelő helyettest találni.**

Ez igazolható a jelenlegi funkciókkal.

## 7.2 Javasolt célállapoti értékajánlat

A kötelező dokumentáció és a helyettes-ellenőrzés elkészülte után:

> **A Zsibongó egy helyen tartja ellenőrzésre készen a családi bölcsőde napi működését: jelenlét, KENYSZI, kötelező dokumentáció, határidők, pénzügy és igazolt helyettesítés – kevesebb papírral és kisebb támogatási kockázattal.**

## 7.3 Amit nem érdemes a fő marketingüzenetbe tenni

- AI-adatimport;
- outbreak board;
- SDS-készlet;
- technikai adatvédelmi megoldások;
- 19+ funkció;
- „jogi megfelelést garantál”;
- „automatikusan beadja a KENYSZI-t”;
- „teljes bölcsődei adminisztráció”, amíg a szakmai dokumentáció hiányzik.

---

# 8. Javasolt fejlesztési prioritások

## P0 – kontrollált élesítés előtt

1. Ellátási forma és fenntartótípus különválasztása.
2. A `segito`, `szolgaltatast_nyujto_szemely` és `kisgyermeknevelo` szerepek rendbetétele.
3. Az egyszerű ratio engine lecserélése jogi állapotmátrixra.
4. Az e-képviselő jogosultságának leszűkítése a KENYSZI/OJR és kapcsolódó riportokra. A hivatalos e-képviselői szerep az adatrögzítéshez és jelentéshez kötődik; nem indokol automatikus pénzügyi vagy egészségügyi adminjogot.
5. A helyettesek képesítésének, egészségügyi nyilatkozatának és alkalmasságának ellenőrzése.
6. A pénzügyi modul számlázási jogi státuszának tisztázása.
7. Az outbreak board kikapcsolva vagy zárt bétában maradjon a hiányzó QA-kör lezárásáig.
8. Az ÁSZF, adatkezelési tájékoztató és adatfeldolgozói konstrukció lezárása.

## P1 – a valódi piaci előnyhöz

1. Teljes compliance-naptár KENYSZI-, OJR-, zárvatartási és egyéb határidőkkel.
2. Ellenőrzésálló törzslap és fejlődési dokumentáció.
3. Teljes csoportnapló és családi füzet.
4. Adminoldali dokumentumfeltöltés, verziózás és megőrzés.
5. Stabil üzenetkezelés értesítésekkel, olvasási státusszal és sürgős üzenetekkel.
6. Mobilra optimalizált „Mai nap” felület és push értesítések.
7. Módszertani szakértői vagy ágazati partneri validáció.
8. Bevezetési csomag, adatimport és ügyféltámogatási modell.

## P2 – későbbi megkülönböztetés

- AI-import fejlesztése;
- járványügyi aggregáció;
- fejlett hálózati analitika;
- automatikus normatíva-előrejelzés;
- kihasználtság- és pénzügyi dashboard;
- óvodai vagy további ellátási formák.

---

# 9. Végső üzleti ajánlás

**A terméket érdemes piacra vinni**, de kontrollált pilotként, kifejezetten családi bölcsődékre szűkítve.

A jelenlegi legerősebb pozíció:

> **családi bölcsődei működési, jelentési és helyettesítési rendszer**

Nem pedig:

> általános bölcsődei–óvodai all-in-one platform.

A 4 990 Ft-os ár egyetlen egységnél kifejezetten vonzó, a 3 500 Ft csak időben korlátozott alapító árként indokolt. A jelenlegi telephely+csoport addonrendszert viszont érdemes engedélyesenkénti, mennyiségi kedvezményes modellre cserélni.

A termék akkor lehet egyértelműen erősebb ajánlat a hazai piacon, amikor a jelenlegi operációs és compliance funkciók mellé bekerül a MINIPED legerősebb területe: a kötelező szakmai dokumentáció tényleges digitális kiváltása. Addig a Zsibongó **ígéretes és jó árú kiegészítő működési rendszer**, utána válhat valódi elsődleges intézményi platformmá.

---

# Források

- [1997. évi XXXI. törvény – gyermekvédelmi és gyámügyi szabályok](https://net.jogtar.hu/jogszabaly?docid=99700031.tv)
- [15/1998. (IV. 30.) NM rendelet](https://net.jogtar.hu/jogszabaly?docid=99800015.nm)
- [415/2015. (XII. 23.) Korm. rendelet](https://net.jogtar.hu/jogszabaly?docid=a1500415.kor)
- [2026. évi költségvetési szabályok](https://net.jogtar.hu/jogszabaly?docid=a2500069.tv)
- [KSH – Magyar statisztikai zsebkönyv 2024](https://www.ksh.hu/docs/hun/xftp/idoszaki/zsebkonyv/magyar%20statisztikai%20zsebkonyv_2024.pdf)
- [MINIPED](https://miniped.hu/)
- [BDDSZ – MINIPED értékelés](https://bddsz.hu/miniped)
- [oviKRÉTA tudásbázis](https://tudasbazis.ekreta.hu/pages/viewpage.action?pageId=99549225)
- [Kinderpedia pricing](https://www.kinderpedia.co/en/pricing)
- [NAV Online Számla](https://nav.gov.hu/Elethelyzetek-adozasa/vallalkozas/Regisztracio-az-Online-Szamla-rendszerben)
- [Szociális Ágazati Portál – KENYSZI](https://szocialisportal.hu/kenyszi_content/)
