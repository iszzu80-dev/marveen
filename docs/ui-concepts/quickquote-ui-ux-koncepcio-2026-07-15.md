# QuickQuote (QQ) – teljes UI/UX koncepció

**Dátum:** 2026-07-15  
**Cél:** a QuickQuote felhasználói felületének és ügyfélélményének teljes újragondolása a magyar és nemzetközi versenytársak, a célperszónák és a fő használati folyamatok alapján.  
**Elsődleges platform:** mobil web / reszponzív PWA  
**Másodlagos platform:** desktop web  
**Elsődleges célfelhasználó:** magyar egyéni szakiparos vagy 1–5 fős szakipari mikrovállalkozás

---

# 1. Vezetői összefoglaló

A QuickQuote UI-ját nem klasszikus ügyviteli rendszerként és nem mini-ERP-ként érdemes felépíteni, hanem **helyszíni, mobilos ajánlatkészítő eszközként**.

A legfontosabb termékígéret:

> **A szakiparos 2–3 percen belül jusson el a diktálástól, jegyzettől vagy fotótól az ellenőrzött és elküldhető ajánlatig.**

A Billingo, Innonest, Jobber, Tradify, Housecall Pro és hasonló rendszerek erőssége a teljes ügyviteli vagy field-service folyamat kezelése. Ez ugyanakkor komplexitást is hoz: sok mező, sok modul, sok státusz és sok adminisztráció.

A QQ-nak nem ezt a komplexitást kell lemásolnia.

A QQ versenyelőnye UI-ban:

- gyorsabb első ajánlatkészítés;
- természetes nyelvű bevitel;
- minimális kézi adatbevitel;
- saját árak elsőbbsége;
- világos ellenőrzési pontok;
- egyetlen folyamattá összekötött bevitel, szerkesztés, küldés és követés;
- mobilos, egykezes használat;
- szakiparosok számára érthető nyelvezet;
- regisztráció nélküli, egyszerű ügyféloldali elfogadás.

A teljes UI-koncepció három mondatban:

> **Elmondom, mit kell megcsinálni.**  
> **A rendszer érthető ajánlattá rendezi, és megmutatja, mit kell ellenőriznem.**  
> **Egyetlen lépésben elküldöm, majd látom, mi történt vele.**

---

# 2. Termékpozicionálás UI-szempontból

## 2.1 Mit ne sugalljon a UI?

A QQ ne tűnjön:

- könyvelőprogramnak;
- számlázórendszernek;
- ERP-nek;
- CRM-nek;
- futurisztikus AI-demónak;
- szakértői árbecslő rendszernek;
- automatikusan döntő AI-nak;
- „minden szakmát mindennel kezelő” üzleti platformnak.

## 2.2 Mit sugalljon?

A kívánatos termékérzet:

> **Megbízható, gyors szakmai eszköz, amelyet munkaruhában, napsütésben, helyszínen és egy kézzel is könnyű használni.**

A felület kommunikálja, hogy:

- a felhasználó irányít;
- az AI csak segít;
- az árakat a szakiparos hagyja jóvá;
- bizonytalan tétel nem mehet ki észrevétlenül;
- az ajánlat professzionális lesz;
- a folyamat gyorsabb, mint Wordben vagy Excelben;
- nincs szükség hosszú betanulásra.

---

# 3. Célperszónák

## 3.1 Egyéni szakiparos a helyszínen

### Jellemzők

- telefonról használja;
- gyakran egy kézzel;
- lehet piszkos a keze;
- sokszor kesztyűben dolgozik;
- siet;
- nem akar hosszú űrlapokat kitölteni;
- nem feltétlenül magabiztos digitális felhasználó;
- szaknyelven, de nem strukturáltan fogalmaz;
- gyakran este vagy két munka között készít ajánlatot;
- sokszor ugyanazokat a munkatípusokat és árakat használja.

### Fő céljai

- gyorsan rögzíteni, mit látott;
- ne felejtsen ki tételeket;
- saját áraival dolgozni;
- professzionális ajánlatot küldeni;
- tudni, hogy az ügyfél megnyitotta-e;
- ne kelljen külön emlékeznie a follow-upra.

### Fő félelmei

- az AI rossz árat ad;
- túl bonyolult a rendszer;
- sok idő a beállítás;
- elvesznek az adatai;
- az ügyfél nem kapja meg;
- véletlenül rossz ajánlatot küld;
- havidíjat fizet, de nem használja.

### UI-következmények

- a kezdőképernyő központi eleme az **Új ajánlat**;
- kevés szöveg, nagy gombok;
- diktálás elsőrangú funkció;
- automatikus mentés;
- hibás vagy hiányos tétel vizuálisan egyértelmű;
- nincs táblázatos szerkesztés mobilon;
- nincs túl sok státusz;
- nincs kötelező onboarding-túra;
- a termék tanuljon a használat közben.

## 3.2 Mikrovállalkozás tulajdonosa vagy művezetője

### Jellemzők

- több ajánlatot kezel;
- lehet, hogy más készíti elő az ajánlatot;
- fontos számára az árak egységessége;
- látni akarja, mi vár válaszra;
- ellenőrizni akarja a kiküldés előtt;
- több dolgozó vagy több szakma is lehet a vállalkozásban.

### Fő céljai

- egységes árazás;
- ajánlatok ellenőrzése;
- munkatársak piszkozatainak jóváhagyása;
- follow-up státuszok;
- nyerési arány;
- elfogadott ajánlati érték;
- ismétlődő sablonok.

### UI-következmények

- **Ellenőrzésre vár** nézet;
- tulajdonosi jóváhagyás;
- felhasználói szerepkörök;
- saját árjegyzék központi kezelése;
- ajánlatverziók;
- teendőalapú dashboard;
- egyszerű, nem BI-jellegű analitika.

## 3.3 Irodai adminisztrátor vagy családtag

### Jellemzők

- gyakrabban használ desktopot;
- ügyfeleket és adatokat javít;
- ajánlatokat formáz;
- sablonokat kezel;
- számlázóba továbbít;
- több ajánlatot kezel egyszerre.

### Fő céljai

- gyors keresés;
- tömeges szerkesztés;
- ügyféltörténet;
- sablonkezelés;
- számlázási átadás;
- export;
- hibás adatok javítása.

### UI-következmények

