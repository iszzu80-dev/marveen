# Marveen ZST Radio Kft. Chief of Staff v1.2

## Operational company CoS — auditból levezetett target baseline

**Célrendszer:** ZST Radio Kft. adminisztratív és operatív Chief of Staff  
**Elsődleges felhasználó:** Istvan  
**Repo:** `iszzu80-dev/marveen-private`  
**Verzió:** **1.2**  
**Dátum:** 2026-08-16  
**Előző baseline:** ZST CoS v1.1 + 2026-08-10 gap audit  
**Kapcsolódó Personal baseline:** `marveen-personal-chief-of-staff-v4.4.md`  
**Kapcsolódó ACP baseline:** `marveen-autonomous-case-progression-spec-v1.4.5-hardening.md`  
**Státusz:** **PROPOSED IMPLEMENTATION BASELINE**

---

# 1. A v1.2 termékdöntése

A v1.2 egyértelműen lezárja a v1.1 után nyitva maradt kérdést:

> **A ZST CoS nem archívum. A ZST CoS operational Chief of Staff.**

A rendszer feladata nem csak az, hogy a céges levelet, számlát vagy szerződést eltárolja, hanem hogy abból **következő teendőt, felelőst, határidőt, várakozási állapotot és lezárási feltételt** állítson elő, majd az ügyet az ACP-n keresztül kontrolláltan továbbvigye.

A 2026-08-16-i állapotban 42 céges ügyből egyiknek sincs `next_action`, `due_at` vagy `closure_reason` értéke. Ez azt jelenti, hogy a motor technikailag létezik, de a céges névtér **iktat, nem hajt**. A v1.2 elsődleges célja ennek megszüntetése.

---

# 2. Biztonsági és szervezeti határ

## 2.1 Céges és privát adat soha nem keverhető

A ZST névtér kizárólag a ZST connector identityből jövő adatokból dolgozik. Kötelező:

- külön case store (`zst_cases`, `zst_case_events`, domain táblák);
- külön Gmail account identity;
- külön outbound ledger;
- külön document provenance;
- cross-domain parent/link tilalom;
- Personal ↔ ZST adat csak explicit, ember által jóváhagyott bridge-mechanizmuson keresztül kerülhet át, ha később ilyen készül.

A mailbox önmagában nem bizonyítja az üzleti scope-ot, de a connector identity a **security boundary**.

## 2.2 ONE / munkáltatói tartalom kizárása

A ZST CoS nem használható ONE Magyarország vagy más munkáltatói mailbox/adat kezelésére. Ha ilyen adat véletlenül bekerül, fail-closed scope finding + quarantine szükséges.

---

# 3. Kötelező operational case contract

Minden új ZST ügy az intake végére legalább az alábbi operational projectiont kapja:

```text
case_type
category
next_action
next_action_owner
due_at | null
temporal_status
waiting_on | null
follow_up_at | null
closure_condition
sensitivity
source_identity
```

A `null` csak akkor megengedett, ha a jelentése explicit.

## 3.1 Actionability Invariant

Minden nem terminális ZST ügy pontosan az alábbiak egyikében legyen:

1. `ACTIONABLE` — van következő teendő és owner;
2. `WAITING_EXTERNAL` — megnevezett külső fél + follow-up policy;
3. `WAITING_OWNER` — aktív owner decision/question;
4. `WAIT_SYSTEM` — capability blocker;
5. `SCHEDULED` — bizonyított jövőbeli időpont;
6. `BLOCKED` / `RECOVERY_REQUIRED` — explicit ok;
7. `PARENT_ONLY` — csak gyűjtőügy, progression tiltott.

Nyitott, de egyik kategóriába sem sorolható ügy **acceptance failure**.

## 3.2 Owner modell

A `next_action_owner` minimum értékei:

- `ISTVAN`
- `ACCOUNTANT`
- `LAWYER`
- `VENDOR`
- `PARTNER`
- `BANK`
- `SYSTEM`
- `EXTERNAL_OTHER`

Az owner nem címke: meghatározza, hogy az ACP kérdez, vár, emlékeztet vagy rendszerhibát kezel.

---

# 4. ZST intake v1.2

Az intake nem tekinthető késznek attól, hogy létrejön a `zst_cases` sor.

A feldolgozási lánc:

```text
mail/thread/document
→ source dedup
→ classification
→ domain extraction
→ operational projection
→ temporal facts
→ case event
→ ACP enrollment
→ acceptance instrumentation
```

Kötelező tulajdonságok:

