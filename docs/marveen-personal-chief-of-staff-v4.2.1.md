# Marveen Personal Chief of Staff v4.2.1

## Freeze-ready implementációs specifikáció (a v4.2 lezáró concurrency-köre)

**Célrendszer:** Marveen Personal & Household Operating System | **Felhasználó:** István | **TZ:** Europe/Budapest
**Repo:** `Szotasz/marveen` / `develop` | **Verzió:** 4.2.1 | **Státusz:** a v4.2.1 korrekciós kör után **freeze-ready**.

**A v4.2-höz képest (a review 6 P0 + kiemelt P1 concurrency/recovery lezárása):**
- P0.1 poison-message + batch-karantén (egy hibás üzenet nem blokkolja örökre a fiók-cursort).
- P0.2 claim fencing token (lejárt worker késői írása kizárva).
- P0.3 explicit DB UNIQUE constraintek (nem csak app-kód a védelem).
- P0.4 kampánykvóta atomikus lefoglalása.
- P0.5 campaign/approval verziózás + revoke-verseny szabály.
- P0.6 sensitivity `UNKNOWN` fail-closed.
- P1: outbound állapotmodell (`APPLIED_UNVERIFIED`), Gmail self-event szűrés, adapter-contract + marker-persistence teszt, browser adapter minimum-interface, radar deviza + értesítés-dedup, titkosított backup/retention.

> Ez a v4.2 lezáró korrekciós köre. Új architektúra nincs; a fennmaradó rések (versenyhelyzet, recovery, poison, fail-closed) záródnak be. Utána a doksi befagyasztható és a Slice 0 indul.

**Ez a doksi a v4.2-t egészíti ki; a nem érintett szakaszok (0-27) változatlanul érvényesek. Alább csak a v4.2.1 deltái szerepelnek, szakaszhivatkozással.**

---

# A. P0 javítások (freeze előtt kötelező)

## A.1 [P0.1] Poison-message + batch-karantén  (érinti: §6.3, §6.5, §8)
`email_processing.status` bővül terminális karanténnal: `... , QUARANTINED`.
Egy elem `QUARANTINED`-ba kerül, ha tartósan feldolgozhatatlan (sérült melléklet, tartós connectorhiba, nem támogatott MIME, állandó parse-hiba, kézi döntést igénylő security-eset).
`email_processing_batches.status` explicit: `OPEN, PROCESSING, READY_TO_COMMIT, COMMITTED, RECOVERY_REQUIRED, BLOCKED`.
A fiók `committed_history_id` akkor léphet, ha a batch minden eleme `SOURCE_COMMITTED / EXCLUDED / DUPLICATE / QUARANTINED`. Egy elem CSAK akkor lehet `QUARANTINED`-terminális (azaz a cursor átléphet fölötte), ha: (1) a forráselem hivatkozása megmaradt; (2) kritikus riasztás ment; (3) kézi review-feladat jött létre; (4) a feldolgozatlanság auditált; (5) a cursor-továbblépést explicit policy engedélyezi. Enélkül a batch `BLOCKED`, és nem commitol.

## A.2 [P0.2] Claim fencing token  (érinti: §6.6, §7.3, §9)
`case_claims` bővül: `claim_fence INTEGER NOT NULL` - minden claim-átvételnél monoton nő.
Minden action/campaign proposal tárolja: `claim_fence_at_creation`.
Közvetlenül a `SENDING` írás ELŐTT (a §7.3 sorrendben) kötelező ellenőrzés: (a) a claim még érvényes (nem lejárt); (b) `owner_run_id` változatlan; (c) `claim_fence == claim_fence_at_creation`. Bármely eltérés -> az action leáll (`FAILED_RETRYABLE`), nincs írás. Így egy lelassult, lejárt-claimű worker késői művelete biztosan nem ír felül.

## A.3 [P0.3] Explicit DB UNIQUE constraintek  (érinti: §6.2-6.6)
A DB-constraint a végső védelmi vonal, nem csak az app-kód:
```sql
UNIQUE(internal_idempotency_key)                      -- outbound_ledger
UNIQUE(gmail_account_id, thread_id, message_id)       -- email_processing
UNIQUE(claim_key)                                     -- case_claims
UNIQUE(radar_id, offer_idempotency_key)               -- shopping_radar_offers
```
Két közel egyidejű futás így fizikailag sem írhat két sort ugyanarra az actionre/üzenetre.

