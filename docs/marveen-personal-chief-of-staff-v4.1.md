# Marveen Personal Chief of Staff v4.1

## Végleges, megépíthető implementációs specifikáció

**Célrendszer:** Marveen Personal & Household Operating System
**Elsődleges felhasználó:** István
**Időzóna:** Europe/Budapest
**Hivatalos repo:** `Szotasz/marveen`, kiindulási ág: `develop`
**Verzió:** 4.1
**Szerző:** Marveen (a v4 kiegészítése a review P0/P1/P2 pontjaival)

**Alapelv:** v4.1 = a v4 architektúrája és vékony szeletei + a v3.3 megmaradó, valóban kritikus domain- és biztonsági követelményei. Nem a v3.3 katedrálisa, nem a v4 hiányos formája.

**Mi került vissza / javult a v4-hez képest (P0 = Slice 1 előtt kötelező):**
1. outbound ledger tényleg használja a `SENDING` állapotot (crash-ablak zárva) [3.3]
2. minden nem-terminális korábbi attempt readbacket kér retry előtt [3.3]
3. idempotencia-kulcs: `action_type` + `sequence_number` bekerül [3.4]
4. könnyű bejövő e-mail commit-határ: local applied vs source committed vs recovery [3.2]
5. SQLite atomikus claim + lejáró recovery claim [3.6]
6. campaign approval: reply policy + stop conditions [3.5]
7. minimális security / Vault / prompt-injection fejezet [4.1]
8. csatolmány- és Drive-readback folyamat [4.2]

**P1 (Slice 2-4 előtt):** teljes Vásárlási radar spec [3.1]; átmeneti Todo Master projection + cutover [2.3]; migrációs teszt-ügyek [4.3]; connector health mátrix [4.4]; ~18-20 acceptance kritérium.

**P2 (később):** memory/system-of-record határ; Skill Factory permission metadata; data-sensitivity/model-eligibility adapterpont; teljes monitoring dashboard.

---

# 0. Vezérelv

> **A cél nem a maximálisan korrekt elosztott rendszer, hanem egy megbízható asszisztens, aki a valódi személyes ügyeket a folyamat végéig elviszi, és csak a visszafordíthatatlan döntésnél kérdez.**

1. **Arányosság** - szigor oda, ahol a hiba fáj (kimenő levél a nevedben, rendelés, fizetés, adatmegosztás).
2. **Inkrementalitás** - egy valódi ügyön végigvitt teljes hurok > tíz félkész alrendszer.
3. **Marveen-native** - meglévő primitívet bővítünk, nem építünk párhuzamosat.
4. **Audit-először** - deployment-állítást (mi read-only, van-e API) nem rögzítünk tényként; a Slice 0 auditja dönt. [5]

---

# 1. Mit tartunk, mit faragunk, mit adunk

## 1.1 A v3.3-ból MEGTARTVA
Meglévőt bővíts alapelv + capability-tábla; nincs Temporal/n8n (scheduler+preCheck); SQLite Case Store = system of record; Kanban = feladatnézet `case_id`-vel; Scope Gate; Action Executor mint egyetlen külső író; konkrét approval; idempotencia + `OUTCOME_UNKNOWN` readback; Skill Factory szigorúbb kapuval; Vásárlási radar külön domain.

## 1.2 KIVÁGVA marad (valódi túltervezés 1-user rendszerhez)
- 15-státuszos immutábilis Email Processing Ledger -> helyette 7-státuszos könnyű modell (8.).
- Elosztott lock-lease manager multi-worker koordinációval -> helyette könnyű SQLite atomikus claim (9.).
- Kétfázisú commit / kompenzáció a BELSŐ SQLite írásokra -> a belső írás tranzakcionális, elég.
- Readback minden belső írásra -> readback CSAK a külső műveletre.

## 1.3 A v4-ből VISSZAKERÜL (túl-vágtam, nem katedrális)
Security minimum (10.), csatolmány-readback (11.), connector health mátrix (12.), teljes Vásárlási radar spec (15.), migrációs seed-ügyek (16.), monitoring (18.), memory/skill határok (23.). Plusz két korrektségi javítás: outbound SENDING-flow (7.), idempotencia-kulcs kiterjesztés (7.1).

---

# 2. Scope

