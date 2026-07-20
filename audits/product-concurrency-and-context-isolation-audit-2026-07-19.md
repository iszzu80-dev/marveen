# PRODUCT_CONCURRENCY_AND_CONTEXT_ISOLATION_AUDIT

**Elvégezte:** marveen | **Dátum:** 2026-07-19 | **Mód:** read-only

---

## VERDIKT

### `CONCURRENCY_IS_MAJOR_AMPLIFIER`

Nem elsődleges gyökérok. A hét ismert hiba egyikében sem az. De mérhetően felerősíti, és a felerősítés mechanizmusa konkrét: elveszi azt a holtidőt, amiben egy téves állítást ellenőriznének, és legyártja azokat a zavaros artefaktumokat, amikről a téves állítások képződnek.

Kvalitatív besorolás, nem százalék. A kauzális arány méréséhez címkézett hibanyilvántartás és kontrollcsoport kellene; egyik sincs. Az egyetlen szám ami erre kínálkozott (77%) hamis volt, lásd lentebb.

---

## 1. VIZSGÁLT IDŐABLAK

- Elsődleges: 2026-07-12 00:50 → 2026-07-19 00:50 (7 nap, 168 óra)
- Másodlagos: 2026-06-19 → 2026-07-19 (30 nap; gyakorlatilag a teljes adathalmaz, a legkorábbi kártya 06-18)

## 2. VIZSGÁLT TERMÉKEK

Adatból származtatva, nem feltételezve: MikroKönyv, QuickQuote, Zsibongő, DORA, LumaSeat/Eskuvő, CostOps, APG, Marveen-core/dashboard. **Nyolc.** Ismeretlen termék nem került elő.

## 3. VIZSGÁLT ÁGENSEK

**16 aktív ágens** a hét napban. Kommentvolumen szerint: deliverylead (1318), marveen (800), uat (278), fullstackfejlesztő (236), architect (183), frontendfejlesztő (152), qa (107), devops (77), buildfejlesztő (77), jogász (63), uxuidesigner (36), business (27), marketing (10), ba (6), research (3), frontendfejlesztő2 (2).

## 4. MAXIMÁLIS PÁRHUZAMOS PRODUCT WIP

- **Egyidejűleg aktív termékek: MAX 8, ÁTLAG 7.31**
- **Egyidejűleg buildben lévő termékek: MAX 6, ÁTLAG 5.00**
- Csúcs: 2026-07-16 20:28, mind a nyolc termék egyszerre aktív

Az átlag 7.31 a maximum 8 mellett azt jelenti, hogy **ez nem csúcs, hanem az állandósult állapot**. A flotta a teljes héten át gyakorlatilag minden terméket nyitva tartott.

Párhuzamos in_progress kártyák ágensenként (csúcs): fullstackfejlesztő **10**, frontendfejlesztő **8**, buildfejlesztő **7**.

Párhuzamos ágensek termékenként (egy napon belül, csúcs): MK **14**, LumaSeat **12**, Zsibongő/QQ/DORA **11**. Egy 16 fős flottából.

## 5. AGENT-TERMÉK VÁLTÁSOK

- **819 váltás** (debounce-olt) / 1649 (nyers felső korlát), 7 nap
- 30 nap: 2172 debounce-olt = 72.4/nap, szemben a legutóbbi hét 117/napjával. **A váltási intenzitás ~1.6x-ra nőtt.**
- Medián 2.3/ágens/nap; az átlag (6.9) nem leíró, mert a szórás extrém
- **deliverylead + marveen = az összes váltás 65%-a.** Mindkettő 9-10 terméket érint 24 órán belül
- **16 ágensből 16 érint 3+ terméket 24 órán belül**

A koordinátorok magas száma szerkezeti, nem hiba: a koordináció definíció szerint termékek között útvonalaz. **A valódi aggodalom `fullstackfejleszto`**: fejlesztő szerep, 7 termék 24 óra alatt, 5 termék egyszerre nyitva, 9 kártyával. Ott nincs koordinációs mandátum ami indokolná.

**A `--continue` nem kockázati tényező itt.** A négy `--continue` ágens a váltási rangsor 8., 15., 16. és 17. helyén áll. A hosszú session + egy termék egészségesebb minta, mint a rövid session + nyolc termék.

## 6. FRISS SESSION NÉLKÜLI VÁLTÁSOK