- message id + thread id dedup;
- source cursor/batch semantics;
- poison quarantine;
- attachment ingest;
- extraction state explicit;
- minden létrejött case ACP state-et kap;
- a case csak akkor számít operationally ingestednek, ha Actionability Invariant szerint besorolható.

---

# 5. Céges domain-ek

## 5.1 Számlák és könyvelés

A `zst_invoices` legyen tényleges operatív adatforrás, nem csak struktúra.

Minimum kinyerendő mezők:

```text
supplier
invoice_number
issue_date
performance_date
payment_due_date
net_amount
vat_amount
gross_amount
currency
payment_status
accounting_status
source_document_id
```

Minden mezőnek extraction state + provenance kell.

### Pénzügyi biztonság

A rendszer:

- olvashat kivonatot;
- javasolhat számla ↔ banktranzakció egyezést;
- kimutathat duplikációt és hiányt;
- előkészíthet könyvelői csomagot;
- emlékeztethet fizetési határidőre.

A rendszer **nem**:

- indíthat banki utalást;
- hagyhat jóvá pénzügyi tranzakciót;
- hajthat végre befektetési műveletet;
- tekinthet bankmatch-javaslatot könyvelt fizetés bizonyítékának emberi vagy elsődleges forrás nélkül.

## 5.2 Könyvelői csomag

Az accounting package lifecycle:

```text
COLLECTING → READY_FOR_REVIEW → APPROVED_TO_SEND → SENT → ACKNOWLEDGED → CLOSED
```

A küldés mindig exact-payload approvalt igényel. A rendszer draftolhat és csomagolhat autonóm módon, de emailt nem küldhet jóváhagyás nélkül.

## 5.3 Szerződések és kötelezettségek

`zst_contracts` + `zst_obligations` operational követelményei:

- partner/counterparty;
- effective date;
- end date;
- renewal logic;
- cancellation/notice deadline;
- recurring obligations;
- owner;
- evidence/provenance;
- legal-review-needed flag.

### Jogi biztonság

Marveen:

- összefoglalhat;
- határidőt figyelhet;
- tervezetet készíthet;
- ügyvédnek kérdésdraftot készíthet.

Marveen **nem** vállalhat jogi vagy szerződéses kötelezettséget és nem küldhet kötelező erejű nyilatkozatot explicit emberi approval nélkül.

## 5.4 Licencek és előfizetések

A meglévő `zst_licenses` tábla v1.2-ben aktív domain lesz.

Minimum:

```text
service
vendor
renewal_date
auto_renew
cancellation_deadline
billing_period
price
currency
usage_status
owner
cancel_candidate
source
```

Kötelező watch:

- 90/60/30/14/7 napos megújulási ablak;
- trial end;
- áremelés;
- nem használt, de fizetett szolgáltatás;
- lemondási határidő.

A lemondás vagy szerződésmódosítás nem hajtható végre autonóm módon.

## 5.5 Vendor / beszerzés / radar

A procurement radar csak akkor nyitható, ha van:

- konkrét termék/szolgáltatás;
- cél vagy döntési kritérium;
- budget/cap opcionálisan;
- határidő;
- beszerzési owner.

Találatnál a rendszer összehasonlítja:

- ár;
- garancia/SLA;
- eladó/szállító megbízhatósága;
- szerződéses feltételek;
- valós használati igény;
- alternatívák.

Külső megrendelést nem adhat fel autonóm módon.

## 5.6 Partner / opportunity

Az opportunity pipeline minimum állapotai:

```text
NEW → QUALIFYING → DECISION_REQUIRED → CONTACT_PREPARED → APPROVED_OUTREACH → WAITING_EXTERNAL → NEXT_STEP → WON/LOST/CANCELLED
```

Külső outreach csak explicit approval után.

## 5.7 Product Lab gateway

A ZST product ügyekből a rendszer:

- GitHub/termék státuszt összefoglalhat;
- milestone-t és blokkert tárolhat;
- céges adminisztratív függést nyithat;
- döntési pontot eszkalálhat.

A Product Lab technikai végrehajtó rendszerét nem duplikálja.

---

# 6. Temporal Semantic Integrity a céges oldalon

A ZST ugyanazt a shared TSCG-t használja, mint a Personal CoS / ACP v1.4.5.

Céges temporal fact típusok minimum:

- `PAYMENT_DUE`
- `TAX_OR_FILING_DEADLINE`
- `CONTRACT_END`
- `RENEWAL_DEADLINE`
- `CANCELLATION_DEADLINE`
- `DECISION_DEADLINE`
- `ACCOUNTANT_HANDOFF_DUE`
- `EXPECTED_REPLY_BY`
- `MEETING_OR_EVENT`
- `FOLLOW_UP_AT`
- `WAKE_AT`

