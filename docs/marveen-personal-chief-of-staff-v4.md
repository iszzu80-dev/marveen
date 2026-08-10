# Marveen Personal Chief of Staff v4

## Marveen saját implementációs javaslata

**Célrendszer:** Marveen Personal & Household Operating System
**Elsődleges felhasználó:** István
**Időzóna:** Europe/Budapest
**Hivatalos repo:** `Szotasz/marveen`, kiindulási ág: `develop`
**Verzió:** 4.0
**Szerző:** Marveen (a v3.3 spec átdolgozása saját mérnöki javaslattá)

**Fő eltérés a v3.3-hoz képest:**

1. **Végrehajtási filozófia:** vízesés (WP0-WP10) helyett **inkrementális, vékony-szelet-elsős** szállítás egy valódi ügyön, majd általánosítás.
2. **Arányos biztonság:** a külső műveleteknél megtartott szigor (idempotencia, kampány-approval, readback), de **kivágva a 15-státuszos immutábilis ledger és a multi-worker lock-lease katedrális** - egyfelhasználós, egyírós rendszerhez indokolatlan.
3. **Autonómia-modell:** explicit **"kampány-jóváhagyás -> autonóm végrehajtás -> kapu a folyamat VÉGÉN"** köré szervezve. Ez adja azt, amit István valóban akar: ő ne lépésenként bólintson, hanem a tervet hagyja jóvá egyszer, aztán csak a végső döntésre / fizetésre jöjjön vissza.
4. **Control Tower a Mission Control dashboardban** (SQLite), a Google Sheet opcionális, későbbi projekció.
5. **Personal-only**; a ZST Radio Chief of Staff külön rendszer, később.

---

# 0. Vezérelv

> **A cél nem egy maximálisan korrekt elosztott rendszer, hanem egy megbízható asszisztens, aki a valódi személyes ügyeket a folyamat végéig elviszi, és csak a visszafordíthatatlan döntésnél kérdez.**

Három tervezési elv, ebben a sorrendben:

1. **Arányosság.** A szigort oda tesszük, ahol a hiba fáj (kimenő levél a nevedben, rendelés, fizetés). Ahol nem fáj (belső állapot, olvasás, elemzés), ott egyszerű a megoldás.
2. **Inkrementalitás.** Egy valódi ügyön végigvitt teljes hurok többet ér, mint tíz félkész infrastruktúra-munkacsomag. Előbb élő érték, aztán általánosítás.
3. **Marveen-native.** Meglévő primitívet bővítünk, nem építünk párhuzamosat (ezt a v3.3 helyesen mondta ki, megtartjuk).

---

# 1. Mit tartunk meg, mit faragunk le, mit teszünk hozzá

## 1.1 A v3.3-ból MEGTARTVA (jó és szükséges)

- "Meglévőt bővíts, ne implementálj újra" alapelv és a repo-capability tábla.
- Nincs Temporal/n8n; a tartós működés a meglévő scheduler + `preCheck` gate-re épül.
- SQLite Personal Case Store = technikai system of record.
- Kanban = végrehajtási feladatnézet (`case_id` kapcsolattal); a kanban-kártya nem az ügyállapot.
- Scope Gate (personal vs céges elkülönítés).
- Action Executor = az egyetlen külső író komponens.
- Konkrét, actionhöz kötött approval objektum.
- Idempotencia a kimenő műveleteken; `OUTCOME_UNKNOWN` -> readback, nincs vak retry.
- Skill Factory szigorúbb kapuval a külső-mellékhatású skilleknél.
- Vásárlási radar mint külön tartós domain (elkülönítve a `PURCHASE` case-től).

## 1.2 A v3.3-ból LEFARAGVA (aránytalan egy 1-user rendszerhez)

