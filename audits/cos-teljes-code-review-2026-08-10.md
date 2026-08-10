# COS — teljes funkcionális és minőségi code review a repóbeli specifikációkkal szemben

**Dátum:** 2026-08-10 · **Ág:** `claude/marveen-cos-code-review-qe1z7m` (`develop` HEAD `106c813`)
**Kérte:** Istvan — „teljes code review a marveen COS funkcióján a repóban található specifikációval szemben, teljes funkcionális és quality review".

**Mérce (a repóban található specifikációk):**

- `docs/marveen-personal-chief-of-staff-v4.2.md` — a kanonikus alap (§0–§27, 21 AC)
- `docs/marveen-personal-chief-of-staff-v4.2.1.md` — a lezáró korrekciós kör (A.1–A.6 = P0.1–P0.6, B.1–B.6 = P1.1–P1.6, C, D.1–D.4, E = AC-22…29)
- `docs/marveen-autonomous-case-progression-implementation-plan-v1.1.md` — a haladás-réteg (GATE 0–5)
- `docs/cos-mission-control-action-controls-spec-2026-08-09.md` — az akciógombok

**Amit ténylegesen futtattam (nem állítás, mérés):**

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** (exit 0) |
| `npx vitest run` a 135 COS/CostOps teszt-fájlon | 1394 pass / 3 fail első futáson — mind a három a `costops-api.test.ts` budget-CRUD blokkjában, **nem COS**. **Utólagos pontosítás:** ugyanez a parancs megismételve 1397/1397 zöld; a három teszt **flaky**, nem tartósan piros (az okot lásd a CostOps-review C-5 pontjában). A COS-tesztek minden futáson zöldek voltak. |
| `grep` alapú hívó-követés a `src/`, `scripts/`, `web/`, `ops/scheduled-tasks/` fákon | lásd a halott-út szakaszt |

