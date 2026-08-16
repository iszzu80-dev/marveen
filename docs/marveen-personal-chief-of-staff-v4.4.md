# Marveen Personal Chief of Staff v4.4

## Production-hardening target baseline — auditból levezetett következő verzió

**Célrendszer:** Marveen Personal & Household Operating System  
**Elsődleges felhasználó:** Istvan  
**Időzóna:** Europe/Budapest  
**Repo:** `iszzu80-dev/marveen-private`  
**Verzió:** **4.4**  
**Dátum:** 2026-08-16  
**Előző baseline:** `marveen-personal-chief-of-staff-v4.3.md`  
**Kapcsolódó ACP baseline:** `marveen-autonomous-case-progression-spec-v1.4.5-hardening.md`  
**Státusz:** **PROPOSED IMPLEMENTATION BASELINE** — a v4.3 élő állapotára épül; az új követelmények addig nem tekinthetők megépítettnek, amíg a jelen dokumentum DoD-je nem teljesül.

---

# 1. Miért kell v4.4

A v4.3 először választotta szét a **szándékot** a **bizonyított állapottól**. A 2026-08-16-i közös CoS + ACP audit alapján a Personal CoS már felügyelt production használatra alkalmas, de az unattended működésnek még van egy közvetlen P1 akadálya és több P2 hardening hiánya.

A fő tanulság nem egyetlen bug, hanem egy visszatérő hibaosztály:

> **Egy adatmező, modul, sweep vagy detector nem kész attól, hogy írni és olvasni tudjuk. Csak akkor kész, ha van fogyasztója, a fogyasztó bizonyítható hatást vált ki, a hatás visszaolvasható, és a nulla-eset is mérhető.**

A v4.4 célja ezért nem új funkcióhalmaz építése, hanem a v4.3-ból egy **semantikailag konzisztens, mérhető és unattended-ready** Personal CoS kialakítása.

---

# 2. Változatlan, örökölt alapelvek

A v4.3 minden követelménye érvényben marad, kivéve ahol ez a dokumentum kifejezetten szigorít.

Nem változik:

- a személyes és céges névtér fizikai elválasztása;
- az append-only case event log;
- az optimista konkurenciakezelés (`seenVersion`);
- a fiók-szintű source cursor és poison quarantine;
- a scope gate;
- az approval-gated outbound út;
- az a szabály, hogy **email nem küldhető autonóm módon**;
- a kérdéscsatorna és owner-response freshness szabály;
- a `WAIT_SYSTEM` megkülönböztetése az ownerre várástól;
- a kill switch és progression mode-ok;
- a dokumentumtár, radar, naptár-integráció, backup és restore próba;
- pénzügyi témában csak elemzés és döntési alternatíva: **nincs banki utalás, befektetési tranzakció vagy fizetési végrehajtás**;
- jogi/szerződéses kötelezettségvállalás nem hajtható végre autonóm módon.

---

# 3. P1 — Temporal Semantic Integrity

## 3.1 Probléma

A v4.3 strukturált dátummezőket használ (`due_at`, `follow_up_at`, `next_wake_at`, calendar event), de a 2026-08-16-i élő Hertz/Sixt eset bizonyította, hogy **egy helyes formátumú dátum lehet szemantikailag rossz**.

Példa:

- `next_action`: „DÖNTÉS 2026-08-16 10:00 előtt: Hertz VAGY Sixt”
- `due_at`: az autó átvételének dátuma
- `follow_up_at`: egy korábbi követési dátum
- `next_wake_at`: hiányzik

A rendszer tehát rendelkezett dátummal, de nem rendelkezett a **döntési határidő strukturált reprezentációjával**.

## 3.2 Normatív temporal fact modell

Minden döntést befolyásoló időpontnak legyen **szemantikai típusa**. Minimum típuskészlet:

- `DECISION_DEADLINE`
- `PAYMENT_DUE`
- `SERVICE_DUE`
- `RENEWAL_DEADLINE`
- `CANCELLATION_DEADLINE`
- `EVENT_START`
- `EVENT_END`
- `FOLLOW_UP_AT`
- `WAKE_AT`
- `EXPECTED_REPLY_BY`
- `BOOKING_CUTOFF`
- `OTHER_DEADLINE`