Minden kritikus dátum provenance-kötött.

Ha például egy szerződés lejárati dátuma és a felmondási határidő keveredik, a rendszer nem használhatja az egyiket a másik helyett. Konfliktus esetén `TEMPORAL_CONFLICT` és human review.

---

# 7. Céges outbound

A v1.1-ben megépített send stack v1.2-ben csak akkor tekinthető capabilitynek, ha van production caller és user-facing ajtó.

Kötelező lánc:

```text
case/action
→ draft
→ exact payload hash
→ recipient validation
→ sensitivity gate
→ approval
→ dispatch claim/fencing
→ send
→ readback/receipt
→ thread link
→ ledger close
```

Tilos:

- implicit approval;
- „same intent” approval reuse módosult payloadra;
- autonomous email send;
- RECOVERY_REQUIRED automatikus resend;
- céges és privát outbound ledger keverése.

---

# 8. Consumer Completeness Contract

A ZST v1.2 ugyanazt a közös szerződést követi:

```text
producer → persist → consumer → observable effect → receipt/readback → dedup → recovery → zero-case telemetry
```

Különösen kötelező:

- contract/license watcher;
- invoice due watcher;
- accounting package queue;
- bank import;
- product-lab escalation;
- outbound queue;
- ZST deadline detector;
- capability recovery.

Egy tesztelt, de production caller nélküli modul **FAIL**.

---

# 9. ZST napi reconcile és monitoring

A v1.2-ben a céges monitoring nem lehet a Personal oldal mellékterméke.

Minimum napi mérés:

```text
zst_open_cases
zst_orphan_open_cases
zst_progression_enabled
zst_progression_disabled_unexpected
zst_due_48h
zst_past_due
zst_temporal_conflicts
zst_waiting_owner
zst_waiting_external
zst_wait_system
zst_outbound_planned
zst_outbound_recovery
zst_invoice_unprocessed
zst_invoice_due_7d
zst_contract_notice_30d
zst_license_renewal_30d
zst_reader_backlog
zst_extraction_failures
zst_cycle_failures
```

A `0` csak mérhető adatból jöhet. Ha például `due_at` mezőt a pipeline még nem ír, a brief nem mondhatja, hogy `due48h=0`; helyette `NOT_INSTRUMENTED` / `UNKNOWN`.

---

# 10. Meglévő 42 ügy operational migrációja

A v1.2 nem enged tömeges, vak backfillt.

## 10.1 Fázisok

1. **Dry classification** — minden meglévő case-re javasolt operational state, write nélkül.
2. **Canary 2 case** — két eltérő típusú ügyön teljes projection + ACP, egy teljes ciklus megfigyelése.
3. **Canary 5 case** — külön domain-ekből.
4. **Batch 10** — acceptance gate után.
5. **Remainder** — csak zöld reconcile mellett.

## 10.2 Minden migrált case követelménye

- source evidence megmarad;
- régi státusz nem veszhet el audit nélkül;
- operational projectionhez `MIGRATED_OPERATIONAL_PROJECTION` event;
- progression explicit re-enable csak akkor, ha a case Actionability Invariant szerint érvényes;
- soha nincs automatikus terminal close pusztán a backfill miatt.

---

# 11. ZST acceptance gate v1.2

A `zst-acceptance` elsőrangú release gate. Minimum csoportok:

1. namespace/security;
2. intake/dedup;
3. operational projection;
4. ACP enrollment;
5. temporal semantics;
6. outbound approval;
7. finance safety;
8. legal safety;
9. consumer completeness;
10. monitoring;
11. backup/recovery;
12. production caller validation.

A kapu determinisztikus, pirosnál non-zero exit.

---

# 12. Kötelező acceptance fixture-ek

