# v1.4 — Case-híd, approval-csatorna, acceptance fixture-ök

**Mi ez:** a §26 implementációs sorrend maradéka: **11., 12., 19., 24., 25., 27., 33.** és
részben **34.**

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6680 | **6742** (+62) |
| Bukó teszt | 0 | **0** |
| `tsc --noEmit` | tiszta | tiszta |

Hat állítás pirosra járatva.

---

## 1. A Case-híd szándékosan a határon KÍVÜL van

A `proactive-case-bridge.ts` nem a `src/cos/proactive/` alatt él. Az importhatár tiltja, hogy az a
könyvtár egyáltalán elérje a Case store-t — **és pontosan ettől nem ígéret a §4.1 „egy signal
létrejötte nem hozhat létre Case-t", hanem betartatott állítás.**

Ez nem megkerülés. Ez a szabály **kért alakja**: ami észlel, annak nincs jogosultsága cselekedni, és
aminek van, az nem észlel.

### §8: meglévő Case először, új Case utoljára

Négy szint, sorban, az elsőnél megállva. Egy proaktív réteg, ami jelenként nyit egy ügyet, egy héten
belül **olvashatatlan táblát** állít elő — és mindegyik ügy munkának látszik.

A tárgy-egyeztetés **ékezetet hajt.** Ez ebben a kódbázisban nem finomkodás: a `foldName` pont azért
létezik, mert a modell hol „István"-t, hol „Istvan"-t ír, és az egzakt összehasonlítás ugyanazt az
ügyet két külön rekeszbe sorolta aszerint, melyik írásmód érkezett. Egy cím-egyeztetésnek ugyanez a
kitettsége.

A **nemrég lezárt** ügy újranyílik, nem duplikálódik — de csak 30 napon belül. Egy múlt héten lezárt
és egy tavaly lezárt ügy különböző ajánlat: az elsőt újranyitni beszélgetést folytat, a másodikat
**feltámaszt.**

### §8.1: az öt feltétel közül az utolsó viszi a súlyt

*„a Case nem pusztán FYI értesítés lenne."* A lista összes többi pontját teljesíti egy jel, ami
egyszerűen információ — és egy FYI-okkal teli tábla olyan tábla, amit abbahagynak olvasni.

Egy dolgot érdemes kimondani: ezt az őrt a kvalifikációs úton **soha nem éri el hívás**, mert egy
alacsony cselekvőképességű jel már a `qualifySignal`-ban `ANNOTATE`. Redundánsnak *látszik* — egészen
addig, amíg egy hívó maga nem állít elő verdiktet. A §8.1 felsorolja a feltételt, ezért ott van
ellenőrizve, ahol Case ténylegesen létrejön, nem csak ott, ahol a verdikt megszületik. Külön teszt
teszi teherbíróvá.

### §14: resolve-before-ask, és a feltétel, amit sietve átugranak

A lánc az **első válaszoló forrásnál megáll.** Továbbmenni annyi lenne, hogy egy eldöntött kérdésre
második válasz születik — és két egymásnak ellentmondó feloldás rosszabb, mint egy, ami csak
hiányos.

És a fontosabbik: **ha egyetlen belső forrás sincs bekötve, az NEM engedély a kérdezésre.** Egy
resolver, aminek nincs próbája konfigurálva, semmit nem old fel — és a „semmi nem oldotta meg"
pontosan úgy néz ki, mint a „mindent megpróbáltunk", amíg a kettőt meg nem különböztetjük. A
`mayAskOwner` a részlegesen bekötött láncot is elutasítja.

---

## 2. Az approval-csatorna három sor között áll

A §17.6 saját megfogalmazásában:

> NORMAL CAP protects attention
> DEADLINE ESCAPE protects outcome
> **AUTHORITY GATE remains unchanged**

A keret és a menekülő szándékosan ellentétes irányba húznak, és a harmadik sor tartja őszintén az
érvelést: **egyik sem nyúl a jogosultsághoz.** A menekülő azt változtatja meg, hogy *mikor* mutatunk
meg valamit, azt soha, hogy mit szabad vele tenni.

