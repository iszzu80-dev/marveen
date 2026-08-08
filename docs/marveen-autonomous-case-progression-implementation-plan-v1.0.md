# Marveen Autonomous Case Progression Layer v1.0
## Részletes implementációs terv – Personal + ZST Chief of Staff

**Státusz:** review-ready implementációs terv; kódmódosítás még nem történt  
**Repo:** `Szotasz/marveen`  
**Baseline:** `develop` @ `832305827b7891dc7bfa90a36e98ad5d699c88c6` (2026-08-08)

## 1. Végleges architekturális döntés

A rendszerből **egy közös Autonomous Case Progression Kernel** készüljön, amely két izolált runtime-kontextusban fut:

```text
                         MARVEEN
                            │
                  Main Orchestrator
                            │
          Autonomous Case Progression Kernel
                            │
                   Domain Router / Gate
                  ┌─────────┴─────────┐
                  │                   │
                 PRI                 ZST
                  │                   │
         PRI DomainContext      ZST DomainContext
         PRI case state         ZST case state
         PRI connectors         ZST connectors
         PRI memory             ZST memory
         PRI policies           ZST policies
         PRI delegation         ZST delegation
                  │                   │
                  └─────────┬─────────┘
                            │
                   Controlled Action Path
                            │
                    Readback + Verify
                            │
                  Semantic Completion
```

**Alapelv:** `shared code != shared authority != shared context`.

Közös legyen a progression algoritmus, outcome contract, resolver, plan-to-done, wait/wake, escalation, delegation evaluator, action lifecycle, idempotency, recovery, completion verifier, KPI és UI-komponens.

Külön maradjon a PRI és ZST connectorprofil, credential, memória namespace, scope/risk policy, hard gate, delegation envelope, approval authority, címzetti szabályok, sensitivity, dokumentum- és retention-policy.

---

## 2. Kötelező működési filozófia

### Resolve before ask

Hiányzó információnál a sorrend:

```text
Case state/events
→ full email thread
→ linked Drive docs
→ Calendar
→ Contacts
→ domain-safe memory
→ allowed MCP/API
→ allowed web research
→ safe inference
→ csak ezután István
```

Istvánt csak olyan információért kérdezheti, amely tényleges blocker, máshonnan nem szerezhető meg, és nem biztonságos feltételezni.

### Plan to done

Minden Case kötelező mezői:

```text
goal
definition_of_done
success_evidence_requirements
rolling_plan
next_best_action
known_blockers
expected_waits
potential_escalations
```

### Execute within delegation

A policy vagy érvényes Delegation Envelope által már delegált lépéshez Marveen ne kérjen új approvalt.

### Interrupt only when blocked

Csak ezek valamelyikénél:

```text
INFORMATION_REQUIRED
DECISION_REQUIRED
APPROVAL_REQUIRED
CALL_REQUIRED
MANUAL_ACTION_REQUIRED
SECURITY_ESCALATION
RECOVERY_ESCALATION
```

### Verify outcome, not just action

`email_sent` nem jelenti, hogy a Case kész. `COMPLETED` csak a `definition_of_done` és az előírt bizonyíték teljesülésekor lehetséges.

---

## 3. Aktuális repo – gap map

### EXISTS – újrahasználandó

- Scheduler: `task`, `heartbeat`, `command`, retry queue, catch-up, stuck watchdog, általános `preCheck`, MCP pre-check.
- Autonomy: `seed-config/autonomy-config.json`, `store/autonomy-config.json`, `/api/autonomy`, level 1–3, `locked`, `maxLevel`.
- Approval: SQLite store, create/get/list/resolve, timeout, idempotens resolve, self-approval guard, `/api/approvals`.
- Agent fleet és inter-agent queue.
- Background tasks.
- Kanban hierarchy, assignee, aging, WIP.
- Memory + Skill Factory.
- Audit/web route minták.

### PARTIAL – bővítendő

