# Marveen – Implementation Plan & Way of Working v1.0

**Dátum:** 2026-08-24  
**Cél:** a Marveen következő fejlesztési szakaszának olyan részletes, önállóan végrehajtható specifikációja, amely alapján Marveen repo-szinten auditál, tervez, implementál, tesztel és bizonyít, anélkül hogy Istvánnak közvetítőként oda-vissza kellene járnia ChatGPT és Marveen között.

---

## 0. Executive summary

A következő fejlesztési sorrend:

1. **Phase 0 – Trustworthy Kernel / Hardening**  
   W10–W14 lezárása implementation-ready packetekben.
2. **Phase 1 – Reliable Case Autonomy**  
   Canonical Case, Next Action invariant, Waiting/Wake, Completion + Evidence, Confidence Escalation, Stale/Reopen.
3. **Phase 2 – CoS Intelligence**  
   Commitment Tracker, Decision Object, Attention Engine, Opportunity Detection, Question Consolidation.
4. **Phase 3 – External Research**  
   Egyelőre csak architecture/concept gate; implementáció csak külön go/no-go után.
5. **Phase 4 – Controlled Browser Autonomy**  
   Parkoltatva Phase 0–2 eredményeinek és valós működési tapasztalatainak kiértékeléséig.

A legfontosabb elv:

> **A specifikáció meghatározza a WHAT / WHY / INVARIANTS / SAFETY / ACCEPTANCE CRITERIA részt. Marveen a repo valós állapota alapján maga határozza meg a HOW-t, file-level implementációs tervet, kódot és teszteket.**

István csak akkor kap kérdést, ha valódi döntési konfliktus van. Nem kell közvetítenie ChatGPT és Marveen között.

---

# 1. Way of Working – autonóm együttműködési szerződés

## 1.1 Szerepek

### István

István a **product owner / policy owner / végső döntéshozó**.

Istvánt csak akkor szabad bevonni, ha a döntés:

- scope-ot változtat;
- biztonsági vagy adatkezelési policy-t változtat;
- acceptance criteria-t gyengít vagy érdemben módosít;
- új költség- vagy infrastruktúra-kötelezettséget teremt;
- jogi, pénzügyi vagy biztonsági trade-offot igényel;
- visszafordíthatatlan vagy jelentős architekturális lock-in-t okoz;
- két legitim, üzletileg eltérő megoldás között valódi product döntést igényel.

Istvánt **nem** szabad bevonni:

- fájlnevek;
- modulhatárok;
- belső interface nevek;
- refaktorstratégia;
- teszt framework választás;
- migration technikai megoldás;
- belső retry implementáció;
- logging technikai részletek;
- repository housekeeping;
- dependency vagy library verzió kiválasztás miatt, ha nincs security/licence/költség hatása.

### ChatGPT / specifikációs réteg

A jelen dokumentum a **product + architecture + safety contract**.

A dokumentum célja, hogy Marveen ne igényeljen további magyarázatot a normál végrehajtáshoz.

### Marveen

Marveen a **staff engineer + implementation agent + verification owner**.

Kötelező feladatai minden packetnél:

1. Repo audit.
2. Feltételezések validálása.
3. Gap-mátrix készítése.
4. File-level implementation plan.
5. Implementáció.
6. Automatizált tesztek.
7. Negatív és failure-path tesztek.
8. Migration / rollback proof, ha releváns.
9. Observability proof.
10. Dokumentáció frissítése.
11. Done report.
12. Következő packet automatikus indítása, ha minden gate zöld.

---

## 1.2 Marveen autonóm döntési joga

Marveen **szabadon módosíthatja a HOW-t**, ha:

- a WHAT változatlan;
- az invariánsok változatlanok;
- a safety boundary nem gyengül;
- az acceptance criteria teljesül;
- a megoldás visszafelé kompatibilis vagy kontrollált migrációt tartalmaz;
- nincs új, nem jóváhagyott külső költség vagy szolgáltatásfüggés.

Ha a repo valós állapota miatt a specifikációban szereplő technikai feltételezés hibás, Marveen **nem áll meg automatikusan**. Ehelyett:

1. dokumentálja a különbséget;
2. készít kompatibilis alternatív implementációs tervet;
3. folytatja a munkát, ha a contract teljesül;
4. csak akkor kér döntést, ha a contract maga sérülne.

---

## 1.3 Kötelező auditstátuszok

Minden requirementet a repo audit során pontosan egy kategóriába kell sorolni:

- `VERIFIED_DONE` – már megfelelően létezik és bizonyított.
- `PARTIAL` – részben létezik, de hiányos.
- `MISSING` – nincs implementálva.
- `CONFLICT` – a jelenlegi megoldás ellentmond a contractnak.
- `BLOCKED_EXTERNAL` – valóban külső dependency miatt nem folytatható.

`VERIFIED_DONE` csak teszttel vagy közvetlen repo/runtime evidence-szel adható.

Dokumentáció vagy komment önmagában **nem** bizonyít implementációt.

---

## 1.4 Kérdés- és eszkalációs szabály

