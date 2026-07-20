# Zsibongo – egyértelmű launch-módosítási javaslatok

**Dátum:** 2026-07-17  
**Cél:** A Zsibongo kontrollált és hiteles piacra viteléhez szükséges termék-, compliance-, UX-, technikai és go-to-market módosítások összefoglalása.

---

## Vezetői álláspont

A Zsibongo esetében **nem általános bölcsődei adminisztrációs rendszerként indulnék el**, hanem kifejezetten magyar családi bölcsődék napi működési és megfelelési asszisztenseként.

A jelenlegi termékben már elérhető:

- jelenlét- és étkezésnyilvántartás;
- normatíva-számítás;
- KENYSZI-export;
- szülői értesítés;
- allergia-alert;
- a helyettes-hálózat alapjai.

A roadmapben szerepel az Excel-import, a KENYSZI kitöltési segédlet, a MÁK-folyamat, a gyors onboarding, a többtelephelyes dashboard és a szülői PWA.

A launch előtt a terméket ebből:

> „Családi bölcsőde adminisztráció KENYSZI-exporttal”

erre módosítanám:

> **„A napi jelenléttől a KENYSZI-adatszolgáltatásig és a normatíva ellenőrzéséig végigvezető, hibákat megelőző működési rendszer családi bölcsődéknek.”**

A fő érték nem az adat tárolása, hanem az, hogy a fenntartó minden nap biztosan tudja:

1. teljesek-e a napi adatok;
2. jogszerű-e a gyermek–dolgozó–kapacitás helyzet;
3. elkészíthető-e a KENYSZI-jelentés;
4. van-e finanszírozási eltérés vagy kockázat;
5. ki és mikor módosított egy adatot.

---

# 1. A launch célpiacának szűkítése

## Első launch-célcsoport

Első körben kizárólag:

- **családi bölcsődék**;
- magán-, nonprofit vagy egyéb nem állami fenntartók;
- 1–3 telephellyel;
- telephelyenként egy vagy néhány csoporttal;
- aktív KENYSZI-adatszolgáltatással;
- napi adminisztrációt jelenleg papíron, Excelben vagy több külön rendszerben végző szolgáltatók.

## Nem javasolt launchkor

Ne célozzuk ugyanazzal a termékkel és kommunikációval egyszerre:

- a hagyományos bölcsődéket;
- a mini bölcsődéket;
- a munkahelyi bölcsődéket;
- az óvodákat;
- a teljes gyermekintézményi piacot.

Ezeknél eltérhet:

- a létszám- és személyzeti szabály;
- a dokumentáció;
- a fenntartói szervezet;
- a finanszírozás;
- a napi munkafolyamat;
- a felhasználói szerepkörök.

A launch landingje egyértelműen mondja ki:

> **„Kifejezetten magyar családi bölcsődéknek.”**

---

# 2. A családi bölcsődei kapacitásszabályok pontosítása

Ez a Zsibongo egyik legfontosabb domainfunkciója, ezért nem egyszerű „létszámkijelzőként”, hanem verziózott megfelelési motorként kell működnie.

## Kötelező launch-módosítás

A kapacitásmotor minden nap vegye figyelembe:

- az engedélyezett férőhelyszámot;
- a ténylegesen jelen lévő gyermekeket;
- a saját gyermeket, ahol azt a szabály szerint be kell számítani;
- a szolgáltatást nyújtó személy jelenlétét;
- a segítő személy jelenlétét és foglalkoztatási státuszát;
- az SNI vagy korai fejlesztésre jogosult gyermekek számát;
- az adott telephely és csoport szolgáltatói nyilvántartásban szereplő adatait;
- az esetleges helyettesítés jogszerűségét.

## UI-állapotok

### Zöld

> **Kapacitás rendben – 5/5 gyermek**

### Sárga

> **A mai 7 gyermekhez segítő személy szükséges. A segítő jelenléte még nincs igazolva.**

### Piros

> **A jelenlegi létszám meghaladja a mai személyzeti feltételek mellett engedélyezett kapacitást.**

### Szürke/blokkolt

> **Az SNI-státusz vagy az engedélyezett férőhelyszám nincs teljesen beállítva. A megfelelési eredmény nem állapítható meg.**

## Fontos működési szabály

A Zsibongo ne módosítsa automatikusan a jelenléti adatot azért, hogy a kapacitás „zöld” legyen. Jelezze az eltérést, de a valós adatot tartsa meg.

---

# 3. A KENYSZI-ígéret pontos megfogalmazása

A Zsibongo launchkor ne ígérje ezt:

> „Automatikusan beküldjük a KENYSZI-jelentést.”

Amíg nincs dokumentált, hivatalosan engedélyezett integráció és végpont, a helyes ígéret:

> **„Előkészítjük, ellenőrizzük és lépésről lépésre végigvezetjük a KENYSZI napi adatszolgáltatáson.”**

## Kötelező launch-funkció

A napi záráskor a rendszer készítsen **KENYSZI-készültségi ellenőrzést**:

- minden gyermek szerepel-e;
- a szolgáltatási jogviszony aktív-e;
- a jelenlét rögzített-e;
- van-e kapacitási ellentmondás;
- van-e ismeretlen TAJ- vagy azonosítási állapot;
- történt-e utólagos módosítás;
- szükséges-e önellenőrzés;
- ki jogosult a jelentés megtételére;
- mikor jár le a határidő.

## KENYSZI workflow

1. Gondozó rögzíti a napi jelenlétet.
2. Vezető lezárja a napot.
3. Zsibongo lefuttatja az ellenőrzéseket.
4. Megjelenik a KENYSZI-be beírandó vagy ellenőrizendő lista.
5. Az e-képviselő vagy adatszolgáltató belép a hivatalos rendszerbe.
6. A Zsibongo lépésről lépésre megmutatja a szükséges műveleteket.
7. A felhasználó rögzíti, hogy a jelentést beadta.
8. A rendszer eltárolja a beadási időt, a felelőst és lehetőség szerint a hivatalos visszaigazolást.

## Biztonsági szabály

A Zsibongo ne tárolja:

- az Ügyfélkapu+/DÁP belépési adatokat;
- a KENYSZI-jelszót;
- más személy e-képviselői hitelesítő adatait.

A hivatalos rendszerbe a felhasználó közvetlenül jelentkezzen be.

---

# 4. A „KENYSZI-export” elnevezés módosítása

A „KENYSZI-export” azt sugallhatja, hogy van hivatalos importfájl vagy közvetlen integráció.

## Javasolt elnevezések

Amennyiben nincs hivatalos gépi import:

- **KENYSZI napi előkészítő**
- **KENYSZI-készültség**
- **KENYSZI kitöltési segédlet**
- **Napi adatszolgáltatási ellenőrző lista**

Csak akkor maradjon „export”, ha:

- pontosan ismert a fogadó formátum;
- az hivatalosan támogatott;
- verziókövetett;
- a célrendszer ténylegesen be tudja fogadni;
- a teljes folyamat end-to-end tesztelt.

---

# 5. A normatívaszámítás legyen bizonyítható kontroll

## Javasolt launch-megjelenítés

Ne:

> **Várható normatíva: 8 426 300 Ft**

Hanem:

> **Becsült támogatás: 8 426 300 Ft**

Alatta:

- számítási év: 2026;
- szabályprofil verziója;
- figyelembe vett gyermekek;
- jogosult napok;
- kizárt vagy bizonytalan napok;
- hiányzó adatok;
- eltérés a KENYSZI-jelentéshez képest;
- utolsó validáció időpontja;
- könyvelői/fenntartói ellenőrzés státusza.

## Kötelező blokkolás

Ne készüljön biztos támogatási összeg, ha:

- hiányzik egy gyermek szolgáltatási jogviszonya;
- nincs lezárva a napi jelenlét;
- eltér a Zsibongo és a KENYSZI státusza;
- nem ismert a fenntartói támogatási profil;
- nincs validált 2026-os szabályprofil;
- a MÁK-adatlap verziója megváltozott.

---

# 6. Az Excel-import és az onboarding P0 prioritása

Az Excel-importot és a tíz percnél rövidebb onboardingot egyetlen **migrációs epické** kell összevonni.

## Javasolt onboarding

### 1. Fenntartó és telephely

- fenntartó típusa;
- engedélyes adatai;
- szolgáltatói nyilvántartási adatok;
- telephely;
- férőhely;
- nyitvatartás.

### 2. Dolgozók és szerepek

- szolgáltatást nyújtó személy;
- kisgyermeknevelő;
- segítő;
- helyettes;
- vezető;
- e-képviselő;
- adatszolgáltató munkatárs.

### 3. Gyermekek importja

- Excel-sablon;
- oszlopfelismerés;
- duplikációellenőrzés;
- hiányzó adat jelzése;
- próbaimport;
- jóváhagyás.

### 4. Jogviszonyok

- megállapodás kezdete;
- várható vége;
- csoport;
- támogatási státusz;
- speciális ellátási adat;
- étkezés.

### 5. Próbanap

A rendszer egy korábbi vagy minta napon végigvezeti:

- a jelenléten;
- a kapacitásellenőrzésen;
- a napi záráson;
- a KENYSZI-készültségen.

## Sikerkritérium

> **Az első teljes és KENYSZI-re előkészített nap tíz percen belül létrejön az import befejezése után.**

---

# 7. A kezdőképernyő legyen „Mai működés”

## A gondozó napi képernyője

Elsődleges elemek:

1. **Ma várt gyermekek**
2. **Megérkezett / hiányzik / távol marad**
3. **Étkezési eltérések**
4. **Allergia- és egészségügyi figyelmeztetés**
5. **Távozott**
6. **Nap lezárása**

## Gyors interakció

Gyermekenként legfeljebb egy koppintás:

- megérkezett;
- hiányzik;
- később érkezik;
- távozott.

Legyen elérhető:

- „mindenki megérkezett” tömegművelet;
- utólagos korrekció;
- korrekciós ok;
- automatikus időbélyeg;
- módosító személy naplózása.

## Vezetői napi képernyő

A vezető ezt lássa:

- melyik csoport nincs lezárva;
- melyik gyermeknek hiányzik adat;
- van-e kapacitási probléma;
- teljesíthető-e a KENYSZI-jelentés;
- ki az aznapi adatszolgáltató;
- mikor jár le a határidő;
- történt-e utólagos korrekció.

## Fenntartói képernyő

A fenntartó ezt lássa:

- telephelyenkénti megfelelési státusz;
- férőhely-kihasználtság;
- hiányzó napi jelentések;
- normatívaeltérések;
- dolgozói és helyettesítési kockázatok;
- közelgő határidők.

---

# 8. A szerepkörök véglegesítése

## Fenntartó

- minden telephely áttekintése;
- pénzügy és normatíva;
- felhasználók;
- megfelelési státusz;
- export;
- auditnapló.

## Telephelyvezető/admin

- gyermekek és megállapodások;
- napi zárás;
- KENYSZI-előkészítés;
- dolgozók;
- javítások;
- riportok.

## Gondozó/kisgyermeknevelő

- saját csoport;
- jelenlét;
- étkezés;
- szükséges egészségügyi figyelmeztetések;
- napi események.

## Segítő

A segítő szükség esetén kapjon saját, korlátozott hozzáférést:

- jelenlét megtekintése;
- kijelölt napi műveletek;
- csak a szükséges gyermekadatok;
- nincs normatíva-, fenntartói vagy teljes egészségügyi hozzáférés.

## E-képviselő/adatszolgáltató

Ez egy meglévő felhasználóhoz rendelt **jogosultság és felelősség** legyen:

- jelentés előkészítése;
- beadás visszaigazolása;
- korrekció;
- önellenőrzés;
- auditnapló.

---

# 9. Az allergia-alert és az adatvédelmi launch-gate

## Kötelező launch-követelmények

- dokumentált adatkezelő–adatfeldolgozó szerepek;
- adatfeldolgozói szerződés;
- EU/EGT-adattárolási és alvállalkozói lista;
- adatvédelmi hatásvizsgálat szükségességének dokumentált vizsgálata;
- szerepköralapú hozzáférés;
- titkosítás adatátvitelkor és tároláskor;
- hozzáférési napló;
- export- és törlési folyamat;
- adatmegőrzési szabály;
- incidenskezelési folyamat;
- elveszett eszköz esetén munkamenet-visszavonás.

## UI-elv

A gondozó lássa:

> **„Mogyoróallergia – sürgősségi protokoll megtekintése”**

De ne lássa automatikusan:

- a teljes orvosi dokumentációt;
- szükségtelen diagnózisokat;
- más csoportok egészségügyi adatait;
- fenntartói dokumentumokat.

---

# 10. A helyettes-hálózat kivétele a core launchból

A helyettes-hálózat nem egyszerű funkció, hanem külön piactérjellegű üzleti modell.

## Launchra javasolt minimum

Ne marketplace készüljön, hanem **helyettesítési készenlét**:

- telephelyenként kijelölt helyettes;
- képesítés és dokumentum lejárata;
- elérhetőség;
- helyettesítési terv;
- hiányzó helyettesítés riasztása;
- esemény naplózása.

A több fenntartó közötti piactér csak külön validáció után induljon.

---

# 11. A szülői PWA ne legyen launch-blocker

## Launchra elegendő

- szülői kapcsolattartók;
- célzott értesítés;
- hiányzás bejelentése;
- étkezési változás;
- adatváltozás kérése;
- dokumentált kézbesítés.

## Launch után

