# Clean Replay & Reconciliation Gate v1.0

## Personal CoS v4.4 + ZST CoS v1.2 + ACP v1.4.5 rollout addendum

**Dátum:** 2026-08-16  
**Státusz:** **PROPOSED IMPLEMENTATION / ACCEPTANCE BASELINE**  
**Kapcsolódó specifikációk:**
- `docs/marveen-personal-chief-of-staff-v4.4.md`
- `docs/zst/marveen-zst-radio-chief-of-staff-v1.2.md`
- `docs/marveen-autonomous-case-progression-spec-v1.4.5-hardening.md`
- `docs/cos-v4.4-zst-v1.2-acp-v1.4.5-implementation-plan.md`

---

# 1. Döntés

Az új baseline-ok implementációja után **nem cseréljük le közvetlenül a production adatbázist egy újraépített adatbázisra**. Helyette egy külön, üres **shadow replay adatbázist** építünk fel a forrásadatok determinisztikus újrajátszásával, majd strukturáltan összehasonlítjuk a production állapottal.

A Clean Replay célja:

> **függetlenül újraszámolni mindazt, ami a forrásokból újra levezethető, és ezzel megtalálni a production store-ban felhalmozódott hiányokat, duplikációkat, scope-hibákat, rossz thread-linkeket, actionability-hiányokat és temporal szemantikai inkonzisztenciákat — anélkül, hogy emberi döntést vagy valódi külső execution evidence-et felülírnánk.**

A replay **nem migration shortcut**, hanem release gate és reconciliation instrumentum.

---

# 2. Miért nem production wipe + rebuild

A CoS store nem kizárólag Gmailből származó projection. Olyan authority adatokat is tartalmaz, amelyek a levelekből nem rekonstruálhatók megbízhatóan:

- owner válaszok és döntések;
- exact-payload approvalok;
- tényleges outbound send receipt/readback;
- manual case repair / closure döntések;
- kill-switch és recovery események;
- progression során született, auditált állapotok;
- parent/child linkek emberi megerősítése;
- calendar write receipt és provider event id;
- dokumentumok explicit sensitivity/shareability döntései;
- banki vagy könyvelési emberi reconciliation döntések;
- jogi/szerződéses emberi jóváhagyások.

Ezeket egy Gmail-only rebuild vagy elveszítené, vagy újraértelmezné. Ezért:

```text
PRODUCTION STORE = authority az emberi döntésre és megtörtént külső hatásra
SHADOW REPLAY    = authority-candidate a forrásból újraszámolható derived state-re
```

A két oldal eltérését reconciliation policy oldja fel; egyik sem írhatja felül vakon a másikat.

---

# 3. Replay időablak

## 3.1 Alapértelmezés

A replay anchor window alapértelmezetten **60 nap**.

Minimum elfogadható ablak: **45 nap**.

30 nap csak diagnosztikai quick runként használható; release gate-nek nem ajánlott, mert:

- follow-up ügy kezdete könnyen korábbra esik;
- szerződéses/megújulási folyamatok átnyúlhatnak rajta;
- egy booking vagy reklamáció első levele korábbi lehet;
- Sent/Inbound reply pár egyik fele kicsúszhat az ablakból.

## 3.2 Full-thread expansion — kötelező

Az anchor window **nem kemény levágás**.

Ha az utolsó 60 napban egy Gmail thread bármely üzenete érintett, a replay corpusba a **teljes thread** bekerül, akkor is, ha annak első levele 60 napnál régebbi.

```text
anchor_window_message
→ thread_id
→ fetch complete thread
→ immutable replay corpus
```

Ez kötelező Personal és ZST oldalon is.

## 3.3 Source-reference expansion

Ha egy replayelt levél vagy attachment olyan konkrét source identityre hivatkozik, amely a case megértéséhez szükséges és elérhető a támogatott forrásban — például korábbi booking email, invoice thread, contract notice —, a corpus bővíthető célzott source expansionnel.

