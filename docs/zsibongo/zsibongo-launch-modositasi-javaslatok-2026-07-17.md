# Zsibongo – egyértelmű launch-módosítási javaslatok

_(Istvan által Telegramon beillesztve, 2026-07-17. Több részletben érkezik.)_

## Vezetői álláspont

A Zsibongo esetében nem általános bölcsődei adminisztrációs rendszerként indulnék el, hanem kifejezetten **magyar családi bölcsődék** napi működési és megfelelési asszisztenseként.

A jelenlegi termékben már elérhető:
- jelenlét- és étkezésnyilvántartás;
- normatíva-számítás;
- KENYSZI-export;
- szülői értesítés;
- allergia-alert;
- a helyettes-hálózat alapjai.

Roadmapben: Excel-import, KENYSZI kitöltési segédlet, MÁK-folyamat, gyors onboarding, többtelephelyes dashboard, szülői PWA.

Reframe: „Családi bölcsőde adminisztráció KENYSZI-exporttal" ->
> **„A napi jelenléttől a KENYSZI-adatszolgáltatásig és a normatíva ellenőrzéséig végigvezető, hibákat megelőző működési rendszer családi bölcsődéknek."**

A fő érték nem az adat tárolása, hanem hogy a fenntartó minden nap biztosan tudja: (1) teljesek-e a napi adatok; (2) jogszerű-e a gyermek-dolgozó-kapacitás helyzet; (3) elkészíthető-e a KENYSZI-jelentés; (4) van-e finanszírozási eltérés/kockázat; (5) ki és mikor módosított egy adatot.

---

## 1. A launch célpiacának szűkítése

**Első launch-célcsoport:** kizárólag családi bölcsődék; magán-/nonprofit/egyéb nem állami fenntartók; 1-3 telephely; telephelyenként egy vagy néhány csoport; aktív KENYSZI-adatszolgáltatás; jelenleg papíron/Excelben/több külön rendszerben adminisztráló szolgáltatók.

**Nem launchkor:** hagyományos bölcsődék, mini bölcsődék, munkahelyi bölcsődék, óvodák, teljes gyermekintézményi piac (eltérő létszám-/személyzeti szabály, dokumentáció, fenntartói szervezet, finanszírozás, munkafolyamat, szerepkörök).

Landing: „Kifejezetten magyar családi bölcsődéknek."

---

## 2. Családi bölcsődei kapacitásszabályok = verziózott megfelelési motor

15/1998. NM rendelet: családi bölcsődében alapesetben legfeljebb **5 gyermek**; segítő személlyel, SNI/korai fejlesztés nélkül legfeljebb **8**; SNI/korai fejlesztési esetekkel a megengedett létszám fokozatosan csökken.

**Kapacitásmotor napi bemenete:** engedélyezett férőhelyszám; ténylegesen jelen lévő gyermekek; saját gyermek (ahol beszámítandó); szolgáltatást nyújtó személy jelenléte; segítő személy jelenléte + foglalkoztatási státusz; SNI/korai fejlesztésre jogosult gyermekek száma; telephely/csoport szolgáltatói nyilvántartási adatai; helyettesítés jogszerűsége.

**UI-állapotok:** Zöld (Kapacitás rendben 5/5) / Sárga (7 gyermekhez segítő kell, jelenléte nincs igazolva) / Piros (létszám meghaladja a mai személyzeti feltételek melletti kapacitást) / Szürke-blokkolt (SNI-státusz vagy férőhelyszám nincs beállítva -> megfelelés nem állapítható meg).

**Működési szabály:** a Zsibongo NE módosítsa automatikusan a jelenléti adatot azért, hogy a kapacitás zöld legyen. Jelezze az eltérést, de a valós adatot tartsa meg. (= ugyanaz az honest-data elv, mint MK/QQ.)

---

## 3. KENYSZI-ígéret pontos megfogalmazása

Jogi/működési háttér: a KENYSZI-adatszolgáltatásért a **fenntartó** felel. A fenntartó e-képviselőt jelöl ki, aki adatszolgáltató munkatársakat is jogosíthat az egyes engedélyesekhez. A rendszer a hozzáféréseket és adatmódosításokat naplózza.

