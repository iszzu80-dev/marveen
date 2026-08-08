# Marveen Autonomous Case Progression Layer v1.1
## Brownfield, single-build implementation plan – Personal + ZST Chief of Staff

**Státusz:** revised implementation baseline  
**Fő változás:** greenfield Case Engine helyett a már működő COS Case Layer progression-bővítése  
**Implementációs stratégia:** egy koherens fejlesztési csomag, több belső safety/activation gate-tel  
**Aktiválási alapelv:** build together, activate progressively

---

# 1. Mi változott a v1.0-hoz képest?

A live Marveen runtime review alapján már létezik és használatban van:

- `personal_cases`
- `zst_cases`
- `personal_case_events`
- `src/cos/case-store.ts`
- `src/cos/case-engine-core.ts`
- email → case intake
- Mission Control COS case integration

A live audit szerint 48 Personal Case, 27 ZST Case és 182 Personal Case Event van.

Ezért a fejlesztés **nem új Case Store és Case Engine létrehozása**, hanem a meglévő, éles COS Case Layer outcome-driven autonomous progression képességgel történő kibővítése.

---

# 2. Végleges architekturális döntés

A meglévő COS Case Layer marad a system of record.

```text
                 EXISTING MARVEEN COS LAYER
                           │
                 email/user/event intake
                           │
               ┌───────────┴───────────┐
               │                       │
        personal_cases             zst_cases
               │                       │
        Personal Case Engine       ZST Case Engine
               │                       │
               └───────────┬───────────┘
                           │
              SHARED PROGRESSION KERNEL
                           │
                 DomainContext / Gate
                           │
          Outcome + Resolver + Plan-to-Done
                           │
                 Next Best Action
                           │
                 Policy / Delegation
                           │
                Controlled Action Path
                           │
                  Readback / Verify
                           │
                Semantic Completion
```

Nem készül új generic Case Store, új párhuzamos Case Engine vagy duplicate intake pipeline.

A közös kernel domain adaptereken keresztül dolgozik a meglévő Personal és ZST store-okon.

---

# 3. Baseline-kezelés

A specifikáció nem pinelhet vakon bare upstream SHA-ra.

A runtime review szerinti tényleges baseline:

```text
live develop: c8312b3
Marveen: 1.31.0
```

Implementáció előtt kötelező újrapinelni:

```text
git rev-parse HEAD
git status
package/version
live DB schema dump
src/cos tree inventory
current Mission Control routes/UI
current intake paths
```

A funkcionális specifikáció stabil; a commit SHA-t közvetlenül implementáció előtt kell a live working tree-re rögzíteni.

---

# 4. Új gap map

## EXISTS

- Personal Case Store
- ZST Case Store
- Case Engine Core
- Case event/history
- Case lifecycle
- email → Case intake
- Mission Control Case megjelenítés
- scheduler/retry/heartbeat/MCP precheck
- approvals/autonomy
- Kanban/background tasks/agent fleet
- audit/memory/connectors

## PARTIAL

- Outcome Contract
- explicit Definition of Done
- outcome-driven progression loop
- Resolve-before-ask
- rolling Plan-to-Done
- Next Best Action contract
- waiting/follow-up mint first-class progression primitive
- semantic completion
- context-aware delegation
- controlled write chokepoint
- progression audit

## MISSING

- shared Progression Kernel
- Progression Run Ledger
- structured Escalation / Needs István
- Delegation Envelope
- Controlled Action Executor / write gateway
- Semantic Completion Verifier
- replay/eval harness a progression lifecycle közepén

---

# 5. Egyben fejlesztés – de nem egyben aktiválás

A teljes funkció **egy koherens implementation branch / implementation request** legyen.

Egyben épüljön meg:

```text
A. Existing COS model extensions
B. Progression Kernel
C. Resolver
D. Planning / Next Best Action
E. Wait/Wake
F. Semantic Completion
G. Escalation / Needs István
H. Eval / Replay Harness
I. Delegation Envelope
J. Controlled Action Executor
K. Mission Control UI
L. PRI/ZST policy packs
M. Migration / backward compatibility
```

De az authority gate-ek maradnak:

```text
GATE 0 — regression/eval infrastructure
GATE 1 — shadow progression
GATE 2 — internal autonomous progression
GATE 3 — external-action shadow
GATE 4 — narrow PRI external canary
GATE 5 — narrow ZST external canary
```

