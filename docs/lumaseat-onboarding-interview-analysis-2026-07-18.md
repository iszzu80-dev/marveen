Reading additional input from stdin...
OpenAI Codex v0.144.4
--------
workdir: /home/iszzu/marveen
model: gpt-5.6-sol
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
reasoning effort: high
reasoning summaries: none
session id: 019f756c-8b67-7b53-bde1-45989b2cede9
--------
user
Te egy termék- és UX-elemző vagy. Egy magyar esküvői ültetéstervező szoftver (LumaSeat) ONBOARDING INTERJÚJÁT kell pontosan definiálnod. Magyarul válaszolj.

## A TERMÉK

LumaSeat: esküvői ültetésrend-tervező. A pár (nem szervező) használja, egy esküvőre. Az értéklánc:
vendéglista → RSVP → terem/asztalok → ültetés (kézi VAGY AI) → konfliktus-ellenőrzés → jóváhagyás → export a helyszínnek/cateringnek/dekorosnak.

KEMÉNY TERMÉK-ELV: a szoftvernek AI NÉLKÜL IS teljes értékűen használhatónak kell lennie. Az AI gyorsító, nem a termék. Az onboarding sem függhet AI-tól.

MÁR MŰKÖDIK a termékben: vendéglista-kezelés, CSV-import, RSVP-folyamat és -linkek, teremrajz (drag-and-drop asztalmozgatás), kézi ültetés, AI-ültetés, konfliktus-detektálás, privát jegyzet-réteg (alapból KIZÁRVA minden exportból), PDF/CSV/HTML export, megosztási link, DXF teremrajz-import.

## AZ ONBOARDING JELENLEGI PROTOTÍPUSA ("0. lépés — párinterjú")

Van egy működő prototípus. 16 kérdés, és MÁR NÉGYFÉLE beviteli típust használ: `single` (egy választás gombokkal), `multi` (több választás), `fields` (szabad szöveges mezők), `files` (fájlfeltöltés). Van "élő eredmény" panel (mutatja mi készült el eddig, százalékkal), mentett-interjú-folytatás, és a végén átadás a teremtervezőbe és az ültetésbe.

A 16 kérdés:
1. Hol tartotok jelenleg? (opciók pl. "Még csak most kezdjük")
2. Mikor lesz az esküvő?
3. Körülbelül hány vendéggel számoltok? (opciók pl. "30 fő alatt")
4. Mi a pár két tagjának neve?
5. Van már vendéglistátok valamilyen formában? (opció: "Igen, feltöltöm" — Excel, CSV, PDF, Word, kép vagy képernyőkép is)
6. Milyen nagyobb vendégcsoportokkal számoljunk? (pl. "Az egyik fél közeli családja")
7. Mi legyen az alapértelmezett szabály a pároknál és családoknál? (pl. "Párok egymás mellett üljenek")
8. Van érzékeny családi vagy személyes helyzet, amit figyelembe vegyünk? (pl. "Valaki ne kerüljön egy asztalhoz valakivel")
9. Megvan már a vacsora vagy lakodalom helyszíne?
10. Mit tudunk most a teremről?
11. Milyen asztalok vannak?
12. Mely területeket kell figyelembe vennünk az ültetésnél?
13. Mitől éreznétek igazán jónak az ültetést?
14. Van olyan információ, ami befolyásolhatja, hogy valaki hol üljön?
15. Mivel kezdjek inkább?
16. Töröljük a 0. lépés mentett válaszait ezen a gépen?

## A FELADATOD

Add meg PONTOSAN, kérdésenként:

### A) BEVITELI MÓD kérdésenként
Minden kérdéshez döntsd el és INDOKOLD, hogy melyik a helyes bevitel:
- GOMBOS VÁLASZTÁS (egy vagy több) — és akkor pontosan MILYEN opciókkal
- SZABAD SZÖVEG (gépelve vagy bediktálva)
- FÁJLFELTÖLTÉS — és milyen formátumokból mit tudunk kinyerni
- KOMBINÁLT (pl. gombok + "egyéb" szabad mező)
- SZÁM/DÁTUM-választó

Elv, amit alkalmazz: gombot ott adj, ahol a válaszkészlet ZÁRT és a gép később gépi döntést hoz belőle (mert a szabad szöveg ott adatvesztést okoz). Szabad szöveget/diktálást ott, ahol a válasz NYITOTT, árnyalt vagy érzelmi. Fájlfeltöltést ott, ahol a felhasználónál MÁR LÉTEZIK az adat és a begépelés büntetés lenne.

### B) MI LESZ AZ ADATBÓL
Kérdésenként mondd meg, MELYIK termék-objektumot tölti fel a válasz: vendéglista, vendégcsoport, ültetési szabály (kemény/lágy), terem, asztal, privát jegyzet, vagy csak beállítás/kontextus. Ha egy kérdés válasza SEHOVA nem folyik be, azt jelöld meg — az felesleges kérdés.

### C) SORREND ÉS ELHAGYHATÓSÁG
- Mi a helyes sorrend, és miért?
- Melyik kérdés KÖTELEZŐ, és melyik hagyható ki büntetlenül?
- Hol lehet a felhasználót korán "kiengedni" hasznos eredménnyel (hogy ne legyen 16 kérdéses fal)?

### D) HIÁNYZÓ KÉRDÉSEK
Mi az, amit a fenti 16 NEM kérdez meg, de az értéklánc miatt kellene? Csak akkor javasolj újat, ha meg tudod mondani, melyik termék-objektumot töltené fel.

### E) FELESLEGES VAGY ROSSZUL FELTETT KÉRDÉSEK
Melyik kérdés kérdez olyat, amit a rendszer később úgyis megtud, vagy amire a válasz nem befolyásol semmit? Melyik van rosszul megfogalmazva?

### F) ÉRZÉKENY ADAT (fontos)
A 8. és 14. kérdés MEGNEVEZETT HARMADIK FELEKRŐL gyűjt információt (családi konfliktusok, elváltak, "valakit ne ültess valaki mellé"), akik ebbe soha nem egyeztek bele. Add meg:
- hogyan kérdezzünk úgy, hogy a szükséges információt megkapjuk, de NE gyűjtsünk indokolatlanul sokat
- milyen megfogalmazás kerüli el, hogy diagnózist, egészségügyi vagy különleges adatot kérjünk
- mit kell a felhasználónak tudnia arról, mi történik ezzel az adattal

### G) FÁJLFELTÖLTÉS REALITÁSA
Az 5. kérdés Excelt, CSV-t, PDF-et, Wordöt, képet és képernyőképet is elfogad. Mondd meg formátumonként, mi az, ami REÁLISAN kinyerhető megbízhatóan, és mi az, ahol a felhasználót inkább kézi megerősítésre kell kérni. Hol keletkezik csendes adatvesztés?

## KIMENET FORMÁTUMA

Kérdésenkénti táblázat (kérdés | beviteli mód | opciók ha gombos | mit tölt fel | kötelező-e), majd az D-G szekciók külön. Legyél konkrét: ha opciókat javasolsz, ÍRD LE őket magyarul, ne csak azt hogy "adjunk opciókat".
2026-07-18T13:31:20.608375Z ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit
codex
A 16 kérdést nem egyetlen lineáris kérdőívként kezelem: előbb meghatározom, mely válaszok hoznak létre tényleges termékadatot, majd ezekből rövid, elágazó onboardingot állítok össze. Az AI-ültetés csak egy választható végpont lesz, nem előfeltétel.
codex
Az onboarding helyes formája nem 16 kötelező kérdés egymás után, hanem egy rövid útvonalválasztó és három elágazó munkafolyamat:

1. vendégek és RSVP,
2. terem és asztalok,
3. ültetési szabályok.

Minden ág után ki kell engedni a felhasználót a tényleges szerkesztőbe. Az AI-ültetés csak az egyik választható cél; ugyanazok az adatok a kézi ültetést és a konfliktus-ellenőrzést is szolgálják.

## A–B) Kérdésenkénti definíció

A „kötelező” itt onboarding-kaput jelent. A termékbe való belépéshez egyik tartalmi kérdés sem lehet kötelező; egyes adatok csak egy adott funkció használatához szükségesek.