- desktopon táblázatos lista megengedett;
- gyorsbillentyűk;
- oldalsó navigáció;
- inline szerkesztés;
- több ajánlat összehasonlítása;
- szűrés és mentett nézetek;
- de a mobilfelület ne váljon desktop ERP-vé.

## 3.4 Az ajánlatot kapó ügyfél

### Jellemzők

- nem akar regisztrálni;
- jellemzően telefonon nyitja meg az ajánlatot;
- gyorsan akarja érteni a tartalmat és a teljes árat;
- nem biztos, hogy érti a szakmai részleteket;
- kérdést vagy módosítást akarhat;
- összehasonlíthat más ajánlatokat;
- bizalmat keres.

### Fő céljai

- mit tartalmaz az ajánlat;
- mi nincs benne;
- mennyi a végösszeg;
- meddig érvényes;
- mikor készülhet el;
- hogyan kérhet módosítást;
- hogyan fogadhatja el;
- kit hívhat kérdés esetén.

### UI-következmények

- külön ügyféloldali mobilélmény;
- regisztráció nélkül;
- jól látható vállalkozói név és elérhetőség;
- egyszerű összefoglaló;
- opcionálisan részletes tételbontás;
- állandó alsó elfogadási sáv;
- módosításkérés;
- telefonhívás;
- PDF-letöltés;
- világos elfogadási visszaigazolás.

---

# 4. Fő UX-alapelv: capture first

A legtöbb ügyviteli rendszer azzal kezd, hogy a felhasználó kiválasztja:

- az ügyfelet;
- a dokumentumtípust;
- a projektet;
- a dátumot;
- a sablont;
- az árlistát;
- az érvényességet;
- az áfakulcsot.

A QQ ezzel szemben egyetlen kérdéssel induljon:

> **Mit kell megcsinálni?**

Alatta három elsődleges beviteli mód:

1. **Elmondom**
2. **Leírom**
3. **Lefotózom**

Az ügyfél neve, email-címe, ajánlati érvényesség és egyéb adminisztratív adatok csak akkor kerüljenek elő, amikor a munka tartalma már elkészült.

Ez csökkenti:

- a kognitív terhelést;
- a félbehagyást;
- az első ajánlatig eltelt időt;
- a tanulási küszöböt;
- a hibás adatbevitel esélyét.

---

# 5. Információs architektúra

## 5.1 Mobil alsó navigáció

Legfeljebb öt elem:

| Navigáció | Funkció |
|---|---|
| **Kezdőlap** | Új ajánlat, teendők, piszkozatok |
| **Ajánlatok** | Ajánlatlista, keresés, státuszok |
| **＋ Új** | Kiemelt ajánlatkészítő gomb |
| **Ügyfelek** | Ügyféltörzs és előzmények |
| **Továbbiak** | Saját árak, sablonok, elemzés, beállítások |

A középső **＋ Új** gomb minden főképernyőről elérhető legyen.

### Miért ez a struktúra?

A felhasználó mentális modellje:

- új ajánlatot készítek;
- megnézem az ajánlataimat;
- megkeresek egy ügyfelet;
- beállítom a saját áraimat;
- ritkábban elemzek vagy konfigurálok.

Az „Áttekintés” mint mindent tartalmazó almenü nem követi ezt a mentális modellt.

## 5.2 Desktop navigáció

Bal oldali állandó navigáció:

- Kezdőlap
- Ajánlatok
- Ügyfelek
- Saját árak
- Sablonok
- Elemzés
- Beállítások

Felső sáv:

- globális keresés;
- értesítések;
- súgó;
- profil;
- kiemelt **Új ajánlat** gomb.

A mobil és desktop információs architektúra legyen azonos. Csak a megjelenítés és a sűrűség változzon.

---

# 6. Fő ajánlatkészítési folyamat

A teljes folyamat ideális esetben három fő lépésből áll:

1. **Munka rögzítése**
2. **Pontosítás és ellenőrzés**
3. **Ügyfél és küldés**

A fejlécben egyszerű progress:

```text
1. Munka  →  2. Ellenőrzés  →  3. Küldés
```

Mobilon ne legyen túl részletes stepper; csak jelezze, hol tart a felhasználó.

---

# 7. 1. lépés – Munka rögzítése

## 7.1 Képernyőstruktúra

```text
Mit kell megcsinálni?

[ 🎤 Elmondom ]

[ Írd vagy másold ide a jegyzetet… ]

[ 📷 Fotó hozzáadása ]

[ 📋 Sablonból indulok ]
```

Példaszöveg:

> „30 négyzetméter nappali festése két rétegben, kisebb gletteléssel, fóliázással és kiszállással.”

## 7.2 Diktálás UX

A diktálás legyen az elsődleges, legnagyobb CTA.

### Felvétel előtti állapot

```text
[ 🎤 Elmondom a munkát ]
```

### Felvétel közben

```text
Hallgatlak…

00:18

[ Szünet ]      [ Kész ]
```

### Felvétel után

A diktált szöveg azonnal jelenjen meg szerkeszthetően.

```text
„Harminc négyzetméter nappali festése két rétegben,
kisebb gletteléssel és fóliázással.”

[ Újra felveszem ]   [ Folytatás ]
```

## 7.3 Diktálási mikroszövegek

- „Mondd el úgy, ahogy egy kollégának mondanád.”
- „Mondhatsz mennyiséget, egységárat és kiszállási díjat is.”
- „A szöveget a következő lépésben ellenőrizheted.”
- „A végleges árakat mindig te hagyod jóvá.”

## 7.4 Szöveges bevitel

Támogatott legyen:

- gépelés;
- másolás;
- korábbi jegyzet beillesztése;
- WhatsApp/Viber/SMS szöveg beillesztése;
- ügyfél emailjéből kimásolt leírás.

A mező ne legyen klasszikus kis textarea. Legyen nagy, teljes szélességű, kényelmes beviteli felület.

## 7.5 Fotó hozzáadása

A fotó ne különálló „modul” legyen.

Ugyanahhoz az ajánlathoz lehessen:

- szöveget;
- hangot;
- több fotót;
- kézi megjegyzést;
- sablont

együttesen használni.

## 7.6 Automatikus mentés

Minden bevitelt folyamatosan mentsen.

Visszajelzések:

- „Piszkozat mentve”
- „Piszkozat elmentve ezen az eszközön”
- „Kapcsolat helyreállt, szinkronizálva”
- „Offline dolgozol – az adatok nem vesznek el”

