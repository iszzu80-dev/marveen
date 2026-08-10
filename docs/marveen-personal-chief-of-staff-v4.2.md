# Marveen Personal Chief of Staff v4.2

## Végleges cél- és inkrementális implementációs specifikáció

**Célrendszer:** Marveen Personal & Household Operating System
**Elsődleges felhasználó:** István
**Időzóna:** Europe/Budapest
**Hivatalos repo:** `Szotasz/marveen`, kiindulási ág: `develop`
**Verzió:** 4.2 (freeze-candidate)
**Szerző:** Marveen (a v4.1 lezáró korrektségi köre)

**A v4.1-hez képest (a review 6 P0 + kiemelt P1 pontja):**
- P0.1 `DONE` státuszellentmondás megszüntetve (terminális siker = `SOURCE_COMMITTED`).
- P0.2 account-level Gmail checkpoint + batch-modell (a fiók-cursor nem üzenetenkénti).
- P0.3 kereshető külső idempotencia-jel a kimenő üzenetben (readback bizonyíthatóvá téve).
- P0.4 template + renderelt payload külön validálása; szabad LLM-szöveg csak `PREPARE`.
- P0.5 case `version` + optimista konkurencia + belső tranzakciós határ.
- P0.6 statikus data-sensitivity enforcement már Slice 0-ban (a dinamikus routing marad P2).
- P1: campaign lifecycle + revoke/pause; capability baseline tábla (önálló doksi); rendszer-szintű DoD; radar mezők kibővítve; kvóta- és budget-mezők pontosítva; táblanevek egységesítve.

**Alapelv:** v4.2 = a v4 karcsú gerince + a v3.3 megmaradó kritikus követelményei + a korrektségi rések bezárva. Nem növeli a rendszert, a fennmaradó réseket zárja.

---

# 0. Vezérelv
> A cél nem a maximálisan korrekt elosztott rendszer, hanem egy megbízható asszisztens, aki a valódi személyes ügyeket a folyamat végéig elviszi, és csak a visszafordíthatatlan döntésnél kérdez.

1. Arányosság - szigor oda, ahol a hiba fáj (kimenő levél a nevedben, rendelés, fizetés, adatmegosztás).
2. Inkrementalitás - egy valódi ügyön végigvitt teljes hurok > tíz félkész alrendszer.
3. Marveen-native - meglévő primitívet bővítünk.
4. Audit-először - deployment-állítást nem rögzítünk tényként; a Slice 0 auditja dönt.

---

# 1. Capability baseline (a doksi önálló) [P1.3]

| Terület | Marveen-képesség | Besorolás |
|---|---|---|
| Fő koordináció / orchestrator | fő agent | EXISTS |
| Mission Control dashboard | web dashboard | EXISTS (bővítendő) |
| Kanban + alfeladat + aging | kártyák, kommentek | EXISTS |
| Ütemezés (cron/task/heartbeat/command) + preCheck | scheduler | EXISTS |
| Retry queue + agent auto-start | pending retry | EXISTS |
| Autonómia 1-3 + locked/maxLevel | autonomy-config | PARTIAL (Personal kategóriák) |
| Memória hot/warm/cold/shared + FTS5+vektor | memory | EXISTS |
| Vault (AES-256-GCM) | credential store | EXISTS |
| Skill Factory | skill tanulás | PARTIAL (szigorúbb kapu) |
| Per-tool HTTP deadline | tool-timeouts.ts | VERIFY_IN_SLICE_0 |
| Gmail/Calendar/Drive MCP write | connector | VERIFY_IN_SLICE_0 |
| Kifli integráció | - | VERIFY_IN_SLICE_0 |
| Personal Case Engine / ledgerek / Action Executor / Scope Gate | - | MISSING (új) |

Besorolások: `EXISTS` (kész), `PARTIAL` (bővítendő), `MISSING` (új fejlesztés), `VERIFY_IN_SLICE_0` (deploymentben auditálandó).