| Kérdés | Beviteli mód és indoklás | Pontos opciók | Mit tölt fel | Kötelező-e? |
|---|---|---|---|---|
| **1. Hol tartotok jelenleg?** Átfogalmazva: **„Mi van már meg?”** | **Többválasztós gombok.** Ezek zárt, egymástól független állapotok, amelyekből a rendszer útvonalat választ. A „most kezdjük / már haladtunk” típusú egyetlen válasz túl pontatlan. | „Van vendéglistánk”; „Vannak már vendégenkénti RSVP-válaszaink”; „A helyszín végleges”; „Van teremrajzunk vagy alaprajzunk”; „Ismerjük az asztalokat és a férőhelyeket”; „Van már ültetési vázlatunk”; „Még egyik sem” – ez utóbbi kizárja a többit. | Csak **beállítás/kontextus és útvonalválasztás**. Később a rendszernek felül kell írnia a tényleges projektállapot alapján. | Nem. Legyen „Kihagyom, az áttekintőre megyek”. |
| **2. Mikor lesz az esküvő?** | **Dátumválasztó**, mellette bizonytalansági opció. A dátum zárt, validálandó adat; szabad szöveggel csak formátumhibák keletkeznének. | „Pontos dátum” → naptár; „Csak a hónap ismert” → év és hónap; „Még nincs dátum”. | **Beállítás/kontextus**: projekt dátuma, RSVP- és feladatütemezés. Nem hoz létre vendéget vagy szabályt. | Nem. Az ülésrend dátum nélkül is elkészíthető. |
| **3. Körülbelül hány vendéggel számoltok?** Átfogalmazva: **„Körülbelül hány ülőhelyre készüljünk?”** | **Számmező** „becsült” jelöléssel. A „30 alatt / 30–60” kategóriák adatot veszítenek, miközben a teremkapacitáshoz szám kell. Ha már van vendéglista, ezt ne kérdezze a rendszer, hanem számolja ki. | Pozitív egész szám; „Ez csak becslés”; „Még nem tudjuk”. Érdemes külön megjeleníteni: meghívottak száma és jelenleg visszaigazolt résztvevők száma. | Csak **kapacitásbecslési kontextus**. Nem szabad ennyi névtelen vendégrekordot létrehozni. A valódi vendéglista később felülírja. | Nem; csak vendéglista hiányában kérdezhető. |
| **4. Mi a pár két tagjának neve?** | **Két szabad szöveges névmező.** A név nyitott adat. Diktálás engedhető, de a felismert neveket kötelező visszaigazolni. | „Első fél neve”; „Második fél neve”; opcionálisan „A projekt megjelenített neve”. Ne használjon „menyasszony/vőlegény” rögzített szerepeket. | **Beállítás/kontextus**: projektcím, dinamikus csoportnevek, export fejléc. Nem automatikusan vendéglista-rekord. | Nem. Alapértelmezett projektcím lehet „Esküvőnk”. |
| **5. Van már vendéglistátok?** | **Kombinált: gombos útvonal + fájlfeltöltés.** A már létező adatot nem szabad újragépeltetni. Feltöltés után mindig legyen előnézet, oszloptérképezés és megerősítés. | „Fájlból importálom”; „Másolás és beillesztés táblázatból”; „Kézzel kezdem el”; „Még nincs vendéglistánk”; „Ezt most kihagyom”. Fájlok: XLSX/XLS, CSV, DOCX, PDF, PNG, JPG, HEIC. | Megerősítés után **vendéglista**; explicit oszlopokból RSVP-státusz, elérhetőség, meghívási egység és vendégcsoport is. Ismeretlen oszlopot nem szabad automatikusan privát jegyzetként eltárolni. | Nem. Az import megerősítése viszont kötelező az adatok tényleges létrehozása előtt. |
| **6. Milyen nagyobb vendégcsoportokkal számoljunk?** | **Kombinált: javasolt csoportgombok + egyedi név + vendégek hozzárendelése.** Egy üres csoportnév önmagában nem használható; minden csoporthoz tagokat is ki kell választani vagy importoszlopot kell rendelni. | „[Első fél] közeli családja”; „[Első fél] tágabb rokonsága”; „[Második fél] közeli családja”; „[Második fél] tágabb rokonsága”; „Közös barátok”; „[Első fél] barátai”; „[Második fél] barátai”; „Kollégák”; „Iskolai/egyetemi társaság”; „Szomszédok/helyi közösség”; „Másik társaság…”; „Nem szeretnénk csoportokat használni”. Egy vendég több csoport tagja is lehet. | **Vendégcsoportok és tagságuk**. Önmagában még nem ülési szabály. | Nem. Csak létező vendégek után érdemes kérdezni. |
| **7. Mi legyen az alapértelmezett szabály a pároknál és családoknál?** | **Két külön egyválasztós gombcsoport.** A „pár” és a „család” nem ugyanaz a kapcsolat, és külön erősség kell. Csak már azonosított kapcsolatokra alkalmazható. | **Párok:** „Egymás mellett – kemény szabály”; „Egy asztalnál – kemény szabály”; „Lehetőleg egymás mellett – lágy szabály”; „Nincs általános szabály”. **Együtt meghívott/háztartási egységek:** „Egy asztalnál – kemény”; „Lehetőleg egy asztalnál – lágy”; „Nincs általános szabály”. | **Ültetési szabály**, választástól függően kemény vagy lágy. | Nem. Kihagyáskor ne keletkezzen rejtett alapértelmezett szabály. |
| **8. Van érzékeny családi vagy személyes helyzet?** Átfogalmazva: **„Van két vendég, akiket az ültetésnél külön kell kezelni?”** | **Kombinált, strukturált szabályszerkesztő.** Először igen/nem/később, majd két vendég kiválasztása és a szükséges távolság. Szabad történetmező alapból ne legyen. | „Nincs ilyen”; „Igen, hozzáadok egy elkülönítési szabályt”; „Később adom meg”. Szabálytípus: „Ne kerüljenek egy asztalhoz – kemény”; „Ne üljenek egymás mellett – kemény”; „Lehetőleg külön asztalhoz kerüljenek – lágy”. | **Kemény vagy lágy ültetési szabály** két vendég között. Indoklás nem szükséges. | Nem. Vendéglista előtt ne jelenjen meg. |
| **9. Megvan már a helyszín?** | **Egyválasztós gombok + opcionális névmező.** Csak útvonalat választ; a puszta igen/nem nem hoz létre használható termet. | „Igen, végleges”; „Van kiszemelt helyszín, de még változhat”; „Még nincs helyszín”; „Kihagyom”. „Igen” esetén opcionális: helyszín neve, terem neve, település. | **Terem alapadata**, ha nevet is megadnak; egyébként csak **kontextus/státusz**. | Nem. Összevonható a 10. kérdés kezdőállapotával. |
| **10. Mit tudunk most a teremről?** | **Kombinált, egyválasztós adatforrás + fájl vagy méretmezők.** A választás konkrét teremlétrehozási útvonalat indít. | „DXF teremrajz feltöltése”; „Méretezett PDF-alaprajz feltöltése”; „Kép vagy képernyőkép feltöltése és egy ismert méret megadása”; „Téglalap alakú terem méreteinek megadása”; „Üres vásznon rajzolom meg”; „Még nincs teremadatunk”. Méretmegadás: hossz, szélesség, mértékegység. | Ellenőrzés után **terem**, falak és alaprajzi elemek. Egy nem méretezett kép önmagában csak háttérreferencia lehet. | Nem az onboardinghoz. Teremalap szükséges a térbeli ültetéshez, de később is elkészíthető. |
| **11. Milyen asztalok vannak?** | **Ismételhető strukturált űrlap.** Az alak önmagában kevés: darabszám, férőhely és lehetőleg méret is kell. | Alak: „Körasztal”; „Téglalap alakú asztal”; „Ovális asztal”; „Összetolt asztalsor”; „Egyedi alak vagy méret”. Minden típusnál: darabszám, ülőhely/asztal, méretek, „Fix helyen van / Mozgatható”. Plusz: „Egyenként a teremtervezőben adom hozzá”; „Még nem tudjuk”. | **Asztalobjektumok**, férőhelyekkel és geometriai adatokkal. | Nem az onboardinghoz; legalább egy ülőhellyel rendelkező asztal szükséges az ültetés elkezdéséhez. |
| **12. Mely területeket kell figyelembe vennünk?** | **Többválasztós gombok + kötelező elhelyezés a rajzon.** Egy címke koordináta és méret nélkül nem használható. | „Tánctér”; „Színpad”; „DJ vagy zenekar”; „Bejárat”; „Kijárat/vészkijárat”; „Közlekedő- vagy felszolgálóút”; „Oszlop”; „Bár”; „Büfé”; „Tortaasztal”; „Mosdó iránya”; „Gyereksarok”; „Fotósarok”; „Akadálymentes útvonal”; „Másik terület…”. Minden kiválasztott elemet el kell helyezni és méretezni. | **Teremzóna vagy akadály**; szükség szerint kemény távolsági/ütközési korlát. | Nem. Pontos konfliktus-ellenőrzéshez a valóban létező fix elemeket később rögzíteni kell. |
| **13. Mitől lenne igazán jó az ültetés?** | **Sorrendezett többválasztás, legfeljebb három prioritással, plusz „egyéb”.** A gépi döntéshez strukturált súlyok kellenek. A szabad mondat önmagában nem válhat automatikusan szabállyá. | „A megjelölt társaságok maradjanak együtt”; „Az együtt meghívott egységek maradjanak egy asztalnál”; „Keveredjenek a különböző társaságok”; „Legyen kiegyensúlyozott az asztalok létszáma”; „A megjelölt kiemelt vendégek legyenek közel a párhoz”; „A nyugodtabb és élénkebb zónákhoz igazodjanak a megadott preferenciák”; „Nincs külön prioritás”; „Más szempont…”. | A strukturált választás **lágy ültetési szabályokat és prioritási súlyokat** tölt fel. Az „egyéb” szöveg csak **privát jegyzet/kontextus**, amíg a felhasználó nem alakítja át konkrét szabállyá. | Nem. Kézi ültetésnél is használható ellenőrzőlista, nem csak AI-input. |
| **14. Van olyan információ, ami befolyásolhatja, hogy valaki hol üljön?** Átfogalmazva: **„Van vendég, akinek konkrét elhelyezésre van szüksége?”** | **Kombinált, strukturált elhelyezési szabály.** Vendég + hely/terület + közel/távol + kemény/lágy. Nem kérhet diagnózist vagy személyes történetet. | „Nincs ilyen”; „Igen, hozzáadok elhelyezési igényt”; „Később”. Elhelyezés: „Be-/kijárat közelében”; „Mosdó közelében”; „Akadálymentes útvonal mentén”; „Több szabad hellyel a szék körül”; „Hangfaltól vagy színpadtól távol”; „A párhoz vagy színpadhoz közel”; „Meghatározott vendég mellett/azonos asztalnál”; „Másik kijelölt zónához közel vagy attól távol”. Erősség: „Szükséges – kemény”; „Előnyös – lágy”. | **Kemény vagy lágy ültetési szabály** vendég és személy/zóna között. Rövid operatív megjegyzés csak külön **privát jegyzetként**. | Nem. |
| **15. Mivel kezdjek inkább?** | **Egyválasztós navigációs gombok.** Ez nem interjúkérdés, hanem folyamatosan elérhető következő lépés. A rendszer ajánlhat, de nem kényszeríthet AI-ra. | „Vendéglista létrehozása vagy importálása”; „RSVP beállítása”; „Terem és asztalok megrajzolása”; „Kézi ültetés elkezdése”; „Automatikus, AI-alapú ülésjavaslat kérése”; „Meglévő terv konfliktusainak ellenőrzése”; „Projektáttekintő megnyitása”. A nem elérhető műveletnél jelenjen meg a hiányzó előfeltétel. | Csak **navigációs beállítás/kontextus**. | Nem. Ennek már az első rövid képernyő után elérhetőnek kell lennie. |
| **16. Töröljük a 0. lépés mentett válaszait ezen a gépen?** | **Nem onboarding-kérdés, hanem destruktív beállítási művelet.** Kerüljön a „Folytatás” kártyára és az adatvédelmi beállításokba. | Gomb: „Helyi onboarding-mentés törlése”. Megerősítés: „Csak ezen a böngészőn tárolt, be nem fejezett onboarding-válaszok törlődnek. A létrehozott projekt, vendégek, terem és ültetés nem törlődik.” Gombok: „Mégse”; „Helyi mentés végleges törlése”. | **Sehová nem folyik be**; ez törlési művelet, nem válasz. | Nem. El kell távolítani a 16 kérdés közül. |

