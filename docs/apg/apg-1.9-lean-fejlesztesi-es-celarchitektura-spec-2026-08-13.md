# AGP 1.0 Lean – fejlesztési és célarchitektúra-specifikáció (v1.9)

**Státusz:** High-level target specification  
**Verzió:** 1.8-draft  
**Dátum:** 2026-08-09  
**Előzmény:** AGP/APG 0.4 Lean Pilot Kernel + Phase 0/1 tapasztalatok  
**Célkörnyezet:** Marveen multi-agent fejlesztési rendszer  
**Alapelv:** **FREE SOLUTION SPACE, CONTROLLED AUTHORITY AND PROGRESSION**

---

## v1.9 változásnapló

A v1.9 az első verzió, amely **nem új kontrollt ad hozzá, hanem a meglévők szállíthatóságát javítja**. Egy 2026-08-13-i, teljes spec-vs-kód konformancia-felmérés kiindulópontja: nyolc munkacsomagból nulla elfogadva, és ami éles munka ellen fut, az egy kézzel indított szkript hét átmásolt kártyán. A diagnózis nem az volt, hogy a spec téved — a megcélzott hibaosztályt („egy felület olyan állapotot jelent, amit nem ellenőrzött") a Marveen más területein, az AGP-től függetlenül végzett review is újra és újra megtalálta. A probléma a méretezés: a §30 lean anti-bloat szabály ellenére a WP1 44 deliverable-t tartalmazott, amelyből ~35 egyetlen kontroll, a §9.2 kalibrációs lánca volt.

A v1.9 négy változtatása:

1. **A §9.2 kikerül a WP1-ből.** A periodikus haladás-kontroll három önálló munkacsomag lesz (WP9, WP10, WP11), és az új §9.2.0 kimondja, hogy kalibráció nélkül `OBSERVE_ONLY` — semmit nem blokkol, és a hiánya **nem blokkolhat más work package acceptance-t**. A WP10 kilépési pontja explicit módon megengedi a `CALIBRATION_ECONOMICS_NOT_LEAN` kimenetet: egy kalibrálhatatlan kontroll helyes válasza a nem-enforced státusz, nem a becsült küszöb.
2. **A WP1 újradefiniálva arra, aminek van zöld állapota:** registry az élő kiértékelési úton per-execution receipttel, egy valódi executor (startability, §9.1), applicability receipt, acceptance-control séma, és a `blocking_rule → executable_control` validátor. A handoff-, backlog- és falsification-munka WP1b/WP1c/WP1d néven külön csomag, amely a WP1-re épül, de nem előfeltétele.
3. **Stage 1 előfeltétele az élő betáplálás.** Az observe mód csak akkor observe, ha ténylegesen mér: automatikus ingest, saját liveness-jel, és számlálható `eligible work item`. Enélkül a helyes állapotjelentés `NOT_STARTED / OBSERVE_NOT_FED`, nem „Stage 1 folyamatban".
4. **Az AGP maga is a saját mércéje alá kerül** (§28 42–43. kritérium): mért overhead és mért hozam ugyanabban a `MEASURED_POSITIVE / NONPOSITIVE / UNKNOWN` állapottérben, becsült baseline nélkül, és a §23.1 gate-class logikájával a következményekre.

Szerkesztési javítás: a v1.8-ban két szakasz viselte a **9.3** számot. A v1.9-ben a Dual-sided Acceptance Contract marad 9.3, a Cross-Component Effect Propagation Control 9.4, a Backlog Recovery / Replay Proof 9.5 lett. A `WP2`–`WP8` azonosítói és exit-kódjai szándékosan változatlanok, hogy a meglévő auditok hivatkozásai érvényben maradjanak.

Amit a v1.9 **nem** tesz: egyetlen kontrollt sem gyengít, egyetlen bizonyítási követelményt sem enged el, és egyetlen szakasz szakmai tartalmát sem írja át. A §9.2 ugyanaz a fejezet maradt, ugyanazokkal a követelményekkel; csak az változott, minek az elfogadási feltétele.

---

## v1.8 változásnapló

A v1.8 egy új, valós Mission Control recovery-esetből kiterjeszti a v1.7 cross-component effect proofot: **nem elég bizonyítani, hogy a fix után érkező új input végigmegy; a javítás pillanatában már tartósan rögzített, még érvényes és feldolgozatlan inputnak is bizonyítottan tovább kell haladnia**.

A failure pattern:

```text
input korábban authoritative módon rögzítve
+
consumer/handoff hibás volt
+
input feldolgozatlanul bent maradt
+
javítás után az új inputok már működnek
BUT
a korábban felhalmozott eligible inputok továbbra is érintetlenek
→ feature recovery incomplete
```

A v1.8 ezért:

1. a Cross-Component Effect Propagation Controlt két proof mode-ra bontja:
   - `FRESH_INPUT`
   - `PREEXISTING_ELIGIBLE_UNCONSUMED_INPUT`;
2. bevezeti az explicit **Backlog Eligibility Contractot**;
3. kimondja, hogy durable input persistence önmagában nem teljes delivery, ha a recovery path nem fogyasztja el a még érvényes pending inputokat;
4. kötelező historical fixture-ként felveszi:
   - `HF-05 — PREEXISTING_UNCONSUMED_INPUT_NOT_REPLAYED`;
5. kötelező reverse control:
   - már consumed input nem dolgozható fel újra;
   - cancelled / expired / superseded / no-longer-relevant input nem replayelhető;
6. replay/recovery PASS csak akkor adható, ha ugyanaz az authoritative downstream effect létrejön, mint a friss input esetén;
7. idempotency first-class követelmény: retry/replay nem okozhat dupla side effectet;
8. a replay nem jelent általános „játsszunk vissza mindent” mechanizmust; csak explicit módon **eligible + current + unconsumed** input kerülhet recovery feldolgozásba;
9. fix/restart/deployment után a backlog recovery proof ugyanúgy correlation- és effect-alapú, mint a fresh path;
10. a v1.8 továbbra sem igényel külön Backlog Service-t: a meglévő durable store/queue/state primitive-ekre és a v1.7 handoff executorra épül.

---

## v1.7 változásnapló

A v1.7 egy 2026-08-09-i valós Mission Control hibából új failure classt vezet be: **cross-component effect propagation failure**.

A hiba mintája:

```text
upstream UI/action komponens helyesen ír eseményt
+
downstream motor helyesen lefut
+
mindkét komponens saját tesztje zöld
BUT
a downstream komponens nem fogyasztja / nem értelmezi az upstream választ
→ a felhasználói lánc nem záródik
```

Ez nem startability-hiba és nem egyszerű periodic-stall. A komponensek lokálisan helyesek, de az **összekötés és a tényleges hatáspropagáció hiányzik**.

A v1.7 ezért:

1. bevezeti a **Cross-Component Effect Propagation Control** fogalmát;
2. kimondja, hogy component-local PASS nem bizonyít feature-level PASS-t, ha az acceptance több komponens közötti adat-/eseményátadástól függ;
3. minden releváns handoff edge-hez explicit input → correlation → observable downstream effect contract tartozik;
4. a proof célja nem az, hogy „mindkét oldal lefutott”, hanem hogy az upstream stimulus után a downstream **viselkedése vagy authoritative business-state-je** a contract szerint megváltozott;
5. aszinkron handoffnál bounded observation window és correlation identity szükséges;
6. kötelező negatív kontroll: upstream event megvan + consumer fut, de a downstream expected effect nem történik meg → FAIL;
7. a kontroll Lean marad: nem minden belső függvényhíváshoz kell end-to-end teszt, csak olyan feature/acceptance edge-hez, ahol komponenshatáron átadott adat vagy esemény szükséges a kívánt eredményhez.

---

## v1.6 változásnapló

A v1.6 két v1.5 utáni review findingot zár le.

1. **A coverage declaration maga is claim.** `COMPLETE` intervention coverage nem származhat pusztán a chain charter kézi felsorolásából.
2. **Két külön coverage-proof szükséges:**
   - `Surface Inventory Resolver`: producer-függetlenül deriválja a releváns code/config/state/runtime/deployment influence surface-eket az authoritative execution/dependency scope-ból;
   - `Detection Canary`: bizonyítja, hogy minden COMPLETE-nek mondott observation path ténylegesen észlel egy ismert, biztonságos beavatkozást.
3. **Canary önmagában nem bizonyít teljességet.** Egy deklarált sensor működését bizonyítja; a kihagyott surface problémát az inventory completeness kezeli.
4. **Coverage is falsifiable.** Kihagyott derivált surface vagy vak sensor esetén a rendszernek el kell veszítenie a COMPLETE státuszt.
5. **Coverage proof currentness.** Dependency-, watcher-, config/state source-, runtime/deployment-topology változás, audit gap vagy false-negative incident után revalidation kötelező.
6. **Economics consequence binding.** A `MEASURED_*` economics státusz explicit gate-lifecycle következményt kap.
7. **Pure efficiency gate:** current `MEASURED_POSITIVE` nélkül nem tarthat meg enforced státuszt; authoritative `MEASURED_NONPOSITIVE` vagy stale/invalid economics justification deterministic downgrade-ot vált ki.
8. **Correctness/reliability gate:** negatív economics kötelező value review-t indít, de downgrade csak akkor, ha a külön defect-prevention justification sem tartja fenn.
9. **Hard-safety gate:** economics önmagában nem kapcsolhatja le; cost/architecture review indul, enforcement csak safety-equivalent replacement vagy megfelelő safety authority alapján változhat.
10. **No consequence-free metric.** Ha egy mérőszám promotion/retention indok, a gate charternek explicit lifecycle consequence-t kell rendelnie hozzá.

---

## v1.5 változásnapló

A v1.5 két további, ugyanabból az alapelvből következő rést zár le: **enforcement-döntést nem befolyásolhat becsült gazdasági baseline**, és **az automatikus episode labeling csak bizonyított intervention-observability mellett adhat ground truth authorityt**.

A v1.4 minden korábbi korrekciója megmarad, az alábbi kiegészítésekkel:

1. **Measured economics, not estimated ROI.** A `baseline_manual_monitoring_minutes` nem lehet becsült vagy deklarált szám. Gazdasági előny csak mért historical incidentből, observe/shadow időablakból vagy explicit manual-control sample-ből származhat.
2. **Economics tri-state.** A calibration/gate economics eredménye `MEASURED_POSITIVE | MEASURED_NONPOSITIVE | UNKNOWN`. `UNKNOWN` esetben sem pozitív, sem negatív ROI-t nem szabad feltételezni.
3. **No guessed denominator.** Becslés, survey, „tipikus javítási idő”, agent estimate vagy owner guess nem adhat enforced promotion authorityt.
4. **Safety and economics separated.** Hard-safety/security/privacy/data-loss invariant enforceddé válhat `ECONOMICS_UNKNOWN` mellett is, ha a safety acceptance teljesül és az overhead mért/elfogadott. Nem-hard-safety efficiency gate hipotetikus megtakarítás alapján nem léphet enforcedbe.
5. **Intervention Visibility Contract.** Automatikus `AUTO_EVENTUAL_PROGRESS` vagy `AUTO_CONFIRMED_STALL` címkéhez bizonyítani kell, hogy a releváns code/config/state/runtime mutation surface-ek megfigyelési lefedettsége teljes az epizódra.
6. **Unknown provenance => UNLABELED.** Nem-engine-originated írás, ismeretlen eredetű mutation, manual restart, process-generation változás, hiányzó watcher/audit coverage vagy puszta gyanú esetén az epizód automatikus ground-truth címkéje tilos.
7. **Absence of evidence is not evidence of no intervention.** „Nem láttunk beavatkozást” csak akkor használható auto-label feltételként, ha az observability manifest bizonyítja, hogy az összes deklarált intervention surface lefedett volt.
8. **Marveen reuse, not duplicate audit.** A meglévő Marveen audit-jelek (Settings change log, store file audit stb.) használhatók intervention evidence-ként, de mivel nem fednek le automatikusan minden code/config/state/restart útvonalat, hiányzó coverage-nél az AGP konzervatívan `UNLABELED`-et ad, nem épít feltétlenül új teljes audit platformot.

---

## v1.4 változásnapló

A v1.4 két gyakorlati üzemeltetési rést zár le a v1.3-ban: **egy új, kalibrálatlan periodikus lánc ne kényszerítse az egész terméket vissza observe módba**, és **a grace calibration ne igényeljen epizódonként emberi címkézést**.

A v1.3 minden korábbi korrekciója megmarad, az alábbi kiegészítésekkel:

1. **Compositional enforcement, nem monolitikus mód.** Az AGP mód nem csak globális vagy termékszintű állapot. A kontrollok chain/gate scope-ban külön maturity állapotot kapnak. Egy új periodikus lánc `progress_liveness` gate-je kalibrálatlanul `OBSERVE_CALIBRATION`, miközben ugyanazon termék többi enforced gate-je enforced marad.
2. **Nincs kézi chain-level downgrade kiskapu.** A producer vagy futó agent nem állíthatja a teljes láncot observe módba azért, mert egy gate még nem kalibrált. A calibration exception kizárólag a konkrét gate-re, determinisztikus maturity resolverből, auditálva és automatikusan lejáró módon keletkezhet.
3. **Episode Label Resolver.** A calibration input epizódok címkézése külön authority pipeline-t kap. Elsődleges forrás a deterministic/authoritative auto-label, második a fresh verifier adjudication, ember csak unresolved/conflicting esetben szükséges.
4. **Nincs kötelező human label per episode.** Olyan calibration design, amely minden vagy rendszeresen a legtöbb epizódhoz owner/operator döntést kíván, nem Lean-enforced-ready.
5. **Intervention-aware labeling.** Manuális restart, bugfix, config/policy change vagy owner beavatkozás után bekövetkező progression nem címkézhető automatikusan `eventual_progress`-ként vagy `confirmed_stall`-ként. Az epizód `INTERVENED/UNLABELED`, amíg independent resolver nem adjudikálja.
6. **A detector saját ítélete nem ground truth.** A stagnálás-detektor korábbi `STALLED`/`PASS` eredménye nem használható önmagában a következő calibration címkéjeként.
7. **Calibration labor economics.** Minden gate méri az auto/verifier/human label arányt, human minutes-t, verifier tokenköltséget és nettó emberi megtakarítást. Nem hard-safety gate csak akkor léphet enforcedbe, ha a calibration/adjudication emberi költsége nem semmisíti meg az automatizáció hasznát.

---

## v1.3 változásnapló

A v1.3 a v1.2 periodikus haladás-detektálását két új elvvel szigorítja: **a stagnálási türelmi ablak nem lehet kézzel becsült authority-paraméter**, és **fázisos láncnál a grace policy kötelezően fázisspecifikus**.

A v1.2 minden korábbi korrekciója megmarad, az alábbi kiegészítésekkel:

1. **Measured Grace, Not Guessed Grace.** Enforced módban a `PASS ↔ STALLED` határt meghatározó grace thresholdot nem írhatja be producer, agent vagy operátor ad-hoc számként. A határt egy determinisztikus `Periodic Grace Calibrator` állítja elő megfigyelt progress-epizódokból.
2. **Lexikografikus kalibrációs cél.** A kalibrátor először olyan thresholdot keres, amely a known-good / eventual-progress kalibrációs és validációs adatokon nem gyárt false-stallt; az ilyen jelöltek közül a legkisebb, true-stall eseteken leggyorsabb detektálást adó értéket választja. Ha a rendelkezésre álló evidence alapján nincs megbízható választás, az eredmény `UNCALIBRATED`, és a progress gate `UNKNOWN`.
3. **A receipt nem teszi igazzá a küszöböt.** A progress receipt továbbra is auditálja a használt policyt, de authorityt csak érvényes calibration receipt adhat.
4. **Phase-specific grace kötelező.** Ha egy periodikus lánc canonical phase-eket ismer, minden enforced stagnálási policyt phase-id alapján kell feloldani. A korábbi opcionális `phase_overrides` megszűnik. Globális grace nem használható fallbackként fázisos láncnál.
5. **Phase transition reset.** Canonical phase-váltás új progress-epizódot indít, és a következő ciklustól az új phase calibrationje érvényes. A korábbi phase no-progress streakje nem vihető át az új phase-be.
6. **Calibration lifecycle.** A kalibráció verziózott, immutable és producer-független. Revalidation/recalibration kötelező canonical chain/phase modell változásakor, confirmed false-stall esetén, calibration-data drift esetén, valamint a policy szerinti review pontokon.
7. **Új fordított kontrollok.** Kötelező fixture bizonyítja, hogy (a) ugyanazon lánc lassú planning és gyors execution fázisa eltérő grace-t kap, (b) phase-specifikus kalibráció hiányában `UNKNOWN` keletkezik, és (c) stale calibration nem használható enforced PASS/FAIL authorityként.

---

## v1.2 változásnapló

A v1.2 a v1.1 után érkezett új, valós Marveen futási tapasztalatokat építi be. A fő korrekció az, hogy a periodikus haladás-detektálás ne gyártson hamis hibát egy legitim, lassan induló láncból, és hogy az Observe → Assisted promotion ne csak a false pass, hanem a false block irányt is mérje.

A v1.1 minden korábbi korrekciója megmarad, az alábbi módosításokkal:

1. **Grace-aware periodic progress:** a két egymást követő ciklus közti nulla business-state delta önmagában többé nem `STALLED`. Minden periodikus lánchoz kötelező, producer-független `Periodic Chain Charter` tartozik progress-invarianttal és stagnálási türelmi ablakkal.
2. **Nincs globális, implicit stagnálási küszöb.** Ha a releváns chain charter nem definiálja a grace policyt, a progress executor eredménye `UNKNOWN`, nem `STALLED` és nem `PASS`.
3. **A v1.1 HF-03 újraminősítve.** A későbbi megfigyelés szerint a 2–4. ciklus közti mozdulatlanság legitim tervezési fázis volt, és az 5. ciklustól progression indult. Ez ezért nem confirmed true-stall fixture, hanem first-class **false-stall / slow-progress historical control**.
4. **Fordított stagnálás-kontroll:** a detektornak bizonyítania kell, hogy egy grace window-n belül legitim módon stagnáló, majd később haladó láncot NEM jelöl `STALLED`-nek.
5. **True-stall kontroll külön fixture.** A valódi stagnálási RED út szintetikus vagy más, ténylegesen igazolt historical fixture-rel bizonyítandó: runnable work + grace túllépve + nincs progression + nincs authoritative wait evidence.
6. **Observe → Assisted promotion kétirányú.** A clean promotion window alatt `confirmed_false_pass = 0` ÉS `confirmed_false_block = 0` szükséges. A false block csak függetlenül adjudikált, ugyanazon acceptance contract szerint valóban hibás gépi megállítás; puszta owner override nem számít false blocknak.
7. **Progress receipt auditálja a grace policyt.** A receipt tartalmazza a chain charter/policy verzióját és hashét, hogy a producer ne tudjon runtime-ban kényelmesebb stagnálási küszöböt választani.

---

## 0. Vezetői összefoglaló

Az AGP 1.0 Lean célja, hogy a Marveenben végzett AI-agent fejlesztés:

- gyorsabb legyen;
- minél nagyobb arányban automatikusan végigfusson;
- kevesebb emberi koordinációt igényeljen;
- lényegesen kevesebb kontextus-, authority-, stale-state- és acceptance-hibát engedjen át;
- reprodukálható bizonyíték alapján mondja ki, hogy valami elkészült;
- ugyanakkor **ne vegye el az AI modellek kreatív problémamegoldási szabadságát**.

Az AGP 1.0 nem azt mondja meg az agentnek, **hogyan** oldjon meg egy problémát. Azt szabályozza, hogy:

1. miből lehet aktuális tényt állítani;
2. milyen authorityvel lehet egy állítást továbbadni;
3. milyen ellenőrzésnek kell ténylegesen lefutnia;
4. mikor tekinthető egy munka elkészültnek;
5. mikor tekinthető függetlenül elfogadottnak;
6. mikor kell megállni bizonytalanság, konfliktus vagy kockázat miatt;
7. mikor szükséges emberi owner-döntés;
8. hogyan lehet mindezt visszajátszani és auditálni.

A modell lényege:

> **Az agent szabadon gondolkodik és szabadon választ megoldást, de nem szabadon választ authorityt és nem ugorhat át bizonyítás nélkül egy kötelező kaput.**

A Lean jelleg azt jelenti, hogy az AGP nem épít kötelező, sok-agent-es bürokráciát minden apró változtatás köré. Az alapértelmezett működés:

- **egy producer agent**;
- először **deterministic checks**;
- semantic verifier csak akkor, ha a kockázat indokolja;
- egyszerre maximum **egy fresh semantic verifier**;
- owner csak valódi owner-döntésnél;
- nincs kötelező multi-agent SDLC;
- nincs minden változtatáshoz teljes compliance workflow;
- nincs megoldás-prescription;
- nincs automatikus production side effect pusztán attól, hogy egy LLM azt mondja: „kész”.

---

# 1. Miért kell az AGP 1.0?

Az AGP 0.4 Lean bebizonyította, hogy a következő elemek működőképesek:

- append-only evidence/receipt modell;
- execution receipt chain;
- determinisztikus checkpoint evaluator;
- producer és accepter szétválasztása;
- sidecar architektúra;
- observe-only működés;
- visszajátszható, auditálható állapot;
- a Marveen core módosítása nélküli pilot.

A 0.4 ugyanakkor tudatosan nem építette meg a teljes automatikus végrehajtó láncot.

A Phase 1 tapasztalata megmutatta a legfontosabb korlátot:

> **Egy kapu létezése nem jelenti azt, hogy a rendszer valóban meg is méri azt, amit a kapu elvileg ellenőriz.**

A checkpoint evaluator helyesen tudott `UNKNOWN` eredményt adni. Ez biztonságosabb a hamis PASS-nál, de önmagában nem csökkent kockázatot, ha nincs mögötte executor, amely ténylegesen:

- futtatja a tesztet;
- lekérdezi a runtime-ot;
- ellenőrzi az állítást;
- validálja a kontextust;
- vagy elindítja a független verifikációt.

Az 1.0 fő ugrása ezért nem „még több governance”, hanem:

> **a dokumentált módszertan végrehajtható, mérhető, falszifikálható rendszerként való megvalósítása.**

---

# 2. North Star

Az AGP 1.0 akkor sikeres, ha egy tipikus low/medium-risk Marveen fejlesztési feladat így működik:

```text
Owner / Marveen:
„Ezt a problémát oldjuk meg.”

        ↓

AGP
azonosítja a terméket és a change-et
betölti a releváns, current contextet
rögzíti a célt és az acceptance contractot
meghatározza a risk profile-t
meghatározza a kötelező executorokat

        ↓

Producer agent
szabadon tervez
szabadon challenge-el
szabadon implementál
szabadon kérhet segítséget

        ↓

AGP executorok
typecheck / test / diff / policy / runtime / evidence
ténylegesen lefutnak

        ↓

Falsification
megpróbálja cáfolni a változtatás helyességét

        ↓

Fresh verifier
csak ha a risk profile indokolja

        ↓

PASS / RETURN_FOR_FIX / BLOCKED / OWNER_DECISION

        ↓

safe delivery / runtime verification

        ↓

accepted + auditable receipt chain
```

A felhasználónak normális esetben nem kell agenteket kézzel koordinálnia.

Az owner akkor kap megszakítást, ha:

- valódi üzleti döntés szükséges;
- két authority összeütközik;
- kötelező bizonyíték nem szerezhető be;
- high/critical kockázatú side effect következik;
- a rendszer nem tud biztonságosan továbbhaladni.

---

# 3. Alapvető tervezési elvek

## 3.1. Free Solution Space

Az AGP nem írja elő a megoldást.

A producer szabadon:

- találhat új architektúrát;
- választhat implementációs stratégiát;
- refaktorálhat;
- alternatívát javasolhat;
- challenge-elheti a briefet;
- UX-koncepciót változtathat;
- más agentet kérhet fel;
- új eszközt javasolhat;
- bizonyíthatja, hogy az eredeti megoldási irány rossz.

A rendszer **outcome + constraints + acceptance** alapján működik, nem solution prescription alapján.

### Tilos az AGP-ben

- kötelező agent-sorrend minden feladathoz;
- kötelező „architect → developer → reviewer → QA” pipeline minden change-re;
- kötelező solution template;
- kötelező implementációs pattern, ha nincs safety oka;
- a producer kreatív reasoningjének előírása;
- a producer „jó megoldásának” előre definiálása.

---

## 3.2. Controlled Authority

Az, hogy egy agent állít valamit, nem teszi bizonyítékká.

Alapértelmezett agent-output:

```text
CREATOR_CLAIMED
```

Authorityt csak megfelelő forrás vagy receipt adhat.

Authoritative evidence lehet például:

- determinisztikus executor receipt;
- runtime observation receipt;
- immutable source/diff/commit;
- hiteles külső forrás;
- runnerhez kötött verification receipt;
- human owner decision megfelelő principalből;
- explicit canonical config / ledger állapot.

Nem authoritative önmagában:

- agent üzenet;
- másik agent összefoglalója;
- chat history;
- komment;
- fájlnév;
- kártyacím;
- régi owner-döntés currentness ellenőrzés nélkül;
- busz `from=` mező;
- „szerintem működik”.

---

## 3.3. Controlled Progression

A modell nem azt ellenőrzi, hogyan gondolkodott az agent.

Azt ellenőrzi:

> **Megvan-e a szükséges bizonyíték ahhoz, hogy a következő állapotba lépjünk?**

Minden blocking progression rule mögött végrehajtható mechanizmusnak kell lennie.

---

## 3.4. Deterministic First

Mielőtt LLM-et hívunk, használjunk olcsó, reprodukálható ellenőrzést.

Példák:

- compiler/typecheck;
- unit/integration test;
- linter;
- schema check;
- diff scope;
- git status;
- dependency audit;
- migration ledger;
- HTTP contract probe;
- config validation;
- runtime health endpoint;
- explicit receipt lookup.

LLM semantic verifier csak akkor induljon, ha:

- a deterministic checks nem tudják lefedni az acceptance-et;
- a kockázat indokolja;
- vagy a feladat lényegében szemantikai/minőségi természetű.

---

## 3.5. One Agent Default

Alapértelmezés:

```text
1 producer
```

További agent csak akkor:

- specialist knowledge kell;
- verifier independence kell;
- security/UX/domain review indokolja;
- owner explicit kéri;
- vagy az orchestration policy bizonyítja, hogy értéket ad.

Az AGP nem jutalmazza a sok agent használatát önmagáért.

---

## 3.6. Falsification Before Trust

A rendszer ne azt kérdezze:

> „Megvan minden, ami szerintünk jó?”

Hanem:

> „Milyen bizonyíték cáfolná azt, hogy ez a change helyes?”

Az AGP 1.0 saját fejlesztésének minden fázisát is falsification runnerrel kell validálni.

---

## 3.7. No Silent Unknown

A bizonytalanság first-class state.

`UNKNOWN`:

- nem PASS;
- nem FAIL;
- nem success;
- nem „probably okay”.

Enforced módban egy **required** check `UNKNOWN` eredménye megállítja a progressiont mint `INCOMPLETE`.

---

## 3.8. Updateability First

A helyi Marveen deployment maradjon frissíthető.

Preferencia:

1. sidecar;
2. adapter;
3. extension hook;
4. generikus upstream capability;
5. minimális local patch;
6. core fork csak végső esetben.

Minden generikusan hasznos core-fejlesztést upstream candidate-ként kell értékelni.

---

# 4. Mi NEM az AGP 1.0?

Az AGP 1.0 Lean nem:

- teljes workflow engine;
- Temporal/Camunda-klón;
- Jira-helyettesítő;
- állandó multi-agent swarm;
- autonóm üzleti döntéshozó;
- teljes compliance platform;
- automatikus production deployment minden change-re;
- portfolio management rendszer;
- solution governance;
- prompt police;
- reasoning police;
- agent kreativitást korlátozó módszertan.

---

# 5. Logikai architektúra

```text
                     ┌────────────────────────────┐
                     │        OWNER / USER        │
                     └─────────────┬──────────────┘
                                   │
                             owner decisions
                                   │
                                   ▼
┌───────────────────────────────────────────────────────────┐
│                    AGP CONTROL PLANE                      │
│                                                           │
│  Work Item / Change Runner                                │
│  Risk + Gate Profile                                      │
│  Product Identity + Currentness                           │
│  Context Router                                           │
│  Gate Executor Registry                                   │
│  Falsification Runner                                     │
│  Verification / Acceptance                                │
│  Receipt & Evidence Ledger                                │
│  Gate Telemetry / Economics                               │
└───────┬─────────────────┬─────────────────┬───────────────┘
        │                 │                 │
        ▼                 ▼                 ▼
  Producer agent    Fresh verifier     Deterministic
                                         executors
        │                 │                 │
        └─────────────────┴─────────────────┘
                          │
                    immutable target
                          │
                          ▼
                  Safe Delivery Layer
                          │
                          ▼
                   Runtime verification

      Marveen Kanban / Approvals / Activity / UI
             = projection + control surface
```

A sidecar ledger maradjon az AGP control-plane authority.

A Marveen UI és Kanban ne legyen az AGP belső truth source-ja.

---

# 6. A fejlesztési sorrend

Az 1.0 dependency order:

```text
A. EXECUTABLE VERIFICATION FOUNDATION
        ↓
B. PRODUCT IDENTITY + CURRENTNESS
        ↓
C. EXECUTION IDENTITY + DELEGATION PROVENANCE
        ↓
D. CONTEXT ROUTER + FRESH VERIFICATION
        ↓
E. GRAPH / CHANGE RUNNER + EXECUTOR-BOUND GATES
        ↓
F. KANBAN + DISPATCH INTEGRATION
        ↓
G. SAFE DELIVERY + RUNTIME VERIFICATION
        ↓
H. FULL PRODUCT LCM CLOSED LOOP
```

A sorrend szándékos.

A falsification és executor infrastructure **előbb készül el**, mint azok a képességek, amelyeket vele ellenőrizni fogunk.

---

# 7. Fázis A – Executable Verification Foundation

## 7.1. Cél

Minden későbbi AGP-fejlesztési fázishoz legyen eszközünk annak bizonyítására, hogy a fázis képes:

- elfogadni a jó esetet;
- elutasítani a rossz esetet;
- bizonytalanságot felismerni;
- reprodukálható receiptet adni;
- bizonyítani, hogy a megfelelő gate-ek valóban lefutottak;
- bizonyítani, hogy a gate-ek kötelező halmazát nem a producer választotta ki.

---

## 7.2. Gate Profile Resolver – a kötelező halmaz authorityje

A v1.1-ben a gate **kötelezősége** és a gate **futási eredménye** két külön fogalom.

A producer nem döntheti el, hogy egy gate required-e.

A work item indulásakor, a producer execution létrehozása **előtt** egy determinisztikus `Gate Profile Resolver` állítsa elő az applicability mapet az alábbiakból:

```yaml
applicability_input:
  work_item_id:
  product_id:
  change_class:
  risk_profile:
  target_kind:
  environment:
  side_effect_class:
  policy_version:
  explicit_owner_constraints:
```

Output:

```yaml
gate_profile:
  profile_id:
  profile_version:
  input_hash:
  generated_by: gate_profile_resolver

  gates:
    - gate_id:
      obligation: REQUIRED | ADVISORY | EXCLUDED
      rule_id:
      rule_version:
      reason_code:
      reason_text:
      input_facts:

  created_at:
```

### Authority szabályok

1. A producer nem írhatja a `gate_profile`-t.
2. Egy gate executor nem minősítheti saját magát `EXCLUDED`-nak.
3. Az accepter ugyanazt az immutable gate profile-t látja, amely alapján a producer execution elindult.
4. Minden `EXCLUDED` gate külön append-only `applicability_receipt`-et kap.
5. Az accepter UI-ban látszódjon minden kihagyott gate és az indoka.
6. Ha a producer szerint a profile hibás, csak `CHALLENGE_CONTRACT` útvonalon kérhet profile-változtatást.
7. A profile módosítása új `profile_id`-t és új receiptet hoz létre; a régi nem íródik felül.
8. Enforced módban a producer execution közben a required halmaz nem szűkíthető silent módon.

### Manuális override

Kivételes gate downgrade csak:

- megfelelő authorityből;
- explicit indokkal;
- append-only override receipttel;
- accepter számára láthatóan;
- high/critical safety invariant esetén owner/human authorityvel.

A downgrade nem módosíthatja visszamenőleg a korábbi evidence-et.

---

## 7.3. Gate Executor Registry

Minden progressiont vagy acceptance-et befolyásoló szabály mögött legyen executor vagy authoritative resolver.

Executor contract minimum:

```yaml
executor_id:
version:
class:
  deterministic | evidence_resolver | semantic_verifier | human_decision

applies_to:
input_contract:
output_contract:

timeout:
retry_policy:
failure_semantics:

cost_class:
expected_latency:

receipt_schema:
```

Blocking gate executor/resolver nélkül:

```text
NON_EXECUTABLE_GATE
```

Enforced-ready státusz nem adható neki.

---

## 7.4. Gate futási eredmények

Canonical executor result:

```text
PASS
FAIL
UNKNOWN
ERROR
```

A `NOT_REQUIRED` **nem executor result** a v1.1-ben.

A gate applicabilityt a `Gate Profile Resolver` előre dönti el:

```text
REQUIRED
ADVISORY
EXCLUDED
```

### PASS

A check ténylegesen lefutott, és megfelelt.

### FAIL

A check ténylegesen lefutott, és bizonyított hibát talált.

### UNKNOWN

A checknek lenne értelme és a gate aktív, de nincs elég evidence megbízható eredményhez.

### ERROR

Az executor technikailag nem tudott lefutni vagy nem adott valid eredményt.

### EXCLUDED

Nem futási eredmény. A gate profile determinisztikusan kimondta, hogy az adott check nem alkalmazandó ennél a work itemnél. Ehhez kötelező `applicability_receipt` tartozik.

---

## 7.5. Enforced mód szemantikája

| Obligation | Futási eredmény | Progression |
|---|---|---|
| REQUIRED | PASS | mehet |
| REQUIRED | FAIL | BLOCK |
| REQUIRED | UNKNOWN | INCOMPLETE / BLOCK |
| REQUIRED | ERROR | BLOCK |
| ADVISORY | PASS | mehet |
| ADVISORY | FAIL | warning / policy függő |
| ADVISORY | UNKNOWN | warning |
| ADVISORY | ERROR | warning + degraded |
| EXCLUDED | nincs futás | kihagyható, applicability receipttel |

Az `UNKNOWN` problémát nem azzal oldjuk meg, hogy átengedjük.

A helyes megoldás:

> **a kötelező halmazt producer-független, determinisztikus risk/profile szabály állítja elő.**

Ez zárja le azt a megkerülést, amelyben egy producer nem az eredményről hazudna, hanem egyszerűen kivenné a kaput a required halmazból.

---

# 8. Falsification Runner

## 8.1. Szerepe

A Falsification Runner az AGP egyik alapműszere.

Nem „AI reviewer”.

Feladata:

> a target és az acceptance contract alapján aktívan olyan bizonyítékot keresni, amely cáfolja, hogy a change elfogadható.

---

## 8.2. Input

Elsődleges bemenet:

```yaml
verification_request:
  work_item_id:
  product_id:
  change_id:

  target_ref:
    kind: commit | diff | artifact | deployment | runtime
    immutable_ref:
    hash:

  acceptance_contract_ref:
  gate_profile_ref:
  risk_class:

  producer_execution_id:
  evidence_refs:
```

A commit/diff csak target-típus, nem az egész interfész.

---

## 8.3. Caller

Korai szakasz:

```text
CLI / manual pilot
```

1.0 működés:

```text
Change Runner
   ↓
verification checkpoint
   ↓
Falsification Runner
```

A producer nem döntheti el, hogy a kötelező falsification fusson-e.

---

## 8.4. Output

Append-only:

```yaml
verification_receipt:
  receipt_id:
  work_item_id:
  target_hash:

  verdict:
    PASS | FAIL | UNKNOWN | ERROR

  checks_run:
  findings:
  counterexamples:
  evidence_refs:

  verifier_principal:
  verifier_session_id:
  context_packet_hash:

  started_at:
  finished_at:
  latency_ms:
  token_usage:
  estimated_cost:

  runner_version:
```

`PASS` csak akkor létezhet, ha minden required executor valóban lefutott vagy hiteles receipt bizonyítja az eredményét.

---

# 9. Negatív kontrollok

Az AGP 1.0 nem fogadható el csak „happy path” eredményekkel.

Minden executorhoz kötelező:

```text
known-good
→ PASS

known-bad
→ FAIL

insufficient evidence
→ UNKNOWN / INCOMPLETE
```

End-to-end kontrollok legalább:

1. szándékosan typecheck-hibás diff;
2. acceptance criteriont megsértő implementáció;
3. stale/superseded owner-döntés;
4. rossz product identity;
5. hiányzó required runtime evidence;
6. self-approval kísérlet;
7. delegated agent output authoritative evidence-ként való beadása;
8. conflicting evidence;
9. executor timeout;
10. sidecar/projection partial failure;
11. **szállított, futtathatónak deklarált entrypoint el sem indul** a canonical indítási móddal, miközben statikus tesztek zöldek;
12. **true-stall fixture:** periodikus lánc fut, activityt/logot termel, runnable work van, a saját deklarált grace window lejár, és továbbra sincs tényleges business-state progression vagy authoritative wait evidence;
13. **slow-but-progressing reverse control:** periodikus lánc a kalibrált grace window-n belül több cikluson át nem mutat stage/cursor változást, majd a grace lejárta előtt vagy annak határán legitim progressiont mutat; ezt a detector NEM jelölheti `STALLED`-nek.
14. **phase-aware grace control:** ugyanazon lánc planning phase-e hosszabb stationary szakaszt, execution phase-e rövidebbet mutat; a detector phase-specifikus calibrationt használ, és egyik phase-re sem alkalmaz globális fallbackot.
15. **missing/invalid calibration control:** required progress checknél nincs VALID phase calibration; az eredmény `UNKNOWN`, nem PASS és nem STALLED.
16. **stale calibration control:** a chain/phase semantics megváltozott vagy a calibration superseded/invalid; a régi threshold nem használható enforced authorityként.
17. **cross-component effect propagation control:** az upstream komponens helyesen létrehozza a stimulus/eventet és a downstream komponens fut, de a downstream expected business-state/behavior nem változik; a rendszer ezt nem fogadhatja el pusztán component-local zöld tesztek alapján.
18. **pre-existing eligible backlog recovery control:** a javítás pillanatában már authoritative módon rögzített, current, eligible és unconsumed input javítás/restart után új stimulus nélkül feldolgozódik, és létrehozza az elvárt downstream effectet.
19. **replay idempotency control:** már consumed input vagy ugyanazon correlation/input retryja nem okozhat második authoritative side effectet.
20. **stale backlog exclusion control:** cancelled / expired / superseded / no-longer-relevant input nem replayelhető pusztán azért, mert technikailag még perzisztálva van.

Acceptance feltétel:

> legalább egy teljes known-bad work itemnek a normál automatikus láncban ténylegesen `RETURN_FOR_FIX` vagy `BLOCKED` állapotba kell jutnia.

A v1.1 három elsődleges historical fixture-je valós Marveen hibából származik:

### HF-01 – DOCUMENTED_CHECK_NOT_EXECUTED

A szabály/spec előírta a checket, de nem gépi executor futtatta. A rendszernek ezt `NON_EXECUTABLE_GATE` vagy hiányzó receipttel blokkolnia kell.

### HF-02 – GREEN_BUT_DOES_NOT_START

Egy szállított script 23 zöld teszt, tiszta typecheck és öt zöld gate mellett egyáltalán nem indult el. A startability executor feladata ezt elkapni.

### HF-03 – LEGITIMATE_SLOW_PROGRESS / FALSE-STALL CONTROL

A v1.1-ben ezt az esetet tévesen confirmed stagnálási hibaként osztályoztuk. A későbbi valós megfigyelés szerint a 2., 3. és 4. ciklus között nem változott a látható lépésszám, mert a rendszer legitim módon a terv kialakításán dolgozott; az 5. ciklustól tényleges progression indult.

Ez ezért v1.2-től **known-good reverse control**:

```text
ciklus 2 → nincs látható stage delta
ciklus 3 → nincs látható stage delta
ciklus 4 → nincs látható stage delta
ciklus 5 → progression

expected:
a planning phase VALID calibrationje alapján
WITHIN_GRACE → WITHIN_GRACE → WITHIN_GRACE → PROGRESSING
never: STALLED

A fixture v1.3-tól calibration inputként is használható az eventual-progress stationary streak megfigyeléséhez; a raw „3 ciklus” nem canonical threshold, csak egy historical observation.
```

### HF-04 – COMPONENTS_GREEN_BUT_HANDOFF_MISSING

Valós Mission Control hiba:

```text
1. felhasználó megnyomja az „akció elvégzése” gombot
2. az UI/action komponens helyesen írja az eseményt
3. a motor a trigger után helyesen lefut
4. mindkét komponens saját tesztje zöld
5. a motor azonban nem olvassa/fogyasztja a választ
6. a lánc nem záródik be
```

A hiba lényege:

```text
local component correctness = true
cross-component feature correctness = false
```

A fixture expected eredménye:

```text
upstream stimulus present
+
downstream execution present
+
required downstream observable effect absent
→ EFFECT_NOT_PROPAGATED
→ FAIL / RETURN_FOR_FIX
```

A proof nem teljesül attól, hogy:

- event keletkezett;
- consumer process/tick lefutott;
- mindkét komponens unit tesztje zöld;
- log keletkezett.

A proof csak akkor teljesül, ha a handoff contract által elvárt downstream **viselkedés/state transition** authoritative módon megfigyelhető.


### HF-05 – PREEXISTING_UNCONSUMED_INPUT_NOT_REPLAYED

Valós Mission Control recovery-eset:

```text
1. a felhasználói döntés/input már a javítás előtt authoritative módon rögzítve volt;
2. a korábbi handoff/consumer hiba miatt nem dolgozódott fel;
3. a rekord továbbra is persisted + unconsumed állapotban maradt;
4. a javítás után az új inputok már helyesen végigmennek;
5. a régi, még érvényes pending input azonban érintetlen marad.
```

Ez külön failure class:

```text
LIVE_PATH_FIXED
BUT
RECOVERY_BACKLOG_NOT_CONSUMED
```

Canonical failure:

```text
BACKLOG_NOT_CONSUMED
```

Expected fixture:

```text
GIVEN
  persisted input exists before fix/restart/deployment
  AND input is eligible
  AND input is current
  AND input has no consumed/processed receipt

WHEN
  repaired consumer becomes active

THEN
  no new upstream stimulus is required
  AND the existing input is discovered
  AND the existing input is consumed exactly once
  AND the expected downstream effect occurs
  AND a processed/consumed receipt is written
```

A fixture nem tekinti PASS-nak azt, hogy:

- az új inputok már működnek;
- a consumer process fut;
- a backlog rekord továbbra is olvasható;
- a motor periodikusan tickel;
- új eseményre a feature működik.

PASS csak akkor:

```text
PREEXISTING_ELIGIBLE_UNCONSUMED_INPUT
→ CONSUMED
→ EXPECTED_EFFECT
```

#### Reverse controls

**Already consumed**

```text
persisted input
+
valid consumed receipt
→ MUST NOT create a second side effect
```

**Cancelled / expired / superseded**

```text
persisted but no longer eligible
→ MUST NOT replay
```

**No-longer-relevant workflow state**

```text
input was once valid
BUT current workflow state no longer accepts it
→ MUST NOT replay blindly
→ explicit SKIPPED_NOT_ELIGIBLE / equivalent receipt
```

A replay tehát nem „minden régi adat újrajátszása”, hanem current eligibility alapján kontrollált recovery.


A true-stall RED út külön `SF-03 — TRUE_STALL_BEYOND_GRACE` fixture-rel bizonyítandó, amíg nincs más, egyértelműen igazolt historical true-stall eset.

---

## 9.1. Startability Control

Minden olyan deliverable esetén, amely futtatható entrypointot ígér, a statikus correctness nem elegendő.

Kötelező startability contract:

```yaml
startability_contract:
  entrypoint_ref:
  launch_command_source:
  launch_command_hash:
  environment_profile:
  startup_timeout:
  ready_condition:
  expected_lifecycle:
    long_running | exits_successfully | one_shot
```

A launch parancsot ne az executor találja ki. A projekt canonical konfigurációjából vagy explicit acceptance contractból olvassa.

A startability executor bizonyítsa legalább:

1. a belépési pont valóban létezik;
2. a canonical indítási paranccsal elindul;
3. eléri a definiált ready/healthy állapotot vagy a one-shot sikeres terminális állapotot;
4. nincs azonnali crash/exit, ha long-running lifecycle az elvárt;
5. a receipt tartalmazza az exit/ready evidence-et.

Zöld unit test, build vagy typecheck **nem helyettesíti** ezt a checket.

Canonical failure:

```text
ENTRYPOINT_START_FAILURE
```

---

## 9.2. Periodic Progress Differential Control

Ismétlődő/periodikus láncnál a `tick lefutott`, `log keletkezett`, `counter nőtt` nem bizonyít progressiont. Ugyanakkor **egy vagy több mozdulatlan ciklus önmagában nem bizonyít stagnálást sem**.

A progress detector csak a lánc saját, verziózott progress policyja alapján mondhatja ki, hogy egy lánc megrekedt.

### 9.2.0. Enforcement-státusz: OBSERVE-only, amíg nincs kalibráció (v1.9)

Ez a fejezet a spec legnagyobb egybefüggő kontrollja, és a hozzá tartozó bizonyítási lánc — charter → kalibrátor → epizód-címkék → intervention visibility → surface inventory → detection canary → coverage revalidation — **önmagában work package méretű**. A v1.9 ezért kimondja:

```text
periodic_progress_differential.enforcement_status = OBSERVE_ONLY
```

amíg a §9.2.1.c szerinti érvényes calibration receipt elő nem áll az adott lánc adott fázisára.

Következmények, kötelező érvénnyel:

- **A kontroll OBSERVE-only állapotban semmilyen progressiont nem blokkolhat**, semmilyen parent mode alatt — enforced product alatt sem. Mér, receiptet ír, shadow verdiktet ad, és láthatóvá teszi magát; nem állít meg munkát.
- **Egy OBSERVE-only progress-kontroll hiánya nem blokkolhat más work package acceptance-t.** Ez a v1.9 legfontosabb szerkezeti változása: a §9.2 megléte a WP9–WP11 elfogadási feltétele, nem a WP1-é.
- **Kalibráció nélküli stagnálás-állítás tilos.** A `missing_calibration_result: UNKNOWN` szabály (§9.2.1) nem hangolható: kalibrálatlan láncnál a gate eredménye UNKNOWN, nem „valószínűleg elakadt".
- **Az átmeneti, kézzel megadott küszöb megengedett, de kizárólag nem-authoritative telemetriaként**, és a kódban is annak kell látszania. Ha egy termék ma egy `STAGNATION_RUNS = N` típusú konstanssal riaszt, az addig legális, amíg (a) semmit nem blokkol, (b) a konstans a forrásban explicit módon nem-authoritative jelöléssel szerepel, és (c) nem hivatkozik rá acceptance-kritérium. Ez pontosan a §9.2.1.b által tiltott minta legális, felcímkézett változata — a tiltás az authority-ra vonatkozik, nem a mérésre.

A cél nem a kontroll gyengítése. A cél, hogy a legdrágább kontroll ne tartsa túszul a legolcsóbbakat: a startability (§9.1) és a dual-sided acceptance contract (§9.3) önmagában is szállítható érték, és a v1.8-ban ezek egy csomagban álltak a fenti kalibrációs hegygel.

### 9.2.1. Periodic Chain Charter

Minden olyan lánchoz, amelynél stagnálás-detektálást akarunk enforced kontrollként használni, kötelező producer-független charter.

A v1.3-ban a charter **nem tartalmazhat kézzel megadott authoritative grace thresholdot**. A charter azt definiálja, **mit mérünk és milyen kalibrációs policyből származhat a threshold**; a konkrét effective grace értéket külön, verziózott calibration receipt adja.

```yaml
periodic_chain_charter:
  chain_id:
  version:
  authority:

  progress_invariant:
  progress_observation_source:

  phase_model:
    mode: phase_less | phased
    canonical_phase_source:
    phase_ids: []

  grace_policy:
    mode: calibrated
    calibration_policy_ref:
    review_policy_ref:
    missing_calibration_result: UNKNOWN

  legitimate_stationary_states:
  authoritative_wait_evidence:

  charter_hash:
```

Követelmények:

- `progress_invariant` mondja meg, mi számít valódi üzleti haladásnak;
- a charter nem mondhatja meg ad-hoc számmal, hány no-progress ciklus „fér bele”;
- a producer nem módosíthatja saját futása közben a chartert, phase-modellt vagy calibration policyt;
- a charter módosítása új policy-verzió és új audit receipt;
- nincs rendszer-szintű kényelmi default grace;
- enforced stagnálási döntéshez érvényes calibration receipt szükséges.

### 9.2.1.a. Periodic Grace Calibrator

A `Periodic Grace Calibrator` determinisztikus executor/resolver.

Feladata, hogy a ténylegesen megfigyelt progress-viselkedésből állítsa elő az effective grace policyt.

Minimum input:

```yaml
grace_calibration_request:
  chain_id:
  chain_charter_version:
  phase_id: optional_if_phase_less
  calibration_policy_ref:

  observations:
    eventual_progress_episode_refs:
    confirmed_stall_episode_refs:
    false_stall_episode_refs:

  prior_calibration_ref: optional
```

Az `eventual_progress` epizód olyan megfigyelt időszak, amelyben:

- volt runnable work;
- egy ideig nem látszott business-state delta;
- beavatkozás nélkül vagy a normál lánc részeként később authoritative progression következett be.

A `confirmed_stall` epizód olyan eset, amelyet független evidence/adjudication valódi stagnálásként igazolt.

A calibration-data nem származhat pusztán a detector saját korábbi címkéiből, különben self-confirming feedback loop keletkezne.

### 9.2.1.a.1. Episode Label Resolver – honnan jön a calibration ground truth?

A grace calibration nem kérhet automatikusan emberi címkét minden epizódhoz.

Külön `Episode Label Resolver` állítja elő a kalibrációban használható ground-truth címkét.

Canonical label state:

```text
AUTO_EVENTUAL_PROGRESS
AUTO_CONFIRMED_STALL
VERIFIER_EVENTUAL_PROGRESS
VERIFIER_CONFIRMED_STALL
HUMAN_EVENTUAL_PROGRESS
HUMAN_CONFIRMED_STALL
INTERVENED
CONFLICTING
UNLABELED
```

A forrás-prioritás:

```text
1. deterministic / authoritative auto-label
2. fresh verifier adjudication
3. human adjudication
4. különben UNLABELED
```

A human adjudication **nem kötelező lépés minden epizódnál**.

#### AUTO_EVENTUAL_PROGRESS

Automatikusan csak akkor adható, ha mind teljesül:

- ugyanaz a `chain_id`, `phase_id`, canonical contract és execution epoch;
- volt megfigyelt stationary szakasz;
- később authoritative business-state progression történt;
- VALID intervention-observability manifest bizonyítja a releváns mutation surface-ek COMPLETE coverage-ét, és nincs external/unknown mutation vagy intervention suspicion;
- nincs conflicting evidence.

Ez erős known-good / slow-progress calibration evidence.

#### AUTO_CONFIRMED_STALL

Automatikusan csak akkor adható, ha a stagnálást a detector saját outputjától **független determinisztikus hard-failure evidence** bizonyítja, például:

- a canonical scheduler/process ténylegesen nem fut;
- a szállított entry point nem indítható;
- terminal error miatt a lánc nem tud új ciklust végrehajtani;
- runnable work van, de az authoritative executor/worker identity bizonyítottan nem képes azt fogyasztani;
- explicit invariant bizonyítja, hogy további progression beavatkozás nélkül lehetetlen.

A puszta „sok ciklus óta nem halad” nem auto-confirmed stall; az maga a vizsgált jelenség.

#### INTERVENED

Ha az epizód alatt vagy a progression előtt történt például:

- manual restart;
- bugfix;
- config change;
- deployment change;
- policy/charter változás;
- owner/operator recovery action;

akkor az epizód nem kaphat automatikus eventual-progress vagy stall ground-truth címkét.

```text
INTERVENED
```

lesz, amíg independent adjudication nem állapítja meg a releváns counterfactualt.

Ez megelőzi azt a hibát, hogy:

```text
„beavatkoztunk és utána haladt”
→ automatikusan „előtte biztosan stall volt”
```

#### Intervention Visibility Contract

Az `AUTO_EVENTUAL_PROGRESS` és `AUTO_CONFIRMED_STALL` label csak akkor adható, ha az epizódhoz tartozik VALID intervention-observability manifest.

A chain charter deklarálja a releváns mutation surface-eket:

```yaml
intervention_surfaces:
  code:
  config:
  state:
  runtime:
  deployment:
```

Nem minden láncnál kell mind az öt; de amelyik surface a haladást vagy stagnálást érdemben befolyásolhatja, annak szerepelnie kell.

Az epizód elején a rendszer rögzíti:

```yaml
intervention_observability_manifest:
  episode_id:
  chain_id:
  phase_id:

  surfaces:
    - surface:
      coverage: COMPLETE | PARTIAL | NONE
      observation_method:
      baseline_fingerprint:
      event_cursor:
      engine_write_receipt_namespace:

  surface_inventory_status:
  surface_inventory_receipt_ref:
  detection_proof_refs:

  process_generation_id:
  deployment_ref:
  manifest_hash:
```

A megfigyelési módszer lehet meglévő Marveen primitive vagy AGP adapter, például:

- Settings change-log cursor;
- store file-audit cursor;
- git HEAD + dirty-tree/diff fingerprint;
- effective config hash;
- declared state-store revision/fingerprint;
- process/session generation id;
- deployment/target ref;
- AGP engine-originated mutation receipts.

A cél nem egy új univerzális audit platform építése, hanem a **lánc szempontjából releváns mutation surface-ek minimális, bizonyítható lefedése**.

##### Surface Inventory Completeness

A `COMPLETE` coverage nem alapulhat kizárólag azon, hogy a charter felsorolta a szerinte releváns felületeket.

Producer-független `Surface Inventory Resolver` deriválja a chain/phase releváns influence surface-eit authoritative scope-ból, például:

- executable entry point és dependency/import footprint;
- effective config sources;
- declared state stores / tables / files;
- runtime process/session identity;
- deployment target/ref;
- explicit external resource, amely progressiont befolyásolhat.

Canonical eredmény:

```text
INVENTORY_COMPLETE
INVENTORY_PARTIAL
INVENTORY_UNKNOWN
```

A charter/producer további surface-t hozzáadhat, de resolver által relevánsnak talált surface-t nem távolíthat el.

Ha a releváns influence surface-ek teljessége nem deriválható megbízhatóan:

```text
INVENTORY_UNKNOWN
→ overall coverage ≠ COMPLETE
→ AUTO_LABEL_FORBIDDEN
```

##### Detection Canary – a megfigyelőnek bizonyítania kell, hogy képes pirosodni

Minden `COMPLETE`-nek minősített required surface observation pathjához current detection proof kell.

Preferált proof egy biztonságos, ismert canary intervention:

```yaml
intervention_detection_canary:
  canary_id:
  chain_id:
  phase_id:
  surface_id:

  safe_test_action:
  expected_observation:
  detector_ref:
  timeout:
  cleanup_or_rollback:
```

Canonical result:

```text
CANARY_PASS
CANARY_FAIL
CANARY_ERROR
CANARY_UNSAFE
```

- `CANARY_PASS`: az ismert interventiont a tényleges observation path észlelte.
- `CANARY_FAIL/ERROR`: a surface nem maradhat COMPLETE; auto-label authority megszűnik.
- `CANARY_UNSAFE`: ha a canary nem futtatható biztonságosan, más independent proof kell; különben a surface coverage `PARTIAL/UNKNOWN`.

A canary **nem bizonyítja**, hogy nem hagytunk ki surface-t. Erre az inventory completeness szolgál.

##### Coverage revalidation

Inventory + detection proof revalidation kötelező legalább:

- chain entry point/dependency footprint változásakor;
- watcher/audit implementation vagy verzió változásakor;
- config/state source változásakor;
- runtime/deployment topology változásakor;
- audit/watcher gap vagy restart után;
- igazolt false-negative intervention incident után;
- a gate charter review policy szerint.

Coverage proof append-only receiptet kap; stale/superseded proof nem tarthat fenn COMPLETE státuszt.


##### Engine-originated vs external mutation

Minden olyan írás, amelyet a chain motor maga hajt végre és amelyet auto-label során meg akarunk engedni, kapjon engine-origin receiptet.

Ha ugyanazon surface-en mutation történik és nincs hozzá megfelelő engine-origin receipt:

```text
EXTERNAL_OR_UNKNOWN_MUTATION
```

Az episode:

```text
INTERVENED vagy UNLABELED
```

lesz, nem automatikus ground truth.

##### Manual restart / runtime generation

Process/session generation változása az episode közben intervention signal, kivéve ha a charter explicit módon bizonyítja, hogy a generation change a motor saját canonical transitionje és receiptelt.

Ismeretlen restart origin:

```text
UNLABELED
```

##### Conservative default

Auto-labelhoz kötelező:

```text
surface inventory = INVENTORY_COMPLETE
AND
all relevant surfaces coverage = COMPLETE
AND
all required detection proofs are current PASS
AND
no external/unknown mutation
AND
no unexplained process/deployment generation change
AND
no intervention suspicion
```

Ha bármelyik nem teljesül:

```text
AUTO_LABEL_FORBIDDEN
→ UNLABELED / INTERVENED
```

Különösen:

> **A beavatkozás hiányát csak teljes megfigyelési lefedettség mellett lehet bizonyítottnak venni.**

Nem elég az, hogy „nem láttunk semmit”.

##### Suspicion rule

Ha conflicting timestamp, fingerprint drift, audit gap, watcher restart, retention gap, unknown writer vagy más provenance-anomália miatt ésszerűen felmerülhet külső beavatkozás:

```text
INTERVENTION_VISIBILITY = SUSPECT
→ UNLABELED
```

A conservative default tudatosan csökkentheti az auto-label rate-et. Ez helyesebb, mint szennyezett calibration ground truthot gyártani.


#### VERIFIER_* címke

Ha a deterministic evidence nem elég, de az epizód üzletileg fontos a calibrationhoz, fresh verifier kaphat célzott episode packetet:

- immutable snapshots;
- event timeline;
- interventions;
- chain/phase contract;
- authoritative runtime evidence;
- downstream progression.

A verifier producer- és detector-független execution principal.

A verifiernek explicit verdictet és evidence receiptet kell adnia.

#### HUMAN_* címke

Human adjudication csak akkor szükséges, ha:

- deterministic resolver nem tud dönteni;
- verifier evidence konfliktusos vagy elégtelen;
- a calibration döntés high-impact policyt változtat;
- vagy hard-safety gate külön human authorityt ír elő.

Az emberi címke kivétel, nem alapfolyamat.

#### UNLABELED

Ha nincs elég evidence:

```text
UNLABELED
```

Az ilyen epizód:

- telemetryben megmarad;
- később újraadjudikálható;
- **nem használható enforced calibration ground truthként**.

#### Anti-self-confirmation invariant

Tilos:

```text
detector said STALLED
→ label = CONFIRMED_STALL
→ next calibration validates detector
```

A detector saját eredménye csak candidate signal, nem ground truth.

### 9.2.1.a.2. Label receipt

```yaml
episode_label_receipt:
  episode_id:
  chain_id:
  phase_id:
  label:
  label_authority:
    deterministic | verifier | human

  evidence_refs:
  intervention_refs:
  intervention_observability_manifest_ref:
  intervention_visibility_status:
  resolver_version:
  verifier_execution_id: optional
  human_principal: optional

  observed_at:
  adjudicated_at:
  receipt_hash:
```

A calibration csak megfelelő authority-jú, nem superseded label receiptet használhat.

### 9.2.1.a.3. Calibration emberi költség-budget – csak mért baseline-nal

Minden periodic calibration mérje legalább:

```text
episode_count
auto_labeled_count
verifier_labeled_count
human_labeled_count
unlabeled_count

auto_label_rate
verifier_label_rate
human_label_rate

human_minutes
verifier_token_cost
calibration_compute_cost

baseline_evidence_status
baseline_evidence_refs
measured_manual_monitoring_minutes
measured_manual_detection_minutes
measured_manual_diagnosis_minutes
measured_manual_recovery_minutes

false_block_adjudication_minutes
manual_override_recovery_minutes

economics_status
net_human_minutes_saved
```

Alapelv:

> **Nincs kötelező emberi döntés epizódonként, és nincs becsült ROI enforcement-döntéshez.**

#### Megengedett baseline-források

A manual baseline csak megfigyelt evidence-ből származhat:

1. **historical incident receipt**
   - tényleges, azonos vagy megfelelően ekvivalens failure class;
   - mért detection / diagnosis / recovery idő;
   - lehetőleg explicit human work intervalokkal;

2. **observe/shadow baseline window**
   - a gate még nem blokkol;
   - a normál emberi folyamat tovább él;
   - tényleges owner/operator monitoring/intervention idő mérve van;

3. **explicit manual-control sample**
   - előre kijelölt, rövid összehasonlító ablak;
   - valódi emberi monitoring work időzítve;
   - nem szimulált „szerintünk ennyi lenne” érték.

Nem megengedett enforced economics evidence-ként:

```text
agent estimate
owner guess
survey estimate
industry average
„tipikusan 10 perc”
nem mért historical emlék
```

#### Economics state

```text
MEASURED_POSITIVE
MEASURED_NONPOSITIVE
UNKNOWN
```

`MEASURED_POSITIVE` csak akkor:

```text
valid measured baseline
+
measured calibration/adjudication burden
+
measured false-block/override burden
→ net_human_minutes_saved > 0
```

`MEASURED_NONPOSITIVE` akkor, ha mindkét oldal mért, de a nettó emberi megtakarítás ≤ 0.

`UNKNOWN` akkor, ha nincs érvényes measured baseline vagy a counterfactual nem összehasonlítható.

`UNKNOWN` esetén:

- ne számoljunk ki látszólag precíz ROI-t;
- ne helyettesítsük becsléssel;
- a gate ne hivatkozhasson „megtakarításra” promotion indokként.

#### Promotion policy economics alapján

**Pure efficiency / convenience gate**

```text
ECONOMICS_UNKNOWN
→ observe/assisted marad

MEASURED_NONPOSITIVE
→ default enforced promotion tilos

MEASURED_POSITIVE
→ economics oldalról promotion eligible
```

**Correctness / reliability gate, nem hard-safety**

Enforced promotionhoz legalább egyik kell:

- mért valódi defect-prevention evidence megfelelő severityvel; vagy
- `MEASURED_POSITIVE` operational economics;

és továbbra is teljesülnie kell a false-pass/false-block és negative-control feltételeknek.

Pusztán hipotetikus elkerült hiba vagy becsült emberi megtakarítás nem elég.

**Hard safety / security / privacy / data-loss invariant**

`ECONOMICS_UNKNOWN` nem blokkolja automatikusan az enforced promotiont.

Ilyenkor a döntési authority:

```text
safety classification
+
negative controls
+
measured operational overhead
+
explicit owner/safety acceptance
```

A gazdasági szám informatív, nem a safety gate igazságának forrása.

Ha egy nem hard-safety progress gate csak úgy tartható kalibrálva, hogy az epizódok rendszeres vagy domináns részét embernek kell adjudikálnia, akkor:

```text
CALIBRATION_ECONOMICS = NOT_LEAN
```

és a gate nem válhat automatikusan enforced defaulttá.

Ha nincs elég automatikusan/verifierrel címkézett data vagy nincs mért economics baseline:

```text
CALIBRATION = UNCALIBRATED
vagy
ECONOMICS = UNKNOWN
```

A kettőt külön kell kezelni: a calibration technikailag lehet VALID úgy is, hogy az economics még UNKNOWN.


### 9.2.1.b. Threshold kiválasztási szabály

A kalibrátor candidate thresholdokat kizárólag a megfigyelt stationary-streak / duration határokból képezzen.

A kiválasztás lexikografikus:

1. **első cél: false-stall elkerülése** a known-good / eventual-progress calibration + validation seten;
2. **második cél: a legkisebb olyan threshold kiválasztása**, amely az első célt teljesíti;
3. **harmadik cél: true-stall fixture/episode esetén a detektálási késleltetés minimalizálása** az azonosan biztonságos jelöltek között.

A raw threshold tehát nem emberi becslés, hanem a kalibráció reprodukálható eredménye.

Ha:

- nincs elegendő érvényes eventual-progress evidence;
- a phase nincs kalibrálva;
- a calibration inputok ellentmondanak;
- a calibration validation megbukik;
- vagy nincs stabil, reprodukálható policy;

akkor:

```text
CALIBRATION_STATUS = UNCALIBRATED
progress gate = UNKNOWN
```

Nem engedélyezett:

```text
„tegyünk be ideiglenesen 3 ciklust”
```

mint enforced fallback.

Observe módban gyűjthető evidence kalibráció nélkül; enforced authorityt azonban nem adhat.

### 9.2.1.c. Calibration receipt

```yaml
periodic_grace_calibration:
  calibration_id:
  chain_id:
  chain_charter_version:
  phase_id: optional_if_phase_less

  calibration_policy_ref:
  observation_manifest_hash:

  eventual_progress_episode_count:
  confirmed_stall_episode_count:
  false_stall_episode_count:

  auto_labeled_count:
  verifier_labeled_count:
  human_labeled_count:
  unlabeled_count:
  human_minutes:
  verifier_token_cost:

  economics_status:
  baseline_evidence_refs:
  measured_manual_baseline_minutes: optional
  measured_net_human_minutes_saved: optional

  selected_max_no_progress_cycles:
  selected_max_no_progress_duration: optional

  validation:
    false_stall_count:
    confirmed_stall_detection_results:
    status: VALID | INVALID | UNCALIBRATED

  valid_from:
  review_due_at:
  supersedes:
  calibration_hash:
  generated_by: periodic_grace_calibrator
```

A receipt visszakövethetővé teszi a döntést, de a threshold helyességét a mögötte lévő calibration evidence + validation bizonyítja.

### 9.2.1.d. Phase-aware grace – kötelező szabály

Ha:

```text
phase_model.mode = phased
```

akkor:

- minden progress snapshot tartalmazzon canonical `phase_id`-t;
- minden enforced stagnálási döntéshez az adott `phase_id`-hoz tartozó VALID calibration kell;
- planning, implementation, verification vagy más phase külön calibrationt kaphat;
- globális grace fallback **tilos**;
- egy másik phase calibrationjének reuse-a **tilos**;
- hiányzó phase calibration → `UNKNOWN`;
- phase transition reseteli a no-progress streaket;
- a canonical phase transition maga authoritative progress event lehet, ha a chain charter ezt progressként definiálja.

Ez megakadályozza, hogy:

- a leglassabb phase túl nagy globális grace-e vakká tegye a gyors phase-ek stagnálás-detektorát;
- vagy a leggyorsabb phase rövid grace-e false-stallt gyártson a lassú, legitim planning phase-ben.

### 9.2.1.e. Calibration lifecycle és drift

A calibration immutable és verziózott.

Kötelező revalidation/recalibration trigger legalább:

- canonical chain contract változás;
- phase model vagy phase semantics változás;
- progress invariant változás;
- confirmed false-stall;
- confirmed missed/delayed stall, amely a jelenlegi policy értékét megkérdőjelezi;
- megfigyelt stationary/progress eloszlás material driftje;
- a calibration policy által meghatározott review pont.

Az új calibration nem írja felül a régit; `supersedes` láncon lép életbe.

Futó execution közben az effective calibration nem cserélhető silent módon. Új calibration csak explicit policy boundarynál vagy új execution/episode kezdetén léphet életbe.

Stale, invalid vagy superseded calibration nem adhat enforced PASS/FAIL authorityt.

Ha a required progress checkhez nincs érvényes calibration:

```text
UNKNOWN
```

és **nem** `STALLED`, **nem** `PASS`.

Enforced módban ez `INCOMPLETE/BLOCK`, amíg a chain/phase calibration nem lesz érvényes.


### 9.2.2. Progress snapshot

A progress executor egymást követő completed cycle-ok tényleges business state-jét hasonlítsa össze.

```yaml
progress_snapshot:
  chain_id:
  chain_charter_version:
  chain_charter_hash:
  phase_id: optional_if_phase_less
  grace_calibration_id:
  grace_calibration_hash:
  cycle_id:
  observed_at:
  runnable_items:
  state_vector_hash:
  business_progress_tokens:
  terminal_count:
  blocked_count:
  waiting_count:
  no_progress_cycles:
  no_progress_duration:
```

A belső stagnation counter csak telemetry. Nem authority.

### 9.2.3. Domain state és gate mapping

A progress detector domain-state-je:

```text
PROGRESSING
WITHIN_GRACE
STALLED
UNKNOWN
ERROR
```

Mapping a canonical gate resultba:

```text
PROGRESSING  → PASS
WITHIN_GRACE → PASS + explicit progress_state=WITHIN_GRACE
STALLED      → FAIL
UNKNOWN      → UNKNOWN
ERROR        → ERROR
```

A `WITHIN_GRACE` PASS jelentése kizárólag:

> a deklarált chain policy alapján még nincs elég bizonyíték stagnálás kimondására, ezért a progression nem blokkolható.

Nem jelentheti azt, hogy a lánc ténylegesen már haladt.

### 9.2.4. STALLED feltétel

`STALLED` csak akkor mondható ki, ha mind teljesül:

```text
runnable_items > 0
ÉS
nincs elfogadható business-state delta
ÉS
az aktuális phase-hez VALID calibration tartozik
ÉS
a kalibrált canonical grace window lejárt
ÉS
nincs authoritative WAITING_EXTERNAL / legitimate stationary evidence
```

A lánc saját progression invariantja lehet például:

- stage változás;
- cursor előrelépés;
- remaining-work csökkenés;
- terminal count növekedés;
- explicit retry budget fogyás;
- tervezési artifact canonical revisionje, ha ezt a charter progressként definiálja;
- igazolt external wait state.

### 9.2.5. Kötelező többirányú kontroll

A stagnálás-detektor elfogadásához legalább az alábbi eseteket kell bizonyítani:

```text
TRUE_STALL_BEYOND_CALIBRATED_GRACE
→ STALLED / FAIL

LEGITIMATE_SLOW_PROGRESS
→ WITHIN_GRACE ... → PROGRESSING
→ soha nem STALLED

MISSING_OR_INVALID_CALIBRATION
→ UNKNOWN

PHASE_AWARE_SLOW_THEN_FAST
→ planning phase: saját kalibrált grace
→ phase transition
→ execution phase: saját, külön kalibrált grace
→ nincs globális fallback
→ nincs false-stall és nincs szükségtelen detektálási késés

STALE_CALIBRATION
→ UNKNOWN / recalibration required
```

A detector ezzel nemcsak azt bizonyítja, hogy tud megállítani, hanem azt is, hogy:

- nem gyárt hibát legitim lassú haladásból;
- nem használ egyetlen globális thresholdot eltérő viselkedésű phase-ekre;
- és nem kezel auditálható, de empirikusan nem validált számot authorityként.

Canonical failure:

```text
PERIODIC_CHAIN_STALLED
```

Canonical configuration gap:

```text
PERIODIC_PROGRESS_POLICY_UNKNOWN
```

---

## 9.3. Dual-sided Acceptance Contract

Minden acceptance criterionhoz kötelező két oldal:

```yaml
acceptance_control:
  criterion_id:
  positive_condition:
  red_condition:
  executor_or_resolver:
  required_evidence:
  negative_fixture_refs:
```

Nem szükséges minden acceptance sorhoz külön, egyedi tesztfájl.

Viszont minden acceptance dimenzióhoz kötelező megmondani:

> **Mitől menne pirosra?**

Ha erre nincs gépileg vagy hiteles authorityből bizonyítható válasz, a criterion nem enforced-ready.

---

## 9.4. Cross-Component Effect Propagation Control

### 9.4.1. Cél

Ha egy feature vagy acceptance criterion két vagy több komponens közötti adat-/eseményátadástól függ, a komponensenkénti correctness nem elegendő.

Alapelv:

> **The handoff is proven by downstream effect, not by upstream emission or downstream execution alone.**

### 9.4.2. Handoff Edge Contract

Minden acceptance-szempontból releváns komponenshatárhoz:

```yaml
handoff_effect_contract:
  contract_id:
  version:

  upstream_component:
  downstream_component:

  stimulus:
    kind:
    source_ref:

  correlation:
    correlation_id_source:
    propagation_rule:

  transfer_evidence:
    optional_transport_receipt:

  expected_effect:
    effect_kind:
      state_transition | behavior_change | emitted_result | terminal_completion
    authoritative_observation_source:
    expected_value_or_predicate:

  observation_window:
  failure_semantics:
```

A contractot nem a producer alakíthatja át runtime közben saját PASS érdekében.

### 9.4.3. Proof chain

Minimum proof:

```text
KNOWN INPUT / STIMULUS
        ↓
UPSTREAM ACCEPTS / EMITS
        ↓
CORRELATION IDENTITY
        ↓
DOWNSTREAM CONSUMPTION OR PROCESSING
        ↓
EXPECTED OBSERVABLE EFFECT
```

A végső PASS authority az utolsó elemhez kötött.

Nem elég:

```text
event exists
AND
consumer ran
```

ha:

```text
expected behavior/state unchanged
```

### 9.4.4. Canonical result

```text
PASS
FAIL
UNKNOWN
ERROR
```

Canonical failure class:

```text
EFFECT_NOT_PROPAGATED
```

`FAIL`, ha:

- a stimulus authoritative módon létrejött;
- a releváns downstream execution/observation window megtörtént;
- de az expected effect nem állt elő.

`UNKNOWN`, ha:

- nincs elég correlation evidence;
- nem bizonyítható, mely downstream execution tartozott a stimulushoz;
- az authoritative effect observation source nem elérhető.

`ERROR`, ha a probe/executor technikailag nem tudott lefutni.

### 9.4.5. Async handoff

Aszinkron rendszernél nem kell azonnali effect.

Kötelező:

- bounded observation window;
- correlation identity;
- explicit terminal/expected effect predicate.

A window nem lehet ad-hoc producer guess; canonical project/runtime contractból vagy mért, valid policyból jön.

### 9.4.6. Negatív kontroll

Kötelező fixture:

```text
upstream event = correct
downstream process = running
consumer path = disabled / response ignored / schema mismatch
expected downstream state = unchanged

expected:
EFFECT_NOT_PROPAGATED
```

Ez bizonyítja, hogy a gate nem csak komponens-local healthot mér.

### 9.4.7. Reverse / false-block kontroll

Known-good fixture:

```text
upstream stimulus
→ valid correlation
→ legitimate async delay
→ expected downstream effect within contract window
```

nem jelölhető failure-nek pusztán azért, mert a komponensek között nem azonnal változik az állapot.

### 9.4.8. Lean scope

Nem kell minden belső függvényhívásra handoff executor.

A kontroll akkor required, ha:

- acceptance criterion komponenshatáron átnyúló effektust ígér;
- user action → engine behavior;
- service → worker;
- UI/API → event consumer;
- queue/event → state transition;
- workflow step → következő component behavior;
- vagy hasonló cross-component dependency nélkül a feature nem tekinthető késznek.

Deterministic probe preferált. Semantic verifier csak akkor kell, ha maga az expected effect szemantikai.

---

## 9.5. Backlog Recovery / Replay Proof

### 9.5.1. Cél

A v1.7 cross-component proof a friss stimulus útját bizonyítja.

A v1.8 hozzáadja a recovery invariantot:

> **A fix akkor teljes, ha nemcsak a jövőbeli inputot dolgozza fel, hanem a javítás pillanatában már tartósan rögzített, még érvényes és feldolgozatlan inputot is.**

Ez különösen fontos:

- durable queue;
- database-backed event;
- approval/decision record;
- pending workflow transition;
- message inbox;
- persisted command;
- retryable job

esetén.

### 9.5.2. Handoff proof mode

A `handoff_effect_contract` minimum:

```yaml
proof_modes:
  - FRESH_INPUT
  - PREEXISTING_ELIGIBLE_UNCONSUMED_INPUT
```

Nem minden handoffnak kell mindkettőt támogatnia.

A backlog/replay mód akkor required, ha:

- az upstream input durable módon perzisztál;
- az input élettartama túlélheti a consumer hibáját/restartját/deploymentjét;
- a rendszer üzleti ígérete szerint a pending input elvesztése nem elfogadható.

### 9.5.3. Backlog Eligibility Contract

Replay előtt determinisztikusan fel kell oldani, hogy a persisted input még feldolgozható-e.

```yaml
backlog_eligibility_contract:
  contract_id:
  version:

  durable_input_source:
  input_identity:
  correlation_identity:

  eligibility_predicates:
    persisted:
    not_consumed:
    not_cancelled:
    not_expired:
    not_superseded:
    workflow_state_allows_processing:
    current_schema_or_upgrade_path_valid:

  consumed_receipt_source:
  supersede_source:
  expiry_source:
  workflow_state_source:

  on_ineligible:
    SKIP_WITH_RECEIPT

  contract_hash:
```

A producer nem lazíthatja runtime közben az eligibility predicate-eket saját PASS érdekében.

### 9.5.4. Canonical eligibility result

```text
ELIGIBLE
INELIGIBLE
UNKNOWN
ERROR
```

`ELIGIBLE` csak authoritative evidence alapján.

`UNKNOWN` esetén:

```text
NO REPLAY AUTHORITY
```

és required recovery gate-nél `INCOMPLETE/BLOCK`.

### 9.5.5. Recovery proof chain

```text
PREEXISTING PERSISTED INPUT
        ↓
ELIGIBILITY = ELIGIBLE
        ↓
NO PRIOR CONSUMED RECEIPT
        ↓
REPAIRED CONSUMER DISCOVERS INPUT
        ↓
CORRELATED PROCESSING
        ↓
EXPECTED DOWNSTREAM EFFECT
        ↓
CONSUMED / PROCESSED RECEIPT
```

PASS csak az utolsó két elem authoritative bizonyítása után.

### 9.5.6. Canonical result / failure classes

```text
PASS
FAIL
UNKNOWN
ERROR
```

Kiemelt failures:

```text
BACKLOG_NOT_DISCOVERED
BACKLOG_NOT_CONSUMED
EFFECT_NOT_PROPAGATED
DUPLICATE_EFFECT
INELIGIBLE_INPUT_REPLAYED
```

### 9.5.7. Idempotency

A replay/retry recovery kötelező invariánsa:

> **same logical input → at most one authoritative business side effect**

Minimum:

- stable input identity;
- consumed/processed receipt;
- duplicate detection;
- idempotent or deduplicated effect path.

Ha ugyanaz az input kétszer fut át:

```text
second processing attempt
→ NO SECOND EFFECT
→ DUPLICATE / ALREADY_PROCESSED receipt
```

A rendszer nem használhatja azt az egyszerű stratégiát, hogy „biztonság kedvéért mindent újra lefuttatunk”.

### 9.5.8. Fix / restart / deployment recovery

Ha a consumer javítása deploy/restarttal jár:

- a restart/deployment önmagában nem jelenti a backlog feldolgozását;
- startup után explicit recovery scan / cursor resume / durable queue consumption bizonyítandó;
- a proof ugyanahhoz az input identityhez és downstream effecthez kötött.

### 9.5.9. Fresh path + backlog path acceptance

Ha backlog recovery required:

```text
FRESH_INPUT = PASS
AND
PREEXISTING_ELIGIBLE_UNCONSUMED_INPUT = PASS
```

kell a feature-level acceptancehez.

Csak fresh PASS esetén:

```text
RECOVERY_INCOMPLETE
```

### 9.5.10. Lean implementation

Nem kell új Backlog Service.

Preferált reuse:

- meglévő DB pending state;
- durable queue;
- existing cursor;
- processed flag;
- receipt table/store;
- idempotency key;
- existing scheduler/worker wakeup.

Az AGP feladata:

- eligibility contract;
- recovery probe;
- effect proof;
- receipt.

Nem az underlying queue/runtime újraépítése.

---

# 10. Fázis B – Product Identity + Currentness

## 10.1. Product identity

Minden AGP work itemhez legyen first-class:

```text
product_id
```

A product identity:

- explicit;
- immutable vagy kontrolláltan változtatható;
- minden claimhez, receipthez, work itemhez és context packethez kapcsolható.

Ismeretlen product esetén:

```text
PRODUCT_ID_UNKNOWN
```

Enforced product-specific workflow nem indul.

---

## 10.2. Currentness

Az AGP külön kezelje:

```text
CURRENT
HISTORICAL
SUPERSEDED
CONFLICTING
UNKNOWN
```

Nem elég a fájl módosítási ideje.

Currentness alapja lehet:

- supersede relation;
- canonical owner decision;
- runtime observation;
- source version;
- effective config;
- deployment ref;
- explicit currentness receipt.

---

## 10.3. Claim model

Minimum:

```yaml
claim:
  claim_id:
  product_id:
  text:
  class:

  source_type:
  source_ref:
  observed_at:

  verification_status:
  verification_receipt_id:

  currentness:
  supersedes:
  superseded_by:

  allowed_wording:
```

A `VERIFIED_CURRENT` kizárólag replayelhető vagy authoritative receipt alapján adható.

---

# 11. Fázis C – Execution Identity + Delegation Provenance

## 11.1. Probléma

A Marveen agent-busz szállítási mechanizmusa nem tekinthető cryptographic authority boundarynek.

Egy `from_agent` mező vagy shared bearer token önmagában nem bizonyítja, hogy:

- valóban az adott agent hozta az állítást;
- az agent jogosult authorityt adni;
- a kérő agent nem tudta a forrást imitálni;
- a döntés valóban embertől jött.

---

## 11.2. Execution principal

Az AGP runner minteljen execution identityt.

```yaml
execution_identity:
  execution_id:
  work_item_id:
  agent_id:
  role:
    producer | verifier | executor | owner
  session_id:
  target_ref:
  context_packet_hash:
  created_at:
  issued_by: agp_runner
```

Authority esetén ne az agent saját self-declared identityje legyen a döntő.

---

## 11.3. Delegáció

A producer szabadon kérhet más agenttől segítséget.

Delegated output:

```text
CREATOR_CLAIMED
```

amíg nem kerül verifikálásra.

A delegáció:

- nem ad automatikusan authorityt;
- nem teszi bizonyítékká az outputot;
- nem változtatja meg az acceptance chain-t;
- nem jogosít self-approvalra.

Ez megőrzi a kreatív multi-agent kollaboráció szabadságát, miközben a trust boundary kontrollált marad.

---

## 11.4. Human approval

Owner decision külön authority class.

Elv:

> Human-required gate csak hitelesített human principalből oldható fel.

A Marveen upstreamben ezt generikus capabilityként kell preferálni.

Preferált cél:

```text
authenticated human principal
+
server-side resolved_by attribution
+
human_required approval category
```

Nem elég:

```text
resolved_by: "owner"
```

a request bodyban.

---

# 12. Fázis D – Context Router + Fresh Verification

## 12.1. Context packet

Minden execution célzott contextet kapjon.

Minimum:

```yaml
context_packet:
  packet_id:
  work_item_id:
  product_id:
  execution_role:

  objective:
  constraints:
  acceptance_criteria:

  verified_claims:
  current_decisions:
  relevant_artifacts:

  allowed_tools:
  forbidden_actions:

  packet_hash:
  generated_at:
```

---

## 12.2. Producer context

Tartalmazhat:

- releváns product contextet;
- előző döntéseket;
- szükséges forrásokat;
- implementation historyt;
- design kontextust.

A producer kreatív munkához több kontextust kaphat.

---

## 12.3. Fresh verifier context

Infrastructure-level jelentése:

- producerétől eltérő execution identity;
- új session;
- célzott verifier context packet;
- immutable target;
- acceptance contract;
- verified claims;
- szükséges constraints;
- producer teljes session historyja nélkül.

Nem kötelező:

- másik modell;
- más provider;
- más agent persona.

Más modell csak risk/cost policy alapján.

---

## 12.4. Költségpolicy

### LOW risk

```text
deterministic executors
semantic verifier nélkül
```

### MEDIUM risk

```text
deterministic executors
+
maximum 1 semantic verifier, ha szükséges
```

### HIGH / CRITICAL

```text
deterministic executors
+
1 fresh semantic verifier
+
szükség esetén owner gate
```

A semantic verifier nem automatikusan minden change költsége.

---

# 13. Fázis E – Graph / Change Runner

## 13.1. Szerepe

Az AGP 1.0 tényleges automata progression motorja.

Feladata:

- work item indítása;
- risk/profile feloldása;
- context készítése;
- producer dispatch;
- executor trigger;
- verification;
- acceptance;
- return-for-fix;
- owner-decision request;
- resume;
- safe delivery handoff;
- close.

---

## 13.2. Runner nem workflow-bürokrácia

A runner ne írjon elő sok fix lépést.

A graph profile-ból épüljön.

Példa low-risk:

```text
scope
→ execute
→ deterministic verify
→ accept
```

Medium:

```text
scope
→ execute
→ deterministic verify
→ semantic verify
→ accept
```

High:

```text
scope
→ evidence
→ execute
→ deterministic verify
→ semantic verify
→ owner decision
→ safe delivery
→ runtime verify
```

---

## 13.3. Progression rule

Minden edge-hez:

```yaml
transition:
  from:
  to:
  required_gate_ids:
  allowed_results:
  executor_refs:
```

Blocking transition executor nélkül build-time/spec-conformance hibát adjon.

---

# 14. Módszertani conformance

A 0.4 tapasztalat alapján a dokumentált `MUST` nem elég.

Az AGP 1.0 canonical spec minden progressiont, acceptance-et, authorityt, security/privacy boundaryt vagy production side effectet befolyásoló `MUST/SHALL` szabályához tartozzon:

```text
executor
vagy
authoritative resolver
vagy
explicit human gate
```

Conformance suite ellenőrizze:

```text
blocking_rule -> executable_control
```

Ha nincs:

```text
DOCUMENT_ONLY_CONTROL
```

és enforced-ready státusz nem adható.

Kreatív/advisory guideline kivétel.

---

# 15. Fázis F – Marveen Kanban + Dispatch Integration

## 15.1. Kanban szerepe

A Kanban:

- vizuális munkaállapot;
- human control surface;
- projection.

Nem a belső AGP truth source.

---

## 15.2. Done ≠ Accepted

Marveen `done`:

```text
producer completed
```

AGP acceptance:

```text
verification + acceptance contract satisfied
```

A kettő külön mező.

---

## 15.3. Dispatch

A runner dönthet automatikus dispatchelről, de:

- agent assignment profile szerint;
- execution identityt mintel;
- context packetet ad;
- dispatch receiptet ír;
- nem bízik vakon a busz reply-ban;
- completion claim után verifikál.

---

# 16. Fázis G – Safe Delivery + Runtime Verification

Az 1.0 end-to-end fejlesztési lánc része.

Minimum:

```text
accepted change
→ delivery candidate
→ deployment authority check
→ deploy
→ runtime verification
→ success / rollback
```

A deploy mechanizmus lehet meglévő tool/CI.

Az AGP nem feltétlen maga deployol.

A kontroll lényege:

- immutable deploy target;
- receipt;
- environment identity;
- runtime probe;
- rollback path.

---

## 16.1. Production side effect

Alapértelmezés:

```text
assisted
```

Auto-deploy csak külön opt-in policyval.

High/critical production side effect owner gate-hez köthető.

---

# 17. Fázis H – Full Product LCM Closed Loop

A Product LCM és Change Delivery FSM maradjon külön.

Az AGP 1.0-ban a change eredménye vissza tudjon kerülni a product lifecycle-ba:

```text
product hypothesis
→ change
→ delivery
→ runtime
→ measurement
→ evidence
→ product review
→ next change / pivot / stop
```

A Product LCM ne váljon minden apró commit workflow-jává.

---

# 18. Risk Profile rendszer

A gate-eket ne globálisan minden change-re kapcsoljuk.

Minimum risk class:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

Risk input például:

- production side effect;
- auth/security;
- PII;
- destructive DB;
- billing;
- tenant isolation;
- user-facing legal;
- rollback difficulty;
- blast radius;
- dependency upgrade;
- unknown system state.

---

## 18.1. LOW

Példák:

- copy;
- egyszerű CSS;
- internal docs;
- low-risk test update.

Default:

- deterministic;
- nincs semantic verifier;
- owner nincs.

---

## 18.2. MEDIUM

Példák:

- normál feature;
- API behavior;
- kisebb refactor;
- új UI flow.

Default:

- deterministic;
- semantic verifier csak ha acceptance szemantikai;
- owner csak decision esetén.

---

## 18.3. HIGH

Példák:

- auth;
- tenant boundary;
- pricing/billing;
- customer data;
- deployment policy.

Default:

- deterministic;
- fresh semantic verifier;
- erősebb evidence;
- szükség szerint owner.

---

## 18.4. CRITICAL

Példák:

- irreversible data migration;
- credential/security boundary;
- high blast radius production operation.

Default:

- explicit rollback;
- negative control;
- verifier;
- owner gate;
- runtime verification.

---

# 19. Owner interaction minimalizálása

Az AGP 1.0 célja nem az approvalok számának növelése.

Owner csak:

- üzleti trade-off;
- jogi/policy decision;
- irreversible change;
- high-risk authority;
- conflicting authoritative evidence;
- unresolved ambiguity.

Ne kérjen ownertől:

- typecheck döntést;
- unit-test interpretációt;
- formatter döntést;
- normál implementation detailt;
- olyan választ, amit executor objektíven eldönt.

---

# 20. Agent Challenge Path

A kreativitás megőrzéséhez first-class lehetőség:

```text
CHALLENGE_CONTRACT
```

A producer jelezheti:

- az acceptance criterion hibás;
- a scope túl szűk;
- jobb solution van;
- constraint ellentmond a product goalnak;
- a requested implementation veszélyes.

Ekkor ne „szabálysértés” legyen.

A runner:

```text
execution pause
→ challenge evidence
→ owner/architect decision
→ contract update / reject challenge
→ resume
```

A producer tehát nem kényszerül vakon rossz specifikációt implementálni.

---

# 21. Gate Charter

Minden új blocking gate dokumentálja:

```yaml
gate_charter:
  gate_id:
  purpose:
  failure_mode:
  historical_incident:
  severity:

  gate_class:
    efficiency | correctness_reliability | hard_safety

  executor:
  required_evidence:
  expected_latency:
  expected_cost:
  false_block_risk:

  periodic_chain_charter_ref: optional
  false_stall_fixture_ref: optional

  economics_evidence_policy: optional
  economics_min_evidence_policy: optional
  economics_hysteresis_policy: optional
  economics_lifecycle_consequence: optional

  intervention_visibility_requirements: optional

  review_interval:
  downgrade_rule:
  retirement_rule:
```

### Historical incident

Preferáltan konkrét megtörtént hiba.

Kivétel:

- security;
- privacy;
- data-loss;
- compliance hard invariant.

Itt nem szükséges megvárni az első incidenst.

---

# 22. Gate érték mérése

Minimum telemetria:

```text
eligible_runs
pass_count
fail_count
unknown_count
error_count
not_required_count

real_defects_caught
severity_weighted_defects

false_blocks
post_pass_escapes

added_latency_ms
token_cost
human_interrupts
override_rate
rerun_rate

calibration_episode_count
auto_label_rate
verifier_label_rate
human_label_rate
human_label_minutes
calibration_verifier_token_cost

intervention_visibility_complete_rate
external_or_unknown_mutation_count
intervention_suspect_count

economics_status
measured_baseline_episode_count
measured_manual_baseline_minutes
measured_net_human_minutes_saved
```

A `measured_*` gazdasági mezők csak valid measurement receiptből tölthetők. Becsült baseline esetén:

```text
economics_status = UNKNOWN
```

és a numerikus megtakarítás mezők maradjanak `null`, ne becsült értéket tartalmazzanak.

Javasolt derived mutatók:

```text
defect_catch_rate
escape_rate
false_block_rate
cost_per_caught_defect
latency_per_caught_defect
owner_interrupts_per_100_changes
```

---

# 23. Gate leállítás / downgrade

Nem minden gate marad örökké, és a measurement nem lehet következmény nélküli.

Review akkor kötelező, ha például:

- magas false-block rate;
- override rate tartósan >20%;
- jelentős latency;
- jelentős tokenköltség;
- azonos hibát olcsóbb deterministic kontroll megfogja;
- sok `UNKNOWN`, kevés valódi measurement;
- a gate output nem változtat döntést;
- economics státusz romlik;
- coverage/currentness evidence stale vagy invalid lesz.

Lehetséges maturity döntés:

```text
ENFORCED_READY
→ ASSISTED_READY / ADVISORY
→ OBSERVE / EXPERIMENTAL
→ REMOVED
```

## 23.1. Economics lifecycle binding

A gate charter `gate_class` szerint más consequence policyt használ.

### Efficiency gate

Az enforcement justificationje az operational benefit.

```text
current MEASURED_POSITIVE
→ ENFORCED_READY megtartható

authoritative MEASURED_NONPOSITIVE
→ deterministic downgrade
→ ENFORCED_READY → ASSISTED_READY / ADVISORY

economics evidence stale/invalid
→ ECONOMICS_UNKNOWN
→ az economics-alapú enforcement justification megszűnik
→ legalább ASSISTED_READY
```

A `MEASURED_*` státusz nem változhat egyetlen zajos mintától. A charter előre rögzíti:

- minimum sample/episode count;
- minimum observation window;
- evidence freshness;
- confirmation/hysteresis policy.

A producer ezeket futás közben nem módosíthatja.

### Correctness / reliability gate

```text
MEASURED_NONPOSITIVE
→ MANDATORY_VALUE_REVIEW
```

de nem automatikus kikapcsolás.

Ha current, mért defect-prevention evidence továbbra is igazolja a gate-et:

```text
enforcement marad
+ optimization/replacement review
```

Ha ez az independent justification sincs:

```text
downgrade
```

### Hard safety gate

Economics önmagában nem változtathat enforcementet.

```text
MEASURED_NONPOSITIVE
→ COST/ARCHITECTURE_REVIEW
→ enforcement remains
```

Downgrade csak:

- safety classification változás;
- bizonyított equivalent/stronger replacement control;
- megfelelő explicit safety/human authority;

alapján.

## 23.2. No consequence-free metric

Ha egy metric promotiont, retentiont, downgrade-ot vagy retirementet indokol, a gate charterben explicit consequence mapping szükséges.

Ha nincs consequence mapping:

```text
metric = observational only
```

és nem használható enforcement justificationként.

Hard safety gate-et nulla catch vagy negatív economics miatt önmagában nem szabad eltávolítani.


# 24. Működési módok

## 24.0. A mód compositional, nem monolitikus

A global/product mód az alap enforcement policy, de egyetlen új vagy kalibrálatlan gate miatt nem szabad az egész terméket visszaminősíteni.

A tényleges viselkedés két tengelyből áll:

```text
parent execution mode
+
gate maturity
```

Parent execution mode:

```text
OFF | OBSERVE | ASSISTED | ENFORCED
```

Gate maturity:

```text
UNVALIDATED
OBSERVE_CALIBRATION
ASSISTED_READY
ENFORCED_READY
```

### 24.0.1. Global OFF

```text
global = OFF
```

abszolút master off.

Alacsonyabb scope nem kapcsolhatja vissza.

### 24.0.2. Product default

A product mode megadhatja a termék normál működését.

Például:

```text
product = ENFORCED
```

Ez **nem** jelenti azt, hogy egy új, még nem validált gate azonnal enforced authorityt kap.

### 24.0.3. Chain/gate scoped maturity

Minden periodic chain és releváns gate külön maturity recordot kap:

```yaml
control_maturity:
  scope_type: chain_gate
  product_id:
  chain_id:
  gate_id:

  maturity:
    UNVALIDATED |
    OBSERVE_CALIBRATION |
    ASSISTED_READY |
    ENFORCED_READY

  reason:
  calibration_ref:
  validation_refs:
  issued_by:
  issued_at:
  expires_or_review_at:
```

Egy új periodikus chain tipikus indulása:

```text
product mode = ENFORCED

chain A / typecheck gate = ENFORCED_READY
chain A / security gate  = ENFORCED_READY
chain A / progress gate  = OBSERVE_CALIBRATION
```

Tehát:

- a termék nem kerül vissza observe módba;
- a chain többi enforced kontrollja nem gyengül;
- csak a még kalibrálatlan progress gate fut shadow/observe módban;
- a progress gate közben gyűjti a calibration evidence-et.

### 24.0.4. Kalibrálatlan progress gate viselkedése

Ha:

```text
parent mode = ENFORCED
gate maturity = OBSERVE_CALIBRATION
```

akkor az adott progress gate:

- fut és receiptet ír;
- shadow verdictet számol;
- calibration episode-okat gyűjt;
- **nem blokkol csak azért, mert még nincs valid calibration**;
- explicit UI/status jelzi: `OBSERVE_CALIBRATION / NOT YET ENFORCED`;
- nem adhat enforced PASS authorityt.

Ez egy kontrollált rollout-state, nem implicit fail-open.

### 24.0.5. Nincs kézi blanket downgrade

Producer, worker vagy a futó chain nem teheti:

```text
ENFORCED product
→ whole chain OBSERVE
```

pusztán azért, mert egy gate kényelmetlen vagy kalibrálatlan.

Gate-local calibration maturity csak:

- deterministic maturity resolver;
- explicit policy;
- receipt;
- review/expiry;

alapján keletkezhet.

Owner/operator emergency override külön auditable safety action lehet, de:

- indok kötelező;
- időben/scope-ban korlátozott;
- nem írja át a gate maturity evidence-et;
- nem válik automatikus precedentté.

### 24.0.6. Promotion

A progress gate:

```text
OBSERVE_CALIBRATION
→ ASSISTED_READY
→ ENFORCED_READY
```

csak akkor léphet tovább, ha:

- calibration VALID;
- phase-specific calibrationok megvannak, ha szükséges;
- positive/negative/unknown control zöld;
- false-stall reverse control zöld;
- stale/missing-calibration control zöld;
- calibration economics elfogadható;
- nincs unresolved systemic false pass/false block.

A gate-local promotion nem igényli a teljes product mode megváltoztatását.


## OFF

- nincs AGP progression;
- history megmarad;
- Marveen normál működés;
- nincs adatvesztés.

## OBSERVE

- runner figyel;
- executor futtatható;
- recommendation;
- nincs blocking.

## ASSISTED

- automata progression a safe pontokig;
- owner decisionnél megáll;
- high-risk side effect nem automatikus.

## ENFORCED

- required executable gate-ek kötelezőek;
- UNKNOWN/ERROR required checknél blokkol;
- authority és acceptance kikényszerített.

---

# 25. Fail-open / Fail-closed

## Observe

Control-plane failure:

```text
fail-open + explicit degraded state
```

## Assisted

Ne mutass hamis PASS-t.

A nem AGP-s Marveen működés maradhat elérhető, de az adott controlled progression ne hazudjon success állapotot.

## Enforced

Required control-plane vagy executor failure:

```text
fail-closed
```

Csak az AGP-controlled progression álljon meg, ne a teljes dashboard.

---

# 26. Biztonság és authority

Kiemelt invariantok:

1. agent nem fogadhatja el saját final outputját;
2. human-required gate-et agent principal ne oldhasson fel;
3. busz sender identity nem bizonyít authorityt;
4. credential soha nem kerül evidence payloadba;
5. secret path nem válik statikus current authorityvé;
6. runtime claimhez runtime evidence kell, ha a gate ezt kívánja;
7. immutable target nélkül nincs verification PASS;
8. stale decision nem current;
9. delegated output nem evidence automatikusan;
10. owner decision append-only audit receiptet kap.

---

# 27. Tesztstratégia

## 27.1. Unit

- state mapping;
- applicability;
- required/advisory semantics;
- currentness;
- supersede;
- execution identity;
- receipt validation;
- risk profile;
- gate value metrics.

## 27.2. Contract

- executor contracts;
- falsification request/receipt;
- context packet;
- owner decision;
- dispatch;
- delivery.

## 27.3. Mutation / negative

Szándékosan hibás inputok.

## 27.4. Historical replay

Korábban ténylegesen megtörtént Marveen hibák replaye.

## 27.5. Cross-product contamination

Más product stale claimje ne tudjon current evidence-ként bekerülni.

## 27.6. Trust attack

- forged sender;
- self-approval;
- delegated claim authority escalation;
- fake receipt;
- reused stale receipt.

## 27.7. Failure injection

- executor timeout;
- LLM verifier failure;
- store unavailable;
- partial write;
- deployment failure;
- runtime mismatch.

---

# 28. Teljes AGP 1.0 acceptance kritérium

Az AGP 1.0 akkor nevezhető 1.0-nak, ha az alábbi positive conditionök teljesülnek **és minden sorhoz működik a hozzá tartozó RED/falsifier út**.

A lista nem puszta feature checklist: minden criterion `acceptance_control` rekordként legyen gépileg összekötve executorral/resolverrel és legalább egy negatív bizonyítási úttal.

1. **Standard low/medium-risk work item end-to-end automatikusan végigvezethető.**  
   **RED:** eligible known-good work item kézi agent-koordináció nélkül nem tud végigmenni, vagy required gate-et kihagyva jut tovább.

2. **Producer solution freedom megmarad.**  
   **RED:** nem-safety jellegű gate konkrét implementációs megoldást ír elő, és alternatív, acceptance-kompatibilis megoldást blokkol.

3. **Minden blocking gate executable vagy authoritative resolverhez kötött.**  
   **RED:** blocking transition mögött csak dokumentált szabály van végrehajtó nélkül.

4. **Minden required checknek authoritative resultja van.**  
   **RED:** creator-claimed állítás vagy hiányzó receipt alapján PASS/acceptance keletkezik.

5. **Required `UNKNOWN` nem tud PASS-ként átszivárogni.**  
   **RED:** insufficient-evidence fixture progressiont kap.

6. **Known-bad end-to-end control ténylegesen megáll.**  
   **RED:** bármely kijelölt known-bad fixture `accepted` vagy delivery állapotig jut.

7. **Producer és accepter identity különválik.**  
   **RED:** ugyanaz az execution principal saját final outputját elfogadhatja.

8. **Delegated output authority nélkül nem evidence.**  
   **RED:** puszta inter-agent message authoritative evidence-ként elég egy gate-hez.

9. **`product_id` explicit és konzisztens.**  
   **RED:** product-scoped work item hiányzó/ambiguous product identityvel elindul vagy más termék evidence-ét elfogadja.

10. **Currentness/supersede működik.**  
    **RED:** superseded/historical claim currentként gate-et tud nyitni.

11. **Fresh verifier infrastruktúra működik ott, ahol required.**  
    **RED:** verifier a producer execution identityjét/session historyját reuse-olja úgy, hogy a profile fresh verifiert ír elő.

12. **Low-risk change nem kap szükségtelen semantic verifiert.**  
    **RED:** deterministic-only low-risk fixture policy-indok nélkül semantic verifiert indít.

13. **A risk profile determinisztikusan meghatározza a gate obligation mapet.**  
    **RED:** ugyanazon immutable inputokból eltérő required halmaz keletkezik, vagy a producer saját maga downgrade-el gate-et.

14. **Owner csak indokolt decision pointokon szükséges.**  
    **RED:** objektíven géppel eldönthető check ownert szakít meg.

15. **Human-required approval valódi human authorityből érkezik.**  
    **RED:** fleet agent human-required gate-et fel tud oldani.

16. **Kanban done és AGP accepted külön kezelődik.**  
    **RED:** `done` automatikusan `accepted`-et jelent verification nélkül.

17. **Dispatch receiptelt és runnerhez kötött.**  
    **RED:** controlled work execution indulhat runner-mintelt execution/dispatch receipt nélkül.

18. **Safe delivery receiptelt.**  
    **RED:** delivery/deploy immutable target és authority receipt nélkül indul.

19. **A szállított futtatható entrypoint ténylegesen elindul.**  
    **RED:** zöld build/typecheck/test mellett a canonical entrypoint startup fail, és a rendszer mégis elfogadja.

19a. **Cross-component feature-nél az upstream stimulus tényleges downstream effectet okoz.**  
    **RED:** upstream event/output helyes, downstream komponens fut, de az acceptance contract szerinti authoritative downstream behavior/state transition nem történik meg, és a rendszer mégis PASS-t ad.

19b. **Durable handoffnál a fix a már persisted eligible backlogot is feldolgozza.**  
    **RED:** a javítás után fresh input működik, de a javítás pillanatában már persisted + current + eligible + unconsumed input új stimulus nélkül nem jut el az expected downstream effectig.

19c. **Replay idempotens.**  
    **RED:** ugyanazon logical input retry/replay során második authoritative business side effect keletkezik.

19d. **Ineligible backlog nem replayelhető.**  
    **RED:** cancelled, expired, superseded, már consumed vagy current workflow szerint irreleváns input feldolgozásra kerül pusztán azért, mert perzisztálva maradt.

20. **Periodikus lánc empirikusan kalibrált, phase-aware grace policyval különbözteti meg a valódi stagnálást a legitim lassú haladástól.**  
    **RED:** bármelyik teljesül: (a) enforced döntés kézzel beírt vagy nem VALID calibrationből származó raw grace thresholdot használ; (b) a detector VALID calibration grace lejárta előtt `STALLED`-et ad; (c) grace lejárta után runnable work + nulla business-state delta mellett healthy marad authoritative wait evidence nélkül; (d) hiányzó/invalid/stale calibration mellett `UNKNOWN` helyett definitív PASS/FAIL keletkezik; (e) fázisos lánc globális grace-t vagy másik phase calibrationjét használja; (f) phase transition után a régi phase no-progress streakje tovább él.

21. **Runtime verification elérhető és required esetben lefut.**  
    **RED:** production delivery successfulnak minősül required runtime observation receipt nélkül.

22. **Rollback policy létezik és high/critical esetben bizonyított.**  
    **RED:** irreversible/high-risk delivery rollback path vagy rollback authority nélkül elfogadható.

23. **Sidecar replay determinisztikus.**  
    **RED:** azonos immutable ledger inputból eltérő authoritative projection keletkezik.

24. **Gate telemetry mérhető.**  
    **RED:** enforced gate latency/cost/result/override telemetry nélkül fut.

25. **Gate charter és retirement/downgrade működik.**  
    **RED:** gate charter nélkül enforceddé válik, vagy tartósan rossz false-block/override mutató mellett review nélkül marad.

26. **Off/observe/assisted/enforced módok valóban eltérő policyt adnak.**  
    **RED:** `off` továbbra is blokkol, `observe` hard-blockol, vagy `enforced` required control failure mellett silent fail-open.

27. **Updateability nem romlik érdemben.**  
    **RED:** normál Marveen upstream update csak nagy, ismételten kézzel konfliktusoldandó AGP core patch-csomag mellett vihető át, miközben generikus extension/upstream út létezne.

28. **Nincs szükség tartós, nagy Marveen core forkra.**  
    **RED:** az AGP domainlogika szétszóródik a Marveen core-ban, sidecar/adapter vagy upstream-generic capability helyett.

29. **Gate economics nem támaszkodik becsült manual baseline-ra.**  
    **RED:** enforced promotiont vagy gate-retention döntést becsült/survey/agent/owner baseline vagy hipotetikus javítási idő befolyásol `MEASURED_*` értékként.

30. **Hiányzó measured baseline esetén az economics explicit `UNKNOWN`.**  
    **RED:** baseline evidence nélkül numerikus `net_human_minutes_saved` vagy pozitív ROI állítás keletkezik.

31. **Hard-safety és economics authority különválik.**  
    **RED:** hard-safety gate kizárólag becsült ROI miatt engedélyeződik vagy tiltódik; illetve non-safety efficiency gate hipotetikus megtakarítás alapján enforceddé válik.

32. **Auto episode label csak COMPLETE intervention-observability mellett keletkezhet.**  
    **RED:** bármely releváns code/config/state/runtime/deployment surface `PARTIAL/NONE`, mégis `AUTO_EVENTUAL_PROGRESS` vagy `AUTO_CONFIRMED_STALL` keletkezik.

33. **Unknown vagy external mutation konzervatívan címkézetlen.**  
    **RED:** engine-origin receipt nélküli releváns írás, unknown restart/process-generation change vagy provenance-anomália mellett automatikus ground-truth label keletkezik.

34. **A beavatkozás hiánya is bizonyítandó állítás.**  
    **RED:** a resolver pusztán audit-esemény hiányából következtet „no intervention”-re anélkül, hogy az observability manifest COMPLETE coverage-et igazolna.

35. **Marveen audit reuse történik, de hiányzó coverage nem válik hamis biztonsággá.**  
    **RED:** a rendszer a Settings/store auditot univerzális intervention proofként kezeli olyan code/config/state/restart surface-re is, amelyet az nem fed le.

36. **Coverage COMPLETE nem self-declared.**  
    **RED:** relevant surface inventory kizárólag producer/charter felsorolásból jön, vagy resolver által relevánsnak talált surface elhagyható.

37. **A COMPLETE observation path képes bizonyítottan pirosodni.**  
    **RED:** required surface current successful canary/equivalent independent detection proof nélkül COMPLETE marad, vagy szándékosan vak sensor mellett is COMPLETE státusz keletkezik.

38. **Coverage proof currentnessnek lifecycle-következménye van.**  
    **RED:** failed/stale/superseded detection proof vagy inventory evidence után auto-label továbbra is engedélyezett.

39. **Pure efficiency gate economics-romlásra downgrade-el.**  
    **RED:** authoritative `MEASURED_NONPOSITIVE` vagy stale/invalid economics justification mellett változatlanul `ENFORCED_READY` marad.

40. **Correctness gate economics és defect-prevention justification külön authority.**  
    **RED:** negatív economicsra automatikusan kikapcsol independent defect evidence vizsgálata nélkül, vagy independent justification nélkül review/downgrade nélkül marad.

41. **Hard-safety gate-et economics önmagában nem kapcsol le.**  
    **RED:** safety/security/privacy/data-loss gate negatív economics miatt automatikusan downgrade-elődik.

42. **Az AGP maga is méri a saját gazdaságosságát, ugyanazzal a szabállyal, amit a gate-ektől megkövetel.**  
    Az AGP futtatásának mért többletköltsége (executor latency, token, emberi címkézés és owner-interakció percben) és mért hozama (megfogott valós defektek súlyozva, megelőzött escape-ek) ugyanabban a `MEASURED_POSITIVE / MEASURED_NONPOSITIVE / UNKNOWN` állapottérben jelenik meg, mint egy gate economics állapota. Becsült baseline itt sem megengedett: mérés hiányában az érték `UNKNOWN` és a numerikus mezők nullák helyett üresek.  
    **RED:** az AGP overhead/hozam állapota becsült számból származik; vagy `MEASURED_NONPOSITIVE` mellett a rendszer következmény nélkül marad enforced-ready állapotban.

43. **Az AGP `MEASURED_NONPOSITIVE` állapota kötelező review-t vált ki — de nem automatikus kikapcsolást.**  
    A §23.1 gate-class logikája önmagára is érvényes: a hard-safety kontrollok (security, privacy, data-loss, compliance) gazdasági alapon nem eshetnek ki, a tisztán hatékonysági kontrollok igen, a correctness-kontrollok pedig független defect-evidence vizsgálata nélkül nem.  
    **RED:** az AGP egésze gazdasági alapon automatikusan kikapcsol, hard-safety kontrollokat is magával vive; vagy tartósan `MEASURED_NONPOSITIVE` marad bármilyen review-kötelezettség nélkül.

> **Miért került ez a v1.9-be.** A §23.2 kimondja, hogy nincs következmény nélküli metrika, és minden gate-től megköveteli, hogy mért értékkel igazolja a létét. A v1.8-ban maga az AGP volt az egyetlen kontroll, amelyre ez nem vonatkozott: negyvenegy acceptance-kritérium közül egy sem kérdezte meg, hogy a keretrendszer futtatása megérte-e. Egy olyan spec, amely a hamisíthatóságot teszi központi elvvé, nem tarthatja fenn magának a hamisíthatatlanság kiváltságát.

### 28.1. Acceptance evidence szabály

Egy criterion nem tekinthető elfogadottnak pusztán attól, hogy a positive fixture zöld.

Kötelező:

```text
positive evidence
+
explicit red condition
+
legalább egy lefuttatott vagy historical negative fixture mapping
```

A negative fixture lehet több criterion közös kontrollja; a cél nem 28 külön mesterséges teszt létrehozása, hanem hogy **egyetlen acceptance állítás se legyen unfalsifiable**.

---

# 29. Siker KPI-k

Az 1.0 nem pusztán feature checklist.

Mérendő:

### Minőség

- false acceptance rate;
- escaped defect rate;
- stale-context incident rate;
- cross-product contamination;
- self-approval / authority violation;
- rollback-triggering defect.

### Sebesség

- lead time;
- active execution time;
- verification latency;
- owner waiting time;
- retries.

### Automatizálás

- human coordination nélkül lezárt change-ek aránya;
- owner-interruption / 100 change;
- automatikusan megoldott return-for-fix loopok;
- manual dispatch arány.

### Költség

- token/change;
- verifier token/change;
- gate cost/change;
- caught defect/cost.

### Kreativitás

Proxy mérőszámok:

- challenge path usage;
- alternative solution proposal rate;
- unnecessary prescriptive-gate override;
- agent-generated architecture/design alternatives.

Nem cél ezek maximalizálása; regressziójelzőként használjuk.

---

# 30. Lean anti-bloat szabályok

Új AGP capability csak akkor kerüljön core scope-ba, ha legalább egy igaz:

- tényleges hibát előz meg;
- automationt növel;
- owner-interruptot csökkent;
- lead time-ot csökkent;
- evidence qualityt javít;
- security/privacy hard invariant.

Egy feature NE kerüljön be csak azért, mert:

- „enterprise” jellegű;
- szép dashboardot ad;
- még több state-et tudunk modellezni;
- még egy agent szerep hozzáadható;
- egy ritka elméleti esethez komplex workflow építhető.

---

# 31. Marveen integrációs stratégia

## Maradjon local AGP sidecar

- AGP domain model;
- receipt/evidence ledger;
- claim/currentness;
- falsification;
- gate registry;
- change runner;
- context packet;
- AGP UI projection.

## Upstream candidate

Generikus Marveen capabilityk:

- non-forgeable human approval principal;
- server-side approval attribution;
- generic card extension hook;
- generic execution provenance hook;
- frontend extension eventek;
- agent/session execution metadata;
- generic verification/receipt attachment point.

Ezeknél upstream issue/PR javasolt a lokális core fork helyett.

---

# 32. Jelenlegi upstream releváns megfigyelés

A Marveen jelenlegi approval rendszerében a self-approval guard hasznos, de a shared fleet credential modell miatt nem teljes trust boundary.

A 2026-08-05-i upstream issue #923 ugyanezt a problémát méri: a `resolved_by` önmagában szabad szöveg, és a fleet agentek közös bearer credentialje mellett szükség van szerveroldali human principal fogalomra a human-required approval kategóriákhoz.

AGP 1.0 döntés:

> ezt nem helyi AGP-specifikus approval rendszerrel kell megkerülni, hanem generikus Marveen upstream capabilityként kell kezelni.

---

# 33. A fejlesztés javasolt munkacsomagjai

## A v1.9 munkacsomag-szerkezet

A v1.8-ban a WP1 44 deliverable-t tartalmazott, amelyből mintegy 35 a §9.2 periodikus kalibrációs láncához tartozott. Ez a WP1-et termék méretűvé tette: nem volt olyan állapota, amelyben elfogadható lett volna, és amíg nem készült el, semmi nem szállított értéket.

A v1.9 ezt szétvágja. A szakaszok tartalma nem változik; az változik, **melyik csomag elfogadásának feltétele mi**:

- **WP1** az a mag, amelynek van zöld állapota: a registry az élő kiértékelési úton, egy valódi executor, az applicability receipt és az acceptance-control séma.
- **WP1b, WP1c** a v1.7/v1.8 handoff- és backlog-bizonyítás, amely a WP1-re épül, de nem előfeltétele.
- **WP9, WP10, WP11** a §9.2 kalibrációs lánca, három csomagra bontva, `OBSERVE_ONLY` enforcement-státusszal (§9.2.0).

A `WP2`–`WP8` azonosítói és exit-kódjai változatlanok, hogy a meglévő auditok és receiptek hivatkozásai érvényben maradjanak. Az új csomagok ezért a sor végén kaptak számot, nem beszúrással.

---

## WP1 – Executable Verification Foundation (mag)

A WP1 v1.9-es hatóköre az a legkisebb halmaz, amely után a rendszer **bizonyítani tudja, hogy a megfelelő gate-ek valóban lefutottak** — és amely nélkül minden későbbi csomag tesztelhetetlen.

Deliverables:

- Gate Profile Resolver + immutable applicability map;
- applicability receipt minden `EXCLUDED` gate-hez;
- producer-független required/advisory/excluded döntés;
- executor registry **az élő kiértékelési úton** (nem regisztrálható, hanem ténylegesen dispatchelő), per-execution executor receipttel;
- `NON_EXECUTABLE_GATE` mint production assertion, az overlay gate-ekre is kiterjedően;
- canonical executor results (`PASS/FAIL/UNKNOWN/ERROR`), legalább egy executorral, amely ténylegesen tud `ERROR`-t emittálni;
- startability executor/contract (§9.1) — az első valódi, nem-triviális executor;
- known-good/bad/unknown control **executoronként**;
- dual-sided acceptance-control schema (§9.3);
- HF-01 documented-check-not-executed historical fixture;
- HF-02 green-but-does-not-start historical fixture;
- gate conformance validator: `blocking_rule → executable_control`, `DOCUMENT_ONLY_CONTROL` címkével a maradékra;
- cost/latency/result telemetry executoronként.

Exit:

```text
EXECUTABLE_VERIFICATION_FOUNDATION_ACCEPTED
```

**Kifejezetten NEM feltétele a WP1 elfogadásának:** a falsification runner (WP1d), a handoff/backlog proof (WP1b, WP1c), és a teljes §9.2 kalibrációs lánc (WP9–WP11).

---

## WP1b – Cross-Component Effect Propagation

Deliverables:

- Cross-Component Effect Propagation executor/contract (§9.4);
- correlation-aware handoff/effect receipt;
- `EFFECT_NOT_PROPAGATED` failure class;
- HF-04 components-green-but-handoff-missing historical fixture;
- reverse false-block kontroll (legitim aszinkron késés).

Exit:

```text
EFFECT_PROPAGATION_ACCEPTED
```

---

## WP1c – Backlog Recovery / Replay Proof

Deliverables:

- Backlog Eligibility Contract (§9.5);
- backlog recovery/replay proof mode;
- idempotency / already-processed reverse control;
- stale/cancelled/expired/superseded backlog exclusion;
- HF-05 preexisting-unconsumed-input-not-replayed historical fixture.

Exit:

```text
BACKLOG_RECOVERY_ACCEPTED
```

---

## WP1d – Falsification Runner

Deliverables:

- falsification runner (§8);
- `verification_request` / `verification_receipt` a §8.2/§8.4 szerinti mezőkkel;
- verifier principal a receipten;
- caller-szabály: a producer nem dönthet arról, lefut-e a kötelező falsification.

Exit:

```text
FALSIFICATION_RUNNER_ACCEPTED
```

---

## WP2 – Product Identity + Currentness

Deliverables:

- product_id;
- claim currentness;
- supersede;
- current authority;
- contamination tests.

Exit:

```text
PRODUCT_CURRENTNESS_ACCEPTED
```

---

## WP3 – Execution Identity + Provenance

Deliverables:

- runner-minted execution identity;
- producer/verifier roles;
- delegated claim semantics;
- trust attack tests;
- human-principal integration design/upstream packet.

Exit:

```text
EXECUTION_PROVENANCE_ACCEPTED
```

---

## WP4 – Context Router + Fresh Verifier

Deliverables:

- producer context packet;
- verifier context packet;
- fresh session;
- risk-based verifier policy;
- cost telemetry.

Exit:

```text
FRESH_VERIFICATION_ACCEPTED
```

---

## WP5 – Change Runner

Deliverables:

- graph progression;
- executable transitions;
- return-for-fix loop;
- owner decision pause/resume;
- challenge path.

Exit:

```text
CHANGE_RUNNER_ACCEPTED
```

---

## WP6 – Kanban + Dispatch

Deliverables:

- supervised dispatch;
- receipt linkage;
- done ≠ accepted;
- UI projection;
- resume/recovery.

Exit:

```text
MARVEEN_WORKFLOW_INTEGRATION_ACCEPTED
```

---

## WP7 – Safe Delivery

Deliverables:

- immutable delivery target;
- deployment authority;
- runtime verify;
- rollback receipt;
- production safety profile.

Exit:

```text
SAFE_DELIVERY_ACCEPTED
```

---

## WP8 – Product LCM Closed Loop

Deliverables:

- change result → measurement;
- product evidence update;
- product review;
- next-change recommendation.

Exit:

```text
AGP_1_0_LEAN_ACCEPTED
```

---

## WP9 – Periodic Chain: charter és mérés (OBSERVE_ONLY)

A §9.2 lánc első harmada: **mérni tudjuk, amiről később dönteni akarunk**. Semmit nem blokkol (§9.2.0).

Deliverables:

- Periodic Chain Charter, canonical phase model és producer-független calibration policy (§9.2.1);
- progress snapshot (§9.2.2) a charter- és calibration-hivatkozással;
- domain state és gate mapping (§9.2.3): `PROGRESSING / WITHIN_GRACE / STALLED / UNKNOWN / ERROR`;
- `missing_calibration_result: UNKNOWN` érvényesítve — kalibrálatlan lánc nem állíthat stagnálást;
- minimal mutation-surface adapters/reuse (git/config/state/runtime fingerprints ahol releváns);
- a meglévő, nem-authoritative stagnálás-telemetria explicit felcímkézése a forrásban (§9.2.0).

Exit:

```text
PERIODIC_CHAIN_MEASUREMENT_ACCEPTED
```

---

## WP10 – Periodic Chain: epizód-címkézés és intervention visibility (OBSERVE_ONLY)

A lánc középső harmada, és a legkockázatosabb: **honnan jön a ground truth**. Ez a csomag dönti el, hogy a kalibráció egyáltalán megalapozható-e — ha a válasz nem, azt itt kell megtudni, nem három csomaggal később.

Deliverables:

- Episode Label Resolver + label receipt + intervention-aware ground-truth policy (§9.2.1.a.1–a.2);
- Intervention Visibility Contract + per-episode observability manifest;
- Surface Inventory Resolver + completeness receipt;
- safe detection canary / ezzel egyenértékű független detekciós bizonyíték + receipt;
- coverage revalidation/currentness;
- unknown/external mutation → `UNLABELED` control;
- anti-self-confirmation invariáns érvényesítve.

**Kilépési feltétel előtti kötelező döntési pont:** ha a mért emberi címkézési költség (§9.2.1.a.3) meghaladja a charterben rögzített budgetet, a helyes kimenet `CALIBRATION_ECONOMICS = NOT_LEAN`, és a lánc **véglegesen OBSERVE_ONLY marad** — ez elfogadott, sikeres kimenet, nem kudarc. A v1.9 kimondja, hogy egy kalibrálhatatlan kontroll megfelelő válasza a nem-enforced státusz, nem a becsült küszöb.

Exit:

```text
PERIODIC_CHAIN_GROUND_TRUTH_ACCEPTED | CALIBRATION_ECONOMICS_NOT_LEAN
```

---

## WP11 – Periodic Chain: kalibráció és enforcement

A lánc utolsó harmada. **Csak akkor indul, ha a WP10 `PERIODIC_CHAIN_GROUND_TRUTH_ACCEPTED`-tel zárult.**

Deliverables:

- Periodic Grace Calibrator + immutable calibration receipt (§9.2.1.a, §9.2.1.c);
- threshold kiválasztási szabály megfigyelt streakekből (§9.2.1.b) — kézzel megadott authoritative küszöb nélkül;
- phase-aware grace (§9.2.1.d);
- calibration lifecycle: validation, supersede, drift/review trigger (§9.2.1.e);
- empirically calibrated, phase-aware periodic progress differential executor/contract;
- progress controls: true-stall / slow-progress / missing-calibration / phase-aware / stale-calibration;
- HF-03 legitimate-slow-progress / false-stall historical fixture + eventual-progress calibration evidence;
- SF-03 true-stall-beyond-calibrated-grace fixture;
- PF-04 phase-aware slow-planning/fast-execution fixture;
- CF-04 missing/invalid calibration → UNKNOWN fixture;
- CF-05 stale/superseded calibration rejection fixture;
- measured-baseline economics state (`MEASURED_POSITIVE/NONPOSITIVE/UNKNOWN`);
- gate-class aware economics lifecycle resolver;
- minimum evidence + hysteresis policy;
- chain/gate scoped control maturity resolver (`OBSERVE_CALIBRATION` blanket product downgrade nélkül);
- confirmed false-pass / false-block shadow telemetry + adjudication receipt contract.

Exit:

```text
PERIODIC_CHAIN_ENFORCEMENT_ACCEPTED
```

---

# 34. Minden work package kötelező acceptance mintája

Minden WP-nél:

1. positive fixture;
2. negative fixture;
3. unknown/incomplete fixture;
4. minden acceptance criterionhoz `red_condition`;
5. gate profile/applicability receipt ellenőrzés;
6. falsification run;
7. independent acceptance;
8. startability check, ha runnable deliverable van;
9. cross-component effect propagation check, ha az acceptance komponenshatáron átnyúló adat-/eseményátadástól függ;
10. backlog recovery/replay + idempotency check, ha a handoff durable persisted inputot használ;
11. grace-aware progress differential check, ha recurring/periodic lánc van, beleértve a slow-progress false-stall kontrollt;
10. updateability diff;
11. performance/cost measurement;
12. rollback;
13. no-secret check;
14. final receipt.

Egy WP nem fogadható el pusztán producer státuszjelentés, zöld statikus teszt vagy egyetlen happy-path futás alapján.

A WP acceptance reportban külön jelenjen meg:

```text
What made it GREEN?
What would make it RED?
Which negative fixture proved the RED path?
```

---

# 35. Rollout

Nem egyszerre kapcsoljuk be minden termékre.

## Stage 1 – Observe

```text
observe
```

Valós work itemeken mérés, blocking nélkül.

### Stage 1 előfeltétele: élő betáplálás (v1.9)

Az observe mód **csak akkor observe, ha ténylegesen mér**. A v1.8 ezt hallgatólagosan feltételezte, és a feltétel nem teljesült: a store-t kézzel indított ingest töltötte néhány átmásolt work itemmel, így a promotion window 7 napos / 20 elemes számlálója soha nem tudott gyűlni. Egy nem táplált observe mód nem korai stádium, hanem álló rendszer.

Stage 1 ezért nem tekinthető megkezdettnek, amíg mind a három nem áll:

1. **Automatikus, ütemezett vagy eseményvezérelt ingest** fut a valós work-item forrás ellen — nem kézi szkript, nem hand-transcribed lista;
2. az ingest **saját liveness-jelet** ír (utolsó sikeres futás időbélyege és feldolgozott elemszáma), amely a dashboardon látható, és amelynek elakadása észlelhető;
3. az `eligible work item` **számlálható**: a promotion gate 20-as küszöbe egy lekérdezhető számból jön, nem becslésből.

Amíg ez nem áll, a helyes állapotjelentés:

```text
rollout_stage = NOT_STARTED
reason = OBSERVE_NOT_FED
```

és nem `stage_1_in_progress`. Ez ugyanaz a fegyelem, amit a spec a gate-ektől megkövetel: mérés nélkül nincs mért állapot, csak UNKNOWN.

Új periodic chain bevezetésekor nem szükséges a teljes productot Stage 1-be visszatenni. Ha a product már assisted/enforced, az új chain kalibrálatlan `progress_liveness` gate-je gate-local:

```text
OBSERVE_CALIBRATION
```

maturityben fut, miközben a többi validated kontroll megtartja a parent mode szerinti enforcementet.

### Observe → Assisted promotion gate

`assisted` módba csak akkor léphetünk, ha **mindkettő** teljesül:

1. legalább **7 egymást követő naptári nap** observe mérés;
2. legalább **20 releváns, valós eligible work item**.

És a teljes promotion window alatt kétirányú clean shadow result szükséges:

```text
confirmed_false_pass_to_manual_stop = 0
confirmed_false_block_to_manual_allow = 0
```

Definíciók:

> **confirmed false pass:** a gépi AGP-lánc továbbengedte volna a work itemet, de a párhuzamos, független kézi/acceptance kontroll ugyanazon contract alapján helyesen megállította.

> **confirmed false block:** a gépi AGP-lánc megállította vagy `INCOMPLETE`-nek minősítette volna a work itemet, de független adjudication ugyanazon acceptance contract és authoritative evidence alapján bizonyította, hogy a progression helyes lett volna.

Nem számít confirmed false blocknak egy puszta owner override, impatience vagy safety waiver. A machine-vs-human eltéréshez külön adjudication receipt kell.

A promotion window ezért nemcsak azt bizonyítja, hogy az AGP nem enged át rossz munkát, hanem azt is, hogy **nem lassítja indokolatlanul a jó munkát**.

Továbbá:

- nincs unresolved required-control measurement gap;
- gate applicability receipt minden excluded gate-hez megvan;
- known-bad fixture-ek továbbra is pirosra mennek;
- startability/progress differential kontrollok a releváns work itemeken működnek.

Ha a 7 nap letelik, de nincs 20 eligible work item, observe marad a 20. work itemig.

Ha confirmed false pass vagy confirmed false block történik, a hibát előbb klasszifikálni és javítani kell; a clean 7 napos ablak a javítás független elfogadása után újraindul.

---

## Stage 2 – Assisted

```text
assisted
```

Low/medium-risk selected products.

Automatikus progression a safe pontokig, owner decisionnél vagy required unresolved evidence-nél megáll.

### Assisted → Enforced promotion gate

Csak olyan gate-ek és profile-ok léphetnek enforcedbe, amelyek:

- executorral/resolverrel rendelkeznek;
- gate obligation producer-függetlenül feloldható;
- positive + negative + unknown controlt átmentek;
- confirmed false-block rate az assisted evaluation windowban a policy által elfogadott határ alatt van, és nincs unresolved systemic false block;
- nincs olyan gate/profile, amelyet a felhasználók tartósan megkerülnek indokolatlan blokkolás miatt;
- overhead mérhető;
- gate charter valid;
- nincs ismert false pass az adott profile-ban;
- startability/progress kontroll releváns esetben bizonyított.

A promotion minimum egy teljes assisted evaluation window után történjen, owner acceptance-tel.

---

## Stage 3 – Enforced

```text
enforced
```

Csak validated profile-okra és gate-ekre.

Required control failure/UNKNOWN/ERROR fail-closed az AGP-controlled progressionben.

---

## Stage 4 – Szélesebb default

Csak akkor, amikor a több-termékes működésben is stabil:

- quality;
- latency;
- cost;
- owner-interruption;
- confirmed false-block / confirmed false-pass;
- shadow disagreement + adjudication outcome.

Globális master off végig megmarad.

---

# 36. Példa: kreatív UI fejlesztés

Request:

> „Tervezz jobb onboardingot a QuickQuote-hoz.”

AGP:

```text
objective
constraints
acceptance
risk = medium
```

Nem mondja meg:

- layoutot;
- komponenseket;
- színeket;
- UX-flow részleteit.

UX/producer szabadon tervez.

Deterministic:

- build;
- accessibility baseline;
- responsive checks;
- tests.

Semantic verifier:

- csak az acceptance szemantikai részei;
- fresh context;
- nem látja producer teljes narratíváját.

Ha az agent jobb scope-ot javasol:

```text
CHALLENGE_CONTRACT
```

Owner dönt.

Kreativitás megmarad; acceptance nem válik szubjektív self-approvalvá.

---

# 37. Példa: egyszerű bugfix

Request:

> „Javítsd a hibás validációt.”

LOW risk.

AGP:

```text
producer
→ unit test
→ typecheck
→ targeted regression
→ accept
```

Nincs semantic verifier.

Nincs owner.

Nincs 5 agent.

Ez Lean.

---

# 38. Példa: auth változtatás

HIGH risk.

```text
current auth evidence
→ producer
→ deterministic security checks
→ falsification
→ fresh verifier
→ negative auth fixture
→ owner gate, ha policy változik
→ deploy
→ runtime probe
```

Itt a nagyobb kontroll indokolt.

---

# 39. Végleges elvi mondatok

Az AGP 1.0 Lean alapelvei:

> **FREE SOLUTION SPACE, CONTROLLED AUTHORITY AND PROGRESSION.**

> **A claim is not evidence because an agent said it.**

> **A gate is not a control unless something executes it.**

> **UNKNOWN is not PASS.**

> **Gate applicability is authority, not producer preference.**

> **Green static checks do not prove that a runnable deliverable starts.**

> **Activity is not progress.**

> **No visible progress is not automatically a stall.**

> **Grace is measured, not guessed.**

> **A phase-aware chain requires phase-aware liveness policy.**

> **A receipt proves provenance; calibration evidence proves a threshold.**

> **A new gate calibrates locally; it does not downgrade the whole product.**

> **Calibration ground truth should be automatic by default, human only by exception.**

> **A detector cannot be its own ground truth.**

> **Automation that requires more human labeling than it saves is not Lean.**

> **Measured economics, not estimated ROI.**

> **If the baseline is unknown, the savings are UNKNOWN.**

> **Absence of an intervention event is not proof of no intervention without complete observability.**

> **Unknown mutation provenance means UNLABELED, not automatic ground truth.**

> **A coverage claim must prove both inventory completeness and detector sensitivity.**

> **A sensor that cannot be made red cannot justify COMPLETE coverage.**

> **A metric used for enforcement must have an enforcement consequence.**

> **Efficiency controls follow economics; safety controls follow safety evidence.**

> **Component-local green is not feature-level green.**

> **A handoff is proven by downstream effect, not by both sides merely running.**

> **A fix must prove both the live path and the eligible backlog path.**

> **Durability without recovery/replay is incomplete delivery.**

> **Replay must be eligibility-aware and idempotent.**

> **A stall detector must prove both detection and non-detection.**

> **Every acceptance claim must have a RED condition.**

> **Done is not Accepted.**

> **Delegation transfers work, not authority.**

> **Falsification comes before trust.**

> **Deterministic first, semantic only when needed.**

> **One agent by default.**

> **Owner attention is a scarce resource.**

> **Every blocking control must justify its cost.**

---

# 40. Egy mondatban az AGP 1.0 Lean

**Az AGP 1.0 Lean egy könnyű, végrehajtható és falszifikálható control plane a Marveen körül, amely szabadon hagyja az AI agenteket a megoldás megtervezésében és megvalósításában, de csak bizonyított tények, hiteles authority, ténylegesen lefutott ellenőrzések és független acceptance alapján engedi a munkát továbbhaladni.**

---

# 41. Következő konkrét fejlesztési lépés

A specifikáció elfogadása után ne a teljes 1.0 implementáció induljon egyetlen nagy diffként.

Az első és egyetlen következő implementációs work item:

```text
WP1 — EXECUTABLE_VERIFICATION_FOUNDATION
```

Scope:

- Gate Profile Resolver;
- deterministic `REQUIRED/ADVISORY/EXCLUDED` applicability map;
- applicability receipt és producer-független gate obligation;
- Gate Executor Registry;
- canonical executor results (`PASS/FAIL/UNKNOWN/ERROR`);
- Falsification Runner minimal interface;
- verification receipt;
- startability contract + executor;
- cross-component handoff/effect contract + executor;
- correlation-aware effect proof;
- backlog eligibility + recovery/replay proof;
- replay idempotency + duplicate-effect prevention;
- ineligible/stale backlog exclusion;
- HF-04 components-green-but-handoff-missing fixture;
- HF-05 preexisting-unconsumed-input-not-replayed fixture;
- periodic chain charter + canonical phase model + producer-független calibration policy;
- Periodic Grace Calibrator + calibration receipt;
- Episode Label Resolver + auto/verifier/human label authority hierarchy;
- Intervention Visibility Contract + observability manifest;
- Surface Inventory Resolver + completeness proof;
- safe detection canary/equivalent proof + coverage revalidation receipt;
- engine-origin vs external/unknown mutation provenance;
- conservative incomplete/suspect coverage → UNLABELED;
- intervention-aware label receipt;
- measured-baseline economics state + labor-economics telemetry becsült baseline nélkül;
- gate-class aware economics consequence/downgrade resolver;
- chain/gate scoped maturity resolver;
- empirically calibrated, phase-aware periodic progress differential contract + executor;
- calibration validation/supersede/drift lifecycle;
- true-stall / slow-progress / missing-calibration / phase-aware / stale-calibration controls;
- dual-sided acceptance-control (`positive_condition` + `red_condition`);
- HF-01 documented-but-not-executed historical fixture;
- HF-02 green-but-does-not-start historical fixture;
- HF-03 legitimate-slow-progress / false-stall historical fixture + calibration evidence;
- SF-03 true-stall-beyond-calibrated-grace fixture;
- PF-04 phase-aware slow-planning/fast-execution fixture;
- missing/invalid calibration → UNKNOWN fixture;
- stale/superseded calibration rejection fixture;
- positive/negative/unknown fixtures;
- conformance check: blocking rule → executor/resolver;
- cost/latency/result telemetry;
- independent acceptance.

Sem product-currentness, sem dispatch, sem Kanban writeback ne kerüljön bele WP1-be.

WP1 elfogadása után a saját falsification eszközünkkel ellenőrizzük WP2-t.

---

# v1.8 forrásmegjegyzés

A v1.8 egy közvetlenül a v1.7 után azonosított Mission Control recovery-findingból származik.

A konkrét esetben a felhasználói döntés már a javítás előtt authoritative módon rögzítve volt az adatbázisban, de a hibás consumer/handoff nem dolgozta fel. A javítás után önmagában nem elegendő bizonyítani, hogy egy új gombnyomás már végigmegy: a korábban felhalmozott, még current + eligible + unconsumed döntésnek is feldolgozódnia kell.

Ezért a v1.8 a handoff proofot `FRESH_INPUT` és `PREEXISTING_ELIGIBLE_UNCONSUMED_INPUT` módokra bontja, és explicit idempotency + stale/ineligible reverse kontrollokat ad hozzá.

A cél nem egy új backlog-platform. A meglévő durable persistence/queue/cursor primitive-eket kell újrahasználni; az AGP csak az eligibility, replay effect és idempotency bizonyítását teszi acceptance-követelménnyé.

---

# v1.7 forrásmegjegyzés

A v1.7 egy 2026-08-09-i valós Mission Control incidentből származik. Az „akció elvégzése” UI-oldali művelet helyesen létrehozta az eseményt, a downstream motor helyesen lefutott, és mindkét komponens saját tesztje zöld volt. A feature mégsem zárta le a láncot, mert a motor nem fogyasztotta/olvasta a választ.

Ez megmutatta, hogy a v1.6 startability és progress kontrolljai mellett külön cross-component effect proof szükséges. A v1.7 ezt nem általános integrációs frameworkként építi fel, hanem acceptance-szintű, determinisztikus handoff probe-ként: ismert stimulus → correlation → downstream observable effect.

---

# v1.6 forrásmegjegyzés

A v1.6 két v1.5 utáni review findingból származik.

Az első finding szerint a `COMPLETE` intervention-coverage nyilatkozat maga is claim: egy kézzel deklarált surface-lista kihagyhat releváns felületet. A v1.6 ezért két külön bizonyítást követel. A producer-független Surface Inventory Resolver a releváns influence surface-ek teljességét kezeli; a safe detection canary azt bizonyítja, hogy a deklarált sensor ténylegesen képes észlelni. A canary önmagában nem oldja meg az omitted-surface problémát.

A második finding szerint a measured economics csak akkor ér valamit, ha lifecycle-következménye is van. A v1.6 gate-class szerint köti össze a mérést a downgrade-dzsal: pure efficiency gate elveszíti enforcementjét tartós/current negative economicsnál; correctness gate mandatory review-ra kerül; hard-safety gate-et economics önmagában nem kapcsolhat le.

A Marveen jelenlegi audit primitive-jei továbbra is reuse-pontok, de nem univerzális completeness proofok. A cél minimális resolver/canary adapter, nem új audit platform.

---

# v1.5 forrásmegjegyzés

A v1.5 két további gyakorlati korrekcióból származik:

1. a v1.4 `net_human_minutes_saved` szabálya még megengedte volna, hogy a baseline manual monitoring/javítási idő becslésből származzon. A v1.5 ezt megszünteti: economics authority csak mért historical vagy observe/shadow evidence-ből jöhet; különben `UNKNOWN`;
2. a v1.4 intervention-aware labelingje feltételezte, hogy a rendszer tudja, történt-e külső beavatkozás. A jelenlegi Marveen audit hasznos jeleket ad (Settings change-log, `store/` file audit), de nem univerzális provenance ledger minden code/config/state/restart útvonalhoz. Ezért a v1.5 explicit Intervention Visibility Contractot vezet be, és hiányos vagy gyanús coverage esetén konzervatívan `UNLABELED`-et ír elő.

A cél továbbra sem új audit-platform építése. A WP1-nek a meglévő Marveen jeleket és olcsó fingerprint/generation primitive-eket kell újrahasználnia, és csak a valóban szükséges coverage-gapet kell adapterrel lezárnia.

---

# v1.4 forrásmegjegyzés

A v1.4 két 2026-08-09-i gyakorlati Marveen use case-ből származik:

1. ugyanazon a napon új periodic chain került bevezetésre, miközben a termék többi kontrollja már stabil lehet; ezért a calibration rolloutnak gate-localnak kell lennie, nem product-wide mode downgrade-nak;
2. a v1.3 calibrator csak azt írta le, milyen episode label kell, de nem azt, hogyan keletkezik és mennyi human work kell hozzá. A v1.4 ezért külön `Episode Label Resolver` authority-láncot és calibration labor-economics mérést vezet be.

A cél nem további governance-réteg, hanem éppen a Lean működés védelme: **új kontroll kalibrálható anélkül, hogy a stabil kontrollokat lekapcsolnánk, és a kalibráció nem válhat rejtett manuális annotációs projektté.**

---

# v1.3 forrásmegjegyzés

A v1.3 két új korrekciója a 2026-08-09-i valós Marveen megfigyelésből származik:

1. a stagnálási grace threshold puszta receiptelése nem teszi a számot helyessé; az enforced thresholdnak megfigyelt progress-eloszlásból, reprodukálható kalibrációval kell származnia;
2. a megfigyelt false-stall esetben a lánc planning → execution phase-váltása lényegesen eltérő legitim stationary viselkedést mutatott, ezért fázisos láncnál a grace calibration phase-specifikus, nem opcionális.

A v1.3 ezért a korábbi „producer-független grace policy” elvet tovább szigorítja: **producer-független + empirical calibration + phase-specific authority** szükséges.

---

# v1.2 forrásmegjegyzés

A v1.1 és v1.2 korrekciói közvetlenül a Marveen 2026-08-09-i valós futási tapasztalataiból származnak.

Fontos korrekció: a v1.1-ben `HF-03 ACTIVE_BUT_NOT_PROGRESSING` néven true-stall esetként kezelt megfigyelést a későbbi evidence felülírta. A lánc az 5. ciklustól legitim módon haladni kezdett, ezért v1.2-ben ez **slow-progress / false-stall known-good control**. A specifikáció ezzel saját currentness/supersede elvét alkalmazza önmagára is: a korábbi hibás fixture-classification nem maradhat authoritative csak azért, mert már dokumentáltuk.

---

# Források és kapcsolódó anyagok

## Marveen upstream

- Repository: https://github.com/Szotasz/marveen
- Approval implementation: `src/web/routes/approvals.ts`
- Message sender/provenance constraints: `src/web/routes/messages.ts`
- Settings registry/store: `src/config-registry.ts`, `src/settings-store.ts`
- Kanban / dispatch infrastruktúra: `src/kanban-dispatch.ts`, `src/web/routes/kanban.ts`
- Human approval authority feedback: https://github.com/Szotasz/marveen/issues/923

## AGP 0.4 belső alapok

Ez a specifikáció az eddig elfogadott AGP/APG 0.4 Lean alapelveket viszi tovább:

- artifact/evidence-driven workflow;
- Product LCM és Change Delivery FSM szétválasztása;
- producer ≠ accepter;
- append-only receipt chain;
- deterministic checks before LLM;
- one-agent default;
- risk-based semantic verification;
- sidecar-first architecture.
