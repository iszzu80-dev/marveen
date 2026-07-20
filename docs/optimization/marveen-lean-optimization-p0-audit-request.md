# Marveen kérés — Lean Model, Capacity & Cost Optimization P0 audit

## Cél

Auditáld a jelenlegi Marveen telepítést a **Lean Model, Capacity & Cost Optimization** célmodell alapján.

A cél most **nem fejlesztés és nem konfigurációváltás**, hanem annak pontos feltérképezése, hogy:

- mi működik már;
- mi csak részben működik;
- mi hiányzik;
- mely hiány kezelhető konfigurációval, prompttal vagy skillel;
- mely hiány igényel kódfejlesztést;
- mely fejlesztés helyi;
- mely fejlesztést érdemes upstreamben megvalósítani.

## Kötelező működési elvek

A célmodell alapelvei:

1. **Agent-default routing**
   - Minden agent kapjon egy stabil alapértelmezett model profile-t.
   - Ne történjen minden feladat előtt teljes újraoptimalizálás.

2. **Feladattípus-defaultok**
   - Agentenként legfeljebb 1–3 tipikus feladattípus kapjon külön profilt.
   - A ritka feladatok az agent defaultját használják.

3. **Sticky routing**
   - Egy Kanban-kártya vagy munkacsomag ugyanazon a profilon és runtime-úton fusson végig.
   - Ne legyen modellváltás minden alfeladatnál vagy tool-hívásnál.

4. **Ritka, determinisztikus task override**
   Override csak akkor történhet, ha:
   - változik az adatérzékenység;
   - a primary kapacitása limited vagy blocked;
   - a feladat szokatlanul nehéz;
   - a munka kifejezetten gépies vagy nagy volumenű;
   - az első végrehajtás igazoltan modellképesség miatt sikertelen.

5. **Subscription-first**
   - Elsőként a már kifizetett Claude- és Codex-kapacitást használjuk.
   - A prémium csomagkapacitást védeni kell a magas értékű munkák számára.
   - A rutin és overflow feladatok ár–érték alapján API-ra terelhetők.

6. **Runtime-only fallback**
   - A fallback csak az adott executionre vonatkozhat.
   - Nem írhatja át az agent konfigurált primary modelljét.
   - A következő munkacsomagnál újra a primary próbálkozik.

7. **Adatérzékenységi kapu**
   Három kategória:
   - `public`
   - `internal`
   - `restricted`

   Restricted adat:
   - nem kerülhet tiltott providerhez;
   - nem kaphat automatikus cross-provider privacy downgrade-et;
   - szükség esetén `ask` vagy `manual_only` módot igényel.

8. **Tokenkímélő végrehajtás**
   - Context Packet célérték: legfeljebb 3000 fresh token.
   - Alap kumulatív ceiling: 12000 token.
   - Nagy anyagok referencia, útvonal, hash és releváns kivonat formájában menjenek.
   - Progressive disclosure legyen az alap.
   - Ne inline-oljuk újra a változatlan dokumentumokat és artifactokat.

9. **Context telítettség**
   - 75%: figyelmeztetés.
   - 80%: új nagy feladat nem indul.
   - 85%: checkpoint és friss session.
   - 90%: stop vagy `BUDGET_BLOCKED`.

10. **Deterministic-first**
    LLM-verifier előtt:
    - build;
    - test;
    - typecheck;
    - lint;
    - schema validation;
    - policy check;
    - hash/fingerprint check.

    Low-risk feladatnál ne legyen LLM-verifier.
    Medium/high-risk feladatnál maximum egy független semantic verifier legyen.

11. **CostOps és mérés**
    A meglévő mérésre építs:
    - input/output token;
    - cache read/cache creation;
    - provider és modell;
    - subscription vagy API;
    - fallback;
    - eredmény;
    - retry;
    - emberi korrekció;
    - `cost_per_accepted_task`.

12. **Csomagportfólió-ajánlás**
    A rendszer csak ajánlhat:
    - `KEEP`
    - `UPGRADE`
    - `DOWNGRADE`
    - `CANCEL`
    - `ADD`
    - `ENABLE_USAGE_CREDIT`

    Nem vásárolhat, nem mondhat le és nem módosíthat csomagot automatikusan.

13. **Piaci screening**
    - Heti determinisztikus változásfigyelés, LLM nélkül.
    - Havi rövid CostOps-alapú review.
    - Negyedéves vagy eseményvezérelt mély screening.
    - Fórumok csak early-warning források.
    - Ár, limit és csomagtartalom esetén hivatalos forrás vagy tényleges számla az elsődleges.

14. **Canary-first**
    - Új modell, provider vagy routing szabály először egy agenten fusson.
    - Mérés után korlátozott rollout.
    - Csak ezután teljes rollout.
    - Rollback legyen egyszerű és determinisztikus.

15. **Upstream-frissíthetőség**
    - A generikus routing- és capacity-elemek upstream-kompatibilisek legyenek.
    - A konkrét fiókok, csomagok, árak, modellek és privacy policy maradjanak deployment-local konfigurációban.
    - Nagyobb, generikus fejlesztést először upstream issue/PR formában kell javasolni.

## Vizsgálandó model profile-ok

A célmodell négy generikus profilt használ:

- `premium_reasoning`
- `build_strong`
- `analysis_efficient`
- `routine_lowcost`

A konkrét provider- és modellnevek ne kerüljenek a core policybe.