A bővítés minden esetben manifestbe kerül; nincs csendes ad hoc input.

---

# 4. Replay corpus

## 4.1 Kötelező Gmail források

Mindkét domain saját connector identityjén:

- Inbox / received mail;
- Sent mail;
- teljes thread;
- message id;
- thread id;
- From / To / Cc releváns header;
- timestamp;
- subject;
- full body;
- attachment metadata;
- attachment bytes, ahol elérhető;
- provider identity / account identity.

A replay read-only. Forrásoldali label, archive, send vagy módosítás tilos.

## 4.2 Attachment corpus

A replay a levélhez tartozó attachment bytes-ot is feldolgozza, mert invoice/contract/document extraction enélkül nem hasonlítható össze érdemben.

Minden attachment:

```text
source_account
message_id
attachment_id
filename
mime_type
sha256
byte_size
retrieval_status
```

## 4.3 Calendar

A Calendar **nem primary replay source** ugyanabban az értelemben, mint a Gmail.

A calendar state reconciliation inputként használható:

- meglévő provider event id;
- booking/reservation identity;
- start/end;
- source provenance;
- case link.

A replay **nem ír calendar eventet**.

## 4.4 Owner-channel / Telegram / Mission Control events

Ezek nem játszhatók újra úgy, mintha új inputok lennének. A productionból authority overlayként olvashatók az összehasonlítás során.

Különösen:

- owner answer;
- explicit decision;
- approve/reject;
- manual close/cancel;
- temporal fact confirmation/rejection.

---

# 5. Immutable replay manifest

Minden run a feldolgozás előtt létrehoz egy immutable manifestet.

Minimum mezők:

```text
replay_run_id
created_at
code_commit_sha
spec_baseline
schema_version
anchor_start
anchor_end
source_account_ids
message_count
thread_count
attachment_count
source_expansion_count
input_manifest_sha256
connector_surface_fingerprint
extractor_config_fingerprint
replay_mode = SHADOW_NO_EFFECTS
```

A replay eredménye csak ehhez a corpushoz és kódhashhez értelmezhető.

Ugyanazon manifest + kódhash kétszeri futtatásának azonos source-derived eredményt kell adnia.

---

# 6. Shadow DB tulajdonságai

A replay DB külön fizikai adatbázis.

Tilos:

- production DB-re írni;
- production cursort mozgatni;
- Gmail labelt változtatni;
- emailt küldeni;
- owner-questiont kiküldeni;
- calendar eventet létrehozni/módosítani/törölni;
- külső vendor/API actiont végrehajtani;
- payment/legal/contract actiont indítani.

A replay minden outbound / owner-facing / external effect útját hard-disable módra állítja.

Kötelező invariant:

```text
replay_mode == SHADOW_NO_EFFECTS
AND external_effect_count == 0
AND owner_notification_count == 0
```

Ha ez nem bizonyítható, a replay run FAIL és az eredménye nem használható reconciliationre.

---

# 7. Replay processing order

Az inputokat determinisztikusan kell rendezni.

Elsődleges ordering:

```text
provider_timestamp ASC
→ account_id ASC
→ thread_id ASC
→ message_id ASC
```

A pipeline:

```text
immutable corpus
→ source dedup
→ connector-identity scope boundary
→ intake classification
→ full-thread association
→ attachment/document ingest
→ domain extraction
→ temporal facts
→ operational projection
→ Actionability Gate
→ ACP enrollment
→ internal/shadow progression
→ CPP instrumentation
→ final shadow projection
```

A replaynek ugyanazokat a normatív domain modulokat kell használnia, mint a productionnak. Külön „replay parser” vagy egyszerűsített üzleti logika tilos, mert akkor nem ugyanazt a rendszert mérjük.

---

# 8. Authority classes

A reconciliation minden mezőt / entitást előre deklarált authority classba sorol.