---

# 2. Scope
Engedélyezett (personal): család, ház/háztartás, karbantartás-javítás, magánutazás, személyes pénzügyi admin, magánegészségügy, iskolai/családi ügyek, privát események, személyes vásárlások, magánjogi/ingatlan admin, kapcsolatok, ajánlatkérések, dokumentumok, határidők, utánkövetések, készülékek/garanciák, felújítás.
Tiltott (technikai kontrollal): ONE, ZST Radio, Product Lab, céges e-mail/naptár/Drive, vállalati ügyek, `COS/ZST-Bridge`. A ZST COS külön rendszer később.
Scope Gate minden bejövő elemre írás előtt -> `PERSONAL_CONFIRMED` / `PERSONAL_PROBABLE` / `AMBIGUOUS` / `CORPORATE_EXCLUDED` / `ZST_EXCLUDED` / `SECURITY_BLOCKED`.

---

# 3. Autonómia: kampány-jóváhagyás + válaszkezelés + folyamat-végi kapu

## 3.1 Hurok
`szandek -> felderit+TERV -> KAMPANY-JOVAHAGYAS(egyszer) -> AUTONOM (kuldes idempotens + follow-up + bejovo valasz a reply-policy szerint + begyujtes) -> VEGKAPU (osszehasonlitas -> Istvan valaszt/fizet) -> vegrehajtas`

## 3.2 Campaign approval objektum [P0.4 + 3.5 + 4.6/4.7]
```text
campaign_approval
  campaign_id, case_id, campaign_type, scope_summary
  allowed_recipients, allowed_channels
  template_id, template_version, template_hash        [P0.4]
  allowed_variable_schema, allowed_variable_sources, forbidden_variables  [P0.4]
  shareable_data
  quote_target_budget, quote_hard_limit, autonomous_spend_limit = 0, currency  [4.7]
  max_initial_outbound, max_follow_up_outbound, max_autonomous_replies, max_total_outbound  [4.6]
  follow_up_policy
  allowed_reply_classes, allowed_follow_up_templates, allowed_attachment_types
  stop_conditions, escalation_conditions
  final_gate (SELECTION | PAYMENT | BOTH)
  valid_until, approved_by, approved_at
```
`autonomous_spend_limit = 0`: a kampány automatikusan SOHA nem költ; minden fizetés kapu.

## 3.3 Template vs renderelt payload [P0.4]
A jóváhagyás a SABLONT hagyja jóvá, de minden konkrét küldésnél a renderelt tartalom külön ellenőrzött:
- minden kimenéshez: `rendered_payload_hash`, `rendered_variables_hash`;
- az Action Executor ellenőrzi: (1) a sablonverzió jóváhagyott; (2) csak `allowed_variable_schema` szerinti változó került be; (3) a változó `allowed_variable_sources`-ból származik; (4) nincs `forbidden_variables` / plusz személyes adat; (5) a RENDERELT payload kerül az `outbound_ledger`-be, nem a sablon.
- **Szabad LLM-generált szöveg csak `PREPARE` (draft Istvánnak), autonóm `SEND` csak típusos slotos, jóváhagyott sablonból.** Ez a legkényesebb határ: autonóm módon soha nem megy ki szabad-szöveges levél a nevedben.

## 3.4 Stop/escalation (a bejövő válaszra)
Marveen megáll és Istvánhoz fordul, ha a válasz: új személyes adatot / előleget / fizetést kér; foglalást/szerződést véglegesítene; `quote_hard_limit` fölé visz; jogi feltételt küld; lényegesen eltér a sablontól/céltól; gyanús (prompt injection).