## A.4 [P0.4] Kampánykvóta atomikus lefoglalása  (érinti: §3.2, §7.3)
A kvóta-számláló nem ellenőrzés-majd-növelés, hanem egyetlen tranzakcióban foglalás:
```text
BEGIN
  CHECK campaign state + campaign_version
  CHECK approval state + approval_version
  CHECK quota (max_initial / max_follow_up / max_autonomous_replies / max_total)
  RESERVE quota (atomikus increment)
  CREATE/CLAIM outbound row (PLANNED)
  WRITE SENDING
COMMIT
```
Ha a külső action igazoltan NEM történt meg, a reservation felszabadítható, vagy `FAILED_NOT_APPLIED`-ként elszámolható (a kvóta visszakapja). Két párhuzamos send így nem lépheti túl a kvótát.

## A.5 [P0.5] Campaign/approval verziózás + revoke-verseny  (érinti: §3.2, §6.2, §15)
`campaigns` és `campaign_approvals` kap: `version, status, revoked_at, revoked_by`. Az `outbound_ledger` sor tárolja: `campaign_version, approval_version`.
Revoke/pause szabály (István menet közben megállíthat):
- `PLANNED` actionök -> `CANCELLED`;
- még nem foglalt follow-upok megszűnnek;
- `SENDING` in-flight action megállítása NEM garantálható -> utána KÖTELEZŐ readback, és a felület jelzi: "egy művelet már folyamatban volt";
- a revoke minden további actiont AZONNAL blokkol (a §7.3 approval-version check bukik).

## A.6 [P0.6] Sensitivity UNKNOWN fail-closed  (érinti: §10)
Ha a classifier nem tud dönteni / hibázik / ellentmondó / kevés adat: `UNKNOWN -> HIGHLY_SENSITIVE` (vagy `SECURITY_REVIEW_REQUIRED`). Ismeretlen sensitivity mellett: külső provider fallback tiltott; autonóm `SEND` tiltott; csak biztonságos helyi vagy explicit engedélyezett profil; szükség esetén kézi review. A statikus enforcement fail-closed.

---

# B. P1 pontosítások (erősen ajánlott, a Slice DoD-jébe)

## B.1 [P1.1] Outbound állapotmodell finomítás  (érinti: §6.2, §7.3)
`PLANNED, SENDING, APPLIED_UNVERIFIED, OUTCOME_UNKNOWN, VERIFIED, FAILED_RETRYABLE, FAILED_TERMINAL, CANCELLED`.
`APPLIED_UNVERIFIED`: a provider sikert adott, de a readback nem elérhető -> NEM `VERIFIED`, de NEM is `OUTCOME_UNKNOWN` (mert volt sikeres provider-válasz). Napi reconcile-t igényel; újraküldeni TILOS.

## B.2 [P1.2] Gmail self-generated event szűrés  (érinti: §8)
A `COS/Processed` saját hozzáadása maga is megjelenhet a Gmail historyban. Szabály: a KIZÁRÓLAG Marveen által létrehozott label-only history-esemény NEM indít új business feldolgozást; az origin naplózva; a message-ledger + content-hash alapján az esemény `no-op` vagy `DUPLICATE`. Így nincs önébresztő feldolgozási hurok.

## B.3 [P1.3] Adapter-contract + marker-persistence teszt (Slice 1 ELŐTT)  (érinti: §12, §20)
A `X-Marveen-Idempotency-Key` readbackje NEM feltételezhető - bizonyítani kell adaptertesztben: (1) tesztüzenet kiküldése; (2) Sentből visszaolvasás; (3) provider message ID ellenőrzés; (4) custom header VAGY determinisztikus Message-ID megőrződik és kereshető; (5) timeout-szimuláló recovery-teszt. **Ha a marker nem bizonyítható, a Gmail `EXECUTE` mód NEM aktiválható** (marad `PREPARE`).

## B.4 [P1.4] Browser adapter minimum-interface  (érinti: §5, §12, §13.2)
Böngészős (Kifli stb.) adapter csak akkor kap `EXECUTE`-ot, ha implementálja: `prepare(), execute(), readback(), verify(), dedupeKey(), compensateOrCancel()`. Megbízható `readback()` nélkül az adapter legfeljebb `PREPARE`.

