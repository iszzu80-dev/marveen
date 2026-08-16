# CoS v4.4 + ZST v1.2 + ACP v1.4.5 — implementation / Clean Replay run log

**Dátum:** 2026-08-16  
**Branch:** `agent/cos-v44-acp145-replay-hardening`  
**Stacked baseline:** PR #19 / `spec/cos-acp-audit-hardening-2026-08-16`  
**Implementation PR:** #20  
**Állapot:** `IN PROGRESS — production mutation intentionally not performed`

---

## 1. Executive result

A három kért lépésből a kód- és tooling-réteg elkészült olyan safety envelope-pal, amely nem képes automatikus production correctionre, külső email-küldésre, fizetésre, befektetési tranzakcióra vagy jogi kötelezettségvállalásra.

A valódi production-shadow reconciliation és az arra épülő canary correction **nem tekinthető lefutottnak**, mert ebben az implementációs környezetben nincs közvetlen read-only filesystem/SQLite hozzáférés a Marveen live store-hoz, és a ChatGPT Gmail connectorból nem állítható elő közvetlenül a repo CLI által fogyasztható, 2474+ üzenetes immutable corpus fájl. Emiatt a biztonságos viselkedés: `BLOCKED/UNKNOWN`, nem pedig hamis `PASS`.

Ez nem kerülőút: a Clean Replay v1.0 normatív szabálya szerint correction/canary csak valódi replay + authority-aware diff után indulhat, `auto_apply_allowed=false` mellett.

---

# 2. STEP 1 — M0–M5 shared hardening

## 2.1 Elkészült

### Strict connector-identity namespace boundary

`src/cos/scope-gate.ts`

- az automatikus namespace-et kizárólag a connector/account identity választja;
- private connector → Personal store;
- ZST connector → ZST store;
- tartalom csak mismatch/review jelzést adhat;
- private→ZST vagy ZST→Personal automatikus cross-route nincs;
- cross-domain mozgatás külön, explicit human-approved bridge feladata;
- prompt/instruction injection továbbra is fail-closed `SECURITY_BLOCKED`.

### Typed temporal fact layer

`src/cos/temporal-facts.ts`

Új provenance-bound temporal contract:

- semantic `fact_kind`;
- exact `occurs_at`;
- `source_system`, `source_reference`, `source_field`;
- confidence;
- `VERIFIED | UNVERIFIED | CONFLICTED | REJECTED`;
- supersession;
- raw evidence;
- actor.

A legacy `due_at/follow_up_at/next_wake_at` mezők migráció alatt projectionként megmaradnak.

### Temporal Semantic Consistency Gate (TSCG)

`src/cos/temporal-consistency-gate.ts`

Kimenetek:

- `TEMPORAL_OK`
- `TEMPORAL_MISSING`
- `TEMPORAL_UNVERIFIED`
- `TEMPORAL_CONFLICT`
- `TEMPORAL_PAST_DUE`

A gate szemantikusan azonos factet követel. Egy verifikált autófelvételi időpont (`BOOKING_START`) nem elég egy külön döntési határidő (`DECISION_DUE`) igazolására.

### Hertz/Sixt mandatory regression

`src/__tests__/cos-v44-acp145-hardening.test.ts`

Fixture:

- case-text: döntés 2026-08-16 10:00 előtt;
- structured fact: booking/pickup 2026-08-18;
- elvárt: `TEMPORAL_MISSING`, progression tiltott.

A kapcsolt Gmailből célzott read-only ellenőrzéssel mind Hertz, mind SIXT reservation-források megtalálhatók; a SIXT pickup 2026-08-18, és 2026-08-16-i cancellation source is jelen van. A fixture tehát valós incident-osztályt reprezentál, nem mesterséges példát.

### Shared Actionability Invariant

`src/cos/actionability.ts`

Normatív osztályok:

- `ACTIONABLE`
- `WAITING_EXTERNAL`
- `WAITING_OWNER`
- `WAIT_SYSTEM`
- `SCHEDULED`
- `BLOCKED`
- `RECOVERY_REQUIRED`
- `PARENT_ONLY`
- `ORPHAN`
- `TERMINAL`

Nyitott, nem classifiable case → `ORPHAN`; nem tekinthető kész operational state-nek.

### Complete Progression Path / consumer manifest

`src/cos/consumer-manifest.ts`

Minden normatív feature szerződése:

`producer → storage → consumer → observable effect → receipt/readback → dedup/idempotency → recovery → zero semantics`