## 3.5 Autonóm vs kapu
Autonóm: keresés/shortlist; ajánlatkérő a jóváhagyott címzetteknek; follow-up; `allowed_reply_classes`-en belüli válasz típusos sablonból; begyűjtés/normalizálás/összehasonlítás; privát naptár; Kifli-kosár.
Kapu (István): végső választás/foglalás; fizetés (kézzel); listán kívüli címzett; jóváhagyottnál több adat; bármely `stop_condition`.

---

# 4. Arányos biztonság
Kimenő garanciák: nincs duplaküldés (7.1); nincs duplarendelés; timeout után nincs vak retry; jóváhagyott kereten kívül semmi; minden kimenő auditálható.
Konkurencia: nincs elosztott lock manager, de kell könnyű atomikus claim (9.) + case verziózás (6.7/P0.5), mert időben átfedhet scheduler/heartbeat/manuális chat/background/retry/fleet.
Kivágva marad: 15-státuszos immutábilis ledger; multi-worker lock-lease; kétfázisú commit a belső írásokra; readback minden belső írásra.

---

# 5. Repo-native architektúra
```text
Telegram/(Slack)/Mission Control -> Fo Orchestrator [MEGLEVO]
  |- Scope Gate, Case Engine, Campaign&Approval Store [UJ]
  |- Autonomy Config [PARTIAL], Memory/Skill/Kanban/Scheduler+preCheck/Background/Fleet [EXISTS]
  \- Action Executor [UJ] (egyetlen kulso iro): Gmail/Calendar/Drive MCP, Kifli browser-worker(izolalt), Research, Notification
SQLite: personal_cases(+version), personal_case_events(append-only), personal_case_actions,
  campaigns, campaign_approvals, outbound_ledger, email_processing, email_processing_batches,
  email_source_checkpoints, case_claims, attachments, connector_health,
  shopping_radar_items/offers/checks/status_events + meglevo tablak.
```

---

# 6. Adatmodell

## 6.1 `personal_cases`
Az általános mezők + `next_wake_at` + **`version INTEGER NOT NULL`** [P0.5].
Típusok: PERSONAL_ADMIN, HOUSEHOLD_EVENT, HOME_REPAIR, HOME_IMPROVEMENT, PURCHASE, TRAVEL, FAMILY, FINANCE, HEALTH_ADMIN, DOCUMENT_REQUEST, LEGAL_PROPERTY, WAITING_FOLLOWUP, RECURRING_MAINTENANCE.
Állapotgép: NEW -> TRIAGE -> INFO_REQUIRED -> READY -> PLANNING -> AWAITING_APPROVAL -> EXECUTING -> WAITING_EXTERNAL -> FOLLOW_UP_DUE -> CALL_REQUIRED -> AWAITING_SELECTION -> SCHEDULED -> BLOCKED -> RECOVERY_REQUIRED -> COMPLETED -> CANCELLED -> ARCHIVED. Státuszt csak validált domain command ír.

## 6.2 `outbound_ledger` [P0.3/P0.4]
`outbound_id, case_id, campaign_id, channel, idempotency_key, marveen_idempotency_key, recipient, action_type, sequence_number, rendered_payload_hash, rendered_variables_hash, status, provider_message_id, rfc_message_id, external_ref, first_attempt_at, last_attempt_at, verified_at, error_code`
Státuszok: `PLANNED -> SENDING -> APPLIED -> VERIFIED`, mellékág `OUTCOME_UNKNOWN`, `FAILED`.

## 6.3 `email_processing` (üzenet-szintű, DONE nélkül) [P0.1]
Egyedi kulcs `gmail_account_id + thread_id + message_id`; `content_hash, case_id, batch_id, status, claimed_at, claim_expires_at, local_applied_at, source_committed_at, run_id, error_code`.
Státuszok (terminális siker = `SOURCE_COMMITTED`, nincs `DONE`): `DISCOVERED, CLAIMED, LOCAL_APPLIED, SOURCE_COMMITTED, RECOVERY_REQUIRED, EXCLUDED, DUPLICATE`.