**Igazolt alsó korlát: 32.** A valós szám lényegesen magasabb.

`UNKNOWN — INSTRUMENTATION GAP`: nincs ágens-életciklus tábla, tehát csak az jelenleg futó processzen belüli váltás bizonyítható. A flotta nagy része órákkal az audit előtt újraindult, így a hét nap túlnyomó része a megfigyelhető határ előtt van. **A 32-t alsó korlátként kell idézni, nem válaszként.**

## 7. KÖZÖS MEMORY NAMESPACE-EK

**Egy. És ami izolációnak látszik, az nem az.**

Mind a 15 ágens configjában külön `claudeConfigDir` áll, ami izolációnak néz ki. A `projects` almappája viszont **symlink ugyanabba a közös könyvtárba**. A `claudeConfigDir` kizárólag a hitelesítési fiókot választja szét, memóriát nem.

Ami ténylegesen izolál: a **munkakönyvtár**. Ez viszont véletlen — a launcher `cd`-jének mellékterméke, nem szándékolt kontroll. **Minden al-ágens amit a fő marveen indít, örökli a cwd-t, és a marveen 290 fájlos névterébe ír.**

- Auto-memória névterek: 8 létezik, ebből **12 futó ágensnek egyáltalán nincs memória-könyvtára**. Az auto-memória gyakorlatilag egyágenses rendszer: csak marveen halmoz (290 fájl); deliverylead-é 9 napja megállt.
- **Két párhuzamos, egymást nem ismerő memóriarendszer:** a fájlalapú (session-indításkor automatikusan betöltődik, a CLAUDE.md **egyáltalán nem említi**) és az SQLite-alapú (1651 sor, 20 ágens, csak lekérésre, a CLAUDE.md **kizárólag ezt szabályozza**). A doktrína azt a rendszert szabályozza, ami nem töltődik be automatikusan.
- Az SQLite-memóriában az `agent_id` **lekérdezési paraméter, nem jogosultsági határ**: a megosztott tokennel bármely ágens olvassa bármely másikét.

## 8. PRODUCT-LOCAL MEMORY ÁLLAPOT

**Nem létezik.** Egyetlen névtérben **legalább 9 termék** állapota, termékmező, címke, almappa és szűrő nélkül. A `MEMORY.md` 11 szekciócíme mind tematikus, **egy sem termék-hatókörű**. Minden friss session megkapja mind a kilenc termék állapotát, szűretlenül (18.8 KB + 340 soros CLAUDE.md).

- 2026-07-18-án **16 különböző session írt ebbe az egy névtérbe**, zárolás és összefésülés nélkül
- **Nulla érvényességi jelölés** a 290 fájlban: nincs `superseded_by`, `valid_until`, `verified_at`. A dátum szerinti rendezés **rossz választ ad** ebben a korpuszban (több fájl a felülírt döntést teszi a frissebb alá)
- **10 igazolt ellentmondó döntéspár.** Egy fájl `description` mezője — az egyetlen szöveg amit garantáltan elolvasnak — máig felülírt döntést állít
- A 289 fájlból **73 (25%) nincs indexelve** a MEMORY.md-ben, tehát csak célzott kereséssel látható
- **8 fájlnak nincs eredetjelölése**, ebből kettő hordozó (6+ másik fájl hivatkozik rájuk mint tekintélyre)

### Kiemelt lelet: egy álló szabályod elveszett

2026-07-18 23:24-kor a **test-tenant regisztrációs álló szabályod** (07-14, az 1145 tesztbérlős JWT-incidens tanulsága) egy olyan könyvtárba íródott, amit **semmilyen session nem olvas** — `marveen/.claude-deepseek/projects/...`, index nélkül. Ok: egy relatív `CLAUDE_CONFIG_DIR` a munkakönyvtárhoz oldódott fel a home helyett. Ellenőriztem: a fájl ott van, a live névtérben nincs, a MEMORY.md nem hivatkozik rá.

### Kiemelt lelet: az `agents/marveen/CLAUDE.md` nem töltődik be

A gyökér CLAUDE.md a RENDER_API_KEY útvonala miatt odairányít. A CLAUDE.md-felderítés a cwd-ből **felfelé** sétál; a marveen cwd-je `/home/iszzu/marveen`, tehát az `agents/marveen/` **gyermek**, sosem ősi útvonal. Közvetlen bizonyíték: ennek a session-nek az injektált kontextusa a gyökér CLAUDE.md-t tartalmazza, azt nem. A fájl maga rögzítette nyitott kérdésként, hogy senki nem tudja betöltődik-e. **A válasz: nem.**

