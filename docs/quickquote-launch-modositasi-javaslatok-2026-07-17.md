# QuickQuote (QQ) – egyértelmű launch-módosítási javaslatok

**Dátum:** 2026-07-17  
**Cél:** A QuickQuote kontrollált és mérhető piacra viteléhez szükséges termék-, pozicionálási, UX-, technikai és go-to-market módosítások összefoglalása.

---

## Vezetői álláspont

A QQ közel van a kontrollált launchhoz, de jelenlegi formájában:

- túl általános az ígéret;
- túl széles a célcsoport;
- nem teljesen egyértelmű az ingyenes használat és a fizetési pont;
- a hangalapú capture minősége még nem eléggé bizonyított;
- az AI bizonytalanságkezelése és a szakmaspecifikus intelligencia még nem látható elég erősen;
- az éles email-kézbesítés továbbra is kemény launch-feltétel.

**Javasolt indulási modell:**

1. **20–30 szakiparossal kontrollált, mérhető pilot**
2. **Nyilvános launch csak a pilot minőségi és üzleti kapuinak teljesülése után**

---

# 1. A launch célcsoportjának szűkítése

## Jelenlegi probléma

A „magyar szakiparosok, 13 szakma” túl tág induló célcsoport.

Más tétellogikát, mértékegységet és ajánlati szerkezetet használ például:

- egy villanyszerelő;
- egy festő;
- egy burkoló;
- egy klímaszerelő;
- egy asztalos.

Ha mindegyiket egyszerre, azonos mélységben támogatja a termék, az AI várhatóan általános, közepes minőségű tételezést ad.

## Javaslat

Az első launchban legfeljebb három kiemelten támogatott szakma legyen:

1. **villanyszerelő**
2. **víz-, gáz- és fűtésszerelő**
3. **klímaszerelő**

Ezeknél:

- jól strukturálható a munkadíj, anyag és kiszállás;
- gyakori a helyszíni felmérés;
- magasabb lehet az átlagos munkaérték;
- egy elnyert ajánlat többszörösen visszahozhatja a havi díjat.

A többi szakma használhatja az általános módot, de a landing és az onboarding ne állítsa, hogy mind a 13 szakmában azonos mélységű a támogatás.

---

# 2. A fő termékígéret módosítása

## Nem javasolt fő üzenet

> AI-alapú árajánlatkészítő szakiparosoknak.

Ez generikus, és nem különíti el eléggé a QQ-t a számlázóktól, szakipari ügyviteli rendszerektől és nemzetközi field-service platformoktól.

## Javasolt fő üzenet

> **Mondd el, mit mértél fel – a QuickQuote 60 másodperc alatt szerkeszthető, elküldhető árajánlatot készít.**

Másodlagos ígéret:

> **Nem kell este újra begépelned a helyszíni jegyzeteidet.**

A kommunikáció középpontjában ne az „AI”, hanem a kézzelfogható eredmény legyen:

- helyszínen elkészíthető;
- nem marad estére adminisztráció;
- professzionális ajánlat készül;
- követhető, hogy az ügyfél megnyitotta-e;
- egy gombbal elfogadható.

---

# 3. A hangbevitel mint launch-gate

A hangalapú ajánlatkészítés csak akkor lehet a landing fő ígérete, ha valós helyszíni környezetben is bizonyított.

## Tesztelendő helyzetek

- kültéri zaj;
- gépzaj;
- magyar szakmai kifejezések;
- számok és mértékegységek;
- márkanevek és anyagnevek;
- több munkafázis egy diktálásban;
- megszakítás és folytatás;
- tájnyelvi vagy kevésbé tiszta beszéd.

## Két elfogadható launch-opció

### A. Hang-first launch

A diktálás a fő belépési pont, amennyiben a valós tesztek igazolják a megfelelő pontosságot.

### B. Szöveg-first kontrollált launch

Ha a hang még nem stabil:

- a szöveges vagy jegyzetes capture legyen az elsődleges;
- a hangbevitel kapjon **béta** jelölést;
- a landing fő ígérete ne épüljön kizárólag diktálásra.

## Javasolt minőségi kapu

Legalább:

- 15 valódi szakiparos;
- összesen legalább 100 valós diktálás;
- diktálásonként átlagosan legfeljebb 2 lényegi javítás;
- a tételek legalább 85%-a helyesen felismerve;
- a mennyiségek és mértékegységek legalább 95%-ban helyesek;
- kritikus, kitalált tétel: **0%**.

---

# 4. Szakmaspecifikus intelligencia beépítése

A QQ nem lehet egyszerű „LLM → ajánlat” wrapper.

Launchra minden kiemelten támogatott szakmánál szükséges:

- tipikus munkatételek;
- jellemző mértékegységek;
- anyag- és munkadíj elkülönítése;
- kiszállási díj;
- bontás és helyreállítás;
- hulladékelszállítás;
- sürgősségi vagy hétvégi felár;
- garancia;
- ajánlat érvényessége;
- tipikusan elfelejtett kapcsolódó tételek.

