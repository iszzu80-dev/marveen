# v1.4 Proactive Core — élő capability audit, 1. rész

**Mit fed le:** a `marveen-autonomous-case-progression-spec-v1.4-proactive-core.md` §25 auditlistájából
az **1–13., 21., 23–24.** pont — a sweep, a kurzor, a due-state, a claim, a határidő-ontológia, az
elakadás-detektálás, a megszakítási cooldown és a jóváhagyási csatorna.

**Mit NEM fed le:** a 14–20., 22., 26–31. pont (Reader-frissesség, Outcome Contract, resolve-before-ask,
draft-only Writer, WAIT_SYSTEM, shadow/replay instrumentáció, standing-check megvalósíthatóság,
adjudication-képesség, reactive baseline replay). Ezek külön menetet igényelnek.

**Módszer:** a tényleges kód olvasása a `claude/cos-autonom-code-review-qv04y2` branch `243f8bc`
állapotán. Minden M-szint fájl:sor bizonyítékkal. Ahol „a review szerint" szerepel, az a
2026-08-13-i code review megállapítása — ez a dokumentum azt **igazolja vagy cáfolja**, nem ismétli.

**Skála:** `M0 ABSENT · M1 PRESENT_UNWIRED · M2 WIRED_TEMPLATE_ONLY · M3 PRODUCTION_ACTIVE_UNVALIDATED · M4 PRODUCTION_VALIDATED`

---

## Összefoglaló mátrix

| # | Auditpont | M | Egy mondatban |
|---|---|---|---|
| 1 | due-case selection (`findDueCases`) | **M4** primitívként / **M1** v1.4-sweepként | Működik és tesztelt, de csak EGY jelöltforrásból válogat az ötből |
| 2 | sweep fairness PRI/ZST | **M3** | Szerkezetileg tisztességes, de nincs kiéheztetés-metrika |
| 3 | cursor monotonicity | **M4** írásra / **M2** detektálásra | Az írás védve; a reconcile-ellenőrzés STRINGként hasonlít |
| 4 | batch continuation / no silent truncation | **M1** | A repóban **nulla** `has_more`/continuation; egy helyen van jelentés |
| 5 | due-state advancement | **M3** | Ma landolt; mindkét ág `deferProgression`-t hív |
| 6 | claim idempotency / fencing | **M4** | Feltételes UPDATE + fence, alaposan tesztelt |
| 7 | deadline storage/index | **M1** | 14 fogalom, 13 tábla, 3 index, nincs egységes nézet |
| 8 | `follow_up_at` szemantika | **M3** + veszélyforrás | Él, de ma bizonyítottan félreolvasták |
| 9 | stagnant Case detection | **M3** jelentésre / **M0** cselekvésre | Riportál, nem cselekszik |
| 10 | `no_progress_run_count` | **M3** | Karbantartott, olvasott |
| 11 | repeated NBA detection | **M0** | Nincs |
| 12 | per-Case interruption cooldown | **M4** | 6h, két kivétellel — a review állítása igazolva |
| 13 | question queue priority ordering | **M2** | Olvasási sorrend, nem határidő. `0d2121a9` **nyitva** |
| 21 | deadline-ontológia leltár | **M0** | Nem létezik; ez a dokumentum az első |
| 23 | approval queue / rate limit / telemetria | **M0** | Nincs approval-sor, nincs plafon, nincs open-telemetria |
| 24 | approval deadline-escape / rendezés | **M0** | Nincs `latest_present_by`, nincs `internal_safe_deadline` |

**A három legfontosabb következtetés:**

1. **A sweep-oldal és a jóváhagyás-oldal érettsége nem hasonlítható össze.** A §17.3 helyesen mondja,
   hogy a meglévő cooldownt kell újrahasználni — az valóban M4. De a §17.5 jóváhagyási pipeline-nak
   **nincs mit újrahasználnia**: M0. A spec a kettőt párhuzamosként kezeli; az érettségük M4 vs M0.
2. **A határidő-ontológia 4–5-szöröse annak, amit a spec feltételez.** A §10.3 három fogalmat nevez
   meg; a valóság **14 oszlop 13 táblában**, három típuskonvencióval.
3. **Három konkrét elem a v1.4 invariánsainak előfeltétele, és mind nyitva van** — lásd a záró
   szakaszt.

---

## 1. Due-case selection — `findDueCases`

`src/cos/progression-scheduler.ts:103-134`

