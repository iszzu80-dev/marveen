# Marveen CoS v4.4 + ZST v1.2 + ACP v1.4.5 — részletes fejlesztési terv

**Dátum:** 2026-08-16  
**Forrás:** `audits/cos-v4.4-zst-v1.2-acp-v1.4.5-gap-analysis-2026-08-16.md`  
**Cél:** a jelenlegi Personal v4.3 + ACP v1.4.4 brownfield rendszert kontrolláltan az új v4.4 / ZST v1.2 / ACP v1.4.5 targetre emelni, regresszió és autonómia-szint növelése nélkül.

---

# 1. Fejlesztési stratégia

A sorrendet nem a három specifikáció fejezetsorrendje adja, hanem a függőségek:

```text
M0 measurement/red gates
  ↓
M1 temporal semantic core
  ↓
M2 actionability
  ↓
M3 consumer completeness + zero telemetry
  ↓
M4 evidence freshness + backlog proof
  ↓
M5 namespace/security cutover
  ↓
M6 Personal v4.4 domain hardening
  ↓
M7 ZST operationalization + legacy migration
  ↓
M8 readiness/promotion + v1.5 unlock report
```

**Fő szabály:** egy későbbi hullám nem indulhat azért, mert a korábbi kód elkészült. A korábbi hullám **acceptance gate-je** kell zöld legyen.

---

# 2. Nem tárgya ennek a tervnek

- ACP v1.5 external research/browser autonomy implementálása;
- autonóm emailküldés;
- banki utalás vagy befektetési tranzakció;
- autonóm szerződéses/jogi kötelezettségvállalás;
- a Personal és ZST store összevonása;
- a meglévő case engine újraírása;
- a shared executor, Reader, WAIT_SYSTEM, kill switch, deadline index vagy bank parser párhuzamos új implementációja.

---

# 3. M0 — Measurement First / Red Gates

## Cél

A target követelmények **előbb váljanak mérhető piros feltételekké**, mint hogy javítani kezdjük őket.

## Munka

### M0.1 Shared v1.4.5 acceptance layer

Javasolt új modul:

- `scripts/acp-v145-acceptance.py` vagy egy közös helper, amit a Personal és ZST gate importál.

Ne másolja a `cos-acceptance.py` helperjeit; ugyanazokat használja.

Minimum csoportok:

1. `temporal`
2. `actionability`
3. `consumer-completeness`
4. `evidence-freshness`
5. `backlog-recovery`
6. `security-boundary`
7. `promotion-readiness`

### M0.2 Personal acceptance bővítés

Új target checks:

- P44-TSCG installed/reached from production progression path;
- orphan open Personal count;
- unconsumed verified critical deadline;
- document structured extraction-state coverage;
- stale evidence protection;
- calendar identity/readback capability state;
- credential scope measurement state;
- CPP manifest coverage of every `cos-cycle` step.

### M0.3 ZST acceptance bővítés

- Z12 operational projection on newly ingested cases;
- ZST orphan count;
- strict connector identity boundary;
- explicit bridge only;
- 42 legacy case migration state;
- finance/legal safety;
- contract/license temporal semantics;
- Product Lab/outbound production caller preserved;
- bank import production caller measured, not assumed.

### M0.4 Fixture skeletons

Már most kerüljenek be RED állapotban:

- Hertz/Sixt semantic date conflict;
- owner answer + stale packet 37 sec later;
- pre-existing due wake;
- pre-existing pending consumer item;
- producer without consumer;
- consumer without receipt;
- Personal orphan;
- ZST orphan;
- foreign connector direct ZST write;
- legacy ZST migration must not auto-complete.

## DoD

- Minden target gap PASS/FAIL/UNKNOWN/ERROR formában mérhető.
- Az ismert hiányok RED vagy UNKNOWN; nem „not applicable”.
- A jelenlegi erős safety gate-ek zöldek maradnak.
- Legalább a P1 fixture-ek mutation-provenek.

## Rollback

Nincs production behavior change; measurement-only PR.

---

# 4. M1 — Shared Temporal Semantic Core

## Cél

Megszüntetni azt a hibaosztályt, hogy „van dátum, csak nem annak a dátuma, amiről a döntés szól”.

## M1.1 Adatmodell

Javasolt additive tábla:

```sql
case_temporal_facts (
  temporal_fact_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  occur_at INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_locator TEXT,
  confidence REAL,
  verification_status TEXT NOT NULL,
  supersedes_fact_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

Indexek:

- `(domain, case_id, kind, verification_status)`
- `(domain, occur_at, verification_status)`
- `(source_type, source_id)`

Minimum verification:

`VERIFIED | UNVERIFIED | CONFLICTED | REJECTED`

## M1.2 Legacy adapter

A `deadline-index.ts` nem törlendő.

Kell egy adapter, amely:

- legacy scalar/domain dates → `TemporalFactView`;
- explicit stored facts → ugyanabba a view-ba;
- megjelöli, hogy legacy projection vagy explicit fact.

Az első release-ben a legacy mezők továbbra is source of operational compatibility; az explicit factek shadow parityban futnak.

## M1.3 Projection provenance

Kötelező tudni, hogy:

- `due_at`
- `follow_up_at`
- `next_wake_at`

mely factből származik.

Javaslat: `case_temporal_projections(domain, case_id, projection_name, temporal_fact_id)`.

## M1.4 TSCG

Új modul:

`src/cos/temporal-consistency.ts`

Input:

- domain/case;
- next action / current decision class;
- active temporal facts;
- projections;
- active owner workflow/wake/delivery path.

Kimenet:

`TEMPORAL_OK | TEMPORAL_MISSING | TEMPORAL_UNVERIFIED | TEMPORAL_CONFLICT | TEMPORAL_PAST_DUE`

### Gate szabály

TSCG fusson **minden owner-attentiont vagy external-effectet előkészítő döntés előtt**.

Ne blokkoljon fölöslegesen tisztán belső bookkeepingot.

`TEMPORAL_CONFLICT` esetén:

- nincs unattended owner-question spam;
- nincs approval candidate;
- nincs external candidate;
- explicit reconcile finding / targeted clarification.

## M1.5 Trigger integration

`progression-trigger.ts` maradjon a trigger owner.

Bővítés:

- VERIFIED critical semantic deadline due → named trigger;
- ugyanaz a fact ne triggereljen végtelenül;
- handled identity fact-id + version alapján, ne pusztán timestamp alapján.

## M1.6 Deadline delivery check

Új check:

`VERIFIED critical fact + no wake/Today/active owner workflow = UNCONSUMED_DEADLINE`

## Kötelező tesztek

- Hertz/Sixt pickup vs decision cutoff;
- contract expiry vs termination deadline;
- two conflicting verified facts;
- superseded fact;
- unverified LLM suggestion never becomes critical verified fact;
- past deadline changes ask semantics;
- fact without source cannot be VERIFIED.

## DoD

- Hertz/Sixt fixture zöld.
- A TSCG production callerből elérhető.
- Legacy deadline index parity report nincs megmagyarázatlan eltéréssel.
- Nincs destructive schema migration.

---

# 5. M2 — Shared Actionability Gate

## Cél

Egy nyitott ügy ne lehessen „élő, de operatívan gazdátlan”.

## M2.1 Új shared classifier

`src/cos/actionability.ts`

Kimenet:

```text
ACTIONABLE
WAITING_EXTERNAL
WAITING_OWNER
WAIT_SYSTEM
SCHEDULED
BLOCKED
RECOVERY_REQUIRED
PARENT_ONLY
ORPHAN
```

A classifier domain-aware, de shared engine szabályt használ.

### Personal és ZST status mapping

A status enumok eltérnek, ezért ne status string equality legyen a core szabály. Domain adapter adja:

- terminal states;
- waiting-owner states;
- blocked/recovery states;
- parent-only semantics.

## M2.2 Runtime use

Fusson:

1. intake után;
2. progression state write után;
3. migration után;
4. daily reconcile-ben.

### Fontos

Az ORPHAN detector **nem találhat ki next_actiont**.

Lehetséges reakció:

- determinisztikusan resolvable → internal repair;
- forrásból nem resolvable → owner question / quarantine;
- legacy ZST migration scope → migration queue.

## M2.3 Acceptance

- new Personal orphan = FAIL;
- new ZST orphan = FAIL;
- parent-only nem orphan;
- WAIT_SYSTEM nem owner blocker;
- explicit WAITING_EXTERNAL follow-up nélkül csak akkor valid, ha policy generál follow-upot.

## DoD

- új case egyik domainen sem jöhet létre ORPHAN állapotban silent módon;
- reconcile külön riportolja a legacy orphan backlogot;
- `orphan_open_cases` metrikként elérhető.

---

# 6. M3 — Complete Progression Path + Standard Telemetry

## Cél

A „megépült, de nincs fogyasztója” hibaosztályt release-szinten lehetetlenné tenni.

## M3.1 Feature manifest

Új registry:

`src/cos/feature-manifest.ts`

Egy rekord:

```ts
{
  featureId,
  producer,
  storage,
  consumer,
  observableEffect,
  receiptSource,
  idempotencyKey,
  recoveryMode,
  zeroTelemetry,
  supportedDomains,
  status
}
```

`status` minimum:

`LIVE | EXPERIMENTAL_NOT_ROUTED | RETIRED`

## M3.2 Elsőként regisztrálandó feature-ek

- progression heartbeat;
- Reader pass;
- wake alert;
- planned digest;
- radar digest;
- deadline audit;
- owner question send/poll;
- source commit/batch close;
- capability recovery;
- Personal outbound;
- ZST outbound;
- ZST due watcher;
- Product Lab escalation;
- bank import, ha production route igazolt.

## M3.3 Standard PeriodicOutcome

```ts
{
  examined,
  matched,
  acted,
  failed,
  outcome: NO_DATA | NO_MATCH | NO_ACTION | ACTED | FAILED | UNKNOWN,
  reason,
  domain?
}
```

Az existing runner-specifikus counters megmaradhatnak, de ezt a közös minimumot adják.

## M3.4 cos-cycle enforcement

A cycle:

- tudja, mely manifest feature-t futtatja;
- FAIL, ha normatív step outputja nem értelmezhető;
- `UNKNOWN` nem fordulhat át sikeres 0-vá;
- a nested failures logika megmarad.

## M3.5 Acceptance

- producer exists, consumer removed → RED;
- receipt source removed → RED;
- zero telemetry missing → RED;
- EXPERIMENTAL_NOT_ROUTED modul nem reklámozható live capabilityként.

## DoD

A normative CoS periodic features 100%-a manifestben van, és a production caller + receipt ellenőrizhető.

---

# 7. M4 — Evidence Freshness + Backlog Proof

## Cél

Egy régi Reader snapshot ne írja felül vagy ne kérdezze vissza azt, amit az owner azóta már megválaszolt; egy deploy előtti pending input se vesszen el.

## M4.1 Evidence watermark

A `case_evidence_packets` bővítése:

- `case_version_at_read`
- `evidence_max_event_seq`
- `evidence_built_at`
- `source_versions_json`

A source version lehet:

- event id;
- document sha/revision;
- thread newest message id;
- domain entity version.

## M4.2 Generic freshness API

`assertEvidenceFresh(db, domain, caseId, packetId, purpose)`

Purpose példák:

- `OWNER_QUESTION`
- `APPROVAL_REQUEST`
- `EXTERNAL_CANDIDATE`

Owner-originated event snapshot után → stale.

## M4.3 Wiring

Kötelező call site:

- owner question előtt;
- progression-driven compose/approval request előtt;
- external_shadow candidate előtt.

## M4.4 Backlog-before-fix harness

Reusable fixture helper:

1. pending item létrehozása;
2. consumer még nem fut;
3. „deployment boundary”;
4. consumer fut;
5. receipt ellenőrzés;
6. új input nélkül.

Alkalmazandó:

- wake;
- Reader candidate;
- owner question;
- pending outbound recovery;
- source commit/batch;
- capability recovered.

## DoD

- 37 sec stale question fixture zöld;
- old packet approval/external candidate is blocked;
- pre-existing backlog fixture legalább 4 kritikus queue-ra zöld.

---

# 8. M5 — Namespace / Connector Identity Security Cutover

## Cél

Az új ZST v1.2 szerint a connector identity legyen az operational write boundary.

## M5.1 Current behavior megszüntetése

A current route ne tehesse ezt automatikusan:

```text
Personal connector input
→ content classifier says ZST
→ direct ZST case write
```

## M5.2 New behavior

```text
ZST connector → ZST intake
Personal connector → Personal intake
Personal corporate-looking content → SCOPE_REVIEW quarantine
SCOPE_REVIEW + explicit human bridge approval → bridge command → ZST
```

## M5.3 Bridge design

Javasolt command:

`bridgePersonalSourceToZst(...)`

Kötelező:

- owner/human initiator;
- source id;
- destination case/new case decision;
- provenance;
- audit event mindkét oldalon;
- copy/link semantics explicit;
- nem implicit move;
- idempotency key.

## M5.4 Existing historical crossings

- Nem törlendők.
- Nem írjuk át a múltat.
- `LEGACY_CONTENT_ROUTED_CROSSING` provenance/marker migráció megengedett.
- Acceptance csak a cutover utáni új crossingra legyen strict.

## M5.5 Acceptance update

A jelenlegi ZI-4 „marked crossing is okay” szabályt verziózottan módosítani kell:

- cutover előtt: historical accepted/visible;
- cutover után: direct foreign connector write FAIL;
- explicit bridge PASS.

## DoD

Silent cross-namespace operational write technikailag lehetetlen.

---

# 9. M6 — Personal CoS v4.4 Domain Hardening

## M6.1 Structured document extraction state

A content store marad változatlan alap.

Új structured layer, például:

`cos_document_fields`

```text
document_id
field_name
value_text / value_number / value_date
state
source_locator
confidence
extractor_version
extracted_at
```

State:

`NOT_ATTEMPTED | EXTRACTED | NOT_PRESENT | AMBIGUOUS | FAILED`

### Invoice minimum

- issuer
- invoice_number
- gross_amount
- currency
- issue_date
- due_date

Extraction failure finding, nem silent null.

## M6.2 Calendar integrity

Kötelező flow:

```text
confirmed booking
→ source identity
→ lookup existing
→ create if absent
→ provider readback
→ case calendar_event_ids write
→ receipt event
```

Duplicate source identity → `CALENDAR_DUPLICATE_CONFLICT`.

Amíg nincs safe update/delete surface, csak owner repair task.

## M6.3 Mission Control repair commands

Domain command rétegen:

- close/cancel + reason;
- set next action + owner;
- temporal fact confirm/reject;
- parent attach/unlink;
- calendar conflict resolve marker;
- owner question answer/reject;
- progression mode;
- kill switch.

Minden command:

- `seenVersion`;
- event log;
- no direct UI SQL.

## M6.4 Credential scope drift

Capability measurement:

- expected scope set;
- measured scope set, ha technikailag lekérdezhető;
- extra/missing scope finding;
- measurement unavailable → UNKNOWN, nem PASS.

Az email send scope megléte soha nem elég send authoritynak.

## M6.5 Personal reconcile v4.4

Új metrics:

- orphan;
- temporal conflict;
- unconsumed critical deadline;
- stale evidence blocked;
- docs missing structured state;
- calendar conflicts;
- token scope drift;
- CPP violations.

## DoD

Personal supervised v4.4 gate green; unattended még nem automatikusan enabled.

---

# 10. M7 — ZST v1.2 Operationalization

## M7.1 Operational projector

Új shared/domain module:

`src/cos/zst-operational-projector.ts`

Intake után előállítja vagy explicit wait/quarantine állapotba teszi:

- category;
- next_action;
- next_action_owner;
- waiting_on;
- follow_up;
- closure_condition;
- temporal facts;
- actionability classification.

**Tilos:** generic inbound case üres NEW állapotban úgy, hogy nincs operational meaning.

## M7.2 Domain extractor integration

Invoice/contract extractor catch többé ne legyen silent.

Exception esetén:

- case marad;
- structured field state `FAILED`;
- event/finding;
- actionability döntés ennek tudatában.

## M7.3 Existing 42 case dry migration

Első lépés read-only report:

minden case-re:

```text
current status
source evidence
proposed operational class
proposed next_action
proposed owner
proposed temporal facts
confidence
migration blockers
would_enable_progression
```

Semmit nem ír.

## M7.4 Canary migration

### Canary A — 2 case

- két eltérő típus;
- `MIGRATED_OPERATIONAL_PROJECTION` event;
- actionability valid;
- progression explicit enable;
- egy teljes cycle;
- no unintended completion;
- reconcile clean.

### Canary B — 5 case

külön domain-ekből, például:

- invoice;
- contract;
- subscription;
- partner/opportunity;
- general admin.

### Batch 10 → remainder

Csak zöld acceptance + reconcile után.

## M7.5 Migration completion guard

Migration-triggered első progression pass **nem tehet automatikusan terminal állapotba** legacy case-t pusztán generikus DoD alapján.

Terminalhoz szükséges:

- case-specific completion evidence; vagy
- explicit owner close; vagy
- előre definiált deterministic domain completion proof.

## M7.6 Finance

A meglévő bank parser/importer újrahasználandó.

Feladat:

- production entrypoint igazolása;
- ha nincs, controlled upload/import endpoint/CLI;
- import receipt;
- bankmatch továbbra is suggestion only.

Accounting package lifecycle:

`COLLECTING → READY_FOR_REVIEW → APPROVED_TO_SEND → SENT → ACKNOWLEDGED → CLOSED`

SEND exact payload approval mögött.

## M7.7 Licenses / subscriptions

- adatbetöltő/input path;
- 90/60/30/14/7d;
- trial end;
- price increase;
- unused-paid candidate;
- cancellation deadline temporal fact.

Sem lemondás, sem renewal acceptance automatikusan.

## M7.8 Product Lab / outbound

Nem újraépítendő.

Feladat csak:

- CPP manifest;
- temporal facts ahol due_at van;
- acceptance proof;
- receipt/zero telemetry.

## M7.9 ZST reconcile/brief

Kötelező metrics az új specből, köztük:

- orphan;
- progression disabled unexpectedly;
- temporal conflicts;
- due/past due;
- waiting owner/external/system;
- invoice extraction failures;
- contract/license due windows;
- outbound recovery;
- cycle failures.

## DoD

- új ZST case orphan=0;
- strict connector boundary;
- 2+5 canary green;
- legalább 5 diverse live E2E ügy;
- finance/legal/outbound hard gates zöldek.

---

# 11. M8 — Readiness / Promotion / v1.5 Unlock

## Cél

A progression mode ne puszta kapcsoló legyen, hanem mért readiness mellett használható konfiguráció.

## M8.1 Readiness state

Javasolt computed report vagy ledger:

```text
domain
feature_scope
current_mode
eligible_next_mode
blocking_findings
last_p1_at
stable_since
stability_days
gate_evidence_hash
measured_at
```

## M8.2 Promotion semantics

A rendszer **nem auto-promote-ol**.

A gate csak ezt mondja:

- NOT_ELIGIBLE
- ELIGIBLE_FOR_INTERNAL
- ELIGIBLE_FOR_EXTERNAL_SHADOW
- ELIGIBLE_FOR_LIVE

A tényleges mode change explicit owner/admin command.

## M8.3 Stability window

- 7 egymást követő nap;
- P1 silent-failure reseteli;
- UNKNOWN critical metric nem számít stabil napnak;
- domain+feature scoped.

## M8.4 v1.5 unlock

Csak report:

`LOCKED` vagy `ELIGIBLE_TO_IMPLEMENT_LIVE_PHASE`.

Nem indít automatikusan v1.5 munkát és nem emel capabilityt.

## DoD

- Personal és ZST külön readiness;
- gate evidence reprodukálható;
- v1.4.5 state/readiness doc kész `[ÉLŐ]/[MEGÉPÍTVE]/[PAPÍR]/[VISSZAVONVA]` státusszal.

---

# 12. Javasolt PR-sorozat

A változásokat kis, bizonyítható PR-ekre kell bontani:

| PR | Tartalom | Kódviselkedés |
|---|---|---|
| **PR-A** | v4.4/v1.2/v1.4.5 RED acceptance + fixtures | measurement only |
| **PR-B** | temporal fact store + legacy adapter + TSCG | shared internal behavior |
| **PR-C** | Actionability Gate + reconcile | shared internal correctness |
| **PR-D** | CPP manifest + standardized outcome | observability/release gate |
| **PR-E** | evidence watermark + freshness + backlog fixtures | owner/external stale protection |
| **PR-F** | connector identity namespace cutover + explicit bridge | security boundary |
| **PR-G** | Personal extraction/calendar/Mission Control/scope drift | Personal v4.4 |
| **PR-H** | ZST operational intake + dry migration + canaries | ZST v1.2 core |
| **PR-I** | ZST finance/subscription/domain lifecycle completion | ZST business domains |
| **PR-J** | readiness/promotion/v1.5 unlock | release governance |

## PR szabályok

Minden PR:

1. ne növeljen autonóm external execution surface-t;
2. saját acceptance criteriont hozzon;
3. P1 protection esetén mutation proof;
4. update-elje a state/readiness dokumentációt, ha live behavior változik;
5. rollback mechanizmusa legyen dokumentált;
6. no silent UNKNOWN.

---

# 13. Kockázatok és mitigáció

## R1 — Dual temporal truth

**Kockázat:** legacy mezők és új factek eltérnek.  
**Mitigáció:** additive fact layer, shadow parity, projection provenance, nincs azonnali destructive cutover.

## R2 — Legacy ZST tömeges auto-close

**Kockázat:** a korábbi incidens megismétlődik.  
**Mitigáció:** dry run → 2 → 5 → 10; migration first pass terminal tiltás; case-specific completion evidence.

## R3 — Strict namespace cutover miatt elvesző corporate-looking private mail

**Kockázat:** nem kerül automatikusan ZST-be.  
**Mitigáció:** nem dobjuk el; SCOPE_REVIEW quarantine + explicit bridge queue.

## R4 — False-green acceptance

**Kockázat:** a mérőeszköz saját magát méri vagy commentet callernek hisz.  
**Mitigáció:** a meglévő positive-control/caller-search discipline + mutation proof.

## R5 — Telemetry noise

**Kockázat:** minden null/UNKNOWN riaszt, owner csatorna zajossá válik.  
**Mitigáció:** monitoring finding ≠ owner alert; csak actionable P1/decision kerül ownerhez.

## R6 — OAuth scope introspection nem elérhető

**Kockázat:** false safe.  
**Mitigáció:** `UNKNOWN`, nem PASS; write/live eligibility blocked, de supervised internal flow mehet policy szerint.

## R7 — Calendar duplicate

**Kockázat:** két event ugyanarra a bookingra.  
**Mitigáció:** source identity lookup → create → readback; conflict esetén nincs auto repair.

## R8 — Performance

**Kockázat:** temporal/actionability/CPP check minden 10 percben drága.  
**Mitigáció:** indexelt fact store, bounded scans, changed-state triggers; acceptance/reconcile full scan napi, nem minden cycle-ben.

## R9 — Readiness auto-eszkalálja az autonómiát

**Kockázat:** green metricből implicit authority lesz.  
**Mitigáció:** readiness csak eligibility; mode change explicit owner/admin action.

---

# 14. Implementációs függőségi döntések

## D1 — Temporal facts vs deadline index

**Ajánlás:** hibrid additive modell.

- deadline index marad compatibility/read model;
- explicit fact lesz a jövőbeli semantic truth;
- parity után lehet projection authorityt fokozatosan átadni.

## D2 — Actionability javítás

**Ajánlás:** shared engine classifier, nem Personal/ZST külön implementáció.

## D3 — Readiness promotion

**Ajánlás:** soha ne legyen automatikus promotion. A gate mér, az owner állít módot.

## D4 — ZST strict namespace

**Ajánlás:** az új v1.2 legyen authority; a 2026-08-09 „content decides” automatic cross-write viselkedés legyen visszavonva, de a classifier maradjon quarantine detector.

---

# 15. Végső Definition of Done a teljes programra

A program akkor zárható le, ha:

1. az új target acceptance minden P1/P2 kritériuma PASS vagy explicit approved deferred;
2. nincs aktív supported Personal/ZST orphan case;
3. Hertz/Sixt semantic regression zöld;
4. minden VERIFIED critical deadline-nak van consumer/delivery pathja;
5. minden normatív periodic feature CPP-manifesttel és receipttel rendelkezik;
6. stale Reader packet owner input után nem tud kérdést/approvalt/external candidate-et okozni;
7. pre-existing backlog fixture-ek zöldek;
8. ZST silent cross-namespace write megszűnt;
9. új ZST intake operational case-t készít;
10. legacy ZST migráció canary-val végigment unintended completion nélkül;
11. Personal document extraction state és calendar integrity működik;
12. bank/legal/email hard safety invariánsok változatlanul érvényesek;
13. Personal és ZST readiness külön mérhető;
14. 7 napos stability window teljesül az unattended-re promotálni kívánt scope-on;
15. ACP v1.5 addig LOCKED, amíg a fenti gate-ek nem teljesülnek.

---

# 16. Ajánlott végrehajtási sorrend egy mondatban

> **Először a mérőeszközöket pirosítsuk be; utána egyetlen shared semantic/actionability/consumer core-t építsünk; csak ezután nyúljunk a ZST legacy case-ekhez és a domain-adatokhoz; a végén mérjünk stabilitást, és az autonómia-emelés maradjon explicit emberi döntés.**
