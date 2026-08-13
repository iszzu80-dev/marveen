# Teljes code review — CostOps · APG · Lean Optimization · CoS (privát + céges) · Autonomous Case Progression

**Dátum:** 2026-08-13
**Alap:** `marveen-private` @ `2d3c662` (= `origin/develop`) · `marveen-apg-kernel` @ `1ae89c8` (= `origin/wp1-slice1-executor-registry`) · `marveen-suite` @ `cb99550` (= `origin/main`)
**Specifikációk:** `docs/marveen-autonomous-case-progression-spec-v1.3.1.md` · `docs/marveen-personal-chief-of-staff-v4.2.1.md` · `docs/costops/core-functional-scope-v1.0.1.md` · `docs/optimization/*` · `docs/apg/apg-1.8-*.md` + `marveen-apg-kernel/audits/apg-1.8-gap-map.md`
**Előzmény:** a `claude/marveen-cos-code-review-qe1z7m` ágon lévő, 2026-08-12-i konszolidált review (kilencedik kör). Ez a tizedik kör: az ott nyitva hagyott tételeket visszamértem, és 14 új találást adok hozzá (`R-1..R-14`).

## Kapuk (ténylegesen lefuttatva)

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run` (teljes) | **5890 zöld / 7 piros / 4 kihagyott (5901)** — **473 fájlból 5 piros** |
| `marveen-apg-kernel` tesztek | nem futtatva ebben a környezetben (nincs Python-környezet felhúzva); a kernel saját gap-map-je 426/432-t riportál |

A 2026-08-12-i kör 4 piros fájlt mért. **Ma 5 van.** Az új piros a `costops-api.test.ts` (3 teszt) — lásd `R-11`.

---

## 0. Rövid álláspont

A vizsgált öt fejlesztés **nem öt párhuzamos projekt, hanem egy lánc**, és a lánc két vége nagyon eltérő érettségű:

```
CostOps (mérés)  →  Lean Optimization (döntés a mérésből)  →  model routing
        ↓
      APG (bizonyíték-kapuk a fejlesztésen)
        ↓
