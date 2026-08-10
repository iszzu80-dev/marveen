# QuickQuote szakértői launch-értékelés

## Vezetői döntés

A QuickQuote **jó problémát céloz, a termék alapja életképes, és a legfontosabb megkülönböztető képesség — a jegyzetből vagy diktálásból készülő, bizonytalanságokat jelző ajánlat — valóban értékes**.

A jelenlegi állapot azonban:

- **kontrollált pilotra még nem teljesen kész**;
- **nyilvános, fizetős launchra egyértelműen NO-GO**;
- funkcionálisan jóval előrébb tart, mint amit a launch-javaslat készítésekor feltételeztünk;
- ugyanakkor néhány kulcsképessége csak papíron vagy holt kódként létezik;
- az operációs lánc — email, fizetés, support, pilotmérés — lényegesen gyengébb, mint maga az ajánlatkészítő motor.

A július 17-i launch-javaslat stratégiai iránya nagyrészt helyes volt: három mély szakma, eredményközpontú pozicionálás, bizonytalanságkezelés, 3 ingyenes ajánlat és kontrollált pilot. A jelenlegi termékleírás alapján azonban több döntés nem került ténylegesen végigvezetésre a landen, onboardingon, mérésen és üzemeltetésen.

### Összesített értékelés

| Terület | Értékelés |
|---|---:|
| Megoldott probléma és cél | **8,5/10** |
| Célcsoport pontossága | **7/10** |
| Funkcionális termékalap | **7,5/10** |
| Jelenleg ténylegesen működő differenciálás | **6/10** |
| AI-bizalom és bizonytalanságkezelés | **8,5/10** |
| Mobil UX szerkezete | **6/10** |
| Pixel-level vizuális UI | **nem ellenőrizhető képernyőképek nélkül** |
| Ár–érték a célállapotban | **7,5/10** |
| Ár–érték a jelenlegi állapotban | **5,5/10** |
| Kontrollált pilot készültsége | **kb. 60–65%** |
| Nyilvános, fizetős launch készültsége | **kb. 35–40%** |

A százalékok vezetői készültségi becslések, nem kódsor-alapú fejlesztési készültségek.

---

# 1. A korábbi launch-javaslat és a jelenlegi termék összevetése

| Korábbi döntés | Jelenlegi állapot | Értékelés |
|---|---|---|
| Három mély szakma, a többi általános mód | A landing ezt kommunikálja, de az elsődleges szakma nem íródik be, ezért mindig az általános prompt fut | **Kritikus rés** |
| Szöveges capture + béta hang | Mindkettő működik, a hang megfelelően béta jelölésű | **Kész** |
| Szakmaspecifikus intelligencia | Megépítve és tesztelve, de holt kód | **Papíron kész, üzletileg nincs** |
| Bizonytalanság és hiányok jelzése | Ötállapotú rendszer, küldésblokkolás, nincs kitalált ár | **A tervnél is jobb** |
| 2–4 tisztázó kérdés | Inkább „áttekintettem” checkboxok | **Funkcionálisan részleges, UX-ben gyenge** |
| Ügyfél által látott ajánlat előnézete | Megvalósult | **Kész és helyes** |
| 3 elküldött ajánlat ingyen | Megvalósult, draft nem számít | **Kész** |
| Fizetés a 3. ajánlat után | Nincs fizetési útvonal | **Nyilvános launch-blocker** |
| Kézi follow-up induláskor | Automatikus, óránként futó kiküldés működik | **A döntéssel ellentétes** |
| Minimum számlázási handoff | Teljes Számlázz.hu-integráció készült | **Túlteljesített** |
| Fotó-AI korlátozva | Arc-elmosás és EXIF-tisztítás kész, funkció zárva | **Majdnem kész**, de a prompt még árat kér |
| Email production kapu | Reply-to hiányzik, rossz termék feladó címe szerepel, SES production nem igazolt | **Kritikus rés** |
| 10 launch-esemény | 9/10 megvan | **Jó alap**, de az időmérés és fizetés hiányzik |
| Triázs kezdőképernyő | Nem épült meg; általános SaaS-dashboard készült | **Legnagyobb UI-eltérés** |
| Valósághű demó | Kitalált árakat és a valódi motortól 2,5-szer eltérő eredményt mutat | **Bizalomromboló** |

A core ajánlat-életciklus — capture, szerkesztés, ügyféloldal, email, megnyitás, elfogadás, PDF és számlázási átadás — jelentős része már működik. Ezzel szemben a szakmaspecifikus motor kiválasztása, a fizetés, a helyes email-konfiguráció, az első ajánlat idejének mérése és a supportút hiányzik.

