# Marveen Autonomous Case Progression v1.4
## Proactive Core
### Brownfield proactive detection, qualification and internal preparation — zero new external execution surface

**Státusz:** proposed implementation baseline — review-integrated revision  
**Dátum:** 2026-08-13  
**Előző baseline:** `marveen-autonomous-case-progression-spec-v1.3.1.md`  
**Leválasztott következő release:** `marveen-autonomous-case-progression-spec-v1.5-external-research-browser-autonomy.md`  
**System of record:** meglévő Personal + ZST COS Case Store, intake, events, progression state, approval/action réteg  
**Implementációs stratégia:** brownfield `reuse → audit → harden → wire`; új subsystem csak bizonyított hiány esetén  
**Release boundary:** v1.4 **nem** vezet be új böngészőt, külső kutatási végrehajtót, form-submitot, adatkiadási felületet vagy új binding actiont

**Acceptance fixtures:** `marveen-acp-v1.4-acceptance-fixtures.md`

---

# 0. Executive summary

A v1.3.1 fő kérdése:

> **Ha már van egy Case és outcome, hogyan vigye Marveen azt autonóm módon előre?**

A v1.4 új kérdése:

> **Hogyan vegye észre Marveen magától, hogy egy meglévő vagy potenciális ügy figyelmet igényel, hogyan döntse el, hogy valóban érdemes-e foglalkozni vele, és hogyan készítse elő a következő döntést vagy lépést anélkül, hogy feleslegesen megszakítaná Istvánt?**

A v1.4 célja nem „több értesítés”, hanem **proaktív belső ügy-előkészítés**.

A release kívánt működése:

```text
new event / document / email / state change / time-based sweep
→ existing Reader / Context Builder
→ evidence-grounded signal
→ deterministic qualification
→ duplicate / novelty suppression
→ existing Case match OR justified Case promotion
→ desired outcome / gap
→ deadline / stall / anomaly evaluation
→ resolve-before-ask
→ INTERNAL-ONLY autonomous preparation
→ interruption/backpressure gate
→ Decision / Action Package only when needed
→ existing v1.3.1 progression continues
```

A v1.4 **nem** próbálja ugyanebben a release-ben megoldani a külső webkutatást és böngésző-autonómiát. Ennek oka szerkezeti:

```text
Proactive Core = brownfield
External Research / Browser = greenfield or low-maturity external trust boundary
```

Ez a release-határ a kockázatot, a tesztfelületet és a delivery méretét csökkenti, miközben a proaktivitás fő értékét már önállóan mérhetővé teszi.

---

# 1. Product definition

## 1.1 Rövid definíció

> **Marveen v1.4 egy proaktív chief-of-staff core, amely az engedélyezett belső eseményekből és időalapú állapotellenőrzésekből felismeri a cselekvésre érdemes opportunity, risk, obligation, deadline, anomaly és stall helyzeteket; determinisztikusan kvalifikálja őket; összeköti a megfelelő Case-szel; meghatározza a kívánt outcome-ot; elvégzi a policy által engedett belső előkészítést; és Istvánt csak valódi döntési, jóváhagyási vagy nem feloldható információs határnál vonja be.**

## 1.2 A v1.4 proaktivitási ciklusa

```text
DETECT
→ QUALIFY
→ DEDUPLICATE
→ CONNECT TO CASE
→ DEFINE OUTCOME / GAP
→ RESOLVE INTERNALLY
→ PREPARE INTERNALLY
→ PRIORITIZE
→ INTERRUPT ONLY IF NEEDED
→ CONTINUE WITH EXISTING PROGRESSION
```

A release központi elve:

> **Detect first; qualify second; prepare third; interrupt last.**

## 1.3 Mi nem a v1.4 definíciója?

Nem része a v1.4 product definitionnek:

- general web research;
- browser automation;
- form filling / form submit;
- CAPTCHA/login takeover;
- külső provider interaction;
- adatkiadás új külső félnek;
- commercial quote orchestration;
- új külső API/egress executor;
- binding purchase/cancellation/acceptance;
- Mission Control redesign mint release blocker.

Ezek v1.5 scope.

## 1.4 Pre-registered Value Hypothesis / Release Success Contract

A v1.4 nem tekinthető sikeresnek pusztán attól, hogy a mechanizmus-metrikái zöldek. A release-nek **előre rögzített, cáfolható inkrementális értékhipotézist** kell teljesítenie shadow módban.

### 1.4.1 Historical volume calibration before pre-registration

A live shadow küszöb és mérési ablak **nem választható meg vakon**. A §26 szerinti replay corpus + reactive baseline lépés részeként először kötelező lefuttatni legalább az előző 90 nap reprezentatív korpuszát, és megmérni:

```text
historical_eligible_case_count
historical_eligible_initiative_count
historical_eligible_events_per_30d
historical_reactive_findings_count
historical_material_findings_count
historical_deadline/stall/anomaly/opportunity mix
```

A replay után, **de a live shadow indulása előtt**, egy immutable eval configurationben pre-registerelendő:

```yaml
value_gate_registration:
  corpus_window_days: 90
  shadow_window_days: <30|60|90>
  minimum_eligible_observations: <integer>
  required_incremental_material_catches: <integer>
  max_false_positive_interruption_candidates_per_7d: <integer>
  primary_adjudicator: <named human>
  backup_adjudicator: <named human>
  adjudication_cadence: <e.g. twice weekly>
  timeliness_rubric_version: <immutable version>
  reactive_baseline_run_id: <independently persisted control run>
  blinding_effectiveness_test: <pre-registered test/version>
  blinding_null_origin_guess_rate: 0.50
  blinding_detectable_origin_guess_rate: 0.70
  origin_guess_alpha: 0.05
  blinding_target_power: 0.80
  blinding_validation_min_packets: <power-derived integer; default design = 40>
  frozen_at:
```

**Default candidate**, ha a historical volume ezt támogatja:

```text
shadow_window = 30 days
minimum_eligible_observations = 25
required_incremental_material_catches = 5
max_false_positive_user-interruption_candidates = 2 / 7 days
```

A kalibrációnak **két külön mintaigényt** kell egyszerre méreteznie:

```text
value_gate_required_window = az eligible observations / incremental-value gate által igényelt ablak
blinding_required_window = a pre-registered blinding power-design által igényelt ablak
frozen_shadow_window = max(value_gate_required_window, blinding_required_window)
```

Ha a 90 napos replay azt mutatja, hogy 30 nap alatt bármelyik mintaigény várhatóan nem teljesül, az ablakot **a shadow előtt** 60 vagy 90 napra kell kalibrálni. A value-gate küszöböt és a blinding minimum mintát együtt kell befagyasztani. Live shadow közben egyik gate success-preserving módosítása sem megengedett.

A default blinding power-design:

```text
H0 origin-guess rate = 0.50
detectable bad blinding rate = 0.70
one-sided exact binomial
alpha = 0.05
target power >= 0.80
minimum independent adjudication packets = 40
```

Az exact binomiális minimum ennél a designnál 37 packet; a specifikáció 40-et használ konzervatív defaultként. Ha a teszt, `p1`, alpha vagy cél-power változik, a minimum mintát **újra kell számolni és shadow előtt pre-registerelni**; tetszőleges kézi `<integer>` nem elfogadható. Ugyanazon packet többszöri újraértékelése nem növeli az effektív mintaszámot.

A `NO_EVIDENCE_DUE_TO_LOW_VOLUME` és a `BLINDING_EVIDENCE_INSUFFICIENT` külön eredmények; egyik sem PASS és egyik sem mechanikai FAIL. Nem szabad csendben sikernek minősíteni vagy a megfigyelési ablakot utólag tetszőlegesen nyújtani.

### 1.4.2 What counts as incremental value

Egy `validated incremental material catch` csak akkor számít, ha mindegyik igaz:

1. a signal/initiative evidence-grounded;
2. materiality legalább `MEDIUM`;
3. a független reactive control ugyanazon korpuszon ugyanazt a lényegi ügyet a pre-registered timeliness rubric szerint **nem hozta fel időben**, vagy csak explicit user prompt után hozta volna fel;
4. a finding valós next actiont, korábbi beavatkozást, elkerült deadline/risk miss-t, vagy mérhető emberi előkészítési munkamegtakarítást eredményezett volna;
5. adjudication megerősíti, hogy az Initiative nem pusztán újrafogalmazta a már ismert Case-state-et.

`false-positive user-interruption candidate` az a P1/P2/P3 jelölt, amely a pre-registered rubric alapján nem indokolt user interruptiont jelentett volna.

### 1.4.3 Blind adjudication and blinding-effectiveness test

Az értékelés nem alapulhat azon, hogy az elbíráló tudja, melyik findinget a Proactive Core és melyiket a reactive control állította elő. A vakítás **nem tekinthető bizonyítottnak pusztán attól, hogy az origin label el van rejtve**; mérni kell, hogy a packet formája alapján az eredet visszakövetkeztethető-e.

Kötelező folyamat:

```text
same frozen corpus
→ proactive shadow run persisted independently
→ reactive baseline/control run persisted independently
→ outputs mapped into one canonical adjudication schema
→ provenance/source-of-origin hidden
→ randomized adjudication packet
→ blind human adjudication using fixed rubric
→ adjudicator records origin_guess before unblinding
→ judgment + origin_guess persisted
→ provenance unblinded only after both are persisted
→ metric calculation
```

Az adjudicator láthatja a Case/evidence kontextust, a findinget, a proposed next actiont és a releváns timestamp-eket, de **nem láthatja az origin labelt** (`PROACTIVE` vs `REACTIVE`) az ítélet és az `origin_guess` rögzítéséig.

A canonical adjudication schema legalább ezeket az összehasonlítható mezőket használja mindkét oldalra:

```yaml
adjudication_packet:
  packet_id:
  case_context_summary:
  evidence_refs:
  finding:
  materiality:
  timeliness_relevant_timestamps:
  proposed_next_action:
  rationale:
  origin_label: HIDDEN_UNTIL_PERSISTED_JUDGMENT
```

A proactive-only belső mezők (`PreparedInitiative` implementation metadata, planner trace, detector-specific fields, run naming, source-specific ordering) **nem jelenhetnek meg** az adjudicator packetben, ha a reactive controlnak nincs ekvivalens mezője. Ha valamely mező szükséges az ítélethez, mindkét oldalra azonos kanonikus reprezentációt kell előállítani.

Minden adjudication record kötelező mezői:

```yaml
adjudication_record:
  packet_id:
  adjudicator_id:
  judgment:
  timely: true|false
  material: true|false
  origin_guess: PROACTIVE|REACTIVE
  origin_guess_confidence: LOW|MEDIUM|HIGH
  judged_at:
  rubric_version:
```

Kötelező metrika:

```text
origin_guess_accuracy
origin_guess_accuracy_by_confidence
origin_guess_sample_size
```

A blinding effectiveness értékelése előre rögzített, **power-qualified** statisztikai szabállyal történik. Default: egyoldali exact binomial test a `p=0.5` nullhipotézis ellen, `alpha=0.05`, legalább 0.80 powerrel a `p=0.70` alternatíva detektálására. A default minimum 40 egyedi adjudication packet.

A teszt **fail-closed**:

- ha a pre-registered minimum minta nincs meg → `BLINDING_EVIDENCE_INSUFFICIENT`;
- ha a minta megvan és az `origin_guess_accuracy` szignifikánsan 50% fölött van → `VALUE_GATE_ADJUDICATION_CAPABILITY_GAP`;
- csak akkor lehet `VALID`, ha a minimum minta megvan **és** a pre-registered teszt nem talál above-chance origin inference-t.

Ha az `origin_guess_accuracy` szignifikánsan 50% fölött van, a vakítás nem működik:

```text
VALUE_GATE_ADJUDICATION_CAPABILITY_GAP
```

Ha a pre-registered `blinding_validation_min_packets` nem gyűlik össze a befagyasztott mérési ablakban, az eredmény:

```text
BLINDING_EVIDENCE_INSUFFICIENT
```

Ez nem PASS. A release mechanikailag lehet kész, de érvényes value-gate bizonyításnak nem minősíthető addig, amíg a vakítás hatékonysága nem mérhető.

Ha technikailag nem biztosítható a vakítás vagy az origin-guess mérés, az `VALUE_GATE_ADJUDICATION_CAPABILITY_GAP`; a gate nem mérhető érvényesen.

### 1.4.4 Timeliness rubric — pre-registered by initiative type

Az „időben” fogalma nem dönthető el utólag esetről esetre. A shadow előtt versionált rubric szükséges legalább az alábbi osztályokra:

| Initiative class | `timely` minimum rule |
|---|---|
| DEADLINE / OBLIGATION | finding surfaced before `internal_safe_deadline` |
| STALL | finding surfaced no later than the first policy-defined stale/follow-up threshold |
| ANOMALY | finding surfaced before the next normal reactive review point or before a dependent decision/action |
| RISK | finding surfaced before the first point where the identified harm becomes materially harder/costlier to avoid |
| OPPORTUNITY / OPTIMIZATION | finding surfaced while a meaningful decision/action window remains open |
| MISSING_REQUIREMENT | finding surfaced before the missing requirement blocks or materially delays the target outcome |

A konkrét thresholdok domain/policy szerint pontosíthatók, de csak a shadow előtt és immutable rubric versionben.

### 1.4.5 Adjudicator ownership, independence and cadence

A gate költsége és működése explicit:

- `primary_adjudicator` és `backup_adjudicator` **nevesített ember**; nem lehet LLM, agent, automatikus policy evaluator vagy ugyanazon modellcsalád újabb futása;
- egyik adjudicator sem lehet a Proactive Core adott outputjának előállítója;
- az adjudicator nem láthat detector/planner trace-et vagy originre utaló implementation metadata-t az ítélet előtt;
- az implementációs owner lehet technikai facilitator, de az ítéletet nem írhatja felül és nem backfillelheti;
- minimum heti kétszeri adjudication cadence ajánlott, de a konkrét cadence pre-registered;
- minden candidate-nek SLA szerinti időn belül ítéletet kell kapnia;
- ha az adjudication backlog a megengedett SLA fölé nő vagy két egymást követő cadence kimarad, az ablak `EVALUATION_WINDOW_DEGRADED` státuszú;
- degraded window nem minősíthető PASS-nak korrekció és dokumentált extension nélkül;
- az evaluation workload külön mérendő (`adjudication_minutes`, `pending_adjudication_count`, `adjudication_sla_breach_count`).

Az adjudicator személye és a cadence **a shadow indulása előtt** kerül befagyasztásra. Személycsere csak dokumentált `ADJUDICATOR_REPLACEMENT` eseménnyel, okkal és effective timestamp-pel történhet; a már elbírált packeteket nem kell újraminősíteni, de az új adjudicator origin-guess metrikája külön is riportálandó.

### 1.4.6 Reactive control independence

A „baseline nem hozta volna fel” állítás csak akkor érvényes, ha a reactive control:

- ugyanazon frozen korpuszon fut;
- ugyanazokat a forrásadatokat kapja meg, amelyek a reaktív rendszer számára normálisan elérhetők;
- a Proactive Core outputját nem látja;
- a saját outputját függetlenül és immutable módon rögzíti **az adjudication előtt**;
- run ID-val és konfiguráció-verzióval reprodukálható.

Emlékezetből, kézi visszatekintéssel vagy a proactive output ismeretében rekonstruált baseline **nem elfogadható kontroll**.

### 1.4.7 Evaluation discipline

