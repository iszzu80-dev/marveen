# Zsibongó – teljes UI/UX koncepció és termékspecifikáció

**Dátum:** 2026-07-15  
**Cél:** a Zsibongó felhasználói felületének újraszervezése a magyar és nemzetközi versenytársak, a tényleges felhasználói perszónák és a legfontosabb napi munkafolyamatok alapján.  
**Fókusz:** a lehető legegyszerűbb ügyfélélmény, minimális kognitív terhelés, gyors napi használat, szerepkör-specifikus nézetek, auditálható működés és mobil-first gondozói/szülői élmény.

---

# 1. Vezetői összefoglaló

A Zsibongó jelenlegi termékkoncepciója funkcionálisan széles, de a UI-t nem érdemes a meglévő 19+ funkcióterület közvetlen leképezéseként felépíteni.

A felhasználók nem „modulokat” akarnak használni, hanem gyorsan választ szeretnének kapni négy kérdésre:

1. **Mi történik ma?**
2. **Mi igényel beavatkozást?**
3. **Mit kell most elvégezni vagy jelenteni?**
4. **Kivel kell kommunikálni?**

A Zsibongó célállapoti UX-pozíciója:

> **Reggel megnyitod, és azonnal látod, hogy rendben működik-e a bölcsőde, kinek mi a feladata, és hol kell közbelépned.**

A legfontosabb UI-döntés ezért:

> **A funkcióalapú navigációt szerepkör-, nap-, objektum- és teendőalapú működésre kell cserélni.**

A terméknek nem egyetlen közös, mindenki számára azonos felületet kell adnia. Négy eltérő munkamód szükséges:

- **fenntartó / telephelyvezető:** desktop-first működési cockpit;
- **gondozó / kisgyermeknevelő / helyettes:** mobile-first napi munkafelület;
- **szülő:** egyszerű mobilalkalmazás-szerű élmény;
- **e-képviselő:** szűk, megfelelési és jelentési portál.

---

# 2. Tervezési alapelvek

## 2.1 A kezdőlap ne dashboard, hanem munkafelület legyen

A kezdőlap ne általános grafikonokat és összesítéseket mutasson, hanem:

- mai feladatokat;
- lejárt vagy közelgő határidőket;
- jóváhagyásokat;
- kockázatokat;
- eltéréseket;
- sürgős üzeneteket;
- közvetlen következő lépéseket.

A „minden rendben” állapot legyen rövid és nyugodt. A rendszer ne töltsön ki teljes képernyőket zöld kártyákkal.

## 2.2 Minden szerepkör csak a saját feladatát lássa

A cél nem az, hogy minden felhasználó minden funkcióhoz hozzáférjen.

A jó UX azt jelenti, hogy:

- a gondozó nem lát pénzügyi és fenntartói funkciókat;
- a szülő nem lát intézményi adminisztrációt;
- az e-képviselő nem lát gyermek-PII-t vagy egészségügyi narratívát;
- a helyettes csak az aktuális megbízásához szükséges információt látja;
- a fenntartó aggregált állapotot és kivételeket lát, nem minden napi apró bejegyzést.

## 2.3 A rendszer központi eleme a teendő

Minden fontos esemény ugyanazt az alapmodellt használja:

- mi történt;
- miért fontos;
- kit érint;
- ki a felelős;
- mi a határidő;
- mi a következő lépés;
- milyen bizonyítékkal zárható le.

A teendő nem értesítés és nem üzenet. Önálló, lezárható munkadarab.

## 2.4 A rendszer központi objektumai

A felületet az alábbi objektumok köré kell szervezni:

- szervezet;
- telephely;
- szolgáltatási egység;
- csoport;
- gyermek;
- szülő / kapcsolattartó;
- dolgozó;
- helyettes;
- megbízás;
- jelenléti nap;
- jelentési időszak;
- dokumentum;
- teendő;
- üzenetszál;
- pénzügyi tétel;
- megfelelési esemény.

A felhasználó mindig objektumból induljon, ne modulból.

## 2.5 Egy adatot egyszer kelljen rögzíteni

A napi működés során rögzített adatok később automatikusan legyenek újrahasznosíthatók:

- csoportnaplóban;
- gyermek-idővonalon;
- szülői tájékoztatásban;
- havi jelentésben;
- KENYSZI-előkészítésben;
- megfelelési ellenőrzésben;
- dokumentációban.

Ez az egyik legnagyobb valós ügyfélérték.

## 2.6 A veszélyes vagy jogilag érzékeny műveletek legyenek külön kezelve

Ilyenek:

- gyógyszeradás;
- elviteli jogosultság;
- helyettesi megbízás;
- normatíva-eltérés;
- KENYSZI-eltérés;
- dokumentum-visszavonás;
- egészségügyi adat módosítása;
- jogosultság megadása;
- vészhelyzeti kilépés.

Ezeknél szükséges:

- egyértelmű kontextus;
- megerősítés;
- auditnapló;
- visszavonási vagy korrekciós út;
- felelős személy;
- verziókövetés.

---

# 3. Versenytársi tanulságok

## 3.1 Famly

A Famly erősségei:

- szerepkör-specifikus felületek;
- intézményi és csoportszintű kezdőképernyők;
- gyermekközpontú működés;
- a napi adminisztráció és kommunikáció összekötése;
- közvetlen műveletek gyermekprofilból;
- egyszerű, vizuálisan nyugodt felépítés.

### Átveendő elemek

- egyetlen szerepkör-specifikus kezdőlap;
- csoport- és gyermekprofil mint központi navigációs elem;
- napi események idővonalon;
- közvetlen gyorsműveletek;
- kevés felső szintű menüpont;
- objektumközpontú munkavégzés.

## 3.2 Brightwheel

A Brightwheel erősségei:

- gyors szerepkör-alapú onboarding;
- admin, dolgozó és szülő élesen eltérő használati útja;
- jelenlét, kommunikáció és napi műveletek egyszerű kezelése;
- mobil-first dolgozói és szülői UX;
- gyors indulás.

### Átveendő elemek

- szerepkör automatikus feloldása meghívás alapján;
- külön vezetői, gondozói és szülői onboarding;
- azonnali, egyértelmű első feladat;
- minimális menüszerkezet;
- használat közbeni kontextuális segítség.

## 3.3 Kinderpedia

A Kinderpedia erősségei:

- attendance, kommunikáció, pénzügy és dokumentáció egy platformon;
- szülői kommunikáció központi szerepe;
- értesítési rendszer;
- több telephelyes működés;
- napi események és adminisztráció összekötése.

### Átveendő elemek

- egységes értesítési központ;
- kontextushoz kötött beszélgetések;
- olvasási státusz;
- szülői teendők külön kezelése;
- több telephelyes fejléc és kontextusváltás.

## 3.4 MINIPED

A MINIPED fő erőssége:

- szakmai dokumentáció;
- fejlődési napló;
- csoportnapló;
- törzslap;
- családi füzet;
- módszertanhoz igazított dokumentáció;
- napi eseményekből előállítható szakmai anyagok.

### Átveendő elemek

- külön Dokumentáció munkatér;
- kitöltöttségi státusz;
- hiányzó kötelező elemek jelzése;
- gyermekenkénti dokumentációs idővonal;
- sablonok és ellenőrzött folyamatok;
- napi bejegyzésekből újrahasznosítható dokumentáció.

## 3.5 oviKRÉTA

Az oviKRÉTA erősségei:

- szerepkörök;
- gyermek-, csoport- és alkalmazotti törzsadat;
- hivatalos dokumentumok;
- riportok;
- intézményi működés strukturált kezelése.

### Átveendő elemek

- központi adattörzs;
- egyértelmű szerepkörök;
- dokumentumok objektumokhoz kapcsolása;
- hivatalos riportok és exportok.

### Nem átveendő elemek

- sok felső szintű modul;
- klasszikus adminisztrációs menülogika;
- túl sok táblázat;
- desktop-only működés;
- a felhasználóra hárított navigációs komplexitás.

---

# 4. Felhasználói perszónák

## 4.1 Fenntartó / tulajdonos

### Céljai

- lássa, hogy az összes egység szabályosan működik-e;
- azonosítsa a kockázatokat;
- lássa a kapacitást, személyzetet és pénzügyet;
- minimalizálja a támogatási és működési hibákat;
- több telephelyet tudjon összehasonlítani;
- csak kivételes esetekkel kelljen foglalkoznia.

### Fő kérdései

- Minden egység rendben működik?
- Hol van eltérés vagy kockázat?
- Hol hiányzik dolgozó?
- Hol van KENYSZI- vagy normatíva-probléma?
- Melyik telephelyen nő a hátralék?
- Mi igényel ma döntést?

### UI-igény

- desktop-first;
- aggregált nézet;
- telephelyek összehasonlítása;
- kivételalapú cockpit;
- jóváhagyási sor;
- exportok;
- auditálható státuszok.

## 4.2 Telephelyvezető

### Céljai

- a napi működés biztosítása;
- jelenlét és személyzeti lefedettség;
- határidők;
- szülői és dolgozói ügyek;
- helyettesítés;
- napi adminisztráció lezárása.

### Fő kérdései

- Ki van ma bent?
- Van-e kapacitási vagy személyzeti probléma?
- Van-e esedékes gyógyszer?
- Melyik adat vagy jóváhagyás hiányzik?
- Van-e sürgős szülői üzenet?
- Lezárható-e a mai nap?

### UI-igény

- desktop és tablet;
- napi teendőlista;
- csoportállapotok;
- gyors jóváhagyás;
- megfelelési központ;
- személyzeti és helyettesítési nézet.

## 4.3 Gondozó / kisgyermeknevelő

### Céljai

- minimális adminisztrációval rögzítse a napot;
- lássa a gyermekek fontos biztonsági adatait;
- gyorsan kezelje a jelenlétet;
- rögzítse az étkezést, eseményt, gyógyszert;
- üzenjen a szülőnek vagy vezetőnek;
- ne kelljen adminisztratív menükben keresnie.

### Fő kérdései

- Kik vannak ma bent?
- Van-e allergia vagy gyógyszer?
- Ki viheti el a gyermeket?
- Mi az aktuális feladatom?
- Mit kell még rögzítenem a nap lezárásához?

### UI-igény

- mobile-first;
- egyképernyős jelenlét;
- nagy érintési felületek;
- gyorsrögzítés;
- offline-tűrés;
- minimális szövegbevitel;
- gyermekbiztonsági figyelmeztetések.

## 4.4 Helyettes

### Céljai

- csak az aktuális megbízást lássa;
- gyorsan megértse a csoport és gyermekek fontos adatait;
- tudja, kihez fordulhat;
- biztonságosan be- és kiléphessen;
- ne kapjon túl széles intézményi hozzáférést.

### UI-igény

- megbízásspecifikus munkatér;
- időben korlátozott hozzáférés;
- fontos gyermekbiztonsági adatok;
- kapcsolattartó;
- vészhelyzeti megszakítás;
- világos státusz.

## 4.5 Szülő

### Céljai

- tudja, mi történt a gyermekével;
- gyorsan intézze a szükséges jóváhagyást;
- módosítsa az elviteli vagy egészségügyi adatokat;
- lássa az egyenleget;
- kommunikáljon az intézménnyel;
- ne kelljen intézményi rendszert megtanulnia.

### Fő kérdései

- Mi történt ma?
- Van teendőm?
- Van üzenetem?
- Van fizetnivalóm?
- Ki viheti el a gyermekemet?
- Érvényesek-e a hozzájárulások?

### UI-igény

- mobilalkalmazás-szerű;
- egyszerű nyelv;
- maximum 4–5 alsó navigációs pont;
- gyermekközpontú idővonal;
- külön teendőközpont;
- biztonságos jóváhagyások;
- olvasási státusz.

## 4.6 E-képviselő

### Céljai

- jelentési és normatíva-adatok ellenőrzése;
- intézmények állapotának áttekintése;
- exportok;
- hiányzó adatok jelzése.

### UI-igény

- szűk read-only vagy korlátozott admin;
- jelentések;
- normatíva;
- intézménylista;
- nincs gyermek-PII;
- nincs egészségügyi narratíva;
- nincs szülői kommunikáció;
- nincs gyermekenkénti pénzügy.

---

# 5. Javasolt teljes információs architektúra

## 5.1 Vezetői desktop főmenü

A napi használatban legfeljebb hat felső szintű menüpont legyen:

1. **Ma**
2. **Gyermekek**
3. **Működés**
4. **Megfelelés**
5. **Pénzügy**
6. **Kapcsolatok**

A menü alján:

- Beállítások
- Súgó
- Profil

## 5.2 Főmenük tartalma

### Ma

- mai teendők;
- figyelmeztetések;
- jóváhagyások;
- csoportállapot;
- személyzeti lefedettség;
- KENYSZI-eltérések;
- esedékes gyógyszerek;
- közelgő határidők;
- sürgős üzenetek;
- napzárási állapot.

### Gyermekek

- gyermeklista;
- keresés és szűrés;
- gyermekprofil;
- szülők / kapcsolattartók;
- allergia;
- gyógyszer;
- elvitel;
- hozzájárulások;
- dokumentumok;
- idővonal;
- fejlődési dokumentáció.

### Működés

- jelenlét;
- csoportok;
- napi állapot;
- dolgozói jelenlét;
- beosztás;
- helyettesítés;
- étlap;
- étkezés;
- készlet;
- telephelyi működés.

### Megfelelés

- KENYSZI-előkészítés;
- normatíva;
- megfelelési naptár;
- kötelező jelentések;
- kapacitás- és személyzeti megfelelés;
- dokumentumlejáratok;
- működési engedély;
- jegyzőkönyvek;
- betegség-visszatérés;
- gyógyszeradási szabályok;
- auditnapló.

### Pénzügy

- díjak;
- befizetések;
- hátralékok;
- étkezési jóváírás;
- havi zárás;
- riportok;
- bizonylatok;
- export;
- számlázási integráció státusza.

### Kapcsolatok

- szülői üzenetek;
- dolgozói üzenetek;
- jelentkezések;
- meghívások;
- jóváhagyásra váró adatlapok;
- értesítések;
- csoportos közlemények.

## 5.3 Beállítások

A napi navigációból ki kell venni:

- onboarding;
- adatimport;
- szervezet;
- telephelyek;
- csoportok alapbeállításai;
- jogosultságok;
- előfizetés;
- addonok;
- integrációk;
- szabálycsomag;
- értesítési beállítások;
- adatmegőrzés.

---

# 6. Globális navigáció és fejléc

## 6.1 Fejléc

Példa:

```text
Zsibongó   [Napraforgó Családi Bölcsőde ▼] [Ürömi egység ▼]
           2026. július 15.                  🔔 3   Súgó   Profil
```

A fejléc mindig mutassa:

- aktuális szervezet;
- aktuális telephely vagy szolgáltatási egység;
- dátum;
- értesítések;
- felhasználói profil;
- segítség.

## 6.2 Kontextusváltás

Több telephely esetén:

- a telephelyváltás jól látható legyen;
- a fejlécben maradjon az aktuális kontextus;
- a váltás után rövid megerősítés jelenjen meg;
- veszélyes műveletnél a telephely neve a megerősítő párbeszédben is jelenjen meg;
- a rendszer akadályozza meg, hogy a felhasználó észrevétlenül rossz egységhez rögzítsen adatot.

## 6.3 Globális keresés

A kereső találjon:

- gyermeket;
- szülőt;
- dolgozót;
- telephelyet;
- csoportot;
- dokumentumot;
- üzenetet;
- bizonylatot;
- teendőt.

A találatok szerepkör szerint szűrve jelenjenek meg.

---

# 7. Vezetői „Ma” képernyő

## 7.1 Képernyőszerkezet

```text
┌──────────────────────────────────────────────────────────────────┐
│ Jó reggelt, Anna!                         Ürömi egység · Ma      │
├──────────────────────────────────────────────────────────────────┤
│  7/8 gyermek bent   2 dolgozó bent   Kapacitás: RENDBEN         │
│  KENYSZI: 1 eltérés  Gyógyszer: 1 esedékes  Hátralék: 2 család  │
├───────────────────────────────────┬──────────────────────────────┤
│ MA ELVÉGZENDŐ                     │ KÖVETKEZŐ HATÁRIDŐK         │
│                                   │                              │
│ 🔴 KENYSZI-eltérés ellenőrzése    │ júl. 17. Havi zárás         │
│ 🟠 Helyettesítés jóváhagyása      │ júl. 31. Normatíva riport   │
│ 🟠 2 szülői adatlap jóváhagyása   │ aug. 05. Dokumentum lejár   │
│ ○ Étkezési napló lezárása         │                              │
├───────────────────────────────────┼──────────────────────────────┤
│ CSOPORTOK                         │ LEGUTÓBBI ÜZENETEK           │
│ Méhecske   5/5   Rendben          │ Kovács család · 8:32        │
│ Katica     2/3   1 hiányzó adat   │ „Nagymama viszi el…”        │
└───────────────────────────────────┴──────────────────────────────┘
```

## 7.2 Elsődleges blokkok

- napi működési állapot;
- teendők;
- határidők;
- csoportok;
- személyzeti lefedettség;
- sürgős üzenetek;
- napzárási státusz.

## 7.3 Kivételalapú logika

A kezdőlapon csak az jelenjen meg, ami:

- lejárt;
- ma esedékes;
- figyelmet igényel;
- jóváhagyásra vár;
- eltérést tartalmaz;
- működési kockázat;
- jogi vagy biztonsági kockázat.

## 7.4 Státuszok

Javasolt státuszkészlet:

- Rendben
- Figyelmet igényel
- Teendő
- Lejárt
- Kritikus
- Ellenőrzés alatt
- Jóváhagyásra vár
- Lezárva

A piros szín csak „Kritikus” állapotra legyen fenntartva.

---

# 8. Egységes teendőmodell

## 8.1 Teendőkártya

```text
KENYSZI-eltérés
Katica csoport · 2026. július 15.

A helyi jelenlétben 3, az előkészített jelentésben 2 gyermek szerepel.

Határidő: ma 16:00
Felelős: Kiss Anna

[Áttekintem] [Felelőst módosítok] [Később]
```

## 8.2 Kötelező mezők

- cím;
- típus;
- súlyosság;
- forrás;
- érintett objektum;
- leírás;
- felelős;
- határidő;
- következő lépés;
- státusz;
- lezárás ideje;
- lezáró személy;
- bizonyíték vagy megjegyzés.

## 8.3 Teendőtípusok

- adateltérés;
- jóváhagyás;
- határidő;
- dokumentumhiány;
- dokumentumlejárat;
- személyzeti probléma;
- kapacitási kockázat;
- egészségügyi teendő;
- pénzügyi teendő;
- szülői teendő;
- helyettesítési teendő;
- napzárási teendő.