Bölcsődei ellátás: időszakos jelentés naponta, a napot követő munkanap 24:00-ig. A jelentett adat a következő hónap 15-ig egyszer önellenőrzéssel módosítható, a hiba okának megjelölésével.

KENYSZI-ígéret: NE „automatikusan beküldjük", HANEM (amíg nincs dokumentált hivatalos integráció/végpont) „előkészítjük, ellenőrizzük és lépésről lépésre végigvezetjük a KENYSZI napi adatszolgáltatáson". Napi záráskor KENYSZI-készültségi ellenőrzés (minden gyermek szerepel, jogviszony aktív, jelenlét rögzített, kapacitási ellentmondás, ismeretlen TAJ, utólagos módosítás, önellenőrzés szükséges, ki jogosult, határidő). 8-lépéses workflow (gondozó rögzít -> vezető zár -> ellenőrzések -> lista -> e-képviselő belép a hivatalos rendszerbe -> Zsibongo végigvezet -> user rögzíti a beadást -> beadási idő+felelős+visszaigazolás tárolva). BIZTONSÁG: Zsibongo NE tárolja az Ügyfélkapu+/DÁP belépést, KENYSZI-jelszót, más e-képviselői hitelesítőt -- a hivatalos rendszerbe a user közvetlenül lép be.

## 4. „KENYSZI-export" átnevezése
Hivatalos gépi import nélkül: „KENYSZI napi előkészítő / KENYSZI-készültség / kitöltési segédlet / napi adatszolgáltatási ellenőrző lista". „Export" csak ha a fogadó formátum ismert + hivatalosan támogatott + verziókövetett + end-to-end tesztelt.

## 5. Normatíva = becslésből bizonyítható kontroll
NE „Várható normatíva: X Ft", HANEM „Becsült támogatás: X Ft" + alatta: számítási év 2026, szabályprofil-verzió, figyelembe vett gyermekek, jogosult napok, kizárt/bizonytalan napok, hiányzó adatok, KENYSZI-eltérés, utolsó validáció, könyvelői/fenntartói ellenőrzés státusza. 2026 MÁK évközi frissített adatlapok -> a számítást évhez + dokumentumverzióhoz kötni. BLOKK ha: hiányzó jogviszony / nincs lezárt jelenlét / Zsibongo-KENYSZI eltérés / ismeretlen fenntartói profil / nincs validált 2026 szabályprofil / MÁK-verzió változott.

## 6. Excel-import + onboarding = legelső launch-prioritás (egy migrációs epic)
Onboarding: (1) fenntartó+telephely; (2) dolgozók+szerepek; (3) gyermekek Excel-import (sablon, oszlopfelismerés, dedup, hiányjelzés, próbaimport, jóváhagyás); (4) jogviszonyok; (5) próbanap (jelenlét->kapacitás->zárás->KENYSZI-készültség). Siker: első teljes KENYSZI-előkészített nap <10 perc az import után.

## 7. Kezdőképernyő = „Mai működés", nem admin-dashboard
Gondozó: mai várt gyermekek / megérkezett-hiányzik-távol / étkezési eltérés / allergia-alert / távozott / nap lezárása. Max 1 koppintás/gyermek + tömegművelet + korrekció(ok)+időbélyeg+naplózás. Vezető: melyik csoport nincs lezárva, hiányzó adat, kapacitásprobléma, KENYSZI teljesíthető-e, aznapi adatszolgáltató, határidő, utólagos korrekció. Fenntartó: telephelyenkénti megfelelés, férőhely-kihasználtság, hiányzó jelentések, normatívaeltérés, dolgozói/helyettesítési kockázat, közelgő határidők.