| v3.3 elem | Miért faragjuk | Helyette |
|---|---|---|
| Email Processing Ledger 15 státusszal, immutábilis, külön | Elosztott-rendszer szemantika 1 usernek, 1 írónak | `outbound_ledger` idempotencia-kulccsal + `email_processing` egyszerű állapot (lásd 6-7) |
| Thread lock lease + multi-worker konkurencia-kezelés | Nincs több párhuzamos worker ugyanazon a szálon | Egyszerű per-case advisory lock (egy futás egy case-t claim-el) |
| Minden belső íráshoz kötelező readback + kompenzáció | A belső SQLite írás megbízható, tranzakcionális | Readback CSAK a külső műveletekre (küldés, esemény, rendelés) |
| 30+ formális acceptance teszt előre | Waterfall-jelleg, a valós kockázatot nem fedi arányosan | Célzott elfogadási kritériumok a tényleges kockázati pontokra (13.) |
| Exactly-once "hatás" teljes formalizmusa mindenre | Csak a kimenő third-party műveletnél kritikus | Exactly-once GARANCIA a kimenő küldés/rendelésre; a belső oldal at-most-once elég |

Fontos: a **biztonsági INVARIÁNSOKAT nem gyengítjük** - csak a nehéz gépezetet cseréljük arányos, ugyanazt garantáló megoldásra. Egy cégnek soha nem megy ki kétszer ugyanaz a levél; egy rendelés soha nem duplázódik. Ezt a 7. szakasz konkrétan bizonyíthatóan adja.

## 1.3 HOZZÁTÉVE a v3.3-hoz

1. **Kampány-szintű autonómia-modell** (3.) - a v3.3 approval-je action-szintű; kibővítjük "terv-jóváhagyás -> autonóm batch-végrehajtás -> végkapu"-ra, mert István ezt kérte.
2. **Fokozatos bizalom-felhúzás** (12.) - az autonómia szintje ügytípusonként emelkedik, ahogy bizonyít.
3. **Vékony-szelet szállítási terv** (11.) a WP-katalógus helyett.

---

# 2. Scope

## 2.1 Engedélyezett (personal)

Család, ház/háztartás, karbantartás-javítás, magánutazás, személyes számlák és pénzügyi admin, magánegészségügyi admin, iskolai/családi ügyek, privát események, személyes vásárlások, magánjogi/ingatlan admin, személyes kapcsolatok, szolgáltatói ajánlatkérések, személyes dokumentumok, privát határidők, utánkövetések, háztartási készülékek és garanciák, otthoni felújítás.

## 2.2 Tiltott (technikai kontrollal, nem promptból)

ONE Magyarország, ZST Radio Kft., Product Lab, céges vezetői feladatok, céges e-mail/naptár/Drive, vállalati/márka ügyek, céges stratégia, `COS/ZST-Bridge` címke.

A ZST Radio Chief of Staff **külön rendszer lesz** (István döntése), nem ez.

## 2.3 Scope Gate

Minden bejövő elemre lefut, MIELŐTT bármit teszünk vele. Vizsgál: forrásfiók, Gmail-címkék, feladó/címzett domain, naptár-id, Drive-mappa, tárgy/entitások, korábbi ügykapcsolat, kontakt-típus, explicit projekt/cégnév.

Eredmény: `PERSONAL_CONFIRMED` (feldolgozható) / `PERSONAL_PROBABLE` (csak olvasás+elemzés, írás előtt még egy ellenőrzés) / `AMBIGUOUS` (`COS/Unmatched`, nincs főügy-írás) / `CORPORATE_EXCLUDED` / `ZST_EXCLUDED` (azonnali leállás) / `SECURITY_BLOCKED` (izolálás). Kizárt tartalom nem kerül személyes memóriába/összefoglalóba, csak minimális technikai auditsor.

---

# 3. Autonómia-modell: kampány-jóváhagyás + folyamat-végi kapu

Ez a v4 magja, mert ez adja azt, amit István akar.

## 3.1 A hurok

```text
[1] Istvan szandeka  (pl. "keress ajanlatot a medence-burkolatra")
      v
[2] Marveen felderit + TERVET kesz  (mely cegek, sablon, megoszthato adat, budget-cap, hatarido)
      v
[3] KAMPANY-JOVAHAGYAS  (Istvan EGYSZER bolint a tervre - nem levelenkent)
      v
[4] Marveen AUTONOM vegrehajt:
        - kikuldi a leveleket (idempotens, egyszer-kuldos)
        - utankovet (follow-up N nap utan)
        - begyujti + normalizalja az ajanlatokat
      v
[5] VEGKAPU  (Marveen visszajon: osszehasonlito tabla + ajanlas -> Istvan valaszt / fizet)
      v
[6] Vegrehajtas (foglalas/rendeles) + lezaras
```