- autonomy jelenleg kategória-szintű, nem context-aware;
- approval nincs Case + Action + payload-hash contracthoz teljesen kötve;
- schedulernek nincs due-Case progression source-a;
- nincs outcome-driven durable controller;
- nincs enforce-olt egyetlen külső write chokepoint.

### MISSING – valódi fejlesztési gap

- Case Store;
- `case_id` üzleti domainmodell;
- Progression Kernel;
- Outcome Contract;
- Resolve-before-ask resolver;
- rolling Plan-to-Done;
- Delegation Envelope;
- context-aware policy approval;
- Progression Run Ledger;
- Case Escalation Store;
- Semantic Completion Verifier;
- Controlled Action Executor/write gateway;
- kódosan enforce-olt PRI/ZST Case runtime.

---

## 4. Fontos implementációs döntések

1. **Nem vezetünk be LangGraphot, Temporalt vagy n8n-t.** A Marveen saját SQLite + scheduler + retry + orchestrator + approval + MCP primitívjei elegendők.
2. **A Progression Kernel nem külön permanens LLM-agent.** A determinisztikus alkalmazásréteg kezeli a state-et/policyt/lockot/actiont; a main orchestrator végzi a célértelmezést, tervezést és next-best-action reasoninget.
3. **Első verzióban közös fizikai SQLite, hard domain scopinggal.** Minden üzleti rekord kötelező `domain` mezőt kap, minden repository/API kötelező DomainContextet vár. Cross-domain query alapértelmezetten tiltott.
4. **A Kanban task projection marad, nem Case Store.**
5. **A meglévő Approval Store marad és bővül.**

---

## 5. Javasolt új core modul

```text
src/progression/
  types.ts
  domain-context.ts
  case-service.ts
  engine.ts
  planner-contract.ts
  context-resolver.ts
  policy.ts
  delegation.ts
  action-executor.ts
  completion.ts
  waits.ts
  escalations.ts
  recovery.ts
  metrics.ts
```

A tiszta decision/policy logika legyen I/O-mentes és unit tesztelhető.

---

## 6. DomainContext

```typescript
type DomainId = 'PRI' | 'ZST'

interface DomainContext {
  domain: DomainId
  connectorProfile: string
  memoryNamespace: string
  allowedSourceAccounts: string[]
  allowedMcpServers: string[]
  allowedDriveRoots: string[]
  allowedCalendars: string[]
  scopePolicyId: string
  riskPolicyId: string
  delegationPolicyId: string
  completionPolicyId: string
  notificationTarget: string
}
```

Egy progression run alatt a domain nem változhat.

Cross-domain információ csak explicit bridge proposal → scope/sensitivity check → minimális/redacted payload → külön target-domain event/case útvonalon mehet át.

---

## 7. Mikor legyen valamiből Case?

### Case nyíljon/frissüljön, ha

- tartós cél van;
- külső fél/rendszer érintett;
- több lépés kell;
- follow-up várható;
- határidő vagy döntés van;
- dokumentum/számla/garancia kapcsolódik;
- külső action várható;
- István „intézd”, „kövesd”, „oldjuk meg”, „foglaljuk”, „szerezz ajánlatot” jellegű utasítást ad.

### Ne nyíljon Case

- egyszeri információs kérdésre;
- rövid magyarázatra;
- tiszta ötletelésre;
- hipotetikus témára következő lépés nélkül.

Case matching elsőbbség:

```text
explicit case id
→ email thread id
→ booking/order/document id
→ calendar event id
→ contact + subject + active-case evidence
→ semantic match
```

Bizonytalan match → `TRIAGE_REQUIRED`, ne automatikus duplikált Case.

---

## 8. Case adatmodell

Új `cases` tábla minimum:

```text
case_id TEXT PRIMARY KEY
domain TEXT NOT NULL
case_type TEXT NOT NULL
category TEXT
status TEXT NOT NULL
priority TEXT NOT NULL
owner_agent TEXT

title TEXT NOT NULL
summary TEXT

goal TEXT NOT NULL
definition_of_done_json TEXT NOT NULL
success_evidence_requirements_json TEXT
semantic_completion_status TEXT DEFAULT 'unknown'

rolling_plan_json TEXT
plan_version INTEGER DEFAULT 1
next_best_action_json TEXT

waiting_on TEXT
blocked_reason TEXT
next_progression_at INTEGER
follow_up_at INTEGER
due_at INTEGER

sensitivity TEXT
risk_class TEXT
policy_profile TEXT

source_refs_json TEXT
related_contact_ids_json TEXT
related_document_ids_json TEXT
related_calendar_ids_json TEXT
related_email_threads_json TEXT
related_kanban_ids_json TEXT

version INTEGER DEFAULT 1
created_at INTEGER
updated_at INTEGER
completed_at INTEGER
archived_at INTEGER
closure_reason TEXT
```

Indexek: `(domain,status)`, `(domain,next_progression_at)`, `(domain,due_at)`, `(domain,updated_at)`.

---

## 9. Case Event Ledger

Új append-only `case_events`:

```text
event_id
case_id
domain
case_version
event_type
source_type
source_reference
actor
summary
payload_json
created_at
correlation_id
```

Kötelező eventek:

`CASE_CREATED`, `GOAL_DEFINED`, `PLAN_CREATED`, `PLAN_REVISED`, `INFORMATION_RESOLVED`, `ACTION_PROPOSED`, `ACTION_VERIFIED`, `WAIT_STARTED`, `WAIT_RESUMED`, `ESCALATION_CREATED`, `ESCALATION_RESOLVED`, `COMPLETION_PROPOSED`, `CASE_COMPLETED`, `CASE_REOPENED`, `RECOVERY_STARTED`, `RECOVERY_COMPLETED`.

---

## 10. Outcome Contract

```typescript
interface OutcomeContract {
  goal: string
  definitionOfDone: CompletionCriterion[]
  successEvidenceRequirements: EvidenceRequirement[]
  forbiddenShortcuts?: string[]
}
```

Példa: hátsó lépcső

```yaml
goal: A hátsó kerti lépcső biztonságosan legyen kicserélve.

definition_of_done:
  - vállalkozó kiválasztva
  - időpont lezajlott
  - munka elkészült
  - teljesítés igazolt
  - végleges költség rögzítve
  - számla elmentve
  - garancia rögzítve, ha van
```

---

## 11. Rolling Plan-to-Done

A terv ne legyen statikus BPMN. Aktív horizont: 3–7 érdemi lépés.

Újratervezés:

- új külső válasz;
- action eredmény;
- decision;
- capability változás;
- wait timeout;
- új dokumentum;
- István célmódosítása;
- három egymást követő no-progress run.

---

## 12. Resolve-before-ask resolver

`context-resolver.ts` read-only kimenete:

```typescript
interface ResolutionResult {
  resolvedFacts: Fact[]
  unresolvedBlockers: MissingFact[]
  evidence: SourceEvidence[]
  confidence: number
  sourcesAttempted: string[]
  safeToInfer: boolean
}
```

`ASK_INFORMATION` csak ha:

```text
required blocker
AND nincs további engedélyezett forrás
AND inferencia-confidence a küszöb alatt
```

Minden kérdésnél auditálni kell, hol keresett már Marveen.

---

## 13. Progression Decision

```typescript
type ProgressionDecision =
  | 'CONTINUE_AUTONOMOUSLY'
  | 'WAIT_EXTERNAL'
  | 'WAIT_TIME'
  | 'ASK_INFORMATION'
  | 'REQUEST_DECISION'
  | 'REQUEST_APPROVAL'
  | 'CALL_REQUIRED'
  | 'MANUAL_ACTION_REQUIRED'
  | 'RECOVERY_REQUIRED'
  | 'COMPLETE'
```

