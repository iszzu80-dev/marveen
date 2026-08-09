# COS v4.2 + v4.2.1: teljes fejezetenkénti audit

**Dátum:** 2026-08-09 | **Ág:** `develop` @ `4556e06` | **Spec:** `docs/marveen-personal-chief-of-staff-v4.2.md` (§0-27) + `v4.2.1` (A-E)
**Kiváltó ok:** Istvan kérése, hogy a részleges gap-elemzés terjedjen ki minden fejezetre, kód-bizonyítékkal.

**Módszer:** minden sor a kódon, az élő SQLite store-on vagy a futásnaplón mérve. Negatív állítás (`nincs ilyen`) csak pozitív kontrollal. A spec állítása és egy korábbi audit állítása NEM bizonyíték.

**Jelölések:** `MEGVAN` = megépült és éles úton fut. `INERT` = megépült és tesztelt, de nincs produkciós hívója vagy nem fut le élesben. `RÉSZBEN` = a fele. `MÁS` = megépült, de a spectől eltérő mechanizmussal. `NINCS` = nem létezik.

---

## Összesítés

| | Fejezet |
|---|---|
| **MEGVAN** | §6.1 (részben), §6.6, §6.7, §6.8, §7.1, §7.2, §10, §12 (tábla), §16 (radar), §20 |
| **INERT** | §7.3, §8 (második fele), §9, §11 (küldési lánc), §15 (revoke), A.1, A.2, B.1, B.2, B.4 |
| **RÉSZBEN** | §1, §5, §6.2, §6.3, §6.5, §12 (státuszkészlet), §18, §21, §23, A.3, A.5 |
| **MÁS** | §2 (Scope Gate helyett postafiók-routing), A.4 (kampány-kvóta helyett generikus rate limit), §22 (más autonómia-modell) |
| **NINCS** | §3.2 mezők, §3.3 változó-validáció, §3.4, §3.5, §13, §14, §17, §19 (nagy része), §24 (bekötés), §25 (DoD) |

**A rendszer-szintű Definition of Done (§25) 12 feltételéből 4 teljesül.**

---

## §0 Vezérelv

Nem auditálható tétel, mégis ez a legfájdalmasabb sor. A második alapelv szó szerint: *"egy valódi ügyön végigvitt teljes hurok > tíz félkész alrendszer."*

**Mérve:** 1 kampány, 1 kimenő levél, 1 `VERIFIED` ledger-sor, nulla végigvitt hurok. És a §5 tizenegy alrendszeréből kilenc létezik valamilyen készültségi fokon. Pontosan a fordítottja épült meg annak, amit az elv előír.

---

## §1 Capability baseline

| Spec sor | Besorolás akkor | Valós állapot | Bizonyíték |
|---|---|---|---|
| Per-tool HTTP deadline | VERIFY_IN_SLICE_0 | MEGVAN | `tool-timeouts.ts` + `AbortSignal.timeout` a Gmail-transportban (7dd785b) |
| Gmail/Calendar/Drive MCP write | VERIFY_IN_SLICE_0 | RÉSZBEN | Gmail write bizonyítva (1 `VERIFIED` sor). Calendar/Drive write adapter NINCS |
| Kifli integráció | VERIFY_IN_SLICE_0 | NINCS | discovery sem történt meg (helyesen: csak lista) |
| Personal Case Engine | MISSING | MEGVAN | `case-store.ts`, 61 ügy |
| Ledgerek | MISSING | RÉSZBEN | `outbound_ledger` 1 sor, `send_quotas` |
| Action Executor | MISSING | INERT | `executor.ts` megvan, `send-flow.ts`-nek nincs produkciós hívója |
| **Scope Gate** | MISSING | **NINCS** | lásd §2 |

---

## §2 Scope + Scope Gate

A spec hat verdiktet ír elő minden bejövő elemre írás előtt.

