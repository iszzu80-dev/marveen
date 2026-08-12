# Autonomous Case Progression v1.3.1 — szakaszonkénti állapot, kódból visszamérve

**Spec:** `docs/marveen-autonomous-case-progression-spec-v1.3.1.md` (1476 sor, 33 szakasz)
**Alap:** `develop` @ `2d3c662` + a `claude/cos-review-fixes-qe1z7m` ág
**Előzmény:** COS review #1–#6 és a `teljes-code-review-cos-costops-opt-apg-2026-08-12.md` — ezek **hivatkozták** a specet szakaszonként, de egészben **soha nem mérték fel**. Ez a dokumentum pótolja azt.

---

## 0. Rövid válasz

**Nincs kész.** A spec **saját** checkpointjai (§31) szerint a rendszer a **D és E között** áll, és az **F (Canary readiness) nemcsak hogy nincs meg — a hozzá tartozó biztonsági háló (§16) ma nagyrészt nem tud megszólalni.**

A spec §4-e külön kiköti, hogy `EXISTS / PARTIAL / MISSING` címkék önmagukban összemossák az eltérő problémákat, és öt dimenziót kér: **Existence · Wiring · Coverage · Semantic quality · Safety proof**. Ez a felmérés azt a szerkezetet követi, mert épp az derül ki belőle, hogy az *Existence* szinte mindenütt megvan, és a hiány a *Safety proof* oszlopban koncentrálódik.

**A három legfontosabb megállapítás:**