- önálló szülői PWA;
- napi összefoglaló;
- számlák és térítési díj;
- dokumentummegosztás;
- digitális nyilatkozatok;
- hozzájárulások;
- kétirányú üzenet.

Ne épüljön launchkor:

- közösségi feed;
- korlátlan fotómegosztás;
- pedagógiai portfólió;
- chatcsoportok;
- komplex fejlődési napló.

---

# 12. A NAV auto-pull kivétele a közeli roadmapből

A Zsibongo fő problémája:

- napi jelenlét;
- kapacitás;
- KENYSZI;
- normatíva;
- MÁK;
- gyermek- és dolgozói megfelelés.

A NAV-adat:

- nem oldja meg ezeket;
- új pénzügyi scope-ot nyit;
- számlázási és könyvelési elvárásokat hoz;
- eltereli a fejlesztést a védhető compliance-wedge-ről.

A pénzügyi modul első lépése inkább:

- térítési díj;
- befizetési státusz;
- normatíva és saját bevétel összképe;
- havi eltérés.

---

# 13. Az árazás pontosítása

A jelenlegi megfogalmazás:

> 4 990 Ft/hó alap + 3 900 Ft/telephely + 2 900 Ft/csoport.

Ez nem teszi egyértelművé, hogy az első telephely és első csoport része-e az alapárnak.

## Javasolt launch-árazás

### Zsibongo Alap – 4 990 Ft + áfa/hó

Tartalmazza:

- 1 fenntartó;
- 1 telephely;
- 1 csoport;
- legfeljebb a jogszabály szerinti csoportlétszám;
- napi jelenlét;
- KENYSZI-előkészítés;
- kapacitásellenőrzés;
- alap normatívabecslés;
- 3–5 dolgozói felhasználó.

### További telephely

> +3 900 Ft + áfa/hó

### További csoport

> +2 900 Ft + áfa/hó

### Hálózati csomag

Egyedi vagy sávos árazás 4–5 telephelytől.

## Trial

> **Az első teljes naptári hónap ingyen, legfeljebb 45 napig.**

---

# 14. A Minipedhez képesti pozicionálás

A Zsibongo ne állítsa:

> „Nincs más magyar bölcsődei adminisztrációs rendszer.”

A helyes különbségtétel:

> **„A Zsibongo nem egyszerűen digitalizálja a dokumentációt: naponta összekapcsolja a jelenlétet, a személyzeti és kapacitási szabályokat, a KENYSZI-adatszolgáltatás előkészítését és a normatívaellenőrzést.”**

---

# 15. Üzemzavar- és offline működés

## Launchra szükséges minimum

- jelenlét lokális vagy megbízható ideiglenes mentése;
- automatikus újrapróbálkozás;
- egyértelmű offline állapot;
- utolsó sikeres szinkron időpontja;
- exportálható vészhelyzeti napi lista;
- szolgáltatáskiesési eseménynapló;
- adminisztrátori riasztás;
- helyreállítás utáni egyeztetés;
- napi biztonsági mentés;
- dokumentált visszaállítási teszt.

Teljes, korlátlan offline alkalmazás nem szükséges launchra.

---

# Javasolt végleges launch-scope

## Kötelezően benne

- családi bölcsődei, nem generikus termékpozíció;
- fenntartó, telephely, csoport és engedélyes alapadatok;
- Excel-import;
- gyermek- és megállapodásnyilvántartás;
- szolgáltatási jogviszony kezdete és vége;
- dolgozók és szerepkörök;
- napi érkezés, távozás és hiányzás;
- étkezés;
- célhoz kötött allergia-alert;
- verziózott kapacitásmotor;
- segítői és helyettesítési státusz;
- napi zárás;
- KENYSZI-készültségi ellenőrzés;
- határidő- és önellenőrzés-kezelés;
- beadás visszaigazolásának rögzítése;
- verziózott normatívabecslés;
- eltérés- és hiányjelzés;
- teljes auditnapló;
- szerepköralapú hozzáférés;
- adatvédelmi és biztonsági minimum;
- kiesésbiztos jelenlétrögzítés;
- alap termékanalitika;
- support- és incidensfolyamat.

## Launch utáni első 30–60 nap

- MÁK-adatlap kitöltési segédlet;
- többtelephelyes fenntartói dashboard;
- szülői hiányzásbejelentés;
- térítési díj és befizetés;
- dokumentumlejárati figyelmeztetés;
- helyettesítési készenlét;
- részletes havi finanszírozási egyeztetés;
- digitális szülői nyilatkozatok;
- korlátozott szülői PWA.

## Kivenném vagy elhalasztanám