## 6.4 `email_source_checkpoints` (account-level cursor) [P0.2]
`gmail_account_id, committed_history_id, discovered_history_id, active_batch_id, updated_at`

## 6.5 `email_processing_batches` [P0.2]
`batch_id, gmail_account_id, cursor_before, cursor_after_candidate, status`
A `committed_history_id` csak akkor lép `cursor_after_candidate`-re, ha a batch MINDEN eleme `SOURCE_COMMITTED` / `EXCLUDED` / `DUPLICATE`.

## 6.6 `case_claims` (atomikus) [P0.5/4.5]
`claim_key, owner_run_id, claimed_at, claim_expires_at` + UNIQUE(`claim_key`). Megszerzés és lejárt-claim átvétel egyetlen atomikus feltételes upserttel (nem SELECT majd UPDATE).

## 6.7 Case verziózás + tranzakciós határ [P0.5]
Minden domain command: `UPDATE personal_cases SET ..., version=version+1 WHERE case_id=? AND version=expected_version`. Egyetlen SQLite-tranzakcióban: case update + event append + action/campaign proposal + claim-ellenőrzés. A külső action ELŐTT újra ellenőrzi a case és approval verzióját (stale-write védelem).

## 6.8 `attachments`
`attachment_id, case_id, drive_file_id, filename, checksum, sensitivity, approved_recipient, outbound_id, verification_status`

---

# 7. Kimenő művelet-biztonság

## 7.1 Idempotencia-kulcs
Küldés: `sha256(campaign_id + recipient + action_type + sequence_number + rendered_payload_hash)`. Rendelés/Kifli: `sha256(campaign_id + cart_content_hash)`.

## 7.2 Kereshető külső idempotencia-jel [P0.3]
A kulcsot magába a KIMENŐ üzenetbe is beírjuk, hogy a readback bizonyítható legyen:
- Gmail: `X-Marveen-Idempotency-Key: <marveen_idempotency_key>` header (és/vagy determinisztikus `Message-ID`); tárolt: `provider_message_id, rfc_message_id, marveen_idempotency_key, thread_id`.
- Calendar: `extendedProperties.private.marveenIdempotencyKey`.
- Böngészős rendelés: adapterenként definiált readback-jel (order-id / cart-token) - lásd 12.

## 7.3 Végrehajtási sorrend (crash-ablak zárva) [P0.3]
```text
CHECK approval hash + template_version + rendered_payload validacio (3.3) + scope + budget + kvota
CHECK idempotency (outbound_ledger a kulcsra):
    VERIFIED -> STOP
    SENDING / OUTCOME_UNKNOWN -> READBACK eloszor (a kereshtő jel alapjan), NEM kuld vakon
WRITE PLANNED -> WRITE SENDING (a hivas ELOTT)
EXECUTE external
    timeout/ismeretlen -> OUTCOME_UNKNOWN, STOP
    siker -> APPLIED
READBACK a kereshto jel alapjan (Gmail header/Message-ID; Calendar extendedProperties; browser order-id)
WRITE VERIFIED (+ provider_message_id/external_ref) -> UPDATE case + event log
```
Nincs hamis rollback; tévedésnél explicit naplózott kompenzáció.

---

# 8. Bejövő e-mail commit-határ [P0.1/P0.2]
```text
DISCOVERED -> CLAIMED (atomikus) -> teljes thread + Scope Gate + delta + case-match
 -> LOCAL_APPLIED (case store + kanban + event, egyszer, a batch-hez kotve)
 -> SOURCE_COMMITTED (Gmail-label; a fiok-cursor a BATCH szinten lep, ha minden elem terminalis)
```
A lokális business-write egyszer; ha `LOCAL_APPLIED` sikerült de a label/cursor nem, a következő futás CSAK a hiányzó source-commitot pótolja. `COS/Processed` csak `SOURCE_COMMITTED` után; a fiók-cursor a batch-lezárás után.

---