**A menekülő a keret ELŐTT számítódik.** Utána számolva a keret speciális esete lenne — ami az
ellenkezője annak a viszonynak, amit a §17.6 kimond („a budget nem írhatja felül a deadline
engine-t").

**Több egyidejű menekülő EGY P0 kötegbe kerül.** A spec szerint nem rejthetők el — de burstként sem
érkezhetnek, mert pont az ellen készült a keret. Egy köteg, ami egy elemből áll, viszont csak egy
prompt fölösleges szavakkal, ezért az nem kötegelődik.

És a menekülő **nem menti meg** a §15.5 tényszerűségi kapun elbukott draftot: egy draft, amiben nem
lehet megbízni, nem lesz megbízható attól, hogy késésben van.

### §17.6.1 — amit a kedvesség ront el a legkönnyebben

> *„Épp most válaszolt, biztos megnéz még egyet."*

Ez vonzó érvelés, és pontosan az az ajtó, amit a keret bezár. **Egy kérdés megválaszolása nem
ugyanaz a cselekvés, mint egy művelet jóváhagyása.** Ha egy válasz feloldaná a jóváhagyási keretet,
egyetlen „igen" egy **nem kapcsolódó** kérdésre egyszerre engedné át a visszatartott jóváhagyások
sorát — pontosan az a löket, ami ellen a keret készült, csak azon az ajtón érkezve, amire az van
írva, hogy *„most úgyis figyel"*.

Az `owner_response_releases_approval_budget = false` normatív alapérték, és minden ismert kivétel
explicit `INHERIT` / `DO_NOT_INHERIT` / `ADAPT` döntést kapott, indoklással.

Az újrafogalmazási szabály **ADAPT**, nem INHERIT: az elv átjön, a mechanizmusa nem. Az interruption
oldalon a **kérdés** hashe dönt; itt a **draft tartalmának** digestje, mert egy átfogalmazott
jóváhagyási kérés akkor is ugyanaz a kérés, ha a szövege más — és akkor **nem** ugyanaz, ha a
tartalma változott.

---

## 3. Az acceptance fixture-ök — és amit egy ilyen fájl a legkönnyebben elronthat

A `V4-F1`–`V4-F14` végigjátszva a megépült rétegen. **De ez nem az az állítás, hogy a v1.4 kész.**

A fixture-fájl saját elfogadási szabálya kormányoz, és a középső sora a lényeg:

> *no fixture result is synthetic-only when the fixture claims runtime evidence*

Egy fixture, ami futásidejű bizonyítékot állít, nem jelölhető zöldnek olyan teszttel, ami maga
gyártotta a futásidőt. Ezért minden fixture **kétféle** lehet, és a fajtája ki van írva:

- **MECHANISM** — a szabály kódban van, ez pedig végigjáratja. Valóban zöld.
- **CAPABILITY GAP** — a mechanizmus megvan, de a *bizonyíték* éles adatot vagy embert igényel.
  Addig állítva, ameddig lehet, és a maradék **hiányként megnevezve.**

A másodikat zöldnek nevezni **pontosan az a hamis zöld**, amit az elfogadási szabály tilt — és ez a
legkönnyebben elkövethető hiba egy „acceptance fixtures" nevű fájlban.

Három deklarált hiány: **V4-F5** (a dokumentumból kinyert összegek strukturált tárolása),
**V4-F13** (nevesített, független **ember** adjudikátor) és **V4-F14** (90 napos éles replay korpusz).

A hiánylista **deklarált, nem futás közben gyűjtött.** Gyűjtve a záró állítás minden korábbi teszt
lefutásától függne — így egyetlen fixture izolált futtatása (`-t V4-F1`) **nulla hiányt** jelentene,
ami pontosan az a hamis zöld, ami ellen a lista készült.

---

## 4. Hol tart a §26 sorrend

**Kész:** 1–2., 6–7., 9–20., 22–30., 32–33.

**Nyitva, kódolható:** 21. (a release-boundary standing checkek megvannak; a **tranzitív permit-út**
ellenőrzése bővíthető, ha a planner valaha permitet kap), 34. (adverzariális készlet — az alapja
megvan a pirosra járatott sértésekben, de a teljes készlet külön munka), 35–36. (shadow mód és a
canary — ezek **futtatási** fázisok, nem kódolási feladatok).

**Nem kezdhető el itt, változatlanul:**

- **3–5.** — éles adatot igénylő kalibráció és a value-gate befagyasztás, a shadow **előtt**. Ez a
  legsürgősebb tétel az egész listán, mert utólag nem pótolható.
- **31.** — nevesített, **független ember** adjudikátor. Szervezeti döntés, nem kód.

A v1.4 mérési lánca teljes és a mechanizmusok megépültek. Ami hiányzik, az **adat és egy ember** —
és mindkettő hiánya ki van mondva, nem elrejtve egy zöld pipa mögé.