## 9. SHARED WORKTREE ESETEK

- **52 worktree** a suite repóhoz, **három egymással nem összefüggő szülőkönyvtárban**
- A közös suite checkout: **103 commit, 89 branch-váltás**, és **51 termékhatár-átlépés 102 szomszédos commit-páron** (a felénél több)
- **10 worktree jelenleg piszkos**, 07-10-ig visszamenő nem commitolt változtatásokkal. Ezek viszont *tartalmazottak* — a per-kártya worktree mint kontroll működik
- Egy javítás és a saját visszavonása **két testvér worktree-ként** él ugyanazon a kártya-azonosítón

### A legfontosabb egyedi lelet: `afe2b51`

Egy commit, aminek a deklarált célja "restore local features lost in upstream merge" volt (**4 forrásfájl**), valójában **217 fájlt, 32 665 sort és 11 termék anyagát** vitte be, benne bináris képernyőképeket és egy eldobható DB-író segédszkriptet.

Ez ugyanaz a commit, amiről ma este külön kiderült, hogy **a tárolást visszaállította, a meghívást nem** — az adatérzékenységi kapu egyetlen hívási pontja emiatt tűnt el. **A két lelet egy okra vezet vissza: egy 217 fájlos commitot senki nem tud átnézni.** És a suite repóban nincs is review-kapu, közvetlenül main-re megy minden.

## 10. PISZKOS FÁN FUTTATOTT ACCEPTANCE

`UNKNOWN — INSTRUMENTATION GAP` — pontos szám nem megállapítható, mert **egyetlen acceptance-verdikt sem rögzít commit-SHA-t vagy `git status`-t**.

Ami megállapítható: a 217 fájlos nem-követett halmaz **folyamatosan a fában ült 2026-07-18 22:00-ig**, miközben a reflog **8 commitot** mutat ugyanabban a fában 07-17 és 07-18 között. Bármely build vagy teszt abban az időszakban nem tiszta fán futott. A darabszám nem mérhető, a tény igen.

## 11. PRODUCER-VERIFIER FÜGGETLENSÉG

350 kártyához kötött verdikt elemezve, mind a hat kritérium mentén.

### **Valóban független: 12 / 350 = 3.4%**
### **Névlegesen független: 338 / 350 = 96.6%**

| Kritérium | Teljesül |
|---|---|
| Külön ágens (producer ≠ verifier) | 72% |
| **Célzott acceptance-kontextus** | **11%** |
| Közvetlen artefaktum-hozzáférés | 69% |
| Saját futtatás | 57% |
| Explicit cáfolási szándék | 58% |
| A producer önjelentése NEM tekintély | 77% |

**A kötő korlát a session-kontextus.** Ha csak ezt az egy kritériumot ejtjük, 12-ről **110-re** ugrik a szám. Az acceptance gyakorlatilag soha nem tiszta, célra szabott kontextusban történik, hanem menet közben, abban a hosszú session-ben ami a koordinációs narratívát tartja. `uat`, a flotta kijelölt független ellenőre, **66 verdiktet adott 3 session-ből**. A verdikt pillanatában a verifier session-jének medián kora **9.4 óra**.

**Önelfogadás: 99 / 350 = 28%** (producer == verifier).

### A szekció legfontosabb száma: **43% vs 7%**

Azok a verifierek, akik **cáfolni** indultak, 203-ból 87 esetben találtak eltérést. Akik **megerősíteni**, 147-ből 11-ben.

**A cáfolási szándék 6-szoros megkülönböztető.** Az artefaktum-hozzáférés és a saját futtatás egyenként csak 1.5-2x. A flottának megvan az eszköze — a verdiktek 69%-ánál volt artefaktum-hozzáférés, 57%-uk futtatott valamit. Ami 42%-uknál hiányzott, az a **szándék hogy az állítás megbukjon**.

És mivel az acceptance-eknek csak 11%-a történik célzott kontextusban, az alapértelmezett testtartás a koordinátoré: menet közben, hat másik termékkel a fejben. Az a testtartás az, ami 7%-ot talál.