## 8.4 Teendő és értesítés különbsége

**Értesítés:**

- információ;
- nem feltétlenül igényel akciót;
- olvasottra állítható.

**Teendő:**

- felelőse van;
- határideje van;
- állapota van;
- lezárható;
- auditálható.

---

# 9. Gondozói mobilfelület

## 9.1 Alsó navigáció

```text
[ Ma ]   [ Csoport ]   [ Üzenetek ]   [ Továbbiak ]
                       [+ rögzítés]
```

Legfeljebb négy fő pont és egy központi gyorsrögzítő gomb.

## 9.2 „Ma” képernyő

```text
Szerda, július 15.
Katica csoport                        7/8 gyermek

⚠ Kovács Emma – allergia
💊 Nagy Bence – gyógyszer 11:30
👤 Szabó Anna – ma nagymama viszi el

Jelenlét
✓ Emma      ✓ Bence      ✓ Áron
✓ Lili      ✓ Máté       – Dorka
✓ Nóra

[ Jelenlét lezárása ]

Gyors rögzítés
[ Étkezés ] [ Csoportnapló ] [ Gyógyszer ] [ Jegyzőkönyv ]
```

## 9.3 Egyképernyős jelenlét

Követelmények:

- minden gyermek egy képernyőn vagy minimális görgetéssel;
- alapértelmezett státusz gyorsan beállítható;
- tömeges jelölés;
- egyedi kivétel;
- érkezési és távozási idő;
- hiányzás oka;
- lezárás előtt összesítés;
- lezárás után korrekció auditnaplóval.

## 9.4 Gyorsrögzítés

A központi `+` gombból:

- étkezés;
- napi esemény;
- csoportnapló;
- gyógyszer;
- baleset / jegyzőkönyv;
- alvás;
- szülői üzenet;
- elviteli megjegyzés.

## 9.5 Gyermekbiztonsági jelzések

A gyermek neve mellett közvetlenül:

- allergia;
- gyógyszer;
- elviteli korlátozás;
- különleges hozzájárulás;
- egészségügyi megjegyzés;
- friss szülői módosítás.

A jelzés:

- ne csak szín legyen;
- legyen ikon és rövid címke;
- érintésre nyíljon részletes kártya;
- veszélyes adatot ne lehessen véletlenül elrejteni.

## 9.6 Offline és szinkron

A mobilfelületnek mutatnia kell:

- online;
- offline;
- mentés folyamatban;
- szinkronizálva;
- szinkronhiba.

Offline állapotban:

- jelenlét;
- napi esemény;
- étkezés;
- piszkozat

lokálisan menthető legyen.

Gyógyszeradás és magas kockázatú művelet offline kezelését külön biztonsági szabály szerint kell meghatározni.

---

# 10. Helyettesi munkatér

## 10.1 Alapelv

A helyettes ne kapja meg automatikusan a teljes gondozói felületet.

A hozzáférés:

- megbízáshoz kötött;
- időben korlátozott;
- csoporthoz kötött;
- visszavonható;
- auditált.

## 10.2 Képernyő

```text
Mai megbízás
Napraforgó Bölcsőde · 08:00–16:00
Katica csoport · 7 gyermek

[ Belépek a csoportba ]

Fontos tudnivalók
• 1 súlyos allergia
• 1 esedékes gyógyszer
• Elviteli változás: Szabó Anna

Kapcsolattartó
Kiss Anna telephelyvezető
[ Hívás ] [ Üzenet ]

[ Megbízás vészhelyzeti megszakítása ]
```

## 10.3 Helyettes onboarding

A megbízás elfogadása előtt:

- személyazonosság;
- képesítés;
- dokumentumok;
- egészségügyi nyilatkozat;
- feltételek;
- adatkezelés;
- megbízási idő;
- intézményi szabályok elfogadása.

## 10.4 Vészhelyzeti megszakítás

Külön, jól látható funkció.

Megnyomás után:

1. ok kiválasztása;
2. azonnali vezetői értesítés;
3. státuszváltozás;
4. hozzáférés kezelése;
5. naplózás;
6. további biztonsági lépések megjelenítése.

---

# 11. Szülői mobilfelület

## 11.1 Alsó navigáció

```text
[ Kezdőlap ] [ Gyermekem ] [ Üzenetek ] [ Pénzügy ] [ Továbbiak ]
```

## 11.2 Kezdőlap

```text
Szia, István!

Emma ma 08:12-kor érkezett.
Katica csoport

MA
✓ Jelen van
✓ Ebéd rögzítve
✓ Nincs új egészségügyi esemény

TEENDŐID
🟠 Új hozzájárulás jóváhagyása
🟠 Elviteli jogosultság megerősítése
○ Júliusi egyenleg: 12 500 Ft

LEGUTÓBBI ÜZENET
„Emma ma nagyon élvezte a közös játékot.”
                                  [Megnyitás]
```

## 11.3 Szülői fő kérdések

A kezdőlap válaszolja meg:

- jelen van-e a gyermek;
- mi történt ma;
- van-e új üzenet;
- van-e teendő;
- van-e fizetendő összeg;
- változott-e valamilyen jogosultság vagy hozzájárulás.

## 11.4 Gyermekprofil

Egyetlen, idővonalas oldal:

- mai állapot;
- étkezés;
- napi megosztott események;
- gyógyszer;
- allergia;
- elvitel;
- hozzájárulások;
- dokumentumok;
- fejlődési dokumentáció megosztható része;
- pénzügyi összefoglaló.

Ne legyen tíz felső szintű fül.

## 11.5 Szülői teendőközpont

A teendők külön felületen:

- hozzájárulás;
- adatellenőrzés;
- elviteli jogosultság;
- dokumentum feltöltése;
- fizetés;
- kérdőív;
- jelentkezési adat kiegészítése.

Példa:

```text
Teendő szükséges

Gyógyszeradási hozzájárulás
Gyermek: Kovács Emma
Beküldve: július 14.
Hatályos: július 16–20.
Kérte: Kiss Anna

[ Részletek és jóváhagyás ]
```

## 11.6 Jóváhagyási képernyő

Mindig mutassa:

- mit hagy jóvá;
- melyik gyermekhez;
- milyen időszakra;
- ki kezdeményezte;
- milyen adat alapján;
- mikor vonható vissza;
- milyen joghatással jár;
- jóváhagyás időpontja;
- jóváhagyás státusza.