```sql
SELECT case_id, next_progression_at, progression_claimed_by, progression_claim_expires_at
FROM case_progression_state
WHERE domain = ? AND progression_enabled = 1
  AND next_progression_at IS NOT NULL AND next_progression_at <= ?
ORDER BY next_progression_at ASC LIMIT ?
```

Indexelt: `idx_cps_next_prog ON case_progression_state(domain, next_progression_at) WHERE progression_enabled = 1`
(`schema.ts:1734`) — a részleges index pontosan a WHERE-hez illeszkedik. Domain-szkópolt, read-only,
nem claimel. Tesztelt: `progression-checkpoint-e3.test.ts:303+` (due/nem-due/letiltott/NULL esetek).

**M4 mint primitív.** De a v1.4 §11.1 ötféle jelöltforrást ír elő:

| §11.1 forrás | Ma |
|---|---|
| due deadlines | ✗ (a `next_progression_at` nem határidő, hanem ütemezési időbélyeg) |
| due follow-ups | ✗ (külön sweep, `followup-autodraft.ts`) |
| stale waits | ✗ |
| stagnant/no-progress candidates | ✗ (külön reconcile-check, csak riport) |
| explicitly scheduled `review_at` | ✓ (ez a `next_progression_at`) |

**Mint v1.4 sweep candidate selection: M1.** Az egyesítés valódi építés, nem bekötés.

---

## 2. Sweep fairness

**Progression-heartbeat: szerkezetileg tisztességes.** `progression-heartbeat.ts:111-112`:

```ts
for (const domain of ['personal', 'zst'] as const) {
  const due = findDueCases(db, domain, now, maxPerDomain)
```

A limit **domainenként** érvényes, tehát egyik ág sem eheti fel a másik keretét. Ez nem policy,
hanem a ciklus alakja — erősebb, mint egy szabály.