# 9. Konkurencia
Könnyű atomikus claim (6.6) + optimista case-verziózás (6.7). Claim nélkül külső action és cursor-commit tilos; lejárt claim csak recovery-check után, atomikus upserttel vehető át.

---

# 10. Biztonsági minimum (normatív)
Vault kötelező; credential soha promptba/logba; e-mail/web/dokumentum = untrusted data; prompt injection nem módosít szabályt/approvalt/scope-ot; browser worker izolált (nincs közvetlen Gmail/Drive/bank/Case Store hozzáférés, csak szűk capability token); banki automatizálás tiltott; fizetés mindig manuális; adatminimum (csak `shareable_data`).
**Statikus data-sensitivity enforcement [P0.6]:** Slice 0-tól osztályok `PUBLIC / PERSONAL / SENSITIVE_PERSONAL / HIGHLY_SENSITIVE` + konfigurált allowlist `sensitivity_class -> allowed_model_profiles`. Amíg nincs dinamikus router (P2): szenzitív ügy csak explicit engedélyezett modellen; ismeretlen providerre nincs fallback; privacy downgrade tiltott.

---

# 11. Dokumentumok és mellékletek
Case-mappa `YYYY-MM - CASE-ID - Megnevezes`; fotó `CASE-ID_YYYYMMDD_TIPUS_SORSZAM.ext`. Küldés (readback kötelező): Drive-kép -> attachments sor (checksum, sensitivity) -> draft -> draft-csatolmány visszaolvasás (név+checksum) -> jóváhagyott recipient + engedélyezett típus -> küldés -> Sent-csatolmány visszaolvasás -> `verification_status=VERIFIED`. Nem megy ki, ha: fájl hiányzik / checksum változott / nincs recipient-jóváhagyás / sensitivity tiltja / lista eltér / draft hash módosult.

---

# 12. Connector health + degradált működés
Capability audit minden kampányfutás előtt. Státuszok: `AVAILABLE, READ_ONLY, DEGRADED, UNAVAILABLE, AUTH_EXPIRED, TIMEOUT`. Szabályok: ledger/store nélkül nincs külső action; send nélkül csak draft; Drive write nélkül nincs csatolmányos kiküldés; Calendar write nélkül csak javaslat; timeout -> OUTCOME_UNKNOWN + readback; auth-hiba -> egy tömör értesítés. **Adapterenkénti readback-stratégia** [P1/13]: Gmail = header/Message-ID Sent-keresés; Calendar = extendedProperties; Kifli = order-history/cart-token.

---

# 13. Fő workflow-k
## 13.1 Ajánlatkérő-kampány (1. pilot)
Adatbekérés, szolgáltatókeresés (garanciális->megbízható->hivatalos->helyi->piactér), folyamat: `... SHORTLIST_READY -> [KAMPANY-JOVAHAGYAS] -> REQUESTS_SENDING -> WAITING_EXTERNAL -> FOLLOW_UP_DUE -> (valaszok a reply-policy szerint) -> QUOTES_COLLECTED -> COMPARISON_READY -> [VEGKAPU] -> BOOKING(jovahagyas) -> ... -> COMPLETED`. Hard gate: cím/telefon csak `shareable_data`; listán kívülre nem megy; foglalás/előleg mindig István; nincs duplaküldés; csatolmány-readback; stop-condition.
## 13.2 Vendégség/Kifli (2. pilot, Kifli-discovery után)
`... CALENDAR_HOLD -> MENU_PROPOSAL -> [MENU+LETSZAM+BUDGET] -> KIFLI_CART_ASSEMBLED -> [VEGKAPU: kosar+vegosszeg -> Istvan FIZET] -> ...`. Ételallergia kötelező; fizetés kézzel; kosár idempotens.

---