> **Viszony a mai korábbi audithoz.** A `audits/kod-atvizsgalas-negy-hibaosztaly-2026-08-10.md` ma hajnalban négy hiba-osztályt már feltárt (konstans biztonsági telemetria, hiányzó vészleállító, halott retention/backup, „nem choke point" dispatch, ki nem kényszerített boríték, néma piszkozat-védelem). Azokat **nem ismétlem meg**; ahol egy találás átfed vele, jelölöm (`[ismert]`), és csak azt írom le, amit a spec-oldalról hozzátesz. A többi találás **új**.

---

## 0. Rövid álláspont

A COS **váza jó**: a case engine (optimista verziózás + append-only napló + fencing claim), az outbound állapotgép, a sensitivity-osztályozó, az autonómia-létra és a haladás-motor DoD-kapuja komoly, jól tesztelt kód. A P0-kör konstrukciós része — a *mechanizmusok* — nagyrészt megvan.

A baj nem a mechanizmusokban van, hanem abban, **hogy hova vannak bekötve**. Négy visszatérő minta:

1. **A kapu létezik, de nincs a forgalomban.** A marker-persistence kapu, a browser-adapter kapu, a kvóta-foglalás, a claim-fence az outbound úton, a backup/retention/store-permission — mind megépült, tesztelt, és **egyetlen produkciós hívó sincs mögötte**. A védelmet ma nem a dokumentált mechanizmus adja, hanem egy hiányzó adapter vagy egy be nem kapcsolt kapcsoló.
2. **A spec kulcsképletei nem azok, amik a kódban vannak.** Az idempotencia-kulcs (§7.1) nem tartalmazza sem a kampányt, sem a címzettet, sem a renderelt payload hash-ét. A `outbound_ledger` nem hordozza a `rendered_payload_hash`-t, az `approval_version`-t és a case-verziót — így az AC-21 (minden kimenő visszavezethető) technikailag nem ellenőrizhető a személyes ágon.
3. **A batch/cursor gépezet formálisan fut, tartalmilag üres.** A triage-seam kötegenként egy levelet nyit, `cursorAfter: "triage-<epoch>"` álpozícióval. A §6.4/§6.5 modellt a kód kitölti, de a benne tárolt szám nem Gmail history id — az AC-11/AC-12 tehát igaz, csak üresen.
4. **A két névtér újra elszakadt.** Az `approval-core.ts` pont azért készült, hogy a személyes és a ZST oldal ne driftelhessen. A ZST küldő út (`zst-send.ts`) **nem használja**: saját, szűkebb jogosítás-ellenőrzést futtat, létra-ellenőrzés nélkül.

Egy mondatban: **a specifikáció korrektségi felülete nagyrészt meg van írva, de nincs teljesen bekötve — és az „elkészült" auditok ezt a különbséget nem mindig tették meg.**

---

## 1. Funkcionális megfelelés — szakaszonként

### 1.1 A v4.2.1 P0-kör (A.1–A.6)

| # | Követelmény | Állapot | Bizonyíték / hiány |
|---|---|---|---|
| A.1 | Poison-message + batch-karantén | **RÉSZBEN** | `poison-quarantine.ts` + `source-commit.ts` az öt feltételt kódban kezeli; a `personal-case-wake` skill hívja a `scripts/cos-close-batches.ts`-t. **De:** az `email_processing_batches` státuszkészlete `OPEN/PROCESSING/TERMINAL/QUARANTINED` — a spec `READY_TO_COMMIT`, `COMMITTED`, `RECOVERY_REQUIRED` és **`BLOCKED`** állapota nem létezik (`schema.ts:263`). Az A.1 „enélkül a batch `BLOCKED`" mondata így nem ábrázolható: a blokkolt köteg `PROCESSING`-ban ül, ugyanabban az állapotban, mint a normál munkában lévő. |
| A.2 | Claim fencing token | **NINCS a kimenő úton** | `case-engine-core.ts:acquireClaim` helyes atomikus upsert, monoton fence-szel. **De** az egyetlen hívója a `progression-heartbeat.ts:89`. Az `outbound_ledger.claim_fence` oszlop létezik és **soha nem íródik**; `claim_fence_at_creation` nincs; a `SENDING` írás előtt (`executor-core.ts:160`) **nincs semmilyen claim-, run-id- vagy fence-ellenőrzés**. Az A.2 kifejezetten ezt a három ellenőrzést írja elő. → **AC-23 kódban nem teljesül** (a fence-teszt a case-store szintjén zöld, a kimenő úton nincs mit tesztelni). |
| A.3 | Explicit DB UNIQUE constraintek | **3/4** | Megvan: `UNIQUE(internal_idempotency_key)` és `UNIQUE(case_id, action_type, sequence_number)` (`schema.ts:207`), `UNIQUE(gmail_account_id, thread_id, message_id)` + a message-szintű pótindex (`schema.ts:377`), `UNIQUE(claim_key)` (`schema.ts:153`). **Hiányzik:** `UNIQUE(radar_id, offer_idempotency_key)` — mert nincs `shopping_radar_offers` tábla és nincs `offer_idempotency_key` (lásd §16 alább). |
| A.4 | Kampánykvóta **atomikus lefoglalása** | **NEM** | Két külön dolog épült meg, és a rossz van bekötve: (a) `quota.ts:reserveQuota` valódi atomikus check-and-increment — de **egyetlen produkciós hívó sem adja át az `opts.quota`-t** (`grep "quota:" src` a teszteken kívül nulla találat), tehát az `executor-core.ts:150` ága soha nem fut; (b) a **kampány**-kvótát az `approval-core.ts:215` `COUNT(*)`-gal ellenőrzi és nem foglal — klasszikus check-then-act. Két párhuzamos küldés mindkettő „még van hely"-et olvas. A spec A.4 pontosan ezt a `BEGIN … RESERVE … WRITE SENDING … COMMIT` egy-tranzakciós blokkot írja elő; a kódban a jogosítás, a kvóta és a `SENDING` írás **három külön tranzakció**. → **AC-24 nem teljesül.** |
| A.5 | Campaign/approval verziózás + revoke | **RÉSZBEN** | A verzió-kötés helyes (`campaigns.ts:78`, `approval-core.ts:253`), a `resumeCampaign` szándékosan nem lép verziót — ez jó. **De** `revokeCampaign`/`pauseCampaign`/`resumeCampaign` `[ismert]` **hívó nélkül** van: futó kampányt sem API-ról, sem UI-ról nem lehet leállítani. Az A.5 in-flight szabálya („utána KÖTELEZŐ readback, a felület jelzi") sehol nincs implementálva. → **AC-25 nem teljesül.** |
| A.6 | Sensitivity UNKNOWN fail-closed | **IGEN, de a fő úton hatástalanítva** | `sensitivity.ts:coerceSensitivity` helyesen `HIGHLY_SENSITIVE`-re esik ismeretlennél, és csak eszkalál. **De** az egyetlen élő személyes küldő út beégeti a bemeneteit: `routes/cos.ts:1057` `declaredSensitivity: 'PERSONAL'`, `targetProfile: 'premium_reasoning'`. A `premium_reasoning` **minden** szinten engedélyezett, tehát a `dispatch-gate` sensitivity-ága ezen az úton mindig átenged; ráadásul egy `HIGHLY_SENSITIVE`-nek jelölt ügy deklarált szintje elvész (a tartalom-osztályozó eszkalálhat, de csak ha mintát talál). Ez a §10 tiltotta **privacy downgrade**, és a §19 kritikus riasztási listáján is szerepel. Az aszimmetria árulkodó: a ZST-ág ugyanitt (`routes/cos.ts:1031`) az ügy valódi `sensitivity` mezőjét adja át. |

### 1.2 A v4.2.1 P1-kör (B.1–B.6)

| # | Követelmény | Állapot | Megjegyzés |
|---|---|---|---|
| B.1 | Outbound állapotmodell (`APPLIED_UNVERIFIED`) | **IGEN** | `executor-core.ts` a 9 állapotot helyesen kezeli, a P1.1 migráció (`schema.ts:170`) leképezi a régi `APPLIED`/`FAILED` sorokat. Az „újraküldeni TILOS `APPLIED_UNVERIFIED`-ből" invariáns kódban áll (`NON_RESENDABLE_STATUSES`, `executeAction:139`). |
| B.2 | Gmail self-event szűrés | **IGEN** | `gmail-history-guard.ts` + két független védelem az intake-ben (`intake.ts:75` header-marker, `intake.ts:87` saját ledger-visszakeresés). AC-28 fedve. |
| B.3 | Marker-persistence teszt mint **kapu** | **KÖNYVTÁR, NEM KAPU** | `marker-persistence.ts` megvan és tesztelt, de `markerPersistenceGate`/`verifyMarkerPersistence` **produkciós hívó nélkül**. Semmi nem konzultálja küldés előtt. Ráadásul a spec 3. pontja (provider message id egyezés) a `passed` számításból **kimarad** (`marker-persistence.ts:81` — a `refMatches` csak a szövegbe kerül, a döntésbe nem; a detail maga írja ki, hogy „id not compared"). |
| B.4 | Browser adapter minimum-interfész | **KÖNYVTÁR, NEM KAPU** | `browser-adapter.ts:assessBrowserAdapter` — szintén produkciós hívó nélkül. Ma azért nincs baj, mert a shopping/rental adapterek konstrukcióból nem tudnak checkoutolni (`assertNoCheckoutSurface`, ez a rész **jó** és tényleg fut). |
| B.5 | Radar deviza | **RÉSZBEN** | Az FX-oszlopok megvannak és a HIT az átváltott áron dől el (`radar.ts:160`). **De** nincs `shipping`/`tax_duty` mező, tehát a §16 „Final price = ár + szállítás + adó/vám − kedvezmény" képlete nem számolható; a `converted_final_price` az, amit az adapter mond. |
| B.6 | Radar értesítés-dedup | **RÉSZBEN** | `decideNotify` (`radar.ts:113`) jól deduplikál (NEW_HIT/NEW_OFFER/PRICE_DROP, 3% küszöb). **De** csak `hit === true` esetén értesít egyáltalán. A spec négy trigger közül hármat nem ismer: készletváltozás, lényeges garancia/szállítás-változás, korábbi ajánlat lejárta — és a „jelentős áresés" is csak akkor számít, ha közben célár alá is ment. Egy 40%-ot eső, de célár feletti ajánlat néma marad. |

### 1.3 §C — adatbiztonsági + üzemeltetési DoD

**Nem teljesül.** `[ismert, de a spec-oldalról súlyosabb, mint ahogy szerepelt]` A §C hét követelménye közül a kód négyhez ad könyvtárat és **nullához hívót**:

- `store-security.ts:assertStorePermissions` — hívó nélkül → a db/store jogosultság soha nem lett ellenőrizve, nemhogy kikényszerítve.
- `backup.ts:createEncryptedBackup` + `pruneBackups` — hívó nélkül → **titkosított mentés sosem készült**, retention-ablak nincs érvényesítve, „rendszeres restore-teszt" nem létezik.
- `retention.ts:purgeExpiredAttachmentContent` + törölt-case purge — hívó nélkül → érzékeny melléklet-tartalom határidő nélkül él (a `cos_documents` élesben 88 sor).
- Ami **megvan és igaz**: az auditlog append-only trigger szinten (`schema.ts:867`, `DROP+CREATE` szándékosan, jó indoklással), és a melléklet-checksum readback (`attachments.ts:54`).

Ez a §25 rendszer-DoD (10) „van rollback- és üzemeltetési terv" pontját is kinyitja: mentés nélkül nincs rollback.

### 1.4 §23 — a 21 elfogadási kritérium

| AC | Állítás | Ítélet | Indoklás |
|---|---|---|---|
| 1 | Nincs duplaküldés | **RÉSZBEN** | A DB UNIQUE + az állapotgép megvédi az *azonos ledger-soron* belüli duplát. De a kulcs nem a spec kulcsa (lásd F-1): `mv-<case>-<action>-<seq>`, kampány, címzett és renderelt payload nélkül. Két különböző címzettnek szánt, ugyanarra a case-re tervezett akciót csak a `seq` különbözteti meg, amit egy `COUNT(*)+1` ad (`send-flow.ts:90`) — versenyben ütközik. |
| 2 | Timeout-biztos: readback retry előtt | **RÉSZBEN** | Az állapotgép helyes. **De** az élő úton a readback ki van kapcsolva (`embedBodyMarker: false`), tehát minden valódi küldés `APPLIED_UNVERIFIED`-en áll meg, és egy `OUTCOME_UNKNOWN` sor **automatikusan sosem rendezhető** — a readback definíció szerint `available:false`-t ad. |
| 3 | `SENDING` a hívás előtt perzisztál | **IGEN** | `executor-core.ts:160`, majd a hívás. Ez helyes. |
| 4 | Kampány-határ, listán kívülre nincs küldés | **IGEN, a személyes úton** | `approval-core.ts:274` — lista hiánya = tiltás, nem „bárki". `[ismert]` gyengeség: bővebb lista is elfogadható és el is tárolódik. A ZST úton külön, szűkebb ellenőrzés fut (`zst-send.ts:132`). |
| 5 | Rendered payload-kontroll, szabad LLM-szöveg nem megy autonóm SEND-re | **RÉSZBEN** | A `allows_free_text` kapu megvan és fail-closed. **De** `allowed_variable_schema` / `forbidden_variables` csak akkor számít, ha a hívó átad `usedVariables`-t — a `dispatch-gate.ts:88` **nem ad át** `channel`, `outboundKind`, `usedVariables` mezőt `[ismert]`. |
| 6 | Reply-policy stop-conditionök | **NEM** | `tripStopCondition` létezik és az `authorizeSend` olvassa, de semmi nem hívja: nincs beérkező-válasz osztályozó, ami előleg/új adat/foglalás/jogi feltétel esetén elsütné. |
| 7 | Adatminimum (`shareable_data`) | **RÉSZBEN** | A dokumentum-megosztás kapuja jó és valódi (`cos-documents.ts:193`: explicit clearance + sha256 + purge-ellenőrzés). A `shareable_data` és `allowed_attachment_types` boríték-mezők íródnak, de **nincsenek olvasva**. |
| 8 | Végkapu; `autonomous_spend_limit = 0` | **IGEN** | Invariánsként kikényszerítve write-időben (`approval-core.ts:161`), és a létra a `PAYMENT`-et a fokozat olvasása ELŐTT utasítja el (`autonomy-ladder.ts:permits`). Ez a rendszer legerősebb pontja. |
| 9 | Kifli nem duplarendel | **N/A** | Nincs Kifli-integráció (tudott, credential-gated). |
| 10 | `LOCAL_APPLIED` egyszer, label/cursor külön pótolható | **IGEN** | `email_processing` UNIQUE + `ingestTriagedEmail` `ALREADY_PROCESSED` ága. |
| 11 | Cursor csak terminális kötegnél lép | **IGAZ, DE ÜRESEN** | `tryAdvanceCheckpoint` helyes. De a köteg egy levél, a `cursor_after` értéke `"triage-<epoch>"` (`triage-bridge.ts:58`) — nem Gmail history id. A „pozíció" nem olyasmi, amiről bárki folytatni tudná az olvasást. |
| 12 | Cursor-visszaállás nem okoz újra-írást | **IGEN** | UNIQUE-alapú, ez tényleg tart. |
| 13 | Atomikus claim | **IGEN a motorban, NEM a kimenő úton** | Lásd A.2. |
| 14 | Case verziózás / stale-write védelem | **IGEN** | `case-engine-core.ts:257` + `CaseConcurrencyError`. Tiszta munka. |
| 15 | Melléklet: eltérő lista/checksum → küldés leáll | **RÉSZBEN, és egy hibával** | A share-gate dob, ha a checksum nem egyezik — jó. **De** a spec §6.8 `attachments` táblája (`approved_recipient`, `outbound_id`, `verification_status`) nem létezik, nincs draft-visszaolvasás és nincs Sent-visszaolvasás. Ráadásul az élő ajtó `new GmailSendAdapter(transport)`-ot épít **resolver nélkül** (`routes/cos.ts:1054`), tehát egy mellékletet kérő payload a `send()`-ben dob — és az executor ezt `OUTCOME_UNKNOWN`-ra képezi (lásd F-3). |
| 16 | Connector: store/ledger kiesésnél nincs külső action | **RÉSZBEN** | `isUsable` megvan és a kapu hívja. De a §12 státuszkészletből hiányzik az `AUTH_EXPIRED` és a `TIMEOUT` — a `connector_health.status` csak `OK/DEGRADED/DOWN/UNKNOWN`, tehát a „auth-hiba → egy tömör értesítés" szabály nem megkülönböztethető. |
| 17 | ZST/céges tartalom nem kerül a personal store-ba | **RÉSZBEN** | A Scope Gate megépült és jó minőségű (`scope-gate.ts`), az intake-route hívja. **De** (a) csak a HTTP-ajtóban van bekötve — a `ingestTriagedEmail` maga kapu nélkül exportált, egy második hívó újranyitja a 2026-08-09-i hibát; (b) a verdikt **nem kerül a `personal_cases.scope` oszlopba** — az egyetlen író egy boot-migráció (`schema.ts:434`). Minden intake-ből született ügy `PERSONAL_CONFIRMED`, akkor is, ha a gate `AMBIGUOUS`-t vagy `PERSONAL_PROBABLE`-t mondott; a bizonytalanság a `blocked_reason` mezőbe megy (`routes/cos.ts:116`), ami egy másik célra való oszlop, és felülírja az esetleges valódi blokkolási okot. A §25 DoD (11) „a Scope Gate technikailag bizonyított" a tárolóból nem bizonyítható. |
| 18 | Data-sensitivity: szenzitív ügy csak engedélyezett profilon | **HATÁSTALANÍTVA a fő úton** | Lásd A.6. |
| 19 | Nincs kitalált tény; bizonytalan = `UNVERIFIED` | **RÉSZBEN** | A `MIGRATED_UNVERIFIED` jelölés megvan a Drive-importra. A haladás-motor DoD-kapuja (`progression-completion.ts:445`) most már valódi bizonyítékot követel (`met_by_evidence`), és a generikus státusz-sablonra nem enged zárni — ez a mai javítás **erős és helyes**. |
| 20 | Restart-folytonos; PAUSE/REVOKE működik | **NEM** | A restart-folytonosság a store-ból adódik, de a PAUSE/REVOKE hívó nélkül van (A.5). |
| 21 | Audit: minden kimenő visszavezethető approvalhoz, kampányhoz, case+version-höz, run-hoz, forráshoz | **NEM** | Az `outbound_ledger` személyes ágán **nincs** `rendered_payload_hash` oszlop (a §6.2 kéri), az `approval_version`, `campaign_version`, `rendered_variables_hash`, `provider_message_id`, `rfc_message_id` oszlopok léteznek és **soha nem íródnak** (`grep`: a ZST-ág írja a `campaign_version`-t, a személyes nem). Case-verzió és run-id nincs a soron. A visszavezetés ma a `payload` JSON újrahash-eléséből rekonstruálható, nem a ledgerből olvasható. |

### 1.5 §16 — vásárlási radar

A megépült radar **nem a spec radarja**, hanem egy lényegesen egyszerűbb ár-figyelő:

| Spec | Kód |
|---|---|
| `shopping_radar_items` ~35 mező (követelmény-szöveg, méret/modell, garancia-elvárás, elfogadható kereskedők, ország, HU-szállítás, csomagautomata, max szállítási nap, min. értékelés, adó/vám, állapot, halasztás, visszaküldési határidő, vásárlási adatok, `best_offer_id`, `linked_purchase_case_id`) | `radar_items` 13 mező + 4 dedup-mező (`schema.ts:518`) |
| `shopping_radar_offers` (ajánlatonként egy sor, `offer_idempotency_key`, merchant, shipping, tax_duty, final_price, stock, warranty, `meets_requirements`, `score`, `rejection_reason`) | **nincs ilyen tábla** — `radar_observations` ellenőrzésenként egy sor, benne a *legjobb* ajánlat JSON-blobként |
| `shopping_radar_checks`, `shopping_radar_status_events` | **nincsenek** |
| Státuszok `AKTIV_KERESES / ELHALASZTVA / MEGVASAROLVA / LEZARVA` | `ACTIVE / PAUSED / HIT / CLOSED` — a `MEGVASAROLVA` és a hozzá tartozó vásárlás-utókövetés (számla, garancia-vég, visszaküldési határidő) hiányzik |
| Szűrés: kereskedői kör + ország + HU-szállítás + garancia + méret/modell + min. értékelés + állapot | **nincs implementálva**, és nincs hol tárolni a döntést (`rejection_reason`) |

Ez nem korrektségi hiba (a Slice 4 nyitva van), de a lezárt auditokban „radar BUILT"-ként szerepel, ami félrevezető. A helyes megfogalmazás: **a radar egy működő ár-figyelő magja, a §16 adat- és szűrésmodellje nélkül.** Ehhez tartozik az A.3 negyedik UNIQUE constraint hiánya is.

### 1.6 A haladás-réteg (progression plan v1.1)

- **GATE 0–2 megvan** és a mai javítások után komoly: replay-harness (`scripts/cos-dryrun-progression.ts`), run-ledger, DoD-provenance, stagnáció-számláló valódi olvasóval.
- **A DoD-kapu most már helyes**: `GENERIC_STATUS_TEMPLATE`-re a motor nem zárhat, bizonyíték-hivatkozás nélküli pipa nem számít teljesítettnek (`progression-completion.ts:409`). Ez zárta le a 45 ügyet érintő tömeges lezárást — jó munka.
- **`[ismert]` a biztonsági telemetria konstans** (`progression-eval.ts`): hét állítás, 7223 futás, egy különböző érték. Spec-oldalról ez a plan §15 „Eval / Replay Harness – P0" pontját üresíti ki: a harness fut, de nem mér.
- **`completionActor` alapból nyitott** `[ismert]` — spec-oldalról a §23 „Semantic Completion" kapuja bármely nem-`progression-engine` aktor előtt kinyílik. Ma három hívó van és mind a motor, de a helyes forma a fordított allowlist.
- **Az `evaluateDoDCompleteness` aszimmetriája** (új): hiányzó `dod_verification_json` → `allMet: false`, de **parse-olható, üres kritériumlista → `allMet: true`** (`progression-completion.ts:395`). A `canCompleteCase` ezt elkapja (`totalCriteria === 0` → tilt), de a függvény exportált, és a következő hívó a csapdába lép.

### 1.7 A Mission Control akciógomb-spec

- A „gomb eseményt ír, nem állapotot" alapelv **betartva** (`routes/cos.ts:636`), és az azonnali egy-ciklus visszajelzés is megvan. Jó.
- **Eltérés a §6.2-től**: a spec `case_version` alapú 409-et kér; a kód tartalom-alapú frissesség-ellenőrzést csinál (`decision` + `next_best_action`), és a `caseVersion`-t **nem validálja** — csak beírja az append-only naplóba. Az indoklás a kódban meggyőző (minden heartbeat új run-id-t ír), de a mellékhatás az, hogy egy **kliens által küldött, ellenőrizetlen `case_version`** kerül a megváltoztathatatlan naplóba. Ha az eltérés szándékos, a spec §6.2-t kellene módosítani, nem csendben mást csinálni.
- **Idempotencia-verseny** (kicsi): a kulcs-ellenőrzés (`routes/cos.ts:578`) és a beszúrás nem egy tranzakcióban van; két egyidejű koppintás két eseményt ír. A spec ezt kifejezetten „alapesetnek" nevezi.

---

## 2. Találások súlyosság szerint

### F-1 · P0 · Az idempotencia-kulcs nem a spec kulcsa

`src/cos/executor-core.ts:54`

```ts
export function idempotencyKey(caseId, actionType, sequenceNumber) {
  return `mv-${caseId}-${actionType}-${sequenceNumber}`
}
```

A §7.1 ezt írja elő: `sha256(campaign_id + recipient + action_type + sequence_number + rendered_payload_hash)`.

**Következmény.** A kulcs nem köti sem a kampányt, sem a címzettet, sem a tartalmat. Amit a UNIQUE constraint véd, az „ugyanaz a case + művelettípus + sorszám", nem „ugyanaz a levél ugyanannak". A `seq` egy `COUNT(*)+1` (`send-flow.ts:90`), ami két párhuzamos piszkozatnál ütközik (a DB elkapja, de kezeletlen `SqliteError`-ként dobja fel a hívónak). Fordítva: ha a payload jóváhagyás után módosul és a sor újratervezésre kerül ugyanazzal a `seq`-kel, a kulcs változatlan marad — a rendszer azt hiszi, ugyanaz az akció.

**Javaslat.** A kulcs számítása a spec képlete szerint, és a `rendered_payload_hash` felvétele a ledgerbe (ez az F-2-t is megoldja). A `seq` ne `COUNT(*)` legyen, hanem a UNIQUE-ra támaszkodó, ütközésre újrapróbáló allokáció.

### F-2 · P0 · A ledger nem hordozza az auditnyomot (AC-21)

`src/cos/schema.ts:190` (tábla) és `:409` (`ensureColumns`)

- `rendered_payload_hash` — **nincs oszlop** (a §6.2 kéri).
- `campaign_version`, `approval_version`, `rendered_variables_hash`, `provider_message_id`, `rfc_message_id` — oszlop van, **író nincs** a személyes ágon.
- Case-verzió és `run_id` a soron nincs.

**Következmény.** „Minden kimenő action visszavezethető approvalhoz (template+rendered), kampányhoz, case+version-höz, run-hoz, forráshoz" — ez az AC-21, és ma nem ellenőrizhető lekérdezéssel. A `provider_message_id`/`rfc_message_id` `[ismert]` ráadásul csapda a következő fejlesztőnek: úgy néz ki, mintha a szülő-azonosító el lenne mentve.

### F-3 · P0 · Helyi hiba `OUTCOME_UNKNOWN`-t ír — a sor véglegesen megmérgeződik

`src/cos/adapters/gmail-send.ts:73,79` + `src/cos/executor-core.ts:166`

A `GmailSendAdapter.send()` sima `Error`-t dob három olyan esetben, ami **bizonyítottan nem érte el a szolgáltatót**:

1. hiányzó `to`/`subject` a payloadban;
2. melléklet kérve, de nincs bedrótozva share-gated resolver — és az élő ajtó pontosan így példányosít (`routes/cos.ts:1054`, resolver nélkül);
3. a resolver dob (nem megosztható dokumentum).

Az executor a `reachedProvider` hint hiányában az `else` ágra esik → **`OUTCOME_UNKNOWN`**. A §7.3 szerint ez az az állapot, amiből vakon küldeni tilos; a reconcile innentől minden ciklusban readbacket próbál, ami az élő transzporton `embedBodyMarker: false` miatt mindig `available:false` — tehát **a sor sosem rendeződik**, örökké a munkasorban marad, és a `RECOVERY_REQUIRED` riasztásba sem kerül bele (mert nem az az állapota).

**Javaslat.** Az adapter dobja `SendError`-t `{ reachedProvider: false, terminal: true }` hintekkel minden pre-flight validációs hibára; az executor pedig alapértelmezésben csak akkor menjen `OUTCOME_UNKNOWN`-ba, ha a hívás valóban elindult (pl. a hálózati hívást külön try-blokkba zárva).

### F-4 · P0 · A claim-fence nincs a kimenő úton (A.2)

`src/cos/executor-core.ts:161` — a `SENDING` írás előtt nincs claim-, `owner_run_id`- és fence-ellenőrzés; az `outbound_ledger.claim_fence` soha nem íródik; `claim_fence_at_creation` nincs sehol.

**Következmény.** Egy lelassult, lejárt claimű futás késői küldése ma nincs kizárva. A specifikáció ezt nevezte meg P0.2-ként, és az AC-23 ezt kéri számon. A kódban lévő fence-tesztek a case-store szintjét fedik, ahol viszont a fence **nem véd kimenő műveletet**.

### F-5 · P0 · A kvóta-foglalás halott, a kampánykvóta versenyezhető (A.4)

- `executor-core.ts:150` a `reserveQuota`-t csak `opts.quota` esetén hívja — **egyetlen produkciós hívó sem adja át** (`dispatchApproved`, `dispatchApprovedSend`, `cosTick`, `dispatchZstSend`: mind alapértelmezett `{}`-t adnak).
- `approval-core.ts:215` a kampánykvótát `COUNT(*)`-gal ellenőrzi, foglalás nélkül.
- `releaseQuota` `[ismert]` hívó nélkül — így ha a foglalás mégis bekapcsolna, egy bizonyítottan meg nem történt küldés foglalása bent ragadna, és **minden retry újra foglalna** (a `PLANNED → SENDING` út újrafut).

### F-6 · P1 · A sensitivity-kapu az élő személyes küldő úton hatástalan

`src/web/routes/cos.ts:1057` — `declaredSensitivity: 'PERSONAL'`, `targetProfile: 'premium_reasoning'` beégetve. A ZST-ág ugyanott az ügy valódi értékét adja át — az aszimmetria mutatja, hogy ez elmaradás, nem döntés. Egy sor javítás: olvasd a `personal_cases.sensitivity`-t (az `approveOutbound` már joinolja a `personal_cases`-t, csak a `sensitivity` oszlopot nem hozza el).

### F-7 · P1 · A `tick.ts` megkerüli a dispatch-kaput `[ismert, spec-oldali kiegészítéssel]`

`src/cos/tick.ts:58` közvetlenül `executeAction`-t hív a `reconcileOutbound` **minden** sorára — és az `PLANNED` sorokat is visszaad (`scheduler.ts:76`). Vagyis a tick nem csak „recovery"-t futtat: **jóvá nem hagyott, tervezett küldést is elküldene**, ha kapna adaptert. A védelem ma egyetlen hiányzó adapter (`runtime.ts:39`).

Spec-oldalról ez a §7.3 első sorát sérti („CHECK approval hash + template_version + rendered_payload validáció + scope + budget + kvóta" **minden** végrehajtás előtt). A javítás nem UI-kérdés: az `executeAction`-nek magának kellene megkövetelnie egy már ellenőrzött döntést (pl. jogosítás-token paraméterként), vagy a reconcile-nak csak a nem-`PLANNED` állapotokat szabadna hajtania.

### F-8 · P1 · A source-commit policy-kivétel hazudik az állapottal

`src/cos/source-commit.ts:132` — ha `allowCursorAdvanceWithoutSourceWrite`, a kód `SOURCE_COMMITTED`-re állítja azokat az üzeneteket, amiket **nem jelölt meg a forrásnál**, és csak a `last_error`-ba írja az okot.

Az A.1 öt feltételéből ezen az ágon kettő nincs teljesítve: **nincs kritikus riasztás** és **nincs kézi review-feladat** (ezek csak a karantén-ágra vannak bedrótozva a `scripts/cos-close-batches.ts`-ben). Az állapotnév maga is félrevezető: a `SOURCE_COMMITTED` a §6.3 szerint a terminális *siker*, itt viszont „nem tudtuk megjelölni, de továbbengedtük". Egy külön terminális állapot (vagy a `QUARANTINED` használata a megfelelő okkal) őszintébb, és nem rontja el a későbbi lekérdezéseket.

### F-9 · P1 · A ZST küldő út saját, szűkebb kaput használ

`src/cos/zst-send.ts:132` (`authorizeZstSend`) és `:174` (`evaluateZstSendGate`)

Az `approval-core.ts` fejléce szó szerint azért íródott, hogy a két névtér ne driftelhessen — és a ZST küldő út **nem hívja** (`zstApprovals.authorizeSend` létezik, használatlan). Amit a ZST-ág emiatt kihagy: lejárati idő (`valid_until`), stop-condition, csatorna-ellenőrzés, változó-ellenőrzés, per-típus és össz-kvóta, **és az autonómia-létra** (`permits`) — utóbbi a személyes kapuban benne van (`dispatch-gate.ts:75`), a ZST-ben nincs.

### F-10 · P1 · A marker-persistence és a browser-adapter kapu nincs bekötve; a marker-teszt 3. pontja nem gátol

`src/cos/marker-persistence.ts:81` és `:90`, `src/cos/browser-adapter.ts:58`

Egyik függvényt sem hívja produkciós kód. A B.3 kijelentése („**Ha a marker nem bizonyítható, a Gmail `EXECUTE` mód NEM aktiválható**") ma nem gépi szabály, hanem a `connector_health.mode` kézi állításán múlik. Emellett a `passed` nem tartalmazza a `refMatches`-t, tehát a spec 3. pontja (provider message id egyezés) jelentés, nem kapu.

### F-11 · P1 · A readback alapértelmezett várakozása 0 ms, az indexelési késés ~2 s

`src/cos/adapters/gmail-api-transport.ts:153` (`readbackWaitMs ?? 0`) és `:212`

Ha valaki bekapcsolt `embedBodyMarker` mellett használja a transzportot (ez az alapértelmezés) és nem ad `readbackWaitMs`-t, az első keresés azonnal lefut, a `deadline` már lejárt, és a függvény `{ found:false, available:true }`-t ad — amit a `verifyAction` **`RECOVERY_REQUIRED`-nek** minősít („a szolgáltató sikert jelentett, de a jel bizonyítottan hiányzik"). Egy tökéletesen sikeres küldés így emberi beavatkozást igénylő állapotba kerül. A modul saját kommentje mondja ki, hogy az indexelés ~2 s.

### F-12 · P1 · Az élő küldő úton a readback definíció szerint lehetetlen

`src/web/routes/cos.ts:1053` (`embedBodyMarker: false`)

A döntés indoklása jó (a tulajdonos a szöveget betű szerint hagyta jóvá). A következményét viszont ki kell mondani: a személyes és a ZST küldés **soha nem érheti el a `VERIFIED` állapotot**, és egy `SENDING`/`OUTCOME_UNKNOWN` sor **automatikusan sosem rendezhető** — a §7.3 recovery-ága ezen az úton nem működik, az AC-2 nem bizonyítható. Ez elfogadható tervezési kompromisszum lehet, de akkor a spec §7.2-t vagy a napi reconcile-t kell kiegészíteni egy alternatív bizonyítékkal (pl. a visszakapott `provider_message_id` `messages.get` ellenőrzése — amihez a `provider_message_id` oszlopot **el is kellene menteni**, lásd F-2).

### F-13 · P2 · A Scope Gate verdiktje nem kerül a `scope` oszlopba

`src/web/routes/cos.ts:115` — a bizonytalanság a `blocked_reason`-be megy, a `scope` marad `PERSONAL_CONFIRMED`.

Két baj: az audit-nyom hamis (minden ügy „megerősített személyes"), és a `blocked_reason` felülírja azt, amit a §6.1 szerint tárolni kellene benne. Egy `scope` írás + egy külön `scope_review_reason` oszlop (vagy egy esemény) mindkettőt megoldja.

### F-14 · P2 · A batch-státuszkészlet nem tudja ábrázolni a `BLOCKED`-et

`src/cos/schema.ts:263` — `CHECK (status IN ('OPEN','PROCESSING','TERMINAL','QUARANTINED'))`. Az A.1 által előírt `READY_TO_COMMIT`, `COMMITTED`, `RECOVERY_REQUIRED`, `BLOCKED` hiányzik. Egy örökre blokkolt köteg ma megkülönböztethetetlen egy éppen dolgozó kötegtől.

### F-15 · P2 · Nincs `FAILED_RETRYABLE` visszafogás

`src/cos/scheduler.ts:78` + `executor-core.ts:141` — a `FAILED_RETRYABLE` sorok minden tickben újra próbálkoznak, az `attempt` nő, de **semmi nem olvassa**: nincs maximum, nincs exponenciális várakozás, nincs `FAILED_TERMINAL`-ra léptetés. Egy tartósan hibás címzett örökké őrli a sort (és — ha az F-5 kvóta valaha bekapcsol — a kvótát is).

### F-16 · P2 · A jóváhagyás soha nem jár le

`src/cos/send-flow.ts:127` (`approveSend`) — a boríték csak `allowedChannels` és `allowedRecipients` mezőt kap; `validUntil`, `maxTotalOutbound`, `stopConditions` sosem íródik. Az `authorizeSend` lejárat-ellenőrzése (`approval-core.ts:268`) ezért mindig átenged. A §3.2 `valid_until` mezője gyakorlatilag nem létezik.

### F-17 · P2 · A `personal-case-wake` §8-lánc prompt-vezérelt

`ops/scheduled-tasks/personal-case-wake/SKILL.md` — a köteg-lezárás, a szál-letöltés és az utánkövetés-fogalmazás egy **LLM-heartbeat promptban** felsorolt `npx tsx` parancsokként él, 10 percenként. A §21 zárómondata: „Nincs prompt-only »kész«". Egy determinisztikus runner (egy szkript, ami mindhármat sorban futtatja) ugyanennyi munka és nem függ attól, hogy a modell végigolvassa-e a skillt.

### F-18 · P3 · Higiénia

- `_qq_insert_tmp.js` a repó gyökerében: beégetett `/home/iszzu/...` útvonal, `require()` egy `"type": "module"` projektben, egy kanban-kommentet szúr be. Törlendő.
- `src/cos/schema.ts` 1461 sor, és minden bootkor futtat tábla-újraépítéseket (`RENAME` + `CREATE` + `INSERT OR IGNORE` + `DROP`) és egy adat-migrációt (`UPDATE personal_cases SET scope=…`). Az `INSERT OR IGNORE` a `email_processing` újraépítésénél **csendben eldobhat** sorokat, ha az új kulcs ütközik. A migrációk kiemelése egy verziózott, egyszer futó lépéssorba (`migrations/`, ami a kernel-repóban már létezik mintaként) csökkentené a boot-kockázatot — a repó saját története mutatja, hogy egy hibás séma-definíció már okozott dashboard boot-loopot.
- 3 piros teszt a `costops-api.test.ts`-ben (budget CRUD/history). Nem COS, de a „minden zöld" állítást ma nem lehet kimondani.

---

## 3. Amit jónak találtam

Nem minden lett piros, és ez is információ:

- **Case engine** (`case-engine-core.ts`): az optimista verziózás, az append-only napló DB-trigger szintű kikényszerítése, és a claim atomikus feltételes upsertje (nem SELECT-majd-UPDATE) tankönyvi. A `CaseConcurrencyError` nem nyeli el a versenyt.
- **Outbound állapotgép** (`executor-core.ts`): a `SENDING` a hívás előtt, az `APPLIED_UNVERIFIED`-ből tiltott újraküldés, a „bizonyítottan hiányzik → `PLANNED`, bizonytalan → marad" megkülönböztetés — pontosan az, amit a B.1 kér.
- **Sensitivity-osztályozó** (`sensitivity.ts`): csak eszkalál, ismeretlen bemenetre a legszűkebb halmazra esik, és a fleet-gate mintaillesztő motorját újrahasználja ahelyett, hogy forkolná.
- **Autonómia-létra** (`autonomy-ladder.ts`): a `PAYMENT` és a jóváhagyáson túli adatmegosztás a fokozat **olvasása előtt** kerül elutasításra — ez a helyes sorrend, és ettől nem lehet egy rosszul beállított fokozattal kinyitni.
- **Dokumentum-megosztás kapuja** (`cos-documents.ts:193`): explicit clearance, sha256 újraszámolás, purge- és lemez-ellenőrzés, és minden hiba **dobás**, nem visszatérési érték.
- **A mai DoD-kapu javítás** (`progression-completion.ts`): a bizonyíték-hivatkozás követelése és a generikus sablon kizárása a motor elől valódi, mérhető javulás — és a `scripts/cos-dryrun-progression.ts` (az élő store másolatán futó száraz futás) a repó legjobb minőségű verifikációs eszköze.
- **`output-floor.ts`**: „nulla nem csend, hanem riasztás" — ez a hiányzó monitoring-osztály, és jól van megfogalmazva.
- **A kommentek nagy része** valódi tervezési döntést és annak árát rögzíti, nem a kódot ismétli. Ez ritka és értékes; a hibás kommentek (`[ismert]` P2 szakasz a mai auditban) épp azért feltűnőek, mert a többi igaz.

---

## 4. Javasolt sorrend

**Most (a korrektségi rés bezárása, nem új funkció):**

1. **F-3** — az adapter pre-flight hibái `SendError{reachedProvider:false, terminal:true}`-ként. Egy sor, és megszünteti a mérgezett sorokat. Egyben drótozd be a share-gated resolvert a `routes/cos.ts:1054`-ben.
2. **F-6** — az ügy valódi `sensitivity`-je a küldő kapuba. Egy sor, és megszünteti a §10 privacy-downgradet.
3. **F-7** — a reconcile ne hajtson `PLANNED` sort, vagy az `executeAction` követeljen bizonyított jogosítást. Ez az egyetlen dolog, ami ma egy adapter bedrótozásától élessé válna.
4. **F-1 + F-2** — a spec kulcsképlete és a ledger audit-oszlopainak feltöltése. Ez a kettő együtt teszi az AC-1-et és az AC-21-et ellenőrizhetővé.

**Rövid távon:**

5. **F-4, F-5** — a claim-fence és a kvóta-foglalás bekötése a `SENDING` írás elé, egy tranzakcióban (A.2 + A.4 együtt egy javítás).
6. **F-8, F-14** — a köteg-állapotok kiegészítése és a policy-kivétel őszinte állapotneve.
7. **F-9** — a ZST küldő út a közös `approval-core`-ra és a létrára.
8. **F-16, F-15** — lejárati idő és kvóta a jóváhagyásra; retry-plafon.

**Középtávon (a spec-állítások és a valóság összehangolása):**

9. §C bekötése (backup + retention + store-permission egy ütemezett feladatba) — vagy a §C leminősítése a specben, de a jelenlegi „kész" állítás nem tartható.
10. **F-10** — a marker- és a browser-kapu tényleges bekötése, vagy a B.3/B.4 átfogalmazása „kézi ellenőrzési eljárássá".
11. **F-17** — determinisztikus runner a §8-lánc lezárására.
12. A §16 radar-modell kiegészítése **vagy** a lezárt auditok szövegének javítása „ár-figyelő mag, a §16 adatmodellje nélkül"-re.

---

## 5. Módszertani megjegyzés

A repóban három lezáró audit állítja, hogy „a teljes korrektségi felület megvalósítva, tesztelve, élesben fut" és „nincs korrektségi hiány" (`docs/cos-p1-p2-closure-audit-2026-08-06.md`, `docs/cos-spec-implementation-verification-2026-08-06.md`). A második már hordoz egy 2026-08-09-i visszavonást, és a mai hajnali audit további hat állítást döntött meg. A jelen review ehhez még nyolcat tesz hozzá.

A közös minta mindegyikben ugyanaz: **a modul létezésének bizonyítéka (fájl + teszt) „bekötve"-ként lett elkönyvelve.** Egy olcsó, gépi ellenőrzés a legtöbbet kifogta volna: *minden exportált COS-függvényre egy hívó-számláló, a teszteken kívül*. Aminél nulla, az nem kész, hanem könyvtár. Javaslom ezt a repó CI-jébe tenni — nem lintként, hanem egy riportként, amit a következő „kész" állítás mellé kell tenni.

*Marveen-review, 2026-08-10 — a spec a mérce, a hívó-lista az igazság.*