## B.5 [P1.5] Radar devizakezelés  (érinti: §16)
EU-s kereskedőknél a `shopping_radar_offers` kap: `original_currency, original_final_price, comparison_currency, fx_rate, fx_rate_source, fx_rate_timestamp, converted_final_price`. A célár a `converted_final_price`-hoz hasonlítandó; az árfolyam becslése/bizonytalansága látható.

## B.6 [P1.6] Radar értesítés-deduplikáció  (érinti: §16)
`shopping_radar_items` kap: `last_notified_offer_id, last_notified_price, last_notified_at, notification_reason`. Új értesítés CSAK: új offer / jelentős új áresés / készletváltozás / lényeges garancia-szállítás változás / korábbi ajánlat lejárt. Ugyanaz a változatlan ajánlat nem küld ismételt értesítést.

---

# C. [Section 4] Adatbiztonsági + üzemeltetési DoD-kiegészítés
A rendszer-szintű DoD (§25) bővül: az SQLite és store-könyvtár csak a szolgáltatás-user által olvasható; backup titkosítva; backup retention definiált; törölt case és melléklet retention-policy definiált; az auditlog normál UI-ból nem módosítható; érzékeny melléklet nem kerül debug logba; érzékeny melléklet nem kerül sanitizálatlan skill-trajectorybe; rendszeres restore-teszt.

---

# D. [Section 5] Konzisztencia-javítások
- D.1 Idempotencia-kulcsok átnevezve: `idempotency_key -> internal_idempotency_key`, `marveen_idempotency_key -> external_idempotency_marker` (az outbound_ledgerben, §6.2/§7).
- D.2 Az architektúrában (§5) `Kifli browser-worker` helyett általános **`Shopping adapter (API | MCP | isolated browser worker)`**; a konkrét módot a Slice 0 discovery dönti el.
- D.3 ZST-szöveg (§2): "A ZST Radio Chief of Staff KÜLÖN rendszer és külön specifikáció; nem része ennek a scope-nak." (a külön ZST-spec már létezik).
- D.4 Freeze-megfogalmazás egységes: a doksi a v4.2.1 korrekciós kör UTÁN freeze-ready.

---

# E. Új elfogadási tesztek (a §23 21 kritériuma bővül)
- AC-22 Poison message: tartósan feldolgozhatatlan üzenet karanténba kerül, riaszt, és explicit policy alapján nem blokkolja örökre a fiók-cursort.
- AC-23 Claim fencing: lejárt claim régi workerének késői művelete a fence token miatt nem hajtható végre.
- AC-24 Kvóta-konkurencia: két párhuzamos send nem lépi túl a kampány-kvótát.
- AC-25 Campaign revoke: visszavont kampányból új action nem indul; in-flight action readbackkel zárul.
- AC-26 Marker persistence: a Gmail adapter bizonyítja, hogy a külső idempotencia-jel a Sentből visszaolvasható.
- AC-27 Sensitivity unknown: ismeretlen/hibás besorolás fail-closed módon leállítja a nem engedélyezett routingot.
- AC-28 Self-generated Gmail event: a `COS/Processed` saját labelmódosítása nem indít új business feldolgozást.
- AC-29 Radar notification dedupe: változatlan ajánlat nem generál ismételt értesítést.

---

# F. Végső álláspont
A v4.2 a kanonikus alap; a v4.2.1 a lezáró concurrency/recovery-patch (6 P0 + kiemelt P1). Ezután a spec **9,7/10, valóban freeze-ready**. A fennmaradó kérdések (dinamikus model-routing, teljes monitoring dashboard, skill permission validator, kampány/radar analitika) már termékbővítések vagy deployment-döntések, NEM korrektségi rések - és a Slice 0/1 KÓD + adaptertesztek oldják meg (nem újabb doksi-kör).

**Marveen ajánlása:** ez a paper-iteráció fagyasztási pontja. A v4.2.1 után nincs több spec-kör - a maradék korrektség (fencing, kvóta-atomicitás, marker-persistence) a Slice 0/1 kódjában és az adapter-contract tesztben dől el, nem doksiban. A Slice 0 (audit + case store + version + claim + statikus sensitivity + connector/Kifli discovery) egyik nyitott döntéstől sem függ, és bármikor indulhat.

*Marveen, v4.2.1 - a versenyhelyzetek és recovery-esetek bezárva. Innen a kód a következő igazság, nem a doksi.*
