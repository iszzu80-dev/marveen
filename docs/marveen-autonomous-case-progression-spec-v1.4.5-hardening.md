# Marveen Autonomous Case Progression v1.4.5

## Production Hardening — semantic time, consumer completeness and promotion gates

**Rendszer:** Marveen Autonomous Case Progression (ACP)  
**Spec verzió:** **v1.4.5**  
**Dátum:** 2026-08-16  
**Előző implementált baseline:** `marveen-autonomous-case-progression-spec-v1.4-proactive-core.md`, belső verzió v1.4.4  
**Kapcsolódó CoS baseline-ok:** `marveen-personal-chief-of-staff-v4.4.md`, `zst/marveen-zst-radio-chief-of-staff-v1.2.md`  
**Következő, külön release:** `marveen-autonomous-case-progression-spec-v1.5-external-research-browser-autonomy.md`  
**Státusz:** **PROPOSED IMPLEMENTATION BASELINE**

---

# 1. Mi a v1.4.5 és mi nem

A v1.4.4 2026-08-16-ra **implemented baseline** lett: a triggerelt progression, Reader/evidence chain, capability preflight, WAIT_SYSTEM, progression mode-ok, kill switch, bounded sweep és több proaktív fogyasztó valódi store-on működik.

A v1.4.5 nem új autonómia-szint. A célja, hogy az implementált v1.4 magot **production-readiness szinten kikényszeríthetővé** tegye.

A v1.4.5 három audit-leletet emel közös platformkövetelménnyé:

1. **a helyes formátumú adat lehet szemantikailag rossz** — különösen a dátum;
2. **a megépített producer/reader nem capability fogyasztó nélkül**;
3. **a zöld teszt nem elég, ha az élő input, a backlog vagy a readback nincs bizonyítva**.

## 1.1 Kifejezetten nincs scope-ban

A v1.4.5 **nem** implementálja a v1.5-öt. Nincs új:

- általános webkutatás;
- browser autonomy;
- külső oldalakon önálló navigáció vagy formkitöltés;
- új external execution surface;
- autonóm emailküldés;
- pénzügyi tranzakció;
- jogi/szerződéses kötelezettségvállalás.

A v1.5 dokumentuma továbbra is létező roadmap-spec, de **NOT BUILT**.

---

# 2. Normatív fogalom: Complete Progression Path

Egy ACP-képesség csak akkor tekinthető működőnek, ha a teljes lánc megvan:

```text
trigger/source
→ producer
→ persist
→ evidence/provenance
→ policy/decision
→ consumer
→ observable effect
→ receipt/readback
→ dedup/idempotency
→ recovery
→ zero-case telemetry
```

Ezt nevezzük **Complete Progression Pathnak (CPP)**.

## 2.1 DONE-szabály

Egy modul, sweep, detector, Reader-stage, watcher vagy queue **NEM DONE**, ha:

- csak adatot ír, de senki nem fogyasztja;
- csak olvas, de nincs hatása;
- hatása van, de nincs receipt/readback;
- nincs dedup és újrafutáskor ismétel;
- hiba után nincs meghatározott recovery;
- csak találatkor szólal meg, ezért a „nem futott” és a „0 találat” nem különböztethető meg;
- csak új inputtal tesztelték, de a deploy előtt már rögzített, feldolgozatlan inputtal nem.

## 2.2 Consumer manifest

Minden periodikus ACP-lépés vagy producer deklarálja legalább:

```text
feature_id
producer
storage
consumer
observable_effect
receipt_source
idempotency_key
recovery_mode
zero_telemetry
supported_domains
```

A manifest lehet kód vagy strukturált registry, de acceptance-ből gépileg ellenőrizhetőnek kell lennie.

## 2.3 Built-but-not-invoked gate

Release FAIL, ha production buildben olyan ACP feature van, amely:

- normatív capabilityként dokumentált;
- tesztelt;
- de nincs production caller/consumer útja.

Kivétel csak explicit `EXPERIMENTAL_NOT_ROUTED` státusszal megengedett, és akkor a capability nem jelenhet meg live státuszként.

---

# 3. Zero telemetry semantics

A v1.4.5 minden periodikus lépésre kötelezővé teszi a csend típusának megnevezését.

Minimum outcome-k:

```text
NO_DATA       — nincs feldolgozható bemenet
NO_MATCH      — volt bemenet, a szabály nem talált találatot
NO_ACTION     — volt találat, de policy/gate miatt nincs akció
ACTED         — consumer végrehajtotta a belső vagy engedélyezett hatást
FAILED        — a lépés nem fejeződött be
UNKNOWN       — az állapot nem mérhető / nincs instrumentálva
```