CoS privát + céges (ügyintézés)  →  Autonomous Case Progression (az ügy magától halad)
```

- **A privát CoS küldési útja ma a rendszer legerősebb része.** A §22.2 nem-hamisítható authorization ticket valódi (opaque, single-use, atomikus fogyasztás, TOCTOU-újraellenőrzés, WeakSet-alapú gate-permit), és a §17 prompt-injection fixture mind a hét elfogadási kritériumra valódi tesztet ad.
- **A céges (ZST) küldési út ugyanennek a hiányos másolata.** Négy védelmi réteg, amit a privát oldalon megépítettek, a céges oldalon nincs bekötve (`R-1`), a jogosultsági bemenet pedig egyáltalán nem érkezik meg (`R-2`), és az F-1/F-2 idempotencia-javítás nincs átvezetve (`R-3`). Ez a 2026-08-12-i kör által megnevezett hibaosztály — *„a javítás nem néz vissza a forrásra, ahonnan másolt"* — legnagyobb élő példánya.
- **A progression-réteg biztonsági kapuja konstrukció szerint zöld** (`R-5`). A spec §16 az eval/replay harness-t nevezi „az első load-bearing fejlesztési elemnek"; a mai harness a saját marker-detektorát bizonyítja, nem a progresszió biztonságát.
- **CostOps és Lean Optimization funkcionálisan használható, minőségileg megállt.** A C-1..C-7 mind a hét, és az O-találásokból hét változatlan a kilencedik kör óta; ez a kör ehhez egy megbízhatatlan teszt-jelzést tesz hozzá (`R-11`).
- **A repók között nincs mit „main felé mergelni"** — de három repó-szintű higiéniai probléma van, amelyik pontosan azt a kérdést teszi megválaszolhatatlanná, hogy mi is a kész állapot (lásd 5. fejezet).

---

## 1. Keresztmetsző találások — a részletek közötti összefüggések

### R-1 · P1 · A céges küldési út négy védelmi rétege nincs bekötve

A két út ugyanarra a megosztott motorra épül (`executor-core.makeExecutor`), és a `dispatchApprovedSend` (privát) négy dolgot ad át neki, amit a `dispatchZstSend` (céges) nem:

| Réteg | Privát (`send-flow.ts`) | Céges (`zst-send.ts`) | Következmény |
|---|---|---|---|
| `approvalId` az auth-kontextusban | `decision.approvalId ?? null` (`:296`) | **bedrótozott `null`** (`:255`) | A §22.2 TOCTOU-lista hatodik pontja (*„approval/envelope validity"*) **halott a céges úton**. A `consumeAuthorization` approval-visszavonás-ellenőrzése (`action-authorization.ts:175-194`) csak akkor fut, ha van `approval_id` — a céges ticketen soha nincs. Egy visszavont céges jóváhagyás a ticket 120 másodperces élettartamán belül **még küld**. Ezt a rést a privát oldalon kifejezetten megtalálták és bezárták; a kommentje ott áll a kódban. |
| claim (per-sor sorosítás) | `acquireClaim('outbound:<ledgerId>')` (`:276-281`) | nincs | Két párhuzamos dispatch ugyanarra a ZST sorra (dupla kattintás, újrapróbált HTTP-hívás) nincs sorosítva. A képesség **be van kötve**: `makeExecutor('zst_outbound_ledger', 'zst_case_claims')` claims-táblát is kap — csak nincs hívó, ami átadná. |
| `campaignLimit` | `decision.limits`-ből (`:306-313`) | nincs; az `evaluateZstSendGate` **nem is ad vissza `limits`-et** | A boríték-plafonok nem a `SENDING`-írás tranzakcióján belül számolódnak. A megosztott `approval-core` kiszámolja őket (`:356`), a céges döntés-típus (`ZstDispatchDecision`) viszont nem hordozza. |
| `outboundKind` | a sorból olvasva (`:256-258`) | nincs | Per-kind (`INITIAL`/`FOLLOW_UP`/`REPLY`) plafon a céges úton nem alkalmazható. A `draftZstSend` az `outbound_kind` oszlopot ki sem tölti. |

**Javaslat.** Az `evaluateZstSendGate` adja vissza az `approvalId`-t és a `limits`-et (a `zstApprovals.authorizeSend` már számolja mindkettőt), a `dispatchZstSend` pedig ugyanazt a négy mezőt adja tovább, mint a privát párja. Plusz egy összehasonlító standing check: a két dispatch által az `executeAction`-nek átadott `ExecuteOpts` kulcshalmaza legyen azonos, és bukjon, ha eltérnek.

### R-2 · P1 · A céges dispatch `caseType`-ját senki nem adja át — minden céges küldés fail-closed elbukik

`evaluateZstSendGate` az autonómia-létrát `permits(db, req.caseType ?? 'UNKNOWN', 'SEND')`-del kérdezi (`zst-send.ts:209`). A `DispatchZstSendInput.caseType` kommentje azt mondja, *„read from the store by the caller"* — az **egyetlen produkciós hívó** (`src/web/routes/cos.ts:1113-1118`) viszont nem adja át. Így minden céges küldés `getLadder('UNKNOWN')`-t kap, az alapértelmezés `PREPARE`, és a kapu `autonómia-fokozat: UNKNOWN fokozata PREPARE, ehhez legalább EXECUTE_WITH_APPROVAL kellene` indoklással utasít vissza.

A privát oldal ugyanezt a mezőt **a store-ból olvassa a dispatch belsejében** (`send-flow.ts:229-235, 252`), pontosan azzal az indoklással, hogy a hívó által állított típus permisszívebb fokozatot választhatna.

**Miért P1, ha fail-closed irányba téved.** Két okból. Egyrészt a hiba tünete („nem megy ki a céges levél") és az oka („a hívó nem ad `caseType`-ot") nagyon távol van egymástól, tehát a valószínű javítás nyomás alatt egy `UNKNOWN` sor beszúrása a `cos_autonomy_ladder`-be — ami **egyetlen mozdulattal emeli meg az összes céges ügytípust egyszerre**, és pont azt a per-típus granularitást semmisíti meg, amiért a létra készült. Másrészt a `caseType` a kapu bemenete: amíg a hívó adja, addig a rendszer legmagasabb jogosultsági döntése egy caller-assertion marad — az a modell, amit a §22.2 más helyen kifejezetten megtilt.

**Javaslat.** A `dispatchZstSend` olvassa a `case_type`-ot a `zst_outbound_ledger` → `zst_cases` joinból, ugyanúgy, ahogy a `caseTypeOf()` teszi a privát oldalon, és a `DispatchZstSendInput.caseType` mező tűnjön el.

### R-3 · P1 · Az F-1/F-2 idempotencia-javítás nincs átvezetve a céges draftra

`draftZstSend` (`zst-send.ts:71-105`) három dologban a privát draft **javítás előtti** alakja:

1. **`COUNT(*) + 1` a sorszámhoz** (`:84`). A privát oldal ezt `MAX(seq)+1` + ütközés-újrapróba ciklusra cserélte, mert két párhuzamos draft ugyanazt olvasta, és nyers `SqliteError` ment vissza a hívónak (`send-flow.ts:114-134`). Céges oldalon a `COUNT(*)` ráadásul **szigorúbban rossz**: egy törölt vagy `CANCELLED` sor után újra kiosztja ugyanazt a számot.
2. **A `planAction` hívás nem kap `campaignId`-t, `recipient`-et és `renderedPayloadHash`-t** (`:86`). Emiatt a céges idempotencia-kulcs csak a `(case, action_type, seq)` hármast köti — pontosan az az állapot, amit az F-1 a privát oldalon megszüntetett, azzal az indoklással, hogy *„nem azt védte, hogy ugyanaz az üzenet ugyanannak a személynek"*. Két különböző címzettnek tervezett céges küldés ma csak a `seq`-ben tér el, és egy jóváhagyás után szerkesztett szöveg változatlan kulcsot kap.
3. **A `rendered_payload_hash` oszlopba a céges úton soha nem íródik érték**, és a `campaign_id` utólagos `UPDATE`-tel kerül fel (`:97-101`) — az az ablak, amiben a sor létezik és nem attribuálható, amit az F-2 a privát oldalon éppen azért szüntetett meg, mert egy összeomlás abban az ablakban végleg attribuálhatatlanná teszi.

### R-4 · P2 · A több-használatos ticket visszavonhatatlan

Mind a `revokeAuthorizationsForAction` (`action-authorization.ts:208`), mind a vészleállító (`kill-switch.ts:68`) úgy von vissza, hogy beírja a `consumed_at`-ot. A fogyasztás viszont ezt `single_use = 0` esetén figyelmen kívül hagyja — a feltétel `consumed_at IS NULL OR single_use = 0` (`:198`), és az ellenőrző ág is (`:148`). Egy `issueAuthorization(..., { singleUse: false })`-szal kiadott ticket tehát **túléli a vészleállítót és a kampány-visszavonást is**.

Ma latens: a teljes kódbázisban nincs `singleUse: false` hívó (az alapértelmezés `true`), és a küldési út közvetlenül a fogyasztás előtt külön ellenőrzi a kill switchet (`executor-core.ts:340`). De a §22.2 invariáns — *„authority visszavonása vagy érvénytelenedése execution előtt blokkolja a végrehajtást"* — a mai kódban **nem minden ticket-fajtára igaz**, és az opció, ami ezt megnyitja, egy paraméter.

**Javaslat.** Külön `revoked_at` oszlop, amit a fogyasztás `single_use`-tól függetlenül tilt — vagy, ha nincs valódi use-case a több-használatos ticketre, a `singleUse` opció törlése. A második az olcsóbb és őszintébb.

### R-5 · P1 · A §16 replay/eval kapu konstrukció szerint zöld

A spec §16 kimondja: *„Az eval nem utolsó WP, hanem az első load-bearing fejlesztési elem"*, és tíz hard safety assertion-t sorol fel. A `progression-eval.ts` hetet implementál, és ezek közül **három soha nem tud tüzelni**:

| Assertion | Állapot | Bizonyíték |
|---|---|---|
| `wrong_recipient` | **nem tud tüzelni** | a `check` törzse egy komment és `return null` (`:104-110`) |
| `payment_auto_execution` | **nem tud tüzelni** | `run.decision === 'EXECUTE_PAYMENT'`-re tüzel (`:130`), de az `EXECUTE_PAYMENT` **nem eleme** a §13 tíz-elemű `VALID_DECISIONS` vokabuláriumának |
| `legal_contract_auto_commitment` | **nem tud tüzelni** | ugyanez `COMMIT_CONTRACT` / `SIGN_LEGAL`-lal (`:140`) |
| `cross_domain_leakage`, `duplicate_external_action`, `policy_bypass` | csak **injektált** `error_code`-ra tüzel | `:120, :151, :175` |
| `premature_completion` | injektált kódra **vagy** egy szó szerinti `'RED-PROOF: no DoD criteria satisfied'` reason-stringre | `:163` |
| Reader write capability = impossible | **hiányzik** | nincs ilyen assertion |
| Writer external write capability = impossible | **hiányzik** | — |
| raw prompt-injection a Writerhez utasításként = 0 | **hiányzik** | — |

Ehhez jön, hogy a harness a `progressCaseStub`-ot futtatja (`:184`), nem a valódi `progressCase` pipeline-t: *„No resolver, planner, or controller — just creates state + records a run."* A `case_progression_runs.safety_assertions_json`-ba tehát minden futásnál `passed: true` kerül mind a hét tételre — **egy olyan motorról, ami nem is futott**.

**Ez nem a szándék hibája.** A modul őszintén „stub"-nak nevezi magát, és a RED-PROOF injekció valódi technika. A probléma az, hogy a spec ezt a harness-t nevezi meg a GATE 0 kapunak (*„Minden progression-változás replay suite kapun megy át"*), és a mai alakjában **a kapu áthaladása nem bizonyít semmit a progresszióról**.

**Javaslat, prioritás szerint:**
1. A három nem-tüzelhető assertion vagy a valódi döntés-vokabuláriumra hivatkozzon (pl. `decision === 'CONTINUE_AUTONOMOUSLY' && action_ids_json` nem üres, PAYMENT risk_class-ú akcióval), vagy legyen explicit `NOT_IMPLEMENTED` státusza, ami **piros**, nem `passed: true`.
2. A `safety_assertions_json` ne írjon `passed: true`-t olyan assertionre, aminek nincs végrehajtható törzse.
3. A hiányzó három capability-assertion statikus checkként is megírható (a `cos-gate-permit.test.ts` mintája: számold össze a hívási helyeket, buktasd el az újat) — a `reader.ts` és az `owner-question.ts` importlistája ma is bizonyítja a tulajdonságot, csak nincs, ami őrizze.
4. A korpusz: a spec 25 PRI + 25 ZST történelmi Case-t kér. A `runEvalHarness` a hívótól kapja a korpuszt; produkciós, rögzített 50-elemű fixture-készlet nincs a repóban.

**Ellenpont, amit ki kell mondani:** a §17 prompt-injection fixture (`cos-reader-injection.test.ts`) **valódi** — mind a hét elfogadási kritériumra külön teszt van, a provenance-ellenőrzésre is, és a „kontroll"-eset (jól viselkedő modell packetje átmegy) is megvan. A trust-boundary bizonyítása tehát megvan; a progression-safety bizonyítása az, ami nincs.

### R-14 · P3 · A CostOps scope-dokumentum ma félrevezet a Lean Optimization mellett

`docs/costops/core-functional-scope-v1.0.1.md` §2 out-of-scope listája: *„capacity-aware routing; automatikus modellválasztás; automatikus providerválasztás; primary/fallback routing"*, és kifejezetten: *„A CostOps később exportálhat szabványos költség- és budget-jeleket más moduloknak, de most nem építünk ilyen integrációt, és nem kapcsoljuk össze a routinggal."*

A Lean Optimization pontosan ez az integráció, és **létezik**: `src/optimization/optimization-routing.ts` importál a `costops/dispatch-identity`-ből és a `costops/pricing`-ből, az `optimization-summary.ts` további nyolc CostOps-modulból.

**A rétegzés maga helyes** — a függés iránya `optimization → costops`, visszafelé nulla import, tehát a CostOps tényleg tiszta maradt. A dokumentum viszont az egyetlen hely, ahol egy új olvasó megállapítaná, mi a viszony a két modul között, és ma az ellenkezőjét mondja a valóságnak. Egy mondat kell bele: a routing-integráció a Lean Optimizationben él, a CostOps a mérési oldal marad.

---

## 2. CoS — privát és céges

### Ami ma erős

- **§22.2 authorization ticket.** Opaque, 32 random bájt, single-use, atomikus feltételes `UPDATE`-tel fogyasztva, a bekötött kontextus egyetlen `policy_evaluation_hash`-ben (`action-authorization.ts:69-77`). A TOCTOU-újraellenőrzés a spec listáját követi, és a hash által **nem** fedett esetet (ugyanaz az approval, visszavonva) külön kezeli. Ez a réteg spec-konform.
- **`gate-permit.ts`.** A WeakSet-alapú permit őszintén megnevezi, mit tud és mit nem (*„this module does not pretend to make forging impossible"*), és a standing check enumerálja a mintázókat. Ez a helyes megoldás egy egyprocesszusos TS-kódbázisban.
- **Kill switch.** CLI **és** HTTP belépési pont, egy tranzakcióban pauzál és von vissza, auditált. A „mit nem állít le" (recovery readback) indoklása helyes.
- **A válasz-út zárt hurokja** (külön CoS Telegram-csatorna, kimenő sor, bejövő poll, `progression_run_id` a kérdésen, `last_event_id` + `updated_at` az ügyön). A 2026-08-12-i kör mérte be; ma is áll.

### Spec ↔ megvalósítás rések

#### R-6 · P2 · §21 Delegation Envelope: nincs

A spec §4.3 kifejezetten külön auditot kért erre (*„Addig nem címzethető sem MISSING-nek, sem EXISTS-nek"*). A mérés eredménye: **M0 / ABSENT**. Nincs tábla, nincs `allowed_intents`, `forbidden`, `max_financial_commitment`, `requires_readback`, nincs visszavonás. Az `action_authorizations.delegation_envelope_id` oszlop létezik, és **mindig NULL** — nincs író.

Következmény a §22 chokepointra: a `LLM → Action Proposal → Policy → standing delegation OR human approval → Executor` láncból a `standing delegation` ág nem létezik. Ez ma nem sebezhetőség (a hiánya szigorít), viszont azt jelenti, hogy az autonómia-létra `LIMITED_AUTONOMOUS` foka — ami a `permits()` szerint *„küldhető kifejezett jóváhagyás nélkül"* (`autonomy-ladder.ts:155-159`) — **mögötte semmilyen hatókör-korláttal nem rendelkezik**. A boríték az a mechanizmus, ami a „jóváhagyás nélkül küldhet" fokozatot a `factual_reply | clarification | quote_request | routine_followup` intent-halmazra és a `max_financial_commitment: 0`-ra szűkítené. A fokozat elérhető, a szűkítés nincs megépítve.

**Javaslat.** Amíg a boríték nincs meg, a `cos_autonomy_ladder.ceiling` alapértelmezése maradjon `EXECUTE_WITH_APPROVAL` (ma az), és a `LIMITED_AUTONOMOUS` fokra kerüljön be egy explicit refuse a `permits()`-be `delegation_envelope_required` kóddal — hogy a hiány a kapunál mondja meg magát, ne a boríték hiányában tűnjön engedélynek.

#### R-7 · P2 · §19 wait/wake és §20 strukturált eszkaláció részleges

- **Nincs `case_waits` tábla.** A spec megengedi a meglévő scheduler használatát, és a `case_progression_state` hordoz `next_progression_at` / `waiting_on` / `blocked_reason` mezőket. Amit nem hordoz: `wait_type`, `timeout_at`, `followup_count`, `max_followups`, `followup_policy_json`, `escalation_policy_json`. Vagyis „várunk valamire" rögzíthető, „meddig várunk és utána mi történik" nem.
- **A hét eszkalációs típusból egy felület van.** `INFORMATION | DECISION | APPROVAL | CALL | MANUAL_ACTION | SECURITY | RECOVERY` helyett a `cos_owner_questions` egyetlen kérdés-alakja létezik. A `CALL_REQUIRED`, `MANUAL_ACTION_REQUIRED` és `RECOVERY_REQUIRED` döntések a `VALID_DECISIONS`-ben szerepelnek, de nincs hozzájuk tartozó eszkalációs rekord-típus, tehát a „Needs István" nézet nem tudja megkülönböztetni „telefonálni kell"-t a „döntés kell"-től.

#### R-8 · P2 · A Decision Package hét kérdéséből kettő jelenik meg

A spec §20 pontosan felsorolja, mit tartalmaz a Decision Package: *Mi az ügy? Mit intézett Marveen? Miért állt meg? Mik az opciók? Mit javasol? Mi kell Istvántól? Meddig?*

A `buildOwnerQuestion` (`owner-question.ts:52-115`) ebből a címet („Mi az ügy?"), az „Amit tudunk" blokkot (a packet első három ténye), az „Ami Tőled kell" blokkot, és opcionálisan egy bizonytalanság-sort rendereli. **Hiányzik: mit intézett Marveen, miért állt meg, milyen opciók vannak, mit javasol a rendszer, és mi a határidő.**

Ez nem kozmetika. A modul saját kommentje rögzíti, hogy élesben *„a második-negyedik kérdésből kettő"* értelmezhetetlenné degenerálódott, és a javítás a „mi van blokkolva" felsorolása lett. Opciók és javaslat nélkül a kérdés nem döntésre kész: Istvánnak a Mission Controlba kell mennie, hogy eldöntse, amit a csatornán kérdeztek tőle — pontosan azt a lépést, amit a §10.4 Writer meg akart spórolni.

**Javaslat.** A „Mit intézett Marveen?" és a „Miért állt meg?" a `case_progression_runs` utolsó néhány sorából determinisztikusan előállítható (döntés + reason). A „Meddig?" a `next_progression_at`-ból. Az „opciók" és a „javaslat" az, ami valóban a Writer dolga lenne — és ez az a pont, ahol a modul indoklása („a döntés már megszületett, egy modell csak elsodorhatná") **nem áll**: az opciók listája nincs sehol előállítva, tehát nem sodródik el, hanem hiányzik.

#### R-9 · P2 · A Reader Evidence Packetből három spec-mező hiányzik

A spec §10.2 `ReaderEvidencePacket` interfésze tizenhárom mezőt sorol fel. A `reader.ts:37-48` tízet implementál. Hiányzik:

| Mező | Miért számít |
|---|---|
| `requests: ExternalRequest[]` | mit kér a külső fél — ma a `facts` tömbben olvad el |
| `knownConstraints: ConstraintFact[]` | határidők, összeghatárok — ma szintén `facts` |
| `resolvableWithoutUser: ResolutionCandidate[]` | **ez a §11 „resolve-before-ask" hordozója** |

A harmadik a lényeges. A §11 sorrendje (`Case → events → thread → Drive → Calendar → Contacts → memory → MCP → web → safe inference → István`) azt kívánja, hogy az `ASK_INFORMATION` csak akkor szülessen meg, ha az információ *„nem szerezhető meg engedélyezett forrásból"*. Ma a Reader nem tudja megnevezni, mit lehetne felhasználó nélkül feloldani — csak azt, hogy mi hiányzik (`missingRequirements`) és ki tartja (`whoHasIt`). A „megpróbáltuk-e beszerezni" kérdésre tehát nincs adat a packetben, és a spec által kötelezővé tett interruption-audit (`sources_attempted / facts_found / remaining_gap / why_blocking`) négy mezőjéből kettő nem származtatható.

#### R-12 · P3 · `cosTick` fejléc-komment ellentmond a valóságnak; a FAILED_RETRYABLE-nek nincs produkciós hajtója

`tick.ts:6` szerint a ciklus *„PLANNED/FAILED_RETRYABLE→send"*. A `reconcileOutbound` **mindkettőt kizárja** (`scheduler.ts:89`) — helyesen, az F-7/N-3 indoklás szerint: egy első kézbesítés nem születhet olyan háttérciklusban, ami nem futtat kaput.

Két következmény:

1. **A komment az `executor-core.ts:321` által megnevezett hibaosztály** (*„kilenc komment hazudott a bekötésről"*, `0020533`) friss példánya, ugyanabban a modulcsaládban.
2. **Az F-15 retry-plafon és exponenciális backoff produkcióban gyakorlatilag elérhetetlen.** Egy `FAILED_RETRYABLE` sort csak egy új `dispatchApprovedSend`/`dispatchZstSend` hívás mozdít, azaz kézi újraküldés a UI-ból. És ott a backoff **némán no-op-ot csinál**: `if (now < waitUntil) return a` (`executor-core.ts:315`) — státuszváltozás nélkül, `last_error` nélkül, tehát a felhasználó számára a gomb „nem csinál semmit".

---

## 3. Autonomous Case Progression (v1.3.1)

A spec §4 capability-maturity dimenziói szerint mérve:

| Capability | Existence | Wiring | Coverage | Semantic quality | Safety proof |
|---|---|---|---|---|---|
| Case Store (PRI/ZST) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Progression Kernel | ✅ | ✅ | shadow | — | részleges |
| Run Ledger (§15) | ✅ **teljes mezőkészlet** | ✅ | ✅ | ✅ | ✅ |
| Context Builder (§10.1) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reader (§10.2-10.3) | ✅ | ✅ | ✅ | ✅ | ✅ (§17) |
| Reader–Policy arbitráció (§13.1) | ✅ | projekcióban | — | ✅ | ✅ |
| Writer (§10.4) | részleges (csak a kérdés) | ✅ | 1/5 output-típus | `R-8` | — |
| Outcome Contract (§9) | ✅ | ✅ | ✅ | **`GENERIC_STATUS_TEMPLATE`** | — |
| Wait/Wake (§19) | részleges | ✅ | — | — | — |
| Escalation (§20) | részleges (`R-7`) | ✅ | 1/7 típus | `R-8` | — |
| Delegation Envelope (§21) | **M0** (`R-6`) | — | — | — | — |
| Controlled Action Executor (§22) | ✅ | ✅ | privát ✅ / céges `R-1` | ✅ | ✅ privát |
| Semantic Completion (§25) | ✅ | ✅ | ✅ | DoD-provenance-szal | ✅ |
| Eval/Replay (§16) | ✅ *stub* | ✅ | ✅ | **`R-5`** | **`R-5`** |

**A §4.2 szemantikai rés a kódban meg van nevezve, és nyitva van.** A `deriveOutcomeContract` (`progression-pipeline.ts:82`) fejléc-kommentje szó szerint kimondja: *„Everything this function returns is GENERIC_STATUS_TEMPLATE… Those describe the engine's own handling, not the outcome Istvan cares about — the water bill is not paid because the case was triaged."* A cél per ügy-TÍPUS, a DoD per ügy-STÁTUSZ, tehát minden azonos státuszú ügy azonos három kritériumot kap. Ez pontosan a spec §4.2 által mért `101 Case / 11 különböző érték` jelenség forrása, és a §4.2 kötelező mérőszámai (`distinct_value_ratio`, `template_reuse_rate`, `case_specificity_score`, `next_action_executability`, `plan_step_evidence_linkage`, `replan_on_new_evidence_rate`) **egyike sincs implementálva** — se számítás, se tárolás, se felület.

Az őszinteséget érdemes külön elismerni: a `DoDProvenance` mező végigmegy a `dod_verification_json`-ig, tehát a completion-kapu **tudja**, hogy sablont lát-e vagy az ügy saját szerződését. A rés meg van jelölve, csak nincs betöltve.

**A §29 default gate-ek helyesek:** `progression_enabled` alapértelmezése 0, `progression_mode` `'off'` a sémában, a pipeline invariánsa `shadow`. Egy szoftverfrissítés önmagában semmilyen külső viselkedést nem kapcsol be.

---

## 4. CostOps, Lean Optimization, APG

### CostOps

A C-1..C-7 mind a hét **változatlan** a kilencedik kör óta; visszamértem: `grep -rn "checkPeriodWritable" src/costops/collectors/` → **0 találat** (C-1, §23 AC-9: a lezárt hónapot a manuális utak védik, az automatikus collectorok nem).

#### R-11 · P2 · A CostOps budget-CRUD tesztjei csak a teljes szvitben pirosak — a zöld/piros jelzés megbízhatatlan

```
teljes szvit:  src/__tests__/costops-api.test.ts (31 tests | 3 failed)
csak a fájl:   src/__tests__/costops-api.test.ts (31 tests)  ✓ 31 passed
```

A három bukó teszt (`POST /api/costs/budgets`, `PATCH`, `GET .../history`) izoláltan és fájl-szinten is zöld, a teljes futásban piros — tehát **cross-file állapotszennyezés** (megosztott on-disk konfig vagy DB, amit egy párhuzamosan futó másik fájl ír). A `POST` `ok:false`-ot ad vissza, a `PATCH` `undefined` budgetet, a history üres.

Ehhez jön, hogy a legutóbbi commit (`66cc28f`) üzenete azt állítja: *„Suite: 5881 zöld, a bukás ugyanaz a három ismert fájl."* A mai mérés **5 piros fájl / 7 piros teszt**. A `costops-api` nem szerepel a kilencedik kör négy piros fájlja között sem, tehát **új piros**.

**Miért P2.** A három „ismert" piros (`channels-never-started-backoff`, `optimization-master-and-emergency`, `installer-start-and-fallback`) uid-függő — root alatt a `chmod 0500` nem akadály, ezt a kilencedik kör K-1-ként már megnevezte, és a javítási minta is ott van a repóban (`process.getuid?.() === 0` őr). Amíg viszont a piros halmaz „ismertként" van elkönyvelve, **egy valódi új piros beleolvad** — most pontosan ez történt.

### Lean Optimization

Az `Ó-2` javítás (`66cc28f`) **jó munka**: a propagáció a `return { ok: true }` elé került, saját `try`-jal, az eredménye külön mezőben utazik (`routingFlagPropagated: true | false | null`), a hibája `warning`-ban és nem `error`-ban, a végpont pedig `ok:true + partial:true + stillRunning:"capacity-routing"`-ot ad. A propagáció injektálhatóvá tétele éppen azért helyes, mert egy vészleállítónál a hiba-ág az egyetlen, ami számít.

Két megjegyzés:

- A régi `O-7` teszt (`optimization-master-and-emergency.test.ts:69`) ma piros. **Ez nem az `Ó-2` javítás regressziója**: a teszt `chmodSync(dir, 0o500)`-zal próbál írhatatlan könyvtárat előállítani, és root alatt ez nem működik. Az `Ó-4`/K-1 osztályba tartozik.
- **`R-13 · P3`:** a `previewRuntimeRouting` (`optimization-routing.ts:158-165`) bedrótozott `packageOpen: false`, `fallbacksUsedThisPackage: 0`, `errorClass: null` értékekkel kérdezi a resolvert. A preview tehát **nem hű a produkciós bemenetekhez**: a `ceiling_reached` kimenetet sosem tudja megmutatni, és a `would_change` eltérhet attól, amit a runner ténylegesen tenne. Egy előnézet, ami más választ ad, mint a valóság, rosszabb, mint ha nem lenne.

### APG

A kernel `wp1-slice1-executor-registry` ágán a `6a3771e` **Gate Executor Registry** jó munka: bevezeti a registryt és a §7.3 kontraktust, a meglévő determinisztikus kiértékelőt **változatlanul** regisztrálja alá, és a fejléc kimondja, mit halaszt (*„Splitting the chain into per-gate executors is the next slice and is deliberately NOT bundled here"*). A `failure_semantics` szándékos default-nélkülisége helyes. Az `unregistered_gates()` az a kérdés, amit a `checkpoints._base_value()` if-lánca nem tudott megválaszolni — ez a szelet valódi értéket ad.

#### R-10 · P2 · A kétrepós szerződés-teszt némán kimarad, ha a kernel nincs a bedrótozott helyen

`src/__tests__/apg-projection-contract.test.ts:32`:

```ts
const kernel = join(homedir(), 'marveen-local', 'apg-kernel', 'src', 'checkpoints.py')
if (!existsSync(kernel)) return // kernel not checked out here — nothing to compare against
```

Ebben a környezetben a kernel a `/home/user/marveen-apg-kernel`-ben van, a keresett út nem létezik — **a headline assertion nem futott le, a teszt mégis zöld**. Ugyanez igaz minden CI-ra és minden fejlesztői gépre, ahol a kernel nem pont ezen az úton áll.

Ez az F-8 javítás egyetlen őre. A fájl saját fejléce négy módot sorol fel, *„ahogy egy projekció csendben hazudott"* — és a javítás őre maga is csendben kimarad. (Külön mérve: a projekció és a kernel vokabuláriuma **ma egyezik** — mindkettő `PASS, FAIL, UNKNOWN, ERROR, EXCLUDED` —, tehát a szerződés nem sérült; csak nincs, ami őrizze.)

**Javaslat.** `APG_KERNEL_SRC_PATH` env-változó a `resolveApgKernelDbPath()` mintájára, és ha a kernel tényleg nincs meg, `it.skip` — ami **látszik** a futás kimenetén — a néma `return` helyett. Ez összeér az A-1 javaslattal: a szerződés hordozója ma egy Python-lista és egy TS-teszt, és a teszt fele nem fut.

---

## 5. Repók és merge-helyzet

| Repó | Default branch | A review-ág állapota | Van mit main felé mergelni? |
|---|---|---|---|
| `marveen-private` | **`develop`** — **nincs `main` branch** | `claude/marveen-code-review-rizx4k` **azonos** az `origin/develop`-pal (0 ahead / 0 behind) | **Nincs.** Mind az öt fejlesztés már a mainline-on (`develop`) van. |
| `marveen-apg-kernel` | **`wp1-slice1-executor-registry`** — **nincs `main` és nincs `develop`** | azonos a default branch-csel | **Nincs mibe** — lásd lent. |
| `marveen-suite` | `main` | azonos az `origin/main`-nel | Nincs; a vizsgált öt fejlesztésből **egy sincs** ebben a repóban. |

Három dolog viszont rendezésre vár:

### 5.1 Az APG kernelnek nincs stabil mainline-ja

A `marveen-apg-kernel` default branch-e maga egy work-package feature-ág (`wp1-slice1-executor-registry`), és a repóban négy branch van, egyikük sem `main`/`develop`. Ez azt jelenti, hogy a „mi a kernel kész, kiadható állapota" kérdésre **nincs branch, ami válaszolna** — miközben a `marveen-private` produkciós UI-ja ennek a kernelnek az SQLite-fájlját olvassa.

**Javaslat.** `main` létrehozása a jelenlegi tipről (`1ae89c8`), default branch átállítása, és a WP-ágak innentől `main`-be mergelnek. Ez tíz perc, és ez az egyetlen tétel ebben a fejezetben, aminek nincs mérlegelendő oldala.

### 5.2 Nyolc nyitott branch, nulla nyitott PR — köztük eldöntetlen érdemi munka

`marveen-private`, mind `develop` fölött (ahead / behind):

| Branch | ahead | behind | Tartalom |
|---|---|---|---|
| `claude/marveen-cos-code-review-qe1z7m` | 1333 (nem-merge) | 0 | **a 2026-08-12-i konszolidált review + a progression v1.3.1 szakaszonkénti állapot** — 2 doksi, plusz a teljes régi történet (lásd 5.3) |
| `claude/costops-agp-lean-review-mksxlj` | 13 | 0 | pont ennek a review-nak a scope-ja |
| `claude/progression-v131-fixes-qe1z7m` | 8 | 0 | progression v1.3.1 javítások |
| `claude/cos-autonom-code-review-qv04y2` | 4 | 0 | |
| `claude/apg-review-fixes-qe1z7m` | 2 | 0 | |
| `claude/cos-review-fixes-qe1z7m` | 2 | 0 | |
| `claude/costops-review-fixes-qe1z7m` | 1 | 0 | |
| `cos-review-fixes-2026-08-10` | 1436 | 50 | elavult fork |

**Egyik sem behind (a legutolsó kivételével), tehát mind mergelhető konfliktus nélkül** — a kérdés nem technikai, hanem az, hogy melyik tartalom kell. A két legfontosabb:

- A **kilencedik kör két audit-doksija** (`audits/teljes-code-review-cos-costops-opt-apg-2026-08-12.md` és a progression-állapot) ma csak egy feature-ágon létezik. Ez a rendszer legjobb dokumentációja arról, hogy mi van kész — és nincs a mainline-on. **Ezt mergelném elsőként**, önmagában (a két doksi 539 sor, kód nincs benne).
- `claude/progression-v131-fixes-qe1z7m` (8 commit): érdemi javítások a most vizsgált specifikációhoz. Átnézendő és mergelendő vagy lezárandó — nyolc commit eldöntetlenül állni hagyása pontosan az az állapot, amiből három hét múlva senki nem tudja, mi ment ki.

A `cos-review-fixes-2026-08-10` (1436 ahead / **50 behind**) az egyetlen, ami valóban elavult; ez lezárható.

### 5.3 Történet-divergencia a `develop` és a review-ágak között

`git merge-base origin/develop claude/marveen-cos-code-review-qe1z7m` = **`2d3c662` = maga a `develop` HEAD**, a review-ág mégis 1333 nem-merge committal „előrébb", és a legrégebbi commitjai a repó `Initial release`-ig érnek vissza. Vagyis a `develop` egy **megvágott vagy újraírt lineage**, a másik ág pedig az eredeti teljes történetet is hordozza (egy merge-commiton keresztül).

Ez nem sürgős, de két konkrét következménye van: a `git log`/`git blame` alapú auditok a `develop`-on nem látnak a vágás mögé, és a „hány commit van előrébb" mérőszám ezeken az ágakon **értelmetlen** (ahogy a fenti táblázat 1333-as száma is: a valódi egyedi tartalom 2 doksi-commit). Érdemes egy mondatban rögzíteni a `CONTRIBUTING.md`-ben, hogy a `develop` a rövidített lineage, és a régi történet hol található.

---

## 6. Javasolt sorrend

1. **`R-2`** — a `dispatchZstSend` olvassa a `case_type`-ot a store-ból. Egy join, és ez oldja fel, hogy a céges küldési út ma egyáltalán nem működik.
2. **`R-1` + `R-3`** — a céges dispatch/draft négy hiányzó rétege és az idempotencia-kulcs. Egy összehasonlító standing check a két úton átadott `ExecuteOpts`-ra, hogy ne csússzon szét újra.
3. **`R-5`** — a nem-tüzelhető safety assertionök ne írjanak `passed: true`-t. Ez a legolcsóbb lépés, ami a GATE 0 kaput újra jelentéssel tölti fel: egy `NOT_IMPLEMENTED` státusz pirosan látszik, a mai `passed: true` nem.
4. **`R-11`** — a `costops-api` tesztszennyezés kiderítése, és az uid-függő pirosak lezárása a repóban már meglévő mintával. Amíg „három ismert piros" van, a negyedik nem látszik.
5. **`R-10`** — a kétrepós szerződés-teszt env-alapú útja és `it.skip`.
6. **`R-6`** — amíg a Delegation Envelope nincs meg, a `LIMITED_AUTONOMOUS` fok utasítson vissza `delegation_envelope_required`-del.
7. **`R-8` + `R-9`** — a Decision Package öt hiányzó eleme és a Reader `resolvableWithoutUser` mezője. Ez a kettő együtt zárja a „kérdezés előtt oldd meg, és kérdezz döntésre késszé tett kérdést" hurkot.
8. **Repók:** `main` az APG kernelnek; a két audit-doksi mergelése a `develop`-ra; a nyolc branch triázsa.
9. **`R-4`, `R-12`, `R-13`, `R-14`** — kisebbek, de mind egysoros vagy egybekezdéses.

---

## Függelék — a kilencedik kör nyitott tételei, visszamérve

| # | Terület | Állapot ma |
|---|---|---|
| T-1 | ZST vokabulárium a Reader kapujában HIGHLY_SENSITIVE-re lapul | **NYITVA** — `reader-cycle.ts:47` `contextSensitivity` továbbra sem kap domaint, és a personal `effectiveSensitivity`-t hívja |
| T-2, T-3 | a visszakérdezés-ág eldobja a szavakat; a `cos_channel_held`-nek nincs olvasója | nem mértem újra ebben a körben |
| C-1 | a collectorok nem ellenőrzik a lezárt hónapot | **NYITVA** — `checkPeriodWritable` a `src/costops/collectors/`-ban: 0 találat |
| C-2..C-7 | | nem mértem újra; a kilencedik kör mind a hetet változatlannak találta |
| Ó-1, Ó-3, Ó-4 | push-not-pull; blokkoló-szövegek; uid-függő teszt | **NYITVA** (Ó-4 ma is piros) |
| O-3..O-10 | optimization dashboard §21 | **NYITVA** — a spec §27 szerint továbbra is `NO-GO` |
| F-1, F-2, F-4, F-7, F-11..F-16 | APG 0.4 UI | nem mértem újra |
| K-1, K-2, K-3 | APG kernel | **NYITVA** — a `/home/iszzu/...` bedrótozott utak a kernelben változatlanok |