- A shadow window, eligible minimum, catch threshold és false-positive threshold **a shadow indulása előtt** kerül befagyasztásra.
- A threshold utólag nem változtatható úgy, hogy egy sikertelen futás sikeressé váljon.
- Volume-insufficient esetet külön kell jelenteni; nem szabad PASS-ra konvertálni.
- A v1.5 go/no-go egyik előfeltétele a v1.4 value hypothesis érvényes, nem degradált mérésből származó teljesülése.

### Secondary value metrics

```text
incremental_material_catch_count
incremental_material_catch_rate
eligible_observation_count
missed_by_reactive_baseline_count
prevented_deadline_or_stall_miss_count
human_preparation_minutes_avoided_estimate
false_positive_interruption_candidates_per_week
adjudication_minutes
pending_adjudication_count
adjudication_sla_breach_count
blind_adjudication_coverage_rate
reactive_control_reproducibility_rate
value_hypothesis_result = PASS | FAIL | NO_EVIDENCE_DUE_TO_LOW_VOLUME | EVALUATION_WINDOW_DEGRADED
```


---

# 2. Release boundary

## 2.1 v1.4 — Proactive Core

A v1.4 csak olyan capability-ket szállít, amelyek a meglévő COS/ACP belső adataiból és már engedélyezett olvasási felületeiből működnek.

```text
IN:
- signal detection
- initiative qualification
- materiality / novelty filtering
- duplicate suppression
- existing Case matching
- justified Case promotion
- Outcome Contract integration
- deadline engine
- scheduled proactive sweep
- stall detection
- anomaly detection
- resolve-before-ask
- internal preparation planning
- internal evidence organization
- draft preparation
- risk assessment
- decision package preparation
- interruption backpressure
- replay / shadow / eval

OUT:
- browser
- web research execution
- external form submission
- external disclosure
- provider/account creation
- external side-effect orchestration
- new binding authority
```

## 2.2 v1.5 — External Research & Browser Autonomy

A v1.5 külön trust boundaryként kezeli:

- research orchestration;
- browser sessions;
- checkpoints/resume;
- human takeover;
- disclosure policy;
- external evidence normalization;
- commercial comparison specialization.

A v1.5 csak v1.4 stabil, mért Proactive Core után aktiválható.

---

# 3. Brownfield reuse contract

A v1.4 nem épít párhuzamos COS-t.

Kötelezően újrahasználandó, ha a live audit szerint létezik és megfelelő:

- Personal Case Store;
- ZST Case Store;
- Case events/history;
- Gmail/document intake;
- Context Builder;
- Reader / evidence extraction;
- Progression Kernel;
- Progression Run Ledger;
- Rolling Plan / Next Best Action;
- Resolve-before-ask;
- Wait/Wake;
- Structured Escalation;
- Semantic Completion;
- Writer;
- Delegation Envelope;
- Controlled Action Executor;
- Approval/Decision state;
- existing notification/question queue;
- existing idempotency primitives.

Minden komponensnél:

```text
REUSE
→ LIVE AUDIT
→ HARDEN / REWIRE IF NEEDED
→ CREATE NEW ONLY IF ABSENT
```

A v1.4 nem indokol új queue-t, új Case Store-t vagy második progression engine-t.

---

# 4. ProactiveSignal

A `ProactiveSignal` first-class, de **nem Case**.

```ts
type ProactiveSignalType =
  | "OPPORTUNITY"
  | "RISK"
  | "OBLIGATION"
  | "DEADLINE"
  | "ANOMALY"
  | "STALL"
  | "CHANGE"
  | "GAP";

interface ProactiveSignal {
  signal_id: string;
  domain: "PRI" | "ZST";
  signal_type: ProactiveSignalType;

  source_refs: SourceRef[];
  source_event_ids: string[];
  detected_at: string;

  subject_ref?: string;
  candidate_case_id?: string;

  summary: string;
  evidence_claims: EvidenceClaim[];

  estimated_materiality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  estimated_urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  estimated_actionability: "LOW" | "MEDIUM" | "HIGH";

  candidate_deadline?: string;
  confidence: number;

  dedupe_key: string;
  novelty_key: string;

  status: "DETECTED" | "SUPPRESSED" | "PROMOTED" | "ANNOTATED";
}
```

## 4.1 Signal invariants

- signal csak evidence alapján jöhet létre;
- source reference kötelező;
- model-only sejtés nem elég;
- ugyanaz az esemény ne generáljon ismételten új signal-t;
- signal létrejötte önmagában nem szakíthatja meg a felhasználót;
- signal létrejötte önmagában nem hozhat létre új Case-t.

---

# 5. ProactiveInitiative

A `ProactiveInitiative` a kvalifikált, cselekvésre érdemes proaktív egység.

```ts
type InitiativeState =
  | "QUALIFIED"
  | "LINKED_TO_CASE"
  | "PREPARING"
  | "WAITING_INTERNAL"
  | "DECISION_READY"
  | "SUPPRESSED"
  | "RESOLVED";

interface ProactiveInitiative {
  initiative_id: string;
  domain: "PRI" | "ZST";
  signal_ids: string[];

  initiative_type:
    | "OPPORTUNITY"
    | "RISK"
    | "OBLIGATION"
    | "DEADLINE"
    | "ANOMALY"
    | "STALL"
    | "CHANGE"
    | "GAP";

  materiality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

  case_id?: string;
  desired_outcome: DesiredOutcome;
  current_gap: string;

  decision_deadline?: string;
  internal_safe_deadline?: string;

  allowed_preparation_classes: InternalPreparationClass[];
  unresolved_requirements: Requirement[];

  user_interruption_required: boolean;
  interruption_reason?: string;

  state: InitiativeState;
  confidence: number;
}
```

## 5.1 Promotion rule

A signal csak akkor promotálható Initiative-vá, ha legalább az alábbiak igazak:

```text
materiality >= configured threshold
AND actionable or decision-relevant
AND sufficiently novel
AND evidence-grounded
AND not already represented by equivalent active Initiative/Case state
```

Egy alacsony értékű, ismétlődő vagy nem cselekvőképes jel annotálható vagy suppressálható.

---

# 6. Initiative Qualification Policy

A qualification determinisztikus policy-réteg; a Reader/model javaslata csak input.

## 6.1 Döntési sorrend

```text
1. hard gate / domain policy
2. evidence sufficiency
3. duplicate / novelty check
4. materiality
5. urgency / deadline
6. actionability
7. existing Case relevance
8. interruption cost
9. promotion decision
```

## 6.2 Policy output

```ts
interface InitiativeQualificationResult {
  signal_id: string;
  decision: "SUPPRESS" | "ANNOTATE" | "PROMOTE";
  reason_codes: string[];
  matched_case_id?: string;
  materiality_score: number;
  urgency_score: number;
  actionability_score: number;
  interruption_score: number;
  confidence: number;
}
```

## 6.3 Materiality discipline

A v1.4 saját proaktív outputjára ugyanaz az elv vonatkozik, mint a Case-ekre:

> **Nem az a cél, hogy mindent észrevegyen, hanem hogy a kevés valóban cselekvésre érdemes dolgot megbízhatóan kiemelje.**

Ezért minimum szükséges:

- configurable materiality threshold;
- per-domain suppression policy;
- duplicate/near-duplicate collapse;
- low-value signal suppression;
- interruption budget;
- replayen mérhető precision.

---

# 7. Duplicate and novelty suppression

## 7.1 Dedupe hierarchy

```text
exact source event id
→ message/document identity
→ semantic signal fingerprint
→ active Initiative equivalence
→ active Case state equivalence
```

## 7.2 Invariants

- ugyanaz az email/message/document nem indíthat két azonos Initiative-t;
- sweep és event-driven path ugyanarra a helyzetre nem hozhat létre duplikált Case-t;
- új információ frissítheti az existing Initiative-t;
- duplicate suppression nem nyelheti el a materially changed állapotot;
- dedupe döntés naplózott és replayelhető.

---

# 8. Initiative → Case wiring

A v1.4 elsőként meglévő Case-t keres.