## 3.2 A kampány-jóváhagyási objektum

A jóváhagyás **egy tervre** szól, nem egyetlen műveletre, és pontosan behatárolja, mit tehet Marveen autonóm módon:

```text
campaign_approval
  campaign_id
  case_id
  campaign_type        (QUOTE_REQUEST | DINNER_ORDER | ...)
  scope_summary        (mit fog csinalni, emberi mondatban)
  allowed_recipients   (konkret cegek/cimek listaja - csak ezeknek)
  allowed_channels     (email | webform)
  message_template_hash(a jovahagyott sablon hash-e)
  shareable_data       (pl. "nev + kerulet + email" - EZEN TUL semmi)
  budget_cap + currency
  max_outbound_count   (hany level mehet ki max)
  follow_up_policy     (hany nap, hanyszor)
  valid_until
  approved_by / approved_at
  final_gate           (mi a vegso kapu: SELECTION | PAYMENT | BOTH)
```

**Bármely lényeges eltérés érvényteleníti a jóváhagyást** (más címzett, módosult sablon-hash, budget-túllépés, több levél mint `max_outbound_count`, új megosztandó adat). Ilyenkor Marveen megáll és visszakérdez.

## 3.3 Mit tehet Marveen autonóm módon, és mi marad kapunál

| Művelet | Kampány-jóváhagyás után |
|---|---|
| Szolgáltatók keresése, shortlist | Autonóm |
| Ajánlatkérő levél kiküldése a jóváhagyott címzetteknek | **Autonóm** (a jóváhagyott sablonnal + adattal) |
| Follow-up levél a jóváhagyott policy szerint | Autonóm |
| Beérkező ajánlatok begyűjtése, normalizálása, összehasonlítása | Autonóm |
| Naptárbejegyzés (privát, saját) | Autonóm |
| Kifli-kosár összeállítása | Autonóm |
| **Végső szolgáltató kiválasztása / foglalás** | **Kapu (István)** |
| **Fizetés / bankkártyás hitelesítés** | **Mindig István, kézzel** |
| Új címzett, aki nincs a jóváhagyott listán | Kapu (István) |
| A jóváhagyottnál több személyes adat kiadása | Kapu (István) |

## 3.4 Első-futás bizalom-építés

A LEGELSŐ kampánynál (ügytípusonként egyszer) Marveen a terv-jóváhagyás részeként megmutatja a **konkrét shortlistet + a pontos levélsablont** egy gyors ok-ra, mielőtt az első levél kimegy. Ez NEM levelenkénti jóváhagyás - egyszeri, a kampány elején. Miután az adott ügytípus bizonyított, ez a felmutatás elmarad (lásd 12. fokozatos autonómia).

---

# 4. Arányos biztonság - mit garantálunk és hogyan

A cél ugyanaz, mint a v3.3-é a kimenő oldalon, csak olcsóbban:

1. **Egy third-party sem kap kétszer ugyanaz t a levelet.** -> per-recipient idempotencia-kulcs (7.1).
2. **Egy rendelés sem duplázódik.** -> idempotencia-kulcs + rendelés-előtti kosár/order readback.
3. **Timeout után nem küldünk vakon újra.** -> `OUTCOME_UNKNOWN` állapot + Sent/order readback a retry előtt.
4. **A jóváhagyott kereten kívül semmi nem történik.** -> kampány-approval hash-ellenőrzés minden action előtt.
5. **Minden kimenő művelet auditálható.** -> `outbound_ledger` + `personal_case_events` append-only napló.

Amit NEM építünk (és miért nem kell): elosztott exactly-once koordináció, multi-worker lock-lease, kétfázisú commit a belső írásokra. Egy user, egy Marveen-instancia, egy író Action Executor - a konkurencia, ami ezeket indokolná, itt nem létezik.

---

# 5. Repo-native architektúra