- cross-operator helyettes-marketplace;
- NAV auto-pull;
- teljes szülői közösségi app;
- korlátlan fotómegosztás;
- pedagógiai fejlődési portfólió;
- automatikus KENYSZI-beküldés hivatalos integráció nélkül;
- „hatóságilag garantált normatíva” állítás;
- mini bölcsőde és hagyományos bölcsőde egyidejű támogatása;
- túl széles HR- és bérmodul;
- teljes könyvelési rendszer.

---

# Launch-analitika

## Minimum mérendő események

1. fenntartó regisztrált;
2. telephely beállítva;
3. Excel-import elindult;
4. import sikeres;
5. első csoport létrejött;
6. első gyermek jogviszonya teljes;
7. első napi jelenlét rögzítve;
8. napi zárás megtörtént;
9. KENYSZI-készültség zöld;
10. eltérés észlelve;
11. eltérés feloldva;
12. jelentés beadása visszaigazolva;
13. normatívabecslés elkészült;
14. második hét aktív használata;
15. trialból fizetővé vált.

## Elsődleges KPI

> **A működési napok hány százalékában készül el határidő előtt teljes, eltérésmentes KENYSZI-előkészítés?**

## Javasolt kezdeti célok

| Mutató | Kezdeti cél |
|---|---:|
| Import → első teljes nap | <30 perc |
| Napi jelenlét kitöltése | <2 perc/csoport |
| Napi zárás | <3 perc/telephely |
| KENYSZI-készültség zöld határidő előtt | ≥98% |
| Pilot alatt elveszett jelenléti adat | 0 |
| Kritikus kapacitásszámítási eltérés | 0 |
| Jogosulatlan egészségügyi hozzáférés | 0 |
| Heti aktív telephelyek | ≥80% |
| 30 napos trial → fizetés | ≥25% |
| Adminisztrációs idő érzékelt csökkenése | ≥30% |

---

# Go/no-go launch gate

A Zsibongo nyilvánosan akkor induljon, ha mind teljesül:

- [ ] A célcsoport egyértelműen családi bölcsőde.
- [ ] A hatályos kapacitás- és személyzeti szabályok verziózottak.
- [ ] Az öt- és nyolcfős működési esetek szakértőileg validáltak.
- [ ] Az SNI/korai fejlesztési esetek validáltak vagy biztonságosan blokkoltak.
- [ ] A KENYSZI napi és korrekciós határidők helyesen működnek.
- [ ] A termék nem állít hivatalos automatikus beküldést integráció nélkül.
- [ ] A KENYSZI-készültségi ellenőrzés end-to-end tesztelt.
- [ ] A normatívabecslés 2026-os szabályprofilja validált.
- [ ] Az Excel-import duplikáció- és hiánykezelése működik.
- [ ] A szerepkörök és jogosultságok elkülönülnek.
- [ ] Az allergia- és egészségügyi adatok hozzáférése tesztelt.
- [ ] A tenantok között nincs adatszivárgás.
- [ ] Minden kritikus módosítás naplózott.
- [ ] Rövid hálózati kiesésnél nem vész el a jelenlét.
- [ ] Legalább 5–10 valódi családi bölcsőde végigvitt egy teljes hónapot.
- [ ] Van legalább egy egytelephelyes és egy többtelephelyes pilot.
- [ ] Van ötfős, segítős és helyettesítési teszteset.
- [ ] Legalább 100 működési nap összevetése megtörtént.
- [ ] Kritikus compliance-eltérés: 0.
- [ ] A pricing egyértelműen tartalmazza az első telephelyet és csoportot.
- [ ] Van support-, incidens- és helyreállítási folyamat.

---

# A legfontosabb launch-döntések

A Zsibongo indulása előtt hat egyértelmű módosítást tennék:

1. **Kizárólag családi bölcsődékre szűkíteném a publikus launchot.**
2. **Az Excel-importot és a gyors onboardingot P0 launch-funkcióvá emelném.**
3. **A KENYSZI-exportot KENYSZI-előkészítő és ellenőrző folyamattá pontosítanám.**
4. **Verziózott kapacitás- és normatívamotort építenék, blokkolással bizonytalan esetekre.**
5. **Kivenném a helyettes-marketplace-et, a NAV-integrációt és a teljes szülői appot a core launchból.**
6. **A fő UI-t szerepspecifikus „Mai működés” és „KENYSZI-készültség” képernyők köré szervezném.**

Ezekkel a Zsibongo nem egy újabb adminisztrációs rendszerként, hanem **a családi bölcsőde napi megfelelési és finanszírozási kontrollközpontjaként** indulhat el.