## 2.1 Engedélyezett (personal)
Család, ház/háztartás, karbantartás-javítás, magánutazás, személyes számlák/pénzügyi admin, magánegészségügy, iskolai/családi ügyek, privát események, személyes vásárlások, magánjogi/ingatlan admin, személyes kapcsolatok, szolgáltatói ajánlatkérések, dokumentumok, privát határidők, utánkövetések, háztartási készülékek/garanciák, otthoni felújítás.

## 2.2 Tiltott (technikai kontrollal)
ONE Magyarország, ZST Radio Kft., Product Lab, céges vezetői feladatok, céges e-mail/naptár/Drive, vállalati/márka ügyek, céges stratégia, `COS/ZST-Bridge`. A ZST Radio COS külön rendszer lesz később.

## 2.3 Scope Gate
Minden bejövő elemre lefut írás előtt. Vizsgál: forrásfiók, címkék, feladó/címzett domain, naptár-id, Drive-mappa, tárgy/entitások, korábbi ügykapcsolat, kontakt-típus, explicit projekt/cégnév. Eredmény: `PERSONAL_CONFIRMED` / `PERSONAL_PROBABLE` (csak olvasás+elemzés) / `AMBIGUOUS` (`COS/Unmatched`) / `CORPORATE_EXCLUDED` / `ZST_EXCLUDED` / `SECURITY_BLOCKED`. Kizárt tartalom nem kerül személyes memóriába, csak minimális auditsor.

---

# 3. Autonómia-modell: kampány-jóváhagyás + folyamat-végi kapu + válaszkezelés

## 3.1 A hurok
```text
[1] Istvan szandeka
[2] Marveen felderit + TERVET kesz
[3] KAMPANY-JOVAHAGYAS (egyszer)
[4] Marveen AUTONOM: kikuldes (idempotens) + follow-up + BEJOVO VALASZ kezelese a reply-policy szerint + begyujtes/normalizalas
[5] VEGKAPU: osszehasonlitas + ajanlas -> Istvan valaszt/fizet
[6] Vegrehajtas + lezaras
```

## 3.2 Kampány-jóváhagyási objektum (bővített) [3.5]
```text
campaign_approval
  campaign_id, case_id, campaign_type
  scope_summary
  allowed_recipients          (csak ezeknek)
  allowed_channels            (email | webform)
  message_template_hash
  shareable_data              (pl. "nev + kerulet + email" - ezen tul semmi)
  budget_cap + currency
  max_outbound_count
  follow_up_policy            (hany nap, hanyszor)
  allowed_reply_classes       (mire VALASZOLHAT autonom: idopont-egyeztetes, tovabbi fenykep, pontositas)
  allowed_follow_up_templates (jovahagyott valasz-sablonok)
  allowed_attachment_types    (mit csatolhat: pl. allapot-foto igen, szemelyi/szamla nem)
  stop_conditions             (lasd 3.4)
  escalation_conditions       (mikor fordul Istvanhoz)
  final_gate                  (SELECTION | PAYMENT | BOTH)
  valid_until, approved_by, approved_at
```
Bármely lényeges eltérés (más címzett, sablon-hash változás, budget-túllépés, `max_outbound` fölött, új megosztandó adat) érvényteleníti a jóváhagyást.

## 3.3 Mit tehet autonóm / mi marad kapunál
Autonóm (jóváhagyás után): szolgáltatókeresés/shortlist; ajánlatkérő kiküldése a jóváhagyott címzetteknek; follow-up a policy szerint; **a jóváhagyott `allowed_reply_classes`-en belüli válasz** (pl. időpont-egyeztetés, kért állapotfotó küldése a jóváhagyott típusból); ajánlatok begyűjtése/normalizálása/összehasonlítása; privát naptárbejegyzés; Kifli-kosár összeállítása.
Kapu (István): végső szolgáltató-választás / foglalás; fizetés (mindig kézzel); jóváhagyott listán kívüli címzett; jóváhagyottnál több adat; bármely `stop_condition`.

## 3.4 Stop- és escalation-feltételek (a bejövő válaszra) [3.5]
Marveen MEGÁLL és Istvánhoz fordul, ha a szolgáltató válasza:
- új személyes adatot kér (a `shareable_data`-n túl);
- előleget vagy fizetést kér;
- foglalást/szerződést véglegesítene;
- a `budget_cap` fölé visz;
- jogi/szerződési feltételt küld;
- lényegesen eltér a jóváhagyott sablontól/kampány-céltól;
- azonosíthatatlan vagy gyanús (lehetséges prompt injection, lásd 10.).