## 8. Szerepkörök véglegesítése
Fenntartó (minden telephely, pénzügy/normatíva, userek, megfelelés, export, audit) / Telephelyvezető-admin (gyermekek+megállapodás, zárás, KENYSZI-előkészítés, dolgozók, javítás, riport) / Gondozó (saját csoport, jelenlét, étkezés, eü-figyelmeztetés, események) / Segítő (korlátozott: jelenlét-megtekintés, kijelölt műveletek, csak szükséges gyermekadat, NINCS normatíva/fenntartói/teljes eü) / E-képviselő-adatszolgáltató (nem önálló munkakör, hanem meglévő userhez rendelt jogosultság: jelentés-előkészítés, beadás-visszaigazolás, korrekció, önellenőrzés, audit).

## 9. Allergia-alert marad, de ADATVÉDELMI launch-gate kell
Allergia/diagnózis/eü-állapot = különleges személyes adat (GDPR); gyermekadatnál fokozott kötelezettség (NAIH). Launch-követelmény: dokumentált adatkezelő-adatfeldolgozó szerepek, adatfeldolgozói szerződés, EU/EGT-tárolás+alvállalkozói lista, DPIA-szükségesség dokumentált vizsgálata, szerepköralapú hozzáférés, titkosítás átvitel+tárolás, hozzáférési napló, export+törlés, megőrzés, incidenskezelés, elveszett-eszköz munkamenet-visszavonás. UI: gondozó lássa „Mogyoróallergia - sürgősségi protokoll", DE ne a teljes orvosi doksit / szükségtelen diagnózisokat / más csoportok eü-adatait. Eü-figyelmeztetés: gyorsan észrevehető + célhoz kötött + minimális + naplózott + felülvizsgált.

## 10. Helyettes-hálózat KI a core launchból
Marketplace = külön üzleti modell (képesítés, alkalmasság, elérhetőség, szerződés, díjazás, reputáció). Launchra CSAK helyettesítési készenlét: telephelyenként kijelölt helyettes, képesítés+dokumentum-lejárat, elérhetőség, helyettesítési terv, hiányzó-helyettes riasztás, esemény-naplózás. Cross-operator piactér csak külön validáció után.

## 11. Szülői PWA NEM launch-blocker
Launchra elég: szülői kapcsolattartók, célzott értesítés, hiányzás-bejelentés, étkezési változás, adatváltozás-kérés, dokumentált kézbesítés. Launch után: önálló PWA, napi összefoglaló, számlák/térítés, dokumentummegosztás, digitális nyilatkozatok. NE launchkor: közösségi feed, korlátlan fotómegosztás, pedagógiai portfólió, chatcsoportok, komplex fejlődési napló.

## 12. NAV auto-pull KI a közeli roadmapből
Nem oldja a core problémát (jelenlét/kapacitás/KENYSZI/normatíva/MÁK/megfelelés), új pénzügyi scope-ot nyit, eltereli a compliance-wedge-ről. Pénzügyi modul első lépése: térítési díj, befizetési státusz, normatíva+saját bevétel összkép, havi eltérés. NAV csak későbbi bizonyított igénynél.

## 13. Árazás pontosítása
Jelenlegi 4990 alap + 3900/telephely + 2900/csoport nem egyértelmű (1 telephely+1 csoport benne van-e?). Ha minden az első egységtől összeadódik: egytelephelyes-egycsoportos = 11790/hó, ami ütközik a kommunikált 4990-nel. JAVASOLT: **Zsibongo Alap 4990 Ft+áfa/hó** tartalmaz 1 fenntartó + 1 telephely + 1 csoport + jogszabályi csoportlétszám + napi jelenlét + KENYSZI-előkészítés + kapacitásellenőrzés + alap normatívabecslés + 3-5 dolgozói user. További telephely +3900, további csoport +2900. Hálózati csomag 4-5 telephelytől sávos. Trial: **első teljes naptári hónap ingyen, max 45 nap** (hogy a havi zárás+KENYSZI-rutin+normatívaellenőrzés megtapasztalható legyen).

