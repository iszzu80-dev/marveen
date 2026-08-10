# Marveen memória-, stabilitás- és tokenhatékonysági audit

**Cél:** bizonyítékokkal ellenőrizni, hogy a helyi Marveen deployment valóban alkalmazza-e a korábban meghatározott memória- és stabilitásvédelmi mechanizmusokat, és ezek nem okoznak-e indokolatlan LLM- vagy tokenfogyasztást.

**Fontos:** ez az első kör kizárólag audit. Ne módosíts forráskódot, konfigurációt, systemd unitot, scheduled taskot, tmux sessiont vagy futó agentet. Ne commitolj, ne pusholj, ne nyiss PR-t vagy issue-t. Minden lépés végén állj meg, add át az eredményt és várj a következő jóváhagyásra.

---

## 1. Háttér és korábbi döntések

A korábbi incidensek alapján legalább három eltérő hibacsaládot kell külön kezelni:

1. **Valódi memória-/OOM-nyomás**
   - sok agent vagy nehéz workload egyszerre fut;
   - reconcile vagy restart után túl sok processz indul;
   - browser/UAT/MCP folyamatok nagy RSS-t érhetnek el;
   - kernel OOM-killer avatkozik be.

2. **OOM-tól független WSL/runtime leállás**
   - ugyanazon boot alatt `systemd-logind: The system will power off now!`;
   - nincs előtte bizonyítható OOM;
   - korábban a `wsl-pro.service`/Windows Agent bridge hibáival mutatott időbeli korrelációt.

3. **Alkalmazásszintű beragadás**
   - a host és a szolgáltatások élnek, de a prompt vagy channel útvonal blokkolt;
   - korábban stale hook okozott ilyen tünetet.

Ezért tilos minden „Marveen nem válaszol” esetet automatikusan memóriahibának minősíteni.

A korábban elfogadott védelmi koncepció:

- determinisztikus watchdog;
- MemGate;
- core-only safe-mode;
- non-core agent parking;
- minden agentindításra közös admission gate;
- reconcile storm elleni védelem;
- schedule-runner és minden más indítási út safe-mode-kompatibilitása;
- fokozatos, kontrollált unpark;
- agent- és workloadszintű memóriafigyelés;
- LLM-mentes steady-state opsmonitor;
- delta-alapú, deduplikált és cooldownos jelentés;
- LLM csak valódi állapotváltozás vagy összetett triage esetén;
- a helyi deployment maradjon frissíthető;
- az általánosítható, upstreamben hiányzó funkciókat upstream javaslatként kell kezelni, nem tartós mély forkban.

Korábbi megfigyelt eredmény:

- a MemGate egy incidens során **19 non-core agentet parkolt**;
- a memóriahasználat körülbelül **86%-ról 32%-ra** csökkent;
- az Ollama embedding szolgáltatás idle memóriahasználata csak körülbelül **37 MB** volt, ezért nem ezt tekintettük elsődleges optimalizációs célpontnak.

Ezek történeti referenciák, nem a jelenlegi működés automatikus bizonyítékai.

---

## 2. Kötelező munkamód

### 2.1. Lépésenkénti végrehajtás

Az auditot az alábbi fázisokban végezd:

1. audit terv és scope;
2. runtime- és repository-baseline;
3. hibadetektálási mechanizmusok;
4. memória-admission és agent lifecycle;
5. safe-mode és restart/reconcile útvonalak;
6. tokenhatékonyság;
7. kontrollált tesztek;
8. gap-mátrix;
9. javítási és upstream terv.

**Egyszerre csak egy fázist végezz el.**  
Minden fázis végén:

- add meg, mit vizsgáltál;
- add meg a parancsokat vagy lekérdezéseket;
- mutasd meg a releváns nyers bizonyítékot;
- vond le a következtetést;
- jelöld a bizonytalanságot;
- állj meg.

Ne kezdd el automatikusan a következő fázist.

### 2.2. Bizonyítéki sorrend

A bizonyítékok erősségi sorrendje:

1. **Futó processzből és valós runtime-ból származó bizonyíték**
2. **Kontrollált, reprodukálható teszt**
3. **Ténylegesen betöltött systemd/tmux/process environment**
4. **A futó build forráskódja**
5. **Konfiguráció**
6. **Dokumentáció vagy komment**
7. **Feltételezés**