Marveen alapértelmezetten **nem kérdez**.

A bizonytalanság kezelésének sorrendje:

1. repo inspection;
2. meglévő tesztek;
3. dokumentáció;
4. git history / korábbi implementációs minták;
5. legkisebb kompatibilis, visszafordítható megoldás;
6. explicit assumption log;
7. csak végül eszkaláció.

### Eszkaláció csak akkor engedélyezett, ha

- policy konfliktus van;
- acceptance criteria csak gyengítéssel teljesíthető;
- két megoldás üzletileg eltérő user behaviort eredményez;
- adatkezelési vagy security boundary nem dönthető el technikailag;
- irreverzibilis migration vagy adatvesztés kockázata van;
- új fizetős infrastruktúra szükséges.

### Eszkaláció formátuma

Egyetlen konszolidált blokk:

```text
DECISION REQUIRED
Context:
Conflict:
Option A:
Option B:
Marveen recommendation:
Impact if no decision:
Safe default if allowed:
```

Egy packeten belül több apró kérdés nem küldhető külön.

---

## 1.5 Packet execution loop

Minden W packet végrehajtása ugyanazt a ciklust követi:

### Step 1 – Verify

- repo state;
- current architecture;
- existing modules;
- current test coverage;
- data model;
- migrations;
- runtime / deployment dependencies.

### Step 2 – Gap matrix

Kötelező táblázat:

| Requirement | Repo evidence | Status | Gap | Planned change |
|---|---|---|---|---|

### Step 3 – File-level plan

Marveen készíti el, nem ez a dokumentum.

Tartalmazza:

- files/modules to change;
- schema changes;
- tests;
- migrations;
- feature flags;
- rollout;
- rollback;
- observability.

### Step 4 – Implement

Preferált elv:

- additív;
- kicsi diff;
- backward compatible;
- feature-flaggel védhető, ha indokolt;
- minimal dependency.

### Step 5 – Verify locally

Minimum:

- lint;
- typecheck;
- unit tests;
- integration tests;
- failure-path tests;
- migration test, ha releváns.

### Step 6 – CI / release proof

Ne használja a CI-t inner-loop hibakeresésre.

Először lokális stabilitás, utána CI.

### Step 7 – Done report

```text
PACKET: Wxx
Status: DONE / PARTIAL / BLOCKED
Implemented:
Existing capability reused:
Tests added:
Negative tests:
Migration:
Rollback:
Security impact:
Evidence/proof:
Known limitations:
Next packet readiness:
```

Ha `DONE` és nincs policy blokk, Marveen automatikusan folytathatja a következő packettel.

---

## 1.6 Dokumentációs fegyelem

Minden packet végén kötelező:

- architecture doc frissítés;
- security/threat model frissítés, ha érintett;
- migration doc;
- runbook;
- ADR csak valódi architekturális döntésnél;
- changelog / release note;
- known limitations.

A dokumentáció a kóddal egy PR-ban frissüljön.

---

# 2. Global engineering invariants

Ezek minden fázisban kötelezőek.

## 2.1 Fail-closed

Bizonytalan vagy hibás authorization / sensitivity / policy állapot esetén:

> **nincs side effect.**

Read-only elemzés megengedhető, ha az adatkezelési policy ezt engedi.

---

## 2.2 Idempotency

Ugyanaz a logikai input/event nem okozhat kétszer ugyanazt a side effectet.

Kötelező:

- stabil idempotency key;
- persisted execution state;
- duplicate detection;
- retry-safe behavior;
- ambiguous outcome kezelés.

---

## 2.3 Transactional ordering

Alapelv:

```text
read -> validate -> plan -> persist intent/state -> side effect -> verify outcome -> finalize state
```

Nem megengedett:

```text
side effect -> majd valahogy naplózzuk
```

---

## 2.4 Evidence before completion

`DONE` vagy `COMPLETED` csak bizonyított outcome alapján.

Intent, request vagy ígéret nem outcome.

---

## 2.5 Reopen

Későbbi ellentétes evidence képes legyen lezárt workflow/case újranyitására.

---

## 2.6 Auditability

Minden automatikus actionhez legyen legalább:

- actor;
- trigger;
- input reference;
- policy decision;
- plan/action;
- side-effect identifier;
- outcome;
- timestamp;
- correlation/run id.

---

## 2.7 Least privilege

Agent, service és user permission csak a szükséges minimum.

---

## 2.8 No silent truncation

Ha a rendszer nem tud teljes inputot feldolgozni:

- explicit incomplete state;
- nincs „success”; 
- nincs csendes adatvesztés.

---

# 3. Phase 0 – Trustworthy Kernel

## Cél

A Phase 0 végén Marveen olyan megbízható execution kernel legyen, amelyre a későbbi autonóm case és browser működés biztonságosan építhető.

### Phase 0 Global Exit Gate

Phase 0 csak akkor `DONE`, ha:

- W10–W14 minden packet DONE;
- minden kritikus negatív teszt zöld;
- staging/canary proof elkészült;
- backup/restore proof elkészült;
- side-effect idempotency bizonyított;
- sensitivity/credential boundary fail-closed;
- run integrity visszaolvasható;
- nincs nyitott P0 security finding.