---

# 8. 2. lépés – Dinamikus pontosítás

Az AI ne azonnal mutasson kész ajánlatot, ha fontos adatok hiányoznak.

Először csak a szükséges, magas értékű kérdéseket tegye fel.

## 8.1 Kérdéskártyák

Példa festésnél:

```text
Még 3 információ hiányzik

Hány réteg festés?
[ 1 ] [ 2 ] [ 3 ]

Ki biztosítja az anyagot?
[ Én ] [ Az ügyfél ] [ Még nem tudom ]

Milyen állapotú a fal?
[ Jó ]
[ Kisebb javítás kell ]
[ Erős javítás kell ]
```

## 8.2 Szakmaspecifikus kérdések

### Festés

- felület nagysága;
- rétegek száma;
- fal állapota;
- mennyezet is készül-e;
- anyagot ki adja;
- takarás szükséges-e;
- bútorok mozgatása;
- magasság;
- színváltás.

### Burkolás

- felület nagysága;
- fal vagy padló;
- bontás szükséges-e;
- aljzat állapota;
- lapméret;
- fugázás;
- szegély;
- vízszigetelés;
- anyagot ki adja.

### Villanyszerelés

- darabszám;
- süllyesztett vagy falon kívüli;
- meglévő hálózat állapota;
- új áramkör kell-e;
- falvésés;
- anyag;
- kiszállás;
- hibakeresés vagy telepítés.

### Vízszerelés

- csere vagy új kiépítés;
- hozzáférhetőség;
- bontás szükséges-e;
- csőanyag;
- darabszám;
- kiszállás;
- sürgősség.

### Klímaszerelés

- készülék típusa;
- telepítés vagy karbantartás;
- csőhossz;
- emelet;
- kültéri egység elérhetősége;
- elektromos kiállás;
- falvastagság;
- kondenzvíz-elvezetés.

### Költöztetés

- honnan és hová;
- emelet;
- lift;
- hozzávetőleges térfogat;
- rakodók száma;
- távolság;
- csomagolás;
- különösen nehéz tárgy.

## 8.3 Kérdésszám

Maximum 3–5 kérdés jelenjen meg egyszerre.

Ha ennél több információ hiányzik:

- csoportosítsa a rendszer;
- lépésenként kérdezzen;
- először a végösszeget legjobban befolyásoló adatokat kérje.

## 8.4 Kihagyás

Minden kérdésnél legyen:

> **Most kihagyom**

Az így keletkezett tétel kapjon:

- „Ellenőrzést igényel”
- „Mennyiség hiányzik”
- „Ár hiányzik”
- „Anyag nincs meghatározva”

jelzést.

Hiányos tételt ne lehessen észrevétlenül kiküldeni.

---

# 9. 3. lépés – Tételes ellenőrzés

## 9.1 Mobilos kártyás szerkesztés

Mobilon ne jelenjen meg Excel-szerű táblázat.

Minden tétel külön kártya:

```text
Nappali festése

30 m² × 3 200 Ft

96 000 Ft

Ár forrása: Saját ár

[ Módosítás ]
```

## 9.2 Hiányos tétel

```text
Takarófólia és maszkolás

Ár még nincs megadva

⚠ Ellenőrzést igényel

[ Ár megadása ]
```

## 9.3 Bizonytalan mennyiség

```text
Kisebb glettelés

Becsült mennyiség: 5 m²

A mennyiséget a leírás alapján becsültük.

[ Megerősítem ]   [ Módosítom ]
```

## 9.4 Sticky összegző sáv

A képernyő alján mindig látható:

```text
Összesen: 137 160 Ft

2 tétel ellenőrizve • 1 hiányos

[ Ellenőrzés befejezése ]
```

Minden tétel rendben:

```text
Összesen: 149 860 Ft

Minden tétel ellenőrizve

[ Ügyfél és küldés ]
```

## 9.5 Új tétel hozzáadása

Nagy, jól látható gomb:

```text
[ ＋ Új tétel ]
```

Lehetőségek:

- saját árból;
- QQ referencia alapján;
- egyedi tétel;
- korábbi ajánlatból;
- sablonból.

---

# 10. Árforrások megjelenítése

A technikai `high / medium / low confidence` címkék ne jelenjenek meg fő UI-nyelvként.

## 10.1 Felhasználóbarát címkék

- **Saját ár**
- **Korábbi ajánlatból**
- **QQ referencia**
- **Felhasználó adta meg**
- **Ár nincs megadva**

## 10.2 Részletes forráspanel

„Miért ezt az árat látom?” lenyitható panel:

```text
Ár forrása: QQ referencia

Terület: Budapest és Pest vármegye
Frissítve: 2026. július
Jellemző tartomány: 2 800–3 600 Ft/m²
A te ajánlatodban: 3 200 Ft/m²
```

## 10.3 Saját ár elsőbbsége

A prioritási sorrend:

1. felhasználó által explicit megadott ár;
2. saját árjegyzék;
3. korábbi, hasonló elfogadott ajánlat;
4. QQ referencia;
5. ár nélkül, kézi ellenőrzésre.

## 10.4 Ár mentése használat közben

Amikor a felhasználó módosít egy árat:

```text
Ezt az árat legközelebb is használjuk?

Festés, két réteg
3 400 Ft/m²

[ Igen, mentés a saját áraimhoz ]
[ Csak ebben az ajánlatban ]
```

Ez fontosabb UX, mint egy külön, bonyolult árjegyzék-adminisztráció.

---

# 11. Saját árak felület

A menüpont neve:

> **Saját árak**

Nem „Ratebook”, nem „Ár-adatbázis”, nem „Árjegyzék-motor”.

## 11.1 Saját áraim

```text
Festés, két réteg                  3 200 Ft/m²
Glettelés                          2 400 Ft/m²
Kiszállás Budapest                 8 000 Ft
Konnektorcsere                     6 500 Ft/db
```

## 11.2 QQ referenciaárak

Külön vizuális szekció:

```text
Festés, két réteg

Tipikus referencia:
2 800–3 600 Ft/m²

[ Felveszem a saját áraim közé ]
```

## 11.3 Első beállítás

Három lehetőség:

1. **Használom a QQ induló referenciaárait**
2. **Beírom a saját áraimat**
3. **Importálom Excelből vagy korábbi ajánlatból**