Egy mechanizmust nem szabad `PROVEN` státuszúnak minősíteni csak azért, mert:

- van róla fájl vagy config;
- létezik hasonló nevű service;
- a forráskódban van egy függvény;
- korábban egyszer működött;
- a dokumentáció ezt állítja.

### 2.3. Kötelező minősítések

Minden auditált állítás egyet kapjon az alábbi státuszokból:

- **PROVEN** — futó rendszerből és/vagy kontrollált teszttel bizonyított;
- **PARTIAL** — létezik, de nem fed le minden útvonalat vagy feltételt;
- **NOT PROVEN** — lehet, hogy létezik, de nincs elég bizonyíték;
- **CONTRADICTED** — a runtime viselkedése vagy a forrás ellentmond a követelménynek;
- **NOT APPLICABLE** — bizonyítottan nem releváns az adott deploymentben.

Minden státusz mellett legyen:

- bizonyíték;
- fájl/service/process hivatkozás;
- kockázat;
- szükséges következő ellenőrzés vagy javítás.

---

# 3. Fázis 1 — Audit terv és scope

Első válaszodban kizárólag ezt add át:

## 3.1. Tervezett vizsgálati területek

Legalább:

- WSL host és systemd;
- Marveen dashboard/channel/broker/orchestrator;
- agent tmux sessionök;
- agent start/stop/reconcile útvonalak;
- schedule-runner és heartbeat;
- watchdog;
- MemGate;
- safe-mode;
- memory/resource monitor;
- logok és incidens-nyilvántartás;
- CostOps/capacity registry kapcsolódás;
- token- és LLM-használat;
- git/upstream-frissíthetőség.

## 3.2. Biztonságos auditmódszer

Írd le:

- milyen read-only parancsokat használsz;
- mely műveletek lehetnek terhelők;
- mely tesztekhez kell majd külön jóváhagyás;
- hogyan kerülöd el, hogy az audit maga okozzon OOM-ot vagy restart stormot.

## 3.3. Várt kimenet

A végső audit kimenete legyen:

1. executive summary;
2. runtime topológia;
3. mechanizmusonkénti evidence table;
4. minden indítási útvonal coverage-mátrixa;
5. tokenhatékonysági audit;
6. kontrollált teszteredmények;
7. gap- és kockázati lista;
8. helyi javítási terv;
9. upstream javaslatok;
10. elfogadási kritériumok.

**Ezután állj meg.**

---

# 4. Fázis 2 — Runtime- és repository-baseline

A következő jóváhagyás után bizonyítsd a tényleges futó állapotot.

## 4.1. Host és WSL

Gyűjtsd ki legalább:

- aktuális dátum és idő;
- boot-id;
- uptime;
- RAM és swap;
- kernel;
- WSL-verzió és releváns `.wslconfig`;
- systemd állapot;
- utolsó OOM-események;
- utolsó `power off`, shutdown és boot események;
- `wsl-pro.service` tényleges állapota;
- kulcsfontosságú cgroup/systemd slice memóriaadatai.

Ne csak a configot mutasd: ahol lehet, a futó kernel vagy systemd effektív értékét add meg.

## 4.2. Marveen processztopológia

Mutasd meg:

- mely processzek a core komponensek;
- mely agentek futnak;
- melyek stopped, parked vagy unreachable állapotúak;
- tmux sessionök;
- agentenkénti fő PID;
- agentenkénti processzfa;
- RSS/PSS, ha biztonságosan mérhető;
- browser, Playwright, Chrome és MCP gyermekfolyamatok;
- árván maradt vagy nem várt processzek;
- Ollama aktuális és csúcsterhelésre utaló adatai.

## 4.3. Repository és helyi eltérések

Add meg:

- repository útvonala;
- aktuális branch és HEAD;
- `origin/main` állapota;
- ahead/behind;
- tracked és untracked változások;
- helyi patchek;
- helyi systemd unitok vagy scriptek, amelyek nincsenek upstreamben;
- mely memória/stabilitási mechanizmus upstream, és melyik csak helyi.

Külön minősítsd a helyi frissíthetőséget:

- **CLEANLY UPDATEABLE**
- **UPDATEABLE WITH MANAGED OVERLAY**
- **FRAGILE LOCAL PATCHSET**
- **FORK DIVERGENCE RISK**

**Ne módosíts semmit. Ezután állj meg.**