## C) Helyes sorrend, kötelezőség és korai kilépés

### Javasolt sorrend

**1. Rövid induló képernyő**

1. „Mi van már meg?” – jelenlegi 1.
2. A pár neve, dátum és becsült létszám egyetlen, átugorható „Esküvő alapadatai” kártyán – jelenlegi 4., 2., 3.
3. „Mivel szeretnétek most foglalkozni?” – jelenlegi 15.

A harmadik pont után a felhasználó már elhagyhatja az onboardingot.

**2/A. Vendégág**

1. Vendéglista létrehozása/importálása – 5.
2. Import-előnézet és kézi megerősítés.
3. Meghívási egységek/párkapcsolatok rögzítése – hiányzó kérdés.
4. Vendégcsoportok és tagok – 6.
5. Párok és meghívási egységek alapértelmezett szabályai – 7.
6. Általános ültetési prioritások – 13.
7. Konkrét elkülönítések – 8.
8. Konkrét elhelyezési igények – 14.

**2/B. Teremág**

1. Helyszín állapota – 9.
2. Teremadat forrása – 10.
3. Asztaltípusok, darabszám és férőhely – 11.
4. Fix zónák és akadályok – 12.

**2/C. RSVP-ág**

A már létező RSVP-adatok importálása vagy az új RSVP-folyamat beállítása. Ez jelenleg hiányzik az interjúból.

### Mi legyen ténylegesen kötelező?

Az onboarding megkezdéséhez semmi. Funkciószinten viszont:

- Vendég importálásakor kötelező az import-előnézet megerősítése.
- Ültetéshez legalább egy aktív vendég és egy szabad ülőhely kell.
- Konfliktusszabályhoz ki kell választani a szabály alanyait és erősségét.
- Térbeli elhelyezési szabályhoz kell megfelelő teremzóna.
- AI-javaslathoz ugyanazok az előfeltételek kellenek, mint a kézi ültetéshez; az AI nem igényelhet külön, kötelező onboarding-adatot.

### Korai, hasznos kilépési pontok

- **Az induló képernyő után:** üres vendéglista-, RSVP- vagy teremtervező megnyitása.
- **Sikeres vendégimport után:** azonnal a vendéglista és RSVP kezelése.
- **Az első asztalok létrehozása után:** azonnal a drag-and-drop teremtervező.
- **Vendégek és asztalok megléte után:** azonnal kézi ültetés.
- **Az első szabály létrehozása után:** azonnali konfliktus-ellenőrzés.
- **Bármely ponton:** „Mentés és folytatás később”.

Az „élő eredmény” százaléka ne a 16 kérdésből megválaszolt darabszám legyen. Jobb állapotok:

- Vendéglista: nincs / vázlat / ellenőrzött
- RSVP: nincs beállítva / folyamatban / lezárt
- Terem és asztalok: nincs / vázlat / használható
- Szabályok: nincs / alapok megadva
- Ültetés: nem kezdődött / folyamatban / ellenőrzött / jóváhagyott

## D) Hiányzó kérdések

### 1. Meghívási egységek és kapcsolatok

**Kérdés:** „Kik tartoznak egy közös meghíváshoz vagy együtt kezelendő egységhez?”

Bevitel:

- importoszlop hozzárendelése;
- vendégek kijelölése és „Közös meghívási egység létrehozása”;
- két vendégnél opcionális „Párként kezeljük”;
- „Nincsenek ilyen egységek”;
- „Később adom meg”.

**Mit tölt fel:** vendéglista-kapcsolatok/RSVP-egység, valamint a 7. kérdés szabályainak alanyai. Enélkül a rendszer nem tudja, kikre vonatkozik a „párok maradjanak együtt” szabály.

### 2. Meglévő RSVP-válaszok

**Kérdés:** „Van már vendégenkénti részvételi válaszotok?”

Opciók:

- „Igen, a vendéglistás fájl tartalmazza”
- „Igen, külön fájlból importálom”
- „Még gyűjtjük a válaszokat”
- „A LumaSeatben szeretnénk elindítani az RSVP-t”
- „Most nem foglalkozunk vele”

Importálható státuszok:

- „Meghívva, még nem válaszolt”
- „Részt vesz”
- „Nem vesz részt”
- „Bizonytalan”
- „Lemondta”

**Mit tölt fel:** vendégenkénti RSVP-státusz. A „nem vesz részt” vendégeket nem szabad törölni, csak alapból kizárni az ültetendők közül.

### 3. Mit gyűjtsön az RSVP?

**Kérdés:** „Milyen adatokat kérjünk be az RSVP során?”

Opciók:

- „Részvétel” – mindig
- „Kísérő neve”
- „Felnőttek és gyerekek száma”
- „Menüválasztás”
- „Étrendi kiszolgálási igény”
- „Etetőszék szükséges”
- „Konkrét elhelyezési igény”
- „Egyiket sem, csak a részvételt”

**Mit tölt fel:** RSVP-űrlap beállítása és vendégadatok. Az étrendi vagy elhelyezési igénynél csak operatív információt szabad kérni, diagnózist nem.

### 4. Jóváhagyás

**Kérdés:** „Kinek kell jóváhagynia a végleges ülésrendet?”

Opciók:

- „Mindketten jóváhagyjuk”
- „Egyikünk véglegesíti”
- „Megosztási linken külső véleményezőt is bevonunk”
- „Nem kell külön jóváhagyási lépés”

**Mit tölt fel:** jóváhagyási és megosztási beállítás. Ezt nem az első onboardingban, hanem az első teljes terv elkészülésekor kell megkérdezni.

### 5. Átadás és export

**Kérdés:** „Kinek és milyen formában kell majd átadni az adatokat?”

Címzettek:

- „Helyszín”
- „Catering”
- „Dekoros”
- „Nyomda”
- „Más címzett…”

Formátumok:

- „PDF ülésrend”
- „CSV vendég- és asztallista”
- „HTML megosztási nézet”
- „Teremrajz”

Plusz opcionális átadási határidő.

**Mit tölt fel:** exportpreset és projekt-határidő. Ezt elég az exportálás közeledtével kérdezni.

## E) Felesleges vagy rosszul feltett kérdések

- **1. „Hol tartotok?”** túl általános, és átfed az 5., 9., 10. és 11. kérdéssel. Konkrét meglévő eszközök ellenőrzőlistájává kell alakítani, majd a tényleges projektállapotból automatikusan frissíteni.
- **3. Létszám:** vendéglista után már kikövetkeztethető. Csak vendéglista hiányában indokolt, és akkor is ülőhely-becslést kell kérni, nem intervallumot.
- **5. „Van vendéglistátok?”** a jelenlegi formában túl sok különböző minőségű fájlt kezel azonos ígérettel. Importfolyamatot, nem igen/nem kérdést kell indítania.
- **6. Vendégcsoportok:** tagok hozzárendelése nélkül üres címkéket hoz létre, amelyek nem segítik az ültetést.
- **7. Párok és családok:** két külön fogalmat mos össze. A „család” lehet háztartás, rokonság vagy vendégcsoport; ezeket nem szabad ugyanazzal a szabállyal kezelni.
- **8. Érzékeny helyzet:** személyes történet elmesélésére csábít, miközben a rendszernek csak két vendég és egy távolsági szabály kell.
- **9–10. Helyszín és terem:** jelentős átfedés van köztük. A 9. csak elágazás legyen, a 10. konkrét adatbeviteli mód.
- **11. Asztalok:** alak megkérdezése darabszám, kapacitás és méret nélkül nem használható.
- **12. Területek:** felsorolás koordináta és méret nélkül nem kerülhet be valódi teremobjektumként.
- **13. „Mitől lenne igazán jó?”** kutatási interjúkérdésnek jó, termékbeviteli kérdésnek csak akkor, ha strukturált prioritásokká alakul.
- **14. „Van olyan információ…”** túl tág, átfed a 8. kérdéssel, és egészségügyi vagy más különleges adatok megadására ösztönözhet.
- **15. „Mivel kezdjek?”** navigáció, nem az interjú végi kérdés. Már a folyamat elejétől láthatónak kell lennie.
- **16. Törlés:** nem termékadat, nem onboarding-kérdés, és nem számíthat bele a készültségi százalékba.

## F) Érzékeny, harmadik félre vonatkozó adatok

### A 8. kérdés helyes adatminimalizálása

Ne ezt kérdezzük:

> „Írjátok le az érzékeny családi vagy személyes helyzetet.”

Hanem ezt:

> „Van két vendég, akiket az ültetésnél külön kell kezelni? Nem kell megadnotok az okát.”

A szükséges adatok kizárólag:

- első vendég;
- második vendég;
- szükséges elkülönítés;
- kemény vagy lágy szabály.

Nem szükséges tudni, hogy válás, családi vita, korábbi kapcsolat vagy más konfliktus áll-e mögötte.

### A 14. kérdés helyes megfogalmazása

Ne kérdezze a rendszer:

- „Milyen betegsége van?”
- „Fogyatékkal él?”
- „Miért kell közel ülnie a kijárathoz?”
- „Van pszichés vagy egészségügyi problémája?”
- „Milyen vallási/egészségügyi okból kéri ezt?”

Helyette:

> „Milyen konkrét elhelyezés segíti a vendéget? Az okát nem szükséges megadni.”

Például:

- akadálymentes útvonal szükséges;
- több szabad hely szükséges a szék körül;
- legyen távol a hangfaltól;
- legyen közel a kijárathoz;
- üljön egy megjelölt kísérő mellett.

Ez funkcionális igényt rögzít, nem diagnózist.

### Mit kell közölni a felhasználóval?

A kérdések mellett, nem csak az általános adatkezelési tájékoztatóban:

> „Csak az ültetéshez feltétlenül szükséges információt add meg. Ne írj be diagnózist, egészségügyi adatot vagy a konfliktus részletes történetét.”

A felhasználónak egyértelműen látnia kell:

- milyen célból tárolódik az adat;
- kik férhetnek hozzá a projektben;
- a szabály nem jelenik meg a PDF-, CSV- vagy HTML-exportban;
- a privát jegyzet alapból minden exportból és nyilvános megosztásból ki van zárva;
- a szabály vagy jegyzet külön törölhető;
- meddig tárolódik, illetve a projekt törlésével mi történik vele;
- az eszközön mentett, befejezetlen onboarding-adat külön törölhető;
- mi történik akkor, ha a felhasználó AI-ültetést kér.

AI használatakor különösen fontos:

- a kézi ültetés és a determinisztikus konfliktus-ellenőrzés AI nélkül is működjön;
- a privát szöveges jegyzet ne kerüljön automatikusan AI-feldolgozásba;
- a rendszer előre jelezze, mely strukturált szabályokat használja az AI-javaslathoz;
- lehessen egy szabályt kizárni az AI-feldolgozásból úgy, hogy a kézi ellenőrzésben továbbra is aktív maradjon.

A pontos adatkezelői/adatfeldolgozói szerepeket és megőrzési időket a tényleges technikai és jogi működés alapján kell feltüntetni; ezeket a felület nem állíthatja általánosságban ellenőrzés nélkül.

## G) A fájlfeltöltés realitása