A Case státusz azt mondja, **hol tart az ügy**. A Progression Decision azt, **mit kell most tenni**.

---

## 14. Progress Delta és stalled detection

Valódi progress:

- új releváns információ;
- blocker eltűnt;
- külső dependency előrelépett;
- decision resolved;
- completion criterion teljesült;
- meaningful state change.

Tool call önmagában nem progress.

Három egymást követő no-progress run:

```text
alternative plan
→ recovery
→ csak ezután escalation
```

---

## 15. Wait/Wake

Új `case_waits`:

```text
wait_id
case_id
domain
wait_type
wait_condition_json
status
waiting_on
started_at
next_wake_at
timeout_at
followup_count
max_followups
followup_policy_json
escalation_policy_json
resolved_at
resolution_reference
```

Típusok: `WAIT_EXTERNAL`, `WAIT_TIME`, `WAIT_EVENT`, `WAIT_USER`, `WAIT_CAPABILITY`.

Két scheduled task:

```text
personal-case-progression-wake
zst-case-progression-wake
```

Ugyanazt a shared kernelt hívják. `preCheck`: 0 due Case → `SKIP`; csak valódi esedékességnél legyen LLM-run.

---

## 16. Needs István / escalation

Új `case_escalations`:

```text
escalation_id
case_id
domain
type
question
context_summary
options_json
recommendation
recommendation_reason
urgency
deadline
status
created_at
notified_at
resolved_at
resolution_json
```

Típusok: `INFORMATION`, `DECISION`, `APPROVAL`, `CALL`, `MANUAL_ACTION`, `SECURITY`, `RECOVERY`.

Kötelező Decision Package:

1. mi az ügy;
2. mit intézett már Marveen;
3. miért nem tud továbbmenni;
4. opciók;
5. Marveen ajánlása;
6. pontosan mi kell Istvántól;
7. határidő.

---

## 17. Delegation Envelope

A jelenlegi `email_send maxLevel=2` logikát nem írjuk át globális level 3-ra.

Új `delegation_envelopes`:

```text
envelope_id
domain
name
enabled
action_type
case_types_json
allowed_intents_json
recipient_scope_json
target_system_scope_json
data_class_scope_json
constraints_json
max_financial_commitment
currency
existing_thread_only
requires_readback
valid_from
valid_until
created_by
created_at
revoked_at
policy_hash
```

PRI példa: existing vendor thread + factual reply / clarification / quote request / routine follow-up / scheduling question; financial commitment 0; offer acceptance és payment tiltott.

ZST példa: accountant allowlist + requested document / missing invoice / factual accounting clarification; payment, tax/legal commitment és contract acceptance tiltott.

---

## 18. Policy evaluator

```typescript
interface PolicyDecision {
  result: 'AUTO_ALLOW' | 'HUMAN_APPROVAL' | 'DENY'
  reason: string
  envelopeId?: string
}
```

Sorrend:

```text
HARD GATE
→ domain scope
→ autonomy maxLevel
→ action risk
→ envelope match
→ recipient/target
→ data class/payload
→ financial commitment
→ expiry
→ capability
```

`AUTO_ALLOW` kizárólag determinisztikus policy eredmény lehet.

---

## 19. Meglévő Approval Store bővítése

Nem új rendszer.

Opcionális új mezők:

```text
case_id
action_id
approval_kind
approval_source
delegation_envelope_id
payload_hash
target_reference
recipient
valid_until
consumed_at
policy_evaluation_hash
```

`approval_kind`: `HUMAN_ONE_SHOT` vagy `STANDING_DELEGATION`.

Standing delegationt a determinisztikus policy service igazol, nem az agent hagyja jóvá saját magának.

---

## 20. Controlled Action Executor / write gateway

Automatikus külső action előtt ez kötelező P0 elem.

Agent csak `ActionProposal`-t készíthet.

```text
action_id
case_id
domain
action_type
intent
target_system
target_reference
recipient
payload_json
payload_hash
idempotency_key
risk_class
status
approval_id
delegation_envelope_id
```