```text
signal
→ active Case exact match
→ active Case semantic/subject match
→ recently completed Case re-open eligibility
→ only then consider new Case
```

## 8.1 Új Case csak akkor

- nincs megfelelő aktív Case;
- a signal materialitása eléri a thresholdot;
- van értelmezhető desired outcome;
- van következő cselekvés vagy decision boundary;
- a Case nem pusztán FYI értesítés lenne.

## 8.2 Case explosion guard

Kötelező mérőszámok:

- `signals_per_case_created`;
- `duplicate_case_rate`;
- `suppressed_signal_rate`;
- `initiative_to_case_promotion_rate`;
- `reused_existing_case_rate`.

---

# 9. Desired Outcome / Gap Model

Minden promotált Initiative-hez outcome kell.

```ts
interface DesiredOutcome {
  outcome_type: string;
  target_state: string;
  completion_evidence: string[];
  authority_boundary?: string;
}
```

A rendszer explicit tartsa nyilván:

```text
CURRENT STATE
DESIRED STATE
GAP
NEXT INTERNAL PREPARATION
EXTERNAL/USER BOUNDARY
COMPLETION EVIDENCE
```

Az Initiative nem maradhat „nézzük meg” állapotban outcome nélkül.

---

# 10. Deadline Engine

A v1.4 támogatja:

- explicit határidő;
- inferred deadline evidence alapján;
- safe internal deadline;
- expiry / renewal / response due;
- follow-up due;
- stale waiting state.

## 10.1 Deadline normalization

```ts
interface DeadlineRecord {
  deadline_id: string;
  case_id?: string;
  initiative_id?: string;
  source_ref: SourceRef;
  deadline_type: string;
  external_deadline: string;
  internal_safe_deadline?: string;
  confidence: number;
  status: "OPEN" | "SATISFIED" | "SUPERSEDED" | "EXPIRED";
}
```

## 10.2 Deadline index

A review alapján a határidő-adatok jelenleg szétszórtak lehetnek; ezért a v1.4 egyik konkrét brownfield feladata egy **lekérdezhető deadline index/normalizált nézet** létrehozása vagy bizonyítása.

A `DeadlineIndex` alapértelmezetten **derived read model / projection**, nem negyedik önálló source of truth. Új write-authority csak explicit migration decisionnel hozható létre.

Követelmény:

- due item lekérdezés deadline szerint;
- priority order ne read-order legyen;
- safe deadline determinisztikusan számítható, ahol szabály ismert;
- deadline source és confidence tárolt;
- deadline változás replan trigger.

## 10.3 Deadline ontology consolidation contract

A build előtt kötelező inventory készül minden meglévő deadline-fogalomról, minimum az auditban talált példákra:

```text
follow_up_at
zst-watch horizon / watch due concept
progression-trigger dueDeadline
+ minden további deadline/due/review timestamp, amelyet live repo/DB audit talál
```

Minden fogalom pontosan egy státuszt kap:

```text
SUBSUMED
ADAPTED_TO_INDEX
INTENTIONALLY_DISTINCT
DEPRECATED
```

És dokumentálni kell:

```yaml
field_or_concept:
semantic_owner:
source_of_truth:
readers:
writers:
normalized_deadline_type:
precedence_if_conflict:
status: SUBSUMED | ADAPTED_TO_INDEX | INTENTIONALLY_DISTINCT | DEPRECATED
rationale:
migration_or_adapter:
```

Invariánsok:

- a v1.4 nem hozhat létre indoklás nélkül negyedik párhuzamos deadline-semantikát;
- az index nem lehet kézzel írt alternatív truth-store;
- conflict precedence determinisztikus;
- minden `INTENTIONALLY_DISTINCT` fogalomhoz explicit indoklás szükséges;
- a DoD csak akkor zöld, ha a meglévő deadline-fogalmak **subsumálva, adapterrel normalizálva vagy explicit indoklással külön tartva** vannak.

---

# 11. Scheduled Proactive Sweep

A sweep célja nem az összes Case újraelemzése, hanem az esemény nélkül változó állapotok felismerése:

- due deadline;
- follow-up due;
- stale waiting;
- stalled Case;
- unresolved anomaly;
- expiring internal state;
- previously unresolved requirement that may now be resolvable.

## 11.1 Sweep candidate selection

A sweep csak indexelt candidate setből dolgozzon, ne teljes Case-table scanből.

```text
due deadlines
+ due follow-ups
+ stale waits
+ stagnant/no-progress candidates
+ explicitly scheduled review_at
```

## 11.2 Mandatory sweep invariants

### A. Fairness

- PRI és ZST egyik irányban sem éhezhet ki;
- nagy domain nem fogyaszthatja el a teljes batch budgetet;
- fairness policy explicit és tesztelt.

### B. Monotonic cursor

- cursor csak előre mozoghat;
- synthetic/business-state érték nem írhat source cursort;
- cursor csak sikeresen commitált batch után léphet;
- rollback/retry nem okozhat skipet.

### C. No silent truncation

- limit elérésekor `has_more=true` vagy continuation token kötelező;
- a lekérdezési limit mögötti rekordok nem dobhatók el csendben;
- backlog age mérendő.

### D. Due-state advancement

- feldolgozott/no-op candidate nem maradhat azonnal újra due;
- minden claimelt candidate után explicit `next_review_at`, state transition vagy completion szükséges;
- claim-and-release végtelen loop tiltott.

### E. Priority fairness

Elsődleges rendezés:

```text
hard deadline / urgency
→ materiality
→ oldest due
→ stable deterministic tie-breaker
```

Nem elfogadható a puszta „latest read order”.

### F. Claim idempotency

- ugyanaz a due item párhuzamos sweepekben egyszer processzálható;
- lease/fencing vagy egyenértékű mechanizmus szükséges;
- retry nem hozhat duplikált side effectet vagy duplikált Initiative-t.

## 11.3 Sweep observability

Kötelező:

```text
oldest_unprocessed_age
due_backlog_depth
domain_lag
continuation_depth
claimed_count
completed_count
no_op_count
retry_count
starvation_detected
cursor_regression_count
silent_truncation_count
```

`cursor_regression_count` és `silent_truncation_count` production acceptance-ben **0**.

---

# 12. Stall Detection

A v1.4 a már meglévő progression állapotból detektál elakadást.

Candidate signal források:

- `no_progress_run_count`;
- stagnant Case age;
- repeated identical Next Best Action;
- repeated wait without meaningful state change;
- overdue follow-up;
- unresolved blocker with capability now available.

## 12.1 Stall decision

Nem minden régi Case stall.

```text
age threshold
AND no meaningful state transition
AND desired outcome still open
AND not legitimately WAIT_EXTERNAL / WAIT_TIME
```

## 12.2 Action

Stall esetén v1.4 csak belső preparationt vagy meglévő safe progressiont indít.

Nem indít új browser/external research pathot.

---

# 13. Anomaly Detection

A v1.4 csak olyan anomaly-t kezel, amelyhez már rendelkezésre áll belső evidence.

Példák:

- dokumentumban lévő összeg eltér a Case-ben tárolttól;
- új határidő felülírja a korábbit;
- promised reply nincs meg határidőre;
- Case status és evidence ellentmond;
- ugyanarra a tételre két eltérő állapot érkezik;
- expected document/evidence hiányzik.

Anomaly → signal → qualification → existing Case update, nem automatikus alert.

---

# 14. Resolve-before-ask v1.4

A v1.3.1 elv kötelezően megelőzi az interruptiont.

A v1.4 Core resolve sorrendje:

```text
1. Case data
2. Case events/history
3. already-ingested Gmail thread content
4. already-ingested Drive/document evidence
5. Calendar / Contacts if already permitted by domain policy
6. domain-safe stored memory/context
7. deterministic derived facts
8. only then consider asking István
```

**Nem része v1.4-nek:** új webkutatás vagy új browser execution.