Figyelemre méltó: az **önellenőrzés nem mutat romlást** (27% vs 28% eltérés-találati arány). Több önelfogadás elkapta a saját hibáját. **A függetlenségi hiány szerkezeti, nem kompetencia-kérdés.**

## 12. FŐ MARVEEN KOORDINÁCIÓS TERHELÉSE

- **7 termék egyidejűleg**, a hét minden napján legalább 5
- **531 különböző kártyán** kommentelt — a flotta legszélesebb elérése, szélesebb mint deliverylead 454-e
- **2864 busz-üzenet-végpont**; deliverylead 4017. **A kettő együtt az összes busz-forgalom 53%-a**
- deliverylead és marveen között önmagában **1275 üzenet = az összes forgalom 19.7%-a**
- **Nincs product-state registry.** "Hogy áll az MK" kérdésre nem lehet lekérdezéssel válaszolni — csak egy ágens tudja megmondani, aki hosszú session-ben tartja fejben

**Ez a két lelet ugyanaz a hiba két végéről nézve.** A hiányzó registry kényszeríti ki a hosszú koordinátori session-t, a hosszú session pedig az, ami miatt az acceptance-kontextus 89%-ban megbukik.

### Állítás-továbbadás ellenőrzés nélkül

626 továbbadási lánc; ebből **427 (68%) nem hordoz bizonyítékot arra, hogy a továbbadó bármit újraellenőrzött**. **deliverylead 55%-ában közbenső láncszem.**

Fontos különbség: a **hivatkozott** továbbadás ("Scout megerősítette, hogy X") megőrzi a nyomvonalat; a **hivatkozás nélküli** (165 eset) a másodkézből kapott állítást a koordinátor saját hangjára mossa, ahol ellenőrzött tényként olvasódik. **A Twilio-hiba pontosan ez volt, négy láncszemen át.**

## 13. LIVENESS ÉS OWNER-WAIT

### Liveness

- **A flotta stall-detektora 648-szor futott 8.7 napon át, és 2026-07-17 23:16-ig semmit nem produkált.** Minden futása `fired` státuszú volt — zöld vezérlősík-jelzés egy semmit nem kibocsátó monitorhoz
- **A te 20 tiszta életjel-kérdésedből 20 előtt nulla automatikus detektálás volt**
- 247 üzenet kézbesítése csúszott 1 óránál többet (max 7.1 óra); a `memoria-heartbeat` futásainak **34%-a kimaradt**
- Egy blokkolt hurok élőben: `maestro-backlog-review`, **121 egymást követő "busy" elutasítás 30 perc alatt, riasztás nélkül** — a riasztási útvonal létezik, de erre a sorra nem tüzelt

**Fontos, hogy a csend nem bizonyíték egészségre.** Ebben az esetben igazolhatóan nem az volt: a te 20 kérdésedből 15, a 247 késett kézbesítés és a 34% kimaradt heartbeat mind a néma ablakban történt.

### Owner-wait

**12 nyitott döntés vár rád**, 1497.7 kártya-óra a héten belül. A két legrégebbi **13.3 és 12.5 napos** (Eskuvő presale outreach; Barion kulcsátadás — utóbbi `high`).

Három 10.1 napos tétel **mind ügyfél-validációs interjú jóváhagyás**, három különböző terméken, plusz két pilot-toborzás. **A rád váró munka legnagyobb kategóriája a piaci validáció.**

Indokolatlanul váró: **1 a 12-ből** — `add679ad`, egy `high` prioritású JWT-rotációs security kártya **teljesen komment nélkül**. Az a kártya jelenlegi formájában nem döntéskérés, mert nincs rajta amiből dönteni lehetne. A többi 11 dokumentált, és 9-et 07-18-án újra felszínre hoztam.

## 14. A HÉT HIBA GYÖKÉROK-MÁTRIXA

Skála: 0 = nem járult hozzá, 3 = elsődleges gyökérok.