```text
Felhasznalo
   v
Telegram / (Slack) / Mission Control dashboard
   v
Fo Marveen Orchestrator  [MEGLEVO]
   |- Personal Scope Gate            [UJ]
   |- Personal Case Engine           [UJ]
   |- Campaign & Approval Store       [UJ]
   |- Autonomy Config                 [MEGLEVO, bovitendo]
   |- Memory (hot/warm/cold/shared)   [MEGLEVO]
   |- Skill Factory                   [MEGLEVO, szigoritando]
   |- Kanban                          [MEGLEVO]
   |- Scheduler + preCheck            [MEGLEVO]
   |- Background Tasks / Agent Fleet  [MEGLEVO, opcionalis]
   \- Action Executor                 [UJ]  <-- az EGYETLEN kulso iro
         |- Gmail MCP  (read + WRITE)   <-- write scope kell (elofeltetel)
         |- Calendar MCP (read + write)
         |- Drive MCP (read + write)
         |- Kifli browser-worker (izolalt)   <-- hozzaferes tisztazando
         |- Research / browser adapter
         \- Notification (Telegram)

SQLite store
   |- personal_cases            [UJ]
   |- personal_case_events      [UJ, append-only]
   |- personal_case_actions     [UJ]
   |- campaigns                 [UJ]
   |- campaign_approvals        [UJ]
   |- outbound_ledger           [UJ]  <-- a kimeno idempotencia magja
   |- email_processing          [UJ, egyszerusitett]
   |- connector_health          [UJ]
   |- shopping_radar            [UJ]
   |- kanban_cards / memories / daily_logs / pending_task_retries / background_tasks  [MEGLEVO]
```

---

# 6. Adatmodell (arányos)

## 6.1 `personal_cases`

```text
case_id, title, description, case_type, category, scope, status, priority,
owner, created_at, updated_at, source_system, source_references,
parent_case_id, related_case_ids, next_action, next_action_owner,
due_at, follow_up_at, waiting_on, blocked_reason,
sensitivity, related_contact_ids, related_document_ids,
calendar_event_ids, gmail_thread_ids, last_event_id, closure_reason,
completed_at, archived_at
```

Case típusok: `PERSONAL_ADMIN`, `HOUSEHOLD_EVENT`, `HOME_REPAIR`, `HOME_IMPROVEMENT`, `PURCHASE`, `TRAVEL`, `FAMILY`, `FINANCE`, `HEALTH_ADMIN`, `DOCUMENT_REQUEST`, `LEGAL_PROPERTY`, `WAITING_FOLLOWUP`, `RECURRING_MAINTENANCE`.

Állapotgép (egyszerűsített, de teljes): `NEW -> TRIAGE -> INFO_REQUIRED -> READY -> PLANNING -> AWAITING_APPROVAL -> EXECUTING -> WAITING_EXTERNAL -> FOLLOW_UP_DUE -> CALL_REQUIRED -> AWAITING_SELECTION -> SCHEDULED -> BLOCKED -> RECOVERY_REQUIRED -> COMPLETED -> CANCELLED -> ARCHIVED`.

Státuszt csak validált domain command írhat, nem közvetlen LLM. Minden váltás eseményt ír a `personal_case_events`-be (append-only: previous/new status, ok, kezdeményező, forrás, timestamp).

## 6.2 `campaigns` és `campaign_approvals`

A 3.2 szerinti mezők. Egy case-hez több kampány tartozhat időben, de egyszerre egy aktív.

## 6.3 `outbound_ledger` (a kimenő idempotencia)

```text
outbound_id
case_id
campaign_id
channel              (gmail | calendar | kifli | webform)
idempotency_key      (lasd 7.1)
recipient
payload_hash         (levelsablon+adat / kosar tartalma hash-e)
status               (PLANNED | SENDING | SENT | OUTCOME_UNKNOWN | VERIFIED | FAILED)
external_ref         (Gmail sent message id / calendar event id / order id)
first_attempt_at
last_attempt_at
verified_at
error_code
```

## 6.4 `email_processing` (egyszerűsített, NEM a 15-státuszos ledger)

```text
gmail_account_id + thread_id + message_id  (egyedi kulcs)
content_hash, case_id, status (NEW | ANALYZED | APPLIED | DONE | EXCLUDED | DUPLICATE),
first_seen_at, done_at, run_id, error_code
```

Ennyi elég ahhoz, hogy egy levelet ne dolgozzunk fel kétszer, és hogy a duplát felismerjük. Nincs szükség lock-lease-re és 15 státuszra.

---

# 7. Kimenő művelet-biztonság (a szigor magja)

## 7.1 Idempotencia-kulcs

