# AGP 1.0 Lean – fejlesztési és célarchitektúra-specifikáció

**Státusz:** High-level target specification  
**Verzió:** 1.0-draft  
**Dátum:** 2026-08-09  
**Előzmény:** AGP/APG 0.4 Lean Pilot Kernel + Phase 0/1 tapasztalatok  
**Célkörnyezet:** Marveen multi-agent fejlesztési rendszer  
**Alapelv:** **FREE SOLUTION SPACE, CONTROLLED AUTHORITY AND PROGRESSION**

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
- reprodukálható receiptet adni.

---

## 7.2. Gate Executor Registry

Minden progressiont vagy acceptance-et befolyásoló szabály mögött legyen executor.

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

Blocking gate executor nélkül:

```text
NON_EXECUTABLE_GATE
```

Enforced-ready státusz nem adható neki.

---

## 7.3. Gate eredmények

Canonical result:

```text
PASS
FAIL
UNKNOWN
ERROR
NOT_REQUIRED
```

### PASS

A check lefutott, és megfelelt.

### FAIL

A check lefutott, és bizonyított hibát talált.

### UNKNOWN

A checknek lenne értelme, de nincs elég evidence megbízható eredményhez.

### ERROR

Az executor technikailag nem tudott lefutni vagy nem adott valid eredményt.

### NOT_REQUIRED

Az applicability policy bizonyította, hogy az adott check ennél a work itemnél nem kötelező.

`NOT_REQUIRED` nem lehet az executor kényelmi fallbackje.

---

## 7.4. Enforced mód szemantikája

| Check | Eredmény | Progression |
|---|---|---|
| required | PASS | mehet |
| required | FAIL | BLOCK |
| required | UNKNOWN | INCOMPLETE / BLOCK |
| required | ERROR | BLOCK |
| advisory | FAIL | warning / policy függő |
| advisory | UNKNOWN | warning |
| not required | NOT_REQUIRED | kihagyható |

Az `UNKNOWN` problémát nem azzal oldjuk meg, hogy átengedjük.

A helyes megoldás:

> **csak az legyen required, ami a risk/profile alapján ténylegesen szükséges.**

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
10. sidecar/projection partial failure.

Acceptance feltétel:

> legalább egy teljes known-bad work itemnek a normál automatikus láncban ténylegesen `RETURN_FOR_FIX` vagy `BLOCKED` állapotba kell jutnia.

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
  executor:
  required_evidence:
  expected_latency:
  expected_cost:
  false_block_risk:
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
```

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

Nem minden gate marad örökké.

Review akkor kötelező, ha például:

- magas false-block rate;
- override rate tartósan >20%;
- jelentős latency;
- jelentős tokenköltség;
- azonos hibát olcsóbb deterministic kontroll megfogja;
- sok `UNKNOWN`, kevés valódi measurement;
- a gate output nem változtat döntést.

Lehetséges döntés:

```text
ENFORCED
→ ADVISORY
→ EXPERIMENTAL
→ REMOVED
```

Hard safety gate-et nulla catch miatt önmagában nem szabad eltávolítani.

---

# 24. Működési módok

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

Az AGP 1.0 akkor nevezhető 1.0-nak, ha:

1. standard low/medium-risk work item end-to-end automatikusan végigvezethető;
2. producer solution freedom megmarad;
3. minden blocking gate executable;
4. minden required checknek van authoritative resultja;
5. required `UNKNOWN` nem tud átszivárogni PASS-ként;
6. legalább egy known-bad end-to-end controlt ténylegesen megállít;
7. producer és accepter identity különválik;
8. delegated output authority nélkül nem evidence;
9. product_id explicit;
10. currentness/supersede működik;
11. verifier fresh session/profile működik;
12. low-risk change nem kap szükségtelen semantic verifiert;
13. risk-based gate profile működik;
14. owner csak indokolt decision pointokon kell;
15. human-required approval valódi human authorityból érkezik;
16. Kanban done és AGP accepted külön kezelődik;
17. dispatch receiptelt;
18. safe delivery receiptelt;
19. runtime verification elérhető;
20. rollback policy létezik;
21. sidecar replay determinisztikus;
22. gate telemetry mérhető;
23. gate charter és retirement működik;
24. off/observe/assisted/enforced működik;
25. updateability nem romlik érdemben;
26. nincs szükség tartós, nagy Marveen core forkra.

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

## WP1 – Executable Verification Foundation

Deliverables:

- executor registry;
- falsification runner;
- canonical results;
- receipts;
- known-good/bad/unknown control;
- gate conformance validator.

Exit:

```text
EXECUTABLE_VERIFICATION_FOUNDATION_ACCEPTED
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

# 34. Minden work package kötelező acceptance mintája

Minden WP-nél:

1. positive fixture;
2. negative fixture;
3. unknown/incomplete fixture;
4. falsification run;
5. independent acceptance;
6. updateability diff;
7. performance/cost measurement;
8. rollback;
9. no-secret check;
10. final receipt.

Egy WP nem fogadható el pusztán producer státuszjelentés alapján.

---

# 35. Rollout

Nem egyszerre kapcsoljuk be minden termékre.

## Stage 1

```text
observe
```

Valós work itemeken mérés.

## Stage 2

```text
assisted
```

Low/medium-risk selected products.

## Stage 3

```text
enforced
```

Csak olyan gate-ekkel, amelyek:

- executorral rendelkeznek;
- negative controlt átmentek;
- false-block rate elfogadható;
- overhead mérhető;
- gate charter valid.

## Stage 4

Szélesebb default.

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

- Gate Executor Registry;
- canonical gate results;
- Falsification Runner minimal interface;
- verification receipt;
- positive/negative/unknown fixtures;
- conformance check: blocking rule → executor;
- cost/latency telemetry;
- independent acceptance.

Sem product-currentness, sem dispatch, sem Kanban writeback ne kerüljön bele WP1-be.

WP1 elfogadása után a saját falsification eszközünkkel ellenőrizzük WP2-t.

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