## Fontos következtetés

A QQ fő problémája már nem az, hogy „nincs megépítve a termék”. A probléma az, hogy:

> **a legjobb megépített képességei nincsenek megfelelően aktiválva, bemutatva és operációsan körbezárva.**

Ez jó hír, mert a szakmaspecifikus intelligencia életre keltése valószínűleg sokkal olcsóbb, mint újra megépíteni. Rossz hír, mert a landing jelenleg olyasmit állít, amit a tényleges felhasználói út nem teljesít.

---

# 2. Helyes-e a célmeghatározás?

## Igen, de pontosabb ICP kell

A „magyar szakiparos egyéni vállalkozó és mikrovállalkozás, aki helyszíni felmérés után ajánlatot ad” jó kiindulás.

A valódi elsődleges célcsoportot azonban viselkedés alapján szűkíteném:

> **1–5 fős, tulajdonos által vezetett szakipari vállalkozás, amely havonta legalább 5–10, jellemzően 100 ezer és néhány millió forint közötti munkára készít ajánlatot, jelenleg telefonos jegyzetet, papírt, Excelt, Billingót vagy Számlázz.hu-t használ, és nincs külön irodai adminisztrátora.**

Nem elsődleges célcsoport:

- sürgősségi javítást végző szakember, aki ritkán készít előzetes ajánlatot;
- nagy kivitelező, amely költségvetési kiírásokkal és komplex tenderekkel dolgozik;
- olyan szakember, akinek évente csak néhány ajánlata van;
- teljes ERP-t, készletet és munkaszervezést kereső több tucat fős cég.

## A három szakma kiválasztása részben jó

**Villanyszerelő:** jó választás. Sok tétel, mennyiség, kábel, szerelvény, falvésés, helyreállítás és kiszállás merül fel, ezért a hiányfelismerés valódi érték.

**Klímaszerelő:** szintén jó. Viszonylag ismétlődő csomagok, csőhossz, konzol, áttörés, kondenzvíz-elvezetés, magasban végzett munka és extra anyagok kezelhetők.

**„Víz-, gáz- és fűtésszerelő”: túl széles kategória.** A csapcsere, csőtörés, padlófűtés, kazáncsere és gázterv teljesen más ajánlati logikát kíván. Launchra ezt így módosítanám:

1. villanyszerelő;
2. klímaszerelő;
3. víz- és fűtésszerelő.

A gázspecifikus munkák egyelőre kerüljenek általános vagy béta módba, amíg külön szakmai prompttal és valós tesztekkel nincsenek lefedve.

---

# 3. Versenytársak: a korábbi elemzés egyik fontos állítása hibás

A jelenlegi termékleírás azt állítja, hogy a Billingo és a Számlázz.hu „nem készít árajánlatot”. Ez **a Billingóra biztosan nem igaz**.

A Billingo Pro csomagban árajánlat készíthető, emailben kiküldhető, ügyhöz rendezhető, újraküldhető, és az elfogadott ajánlatból megrendelés, teljesítési igazolás vagy számla készíthető. A Pro csomag jelenlegi ára 3 790 Ft + áfa havonta.

## A releváns versenytér

| Versenytárs | Erőssége | QQ előnye / veszélye |
|---|---|---|
| **Billingo Pro** | Ismert magyar brand, számlázás, partner- és terméktörzs, ajánlatból számla, 3 790 Ft + áfa | A QQ sokkal gyorsabb capture-rel nyerhet, de a felhasználó azt kérdezi majd: „miért ne csináljam a Billingóban?” |
| **Colostok** | Építőipari fókusz, kalkulátorok, PDF, szerződés és teljesítési igazolás; 2 500–4 000 Ft/hó AAM | A legközelebbi olcsó, szakipari direkt versenytárs; QQ előnye a capture és a hiányfelismerés |
| **Droposal** | Magas szintű ajánlati UX, követés, elfogadás, e-aláírás, automatikus follow-up, AI-szerkesztés, integrációk | Komoly ügyféloldali élmény- és UI-benchmark; Starter 4 990 Ft + áfa, havi 10 dokumentummal |
| **Innonest + Számlázz.hu** | Helyszíni mobil ajánlat, digitális aláírás, ajánlattól számláig workflow | Kevésbé gyors capture, de szélesebb ügyviteli folyamat |
| **Uplan/eDesign és szakmaspecifikus kalkulátorok** | Villamos műszaki tervezés, anyaglista, konkrét szakmai mélység | A QQ nem technikai tervezőrendszer; nem szabad annak látszania |
| **Jobber, Tradify, Housecall Pro, Fergus** | Érett mobil quoting, job management, árlisták, opciós ajánlatok, utánkövetés, fizetés | Magyar lokalizációban gyengék, de megmutatják, merre tart a kategória |