Standard zero/outcome vocabulary:

`NO_DATA | NO_MATCH | NO_ACTION | ACTED | FAILED | UNKNOWN`.

### Generic evidence freshness

`src/cos/evidence-freshness.ts`

Watermark:

- domain;
- case ID;
- case version;
- max event sequence;
- built timestamp;
- source fingerprint.

Új case event vagy case-version változás a korábbi evidence-et stale-lé teszi. A 37 másodperccel később érkező owner-input regression fixture ezt bizonyítja.

### ZST operational intake

`src/cos/zst-operational-projector.ts` + `src/cos/zst-intake.ts`

Új ZST case már intake-kor kap:

- operational status;
- explicit `next_action`;
- `next_action_owner`;
- `waiting_on` / follow-up, ahol releváns;
- semantic temporal claim-eket `UNVERIFIED` provenance factként;
- actionability validationt a tranzakció lezárása előtt.

Invoice/accounting alap owner: `ACCOUNTANT`; contract/legal/vendor/opportunity döntési owner: `ISTVAN`. A projector nem generál email-send, payment, transfer, signature vagy legal commitment executiont.

Invoice/contract extractor hiba most explicit `extractionState=FAILED`, nem teljesen néma best-effort hiba.

## 2.2 Még nem production-complete integráció

A következő pontokat **nem jelöljük zöldnek csak azért, mert a primitive elkészült**:

1. `case_temporal_facts` és `cos_feature_runs` jelenleg defensive/lazy schema bootstrapot használ; a repo preferált központi `initCosSchema()` seam-jébe még be kell kötni.
2. TSCG primitive még nincs minden progression policy döntés elé bekötve a `progression-pipeline.ts`-ben.
3. generic evidence watermark még nincs minden owner-facing és external-candidate consumerre bekötve; a meglévő owner-question út saját lokális stale guardja továbbra is él.
4. standard CPP telemetry még nincs minden `cos-cycle` lépésen egységesítve.
5. Actionability runtime gate az új ZST intake-ben él; a teljes Personal/ZST existing-case progression/reconcile release-gate-re még általánosítandó.

**STEP 1 minősítés:** `PARTIAL PASS / IMPLEMENTED PRIMITIVES, INTEGRATION PENDING`. Unattended promotion tilos.

---

# 3. STEP 2 — Clean Replay & Reconciliation toolchain

## 3.1 Elkészült tooling

### Immutable replay contracts

`src/cos/replay/types.ts`

Külön típusok source message-re, attachment manifestre, replay projectionre, production snapshotra, reconciliation findingra és ZST migration batchre.

### Shadow replay engine

`src/cos/replay/shadow-replay.ts`

Tulajdonságok:

- kizárólag a caller által átadott shadow SQLite handle-t ismeri;
- nincs Gmail writer / executor / approval / production DB import;
- 60 napos anchor-window támogatás;
- minden anchorban érintett thread **teljes rendelkezésre álló története** bekerül;
- determinisztikus sorrend;
- body és attachment manifest hash;
- connector-identity namespace;
- temporal claim extraction;
- actionability classification;
- multi-run history: run-scoped message/case kulcsok, előző replay evidence nem íródik felül.

### Authority-aware reconciliation

`src/cos/replay/reconcile.ts`

- match provider thread identity alapján;
- nem egyértelmű mapping → `CONFLICT_REVIEW/P1`;
- source-derived state és production-authoritative state külön;
- human/manual current state és external receipt nem írható felül replayből;
- minden finding: `autoApplyAllowed=false`;
- stability csak 0 P0/P1/unclassified findingnál indulhat.

### Read-only production snapshot exporter

`scripts/cos-replay-export-production-snapshot.ts`

- SQLite `{ readonly: true, fileMustExist: true }`;
- `PRAGMA query_only=ON` ellenőrzés;
- nincs `initDatabase()`, migration, CREATE, UPDATE, correction;
- Personal+ZST production snapshot;
- külön ZST legacy snapshot;
- output file mode `0600`.

### Operator replay CLI

`scripts/cos-clean-replay.ts`

Kötelező inputok:

- immutable source corpus;
- külön shadow DB path;
- report path.

Opcionális:

- read-only production snapshot;
- ZST legacy snapshot.

Szándékosan **nem létezik** `--apply`, `--prod-db`, outbound vagy send mód.

## 3.2 Valódi source census

A kapcsolt privát Gmail account read-only keresésével a 2026-06-17–2026-08-16 anchorban, spam/trash nélkül:

**2 474 message** található.