## 11.4 Import UX

Import előtt ne kelljen sablont letölteni.

A rendszer:

- feltölti az Excel/CSV fájlt;
- felismeri az oszlopokat;
- megmutatja az előnézetet;
- jelzi a hibás sorokat;
- szakmánként csoportosít;
- duplikátumot jelez.

---

# 12. Ismeretlen és 0 Ft-os tételek kezelése

Az „ismeretlen ár” nem jelenhet meg 0 Ft-ként.

Belső státuszok:

- `priced`
- `unpriced`
- `included_in_labour`
- `customer_supplied`
- `to_be_confirmed`

Felhasználói megjelenítés:

| Belső állapot | UI-szöveg |
|---|---|
| priced | Ár megadva |
| unpriced | Ár még nincs megadva |
| included_in_labour | A munkadíj tartalmazza |
| customer_supplied | Az ügyfél biztosítja |
| to_be_confirmed | Később pontosítandó |

Kiküldési szabály:

- `unpriced` tétel blokkol;
- `to_be_confirmed` tétel csak explicit jóváhagyással mehet ki;
- `customer_supplied` és `included_in_labour` egyértelműen jelenjen meg az ügyféloldalon.

---

# 13. Fotófunkció UI

## 13.1 Fotó készítése előtti útmutatás

```text
A jobb felismeréshez készíts:

✓ egy képet az egész területről
✓ egy közelit a hibáról
✓ egy képet méretreferenciával

Kerüld emberek és személyes iratok fotózását.
```

## 13.2 Fotótípusok

A rendszer külön kérheti:

- teljes helyiség;
- részlet;
- méretreferencia;
- sérülés;
- hozzáférési pont;
- gép vagy készülék adattábla.

## 13.3 Automatikus adatvédelmi ellenőrzés

Feltöltés előtt:

```text
Fotó ellenőrzése

✓ Helyadatok eltávolítva
✓ 1 arc automatikusan kitakarva
⚠ Egy személyes dokumentum lehet a képen

[ Kitakarás szerkesztése ]
[ Biztonságos feltöltés ]
```

## 13.4 Kitakarás szerkesztése

Funkciók:

- automatikus kijelölés;
- új kitakarási terület;
- visszavonás;
- nagyítás;
- kitakarás törlése;
- eredeti/feldolgozott váltás.

Ne csak drag-and-drop legyen. Minden funkció működjön koppintással is.

## 13.5 Fotóelemzés eredménye

Ne közvetlen végösszeget mutasson.

```text
A fotón valószínűleg látható:

✓ Falfestés
✓ Kisebb vakolatjavítás
? A teljes felület mérete nem állapítható meg

A folytatáshoz add meg:

[ Körülbelüli felület: ___ m² ]

[ Tételek hozzáadása az ajánlathoz ]
```

## 13.6 Line-item szintű bizonyosság

Ne egyetlen `confident: true/false` legyen a felhasználói logika.

Tételenként:

- felismert;
- valószínű;
- nem megállapítható;
- méret szükséges;
- manuális ellenőrzés szükséges.

## 13.7 Fotós pozicionálás

Javasolt marketing/UI-szöveg:

> **Fotóból felismeri a lehetséges munkatételeket és megmutatja, milyen adat hiányzik az árazáshoz. A végleges árat mindig te hagyod jóvá.**

Kerülendő:

> „Az AI megmondja a pontos árat a fotóból.”

---

# 14. Kezdőlap – teendőközpont

A kezdőlap ne analitikai dashboard legyen.

## 14.1 Mobil kezdőképernyő

```text
Jó reggelt, István!

[ ＋ Új ajánlat ]

Mondd el, írd le vagy fotózd le a munkát

TEENDŐID                                      3

⚠ Kovács Anna módosítást kért
245 000 Ft • 18 perce
[ Megnézem ]

⏳ Nagy Péter ajánlata 4 napja válaszra vár
86 000 Ft
[ Emlékeztető küldése ]

⚠ Festés – piszkozat
1 tétel ára hiányzik
[ Folytatom ]

LEGUTÓBBI AJÁNLATOK

Szabó Éva              Elfogadva       192 000 Ft
Tóth Gábor             Megnyitva       340 000 Ft
Varga Ádám             Piszkozat        75 000 Ft
```

## 14.2 Kisméretű havi összefoglaló

```text
Ebben a hónapban

Kiküldve: 14
Elfogadva: 8
Elfogadott érték: 1,24 M Ft
```

## 14.3 Mit ne tegyünk a kezdőlapra?

- kördiagram;
- gauge;
- napi/heti/havi bonyolult grafikonok;
- túl sok KPI;
- forrásminőség-statisztika;
- token- vagy AI-használati adatok;
- technikai backendállapot;
- túl részletes CRM pipeline.

---

# 15. Ajánlatlista

## 15.1 Gyorsszűrők

- **Teendő**
- **Válaszra vár**
- **Elfogadva**
- **Összes**

## 15.2 Felhasználói státuszok

| Belső állapot | UI-megnevezés |
|---|---|
| draft | Piszkozat |
| needs_review | Ellenőrzést igényel |
| sent | Elküldve |
| viewed | Megnyitva |
| change_requested | Módosítást kértek |
| accepted | Elfogadva |
| declined | Elutasítva |
| expired | Lejárt |

## 15.3 Ajánlatkártya

```text
Nagy Péter

Fürdőszoba burkolása

340 000 Ft

Megnyitva 3 napja

Javasolt következő lépés:
[ Emlékeztető küldése ]
```

## 15.4 Következő legjobb művelet

A státusz mellett mindig jelenjen meg a következő értelmes művelet:

- Piszkozat → Folytatás
- Ellenőrzést igényel → Javítás
- Elküldve → Megnyitás ellenőrzése
- Megnyitva → Emlékeztető
- Módosítást kértek → Módosítás megnyitása
- Elfogadva → Munka indítása / számlázás
- Lejárt → Megújítás

---

# 16. Ajánlat részletes nézete

## 16.1 Fejléc

- ügyfél neve;
- munka címe;
- státusz;
- végösszeg;
- utolsó esemény;
- következő javasolt művelet.

## 16.2 Eseményidővonal

```text
2026.07.15. 10:42  Ajánlat elküldve
2026.07.15. 11:03  Email kézbesítve
2026.07.15. 18:24  Ügyfél megnyitotta
2026.07.16. 09:10  Módosítást kért
```