## Auditálandó területek

Vizsgáld meg legalább az alábbiakat:

1. Agentenkénti jelenlegi modell- és fiókbeállítások.
2. Agentenkénti tipikus feladattípusok.
3. Jelenlegi modellváltási és fallback skillek.
4. Claude Max/Pro és Codex subscription használata.
5. DeepSeek és más API-k használata.
6. CostOps források, token_usage és pricing konfiguráció.
7. Kapacitás-, limit-, balance- és reset-kollektorok.
8. A `model` és `CLAUDE_CONFIG_DIR` kezelésének szétválasztása.
9. Jelenlegi canary-first modellváltási folyamat.
10. Context Packet és APG token-budget használat.
11. Token-origin mérés.
12. Session context saturation kezelése.
13. Determinisztikus watcherek és gate-ek.
14. Hash-stable skip és verification fingerprint.
15. Agentenkénti `CLAUDE.md` és skill progressive disclosure.
16. Inter-agent bus nyelve és tokenhatása.
17. Kanban-kártya és execution közötti routing-rögzítés.
18. Routing események és CostOps közötti kapcsolat.
19. Csomagkihasználtság és overflow mérhetősége.
20. Piaci screening és pricing-source kezelés.
21. A #517 koncepcióhoz való illeszkedés.
22. Már meglévő upstream issue-k és PR-ek, amelyek átfednek ezzel.

## Minden vizsgált elemhez kötelező válasz

Minden gap vagy meglévő funkció esetén add meg:

- **Státusz:** `IMPLEMENTED | PARTIAL | MISSING | NOT_NEEDED`
- **Bizonyíték:** fájl, konfiguráció, adatbázistábla, endpoint, skill vagy dokumentáció pontos helye
- **Jelenlegi működés**
- **Eltérés a célmodelltől**
- **Kockázat**
- **Javasolt megoldás**
- **Megoldás típusa:** `CONFIG | PROMPT | SKILL | SCRIPT | CODE | DOC`
- **Helye:** `LOCAL | UPSTREAM_CANDIDATE | UPSTREAM_REQUIRED`
- **Prioritás:** `P0 | P1 | P2`
- **Becsült komplexitás:** `LOW | MEDIUM | HIGH`
- **Token- és működési többlet**
- **Frissíthetőségi hatás**
- **Elfogadási kritérium**

## Külön vizsgálandó egyszerűsítési kérdések

Keresd meg, hol lehet a koncepciót még egyszerűbbé tenni:

- Van-e olyan mező vagy állapot, amely elhagyható?
- Megoldható-e meglévő CostOps vagy APG komponenssel?
- Van-e párhuzamos adatgyűjtés?
- Van-e olyan LLM-hívás, amely determinisztikus kóddal kiváltható?
- Van-e túl sok fallback vagy routing ág?
- Elég-e agent-default és néhány task-profile?
- Hol okozhat a dinamikus routing több hibát, mint megtakarítást?
- Mi legyen a fail-safe viselkedés, ha az optimalizáló réteg hibázik?

A fail-safe alapelv:

> Ha az optimalizáló réteg nem tud biztonságosan dönteni, az agent a konfigurált default profilon fusson, vagy restricted adatnál kérjen jóváhagyást.

## Elvárt kimenet

Készíts egyetlen audit dokumentumot az alábbi szerkezetben:

### 1. Executive summary
- Mi van már kész?
- Mi a legfontosabb 5 gap?
- Mi az, amit nem érdemes megépíteni?
- Mi a legkisebb biztonságos MVP?

### 2. As-is architektúra
- Jelenlegi modell-, fiók-, CostOps- és fallback működés.
- Egyszerű szöveges folyamatábra.

### 3. Target-state mapping
- A jelenlegi elemek megfeleltetése a lean célmodellnek.

### 4. Gap matrix
- A fent kért mezőkkel.

### 5. Egyszerűsítési javaslat
- Mely elemeket kell elhagyni vagy összevonni.

### 6. P0/P1/P2 implementációs terv
- Kis, egymásra épülő lépések.
- Minden lépés önállóan visszagörgethető legyen.

### 7. Upstream-terv
- Mi illik a #517-be?
- Mi igényel külön issue-t?
- Mi maradjon kizárólag lokális?
- Javasolt kis PR-sorozat.

### 8. Canary pilot
- Egy build agent.
- Egy analysis/routine agent.
- Mérendő KPI-k.
- Rollback-feltételek.

### 9. Go/no-go döntési pontok
- Minden fázis végén objektív elfogadási feltételek.

## Tiltások

Az audit során:

- ne módosíts source fájlt;
- ne módosíts production configot;
- ne válts agentmodellt;
- ne indíts automatikus fallbacket;
- ne állíts le vagy indíts újra agentet;
- ne hozz létre commitot;
- ne pusholj;
- ne nyiss PR-t;
- ne nyiss issue-t;
- ne változtass csomagot;
- ne vásárolj kreditet;
- ne módosíts privacy policyt;
- ne futtass teljes flottás benchmarkot.

## Záró válasz formátuma

A munka végén röviden jelentsd:

- Audit dokumentum útvonala
- IMPLEMENTED / PARTIAL / MISSING darabszám
- P0 gapek száma
- Upstream candidate-ek száma
- Javasolt első canary
- Történt-e bármilyen módosítás: kötelezően `NEM`