**One build, staged authority.**

---

# 6. Thin vertical slice az implementáción belül

Nem külön release, hanem korai proof point:

```text
existing Personal/ZST Case
→ Outcome Contract
→ resolver
→ rolling plan
→ Next Best Action
→ progression run
→ shadow result
→ Mission Control display
```

Nincs side effect.

Ha ez stabil, ugyanazon fejlesztés folytatódik a teljes scope-pal.

---

# 7. Meglévő Case Store kiterjesztése

Nem készül új `cases` tábla.

Preferált megoldás, ha a meglévő Personal és ZST schema elég közel áll:

```text
goal
definition_of_done_json
success_evidence_requirements_json
semantic_completion_status
rolling_plan_json
plan_version
next_best_action_json
progression_enabled
progression_mode
next_progression_at
last_progressed_at
progression_claimed_by
progression_claim_expires_at
blocked_reason
waiting_on
interruption_count
no_progress_run_count
goal_version
case_version
```

Alternatíva, ha a két live schema erősen eltér:

```text
case_progression_state(
  domain,
  case_id,
  ...
)
```

Unique `(domain, case_id)`.

A shared extension table kizárólag progression-specifikus állapotot tarthat; a Case system of record továbbra is a meglévő COS store.

---

# 8. Event ledger

A meglévő event/history rendszer bővüljön, ne készüljön párhuzamos generic event store.

Új event type-ok:

```text
GOAL_DEFINED
GOAL_CHANGED
OUTCOME_CONTRACT_UPDATED
PROGRESSION_STARTED
PLAN_CREATED
PLAN_REVISED
INFORMATION_RESOLVED
ACTION_PROPOSED
ACTION_VERIFIED
WAIT_STARTED
WAIT_RESUMED
ESCALATION_CREATED
ESCALATION_RESOLVED
COMPLETION_PROPOSED
CASE_COMPLETED_SEMANTICALLY
RECOVERY_STARTED
RECOVERY_COMPLETED
```

---

# 9. Outcome Contract

Minden progression-enabled Case kap:

```typescript
interface OutcomeContract {
  goal: string
  definitionOfDone: CompletionCriterion[]
  successEvidenceRequirements: EvidenceRequirement[]
  forbiddenShortcuts?: string[]
}
```

Legacy Case-eknél `progression_enabled=false`, amíg az outcome nincs megbízhatóan előállítva.

Nem kell az összes live Case-t bulkban kézzel migrálni. Megengedett lazy enrichment:

```text
case becomes active/due
→ proposed outcome contract
→ validation
→ save
→ shadow progression
```

---

# 10. Resolve-before-ask

Sorrend:

```text
current Case
→ Case events/history
→ full email thread
→ linked Drive docs
→ Calendar
→ Contacts
→ domain-safe memory
→ allowed MCP/API
→ permitted web research
→ safe inference
→ István
```

`ASK_INFORMATION` csak ha az információ szükséges, nem szerezhető meg engedélyezett forrásból, nem biztonságos feltételezni és ténylegesen blokkolja a progresszt.

Minden user interruption auditálja:

```text
sources_attempted
facts_found
remaining_gap
why_blocking
```

---

# 11. Rolling Plan-to-Done

Aktív horizont: 3–7 érdemi lépés.

Újratervezés trigger:

- új email;
- új dokumentum;
- action result;
- approval/decision;
- wait timeout;
- capability change;
- goal change;
- no-progress threshold.

---

# 12. Progression Kernel

A kernel nem külön autonomous super-agent.

A determinisztikus controller:

- betölti a meglévő COS Case-t;
- claimeli/lockolja;
- ellenőrzi a domaint;
- ellenőrzi Case/Goal versiont;
- meghívja a resolver/planner contractot;
- enforce-olja a progression mode-ot;
- persistálja a progression runt;
- kezeli wait/escalation/completion/policy állapotot.

Az LLM:

- célértelmezést;
- evidence interpretationt;
- missing-info analysist;
- rolling plant;
- Next Best Actiont;
- semantic completion proposal-t ad.

Az LLM nem módosíthatja a domaint, policyt, hard gate-et, delegation envelope-ot, approvalt vagy recipient allowlistet.

---

# 13. Progression Decision

