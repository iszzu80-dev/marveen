# MikroKönyv UI/UX koncepció és részletes termékspecifikáció

**Dátum:** 2026. július 15.  
**Dokumentum típusa:** UI/UX és termékélmény-specifikáció  
**Cél:** a MikroKönyv felületének újraszervezése a lehető legegyszerűbb, legbiztonságosabb és legkönnyebben érthető ügyfélélmény érdekében  
**Elsődleges célcsoport:** egyszerű működésű, magyar, alanyi adómentes, átalányadózó egyéni vállalkozó, aki könyvelő nélkül vagy csak időszakos könyvelői támogatással működik  
**Kapcsolódó üzleti pozicionálás:** számlázótól független adózási és pénzforgalmi kontrollfelület, nem teljes könyvelőprogram és nem AI-adótanácsadó

---

## Tartalomjegyzék

1. [Vezetői összefoglaló](#1-vezetői-összefoglaló)
2. [A UI stratégiai alapelve](#2-a-ui-stratégiai-alapelve)
3. [Versenytársi tanulságok](#3-versenytársi-tanulságok)
4. [Felhasználói perszónák](#4-felhasználói-perszónák)
5. [Felhasználói életciklus és fő ügyfélutak](#5-felhasználói-életciklus-és-fő-ügyfélutak)
6. [Javasolt információs architektúra](#6-javasolt-információs-architektúra)
7. [Navigációs rendszer](#7-navigációs-rendszer)
8. [Áttekintés / főoldal](#8-áttekintés--főoldal)
9. [Bevételek képernyő](#9-bevételek-képernyő)
10. [Teendők képernyő](#10-teendők-képernyő)
11. [Keretek és előrejelzések](#11-keretek-és-előrejelzések)
12. [Számítás és levezetés](#12-számítás-és-levezetés)
13. [Dokumentumok, nyugták és OCR](#13-dokumentumok-nyugták-és-ocr)
14. [Magyarázó asszisztens](#14-magyarázó-asszisztens)
15. [Onboarding és alkalmassági kapu](#15-onboarding-és-alkalmassági-kapu)
16. [NAV-kapcsolat UX](#16-nav-kapcsolat-ux)
17. [Könyvelői hozzáférés és portál](#17-könyvelői-hozzáférés-és-portál)
18. [Mobilalkalmazás és reszponzív működés](#18-mobilalkalmazás-és-reszponzív-működés)
19. [Vizuális rendszer](#19-vizuális-rendszer)
20. [Komponenskönyvtár](#20-komponenskönyvtár)
21. [Nyelvezet és mikroszövegek](#21-nyelvezet-és-mikroszövegek)
22. [Állapotok, hibák és bizonytalanság](#22-állapotok-hibák-és-bizonytalanság)
23. [Értesítési rendszer](#23-értesítési-rendszer)
24. [Adatvédelem és bizalom a felületen](#24-adatvédelem-és-bizalom-a-felületen)
25. [Hozzáférhetőség](#25-hozzáférhetőség)
26. [Demo- és go-to-market élmény](#26-demo--és-go-to-market-élmény)
27. [Analitika és sikerességi mutatók](#27-analitika-és-sikerességi-mutatók)
28. [Fejlesztési prioritások](#28-fejlesztési-prioritások)
29. [Ajánlott végleges termékstruktúra](#29-ajánlott-végleges-termékstruktúra)
30. [Végső döntési javaslat](#30-végső-döntési-javaslat)

---

# 1. Vezetői összefoglaló

A MikroKönyv felületét nem a jelenleg rendelkezésre álló funkciók és kódmodulok köré kell szervezni. A felhasználót nem érdekli, hogy a rendszerben külön modul kezeli a NAV-kapcsolatot, a pénzforgalmi nyilvántartást, a levezetést, a határidőket, az OCR-t, a nyugtaadat-jelentést vagy a chatet.

A felhasználó három kérdésre keres választ:

1. **Minden rendben van?**
2. **Mennyit kell félretennem?**
3. **Mi a következő konkrét teendőm?**

A MikroKönyv akkor nyújt jó ügyfélélményt, ha a felhasználó belépés után legfeljebb 30 másodpercen belül:

- megérti a jelenlegi állapotát;
- látja az aktuálisan félreteendő összeget;
- látja a legközelebbi határidőt;
- észreveszi, ha adat vagy felhasználói döntés hiányzik;
- egyetlen domináns gombbal el tudja indítani a következő feladatot.

A felületnek nem könyvelőprogram-érzetet, hanem **nyugodt, megbízható pénzügyi kontrollt** kell adnia.

A javasolt termékstruktúra négy elsődleges területből áll:

1. **Áttekintés**
2. **Bevételek**
3. **Teendők**
4. **Dokumentumok**

A KATA-összehasonlító, nyugdíjszimulátor, részletes adólevezetés, NAV-integráció, könyvelőkezelés és magyarázó asszisztens nem elsődleges menüpont. Ezek a megfelelő kontextusban, másodlagos vagy beállítási funkcióként jelennek meg.

A legfontosabb UI-szemlélet:

> **Ne azt mutassuk, amit a rendszer már tud, hanem azt, amihez a felhasználó figyelme vagy döntése szükséges.**

---

# 2. A UI stratégiai alapelve

## 2.1 A termék ne funkciólistát, hanem állapotot mutasson

A jelenlegi funkciók száma önmagában nem jelent jó ügyfélélményt. Ha minden modul saját fület kap, a felület gyorsan könyvelői adminisztrációs rendszerré válik.

A megfelelő elsődleges kérdés nem az, hogy:

> „Milyen funkciót szeretnél használni?”

hanem az, hogy:

> „Mi az, amit most tudnod vagy tenned kell?”

## 2.2 Progresszív feltárás

A rendszer mély szakmai és technikai tudással rendelkezhet, de ezt nem kell egyszerre megmutatni.

Három információs szint javasolt:

### 1. szint – döntési információ

- félreteendő összeg;
- határidő;
- következő teendő;
- keretállapot;
- adatfrissesség.

### 2. szint – érthető magyarázat

- mi változott;
- miből áll az összeg;
- melyik bevétel okozta a változást;
- melyik adat hiányzik.

### 3. szint – szakmai levezetés

- jogszabályi szabály;
- alkalmazott képlet;
- minimumalap;
- kerekítés;
- szabálycsomag-verzió;
- validációs állapot.

A felhasználók többsége az első szinten marad. A részletesebb szintek a bizalmat és auditálhatóságot szolgálják.

## 2.3 Egy képernyő – egy domináns feladat

Minden képernyőn legyen egyértelmű:

- mi a legfontosabb információ;
- mi a következő legfontosabb művelet;
- melyik gomb az elsődleges;
- melyik adat bizonytalan;
- mi történik a gomb megnyomása után.

Kerülendő:

- több, vizuálisan azonos súlyú CTA;
- öt-hat dashboardkártya azonos hangsúllyal;
- szakmai menüpontok egymás mellett;
- hosszú táblázatok magyarázat nélkül.

## 2.4 Kivételalapú működés

A felhasználó ne minden számlát, nyugtát és adatot ellenőrizzen.

A rendszer:

1. automatikusan begyűjti az adatokat;
2. automatikusan feldolgozza a biztos eseteket;
3. csak a bizonytalan vagy ellentmondásos tételeket emeli ki;
4. egyértelmű választási lehetőséget ad;
5. a döntést auditálhatóan eltárolja.

Példa:

```text
2 tétel vár ellenőrzésre

A többi 38 számlát a rendszer feldolgozta.
```

Ez sokkal jobb élmény, mint egy 40 soros számlatáblázat megnyitása.

## 2.5 Bizonytalanságot vállaló felület

Adózási és pénzügyi termékben veszélyes a hamis magabiztosság.

A felületnek képesnek kell lennie arra, hogy világosan kimondja:

- nincs elég adat;
- az adat nem friss;
- a besorolás bizonytalan;
- az összeg csak becslés;
- könyvelői ellenőrzés szükséges;
- a rendszer ezt az esetet még nem kezeli.

A „nem tudjuk biztosan” nem rendszerhiba, hanem szabályos termékállapot.

---

# 3. Versenytársi tanulságok

## 3.1 Billingo

### Erősségek

- vizuális keretkövetés;
- adózási összefoglalók;
- számlázási és pénzügyi adatok egy rendszerben;
- könyvelői hozzáférés;
- széles funkciókészlet;
- ismert magyar márka.

### Átveendő elemek

- keretek vizuális megjelenítése;
- időszak szerinti szűrés;
- következő adózási kötelezettség kiemelése;
- feladatok és számítások összekapcsolása;
- könyvelői együttműködés.

### Amit a MikroKönyv egyszerűbben csinálhat

- kevesebb főmenü;
- kevesebb számlázási funkció;
- világosabb fókusz a ténylegesen befolyt pénzre;
- egyszerűbb státusznyelv;
- kisebb mentális terhelés.

## 3.2 Számlázz.hu Keret- és adófigyelő

### Erősségek

- keretfigyelés;
- adózási feladatok;
- bevallási segítség;
- AAM- és átalányadó-logika közös kezelése;
- ismert számlázóplatform.

### Átveendő elemek

- teendőalapú működés;
- határidők cselekvési feladatként;
- bevallási varázsló;
- keretek párhuzamos követése.

### Továbbfejlesztési lehetőség

A MikroKönyv minden feladatnál mondja meg:

- mit kell tenni;
- meddig;
- mennyi idő;
- kell-e fizetni;
- mi történt már meg automatikusan;
- milyen adat hiányzik.

## 3.3 QuickBooks Solopreneur

### Erősségek

- mobil-first összefoglaló;
- nagy számok;
- gyors műveletek;
- egyszerű pénzügyi állapot;
- rövid, cselekvésorientált dashboard.

### Átveendő elemek

- nagy, jól olvasható pénzösszegek;
- fő műveletek a nyitóképernyőn;
- mobilon is teljes értékű főoldal;
- kamerás dokumentumrögzítés.

## 3.4 FreeAgent

### Erősségek

- Tax Timeline;
- múlt, jelen és jövő időbeli szervezése;
- fizetési határidők és összegek együtt;
- adózási folyamat történetté szervezése.

### Átveendő elemek

- adózási idővonal;
- elkészült / aktuális / későbbi állapotok;
- határidő és összeg együttes megjelenítése;
- naptárintegráció.

## 3.5 Xero, ANNA és hasonló nemzetközi termékek

### Erősségek

- automatikus banki párosítás;
- dokumentumfelismerés;
- kivételalapú feldolgozás;
- automatikus kategorizálás;
- felhasználói figyelem minimalizálása.

### Stratégiai tanulság

A MikroKönyv hosszú távú UI-ja akkor lesz igazán egyszerű, ha a felhasználó nem kézi adminisztrációt végez, hanem csak a rendszer javaslatait hagyja jóvá.

---

# 4. Felhasználói perszónák

## 4.1 Elsődleges persona: „A nyugalmat kereső szakértő”

### Profil

- tanácsadó, IT-s, tréner, marketinges, coach, designer vagy más szellemi szolgáltató;
- havi 3–20 számla;
- jellemzően magyar üzleti partnerek;
- nem szeretne könyvelési fogalmakat tanulni;
- nem akar naponta belépni;
- fél a határidőktől és keretátlépéstől;
- mobilon ellenőriz, desktopon állít be.

### Fő céljai

- látni, mennyi pénz folyt be;
- tudni, mennyit kell félretenni;
- elkerülni a határidő-mulasztást;
- tudni, hogy a NAV-kapcsolat működik;
- szükség esetén adatot átadni a könyvelőnek.

### Fő félelmei

- hibás számítás;
- elfelejtett befizetés;
- AAM-keret átlépése;
- rossz tevékenységi besorolás;
- hiányzó NAV-adat;
- túl bonyolult felület.

### Elsődleges UI-igény

Egyetlen mondatban:

> „Mutasd meg, hogy minden rendben van-e, és mondd meg, mi a következő dolgom.”

## 4.2 Másodlagos persona: „A sok számlás, időhiányos vállalkozó”

### Profil

- havi 20–100 számla;
- részfizetések;
- hosszabb fizetési határidők;
- több kintlévőség;
- rendszeres exportigény;
- könyvelővel együttműködik.

### Fő UI-igény

- automatikus fizetési párosítás;
- kivételkezelés;
- kintlévőségek;
- gyors tömeges műveletek;
- könyvelői megosztás;
- auditálható státusz.

A legfontosabb nyitóüzenet számára:

```text
5 tétel vár ellenőrzésre.
A többi 74 tételt feldolgoztuk.
```

## 4.3 Speciális persona: „Nyugtát is kiállító szolgáltató”

### Profil

- számlák mellett saját nyugtákat is kiállít;
- mobilról dolgozik;
- napi vagy rendszeres nyugtaadat-feladat;
- kisebb adminisztrációs fegyelem;
- fontos a határidő és beküldési státusz.

### UI-szabály

A nyugtás funkciók csak akkor jelenjenek meg hangsúlyosan, ha a felhasználó onboarding során jelezte, hogy nyugtát állít ki.

## 4.4 Könyvelő

### Profil

- több ügyfelet kezel;
- nem szeretne egyenként minden ügyfélbe belépni;
- a kockázatokat akarja látni;
- érdekli az adatfrissesség;
- exportot és részletes levezetést igényel.

### Fő UI-igény

- ügyfelek kockázat szerint;
- hiányzó adatok;
- határidők;
- keretkockázatok;
- könyvelői feladatlista;
- auditnapló;
- export.

---

# 5. Felhasználói életciklus és fő ügyfélutak

## 5.1 Első találkozás

### Cél

A látogató megértse:

- kinek szól;
- mit old meg;
- mit nem old meg;
- jelenleg használható-e;
- hogyan próbálhatja ki.

### Ideális út

```text
Landing oldal
    ↓
Interaktív demo
    ↓
Alkalmassági kérdések
    ↓
Regisztráció vagy várólista
```

## 5.2 Első beállítás

```text
Alkalmassági ellenőrzés
    ↓
Adózási profil
    ↓
NAV-kapcsolat
    ↓
Kezdeti bevételi adatok
    ↓
Első eredmény
```

## 5.3 Normál napi használat

A legtöbb napon a felhasználó:

1. belép;
2. látja, hogy minden rendben van;
3. esetleg ellenőriz egy-két tételt;
4. kilép.

Célidő: **30–90 másodperc**.

## 5.4 Negyedéves használat

A negyedév végén:

1. a rendszer jelzi a közelgő feladatot;
2. ellenőrzi az adatok teljességét;
3. megmutatja a becsült fizetendő összeget;
4. levezetést biztosít;
5. segít a bevallásban vagy exportban;
6. lezárja a feladatot.

## 5.5 Év végi használat

- éves összefoglaló;
- AAM-keret visszatekintés;
- átalányadózási keret;
- hiányzó tételek;
- éves export;
- könyvelői csomag;
- következő év szabálycsomagja;
- szükséges profilfrissítés.

## 5.6 Hibahelyzet

Például NAV-kapcsolat megszakad:

1. főoldal státuszüzenet;
2. rövid magyarázat;
3. érintett adatok;
4. javítási gomb;
5. részletes technikai információ csak lenyithatóan.

---

# 6. Javasolt információs architektúra

## 6.1 Elsődleges területek

### Áttekintés

- aktuális állapot;
- félreteendő összeg;
- következő teendő;
- AAM-keret;
- átalányadózási keret;
- adatfrissesség;
- idővonal;
- legutóbbi változás.

### Bevételek

- NAV-számlák;
- befolyt / nem befolyt;
- részfizetés;
- kézi bevétel;
- banki párosítás;
- kintlévőség;
- ellenőrzendő tételek.

### Teendők

- határidők;
- fizetések;
- bevallások;
- nyugtaadat-szolgáltatás;
- adathiányok;
- lejárt feladatok;
- lezárt feladatok.

### Dokumentumok

- nyugták;
- OCR;
- saját kiállítású nyugták;
- PDF;
- CSV;
- ZIP;
- éves és havi riport;
- könyvelői csomag.

## 6.2 Másodlagos területek

### Tervezés

- KATA-jogosultság és összehasonlítás;
- nyugdíjalap-hatás;
- éves bevételi előrejelzés;
- keretforgatókönyvek.

### Könyvelő

- meghívás;
- hozzáférések;
- megosztott adatok;
- könyvelői megjegyzések;
- export.

### Beállítások

- vállalkozási profil;
- adózási profil;
- NAV-integráció;
- bankintegráció;
- értesítések;
- adatvédelem;
- előfizetés.

### Segítség

- magyarázó asszisztens;
- tudásbázis;
- ügyfélszolgálat;
- rendszerállapot;
- jogi dokumentumok.

---

# 7. Navigációs rendszer

## 7.1 Desktop navigáció

```text
MikroKönyv

● Áttekintés
  Bevételek
  Teendők                    3
  Dokumentumok

────────────────────────────
  Tervezés
  Könyvelő
  Beállítások
  Segítség
```

### Szabályok

- legfeljebb négy elsődleges elem;
- a badge csak valódi feladatot mutat;
- a „Teendők 3” három elvégzendő feladatot jelent;
- nem mutatunk általános értesítésszámot;
- a menüben nincs külön NAV, OCR, KATA, Nyugdíj vagy Chat fül.

## 7.2 Mobil navigáció

```text
Főoldal     Bevételek     Teendők     Továbbiak
   ●            ○             ○             ○
```

A „Továbbiak” tartalmazza:

- Dokumentumok;
- Tervezés;
- Könyvelő;
- Beállítások;
- Segítség.

## 7.3 Kontextuális navigáció

A felhasználó az adott információból lépjen tovább.

Példák:

```text
286 400 Ft félreteendő
[Hogyan számoltuk?]
```

```text
4 számla fizetési állapota hiányzik
[Adatok pótlása]
```

```text
A NAV-adatok 3 napja nem frissültek
[Kapcsolat javítása]
```

---

# 8. Áttekintés / főoldal

## 8.1 A főoldal feladata

A főoldal ne általános dashboard legyen. Egy mondatban válaszolja meg:

> „Mi a vállalkozásom aktuális adózási állapota?”

## 8.2 Felső státuszsáv

### Rendben állapot

```text
✓ Minden rendben

A NAV-adatok ma 08:42-kor frissültek.
Nincs lejárt vagy ellenőrzést igénylő feladat.
```

### Teendő állapot

```text
3 dolog vár rád

Először két számla fizetési állapotát kell ellenőrizned.

[Ellenőrzöm]
```

### Bizonytalan állapot

```text
Még nem tudunk biztos összeget mondani

Négy számlánál nem ismert, hogy befolyt-e az összeg.

[Adatok pótlása]
```

### Hibaállapot

```text
A NAV-adatok nem frissültek

Az utolsó sikeres frissítés: július 12. 08:35

[Kapcsolat javítása]
```

## 8.3 Fő információs blokk

```text
MOST FÉLRETEENDŐ

286 400 Ft

Az eddig befolyt bevétel alapján.

[Hogyan számoltuk?]
```

Fontos:

- a „most félreteendő” jelentése legyen egyértelmű;
- ne keverjük a már befizetett összegekkel;
- ha a szám csak részleges, legyen „legalább” vagy „becsült” jelölés;
- mutassuk az adatminőséget.

## 8.4 Következő teendő

```text
KÖVETKEZŐ TEENDŐ

Negyedéves adó és járulék
Határidő: október 12.
Becsült összeg: 183 200 Ft

[Részletek]
```

## 8.5 Keretek

```text
KERETEID

Alanyi adómentesség
12,4 M / 20 M Ft
62%

Év végére várható: 18,7 M Ft
✓ Várhatóan a kereten belül maradsz

Átalányadózási bevételi keret
12,4 M / 38,736 M Ft
32%
```

## 8.6 „Rád vár” blokk

```text
RÁD VÁR

2 számla fizetési állapota
Kb. 1 perc
[Ellenőrzöm]

1 nyugtaadat-jelentés
Határidő: holnap
[Elkészítem]
```

## 8.7 Legutóbbi változás

```text
LEGUTÓBBI VÁLTOZÁS

A félreteendő összeg 24 600 Ft-tal nőtt.

Oka:
két új számla befolytként került rögzítésre.

[Mutasd a részleteket]
```

Ez bizalmat épít, mert a felhasználó látja, mitől változott egy összeg.

## 8.8 Adózási idővonal

```text
✓ Július 12.        ● Október 12.        ○ Január 12.
  Befizetve           Következik           Később

                      183 200 Ft
```

## 8.9 Amit nem mutatunk alapból

- nyugtakategória diagram;
- KATA-összehasonlító;
- nyugdíjbecslés;
- OCR-kvóta;
- NAV-technikai adatok;
- teljes adólevezetés;
- üres chatmező;
- öt külön közteherkártya;
- hosszú naptár.

---

# 9. Bevételek képernyő

## 9.1 Fő cél

A bevételi adatok megbízhatóságának kezelése, nem pusztán számlák listázása.

## 9.2 Felső összesítés

```text
2026-ban befolyt
12 420 000 Ft

Még nem folyt be
1 860 000 Ft

Ellenőrzésre vár
960 000 Ft
```

## 9.3 Elsődleges nézet: ellenőrzendő tételek

```text
2 tétel vár ellenőrzésre

Kovács Consulting Kft.
480 000 Ft

Számla kelte: július 3.
Fizetési határidő: július 11.

Befolyt?

[Nem] [Igen, teljesen] [Részben]
```

## 9.4 Részfizetés

```text
Mennyi folyt be?

Számla összege: 480 000 Ft

Befolyt összeg:
[ 240 000 Ft ]

Beérkezés dátuma:
[ 2026. 07. 10. ]

[Mentés]
```

## 9.5 Szűrők

- Ellenőrzendő;
- Befolyt;
- Kintlévő;
- Részben fizetett;
- Stornó / módosító;
- Mind.

## 9.6 Tételrészletek

A tételoldalon:

- vevő;
- összeg;
- számlaszám;
- teljesítés;
- kiállítás;
- fizetési határidő;
- befolyás;
- adóév;
- forrás;
- kapcsolódó banktétel;
- módosítási napló.

## 9.7 Bankszinkron jövőbeli UX

```text
Valószínű egyezés

Számla
480 000 Ft
Kovács Consulting Kft.

Banktétel
480 000 Ft
KOVACS CONS KFT
Július 10.

[Összepárosítás] [Nem ez az]
```

Magas bizonyosság esetén:

```text
Automatikusan párosítva

[Visszavonás]
```

## 9.8 Tömeges ellenőrzés

Nagyobb felhasználóknál:

```text
8 tétel valószínűleg teljesen befolyt

[Mind jóváhagyása]

vagy

[Egyenként ellenőrzöm]
```

---

# 10. Teendők képernyő

## 10.1 A teendők ne naptárként induljanak

Az alapértelmezett nézet időrendi feladatlista.

```text
MOST

2 befolyt számla ellenőrzése
Kb. 1 perc
[Ellenőrzöm]

────────────────────────────

KÖVETKEZŐ 7 NAP

Nyugtaadat-jelentés
Határidő: holnap
[Elkészítem]

────────────────────────────

KÉSŐBB

Negyedéves adó és járulék
Határidő: október 12.
Becsült összeg: 183 200 Ft
[Részletek]

────────────────────────────

ELKÉSZÜLT

✓ Július 12-i befizetés
✓ NAV-szinkron ellenőrzése
```

## 10.2 Egy feladat adattartalma

Minden feladat tartalmazza:

- feladat neve;
- jelentése;
- határidő;
- becsült idő;
- becsült vagy pontos összeg;
- státusz;
- szükséges felhasználói lépés;
- már automatikusan elvégzett részek;
- elsődleges CTA.

## 10.3 Feladatállapotok

- új;
- közelgő;
- esedékes;
- lejárt;
- blokkolt;
- ellenőrzésre vár;
- elkészült;
- nem releváns.

## 10.4 Naptárnézet

Másodlagos nézetként:

- havi naptár;
- adózási események;
- Google Calendar export;
- iCal export;
- emlékeztetők.

## 10.5 Feladat részlete

```text
Negyedéves adó és járulék

Határidő
2026. október 12.

Becsült fizetendő
183 200 Ft

Adatállapot
✓ NAV-adatok frissek
✓ Minden számla státusza ismert
! A számítás még becslés

Teendők
1. Ellenőrizd az összeget
2. Készítsd el a bevallást
3. Indítsd el a befizetést
4. Jelöld késznek

[Összeg ellenőrzése]
```

---

# 11. Keretek és előrejelzések

## 11.1 Két külön keret

A felület külön kezelje:

- alanyi adómentességi keret;
- átalányadózási bevételi keret.

A kettő ne keveredjen.

## 11.2 Kártya szerkezete

```text
Alanyi adómentességi keret

12 420 000 / 20 000 000 Ft
Hátralévő keret: 7 580 000 Ft

A jelenlegi ütem mellett:
Várható éves bevétel: 18 700 000 Ft

✓ Várhatóan a kereten belül maradsz

[Mi történik, ha átlépem?]
```

## 11.3 Figyelmeztetési szintek

### Normál

- 0–70%;
- nyugodt státusz;
- nincs sürgetés.

### Figyelő

- 70–85%;
- várható év végi előrejelzés;
- nincs piros riasztás.

### Kockázatos

- 85–100%;
- várható átlépési idő;
- könyvelői egyeztetés javasolt.

### Átlépett

- pontos dátum;
- érintett bevételek;
- feladatlista;
- könyvelői segítség.

## 11.4 Előrejelzés kommunikációja

Kerülendő:

```text
Novemberben biztosan átléped.
```

Javasolt:

```text
A jelenlegi bevételi ütem mellett novemberben elérheted a keretet.
```

Mutassuk:

- előrejelzés alapja;
- bizonytalanság;
- frissítés dátuma;
- forgatókönyv-választás.

## 11.5 Forgatókönyv

```text
Mi történik, ha havonta további 500 000 Ft folyik be?

Várható AAM-keretátlépés:
november 18–30. között

Ez tervezési becslés, nem adótanács.
```

---

# 12. Számítás és levezetés

## 12.1 Első szint

```text
Becsült közterhek
286 400 Ft

SZJA
61 200 Ft

TB
133 600 Ft

Szocho
91 600 Ft
```

## 12.2 Második szint: érthető levezetés

```text
1. Befolyt bevétel
4 200 000 Ft

2. Költséghányad
45%

3. Számított jövedelem
2 310 000 Ft

4. Adómentes jövedelemrész
–1 936 800 Ft

5. Adóköteles rész
373 200 Ft
```

## 12.3 Harmadik szint: szakmai részletek

Lenyitható:

- szabálycsomag;
- hatály;
- forrás;
- validáció;
- minimumalap;
- főállás/mellékállás logika;
- kerekítés;
- számítás időpontja.

## 12.4 Adatminőség

```text
Adatminőség: teljes

Minden szükséges bevételi adat rendelkezésre áll.
```

vagy:

```text
Adatminőség: részleges

4 számla fizetési állapota hiányzik.
A tényleges összeg magasabb vagy alacsonyabb lehet.
```

## 12.5 Változások magyarázata

```text
Miért nőtt 24 600 Ft-tal?

+ 400 000 Ft új befolyt bevétel
+ járulékalap-változás
– nincs más korrekció
```

---

# 13. Dokumentumok, nyugták és OCR

## 13.1 Dokumentumok főoldal

```text
Dokumentum hozzáadása

[Nyugta lefényképezése]
[Fájl feltöltése]
[Saját kiállítású nyugta rögzítése]
```

## 13.2 OCR-eredmény

```text
Ellenőrizd a felismert adatokat

Kibocsátó
Office Depot

Dátum
2026. július 14.

Összeg
18 490 Ft

Kategória
Irodaszer

Felismerés
Biztos

[Mentés] [Javítás]
```

## 13.3 Bizonytalan OCR

```text
Ezt az adatot nem tudtuk biztosan felismerni

ÁFA-kulcs
[Nincs kiválasztva]

[Kiválasztom]
```

## 13.4 Technikai fogalmak elrejtése

Ne jelenjen meg:

- OCR confidence 0,72;
- PII scrubber;
- LLM provider;
- tokenhasználat;
- heurisztika;
- nyers OCR-szöveg alapból.

## 13.5 Dokumentumlista

Szűrés:

- összes;
- ellenőrzendő;
- nyugták;
- saját nyugták;
- exportok;
- könyvelőnek átadott;
- feldolgozási hiba.

## 13.6 Nyugtaadat-jelentés

```text
Nyugtaadat-jelentés

Időszak:
2026. július 14.

Összes nyugta:
12 db

Összesített érték:
184 500 Ft

Beküldési határidő:
július 17.

[Adatok ellenőrzése]
```

---

# 14. Magyarázó asszisztens

## 14.1 Ne legyen általános AI-chat

Az üres „Kérdezz bármit” mező magas elvárást teremt, miközben a rendszer sok adózási kérdést helyesen elutasít.

A chat szerepe legyen:

- meglévő adatok magyarázata;
- státusz értelmezése;
- feladat magyarázata;
- rendszerhasználati segítség.

## 14.2 Kontextuális belépési pontok

```text
286 400 Ft félreteendő
[Magyarázd el egyszerűen]
```

```text
AAM-keret: 62%
[Mit jelent ez?]
```

```text
2 tétel vár ellenőrzésre
[Miért kell ellenőriznem?]
```

## 14.3 Javasolt kérdések

- Miért ennyi az adóm?
- Mit kell tennem október 12-ig?
- Mit jelent az AAM-keret?
- Milyen adat hiányzik?
- Miért változott az összeg?
- Hogyan készült ez a becslés?
- Hogyan kapcsoljam össze a NAV-ot?

## 14.4 Válaszszerkezet

1. egy mondatos válasz;
2. rövid magyarázat;
3. érintett saját adatok;
4. következő művelet;
5. szükség esetén könyvelői javaslat.

## 14.5 Elutasítás UX

Nem jó:

```text
Ezt a kérdést nem válaszolhatom meg.
Keresd fel a könyvelődet.
```

Jobb:

```text
Ebben egyedi adózási döntésre lenne szükség, ezért nem adok automatikus választ.

Amit meg tudok mutatni:
- a jelenlegi adataidat;
- a számítás levezetését;
- az érintett keretet;
- a könyvelődnek exportálható összefoglalót.

[Számítás megnyitása] [Könyvelő meghívása]
```

---

# 15. Onboarding és alkalmassági kapu

## 15.1 Első lépés: megfelel-e a termék?

Kérdések:

### Számlázási piac

```text
Kinek számlázol elsősorban?

○ Magyarországi vállalkozásoknak
○ Magánszemélyeknek
○ Külföldre is rendszeresen
```

### Alkalmazott

```text
Van alkalmazottad?

○ Nincs
○ Van
```

### ÁFA-státusz

```text
Áfa-státuszod

○ Alanyi adómentes
○ Áfakörös
○ Nem tudom
```

### Adózási forma

```text
Hogyan adózol?

○ Átalányadó
○ KATA
○ Más
○ Nem tudom
```

## 15.2 Kizárt eset

```text
A jelenlegi MikroKönyv ezt az esetet még nem kezeli biztonságosan.

Ok:
rendszeres külföldi ügyletek

[Értesítést kérek, ha elérhető lesz]
```

## 15.3 Adózási profil

Kérendő adatok:

- főállás / mellékállás / nyugdíjas;
- vállalkozás kezdete;
- tevékenység;
- költséghányad;
- szünetelés;
- releváns kedvezmények;
- nyugtakiállítás;
- számlázóprogram;
- könyvelő megléte.

## 15.4 Tevékenység-besorolás

A rendszer ne kérje a felhasználótól, hogy szakmai jogszabályi kategóriát válasszon magabiztosan.

Javasolt:

```text
Mivel foglalkozol?

[ Szöveges kereső ]

Találat:
Szoftverfejlesztés

Javasolt költséghányad:
45%

[Ez az én tevékenységem]
```

Bizonytalan eset:

```text
Ezt a tevékenységet nem tudjuk automatikusan, biztonsággal besorolni.

[Könyvelővel ellenőrzöm]
```

## 15.5 NAV-beállítás

Lásd külön fejezet.

## 15.6 Első eredmény

Az onboarding ne „Sikeres beállítás” képernyővel záruljon.

```text
Készen állsz

A jelenlegi adataid alapján:

286 400 Ft-ot érdemes elkülönítened.

Következő teendőd:
2 számla fizetési állapotának ellenőrzése.

[Áttekintés megnyitása]
```

## 15.7 Onboarding megszakítása

- automatikus mentés;
- későbbi folytatás;
- látható előrehaladás;
- nincs adatvesztés;
- a felhasználó mindig tudja, mi hiányzik.

---

# 16. NAV-kapcsolat UX

## 16.1 Bevezető

```text
Kapcsold össze a NAV Online Számla-fiókodat

Mire használjuk?

✓ A számlák automatikus importjára
✓ A bevételi nyilvántartás frissítésére
✓ Az adóbecslés naprakészen tartására

Mire nem használjuk?

– Nem állítunk ki számlát a nevedben
– Nem módosítunk NAV-adatot
– Nem küldünk bevallást engedély nélkül
```

## 16.2 Lépések

1. NAV Online Számla megnyitása;
2. technikai felhasználó létrehozása;
3. szükséges kulcsok másolása;
4. adatok beillesztése;
5. kapcsolat tesztelése;
6. első szinkron.

## 16.3 Lépésenkénti képernyő

Egy képernyőn csak egy feladat.

```text
2/5. Technikai felhasználó létrehozása

Nyisd meg a NAV Online Számla felületet, majd válaszd:

Felhasználók → Új felhasználó → Technikai felhasználó

[NAV megnyitása]

[Elkészült]
```

## 16.4 Kapcsolatteszt

```text
Kapcsolat ellenőrzése

✓ Felhasználónév elfogadva
✓ Aláírókulcs elfogadva
✓ Cserekulcs elfogadva
✓ Adószám egyezik

Kapcsolat sikeres

[Első szinkron indítása]
```

## 16.5 Hibaüzenet

```text
Az aláírókulcs nem megfelelő

Ellenőrizd, hogy a technikai felhasználóhoz tartozó aláírókulcsot másoltad-e be.

[Újra megadom]

Technikai részletek
▸ lenyitható
```

---

# 17. Könyvelői hozzáférés és portál

## 17.1 Vállalkozói oldal

```text
Könyvelői hozzáférés

Jelenleg nincs meghívott könyvelő.

A könyvelő megtekintheti:

✓ bevételek és számlák
✓ számítások
✓ határidők
✓ exportok

Nem teheti meg:

– nem módosíthatja a profilodat
– nem fér hozzá a jelszavaidhoz
– nem kezelheti az előfizetésedet

[Könyvelő meghívása]
```

## 17.2 Meghívási folyamat

```text
Könyvelő email-címe
[                     ]

Hozzáférés lejárata
○ Nincs lejárat
○ 30 nap
○ Egyedi dátum

[Meghívó küldése]
```

## 17.3 Hozzáférés állapot

- meghívva;
- elfogadva;
- lejárt;
- visszavonva.

## 17.4 Könyvelői főoldal

```text
Ügyfelek
24

Figyelmet igényel
5

────────────────────────

Nagy Andrea

4 bizonytalan bevétel
Határidő 3 nap múlva

[Ügyfél megnyitása]

────────────────────────

Kiss Tamás

AAM-keret várható átlépése
Várhatóan novemberben

[Ügyfél megnyitása]

────────────────────────

Minden rendben
19
```

## 17.5 Könyvelői szűrők

- kritikus;
- határidős;
- adathiányos;
- keretkockázatos;
- frissítetlen NAV;
- rendben;
- összes.

## 17.6 Könyvelői ügyféloldal

- állapot;
- adatfrissesség;
- félreteendő összeg;
- következő határidő;
- hiányzó adatok;
- keretállapot;
- számítási levezetés;
- export;
- auditnapló;
- megjegyzés.

---

# 18. Mobilalkalmazás és reszponzív működés

## 18.1 Mobil prioritások

Mobilon a legfontosabb feladatok:

- állapot ellenőrzése;
- félreteendő összeg;
- tétel jóváhagyása;
- nyugta fényképezése;
- teendő megnyitása;
- értesítésből mélylink.

## 18.2 Mobil főoldal

```text
✓ Minden rendben

286 400 Ft
most félreteendő

Következő teendő
Október 12.
183 200 Ft

Keretek
AAM 62%
Átalányadó 32%

Rád vár
2 tétel

[Ellenőrzöm]
```

## 18.3 Mobil alsó navigáció

```text
Főoldal  Bevételek  Teendők  Továbbiak
```

## 18.4 Mobil gyorsművelet

Lebegő gomb csak akkor javasolt, ha valódi gyakori feladatot szolgál.

Lehetséges:

```text
+
```

Megnyitva:

- Nyugta fényképezése;
- Bevétel rögzítése;
- Dokumentum feltöltése.

## 18.5 Desktop speciális funkciók

Desktopon:

- részletes táblázatok;
- tömeges műveletek;
- export;
- könyvelői munka;
- NAV-beállítás;
- szakmai levezetés.

---

# 19. Vizuális rendszer

## 19.1 Márkakarakter

A MikroKönyv legyen:

- nyugodt;
- megbízható;
- emberi;
- modern;
- pontos;
- nem hivataloskodó;
- nem játékos;
- nem túl fintech.

## 19.2 Javasolt színrendszer

### Főszín

Mély petrol vagy sötét kékeszöld.

Példa:

```text
#0F5D5E
```

### Háttér

Törtfehér vagy halvány meleg szürke.

```text
#F7F8F6
```

### Szöveg

```text
#172121
```

### Pozitív állapot

```text
#3D7A57
```

### Figyelmeztetés

```text
#B7791F
```

### Kritikus

```text
#B33A3A
```

### Információ

```text
#356A8A
```

A pontos színeket kontrasztvizsgálattal kell véglegesíteni.

## 19.3 Tipográfia

- modern, jól olvasható sans-serif;
- nagy pénzösszegekhez tabuláris számjegyek;
- címsorok visszafogottak;
- kerülendő az extrém vastag display font;
- mobilon minimum 16 px törzsszöveg.

## 19.4 Térköz

8 pontos spacing rendszer:

- 4 px;
- 8 px;
- 12 px;
- 16 px;
- 24 px;
- 32 px;
- 48 px;
- 64 px.

## 19.5 Lekerekítés

- kisebb input: 8 px;
- kártya: 12–16 px;
- nagy státuszpanel: 16 px;
- teljesen kapszula alakú gomb csak ritkán.

## 19.6 Árnyék

Minimális. Elsődleges elválasztás:

- háttér;
- keret;
- térköz;
- tipográfiai hierarchia.

---

# 20. Komponenskönyvtár

## 20.1 Státuszpanel

Tulajdonságok:

- ikon;
- cím;
- rövid magyarázat;
- opcionális CTA;
- állapotszín;
- adatfrissesség.

Variánsok:

- success;
- info;
- warning;
- critical;
- incomplete.

## 20.2 Pénzösszeg-kártya

- cím;
- összeg;
- jelentés;
- időszak;
- adatminőség;
- levezetés link.

## 20.3 Keretjelző

- keret neve;
- felhasznált összeg;
- teljes keret;
- százalék;
- hátralévő összeg;
- előrejelzés;
- állapotüzenet;
- további magyarázat.

## 20.4 Feladatkártya

- feladat neve;
- határidő;
- összeg;
- becsült idő;
- állapot;
- CTA;
- blokkoló ok.

## 20.5 Adatfrissesség-jelző

```text
NAV-adatok frissítve:
ma 08:42
```

vagy:

```text
NAV-adatok elavultak:
3 napja nincs frissítés
```

## 20.6 Bizonytalansági címke

Felhasználói szavakkal:

- Biztos;
- Becsült;
- Ellenőrzést kér;
- Hiányos adat;
- Nem számítható.

## 20.7 Idővonal

- múlt esemény;
- aktuális esemény;
- jövőbeli esemény;
- összeg;
- státusz;
- mélylink.

## 20.8 Tétel-ellenőrző

- számlaadat;
- javasolt státusz;
- magyarázat;
- jóváhagyás;
- alternatíva;
- auditnapló.

## 20.9 Empty state

Ne csak azt mondja, hogy nincs adat.

Példa:

```text
Még nincs befolyt bevételed ebben az évben.

A NAV-kapcsolat működik, és automatikusan megjelennek itt a számláid.

[Első kézi bevétel rögzítése]
```

---

# 21. Nyelvezet és mikroszövegek

## 21.1 Alapelv

A rendszer ne könyvelői terminológiát tanítson, hanem jelentést közöljön.

## 21.2 Példák

| Kerülendő | Javasolt |
|---|---|
| Adókötelezettség összesen | Eddig ennyit tegyél félre |
| PaymentMark | Befolyt a számla? |
| Revenue recognition | Mikor érkezett meg a pénz? |
| AAM-limit kihasználtság | Ennyi maradt az áfamentes keretedből |
| Overdue | Lejárt – teendőd van |
| Accrual view | Teljesítés szerinti nézet |
| Tax rule validation | A számítás szabályai ellenőrizve |
| Confidence 0.72 | Ellenőrzést kér |
| Sync error | Nem sikerült frissíteni a NAV-adatokat |
| Pending | Folyamatban |
| Estimated tax | Becsült félreteendő összeg |
| Incomplete data | Hiányzó adatok miatt még nem végleges |

## 21.3 CTA-szabályok

Jó CTA:

- Ellenőrzöm;
- Adatok pótlása;
- Kapcsolat javítása;
- Részletek megnyitása;
- Könyvelő meghívása;
- Jelentés elkészítése;
- Export letöltése.

Kerülendő:

- OK;
- Tovább;
- Beküldés;
- Művelet;
- Feldolgozás;
- Részletek, ha nem derül ki, milyen részletek.

## 21.4 Rövid disclaimer

```text
Becsült összeg
A jelenleg ismert adatok alapján.
```

```text
Adat hiányzik
4 számla fizetési állapota még nem ismert.
```

```text
Ellenőrzött szabályok
2026-os szabálycsomag.
```

---

# 22. Állapotok, hibák és bizonytalanság

## 22.1 Rendszerszintű állapotmátrix

| Állapot | Felhasználói jelentés | Fő CTA |
|---|---|---|
| Minden rendben | Nincs feladat | Nincs vagy részletek |
| Teendő van | Felhasználói lépés szükséges | Feladat indítása |
| Adat hiányzik | Nem számítható biztosan | Adatok pótlása |
| Adat elavult | Frissítés szükséges | Szinkron javítása |
| Határidő közel | Hamarosan teendő | Felkészülés |
| Határidő lejárt | Azonnali teendő | Feladat megnyitása |
| Integrációs hiba | Automatikus adatfolyam megszakadt | Kapcsolat javítása |
| Szabály nem validált | Nem végleges számítás | Szakértői ellenőrzés |
| Scope-on kívüli eset | A rendszer nem kezeli | Könyvelő / várólista |

## 22.2 Hibaüzenet szerkezete

1. mi történt;
2. mit jelent;
3. mi érintett;
4. mit tehet a felhasználó;
5. technikai részletek lenyithatóan.

## 22.3 Példa

```text
Nem sikerült frissíteni a NAV-adatokat

Az utolsó sikeres frissítés:
2026. július 12. 08:35

Azóta érkezett számlák még nem szerepelhetnek a becslésben.

[Kapcsolat javítása]

Technikai részletek
▸
```

## 22.4 Blokkolt számítás

```text
A félreteendő összeget most nem tudjuk biztonságosan kiszámítani

Ok:
a 2026-os tevékenységi besorolás nincs megerősítve.

[Könyvelővel ellenőrzöm]
```

---

# 23. Értesítési rendszer

## 23.1 Csatornák

- alkalmazáson belüli;
- email;
- push;
- opcionális naptár;
- később SMS csak kritikus esetben.

## 23.2 Értesítési típusok

### Azonnali

- NAV-kapcsolat megszakadt;
- lejárt határidő;
- keretátlépés;
- biztonságos számítást blokkoló hiba.

### Napi összefoglaló

- új ellenőrzendő tételek;
- új dokumentumhibák;
- közelgő feladatok.

### Heti összefoglaló

- bevételi változás;
- félreteendő összeg;
- keretállapot;
- következő két hét.

### Negyedéves

- teendőlista;
- becsült fizetendő;
- hiányzó adatok;
- bevallási előkészítés.

## 23.3 Értesítési mikroszöveg

Nem jó:

```text
Adózási esemény történt.
```

Jó:

```text
Két új számla befolytként került rögzítésre.
A félreteendő összeg 24 600 Ft-tal nőtt.
```

## 23.4 Értesítési terhelés

Alapelv:

- ne küldjünk értesítést minden NAV-szinkronról;
- csak felhasználói jelentőségű változásról;
- összevonjuk a kisebb eseményeket;
- a felhasználó szabályozhatja a csatornákat.

---

# 24. Adatvédelem és bizalom a felületen

## 24.1 Bizalmi elemek

- utolsó adatfrissítés;
- adatforrás;
- szabálycsomag verzió;
- hozzáférések;
- auditnapló;
- titkosítás rövid magyarázata;
- export és törlés lehetősége.

## 24.2 NAV-integráció bizalmi szöveg

```text
A NAV-hozzáférést csak a számlaadatok lekérésére használjuk.

Nem állítunk ki és nem módosítunk számlát a nevedben.
```

## 24.3 Könyvelői hozzáférés

A felhasználó lássa:

- ki fér hozzá;
- mikor kapott hozzáférést;
- mit láthat;
- mikor lépett be utoljára;
- hogyan vonható vissza.

## 24.4 AI-átláthatóság

Nem kell minden képernyőt AI-jelölésekkel terhelni.

Ahol AI-feldolgozás történik:

```text
Automatikusan felismert adat
Ellenőrizd mentés előtt.
```

A magyarázó asszisztensnél:

```text
Automatikusan készített magyarázat a saját adataid alapján.
```

---

# 25. Hozzáférhetőség

## 25.1 Követelmények

- WCAG 2.2 AA cél;
- billentyűzetes használat;
- képernyőolvasó-kompatibilis címkék;
- megfelelő kontraszt;
- állapot nem csak színnel;
- minimum 44 × 44 px érintési cél;
- jól látható fókusz;
- hibák szöveges magyarázata;
- grafikonok alternatív szövege.

## 25.2 Pénzösszegek

- ezres tagolás;
- Ft következetesen;
- negatív és pozitív érték nem csak színnel;
- mobilon ne törjön értelmezhetetlenül.

## 25.3 Táblázatok

- mobilon kártyás nézet;
- desktopon fejléc rögzítése;
- oszlopok testreszabhatók;
- képernyőolvasó számára helyes szemantika.

---

# 26. Demo- és go-to-market élmény

## 26.1 Zárt regisztráció alatt

A landing fő CTA-k:

```text
[Interaktív demó]
[Értesítést kérek az indulásról]
[Belépés]
```

Ne legyen aktív „Regisztráció” gomb, amely csak később közli a lezárást.

## 26.2 Interaktív demo

A demo:

- mock adatokkal működik;
- kattintható;
- nem kér NAV-hozzáférést;
- bemutatja a főoldalt;
- tartalmaz egy ellenőrzendő tételt;
- mutat keretfigyelést;
- mutat teendőt;
- lehetővé teszi a számítás levezetését.

## 26.3 Demo narratíva

1. „Minden rendben van.”
2. „Ennyit tegyél félre.”
3. „Ez a következő teendőd.”
4. „Két tételt kell ellenőrizned.”
5. „Itt láthatod, hogyan számoltuk.”

## 26.4 Landing hero

```text
Mindig tudd, mennyi folyt be, mennyit tegyél félre,
és mi a következő adózási teendőd.

[Interaktív demó]
```

## 26.5 Landing bizonyíték

A funkciólista helyett:

- NAV-adatok automatikus frissítése;
- pénzforgalmi bevételkövetés;
- AAM- és átalányadó-keret;
- határidők;
- érthető levezetés;
- könyvelői megosztás.

---

# 27. Analitika és sikerességi mutatók

## 27.1 Fő UX-mutatók

### Time to first value

A regisztrációtól az első értelmes félreteendő összegig eltelt idő.

Cél:
- demo esetén 1 perc alatt;
- éles onboarding esetén 10–15 perc alatt, NAV-beállítástól függően.

### Time to understand

A felhasználó mennyi idő alatt találja meg:

- félreteendő összeget;
- következő teendőt;
- keretállapotot.

Cél: 30 másodpercen belül.

### Task completion

- ellenőrzendő számla lezárása;
- NAV-kapcsolat beállítása;
- nyugta rögzítése;
- export elkészítése;
- könyvelő meghívása.

### Manual touches per month

Hány kézi művelet szükséges havonta.

A termék fejlődésével ennek csökkennie kell.

## 27.2 Üzleti mutatók

- onboarding completion;
- NAV connection success;
- első hét aktív használat;
- 30/90 napos retention;
- éves csomag arány;
- könyvelőmeghívás arány;
- demo → regisztráció;
- regisztráció → fizetés;
- támogatási jegyek száma felhasználónként.

## 27.3 Bizalmi mutatók

- számítás megnyitás gyakorisága;
- „Miért változott?” használata;
- elutasított chatkérdések;
- hibás vagy visszavont automatikus párosítás;
- könyvelői korrekciók aránya;
- adatminőség hiányos állapotban töltött idő.

## 27.4 Kerülendő vanity metric

- képernyőmegtekintés;
- chatüzenetek száma;
- OCR-feltöltések száma önmagában;
- dashboardon töltött idő.

Egy jó rendszerben a felhasználó kevés időt tölt adminisztrációval.

---

# 28. Fejlesztési prioritások

## P0 – strukturális UI-újratervezés

1. Navigáció csökkentése négy fő területre.
2. Új állapot- és teendőközpontú főoldal.
3. AAM-keret beemelése.
4. „Nem tudjuk biztosan” állapot kialakítása.
5. Egy domináns CTA képernyőnként.
6. KATA, nyugdíj és chat kivétele a főmenüből.
7. Regisztráció helyett demo / várólista / belépés.
8. Egységes adatfrissesség-jelzés.
9. Feladatkártyák és státuszpanelek.
10. Mobil alsó navigáció.

## P1 – teljes, egyszerű ügyfélút

1. Teendők oldal.
2. Kivételalapú bevétel-ellenőrzés.
3. Adózási idővonal.
4. „Miért változott?” funkció.
5. Könyvelőmeghívó.
6. Dokumentumok és OCR új szerkezete.
7. Kontextuális magyarázó asszisztens.
8. Értesítési beállítások.
9. Alkalmassági onboarding.
10. Adatminőségi állapot.

## P2 – automatizáció és differenciálás

1. Bankszinkron.
2. Automatikus számla–banktétel párosítás.
3. Előrejelzett AAM-keretátlépés.
4. Bevallási varázsló.
5. Könyvelői kockázati munkalista.
6. Automatikus nyugtaadat-szolgáltatás.
7. Biztonságosan rendelkezésre álló pénz.
8. Éves pénzügyi egészségjelentés.
9. Forgatókönyv-tervezés.
10. Automatizált adatminőségi monitor.

## P3 – további fejlesztések

1. mobilalkalmazás;
2. naptárintegráció;
3. partneri könyvelői hálózat;
4. további adózási szegmensek;
5. külföldi ügyletek;
6. ÁFA-körös felhasználók;
7. alkalmazottal működő vállalkozások.

---

# 29. Ajánlott végleges termékstruktúra

```text
Áttekintés
│
├── Minden rendben?
├── Félreteendő összeg
├── Következő teendő
├── Keretek
├── Adatfrissesség
└── Idővonal

Bevételek
│
├── Ellenőrzendő
├── Befolyt
├── Kintlévő
├── Részfizetés
├── Banki párosítás
└── Minden tétel

Teendők
│
├── Most
├── Következő 7 nap
├── Később
├── Lejárt
└── Elkészült

Dokumentumok
│
├── Nyugták
├── Saját nyugták
├── OCR
├── PDF
├── CSV
└── Könyvelői csomag

Továbbiak
│
├── Tervezés
├── Könyvelő
├── Beállítások
└── Segítség
```

---

# 30. Végső döntési javaslat

A MikroKönyv UI-jának nem az a feladata, hogy bizonyítsa a termék 13 különböző funkcióját.

A felületnek ezt az ügyfélélményt kell létrehoznia:

```text
Belépek
    ↓
Látom, hogy minden rendben van-e
    ↓
Látom, mennyit kell félretennem
    ↓
Látom a következő teendőmet
    ↓
Ha kell, egyetlen lépéssel elvégzem
    ↓
Kilépek
```

A részletes számítás, NAV-integráció, OCR, nyugdíjszimuláció, KATA-összehasonlítás, könyvelői hozzáférés és AI-magyarázat mind értékes funkció lehet, de csak akkor, ha nem teszi bonyolultabbá az elsődleges élményt.

A legfontosabb végső alapelv:

> **A MikroKönyv ne könyvelői feladatokat mutasson, hanem vállalkozói döntéseket egyszerűsítsen.**

A sikeres felület nem azt mondja:

> „Itt van minden adatod.”

Hanem ezt:

> **„Minden rendben. Ennyit tegyél félre. Ez a következő dolgod.”**

---

## Külső inspirációs források

- Billingo: https://www.billingo.hu/
- Billingo Átalányadó Asszisztens: https://www.billingo.hu/atalanyado-asszisztens
- Számlázz.hu Keret- és adófigyelő: https://www.szamlazz.hu/keret-es-adofigyelo-egyeni-vallalkozoknak/
- QuickBooks Solopreneur: https://quickbooks.intuit.com/solopreneur/
- FreeAgent self assessment és Tax Timeline: https://www.freeagent.com/features/self-assessment/
- ANNA Money: https://anna.money/
- Xero: https://www.xero.com/

---

**Dokumentum vége**