Ez nem egyenlő a final replay message counttal, mert a replay a touched threadek 60 napnál régebbi előzményeit is hozzáadja.

## 3.3 Miért nem futott le még a teljes valódi replay

Ebben az operátori környezetben két required runtime input nem érhető el fájlként:

1. **live Marveen SQLite read-only snapshot** — nincs jelenlegi SSH/filesystem connector a runtime hosthoz;
2. **full normalized Personal + ZST Gmail corpus file** — a ChatGPT Gmail connector alkalmas read/search műveletekre és a 2474-message censust bizonyította, de nem ad át közvetlen immutable exportfájlt a repo CLI-nak.

A repo viszont már rendelkezik két local Google MCP accounttal (`private`, `zst`) az `email-triage-fetch.py` alapján. A következő runtime integration feladata ezekből teljes, paginált read-only corpus export előállítása, majd a fenti CLI meghajtása ugyanazon a hoston vagy egy read-only snapshot környezetben.

**STEP 2 minősítés:** `TOOLCHAIN PASS / LIVE REPLAY BLOCKED-UNKNOWN`. Ez helyes zero semantics; nem nevezhető sikeres replaynek.

---

# 4. STEP 3 — correction + ZST 42-case canary

## 4.1 Elkészült

`src/cos/replay/zst-migration-plan.ts`

Rollout sequence:

1. `DRY_RUN`
2. `CANARY_2`
3. `CANARY_5`
4. `CANARY_10`
5. `REMAINDER`

A planner csak az operationally hiányos legacy case-eket jelöli repair candidate-nek. Már classifiable case-et nem tesz migration batchbe.

Generated proposal nem tartalmazhat:

- send email;
- payment/transfer;
- contract signature;
- automatic close/complete.

A correction manifest minden findingja `autoApplyAllowed=false`.

## 4.2 Mi nem történt meg

- production Personal case correction **nem futott**;
- ZST case mutation **nem futott**;
- `CANARY_2` **nem futott**;
- email/outbound action **nem futott**;
- progression mode promotion **nem történt**;
- PR merge **nem történt**.

Ennek oka nem pusztán technikai: Clean Replay v1.0 szerint valódi authority-aware diff nélkül correction indítása szabálysértés lenne.

**STEP 3 minősítés:** `PLANNER/SAFETY PASS / LIVE CANARY BLOCKED BY STEP 2`.

---

# 5. Regression és CI evidence

Új célzott tesztek:

- `cos-v44-acp145-hardening.test.ts`
- `cos-clean-replay.test.ts`
- `cos-clean-replay-multirun.test.ts`
- `cos-zst-operational-projector.test.ts`

Lefedett kötelező esetek:

- Hertz/Sixt semantic mismatch;
- orphan open case;
- parent-only semantics;
- private→ZST automatic crossing tiltás;
- ZST connector identity megtartása;
- stale evidence owner event után;
- CPP completeness + explicit zero semantics;
- full-thread expansion;
- shadow-only schema;
- no-auto-apply reconciliation;
- exact ZST batch sizing;
- same-corpus multiple replay run megőrzése;
- ZST invoice/contract/outbound operational projection.

A legutóbbi dokumentált CI snapshotnál a GitHub Actions:

- kernel contract: PASS;
- TypeScript typecheck: PASS;
- full Vitest suite: futott / final resultet a legutolsó headen külön ellenőrizni kell, mert az utolsó tesztcommit új workflow runt indít.

Release-readiness dokumentáció csak a legutolsó head final CI eredményével frissíthető `GREEN`-re.

---

# 6. Safety evidence

Az implementáció során:

- production DB write: **0**;
- replayből production correction: **0**;
- autonomous email send: **0**;
- payment/investment transaction: **0**;
- legal/contract commitment: **0**;
- progression-mode promotion: **0**;
- PR merge: **0**.

Ez szándékos. A hardening célja az authority és bizonyítás erősítése, nem az autonomy gyors növelése.

---

# 7. Következő kötelező gate-ek

A háromlépcsős rollout csak az alábbi sorrendben folytatható:

1. central schema + progression/evidence/CPP runtime integration és teljes CI green;
2. Marveen hoston immutable Personal+ZST corpus export + query-only production snapshot + full 60-day/full-thread replay;
3. reconciliation report review; csak 0 unresolved P0/P1 után `CANARY_2`, majd minden batch után külön reconcile/acceptance gate.

A 7 napos stability window csak a 3. pont sikeres lezárása után indulhat.
