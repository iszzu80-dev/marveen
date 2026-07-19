# MikroKönyv

## Üzleti, szakmai és versenypiaci értékelés

*A célpiac, a funkciók, a versenyhelyzet, az értékajánlat és a 3 500 Ft/hó árazás kritikai felülvizsgálata*

| Döntési státusz | Fő árpozíció | Elsődleges termékirány |
|---|---|---|
| **Korrigálandó, de életképes** | **3 490 Ft bruttó / hó** | **Adózási cockpit** |

**Készült:** 2026. július 15.  
**Alapdokumentum:** MikroKönyv – üzleti koncepció, valós kódbázisból igazolt funkciólista.  
**Külső ellenőrzés:** NAV, Magyar Államkincstár, hatályos jogszabályok és hazai piaci ajánlatok alapján.

*Az árak és piaci ajánlatok a 2026. július 15-én elérhető nyilvános információkat tükrözik.*

## Tartalom

1. [Vezetői értékelés](#1-vezetői-értékelés)
2. [Kritikus szakmai korrekciók](#2-kritikus-szakmai-korrekciók)
3. [A célcsoport értékelése](#3-a-célcsoport-értékelése)
4. [Versenytársak és piaci pozíció](#4-versenytársak-és-piaci-pozíció)
5. [Funkciószintű versenyképesség](#5-funkciószintű-versenyképesség)
6. [A 3 500 Ft/hó ár értékelése](#6-a-3-500-fthó-ár-értékelése)
7. [Az értékajánlat kritikája és új javaslat](#7-az-értékajánlat-kritikája-és-új-javaslat)
8. [Javasolt fejlesztési sorrend](#8-javasolt-fejlesztési-sorrend)
9. [Végső döntési javaslat](#9-végső-döntési-javaslat)
10. [Források](#10-források)

## 1. Vezetői értékelés

**A MikroKönyv alapötlete és szűk célcsoportja üzletileg jó,** de a termék a dokumentumban leírt állapotában még nem nyitható meg fizetős, önkiszolgáló szolgáltatásként.

Ennek nem elsősorban a zárt regisztráció az oka, hanem két olyan adószakmai hiba, amely a kalkulátort, a KATA-összehasonlítást, a PDF-eket, a határidőket, az onboardingot és a chat kontextusát is érintheti:

1. 2026-ban az általános költséghányad 45%, nem 40%.

2. A KATA-modul a jelenlegi KATA helyett részben a régi KATA logikáját tartalmazza.

A feltöltött koncepció erőssége, hogy világosan elkülöníti a működő és hiányzó funkciókat, továbbá helyesen emeli ki a zárt regisztrációt és a még nem validált 2026-os szabálycsomagot. A külső ellenőrzés ugyanakkor több, indulás előtt javítandó szakmai és termékpozicionálási kérdést azonosított.

## Összesített döntési kép

| **Terület**        | **Értékelés**                                   | **Döntési következmény**                                         |
|--------------------|-------------------------------------------------|------------------------------------------------------------------|
| **Célcsoport**     | Jó, de tovább szűkítendő                        | Egyszerű belföldi B2B, AAM átalányadózóra fókuszálni.            |
| **Adószámítás**    | Kritikus javítás szükséges                      | 45%-os 2026-os költséghányad és teljes tesztmátrix.              |
| **KATA-funkció**   | Jelen formában hibás és túlhangsúlyos           | Jogosultsági kapu; 2027-szimulátor launch utánra.                |
| **Termékérték**    | Valós, de túl sok mellékfunkció fedi el         | NAV → befolyt bevétel → félreteendő adó → teendő láncra építeni. |
| **Versenypozíció** | Köztes kategória a számlázó és könyvelés között | Számlázótól független adózási cockpitként pozicionálni.          |
| **Ár**             | Reális, megfelelő csomaggal                     | 3 490 Ft bruttó/hó; később 4 990 Ft-os Complete csomag.          |

## 2. Kritikus szakmai korrekciók

### 2.1 A 40%-os költséghányad hibás

**A dokumentum állításával ellentétben 2026-ban az általános költséghányad 45%, nem 40%.** 2025-ben még 40% volt; 2026. január 1-jétől 45%, 2027-től 50%. **\[1\]**

- A hibás kulcs túl magas jövedelmet és adóterhet mutathat.

- Érintheti az SZJA-, TB- és szocho-becslést, a KATA-összevetést, a PDF-et és a chat kontextusát.

- Minden 2026-os szabálycsomagban 45%-ra kell javítani; a 2027-es packban 50%-ot kell kezelni.

> **Indulási kapu**

> A 45%-os költséghányad javítása és teljes regressziós tesztelése nélkül nem indítható fizetős szolgáltatás.

### 2.2 A KATA-modul jelenlegi logikája hibás

A dokumentum 50 000 Ft-os főállású és 25 000 Ft-os mellékállású KATA-t, illetve céges számlázás esetén 12 millió Ft-os határt említ. Ez a 2022 előtti KATA-rendszer logikájára emlékeztet, és 2026-ban nem helyes. **\[2\]**

- A jelenlegi KATA csak főfoglalkozású egyéni vállalkozó számára választható.

- A havi tételes adó 50 000 Ft; nincs 25 000 Ft-os mellékállású változat.

- Főszabály szerint kifizetőtől, például cégtől szerzett bevétel megszünteti a KATA-alanyiságot.

- A 40%-os különadó éves kerete 18 millió Ft.

Ez stratégiai ellentmondást okoz: a MikroKönyv célcsoportja B2B-only, miközben a jelenlegi KATA a célcsoport döntő többsége számára nem választható. A funkció javasolt új működése:

1. Elsőként jogosultsági kapu vizsgálja meg, hogy a felhasználó egyáltalán választhatja-e a KATA-t.

2. B2B számlázás esetén egyértelműen jelezze, hogy a jelenlegi működési modell mellett a KATA főszabály szerint nem választható.

3. Számszerű összehasonlítás csak jogosult, elsősorban magánszemélyeknek számlázó főállású vállalkozónál fusson.

4. A 2027-es KATA-szimulátor kerüljön ki a launch scope-ból.

### 2.3 TB- és szocho-logika: az alapok helyesek, a szélső esetek bizonyítandók

A dokumentumban szereplő fő 2026-os alapértékek lényegében helyesek: minimálbér 322 800 Ft, garantált bérminimum 373 200 Ft, adómentes jövedelemrész 1 936 800 Ft, általános bevételi limit 38 736 000 Ft, kizárólagos kiskereskedelemnél 193 680 000 Ft, továbbá megszűnt a korábbi 112,5%-os szocho-szorzó. **\[1\]**

Fizetős indulás előtt azonban könyvelő által jóváhagyott automatizált tesztmátrix szükséges legalább az alábbi esetekre:

- főállású, mellékállású és nyugdíjas vállalkozó

- hónap közbeni indulás és megszűnés

- szünetelés

- táppénzes vagy más kieső időszak

- kvalifikációhoz kötött tevékenység

- göngyölítéses járulékalap

- adó- és családi kedvezmények

### 2.4 A pénzforgalmi nyilvántartás jó, de még nem eléggé automatikus

A számla és a tényleges pénzbefolyás szétválasztása helyes, és a MikroKönyv egyik legerősebb része. A kézi „befolyt” jelölés azonban gyengíti a „termék figyel helyettem” ígéretet. A NAV Online Számla a számlát mutatja, nem feltétlenül a fizetés tényét és dátumát.

**Első számú kereskedelmi fejlesztési javaslat:** bankszinkron és automatikus számla–tranzakció párosítás. **\[3\]**

### 2.5 Az AAM-keret hiányzik a fő értékajánlatból

Mivel a célcsoport kizárólag AAM, a 2026-os 20 millió Ft-os alanyi adómentességi keretnek ugyanolyan láthatónak kell lennie, mint az átalányadó bevételi határának. A keret 2027-ben 22 millió, 2028-ban 24 millió Ft lesz. **\[4\]**

Javasolt státuszképernyő:

- AAM-keret: felhasználva, hátralévő összeg és várható átlépési dátum

- átalányadózási bevételi keret

- adómentes jövedelemrész

- következő fizetési és bevallási kötelezettség

### 2.6 A nyugták általános 8 éves megőrzési ideje vitatható

A dokumentum minden nyugtakategóriára nyolcéves megőrzési időt rendel a számviteli törvény alapján. Ez egyéni vállalkozónál nem kezelhető automatikusan általános szabályként. A „megőrzendő 8 évig” feliratot el kell távolítani mindaddig, amíg könyvelő vagy adójogász dokumentumtípusonként nem definiálja a megfelelő megőrzési szabályt. **\[1, 5\]**

### 2.7 A nyugtaadat-jelentési funkció leírása frissítendő

A 2026. szeptember 1-jétől alkalmazandó szabály szerint a kézi vagy számítógéppel előállított nyugtákról három naptári napon belül, napi és áfakulcsonkénti összesített adatot kell szolgáltatni. A NAV már gépi interfészt és dokumentációt is kommunikál, ezért a tartós termékfeltevés nem lehet az, hogy automatizált beküldési lehetőség nem publikus. **\[6\]**

Javaslat: a kézi összesítő mellé kerüljön roadmapre a gépi nyugtaadat-beküldés.

### 2.8 A nyugdíjmodul neve túl erős

A tényleges magyar nyugdíjszámítás az 1988-tól szerzett, nettósított és valorizált kereseteket, kieső időket és arányos szolgálati időt is figyelembe veszi. A MikroKönyv saját időszakának TB-alapja önmagában nem elegendő pontos várható nyugdíjösszeghez. **\[7\]**

Javasolt elnevezés:

- „A járulékalapod várható nyugdíjhatása”

- „Nyugdíjalap-szimulátor”

Pontos Ft-érték helyett irányt, tartományt és adatminőségi szintet célszerű mutatni.

## 3. A célcsoport értékelése

A szűk célzás helyes. Egy adószoftvernél a kontrollált, egyszerű esetekkel való indulás jobb stratégia, mint minden egyéni vállalkozó kiszolgálásának ígérete. A jelenlegi definíció azonban még mindig túl tág: „átalányadós AAM egyéni vállalkozó, könyvelő nélkül, B2B-only”.

## Javasolt launch ICP

- magyar adóügyi illetőségű;

- belföldi partnereknek, jellemzően forintban számláz;

- nincs alkalmazottja;

- nincs rendszeres EU-s vagy harmadik országbeli ügylete;

- egyértelmű költséghányad-kategóriába tartozik;

- nincs többféle, eltérő költséghányadú tevékenysége;

- nincs olyan egyedi kedvezménye vagy élethelyzete, amelyet a motor még nem kezel;

- nem szünetel rendszertelenül év közben.

Az AAM-státusz önmagában nem jelenti azt, hogy az áfakezelés mindig egyszerű. Külföldi szolgáltatásoknál, közösségi ügyleteknél és más speciális esetekben az AAM vállalkozónak is lehet áfakötelezettsége. **\[8\]**

> **Javasolt elsődleges fájdalompont**

> „Nem tudom, a beérkezett pénzből mennyit kell félretennem, melyik keretet közelítem, és mi a következő bevallási vagy fizetési teendőm.” A B2B célcsoport számára ez relevánsabb, mint a „KATA vagy átalányadó?” kérdés.

## 4. Versenytársak és piaci pozíció

A MikroKönyv nem üres piacon indul. A legjelentősebb közvetlen és közvetett versenytársak a Billingo, a Számlázz.hu, a Taxo, valamint az ingyenes kalkulátorok. Az árak az ellenőrzés időpontjában elérhető nyilvános ajánlatokat tükrözik.

## Versenytársi összehasonlítás

| **Megoldás**                         | **Publikus ár**                         | **Fő érték**                       | **Erősség**                                               | **MikroKönyv következménye**                           |
|--------------------------------------|-----------------------------------------|------------------------------------|-----------------------------------------------------------|--------------------------------------------------------|
| **Billingo Átalányadó Asszisztens**  | kb. 4 480 Ft + áfa/hó belépő kombináció | Számlázás + adóasszisztens         | Feladatok, HIPA, könyvelői hozzáférés, bankszinkron opció | A 3 500 Ft-os ár csak valódi automatizálással erős.    |
| **Számlázz.hu Keret- és adófigyelő** | kb. 4 980 Ft + áfa/hó belépő kombináció | Keretfigyelés + bevallási segítség | AAM- és átalányadó-keret, 2558-as támogatás               | AAM és bevallási folyamat kötelező gap.                |
| **Taxo**                             | 6 490 Ft/hó feltüntetett ár             | Digitális könyvelési szolgáltatás  | Bevallások és emberi ügyfélszolgálat                      | Néhány ezer Ft-tal többért teljesebb szolgáltatást ad. |
| **Ingyenes kalkulátorok**            | 0 Ft                                    | Egyszeri adószámítás               | Gyors, széles körben hozzáférhető                         | A kalkulátor önmagában nem fizetős differenciátor.     |

A részletes piaci ajánlatok forrásai: Billingo \[9\], Számlázz.hu \[10\], Taxo \[11\], ingyenes kalkulátorok \[12\].

## 5. Funkciószintű versenyképesség

### 5.1 Amiben a MikroKönyv erős

- determinisztikus, auditálható számítási motor;

- pénzforgalmi és teljesítési nézet szétválasztása;

- egységes számítási forrás a UI, PDF, határidő és chat mögött;

- számlák közvetlen importja a NAV Online Számlából;

- OCR előtti PII-szűrés;

- fail-closed chatarchitektúra;

- érthető számítási levezetés;

- számlázóprogramtól való elvi függetlenség.

### 5.2 Amiben jelenleg le van maradva

- nincs bankszinkron és automatikus befolyáspárosítás;

- nincs 2558-as bevallási varázsló vagy ellenőrzött export;

- nincs HIPA-számítás és bevallási folyamat;

- nincs kamarai hozzájárulás-kezelés;

- nincs teljes vállalkozói könyvelőmeghívás és részletes könyvelői nézet;

- nincs kiforrott adókedvezmény-kezelés;

- nincs bizonyított lefedettség a különleges élethelyzetek teljes körére;

- nincs emberi szakértői háttér vagy felelősségvállalási szint;

- a regisztráció zárva van, a szabálycsomag még nincs könyvelő által validálva.

> **Javasolt piaci kategória**

> A MikroKönyv jelenleg nem hiteles könyvelőhelyettesítő. A legerősebb pozíciója: számlázóprogramtól független adózási kontroll- és előrejelző réteg, vagy röviden „adózási cockpit”.

## 6. A 3 500 Ft/hó ár értékelése

A 3 500 Ft/hó ár reális, de csak pontosan definiált csomaggal és megfelelő bruttó árkommunikációval. Tisztázni kell, hogy az ár bruttó vagy nettó. Egy AAM vállalkozó főszabály szerint nem vonhatja le a beszerzései áfáját, ezért 3 500 Ft + áfa ténylegesen 4 445 Ft/hó költséget jelent számára. **\[8\]**

## Javasolt csomagstruktúra

| **Csomag**                | **Ár**                               | **Tartalom**                                                                                        | **Megjegyzés**                                |
|---------------------------|--------------------------------------|-----------------------------------------------------------------------------------------------------|-----------------------------------------------|
| **Zárt pilot / Founding** | 2 990 Ft bruttó/hó                   | Teljes MVP; aktív visszajelzés; 12 hónapig rögzített ár                                             | Csak szakmai és jogi sign-off után számlázva. |
| **Nyilvános MVP**         | 3 490 Ft bruttó/hó vagy 34 900 Ft/év | NAV-szinkron, bevételi nyilvántartás, adóbecslés, AAM- és adókeret, határidők, export, OCR fair use | Ez a javasolt induló csomag.                  |
| **Complete**              | 4 990 Ft bruttó/hó                   | Bankszinkron, automatikus párosítás, 2558, HIPA, teljes könyvelői portál, magasabb OCR-keret        | Csak a P1 funkciók elkészülte után.           |

A „korlátlan OCR” ígéretet 3 500 Ft körüli áron nem célszerű jogilag korlátlan formában fenntartani. Legalább fair-use feltétel vagy egyértelmű havi dokumentumkeret szükséges.

## 7. Az értékajánlat kritikája és új javaslat

A „termék figyel helyettem” irány jó, de túl általános, a versenytársak is hasonlót ígérnek, bankszinkron nélkül pedig csak részben igaz. A 13 funkció kommunikálása elrejti a valódi felhasználói eredményt.

## A célfelhasználó három elsődleges kérdése:

1. Mennyi bevételem folyt be?

2. Mennyit tegyek félre adóra?

3. Mi a következő teendőm és határidőm?

## Javasolt új főüzenet

> **Mindig tudd, mennyi folyt be, mennyit tegyél félre, és mi a következő adózási teendőd.**

> A MikroKönyv a NAV-számláidból és a beérkezett bevételeidből naprakészen követi az átalányadódat, az alanyi adómentességi keretedet és a közelgő határidőidet. Átlátható számítások, érthető levezetés, számlázóprogramtól függetlenül – kifejezetten egyszerű, belföldi B2B átalányadózó egyéni vállalkozóknak.

## Kerülendő állítások

- „kiváltja a könyvelőt”

- „hibamentes adózás”

- „pontos nyugdíjelőrejelzés”

- „minden átalányadózónak”

- „a NAV-ból mindent automatikusan tud”

- „AI adótanácsadó”

## 8. Javasolt fejlesztési sorrend

## P0 – fizetős indulás előtt kötelező

1. A 2026-os 45%-os és a 2027-es 50%-os általános költséghányad javítása.

2. A teljes KATA-jogosultsági és számítási logika újraírása.

3. A nyugta-megőrzési szövegek javítása.

4. Könyvelői tesztmátrix főállás, mellékállás, nyugdíjas, szünetelés, évközi indulás, kieső idő és kedvezmények esetére.

5. Könyvelői sign-off beépítése a szabálycsomagba.

6. ÁSZF- és adatkezelési review lezárása.

7. A nyugtaadat-API elérhetőségének és integrációs útjának újraértékelése.

## P1 – piacképes MVP

1. AAM-keret és előrejelzett keretátlépés.

2. Bankszinkron és automatikus fizetéspárosítás.

3. 2558-as bevallási varázsló vagy legalább ellenőrzött export.

4. HIPA és kamarai hozzájárulás.

5. Könyvelőmeghívó és részletes ügyfélnézet.

6. Email- vagy push-értesítések a fizetendő összegről és határidőről.

## P2 – valódi differenciátorok

1. „Miért változott az adóm?” magyarázó idővonal.

2. Bizonytalansági és adatminőségi mutató minden becslés mellett.

3. Nyugta-OCR és automatikus nyugtaadat-szolgáltatás.

4. Járulékalap nyugdíjhatásának szimulációja.

5. Szűk, státusz- és teendőorientált Q&A chat.

6. Éves adózási egészségjelentés.

## 9. Végső döntési javaslat

**A terméket nem leállítani kell, hanem szakmailag korrigálni és újrapozicionálni.** A jó piaci helye nem a számlázóprogram és nem a teljes könyvelés, hanem a számlázótól független adózási cockpit az egyszerű B2B átalányadózó számára.

> **Ajánlott kategóriamondat**

> „A MikroKönyv egy számlázótól független adózási cockpit, amely megmutatja, mennyi folyt be, mennyit kell félretenned, melyik keretedet közelíted, és mi a következő teendőd.”

A 3 500 Ft/hó körüli ár akkor reális, ha:

- lehetőleg bruttó végfelhasználói árként jelenik meg;

- a kritikus adóhibák javítva vannak;

- az AAM-figyelés bekerül;

- a fizetési státusz legalább részben automatizálható;

- a termék nem ígér könyvelőhelyettesítést;

- éves csomag is elérhető;

- az OCR-re fair-use szabály vonatkozik.

**A legnagyobb üzleti potenciál ebben a láncban van:** NAV-adatok → ténylegesen befolyt bevétel → félreteendő adó → keretfigyelés → következő konkrét teendő.

Amíg ez a lánc nem teljesen megbízható és minél inkább automatikus, addig a további látványos funkciók – például a KATA-szimulátor, a nyugdíjmodul vagy az általános chat – inkább növelik a komplexitást, mint a fizetési hajlandóságot.

## 10. Források

**\[1\]** [NAV: Az egyéni vállalkozók átalányadózásának alapvető szabályai, 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F100.-az-egyeni-vallalkozok-atalanyadozasanak-alapveto-szabalyai-2026.-01.-14)

**\[2\]** [NAV: Kisadózó vállalkozók tételes adója (KATA), 2026](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2F2026%2F99.-Kisadozo-vallalkozok-teteles-adoja-kata-2026.-01.-08)

**\[3\]** [Billingo Tudásbázis: Bankszinkron](https://support.billingo.hu/content/3253862446)

**\[4\]** [Számlázz.hu Tudástár: átalányadó és AAM keretek](https://tudastar.szamlazz.hu/gyik/atalanyado-tamogato-rendszer-a-szamlazzhuban)

**\[5\]** [Nemzeti Jogszabálytár: 2000. évi C. törvény a számvitelről](https://njt.hu/jogszabaly/2000-100-00-00)

**\[6\]** [NAV: Nyugtaadat-szolgáltatási interfész dokumentáció](https://nav.gov.hu/print/ado/enyugta/nyugtaadat-szolgaltatas/GitHubon_a_nyugtaadat-szolgaltatasi_interfesz_dokumentacioja)

**\[7\]** [Magyar Államkincstár: nyugdíjszámítási példák](https://www.allamkincstar.gov.hu/pfile/file?inline=true&path=%2Fnyugdij%2Fjogszabalyi-hivatkozasok%2Fnyugdijszamitasi-peldak)

**\[8\]** [NAV: Hasznos tudnivalók kezdő áfaalanyoknak](https://nav.gov.hu/pfile/file?path=%2Fugyfeliranytu%2Fnezzen-utana%2Finf_fuz%2Frejtett%2FInformacios-fuzetek---Aktualis%2F14.-informacios-fuzet---hasznos-tudnivalok-kezdo-afaalanyoknak)

**\[9\]** [Billingo: könyvelői és átalányadó-asszisztens ajánlatok](https://www.billingo.hu/konyvelo-vagyok)

**\[10\]** [Számlázz.hu: Keret- és adófigyelő](https://www.szamlazz.hu/keret-es-adofigyelo-egyeni-vallalkozoknak/)

**\[11\]** [Taxo: digitális könyvelési szolgáltatás](https://www.taxo.hu/)

**\[12\]** [Billingo: átalányadó-kalkulátor](https://www.billingo.hu/atalanyado-kalkulator)