| Formátum | Mi nyerhető ki reálisan? | Mihez kell megerősítés? | Tipikus csendes adatvesztés |
|---|---|---|---|
| **XLSX** | Jól strukturált táblából nevek, e-mail, telefon, RSVP-státusz, csoport, meghívási egység és más explicit oszlopok. | Munkalap kiválasztása, fejlécsor, oszloptérképezés, több személyt tartalmazó cellák, duplikátumok. | Rejtett sorok/lapok, színnel jelölt státuszok, megjegyzések, összevont cellák, áthúzott lemondások, képletek, több vendég egy cellában. |
| **Régi XLS** | Alap cellaértékek sok esetben kinyerhetők, de kevésbé kiszámítható. | Ugyanaz, mint XLSX-nél; problémás fájlnál kérjen XLSX- vagy CSV-exportot. | Régi kódolás, formázási jelentés, makrók, sérült vagy jelszavas fájl. |
| **CSV** | A legmegbízhatóbb egyszerű táblás formátum: egy sor/vendég és egyértelmű fejlécek esetén jól importálható. | Elválasztójel, karakterkódolás, oszlopok jelentése, dátumformátum, többértékű mezők. | Elvesző kezdő nullák telefonszámnál, hibás ékezetek, vesszők miatti oszlopcsúszás, Excel által átírt dátumok és azonosítók. |
| **DOCX-táblázat** | Valódi Word-táblából nevek és oszlopok részben megbízhatóan kinyerhetők. | Minden felismert sort át kell nézni; különösen összevont celláknál és több táblánál. | Fejléc/lábléc, megjegyzések, követett változások, színkódok, egymásba ágyazott táblák. |
| **DOCX szöveg vagy felsorolás** | Nevek és sorok felismerhetők, de a mezők kapcsolata bizonytalan. | Gyakorlatilag minden vendégrekord kézi jóváhagyást igényel. | Párok egy sorban, gyermekek behúzással, zárójeles plusz egy fő, törölt vagy áthúzott elemek. |
| **Szöveges PDF** | Szöveg kinyerhető, egyszerű táblázat néha rekonstruálható. | Oszlopsorrend, sortörések, többoldalas táblák és minden bizonytalan rekord. | A vizuális táblázat olvasási sorrendje szétesik; fejléc ismétlődik; név és RSVP-státusz más sorhoz kapcsolódik. |
| **Szkennelt PDF** | OCR-rel nevek és rövid szövegek felismerhetők. | Minden rekord, különösen ékezetes vagy kézzel írt tartalom. | Kimaradó sorok, összekevert karakterek, elvesző pipák, áthúzások és színkódok. |
| **PNG/JPG/HEIC/képernyőkép** | Jó felbontású, egyszerű képből névlista OCR-rel előállítható. | Minden név, sorhatár, státusz és oszlopkapcsolat. Ezt „felismert vázlatként”, nem kész importként kell kezelni. | Levágott sorok, görgetés miatt hiányzó részek, checkboxok, ikonok, színek, csoportfejlécek, egymás alá tördelt nevek. |
| **Fényképezett kézírás** | Legfeljebb import-előkészítő segítségként használható. | Teljes kézi ellenőrzés vagy átírás. | Nevek téves felismerése vagy teljes kihagyása; semmilyen automatikus véglegesítés nem elfogadható. |

### Kötelező importfolyamat

Minden formátumnál:

1. fájl feltöltése;
2. felismert adatok előnézete;
3. oszlopok kézi hozzárendelése;
4. eredeti sor és felismert rekord egymás melletti megjelenítése;
5. alacsony megbízhatóságú sorok megjelölése;
6. duplikátum- és hiányellenőrzés;
7. importált, kihagyott és bizonytalan rekordok darabszámának kijelzése;
8. csak ezután: „Megerősítem és létrehozom a vendégeket”.

Különösen veszélyes csendes adatvesztési források:

- színnel jelölt vendégcsoport vagy RSVP-státusz;
- áthúzással jelölt lemondás;
- rejtett sor vagy munkalap;
- több vendég egy cellában;
- „+1”, „és családja”, „2 gyerek” típusú tömör jelölés;
- megjegyzésben tárolt fontos adat;
- képletből számolt, de nem tárolt érték;
- azonos nevű vendégek automatikus összevonása;
- OCR-rel rosszul felismert magyar ékezetes nevek;
- pár- vagy háztartási kapcsolat automatikus kikövetkeztetése.

A rendszer soha ne állítsa, hogy egy PDF-ből vagy képből „sikeresen importálta a vendéglistát”, amíg a felhasználó nem erősítette meg a felismert rekordokat. Ezeknél a helyes státusz: **„Felismerési vázlat – ellenőrzés szükséges.”**
tokens used
20,396
Az onboarding helyes formája nem 16 kötelező kérdés egymás után, hanem egy rövid útvonalválasztó és három elágazó munkafolyamat:

1. vendégek és RSVP,
2. terem és asztalok,
3. ültetési szabályok.

Minden ág után ki kell engedni a felhasználót a tényleges szerkesztőbe. Az AI-ültetés csak az egyik választható cél; ugyanazok az adatok a kézi ültetést és a konfliktus-ellenőrzést is szolgálják.

## A–B) Kérdésenkénti definíció

A „kötelező” itt onboarding-kaput jelent. A termékbe való belépéshez egyik tartalmi kérdés sem lehet kötelező; egyes adatok csak egy adott funkció használatához szükségesek.