Küldésnél:
```text
sha256(campaign_id + recipient + payload_hash)
```
Rendelésnél / Kifli:
```text
sha256(campaign_id + cart_content_hash)
```

Az Action Executor MINDEN kimenő művelet előtt megnézi az `outbound_ledger`-t az idempotencia-kulcsra:
- ha `VERIFIED` -> **nem csinál semmit** (már megtörtént).
- ha `OUTCOME_UNKNOWN` -> **readback** (lásd 7.2), nem küld vakon.
- ha nincs sor -> `PLANNED` sort ír, majd végrehajt.

## 7.2 Végrehajtási sorrend (per kimenő action)

```text
CHECK approval hash + scope + budget + max_outbound
CHECK idempotency (outbound_ledger)
WRITE PLANNED
EXECUTE external (send / create event / assemble+submit cart)
  - ha timeout/ismeretlen -> status = OUTCOME_UNKNOWN, STOP (nincs vak retry)
READBACK:
  - Gmail: Sent keres idempotency-kulcs + recipient + payload_hash alapjan
  - Calendar: event keres case_id + start/end alapjan
  - Kifli: order-history / cart-state alapjan
WRITE VERIFIED (+ external_ref)
UPDATE case + event log
```

## 7.3 Nincs hamis rollback

Kimenő levél nem vonható vissza. Ahol tévedés történik: kompenzáció (helyesbítő levél, esemény törlése, foglalás lemondása) - explicit, naplózott lépésként, nem "rollback"-ként.

---

# 8. Fő workflow-k (részletesen)

## 8.1 Ajánlatkérő-kampány (autonóm multi-vendor) - ez az 1. pilot

### Adatbekérés (Marveen összegyűjti, hiányzót kérdez)
eszköz/terület, márka/modell, hibajelenség, sürgősség, biztonsági kockázat, fotók (Drive), elérhető időablakok, budget-elképzelés, helyszín (kerület szint a shortlisthez).

### Szolgáltatókeresési sorrend
1. garanciális/gyártói szerviz; 2. korábban megbízhatónak jelölt szolgáltató (memóriából); 3. hivatalos/szakmai szolgáltató; 4. helyi keresés; 5. piacterek.

### Folyamat
```text
NEW -> INFO_REQUIRED -> SAFETY_TRIAGE -> WARRANTY_CHECK
 -> PROVIDER_RESEARCH -> SHORTLIST_READY
 -> [KAMPANY-JOVAHAGYAS: cegek + sablon + megoszthato adat + budget]
 -> REQUESTS_SENDING (autonom, idempotens)
 -> WAITING_EXTERNAL -> FOLLOW_UP_DUE (autonom follow-up)
 -> QUOTES_COLLECTED -> COMPARISON_READY
 -> [VEGKAPU: osszehasonlito tabla + ajanlas -> Istvan valaszt]
 -> APPOINTMENT / BOOKING (jovahagyassal)
 -> SCHEDULED -> SERVICE_DONE -> INVOICE_WARRANTY_CAPTURE -> COMPLETED
```

### Összehasonlító mezők (a végkapunál)
szolgáltató, forrás, értékelés + darab, releváns tapasztalat, kiszállási díj, diagnosztika díj, javítási becslés, alkatrészkezelés, legkorábbi időpont, garancia, számla-adás, kommunikáció minősége, kockázati jelek.

### Hard gate
cím/telefon csak a jóváhagyott `shareable_data` szerint; a jóváhagyott listán kívüli cégnek nem megy levél; foglalás/előleg mindig István; ugyanaz az ajánlatkérés ugyanannak a cégnek nem megy kétszer (7.1).

## 8.2 Vendégség (Kifli-kosár) - 2. pilot, a Kifli-hozzáférés tisztázása után

### Marveen összegyűjti / kérdezi
dátum + időpont, vendégek + létszám (megnézi a korábbi hasonló eseményekből vagy megkérdezi), ételallergia/étrend, főzés vagy rendelés, budget, beszerzési mód.

### Folyamat
```text
NEW -> INFO_REQUIRED -> CALENDAR_HOLD (autonom, privat esemeny)
 -> MENU_PROPOSAL (Marveen ajanl) -> [MENU + LETSZAM + BUDGET JOVAHAGYAS]
 -> SHOPPING_LIST -> KIFLI_CART_ASSEMBLED (autonom)
 -> [VEGKAPU: kesz kosar + vegosszeg + szallitasi sav -> Istvan lekattintja a FIZETEST]
 -> ORDER_CONFIRMED -> CALENDAR_PREP -> COMPLETED
```