Lifecycle:

```text
PROPOSED
→ POLICY_EVALUATED
→ AWAITING_APPROVAL / APPROVED
→ CLAIMED
→ EXECUTING
→ APPLIED / OUTCOME_UNKNOWN
→ VERIFYING
→ VERIFIED / RECOVERY_REQUIRED
```

Végrehajtási sorrend:

```text
case version
→ domain
→ goal version
→ hard gate
→ policy/envelope
→ approval
→ capability
→ action lock
→ idempotency
→ execute
→ readback
→ verify
→ event
```

**Kritikus:** write-capable MCP/API tool nem maradhat megkerülhető közvetlen útvonalon. A side effectnek Action Executor/Write Gateway chokepoint-on kell átmennie. Read toolok maradhatnak közvetlenek.

---

## 21. Exactly-once + readback

Minden külső action determinisztikus idempotency key-t kap.

E-mail példa:

```text
case_id + normalized_recipient + intent + thread_id + payload_hash
```

Timeout:

```text
OUTCOME_UNKNOWN
→ readback
→ megtörtént: VERIFIED
→ biztosan nem történt meg: retry
→ nem dönthető el: RECOVERY_REQUIRED
```

Vak retry tiltott.

---

## 22. Hard gate-ek

### PRI – soha nem automatikus

- banki utalás;
- befektetés;
- hitel;
- szerződéses/jogi commitment;
- jelentős egészségügyi döntés;
- érzékeny új adatmegosztás;
- nagy vagy nehezen visszafordítható rendelés/foglalás;
- telefon, amíg nincs megbízható phone-agent.

### ZST – soha nem automatikus

- banki tranzakció;
- befektetés;
- contract signature;
- jogi nyilatkozat;
- kötelező erejű ajánlatelfogadás;
- joghatású tax/authority submission;
- hosszú távú licenc/subscription commitment;
- tulajdonosi döntés.

---

## 23. PRI policy v1

**Auto:** Case/event update, research, Gmail/Drive/Calendar/Contacts read, dokumentumlink, rolling plan, wait/wake, Kanban projection, draft, offer normalization, completion evidence.

**Envelope után auto:** existing-thread vendor clarification, routine follow-up, quote clarification, non-binding scheduling question.

**Human approval:** első új külső címzett, végleges időpontcommitment, booking, order, offer acceptance, új cím/telefon megosztás.

**Hard deny auto:** payment, investment, contract/legal commitment.

---

## 24. ZST policy v1

**Auto:** Case/event update, invoice/receipt recognition, read-only bank reconciliation, accounting package prep, Drive organization, research, partner context resolution, Product Lab executive projection, deadline tracking, draft.

**Envelope után auto:** accountant requested-document flow, missing invoice request, existing-vendor factual clarification, routine admin follow-up.

**Human approval:** új partner, pricing/offer communication, érzékeny dokumentummegosztás, external invite, supplier choice, subscription renewal.

**Hard deny auto:** bank, contract signature, legal/tax commitment, ownership decision.

---

## 25. Semantic Completion

```typescript
interface CompletionAssessment {
  result: 'INCOMPLETE' | 'READY_TO_COMPLETE' | 'NEEDS_CONFIRMATION'
  satisfiedCriteria: string[]
  missingCriteria: string[]
  evidenceRefs: string[]
  confidence: number
}
```

`COMPLETED` csak ha:

```text
mandatory DoD teljesült
AND evidence megvan
AND nincs unresolved mandatory action/wait
AND nincs OUTCOME_UNKNOWN action
```

---

## 26. Mission Control UI

A jelenlegi dashboard bővüljön, ne legyen külön app.

### Cases

Filter: All / PRI / ZST / Active / Waiting / Needs István / Stalled / Completed.

Case card: domain, outcome, status, next automatic step, next wake, „Tőlem kell?”, progress age.