# 14. Scheduler-integráció
`personal-case-wake` (5-10p, preCheck+atomikus claim); `personal-gmail-delta` (óránként, a meglévő email-triage-t ide integrálva, batch-modell); `personal-daily-reconcile` (ledger/batch/checkpoint/store/kanban/health, OUTCOME_UNKNOWN+RECOVERY rendezés); `personal-weekly-review`. preCheck sosem helyettesíti a capability/approval/claim/idempotency/version ellenőrzést.

---

# 15. Campaign lifecycle [P1.1]
Állapotok: `DRAFT, AWAITING_APPROVAL, APPROVED, ACTIVE, PAUSED, STOPPED_BY_POLICY, AWAITING_FINAL_GATE, COMPLETED, CANCELLED, EXPIRED, RECOVERY_REQUIRED`. Mezők: `revoked_at, revoked_by, pause_reason, outbound_count, follow_up_count, last_activity_at`. István menet közben `PAUSE`/`REVOKE`-olhat; policy-stop -> `STOPPED_BY_POLICY` + escalation.

---

# 16. Vásárlási radar (teljes spec, megvalósítás Slice 4) [P1.2]
Szerep: tartós igény/piacfigyelés, elkülönítve a `PURCHASE` case-től; egy radar-elemhez max egy aktív Purchase Case; nem lesz automatikusan megvásárolt.
Státuszok: `AKTIV_KERESES, ELHALASZTVA, MEGVASAROLVA, LEZARVA`.
`shopping_radar_items`: `radar_id, title, category, requirements_text, target_price, max_price, currency, size_spec, model_spec, acceptable_models, warranty_expectation, acceptable_merchants, merchant_country, deliver_to_hungary, shipping_preference, parcel_locker_ok, max_shipping_days, min_rating, tax_duty_note, condition, resume_at, resume_condition, deferral_condition, return_deadline_expectation, purchase_price, purchase_merchant, invoice_ref, warranty_end, actual_return_deadline, status, best_offer_id, linked_purchase_case_id, created_at, updated_at`.
`shopping_radar_offers`: `offer_id, radar_id, offer_idempotency_key, merchant, source_url, price, shipping, tax_duty, final_price, stock, warranty, condition, captured_at, meets_requirements, score, rejection_reason`.
`shopping_radar_checks`: ütemezett ár/készlet-ellenőrzés naplója. `shopping_radar_status_events`: append-only státusz-történet.
Final price = ár + szállítás + adó/vám - kedvezmény. Szűrés: kereskedői kör + ország + HU-szállítás + garancia + méret/modell + min. értékelés + állapot. Aktív keresés a scheduler+preCheck-en. Értesítés: célár, jelentős csökkenés, készletváltozás, új megfelelő ajánlat. Döntési kártya -> jóváhagyással Purchase Case (fizetés kézzel). Radar autonóm: keresés/normalizálás/szűrés; rendelés/fizetés soha approval nélkül.

---

# 17. Migráció + seed teszt-ügyek
Állapot megőrzés; céges/ZST kizárás; bizonytalan = `MIGRATED_UNVERIFIED`; nincs kitalált történet. Seed (mind más minta): Ürömi hiánypótlás (ne találjon ki jogi/tulajdoni tényt), Valencia reptéri autó (lezárt rész ne nyíljon), Kati levél (`CALL_REQUIRED` hívásig), 3 házügy (kampány+csatolmány).

---

# 18. Control Tower [2.3]
Elsődleges: SQLite Case Store + Mission Control nézetek (Ma, Ügyek, Jóváhagyások, Várakozik, Ház, Vásárlások, Dokumentumok, E-mail-feldolgozás, Futások, Radar). Átmeneti: kontrollált Sheet-projection kompatibilitásként. **Mérhető cutover-feltétel:** a Sheet nyugdíjazható, ha a Mission Control lefedi (a) a napi+heti nézetet, (b) az összes manuális mezőt, (c) a jóváhagyás/várakozás/döntés kártyákat - checklistán bizonyítva. Tilos: Sheet-cellából validáció nélküli action; Sheet-hiba miatti action-ismétlés.

