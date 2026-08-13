# v1.4 Proactive Core — élő capability audit, 2. rész

**Mit fed le:** a §25 auditlistából a **14–20., 22., 26–31.** pont — a Reader/Outcome/resolve oldal,
a shadow/replay instrumentáció, a standing-check megvalósíthatóság, és a value-gate mérési apparátus
(reactive control, volumen-kalibráció, adjudication, origin-guess, elbíráló-függetlenség).

**Előzmény:** `v14-proactive-core-capability-audit-2026-08-13.md` (1–13., 21., 23–24. pont).

**Módszer és skála** azonos az 1. résszel: a `243f8bc` állapot tényleges kódja, fájl:sor bizonyítékkal,
`M0 ABSENT · M1 PRESENT_UNWIRED · M2 WIRED_TEMPLATE_ONLY · M3 PRODUCTION_ACTIVE_UNVALIDATED · M4 PRODUCTION_VALIDATED`.

**Egy fontos korlát elöl:** ebben a konténerben **nincs élő adat**. A `store/` 68 KB, frissen jött
létre a tesztfutásoktól; nincs 90 napos korpusz. A 27. pont ezért **a kalibráció képességét** méri, nem
a kalibrációt magát — azt élő store mellett kell lefuttatni. Ahol számot kellene mondanom, ott azt
mondom meg, mivel lehet megmérni.

---

## Összefoglaló mátrix

| # | Auditpont | M | Egy mondatban |
|---|---|---|---|
| 14 | duplicate message/case protection | **M4** | Három UNIQUE + `ALREADY_PROCESSED` ág |
| 15 | Reader evidence freshness | **M3** | Futáshoz kötött, nem órához — de nincs abszolút avulási plafon |
| 16 | Outcome Contract availability | **M3** | Minden futás ír DoD-t, de heurisztikából, ha nincs enrichment |
| 17 | Resolve-before-ask path | **M3** | Két élő forrás + audit-nyom; a §14 nyolc lépcsőjéből öt |
| 18 | draft-only Writer | **M3** | Nincs tool a kezében, de a „draft-only" nincs kódban kikényszerítve |
| 19 | WAIT_SYSTEM / capability recovery | **M1** | A trigger-szókincs kész, a *state* nincs |
| 20 | shadow/replay instrumentáció | **M3** | Gazdag run-ledger + működő dry-run driver |
| 22 | standing-check megvalósíthatóság | **M4** mintaként / **M0** alkalmazva | A `cos-gate-permit` minta bizonyítottan működik |
| 26 | reactive baseline független replay | **M2** | A driver megvan, a *kontroll-kar* fogalma nincs |
| 27 | 90 napos volumen-kalibráció | **M1** | A lekérdezhető adat megvan, a kalibrációs futás nincs |
| 28 | draft factual-claim derivation | **M2** | Ma javítva egy helyen; nincs általános derivation-record |
| 29 | adjudication packet kanonizálás | **M0** | Nincs |
| 30 | origin-guess telemetria | **M0** | Nincs |
| 31 | elbíráló-függetlenség | **M0** | Nincs |

**A három legfontosabb következtetés:**

1. **A value-gate mérési apparátusa (29–31.) teljes egészében M0**, de a hozzá vezető
   infrastruktúra (20., 26.) M2–M3. A hiányzó darab nem a replay, hanem a **kontroll-kar fogalma**:
   ma egy futtatható motor van, nem kettő, amelyet egymás ellen lehetne mérni.
2. **A 27. pont ma elvégezhető** — a lekérdezések adottak, csak élő store kell hozzá. Ez a
   legolcsóbb következő lépés, és a §1.4.1 befagyasztás előfeltétele.
3. **A 19. pont a legfélrevezetőbb állapotban van:** a `CAPABILITY_RECOVERED` trigger létezik és
   szerepel a séma CHECK-jében, tehát egy audit „megvan"-nak olvashatja — de a hozzá tartozó
   *várakozó állapot* nincs, tehát ma nincs mit felébreszteni.

---

## 14. Duplicate message/case protection — M4

Három rétegű, mind a sémában kikényszerítve:

| Réteg | Hol | Mit véd |
|---|---|---|
| `UNIQUE(gmail_account_id, message_id)` | `schema.ts:470` (`email_processing`) | ugyanaz az üzenet kétszer |
| `uq_email_processing_msg` egyedi index | `schema.ts:586` | ugyanaz, index-szinten |
| `UNIQUE(gmail_account_id, thread_id, message_id)` | `schema.ts:575` | szál-szintű ismétlés |
| `UNIQUE(gmail_account_id, message_id)` | `schema.ts:1196` (ZST oldal) | céges ág |

Felette az alkalmazás-szintű ág: a `triage-bridge.ts:50-55` egy már látott üzenetre
`ALREADY_PROCESSED`-et ad vissza, és nem nyúl a sorhoz („no duplicate case, no clobbering a terminal
row").

**Delta a v1.4-hez:** ez az *üzenet*-szintű dedup. A §7 `dedupe_key`/`novelty_key` a **signal**
szintjén kell — szemantikai ujjlenyomat, aktív Initiative-ekvivalencia, aktív Case-állapot-ekvivalencia.
Az alap szilárd, a fölé építendő réteg új.

---

## 15. Reader evidence freshness — M3

A frissesség **nem órához, hanem futáshoz** van kötve (`reader-cycle.ts:112-150`): újraolvasandó az
az ügy, amelyik a legutóbbi olvasás óta **futott**.

```sql
WHERE r.started_at > COALESCE((
  SELECT MAX(p.created_at) FROM case_evidence_packets p
  WHERE p.domain = r.domain AND p.case_id = r.case_id), 0)
```

A kód indoklása pontos: a §10.8 trigger-szerződés már eldöntötte, melyik ügynek volt oka gondolkodni,
és egy „nincs új" miatt kihagyott ügy éppen az, amelyiknek az előző olvasata még áll. Enélkül a sweep
tíz percenként újraolvasna 90 változatlan ügyet — modellhívással.

**Ami hiányzik:** nincs **abszolút** avulási plafon. Egy ügy, amelyik hónapokig nem futott, a
legutóbbi olvasatával dolgozik, bármilyen régi az. A 2026-08-11-i postmortem 4. pontja pontosan ezt a
hibaosztályt írta le (tíz órával korábbi olvasat frissnek látszott) — a javítás a *mozgás*
detektálását kötötte be, nem az öregedést.

**Delta:** a §46-os freshness-fogalom (`observed_at`, `valid_until`, `superseded_by`) az evidence
packetre ma nem érvényes.

---

## 16. Outcome Contract availability — M3

`deriveOutcomeContract` (`progression-pipeline.ts:105`) minden futáson lefut, és a
`definition_of_done_json` + `success_evidence_requirements_json` minden futáson íródik
(`pipeline:1158`).

**A minőségi kérdés:** a szerződés a `title, case_type, status, sensitivity` négyesből származik —
heurisztika, nem a Reader ítélete. A pipeline saját kommentje (636) rögzíti, hogy a `goal` mezőt
*minden* futás felülírja a heurisztikus értékkel, kivéve ahol az enrichment már beírt egy jobbat.

**Delta a v1.4-hez:** a §9 megköveteli, hogy **minden promotált Initiative-nek** legyen `DesiredOutcome`,
és hogy ne maradhasson „nézzük meg" állapotban. A tároló és az író megvan; ami hiányzik, az a
`GENERIC_STATUS_TEMPLATE` és a `CASE_SPECIFIC` DoD megkülönböztetése a promóciós döntésben — ez a
2026-08-09-i hamis lezárások gyökere volt, és a completion-gate ma már nézi, a *promóció* még nem.

---

## 17. Resolve-before-ask — M3

`progression-resolver.ts` két **élő belső** forrást ad a Checkpoint B DB-only változatához:

1. teljes e-mail-szál (`email_processing` / `zst_email_processing`) — nem csak a kiváltó levél;
2. domain-biztos memória (`memories_fts`).

Minden feloldás `ResolutionAudit`-ot ad vissza (`sources_attempted`, `facts_found`, `remaining_gap`,
`why_blocking`) — **akkor is, ha nem hiányzik semmi**, hogy egy későbbi `ASK_INFORMATION` meg tudja
mutatni, mit próbáltak már.

A resolver az untrusted-forward jelölést is viszi (`progression-resolver.ts:22-30`): a szál és a
memória is injekciós felület, ezért a LLM-fogyasztó szelet előtt DATA-ként kell címkézni.

**A §14 nyolc lépcsőjéből öt van meg:** Case-adat ✓, Case-események ✓, e-mail-szál ✓, memória ✓,
determinisztikus derivált tények ✓ — **hiányzik**: már beolvasott Drive/dokumentum-evidence, Calendar,
Contacts.

---

## 18. Draft-only Writer — M3

A Writer tool nélküli: a `progression-pipeline` shadow-ágon kimondottan no-op a kommunikáció
(`pipeline:596-597`: „Communication step documented; shadow mode — no actual send"), és a küldés
kizárólag az `executeAction` choke-ponton át mehet, amit az 1. rész E-blokkja fed.

**Ami hiányzik:** a „draft-only" ma a **hívási gráf tulajdonsága**, nem kikényszerített invariáns.
Nincs olyan teszt, amely elbukna, ha a Writer-út egyszer kapna küldő-képességet.

**Ez pontosan a 22. pont tárgya** — és ott van rá bizonyított minta.

---

## 19. WAIT_SYSTEM / capability recovery — M1, és félrevezető

**Ami van:** a `CAPABILITY_RECOVERED` trigger-érték létezik a szókincsben
(`progression-trigger.ts:31, 57`) és a séma CHECK-jében (`schema.ts:1770`), valamint a pipeline
trigger-uniójában (`pipeline:728`).

**Ami nincs:** maga a **várakozó állapot**. Grep a `WAIT_SYSTEM` és `WAITING_CAPABILITY` mintára a
`src/cos/` alatt: **nulla találat**. A `ProgressionDecision` enumban nincs ilyen érték; a
`case_progression_state`-en nincs capability-várakozás mező.

**Miért ez a legfélrevezetőbb sor a mátrixban:** egy audit, amely a trigger-szókincset nézi, „megvan"-t
ír. A valóság: a rendszer **fel tudna ébredni** egy visszatérő képességre, de **nincs mit felébreszteni**,
mert nincs olyan állapot, amelybe egy képességhiány miatt kerülne. Ma a képességhiba vagy kivétel
(a ciklus elbukik), vagy `RECOVERY_REQUIRED` — ami a §19 szerint kifejezetten **nem** lehet a
rendszerhibák helye, mert az emberhez visz.

**Delta:** a §19 „rendszerhiba ne legyen Needs István" követelménye új állapotot és új döntést kér.
Ez a v1.4 egyik valódi építési tétele, nem bekötés.

---

## 20. Shadow/replay instrumentáció — M3

**Run-ledger:** a `case_progression_runs` (`schema.ts:1739-1771`) gazdag — `context_hash`,
`decision`, `reason`, `progress_delta_json`, `action_ids_json`, `safety_assertions_json`,
`case_version_before/after`, `plan_version_before/after`, `trigger_type` + `trigger_reference`.
Egy futás visszajátszható belőle.

**Replay-driver:** `scripts/cos-dryrun-progression.ts` — és ez fontosabb, mint amilyennek látszik:

- a **live store MÁSOLATÁN** fut, és névre megtagadja a live DB megnyitását (32-38);
- N cikluson át hajtja a motort minden nem-terminális, engedélyezett ügyön (76-90);
- `--unfreeze` kapcsolóval elő tudja állítani azt az állapotot, amit egy újra-élesítés produkálna;
- a saját fejléce rögzíti, miért létezik: a 2026-08-09-i tömeges lezárás után egy kétügyes élő canary
  „semmit nem bizonyított volna egy ciklus után — a lezáráshoz négy kell".

**Ami hiányzik a value-gate-hez:** a script **stdout-ra riportál**, nem perzisztál immutable
run/config ID-val. A §1.4.6 „a saját outputját függetlenül és immutable módon rögzíti az adjudication
előtt" követelményéhez ez a kimeneti oldal hiányzik — a bemeneti oldal (frozen korpusz-másolat) kész.

---

## 22. Standing-check megvalósíthatóság — M4 mintaként, M0 alkalmazva

A §15.3 kódszintű release-határt kér. A minta **bizonyítottan működik ebben a repóban**:
`cos-gate-permit.test.ts` a `readdirSync`-kel bejárja a repót (33), `readFileSync`-kel olvassa a
forrásokat (106, 114), és regexszel kényszeríti ki, hogy **pontosan két kapu** bocsáthat ki permitet —
a teljes `src/` és `scripts/` felett.

**Amit ez a v1.4-nek jelent:** a `proactive-core-action-boundary.test.ts` és a
`proactive-core-import-boundary.test.ts` nem kutatás, hanem másolás-és-átszabás. A §15.3 öt
bukási feltételéből négy közvetlenül kifejezhető ebben a mintában; az ötödik (tranzitív
függőség-lezárás) importgráf-bejárást igényel, ami a meglévő minta bővítése.

**Ez egyben a 18. pont megoldása is:** a „draft-only Writer" ugyanezzel a formával válik
kikényszerített invariánssá.

---

## 26. Reactive baseline független replay — M2

**A driver megvan** (20. pont). Amit a §1.4.6 öt feltételéből teljesíteni tud:

| §1.4.6 feltétel | Ma |
|---|---|
| ugyanazon frozen korpuszon fut | ✓ (a másolat a frozen korpusz) |
| ugyanazokat a forrásadatokat kapja | ✓ (a másolat teljes) |
| a Proactive Core outputját nem látja | ✓ *(triviálisan — ma nincs Proactive Core)* |
| outputját függetlenül és immutable módon rögzíti | ✗ (stdout) |
| run ID-val és konfiguráció-verzióval reprodukálható | ✗ (nincs run/config ID) |

**A hiányzó fogalom viszont mélyebb, mint a két pipa:** a §1.4.6 „reactive control" azt feltételezi,
hogy **két konfiguráció** futtatható ugyanazon a korpuszon — a proaktív és a reaktív. Ma egy motor
van. A v1.4 build alatt a kontroll-kar = „a v1.4 detektor kikapcsolva", és ezt a
**feature-flag-szintű kettéválasztást előre meg kell tervezni**, különben a shadow indulásakor nem
lesz mihez hasonlítani.

Konkrétan: a §60-as feature-flag lista (`proactive.enabled = false`, `proactive.shadow = true`) ma a
*rollout* eszköze. A value-gate-hez ugyanez a kapcsoló a **kísérleti kar** eszköze is — ugyanazon a
korpuszon kétszer kell futnia, két run-ID alatt.

---

## 27. 90 napos volumen-kalibráció — M1, és ez a legolcsóbb következő lépés

**Amit a §1.4.1 mérni akar, és amivel ma megmérhető** (élő store mellett):

| Kalibrációs metrika | Forrás ma |
|---|---|
| `historical_eligible_case_count` | `personal_cases` + `zst_cases`, `created_at` szűréssel |
| `historical_eligible_events_per_30d` | `personal_case_events` / `zst_case_events` |
| `historical_reactive_findings_count` | `case_progression_runs` (decision ≠ CONTINUE_AUTONOMOUSLY) |
| deadline/stall/anomaly/opportunity mix | a 14 határidő-oszlop (1. rész, 7. pont) + `no_progress_run_count` |

Tehát a lekérdezések **adottak**; ami hiányzik, az a kalibrációs futás és a befagyasztott
`value_gate_registration` artifact.

**Egy nagyságrendi figyelmeztetés, amit a kalibrációnak meg kell cáfolnia vagy igazolnia:** a
kódbázis kommentjeiben rögzített élő számok **101 ügyről** beszélnek (`evidence-planner.ts` fejléce:
„101 cases", `progression-heartbeat` §10.8-komment: „10 716 runs in 24 hours over 101 cases"). Ha ez
a nagyságrend áll, akkor a §1.4.1 default `minimum_eligible_observations = 25` **30 nap alatt** nem
biztos, hogy összejön az *érdemi, MEDIUM+ materialitású* eseményekből — és a blinding 40 packetje sem.

Ez pontosan az az eset, amire a V4-F14 fixture és a
`frozen_shadow_window = max(value_gate_required_window, blinding_required_window)` szabály készült.
**A kalibráció nem formaság: reális esély, hogy 60 vagy 90 napra fog kijönni.**

---

## 28. Draft factual-claim derivation — M2

Ma egy helyen van bizonyított derivation: a `followup-autodraft.ts:197` a „megkeresés óta eltelt N
nap" állítást az utolsó tényleges küldésből számolja (`outbound_ledger.applied_at`, `:167`), és a
`last_sent_at` mező a lekérdezésben nevesítve van. Ez ma landolt, mert az előző számítás
`follow_up_at`-ból indult, és **valódi címzettnek küldött volna rossz számot**.

**Ami hiányzik:** ez egyetlen javítás, nem általános szabály. A §15.5 azt kéri, hogy **minden
számított állításhoz** determinisztikus derivation record tartozzon, és stale/conflicting evidence
esetén a draft `NOT_APPROVAL_READY` legyen. Ma nincs `derivation` mező, nincs
`NOT_APPROVAL_READY` állapot, és nincs a draftokat átvilágító kapu.

A V4-F12 fixture ezt az egy esetet rögzíti; a §15.5 a szabályt kéri.

---

## 29–31. Adjudication, origin-guess, elbíráló-függetlenség — M0

Grep a teljes `src/` + `scripts/` felett `adjudicat`, `origin_guess`, `baseline_run`, `control_run`
mintákra: **egyetlen találat**, és az egy komment a `context-builder.ts:197`-ben, ami egy régi
incidensről szól — nem a mérési apparátus.

Nincs:
- kanonikus adjudication packet séma vagy builder (29.);
- `origin_guess` tárolás, `origin_guess_accuracy` számítás, binomiális teszt (30.);
- elbíráló-nyilvántartás, függetlenség-kikényszerítés, `ADJUDICATOR_REPLACEMENT` audit-nyom (31.).

**Ez nem meglepetés és nem hiba** — a mérési apparátus a v1.4 új része. De rögzíteni kell, hogy a
§26-os implementációs sorrend **29–31. lépése három teljes greenfield tétel**, nem bekötés, és hogy
a `blinding_validation_min_packets` power-levezetése (V4-F13) e nélkül nem futtatható.

---

## Mit ad ez a két rész együtt a v1.4 tervhez

### A négy legsürgősebb tétel, sorrendben

1. **A 27-es kalibrációt futtassátok le élő store-on.** A lekérdezések adottak, órák kérdése, és ez
   dönti el, hogy a shadow ablak 30, 60 vagy 90 nap — amit **a shadow előtt** kell befagyasztani.
   Reális esély, hogy a default 30 nap alulmért.
2. **Tervezzétek meg a kontroll-kart, mielőtt a detektor épül** (26.). A feature-flag ma rollout-eszköz;
   a value-gate-hez kísérleti kar is. Ha ez utólag jön, a shadow indulásakor nincs mihez hasonlítani.
3. **Írjátok meg a standing-checkeket korán** (22.). A minta bizonyítottan működik, és a release-határ
   így nem attól függ, hogy a 20. lépésig senki nem nyúlt a planner allowlistjéhez. Egyben a 18-as
   „draft-only Writer" invariánst is kikényszeríti.
4. **A `dryrun` scriptet egészítsétek ki perzisztálással** (20./26.). Ma stdout-ra riportál; egy
   immutable run/config ID-val rögzített kimenet a §1.4.6 kontroll-követelményének fele.

### Amit a v1.4 nyugodtan újrahasználhat

Duplikátum-védelem (M4), run-ledger (M3, gazdag), dry-run replay-driver (M3, live-safe),
resolve-before-ask öt forrásból (M3, audit-nyommal), standing-check minta (M4).

### Amit építeni kell, és nem szabad bekötésnek nevezni

`WAIT_SYSTEM` állapot (19.), signal-szintű dedup a message-szintű fölé (14.), abszolút
evidence-avulás (15.), általános derivation-record és `NOT_APPROVAL_READY` (28.), és a teljes
adjudication-apparátus (29–31.).

---

## Az audit lezárása

A §25 mind a 31 pontja fel van mérve (1. rész: 1–13., 21., 23–24.; 2. rész: 14–20., 22., 26–31.).

**Összesítve:** M4 = 5 pont · M3 = 9 · M2 = 4 · M1 = 5 · M0 = 8.

A v1.4 tehát **nem egyenletesen brownfield**. A sweep-gerinc, a duplikátum-védelem, a claim és a
replay-alap valóban meglévő, tesztelt infrastruktúra. A mérési apparátus és a jóváhagyási csatorna
teljes egészében új. A becslésnek ezt a kettősséget kell tükröznie — a „brownfield extension"
keretezés a pontok kétharmadára igaz, egyharmadára nem.