| Kérdés | Beviteli mód és indoklás | Pontos opciók | Mit tölt fel | Kötelező-e? |
|---|---|---|---|---|
| **1. Hol tartotok jelenleg?** Átfogalmazva: **„Mi van már meg?”** | **Többválasztós gombok.** Ezek zárt, egymástól független állapotok, amelyekből a rendszer útvonalat választ. A „most kezdjük / már haladtunk” típusú egyetlen válasz túl pontatlan. | „Van vendéglistánk”; „Vannak már vendégenkénti RSVP-válaszaink”; „A helyszín végleges”; „Van teremrajzunk vagy alaprajzunk”; „Ismerjük az asztalokat és a férőhelyeket”; „Van már ültetési vázlatunk”; „Még egyik sem” – ez utóbbi kizárja a többit. | Csak **beállítás/kontextus és útvonalválasztás**. Később a rendszernek felül kell írnia a tényleges projektállapot alapján. | Nem. Legyen „Kihagyom, az áttekintőre megyek”. |
| **2. Mikor lesz az esküvő?** | **Dátumválasztó**, mellette bizonytalansági opció. A dátum zárt, validálandó adat; szabad szöveggel csak formátumhibák keletkeznének. | „Pontos dátum” → naptár; „Csak a hónap ismert” → év és hónap; „Még nincs dátum”. | **Beállítás/kontextus**: projekt dátuma, RSVP- és feladatütemezés. Nem hoz létre vendéget vagy szabályt. | Nem. Az ülésrend dátum nélkül is elkészíthető. |
| **3. Körülbelül hány vendéggel számoltok?** Átfogalmazva: **„Körülbelül hány ülőhelyre készüljünk?”** | **Számmező** „becsült” jelöléssel. A „30 alatt / 30–60” kategóriák adatot veszítenek, miközben a teremkapacitáshoz szám kell. Ha már van vendéglista, ezt ne kérdezze a rendszer, hanem számolja ki. | Pozitív egész szám; „Ez csak becslés”; „Még nem tudjuk”. Érdemes külön megjeleníteni: meghívottak száma és jelenleg visszaigazolt résztvevők száma. | Csak **kapacitásbecslési kontextus**. Nem szabad ennyi névtelen vendégrekordot létrehozni. A valódi vendéglista később felülírja. | Nem; csak vendéglista hiányában kérdezhető. |
| **4. Mi a pár két tagjának neve?** | **Két szabad szöveges névmező.** A név nyitott adat. Diktálás engedhető, de a felismert neveket kötelező visszaigazolni. | „Első fél neve”; „Második fél neve”; opcionálisan „A projekt megjelenített neve”. Ne használjon „menyasszony/vőlegény” rögzített szerepeket. | **Beállítás/kontextus**: projektcím, dinamikus csoportnevek, export fejléc. Nem automatikusan vendéglista-rekord. | Nem. Alapértelmezett projektcím lehet „Esküvőnk”. |
| **5. Van már vendéglistátok?** | **Kombinált: gombos útvonal + fájlfeltöltés.** A már létező adatot nem szabad újragépeltetni. Feltöltés után mindig legyen előnézet, oszloptérképezés és megerősítés. | „Fájlból importálom”; „Másolás és beillesztés táblázatból”; „Kézzel kezdem el”; „Még nincs vendéglistánk”; „Ezt most kihagyom”. Fájlok: XLSX/XLS, CSV, DOCX, PDF, PNG, JPG, HEIC. | Megerősítés után **vendéglista**; explicit oszlopokból RSVP-státusz, elérhetőség, meghívási egység és vendégcsoport is. Ismeretlen oszlopot nem szabad automatikusan privát jegyzetként eltárolni. | Nem. Az import megerősítése viszont kötelező az adatok tényleges létrehozása előtt. |
| **6. Milyen nagyobb vendégcsoportokkal számoljunk?** | **Kombinált: javasolt csoportgombok + egyedi név + vendégek hozzárendelése.** Egy üres csoportnév önmagában nem használható; minden csoporthoz tagokat is ki kell választani vagy importoszlopot kell rendelni. | „[Első fél] közeli családja”; „[Első fél] tágabb rokonsága”; „[Második fél] közeli családja”; „[Második fél] tágabb rokonsága”; „Közös barátok”; „[Első fél] barátai”; „[Második fél] barátai”; „Kollégák”; „Iskolai/egyetemi társaság”; „Szomszédok/helyi közösség”; „Másik társaság…”; „Nem szeretnénk csoportokat használni”. Egy vendég több csoport tagja is lehet. | **Vendégcsoportok és tagságuk**. Önmagában még nem ülési szabály. | Nem. Csak létező vendégek után érdemes kérdezni. |
| **7. Mi legyen az alapértelmezett szabály a pároknál és családoknál?** | **Két külön egyválasztós gombcsoport.** A „pár” és a „család” nem ugyanaz a kapcsolat, és külön erősség kell. Csak már azonosított kapcsolatokra alkalmazható. | **Párok:** „Egymás mellett – kemény szabály”; „Egy asztalnál – kemény szabály”; „Lehetőleg egymás mellett – lágy szabály”; „Nincs általános szabály”. **Együtt meghívott/háztartási egységek:** „Egy asztalnál – kemény”; „Lehetőleg egy asztalnál – lágy”; „Nincs általános szabály”. | **Ültetési szabály**, választástól függően kemény vagy lágy. | Nem. Kihagyáskor ne keletkezzen rejtett alapértelmezett szabály. |
| **8. Van érzékeny családi vagy személyes helyzet?** Átfogalmazva: **„Van két vendég, akiket az ültetésnél külön kell kezelni?”** | **Kombinált, strukturált szabályszerkesztő.** Először igen/nem/később, majd két vendég kiválasztása és a szükséges távolság. Szabad történetmező alapból ne legyen. | „Nincs ilyen”; „Igen, hozzáadok egy elkülönítési szabályt”; „Később adom meg”. Szabálytípus: „Ne kerüljenek egy asztalhoz – kemény”; „Ne üljenek egymás mellett – kemény”; „Lehetőleg külön asztalhoz kerüljenek – lágy”. | **Kemény vagy lágy ültetési szabály** két vendég között. Indoklás nem szükséges. | Nem. Vendéglista előtt ne jelenjen meg. |
| **9. Megvan már a helyszín?** | **Egyválasztós gombok + opcionális névmező.** Csak útvonalat választ; a puszta igen/nem nem hoz létre használható termet. | „Igen, végleges”; „Van kiszemelt helyszín, de még változhat”; „Még nincs helyszín”; „Kihagyom”. „Igen” esetén opcionális: helyszín neve, terem neve, település. | **Terem alapadata**, ha nevet is megadnak; egyébként csak **kontextus/státusz**. | Nem. Összevonható a 10. kérdés kezdőállapotával. |
| **10. Mit tudunk most a teremről?** | **Kombinált, egyválasztós adatforrás + fájl vagy méretmezők.** A választás konkrét teremlétrehozási útvonalat indít. | „DXF teremrajz feltöltése”; „Méretezett PDF-alaprajz feltöltése”; „Kép vagy képernyőkép feltöltése és egy ismert méret megadása”; „Téglalap alakú terem méreteinek megadása”; „Üres vásznon rajzolom meg”; „Még nincs teremadatunk”. Méretmegadás: hossz, szélesség, mértékegység. | Ellenőrzés után **terem**, falak és alaprajzi elemek. Egy nem méretezett kép önmagában csak háttérreferencia lehet. | Nem az onboardinghoz. Teremalap szükséges a térbeli ültetéshez, de később is elkészíthető. |
| **11. Milyen asztalok vannak?** | **Ismételhető strukturált űrlap.** Az alak önmagában kevés: darabszám, férőhely és lehetőleg méret is kell. | Alak: „Körasztal”; „Téglalap alakú asztal”; „Ovális asztal”; „Összetolt asztalsor”; „Egyedi alak vagy méret”. Minden típusnál: darabszám, ülőhely/asztal, méretek, „Fix helyen van / Mozgatható”. Plusz: „Egyenként a teremtervezőben adom hozzá”; „Még nem tudjuk”. | **Asztalobjektumok**, férőhelyekkel és geometriai adatokkal. | Nem az onboardinghoz; legalább egy ülőhellyel rendelkező asztal szükséges az ültetés elkezdéséhez. |
| **12. Mely területeket kell figyelembe vennünk?** | **Többválasztós gombok + kötelező elhelyezés a rajzon.** Egy címke koordináta és méret nélkül nem használható. | „Tánctér”; „Színpad”; „DJ vagy zenekar”; „Bejárat”; „Kijárat/vészkijárat”; „Közlekedő- vagy felszolgálóút”; „Oszlop”; „Bár”; „Büfé”; „Tortaasztal”; „Mosdó iránya”; „Gyereksarok”; „Fotósarok”; „Akadálymentes útvonal”; „Másik terület…”. Minden kiválasztott elemet el kell helyezni és méretezni. | **Teremzóna vagy akadály**; szükség szerint kemény távolsági/ütközési korlát. | Nem. Pontos konfliktus-ellenőrzéshez a valóban létező fix elemeket később rögzíteni kell. |
| **13. Mitől lenne igazán jó az ültetés?** | **Sorrendezett többválasztás, legfeljebb három prioritással, plusz „egyéb”.** A gépi döntéshez strukturált súlyok kellenek. A szabad mondat önmagában nem válhat automatikusan szabállyá. | „A megjelölt társaságok maradjanak együtt”; „Az együtt meghívott egységek maradjanak egy asztalnál”; „Keveredjenek a különböző társaságok”; „Legyen kiegyensúlyozott az asztalok létszáma”; „A megjelölt kiemelt vendégek legyenek közel a párhoz”; „A nyugodtabb és élénkebb zónákhoz igazodjanak a megadott preferenciák”; „Nincs külön prioritás”; „Más szempont…”. | A strukturált választás **lágy ültetési szabályokat és prioritási súlyokat** tölt fel. Az „egyéb” szöveg csak **privát jegyzet/kontextus**, amíg a felhasználó nem alakítja át konkrét szabállyá. | Nem. Kézi ültetésnél is használható ellenőrzőlista, nem csak AI-input. |
| **14. Van olyan információ, ami befolyásolhatja, hogy valaki hol üljön?** Átfogalmazva: **„Van vendég, akinek konkrét elhelyezésre van szüksége?”** | **Kombinált, strukturált elhelyezési szabály.** Vendég + hely/terület + közel/távol + kemény/lágy. Nem kérhet diagnózist vagy személyes történetet. | „Nincs ilyen”; „Igen, hozzáadok elhelyezési igényt”; „Később”. Elhelyezés: „Be-/kijárat közelében”; „Mosdó közelében”; „Akadálymentes útvonal mentén”; „Több szabad hellyel a szék körül”; „Hangfaltól vagy színpadtól távol”; „A párhoz vagy színpadhoz közel”; „Meghatározott vendég mellett/azonos asztalnál”; „Másik kijelölt zónához közel vagy attól távol”. Erősség: „Szükséges – kemény”; „Előnyös – lágy”. | **Kemény vagy lágy ültetési szabály** vendég és személy/zóna között. Rövid operatív megjegyzés csak külön **privát jegyzetként**. | Nem. |
| **15. Mivel kezdjek inkább?** | **Egyválasztós navigációs gombok.** Ez nem interjúkérdés, hanem folyamatosan elérhető következő lépés. A rendszer ajánlhat, de nem kényszeríthet AI-ra. | „Vendéglista létrehozása vagy importálása”; „RSVP beállítása”; „Terem és asztalok megrajzolása”; „Kézi ültetés elkezdése”; „Automatikus, AI-alapú ülésjavaslat kérése”; „Meglévő terv konfliktusainak ellenőrzése”; „Projektáttekintő megnyitása”. A nem elérhető műveletnél jelenjen meg a hiányzó előfeltétel. | Csak **navigációs beállítás/kontextus**. | Nem. Ennek már az első rövid képernyő után elérhetőnek kell lennie. |
| **16. Töröljük a 0. lépés mentett válaszait ezen a gépen?** | **Nem onboarding-kérdés, hanem destruktív beállítási művelet.** Kerüljön a „Folytatás” kártyára és az adatvédelmi beállításokba. | Gomb: „Helyi onboarding-mentés törlése”. Megerősítés: „Csak ezen a böngészőn tárolt, be nem fejezett onboarding-válaszok törlődnek. A létrehozott projekt, vendégek, terem és ültetés nem törlődik.” Gombok: „Mégse”; „Helyi mentés végleges törlése”. | **Sehová nem folyik be**; ez törlési művelet, nem válasz. | Nem. El kell távolítani a 16 kérdés közül. |