---

# 4. W10 – Identity, Actor & Data Sensitivity Boundary

## 4.1 Problem statement

A rendszernek minden action előtt tudnia kell:

1. **ki** kezdeményezi;
2. **milyen minőségben**;
3. **milyen adatot** kezel;
4. **milyen tool/service** kapja meg;
5. **engedélyezett-e** az adott adatmozgás és action.

Identity és sensitivity explicit enforcement nélkül az autonómia nem skálázható biztonságosan.

---

## 4.2 Target model

### Actor types

Minimum támogatandó:

- `HUMAN_USER`
- `AGENT`
- `SERVICE`
- `SYSTEM_AUTOMATION`

### Execution identity

Minden tool/action context tartalmazza:

```text
actor_id
actor_type
on_behalf_of
session/run_id
capability_scope
policy_context
```

### Data sensitivity classes

Minimum:

- `PUBLIC`
- `INTERNAL`
- `PERSONAL`
- `CONFIDENTIAL`
- `SECRET`
- `RESTRICTED`

A repo jelenlegi domainje alapján Marveen finomíthatja a neveket, de a viselkedési szintek nem gyengülhetnek.

### Special tags

Ortogonal tagként támogatandó legalább:

- `PII`
- `CREDENTIAL`
- `FINANCIAL`
- `LEGAL`
- `HEALTH`
- `AUTH_TOKEN`

---

## 4.3 Enforcement point

Sensitivity/identity ellenőrzésnek **központi tool/action boundaryn** kell történnie.

Nem elég, ha az egyes tool implementációk „jó esetben” ellenőrzik.

Kötelező sequence:

```text
request
 -> resolve actor
 -> classify/resolve sensitivity
 -> resolve target capability
 -> policy decision
 -> allow / redact / require approval / deny
 -> audit log
 -> execution
```

---

## 4.4 Default policy

### PUBLIC

Normál engedélyezés capability szerint.

### INTERNAL

Csak jóváhagyott belső tool/service.

### PERSONAL / CONFIDENTIAL

Külső service-be csak explicit policy alapján.

### SECRET / CREDENTIAL / AUTH_TOKEN

Default:

> **DENY external propagation**

csak dedikált secret-handling path használható.

---

## 4.5 Redaction

Logba/promptba/tool trace-be nem kerülhet nyersen:

- password;
- API key;
- refresh token;
- private key;
- session cookie;
- OAuth bearer token.

PII redaction legyen policy-függő és determinisztikus.

---

## 4.6 Required tests

### Unit

- minden sensitivity class;
- minden actor type;
- allowed/denied matrix;
- unknown actor;
- unknown sensitivity;
- missing policy context.

### Negative

- secret külső toolba;
- credential logba;
- agent szélesebb scope-pal mint user;
- service account impersonation;
- missing identity;
- malformed classification.

### Integration

Legalább egy valós tool invocation pathon bizonyítani kell, hogy a gate ténylegesen blokkol.

---

## 4.7 Observability

Mérőszámok:

- policy_allow_count;
- policy_deny_count;
- policy_redact_count;
- sensitivity_unknown_count;
- identity_resolution_failure_count.

Security log külön kezelje a denied actionöket.

---

## 4.8 Migration

Ha legacy action record nem tartalmaz actor/sensitivity mezőt:

- ne kelljen minden régi rekordot azonnal backfill-elni;
- új executionnél viszont kötelező legyen;
- legacy replay esetén explicit `LEGACY_UNKNOWN` és korlátozott/fail-closed policy.

---

## 4.9 W10 acceptance criteria

W10 DONE, ha:

- minden tool/action központi policy boundaryn megy át;
- missing identity nem eredményezhet side effectet;
- unknown high-risk sensitivity fail-closed;
- secret/credential leakage negatív teszt bizonyítottan blokkol;
- audit log actor + decision adatot tartalmaz;
- legacy kompatibilitás dokumentált;
- nincs közvetlen bypass path.

---

# 5. W11 – Durable Schema, Versioning & Migration

## 5.1 Problem statement

Autonóm rendszer csak akkor megbízható, ha a tartós state:

- verziózott;
- migrálható;
- visszaolvasható;
- rollbackelhető vagy forward-repairrel javítható;
- részleges migration után nem marad bizonytalan állapotban.

---

## 5.2 Required schema concepts

Minimum minden durable entitynél:

```text
id
schema_version
created_at
updated_at
revision/version
status
source/correlation reference
```

Ha releváns:

```text
migration_state
migration_id
last_verified_at
```

---

## 5.3 Migration invariants

- migration idempotens;
- ugyanaz a migration kétszeri indítása nem korruptál;
- partial migration detektálható;
- migration előtt kompatibilitás-check;
- backup/checkpoint előtte, ha destructive;
- post-migration verification kötelező.

---

## 5.4 Forward/backward compatibility

Preferált:

1. additive schema;
2. dual-read vagy dual-write rövid átmenetileg;
3. migration;
4. old field/path retirement csak proof után.

