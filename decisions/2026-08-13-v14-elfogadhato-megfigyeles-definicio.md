# Az „elfogadható megfigyelés" definíciója — végleges, regisztrációba emelve

**Dátum:** 2026-08-13
**Szerző:** Marveen (definíció), a feltételek 1–4. pontja; az 5. pont Marveen kiegészítése
**Státusz:** befagyasztva a `value_gate_registration` design-felébe

---

## 1. A definíció

> **Elfogadható megfigyelés:** időponthoz kötött állapot a Case-rétegben, amiről egy hozzáértő
> kabinetfőnök szólt volna a tulajdonosnak, és amihez a bizonyíték **már a tárolóban volt** a szólás
> pillanata előtt.

**Három alakja:**

| Kód | Alak |
|---|---|
| `DEADLINE_PASSED_UNSEEN` | határidő, ami levezethető volt a tárolt bizonyítékból, és úgy múlt el vagy közeledett, hogy a tulajdonos nem tudott róla |
| `FOLLOW_UP_ELAPSED_WITHOUT_MOVEMENT` | ügy, ahol a labda a másik félnél volt, és a megállapodott utánkövetési idő mozgás nélkül telt el |
| `STATE_CHANGE_INVALIDATED_DECISION` | ügy, aminek az állapotváltozása érvénytelenített egy korábbi tulajdonosi döntést |

---

## 2. Az öt feltétel — és hogy melyik hol van betartatva

| # | Feltétel | Betartatás |
|---|---|---|
| 1 | **Vak eldönthetőség.** Kizárólag a `T` időpontbeli pillanatképből, olyasvalaki által, aki nem látta a detektor kimenetét. Ha csak a jelzés ismeretében ítélhető meg, az **visszaigazolás, nem megfigyelés**. | `labelEligibleObservation` és `completeEligibilityPass` **megtagadja** a címkézést, ha a korpuszon már lezárult proaktív vagy kalibrációs futás |
| 2 | **Bizonyíték-elsőbbség.** A bizonyítéknak szigorúan `T` **előtt** kell a tárolóban lennie. Ami csak később vált tudhatóvá, az nem elmulasztott megfigyelés. | `observed_at` és `evidence_at` oszlop, `CHECK (evidence_at < observed_at)`, plusz nevesített elutasítás a hívásnál |
| 3 | **Tulajdonosi relevancia, nem rendszer-relevancia.** A próba az, hogy a **tulajdonosnak** kellett-e tudnia, nem az, hogy a rendszer ki tudta-e számolni. | Gépileg nem ellenőrizhető. Amit ki lehet kényszeríteni: **érdemi indoklás**, mert egy címke, amihez a szerzője nem tudott mondatot írni, olyan címke, amit senki nem mérlegelt |
| 4 | **A hiány rekord, nem üresség.** Címkézett nulla ≠ át nem nézett ablak. | Külön `eligibility_passes` tábla. Átnézés nélkül a számláló **null**, nem 0 |
| 5 | **A címkéző mondhassa, hogy nem tudja.** Egy kétes esetre kikényszerített bináris címke **gyártott bizonyosság**. | `UNCERTAIN` alak, **külön számolva**, egyik oldalba sem olvasztva. `uncertainRate` mindig jelentve |

### Az ötödik feltételről

Ez Marveen kiegészítése, és nekem hiányzott. Kimondva, amiért kell: ha az `UNCERTAIN` aránya magas,
**az magáról a definícióról mond valamit, nem a korpuszról** — és azt jobb látni, mint elsimítani.

Küszöb csak **előre regisztrálva** kapuz. Alapértelmezésben `maxUncertainRate = null`: az arány
jelentődik, de nem dönt. Egy küszöb, amit a szám megismerése **után** találunk ki, ugyanaz a lépés,
amit a V4-F14 a találat-küszöbnél tilt.

---

## 3. A nevezőről — a regisztrációba emelt mondat