**Reader/enrichment sweep: ma javítva.** A `roundRobinByDomain` (`reader-cycle.ts:94-110`) valódi
körbeosztás, és a `goal-enrichment.ts:75` is ezt használja. Teszt: `cos-sweep-fairness.test.ts`
(6 eset, köztük „a Reader elér egy zst ügyet hat személyes ügy mögül").

**M3, nem M4** — mert hiányzik a §11.3 megfigyelhetőség: `domain_lag`, `starvation_detected`,
`oldest_unprocessed_age` egyike sincs kiszámolva sehol.

**Delta a v1.4-hez:** a fairness ma egyenlő osztás. A §11.2 E pont súlyozott rendezést kér
(határidő → materialitás → legrégebbi due), ami **más kérdés** — lásd a 13. pontot.

---

## 3. Cursor monotonicity — kettéválik

### Az írási út: M4

`email-ingest.ts:271-280`, ma landolt:

```ts
function checkpointHoldReason(batchId, cursorAfter, current): string | null {
  if (isTriageBatch(batchId)) return 'triage batch carries no history position'
  const next = cursorRank(cursorAfter)
  if (next == null) return `cursor_after is not a historyId: ${cursorAfter}`
  const now = cursorRank(current)
  if (now != null && next <= now) return `cursor would regress: ${cursorAfter} <= ${current}`
  return null
}
```

Mindhárom v1.4 B-invariáns teljesül: **numerikus** rank-összehasonlítás (nem string), a szintetikus
triage-érték soha nem ír source cursort, és a kurzor csak terminalizált batch után lép
(`tryAdvanceCheckpoint` egy tranzakcióban, `email-ingest.ts:240-267`).

Tesztek: `cos-email-ingest.test.ts` — „a batch closing out of order does NOT pull the cursor
backwards" (85), „a TRIAGE batch closes but never writes its wall-clock stamp" (118), „a triage batch
does not seed a garbage checkpoint on a fresh account either" (136), „sequential batches advance the
cursor forward" (200).

### A detektálási út: M2 — **nyitott hiba**

`reconcile.ts:378-379`:

```sql
WHERE b.status IN ('OPEN','PROCESSING') AND b.cursor_after IS NOT NULL
  AND cp.history_cursor IS NOT NULL AND cp.history_cursor >= b.cursor_after
```

Ez **TEXT-összehasonlítás numerikus historyId-kon**: `'999' >= '1000'` igaz. Az az ellenőrzés, amely
a kurzor-regressziót hivatott CRITICAL-ként jelenteni, egyszerre tud fals pozitívat és fals negatívat
adni.

A code review ezt jelentette, a javítás egy tulajdonos nélküli fájlba esett, és **nem landolt**.
A `cursor_regression_count = 0` production acceptance (§11.3) addig nem mérhető érvényesen, amíg ez
így áll.

---

## 4. No silent truncation — M1

**A repóban nulla találat** `has_more`, `hasMore` és `continuation` mintára a `src/cos/` alatt.

Csendben vágó helyek:

| Hely | Bound | Jelent? |
|---|---|---|
| `progression-scheduler.ts:106` `findDueCases` | `LIMIT 50` (default) | ✗ |
| `owner-question.ts:298` kérdés-jelöltek | `LIMIT 50` | ✗ |
| `reader-cycle.ts` / `goal-enrichment.ts` | `roundRobinByDomain(items, limit)` | ✗ |
| `followup-autodraft.ts:156` | `scanWindow + 1` | ✓ **egyetlen** |

A `followup-autodraft` ma kapott `scan_window_exhausted` skip-jelentést — ez az egyetlen sweep, amely
kimondja, hogy a bound betelt. A v1.4 C-invariáns (`has_more`/continuation token kötelező) minden
másra **megépítendő**, nem bekötendő.

---

## 5. Due-state advancement — M3

Ma landolt (`progression-heartbeat.ts:35, 165, 194`):

```ts
export const POST_RUN_RECHECK_SEC = 300      // futás után
export const NO_TRIGGER_BACKOFF_SEC = 900    // §10.8 „nincs mit tenni" után
```

Mindkét ág hív `deferProgression`-t, tehát a claim-and-release végtelen hurok — amely a review
mérése szerint 24 óra alatt 10 716 futást termelt 101 ügyön — megszűnt.

`deferProgression` (`progression-scheduler.ts:67-83`) csak olyan ügyet tol el, amely **jelenleg due**
(`AND next_progression_at <= ?`), tehát nem tud egy jövőbeli ébresztőt visszahúzni.

**Két megjegyzés a D-invariánshoz:**
- A függvény nem kényszeríti ki, hogy az ÚJ érték `> now` legyen. Ma mindkét hívó `now + X`-et ad, de
  a szerződés nincs a kódban.
- A completion-út (`progression-pipeline.ts:1399`) `scheduleNextProgression(..., null, ...)`-t hív,
  ami **kikapcsolja** az ébresztőt. Ez helyes lezáráskor, de a D-invariáns „minden claimelt candidate
  után explicit next_review_at, state transition VAGY completion" hármasából ez a harmadik ág — a
  megvalósításnak ezt meg kell tudnia különböztetni az elfelejtéstől.

---

## 6. Claim idempotency / fencing — M4

**Két mechanizmus, szándékosan:**

1. **Progression-lease** — `tryClaimProgression` (`progression-scheduler.ts:155-193`): egyetlen
   feltételes UPDATE, `changes === 1` a nyertes. A SQLite szerializálja az írásokat, tehát két
   párhuzamos futó nem láthatja mindkettő igaznak. Tesztelt: `progression-checkpoint-e3.test.ts:170+`
   (claim, nem-due, letiltott, NULL, más által foglalt, lejárt lease újrafoglalása, cross-domain).
2. **Fence** — a heartbeat tükrözi a claimet `case_claims`-be monoton fence-tokennel
   (`progression-heartbeat.ts:138-142`), mert a lease-nek nincs fence-e, és egy lejárt lease-ű,
   későn ébredő worker írása különben észrevétlen marad.

**Ma két változás:**
- A route (`routes/cos.ts`) mostantól claimel az owner-action ciklus előtt, `randomUUID()`-vel,
  `requireDue: false` opcióval — mert a kézi trigger sosem esedékes, és a due-feltétel változatlan
  átvétele csendben visszanyitotta volna a versenyt.
- A `tryClaimProgression` kapott egy `opts.requireDue` kapcsolót; az alapérték változatlan.

**Egy fennmaradó él (E2 a review-ból):** az `acquireClaim` (`case-engine-core.ts:306-325`) azonos
ownerre **újrabelépő** — élő claimnél az upsert no-op, de a SELECT `acquired: true`-t ad ugyanazzal a
fence-szel. Ez ma sehol nem sül el (a heartbeat és a route is egyedi runId-t használ), de a v1.4
F-invariáns („retry nem hozhat duplikált side effectet") **ettől a hívói fegyelemtől függ**, nem a
primitívtől. Ha a v1.4 sweep új claim-hívót vezet be, ezt kódban kell kikényszeríteni.

---

## 7 + 21. Határidő-tárolás és -ontológia — M1, illetve M0

A §10.3 három fogalmat nevez meg. A tényleges leltár a `schema.ts`-ből:

| Oszlop | Tábla(k) | Típus |
|---|---|---|
| `due_date` | `case_documents`, `personal_invoices`, `cos_documents`, `zst_invoices`, `zst_obligations`, `zst_product_milestones` | TEXT (ISO) |
| `follow_up_at` | `personal_cases`, `zst_cases`, `zst_obligations` | INTEGER (unix) |
| `next_wake_at` | `personal_cases`, `zst_cases` | INTEGER |
| `next_progression_at` | `case_progression_state` | INTEGER |
| `next_check_at` | `radar_items` | INTEGER |
| `termination_deadline` | `zst_contracts` | TEXT |
| `expiry_date` | `zst_contracts` | TEXT |
| `notice_period_days` | `zst_contracts` | INTEGER (nap, nem időbélyeg) |
| `renewal_date` | `zst_licenses` | TEXT |
| `notice_period` | `zst_licenses` | TEXT |
| `valid_until` | `campaign_approvals`, `zst_campaign_approvals` (az `APPROVAL_ENVELOPE` `ensureColumns`-on át, `schema.ts:106, 675, 1294`) | INTEGER |
| `expires_at` | `action_authorizations` | INTEGER |

**14 határidő-hordozó oszlop, 13 tábla, három konvenció** (unix INTEGER, ISO TEXT, és egy
nap-számláló, ami csak egy másik dátummal együtt jelent határidőt).

**Indexelt négy fogalom, öt indexszel:** `idx_pcases_wake`, `idx_zcases_wake` (`next_wake_at`,
részleges), `idx_radar_due(status, next_check_at)`, `idx_zlic_renewal(renewal_date)`,
`idx_cps_next_prog(domain, next_progression_at)` — az utóbbi kettő részleges. **Indexeletlen:**
`follow_up_at` (három tábla), `due_date` (hat tábla), `termination_deadline`, `expiry_date`,
`notice_period_days`, `notice_period`, `valid_until`, `expires_at`.

A hiányzó `follow_up_at`-index önmagában is figyelemre méltó: a §11.1 „due follow-ups" jelöltforrás
pontosan ezen az oszlopon fog söpörni, három táblában, index nélkül.

**Két olvasó létezik, egyik sem egységes:**
- `zst-watch.ts:39-56` — csak céges szerződés/licenc/kötelezettség, SQL-ben számolt
  „expiry − notice_period" logikával, `date('now','localtime')`-ra.
- `progression-trigger.ts:216-226` `dueDeadline` — csak `next_wake_at` és `follow_up_at`, és csak
  **múltbeli** határidőket ad vissza (`d <= now`), tehát közelgő határidő felismerésére alkalmatlan.

**Következtetés:** a §10.2 „lekérdezhető deadline index" nem meglévő nézet bizonyítása, hanem építés.
A §10.3 leltár-kötelezettség pedig 14 sorra vonatkozik, nem háromra — és a típuskonverzió
(ISO TEXT ↔ unix INTEGER) önmagában hibaforrás, amit a normalizált nézetnek fel kell oldania.

---

## 8. `follow_up_at` szemantika — M3, dokumentált veszélyforrással

Írja: `intake.ts` (felvételkor), `case-store`/engine (állapotváltáskor).
Olvassa: `dueDeadline` (triggerként), `sweepFollowUpCandidates` (sweep-kulcsként),
`reconcile` (`repeatedFollowUp` check), `owner-question` (közvetve).

**Jelentése: „mikortól esedékes az utánkövetés"** — nem az, hogy mikor ment ki a megkeresés.

Ezt ma bizonyítottan félreolvasták: a `followup-autodraft` a „megkeresés óta eltelt N nap" mondatot
`follow_up_at`-ból számolta, és **valódi címzettnek küldött volna rossz számot**. Javítva: a szám
mostantól az utolsó tényleges küldésből (`outbound_ledger.applied_at`), illetve annak hiányában a
case `created_at`-jából jön.

**Delta a v1.4-hez:** a §10.3 leltárban a `follow_up_at` státusza `ADAPTED_TO_INDEX` kell legyen,
és a `semantic_owner` mezőnek ki kell mondania, hogy ez **esedékességi**, nem **eseményidő**.

---

## 9 + 10. Elakadás-detektálás — M3 jelentésre, M0 cselekvésre

`reconcile.ts:528-546` `stagnantCases`:

```
STAGNATION_RUNS = 12
ENGINE_ACTIONABLE = NEW, READY, EXECUTING, FOLLOW_UP_DUE, INFORMATION_REQUIRED, INFO_REQUIRED, RECOVERY_REQUIRED
```

Csak olyan ügyet jelent, amit a motor még ténylegesen pörget — egy lezárt ügy magas számlálóval
történelmi tény, nem élő panasz. Mellette `awaitingOwnerTooLong` (`reconcile.ts:574`).

A `no_progress_run_count` karbantartott: `progression-pipeline.ts:1347-1353` írja, a §-beli no-op
definíció szerint (1290).

**A hiányzó fél:** mindkettő **riport**. A v1.4 §12 azt kéri, hogy az elakadásból *signal* legyen,
ami kvalifikáción megy át és belső előkészítést indít. Ez a lánc nem létezik → **M0**.

---

## 11. Ismétlődő NBA detektálása — M0

A §12 „repeated identical Next Best Action" jelöltforrást ír elő. A `next_best_action_json`-t
összehasonlító logika **nincs** a kódban (grep). A `no_progress_run_count` közelít hozzá, de az a
*futás* no-op voltát méri, nem az NBA azonosságát.

---

## 12. Per-Case interruption cooldown — M4, a review állítása igazolva

`owner-question.ts:192-211`:

```ts
export const ASK_COOLDOWN_SEC = 6 * 3600
```

**A két kivétel, amit a §17.6.1 nevesít, igazolva:**

1. **A tulajdonosi válasz azonnal old** — `askedRecently()`: `if (row.last_answer >= row.last_ask) return false`.
   A kód indoklása: „egy válasz a legutóbbi kérdés óta azt jelenti, hogy a tulajdonos foglalkozik az
   üggyel; a következő kérdés része ennek a beszélgetésnek, nem zaj rajta."
2. **Az újrafogalmazás nem új kérdés** — `hasOtherOpenQuestion()` (221-232): más hash-ű nyitott
   kérdés esetén az új ask **csere**, nem hozzáadás. A cserélt sor `superseded_at`-ot kap, nem
   `answered_at`-ot — a séma kommentje (`schema.ts:1852-1856`) külön kimondja, hogy miért.

A cooldown **nem** a kérdés hash-ére kulcsolódik, szándékosan: a hiba az volt, hogy egy ügy mindig
talált újat kérdezni.

**Ez tehát valóban újrahasználható a §17.3 értelmében** — az interruption-csatornára. Az
approval-csatornára nem (lásd 23.).

---

## 13. Question queue priority ordering — M2, **nyitva** (`0d2121a9`)

`owner-question.ts:298`:

```sql
ORDER BY p.created_at DESC LIMIT 50
```

A `created_at` itt az **evidence packet** létrejöttének ideje: a legfrissebben olvasott ügy kérdez
először. Ez pontosan az, amit a §11.2 E pont kizár („nem elfogadható a puszta »latest read order«").

A plafon így megtelhet a legkevésbé sürgős kérdésekkel, miközben lejárt határidejű ügyek várnak — a
2026-08-11-i postmortem 5. szakasza ezt már kártyázta (`0d2121a9`), és **a javítás nem történt meg**.

**Ez a §11.2 E pont előfeltétele:** amíg a kérdés-sor olvasási sorrendben áll, a „hard deadline →
materialitás → legrégebbi due" rendezés nem bizonyítható, mert nincs mihez rendezni — a 7. pont
szerint a határidő-adat nem lekérdezhető egységes nézetben.

---

## 23. Approval queue / rate limit / telemetria — M0

**Nincs approval-sor.** Ami van:

| Tábla | Mi | Van rátakorlát? | Van open/read? |
|---|---|---|---|
| `campaign_approvals`, `zst_campaign_approvals` (`schema.ts:523, 1271`) | per-payload jóváhagyási **boríték** (TTL, címzett-allowlist, plafon) | ✗ | ✗ |
| `approvals` (`db.ts:884`) | flotta-ágens jóváhagyási kérés (`agent_id`, `category`, `timeout_at`, `telegram_message_id`) | ✗ | ✗ |
| `cos_owner_questions` (`schema.ts:1844`) | tulajdonosi **kérdés** — ennek VAN cooldownja | ✓ (6h) | ✗ |

Grep a teljes sémán: **nincs** `opened_at`, `read_at`, `seen_at`, `viewed` oszlop sehol. Grep az
approvals route-on és az `approval-core`-on: **nincs** cooldown, rate limit, per-user vagy per-case
plafon.

**Következtetés, és ez a legfontosabb eltérés a spec feltételezésétől:** a §17.3 azt mondja,
„auditáld és használd újra a meglévő mechanizmust, ne építs másodikat". Ez az **interruption**
csatornára igaz és helyes (M4). A §17.5 **approval** pipeline-jának viszont nincs mit újrahasználnia:

```
interruption-csatorna:  M4  (6h cooldown, két kivétellel, tesztelt)
approval-csatorna:      M0  (nincs sor, nincs plafon, nincs telemetria)
```

A `approval_without_open_rate` a §17.8-ban helyesen van feltételhez kötve („csak akkor SLO, ha a
telemetria megbízható") — az audit válasza: **ma nincs ilyen telemetria**, tehát a v1.4 indulásakor
ez `capability gap`, nem nulla.

---

## 24. Approval deadline-escape és rendezés — M0

A §17.6 `latest_present_by` és `internal_safe_deadline` mezőket ír elő minden `DEFER` állapotú
approval candidate-re. Egyik sem létezik semmilyen approval-táblán.

Ami közel van: a `campaign_approvals.valid_until` — de az **lejárat** (a jóváhagyás mikor veszti
érvényét), nem **bemutatási határidő** (mikorra kell a tulajdonos elé kerülnie). A kettő ellentétes
irányba mutat: a `valid_until` a jóváhagyás halála, a `latest_present_by` a bemutatás kényszere.

Az `approvals.timeout_at` (`db.ts:892`) sem az: az a kérés automatikus lejárata, ami az ellenkezője
annak, amit a deadline-escape véd.

**A queue rendezhetősége** ezért ma nem értelmezhető: nincs sor, és nincs mi szerint rendezni.

---

## Amit ez az audit a v1.4 tervhez ad

### Három nyitott elem, amely v1.4-invariáns előfeltétele

1. **`reconcile.ts:379` string-összehasonlítás** → a B-invariáns *detektálása* hibás. Amíg így áll, a
   `cursor_regression_count = 0` acceptance nem mérhető érvényesen. Kicsi javítás, tulajdonos nélkül
   maradt.
2. **Nincs continuation sehol** (`has_more` nulla találat) → a C-invariáns nem „bekötés", hanem
   négy sweep-en megépítendő. A `followup-autodraft` mai `scan_window_exhausted` jelentése a minta.
3. **A kérdés-sor olvasási sorrendben áll** (`0d2121a9`) → az E-invariáns előfeltétele, és önmagában
   sem javítható, amíg a 7. pont szerinti egységes határidő-nézet nincs meg.

### Két helyen a spec becslése tér el a valóságtól

- **A határidő-ontológia 14 fogalom, nem 3.** A §10.3 leltár-kötelezettség ennek megfelelően
  nagyobb munka; a típuskonverzió (ISO TEXT ↔ unix INTEGER ↔ nap-számláló) külön döntést igényel.
- **Az approval-csatorna M0, nem „meglévő, újrahasználandó".** A §17.5–17.6 teljes egészében
  greenfield a v1.4-en belül. Ez nem érv a scope ellen — de a becslésben nem szabad
  „a cooldown már megvan" alapon szerepelnie, mert az a másik csatorna.

### Amit a v1.4 nyugodtan újrahasználhat

`findDueCases` + `tryClaimProgression` + fence + `deferProgression` együtt egy **működő, tesztelt,
indexelt due-loop** — a sweep gerince megvan. A `roundRobinByDomain` fairness-primitív kész. A
kurzor írási útja megfelel mind a három B-invariánsnak. A 6 órás cooldown a két kivételével
dokumentált és tesztelt.

---

## Következő menet

A hátralévő auditpontok: 14–20. (Reader-frissesség, Outcome Contract, resolve-before-ask, draft-only
Writer, WAIT_SYSTEM), 22. (standing-check megvalósíthatóság a `cos-gate-permit.test.ts` mintán),
26–27. (reactive baseline független replay, 90 napos volumen-kalibráció), 29–31. (adjudication-packet
kanonizálás, origin-guess telemetria, elbíráló-függetlenség).

A 26–27. pont a legsürgősebb, mert a §1.4.1 value-gate regisztrációt **a shadow előtt** kell
befagyasztani, és ahhoz a 90 napos replay eligible-volumene és a blinding mintaigénye kell — a
kettő közül a hosszabb ablakot választva.