| Eset | Párh. termék | Ctx váltás | Közös mem. | Repo/worktree | Stale forrás | Rossz forrás-tekintély | Hiányzó runtime verif. | Rejtett claim | Self-report tovább | Nem füg. verifier | Túlterhelés | Liveness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 30 fős korlát | 0 | 0 | 0 | 0 | 0 | **3** | **3** | 1 | 0 | 2 | 1 | 0 |
| Twilio | 0 | 1 | 1 | 0 | **3** | **3** | **3** | 2 | **3** | 2 | 2 | 0 |
| 11 bölcsőde | 0 | 0 | 0 | 0 | 2 | **3** | **3** | 1 | 0 | 1 | 2 | 0 |
| Nyolc hónap | 1 | 0 | 0 | 0 | 0 | 0 | 0 | **3** | 0 | 0 | 2 | 0 |
| 4900 Ft | 1 | 1 | 2 | 0 | 2 | 1 | 1 | 0 | 0 | 0 | 1 | 0 |
| MK gomb | 0 | 1 | 0 | 1 | 1 | 2 | 2 | 0 | 0 | 0 | 1 | 0 |
| 9 migrációs ütközés | 2 | 1 | 0 | 2 | 0 | **3** | 2 | 0 | 0 | 0 | 1 | 0 |
| **ÖSSZESEN (max 21)** | **4** | **4** | **3** | **3** | **8** | **15** | **14** | **7** | **3** | **5** | **10** | **0** |

### Amit a mátrix mond

**Két oszlop dominál, és ugyanannak a hibának a két fele: rossz forrás-tekintély (15) és hiányzó futásidejű ellenőrzés (14).** Mind a hét esetben egy olvasható artefaktumot fogadtunk el a futásidejű viselkedés bizonyítékának. **Egyik esetben sem volt félreolvasás.** A kód tényleg úgy néz ki mintha korlátozna. A komment igaz volt amikor írták. Az oszlop létezik. A grep-találat ott van. A névkonvenció valós. Mindegyik hiteles forrás, helyesen elolvasva — csak egyik sem tudta bizonyítani amit rábíztunk.

**A párhuzamossági oszlopok (4, 4, 3, 3) jelen vannak, de egyikben sem elsődlegesek.**

**A túlterhelés mind a hét esetben ott van, és egyikben sem elsődleges ok (10 pont, nulla hármas).** Ez maga az eredmény: a túlterhelés nem hibát okoz, hanem elnyomja az ellenőrzési lépést ami elkapná.

**A liveness nulla pontot kapott mind a hétben.** A leállások valósak és súlyosak, de **külön hibacsalád**. Ha egybemossuk, az egyikre adott megoldás úgy fog látszani mintha a másikat is javítaná.

## 15. AJÁNLOTT MŰKÖDÉSI MODELL

### `B. VIRTUÁLIS PRODUCT POD`

**A dedikált termékcsapat NEM ajánlott, és ez szembemegy a kézenfekvő megoldással.**

A mért hiba nem az volt, hogy az ágensek nem ismerték a terméket. Az volt, hogy nem tudták megmondani, amit tudnak, még igaz-e. A dedikált csapat a **jártasságot** javítja, ami nem volt probléma, és az **érvényességet** rontja: egy tartósan egy terméken ülő ágens *több* elavult állapotot halmoz fel, és kevesebb külső szem nézi. Több lelet a hétből épp a termékek közti átjárás miatt bukott ki.

A pod mellett szóló döntő érv nem elméleti: **minden alkatrésze már létezik és működik.** Per-kártya worktree (52 él, 42 tiszta), friss session indítás, az APG kontextus-csomag fegyelme, cwd-alapú névterezés. Semmit nem kell építeni.

**Az APG a kontrollcsoport:** a flotta legszigorúbb folyamata (kontextus-csomag, friss session, a producer sosem fogadja el magát, független acceptance), és a legkevesebb hibát termelte. Nem változtatni kell rajta, hanem lemásolni.

Az `A` (jelenlegi közös flotta) sem tarthatatlan változatlanul — de a hibái `A`-n belül javíthatók. **A 17. pont izolációs csomagja többet ér, mint maga a modellváltás.**

## 16. TERMÉKENKÉNTI BESOROLÁS