Egy dashboard vagy brief nem alakíthat `UNKNOWN` / `NO_DATA` állapotot hamis `0` üzleti állítássá.

Minden cikluslépés minimum riportja:

```text
examined
matched
acted
failed
outcome
reason
```

---

# 4. Temporal Semantic Integrity

## 4.1 Problémaosztály

Az ACP nem tekintheti egy dátum meglétét bizonyítéknak arra, hogy **a megfelelő esemény dátuma** áll rendelkezésre.

A 2026-08-16-i élő Hertz/Sixt eset a kötelező referencia:

- a case döntést igényelt 10:00 előtt;
- `due_at` az autó későbbi átvételét reprezentálta;
- ezért egy strukturált dátum jelen volt, de az ACP a döntési határidőt nem látta.

## 4.2 Temporal Fact

A közös engine explicit temporal facteket kezel. Minimum struktúra:

```text
temporal_fact_id
domain
case_id
kind
occur_at
source_type
source_id
source_locator | null
confidence
verification_status
created_at
supersedes_fact_id | null
```

Minimum `verification_status`:

- `VERIFIED`
- `UNVERIFIED`
- `CONFLICTED`
- `REJECTED`

A fact `source_id` nélkül kritikus deadline-ként nem minősülhet VERIFIED-nek.

## 4.3 Közös fact típusok

Minimum:

- `DECISION_DEADLINE`
- `PAYMENT_DUE`
- `FILING_DEADLINE`
- `RENEWAL_DEADLINE`
- `CANCELLATION_DEADLINE`
- `SERVICE_DUE`
- `EVENT_START`
- `EVENT_END`
- `EXPECTED_REPLY_BY`
- `FOLLOW_UP_AT`
- `WAKE_AT`
- `BOOKING_CUTOFF`
- `OTHER_DEADLINE`

Domain-spec további típust adhat hozzá, de meglévő szemantika átnevezésével nem kerülheti meg a közös gate-et.

## 4.4 Projectionök

A meglévő mezők:

- `due_at`
- `follow_up_at`
- `next_wake_at`
- `calendar_event_ids`

maradhatnak gyors projectionként, de nem lehetnek a temporal truth egyetlen forrásai.

Projection frissítésnél rögzíteni kell, melyik temporal factből származik.

## 4.5 Temporal Semantic Consistency Gate — TSCG

A progression pipeline döntés előtt ellenőrzi:

1. van-e a `next_action`-höz szükséges temporal fact;
2. a kritikus fact VERIFIED-e vagy policy szerint elfogadható-e;
3. nincs-e két aktív, egymásnak ellentmondó fact;
4. a projection ugyanazt a szemantikai eseményt reprezentálja-e;
5. a kritikus deadline előtt van-e fogyasztó: wake, Today/digest vagy más garantált route;
6. lejárt deadline esetén a kérdés/action semantics átállt-e „megtörtént/elmaradt/újratervezés” módra.

Kimenetek:

```text
TEMPORAL_OK
TEMPORAL_MISSING
TEMPORAL_UNVERIFIED
TEMPORAL_CONFLICT
TEMPORAL_PAST_DUE
```

`TEMPORAL_CONFLICT` mellett unattended progression nem léphet owner-attentiont vagy külső hatást okozó döntésbe.

## 4.6 Tilos a látszatmegoldás

Egy regex, amely dátumszerű szöveget talál, **nem bizonyítja a szemantikát**.

LLM javasolhat temporal factet, de VERIFIED státuszhoz kell:

- strukturált elsődleges forrás; vagy
- determinisztikus, tesztelt extractor; vagy
- explicit owner confirmation.

---

# 5. Actionability Gate

A közös engine minden nem terminális, nem parent-only ügyet besorol egy operatív várakozási/action kategóriába.

Minimum állapotok:

```text
ACTIONABLE
WAITING_EXTERNAL
WAITING_OWNER
WAIT_SYSTEM
SCHEDULED
BLOCKED
RECOVERY_REQUIRED
PARENT_ONLY
```

## 5.1 Orphan case

`ORPHAN_OPEN_CASE`, ha nyitott case:

- nincs érvényes `next_action` + owner;
- nincs aktív külső várakozás;
- nincs owner question;
- nincs WAIT_SYSTEM;
- nincs schedule/wake;
- nincs block/recovery reason;
- nem parent-only.