---

# 4. Arányos biztonság - mit garantálunk

A kimenő oldalon a v3.3-mal AZONOS garanciák, olcsóbban:
1. Egy third-party sem kap kétszer ugyanazt a levelet (7.1 idempotencia).
2. Egy rendelés sem duplázódik (idempotencia + order-readback).
3. Timeout után nincs vak retry (`OUTCOME_UNKNOWN` + readback).
4. A jóváhagyott kereten kívül semmi (approval hash minden action előtt).
5. Minden kimenő művelet auditálható (`outbound_ledger` + append-only event log).

**Konkurencia-korrekció [3.6]:** a v4 "nincs multi-worker" állítása túl erős volt. Egy user mellett is átfedhet időben: scheduler, heartbeat, manuális chatfutás, background task, agent fleet, retry queue. Ezért NEM elosztott lock manager, de KELL könnyű SQLite atomikus claim (9.).

---

# 5. Repo-native architektúra
```text
Telegram / (Slack) / Mission Control
   v
Fo Marveen Orchestrator [MEGLEVO]
   |- Personal Scope Gate [UJ]
   |- Personal Case Engine [UJ]
   |- Campaign & Approval Store [UJ]
   |- Autonomy Config [MEGLEVO, bovitendo]
   |- Memory / Skill Factory / Kanban / Scheduler+preCheck / Background / Fleet [MEGLEVO]
   \- Action Executor [UJ] (egyetlen kulso iro)
         |- Gmail / Calendar / Drive MCP (read + write*)
         |- Kifli browser-worker (izolalt*)
         \- Research adapter / Notification
* a write/hozzaferes a Slice 0 auditban igazolando (19.)

SQLite: personal_cases, personal_case_events (append-only), personal_case_actions,
campaigns, campaign_approvals, outbound_ledger, email_processing, case_claims,
attachments, connector_health, shopping_radar + meglevo tablak.
```

---

# 6. Adatmodell

## 6.1 `personal_cases`
`case_id, title, description, case_type, category, scope, status, priority, owner, created_at, updated_at, source_system, source_references, parent_case_id, related_case_ids, next_action, next_action_owner, due_at, follow_up_at, next_wake_at, waiting_on, blocked_reason, sensitivity, related_contact_ids, related_document_ids, calendar_event_ids, gmail_thread_ids, last_event_id, closure_reason, completed_at, archived_at`

Típusok: `PERSONAL_ADMIN, HOUSEHOLD_EVENT, HOME_REPAIR, HOME_IMPROVEMENT, PURCHASE, TRAVEL, FAMILY, FINANCE, HEALTH_ADMIN, DOCUMENT_REQUEST, LEGAL_PROPERTY, WAITING_FOLLOWUP, RECURRING_MAINTENANCE`.

Állapotgép: `NEW -> TRIAGE -> INFO_REQUIRED -> READY -> PLANNING -> AWAITING_APPROVAL -> EXECUTING -> WAITING_EXTERNAL -> FOLLOW_UP_DUE -> CALL_REQUIRED -> AWAITING_SELECTION -> SCHEDULED -> BLOCKED -> RECOVERY_REQUIRED -> COMPLETED -> CANCELLED -> ARCHIVED`. Státuszt csak validált domain command ír; minden váltás append-only eseményt ír a `personal_case_events`-be.

## 6.2 `outbound_ledger` (a kimenő idempotencia) [3.3/3.4]
`outbound_id, case_id, campaign_id, channel, idempotency_key, recipient, action_type, sequence_number, payload_hash, status, external_ref, first_attempt_at, last_attempt_at, verified_at, error_code`
Státuszok: `PLANNED -> SENDING -> APPLIED -> VERIFIED`, mellékág `OUTCOME_UNKNOWN`, `FAILED`.

## 6.3 `email_processing` (7-státuszos könnyű modell) [3.2]
Egyedi kulcs: `gmail_account_id + thread_id + message_id`.
`content_hash, case_id, status, cursor_before, cursor_after, claimed_at, claim_expires_at, local_applied_at, source_committed_at, run_id, error_code`
Státuszok: `DISCOVERED, CLAIMED, LOCAL_APPLIED, SOURCE_COMMITTED, RECOVERY_REQUIRED, EXCLUDED, DUPLICATE`.