| Termék | Besorolás | Indok |
|---|---|---|
| MikroKönyv | `VIRTUAL_POD_REQUIRED` | Legmagasabb ágens-beáramlás (14 ágens egy napon); adószámítási domain, ahol a rossz szám valódi adó; két kötelező NAV grandfather szabály implementálatlan. A domain viszont **átvihető** kontextus-csomagban (a NAV-kivonat fájl), tehát dedikált csapat nem indokolt |
| Zsibongő | `VIRTUAL_POD_REQUIRED` | **Legrosszabb újranyitási arány: a 30 flotta-újranyitásból 14, ~3x bármely másik.** 3421 várakozási kártya-óra. Ismétlődő azonos-osztályú hibák = a javítások nem általánosulnak |
| DORA | `PARTIALLY_DEDICATED_POD` | Leginkább hibadominált (37 incident vs 6 delivery). FORCE RLS **kétszer** lett visszavonva ugyanazon a három táblán. Megfelelne két kritériumnak — **de a valódi baj a repo-topológia** (suite + egy laza klón), amit csapatszerkezettel nem lehet javítani |
| LumaSeat/Eskuvő | `VIRTUAL_POD_REQUIRED` | Legtöbb rád váró döntés (5 a 12-ből). A legrosszabb memória-szennyezés: a varázsló lépésszáma **6, 9 és 15** három fájlban egyszerre, és ez **már okozott téves kiadást** |
| QuickQuote | `SHARED_POOL_OK` | Legalacsonyabb terhelés, gyorsabban ürül mint telik, friss 3-körös hardening mögötte |
| CostOps | `SHARED_POOL_OK` | 4 kártya, 0 aktív, már upstreamben |
| APG | `SHARED_POOL_OK` | A meglévő fegyelmet **megtartva**. Ez a kontrollcsoport |
| Marveen-core | `PARTIALLY_DEDICATED_POD` | Ez a szubsztrátum amin minden más koordinációja fut. Az upstream-fork és a munkafa összemosása szerkezeti hiba, amit rotáló ágens nem fog megjavítani |

**Egy termék sem kapott `PAUSE_OR_BACKLOG`-ot.** Tiltottad az aktív munka leállítását, és az adat sem követeli: 573 indult / 530 zárult = a tábla egyensúlyban van. **A probléma a sorban állás IDEJE, nem a sor NÖVEKEDÉSE.**

## 17. AJÁNLOTT WIP-LIMIT (javaslat, NEM aktiválva)

| | Konzervatív | **Kiegyensúlyozott (ajánlott)** | Agresszív |
|---|---|---|---|
| Egyidejű BUILD termék | 2 | **3** | 4 |
| Egyidejű discovery/research | 2 | **3** | 4 |
| Platform/APG sáv | 1 | **1** | 2 |
| Product lease / ágens | 1 | **2** | 3 |
| Párhuzamos in_progress / ágens | 2 | **3** | 5 |

**Ajánlott: kiegyensúlyozott.** Jelenleg 5 build-termék fut, 85%-os sorban állás mellett. A 3-ra vágás ~40% csökkentés. **De a per-ágens kártyakorlát fontosabb mint a termékkorlát** — a szűk keresztmetszet a három fejlesztő 7-10 párhuzamos kártyával, nem a termékek száma.

**Kivételek:** élő felületen lévő security-javítás; hiba egy általad meghirdetett launch-ablakban lévő terméken; a te közvetlen utasításod. Az "incidens" **nem** lehet rutin megkerülés — a mátrix szerint a liveness nulla hibát okozott a hétből.

**Új termék indításának feltétele:** szabad build-slot ÉS nevesített owner ÉS termék-lokális memória-névtér ÉS worktree lease. Nem "amikor valakinek van ideje".

**Ha slot kell:** CostOps (már 0 aktív), majd QuickQuote. **Nem** DORA vagy Zsibongő a hibaarányuk ellenére — egy ismert nyitott hibákkal leparkolt termék rosszabb, mint egy aktívan ürített.

## 18. MINIMUM PRODUCT EXECUTION ISOLATION