## 16.3 Műveletek

- Módosítás
- Újraküldés
- Emlékeztető küldése
- Link másolása
- PDF
- Duplikálás
- Lejárat módosítása
- Visszavonás
- Törlés

A fő művelet ne legyen hárompontos menüben.

---

# 17. Ügyfél kiválasztása és küldés

## 17.1 Ügyfél csak a végén

Az ajánlat tartalma előbb készül el.

Küldési lépés:

```text
Kinek küldöd?

[ Ügyfél keresése vagy új ügyfél hozzáadása ]

Kovács Anna
anna@example.hu
+36 30 123 4567
```

## 17.2 Küldési csatorna

```text
Küldés módja

● Email
○ SMS
○ Link másolása
```

Több csatorna is választható.

## 17.3 Email előnézet

```text
Tárgy:
Árajánlat – nappali festése

Üzenet:
Kedves Anna!

Elkészítettem a megbeszélt munkára vonatkozó
árajánlatot. Az alábbi gombra kattintva megtekinthető.

[ Üzenet szerkesztése ]

[ Próba küldése magamnak ]
[ Ajánlat elküldése ]
```

## 17.4 Küldési visszajelzés

```text
Ajánlat elküldve ✓

Email: kézbesítve
SMS: elküldve

[ Ajánlat megnyitása ]
[ Vissza a kezdőlapra ]
```

## 17.5 Technikai állapotok

Normál felhasználói UI-ban ne jelenjen meg:

- `gmail=dev`
- `Twilio backend`
- `bedrock-eu`
- `mock`
- `provider unavailable`

Ehelyett:

- működő csatorna elérhető;
- nem működő csatorna nem választható;
- rövid, érthető hibaüzenet;
- újrapróbálás;
- alternatív csatorna.

---

# 18. Follow-up UX

## 18.1 Automatikus emlékeztető beállítása

Küldés előtt:

```text
Automatikus emlékeztető

[✓] Emlékeztessen, ha 3 napig nincs válasz

Mikor álljon le?
[ Elfogadáskor ]
[ Elutasításkor ]
[ Ügyfélválasznál ]
```

## 18.2 Emlékeztető szöveg

Egyszerű, emberi hang:

> „Kedves Anna! Szeretném megkérdezni, volt-e lehetősége átnézni az ajánlatot. Ha kérdése vagy módosítási kérése van, kérem, jelezze.”

## 18.3 Stopfeltételek

A follow-up álljon le:

- elfogadás;
- elutasítás;
- ügyfélválasz;
- módosításkérés;
- időpontfoglalás;
- kézi leállítás;
- ajánlat lejárata;
- leiratkozás.

Ne álljon le pusztán megnyitásszám alapján.

---

# 19. Ügyféloldali ajánlat

## 19.1 Felső rész

```text
Kovács Burkolás

Árajánlat

Fürdőszoba burkolása

Készült: 2026. július 15.
Érvényes: 2026. július 30-ig
```

## 19.2 Bizalmi elemek

- vállalkozó neve;
- logó;
- telefonszám;
- email;
- szolgáltatási terület;
- adószám, ha releváns;
- opcionális értékelés vagy referencia;
- „Kérdése van? Hívjon” gomb.

## 19.3 Rövid tartalmi összefoglaló

```text
Mit tartalmaz?

• Régi burkolat bontása
• Aljzat előkészítése
• 24 m² fal- és padlóburkolás
• Fugázás és szegélyezés
```

## 19.4 Tételrészletek

Alapértelmezésben könnyen olvasható összefoglaló.

Opcionálisan:

- mennyiség;
- egység;
- egységár;
- részösszeg;
- anyag/munkadíj;
- megjegyzés.

A szakiparos beállíthassa, hogy az egységárak láthatók-e.

## 19.5 Nem tartalmazza

Külön blokk:

```text
Az ajánlat nem tartalmazza:

• a burkolólap árát;
• rejtett szerkezeti hibák javítását;
• villanyszerelési munkát.
```

Ez csökkenti a későbbi vitát.

## 19.6 Ütemezés és feltételek

- várható kezdés;
- becsült időtartam;
- fizetési ütemezés;
- előleg;
- garancia;
- ajánlati érvényesség.

## 19.7 Alsó sticky sáv

```text
Összesen: 486 500 Ft

[ Módosítást kérek ]
[ Ajánlat elfogadása ]
```

## 19.8 További műveletek

- Kérdésem van
- Felhívom a vállalkozót
- PDF letöltése
- Ajánlat elutasítása

---

# 20. Módosításkérés

Ne üres szövegmezővel induljon.

```text
Mit szeretne módosítani?

[ Műszaki tartalom ]
[ Ár ]
[ Időpont ]
[ Opcionális tétel ]
[ Egyéb ]
```

Utána szabad szöveg.

A szakiparos oldalán:

```text
Kovács Anna módosítást kért

Téma: Időpont

„Augusztus 12. helyett augusztus 19. megfelelő lenne?”

[ Válaszolok ]
[ Ajánlat módosítása ]
```

---

# 21. Ajánlatelfogadás

## 21.1 Elfogadási képernyő

```text
Ajánlat elfogadása

Név: Kovács Anna
Email: anna@example.hu

☐ Elolvastam és elfogadom az ajánlat tartalmát
és feltételeit.

[ Elfogadás ]
```

## 21.2 Erősebb elfogadás

Opcionálisan, magasabb értéknél:

- emailes egyszer használatos kód;
- SMS OTP;
- elektronikus aláírás;
- időbélyeg;
- előlegfizetés.

## 21.3 Elfogadás utáni képernyő

```text
Köszönjük, az ajánlatot elfogadta ✓

Elfogadás ideje:
2026. július 16. 14:32

A vállalkozó értesítést kapott.

[ Elfogadott ajánlat letöltése ]
[ Kapcsolatfelvétel ]
```

## 21.4 Jogi nyelv

Kerülendő:

- „eIDAS evidence”
- „minősített aláírás”
- „jogilag garantált”

Javasolt:

> „Az elfogadás időpontját és az ajánlat elfogadott változatát biztonságosan rögzítjük.”

---

# 22. Sablonok és szakmai gyorscsomagok

A sablon ne üres dokumentumsablon legyen, hanem valós szakmai kiindulópont.