## CLASS A — Source-derived / rebuildable

Alapesetben a shadow replay erős összehasonlítási bizonyíték.

Példák:

- email message/thread membership;
- source account identity;
- sender/recipient;
- attachment hash;
- case candidate existence;
- case type/category javaslat;
- invoice/contract extracted facts;
- source-derived temporal facts;
- source-derived waiting party;
- source-derived next-action candidate;
- duplicate/self-send classification;
- source-derived namespace.

Eltérés esetén a production automatikusan **findingot** kap; későbbi javítás csak domain commandon keresztül történhet.

## CLASS B — Authority state / never rebuilt from replay

A production store marad authority.

Példák:

- owner decision;
- approval/rejection;
- actual outbound receipt;
- actual provider message id;
- manual closure;
- explicit temporal confirmation/rejection;
- manual parent link;
- actual calendar provider id;
- bank reconciliation human verification;
- legal approval;
- kill-switch history.

A replay ezeket soha nem írhatja felül.

## CLASS C — Reconciliation conflict

Olyan state, ahol a source-derived shadow és a production authority együtt szükséges.

Példák:

- production case closed, de újabb source email alapján újra releváns;
- owner döntés után új forrás érkezett;
- production due_at más szemantikát hordoz, mint az új VERIFIED temporal fact;
- ugyanazon booking identity több calendar eventre mutat;
- production thread link és source thread topology ellentmond;
- ZST/Personal namespace eltérés.

CLASS C mindig explicit review vagy szabályozott migration input; nincs vak overwrite.

---

# 9. Reconciliation diff taxonomy

Minden eltérés strukturált finding.

Minimum kategóriák:

```text
CASE_MISSING_IN_PRODUCTION
CASE_EXTRA_IN_PRODUCTION
CASE_DUPLICATE
NAMESPACE_MISMATCH
THREAD_LINK_MISMATCH
SOURCE_IDENTITY_MISMATCH
CASE_TYPE_MISMATCH
CATEGORY_MISMATCH
ACTIONABILITY_MISMATCH
ORPHAN_IN_PRODUCTION
NEXT_ACTION_MISMATCH
OWNER_MISMATCH
WAITING_STATE_MISMATCH
TEMPORAL_FACT_MISSING
TEMPORAL_FACT_CONFLICT
TEMPORAL_PROJECTION_MISMATCH
UNCONSUMED_DEADLINE
DOCUMENT_MISSING
DOCUMENT_HASH_MISMATCH
EXTRACTION_STATE_MISMATCH
INVOICE_FACT_MISMATCH
CONTRACT_FACT_MISMATCH
CALENDAR_LINK_MISMATCH
AUTHORITY_STATE_ONLY_IN_PRODUCTION
PROGRESSION_STATE_SUSPECT
LEGACY_BUG_ARTIFACT
UNKNOWN_SOURCE_COVERAGE
```

Minden finding:

```text
finding_id
replay_run_id
domain
case_id | null
severity
category
production_value
shadow_value
authority_class
source_refs
recommended_action
auto_apply_allowed = false
status
```

`auto_apply_allowed` v1.0-ban mindig false.

---

# 10. Severity

## P0

Csak akkor, ha replay közben vagy reconciliation során security/data-integrity breach bizonyítható, például:

- cross-domain sensitive data leak;
- production mutation a shadow runból;
- external effect a replayből;
- authority-state elvesztés vagy felülírás.

## P1

Példák:

- VERIFIED critical deadline hiányzik productionból;
- wrong semantic deadline;
- open orphan case;
- Personal↔ZST namespace mismatch;
- source message nincs feldolgozva és releváns;
- duplicate case valódi owner attentiont vagy outboundot okozhat;
- production state olyan legacy bug eredménye, amely silent misshez vezethet.

## P2

- extraction completeness eltérés;
- category/next-action minőségi eltérés;
- calendar link inconsistency külső hatás nélkül;
- nem kritikus waiting/follow-up eltérés.