---

# 5. Fázis 3 — Watchdog és hibaklasszifikáció

## 5.1. Watchdog létezése és működése

Bizonyítsd:

- mi indítja;
- milyen gyakran fut;
- LLM-et használ-e;
- hol tárol állapotot;
- hogyan észleli a boot-id változást;
- hogyan észleli a same-boot poweroffot;
- hogyan észleli az OOM-ot;
- hogyan észleli a core service kiesést;
- hogyan különíti el az alkalmazásszintű channel/hook beragadást;
- van-e deduplikáció és cooldown;
- újraindítás után megőrzi-e az előző állapotot;
- normál állapotban generál-e értesítést vagy LLM-hívást.

## 5.2. Kötelező hibakategóriák

Ellenőrizd, hogy a rendszer képes-e külön minősíteni legalább:

- `HOST_REBOOT`
- `SAME_BOOT_POWEROFF`
- `KERNEL_OOM`
- `MEMORY_PRESSURE_NO_OOM`
- `CORE_SERVICE_DOWN`
- `AGENT_PROCESS_EXIT`
- `CHANNEL_PATH_BLOCKED`
- `SCHEDULE_OR_RECONCILE_STORM`
- `PROVIDER_CAPACITY_LIMIT`
- `UNKNOWN`

Ha más reason code-ok vannak, készíts megfeleltetési táblát.

## 5.3. Elvárt eredmény

A watchdog:

- ne próbáljon minden hibára teljes-flotta restartot;
- ne indítson automatikusan non-core agenteket safe-mode alatt;
- ne használjon LLM-et puszta mintavételezésre;
- adjon rövid, strukturált evidence bundle-t.

**Ezután állj meg.**

---

# 6. Fázis 4 — MemGate, admission control és agent parking

## 6.1. MemGate

Bizonyítsd:

- hol van implementálva;
- mi indítja;
- milyen mérőszámokat olvas;
- milyen küszöböket használ;
- van-e warning, critical és recovery küszöb;
- van-e hysteresis;
- van-e minimum stabilitási idő;
- milyen gyakran fut;
- használ-e LLM-et;
- mit tekint core és non-core komponensnek;
- milyen sorrendben parkol;
- hogyan kezeli a nehéz browser/UAT workloadot;
- hogyan kezeli az MCP gyermekfolyamatokat;
- mi történik, ha a parkolás nem szabadít fel elég memóriát.

A küszöböket ne találd ki: az effektív runtime/config/forrás alapján add meg.

## 6.2. Agent parking

Ellenőrizd:

- a parking megőrzi-e az agent konfigurációját;
- megmarad-e a feladat és memória;
- leáll-e a teljes processzfa;
- nem marad-e orphan MCP/browser processz;
- a parked állapot látható-e a dashboardon vagy API-ban;
- a reconcile és schedule-runner tiszteletben tartja-e;
- reboot után megmarad-e vagy biztonságosan rekonstruálódik-e;
- van-e különbség `stopped`, `parked`, `unreachable` és `failed` között.

## 6.3. Workload- és agentbudget

Ellenőrizd, van-e:

- agentenkénti memóriafigyelés;
- processzfára számolt memória;
- workload-classification;
- browser/UAT concurrency limit;
- MCP concurrency limit;
- session-élettartam vagy stale-process cleanup;
- burst és sustained memória megkülönböztetés;
- egy agent által okozott növekedés detektálása.

Készíts táblát:

| Agent/workload | Aktuális RSS/PSS | Gyermekfolyamatok | Workload class | Limit | Enforcement | Státusz |
|---|---:|---:|---|---:|---|---|

## 6.4. Történeti referencia ellenőrzése

Keresd meg, van-e hiteles log vagy audit trail a korábbi:

- 19 non-core agent parkolásáról;
- 86% → 32% memóriacsökkenésről.

Ha nincs meg, jelöld történeti állításként, ne jelenlegi bizonyítékként.

**Ezután állj meg.**

---

# 7. Fázis 5 — Safe-mode, reconcile és minden indítási útvonal

Ez az audit legfontosabb része.

## 7.1. Safe-mode

Bizonyítsd:

- hogyan aktiválódik;
- milyen állapotban tárolódik;
- perzisztens-e;
- mely core processzek maradnak;
- mit tilt;
- mit enged;
- hogyan oldható fel;
- automatikusan feloldódhat-e;
- van-e minimum stabilitási idő;
- minden agentindítási út lekérdezi-e.