## 6.4 `case_claims` (atomikus claim) [3.6]
`claim_key (pl. case_id vagy thread_id), owner_run_id, claimed_at, claim_expires_at` + UNIQUE constraint a `claim_key`-en. A claim atomikus `INSERT OR IGNORE` / feltételes update; lejárt claim recovery után átvehető.

## 6.5 `attachments` (könnyű) [4.2]
`attachment_id, case_id, drive_file_id, filename, checksum, sensitivity, approved_recipient, outbound_id, verification_status`

## 6.6 `campaigns`, `campaign_approvals`, `connector_health`, `shopping_radar` - lásd 3.2 / 12. / 15.

---

# 7. Kimenő művelet-biztonság (a szigor magja)

## 7.1 Idempotencia-kulcs [3.4]
Küldés: `sha256(campaign_id + recipient + action_type + sequence_number + payload_hash)`
Rendelés/Kifli: `sha256(campaign_id + cart_content_hash)`
Így a több lépéses kommunikáció (első kérés / follow-up 1 / follow-up 2 / pontosítás) egyértelmű, és a jogos második follow-up nem blokkolódik tévesen.

## 7.2 Végrehajtási sorrend (a crash-ablak zárva) [3.3]
```text
CHECK approval hash + scope + budget + max_outbound
CHECK idempotency (outbound_ledger a kulcsra):
    VERIFIED -> STOP (mar megtortent)
    SENDING vagy OUTCOME_UNKNOWN -> READBACK eloszor (lasd lent), NEM kuld vakon
    nincs sor -> tovabb
WRITE PLANNED
WRITE SENDING            <-- perzisztalva a kulso hivas ELOTT
EXECUTE external
    timeout/ismeretlen -> WRITE OUTCOME_UNKNOWN, STOP
    siker -> WRITE APPLIED
READBACK:
    Gmail: Sent kereses idempotency-kulcs + recipient + payload_hash alapjan
    Calendar: event kereses case_id + start/end alapjan
    Kifli: order-history / cart-state alapjan
WRITE VERIFIED (+ external_ref)
UPDATE case + event log
```
Újrafutás, ha `SENDING`/`OUTCOME_UNKNOWN`-t talál: előbb readback, csak IGAZOLT hiánynál küld újra. Ez a duplaküldés-elkerülés minimuma.

## 7.3 Nincs hamis rollback
Kimenő levél nem visszavonható; tévedésnél explicit, naplózott kompenzáció (helyesbítő levél, esemény törlése, foglalás lemondása), nem "rollback".

---

# 8. Bejövő e-mail feldolgozás: commit-határ [3.2]

A LOKÁLIS business-commit és a Gmail SOURCE-commit szétválik:
```text
DISCOVERED (uj/valtozott thread a cursor alapjan)
 -> CLAIMED (atomikus claim, claim_expires_at)
 -> teljes thread olvasas + Scope Gate + delta-elemzes + case-match
 -> LOCAL_APPLIED (case store + kanban + event log irva, egyszer)
 -> SOURCE_COMMITTED (Gmail-label + history cursor - KULON, biztonsagosan bepotolhato)
 -> DONE
```
Szabályok:
- a lokális változás csak EGYSZER alkalmazható (idempotens a message_id-ra);
- ha `LOCAL_APPLIED` sikerült, de a label/cursor nem -> a következő futás NEM ismétli a business-írást, csak a hiányzó source-commitot pótolja;
- ha a folyamat `LOCAL_APPLIED` előtt áll le -> újra feldolgozható;
- `RECOVERY_REQUIRED` -> a napi reconcile rendezi;
- kizárt (`EXCLUDED`) és duplikált (`DUPLICATE`) rekordnál nincs teljes tartalom, csak audit.
`COS/Processed` címke csak `SOURCE_COMMITTED` után; a cursor commit csak a label után.

---

# 9. Konkurencia: atomikus claim [3.6]
Nem elosztott lock manager, hanem könnyű DB-minta:
- atomikus claim acquisition (`case_claims` UNIQUE + feltételes írás);
- `claimed_at` + rövid `claim_expires_at`;
- a claim tulajdonosa `owner_run_id`;
- claim elvesztése / lejárat -> a művelet leáll, recovery check kötelező az átvétel előtt;
- claim nélkül külső módosító action és cursor-commit tilos.
Ez megakadályozza, hogy egy scheduler-futás és egy manuális chatfutás egyszerre módosítsa ugyanazt az ügyet.