---

# 11. Special rule: Personal ↔ ZST

Az új v1.2 security boundary szerint a replayben:

```text
Personal connector → Personal operational intake only
ZST connector      → ZST operational intake only
```

Ha Personal mailboxban céges tartalom található:

- Personal oldalon `SCOPE_REVIEW` / bridge-candidate finding;
- automatikus ZST write nincs;
- a shadow replay sem „javítja át” automatikusan ZST-be.

A productionban meglévő történeti crossingokat a reconciliation jelöli, de nem törli át automatikusan.

---

# 12. Special rule: temporal truth

A replay az új Temporal Fact + TSCG modellt használja.

A Hertz/Sixt osztály kötelező replay fixture:

```text
source says DECISION before T1
production due_at represents EVENT_START at T2
T1 < T2
```

PASS csak akkor, ha a shadow:

- külön `DECISION_DEADLINE` factet állít elő vagy `TEMPORAL_CONFLICT`-et jelez;
- nem tekinti az `EVENT_START` dátumot döntési deadline-nak;
- delivery coverage-et követel a critical facthez.

A production-vs-shadow diffben ez `TEMPORAL_PROJECTION_MISMATCH` vagy `TEMPORAL_FACT_MISSING` P1.

---

# 13. Special rule: progression state

A progression state nagyrészt derived runtime state, de nem dobható el vakon.

A replay célja itt:

- azonosítani a progresszionálatlan/open orphan ügyet;
- észlelni legacy bug artifactot;
- összevetni a shadow Actionability/TSCG eredményt a production state-tel;
- megtalálni a disabled/frozen vagy értelmetlen schedule state-et.

A replay **nem másolja vissza** a teljes `case_progression_state` táblát.

A production correction később célzott domain commandokkal történik, findingonként vagy jóváhagyott migration batchben.

---

# 14. Special rule: owner decisions and stale evidence

Owner event mindig erősebb, mint a shadow inference.

Ha a productionban owner döntés történt a replay corpus egy pontja után, a shadow state nem minősítheti azt hibának csak azért, mert a forrásból más döntés következne.

Ehelyett:

```text
AUTHORITY_STATE_ONLY_IN_PRODUCTION
```

vagy, ha későbbi source evidence ellentmond neki:

```text
CLASS_C_REVIEW_REQUIRED
```

A 37 másodperces stale-question fixture replayben is kötelező: owner answer után korábbi evidence packetből nem keletkezhet owner-facing action candidate.

---

# 15. Clean Replay acceptance gate

A replay release gate PASS feltételei:

## 15.1 Corpus integrity

- immutable manifest elkészült;
- input hash rögzítve;
- minden anchor-window thread teljesen betöltve vagy explicit `SOURCE_UNAVAILABLE`;
- attachment retrieval coverage mérve;
- Personal és ZST connector identity külön;
- nincs csendes kimaradás.

## 15.2 Determinism

Ugyanazon corpus + commit hash kétszer replayelve:

```text
source_derived_projection_hash_run1 == source_derived_projection_hash_run2
```

Nem kell egyeznie a runtime-generated random ID-knak; canonical projection hash szükséges.

## 15.3 Safety

```text
external_effect_count = 0
owner_notification_count = 0
production_write_count = 0
```

## 15.4 Semantic gate

- Hertz/Sixt fixture green;
- zero unexplained `UNCONSUMED_DEADLINE`;
- TSCG minden replayelt critical temporal factre futott;
- orphan count mérhető.

## 15.5 Reconciliation completeness

Minden production-vs-shadow eltérés vagy:

- classified finding;
- accepted authority difference;
- explicit UNKNOWN.

Nincs „unclassified diff”.

---

# 16. Production correction policy

A v1.0 replay **nem javít automatikusan productiont**.

A diff után három út van.

## A. Source-derived, egyértelmű correction