## 22.1 Festés

- tisztasági festés;
- teljes festés gletteléssel;
- homlokzatfestés;
- egy helyiség festése;
- javítás utáni festés.

## 22.2 Burkolás

- fürdőszoba burkolás;
- konyhai hátfal;
- padlóburkolás;
- bontás és újraburkolás;
- teraszburkolás.

## 22.3 Villanyszerelés

- konnektorcsere;
- lámpatestcsere;
- új áramkör;
- hibakeresés;
- részleges felújítás.

## 22.4 Vízszerelés

- csaptelepcsere;
- szivárgásjavítás;
- WC-csere;
- mosógépbekötés;
- új vízkiállás.

## 22.5 Klíma

- klímatelepítés;
- klímatisztítás;
- áthelyezés;
- hibafeltárás;
- karbantartás.

## 22.6 Természetes nyelvű módosítás

Sablon kiválasztása után:

> „Ez ugyanaz, csak 42 négyzetméter és két szoba.”

A rendszer mutassa:

```text
Változások:

Felület: 30 m² → 42 m²
Helyiségek: 1 → 2

[ Módosítások elfogadása ]
```

---

# 23. Ügyfelek felület

## 23.1 Ügyfélkártya

- név;
- telefonszám;
- email;
- cím;
- utolsó ajánlat;
- összes ajánlati érték;
- elfogadott munkák;
- megjegyzés.

## 23.2 Ügyfél részletes nézet

Szekciók:

- Kapcsolat
- Ajánlatok
- Elfogadások
- Munkák
- Megjegyzések
- Dokumentumok

## 23.3 Gyors műveletek

- Új ajánlat
- Telefonhívás
- Email
- Korábbi ajánlat duplikálása
- Cím másolása
- Megjegyzés hozzáadása

---

# 24. Elemzés

Ne épüljön teljes BI-dashboard.

## 24.1 Öt valóban hasznos mutató

1. Kiküldött ajánlatok száma
2. Elfogadási arány
3. Elfogadott ajánlatok értéke
4. Átlagos válaszidő
5. Follow-up után elfogadott ajánlatok

## 24.2 Cselekvésorientált analitika

```text
5 ajánlat több mint 3 napja vár válaszra

[ Mind az 5 megtekintése ]
```

```text
A festési ajánlatok 68%-át elfogadták

Átlagos válaszidő: 2,1 nap
```

```text
A saját árakkal készített ajánlatoknál
kevesebb utólagos módosítás történt.
```

## 24.3 Amit ne mérjünk fő KPI-ként

- tokenhasználat;
- AI-hívások száma;
- fotók száma;
- nyers megnyitásszám;
- promptok száma;
- technikai feldolgozási statisztika.

---

# 25. Vizuális rendszer

## 25.1 Általános stílus

- törtfehér vagy világosszürke háttér;
- mély teal/petrol főszín;
- meleg narancs csak kiemelt CTA-ra;
- zöld elfogadott állapotokra;
- piros kizárólag blokkoló hibára;
- kevés árnyék;
- világos kártyahatárok;
- nagy, olvasható számok;
- visszafogott ikonhasználat;
- nem futurisztikus AI-esztétika.

## 25.2 Példa színrendszer

- Primary: `#126A70`
- Primary dark: `#0C4F54`
- Accent: `#D6831F`
- Success: `#2E7D4F`
- Warning: `#B76B00`
- Error: `#B42318`
- Background: `#F7F8F7`
- Surface: `#FFFFFF`
- Text primary: `#263238`
- Text secondary: `#607078`
- Border: `#DCE2E3`

## 25.3 Tipográfia

- egyszerű sans-serif;
- mobil törzsszöveg minimum 16 px;
- fő összeg 24–32 px;
- gombfelirat 16–18 px;
- kerülendő a vékony font;
- maximum három betűméret-szint egy képernyőn;
- világos vizuális hierarchia.

## 25.4 Érintési célok

- fő CTA: 52–56 px magas;
- normál gomb: minimum 48 px;
- ikon + felirat;
- legalább 8–12 px tér a gombok között;
- ne legyenek apró checkboxok;
- rádiógombok teljes sorra kattinthatók legyenek.

## 25.5 Ikonok

Fontos művelet ne legyen csak ikon.

Javasolt:

- ✏️ Módosítás
- ＋ Új tétel
- 📤 Küldés
- 💰 Ár megadása
- 📷 Fotó hozzáadása
- 🎤 Elmondom
- 📋 Sablon

---

# 26. Mikroszövegek

| Kerülendő | Javasolt |
|---|---|
| Low confidence | Ellenőrizd ezt a tételt |
| AI-generated estimate | Javasolt ajánlati tételek |
| Ratebook match | Ár forrása: Saját ár |
| No ratebook match | Ehhez még adj meg árat |
| eIDAS evidence | Elfogadás rögzítve |
| Parsing failed | Nem sikerült minden tételt felismerni |
| LLM unavailable | Az automatikus feldolgozás most nem érhető el |
| Follow-up job | Automatikus emlékeztető |
| Draft persisted | Piszkozat elmentve |
| confident:false | A fotó alapján nem becsülhető megbízhatóan |
| Invalid input | Ellenőrizd a megadott adatot |
| Error 500 | Valami nem sikerült. Próbáld újra. |

---

# 27. Üres állapotok

## 27.1 Nincs ajánlat

```text
Még nincs ajánlatod

Mondd el vagy írd le az első munkát,
és a QQ elkészíti a szerkeszthető ajánlatot.

[ Első ajánlat létrehozása ]
```

## 27.2 Nincs saját ár

```text
Még nincsenek saját áraid

Kezdhetsz QQ referenciaárakkal,
és a rendszer használat közben megtanulja a saját áraidat.

[ Saját ár hozzáadása ]
[ Referenciaárak megtekintése ]
```

## 27.3 Nincs ügyfél

```text
Még nincs ügyfeled

Az első ajánlat elküldésekor automatikusan
létrejön az ügyfél adatlapja.
```

---

# 28. Hibakezelés

## 28.1 Feldolgozási hiba

```text
Nem sikerült minden tételt felismerni.

A jegyzeted nem veszett el.

[ Megpróbálom újra ]
[ Kézzel szerkesztem ]
```

## 28.2 Küldési hiba