## 14. Pozicionálás a Miniped-hez képest
Miniped nem csak pedagógiai: bölcsődei adminisztrációs rendszerként pozicionál (BDDSZ szerint kiváltja a kézzel írt törzslapot+csoportnaplót). Zsibongo NE állítsa „nincs más magyar rendszer". Különbségtétel: „nem egyszerűen digitalizálja a dokumentációt: naponta összekapcsolja a jelenlétet, személyzeti+kapacitási szabályokat, KENYSZI-előkészítést és normatívaellenőrzést" -- de csak ha ezt tényleg end-to-end megvalósítja.

## 15. Üzemzavar- és offline működés
KENYSZI-határidő (következő munkanap 24:00) miatt a kiesés közvetlen megfelelési kockázat. Launchra: jelenlét lokális/ideiglenes mentés, auto-retry, offline állapot, utolsó sync ideje, exportálható vészhelyzeti napi lista, kiesés-eseménynapló, admin-riasztás, helyreállítás utáni egyeztetés, napi backup, visszaállítási teszt. NEM kell teljes korlátlan offline app -- csak a reggeli/délutáni jelenlét ne vesszen el.

---

## Javasolt végleges launch-scope
**Kötelezően benne:** családi bölcsődei (nem generikus) pozíció; fenntartó/telephely/csoport/engedélyes alapadat; Excel-import; gyermek+megállapodás nyilvántartás; jogviszony kezdet/vég; dolgozók+szerepkörök; napi érkezés/távozás/hiányzás; étkezés; célhoz kötött allergia-alert; verziózott kapacitásmotor; segítői+helyettesítési státusz; napi zárás; KENYSZI-készültségi ellenőrzés; határidő+önellenőrzés; beadás-visszaigazolás rögzítés; verziózott normatívabecslés; eltérés+hiányjelzés; teljes auditnapló; szerepköralapú hozzáférés; adatvédelmi+biztonsági minimum; kiesésbiztos jelenlét; alap analitika; support+incidens.
**Launch utáni 30-60 nap:** MÁK kitöltési segédlet; többtelephelyes dashboard; szülői hiányzás-bejelentés; térítési díj+befizetés; dokumentumlejárat-figyelmeztetés; helyettesítési készenlét; havi finanszírozási egyeztetés; digitális szülői nyilatkozatok; korlátozott szülői PWA.
**Kivenné/elhalasztaná:** cross-operator helyettes-marketplace; NAV auto-pull; teljes szülői közösségi app; korlátlan fotómegosztás; pedagógiai portfólió; automatikus KENYSZI-beküldés hivatalos integráció nélkül; „hatóságilag garantált normatíva" állítás; mini/hagyományos bölcsőde egyidejű támogatása; túl széles HR/bérmodul; teljes könyvelési rendszer.

## Go/no-go launch gate
- [ ] Célcsoport egyértelműen családi bölcsőde
- [ ] Hatályos kapacitás- és személyzeti szabályok verziózottak
- [ ] Az 5- és 8-fős működési esetek szakértőileg validáltak
- [ ] SNI/korai fejlesztési esetek validáltak vagy biztonságosan blokkoltak
- [ ] KENYSZI napi + korrekciós határidők helyesen működnek
- (+ a doc szerint: elveszett jelenléti adat 0, kritikus kapacitáseltérés 0, jogosulatlan eü-hozzáférés 0, stb.)

## Launch-analitika
15 esemény (regisztráció -> telephely -> import -> első csoport/gyermek -> első jelenlét -> zárás -> KENYSZI-készültség zöld -> eltérés/feloldás -> beadás-visszaigazolás -> normatívabecslés -> 2. heti aktív -> trial->fizető). **Elsődleges KPI: a működési napok hány %-ában készül el határidő ELŐTT teljes, eltérésmentes KENYSZI-előkészítés?** Célok: import->első teljes nap <30 perc, napi jelenlét <2 perc/csoport, napi zárás <3 perc/telephely, KENYSZI-készültség zöld határidő előtt ≥98%, elveszett jelenléti adat 0, kritikus kapacitáseltérés 0, jogosulatlan eü-hozzáférés 0, heti aktív telephely ≥80%, 30 napos trial->fizetés ≥25%, adminisztrációs idő csökkenés ≥30%.