## Példa

A felhasználó ezt diktálja:

> „Nyolc konnektorcsere, két új kiállás, körülbelül húsz méter kábel, falvéséssel.”

A rendszer ne csak tételeket hozzon létre, hanem jelezze:

- a szerelvények benne vannak-e az árban;
- szükséges-e helyreállítás;
- van-e kiszállási díj;
- a kábel típusa hiányzik;
- a fal anyaga befolyásolhatja a munkadíjat.

Ezek **javaslatként** jelenjenek meg, ne automatikusan hozzáadott, kitalált tételekként.

---

# 5. Kötelező bizonytalanság- és hiánykezelés

Az AI minden tételt jelöljön valamelyik állapottal:

- **rendben**
- **ár hiányzik**
- **mennyiség ellenőrzendő**
- **nem egyértelmű**
- **valószínűleg hiányzó kapcsolódó tétel**

Küldés előtt a rendszer legfeljebb 2–4 tisztázó kérdést tegyen fel.

Példák:

- „A 20 méter kábel anyagára szerepeljen az ajánlatban?”
- „A faljavítást is Ön végzi?”
- „Nettó vagy bruttó árat diktált?”
- „A kiszállási díjat külön tételként szeretné feltüntetni?”

Ez fontosabb launch-funkció, mint további látványos AI-képességek hozzáadása.

---

# 6. A mobil UI egyszerűsítése

## Javasolt kezdőképernyő

A főképernyő első eleme egy nagy elsődleges gomb:

> **Új ajánlat diktálása**

Alatta három blokk jelenjen meg.

### Teendőt igényel

- kézbesítési hiba;
- megnyitott, de el nem fogadott ajánlat;
- lejáró ajánlat;
- hiányos draft.

### Folyamatban

- elküldve;
- megnyitva;
- válaszra vár.

### Eredmények

- elfogadott ajánlatok;
- havi elfogadott érték;
- elfogadási arány.

Ne általános SaaS-dashboard vagy sok navigációs elem legyen az első élmény.

## Ajánlatkészítési flow

Maximum négy lépés:

1. **Diktálás vagy jegyzet**
2. **Tételek ellenőrzése**
3. **Ügyfél és feltételek**
4. **Előnézet és küldés**

A felhasználó mindig az ügyfél által látott végső ajánlatot ellenőrizze, ne csak egy belső adatbeviteli táblát.

---

# 7. Az ingyenes használat egyszerűsítése

A „3 ingyenes ajánlat” és a „4 hetes trial” együtt feleslegesen bonyolult.

## Javasolt modell

> **3 elküldött ajánlat ingyen, bankkártya nélkül.**

Utána:

> **4 900 Ft/hó + áfa, korlátlan ajánlatkészítéssel.**

## Miért jobb ez?

- A szakiparosok használati gyakorisága változó.
- Négy hét alatt lehet, hogy csak egy ajánlat készül.
- A három valódi elküldött ajánlat közvetlenül az érték megtapasztalásához kötődik.
- Könnyebb kommunikálni.
- Egyértelműbb a fizetési pont.

A draftok ne számítsanak bele. Csak a ténylegesen elküldött ajánlatok.

---

# 8. A follow-up automatizmus előrehozása

A follow-up közvetlenül növelheti az ajánlatelfogadást, ezért launchra vagy közvetlenül az első launch utáni sprintbe kerüljön.

## Minimum működés

- ajánlat elküldve;
- az ügyfél nem nyitotta meg 24–48 órán belül;
- a rendszer figyelmezteti a szakiparost;
- egy gombbal újraküldhető.

## Következő szint

- az ügyfél három napja megnyitotta, de nem válaszolt;
- a rendszer előkészít egy udvarias emlékeztetőt;
- a szakiparos jóváhagyásával kiküldhető.

Az automatikus küldést induláskor nem javasolt alapértelmezetté tenni. Először ember által jóváhagyott legyen.

---

# 9. Minimum számlázási handoff

A teljes Billingo- és Számlázz.hu-integráció nem feltétlenül launch-blocker, de legalább az alábbi működés szükséges:

- strukturált export;
- ügyféladatok egyszerű másolása;
- elfogadott ajánlatból számlázási előkészítés;
- „számlázásra kész” státusz;
- az adatmodell legyen kompatibilis a későbbi API-integrációval.

A felhasználónak ne kelljen az elfogadott ajánlat minden sorát újra begépelnie.

---

# 10. A fotóbecslés korlátozása

A teljes automatikus fotóbecslés túl nagy:

- pontossági;
- felelősségi;
- GDPR;
- ügyfélbizalmi

kockázatot jelent launchkor.

## Javasolt launch-működés