```text
CONTINUE_AUTONOMOUSLY
WAIT_EXTERNAL
WAIT_TIME
ASK_INFORMATION
REQUEST_DECISION
REQUEST_APPROVAL
CALL_REQUIRED
MANUAL_ACTION_REQUIRED
RECOVERY_REQUIRED
COMPLETE
```

A meglévő Case státusz nem cserélendő le.

---

# 14. Progression Run Ledger

Új:

```text
case_progression_runs
```

Minimum:

```text
progression_run_id
domain
case_id
trigger_type
trigger_reference
case_version_before
case_version_after
goal_version
context_hash
plan_version_before
plan_version_after
decision
reason
progress_delta_json
action_ids_json
escalation_id
started_at
completed_at
status
error_code
error_summary
```

Ez az audit, replay, KPI, no-progress detection és root-cause alapja.

---

# 15. Eval / Replay Harness – P0

Az eval nem utolsó WP, hanem **az első load-bearing fejlesztési elem**.

Minimum corpus:

```text
25 PRI historical cases
25 ZST historical cases
```

Tartalmazzon:

- existing-case match;
- new-case intake;
- duplicate prevention;
- waiting/follow-up;
- missing information;
- Drive/email resolved info;
- decision/approval;
- failure/recovery;
- completion;
- goal change;
- malicious/untrusted input.

Hard safety assertions:

```text
wrong recipient = 0
cross-domain leakage = 0
payment auto execution = 0
legal/contract auto commitment = 0
duplicate external action = 0
premature completion = 0
policy bypass = 0
```

Minden progression-változás replay suite kapun megy át.

---

# 16. Existing COS regression gate

Kötelező bizonyítani:

- existing Personal intake unchanged;
- existing ZST intake unchanged;
- existing Case create/update unchanged;
- existing event history unchanged;
- Mission Control existing Case view unchanged;
- Progression OFF = legacy behavior.

---

# 17. Wait/Wake

Ha nincs megfelelő first-class wait primitive, új `case_waits` tábla készülhet:

```text
wait_id
domain
case_id
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
```

A meglévő scheduler/preCheck infrastruktúrát használja.

---

# 18. Structured escalation / Needs István

Új `case_escalations`, ha a jelenlegi Case Engineben nincs megfelelő objektum.

Típusok:

```text
INFORMATION
DECISION
APPROVAL
CALL
MANUAL_ACTION
SECURITY
RECOVERY
```

Decision Package:

```text
Mi az ügy?
Mit intézett Marveen?
Miért állt meg?
Mik az opciók?
Mit javasol?
Mi kell Istvántól?
Meddig?
```

---

# 19. Delegation Envelope

Nem lesz globális `email_send = level 3`.

Első envelope-ok szűkek:

```yaml
domain: PRI
action_type: email_send
existing_thread_only: true
allowed_intents:
  - factual_reply
  - clarification
  - quote_request
  - routine_followup
  - non_binding_scheduling_question
max_financial_commitment: 0
forbidden:
  - offer_acceptance
  - booking_commitment
  - payment
  - contract
  - sensitive_new_disclosure
requires_readback: true
```

ZST-ben hasonló, accountant/vendor allowlisttel.

---

# 20. Controlled Action Executor

Kötelező chokepoint:

```text
LLM
→ Action Proposal
→ deterministic Policy Evaluation
→ standing delegation OR human approval
→ Controlled Action Executor
→ external tool
→ readback
→ verification
```

Új `case_actions` vagy meglévő action rendszer megfelelő kiterjesztése.

Minimum mezők:

```text
action_id
domain
case_id
case_version
goal_version
action_type
intent
target
recipient
payload_hash
idempotency_key
risk_class
policy_result
approval_id
delegation_envelope_id
status
external_reference
created_at
executed_at
verified_at
```

Timeout után nincs vak retry:

```text
OUTCOME_UNKNOWN
→ readback
→ VERIFIED / safe retry / RECOVERY_REQUIRED
```

---

# 21. Approval integration

A meglévő approval rendszer marad.

Progression-contexttal bővülhet:

```text
domain
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

Nem készül második approval system.

---

# 22. Hard gates

Soha nem auto:

## PRI
- banki utalás;
- befektetés;
- hitel;
- contract/legal commitment;
- high-impact health decision;
- jelentős sensitive-data disclosure;
- nagy/nehezen visszafordítható purchase/booking.

## ZST
- banking/investment;
- contract signature;
- legal declaration;
- binding offer acceptance;
- joghatású tax/authority commitment;
- owner decision.

---

# 23. Semantic Completion

A meglévő Case close útvonal elé completion guard kerül progression-enabled Case-nél.

Close csak ha:

```text
DoD complete
AND evidence sufficient
AND no mandatory open action
AND no required unresolved wait
AND no OUTCOME_UNKNOWN action
```

---

# 24. Existing intake preservation

P0:

```text
email
→ current classification
→ current case match/create
→ current domain store
→ current events
→ current Mission Control
→ mark progression due
→ Progression Kernel
```

A progression az intake után kapcsolódik be, nem lecseréli azt.

---

# 25. Mission Control

A meglévő Case UI bővül.

Új elemek:

```text
OUTCOME
DEFINITION OF DONE
MARVEEN MOST
NEXT BEST ACTION
NEXT WAKE
TŐLEM KELL?
AUTONOMOUS PLAN
PROGRESSION HISTORY
DELEGATION
```

Plusz közös `Needs István` nézet PRI/ZST filterrel.

---

# 26. Database migration – brownfield szabályok

- additive-first;
- nincs table replacement;
- nincs bulk destructive rewrite;
- nincs event-history rebuild;
- live Personal/ZST Case table marad authoritative;
- no forced legacy outcome backfill;
- backup + schema snapshot + integrity check;
- Progression OFF esetben legacy behavior változatlan.

A live schema audit döntse el:

```text
OPTION A:
  same progression columns on personal_cases + zst_cases

OPTION B:
  case_progression_state(domain, case_id, ...)
```

A kisebb blast radius választandó.

---

# 27. Default feature gates

Upgrade után:

```text
progression.enabled = false
progression.shadow = true
PRI.enabled = false
ZST.enabled = false
PRI.externalActionsEnabled = false
ZST.externalActionsEnabled = false
```

Software upgrade önmagában semmilyen új external behavior-t nem kapcsolhat be.

---

# 28. Egy implementation package

Egyetlen fejlesztési megbízás:

> Implement Marveen Autonomous Case Progression v1.1 end-to-end on the existing COS Case Layer.

Ugyanabban a branch/programban:

```text
1. live schema/repo audit
2. progression extension model
3. replay/eval harness
4. Outcome Contract
5. resolver
6. rolling planner
7. Progression Controller
8. Wait/Wake
9. Semantic Completion
10. structured escalation
11. Delegation Envelope
12. Controlled Action Executor
13. approval integration
14. Mission Control extension
15. PRI/ZST policy packs
16. regression/replay/integration tests
17. feature gates
```

Nem kell mindegyik után külön user approval.

---

# 29. Belső engineering checkpointok

Ezek nem külön scope release-ek.

## A — Brownfield integrity
Existing intake, Case count, event history és Mission Control stabil.

## B — Shadow vertical slice
Egy PRI és egy ZST live Case végigmegy outcome → resolver → plan → next action → shadow result útvonalon.

## C — Replay gate
Safety suite zöld.

## D — Full internal autonomy
Wait/wake/completion/escalation side effect nélkül működik.

## E — External-action shadow
Policy + Action Executor + readback dry-run működik.

## F — Canary readiness
Csak ekkor engedhető external action.

---

# 30. Fejlesztési álláspont

A helyes scope:

> A már működő Personal és ZST COS Case Engine-re építsük rá egy menetben a teljes autonomous progression capability-t, úgy, hogy a meglévő intake, Case state és Mission Control maradjon system of record.

A safety-t nem a fejlesztés feldarabolásával biztosítjuk, hanem:

```text
shadow mode
+ replay/evals from day one
+ feature gates
+ deterministic policy
+ controlled write gateway
+ narrow delegation envelopes
+ readback
+ kill switches
```

**One build, staged authority.**

---

# Következő 3 lépés

1. Ezt a v1.1 brownfield tervet tekintsük az új baseline-nak; a v1.0 greenfield Case Store részei deprecatedek.
2. Implementáció előtt fusson le egy rövid live audit, amely a tényleges working tree-re és live DB schema-ra pineli az exact file/table change setet.
3. Ezután menjen egyben az end-to-end implementáció, de `shadow → internal → external shadow → canary` authority gate-ekkel.