| Elem | Besorolás | Indok |
|---|---|---|
| `product_id` a kártyán | **KÖTELEZŐ** | 29% kártyának nincs terméke; a kulcsszavas következtetés 63%-ban többértelmű. Minden más ezen áll |
| Termék-lokális kontextus-csomag | **KÖTELEZŐ** | Jelenleg 18.8 KB szűretlen, 9 termékes betöltés. Az APG bizonyítja hogy 1600-1800 token elég |
| Termék-lokális döntésnapló | **KÖTELEZŐ** | 10 igazolt ellentmondás; a LumaSeat lépésszám-ellentmondás már okozott téves kiadást |
| Evidence/currentness policy | **KÖTELEZŐ** | Nulla érvényességi jelölés 290 fájlban. Minimum: `superseded_by` kulcs, és az a szabály, hogy **egy döntés felülírása ÁTÍRJA a címet és a leírást, nem csak kommentet fűz hozzá** |
| Verifier-szeparáció | **KÖTELEZŐ** | 3.4% valódi függetlenség; 28% önelfogadás |
| Termék-lokális memória-névtér | **AJÁNLOTT** | De a mechanizmust előbb kell érteni: a `claudeConfigDir` **nem** izolál, a cwd igen. Aki a configot állítja, izolációnak fogja hinni és nem lesz az |
| Friss session | **AJÁNLOTT** | De **termékVÁLTÁShoz** kötve, ne session-korhoz — a `--continue` ágensek a legkevesebbet váltanak |
| Worktree lease | **AJÁNLOTT** | A minta működik; a hiba az, hogy a közös checkout megkerülő útként nyitva maradt |
| Handoff receipt | **AJÁNLOTT** | A `/handoff` skill jó és jól szűkített, de opt-in, és nincs automatikus trigger tömörítéskor vagy újraindításkor |
| Agent lease | **HALASZTHATÓ** | A worktree lease + product_id gyakorlatilag lefedi |
| Context-switch logging | **HALASZTHATÓ** | A következő auditnak értékes, a mostani hibacsökkentésnek nem |
| Termékszintű concurrency lock | **FELESLEGES** | Nincs bizonyíték egy terméken belüli ütközésre; a mért ütközések termékek KÖZÖTTIEK egy közös fában, amit a worktree lease megold. Egy zár sorban állást adna egy 85%-ban már sorban álló rendszerhez |

## 19. MEGLÉVŐ CAPABILITY-K (építeni nem kell)

Worktree lease · friss session (`{"fresh":true}`) · kontextus-csomag fegyelem (APG skill) · cwd-alapú névterezés · per-kártya worktree minta

## 20. CONFIG-ONLY TÉTELEK

Termék-lokális memória-névtér (cwd-vezérelt launcher-config) · WIP-limitek · lease-konvenciók

## 21. LOCAL ADAPTEREK

`superseded_by` frontmatter konvenció · termék-lokális döntésnapló

## 22. UPSTREAM CANDIDATE-EK

`product_id` kötelezővé tétele · ismeretlen mezők elutasítása 400-zal (már kartyázva: 0934b467) · ágens-életciklus tábla · `contextTokens_measured_at` · per-ágens git identitás vagy `Agent:` trailer · nem-hívott kapu kanári + audit-log elavulási riasztás · esemény-kibocsátás minden státuszváltásnál · a ms/s időbélyeg-írási hiba javítása

**Most egyik sem lett beküldve** — az utasításod szerint.

## 23. VÉGREHAJTOTT VÁLTOZTATÁSOK

- **Core-módosítás: 0**
- **APG-attributable core modifications: 0**
- Kanban-módosítás az audit keretében: **0**
- Dispatch az audit keretében: **0**
- Config/service módosítás: **0**
- Memória/worktree átstrukturálás: **0**
- Új upstream issue: **0**
- WIP-limit életbe léptetve: **nem**
- Aktív termékmunka leállítva: **nem**

## 24. AUDITKORLÁTOK ÉS INSTRUMENTATION GAPEK

### A mérési aljzat nem támogatja a saját kérdéseit

- 29% kártyának nincs terméke; 39 írásmód 7-8 termékre; nincs CHECK, enum vagy FK
- **A lezárások ~45%-a nem hagy eseményt** (a mutációs réteget megkerüli valamelyik írási út)
- **A státuszváltások 62%-ának nincs szereplője**
- Nincs lane-mező; a `labels` tábla duplikált nevű sorokat tartalmaz, és 618-ból csak 40 kártyát fed
- Nincs verifier/verified_at mező — "ki ellenőrizte ezt" csak kommentszövegből olvasható ki
- Nincs ágens-életciklus tábla → a friss-session nélküli váltások száma nem mérhető
- Nincs `session_id` a kommenteken/üzeneteken → a verdikt session-azonossága következtetett
- **Minden flotta-commit egyetlen git-szerzővel megy** → az ágens-szintű attribúció halott; egy ágens nem is tisztázható
- Vegyes epoch-egységek egyetlen oszlopon belül (ms/s/ISO) → naiv szűrő némán rossz sorokat vesz
- `dispatched_at` NULL 1387-ből 963 kártyán (69%) → a kiadás-indulás késleltetés flotta-szinten mérhetetlen
- `origin_note` a hét 6480 üzenetéből **0-n** volt beállítva → al-ágens attribúció lehetetlen
- Az `approvals` tábla **minden időkre üres** → a level-2 jóváhagyási mechanizmus soha nem lett bizonyítva; semmi nem különbözteti meg a "sosem kellett"-et a "csendben megkerülték"-től
- 22 üzenet `delivered_at`-je NULL az elmúlt 24 órában, miközben igazolhatóan érkeztek üzenetek — **a mező nem tudja megkülönböztetni a "nem kézbesített"-et a "kézbesített de nem bélyegzett"-től**