Például hiányzó attachment link vagy bizonyított source message.

→ domain command / migration patch készül  
→ acceptance + readback  
→ audit event

## B. Authority-state conflict

Például owner decision vs új source evidence.

→ owner review / decision package

## C. Legacy bulk state

Például sok ZST case hiányos operational projectionnel.

→ canary migration:

```text
dry run
→ 2 case
→ acceptance
→ 5 case
→ acceptance
→ 10 case
→ acceptance
→ remainder
```

A replay output itt migration input, nem automatikus migration.

---

# 17. Helye a fejlesztési sorrendben

A Clean Replay nem az első implementációs lépés, mert az új baseline szerint kell újraszámolnia az állapotot.

Javasolt sorrend:

```text
M0  red acceptance / measurement gates
M1  Temporal Facts + TSCG
M2  Actionability Gate
M3  CPP manifest + zero telemetry
M4  Evidence freshness + backlog-before-fix
M5  strict connector identity / bridge boundary
R1  Clean Replay tooling + immutable corpus
R2  60-day + full-thread Personal replay
R3  60-day + full-thread ZST replay
R4  structured production-vs-shadow reconciliation
R5  approved correction/canary migration plan
M6  Personal remaining hardening
M7  ZST operational migration / domain activation
M8  readiness + 7-day stability window
```

A pontos M6/M7 sorrend változhat, de két invariáns nem:

1. a replay az új TSCG + Actionability + CPP szabályokat használja;
2. a 7 napos unattended stability window **csak a replayből származó P1 reconciliation findingok rendezése után indulhat**.

---

# 18. Kötelező replay fixture-ek

| ID | Fixture | PASS feltétel |
|---|---|---|
| CRR-01 | ugyanaz a corpus kétszer | canonical projection hash azonos |
| CRR-02 | thread kezdete 90 nappal korábban, reply 10 napos | teljes thread bekerül |
| CRR-03 | Sent + reply | egy case, nem két duplicate |
| CRR-04 | COS own-send marker/header hiány, de ledger identity ismert a production overlayben | nem nyit új work itemet vakon |
| CRR-05 | Personal mailboxban ZST tartalom | bridge candidate, nincs auto ZST write |
| CRR-06 | Hertz/Sixt semantic deadline | DECISION_DEADLINE/TEMPORAL_CONFLICT, pickup nem helyettesíti |
| CRR-07 | owner decision productionban | replay nem írja felül |
| CRR-08 | stale Reader packet + későbbi owner answer | owner-facing candidate blocked |
| CRR-09 | attachment duplicate bytes két emailben | content dedup, source links megmaradnak |
| CRR-10 | invoice PDF mező nincs rajta | NOT_PRESENT, nem NULL/UNKNOWN |
| CRR-11 | invoice extractor hibázik | FAILED, nem NOT_PRESENT |
| CRR-12 | production open case shadowban nem rekonstruálható | EXTRA/CLASS_C finding, nem automatikus törlés |
| CRR-13 | shadow external send path próbálna futni | hard FAIL, zero external effects |
| CRR-14 | hiányzó source thread retrieval | SOURCE_UNAVAILABLE/UNKNOWN, nem csendes 0 |
| CRR-15 | legacy ZST case generic DoD alapján lezárható lenne | replay/migration nem auto-close |

---

# 19. Replay report

Minden run végén minimum:

```text
replay_run_id
corpus_manifest_hash
code_sha
personal_messages
zst_messages
threads_expanded
attachments_total
attachments_unavailable
shadow_personal_cases
shadow_zst_cases
production_personal_cases_in_scope
production_zst_cases_in_scope
missing_in_production
extra_in_production
duplicates
namespace_mismatches
thread_mismatches
orphan_production_cases
temporal_fact_missing
temporal_conflicts
unconsumed_deadlines
extraction_mismatches
authority_only_differences
class_c_review_required
unknown_source_coverage
unclassified_diffs
external_effect_count
production_write_count
determinism_hash
result
```