---

# 10. Biztonsági minimum (normatív) [4.1]
- Credential kizárólag a Vaultban; promptba/logba SOHA nem kerül.
- E-mail, weboldal és dokumentum tartalma UNTRUSTED DATA, nem utasítás.
- Prompt injection nem módosíthat szabályt, approvalt, scope-ot; a gyanús tartalom `SECURITY_BLOCKED` / escalation (3.4).
- Érzékeny személyes adat nem route-olható nem engedélyezett modellhez/providerhez (adapterpont, P2).
- Browser worker (Kifli) IZOLÁLT: nincs közvetlen Gmail-, Drive-, banki- vagy Case Store-hozzáférése; csak szűk, feladatspecifikus capability tokent kap; nyers credentialt nem lát.
- Banki felület automatizálása tiltott; kártyaadat tárolása tiltott; fizetés MINDIG manuális.
- Adatmegosztás minimum-elve: csak a `shareable_data`-ban engedélyezett kerül ki.

---

# 11. Dokumentumok és mellékletek [4.2]
Case-mappa: `YYYY-MM - CASE-ID - Rovid megnevezes` (pl. `2026-08 - HOME-0043 - Medence koruli burkolat`).
Fotóelnevezés: `CASE-ID_YYYYMMDD_TIPUS_SORSZAM.ext`.
Csatolmány-küldési folyamat (kötelező readback):
```text
Drive-kep kivalasztasa -> attachments sor (checksum, sensitivity) -> Gmail-draft
 -> draft csatolmanylista VISSZAOLVASAS (fajlnev + checksum egyezes)
 -> jovahagyott recipient + engedelyezett attachment_type ellenorzes
 -> kuldes -> Sent csatolmanylista VISSZAOLVASAS -> attachments.verification_status = VERIFIED
```
Nem megy ki csatolmányos levél, ha: a fájl hiányzik; a checksum változott; nincs a címzettre szóló jóváhagyás; a sensitivity nem engedi; a visszaolvasott lista eltér; a draft hash módosult.

---

# 12. Connector health és degradált működés [4.4]
Capability audit MINDEN kampányfutás előtt. Státuszok: `AVAILABLE, READ_ONLY, DEGRADED, UNAVAILABLE, AUTH_EXPIRED, TIMEOUT`.
Szabályok:
- ledger/store nélkül nincs külső action;
- Gmail send nélkül csak draft;
- Drive write nélkül nincs csatolmányos kiküldés;
- Calendar write nélkül csak időpontjavaslat;
- timeout után `OUTCOME_UNKNOWN` + readback;
- auth-hiba -> egyetlen tömör, cselekvésorientált értesítés Istvánnak;
- a hibát a Futások lapon és a store-ban is naplózni.

---

# 13. Fő workflow-k

## 13.1 Ajánlatkérő-kampány (autonóm multi-vendor) - 1. pilot
Adatbekérés: eszköz/terület, márka/modell, hibajelenség, sürgősség, biztonsági kockázat, fotók (Drive), időablakok, budget, helyszín (kerület).
Szolgáltatókeresés: garanciális/gyártói -> korábban megbízható (memória) -> hivatalos/szakmai -> helyi -> piactér.
Folyamat: `NEW -> INFO_REQUIRED -> SAFETY_TRIAGE -> WARRANTY_CHECK -> PROVIDER_RESEARCH -> SHORTLIST_READY -> [KAMPANY-JOVAHAGYAS] -> REQUESTS_SENDING -> WAITING_EXTERNAL -> FOLLOW_UP_DUE -> (bejovo valaszok a reply-policy szerint) -> QUOTES_COLLECTED -> COMPARISON_READY -> [VEGKAPU] -> BOOKING (jovahagyassal) -> SCHEDULED -> SERVICE_DONE -> INVOICE_WARRANTY_CAPTURE -> COMPLETED`.
Összehasonlító mezők a végkapunál: szolgáltató, forrás, értékelés+darab, tapasztalat, kiszállási díj, diagnosztika, javítási becslés, alkatrészkezelés, legkorábbi időpont, garancia, számla-adás, kommunikáció, kockázati jelek.
Hard gate: cím/telefon csak `shareable_data` szerint; listán kívüli cégnek nem megy; foglalás/előleg mindig István; nincs duplaküldés (7.1); csatolmány-readback (11.); stop-condition a válaszra (3.4).