| ID | Fixture | PASS |
|---|---|---|
| Z12-I01 | új invoice email | case + invoice + next_action + payment temporal fact |
| Z12-I02 | duplicate message/thread | nincs duplicate case/domain entity |
| Z12-A01 | nyitott case operational state nélkül | acceptance FAIL |
| Z12-P01 | 42 régi case migrációból canary | nincs automatikus close |
| Z12-P02 | progression disabled incidens-maradvány | reconcile finding |
| Z12-T01 | contract end ≠ cancellation deadline | külön temporal fact, nincs keverés |
| Z12-T02 | invoice due date bizonytalan | human review, nincs kitalált deadline |
| Z12-O01 | send module tesztelt, caller eltávolítva | acceptance FAIL |
| Z12-O02 | módosult payload régi approval mellett | dispatch denied |
| Z12-F01 | bankmatch javaslat | nincs payment state automatikus bizonyítás |
| Z12-F02 | bank write kísérlet | capability denied |
| Z12-L01 | legal commitment draft | approval required, nincs send |
| Z12-R01 | empty source table | brief UNKNOWN/NO_DATA, nem hamis 0 |
| Z12-C01 | contract watcher 0 találat | explicit zero telemetry |
| Z12-C02 | pre-existing unconsumed input deploykor | következő ciklus feldolgozza |

---

# 13. Céges napi brief

A brief csak döntésképes dolgokat hoz:

1. ma / 48 órán belül esedékes;
2. owner döntést igényel;
3. könyvelő/ügyvéd/vendor válaszára vár;
4. számla vagy bizonylat hiány;
5. megújulás/felmondás közeleg;
6. küldésre kész, de approvalra váró draft;
7. rendszerhiba / monitoring finding.

Nem kerülhet a briefbe:

- hamis „0” nem instrumentált mezőből;
- olyan rendszerhiba, amelyet a rendszer maga tud helyreállítani és nem igényel döntést;
- alacsony prioritású nyers ingest lista.

---

# 14. Production readiness

## 14.1 Operational ZST GO

PASS feltételek:

- `zst_orphan_open_cases = 0` az újonnan bejövő ügyeken;
- legalább 5 valós, eltérő típusú ZST ügy end-to-end végigment;
- invoice és contract extractor production callerrel működik;
- temporal gate zöld;
- outbound csak approval-gated;
- finance write impossible;
- legal commitment autonomous execution impossible;
- daily reconcile ténylegesen nézi a ZST névteret;
- consumer completeness gate zöld.

## 14.2 Existing-case migration GO

PASS:

- 2 + 5 canary problémamentes;
- nincs unintended completion;
- nincs silent progression disable;
- minden migrált aktív ügy Actionability Invariant szerint besorolható vagy explicit quarantine-be kerül.

## 14.3 Unattended corporate progression

Csak belső és follow-up jellegű progressionre engedhető. **Nem jelenti** külső email, fizetés, szerződéses döntés vagy jogi nyilatkozat autonóm végrehajtását.

Minimum 7 egymást követő nap P1 silent-failure nélkül.

---

# 15. Implementációs sorrend

## Z1 — operational spine

1. ZST Actionability Invariant;
2. intake operational projection;
3. existing 42 case dry-classification;
4. canary migration;
5. daily reconcile ZST coverage.

## Z2 — temporal + finance evidence

6. temporal facts + TSCG;
7. invoice structured extraction state;
8. accounting package lifecycle;
9. bank statement read-only import + evidence semantics.

## Z3 — business domains

10. contracts/obligations;
11. licenses/subscriptions;
12. vendors/procurement;
13. partner/opportunity;
14. Product Lab gateway production caller.

## Z4 — outbound + readiness

15. user-facing ZST outbound endpoints/controls;
16. caller completeness audit;
17. acceptance fixtures;
18. 7 napos operational observation.

---

# 16. Definition of Done

A ZST CoS v1.2 DONE, ha:

1. a rendszer új céges levelet nem csak iktat, hanem operational case-zé alakít;
2. a nyitott ügyeknek van következő teendőjük vagy explicit wait/block állapotuk;
3. a közeli céges határidők strukturált és provenance-kötött temporal factek;
4. a daily reconcile és brief tényleges adatokból dolgozik;
5. minden megépített business modulnak van production callerje;
6. outbound approval és finance/legal safety gate bizonyított;
7. a meglévő case-ek migrációja canary-val megtörtént vagy explicit deferred/quarantine állapotú;
8. az acceptance suite a fenti fixture-eken bizonyított;
9. állapot-spec frissül `[ÉLŐ] / [MEGÉPÍTVE] / [PAPÍR] / [VISSZAVONVA]` jelöléssel.

---

# 17. Verziókapcsolat

- **v1.1:** shared engine + céges domain struktúrák és részleges live működés.
- **v1.2:** operational company CoS; az „iktat, de nem hajt” állapot felszámolása.
- **ACP v1.4.5:** közös hardening és release gate-ek.
- **Personal v4.4:** ugyanazon engine személyes alkalmazása.

A v1.2 nem nyit banki write, autonóm email send vagy jogi commitment execution surface-t.