1. **§16 — a replay gate egy STUB-ot mér, nem a valódi pipeline-t.** A hét hard safety assertion közül **öt konstrukcióból soha nem tud elsülni**. A Checkpoint C („safety suite zöld") ezért nem bizonyíték.
2. **§8 — a tizenhét előírt event type közül tizenhat nem létezik.** A progression semmilyen eseményt nem ír a case event ledgerbe, tehát a §15 run ledger az egyetlen nyom — az audit „mit csinált a motor" kérdésre igen, a „mi történt az üggyel" kérdésre nem válaszol.
3. **§13.1 — az arbitráció kimenete nem hat a döntésre.** Ez ismert (Ö-1 második fele), tudatosan tulajdonosi döntésre vár — de amíg így van, a §16 hiánya nem is pótolható méréssel.

---

## 1. Szakaszonkénti mátrix

Jelölés: ✅ kész · 🟡 részben · ❌ hiányzik · ⬜ nem kód (folyamat/döntés)

| § | Követelmény | Existence | Wiring | Safety proof | Összegzés |
|---|---|:--:|:--:|:--:|---|
| 2 | Nincs új Case Store / párhuzamos engine | ✅ | ✅ | ✅ | **KÉSZ.** `case_progression_state` a meglévő store mellé, nem helyette |
| 3 | Baseline rögzítés implementáció előtt | ⬜ | — | — | folyamati; a `audits/` sorozat ezt teljesíti |
| 4 | Capability maturity 5 dimenzióban | ⬜ | — | — | ez a dokumentum maga |
| 4.2 | Semantic-quality mérőszámok (`distinct_value_ratio`, `template_reuse_rate`, `case_specificity_score`, …) | ❌ | ❌ | ❌ | **HIÁNYZIK** — egyik metrika sincs implementálva. A goal-enrichment javította az okot, de a mérés nincs meg |
| 4.4 | Terminális Case-ek invariánsa | ✅ | ✅ | ✅ | **KÉSZ** — `casesNeedingGoal` és a Writer-lekérdezés is kizárja a terminális ügyeket |
| 5 | Egy build, staged authority (GATE 0–5) | ✅ | 🟡 | 🟡 | a gate-ek megvannak; a GATE 3→4 átmenet bizonyítéka nincs |
| 6 | Thin vertical slice | ✅ | ✅ | ✅ | **KÉSZ** |
| 7 | Case Store kiterjesztés (Option A vagy B) | ✅ | ✅ | ✅ | **KÉSZ** — Option B, a kisebb blast radius; teszt őrzi, hogy nem szivárgott oszlop a `personal_cases`-be |
| **8** | **17 új event type a meglévő ledgerbe** | ❌ | ❌ | ❌ | **HIÁNYZIK — lásd 2.1** |
| 9 | Outcome Contract + lazy enrichment | ✅ | ✅ | 🟡 | **KÉSZ** — a lazy enrichment él (`goal-enrichment.ts`), a §4.2 minőségi mérés viszont nem |
| 10.1 | Context Builder determinisztikus | ✅ | ✅ | ✅ | **KÉSZ** — provenance, trust, sensitivity, cross-domain kizárás; integritás-ellenőrzés a modell előtt |
| 10.2 | Reader read-only, schema-validált packet | ✅ | ✅ | ✅ | **KÉSZ** — a modul nem importál writert, send flow-t, executort |
| 10.3 | Schema ≠ security boundary | ✅ | ✅ | ✅ | **KÉSZ** — provenance + domain + trust + policy validáció a séma után |
| **10.4** | **Writer / Composer** | ✅ | ✅ | 🟡 | **RÉSZBEN — lásd 2.4.** Determinisztikus, nem LLM; a Decision Package (§20) formátuma nincs meg |
| 10.5 | Personal-data handling (4 feltétel) | 🟡 | 🟡 | 🟡 | a sensitivity/provider tengely megvan (`egressTierFor`); a `recipient_allowed` / `purpose_allowed` páros a küldési úton él, a Writer-oldalon nem |
| 10.6 | Draft és send különválasztva | ✅ | ✅ | ✅ | **KÉSZ** |
| 10.7 | Központi model routing | ✅ | ✅ | ✅ | **KÉSZ** — `provider-data-policy.ts` + `model-routing.ts`; promptonkénti modellválasztás nincs |
| 10.8 | Trigger contract + dedup | ✅ | ✅ | ✅ | **KÉSZ** — `effectiveStateHash`, kanonikus trigger-nevek, a névtelen trigger hiba |
| 11 | Resolve-before-ask + interruption audit | ✅ | ✅ | ✅ | **KÉSZ** — `progression-resolver.ts` mind a négy audit-mezőt vezeti |
| 12 | Rolling Plan 3–7 lépés, 8 újratervezési trigger | 🟡 | ✅ | ❌ | a terv és az újratervezés megvan; a **3–7 lépéses aktív horizont nincs kikényszerítve** kódban |
| 13 | Progression Kernel | ✅ | ✅ | ✅ | **KÉSZ** — claim, domain guard, verziók, mód, persist |
| **13.1** | **Reader–Policy arbitráció** | ✅ | 🟡 | ✅ | **RÉSZBEN — lásd 2.3.** Az arbitráció fut és auditálódik; a kimenete nem hat a motorra |
| 14 | 10 progression decision | ✅ | ✅ | ✅ | **KÉSZ** — `VALID_DECISIONS` pontosan a tíz |
| 15 | Run Ledger (21 mező) | ✅ | ✅ | ✅ | **KÉSZ** — mind a 21 mező megvan, plusz `safety_assertions_json` |
| **16** | **Eval / Replay harness** | ✅ | 🟡 | ❌ | **A LEGSÚLYOSABB RÉS — lásd 2.2** |
| 17 | Prompt-injection fixture (7 acceptance) | ✅ | ✅ | ✅ | **KÉSZ** — `cos-reader-injection.test.ts`, a fixture szó szerint |
| 18 | Existing COS regression gate | ✅ | ✅ | ✅ | **KÉSZ** — az Option-B invariáns teszt és a teljes COS szvit |
| **19** | **Wait/Wake — `case_waits` tábla** | 🟡 | ✅ | 🟡 | **RÉSZBEN.** Nincs `case_waits` tábla; a wait a `case_progression_state` mezőin él. A spec megengedi („ha nincs first-class primitive"), de a `followup_policy_json` / `escalation_policy_json` / `max_followups` mezők így nincsenek sehol |
| **20** | **Structured escalation (7 típus + Decision Package)** | 🟡 | 🟡 | ❌ | **RÉSZBEN — lásd 2.5.** A hét escalation-típusnak nincs zárt vokabuláriuma; a Decision Package hét kérdése nincs strukturálva |
| **21** | **Delegation Envelope** | 🟡 | ❌ | ❌ | **RÉSZBEN.** A `delegation_envelope_id` mező végig utazik a jogosítás-úton és a policy-hash-be is beleszámít — **de egyetlen hívó sem ad neki értéket, és nincs envelope-tábla vagy -policy.** A spec §4.3 külön kikötötte, hogy ezt külön auditálni kell; ez az audit: a csővezeték létezik, a fogalom nem |
| 22 | Controlled Action Executor + chokepoint | ✅ | ✅ | ✅ | **KÉSZ** — egy executor, `outbound_ledger`, readback |
| 22.1 | A feature flag nem security boundary | ✅ | ✅ | ✅ | **KÉSZ** — `authorizedByDispatchGate` boolean megszűnt |
| 22.2 | Nem hamisítható Action Authorization Ticket | ✅ | ✅ | ✅ | **KÉSZ** — WeakSet-permit + két standing check; a modul őszinte arról, mit nem tud |
| 23 | Approval integration (12 mező) | 🟡 | ✅ | 🟡 | 10/12 megvan; `delegation_envelope_id` író nélkül (§21), `approval_source` hiányzik |
| 24 | Hard gates (PRI 7 + ZST 6 tétel) | 🟡 | ✅ | 🟡 | a `PAYMENT` és a `SHARE_BEYOND_APPROVED` **név szerint** tiltva; a többi tizenegy tétel (befektetés, hitel, szerződés, egészségügyi döntés, kötelező ajánlat-elfogadás, adóhatósági kötelezettségvállalás…) **nincs nevesítve kódban** |
| 25 | Semantic Completion (5 feltétel) | ✅ | ✅ | ✅ | **KÉSZ** — `guardCaseCompletion` a close útvonal elé kötve; a `GENERIC_STATUS_TEMPLATE` provenance kifejezetten blokkol |
| 26 | Existing intake preservation | ✅ | ✅ | ✅ | **KÉSZ** |
| **27** | **Mission Control (9 elem + Needs István nézet)** | 🟡 | 🟡 | — | az OUTCOME, NEXT BEST ACTION és a Reader-projekció megvan; a **DEFINITION OF DONE, NEXT WAKE, TŐLEM KELL?, AUTONOMOUS PLAN, PROGRESSION HISTORY, DELEGATION** és a **közös Needs István nézet** nincs |
| 28 | Brownfield migrációs szabályok | ✅ | ✅ | ✅ | **KÉSZ** — additive-only, Option B, nincs destruktív rewrite |
| **29** | **Default feature gates upgrade után** | 🟡 | 🟡 | — | **lásd 2.6** — az intake `progression_enabled = 1, mode = 'internal'`-lel hoz létre új ügyet |
| 30 | Egy implementation package | ⬜ | — | — | folyamati |
| 31 | Checkpoint A–F | — | — | — | **lásd 3.** |
| 32 | ZST részesedés-átruházás fixture | ✅ | ✅ | ✅ | ez a valódi ügy hajtotta a #5–#6 kört |

---

## 2. A hat érdemi rés, részletesen

### 2.1 §8 — a progression nem ír a case event ledgerbe

**Amit mértem.** A spec tizenhét új event type-ot ír elő. Mindegyikre kerestem produkciós írót:

```
GOAL_DEFINED · GOAL_CHANGED · OUTCOME_CONTRACT_UPDATED · PROGRESSION_STARTED
PLAN_CREATED · PLAN_REVISED · INFORMATION_RESOLVED · ACTION_PROPOSED
ACTION_VERIFIED · WAIT_STARTED · WAIT_RESUMED · ESCALATION_CREATED
COMPLETION_PROPOSED · CASE_COMPLETED_SEMANTICALLY · RECOVERY_STARTED
RECOVERY_COMPLETED                                       → mind: NINCS
ESCALATION_RESOLVED                                      → van, de TRIGGER-névként,
                                                           nem event type-ként
```

**Miért számít.** A §8 első mondata: *„A meglévő event/history rendszer bővüljön, ne készüljön párhuzamos generic event store."* Ami történt: nem párhuzamos store készült, hanem a progression **egyáltalán nem ír** a meglévőbe. A `case_progression_runs` az egyetlen nyoma.

Ez két külön kérdést mos össze:

| kérdés | hol a válasz ma |
|---|---|
| „mit csinált a motor?" | `case_progression_runs` ✅ |
| „mi történt ezzel az üggyel?" | `personal_case_events` — **a progression semmit nem tett bele** ❌ |

Egy ügy eseménytörténetét olvasva ma nem látszik, hogy célt kapott, hogy tervet készített, hogy vártatott, hogy escalált vagy hogy szemantikailag lezárult. A Mission Control „PROGRESSION HISTORY" eleme (§27) részben ezért hiányzik: nincs miből felépíteni.

**Egy pozitív ellenpélda ugyanebből a körből:** a tulajdonosi válasz (`recordOwnerAnswer`) **ír** case eventet (`OWNER_DECISION` / `OWNER_INFORMATION`), és épp ez tette lehetővé, hogy a §10.8 trigger felébressze az ügyet. Vagyis a minta működik — csak a progression saját eseményeire nincs alkalmazva.

### 2.2 §16 — a replay gate egy stub-ot mér

**Ez a legsúlyosabb találás, mert ez az a kapu, aminek a többit védenie kellene.**

`progression-eval.ts` fejléce, szó szerint:

> „For **Gate 0** the progression cycle is intentionally a **STUB** — no resolver, no planner, no controller."

A `runEval` ma is a `progressCaseStub`-ot futtatja, nem a `runProgressionCycle`-t. A Gate 0 óta a valódi pipeline megépült — a harness nem követte.

**Következmény: a hét hard safety assertion közül öt konstrukcióból nem tud elsülni.** Mindegyiket megnéztem:

| assertion | tud-e bukni | miért |
|---|---|---|
| `wrong_recipient` | ❌ | egyetlen sor: `return null`. A kommentje kimondja: *„the stub progression never generates external actions, so this always passes"* |
| `payment_auto_execution` | ❌ | `decision === 'EXECUTE_PAYMENT'`-et néz, ami **nincs a `VALID_DECISIONS`-ben** — a CHECK constraint el sem fogadná |
| `legal_contract_auto_commitment` | ❌ | ugyanez `COMMIT_CONTRACT` / `SIGN_LEGAL` |
| `duplicate_external_action` | ❌ | `error_code === 'DUPLICATE_ACTION'` — **nulla író** a produkciós kódban |
| `policy_bypass` | ❌ | `error_code === 'POLICY_BYPASS'` — **nulla író** |
| `cross_domain_leakage` | ✅ | négy író, RED-PROOF teszt is van rá |
| `premature_completion` | ✅ | egy író + reason-illesztés, RED-PROOF teszttel |

Tisztességes szétválasztani két esetet:

- A `payment` és a `legal` assertion **előrevédés** olyan döntésértékekre, amiket a motor ma nem tud előállítani. Ez védhető — de akkor **nem számítható bizonyítéknak** arról, hogy a gát átment.
- A `duplicate_external_action` és a `policy_bypass` viszont **valódi rés**: pontosan az a két dolog, ami a Checkpoint E→F átmenetnél számítana, és egyiket sem detektálja senki. A §16 listája ezeket „= 0" követelményként adja meg, és a jelenlegi nulla **nem mérésből, hanem detektor hiányából** származik.

A spec három további assertiont is kér, amikre nincs megfelelő a `HARD_SAFETY_ASSERTIONS`-ben:

```
Reader direct write capability = impossible          → §17 teszteli, de nem a harness
Writer external write capability = impossible        → nincs assertion
raw prompt-injection reaches Writer as instruction = 0 → §17 teszteli, de nem a harness
```

**Amit ez NEM jelent.** A §17 injection-fixture valódi és zöld, a `cos-reader-injection.test.ts` a spec hét acceptance kritériumát méri. A védelem tehát nem hiányzik — a **replay-kapu** nem méri.

### 2.3 §13.1 — az arbitráció kimenete nem hat a döntésre

Ismert (Ö-1 második fele, tudatos). Az arbitráció **fut**, a konfliktus **auditálódik** (`reader_candidate`, `policy_result`, `conflict_reason`, `safe_fallback_decision` mind tárolva), és a Mission Control **most már megmutatja**. Amit a spec elsőbbségi sorrendje leír, az implementálva van — csak a lánc a tárolásnál ér véget: a `runProgressionCycle` továbbra is `buildRollingPlan`-t hív.

Ez helyes sorrend: előbb kell látni, mennyire jók a javaslatok. **De a §16 mostani állapotában nincs is mire alapozni a döntést** — a két nyitott ügy összefügg.

### 2.4 §10.4 + §20 — a Writer megvan, a Decision Package nem

A Writer determinisztikus (nem LLM), és ez a spec szellemével egyező: az ítélet már megtörtént. A kérdés eljut Istvanhoz, és a válasza visszaér.

Amit a §20 kér, és nincs meg — a Decision Package hét kötelező eleme:

```
Mi az ügy? · Mit intézett Marveen? · Miért állt meg? · Mik az opciók?
Mit javasol? · Mi kell Istvántól? · Meddig?
```

A mai kérdés-szöveg ebből hármat ad („Amit tudunk", „Ami Tőled kell", bizonytalanság). Hiányzik: **mit intézett a rendszer eddig**, **milyen opciók vannak**, **mit javasol**, és **meddig kell válaszolni**.

A hét escalation-típusnak (`INFORMATION` / `DECISION` / `APPROVAL` / `CALL` / `MANUAL_ACTION` / `SECURITY` / `RECOVERY`) sincs zárt vokabuláriuma — a progression decision enum részben lefedi, de nem ugyanaz a tengely.

### 2.5 §21 — a Delegation Envelope egy oszlop, nem egy fogalom

A spec §4.3-a külön kikötötte: *„A `Delegation Envelope` állapota külön auditálandó. Addig nem címkézhető sem MISSING-nek, sem EXISTS-nek."* **Ez az audit:**

| amit kerestem | eredmény |
|---|---|
| `delegation_envelope_id` oszlop | ✅ megvan (`action_authorizations`) |
| írási út | ✅ megvan — `action-authorization.ts:115`, sőt a policy-hash-be is beleszámít (`:74`) |
| **hívó, aki értéket ad neki** | ❌ **nulla.** `send-flow.ts` és `zst-send.ts` az `AuthorizationContext`-et e mező nélkül állítja össze, tehát az oszlop a gyakorlatban mindig `NULL` |
| envelope-tábla vagy -konfig | ❌ nincs |
| a §21 YAML-alakú policy (`allowed_intents`, `max_financial_commitment`, `forbidden`, `requires_readback`) | ❌ nincs |

A csővezeték tehát megvan, a fogalom nincs: a mező végig utazik a rendszeren, beleszámít a jogosítás-hash-be, és soha nincs benne semmi.

Amit **helyette** kapunk: az `autonomy-ladder.ts` öt fokozata és a kampány-jóváhagyás. Ez működő korlátozás, és a `PAYMENT` név szerint tiltott rajta — de **nem** az, amit a §21 leír: nincs intent-szintű engedélylista, nincs `existing_thread_only`, nincs pénzügyi plafon.

Az `approval_source` mező szintén hiányzik a §23 tizenkettőből, tehát az sem rekonstruálható, hogy egy jóváhagyás állandó delegálásból vagy egyedi emberi döntésből jött.

### 2.6 §29 — a default gate-ek és amit az intake csinál

A spec:

```
progression.enabled = false
progression.shadow  = true
```

Az `intake.ts:181-186` új ügyet így hoz létre:

```sql
INSERT OR IGNORE INTO case_progression_state
  (domain, case_id, progression_enabled, progression_mode, ...)
VALUES ('personal', ?, 1, 'internal', ...)
```

Vagyis **`enabled = 1`, `mode = 'internal'`**.

**Ez nem feltétlenül szabálysértés**, és fontos pontosan fogalmazni. A §29 tiltása így szól: *„Software upgrade önmagában semmilyen új **external behavior**-t nem kapcsolhat be."* Az `internal` mód definíció szerint nem külső viselkedés, és a rendszer tudatosan túl van a Gate 2-n.

Amit viszont érdemes kimondani: a **séma-default** helyesen `0` / `'off'` (`schema.ts:1623-1624`), tehát egy frissítés önmagában semmit nem kapcsol be — az intake **új ügyre** hoz `internal`-t. A két dolog különbözik, és a §29 a frissítésről szól. **Megfelel, de a spec szövegéből ez nem olvasható ki egyértelműen**, és egy jövőbeli olvasó ellentmondást fog látni. Egy sor a `schema.ts` vagy az `intake.ts` mellett lezárná.

---

## 3. Hol tart a rendszer a spec saját checkpointjai szerint (§31)

| | Checkpoint | Állapot | Mi hiányzik |
|---|---|---|---|
| **A** | Brownfield integrity | ✅ **megvan** | — |
| **B** | Shadow vertical slice | ✅ **megvan** | — |
| **C** | Replay gate — safety suite zöld | ⚠️ **konstrukcióból zöld** | a harness stubot mér; 7-ből 5 assertion nem tud elsülni (2.2) |
| **D** | Full internal autonomy | ✅ **nagyrészt** | wait/wake, completion, escalation működik; a §8 eseménynyom és a §20 Decision Package hiányzik |
| **E** | External-action shadow | ✅ **megépült** | kapu, jegy, executor, ledger, readback mind él |
| **F** | Canary readiness | ❌ **nincs** | §21 envelope, §24 hard gate-lista, és mindenekelőtt a §16 valódi mérése |

**Egy mondatban: a rendszer a D és E között áll, és az F-hez vezető úton a §16 az első kő, nem az utolsó** — a spec is ezt mondja (*„Az eval nem utolsó WP, hanem az első load-bearing fejlesztési elem"*).

---

## 4. Javasolt sorrend

| # | Mit | Miért ez a sorrend |
|---|---|---|
| 1 | **§16 — a harness a valódi `runProgressionCycle`-t futtassa**, és a `duplicate_external_action` + `policy_bypass` kapjon valódi detektort | ez a kapu, ami a többit védi; amíg stubot mér, minden utána jövő „zöld" olcsó |
| 2 | **§8 — a progression írjon case eventet** (legalább `PLAN_CREATED`, `WAIT_STARTED`, `ESCALATION_CREATED`, `CASE_COMPLETED_SEMANTICALLY`) | ebből lesz a §27 PROGRESSION HISTORY, és ez teszi a §16-ot mérhetővé valódi ügyeken |
| 3 | **§4.2 — a semantic-quality metrikák** (`distinct_value_ratio`, `template_reuse_rate`, `case_specificity_score`) | ez adja a **bizonyítékot** a §13.1 döntéshez: megbízható-e a Reader javaslata |
| 4 | **§13.1 második fele** — az arbitráció kimenete hasson a motorra | csak az 1–3 után; ez a tulajdonosi döntés, aminek eddig nem volt mire támaszkodnia |
| 5 | **§20 Decision Package** — a kérdés hét eleme | a legkisebb munka a legnagyobb napi haszonnal: a kérdés ma nem mondja meg, mit intézett a rendszer, milyen opciók vannak és meddig kell válaszolni |
| 6 | **§21 Delegation Envelope** + **§24 hard gate-lista nevesítése** | a Canary (F) előfeltétele; addig nem sürgős, utána viszont blokkoló |
| 7 | §19 wait-mezők, §27 hiányzó MC-elemek, §23 `approval_source`, §29 megjegyzés | minőségi, ráérnek |

---

## 5. Egy megjegyzés a saját korábbi reviewkról

Hat COS-review hivatkozta ezt a specet, és mindegyik **valódi hibákat talált a megépült részekben**. Amit egyik sem tett meg: nem állt meg megkérdezni, hogy **a spec egészéből mennyi van meg**. Így fordulhatott elő, hogy hat körön át finomítottuk a §10.2 Readert és a §10.4 Writert, miközben a §8 eseménynaplóból tizenhét tételből tizenhat hiányzott, a §16 kapu pedig egy 2026 eleji stubot mért.

Ez ugyanaz a hibaosztály, amit a reviewk a rendszernek felróttak — *a mechanizmus megépül, és nem kerül a forgalomba* —, csak a felülvizsgálat szintjén: **a spec megvan, és nem került a review forgalmába egészben.**