Big-bang breaking change kerülendő.

---

## 5.5 Schema registry / contracts

Legyen egyértelmű source of truth:

- code-level schema;
- migration registry;
- current version;
- compatibility policy.

---

## 5.6 Required tests

- empty database/state;
- n-1 -> n migration;
- migration retry;
- migration interruption;
- duplicate migration execution;
- malformed legacy row/document;
- newer-than-supported schema;
- rollback/forward-repair path.

---

## 5.6b ACCEPTED_DESIGN_DEVIATION — §5.2 on a relational store

**Accepted by Istvan, 2026-08-25, in review of the W11 packet. Recorded here in
his words, in the canonical spec, so it is a decision and not an implementer's
narrowing.**

> A store-level schema version + row-level version only where independently
> meaningful megoldást elfogadom. Rögzítsd ACCEPTED_DESIGN_DEVIATION-ként a
> canonical MIP-ben; ez teljesíti a §5.2 szándékát relációs store esetén.
>
> A future-schema → read-only döntést és az unversioned legacy-store verified
> adoption megoldást szintén elfogadom.

What this means concretely, and what it does NOT license:

- **Store level.** One authoritative `schema_version` for the whole store, plus
  the migration ledger. This is the level at which "a newer-than-supported schema
  must fail closed" is expressible at all, because that decision happens once, at
  open time, before any row is read.
- **Entity level.** A per-row `schema_version` **only** where a row carries its
  own migration state — records that outlive schema changes and may need per-row
  forward repair.
- **Not licensed:** skipping versioning altogether, or deciding per-table at
  implementation time without recording why. A new durable entity that needs
  per-row migration state and does not get a `schema_version` is a defect, not an
  instance of this deviation.

Measured basis for the deviation (2026-08-25): 128 tables, 2 carrying
`schema_version`. Retrofitting the other 126 would be a single breaking change
across the whole database — the "big-bang breaking migration" §5.4 forbids.

Two further decisions accepted in the same review:

- **future schema → read-only, not a crash.** Refusing to boot is also
  fail-closed and is the wrong trade: it takes the owner's entire case board away
  to protect it from a write nobody was making.
- **unversioned legacy store → verified adoption.** Every store written before
  versioning reads as version 0 — which is every existing installation. Failing
  closed on that would be a gate that takes the system down on first contact with
  reality.

---

## 5.7 W11 acceptance criteria

- minden durable core state verziózott;
- migration runner idempotens;
- partial failure detektálható;
- unsupported future schema fail-closed/read-only;
- migration proof stagingen;
- restore vagy forward-repair dokumentált és tesztelt.

---

# 6. W12 – Ingest Idempotency, Transactions & Recovery

## 6.1 Problem statement

Az autonóm rendszer legveszélyesebb hibái közé tartozik:

- duplicate ingest;
- retry után duplicate side effect;
- timeout utáni bizonytalan outcome;
- félbehagyott transaction;
- cursor előrelépése sikertelen írás után.

---

## 6.2 Canonical ingest identity

Minden inputtípushoz stabil dedupe key.

Példák:

```text
source + message_id
source + event_id + version
source + external_record_id
```

Ha nincs természetes key:

- canonical normalized hash;
- collision strategy dokumentálva.

---

## 6.3 Processing states

Minimum:

- `RECEIVED`
- `CLAIMED`
- `PROCESSING`
- `SIDE_EFFECT_PENDING`
- `OUTCOME_UNKNOWN`
- `VERIFIED_SUCCESS`
- `FAILED_RETRYABLE`
- `FAILED_FINAL`

Marveen eltérő neveket használhat, de az outcome uncertainty first-class állapot legyen.

---

## 6.4 Exactly-once semantic target

Nem szükséges matematikai distributed exactly-once, de business-level semantics igen:

> ugyanaz a logikai action legfeljebb egyszer legyen külsőleg végrehajtva, vagy bizonyíthatóan ugyanahhoz az existing outcome-hoz legyen visszakötve.

---

## 6.5 Ambiguous outcome protocol

Timeout / network failure side effect után:

```text
DO NOT blindly retry
 -> mark OUTCOME_UNKNOWN
 -> readback/status query
 -> reconcile
 -> retry only if absence is proven
```

---

## 6.6 Cursor rule

Cursor/checkpoint csak akkor léphet előre, ha:

- state write verified;
- side effect outcome reconciled;
- pending writes = 0 vagy explicit durable recovery queue-ban vannak.

---

## 6.7 Recovery queue

Részleges hiba esetén:

- exact pending action;
- input reference;
- idempotency key;
- last known outcome;
- retry policy;
- max attempts;
- human escalation threshold.

---

## 6.8 Tests

Kötelező fault injection:

- duplicate input;
- crash processing közben;
- DB/state write failure;
- side effect success + response timeout;
- side effect failure;
- readback timeout;
- restart pending state-tel;
- cursor write failure;
- two workers same input.

---

## 6.9 W12 acceptance criteria