---

# 19. Monitoring
Minimum: duplikáció megakadályozva; outbound OUTCOME_UNKNOWN; sikertelen readback; elakadt/paused campaign; lejárt approval; connector outage; scope-block; ismételt/sikertelen follow-up; radar-check hiba; batch-cursor eltérés. Kritikus riasztás: céges adat personal store-ban; approval nélküli küldés/adatmegosztás; duplaküldés/duplafoglalás; fizetési action; cursor-lépés terminálatlan batchen; két futás egy claimen; sensitivity-downgrade kísérlet; tartós connector timeout.

---

# 20. Előfeltételek - AUDIT-ELŐSZÖR
A Slice 0 auditja dönti el (nem a spec állítja): Gmail/Calendar/Drive write capability (ha nincs -> az adott Slice csak OBSERVE/PREPARE); Kifli capability discovery (API/MCP/browser adapter; hiányában csak bevásárlólista, nincs bejelentkezett session).

---

# 21. Inkrementális szállítás
- **Slice 0** (nincs külső függés, a P0-k egy része ITT): repo-audit + gap-mátrix (a névleg hivatkozott repo-elemek a mi develop águnkon verifikálva); connector/Kifli discovery; `personal_cases`(+version)+events+`case_claims`, state machine, tranzakciós határ; **statikus data-sensitivity policy (P0.6)**; Mission Control Ma/Ügyek.
- **Slice 1** (Gmail write után; a P0.1-P0.4 ITT kötelező): campaigns+lifecycle+approvals(template+rendered validacio, reply-policy) + `outbound_ledger`(SENDING+kereshető jel) + email batch-modell(P0.2) + Action Executor Gmail-send + idempotencia + Sent-readback + csatolmány-readback; a teljes 13.1 hurok EGY házügyön (medence-burkolat).
- **Slice 2:** általánosítás 3 házügyre. **Slice 3:** Kifli. **Slice 4:** teljes radar (16.). **Slice 5:** proaktív+reconcile+health+monitoring+Sheet-cutover.
Minden Slice DoD: kódhely+migráció+teszt+futási bizonyíték+UI. Nincs prompt-only "kész".

---

# 22. Fokozatos autonómia
Ügytípusonként `OFF -> OBSERVE -> PREPARE -> EXECUTE_WITH_APPROVAL -> LIMITED_AUTONOMOUS`. Új típus: `EXECUTE_WITH_APPROVAL` + első-futás felmutatás (shortlist+sablon egyszer). N hibamentes kampány után emelhető `LIMITED_AUTONOMOUS`-ra (marad a végkapu). Fizetés és jogosultságon túli adatmegosztás sosem autonóm. Főkapcsoló: az egész Personal Chief szüneteltethető.

---