### Kontrollok
ételallergia kötelezően ellenőrzött a menünél; a kosár összeáll autonóm, de a **fizetés mindig István kézzel**; végösszeg + helyettesítések + szállítási idősáv a végkapunál látszik; a kosár-beküldés idempotens (nem duplarendel).

---

# 9. Scheduler-integráció (meglévőre)

Négy ütemezett belépő, mind a meglévő `preCheck` gate-tel (nincs LLM-hívás, ha nincs munka):

- `personal-case-wake` (5-10 perc): `next_wake_at <= now` ügyek; egy wake-et egyszer claim-el; busy-nál a meglévő retry queue.
- `personal-gmail-delta` (óránként vagy sűrűbben): capability audit után csak új deltát dolgoz; no-op esetén csendes. **A meglévő email-triage heartbeatet ebbe integráljuk, nem építünk párhuzamosat.**
- `personal-daily-reconcile` (napi): `outbound_ledger`, case store, kanban, connector health összevetése; félbemaradt / `OUTCOME_UNKNOWN` action keresése.
- `personal-weekly-review` (heti): elakadt, határidő nélküli, régóta változatlan ügyek.

Külső módosító action előtt a `preCheck` SOHA nem helyettesíti a capability-, approval-, lock- és idempotency-ellenőrzést.

---

# 10. Előfeltételek és külső függőségek

Ezek a kritikus úton vannak, és Istvántól kellenek:

1. **Gmail SEND (write) scope.** A jelenlegi `google-private` MCP read-only. Az ajánlatkérő-kampányhoz Gmail-küldés kell -> böngészős Google consent írási jogokkal, a saját MCP-szerverünkre kötve. (A claude.ai konnektor write-ja headless heartbeatben nem megbízható - ezért a saját MCP-re megy.)
2. **Kifli-hozzáférés módja.** Nincs publikus Kifli API (tudtommal). A kosár-összeállítás valószínűleg egy **izolált browser-worker** a bejelentkezett Kifli-fiókban. Istvánnak kell eldöntenie: ad-e egy izolált workernek Kifli-belépőt (Vaultban tárolva), vagy más megoldás. **A 8.2 pilot ettől függ; a 8.1 pilot NEM.**
3. **Calendar/Drive write** (a 8.2-höz és a fotó-intake-hez): szintén a write consent része.

Amíg ezek nincsenek: a rendszer **observe + prepare** módban teljes értékű (felderít, shortlistet készít, draftot előkészít) - csak a tényleges kiküldés/kosár vár a jogokra.

---

# 11. Inkrementális szállítás - vékony szeletek

A v3.3 WP0-WP10 vízesése helyett szeletek, mindegyik végponttól végpontig, élő értékkel:

### Slice 0 - Alap + WP0 audit (nincs külső függőség)
- Repo-audit + **capability-to-requirement gap-mátrix** (EXISTS / PARTIAL / MISSING / CONFLICT). **A spec névleg hivatkozott repo-elemeit (docs/*, issue #517, #560/#561, tool-timeouts.ts, v1.22.0) itt VERIFIKÁLJUK a mi `develop` águnkon - spec-állítás nem bizonyíték.**
- `personal_cases` + `personal_case_events` táblák, case state machine, domain commands.
- Mission Control "Ma" + "Ügyek" nézet (olvasás).

### Slice 1 - Ajánlatkérő-kampány, EGY valódi házügyön (a fő pilot)
- Előfeltétel: Gmail write consent.
- `campaigns` + `campaign_approvals` + `outbound_ledger`; Action Executor a Gmail-send-re; idempotencia + Sent-readback.
- A teljes 8.1 hurok egy ügyön (javaslat: medence-burkolat): felderítés -> shortlist -> terv-jóváhagyás -> autonóm kiküldés + follow-up -> begyűjtés -> végkapu.
- Első-futás felmutatás (3.4).
- **Ez bizonyítja a teljes autonómia-hurkot, amit István kért, minimális felülettel.**

### Slice 2 - Általánosítás + több házügy
- A 3 házügy (szúnyogháló/redőny, hátsó lépcső, medence-burkolat) mind kap case-t, Drive-mappát, mellékletregisztert.
- A kampány-workflow skillként általánosítva (bármely `HOME_REPAIR`-re).

### Slice 3 - Vendégség + Kifli
- Előfeltétel: Kifli-hozzáférés tisztázva.
- Kifli browser-worker (izolált, Vault-credential), kosár-idempotencia; a 8.2 hurok.

### Slice 4 - Vásárlási radar
- `shopping_radar` domain, ár/készlet-figyelés a scheduler+preCheck-en, döntési kártya, `PURCHASE` case kapcsolat.

### Slice 5 - Proaktív teljesség + reconcile + Mission Control teljes
- Napi reconcile, heti review, connector health nézet, autonómia-kapcsolók domainenként.

Minden szelet DoD-je: kódhely + migráció + teszt + futási bizonyíték + UI-elérés. Nincs prompt-only "kész".

---

# 12. Fokozatos autonómia (bizalom-felhúzás)

Ügytípusonként külön, `OFF -> OBSERVE -> PREPARE -> EXECUTE_WITH_APPROVAL -> LIMITED_AUTONOMOUS`:

- Kezdet: minden új ügytípus `EXECUTE_WITH_APPROVAL` az első-futás felmutatással (3.4).
- Miután egy ügytípus N sikeres kampányt bizonyított hibamentesen, István egy kattintással emelheti `LIMITED_AUTONOMOUS`-ra (nincs első-futás felmutatás, csak a végkapu marad).
- A fizetés és a jogosultságon túli adatmegosztás SOHA nem emelhető autonómra.
- Főkapcsoló: az egész Personal Chief egy kapcsolóval szüneteltethető.

---

# 13. Elfogadási kritériumok (a valódi kockázatra)

- **AC-1 (nincs duplakuldés):** ugyanaz a kampány+címzett+payload háromszori futásnál egyszer küld (idempotencia).
- **AC-2 (timeout-biztos):** Gmail-send timeout után Sent-readback történik retry előtt; nincs vak újraküldés.
- **AC-3 (kampány-határ):** a jóváhagyott listán kívüli címzettnek nem megy levél; sablon-hash változás érvényteleníti a jóváhagyást.
- **AC-4 (adatminimum):** csak a `shareable_data`-ban engedélyezett adat kerül ki; azon túl kapu.
- **AC-5 (végkapu):** foglalás/rendelés/fizetés csak explicit István-döntés után.
- **AC-6 (Kifli nem duplarendel):** kosár-beküldés idempotens; timeout után order-readback.
- **AC-7 (scope):** ZST/céges tartalom nem kerül a personal store-ba.
- **AC-8 (nincs kitalált tény):** dátum/összeg/cím/ajánlat/döntés nem AI-következtetésből lesz tény; bizonytalan = `UNVERIFIED`.
- **AC-9 (restart-folytonos):** többnapos váró kampány újraindítás után folytatódik (case store + outbound_ledger alapján).
- **AC-10 (audit):** minden kimenő action visszavezethető approvalhoz, kampányhoz, case-hez, run-hoz, forráshoz.

---

# 14. Nyitott döntések Istvánnak

1. **Gmail write consent** - mikor tudod megadni (böngészős, írási jogokkal)? Ez a Slice 1 kritikus előfeltétele.
2. **Kifli** - izolált browser-worker a bejelentkezett fiókban (Vault-credential), vagy más? Ez a Slice 3-at nyitja.
3. **Pilot-ügy** - a Slice 1 melyik házügyön induljon? (Javaslatom: medence-burkolat, mert kézzelfogható és jól fotózható.)
4. **Autonómia startszint** - jó az, hogy az első kampánynál egyszer felmutatom a shortlistet + sablont (3.4), vagy még ennél is óvatosabban induljak?

Ha ezekre megvan a válasz, a Slice 0 (audit + gap-mátrix + case store alap) azonnal indulhat, mert az nem vár külső jogokra.

---

*Marveen, v4 - a javaslatom nem a legnagyobb rendszer, hanem az, amelyik a leghamarabb elviszi a valódi ügyeidet a végkapuig, és sehol nem küld kétszer a nevedben.*