## 11.7 Pénzügy

A szülő csak ezt lássa:

- aktuális egyenleg;
- esedékes tételek;
- befizetések;
- étkezési jóváírás;
- bizonylatok;
- fizetési lehetőség vagy instrukció;
- kérdés küldése.

---

# 12. E-képviselői felület

## 12.1 Menü

```text
[ Áttekintés ]
[ Jelentések ]
[ Normatíva ]
[ Intézmények ]
```

## 12.2 Kezdőlap

- beadandó jelentések;
- hiányzó adatok;
- eltérések;
- normatíva-egyeztetés;
- exportok;
- beadási státusz;
- intézményenkénti megfelelési állapot.

## 12.3 Adatkorlátozás

Ne lásson:

- gyermekprofilt;
- egészségügyi narratívát;
- szülői üzenetet;
- elviteli jogosultságot;
- gyermekenkénti egyenleget;
- napi gondozói bejegyzést;
- gyógyszer részleteit.

A backend és UI ugyanazt a jogosultsági szabályt használja.

---

# 13. Gyermekprofil mint központi felület

## 13.1 Fejléc

```text
Kovács Emma                     Katica csoport

Jelen van · 08:12
⚠ Dióallergia
Nagymama viszi el · igazolás szükséges
Aktív gyógyszerhozzájárulás

[ Üzenet ] [ Napi bejegyzés ] [ Dokumentum ] [ További műveletek ]
```

## 13.2 Idővonal

```text
Ma
11:30  Gyógyszer beadva – Kiss Anna
11:05  Ebéd elfogyasztva
08:12  Érkezés – édesapa

Tegnap
15:42  Elvitel – édesanya
13:10  Csoportnapló-bejegyzés
```

## 13.3 Profil szekciók

- alapadatok;
- kapcsolattartók;
- jelenlét;
- egészség és allergia;
- gyógyszer;
- elvitel;
- hozzájárulások;
- dokumentumok;
- napi idővonal;
- fejlődési dokumentáció;
- pénzügy;
- auditnapló.

## 13.4 Gyorsműveletek

- üzenet;
- jelenlét korrekció;
- esemény rögzítése;
- dokumentum feltöltése;
- elviteli adat módosítása;
- hozzájárulás kérése;
- gyógyszerfolyamat indítása;
- jegyzőkönyv indítása.

---

# 14. Csoportoldal

## 14.1 Fő tartalom

- aktuális gyermeklétszám;
- jelenlévők;
- dolgozók;
- kapacitási állapot;
- napi feladatok;
- esedékes gyógyszerek;
- allergiák;
- elviteli változások;
- csoportnapló;
- étkezési állapot;
- napzárás.

## 14.2 Csoportkártya

```text
Katica csoport
7/8 gyermek jelen
2 dolgozó jelen
Kapacitás: rendben

1 gyógyszer 11:30
1 elviteli változás
2 hiányzó napi adat

[ Csoport megnyitása ]
```

---

# 15. Megfelelési központ

## 15.1 Cél

A KENYSZI, normatíva, határidők, kapacitás, dokumentumok és egyéb megfelelési funkciók egy helyen jelenjenek meg.

## 15.2 Főképernyő

```text
Megfelelési állapot – 2026. július

RENDBEN
✓ Működési engedély
✓ Dolgozói jogosultságok
✓ Adatmegőrzési folyamat

FIGYELMET IGÉNYEL
! 1 KENYSZI-eltérés
! 1 dolgozói dokumentum 21 napon belül lejár
! Júliusi normatíva-egyeztetés nincs lezárva

KÖVETKEZŐ HATÁRIDŐ
Július 31. – havi jelentés
```

## 15.3 Követelmények

Minden eltérés mutassa:

- probléma;
- érintett időszak;
- érintett telephely;
- érintett objektum;
- szabályforrás;
- szabályverzió;
- felelős;
- határidő;
- következő lépés;
- lezárási feltétel.

## 15.4 Megfelelési naptár

Nézetek:

- lista;
- havi naptár;
- telephely;
- felelős;
- státusz;
- jogszabályi típus.

Minden eseményhez:

- határidő;
- előzetes emlékeztetők;
- felelős;
- szükséges dokumentumok;
- beadás módja;
- beadás igazolása;
- lezárás;
- audit.

## 15.5 Kapacitás- és személyzeti megfelelés

Ne egyszerű arányszám legyen.

Bemenetek:

- ellátási forma;
- működési engedély szerinti férőhely;
- aktuális gyermeklétszám;
- jelen lévő gyermekek;
- SNI / korai fejlesztési státusz;
- szolgáltatást nyújtó személy;
- segítő;
- helyettes;
- dolgozói jogosultság;
- munkaidő;
- időszak.

Kimenet:

- Rendben;
- Figyelmet igényel;
- Nem megfelelő;
- Nem ellenőrizhető.

Mindig legyen magyarázat.

---

# 16. Kommunikáció és üzenetkezelés

## 16.1 Alapelv

Az üzenet mindig kontextushoz kapcsolódjon:

- gyermek;
- csoport;
- pénzügyi tétel;
- dokumentum;
- megbízás;
- teendő;
- intézményi közlemény.

## 16.2 Üzenettípusok

- egyéni beszélgetés;
- gyermekhez kapcsolt üzenet;
- csoportközlemény;
- intézményi közlemény;
- sürgős értesítés;
- rendszerértesítés;
- teendőhöz kapcsolt megjegyzés.

## 16.3 Funkciók

- olvasási státusz;
- címzettek;
- melléklet;
- válasz;
- lezárás;
- sürgősségi szint;
- értesítési csatorna;
- auditnapló;
- kommunikációs előzmény.

## 16.4 Amit kerülni kell

- üzenetbe rejtett jóváhagyás;
- üzenetbe rejtett pénzügyi teendő;
- üzenetbe rejtett gyógyszerutasítás;
- strukturálatlan, kereshetetlen beszélgetések;
- mindenki számára látható csoportos szálak.

---

# 17. Onboarding

## 17.1 Alapelv

Az onboarding egyszeri bevezetési folyamat, nem állandó napi menüpont.

## 17.2 Öt lépés

### 1. Intézmény

- ellátási forma;
- fenntartó típusa;
- szervezeti adatok;
- kapcsolattartók;
- működési adatok.