## C) Helyes sorrend, kötelezőség és korai kilépés

### Javasolt sorrend

**1. Rövid induló képernyő**

1. „Mi van már meg?” – jelenlegi 1.
2. A pár neve, dátum és becsült létszám egyetlen, átugorható „Esküvő alapadatai” kártyán – jelenlegi 4., 2., 3.
3. „Mivel szeretnétek most foglalkozni?” – jelenlegi 15.

A harmadik pont után a felhasználó már elhagyhatja az onboardingot.

**2/A. Vendégág**

1. Vendéglista létrehozása/importálása – 5.
2. Import-előnézet és kézi megerősítés.
3. Meghívási egységek/párkapcsolatok rögzítése – hiányzó kérdés.
4. Vendégcsoportok és tagok – 6.
5. Párok és meghívási egységek alapértelmezett szabályai – 7.
6. Általános ültetési prioritások – 13.
7. Konkrét elkülönítések – 8.
8. Konkrét elhelyezési igények – 14.

**2/B. Teremág**

1. Helyszín állapota – 9.
2. Teremadat forrása – 10.
3. Asztaltípusok, darabszám és férőhely – 11.
4. Fix zónák és akadályok – 12.

**2/C. RSVP-ág**

A már létező RSVP-adatok importálása vagy az új RSVP-folyamat beállítása. Ez jelenleg hiányzik az interjúból.

### Mi legyen ténylegesen kötelező?

Az onboarding megkezdéséhez semmi. Funkciószinten viszont:

- Vendég importálásakor kötelező az import-előnézet megerősítése.
- Ültetéshez legalább egy aktív vendég és egy szabad ülőhely kell.
- Konfliktusszabályhoz ki kell választani a szabály alanyait és erősségét.
- Térbeli elhelyezési szabályhoz kell megfelelő teremzóna.
- AI-javaslathoz ugyanazok az előfeltételek kellenek, mint a kézi ültetéshez; az AI nem igényelhet külön, kötelező onboarding-adatot.

### Korai, hasznos kilépési pontok

- **Az induló képernyő után:** üres vendéglista-, RSVP- vagy teremtervező megnyitása.
- **Sikeres vendégimport után:** azonnal a vendéglista és RSVP kezelése.
- **Az első asztalok létrehozása után:** azonnal a drag-and-drop teremtervező.
- **Vendégek és asztalok megléte után:** azonnal kézi ültetés.
- **Az első szabály létrehozása után:** azonnali konfliktus-ellenőrzés.
- **Bármely ponton:** „Mentés és folytatás később”.

Az „élő eredmény” százaléka ne a 16 kérdésből megválaszolt darabszám legyen. Jobb állapotok:

- Vendéglista: nincs / vázlat / ellenőrzött
- RSVP: nincs beállítva / folyamatban / lezárt
- Terem és asztalok: nincs / vázlat / használható
- Szabályok: nincs / alapok megadva
- Ültetés: nem kezdődött / folyamatban / ellenőrzött / jóváhagyott

## D) Hiányzó kérdések

### 1. Meghívási egységek és kapcsolatok

**Kérdés:** „Kik tartoznak egy közös meghíváshoz vagy együtt kezelendő egységhez?”

Bevitel:

- importoszlop hozzárendelése;
- vendégek kijelölése és „Közös meghívási egység létrehozása”;
- két vendégnél opcionális „Párként kezeljük”;
- „Nincsenek ilyen egységek”;
- „Később adom meg”.

**Mit tölt fel:** vendéglista-kapcsolatok/RSVP-egység, valamint a 7. kérdés szabályainak alanyai. Enélkül a rendszer nem tudja, kikre vonatkozik a „párok maradjanak együtt” szabály.

### 2. Meglévő RSVP-válaszok

**Kérdés:** „Van már vendégenkénti részvételi válaszotok?”

Opciók:

- „Igen, a vendéglistás fájl tartalmazza”
- „Igen, külön fájlból importálom”
- „Még gyűjtjük a válaszokat”
- „A LumaSeatben szeretnénk elindítani az RSVP-t”
- „Most nem foglalkozunk vele”

Importálható státuszok:

- „Meghívva, még nem válaszolt”
- „Részt vesz”
- „Nem vesz részt”
- „Bizonytalan”
- „Lemondta”

**Mit tölt fel:** vendégenkénti RSVP-státusz. A „nem vesz részt” vendégeket nem szabad törölni, csak alapból kizárni az ültetendők közül.

### 3. Mit gyűjtsön az RSVP?

**Kérdés:** „Milyen adatokat kérjünk be az RSVP során?”

Opciók:

- „Részvétel” – mindig
- „Kísérő neve”
- „Felnőttek és gyerekek száma”
- „Menüválasztás”
- „Étrendi kiszolgálási igény”
- „Etetőszék szükséges”
- „Konkrét elhelyezési igény”
- „Egyiket sem, csak a részvételt”

**Mit tölt fel:** RSVP-űrlap beállítása és vendégadatok. Az étrendi vagy elhelyezési igénynél csak operatív információt szabad kérni, diagnózist nem.

### 4. Jóváhagyás

**Kérdés:** „Kinek kell jóváhagynia a végleges ülésrendet?”

Opciók:

- „Mindketten jóváhagyjuk”
- „Egyikünk véglegesíti”
- „Megosztási linken külső véleményezőt is bevonunk”
- „Nem kell külön jóváhagyási lépés”

**Mit tölt fel:** jóváhagyási és megosztási beállítás. Ezt nem az első onboardingban, hanem az első teljes terv elkészülésekor kell megkérdezni.

### 5. Átadás és export

**Kérdés:** „Kinek és milyen formában kell majd átadni az adatokat?”

Címzettek:

- „Helyszín”
- „Catering”
- „Dekoros”
- „Nyomda”
- „Más címzett…”

Formátumok:

- „PDF ülésrend”
- „CSV vendég- és asztallista”
- „HTML megosztási nézet”
- „Teremrajz”

Plusz opcionális átadási határidő.

**Mit tölt fel:** exportpreset és projekt-határidő. Ezt elég az exportálás közeledtével kérdezni.

## E) Felesleges vagy rosszul feltett kérdések

- **1. „Hol tartotok?”** túl általános, és átfed az 5., 9., 10. és 11. kérdéssel. Konkrét meglévő eszközök ellenőrzőlistájává kell alakítani, majd a tényleges projektállapotból automatikusan frissíteni.
- **3. Létszám:** vendéglista után már kikövetkeztethető. Csak vendéglista hiányában indokolt, és akkor is ülőhely-becslést kell kérni, nem intervallumot.
- **5. „Van vendéglistátok?”** a jelenlegi formában túl sok különböző minőségű fájlt kezel azonos ígérettel. Importfolyamatot, nem igen/nem kérdést kell indítania.
- **6. Vendégcsoportok:** tagok hozzárendelése nélkül üres címkéket hoz létre, amelyek nem segítik az ültetést.
- **7. Párok és családok:** két külön fogalmat mos össze. A „család” lehet háztartás, rokonság vagy vendégcsoport; ezeket nem szabad ugyanazzal a szabállyal kezelni.
- **8. Érzékeny helyzet:** személyes történet elmesélésére csábít, miközben a rendszernek csak két vendég és egy távolsági szabály kell.
- **9–10. Helyszín és terem:** jelentős átfedés van köztük. A 9. csak elágazás legyen, a 10. konkrét adatbeviteli mód.
- **11. Asztalok:** alak megkérdezése darabszám, kapacitás és méret nélkül nem használható.
- **12. Területek:** felsorolás koordináta és méret nélkül nem kerülhet be valódi teremobjektumként.
- **13. „Mitől lenne igazán jó?”** kutatási interjúkérdésnek jó, termékbeviteli kérdésnek csak akkor, ha strukturált prioritásokká alakul.
- **14. „Van olyan információ…”** túl tág, átfed a 8. kérdéssel, és egészségügyi vagy más különleges adatok megadására ösztönözhet.
- **15. „Mivel kezdjek?”** navigáció, nem az interjú végi kérdés. Már a folyamat elejétől láthatónak kell lennie.
- **16. Törlés:** nem termékadat, nem onboarding-kérdés, és nem számíthat bele a készültségi százalékba.