Minden temporal fact minimális struktúrája:

```text
kind
occur_at
source_type
source_id
source_excerpt_or_field
confidence
verified_at
supersedes_fact_id | null
```

A meglévő `due_at`, `follow_up_at`, `next_wake_at` mezők maradhatnak gyors projectionként, de **nem lehetnek az időszemantika egyetlen igazságforrásai**.

## 3.3 Temporal Semantic Consistency Gate (TSCG)

Minden progression előtt futó determinisztikus kapu ellenőrizze:

1. a `next_action` természetéhez tartozik-e releváns temporal fact;
2. a projection mező (`due_at` stb.) ugyanarra a szemantikai eseményre mutat-e;
3. nincs-e egymással ellentmondó aktív temporal fact;
4. a forrás bizonyítja-e a kritikus határidőt;
5. a határidő lejárta előtt van-e értelmes `next_wake_at` vagy más fogyasztó.

Ha konfliktus van:

```text
TEMPORAL_CONFLICT
```

és az ügy **nem léphet unattended külső vagy owner-attentiont fogyasztó döntésre**, amíg a konfliktus nincs feloldva.

A gate nem találhat ki dátumot. Lehet:

- strukturált forrásból determinisztikusan átvenni;
- Reader által javasolt factet `UNVERIFIED` állapotban tárolni;
- Istvantól egyetlen, célzott kérdéssel tisztázni.

## 3.4 Kötelező regressziós fixture

A Hertz/Sixt 2026-08-16 eset kötelező fixture:

- van `due_at`, de az `EVENT_START` / pickup;
- a `next_action` döntést kér korábbi időpontra;
- PASS csak akkor, ha a rendszer **TEMPORAL_CONFLICT-et talál vagy létrehoz egy bizonyított `DECISION_DEADLINE` factet és ahhoz ébresztést kapcsol**.

---

# 4. Actionability Invariant

A v4.4-ben egy nyitott személyes ügy nem lehet „formálisan élő, operatívan üres”.

Minden nem terminális, nem parent-only ügynek pontosan az alábbi állapotok egyikében kell lennie:

1. **ACTIONABLE** — van `next_action` + owner;
2. **WAITING_EXTERNAL** — van külső függőség + `expected_reply_by` vagy follow-up policy;
3. **WAIT_SYSTEM** — explicit capability blocker;
4. **WAITING_OWNER** — van aktív, deduplikált owner-kérdés;
5. **SCHEDULED** — van strukturált jövőbeli event/wake;
6. **BLOCKED/RECOVERY_REQUIRED** — explicit okkal;
7. **PARENT_ONLY** — nincs saját teendő és progression tiltott.

**Tilos:** nyitott case, amelyik egyik kategóriába sem sorolható.

Az acceptance gate riportálja:

```text
open_cases
classifiable_open_cases
orphan_open_cases
```

Production PASS: `orphan_open_cases = 0`.

---

# 5. Consumer Completeness Contract

Minden új vagy meglévő periodikus mechanizmusra kötelező a következő lánc:

```text
producer → persist → consumer → observable effect → receipt/readback → dedup → recovery → zero-case telemetry
```

Példák:

- `next_wake_at` → wake consumer → Telegram/bus event → wake clear → dedup;
- planned outbound → digest consumer → owner-visible item;
- deadline detector → case flag / digest / kérdés;
- radar observation → decision rule → digest/alert;
- capability recovery → progression wake.

Egy feature **NEM DONE**, ha bármely elem hiányzik.

A periodikus ciklus minden lépése nullát is jelent:

```text
examined=N matched=0 acted=0 reason=NO_MATCH
```

és különbséget tesz:

- nincs bemenet;
- volt bemenet, nincs találat;
- találat volt, de nincs akció;
- akció történt.

---

# 6. Dokumentumok: strukturált pénzügyi metaadat

A v4.3-ban a Reader a tárolt bytes fallbackkel látja a dokumentumot, de az `amount`, `issuer`, `due_date` mezők több számlán üresek. A v4.4 ezt nem kezeli többé egyszerű nullable mezőként.

