# v1.4 Proactive Core — Stage 0 alap

**Mi ez:** a `marveen-autonomous-case-progression-spec-v1.4-proactive-core` §26 implementációs
sorrendjének első kódolható szelete, a `v14-proactive-core-capability-audit` mérése alapján.

**Egy mondatban:** megvan a jel → kvalifikáció → Initiative gerinc, determinisztikus policyvel,
és megvan a release-határ, amit **kód őriz**, nem egy bekezdés.

**Ami NINCS bekötve, szándékosan:** semmi. Nincs sweep, nincs heartbeat, nincs értesítés, nincs
Case-létrehozás. A §27 Stage 0 „replay only", és ez a szelet az a szókincs plusz policy, amit egy
replay-driver majd hív. Egy detektor, ami a mérési ablak befagyasztása **előtt** elindul, utólag
nem értékelhető — ez a §1.4 value gate egész értelme.

| | Előtte | Utána |
|---|---|---|
| Zöld teszt | 6100 | **6143** (+43) |
| Bukó teszt | 4 | **4 — ugyanaz a négy** |
| `tsc --noEmit` | tiszta | tiszta |

---

## 1. Mi készült el

A §26 sorrendből a 6., 7., 9., 10. és **21.** pont.

| Fájl | Mit fed |
|---|---|
| `src/cos/proactive/types.ts` | §4 signal, §5 Initiative, §9 outcome, §15.1 allowlist, §15.2 denylist |
| `src/cos/proactive/schema.ts` | három additív tábla, domain-scoped, igény szerint deployolva |
| `src/cos/proactive/signal-store.ts` | §4.1 invariánsok + §7 dedupe/novelty |
| `src/cos/proactive/qualification.ts` | §6.1 döntési sorrend, §6.2 kimenet, §6.3 fegyelem |
| `src/cos/proactive/initiative-store.ts` | §5.1 promóció, §9 outcome-kényszer, §6.2 perzisztencia |
| `proactive-core-action-boundary.test.ts` | §15.3 (1), (3), (5) |
| `proactive-core-import-boundary.test.ts` | §15.3 (2), (4) |
| `proactive-signal-qualification.test.ts` | 30 viselkedési teszt |

A 21. pontot (standing checkek) azért hoztam előre a sorrendben, mert az auditom zárása is ezt
javasolta: a határ akkor ér valamit, ha **előbb** áll, mint amit őrizni fog. Utólag felvenni annyit
tesz, hogy a köztes hetekben senki nem őrizte.

---

## 2. A release-határ — és amit az első futásán talált

A §15.3 azt mondja ki, hogy a „zero new external execution surface" nem dokumentációs pipa, hanem
kódszintű standing invariáns. Öt záradéka van; mind az öt **pirosra van járatva** egy valódi
szimulált sértéssel:

| Záradék | A szimulált sértés | Elbukik |
|---|---|---|
| (1) allowlist bővül tiltott osztállyal | `RESEARCH_WEB` felvéve | 3 check |
| (2)/(4) tranzitív függés | `import { foldName } from '../reader.js'` | package-check |
| (2)/(4) egress modul | `await import('../adapters/gmail-send.js')` | modul-check |
| (3) permit a plannernek | `mintGatePermit(...)` a modulban | permit-check |
| (5) alias/rename | tiltott osztálynév bárhol a modulban | név-check |

**Az import-check az első futásán talált egy valódi sértést — a sajátomat.** A `types.ts`
`import type { EvidenceFact } from '../reader.js'`-t használt, a `reader.ts` pedig behozza az
Anthropic SDK-t. Ezzel egy HTTP-kliens került a v1.4 tranzitív függőségi lezártjába — pontosan az
az alak, amit a §15.3(2) tilt.

Erre kézenfekvő azt mondani, hogy „de az `import type`, a TypeScript kitörli". Ez viszont a
*fordításról* szóló érv, nem a *függőségi gráfról*, és a release-határ a gráfra van írva. Egy határ,
ami addig tart, „amíg valaki az `import type`-ot `import`-ra nem írja", nem határ. A megoldás:
az `EvidenceClaim` itt van deklarálva, szerkezetileg azonosan — egy alak, él nélkül. A modul
tranzitív lezártja ma **pontosan a saját könyvtára**, plusz `better-sqlite3`, `node:crypto`.

Két további dolog, amit a checkek a saját működésükről mondanak ki:

- **A scan nem üres.** Egy standing check annyit ér, amennyit a pásztázása lefed, és egy nulla
  fájlt találó scan ugyanolyan magabiztosan jelent tiszta határt, mint egy helyes. Külön állítás
  rögzíti, hogy a modul megvan, a resolver követi az éleket, és a package-ág gyűjt.
- **A kommentek ki vannak zárva a scanből.** Szintén az első futás tanulsága: a `types.ts` prózában
  elmagyarázza, miért *nem* importál a `reader.ts`-ből — idézve a törölt import sort —, a scanner
  pedig importnak olvasta az idézetet. Egy check, ami a dokumentációt kódnak nézi, a dokumentáció
  megírását bünteti, és a fáradt ember reflexe az, hogy törli a magyarázatot.