## F) Érzékeny, harmadik félre vonatkozó adatok

### A 8. kérdés helyes adatminimalizálása

Ne ezt kérdezzük:

> „Írjátok le az érzékeny családi vagy személyes helyzetet.”

Hanem ezt:

> „Van két vendég, akiket az ültetésnél külön kell kezelni? Nem kell megadnotok az okát.”

A szükséges adatok kizárólag:

- első vendég;
- második vendég;
- szükséges elkülönítés;
- kemény vagy lágy szabály.

Nem szükséges tudni, hogy válás, családi vita, korábbi kapcsolat vagy más konfliktus áll-e mögötte.

### A 14. kérdés helyes megfogalmazása

Ne kérdezze a rendszer:

- „Milyen betegsége van?”
- „Fogyatékkal él?”
- „Miért kell közel ülnie a kijárathoz?”
- „Van pszichés vagy egészségügyi problémája?”
- „Milyen vallási/egészségügyi okból kéri ezt?”

Helyette:

> „Milyen konkrét elhelyezés segíti a vendéget? Az okát nem szükséges megadni.”

Például:

- akadálymentes útvonal szükséges;
- több szabad hely szükséges a szék körül;
- legyen távol a hangfaltól;
- legyen közel a kijárathoz;
- üljön egy megjelölt kísérő mellett.

Ez funkcionális igényt rögzít, nem diagnózist.

### Mit kell közölni a felhasználóval?

A kérdések mellett, nem csak az általános adatkezelési tájékoztatóban:

> „Csak az ültetéshez feltétlenül szükséges információt add meg. Ne írj be diagnózist, egészségügyi adatot vagy a konfliktus részletes történetét.”

A felhasználónak egyértelműen látnia kell:

- milyen célból tárolódik az adat;
- kik férhetnek hozzá a projektben;
- a szabály nem jelenik meg a PDF-, CSV- vagy HTML-exportban;
- a privát jegyzet alapból minden exportból és nyilvános megosztásból ki van zárva;
- a szabály vagy jegyzet külön törölhető;
- meddig tárolódik, illetve a projekt törlésével mi történik vele;
- az eszközön mentett, befejezetlen onboarding-adat külön törölhető;
- mi történik akkor, ha a felhasználó AI-ültetést kér.

AI használatakor különösen fontos:

- a kézi ültetés és a determinisztikus konfliktus-ellenőrzés AI nélkül is működjön;
- a privát szöveges jegyzet ne kerüljön automatikusan AI-feldolgozásba;
- a rendszer előre jelezze, mely strukturált szabályokat használja az AI-javaslathoz;
- lehessen egy szabályt kizárni az AI-feldolgozásból úgy, hogy a kézi ellenőrzésben továbbra is aktív maradjon.

A pontos adatkezelői/adatfeldolgozói szerepeket és megőrzési időket a tényleges technikai és jogi működés alapján kell feltüntetni; ezeket a felület nem állíthatja általánosságban ellenőrzés nélkül.

## G) A fájlfeltöltés realitása

| Formátum | Mi nyerhető ki reálisan? | Mihez kell megerősítés? | Tipikus csendes adatvesztés |
|---|---|---|---|
| **XLSX** | Jól strukturált táblából nevek, e-mail, telefon, RSVP-státusz, csoport, meghívási egység és más explicit oszlopok. | Munkalap kiválasztása, fejlécsor, oszloptérképezés, több személyt tartalmazó cellák, duplikátumok. | Rejtett sorok/lapok, színnel jelölt státuszok, megjegyzések, összevont cellák, áthúzott lemondások, képletek, több vendég egy cellában. |
| **Régi XLS** | Alap cellaértékek sok esetben kinyerhetők, de kevésbé kiszámítható. | Ugyanaz, mint XLSX-nél; problémás fájlnál kérjen XLSX- vagy CSV-exportot. | Régi kódolás, formázási jelentés, makrók, sérült vagy jelszavas fájl. |
| **CSV** | A legmegbízhatóbb egyszerű táblás formátum: egy sor/vendég és egyértelmű fejlécek esetén jól importálható. | Elválasztójel, karakterkódolás, oszlopok jelentése, dátumformátum, többértékű mezők. | Elvesző kezdő nullák telefonszámnál, hibás ékezetek, vesszők miatti oszlopcsúszás, Excel által átírt dátumok és azonosítók. |
| **DOCX-táblázat** | Valódi Word-táblából nevek és oszlopok részben megbízhatóan kinyerhetők. | Minden felismert sort át kell nézni; különösen összevont celláknál és több táblánál. | Fejléc/lábléc, megjegyzések, követett változások, színkódok, egymásba ágyazott táblák. |
| **DOCX szöveg vagy felsorolás** | Nevek és sorok felismerhetők, de a mezők kapcsolata bizonytalan. | Gyakorlatilag minden vendégrekord kézi jóváhagyást igényel. | Párok egy sorban, gyermekek behúzással, zárójeles plusz egy fő, törölt vagy áthúzott elemek. |
| **Szöveges PDF** | Szöveg kinyerhető, egyszerű táblázat néha rekonstruálható. | Oszlopsorrend, sortörések, többoldalas táblák és minden bizonytalan rekord. | A vizuális táblázat olvasási sorrendje szétesik; fejléc ismétlődik; név és RSVP-státusz más sorhoz kapcsolódik. |
| **Szkennelt PDF** | OCR-rel nevek és rövid szövegek felismerhetők. | Minden rekord, különösen ékezetes vagy kézzel írt tartalom. | Kimaradó sorok, összekevert karakterek, elvesző pipák, áthúzások és színkódok. |
| **PNG/JPG/HEIC/képernyőkép** | Jó felbontású, egyszerű képből névlista OCR-rel előállítható. | Minden név, sorhatár, státusz és oszlopkapcsolat. Ezt „felismert vázlatként”, nem kész importként kell kezelni. | Levágott sorok, görgetés miatt hiányzó részek, checkboxok, ikonok, színek, csoportfejlécek, egymás alá tördelt nevek. |
| **Fényképezett kézírás** | Legfeljebb import-előkészítő segítségként használható. | Teljes kézi ellenőrzés vagy átírás. | Nevek téves felismerése vagy teljes kihagyása; semmilyen automatikus véglegesítés nem elfogadható. |

### Kötelező importfolyamat

Minden formátumnál:

1. fájl feltöltése;
2. felismert adatok előnézete;
3. oszlopok kézi hozzárendelése;
4. eredeti sor és felismert rekord egymás melletti megjelenítése;
5. alacsony megbízhatóságú sorok megjelölése;
6. duplikátum- és hiányellenőrzés;
7. importált, kihagyott és bizonytalan rekordok darabszámának kijelzése;
8. csak ezután: „Megerősítem és létrehozom a vendégeket”.

Különösen veszélyes csendes adatvesztési források:

- színnel jelölt vendégcsoport vagy RSVP-státusz;
- áthúzással jelölt lemondás;
- rejtett sor vagy munkalap;
- több vendég egy cellában;
- „+1”, „és családja”, „2 gyerek” típusú tömör jelölés;
- megjegyzésben tárolt fontos adat;
- képletből számolt, de nem tárolt érték;
- azonos nevű vendégek automatikus összevonása;
- OCR-rel rosszul felismert magyar ékezetes nevek;
- pár- vagy háztartási kapcsolat automatikus kikövetkeztetése.

A rendszer soha ne állítsa, hogy egy PDF-ből vagy képből „sikeresen importálta a vendéglistát”, amíg a felhasználó nem erősítette meg a felismert rekordokat. Ezeknél a helyes státusz: **„Felismerési vázlat – ellenőrzés szükséges.”**