## 6.1 Extraction state

Minden strukturált mezőhöz legyen állapot:

- `NOT_ATTEMPTED`
- `EXTRACTED`
- `NOT_PRESENT`
- `AMBIGUOUS`
- `FAILED`

és provenance:

```text
value
state
source_document_id
source_page_or_region | null
confidence
extracted_at
```

## 6.2 Számla minimum

Ha egy dokumentum számlának minősül, legalább az alábbi mezők extraction-state-je legyen ismert:

- issuer / supplier
- invoice number
- gross amount
- currency
- issue date
- payment due date

Nem követelmény, hogy mindegyiknek legyen értéke; követelmény, hogy **ne legyen megkülönböztethetetlen a „nem néztük meg” és a „nincs rajta”**.

## 6.3 Biztonság

A kinyert fizetési adat **soha nem indíthat utalást**. A Personal CoS csak:

- összefoglal;
- határidőt figyel;
- döntést kér;
- emlékeztet;
- read-only banki egyezést javasolhat, ha ilyen forrás később elérhető.

---

# 7. Calendar integrity

A megerősített foglalásból történő naptárírás megmarad, de a v4.4 kötelezővé teszi:

1. **identity-first dedup** — reservation/order/booking id elsődleges, cím csak másodlagos;
2. source provenance a calendar event leírásában;
3. case ↔ calendar link visszaírását (`calendar_event_ids`);
4. létrehozás utáni readbacket;
5. ha ugyanarra a source identityre több event van, `CALENDAR_DUPLICATE_CONFLICT`;
6. bizonytalan eventet nem írunk ki.

Amíg nincs biztonságos update/delete tool, a rendszer **nem próbálja automatikusan javítani** a már létrejött hibás eseményt; owner actiont készít elő.

---

# 8. Owner attention budget

Az owner-kérdés a rendszer legdrágább kimenete. A v4.4 mérje:

- kérdések száma / nap;
- ismételt kérdés ugyanarra az ügyre;
- owner response után 10 percen belüli újrakérdezés;
- resolve-before-ask arány;
- unanswered question age;
- kérdésből ténylegesen létrejött döntések aránya.

Kötelező invariáns:

```text
owner_reply_seen_after_reader_snapshot => stale_question_must_not_send
```

A 2026-08-16-i 37 másodperces újrakérdezés kötelező replay fixture marad.

---

# 9. Mission Control v4.4 követelmény

A dashboard ne csak megfigyelő felület legyen. Minimum kontrollok:

- case close/cancel explicit reasonnel;
- next action javítása;
- dátum fact felülvizsgálat / confirm / reject;
- parent link confirm/unlink;
- calendar duplicate megjelölés;
- owner question answer/reject;
- progression mode állítás;
- kill switch.

Minden módosítás domain-parancson keresztül történjen, event loggal és concurrency guarddal; **közvetlen SQL write UI-ból tilos**.

---

# 10. Least-privilege credential boundary

A v4.3 audit kimutatta, hogy a tényleges Google token scope szélesebb lehet a tool surface-nél.

A v4.4 követelménye:

- a capability preflight a **mért token scope-ot** tekinti igazságnak;
- a tool-lista nem security boundary;
- a Personal CoS futtató folyamata csak az adott workflowhoz szükséges credentialt kaphatja meg;
- email send scope megléte önmagában nem jelent send capabilityt;
- send továbbra is approval + outbound ledger + executor gate mögött marad;
- credential scope drift napi maintenance finding legyen.

---

# 11. Observability és SLO-k

A napi reconcile minimum mérőszámai:

```text
open_cases
orphan_open_cases
waiting_owner
waiting_external
wait_system
past_due
next_48h
planned_outbound
unconsumed_wakes
temporal_conflicts
stale_questions
reader_backlog
reader_failures
documents_missing_structured_state
calendar_duplicate_conflicts
cycle_step_failures
backup_status
```

A nulla érték csak akkor jelenhet meg „0”-ként, ha a mögöttes adatforrás **értelmezhető és megvizsgált**. Ha a mező soha nincs írva vagy a capability nincs elérhető, az UI/brief `UNKNOWN` / `NOT_INSTRUMENTED` állapotot mutat.