A safe-mode nem lehet egyszeri „stopolj le néhány agentet” script. Globális runtime policyként kell működnie.

## 7.2. Indítási útvonalak coverage-mátrixa

Azonosíts minden olyan útvonalat, amely agentet vagy nehéz workloadot indíthat:

- dashboard start gomb/API;
- main orchestrator delegálás;
- desired-state reconcile;
- dashboard/service restart utáni bootstrap;
- schedule-runner;
- heartbeat;
- kanban automation;
- inter-agent delegation;
- CLI vagy kézi script;
- systemd restart;
- watchdog recovery;
- remote-agent start;
- teszt/UAT automation;
- egyéb rejtett vagy közvetett út.

Készíts ilyen táblát:

| Indítási út | MemGate | Safe-mode | Capacity gate | Backoff/jitter | Concurrency limit | Audit log | Státusz |
|---|---|---|---|---|---|---|---|
| Dashboard API | | | | | | | |
| Reconcile | | | | | | | |
| Schedule-runner | | | | | | | |
| Heartbeat | | | | | | | |
| Delegálás | | | | | | | |
| CLI/manual | | | | | | | |
| Remote start | | | | | | | |

Egyetlen nem gate-elt indítási út miatt az összesített státusz legfeljebb `PARTIAL`.

## 7.3. Reconcile storm elleni védelem

Bizonyítsd:

- restart után nem indul-e egyszerre a teljes desired fleet;
- van-e prioritási sorrend;
- van-e start batch size;
- van-e két indítás közti késleltetés;
- minden batch után ellenőriz-e memóriát;
- van-e exponential backoff;
- memory pressure esetén megszakítja-e a reconcile-t;
- safe-mode alatt kihagyja-e a non-core agenteket;
- a reconcile desired-state tárolója nem írja-e felül a parkingot.

## 7.4. Schedule-runner bypass

Kifejezetten vizsgáld meg a korábban azonosított hibát:

> a schedule-runner vagy más lifecycle útvonal visszaindíthatta a safe-mode által leállított agenteket.

Adj egyértelmű választ:

- a bypass jelenleg reprodukálható;
- javítva van és teszttel bizonyított;
- csak részlegesen javított;
- nem bizonyítható.

**Ezután állj meg.**

---

# 8. Fázis 6 — Token- és LLM-hatékonyság

## 8.1. Steady-state monitorozás

Bizonyítsd, hogy normál állapotban:

- a RAM/swap/processz mintavételezés nem LLM-mel történik;
- a watchdog nem generál periodikus természetes nyelvi elemzést;
- a heartbeat csak kompakt állapotot olvas;
- nincs teljes `journalctl`, `ps`, tmux dump vagy log újraküldve minden ciklusban;
- az azonos állapot nem generál új jelentést;
- van deduplikáció;
- van cooldown;
- csak delta kerül továbbításra.

## 8.2. Strukturált state registry

Mutasd meg, van-e kompakt állapottár, például:

- aktuális health state;
- previous state;
- timestamp;
- reason code;
- kulcsmérőszámok;
- top memory contributor;
- automatikus action;
- confidence;
- source log reference;
- notification fingerprint.

Értékeld:

- mennyire nő az állapottár;
- van-e TTL vagy retention;
- kerül-e nyers, nagy log az LLM-kontextusba;
- mennyi token egy tipikus normál és egy incidens jelentés.

## 8.3. LLM-es triage

Ha van LLM-es incidens-triage:

- mi triggereli;
- melyik modell fut;
- milyen inputot kap;
- van-e felső tokenlimit;
- használ-e olcsó modellt első szinten;
- mikor eszkalál erősebb modellre;
- provider limit esetén van-e fallback;
- sikertelen LLM-hívás nem blokkolja-e a determinisztikus védelmet.

## 8.4. Elvárt tokenhatékony működés

Az elvárt folyamat:

```text
deterministic sensors
        ↓
compact state registry
        ↓
state transition?
   ┌────┴────┐
  nem       igen
   │          ↓
nincs     short evidence bundle
LLM        ↓
hívás   olcsó LLM triage
             ↓
      csak szükség esetén
       erősebb modell
```

Minősítsd külön:

- steady-state tokenfogyasztás;
- incidensenkénti tokenfogyasztás;
- ismétlődő incidens deduplikációja;
- napi/heti ops-összefoglaló költsége.

**Ezután állj meg.**

---

# 9. Fázis 7 — Kontrollált tesztek

Ezt a fázist csak külön jóváhagyás után végezd.

A tesztek nem okozhatnak valós OOM-ot vagy adatvesztést. Preferáld a dependency injectiont, fixture-t, mockolt mérőszámokat, teszt-agentet vagy elkülönített cgroupot.

## 9.1. Kötelező tesztforgatókönyvek

1. **Warning memory pressure**
   - a rendszer észlel;
   - még nem parkol agresszíven;
   - nem küld ismétlődő riasztást.

2. **Critical memory pressure**
   - új non-core start tiltott;
   - megfelelő agent(ek) parkolnak;
   - teljes processzfa leáll;
   - memória visszaállását ellenőrzi.

3. **Safe-mode + schedule-runner**
   - safe-mode aktív;
   - schedule esedékes;
   - non-core agent nem indul el.

4. **Safe-mode + reconcile**
   - desired state szerint futnia kellene;
   - mégsem indul el safe-mode alatt.

5. **Dashboard restart**
   - nincs teljes-flotta start storm;
   - fokozatos reconcile történik.

6. **Browser/UAT workload**
   - concurrency limit működik;
   - túl nagy agent izolálható;
   - más core szolgáltatás nem esik ki.

7. **Orphan cleanup**
   - agent stop/park után nem marad browser/MCP gyermekfolyamat.

8. **Recovery/unpark**
   - csak megfelelő stabilitási idő után;
   - fokozatosan;
   - minden lépés után újramérés;
   - memória romlásakor azonnal megáll.

9. **Same-boot poweroff klasszifikáció**
   - ne legyen automatikusan OOM-nak nevezve.

10. **Channel path blocked**
    - host alive, channel blocked;
    - watchdog külön reason code-ot ad;
    - nem indít feleslegesen teljes flottát.

11. **LLM/provider failure**
    - a determinisztikus MemGate tovább működik;
    - az LLM-triage hibája nem akadályozza a védelmet.

## 9.2. Tesztbizonyíték

Minden teszthez:

- előfeltétel;
- input;
- pontos parancs vagy fixture;
- elvárt eredmény;
- tényleges eredmény;
- log;
- memória előtte/utána;
- processzlista előtte/utána;
- PASS/FAIL;
- cleanup bizonyíték.

**Ezután állj meg.**

---

# 10. Fázis 8 — Végső gap-mátrix

A végső táblában legalább ezek szerepeljenek:

| Követelmény | Státusz | Runtime evidence | Teszt | Kockázat | Javítás szükséges |
|---|---|---|---|---|---|
| OOM és same-boot poweroff külön kezelése | | | | | |
| Watchdog determinisztikus | | | | | |
| Boot-id és poweroff detektálás | | | | | |
| Stale channel/hook külön felismerése | | | | | |
| MemGate működik | | | | | |
| Core/non-core besorolás explicit | | | | | |
| Agent parking teljes processzfára hat | | | | | |
| Safe-mode globális policy | | | | | |
| Dashboard start gate-elt | | | | | |
| Reconcile gate-elt | | | | | |
| Schedule-runner gate-elt | | | | | |
| Heartbeat/delegálás gate-elt | | | | | |
| Restart után nincs reconcile storm | | | | | |
| Browser/UAT concurrency limit | | | | | |
| Fokozatos unpark | | | | | |
| Hysteresis és cooldown | | | | | |
| Steady-state nincs LLM-hívás | | | | | |
| Delta-alapú jelentés | | | | | |
| Deduplikáció | | | | | |
| Kompakt state registry | | | | | |
| LLM hiba nem blokkolja a védelmet | | | | | |
| Lokális deployment frissíthető | | | | | |
| Általános gap upstreamre jelölve | | | | | |

## 10.1. Összesített döntés

A végén csak egyet válassz:

- **COMPLIANT**
- **COMPLIANT WITH MINOR GAPS**
- **PARTIALLY COMPLIANT**
- **NOT COMPLIANT**
- **INSUFFICIENT EVIDENCE**

A `COMPLIANT` csak akkor adható, ha:

- minden agentindítási út gate-elt;
- a safe-mode nem kerülhető meg;
- a kontrollált tesztek sikeresek;
- steady-state monitorozás LLM-mentes;
- nincs jelentős frissíthetőségi kockázat.

---

# 11. Fázis 9 — Javítási és upstream terv

Csak az audit jóváhagyása után készíts tervet. Még ekkor se implementálj automatikusan.

## 11.1. Javítások kategorizálása

Minden gap kerüljön egy kategóriába:

### A. Lokális konfigurációs javítás

Akkor használd, ha:

- a hivatalos funkció már létezik;
- csak helytelen vagy hiányos helyi config van;
- nincs szükség source patchre.

### B. Kezelt lokális overlay

Akkor használd, ha:

- sürgős helyi stabilitási védelem kell;
- upstreamben még nincs funkció;
- a megoldás külön service/script/config rétegként fenntartható;
- nem módosítja mélyen a Marveen core-t;
- dokumentált install/update/rollback útja van.

### C. Upstream issue vagy PR

Akkor használd, ha a gap általános Marveen-funkció:

- egységes resource admission gate;
- safe-mode minden lifecycle útvonalra;
- reconcile storm protection;
- parked agent state;
- workload concurrency policy;
- struktúrált health/capacity registry;
- determinisztikus opsmonitor;
- tokenhatékony incident delta.

### D. Helyi deployment-specifikus ügy

Például:

- WSL vagy Windows bridge sajátosság;
- helyi hardware limit;
- lokális provider/account routing;
- egyedi agentflotta-méret.

Ezt ne próbáld feltétlenül upstream core funkcióként kezelni.

## 11.2. Kötelező tervformátum

Minden javasolt változtatáshoz:

- probléma;
- bizonyíték;
- root cause;
- minimális megoldás;
- miért nem elég csak config;
- érintett fájlok/service-ek;
- tesztek;
- rollback;
- updateability hatás;
- upstream relevancia;
- becsült token- és memóriahatás;
- sorrend és függőségek.

## 11.3. Implementációs fegyelem

Ha később jóváhagyást kapsz:

1. egy gap;
2. egy terv;
3. egy változtatási csomag;
4. teszt;
5. bizonyíték;
6. megállás;
7. következő jóváhagyás.

Ne keverd össze egy PR-ban:

- WSL host workaroundot;
- MemGate core fejlesztést;
- token routingot;
- dashboard UI-t;
- más, nem kapcsolódó feature-t.

---

# 12. Referencia a hivatalos Marveen-architektúrához

Az audit során először olvasd el és vesd össze a helyi implementációval:

- `README.md`
- `docs/agent-fleet.md`
- `docs/memory-system.md`
- `docs/heartbeat-autonomy.md`
- `docs/scheduled-tasks.md`
- `docs/background-tasks.md`
- `docs/conversation-continuity.md`
- releváns source és install/systemd fájlok.

A hivatalos architektúrából különösen fontos:

- minden agent külön tmux sessionben futó Claude Code példány;
- az agent lifecycle start/stop/status API-kon keresztül kezelhető;
- a heartbeat-ek elvileg rövid, fókuszált ellenőrzések;
- a memória hot/warm/cold/shared rétegeket, FTS5-öt és opcionális Ollama embeddinget használ;
- az Ollama nélkül a szemantikus keresés romlik, ezért csak valódi mérés alapján optimalizálható ki;
- a helyi működésnek az upstream lifecycle fölé kell épülnie, nem kontrollálatlan core-forkként.

---

# 13. Első, most végrehajtandó feladat

Most kizárólag a **Fázis 1 — Audit terv és scope** részt hajtsd végre.

Ne futtass terheléses tesztet.  
Ne állíts le vagy indíts el agentet.  
Ne módosíts fájlt.  
Ne commitolj.  
Ne pusholj.  
Ne nyiss issue-t vagy PR-t.  
Ne lépj tovább a Fázis 2-re.

A válaszod végén pontosan add meg:

```text
FÁZIS 1 ÁLLAPOT: KÉSZ / NEM KÉSZ
MÓDOSÍTÁS TÖRTÉNT: NEM
KÖVETKEZŐ JAVASOLT FÁZIS: FÁZIS 2 — RUNTIME- ÉS REPOSITORY-BASELINE
JÓVÁHAGYÁSRA VÁR: IGEN
```