Az orphan case **P1 operational finding**.

## 5.2 Domain parity

A gate ugyanazon engine-szabályból fut Personal és ZST domainen.

Nem elfogadható, hogy egy mező az egyik névtérben soha nincs írva, de a dashboard ebből üzleti nullát állít elő. Ilyenkor `UNKNOWN` / `NOT_INSTRUMENTED` szükséges.

---

# 6. Evidence freshness és stale-decision védelem

## 6.1 Evidence watermark

Minden Reader/evidence packet tartalmazzon olyan watermarkot, amelyhez képest eldönthető, érkezett-e új bizonyíték a case-re. Például:

```text
evidence_max_event_seq
evidence_built_at
source_versions
```

A konkrét implementáció eltérhet, a követelmény nem: **a packetnek bizonyíthatóan meg kell mondania, milyen state-et látott**.

## 6.2 Owner input erősebb, mint a gépi snapshot

Ha owner-originated event érkezett a Reader snapshot után:

```text
owner_event_seq > evidence_max_event_seq
```

akkor a packet stale owner-facing vagy external-effect döntéshez.

Következmény:

- kérdés nem küldhető ki belőle;
- approval-kérés nem generálható belőle;
- külső action candidate nem léphet tovább;
- előbb új Reader pass vagy determinisztikus re-resolution szükséges.

Nincs grace period az owner szavára.

## 6.3 Kötelező fixture

A 2026-08-16-i eset:

- owner válaszol;
- 37 másodperccel később régi snapshotból új kérdés készülne;
- PASS: a kérdés stale és nem küldhető ki.

---

# 7. Backlog-before-fix invariant

Egy javítás nem bizonyított attól, hogy a deploy **után** érkező új input működik.

Kötelező acceptance eset:

1. input/event már rögzítve van;
2. még nincs elfogyasztva;
3. deploy/fix megtörténik;
4. az első jogosult ciklus feldolgozza;
5. receipt/readback bizonyítja;
6. új input létrehozása nélkül történik.

Ez kötelező minden queue/cursor/wake/question/recovery/reader feature-re, ahol feldolgozatlan backlog lehetséges.

---

# 8. Wake és deadline delivery guarantee

## 8.1 Wake consumer

A v1.4.4-ben javított `next_wake_at` út normatív marad:

```text
set → due read → consumer post → receipt/log → clear
```

Sorrend: observable effect előtt a wake nem törölhető.

Crash a post és clear között ismétlést okozhat; crash a clear és post között nem okozhat silent loss-t, ezért a post-first sorrend kötelező.

## 8.2 Critical deadline coverage

Minden VERIFIED kritikus deadline-ra a rendszernek bizonyítania kell legalább egy delivery pathot:

- `next_wake_at`, vagy
- bounded Today/digest scan garantált időablakkal, vagy
- explicit active owner workflow.

`VERIFIED deadline + no delivery path` = `UNCONSUMED_DEADLINE`, P1 finding.

---

# 9. Capability preflight és WAIT_SYSTEM

A v1.4.4 mechanizmusa érvényben marad és szigorodik.

## 9.1 Igazságforrás

Capability értékelésnél a rendszer a ténylegesen mért állapotot használja:

- connector health;
- read/write mode;
- tényleges credential/token scope, ahol elérhető;
- szükséges local store/table/config.

A tool surface vagy dokumentáció **nem security boundary**.

## 9.2 WAIT_SYSTEM invariáns

System/capability fault:

- nem lehet `WAITING_OWNER`;
- nem fogyaszthat owner attentiont, ha nincs owner által végrehajtható döntés;
- retryable esetben determinisztikus recovery út;
- non-retryable deployment/config fault monitoringba kerül.

## 9.3 Recovery proof

`CAPABILITY_RECOVERED` csak akkor PASS, ha:

- ugyanaz a capability újra elérhető;
- a case wake/progression ténylegesen újraindul;
- receipt/run ledger bizonyítja a folytatást.

---

# 10. Structured evidence availability

A Reader nem tekintheti ugyanannak:

- „nem próbáltuk kinyerni”;
- „nincs az adat a dokumentumban”;
- „nem egyértelmű”;
- „extractor hibázott”.

Minimum availability state:

```text
NOT_ATTEMPTED
AVAILABLE
NOT_PRESENT
AMBIGUOUS
FAILED
```

A policy és a question generator ezek alapján különböző döntést hozhat.

Példa: számla fizetési határideje `FAILED` extraction esetén nem válhat csendesen `null`-lá, majd „nincs határidő” következtetéssé.