# 23. Elfogadási kritériumok (21 célzott)
1. Nincs duplaküldés (kampány+recipient+action_type+seq+rendered_payload háromszori futásnál egyszer).
2. Timeout-biztos: a kereshető jel alapján Sent-readback retry előtt.
3. `SENDING` perzisztál a hívás előtt; crash után nincs újraküldés readback nélkül.
4. Kampány-határ: listán kívülre nincs küldés; sablonverzió/rendered-validáció bukása blokkol.
5. Rendered payload: csak engedélyezett változó, hiteles forrás, nincs plusz személyes adat; szabad LLM-szöveg nem megy autonóm SEND-re.
6. Reply-policy stop-conditionök (előleg/új adat/foglalás/jogi feltétel) megállítanak és eszkalálnak.
7. Adatminimum: csak `shareable_data`.
8. Végkapu: foglalás/rendelés/fizetés csak István-döntés után; `autonomous_spend_limit=0`.
9. Kifli nem duplarendel; timeout után order-readback.
10. Bejövő e-mail: `LOCAL_APPLIED` egyszer; label/cursor külön pótolható.
11. Account-cursor csak akkor lép, ha a batch minden eleme terminális (SOURCE_COMMITTED/EXCLUDED/DUPLICATE).
12. Cursor visszaállás / `COS/Processed` kézi eltávolítás nem okoz újra-business-write-ot.
13. Atomikus claim: két egyidejű futásból egy nyer; lejárt claim atomikus upserttel vehető át.
14. Case verziózás: stale-version alapú action nem íródik ki (optimista concurrency).
15. Csatolmány: eltérő lista/checksum -> küldés leáll.
16. Connector: store/ledger kiesésnél nincs külső action; send nélkül csak draft.
17. Scope: ZST/céges tartalom nem kerül a personal store-ba.
18. Data-sensitivity: szenzitív ügy csak engedélyezett modellprofilon; nincs ismeretlen-provider fallback.
19. Nincs kitalált tény; bizonytalan = `UNVERIFIED`. Ürömi: tulajdoni arányt nem talál ki. Valencia: lezárt rész nem nyílik. Kati: `CALL_REQUIRED` a hívásig.
20. Restart-folytonos: többnapos kampány újraindítás után folytatódik; campaign PAUSE/REVOKE működik.
21. Audit: minden kimenő action visszavezethető approvalhoz (template+rendered), kampányhoz, case+version-höz, run-hoz, forráshoz.

---

# 24. Memory / SoR határ + Skill Factory [P2 elvek]
Memória = preferencia/kapcsolat/összefoglaló, NEM operációs SoR (az ügyállapot a Case Store-ban). Skill Factory: külső-mellékhatású skill szigorúbb kapun; permission metadata + input/output séma + tiltott műveletek + tesztek + rollback + idempotencia + approval-típus; sanitizálatlan trajectory nem seed; nincs auto-publish.

---

# 25. Rendszer-szintű Definition of Done [P1.4]
A v4.2 rendszer akkor kész, ha: (1) Slice 0-5 teljesült; (2) minden kritikus acceptance zöld; (3) nincs prompt-only/mock; (4) legalább egy valós többnapos kampány sikeresen lezárult; (5) legalább egy `OUTCOME_UNKNOWN` recovery teszt sikeres; (6) Mission Control használható; (7) connector health látható; (8) Sheet-cutover döntés megtörtént; (9) kampány revoke+pause működik; (10) van rollback- és üzemeltetési terv; (11) a Scope Gate technikailag bizonyított; (12) a statikus data-sensitivity policy enforce-olt.

---

# 26. Nyitott döntések Istvánnak
1. Gmail write consent - mikor (böngészős, a saját MCP-re). Slice 1 előfeltétele.
2. Kifli - a Slice 0 discovery után döntjük el a módot; addig csak bevásárlólista.
3. Pilot-ügy - Slice 1 melyik házügyön (javaslat: medence-burkolat).
4. Autonómia startszint - első-futás felmutatás jó-e.
A **Slice 0 azonnal indulhat** (audit + case store + version + statikus sensitivity policy + connector/Kifli discovery) - egyik P0-tól sem függ, és pont az igazolja az előfeltételeket tény helyett.

---

# 27. Ajánlott döntés
A v4.2 a kanonikus, freeze-ready alap. A 6 P0 + a kiemelt P1-ek (campaign lifecycle, capability baseline, rendszer-DoD) beépítve; a radar teljes mezőkkel (Slice 4). A további P2 (dinamikus routing, teljes monitoring dashboard, skill permission validator, analitika) a rendszer NÖVELÉSE, nem a korrektség - később.

*Marveen, v4.2 - a rések bezárva: kereshető idempotencia, renderelt-payload kontroll, batch-szintű cursor, case-verziózás, statikus adatérzékenység, kampány-lifecycle. Karcsú, végigvihető, auditálható, biztonságosan autonóm - és most már tényleg megépíthető.*