A QQ valódi moatja nem lehet pusztán:

> „hangból ajánlatot készít”.

Ennek másolása viszonylag egyszerű, és nemzetközileg már megjelent.

A védhetőbb kombináció:

1. magyar szakipari szókincs és tétellogika;
2. saját árlista;
3. hiányzó és bizonytalan tételek felismerése;
4. kitalált árak és tételek tiltása;
5. magyar számlázási handoff;
6. extrém egyszerű, helyszíni mobilfolyamat.

---

# 4. Funkcionálisan versenyben van-e?

## Amiben igen

A jelenlegi QQ már kifejezetten erős az alábbiakban:

- jegyzetből strukturált ajánlat;
- béta hangbevitel;
- ötállapotú bizonytalanságkezelés;
- kitalált ár tiltása;
- ügyféloldali ajánlat;
- megnyitáskövetés;
- elfogadás és elutasítás;
- PDF;
- Számlázz.hu-integráció.

A bizonytalanságkezelés a termék legerősebb tulajdonsága. A legtöbb ajánlatkészítő azt segíti, hogy a felhasználó gyorsabban írja be, amit már tud. A QQ azt is megpróbálja megmutatni, **mit nem tud még biztosan**. Ez valódi differenciálás.

## Amiben jelenleg nem

A QQ jelenlegi működésében nincs valódi háromszakmás intelligencia, mert az elsődleges szakma nincs elmentve. Így a fő termékígéret egyik fele nem teljesül.

A teljes workflow tekintetében a versenytársak előrébb járnak:

- fizetés;
- Billingo-integráció;
- költség, árrés és markup;
- jó–jobb–legjobb vagy opcionális tételek;
- automatikus, szabályozható utánkövetés;
- beszállítói árlisták;
- stabil support és onboarding.

Ezek közül launchra nem kell mindent megépíteni. A gyors capture-wedge elveszne, ha most teljes field-service vagy ERP-terméket kezdenénk építeni.

---

# 5. UI-értékelés

Ez **funkcionális UX-értékelés**, nem pixel-level vizuális audit, mert a feltöltött dokumentum nem tartalmazza a jelenlegi képernyők tényleges renderelt képeit.

## Ami jó

A háromlépcsős folyamat helyes:

1. capture és ellenőrzés;
2. ügyfél által látott előnézet;
3. ügyféladatok, feltételek és küldés.

Nem szükséges ragaszkodni a korábbi négylépéses tervhez. A három lépés egyszerűbb lehet, feltéve, hogy nem zsúfolódik túl az első képernyő.

Az is jó döntés, hogy a felhasználó a **végleges ügyféloldali dokumentumot** hagyja jóvá, nem csak egy belső táblázatot.

## Ami nem elég versenyképes

### 1. A kezdőképernyő rossz termékmodellt sugall

Az általános SaaS-dashboard — ajánlatok, ügyfelek, sablonok, analitika, számlázás — nem a célfelhasználó napi gondolkodásmódja.

A szakiparos elsősorban ezt akarja látni:

- új ajánlat;
- mit kell most javítanom vagy elküldenem;
- melyik ügyfél nyitotta meg;
- melyik ajánlatra kell rákérdezni;
- mit fogadtak el.

A korábban javasolt triázs-kezdőképernyő továbbra is helyes:

**Nagy elsődleges CTA:**  
`+ Új ajánlat`

Alatta:

- **Teendőt igényel**
- **Válaszra vár**
- **Elfogadva**

Az analitika legyen egy szinttel beljebb.

### 2. A checkbox nem valódi tisztázás

A „megnéztem” checkbox nem segíti a szakiparost a döntésben.

Helyette kérdéskártyák kellenek:

> A faljavítás része az ajánlatnak?

`Igen` · `Nem` · `Később pontosítom`

> A 20 méter kábel anyagára is szerepeljen?

`Anyaggal` · `Csak munkadíj` · `Nem tudom még`

Ezzel a QQ nemcsak hibát jelez, hanem gyorsan meg is oldatja.

### 3. Az onboardingot át kell építeni