**Az `@anthropic-ai/sdk` szándékosan a tiltólistán van**, és ez a leginkább vitatható tétel.
Egy modellhívás nem *új* külső felület — a Reader v1.4 előtt is hívott —, de egy case-tartalmat vivő
egress igen, és a v1.4 kvalifikációs policy pont azért determinisztikus, hogy ne kelljen neki
(§6: „a Reader/model javaslata csak input"). A Proactive Core a Reader **kimenetét** fogyasztja, nem
a klienst tartja. Ha egy későbbi detektornak valóban saját hívás kell, ez a sor az a hely, ahol az a
döntés nyíltan megtörténik, nem egy nem odatartozó diff belsejében.

---

## 3. A három tervezési döntés, ami eltér a spec betűjétől

### A domain nevek: `personal` / `zst`, nem `PRI` / `ZST`
A spec `"PRI" | "ZST"`-t ír. Ez a kódbázis az első Case-tábla óta `'personal' | 'zst'`-t mond —
minden indexben, minden lekérdezésben, minden izolációs ellenőrzésben. A §3 tiltja a párhuzamos
alrendszert, és **egy második domain-szókincs az**: ugyanannak a partíciónak a kétféle írásmódja az,
ahogyan egy cross-domain szivárgás túléli a review-t, mert mindkét fél a saját dialektusában
helyesnek látszik.

### A határidők epoch másodpercek, nem ISO stringek
A spec ISO stringet ír. Ebben a store-ban minden határidő-oszlop INTEGER epoch, és a kettő keverése
az, ahogy a határidő-aritmetika csendben elromlik — a V4-F12 pontosan ez a hibaosztály. A store
elutasítja a nem-epoch értéket a bejáratnál.

### Két kulcs, nem egy
A §7.2 két invariánsa egymással szemben feszül: *soha ne duplikálj* és *soha ne nyeld el a
lényegesen megváltozott állapotot*. Egyetlen fingerprinttel csak az egyik teljesíthető. Ezért van
`dedupe_key` („ugyanaz a helyzet?") és `novelty_key` („történt-e benne valami?"). Ugyanaz a helyzet
változatlan tényekkel → `DUPLICATE`. Ugyanaz a helyzet elmozdult tényekkel → a meglévő sor
**frissül**, és ha addig SUPPRESSED volt, visszatér DETECTED-be.

A dedupe-kulcs **domainenként** egyedi, nem globálisan: egy közös szállító vagy közös határidő
mindkét oldalon jogos jel, és egy globális kulcs engedné, hogy a privát oldal elnémítson egy céges
jelet, amiről nem is szabadna tudnia.

---

## 4. Amit a policy szándékosan nem csinál

- **Nem hív modellt.** A §6 első mondata szerint a modell javaslata csak input. Ugyanaz az érv,
  amit az evidence planner és a kérdés-író már használ ebben a kódbázisban: az ítélet feljebb már
  megszületett. És van egy erre a release-re jellemző második ok is: a §1.4.3 **vak adjudikációval**
  méri az inkrementális értéket egy befagyasztott korpuszon. Egy policy, aminek ugyanarra a
  bemenetre a shadow-futásban és a replayben más a válasza, ezt az összehasonlítást értelmetlenné
  teszi — a mért dolognak állnia kell.
- **Nem olvassa a Case-store-t.** A jelölt Case-eket **argumentumként** kapja. Kettős haszon: a
  §15.3(2) importhatár tartható, és egy policy, ami adatbázist olvas, nem replayelhető befagyasztott
  korpuszon.
- **Nem szakít félbe senkit.** Az `user_interruption_required` **kiszámolt és eltárolt** mező; ebben
  a release-ben egyetlen sor sem olvassa, hogy szóljon vele. Az interrupt-út nincs is importálva.
- **Nem hoz létre Case-t.** A §4.1 kimondja; a modul úgy tartja be, hogy a Case-store-hoz nincs
  hozzáférése — ezt külön standing check rögzíti.

Egy dolog, ami nem szigorítás, hanem tudatos lazaság: **az interruption-pontszám nem kapuz**.
Ami belsőleg érdemes előkészíteni, azt akkor is érdemes, ha soha nem lesz érdemes miatta szólni.
Két külön büdzsé, és összevonva az olcsóbbat a drágább helyett költenénk el.

---

## 5. Minden verdikt le van írva — nem csak a promóciók

A `proactive_qualifications` tábla `SUPPRESS`-t és `ANNOTATE`-et is rögzít, gépi olvasható
reason kódokkal (`materiality:below_threshold`, `duplicate_novelty:active_initiative_equivalent`,
`hard_gate:...`). Ok: egy policy, ami csak azt jegyzi fel, amit átengedett, **precisionre pontozható,
recallra soha** — és egy proaktív réteg, ami csendben elmulaszt dolgokat, pontosan úgy néz ki, mint
egy olyan, aminek nem volt mondanivalója.

A pontszámok **tárolva** vannak, nem olvasáskor újraszámolva. A §1.4.3 befagyasztott korpuszhoz mér;
egy olvasáskor újraszámolt pontszám elmozdulna a küszöbök hangolásakor, és csendben átírná azt a
rekordot, amihez a value gate-et mérjük.

---

## 6. Mi jön ezután, és mi nem kezdhető el itt

A §26 sorrendjéből a következő kódolható tételek: 8. (Reader evidence extension), 11.
(Initiative → Case promóció), 13. (deadline ontológia), 14–16. (sweep), 22. (`PreparedInitiative`),
28. (WAIT_SYSTEM / capability preflight — az auditban **M0**, ma nincs állapot képességhibára).

Ami **nem** kezdhető el ebben a konténerben, és nem is fejlesztési feladat:

- **3–5. (replay korpusz, kalibráció, value-gate befagyasztás).** Éles adat kell hozzá; itt nincs.
  Ez az a pont, amit az audit a legsürgősebbnek jelölt, mert a §1.4.1 regisztrációnak a shadow
  **előtt** kell megtörténnie.
- **29–31. (adjudikációs apparátus).** Mindhárom M0, és a 31. nevesített **független ember**
  adjudikátort követel — ez szervezeti döntés, nem kód.

**Stop gate, változatlanul:** a v1.4 itt véget ér. Browser, research és disclosure nem része ennek a
Definition of Done-nak, és a fenti importhatár ezt most már nem kérésre tartja be.