### Case detail

Fent mindig:

```text
OUTCOME
MARVEEN MOST
KÖVETKEZŐ AUTOMATIKUS LÉPÉS
TŐLEM KELL?
```

Alatta rolling plan, waits, actions, evidence, history.

### Needs István

Egy közös inbox domain badge-dzsel: Decision / Approval / Information / Call / Manual / Security / Recovery.

### Autonomy

A jelenlegi level 1–3 szekció marad. Mellé új „Delegált rutinok” szekció envelope-okkal.

### Kill switches

```text
Global Progression ON/OFF
PRI Progression ON/OFF
ZST Progression ON/OFF
PRI External Actions ON/OFF
ZST External Actions ON/OFF
```

Case szinten Pause / Resume / Force review.

---

## 27. API

Új route-ok:

```text
src/web/routes/cases.ts
src/web/routes/progression.ts
src/web/routes/delegations.ts
src/web/routes/escalations.ts
```

Minimum API:

```text
GET/POST /api/cases
GET/PATCH /api/cases/:id
POST /api/cases/:id/transition
POST /api/cases/:id/progress
POST /api/cases/:id/pause
POST /api/cases/:id/resume
GET /api/cases/due?domain=PRI
GET /api/cases/:id/events
GET /api/cases/:id/actions
GET /api/cases/:id/progression-runs

GET/PATCH /api/escalations
GET/POST/PATCH /api/delegations
```

Később:

```text
POST /api/actions/propose
POST /api/actions/:id/execute
POST /api/actions/:id/recover
```

---

## 28. Progression Run Ledger

Új `case_progression_runs`:

```text
progression_run_id
case_id
domain
trigger_type
trigger_reference
case_version_before
case_version_after
context_hash
plan_version_before
plan_version_after
decision
reason
progress_delta_json
proposed_action_ids_json
executed_action_ids_json
escalation_id
started_at
completed_at
status
error_code
error_summary
```

Trigger: USER_INPUT, EMAIL_DELTA, CALENDAR_EVENT, DRIVE_EVENT, WAIT_WAKE, FOLLOW_UP_DUE, APPROVAL_RESOLVED, DECISION_RESOLVED, ACTION_VERIFIED, RECOVERY, MANUAL_RUN.

---

## 29. Scheduler + concurrency

Két domain wake task, közös kernel.

A due-case preCheck csak id/version/reason payloadot adjon, ne teljes contextet.

Kötelező:

- optimistic Case version;
- progression claim lease;
- Action lock;
- idempotency key;
- stale claim cleanup.

Két párhuzamos triggerből csak egy üzleti transition lehessen.

---

## 30. Goal change

István célmódosításakor:

1. `GOAL_CHANGED` event;
2. Case version nő;
3. plan invalid;
4. pending ActionProposalok cancel;
5. végrehajtott actionök auditban maradnak;
6. új DoD;
7. re-plan.

External action előtt Case/Goal version check kötelező.

---

## 31. Security

P0 incident:

- PRI/ZST contamination;
- external action Action Ledger nélkül;
- external action approval/policy nélkül;
- direct write bypass;
- wrong recipient;
- duplicate action;
- prompt-injection miatt módosult goal/policy.

Email, dokumentum és web untrusted data; nem módosíthat policyt, envelope-ot, goal-t, hard gate-et vagy recipient allowlistet.

---

## 32. KPI-k

Fő termék KPI:

- **Autonomous Resolution Rate**
- **Interruptions per Closed Case**
- **Avoidable Interruption Rate**
- **Semantic Reopen Rate**

Operációs:

- time-to-resolution;
- waiting SLA miss;
- follow-up miss;
- stalled rate;
- recovery rate;
- OUTCOME_UNKNOWN;
- duplicate prevented.

Safety célérték: **0** unauthorized action, wrong recipient, cross-domain leakage, payment execution, contract commitment, premature completion.

---

## 33. Replay/eval minimum

Legalább:

- 25 PRI történeti workflow;
- 25 ZST történeti workflow;
- 10 waiting/follow-up;
- 10 decision/approval;
- 10 email thread;
- 5 failure/recovery.

Kötelező scenario-k: Case match/create, ambiguous match, Drive/email resolve-before-ask, routine envelope match, offer acceptance block, wrong recipient, sensitive data block, restart/wake, timeout readback, duplicate prevention, goal change, premature completion, phone escalation, cross-domain isolation, prompt injection, stalled handling, envelope revoke, kill switch.

---

## 34. Rollout

### Phase 0 – Repo audit / contract freeze
Exact EXISTS/PARTIAL/MISSING/CONFLICT map. Külön direct MCP write bypass és memory namespace audit.

### Phase 1 – Case Foundation
DomainContext, Case Store, events, Outcome Contract, transitions, API, basic UI, scope enforcement.

### Phase 2 – Shadow Progression
Resolver, rolling plan, next-best-action, progression runs, escalation proposal, completion proposal. **Nincs external action.**

### Phase 3 – Internal Autonomy
Auto Case update, research, read-only resolution, plan, Kanban, wait/wake, draft, evidence.

### Phase 4 – Action Executor + Delegation
Action Ledger, write gateway, readback, policy evaluator, envelope store/UI, approval extension, kill switches. External action még shadow.

### Phase 5 – PRI Canary
Csak existing-thread vendor clarification / routine follow-up / quote clarification / non-binding scheduling. Először test mailbox, majd kevés valós Case. Gate: min. 20 verified action, 0 incident.

### Phase 6 – ZST Canary
Accountant requested-document, missing invoice, existing-vendor factual clarification, routine admin follow-up. Gate: min. 20 verified action, 0 incident.

### Phase 7 – Optimization
Interruption KPI, skill proposalok, envelope-expansion javaslatok, domain template-ek. Envelope bővítést csak István aktiválhat.

---

## 35. Munkacsomagok

```text
WP0 Baseline audit
WP1 Case Store + Domain Gate
WP2 Outcome + Planning
WP3 Resolver + Escalation
WP4 Wait/Wake + Scheduler
WP5 Progression Kernel Shadow
WP6 Semantic Completion
WP7 Action Executor
WP8 Delegation + Approval extension
WP9 Mission Control
WP10 PRI domain pack
WP11 ZST domain pack
WP12 Replay/Evals + Rollout
```

---

## 36. Javasolt fájlstruktúra

```text
src/progression/*
src/web/routes/cases.ts
src/web/routes/progression.ts
src/web/routes/delegations.ts
src/web/routes/escalations.ts

src/__tests__/
  case-store.test.ts
  domain-isolation.test.ts
  progression-engine.test.ts
  context-resolver.test.ts
  delegation-policy.test.ts
  action-executor.test.ts
  semantic-completion.test.ts
  wait-wake.test.ts
  progression-recovery.test.ts

seed-config/
  progression-config.json
  domain-policies/pri.json
  domain-policies/zst.json

seed-skills/case-progression/
  SKILL.md
  references/

scripts/progression-precheck.sh
```

DB schema/CRUD kezdetben követheti a jelenlegi `src/db.ts` mintát; külön DB-refaktor ne legyen prerequisite.

---

## 37. Default config

```json
{
  "version": 1,
  "globalEnabled": false,
  "externalActionsEnabled": false,
  "maxActionsPerRun": 5,
  "maxPlanSteps": 7,
  "maxNoProgressRuns": 3,
  "defaultClaimMinutes": 10,
  "domains": {
    "PRI": {
      "enabled": false,
      "externalActionsEnabled": false,
      "policyProfile": "pri-v1",
      "memoryNamespace": "PRI"
    },
    "ZST": {
      "enabled": false,
      "externalActionsEnabled": false,
      "policyProfile": "zst-v1",
      "memoryNamespace": "ZST"
    }
  }
}
```