A helyes sorrend:

1. válaszd ki az elsődleges szakmát;
2. add meg az AAM/áfa státuszt;
3. állítsd be az óradíjat és kiszállási díjat;
4. importáld vagy add meg a leggyakoribb tételeidet;
5. készítsd el az első valódi ajánlatot.

A 13 egyenrangú checkboxos szakmaválasztó gyengíti a fókuszt és jelenleg technikailag sem aktiválja a mély promptot.

### 4. A demót azonnal javítani vagy ideiglenesen eltávolítani kell

A demó nem mutathat más árakat és más logikát, mint a termék. Különösen nem hagyhatja ki a termék legfontosabb bizalmi elemét, a bizonytalanságjelzést.

A demó vagy:

- ugyanazt a motort használja sandbox módban;
- vagy verziózott, tesztelt fixture-eredményt mutasson;
- vagy ne legyen publikus a javításig.

---

# 6. Reális-e a 4 900 Ft + áfa ár?

## Igen, de prémiumot kér a lokális alternatívákhoz képest

A 4 900 Ft + áfa:

- körülbelül 20–30%-kal magasabb a Billingo Pro és a Colostok prémium árszintjénél;
- nagyjából megegyezik a Droposal Starter nettó árával;
- ugyanakkor korlátlan ajánlatot ad, szemben a Droposal Starter havi 10 dokumentumával.

Az ár akkor reális, ha a felhasználó valóban azt tapasztalja, hogy:

- 15–30 perc helyett néhány perc alatt elkészül az ajánlat;
- kevesebb tételt felejt el;
- az ajánlat még aznap kimegy;
- nem kell este újragépelnie;
- legalább egy plusz munkát vagy néhány adminisztrációs órát nyer havonta.

Jelenleg azonban a mély szakmafunkció holt kód, nincs fizetés, és a demó hibás. Ebben az állapotban a felhasználó inkább egy drágább ajánlatkészítőt lát, nem egy lényegesen gyorsabb szakipari asszisztenst.

## Árazási javaslat

**A 4 900 Ft + áfa listaárat nem csökkenteném a pilot előtt.**

Maradjon:

- 3 elküldött ajánlat ingyen;
- utána 4 900 Ft + áfa/hó;
- korlátlan ajánlat;
- később 49 000 Ft + áfa/év éves csomag.

Nem hoznék létre több launch-csomagot. A célcsoportnak a háromszintű pricing csak újabb döntési súrlódás lenne.

A pilotban külön kell mérni:

- hányan érik el a negyedik ajánlatot;
- hányan hajlandók ténylegesen fizetni;
- hányan mondják azt, hogy „ezt a Billingóban is megoldom”;
- hány ajánlat/hó felett válik nyilvánvalóvá az érték.

---

# 7. Az értékajánlat kritikája és javasolt új szöveg

A korábbi:

> „Magyar szakipari helyszíni asszisztens, amely diktálásból perceken belül elküldhető és követhető ajánlatot készít.”

irányában jó, de három hibája van:

1. túl nagy hangsúlyt tesz a még nem validált diktálásra;
2. a „követhető ajánlat” már nem egyedi, ezt Billingo, Droposal és mások is tudják;
3. nem mondja el a legerősebb QQ-képességet: a hiányok és bizonytalanságok felismerését.

A „60 másodperc” állítást addig teljesen kivenném, amíg nincs valós mediánidő-mérés.

## Javasolt hero

> **Mondd el, mit mértél fel. A QuickQuote szerkeszthető ajánlattá rendezi.**

Alcím:

> **Saját áraiddal, hiányjelzéssel és ügyfélkövetéssel — hogy ne este kelljen újragépelned.**

Bizalmi sor:

> Villany-, klíma-, valamint víz- és fűtésszerelőknek. Nem talál ki árat. Küldés előtt mindent te hagysz jóvá.

CTA:

> **Első 3 ajánlat ingyen**

Ez az értékajánlat:

- eredményközpontú;
- nem állít bizonyítatlan időt;
- nem teszi az AI-t főszereplővé;
- kiemeli a bizalmi differenciátort;
- megmagyarázza, miért jobb a Billingónál vagy egy sablonnál.

---

# 8. Launch-gate aktuális állapota

A korábbi 12 kapu alapján a szigorúbb, bizonyítékalapú értékelésem:

| Launch-kritérium | Állapot | Megjegyzés |
|---|---|---|
| SES production működik | 🔴 / ismeretlen | Repóból nem igazolható |
| Valódi ügyfélnek kiküldhető | 🟡 | Kód van, valós E2E bizonyíték nincs |
| Megnyitás és elfogadás visszaérkezik | 🟡 | Funkció van, production bizonyíték kell |
| Legalább 15 szakiparos használta | 🔴 | Nincs pilotadat |
| Legalább 50 valódi ajánlat készült | 🔴 | Nincs pilotadat |
| Medián elkészítési idő 5 perc alatt | 🔴 | Nincs is mérve |
| Nincs kritikus, kitalált tétel | 🟡 | Erős kódos guardrail, valós teszt hiányzik |
| Hang validált vagy béta jelölésű | 🟢 | Béta jelölés megvan |
| Pricing és ingyenes használat egyértelmű | 🟢 | Kommunikáció kész |
| Fotó-AI guardrail nélkül nincs nyitva | 🟢 | Zárva, arc-elmosás kész |
| Funnel mérhető onboardingtól elfogadásig | 🟡 | 9/10 esemény, időmérés és fizetés hiányzik |
| Emberi support- és hibakezelési út | 🔴 | Nem található |

**Összesítés: 3 zöld, 4 sárga, 5 piros.**

## További launch-blockerek

- nincs fizetési útvonal;
- nem aktiválódik a szakmaspecifikus motor;
- hibás a feladó és nincs reply-to;
- automatikus follow-up fut emberi jóváhagyás nélkül;
- a demó eltér a terméktől;
- a helyi draftmentés és hálózati hibából való visszaállás nem igazolt;
- a fotóprompt még árat akar generáltatni, ezért a fotó-AI nem nyitható ki.

---

# 9. Javasolt végrehajtási sorrend

## P0 — kontrollált pilot előtt

1. **Automatikus follow-up azonnali kikapcsolása.**
2. **Elsődleges szakma és teljes onboardingmezők bekötése.**
3. **QQ feladócím és szakiparoshoz vezető reply-to javítása.**
4. **SES production, SPF/DKIM/DMARC, bounce/complaint és valós E2E teszt bizonyítása.**
5. **Demó motorhoz igazítása vagy ideiglenes eltávolítása.**
6. **Első capture → első küldés időmérésének beépítése.**
7. **Emberi supportút: in-app segítség, email és hibajegy minimumfolyamat.**
8. **Fotópromptból az árbecslés eltávolítása.**
9. **Hálózati hiba esetén draft-visszaállítás ellenőrzése.**

Ezek után elindítható a 20–30 fős kontrollált pilot.

## P1 — fizetős nyilvános launch előtt

1. fizetési útvonal;
2. negyedik ajánlat paywall → fizetés → aktiválás E2E;
3. fizetővé válás analitikai eseménye;
4. 15+ szakiparos, 50+ valódi ajánlat;
5. 100 valós diktálás;
6. medián idő és javítási arány;
7. kritikus hallucination 0%;
8. legalább egyszerű Billingo export vagy integrációs terv.

## P2 — launch utáni első 30–60 nap

- szakiparos által jóváhagyott follow-up;
- jó–jobb–legjobb vagy opcionális tételek;
- munkacsomagok/kitek;
- költség–eladási ár–árrés kezelés;
- Billingo-integráció;
- újabb szakma;
- PWA és fejlettebb offline működés.

---

# Végső álláspont

**A QQ üzleti koncepcióját nem kell újragondolni vagy lecserélni.** A helyes irány már megvan.

A termék jelenlegi problémája nem az, hogy gyenge az ötlet vagy hiányzik a core funkcionalitás, hanem hogy:

- a szakmaspecifikus intelligencia nem aktiválódik;
- az operációs launch-lánc nincs lezárva;
- a UI nem teszi eléggé központivá a napi feladatot;
- a versenyelemzés alábecsüli a Billingót és a Droposalt;
- az értékajánlat nem emeli ki eléggé a termék legerősebb elemét, a biztonságos bizonytalanságkezelést.

**Döntés:**

- **Nyilvános launch: NO-GO.**
- **Kontrollált pilot: jelenleg NO-GO, de egy fókuszált hardening kör után GO lehet.**
- **Ár: 4 900 Ft + áfa megtartható.**
- **Scope: nem kell bővíteni; előbb a meglévő wedge-et kell ténylegesen működővé és bizonyíthatóvá tenni.**
- **A leghosszabb út nem a fejlesztés, hanem az 50 valódi ajánlatból és 100 diktálásból származó pilotbizonyíték megszerzése.**