## 13.2 Vendégség (Kifli-kosár) - 2. pilot (Kifli-hozzáférés után, 19.)
`NEW -> INFO_REQUIRED -> CALENDAR_HOLD -> MENU_PROPOSAL -> [MENU+LETSZAM+BUDGET JOVAHAGYAS] -> SHOPPING_LIST -> KIFLI_CART_ASSEMBLED -> [VEGKAPU: kesz kosar + vegosszeg + szallitasi sav -> Istvan FIZET] -> ORDER_CONFIRMED -> CALENDAR_PREP -> COMPLETED`.
Ételallergia kötelezően ellenőrzött; fizetés mindig kézzel; kosár-beküldés idempotens (7.1).

---

# 14. Scheduler-integráció (meglévőre)
`personal-case-wake` (5-10 perc, preCheck: `next_wake_at<=now` ügyek, atomikus claim); `personal-gmail-delta` (óránként, capability audit után, csak delta, a meglévő email-triage heartbeatet IDE integráljuk); `personal-daily-reconcile` (napi: outbound_ledger + email_processing + case store + kanban + connector health; `OUTCOME_UNKNOWN`/`RECOVERY_REQUIRED` rendezés); `personal-weekly-review` (heti: elakadt/határidő nélküli/régi ügyek). A preCheck sosem helyettesíti a capability/approval/claim/idempotency ellenőrzést.

---

# 15. Vásárlási radar (teljes spec, megvalósítás Slice 4) [3.1]

## 15.1 Szerep
Tartós igény- és piacfigyelési réteg, elkülönítve a `PURCHASE` case-től. Egy radar-elemhez legfeljebb egy aktív `PURCHASE` case. A radar-elem nem válik automatikusan megvásárolttá.

## 15.2 Státuszok
`AKTIV_KERESES` (aktív ár/készlet-figyelés), `ELHALASZTVA` (feltétellel újraaktiválható), `MEGVASAROLVA`, `LEZARVA` (igény megszűnt).

## 15.3 Adatmodell (`shopping_radar`)
`radar_id, title, category, requirements_text, target_price, max_price, currency, size_spec, model_spec, acceptable_models, warranty_expectation, acceptable_merchants, condition (uj/hasznalt), deferral_condition, return_deadline_expectation, status, best_offer_id, offer_history_ref, linked_purchase_case_id, created_at, updated_at`
Ajánlat (`radar_offers`): `offer_id, radar_id, merchant, source_url, price, shipping, final_price (ar+szallitas-kedvezmeny), stock, warranty, condition, captured_at, meets_requirements (bool), score, rejection_reason`

## 15.4 Végleges ár, minősítés, rangsor
Final price = ár + szállítás - alkalmazható kedvezmény. Minősítés: kereskedői kör + garancia + méret/modell + állapot szűrő; ami nem felel meg, `rejection_reason`-nel kiesik. Rangsor: final price, garancia, kereskedő megbízhatóság, célár-elérés.

## 15.5 Aktív keresés + értesítés
A meglévő scheduler + preCheck-en (nincs LLM-hívás, ha nincs esedékes radar-elem). Értesítés csak: célár elérve, jelentős árcsökkenés, készlethiány-változás, új megfelelő ajánlat. Döntési kártya a Mission Controlban -> jóváhagyással `PURCHASE` case indul (13.2 mintájú végrehajtás, fizetés kézzel).

## 15.6 Radar autonómia és tesztek
Radar keresés/normalizálás/szűrés autonóm; rendelés/fizetés SOHA approval nélkül. Radar acceptance: célár-trigger helyes; nem megfelelő ajánlat kiszűrve; nincs duplarendelés a Purchase Case-be váltásnál; a radar-elem nem lesz automatikusan megvásárolt.

---