---

# 12. Production readiness gate

## 12.1 Felügyelt production

PASS, ha:

- nincs P0;
- `orphan_open_cases = 0`;
- minden periodikus lépésnek van consumer-completeness bizonyítéka;
- backup + restore probe zöld;
- external email approval-gated;
- payment/legal action autonóm módon lehetetlen.

## 12.2 Unattended Personal CoS

Csak akkor engedhető, ha ezen felül:

- Temporal Semantic Consistency Gate zöld;
- Hertz/Sixt fixture zöld;
- 37 másodperces stale-question fixture zöld;
- nincs `unconsumed_wake`;
- nincs nem megmagyarázott deadline miss;
- legalább **7 egymást követő nap** live telemetryben nincs P1 silent-failure;
- minden P1 regression fixture bekerült a kötelező acceptance suite-ba.

Az unattended státusz **nem jelent autonóm emailküldést, pénzügyi tranzakciót vagy jogi kötelezettségvállalást**.

---

# 13. Kötelező acceptance fixture-ek

| ID | Fixture | PASS |
|---|---|---|
| P44-T01 | Hertz/Sixt: döntési deadline ≠ pickup date | konfliktus vagy bizonyított decision fact + wake |
| P44-T02 | prózában deadline, nincs dátummező | detector megszólal és consumer cselekszik |
| P44-Q01 | owner reply után stale Reader | új kérdés nem megy ki |
| P44-W01 | pre-existing due wake a deploy pillanatában | következő ciklus feldolgozza |
| P44-C01 | producer működik, consumer letiltva | acceptance FAIL |
| P44-C02 | zero-match sweep | explicit zero telemetry |
| P44-D01 | invoice due date nincs a dokumentumon | `NOT_PRESENT`, nem null/unknown |
| P44-D02 | invoice extraction hiba | `FAILED` + finding, nem hamis érték |
| P44-K01 | megerősített booking már naptárban | nincs duplicate create |
| P44-K02 | két event ugyanarra a booking id-re | conflict surfaced |
| P44-A01 | nyitott case next_action/wait nélkül | acceptance FAIL |
| P44-S01 | token scope drift | maintenance finding |

---

# 14. Implementációs sorrend

## Phase P1 — unattended blocker

1. temporal fact model;
2. TSCG;
3. Hertz/Sixt fixture;
4. wake policy a kritikus decision deadline-okhoz.

## Phase P2 — completeness

5. Actionability Invariant;
6. Consumer Completeness Contract acceptance checks;
7. zero-case telemetry egységesítése.

## Phase P3 — evidence quality

8. structured document extraction-state;
9. invoice metaadat extraction;
10. calendar readback + duplicate conflict.

## Phase P4 — operational hardening

11. Mission Control domain-write controls;
12. least-privilege scope drift monitor;
13. 7 napos readiness observation.

---

# 15. Definition of Done

A Personal CoS v4.4 **nem** attól DONE, hogy a kód és a tesztek elkészültek.

DONE csak akkor, ha:

1. minden új követelménynek van megnevezett production callerje;
2. minden periodic outputnak van consumerje;
3. minden kritikus consumernek van observable effect + receipt/readback;
4. minden P1 fixture piros a javítás nélkül és zöld a javítással;
5. legalább egy valódi live case-en bizonyított a temporal fact + wake lánc;
6. a napi reconcile a nullát és az UNKNOWN-t helyesen különbözteti meg;
7. a 7 napos unattended readiness ablak teljesült;
8. a v4.4 állapot-specifikációban minden követelmény `[ÉLŐ]`, `[MEGÉPÍTVE]`, `[PAPÍR]` vagy `[VISSZAVONVA]` jelölést kap.

---

# 16. Verziókapcsolat

- **v4.3:** 2026-08-16-i megépített állapot specifikációja.
- **v4.4:** jelen dokumentum, audit-hardening target baseline.
- **ACP v1.4.5:** a közös engine-szintű temporal, consumer-completeness és readiness kapuk normatív helye.
- **ZST CoS v1.2:** ugyanezek céges operational alkalmazása.

A v4.4 nem nyit új external-research vagy browser-autonomy surface-t.