- fotó csatolható a felméréshez;
- az AI segíthet munkatípusokat és ellenőrzendő kérdéseket felismerni;
- ne generáljon önállóan végleges mennyiséget vagy árat;
- emberi arcot tartalmazó kép kerüljön automatikusan elmosásra, vagy ne menjen AI-feldolgozásba;
- a teljes fotó-AI maradjon zárt béta, amíg az adatvédelmi guardrail nincs kész.

---

# 11. Az email production mint kemény launch-gate

Nyilvános launch nem indulhat SES sandbox vagy bizonytalan kézbesítési lánc mellett.

## Kötelező kapuk

- AWS SES production access;
- SPF, DKIM és DMARC megfelelően beállítva;
- bounce és complaint webhook;
- újraküldési lehetőség;
- kézbesítési státusz;
- ügyfélszolgálati hibakeresési lehetőség;
- stabil, mobilon is gyors elfogadási link;
- a reply-to cím a szakiparoshoz vezessen.

## Javasolt belső célok

- 98% feletti technikai kézbesítési arány érvényes címekre;
- elfogadási link kritikus hibaaránya: 0%;
- státuszfrissítés néhány percen belül.

---

# 12. Launch-analitika beépítése

Minimum mérendő események:

1. regisztráció elindult;
2. onboarding befejeződött;
3. első capture elindult;
4. AI-tételezés elkészült;
5. ajánlat szerkesztve;
6. ajánlat elküldve;
7. ajánlat megnyitva;
8. ajánlat elfogadva vagy elutasítva;
9. fizetővé vált;
10. második és harmadik ajánlat elkészült.

## Elsődleges launch KPI

> **A regisztrálók hány százaléka küld ki valódi ajánlatot 24 órán belül?**

## Javasolt induló célok

| Mutató | Induló cél |
|---|---:|
| Onboarding → első draft | ≥60% |
| Első draft → elküldött ajánlat | ≥70% |
| Regisztráció → elküldött ajánlat | ≥40% |
| Első ajánlat elkészítési ideje | <5 perc |
| Második ajánlat 14 napon belül | ≥35% |
| 3 ingyenes ajánlat → fizetés | ≥15% |

Ezek kezdeti tanulási célok, nem iparági benchmarkok.

---

# Javasolt végleges launch-scope

## Kötelezően benne

- szöveges capture;
- validált vagy béta jelölésű hangalapú capture;
- három mélyen támogatott szakma;
- saját árak és árlista;
- szakmaspecifikus tételjavaslatok;
- hiány- és bizonytalanságjelzés;
- ügyféladatok;
- nettó, áfa és bruttó számítás;
- professzionális ügyféloldali ajánlati oldal;
- email-küldés;
- megnyitáskövetés;
- elfogadás és elutasítás;
- újraküldés;
- PDF;
- három ingyenes elküldött ajánlat;
- fizetés;
- alap analitika;
- helyi draftmentés hálózati hiba esetére.

## Launch utáni első 30 nap

- follow-up ajánlások;
- jó–jobb–legjobb ajánlati opciók;
- Billingo/Számlázz.hu handoff vagy első integráció;
- PWA telepítés;
- egy további szakma;
- SMS-pilot.

## Kivenném vagy elhalasztanám

- teljes automatikus fotóbecslés;
- mind a 13 szakma azonos mélységű támogatásának állítása;
- nagy CRM;
- készletkezelés;
- teljes munkalap- és projektmenedzsment;
- emberi kontroll nélkül kiküldött automatikus follow-up;
- teljes offline rendszer;
- saját számlázóvá válás.

---

# Go/no-go launch gate

A QQ nyilvánosan akkor induljon, ha mind teljesül:

- [ ] SES production működik.
- [ ] Valódi ügyfélnek sikeresen kiküldhető az ajánlat.
- [ ] Megnyitás és elfogadás hibamentesen visszaérkezik.
- [ ] Legalább 15 szakiparos kipróbálta.
- [ ] Legalább 50 valódi ajánlat készült.
- [ ] Az első ajánlat medián elkészítési ideje 5 perc alatt van.
- [ ] Nincs kritikus, AI által kitalált tétel.
- [ ] A hangbevitel eléri a vállalt minőséget, vagy béta jelölést kap.
- [ ] A pricing és a trial egyértelmű.
- [ ] A fotó-AI adatvédelmi guardrail nélkül nincs nyilvánosan bekapcsolva.
- [ ] Van mérés az onboardingtól az elfogadásig.
- [ ] Van emberi support- és hibakezelési út.

---

# Legfontosabb termékdöntés

A launch előtt a QQ-t ebből:

> „AI-os ajánlatkészítő 13 szakmának”

erre kell szűkíteni:

> **„Magyar szakipari helyszíni asszisztens, amely diktálásból perceken belül elküldhető és követhető ajánlatot készít.”**

Ez a változtatás egyszerre érinti:

- a termék-scope-ot;
- a landinget;
- az onboardingot;
- a tesztelést;
- a roadmapet;
- a launch kommunikációját;
- a mérési rendszert.