- duplicate ingest nem okoz duplicate logical processinget;
- duplicate side effect negatív teszttel bizonyítottan blokkolt;
- `OUTCOME_UNKNOWN` flow működik;
- crash recovery automatikus és auditált;
- cursor nem tud hibásan előreszaladni;
- concurrent claim biztonságos.

---

# 7. W13 – Credential, PII, Egress & Disclosure Boundary

## 7.1 Problem statement

W10 eldönti, milyen érzékeny az adat. W13 biztosítja, hogy:

- credential helyesen tárolódik;
- agent csak szükséges ideig fér hozzá;
- PII external egress kontrollált;
- disclosure explicit és auditálható.

---

## 7.2 Secret storage

Kötelező elvek:

- secret nem plain configban;
- secret nem logban;
- secret nem durable agent memoryban;
- retrieval scoped;
- rotation támogatott;
- revocation dokumentált.

---

## 7.3 Egress policy

Minden external destination kapjon trust classificationt:

- trusted internal;
- approved external;
- restricted external;
- unknown/untrusted.

Unknown destination + sensitive data = deny.

---

## 7.4 Disclosure decision

Külső tool/site/service esetén a rendszer állapítsa meg:

```text
requested fields
data classes
minimum necessary fields
policy outcome
redactions
approval requirement
```

---

## 7.5 Prompt injection boundary

Külső tartalom nem módosíthatja:

- system policy;
- data disclosure policy;
- tool authorization;
- user identity;
- approval state.

External content = untrusted data.

---

## 7.6 Tests

- secret exfiltration attempt;
- prompt injection external contentből;
- PII unnecessary field disclosure;
- unknown domain;
- allowed domain + forbidden field;
- credential reuse wrong service-re;
- stale/revoked credential;
- log redaction.

---

## 7.7 W13 acceptance criteria

- secret lifecycle dokumentált és tesztelt;
- PII disclosure minimum necessary elven működik;
- unknown external destination fail-closed;
- external prompt injection nem emelhet privilege-et;
- auditból rekonstruálható miért került ki egy adat.

---

# 8. W14 – Backup, Restore, Staging, Canary & Operational Proof

## 8.1 Problem statement

A rendszer csak akkor production-ready, ha nemcsak „működik”, hanem:

- visszaállítható;
- release kontrollált;
- monitoring bizonyítja az egészséget;
- hibás deploy megállítható vagy visszagörgethető.

---

## 8.2 Backup scope

Minimum:

- durable state;
- schema/migration metadata;
- policy/config;
- workflow/case state;
- audit metadata, ahol szükséges.

Secret backup külön security policy szerint.

---

## 8.3 Restore proof

Nem elég dokumentálni.

Kötelező:

1. staging backup;
2. clean restore target;
3. restore;
4. consistency checks;
5. smoke tests;
6. documented RPO/RTO mérés.

---

## 8.4 Staging parity

Staging legyen elég közel productionhöz, hogy tesztelhető legyen:

- auth path;
- migrations;
- policy engine;
- tool execution;
- observability;
- release flow.

Nem kell minden external side effectet élesben végrehajtani; fake/sandbox adapter megengedett.

---

## 8.5 Canary

Új critical behavior esetén:

- limited traffic/workload;
- explicit metrics;
- automatic/manual abort threshold;
- promotion gate.

---

## 8.6 Operational health metrics

Minimum:

- run success/failure;
- partial failure;
- policy deny;
- duplicate suppression;
- unknown outcome;
- recovery queue size;
- migration errors;
- stale runs;
- unverified completion.

---

## 8.7 Run integrity

Minden run:

```text
run_id
started_at
capability/preflight result
input cursor
processed ids/count
pending writes
side effects
verification status
final cursor
finished_at
run_status
```

`SUCCESS` csak readback/verification után.

---

## 8.8 W14 acceptance criteria

- restore dry-run sikeres;
- staging release proof sikeres;
- canary flow működik;
- run integrity visszaellenőrizhető;
- failure alert működik;
- rollback vagy forward-fix runbook kipróbált;
- production readiness checklist zöld.

---

# 9. Phase 0 final go/no-go

Marveen a W14 végén készítsen egyetlen `PHASE_0_GO_NO_GO.md` dokumentumot.

Tartalma:

| Gate | Evidence | Result |
|---|---|---|
| Identity | ... | PASS/FAIL |
| Sensitivity | ... | PASS/FAIL |
| Schema/migration | ... | PASS/FAIL |
| Idempotency | ... | PASS/FAIL |
| Recovery | ... | PASS/FAIL |
| Credential/PII | ... | PASS/FAIL |
| Backup/restore | ... | PASS/FAIL |
| Staging/canary | ... | PASS/FAIL |
| Run integrity | ... | PASS/FAIL |

**No-go**, ha bármely P0 gate FAIL.

---

# 10. Phase 1 Architecture Contract – Reliable Case Autonomy

Phase 1-et most nem kell teljes file-level részletességgel előre megkötni. A Phase 0-nak azonban úgy kell elkészülnie, hogy ezt a modellt natívan támogassa.

---

## 10.1 Canonical Case

Minimum logical fields:

```text
case_id
domain/type
case_goal
status
progress_stage
priority/attention
ball_holder
next_action
next_action_type
deadline
wait_condition
next_review_at
completion_criteria
confidence
risk
approval_gate
source_links
last_event
last_reconciled_at
```

A concrete storage schema Marveen döntése.

---

## 10.2 Case invariants

### Invariant A

Minden aktív case:

```text
next_action
OR
wait_condition + next_review_at
```

Egyik sem hiányozhat.

### Invariant B

`COMPLETED` csak completion criteria + evidence alapján.

### Invariant C

`WAITING` nem lehet next_review_at nélkül, kivéve explicit event-only wake policy esetén, amelynek külön stale safety reviewja van.

### Invariant D

`NEEDS_USER` / `NEEDS_ISTVAN` esetén legyen konkrét:

- decision/question;
- target action;
- deadline/review;
- recommendation, ha lehetséges.

### Invariant E

Low-confidence high-risk action nem hajtható végre automatikusan.

---

## 10.3 Progress stages

Minimum szemantika:

- `ACTIONABLE`
- `WAITING`
- `NEEDS_USER`
- `COMPLETED`
- opcionálisan `MONITORING`

Marveen bővítheti, de ne legyen státuszrobbanás.

---

## 10.4 Waiting / Wake Engine

Wake trigger:

- event;
- new evidence;
- scheduled next_review_at;
- deadline proximity;
- commitment due;
- external response;
- policy change.

Wake után kötelező újraértékelés:

```text
current state
+ new evidence
+ policy
-> next state
```

---

## 10.5 Stale case detection

Case stale, ha például:

- next_review_at lejárt;
- waiting age threshold túllépve;
- több sikertelen follow-up;
- ball holder nem egyértelmű;
- action nem hajtható végre input hiány miatt.

Stale nem egyenlő automatikus user notificationnel.

Először strategy re-evaluation.

---

## 10.6 Completion & evidence

Evidence type példák:

- API readback;
- persisted external status;
- incoming message;
- user confirmation;
- document;
- transaction verification;
- test/health proof.

Completion event tartalmazza:

```text
criteria
criteria_result
evidence_refs
confidence
completed_at
```

---

## 10.7 Reopen

Ha completion után ellentétes evidence érkezik:

- case reopen;
- previous completion megmarad historyban;
- reopen reason;
- new next action.

---

## 10.8 Phase 1 required acceptance scenarios

1. Actionable case automatikusan továbblép.
2. Waiting case eventre felébred.
3. Waiting case review-date-re felébred.
4. Lejárt promise follow-upot generál.
5. User decision szükséges → egy konszolidált kérdés.
6. High-risk low confidence → nincs side effect.
7. Completion csak evidence után.
8. Later contradictory evidence → reopen.
9. Duplicate event → nincs duplicate progression.
10. Restart után state konzisztens.

---

# 11. Phase 2 – CoS Intelligence Functional Contract

Phase 2 csak Phase 0 + Phase 1 proof után implementálandó.

---

## 11.1 Commitment / Promise Tracker

First-class objektum:

```text
commitment_id
case_id
promised_by
promise
promised_at
expected_by
status
confidence
source_ref
fulfillment_evidence
next_review_at
```

Status minimum:

- OPEN
- FULFILLED
- OVERDUE
- BROKEN
- CANCELLED/SUPERSEDED

`FULFILLED` csak outcome evidence alapján.

---

## 11.2 Decision Object

```text
decision_id
case_id
question
options[]
criteria[]
evidence[]
tradeoffs
recommendation
confidence
risk
owner
decision_due
chosen_option
rationale
outcome
```

Cél: a döntés ne note vagy chat-fragment legyen.

---

## 11.3 Attention Engine

Nem egyszerű priority flag.

Minimum faktorok:

- deadline proximity;
- consequence/impact;
- financial exposure;
- legal/security risk;
- blocking factor;
- waiting age;
- confidence gap;
- user effort;
- reversibility.

A pontos formula később kalibrálható.

Kötelező:

- explainable score;
- score breakdown;
- deterministic baseline;
- manual override.

---

## 11.4 Question consolidation

Egy run/case lehetőleg egy konszolidált user interruptiont generáljon.

Kérdés tartalma:

```text
what changed
why user is needed
recommended option
target action
deadline
what happens if no response
```

---

## 11.5 Opportunity Detection

Első verzióban csak:

> detect -> propose -> user/owner accepts

Nem automatikus side effect.

Opportunity típusok például:

- warranty opportunity;
- cost saving;
- consolidation;
- cancellation/renewal opportunity;
- missing negotiation condition;
- duplicate service;
- deadline optimization;
- follow-up strategy change.

### Opportunity acceptance criteria

- evidence-referenced;
- confidence score;
- expected benefit;
- risk;
- no auto-action by default.

---

# 12. Phase 3 – External Research (parkoltatott, de definiált)

Implementáció csak külön go/no-go után.

---

## 12.1 ResearchJob concept

Case-ből származó explicit information gap:

```text
research_goal
required_fields
source_policy
freshness_requirement
minimum_sources
stopping_criteria
budget/time limit
```

---

## 12.2 Evidence normalization

Research result ne weboldal-lista legyen.

Normalizált evidence:

```text
source
retrieved_at
fact/claim
structured fields
confidence
freshness
conflicts
```

---

## 12.3 Stopping criteria

Kötelező, például:

- required fields complete;
- minimum independent sources;
- confidence threshold;
- max cost/time;
- no material unresolved conflict.

---

## 12.4 Phase 3 go/no-go előfeltétele

- Phase 0 stabil;
- Phase 1 valós működési proof;
- Phase 2 attention/question noise elfogadható;
- research use-case-ekből igazolt üzleti érték.

---

# 13. Phase 4 – Controlled Browser Autonomy (Later)

Most nem implementálandó.

A jövőbeli contract minimum elemei:

- persistent session;
- checkpoint/resume;
- human handoff CAPTCHA/OTP/login esetén;
- disclosure gate;
- egress policy;
- exactly-once form submission;
- OUTCOME_UNKNOWN reconciliation;
- browser replay harness;
- prompt-injection isolation;
- domain allow/deny policy.

---

# 14. Phase 5 – Optimization (Later)

Csak valós használati adatok alapján.

Területek:

- token/cost optimization;
- autonomy tuning;
- false-positive reduction;
- interruption reduction;
- latency;
- multi-agent only where measurable benefit exists;
- model routing;
- caching;
- batching.

---

# 15. Delivery strategy

## 15.1 Packet order

Kötelező sorrend:

```text
W10 -> W11 -> W12 -> W13 -> W14 -> Phase 0 GO/NO-GO
```

Utána:

```text
Phase 1 implementation plan -> Phase 1 implementation -> proof
```

Utána:

```text
Phase 2 prioritization -> incremental implementation
```

Phase 3–4 külön döntés nélkül nem indul.

---

## 15.2 No giant PR

Preferált:

- egy packet = egy vagy kevés koherens PR;
- reviewolható diff;
- feature-flag ha kockázatos;
- docs + tests ugyanabban a PR-ban.

---

## 15.3 CI policy

Development inner loop:

- local lint;
- typecheck;
- targeted tests.

PR update:

- fast CI.

Ready-for-review / merge gate:

- full CI;
- integration;
- security/failure tests;
- migration proof, ha kell.

Release:

- staging;
- health;
- canary, ha szükséges;
- proof;
- production promotion.

Concurrency + cancel-in-progress használata ajánlott, ha a CI platform támogatja.

---

# 16. Definition of Done – minden packetre

Egy packet nem DONE attól, hogy a kód elkészült.

Kötelező:

- [ ] repo audit elkészült
- [ ] gap matrix elkészült
- [ ] implementation plan dokumentált
- [ ] code implemented
- [ ] unit tests green
- [ ] integration tests green
- [ ] negative/failure tests green
- [ ] migration proof, ha releváns
- [ ] security impact reviewed
- [ ] observability implemented
- [ ] docs updated
- [ ] rollback/recovery path documented
- [ ] CI green
- [ ] runtime/staging proof, ha releváns
- [ ] known limitations documented
- [ ] acceptance criteria explicitly mapped to evidence

---

# 17. Acceptance Traceability Matrix

Marveen minden packet végén hozzon létre ilyen táblát:

| Acceptance criterion | Test / evidence | Result | Reference |
|---|---|---|---|
| AC-01 | test_xxx | PASS | path/link |

Egy criterion sem tekinthető teljesültnek bizonyíték nélkül.

---

# 18. Risk register

Minimum kiemelt kockázatok:

| Risk | Impact | Required mitigation |
|---|---|---|
| Secret leakage | Critical | W10/W13 fail-closed + redaction |
| Duplicate side effect | Critical | W12 idempotency + reconciliation |
| Silent data loss | Critical | no-silent-truncation + run verification |
| Bad migration | High | W11 idempotent migration + restore |
| Agent privilege escalation | Critical | identity/capability boundary |
| Prompt injection | High | untrusted external content isolation |
| False completion | High | evidence-based completion |
| Stale waiting workflow | Medium/High | next_review + stale detector |
| Excess user interruption | Medium | question consolidation + attention engine |
| Overengineering browser autonomy | Medium | Phase 3/4 go/no-go gate |

---

# 19. Explicit non-goals most

A következőket Marveen **ne** kezdje el a Phase 0–2 closure előtt:

- generic multi-agent hierarchy;
- új orchestration framework pusztán absztrakció kedvéért;
- browser automation platform;
- saját browser runtime újraírás;
- extra tool breadth business proof nélkül;
- UI polish state correctness helyett;
- autonomous financial/legal commitments;
- unrestricted external form submission.

---

# 20. Autonomous continuation policy

Ez a rész biztosítja, hogy Istvánnak ne kelljen közvetítenie.

Marveen a dokumentum átadása után:

1. elkezdi W10 repo auditját;
2. elkészíti a gap matrixot;
3. ha nincs valódi decision conflict, implementál;
4. lezárja a W10 gate-et;
5. automatikusan folytatja W11-gyel;
6. majd W12, W13, W14;
7. Phase 0 GO/NO-GO dokumentumot készít;
8. ha GO, elkészíti a Phase 1 repo-specific implementation plant;
9. Phase 1-et implementálja és bizonyítja;
10. Phase 2 előtt value/risk reviewt készít.

Istvánnak **nem kell minden packet után „mehet” üzenetet adnia**, kivéve ha explicit stop/hold utasítást ad.

---

# 21. Marveen első futásához használható master instruction

Az alábbi utasítás a dokumentummal együtt átadható Marveennek:

```text
Treat MARVEEN_IMPLEMENTATION_PLAN_WAY_OF_WORKING_v1.0_2026-08-24.md as the product, architecture, safety and acceptance contract for the next Marveen development cycle.

Your role is staff engineer + implementation agent + verification owner.

Do not ask István routine technical questions. Resolve HOW decisions yourself from the repository, existing architecture, tests, git history and safest reversible implementation pattern. You may change implementation details, file boundaries and internal architecture as needed, but you may not silently weaken or change the WHAT, invariants, safety boundaries or acceptance criteria.

Execute sequentially:
W10 -> W11 -> W12 -> W13 -> W14 -> Phase 0 GO/NO-GO.

For each packet:
1. audit the actual repository;
2. classify every requirement VERIFIED_DONE / PARTIAL / MISSING / CONFLICT / BLOCKED_EXTERNAL;
3. create a file-level implementation plan;
4. implement;
5. add unit, integration, negative and failure-path tests;
6. verify migrations/recovery where relevant;
7. update documentation;
8. produce an acceptance traceability matrix and evidence-based DONE report.

If an existing implementation already satisfies a requirement, reuse it and prove it instead of rebuilding it.

Only stop and ask István when there is a true product/policy/safety/acceptance-criteria conflict, a new paid infrastructure dependency, an irreversible migration risk, or two technically valid options that cause materially different user behavior. Consolidate all such questions into one DECISION REQUIRED block with your recommendation.

Do not wait for a separate “go” between packets. If a packet is DONE and the next packet has no decision blocker, continue automatically.

Do not start Phase 3 External Research or Phase 4 Browser Autonomy without an explicit post-Phase-2 go/no-go decision.
```

---

# 22. Expected outputs from Marveen

A teljes ciklus végén minimum ezek legyenek a repóban:

```text
/docs/marveen/
  W10_IDENTITY_SENSITIVITY_AUDIT.md
  W10_DONE_REPORT.md
  W11_SCHEMA_MIGRATION_AUDIT.md
  W11_DONE_REPORT.md
  W12_IDEMPOTENCY_RECOVERY_AUDIT.md
  W12_DONE_REPORT.md
  W13_CREDENTIAL_PII_EGRESS_AUDIT.md
  W13_DONE_REPORT.md
  W14_OPERATIONAL_PROOF.md
  W14_DONE_REPORT.md
  PHASE_0_GO_NO_GO.md
  PHASE_1_REPO_IMPLEMENTATION_PLAN.md
  PHASE_1_PROOF.md
```

A pontos elérési út repo-konvenció szerint módosítható.

---

# 23. Management gates

## Gate A – W10 complete

Kérdés: biztonságosan tudja-e a rendszer, ki mit és milyen adattal tehet?

## Gate B – W12 complete

Kérdés: hibánál/retrynál is bizonyíthatóan elkerüljük-e a duplicate vagy bizonytalan side effectet?

## Gate C – Phase 0 complete

Kérdés: production-grade trust kernel áll-e rendelkezésre?

## Gate D – Phase 1 complete

Kérdés: a rendszer reliably tud-e ügyet önállóan progresszelni, várni, felébredni és bizonyítottan lezárni?

## Gate E – Phase 2 complete

Kérdés: valós értéket ad-e a proaktivitás elfogadható user interruption mellett?

Csak Gate E után vizsgálandó Phase 3–4.

---

# 24. Vezetői mérőszámok

Phase 0–2 értékeléséhez ajánlott minimum KPI-k:

### Reliability

- successful verified runs %;
- partial failure rate;
- duplicate suppression count;
- unknown outcome count;
- recovery success rate;
- stale case rate.

### Safety

- blocked sensitive actions;
- credential leakage incidents = 0;
- unauthorized side effects = 0;
- unverified completions = 0 target.

### CoS value

- cases progressed without user intervention;
- user decisions requested;
- unnecessary interruptions;
- overdue commitments detected;
- missed deadlines;
- average waiting-age before escalation;
- opportunities accepted/rejected.

---

# 25. Final instruction

A fejlesztés célja nem az, hogy Marveen „minél több mindent tudjon”, hanem hogy:

> **megbízhatóan, auditálhatóan, minimális user-interruption mellett és kontrollált kockázattal tudjon autonóm módon ügyeket előrevinni.**

A sorrend ezért kötelező:

> **Trust -> State correctness -> Case autonomy -> Intelligence -> External autonomy.**

Nem fordítva.