## 14.1 Resolve output

```ts
interface ResolutionAttempt {
  requirement_id: string;
  attempted_sources: string[];
  resolved: boolean;
  resolved_value?: unknown;
  evidence_refs: SourceRef[];
  unresolved_reason?: string;
}
```

---

# 15. Autonomous Preparation Planner

A v1.4 Proactive Core kulcs execution capability-je.

Csak belső, side-effect-free vagy már meglévő safe draft/preparation action classokat használ.

## 15.1 Allowed internal preparation classes

```ts
type InternalPreparationClass =
  | "READ_CONTEXT"
  | "RESOLVE_MISSING_INFORMATION"
  | "CHECK_DEADLINE"
  | "VERIFY_STATE"
  | "CHECK_STALL"
  | "CHECK_ANOMALY"
  | "ORGANIZE_EVIDENCE"
  | "ASSESS_RISK"
  | "CHECK_DUPLICATE"
  | "PREPARE_DRAFT"
  | "PREPARE_DECISION_PACKAGE"
  | "PREPARE_INTERNAL_SUMMARY"
  | "SCHEDULE_REVIEW";
```

## 15.2 Explicitly forbidden in v1.4 planner

```text
RESEARCH_WEB
BROWSER_NAVIGATE
FORM_FILL
FORM_SUBMIT
SEND_TO_NEW_EXTERNAL_RECIPIENT
DISCLOSE_PERSONAL_DATA
CREATE_ACCOUNT
ACCEPT_OFFER
BOOK
ORDER
PAY
CANCEL_CONTRACT
SIGN
LEGAL_COMMITMENT
```

## 15.3 Release-boundary standing checks

A `zero new external execution surface` **nem dokumentációs checkbox**, hanem kódszintű standing invariant.

A repositoryban kötelező standing test(ek)nek kell elbukniuk, ha bármelyik történik:

1. a v1.4 `InternalPreparationClass` allowlist tiltott external class-szal bővül;
2. v1.4 Proactive Core modul közvetlenül vagy tranzitívan browser/runtime/fetch/external-egress adapterhez függ;
3. v1.4 planner olyan executorhoz kap permitet, amely új külső side effectet tud kibocsátani;
4. browser/research/disclosure module bekerül a v1.4 transitive dependency graphba;
5. tiltott action class alias/rename útján megkerüli az allowlistet.

Ajánlott standing checks:

```text
proactive-core-action-boundary.test.ts
proactive-core-import-boundary.test.ts
```

A repo-ban jelentett `cos-gate-permit.test.ts` mintáját újra kell használni, ha live audit igazolja, hogy alkalmas erre. A teszt a teljes releváns `src/` + `scripts/` felületet és a v1.4 modulok **transitive dependency closure-jét** vizsgálja, nem csak szintetikus fixture-t vagy közvetlen importot.

Production invariant:

```text
forbidden_external_action_class_count = 0
forbidden_external_import_count = 0
unauthorized_external_permit_path_count = 0
```

## 15.4 Preparation plan

```ts
interface InternalPreparationPlan {
  initiative_id: string;
  steps: InternalPreparationStep[];
  stop_condition: string;
  user_boundary?: string;
  evidence_required: string[];
}
```

A plan 3–7 értelmes, Case-specifikus lépés legyen; template reuse önmagában nem elegendő.

## 15.5 Proactive draft factual-quality gate

A `PREPARE_DRAFT` külön kockázati felület: a draft még nem külső side effect, de egy approvalra van a küldéstől. Ezért proaktív draft csak akkor lehet `approval-ready`, ha:

- minden lényegi tényhez evidence/provenance tartozik;
- minden számított állításhoz determinisztikus derivation record tartozik;
- relatív idő-/nap-számítás az esemény tényleges source timestampjéből indul, nem a follow-up due timestampből vagy más proxyból;
- címzett, thread és context target explicit;
- stale/conflicting evidence esetén a draft `NOT_APPROVAL_READY`;
- high-impact vagy jogi/pénzügyi állítás approval-ready draftban csak policy szerint jelenhet meg.

Kötelező negatív fixture: rossz időalapból számított „N nap telt el” állítás nem juthat approval-ready állapotba.

---

# 16. PreparedInitiative artifact

A v1.4 shadow-mode és decision-ready működés központi artifactja:

```yaml
initiative_id:
case_id:
signal_refs: []
qualification:
  materiality:
  urgency:
  actionability:
  reason_codes: []
desired_outcome:
current_gap:
deadline:
internal_safe_deadline:
evidence_resolved: []
remaining_unknowns: []
risk_assessment:
prepared_actions: []
blocked_by:
user_decision_required:
interruption_priority:
next_review_at:
confidence:
```

Ez teszi mérhetővé, hogy Marveen:

- mit vett észre;
- miért minősítette fontosnak;
- mit oldott fel magától;
- mit készített elő;
- mikor és miért szakítaná meg Istvánt.

Mission Control UI nélkül is tárolható és replayelhető.

---

# 17. Interruption and Approval Budget / backpressure

A v1.4 két külön emberi terhelési csatornát modellez:

1. **interruption load** — amikor a rendszer megszakítja Istvánt;
2. **approval load** — amikor a rendszer döntést/jóváhagyást kér egy előkészített draft vagy action package miatt.

A kettő nem azonos: egyetlen bundled értesítés több approval-döntést is tartalmazhat, ezért külön limit és metrika szükséges.

## 17.1 Interruption pipeline

```text
candidate interruption
→ classify priority
→ dedupe/coalesce
→ per-Case cooldown
→ per-user/global backpressure
→ bundle if possible
→ SEND / DEFER / BUNDLE / SUPPRESS
```

## 17.2 Priority classes

```text
P0 = imminent material harm / hard deadline / safety-critical authority need
P1 = near-term material decision required
P2 = useful but deferrable decision/input
P3 = informational / low-value
```

## 17.3 Existing cooldown reuse

A review szerint a codebase-ben már létezik per-Case rate limit/cooldown, jelenleg 6 órás javítással. A v1.4 **ezt a meglévő mechanizmust auditálja és újrahasználja**, nem épít második limitert.

Normatív szabály:

```text
case_interruption_cooldown = existing validated policy
reported current baseline = 6h
```

A konkrét konfiguráció live audit során igazolandó.

## 17.4 Coalescing

Cooldown alatt érkező új jel:

- nem vész el;
- nem generál új user-kérdést;
- az existing pending interruption csomagjához kerül;
- materiality/urgency növekedés újraprioritizálhat;
- csak P0 override kerülheti meg a cooldownot, auditált reason code-dal.

## 17.5 Approval-load pipeline

Minden `PREPARE_DRAFT`, `PREPARE_DECISION_PACKAGE` vagy más approval-required artifact külön approval candidate-et képez.

```text
approval candidate
→ factual-quality gate
→ duplicate/same-decision coalescing
→ per-Case approval cooldown
→ per-user approval-rate budget
→ bundle related approvals
→ PRESENT / DEFER / BUNDLE / SUPPRESS
```

Initial canary defaults, amelyeket live audit után konfigurációban kell rögzíteni:

```text
max_proactive_approval_presentations_per_user_24h = 2
max_proactive_approval_presentations_per_case_24h = 1
```

Ezek **approval presentation** limitek, nem a létrehozható belső draftok számának korlátai. A rendszer továbbra is készíthet shadow/internal draftot, de nem tolhat korlátlan approval-sort a user elé.

P0/P1 sürgősség nem teszi automatikusan jóváhagyhatóvá az actiont; legfeljebb az interruption prioritását emelheti.

## 17.6 Deadline-aware approval escape hatch

Az approval budget zajcsökkentő mechanizmus, **nem írhatja felül a deadline engine-t**.

Minden `DEFER` állapotú approval candidate rendelkezzen:

```yaml
approval_candidate:
  internal_safe_deadline:
  latest_present_by:
  queue_entered_at:
  priority:
  defer_reason:
```