### 2. Egységek és csoportok

- telephely;
- szolgáltatási egység;
- csoport;
- férőhely;
- nyitvatartás;
- működési engedély.

### 3. Munkatársak

- dolgozók;
- szerepek;
- jogosultságok;
- képesítések;
- dokumentumok;
- helyettesek;
- meghívások.

### 4. Gyermekek és szülők

- import;
- kézi felvitel;
- adatellenőrzés;
- szülői meghívás;
- hozzájárulások;
- dokumentumok.

### 5. Indulási ellenőrzés

- hiányzó kötelező adatok;
- jogosultsági hibák;
- dokumentumhiány;
- compliance-státusz;
- teszt nap;
- indulás engedélyezése.

## 17.3 Készültségi mutató

```text
Beállítás készültsége: 78%
3 kötelező adat hiányzik
2 meghívás függőben
1 dokumentum ellenőrzésre vár
```

## 17.4 AI-import

A felhasználói megfogalmazás:

> „Töltsd fel a meglévő Excel-fájlt – megpróbáljuk előkészíteni az adatokat.”

Eredményállapotok:

- biztosan felismert;
- ellenőrzést igényel;
- nem importálható;
- kihagyva adatvédelmi okból.

A commit előtt mindig legyen emberi ellenőrzés.

---

# 18. Dokumentációs munkatér

## 18.1 Cél

A kötelező és szakmai dokumentáció ne egyszerű fájllista legyen.

## 18.2 Fő nézetek

- gyermek dokumentáció;
- csoport dokumentáció;
- intézményi dokumentáció;
- sablonok;
- hiányzó dokumentumok;
- lejáró dokumentumok;
- jóváhagyásra váró dokumentumok.

## 18.3 Dokumentumállapotok

- piszkozat;
- kitöltés alatt;
- ellenőrzésre vár;
- jóváhagyva;
- aláírásra vár;
- hatályos;
- lejárt;
- visszavont;
- archivált.

## 18.4 Dokumentumkártya

```text
Fejlődési napló – Kovács Emma
Időszak: 2026. január–június

Kitöltöttség: 82%
2 kötelező mező hiányzik
Utolsó módosítás: július 13.
Felelős: Kiss Anna

[ Folytatás ] [ Előnézet ] [ Előzmények ]
```

## 18.5 Verziózás

Minden dokumentumnál:

- verzió;
- módosító;
- módosítás ideje;
- változás;
- jóváhagyó;
- hatály;
- visszavonás;
- audit.

---

# 19. Pénzügyi munkatér

## 19.1 Vezetői nézet

- aktuális havi bevétel;
- nyitott tételek;
- lejárt tételek;
- hátralékos családok;
- étkezési jóváírások;
- havi zárás;
- export;
- integráció státusza.

## 19.2 Szülői nézet

- aktuális egyenleg;
- esedékes tételek;
- befizetések;
- jóváírások;
- bizonylatok;
- fizetési mód;
- kérdés küldése.

## 19.3 Elnevezés

Amíg nincs teljes jogi számlázási integráció:

> **Díjak, befizetések és hátralékok**

ne pedig automatikusan „Számlázás”.

---

# 20. Értesítési rendszer

## 20.1 Értesítési szintek

- Információ
- Teendő
- Figyelmeztetés
- Kritikus

## 20.2 Csatornák

- alkalmazáson belüli;
- push;
- email;
- opcionális SMS kritikus esetben.

## 20.3 Felhasználói beállítások

A felhasználó beállíthatja:

- mely eseményről;
- mely csatornán;
- milyen gyakran;
- azonnal vagy összesítve.

A jogi vagy biztonsági minimumértesítések nem kapcsolhatók ki teljesen.

## 20.4 Értesítési központ

Csoportosítás:

- teendők;
- üzenetek;
- rendszer;
- dokumentum;
- pénzügy;
- megfelelés.

---

# 21. Vizuális rendszer

## 21.1 Általános irány

A Zsibongó legyen:

- barátságos;
- bizalomépítő;
- nyugodt;
- professzionális;
- emberközeli;
- nem gyerekjáték-szerű;
- nem klasszikus állami adminfelület.

## 21.2 Színek

Javasolt funkcionális paletta:

- mély türkiz vagy zöld: fő akció;
- törtfehér: háttér;
- meleg szürke: semleges felületek;
- borostyán: figyelmeztetés;
- piros: kritikus veszély;
- zöld: rendben;
- kék: információ.

A státusz soha ne csak színnel legyen jelölve.

## 21.3 Tipográfia

- minimum 16 px alapbetű;
- jól olvasható sans-serif;
- erős címhierarchia;
- rövid címkék;
- kevés nagybetűs szöveg;
- adminisztratív zsargon kerülése.

## 21.4 Kártyák

- visszafogott lekerekítés;
- minimális árnyék;
- világos hierarchia;
- egy kártya = egy feladat vagy állapot;
- ne legyen túl sok dekoráció.

## 21.5 Ikonok

- egységes ikonrendszer;
- ikon mellett szöveg;
- veszélyes művelethez egyértelmű ikon;
- emoji ne legyen egyetlen jelentéshordozó.

## 21.6 Érintési felületek

- minimum 44×44 px;
- gondozói mobilon nagyobb elsődleges gombok;
- fontos műveletek alsó hüvelykujjzónában;
- veszélyes művelet elkülönítve.

---

# 22. Formok és adatbevitel

## 22.1 Alapelv

- csak a szükséges mezőket mutassa;
- hosszú űrlap több lépésre bontva;
- meglévő adat újrahasznosítása;
- alapértelmezések;
- automatikus kitöltés;
- valós idejű validáció;
- piszkozatmentés.

## 22.2 Hibaüzenetek

Ne:

> „Validation error.”

Hanem:

> „A gyermek születési dátuma nem lehet a mai napnál későbbi.”

A hiba:

- a mező mellett jelenjen meg;
- mondja meg, mit kell javítani;
- ne törölje a már bevitt adatot.

## 22.3 Megerősítések

Megerősítés csak:

- törlés;
- visszavonás;
- gyógyszeradás;
- jogosultság;
- pénzügyi lezárás;
- jelentés lezárása;
- vészhelyzeti művelet;
- telephelyváltás közben végzett veszélyes akció.

---

# 23. Hozzáférhetőség

## 23.1 Minimum követelmények