| Verdikt | Produkciós fájlok száma |
|---|---|
| `PERSONAL_CONFIRMED` | 1 (csak mint alapértelmezett oszlopérték a sémában) |
| `PERSONAL_PROBABLE` | 0 |
| `AMBIGUOUS` | 0 |
| `CORPORATE_EXCLUDED` | 0 |
| `ZST_EXCLUDED` | 0 |
| `SECURITY_BLOCKED` | 0 |

**Verdikt: NINCS.** Pozitív kontroll: a `PERSONAL_CONFIRMED` keresése talált, tehát a grep működik.

**Ami helyette van:** postafiók-identitás szerinti routing (`src/web/routes/cos.ts:70`). Ez determinisztikus és védhető, de nem tartalmi kapu. Ezért kerülhetett ma két ZST-üzletrész ügy a személyes tárba (AC #17).

---

## §3 Autonómia

### §3.1 Hurok
Egyszer sem futott végig. Lásd §13.

### §3.2 Campaign approval objektum
A spec **22 mezőt** ír elő. Az élő `campaign_approvals` tábla **9 oszlopos**.

| Spec mező | Van? |
|---|---|
| `template_hash` | OK |
| `allowed_recipients`, `allowed_channels`, `template_id`, `template_version` | HIÁNYZIK |
| `allowed_variable_schema`, `allowed_variable_sources`, `forbidden_variables` | HIÁNYZIK |
| `shareable_data` | HIÁNYZIK |
| `quote_target_budget`, `quote_hard_limit`, `autonomous_spend_limit` | HIÁNYZIK (az `autonomous_spend_limit` a `campaigns` táblában van, értéke 0) |
| `max_initial_outbound`, `max_follow_up_outbound`, `max_autonomous_replies`, `max_total_outbound` | HIÁNYZIK |
| `follow_up_policy`, `allowed_reply_classes`, `stop_conditions`, `escalation_conditions` | HIÁNYZIK |
| `final_gate`, `valid_until` | HIÁNYZIK |

**Tényleges oszlopok:** `approval_id, campaign_id, campaign_version, template_hash, rendered_payload_hash, status, approved_by, created_at, updated_at`.

**Következmény:** a jóváhagyási boríték nem létezik. Emiatt a §3.4, §3.5 és a 4, 6, 7, 8 elfogadási kritérium mögött nincs adatmodell.

**Aszimmetria, ami külön figyelmet érdemel:** a ZST oldalon VAN `allowed_recipients` és kikényszerítés (`src/cos/zst-send.ts:76,110`). A személyes oldalon nincs. Vagyis a címzett-allowlist a céges rendszerben megépült, abban amelyik nem is követelte meg, és hiányzik abból, amelyiknek a specje előírja.

### §3.3 Template vs renderelt payload
`rendered_payload_hash`: MEGVAN. `allowed_variable_schema` / `allowed_variable_sources` / `forbidden_variables` validáció: **nulla produkciós találat**.

Részleges helyettesítő: a `campaigns.allows_free_text` zászló (értéke 0 az egyetlen kampányon). Ez a szabad-szöveg tiltását jelzi, de nem validálja, mely változók kerültek a payloadba.

### §3.4 Stop / escalation
**NINCS.** Se mező, se logika. A spec hat megállási feltétele (előleg, új személyes adat, foglalás véglegesítése, jogi feltétel, sablontól eltérés, prompt injection gyanú) nincs kódolva.

### §3.5 Autonóm vs kapu
Nem értelmezhető: autonóm küldés egyáltalán nincs (§7.3 INERT).

---

## §4 Arányos biztonság
Az idempotencia (§7.1) és a case-verziózás (§6.7) megvan. A *"jóváhagyott kereten kívül semmi"* garancia nem létezik, mert nincs keret (§3.2).

---

## §5 Repo-native architektúra: a spec által megnevezett táblák

| Spec tábla | Élő állapot |
|---|---|
| `personal_cases`, `personal_case_events` | MEGVAN (61 / 253 sor) |
| **`personal_case_actions`** | **NINCS** |
| `campaigns`, `campaign_approvals` | MEGVAN (1 / 1 sor), hiányos mezőkkel |
| `outbound_ledger` | MEGVAN (1 sor), eltérő sémával |
| `email_processing`, `..._batches`, `..._checkpoints` | MEGVAN (18 / 18 / 0 sor) |
| `case_claims` | MEGVAN (0 sor) |
| `attachments` | `case_attachments` néven (átnevezés, elfogadható) |
| `connector_health` | MEGVAN (4 sor) |
| `shopping_radar_items/offers/checks/status_events` | mind a 4 NINCS; helyette `radar_items` + `radar_observations` |

---

## §6 Adatmodell

**§6.1 `personal_cases`** — `version` és `next_wake_at` MEGVAN. Az állapotgép 17 státusza CHECK-kel kikényszerítve, egyezik a speccel.
**Eltérés:** a `case_type`-on **nincs CHECK constraint**, tehát a spec 13 típusa nincs kikényszerítve, és a gyakorlatban más készlet él (`ADMIN, EMAIL, SHOPPING, CALL, VENDOR, PARTNER, ACCOUNTING, ...`). Ez nem korrektségi hiba, de a spec típuslistája halott betű.

**§6.2 `outbound_ledger`** — a 19 spec mezőből névre 5 egyezik. Ebből:
- Átnevezés (D.1 szerint jogos): `idempotency_key -> internal_idempotency_key`, `marveen_idempotency_key -> external_idempotency_marker`.
- **Ténylegesen hiányzik:** `campaign_id`, `channel`, `recipient`, `provider_message_id`, `rfc_message_id`, `rendered_variables_hash`, `first_attempt_at`, `error_code`.
- A címzett a `payload` JSON belsejében él, nem validálható oszlopként. Ezért az AC #4 (*"listán kívülre nincs küldés"*) technikailag nem ellenőrizhető: nincs mihez hasonlítani, és nincs mit hasonlítani.

**§6.3 `email_processing`** — `UNIQUE(gmail_account_id, message_id)`, a spec `thread_id`-t is előírja a kulcsban. Az adat ma visszatöltve (18/18 sor hordoz szálat), **a kulcs nem javítva**.

**§6.4 `email_source_checkpoints`** — 3 spec oszlopból 1 (`history_cursor`). A tábla ÜRES.

**§6.5 `email_processing_batches`** — státuszkészlet eltér: spec `OPEN, PROCESSING, READY_TO_COMMIT, COMMITTED, RECOVERY_REQUIRED, BLOCKED`; épült `OPEN, PROCESSING, TERMINAL, QUARANTINED`. Élesben 18/18 sor `OPEN`.

**§6.6 `case_claims`** — MEGVAN, `claim_fence`-szel. Élesben **0 sor**.

**§6.7 Verziózás + tranzakciós határ** — MEGVAN és használatban (a `personal_cases.version` 77-ig futott a progression-körökben).

**§6.8 Attachments** — `case_attachments`, checksum + `verifyAttachment` recompute. MEGVAN. Élesben 0 sor (a dokumentumok a `cos_documents` táblában vannak, 69 sor, más modell).

---

## §7 Kimenő művelet-biztonság

**§7.1** idempotencia-kulcs sha256-tal: MEGVAN, `UNIQUE(internal_idempotency_key)` + `UNIQUE(case_id, action_type, sequence_number)`.
**§7.2** `X-Marveen-Idempotency-Key` header + Sent-readback: MEGVAN és élesben bizonyítva (2026-08-04). Calendar `extendedProperties`: NINCS Calendar adapter.
**§7.3** a hétlépéses végrehajtási sorrend: kódban MEGVAN (`executor.ts`), **INERT** — a `send-flow.ts`-nek nincs produkciós hívója.

---

## §8 Bejövő e-mail commit-határ

Külön auditban: `audits/cos-email-intake-spec-vs-built-2026-08-09.md`. Röviden: a hatlépéses lánc első fele fut, a második fele (`SOURCE_COMMITTED`, batch-lezárás, cursor) INERT. Teljes szál olvasás NINCS, Scope Gate NINCS, delta NINCS, case-match csak szálon.

---

## §9 Konkurencia
Atomikus claim + fence: kódban MEGVAN, tesztelve. Élesben **0 claim** — a produkciós út soha nem szerez claimet. A spec *"claim nélkül külső action és cursor-commit tilos"* szabálya üresen teljesül: egyik sem történik.

---

## §10 Biztonsági minimum
**MEGVAN, és ez a spec legjobban megépült fejezete.** Négy sensitivity-osztály, `effectiveSensitivity` eszkalációval, `allowedProfilesFor` modellprofil-allowlist, ismeretlen érték fail-closed `HIGHLY_SENSITIVE`-ra (A.6). Vault megvan. Browser worker izolációs interfész megvan (adapter nincs). Banki automatizálás nincs, fizetés kézi.

---

## §11 Dokumentumok és mellékletek
Checksum + readback-verify: MEGVAN (`attachments.ts`). A spec **küldési lánca** (Drive-kép -> attachments sor -> draft -> draft-csatolmány visszaolvasás -> Sent-csatolmány visszaolvasás -> `VERIFIED`): INERT, mert nincs küldés.
A `YYYY-MM - CASE-ID - Megnevezes` mappa-névkonvenció: NINCS, helyette tartalom-címzett tárolás (`cos_documents`, 69 sor). Ez jobb megoldás, de eltérés.

---

## §12 Connector health
Tábla + 4 élő sor: MEGVAN. **Státuszkészlet eltér:** spec `AVAILABLE, READ_ONLY, DEGRADED, UNAVAILABLE, AUTH_EXPIRED, TIMEOUT`; épült `mode: READ_ONLY/READ_WRITE/DISABLED` + `status: OK/DEGRADED/DOWN/UNKNOWN`.
**Az `AUTH_EXPIRED` hiánya konkrét kár:** pont ez a Gmail-token lejárati eset, amit a triage-szkript hibaüzenete külön kezel. A connector-health nem tudja megkülönböztetni a lejárt tokent az általános hibától.

---

## §13 Fő workflow-k

| Spec státusz | Produkciós fájlok |
|---|---|
| `SHORTLIST_READY` | 0 |
| `REQUESTS_SENDING` | 0 |
| `QUOTES_COLLECTED` | 0 |
| `COMPARISON_READY` | 0 |

**Verdikt: NINCS.** Az ajánlatkérő-kampány workflow, ami a spec **1. pilotja** és a Slice 1 tartalma, nem épült meg. A 13.2 (Vendégség/Kifli) sem.

---

## §14 Scheduler-integráció

| Spec feladat | Létezik? |
|---|---|
| `personal-case-wake` (5-10p) | NINCS |
| `personal-gmail-delta` (óránként) | NINCS |
| `personal-daily-reconcile` | NINCS |
| `personal-weekly-review` | NINCS |

**Mind a négy hiányzik.** Ami helyette fut: `email-triage` (3 óránként) és `cos-progression-heartbeat` (**kikapcsolva**).

**Ez a fejezet a mai hiba közvetlen oka.** A `personal-daily-reconcile` feladata a spec szerint pontosan: *"ledger/batch/checkpoint/store/kanban/health, OUTCOME_UNKNOWN+RECOVERY rendezés"*. Ha létezne, az első futásán jelentette volna, hogy 18 köteg nyitva áll és a checkpoint-tábla üres.

---

## §15 Campaign lifecycle
Státuszok: a spec 11-ből épült 5 (`DRAFT, APPROVED, PAUSED, REVOKED, COMPLETED`). **Hiányzik:** `STOPPED_BY_POLICY`, `AWAITING_FINAL_GATE`, `ACTIVE`, `CANCELLED`, `EXPIRED`, `RECOVERY_REQUIRED`.
Mezők: a spec hétből egy van (`version`). **Hiányzik:** `revoked_at, revoked_by, pause_reason, outbound_count, follow_up_count, last_activity_at`.
A revoke logika létezik (`revokeCampaign`, verzió-bumppal), tehát a képesség megvan; az audit-mezők nincsenek. Élesben nem futott.

---

## §16 Vásárlási radar
**A spec négy táblájából nulla épült meg**, helyette két egyszerűsített tábla. A `shopping_radar_items` ~40 mezőjéből a `radar_items` 18-at tart.
**Viszont ez a fejezet ÉL:** 9 radar-elem, 32 megfigyelés, 2 találat, és a 6 órás tick tényleg futtatja. A B.5 devizamezők (`original_currency, fx_rate, fx_rate_source, converted_final_price`) és a B.6 értesítés-dedup mezők (`last_notified_*`) mind megvannak.
**Verdikt: MEGVAN, más adatmodellel.** A hiányzó mezők (kereskedői kör, ország, HU-szállítás, garancia, méret/modell szűrés) valódi funkcióhiányt jelentenek, nem csak séma-eltérést.

---

## §17 Migráció
`MIGRATED_UNVERIFIED`: **nulla produkciós találat.** A Drive-ból migrált **42 ügy** semmilyen bizonytalansági jelölést nem hordoz, holott a spec ezt kifejezetten előírja. A seed teszt-ügyek (Ürömi, Valencia, Kati) léteznek a store-ban.

---

## §18 Control Tower
Élő Mission Control nézetek: `Ma`, `Ma — ZST`, `Radar`, `Analitika`, `Monitoring`, `Kimenő`, `Kampányok`, `Dokumentumok`, ügy-részletpanel. A UI mind a 13 COS-végpontot hivatkozza.
**A spec 10 nézetéből önálló nézetként hiányzik:** `Jóváhagyások`, `Várakozik`, `Ház`, `Vásárlások`, `E-mail-feldolgozás`, `Futások`.
Sheet-cutover: a mérhető cutover-checklist NINCS elkészítve, tehát a §25/(8) feltétel nem teljesíthető.

---

## §19 Monitoring
A `listMonitoring` **két dolgot** figyel: `RECOVERY_REQUIRED` és `FAILED_TERMINAL`.

A spec 10 minimum-riasztásából hiányzik: duplikáció-megakadályozás jelzése, sikertelen readback, elakadt/paused kampány, lejárt approval, connector outage, scope-block, ismételt follow-up, radar-check hiba, **batch-cursor eltérés**.
A 8 kritikus riasztásából hiányzik: **céges adat a personal store-ban**, approval nélküli küldés, duplaküldés, fizetési action, **cursor-lépés terminálatlan batchen**, két futás egy claimen, sensitivity-downgrade kísérlet, tartós connector timeout.

**A vastagon szedett kettő pontosan a ma megtalált két hibát fogta volna meg.** A spec előírta őket. Nem épültek meg.

---

## §20 Előfeltételek (AUDIT-ELŐSZÖR)
**Ez teljesült.** A Gmail write capability tényleg auditálva és bizonyítva lett, nem állítva. A Kifli discovery nem történt meg, és emiatt helyesen maradt lista-szinten. A fejezet szellemével nincs baj.

---

## §21 Inkrementális szállítás

| Slice | Állapot |
|---|---|
| Slice 0 | MEGVAN (case store, version, events, claims, sensitivity, MC Ma/Ügyek) |
| Slice 1 | **RÉSZBEN.** A darabok megvannak (campaigns, approvals, ledger, executor, batch-modell, Gmail-send, idempotencia, readback). **A Slice 1 tényleges tartalma — "a teljes 13.1 hurok EGY házügyön" — NEM futott le.** Egy levél ment ki, nem egy hurok |
| Slice 2-5 | NINCS |

A spec zárómondata a Slice-okhoz: *"Nincs prompt-only »kész«."*

---

## §22 Fokozatos autonómia
`OFF -> OBSERVE -> PREPARE -> EXECUTE_WITH_APPROVAL -> LIMITED_AUTONOMOUS`: az `EXECUTE_WITH_APPROVAL` és a `LIMITED_AUTONOMOUS` **nulla produkciós találat**.
Ami helyette van: a `store/autonomy-config.json` 1-3 szintje, ami a flotta általános modellje, nem ügytípusonkénti COS-létra. COS-szintű főkapcsoló nincs.
**Verdikt: MÁS modell, a specifikált nem épült meg.**

---

## §23 Elfogadási kritériumok (21 + 8)

| # | Kritérium | Verdikt |
|---|---|---|
| 1 | Nincs duplaküldés | INERT (kódban tesztelve, éles úton nem fut) |
| 2 | Timeout-biztos readback | INERT |
| 3 | `SENDING` a hívás előtt | INERT |
| 4 | Kampány-határ, listán kívülre nincs küldés | **NINCS** (nincs `allowed_recipients` a személyes oldalon) |
| 5 | Rendered payload változó-validáció | **NINCS** |
| 6 | Reply-policy stop-conditionök | **NINCS** |
| 7 | Adatminimum, csak `shareable_data` | **NINCS** (nincs ilyen mező) |
| 8 | Végkapu, `autonomous_spend_limit=0` | RÉSZBEN (a limit 0, de nincs végkapu-mechanizmus) |
| 9 | Kifli nem duplarendel | NINCS (nincs Kifli) |
| 10 | `LOCAL_APPLIED` egyszer, label/cursor pótolható | FELE |
| 11 | Cursor csak terminális batchen lép | ÜRESEN IGAZ |
| 12 | Cursor-visszaállás nem okoz újra-write-ot | NEM ÉRTELMEZHETŐ élesben |
| 13 | Atomikus claim | INERT (0 claim) |
| 14 | Case verziózás | MEGVAN |
| 15 | Csatolmány checksum-eltérés megállít | RÉSZBEN (verify megvan, küldési lánc INERT) |
| 16 | Connector kiesésnél nincs külső action | MEGVAN (`dispatch-gate.ts`) |
| 17 | ZST/céges tartalom nem kerül a personal store-ba | **MA MEGSÉRÜLT** (2 ügy) |
| 18 | Data-sensitivity enforce | MEGVAN |
| 19 | Nincs kitalált tény, bizonytalan = UNVERIFIED | NINCS technikai kikényszerítés (elvi szabály) |
| 20 | Restart-folytonos többnapos kampány | NEM BIZONYÍTOTT (nem volt ilyen kampány) |
| 21 | Minden kimenő visszavezethető approvalhoz+verzióhoz | RÉSZBEN (nincs `campaign_version`/`approval_version` a ledgerben) |
| AC-22..29 | v4.2.1 új tesztek | mind a 8-nak van tesztfedése; élesben egyik sem futott, kivéve AC-26 (marker persistence, bizonyítva) |

---

## §24 Memory / SoR + Skill Factory
A memória-SoR határ tartott: az ügyállapot tényleg a Case Store-ban van.
`skill-permission-validator.ts`: megépült és tesztelt, **de nincs bekötve a skill-generálásba**. Ezt a 2026-08-06-i audit is így rögzítette, és azóta sem változott.

---

## §25 Rendszer-szintű Definition of Done

| # | Feltétel | Teljesül? |
|---|---|---|
| 1 | Slice 0-5 teljesült | NEM |
| 2 | Minden kritikus acceptance zöld | NEM |
| 3 | Nincs prompt-only/mock | **NEM** — a haladás-motor árnyék módja pontosan ez: 5816 futás, 0 külső művelet |
| 4 | Legalább egy valós többnapos kampány lezárult | NEM |
| 5 | `OUTCOME_UNKNOWN` recovery teszt sikeres | kódban igen, élesben NEM |
| 6 | Mission Control használható | IGEN |
| 7 | Connector health látható | IGEN |
| 8 | Sheet-cutover döntés megtörtént | NEM |
| 9 | Kampány revoke+pause működik | kódban igen, élesben NEM |
| 10 | Rollback- és üzemeltetési terv | RÉSZBEN (backup/retention modul megvan, terv nincs) |
| 11 | Scope Gate technikailag bizonyított | **NEM** (nincs Scope Gate) |
| 12 | Statikus data-sensitivity enforce-olt | IGEN |

**4 / 12.**

---

## v4.2.1 deltái

| Pont | Verdikt | Bizonyíték |
|---|---|---|
| A.1 poison + karantén | MEGVAN, élesben 0 sor | `QUARANTINED` státusz a CHECK-ben |
| A.2 claim fencing token | MEGVAN, élesben 0 claim | `case_claims.claim_fence` |
| A.3 explicit UNIQUE-ok | **RÉSZBEN** | `outbound_ledger` OK, `case_claims` OK, `email_processing` **hiányos** (nincs benne `thread_id`), `shopping_radar_offers` tábla nem létezik |
| A.4 kampánykvóta atomikus foglalás | **MÁS** | `send_quotas` = generikus, gördülő ablakos rate limit tetszőleges kulcsra. A spec kampány-szintű `max_initial/max_follow_up/max_autonomous_replies/max_total` kvótáit nem valósítja meg (a mezők sem léteznek) |
| A.5 campaign/approval verziózás + revoke | RÉSZBEN | `version` MEGVAN, `revoked_at/revoked_by` NINCS, a ledgerben `campaign_version`/`approval_version` NINCS |
| A.6 sensitivity UNKNOWN fail-closed | MEGVAN | `coerceSensitivity` -> `HIGHLY_SENSITIVE` |
| B.1 outbound állapotmodell | MEGVAN | `APPLIED_UNVERIFIED` a CHECK-ben |
| B.2 Gmail self-event szűrés | MEGVAN, INERT | `gmail-history-guard.ts` + az intake header-szűrője |
| B.3 marker-persistence teszt | **MEGVAN, élesben bizonyítva** | 2026-08-04, 1 `VERIFIED` sor |
| B.4 browser adapter interfész | MEGVAN, adapter NINCS | `browser-adapter.ts` |
| B.5 radar deviza | MEGVAN | 7 FX-mező a `radar_observations`-ben |
| B.6 radar értesítés-dedup | MEGVAN | 4 `last_notified_*` mező |
| C adatbiztonsági DoD | RÉSZBEN | `store-security.ts`, `backup.ts`, `retention.ts` megvan; rendszeres restore-teszt nincs ütemezve |
| D.1-D.4 konzisztencia | MEGVAN | az átnevezések megtörténtek |
| E AC-22..29 | tesztfedés MEGVAN | élesben csak AC-26 |

---

## Mit jelent ez összefoglalva

A COS **korrektségi rétege** (sensitivity, verziózás, idempotencia, claim-fence, karantén, readback-marker) tényleg jó minőségben megépült. Ezt nem vonom vissza.

Amit visszavonok, az az, hogy ez **rendszerré** állt volna össze. A három réteg, ami rendszerré tenné, hiányzik vagy inert:

1. **A jóváhagyási boríték** (§3.2) nem létezik, ezért a kimenő oldal minden szabálya (kinek, mennyit, meddig, mikor állj meg) hiánytalanul hiányzik.
2. **Az ütemezés** (§14) négy specifikált feladatából nulla létezik, ezért semmi nem ébreszti, nem egyezteti és nem zárja le az ügyeket.
3. **A monitorozás** (§19) tizennyolc előírt riasztásából kettő létezik, és a hiányzók közül kettő pontosan a ma megtalált hibákat fogta volna meg.

A rendszer ezért ma egy jól megépített, gondosan tesztelt **alkatrészkészlet**, ami ügyeket rögzít és megjelenít, de nem visz végig semmit.