```text
Az emailt nem sikerült elküldeni.

Az ajánlat piszkozatként elmentve.

[ Újrapróbálom ]
[ Link másolása ]
[ SMS küldése ]
```

## 28.3 Fotóelemzési hiba

```text
A fotó alapján nem tudtunk megbízható
munkatételeket azonosítani.

Próbálj egy távolabbi képet vagy adj meg méretet.

[ Új fotó ]
[ Folytatás fotó nélkül ]
```

---

# 29. Onboarding

## 29.1 Első belépés

Ne legyen hosszú onboarding wizard.

Első képernyő:

```text
Készítsük el az első ajánlatodat

Nem kell mindent előre beállítanod.
A saját áraiddal később is finomíthatod.

[ Első ajánlat létrehozása ]
```

## 29.2 Progresszív profilkitöltés

A rendszer csak akkor kérjen adatot, amikor szükséges:

- első ajánlat előtt: név;
- első küldés előtt: email/cégnév;
- első végleges dokumentum előtt: cím, adózási adatok;
- első logózott ajánlat előtt: logó;
- első online elfogadás előtt: feltételek.

## 29.3 Első sikerpillanat

Az onboarding célja ne a profil 100%-os kitöltése legyen.

A cél:

> **Az első elküldött ajánlat.**

---

# 30. Mobil és desktop eltérések

## 30.1 Mobil

- kártyás szerkesztés;
- alsó navigáció;
- sticky CTA;
- egykezes használat;
- hang és fotó kiemelt;
- kevés adat egy képernyőn;
- nagy érintési felületek;
- részletek lenyithatók.

## 30.2 Desktop

- bal oldali navigáció;
- kétoszlopos szerkesztés;
- jobb oldali élő ajánlatelőnézet;
- táblázatos ajánlatlista;
- tömeges műveletek;
- billentyűzetes navigáció;
- inline szerkesztés;
- egyszerre több adat látható.

## 30.3 Javasolt desktop ajánlatszerkesztő

Bal oldal:

- tételek;
- mennyiségek;
- árak;
- megjegyzések.

Jobb oldal:

- élő ügyféloldali előnézet;
- végösszeg;
- státusz;
- küldési beállítás.

---

# 31. Hozzáférhetőség

Követelmények:

- WCAG 2.2 AA cél;
- megfelelő kontraszt;
- ne csak szín jelezzen státuszt;
- nagy érintési célok;
- billentyűzetes használat;
- képernyőolvasó címkék;
- fókuszállapot;
- drag-and-drop alternatíva;
- egyszerű nyelvezet;
- hibaüzenet a mező mellett;
- megfelelő heading-struktúra;
- form mezők címkével, nem csak placeholderrel.

---

# 32. Teljesítmény és terepi használat

A felületet gyenge mobilhálózatra is optimalizálni kell.

## Követelmények

- gyors első betöltés;
- automatikus piszkozatmentés;
- képtömörítés;
- feltöltési progress;
- offline jegyzetmentés;
- újraküldési queue;
- alacsony adatforgalom;
- skeleton helyett gyors, stabil tartalom;
- jól olvasható napfényben;
- ne függjön folyamatos websocket-kapcsolattól.

---

# 33. Értesítések

Csak cselekvést igénylő értesítés:

- ügyfél megnyitotta;
- módosítást kért;
- elfogadta;
- elutasította;
- ajánlat lejár;
- küldés sikertelen;
- emlékeztető esedékes.

Ne értesítsen:

- minden egyes megnyitásról;
- technikai háttéreseményről;
- AI-feldolgozás befejezéséről, ha azonnali;
- irreleváns termékfrissítésről.

---

# 34. Mit nem érdemes beépíteni az első UI-ba?

1. Teljes projektmenedzsment
2. Bonyolult CRM pipeline
3. Raktárkezelés
4. Munkaidő-nyilvántartás
5. Teljes field-service dispatch
6. Komplex jogosultsági rendszer
7. Többszintű dashboard
8. Chatbot mint fő navigáció
9. Minden szakmára egyedi teljes workflow
10. Túl sok AI-varázsgomb
11. Általános BI
12. Fejlett beszerzési rendszer
13. Túl részletes beállítási oldal
14. Bonyolult brand editor
15. Automatikus végleges ár felhasználói jóváhagyás nélkül

---

# 35. P0 UI-scope

## 35.1 Szakiparosi oldal

- mobilos kezdőlap;
- új ajánlat szövegből;
- diktálás;
- fotó hozzáadása;
- dinamikus pontosító kérdések;
- kártyás tételszerkesztő;
- saját ár és QQ referencia elkülönítése;
- hiányos tételek blokkolása;
- ügyfélválasztás;
- éles email/SMS/link küldés;
- ajánlatlista;
- teendőalapú státuszok;
- egyszerű ügyfél-előzmény;
- saját árak;
- alapbeállítások;
- automatikus mentés;
- mobilos reszponzivitás.

## 35.2 Ügyféloldal

- regisztráció nélküli megtekintés;
- mobilbarát összefoglaló;
- tételrészletek;
- érvényesség;
- módosításkérés;
- kérdés;
- telefonhívás;
- elfogadás;
- elfogadási visszaigazolás;
- PDF-letöltés.

## 35.3 P0-ból kizárt

- fejlett analitika;
- több felhasználó;
- komplex jogosultság;
- Good/Better/Best;
- online fizetés;
- teljes munkalap;
- teljes CRM;
- beszállítói adatbázis.

---

# 36. P1 UI-scope

- Billingo/Számlázz.hu-integráció;
- ajánlatverziók;
- pótmunkakezelés;
- előleg;
- fizetési feltételek;
- saját árak importja;
- korábbi ajánlatból tanulás;
- szakmaspecifikus sablonok;
- több fotó vezetett feltöltése;
- line-item bizonyosság;
- több felhasználó;
- tulajdonosi jóváhagyás;
- alap analitika;
- ügyféloldali opcionális tételek.

---

# 37. P2 UI-scope

- Good/Better/Best ajánlatok;
- margin és job costing;
- beszállítói anyagárak;
- fizetési link;
- előlegfizetés;
- részletfizetés;
- fejlett elemzés;
- szakmánként eltérő onboarding;
- ajánlati konverzióoptimalizálás;
- csapat- és szerepkörkezelés;
- teljes munkalapfolyamat;
- elfogadott ajánlatból munka indítása;
- automatikus számlázási átadás.