# 16. Migráció + seed teszt-ügyek [4.3]
A meglévő állapotot megőrizzük; kizárjuk a céges/ZST tartalmat; bizonytalan történeti feldolgozás `MIGRATED_UNVERIFIED`; nincs kitalált történeti esemény. Seed teszt-ügyek (mind más működési mintát fed):
| Ügy | Mit tesztel |
|---|---|
| Ürömi hiánypótlás (113 m2 / 404/800-ad) | ne találjon ki jogi/tulajdoni tényt; kérjen/keressen hiteles dokumentumot |
| Valencia repülőtéri autó | részben lezárt ügy (városi autó kész) ne nyíljon újra |
| Kati levél | `CALL_REQUIRED`, emberi hívásig blokkolt workflow |
| 3 házügy (szúnyogháló/redőny, hátsó lépcső, medence-burkolat) | kampány + csatolmányok |

---

# 17. Control Tower: Mission Control elsődleges + átmeneti Sheet [2.3]
Elsődleges: SQLite Case Store + Mission Control dashboard nézetek (Ma, Ügyek, Jóváhagyások, Várakozik, Ház, Vásárlások, Dokumentumok, E-mail-feldolgozás, Futások, Radar).
Átmeneti: amíg a Mission Control nem tud mindent, amit a jelenlegi Google Sheet, egy egyirányú/kontrollált **projection** (`Case Store -> Sheet`, és user-editable mezők -> validált command -> Case Store) megmarad kompatibilitásként. **Cutover-terv:** a Sheet akkor nyugdíjazható, ha a Mission Control lefedi a napi/heti nézetet és a manuális mezőket. Tilos: Sheet-cellából validáció nélküli külső action; Sheet-hiba miatti action-ismétlés.

---

# 18. Monitoring (minimum) [4.5]
Duplikáció megakadályozva; outbound `OUTCOME_UNKNOWN`; sikertelen readback; elakadt campaign; lejárt approval; connector outage; scope-block; megismételt/sikertelen follow-up; radar-check hiba.
Kritikus riasztás: céges adat a personal store-ban; approval nélküli küldés/adatmegosztás; duplaküldés/duplafoglalás; fizetési action; cursor commit `SOURCE_COMMITTED` nélkül; két futás ugyanazon claimen; tartós connector timeout.

---

# 19. Előfeltételek - AUDIT-ELŐSZÖR (nem rögzített tény) [5]
A v4 deployment-állításai (private Google MCP read-only, nincs Kifli API, browser worker kell, Calendar/Drive write hiányzik) a Slice 0 auditjában IGAZOLANDÓK, nem előre rögzített tények.
- **Connector write audit:** ellenőrizd a jelenlegi Gmail/Calendar/Drive write capability-t. Ha nincs write, az adott Slice csak `OBSERVE`/`PREPARE` módban aktiválható.
- **Kifli capability discovery:** először derítsd fel (API / MCP / megfelelő browser adapter). Ezek hiányában a rendszer csak bevásárlólistát készít, és NEM nyit bejelentkezett sessiont.
Ez időtállóbb és repo-native.

---