Update/install csak új mezőt merge-eljen, runtime user settinget ne írjon felül.

---

## 38. Migráció

A már kialakított Personal/ZST migráció használható.

Personal Todo Master:

- Ügyek → Case current state;
- Eseménynapló → history;
- Döntések → decision/escalation refs;
- Draftok → artifact/action refs;
- Rules → PRI policy input;
- Futások → történeti audit, nem visszamenőleg kitalált progression run.

ZST Control Tower → domain ZST.

Importált Case-ek:

```text
progression_enabled = false
semantic_completion_status = unknown
```

Csak explicit shadow activation után indul progression.

---

## 39. Definition of Done

A Progression Layer csak akkor kész, ha:

1. egy közös kernel működik;
2. PRI/ZST izoláció kódos;
3. Case Store persistens;
4. restart után folytatható;
5. Outcome Contract kötelező;
6. Resolve-before-ask működik;
7. rolling plan működik;
8. waiting wake-el;
9. stalled detection működik;
10. Needs István strukturált;
11. existing approval store reused;
12. Delegation Envelope működik;
13. hard gate megkerülhetetlen;
14. external action egy controlled writeren megy;
15. idempotency + readback működik;
16. OUTCOME_UNKNOWN nincs vak retry;
17. semantic completion evidence-driven;
18. cross-domain tests zöldek;
19. Cases/Needs István/Delegation UI működik;
20. kill switches működnek;
21. replay suite zöld;
22. shadow mode éles adaton lefutott side effect nélkül;
23. PRI canary 0 incident;
24. ZST canary 0 incident;
25. Autonomous Resolution és Interruption KPI mérhető.

---

## 40. Nem része v1-nek

- automatikus banki tranzakció;
- automatikus befektetés;
- automatikus contract signature;
- autonóm jogi commitment;
- teljes phone-agent;
- Temporal/LangGraph/n8n;
- két külön progression kódbázis;
- automatikus envelope-bővítés;
- globális korlátlan email-send level 3.

---

## 41. Legnagyobb kockázatok

### P0 Write bypass
**Mitigáció:** controlled write gateway, write-capable tool scope szűkítés.

### P0 Cross-domain leakage
**Mitigáció:** mandatory DomainContext, connector allowlist, scoped repository API, isolation tests.

### P0 Premature completion
**Mitigáció:** Outcome Contract + evidence-based Completion Verifier.

### P1 Túl sok kérdés
**Mitigáció:** Resolve-before-ask + Avoidable Interruption KPI + bundled escalations.

### P1 Agent loop/tokenégetés
**Mitigáció:** preCheck, max actions/run, max plan steps, no-progress threshold, wait states.

### P1 Túl széles standing delegation
**Mitigáció:** intent/recipient/case/data constraints, expiry, revoke, policy hash.

### P1 Stale goal
**Mitigáció:** Case + Goal version check action előtt.

---

## 42. Végső implementációs sorrend

```text
Case Store
→ Outcome Contract
→ Shadow Progression
→ Resolve-before-ask
→ Internal Autonomy
→ Wait/Wake
→ Semantic Completion
→ Controlled Action Executor
→ Delegation Envelope
→ PRI Canary
→ ZST Canary
→ Learning / Optimization
```

**Fő design-elv:**

> Marveen gondolkodhat, olvashat, kutathat, tervezhet és belső state-et kezelhet agresszíven autonóm módon; kifelé ható és kötelezettséget teremtő műveleteknél viszont a szabadsága csak determinisztikusan definiált delegation boundarykon belül nőhet.

## Következő 3 lépés

1. Ez a shared Progression spec legyen a fejlesztési baseline; a Personal és ZST specifikáció csak hivatkozzon rá és tartalmazza a domain policy deltát.
2. Következő deliverable a `develop` exact file-by-file WP0 change set.
3. Utána Phase 1–2 implementáció: Case Foundation + teljes Shadow Progression, külső side effect nélkül.