A queue minden újraszámításakor kötelező ellenőrzés:

```text
if now >= latest_present_by
   OR time_to_internal_safe_deadline <= configured_escape_threshold:
       bypass normal approval presentation cap
       surface as DEADLINE_ESCALATED_APPROVAL
       audit reason
```

Ha egyszerre több candidate kényszerülne cap fölötti felszínre, a rendszer **nem rejtheti el őket**. Egyetlen P0 bundled interruptiont kell létrehozni, amely jelzi, hogy a nyitott authority-required döntések száma meghaladja a normál keretet, és legalább egy biztonságos belső határideje lejáróban van.

```text
NORMAL CAP protects attention
DEADLINE ESCAPE protects outcome
AUTHORITY GATE remains unchanged
```

A deadline escape **nem auto-approval**, nem action authority escalation, kizárólag presentation/escalation override.

### 17.6.1 Cooldown exception inheritance is explicit, not implicit

A live auditnak külön fel kell térképeznie a meglévő interruption cooldown kivételeit. A review alapján jelentett jelenlegi kivételek:

1. owner/user response az interruption cooldownt azonnal feloldhatja;
2. egy nyitott kérdés újrafogalmazása nem feltétlenül számít új kérdésnek.

Ezek **nem öröklődnek automatikusan az approval csatornára**.

Normatív v1.4 alapértelmezés:

- `owner_response_releases_interruption_cooldown = existing validated behavior`
- `owner_response_releases_approval_budget = false`
- `question_rephrase_does_not_reset_interruption_budget = existing validated behavior`
- `approval_rephrase_does_not_create_new_approval_candidate = true`
- egy user válasza egy kérdésre nem engedhet át egyszerre több, korábban cap mögött tartott approvalt;
- approval budget csak saját explicit szabály vagy deadline escape alapján oldható fel.

Ha live audit más meglévő kivételeket talál, mindegyikhez explicit `INHERIT | DO_NOT_INHERIT | ADAPT` döntés szükséges.

## 17.7 Approval-fatigue safeguards

- ugyanahhoz a döntéshez tartozó draftok egy approval package-be coalescelendők;
- low-materiality draft nem kérhet önálló approvalt;
- approval queue age és backlog mért;
- repeated unchanged draft nem kérhet új approvalt;
- rejected/edited draft pattern visszacsatolandó a shadow/eval corpusba;
- approval presentation előtt a §15.5 factual-quality gate kötelező.

## 17.8 Backpressure metrics

```text
avoidable_interruption_rate
interruptions_per_case_24h
interruptions_per_user_24h
coalesced_signal_count
suppressed_low_value_count
cooldown_override_count
repeat_question_rate
approval_candidates_per_user_24h
approval_presentations_per_user_24h
approvals_per_user_24h
approvals_per_case_24h
approval_backlog_depth
approval_queue_oldest_age
approval_without_open_rate
approval_rejection_rate
approval_edit_rate
proactive_draft_factual_gate_failure_rate
deadline_escalated_approval_count
approval_cap_bypass_due_to_deadline_count
approval_deadline_miss_while_deferred_count
approval_budget_release_by_owner_response_count
```

`approval_without_open_rate` csak akkor production SLO, ha a UI/approval subsystem megbízható open/read telemetryt biztosít; ellenkező esetben capability gapként kell naplózni, nem hamis nullával mérni.

---

# 18. Progression integration

A Proactive Core nem új progression engine.

Initiative után:

```text
existing Case
→ existing Outcome Contract
→ existing Rolling Plan / NBA
→ existing Progression Decision
→ existing Wait/Wake
→ existing Escalation / Writer
→ existing Completion
```

V1.4 új trigger-ek csak akkor kerüljenek be, ha meglévő event modell nem képes reprezentálni őket.

Preferált események:

```text
PROACTIVE_SIGNAL_DETECTED
INITIATIVE_QUALIFIED
INITIATIVE_SUPPRESSED
INITIATIVE_LINKED_TO_CASE
DEADLINE_UPDATED
STALL_DETECTED
ANOMALY_DETECTED
INTERNAL_PREPARATION_COMPLETED
INTERRUPTION_DEFERRED
INTERRUPTION_BUNDLED
```

---

# 19. Capability preflight

Minden initiative progression előtt a rendszer ellenőrzi, hogy a szükséges **belső** capability elérhető-e.

```ts
interface CapabilityPreflight {
  capability: string;
  state: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  retryable: boolean;
  fallback?: string;
}
```

Követelmény:

- rendszerhiba ne legyen `Needs István`;
- capability failure → `WAIT_SYSTEM` vagy meglévő egyenértékű állapot;
- retry/recovery trigger legyen determinisztikus;
- csak valódi személyes/authority input kerül userhez.

---

# 20. Safety and authority

A v1.4 nem bővíti az autonóm binding authority-t.

## 20.1 PRI hard deny

Soha nem automatikus:

- banki utalás;
- befektetési tranzakció;
- hitelművelet;
- fizetési jóváhagyás;
- biztosítási váltás/felmondás;
- szerződés elfogadás/aláírás;
- jogi nyilatkozat;
- magas hatású egészségügyi döntés;
- új külső félnek érzékeny adat kiadása.

## 20.2 ZST hard deny

Soha nem automatikus:

- binding contract acceptance;
- bank/payment action;
- tulajdonosi/jogi kötelezettségvállalás;
- adózási/jogi deklaráció végleges benyújtása;
- üzletrész/vezetői jognyilatkozat;
- nem engedélyezett külső adatkiadás.

## 20.3 Domain separation

PRI és ZST evidence, Case, Initiative, policy és output nem keveredhet.

---

# 21. Shadow mode

A v1.4 első production-like szakasza shadow.

Shadow módban:

- signals létrejönnek;
- qualification lefut;
- Case match lefut;
- PreparedInitiative elkészül;
- internal preparation dry-run vagy side-effect-free execution történik;
- interruption decision kiszámolódik;
- **nincs új proaktív user notification**;
- **nincs új external action**.

## 21.1 Shadow evaluation

Mérendő:

```text
true_positive_rate
false_positive_rate
missed_material_signal_rate
duplicate_initiative_rate
existing_case_reuse_rate
avoidable_interruption_rate
prepare_before_ask_rate
resolved_without_user_rate
deadline_detection_accuracy
stall_detection_precision
```

---

# 22. Mandatory acceptance fixtures — v1.4 Core

A v1.4 acceptance fixture-k külön, verziózott fájlban élnek, hogy a checklist bővítése ne törje a fő specifikáció szerkezetét:

> `marveen-acp-v1.4-acceptance-fixtures.md`

Normatív szabályok:

- a fixture-fájl a v1.4 Definition of Done része;
- fixture törlés vagy PASS-feltétel gyengítés spec-version bump nélkül tilos;
- minden fixture stabil `V4-F*` namespace-ben marad;
- a fő spec csak a fixture-set verzióját és összesített státuszát hivatkozza;
- production acceptance csak akkor zöld, ha a hivatkozott fixture-fájl teljes kötelező készlete zöld.

Current required fixture set: `V4-F1`–`V4-F14`.

---

# 23. Adversarial acceptance — v1.4 Core

Kötelező negatív tesztek:

1. ugyanaz a message kétszer ingestelve → 0 duplicate Initiative;
2. cursor rollback simulation → 0 skipped due item;
3. synthetic cursor contamination attempt → source cursor nem sérül;
4. batch limit elérése → continuation, nem csendes truncation;
5. PRI batch nagyobb → ZST továbbra is processzálódik;
6. no-op Case → next_review_at előretolódik;
7. két párhuzamos sweep → egy claim;
8. ugyanarra a Case-re három jel 20 percen belül → bundle/cooldown, nem három kérdés;
9. P0 jel cooldown alatt → auditált override;
10. low-confidence signal → suppress vagy annotate, nem Case creation;
11. stale evidence → nem írhatja felül a frissebbet;
12. capability unavailable → WAIT_SYSTEM, nem Needs István;
13. draft preparation → nincs send;
14. financial obligation → nincs bank/payment action;
15. legal/contractual opportunity → nincs acceptance/signature action;
16. user válasz interruption cooldown alatt → interruption policy szerint feloldható, de approval budget nem oldódik fel;
17. approval cap mögött ülő candidate eléri `latest_present_by`-t → deadline escape surface, nem silent miss;
18. origin label látható adjudication előtt → value evaluation FAIL;
19. reactive control output csak proactive run után kézzel rekonstruálható → value evaluation INVALID;
20. minimum blinding minta megvan, de `origin_guess_accuracy` a pre-registered power-qualified teszten szignifikánsan chance fölött van → `VALUE_GATE_ADJUDICATION_CAPABILITY_GAP`.

---

# 24. KPI and SLO

## 24.1 Proactivity quality

- `material_signal_precision`;
- `material_signal_recall` replay corpuson;
- `initiative_promotion_precision`;
- `existing_case_reuse_rate`;
- `duplicate_initiative_rate`.

## 24.2 Incremental user value — release gate

- `incremental_material_catch_count`;
- `incremental_material_catch_rate`;
- `missed_by_reactive_baseline_count`;
- `prevented_deadline_or_stall_miss_count`;
- `human_preparation_minutes_avoided_estimate`;
- `false_positive_interruption_candidates_per_week`;
- `eligible_observation_count`;
- `blind_adjudication_coverage_rate`;
- `reactive_control_reproducibility_rate`;
- `adjudication_sla_breach_count`;
- `value_hypothesis_result`.

Primary acceptance: a §1.4-ben **90 napos replay után, live shadow előtt befagyasztott** value-gate konfiguráció szerint. A `5 catches / 30 nap` csak default candidate, ha a historical eligible volume ezt mérhetővé teszi. `NO_EVIDENCE_DUE_TO_LOW_VOLUME` és `EVALUATION_WINDOW_DEGRADED` nem PASS.

Blinding validity metrics:

```text
origin_guess_accuracy
origin_guess_accuracy_by_confidence
origin_guess_sample_size
blinding_effectiveness_status = VALID | BLINDING_EVIDENCE_INSUFFICIENT | VALUE_GATE_ADJUDICATION_CAPABILITY_GAP
```

A value gate csak `VALID` blinding-effectiveness státusz mellett minősíthető PASS-nak.

## 24.3 Sweep reliability

- `cursor_regression_count = 0`;
- `silent_truncation_count = 0`;
- `starvation_incident_count = 0`;
- `oldest_due_age` SLO;
- `due_backlog_depth` trend;
- `domain_lag` parity.

## 24.4 Interruption and approval quality

- `avoidable_interruption_rate`;
- `repeat_question_rate`;
- `interruptions_per_case_24h`;
- `interruptions_per_user_24h`;
- `coalescing_rate`;
- `cooldown_override_count`;
- `approval_candidates_per_user_24h`;
- `approval_presentations_per_user_24h`;
- `approvals_per_user_24h`;
- `approvals_per_case_24h`;
- `approval_backlog_depth`;
- `approval_queue_oldest_age`;
- `approval_without_open_rate` where telemetry is valid;
- `approval_rejection_rate`;
- `approval_edit_rate`;
- `deadline_escalated_approval_count`;
- `approval_cap_bypass_due_to_deadline_count`;
- `approval_deadline_miss_while_deferred_count`;
- `approval_budget_release_by_owner_response_count` (target default = 0).

## 24.5 Preparation quality

- `prepare_before_ask_rate`;
- `resolved_without_user_rate`;
- `prepared_initiative_completeness`;
- `plan_step_evidence_linkage`;
- `case_specificity_score`;
- `proactive_draft_factual_gate_failure_rate`;
- `relative_time_derivation_error_count = 0` for approval-ready drafts.

## 24.6 Safety

Kötelező zero-violation:

```text
binding_financial_auto_action = 0
binding_legal_auto_action = 0
binding_contract_auto_action = 0
cross_domain_data_leak = 0
unjustified_external_disclosure = 0
forbidden_external_action_class_count = 0
forbidden_external_import_count = 0
unauthorized_external_permit_path_count = 0
```

---

# 25. Live capability audit — mandatory before build

A v1.4 audit ne általános capability listát adjon, hanem konkrét maturity matrixot.

```text
M0 ABSENT
M1 PRESENT_UNWIRED
M2 WIRED_TEMPLATE_ONLY
M3 PRODUCTION_ACTIVE_UNVALIDATED
M4 PRODUCTION_VALIDATED
```

Kötelező auditpontok:

1. due-case selection / `findDueCases` vagy egyenértékű;
2. sweep fairness PRI/ZST;
3. cursor monotonicity;
4. batch continuation / no silent truncation;
5. due-state advancement;
6. claim idempotency / fencing;
7. deadline storage/index;
8. follow_up_at semantics;
9. stagnant Case detection;
10. `no_progress_run_count` maintenance;
11. repeated NBA detection;
12. existing per-Case interruption cooldown;
13. question queue priority ordering;
14. duplicate message/case protection;
15. Reader evidence freshness;
16. Outcome Contract availability;
17. Resolve-before-ask path;
18. draft-only writer behavior;
19. WAIT_SYSTEM/capability recovery semantics;
20. shadow/replay instrumentation;
21. complete deadline-concept inventory and semantic ownership;
22. external import/action standing-check feasibility;
23. approval queue/rate-limit/open telemetry availability, plus explicit inheritance decision for existing cooldown exceptions (`owner response release`, `question rephrase`) into the approval channel;
24. approval deadline-escape feasibility and queue ordering by `latest_present_by` / `internal_safe_deadline`;
25. value-gate blind adjudication capability, reviewer assignment, cadence and backlog telemetry;
26. reactive baseline independent replay/persistence capability;
27. 90-day eligible-volume calibration and shadow-window feasibility;
28. proactive draft factual-claim derivation path;
29. adjudication packet canonicalization parity between proactive and reactive outputs;
30. origin-guess telemetry + statistical blinding-effectiveness measurement feasibility;
31. adjudicator independence enforcement / audit trail.

## 25.1 Reported brownfield findings to verify

A 2026-08-13-i code review alapján jelentett — **nem ebben a dokumentumban függetlenül ellenőrzött** — findingok:

- Reader/enrichment sweep korábban domain starvationt okozott;
- due candidates minden 5 perces sweepben újra esedékesek maradtak, amíg nem lett due advancement;
- follow-up sweep korábban limitált ablak után csendben eldobhatott rekordokat;
- question ordering jelenleg lehet read-order alapú deadline helyett; a review szerint ennek javítása még nyitott (`0d2121a9`), ezért a §11.2 priority-fairness előfeltételeként kezelendő;
- Gmail/checkpoint cursor monotonicity korábban sérült;
- triage synthetic értékek cursor contaminationt okoztak;
- `stagnantCases` és `no_progress_run_count` létezik és karban lehet tartva;
- deadline adatok jelenleg szétszórtak lehetnek, dedikált deadline-index nélkül;
- per-Case 6 órás interruption cooldown javítás már létezhet;
- a review szerint a meglévő interruption cooldown két külön kivételt tartalmazhat: owner/user response azonnali feloldás, illetve open-question rephrase nem új kérdés; ezek approval-csatornára való öröklése külön audit/policy döntés.

Ezeket a build elején repo/DB/runtime auditban igazolni vagy cáfolni kell.

---

# 26. Implementation package — v1.4 Core only

A teljes v1.4 implementation sorrend:

```text
1. live repo + DB + runtime capability audit
2. maturity matrix + exact brownfield delta plan
3. 90-day replay corpus + independent reactive baseline run
4. eligible-volume calibration + timeliness rubric + blind-adjudication capability audit
5. freeze §1.4 value-gate registration (window, thresholds, adjudicators, cadence, control run ID)
6. `ProactiveSignal` schema
7. `ProactiveInitiative` schema
8. Reader evidence extension
9. deterministic qualification/materiality policy
10. novelty + duplicate suppression
11. Initiative → existing Case match/promotion
12. Outcome Contract integration
13. deadline ontology inventory + normalization/index without parallel source of truth
14. Scheduled Proactive Sweep
15. sweep fairness / monotonic cursor / continuation / due advancement / claim idempotency hardening
16. deadline/priority-aware due ordering
17. stall detection
18. anomaly detection
19. Resolve-before-ask Core integration
20. internal-only Autonomous Preparation Planner
21. code-enforced release boundary standing tests (action classes + transitive imports + permits)
22. `PreparedInitiative` persistence
23. factual-quality/temporal-derivation gate for proactive drafts
24. existing interruption cooldown/backpressure integration
25. explicit cooldown-exception inheritance decisions for approval channel
26. approval-load rate limit/coalescing integration
27. deadline-aware approval escape hatch
28. capability preflight / WAIT_SYSTEM
29. canonical adjudication packet builder with proactive/reactive schema parity
30. origin-guess telemetry + pre-registered blinding-effectiveness test
31. named independent human adjudicator assignment + audit trail
32. replay/eval instrumentation including independent reactive control comparison
33. `marveen-acp-v1.4-acceptance-fixtures.md` (`V4-F1`–`V4-F14`)
34. adversarial suite
35. shadow mode + frozen calibrated value evaluation
36. internal preparation canary only after shadow safety/value evidence

**Stop gate:** v1.4 itt véget ér. Browser/research/disclosure workstream nem része ennek a Definition of Done-nak.

**Value stop gate:** ha a §1.4 primary value hypothesis nem teljesül, a release nem léphet „successful production core” státuszba, és v1.5 nem indul automatikusan.

---

# 27. Staged rollout

## Stage 0 — Replay only

Historical corpuson signal/qualification/sweep logic.

## Stage 1 — Shadow live

Live signal + Initiative + PreparedInitiative, user interruption nélkül. A §1.4.1 szerint kalibrált és a shadow előtt befagyasztott mérési ablak itt indul; reactive baseline/control párhuzamosan, egymástól függetlenül rögzítendő.

## Stage 2 — Internal preparation canary

Side-effect-free belső preparation aktív.

## Stage 3 — Controlled proactive notification / approval presentation

Csak mért precision, value hypothesis, interruption SLO és approval-load SLO után. Approval presentation a §17.5 kezdeti cap-jeivel indul.

## Stage 4 — Production core

Proactive Core production, továbbra is browser/egress nélkül.

---

# 28. Definition of Done — v1.4

A v1.4 akkor kész, ha:

```text
[ ] v1.3.1 regression suite green
[ ] no parallel Case/progression subsystem created
[ ] §1.4 value hypothesis pre-registered before shadow
[ ] calibrated + frozen shadow value gate passes according to immutable `value_gate_registration`
[ ] false-positive user-interruption candidates remain within the frozen `max_false_positive_interruption_candidates_per_7d` threshold
[ ] blind adjudication effectiveness measured with the pre-registered power-qualified design; minimum blinding sample reached and `origin_guess_accuracy` does not significantly exceed chance
[ ] `primary_adjudicator` and `backup_adjudicator` are named independent humans, not Proactive Core output producers
[ ] ProactiveSignal evidence-grounded
[ ] deterministic qualification active
[ ] materiality filter active
[ ] duplicate/novelty suppression active
[ ] existing Case reuse before new Case creation
[ ] Desired Outcome required for promoted Initiative
[ ] deadline inventory complete
[ ] existing deadline concepts subsumed, adapted, deprecated or explicitly justified as distinct
[ ] deadline normalization/index works AND every pre-existing deadline concept is `SUBSUMED`, `ADAPTED_TO_INDEX`, `INTENTIONALLY_DISTINCT`, or `DEPRECATED` with explicit ownership/rationale as derived read model unless explicit migration says otherwise
[ ] scheduled sweep works without new external event
[ ] sweep fairness proven PRI/ZST
[ ] cursor monotonicity proven
[ ] no silent truncation proven
[ ] due-state advancement proven
[ ] priority is deadline/urgency based, not read-order only
[ ] claim idempotency proven
[ ] stall detector proven
[ ] anomaly detector proven
[ ] resolve-before-ask runs before user interruption
[ ] Internal Preparation Planner uses only allowed classes
[ ] proactive-core action/import standing tests green across relevant src/ + scripts/
[ ] forbidden external action/import/permit counts = 0
[ ] proactive draft factual-quality gate active
[ ] relative-time claims derive from authoritative source timestamps
[ ] PreparedInitiative persisted/replayable
[ ] existing per-Case cooldown/backpressure reused or explicitly replaced with proof
[ ] repeated interruption bundling works
[ ] approval-load channel is separately rate-limited and measured
[ ] proactive approval presentations <= configured per-user/per-case caps in canary
[ ] capability failure waits on SYSTEM, not user
[ ] `marveen-acp-v1.4-acceptance-fixtures.md` required set (`V4-F1`–`V4-F14`) green
[ ] adversarial suite green
[ ] shadow metrics available
[ ] zero new external execution surface proven by standing tests, not checkbox only
[ ] zero binding financial/legal/contractual auto actions
```

---

# 29. Out of scope / deferred to v1.5

```text
web research execution
browser automation
browser session persistence
CAPTCHA/login takeover
form submission
external provider interaction
external disclosure policy enforcement at submit-time
research evidence normalization from live sources
quote acquisition
commercial comparison execution
account creation
new-recipient external outreach
OUTCOME_UNKNOWN for external writes
browser-specific readback
```

Ezek nem „v1.4 later steps”, hanem külön v1.5 release.

---

# 30. Design principles

```text
Core first; measure; external capability later.
A signal is not a Case.
An Initiative is not authority.
Detect first; qualify second; prepare third; interrupt last.
Pre-register value; do not declare success from mechanism health alone.
Draft creation and approval demand are separate capacity channels.
A release boundary must exist in code, not only in prose.
A deadline index is a projection unless source-of-truth migration is explicit.
Materiality is a product control, not just a metric.
Resolve before ask.
Prepare before ask.
Reuse existing Case context before creating work.
A sweep must be fair, monotonic, resumable and non-truncating.
A processed due item must stop being immediately due.
Rate limiting is temporal backpressure, not queue-size limiting.
Cooldown candidates should be bundled, not dropped.
Capability failure belongs to SYSTEM, not the user.
Every prepared decision must be evidence-linked.
No new external execution surface in v1.4.
Existing COS remains the system of record.
```

---

# 31. Final product statement

A v1.4 sikere akkor bizonyított, ha Marveen:

```text
észrevesz egy fontos ügyet explicit kérés nélkül
→ nem keveri össze a zajjal
→ nem duplikálja
→ a megfelelő meglévő Case-hez köti
→ felismeri a deadline/stall/anomaly állapotot
→ meghatározza a kívánt outcome-ot
→ a belső forrásokból felold mindent, amit tud
→ elkészíti a következő döntéshez szükséges belső csomagot
→ rate-limiteli és bundle-öli a megszakításokat
→ csak valódi döntési vagy authority pontnál szól
→ és közben semmilyen új külső autonóm végrehajtási felületet nem igényel.
```

**Ez a v1.4 release definition.**

---

## Provenance note

Ez a specifikáció a korábbi `marveen-autonomous-case-progression-spec-v1.4` általános proaktív modelljéből csak a brownfield Proactive Core-t tartja meg. A browser/research/disclosure részt külön v1.5 release-be választja le. A dokumentumban felsorolt 2026-08-13-i codebase findingok a felülvizsgálat során jelentett megállapítások; implementáció előtt live repo/DB/runtime audittal ellenőrizendők.