### Amit ez az audit maga rontott el

Négy állítást gyártottak az ágak; **három hibás vagy alátámaszthatatlan volt.** Kettőt az az ág kapott el ami gyártotta, kettőt én.

1. **"77% korreláció a termékváltás és a visszavonás között"** — pont a hipotézis irányába mutatott, ez lett volna a címlap. Az ág maga cáfolta: a sok visszavonást gyártó ágensek ugyanazok akik folyamatosan váltanak, tehát az alapráta közel 100%. **Hamis lett volna.**
2. **"Más ágens nevében írt kanban-kommentet"** — a szkript `uxuidesigner` néven ír, és uxuidesigner annak a kártyának legitim résztvevője. Saját segédszkript, nem megszemélyesítés. **Ami valós marad: egy ágens megkerülte az API-t és közvetlenül az éles DB-be írt, `MAX(id)+1`-gyel — versenyhelyzet minden párhuzamos íróval.**
3. **"A fő marveen ágens nem fut"** — nincs `agent-marveen` session, ezért az ág halottnak nyilvánította. **Fut, `marveen-channels` néven.** Az ág névkonvencióból következtetett hiányra.
4. `984b601` "6 termék, 506 fájl" — root commit, a diffje definíció szerint a teljes fa. Az ág visszavonta.

**Ez az arány önmagában is lelet, és mérsékelnie kell a riport saját magabiztosságát.** Egy audit, amit ellenőrizetlen részeredmények továbbadásával raknak össze, a saját felépítésében reprodukálná azt a hibát, amit diagnosztizálni hivatott.

### Egy fogalmi korrekció, amit qa kért és elfogadtam

Azt írtam, hogy a kiadási hibák (négyszer felvéve-de-nem-kiadva, háromszor újra-kiadva a már kész munkát) a hiányzó registry miatt "elkerülhetetlenek, nem hanyagságból erednek". qa jelezte, hogy ez túlmegy a bizonyítékon: **a kártya gondos elolvasása mindegyiket elkapta volna, az enyémeket is.**

A védhető megfogalmazás: **a jelenlegi folyamat mindkét hibát KÖNNYŰVÉ teszi, és az egyetlen kontrollként az egyéni gondosságra támaszkodik, ami nem kontroll.** Ez elég a registry indoklásához, és nem dől meg ha valaki megtámadja.

---

## KÖVETKEZŐ EGYETLEN AJÁNLOTT LÉPÉS

**Vezesd be a `product_id` kötelezővé tételét és az érvényességi (currentness) szabályt — ebben a sorrendben, egyetlen változtatásként.**

Miért ez a kettő és miért együtt:

A `product_id` a legolcsóbb tétel a listán, és minden más rajta áll. Amíg a kártyák 29%-ának nincs terméke, addig nincs product-state registry, nincs WIP-limit amit ki lehet kényszeríteni, nincs lease, és a következő audit ugyanígy következtetni fog mérés helyett.

Az érvényességi szabály pedig a mátrix két domináns oszlopát támadja közvetlenül. A gyakorlati formája egyetlen mondat: **egy döntés felülírásakor át kell írni a címet és a leírást, nem elég kommentet fűzni hozzá.** Ma este pontosan ezért mondtam neked valótlant az AWS-retentionről: a döntés kommentben volt, a cím még "BLOKKOLÓ"-t mondott, és a státusz-riportot a címekből raktam össze. A kártyák **25%-án** van írásos korrekció, miközben a cím és a `done` státusz továbbra is a megcáfolt állítást hirdeti.

**Nem a modellváltás az első lépés.** A virtuális pod jó és olcsó, de a fenti kettő nélkül csak áthelyezi a problémát; a kettővel viszont a jelenlegi közös flotta is jelentősen javul.