# 20. Inkrementális szállítás (P0/P1/P2-hez kötve)
- **Slice 0** (nincs külső függés): repo-audit + gap-mátrix (a névleg hivatkozott repo-elemeket - docs/*, issue #517, #560/#561, tool-timeouts.ts, v1.22.0 - a MI develop águnkon verifikálva); connector write audit + Kifli discovery (19.); `personal_cases`+events+`case_claims`, state machine; Mission Control Ma/Ügyek.
- **Slice 1** (Gmail write után): campaigns + approvals (reply-policy!) + `outbound_ledger` (SENDING-flow!) + Action Executor Gmail-send + idempotencia + Sent-readback + csatolmány-readback; a teljes 13.1 hurok EGY házügyön (medence-burkolat). Első-futás felmutatás (21.). Tartalmazza a P0-listát.
- **Slice 2:** általánosítás a 3 házügyre; kampány-skill.
- **Slice 3** (Kifli discovery után): Kifli izolált browser-worker + kosár-idempotencia; 13.2.
- **Slice 4:** teljes Vásárlási radar (15.).
- **Slice 5:** proaktív teljesség, reconcile, connector health nézet, autonómia-kapcsolók, monitoring, Sheet-cutover.
Minden Slice DoD-je: kódhely + migráció + teszt + futási bizonyíték + UI-elérés. Nincs prompt-only "kész".

---

# 21. Fokozatos autonómia
Ügytípusonként `OFF -> OBSERVE -> PREPARE -> EXECUTE_WITH_APPROVAL -> LIMITED_AUTONOMOUS`. Új ügytípus: `EXECUTE_WITH_APPROVAL` + első-futás felmutatás (shortlist+sablon egyszer, az első levél előtt). N hibamentes kampány után István egy kattintással emelheti `LIMITED_AUTONOMOUS`-ra (marad a végkapu). Fizetés és jogosultságon túli adatmegosztás SOHA nem emelhető autonómra. Főkapcsoló: az egész Personal Chief szüneteltethető.

---

# 22. Elfogadási kritériumok (~18-20 célzott)
1. Nincs duplaküldés (kampány+recipient+action_type+seq+payload háromszori futásnál egyszer).
2. Timeout-biztos: send-timeout után Sent-readback retry előtt.
3. Az outbound `SENDING` állapot tényleg perzisztál a hívás előtt; crash után nincs újraküldés readback nélkül.
4. Kampány-határ: listán kívüli címzettnek nincs küldés; sablon-hash változás érvényteleníti az approvalt.
5. Reply-policy: a `stop_condition`-ök (előleg, új adat, foglalás, jogi feltétel) megállítják és eszkalálják.
6. Adatminimum: csak `shareable_data` kerül ki.
7. Végkapu: foglalás/rendelés/fizetés csak István-döntés után.
8. Kifli nem duplarendel; timeout után order-readback.
9. Bejövő e-mail: `LOCAL_APPLIED` egyszer; label/cursor külön, biztonságosan pótolható.
10. Cursor visszaállás / `COS/Processed` kézi eltávolítás nem okoz újra-business-write-ot.
11. Atomikus claim: két egyidejű futásból csak egy szerzi meg; lejárt claim recovery után átvehető.
12. Csatolmány: eltérő lista/checksum esetén a küldés leáll.
13. Connector: store/ledger kiesésnél nincs külső action; send nélkül csak draft.
14. Scope: ZST/céges tartalom nem kerül a personal store-ba.
15. Nincs kitalált tény (dátum/összeg/cím/ajánlat/döntés); bizonytalan = `UNVERIFIED`.
16. Restart-folytonos: többnapos váró kampány újraindítás után folytatódik.
17. Ürömi: tulajdoni arányt nem talál ki. 18. Valencia: lezárt rész nem nyílik újra. 19. Kati: `CALL_REQUIRED` a hívásig.
20. Radar: célár-trigger helyes; nem megfelelő ajánlat kiszűrve; nincs duplarendelés a Purchase Case-váltásnál.
21. Audit: minden kimenő action visszavezethető approvalhoz, kampányhoz, case-hez, run-hoz, forráshoz.

---

# 23. Memory / system-of-record határ + Skill Factory [P2]
- A memória (hot/warm/cold/shared) preferenciákra, kapcsolatokra, összefoglalókra való; NEM operációs system of record. Az ügyállapot a Case Store-ban él, nem a memóriában.
- Skill Factory: külső-mellékhatású személyes skill csak szigorúbb kapun publikálható. Minden skillhez: permission metadata (mit érinthet), input/output séma, tiltott műveletek, tesztek, rollback, idempotencia-szabály, szükséges approval-típus. Sanitizálatlan személyes trajectory nem kerül seed-skillbe. Automatikus publikálás tilos.
- Data-sensitivity / model-provider eligibility: adapterpont a jövőre, NEM kötelező függőség most (a repo #517 proposal nyitott).

---

# 24. Nyitott döntések Istvánnak
1. **Gmail write consent** - mikor (böngészős, írási jogokkal, a saját MCP-re). Slice 1 előfeltétele.
2. **Kifli** - a Slice 0 discovery után döntjük el a módot (izolált browser-worker Vault-credentiallal vagy más); addig csak bevásárlólista.
3. **Pilot-ügy** - Slice 1 melyik házügyön (javaslat: medence-burkolat).
4. **Autonómia startszint** - jó-e az első-futás felmutatás (21.), vagy óvatosabban.

A **Slice 0** azonnal indulhat (audit + gap-mátrix + case store alap + connector/Kifli discovery), mert nem vár külső jogokra - és pont az igazolja a fenti előfeltételeket tény helyett.

---

*Marveen, v4.1 - a v4 karcsú gerince + a valóban szükséges biztonság és domain-teljesség. Nem a legnagyobb rendszer, hanem az, amelyik a leghamarabb elviszi a valódi ügyeidet a végkapuig, sehol nem küld kétszer a nevedben, és a bejövő válaszban is tudja, hol kell megállnia.*