> **A nevező kizárólag a címkézési menetből származhat, soha a detektor kimenetéből.**

Ez a mondat egy valódi hibát javított. A `replay-eval.ts` így számolt:

```ts
const eligibleObservationCount = comparison.proactiveCases
```

Vagyis a *„mennyi értéket adott hozzá a detektor"* **nevezője maga a detektor kimenete volt.** Egy
detektor, ami kevesebbet vesz észre, ugyanolyan jól teljesített volna azzal, hogy egy **kisebb
világból** vesz észre kevesebbet.

Marveen megjegyzése erről pontos, és érdemes megőrizni: **nem az a jó hír, hogy megtaláltuk, hanem
hogy egy definíció találta meg, nem egy teszt.** Ez pontosan az a fajta hiba, ami soha semmin nem
bukik el.

### A mondat nem maradt dokumentumsor

`src/__tests__/cos-eligibility-denominator.test.ts` — négy réteg, mert az első három egyike sem elég:

| Réteg | Mit fog meg |
|---|---|
| forrás-pásztázás | egy produkciós sor, ami egy lapon nevezi meg a nevezőt és az ág kimenetét |
| lekérdezés-pásztázás | a nevezőt előállító két függvény csak `eligible_observations` / `eligibility_passes` táblát kérdezhet |
| író-pásztázás | a címketáblába **kizárólag** a `replay-eval.ts` szúrhat be |
| viselkedés a **kapunál** | ugyanaz a címkézés, két különböző méretű ág → a kapu nevezője mindkétszer a címkézett szám |

A negyedik réteg nem eleganciából van ott. Amikor a kaput a **pontosan visszatett eredeti hibával**
mutánsoltam (`const labelled = comparison.proactiveCases`), az első három **zöld maradt** — a soron
nem szerepelt a nevező neve. Egy kapu, ami csak a tegnapi elírást fogja meg, nem kapu. A negyedik
réteggel mindhárom mutáns piros:

```text
a REGI HIBA visszateve: a nevezo = a detektor kimenete   → 2 teszt piros
a nevezo lekerdezese az AG-tablabol jon                  → 5 teszt piros
egy masik modul is ir a cimketablaba                     → 1 teszt piros
```

A 2., 3. és 5. feltétel őrzői ugyanígy piros-igazoltak: az őrző eltávolítása mindegyiknél megnevezve
buktatja azt a tesztet, ami miatt a feltétel bekerült.

---

## 4. A befagyasztási pont — kapu, nem dátum

Marveen: *„egy ígéret, hogy nem landol proaktív modul, pontosan az a fajta állítás, ami csendben
megszegődik."*

```text
kalibrációs commit:            30e16ef92753
detector_config_fingerprint:   e2181cf18b700395d0e68d1aca22430d
```

**A hash hatóköre — tizenkét fájl:**

```text
src/cos/deadline-index.ts        src/cos/proactive/qualification.ts
src/cos/intake.ts                src/cos/proactive/schema.ts
src/cos/triage-bridge.ts         src/cos/proactive/signal-store.ts
src/cos/proactive/approval-load.ts   src/cos/proactive/sweep.ts
src/cos/proactive/detectors.ts       src/cos/proactive/types.ts
src/cos/proactive/initiative-store.ts
src/cos/proactive/preparation.ts
```

A hash a **forrást** hasheli, nem egy verzió-stringet — az újabb ígéret lenne.

**Az intake modulok szándékosan benne vannak.** Marveen mérése szerint a mai ügyeket a saját
email-triage heartbeatje hozta létre, tehát ami organikus érkezésnek látszik, részben a **saját
beviteli csatornánk kimenete**. A jogosultsági ráta így egy **intake-konfigurációra feltételezett**,
és egy csak-detektor hash engedné, hogy a nevező elmozduljon, miközben a kísérlet befagyasztottnak
mondja magát.