- WCAG 2.1 AA cél;
- megfelelő kontraszt;
- billentyűzetes navigáció;
- képernyőolvasó címkék;
- fókuszjelzés;
- ikonok szöveges neve;
- nem csak színalapú státusz;
- nagyítható szöveg;
- mobilon megfelelő érintési méret.

## 23.2 Egyszerű nyelv

A felület kerülje:

- technikai rövidítéseket;
- jogi nyelvet magyarázat nélkül;
- fejlesztői elnevezéseket;
- angol modulneveket.

---

# 24. Napzárási folyamat

## 24.1 Cél

A telephelyvezető és gondozó egyértelműen lássa, lezárható-e a nap.

## 24.2 Napzárási checklist

- jelenlét lezárva;
- távozások rögzítve;
- étkezés lezárva;
- gyógyszerek rögzítve;
- jegyzőkönyvek lezárva;
- hiányzó napi adatok;
- szülői sürgős üzenetek;
- KENYSZI-előkészítési eltérés;
- dolgozói jelenlét.

## 24.3 Képernyő

```text
Mai nap lezárása

✓ Jelenlét teljes
✓ Távozás teljes
✓ Étkezés teljes
! 1 gyógyszerbejegyzés ellenőrzésre vár
! 1 gyermek távozási ideje hiányzik

[ Hiányzó adatok megnyitása ]
[ Nap lezárása később ]
```

---

# 25. Hálózati / több telephelyes vezetői nézet

## 25.1 Fő cél

A fenntartó ne telephelyenként kattintgasson végig mindent.

## 25.2 Telephelylista

```text
Telephely             Állapot       Gyermek   Dolgozó   Teendő
Üröm                   Rendben       7/8       2/2       0
Budakalász             Figyelem      8/8       1/2       2
Szentendre             Rendben       6/8       2/2       1
```

## 25.3 Összehasonlítás

- kapacitáskihasználtság;
- hiányzások;
- személyzeti lefedettség;
- KENYSZI-eltérések;
- normatíva;
- hátralék;
- nyitott teendők;
- dokumentumhiány;
- helyettesítési igény.

## 25.4 Drill-down

Szervezet → telephely → csoport → gyermek / dolgozó / teendő.

---

# 26. Keresés és szűrés

## 26.1 Gyermeklista

Szűrők:

- csoport;
- jelenlét;
- allergia;
- aktív gyógyszer;
- hiányzó dokumentum;
- elviteli változás;
- szülői teendő;
- pénzügyi hátralék.

## 26.2 Teendők

Szűrők:

- felelős;
- határidő;
- státusz;
- súlyosság;
- telephely;
- csoport;
- típus.

## 26.3 Dokumentumok

Szűrők:

- típus;
- gyermek;
- dolgozó;
- státusz;
- lejárat;
- jóváhagyás;
- telephely.

---

# 27. Súgó és támogatás

## 27.1 Kontextuális segítség

Minden fontos képernyőn:

- rövid magyarázat;
- „Miért fontos?”;
- „Mit kell tennem?”;
- releváns súgócikk;
- kapcsolat az ügyfélszolgálattal.

## 27.2 Bevezetési támogatás

- onboarding checklist;
- videós segítség;
- demóadat;
- minta intézmény;
- próbanap;
- indulási ellenőrzés;
- adatimport támogatás.

## 27.3 Ne legyen

- külön súgó nélkül maradó jogi státusz;
- technikai hibaüzenet;
- magyarázat nélküli szabályriasztás;
- elérhetetlen ügyféltámogatás.

---

# 28. Analytics és termékhasználati mérés

## 28.1 Mérendő UX-mutatók

- első sikeres belépésig eltelt idő;
- onboarding befejezési arány;
- első jelenlét lezárásig eltelt idő;
- napi aktív gondozók;
- szülői meghívás elfogadása;
- teendők átlagos lezárási ideje;
- hibás KENYSZI-adatok száma;
- napzárás sikeressége;
- helyettesi megbízás elfogadási arány;
- üzenetek olvasási aránya;
- támogatási igény képernyőnként.

## 28.2 Minőségi kutatás

- 5–8 családi bölcsőde vezető;
- 5 gondozó;
- 5 szülő;
- 2–3 több telephelyes fenntartó;
- 2 e-képviselő;
- legalább 2 helyettes.

Tesztfeladatok:

- mai működési probléma azonosítása;
- jelenlét lezárása;
- gyógyszer rögzítése;
- szülői hozzájárulás;
- helyettes keresése;
- KENYSZI-eltérés javítása;
- dokumentum feltöltése;
- havi jelentés előkészítése.

---

# 29. UI-komponensrendszer

## 29.1 Alapkomponensek

- AppShell;
- ContextSwitcher;
- PageHeader;
- StatusBadge;
- TaskCard;
- AlertBanner;
- ChildCard;
- GroupCard;
- StaffCard;
- Timeline;
- ActivityItem;
- ApprovalCard;
- DeadlineCard;
- DocumentCard;
- MessageThread;
- EmptyState;
- LoadingState;
- SyncStatus;
- AuditTrail;
- ConfirmationModal;
- BottomNavigation;
- QuickActionButton.

## 29.2 Állapotkomponensek

Minden komponens támogassa:

- loading;
- empty;
- error;
- offline;
- permission denied;
- read-only;
- archived;
- partial data;
- stale data.

---

# 30. Mobil és desktop felelősségi határok

## Mobil

Elsődleges:

- jelenlét;
- gyorsrögzítés;
- gyermekbiztonsági adatok;
- üzenetek;
- szülői teendők;
- fizetési státusz;
- helyettesi megbízás;
- értesítések.

## Desktop

Elsődleges:

- riportok;
- több telephely;
- megfelelés;
- normatíva;
- dokumentáció;
- beállítás;
- import;
- pénzügyi zárás;
- jogosultság;
- audit.

## Tablet

Elsődleges:

- telephelyvezető;
- csoportáttekintés;
- jelenlét;
- jóváhagyás;
- napzárás.

---

# 31. Üres állapotok

A jó üres állapot megmondja:

- mi ez;
- miért üres;
- mit lehet tenni;
- mi a következő lépés.

Példa:

```text
Még nincs helyettes a hálózatodban.

Hívj meg egy meglévő helyettest, vagy keress a városi hálózatban.

[ Helyettes meghívása ] [ Keresés ]
```

Ne csak:

> „Nincs adat.”

---

# 32. Hibakezelés

## 32.1 Felhasználói hiba

- közérthető;
- mezőhöz kötött;
- javítható;
- adatvesztés nélkül.

## 32.2 Rendszerhiba

- rövid magyarázat;
- újrapróbálás;
- hibakód;
- támogatási link;
- piszkozat megőrzése.

## 32.3 Szinkronhiba

```text
A bejegyzést elmentettük ezen az eszközön, de még nem szinkronizáltuk.

[ Újrapróbálás ]
```

---

# 33. Biztonság és adatvédelem a UI-ban

## 33.1 Adatminimalizálás

A felhasználó csak azt lássa, ami a feladatához kell.

## 33.2 Érzékeny adatok

- egészségügyi adat;
- gyógyszer;
- elviteli jogosultság;
- személyazonosító adat;
- pénzügyi adat;
- helyettes dokumentum.

Ezeknél:

- részletes jogosultság;
- hozzáférési napló;
- maszkolás ahol indokolt;
- exportkor figyelmeztetés;
- képernyőn egyértelmű adatminősítés.

## 33.3 Auditálhatóság

A felhasználó lássa:

- ki módosította;
- mikor;
- mit módosított;
- előző érték;
- jóváhagyás;
- visszavonás.

---

# 34. Javasolt rollout

## Fázis 1 – navigáció és napi cockpit

- új AppShell;
- szerepkör-specifikus kezdőlap;
- telephely-kontextus;
- teendőmodell;
- csökkentett menü;
- egyképernyős jelenlét;
- gyermekprofil v1.

## Fázis 2 – napi workflow-k

- gondozói gyorsrögzítés;
- szülői teendőközpont;
- üzenetkezelés;
- napzárás;
- helyettesi munkatér;
- megfelelési központ.

## Fázis 3 – dokumentáció és pénzügy

- dokumentációs munkatér;
- verziózás;
- fejlődési napló;
- családi füzet;
- pénzügyi munkatér;
- exportok.

## Fázis 4 – hálózat és optimalizáció

- több telephelyes cockpit;
- összehasonlítás;
- fejlett értesítés;
- offline;
- push;
- analitika;
- testreszabás.

---

# 35. Prioritások

## P0 – azonnal

1. A felső szintű menüpontok csökkentése.
2. „Ma” kezdőlap minden szerepkörnek.
3. Telephely- és csoportkontextus.
4. Egységes teendőmodell.
5. Gyermekprofil és idővonal.
6. Egyképernyős jelenlét.
7. A helyettesi hozzáférés megbízáshoz kötése.
8. E-képviselői felület leszűkítése.
9. Veszélyes műveletek megerősítése és auditja.
10. Onboarding kivétele a napi menüből.

## P1 – következő

1. Megfelelési központ.
2. Compliance-naptár.
3. Napzárás.
4. Szülői teendőközpont.
5. Kontextuális üzenetkezelés.
6. Admin dokumentumkezelés.
7. Mobil gondozói gyorsrögzítés.
8. Hálózati telephelylista.

## P2 – később

1. Push értesítés.
2. Offline működés.
3. Fejlett analitika.
4. Testreszabható cockpit.
5. Automatizált heti összefoglaló.
6. Dokumentációs sablonmotor.
7. Hálózati benchmarkok.

---

# 36. Elfogadási kritériumok

## 36.1 Vezetői kezdőlap

- 10 másodpercen belül látható a legfontosabb probléma;
- maximum 5 elsődleges teendő jelenik meg;
- minden teendő közvetlenül megoldási képernyőre vezet;
- telephely-kontextus mindig látható;
- kritikus állapot nem rejtőzik görgetés alá.

## 36.2 Gondozói jelenlét

- maximum 2 érintés gyermekenként;
- tömeges státusz állítható;
- lezárás előtt hiányzó adat jelzése;
- offline piszkozat;
- mentés egyértelmű visszajelzéssel.

## 36.3 Szülői teendő

- a szülő 3 érintésen belül eljut a jóváhagyáshoz;
- minden releváns kontextus látható;
- jóváhagyás naplózott;
- visszavonási szabály látható;
- nincs intézményi szakzsargon.

## 36.4 Helyettes

- csak aktuális megbízás látható;
- hozzáférés automatikusan lejár;
- fontos gyermekbiztonsági adatok belépés előtt láthatók;
- vészhelyzeti megszakítás egyértelmű;
- vezető azonnal értesül.

## 36.5 Megfelelés

- minden eltérés magyarázott;
- szabályverzió látható;
- felelős és határidő rendelhető;
- lezárás auditált;
- exportálható bizonyíték.

---

# 37. Javasolt fő értékajánlat a UI-ban

## Vezetőnek

> **Egy képernyőn látod, hogy rendben működik-e a bölcsőde, és hol kell közbelépned.**

## Gondozónak

> **A napi adminisztráció néhány érintéssel elvégezhető, a fontos gyermekbiztonsági információk mindig kéznél vannak.**

## Szülőnek

> **Mindig tudod, mi történt a gyermekeddel, és mit kell jóváhagynod vagy elintézned.**

## Fenntartói hálózatnak

> **Minden telephely állapota összehasonlítható, a kockázatok és eltérések azonnal láthatók.**

## E-képviselőnek

> **A jelentések és normatíva-adatok egy helyen, a szükséges részletekkel, gyermek-PII nélkül.**

---

# 38. Végső ajánlás

A Zsibongó UI-ját nem érdemes egyszerűen „szebbé tenni”. A meglévő funkciók navigációs és munkafolyamat-logikáját kell újraszervezni.

A célállapot:

- kevés menüpont;
- szerepkör-specifikus felület;
- egyetlen „Ma” kezdőlap;
- egységes teendők;
- gyermek- és csoportközpontú működés;
- mobile-first gondozói és szülői élmény;
- kivételalapú vezetői cockpit;
- külön megfelelési központ;
- auditálható, biztonságos kritikus folyamatok.

A termék legfontosabb UX-ígérete:

> **Nem kell keresned, mit kell csinálnod. A Zsibongó megmutatja.**

Ez a megközelítés egyszerűbbé, gyorsabbá és versenyképesebbé teszi a rendszert, miközben a jelenlegi funkciók jelentős része változatlan backenddel, elsősorban új információs architektúrával és új workflow-szervezéssel újrahasznosítható.