---

# 38. Javasolt fő képernyők

## Mobil

1. Bejelentkezés
2. Első belépés
3. Kezdőlap
4. Új ajánlat – bevitel
5. Új ajánlat – kérdések
6. Új ajánlat – tételes ellenőrzés
7. Ügyfél kiválasztása
8. Küldési előnézet
9. Küldési siker
10. Ajánlatlista
11. Ajánlat részlete
12. Saját árak
13. Ügyfelek
14. Ügyfél részlete
15. Sablonok
16. Továbbiak
17. Beállítások

## Ügyféloldal

1. Ajánlat összefoglaló
2. Tételrészletek
3. Módosításkérés
4. Elfogadás
5. OTP, ha szükséges
6. Elfogadási siker
7. Elutasítás
8. PDF

## Desktop

1. Dashboard
2. Ajánlatlista
3. Ajánlatszerkesztő
4. Ügyféllista
5. Saját árak
6. Sablonok
7. Elemzés
8. Beállítások
9. Csapat
10. Integrációk

---

# 39. Javasolt fő komponensek

- Primary CTA
- Sticky bottom action bar
- Quote item card
- Price source badge
- Warning banner
- Missing data chip
- Status chip
- Activity timeline
- Customer picker
- Voice recorder
- Photo uploader
- Privacy review
- Dynamic question card
- Quote summary
- Send channel selector
- Empty state
- Error state
- Success state
- Follow-up card
- Action recommendation card
- Bottom navigation
- Desktop sidebar
- Live quote preview

---

# 40. UX-mérőszámok

## Aktiváció

- első ajánlat létrehozásáig eltelt idő;
- első ajánlat elküldéséig eltelt idő;
- első napon elküldött ajánlatok aránya;
- onboarding félbehagyás.

## Használhatóság

- ajánlatkészítési idő;
- kézzel javított tételek száma;
- hiányos tétellel blokkolt küldések;
- visszalépések száma;
- diktálás sikeressége;
- fotóelemzés után elfogadott tételek aránya.

## Üzleti eredmény

- kiküldött ajánlatok;
- megnyitási arány;
- elfogadási arány;
- válaszidő;
- follow-up konverzió;
- ismételt havi használat;
- saját árjegyzéket használók megtartása.

## Minőség

- hibás árral kiküldött ajánlat;
- 0 Ft-os ismeretlen tétel;
- email kézbesítési hiba;
- sikertelen fotófeldolgozás;
- manuális ügyfélszolgálati esetek.

---

# 41. Fő differenciálás a versenytársaktól

A QQ ne több funkcióval akarjon nyerni.

A fő különbség:

> **A QQ-ban az ajánlat a felhasználó természetes munkamódjából indul, nem egy üres ügyviteli űrlapból.**

Versenytársi összevetés:

| Terület | Klasszikus ügyviteli rendszer | QuickQuote |
|---|---|---|
| Kezdés | ügyfél, dokumentum, mezők | mondd el a munkát |
| Bevitel | űrlap | hang, szöveg, fotó |
| Árazás | kézi árlista | saját ár + referencia |
| Ellenőrzés | táblázat | kártyák és figyelmeztetések |
| Mobil | desktop logika lekicsinyítve | mobil-first |
| Follow-up | külön modul | ajánlatfolyamat része |
| Ügyféloldal | dokumentumnézet | döntési felület |
| AI | külön funkció | háttérben segítő eszköz |

---

# 42. Végső UI-ajánlás

A QuickQuote felülete akkor lesz igazán sikeres, ha:

1. az első ajánlat gyorsabban elkészül, mint Wordben;
2. a szakiparosnak nem kell megtanulnia egy ügyviteli rendszert;
3. az AI nem veszi át a döntést, csak rendszerezi az információt;
4. minden bizonytalan tétel egyértelműen látszik;
5. a saját árak automatikusan beépülnek;
6. a küldés valóban működik;
7. az ügyfél telefonon könnyen megérti és elfogadja;
8. a follow-up teendőként jelenik meg;
9. a mobil UI a főtermék, nem másodlagos nézet;
10. a rendszer a használat közben tanul, nem hosszú beállítással indul.

A javasolt végső pozicionálás:

> **A leggyorsabb magyar mobilos ajánlatkészítő egyéni szakiparosoknak: jegyzetből vagy diktálásból profi ajánlat, saját árakkal, elküldéssel, követéssel és online elfogadással.**

---

# 43. Rövid döntési lista

## Azonnal megtartandó

- hangalapú bevitel;
- szöveg strukturálása;
- saját ár elsőbbsége;
- fotóból tételjavaslat;
- online elfogadás;
- automatikus follow-up;
- ügyféloldali ajánlat;
- mobilos használat.

## Azonnal átalakítandó

- Ajánlat / Áttekintés kettős menü;
- technikai konfidenciajelölések;
- 0 Ft-os ismeretlen anyagár;
- iOS voice teljes tiltása;
- fotóból közvetlen ár ígérete;
- eIDAS-megfelelő megfogalmazás;
- megnyitásszám-alapú follow-up stop;
- analitika hangsúlya a kezdőlapon.

## Azonnal hozzáadandó

- teendőközpontú kezdőlap;
- kártyás tételszerkesztés;
- dinamikus pontosító kérdések;
- saját ár mentése használat közben;
- hiányos tétel blokkolása;
- éles email;
- ügyféloldali módosításkérés;
- szakmaspecifikus gyorssablonok;
- fotó adatvédelmi review;
- ajánlatverziók;
- számlázóintegráció.

---

# 44. Összegzés

A QuickQuote UI-jának nem az a feladata, hogy minden üzleti funkciót egy helyre zsúfoljon.

A feladata:

> **A szakiparos fejében lévő kusza munkaleírást a lehető legkevesebb lépéssel professzionális, ellenőrzött és elküldhető ajánlattá alakítani.**

A jó QQ-élmény:

- nem indul hosszú űrlappal;
- nem kéri be előre az összes cégadatot;
- nem mutat technikai AI-nyelvet;
- nem használ mobilon táblázatot;
- nem enged csendben hibás ajánlatot küldeni;
- nem rejti el a következő lépést;
- nem akar ERP lenni.

A végső felhasználói élmény:

> **Elmondom. Ellenőrzöm. Elküldöm. Követem.**