---

## 5. A korpusz-kérdés lezárva

Marveen a domain-falat javasolta (personal = kalibráció, ZST = kísérlet), majd elfogadta az
ellenérvet, és a saját megfogalmazásában rögzítem, mert pontosabb az enyémnél:

> *„Egy erős elválasztás rossz tengelyen rosszabb, mint semmilyen, mert megnyugtat."*

A personalon mért küszöb ZST-re alkalmazva rossz populációból méretezné az ablakot, és a fal ezt
**elfedte** volna: minden szabályosnak látszott volna.

**A megoldás:** a kalibrációs futás **előre néz**, tehát a korpusza a jövő, a kísérleté egy későbbi
jövő — **konstrukció szerint diszjunktak az időben.** Nem kell fal, mert soha nem érintkeznek.

**Mindkét domain, mindkét futásban, egymás után, domainenként jelentve.** Ha a ZST hat nap és 42 ügy
mellett vékony marad, az **megállapítás a ZST-ről** — a becsületes kimenet `NO_EVIDENCE_DUE_TO_LOW_VOLUME`,
ami nem PASS, de nem is elrejtett kudarc.

---

## 6. A volumen-mérés — amit Marveen mért, és amit ebből nem szabad

**A 73 ügyből 45 egyetlen napon jött létre (aug. 6.) — az migráció, nem érkezés.** A maradék 28 tíz
napra oszlik: 1, 1, 1, 7, 6, 3, 3, 6.

Naiv rátaként 2,8 ügy/nap. **Felső korlát, nem becslés**, két okból:

1. **A mérendő rendszer és a mérés forrása nem független.** A mai hat ügyet az email-triage
   heartbeat hozta létre — amit organikus érkezésnek néznénk, részben a saját beviteli csatornánk
   kimenete.
2. **A rendszer felfutásban van, nem stacionárius.**

### Egy módszertani figyelmeztetés, amit meg kell őrizni

A per-ügy késleltetés-mérés (ügy létrehozása mínusz első bizonyíték) **24 ügyet** mutat backfillnek,
holott a napi eloszlás **45-öt**. A különbség oka: a migráció az ügyet és az eseményét **egyszerre
írta**, tehát a késleltetés nulla, és a backfill organikusnak látszik.

**Ha valaha automatikusan mérnénk a backfill arányt ezzel a módszerrel, alulbecsülnénk.** Ezt a
mérőt így nem szabad automatizálni.

---

## 7. A spec-bump — v1.4.2

A 90 napos korpusz-követelmény kikerült a specifikációból, mert **proxy volt**, és a proxy mérésekor
kiderült, hogy soha nem teljesíthető visszamenőleg. Helyére a volumen-feltétel maga került.

**Érintett szakaszok:** §1.4.1 (átírva), §24.2, §26/3–5, §25/27, valamint a `V4-F14` fixture Given-je.
Az indoklás teljes egészében a spec új **§32. Amendment log** szakaszában, hogy ne csak a
`git log`-ban éljen.

**A napló nem az engedékenységet rögzíti, hanem a szigorítást.** Három ponton szigorúbb, mint ami
előtte volt:

1. a nevező nem jöhet a detektor kimenetéből (ez javított egy valódi, néma hibát);
2. az át nem nézett korpusz `null`, nem `0` — `EVALUATION_WINDOW_DEGRADED`, nem PASS;
3. a befagyasztás kapu (`detector_config_fingerprint` + `calibration_commit`), nem dátum.

**Ami szándékosan üres marad:** `minimum_eligible_observations`,
`required_incremental_material_catches` és az adjudikátor-nevek. Az első kettőt csak a kalibrációs
mérés töltheti ki, a harmadik tulajdonosi döntés. Amíg üresek, a kapu kimenete
`NO_EVIDENCE_DUE_TO_LOW_VOLUME` — **ez a helyes állapot, nem hiányosság.**