---

# 11. Safety invariant: mode ≠ permission

A progression mode:

```text
off | shadow | internal | external_shadow | live
```

nem jogosultsági rendszer.

`live` **nem jelenti**, hogy minden action végrehajtható.

Külön hard gate-ek továbbra is érvényesek:

- email/external message: approval + payload binding;
- payment/banking/investment: autonomous execution forbidden;
- legal/contractual commitment: autonomous execution forbidden;
- data delete/permission change/publish content: kategória policy szerint locked/gated;
- sensitivity/provider routing: egress előtt kötelező.

Semmilyen mode promotion nem kerülheti meg ezeket.

---

# 12. Promotion gates

## 12.1 `shadow → internal`

Minimum:

- Actionability Gate zöld;
- CPP manifest teljes az érintett feature-ökre;
- zero telemetry működik;
- backlog-before-fix fixture zöld;
- nincs P0/P1 data integrity finding.

## 12.2 `internal → external_shadow`

Ezen felül:

- TSCG zöld;
- evidence freshness gate zöld;
- sensitivity routing zöld;
- external action candidate csak dry-run/ledger állapotig jut;
- receipt/readback út tesztelt.

## 12.3 `external_shadow → live`

Ezen felül:

- minden external effect külön policy/approval gate mögött;
- nincs orphan open case;
- nincs unconsumed deadline/wake;
- nincs stale owner-facing candidate;
- kötelező live regression fixture-ek zöldek;
- kill switch és TOCTOU recheck bizonyított;
- legalább **7 egymást követő nap** live telemetryben nincs P1 silent-failure az érintett domainen.

## 12.4 Promotion scope

Promotion domain + feature scoped. Personal domain zöldsége nem automatikusan ZST-zöldség, és fordítva.

---

# 13. Shared operational acceptance

A v1.4.5 bevezeti a közös engine-szintű acceptance réteget. A domain acceptance suite-ok erre épülnek.

Minimum ellenőrzések:

```text
CPP completeness
temporal integrity
actionability
evidence freshness
consumer presence
production caller presence
zero telemetry
backlog processing
capability recovery
safety policy
namespace parity
bounded backlog
cycle health
```

A kapu determinisztikus, és P0/P1 esetben non-zero exit.

---

# 14. Kötelező v1.4.5 fixture-készlet

| ID | Fixture | PASS |
|---|---|---|
| A145-T01 | Hertz/Sixt: pickup dátum van, döntési deadline korábbi | `TEMPORAL_CONFLICT` vagy verified decision fact + delivery path |
| A145-T02 | próza-deadline, nincs fact | detector finding + consumer |
| A145-T03 | két verified fact ellentmond | conflict, nincs unattended decision |
| A145-Q01 | owner válasz 37 mp-cel régi snapshot után | stale question blokkolva |
| A145-E01 | új case event Reader packet után | packet stale megfelelő döntésekhez |
| A145-W01 | due wake már deploy előtt ott van | következő ciklus elfogyasztja |
| A145-B01 | queue item deploy előtt pending | új input nélkül feldolgozódik |
| A145-C01 | producer megvan, consumer eltávolítva | acceptance FAIL |
| A145-C02 | consumer megvan, receipt nincs | acceptance FAIL |
| A145-Z01 | sweep 0 találat | `NO_MATCH`, examined > 0 |
| A145-Z02 | nincs input | `NO_DATA`, nem üzleti 0 |
| A145-A01 | nyitott Personal orphan case | P1 finding |
| A145-A02 | nyitott ZST orphan case | P1 finding |
| A145-S01 | connector READ_ONLY, write kellene | WAIT_SYSTEM / denied, nincs write |
| A145-S02 | token scope drift | monitoring finding |
| A145-R01 | capability recovered | case progression újraindul és receipt van |
| A145-D01 | extraction FAILED | availability FAILED, nem null-semantic |
| A145-P01 | `live` mode email approval nélkül | dispatch denied |
| A145-P02 | `live` mode payment action | denied |
| A145-P03 | `live` mode legal commitment | denied |
| A145-X01 | sensitive Reader content, nincs cleared provider | not sent, explicit blocked result |

Minden kritikus fixture-höz mutation proof szükséges: a védelmi logika célzott eltávolítása vagy gyengítése a **nevesített tesztet** tegye pirossá.

---

# 15. Observability

A közös ACP telemetry minimum:

```text
progression_candidates
progression_claimed
progression_completed
progression_failed
progression_remaining
orphan_open_cases
temporal_missing
temporal_conflicts
unconsumed_deadlines
wakes_due
wakes_acted
wakes_failed
reader_candidates
reader_read
reader_refused
reader_sensitivity_blocked
reader_failures
reader_remaining
stale_evidence_blocked
wait_system_cases
capability_recovered
cpp_violations
consumer_missing
receipt_missing
cycle_step_failures
```

Minden metric domain-dimenzióval mérhető (`personal`, `zst`).

---

# 16. Boundedness és fairness

A v1.4.4 bounded sweep és fair interleave szabályai megmaradnak.

A v1.4.5 hozzáteszi:

- backlog nem lehet láthatatlan a limit mögött;
- `remaining` kötelező;
- tartós truncation/stall findingot okoz;
- egyik domain sem éheztetheti a másikat;
- domainon belül a kritikus VERIFIED deadline megelőzheti az alacsonyabb prioritású friss case-t determinisztikus prioritási szabállyal.

Prioritási döntést LLM nem hozhat runtime-ban; a rendezési szabály policy/config.

---

# 17. v1.5 unlock gate

Az external research/browser autonomy implementációja **nem léphet live szakaszba**, amíg a v1.4.5 production gate nem zöld.

Minimum unlock feltételek:

1. Personal v4.4 supervised production gate zöld;
2. ZST v1.2 operational gate zöld azon domain-ekre, amelyek v1.5-t használnák;
3. 7 nap P1 silent-failure nélkül;
4. 0 CPP violation a release windowban;
5. 0 orphan case az érintett live scope-ban;
6. 0 unexplained deadline miss;
7. measured least-privilege credential boundary;
8. egress/sensitivity routing bizonyított;
9. external research evidence provenance modell kész;
10. kill switch és per-feature disable működik.

A v1.5 spec létezése nem jelenti az unlock teljesülését.

---

# 18. Implementációs sorrend

## H1 — P1 semantic correctness

1. temporal fact store/model;
2. TSCG;
3. Actionability Gate;
4. Hertz/Sixt + orphan fixtures.

## H2 — consumer completeness

5. consumer manifest/registry;
6. CPP acceptance checks;
7. zero telemetry standard;
8. unconsumed deadline/wake detector.

## H3 — evidence freshness

9. Reader watermark;
10. stale evidence gate;
11. owner-response fixture;
12. extraction availability semantics.

## H4 — deployment and recovery proof

13. backlog-before-fix fixtures;
14. capability recovery e2e receipt;
15. domain parity checks;
16. bounded backlog/stall telemetry.

## H5 — promotion readiness

17. promotion gate implementation;
18. live telemetry window;
19. v1.5 unlock report.

---

# 19. Definition of Done

ACP v1.4.5 DONE csak akkor, ha:

1. a közös TSCG Personal és ZST domainen ugyanazon engine gateként fut;
2. Actionability Gate mindkét domainen mér és orphan case-t findinggá emel;
3. minden normatív ACP periodic feature CPP-manifesttel rendelkezik;
4. built-but-not-invoked feature nem jelenhet meg live capabilityként;
5. `NO_DATA`, `NO_MATCH`, `NO_ACTION`, `ACTED`, `FAILED`, `UNKNOWN` megkülönböztethető;
6. stale Reader/evidence packet owner input után nem okozhat owner-facing vagy external-effect döntést;
7. pre-existing backlog fixture-ek zöldek;
8. wake/deadline delivery path e2e bizonyított;
9. capability recovery nem csak state-et, hanem tényleges folytatást bizonyít;
10. live mode sem tudja megkerülni az email/payment/legal hard gate-eket;
11. minden kritikus fixture mutation-proven;
12. legalább 7 egymást követő nap nincs P1 silent-failure a promoted scope-ban;
13. elkészül az új **v1.4.5 állapot-spec / readiness report**, amely külön jelöli `[ÉLŐ]`, `[MEGÉPÍTVE]`, `[PAPÍR]`, `[VISSZAVONVA]` státusszal a követelményeket.

---

# 20. Verziókapcsolat

- **v1.4.4:** 2026-08-16-i implemented baseline, a jelenlegi működő Proactive Core.
- **v1.4.5:** jelen dokumentum; hardening + enforceable production-readiness target.
- **v1.5:** külön external research/browser autonomy release, továbbra sem implementált.

A v1.4.5 nem lép a v1.5 helyére. A feladata az, hogy a v1.5 előtt a jelenlegi belső autonóm mag bizonyíthatóan stabil legyen.