A `result` csak akkor PASS, ha a safety és determinism gate zöld. Reconciliation findingok jelenléte önmagában nem teszi a replay futást technikailag FAIL-lé; azok a production readiness gate-et befolyásolják.

---

# 20. Promotion / readiness kapcsolat

Az unattended readinesshez a Clean Replay kötelező előfeltétel.

Minimum:

```text
latest_clean_replay.status = PASS
unclassified_diffs = 0
P0_reconciliation_findings = 0
P1_unresolved_reconciliation_findings = 0
```

Ezután indulhat a 7 napos stability window.

A replay PASS nem jelent automatikus progression-mode emelést. Csak readiness input.

---

# 21. Implementation work packages

## CRR-W1 — Replay manifest + isolated DB

- replay run schema;
- immutable manifest;
- empty shadow DB lifecycle;
- SHADOW_NO_EFFECTS hard gate;
- code/spec/input fingerprint.

## CRR-W2 — Gmail corpus builder

- Personal + ZST read-only fetch;
- anchor-window discovery;
- full-thread expansion;
- Sent inclusion;
- attachments;
- corpus hash;
- unavailable source reporting.

## CRR-W3 — Replay runner

- chronological deterministic execution;
- production business modules reused;
- no outbound/owner effects;
- canonical projection hashing;
- repeated-run determinism test.

## CRR-W4 — Production snapshot reader

- read-only production snapshot;
- authority class overlay;
- owner/approval/outbound/calendar authoritative facts;
- no mutation.

## CRR-W5 — Diff engine

- taxonomy from §9;
- authority classification;
- severity;
- source refs;
- zero/unclassified semantics.

## CRR-W6 — Reconciliation report + Mission Control view

- summary counts;
- case-level diff;
- filter P0/P1/P2/UNKNOWN;
- production vs shadow evidence view;
- no direct SQL repair button.

## CRR-W7 — Correction-plan generator

- suggested domain commands;
- canary batch generation;
- explicit owner-review queue for CLASS C;
- `auto_apply_allowed=false` enforced.

## CRR-W8 — Acceptance/mutation suite

- CRR-01…CRR-15;
- mutate consumer/temporal/scope/determinism gates and prove RED;
- fixture with pre-existing backlog.

---

# 22. Definition of Done

A Clean Replay & Reconciliation Gate v1.0 DONE, ha:

1. 60 napos anchor window + full-thread expansion működik Personal és ZST domainen;
2. corpus immutable és hash-elt;
3. replay külön DB-ben fut;
4. production write technikailag lehetetlen a replay runnerből;
5. external/owner effect count bizonyítottan nulla;
6. ugyanazon corpus kétszer determinisztikus source-derived projectiont ad;
7. v4.4/v1.2/v1.4.5 shared TSCG + Actionability + CPP logikát használja;
8. production-vs-shadow diff minden eltérést kategorizál;
9. authority class megakadályozza az owner/approval/receipt state felülírását;
10. Hertz/Sixt fixture green;
11. 37 másodperces stale-owner fixture green;
12. Personal/ZST strict connector boundary fixture green;
13. legacy ZST auto-close fixture green;
14. unclassified diff = 0;
15. unresolved P0/P1 finding rendezése nélkül a 7 napos readiness window nem indulhat el;
16. production correction kizárólag külön, auditált domain command/migration folyamatban történhet.

---

# 23. Végső álláspont

A Clean Replay **nem a jelenlegi adatbázis bizalmatlanságának kijelentése**, hanem független újraszámítási bizonyíték.

A helyes minta:

```text
current production state
        +
new-spec deterministic replay
        +
authority-aware diff
        +
controlled correction
        =
trusted post-migration state
```

Ez erősebb, mint egy hagyományos backfill és biztonságosabb, mint egy wipe-and-rebuild.
