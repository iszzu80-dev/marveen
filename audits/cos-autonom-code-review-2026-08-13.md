# CoS (privát + céges) és autonómia — teljes code review, 2026-08-13

**Kinek szól:** Istvannak. **Mit fed le:** a `src/cos/` teljes modulkészlete (privát és ZST/céges ág),
az autonómia-réteg (`autonomy-ladder`, `progression-*`, tulajdonosi kérdés/válasz-út), és a hozzájuk
tartozó web route-ok (`src/web/routes/cos.ts`, `approvals.ts`, `autonomy.ts`). A másik két repóban
(`marveen-apg-kernel`, `marveen-suite`) nincs CoS/autonóm kód — ellenőrizve.

**Módszer:** négy párhuzamos, egymástól független mélyolvasás (core engine; privát domain; ZST céges
modulok; autonómia), minden találat a tényleges hívási út visszakövetésével igazolva — a két
legsúlyosabb ZST-találat élő teszttel is lefuttatva. Ezen felül: teljes tesztfuttatás és
típusellenőrzés. A 2026-08-11-i válasz-út postmortemben már kártyázott négy ismert hiányosságot
(`4c6695d9`, `6192068e`, `0d2121a9`, `eaddbad7`) nem soroljuk újra találatként.

**Gépi ellenőrzés eredménye:** `tsc --noEmit` hibátlan. Vitest: **5889 zöld, 4 bukó** — mind a négy
környezetfüggő vagy a postmortemben már ismertként jelzett (két „nem írható könyvtár"-szimuláció,
ami rootként futtatva nem tud nem-írhatót előállítani; az installer ERR-trap; a scheduler-retry).
CoS/autonómia funkcionális teszt nem bukik.

---

## Vezetői összefoglaló

A rendszer architektúrája a méretéhez képest szokatlanul átgondolt: a kimenő út gerince
(jóváhagyási boríték → dispatch-kapu → WeakSet-tel vert permit → egyszer használatos ticket →
kontextus-hash újraellenőrzés fogyasztáskor → vészleállító két ponton) **valóban fail-closed, és a
kompozíció tartja magát** — első kézbesítés csak a kapun át érhető el, a reconcile-hurok
strukturálisan nem tud küldést kezdeményezni, a runtime nem köt be kimenő adaptert. Az
érzékenységi/egress-kapu az olvasási úton szintén valódi (pontosan azt osztályozza, amit elküld,
ismeretlen szint → HIGHLY_SENSITIVE, ismeretlen szolgáltató → THIRD_PARTY).

A gyengeségek négy, jól körülhatárolható gócban ülnek:

1. **A tulajdonosi válasz-hurok alulmodellezált** (a review legsúlyosabb területe): a válasz-esemény
   jelentése és élettartama nincs modellezve — bármilyen nem-„NEM" válasz jóváhagyásnak számít, egy
   régi IGEN visszajátszható egy későbbi, más tartalmú jóváhagyási kérésre, és a többopciós
   válaszszókincs („Lemondjuk", „Várjunk még") a fogyasztónál „mehet"-re esik össze.
2. **A ZST (céges) ág lemaradt a privát ág javításai mögött**: az F-1/F-2/F-4/F-16/N-2 javítások és a
   2026-08-10-i saját-küldés-szűrés csak a privát oldalon landoltak. Ráadásul az egyetlen éles céges
   küldőajtó jelenleg vagy működésképtelen (UNKNOWN case-típus → PREPARE fokozat), vagy egy veszélyes
   közös-létra workaroundon fut.
3. **Konkurencia a kimenő állapotgépben**: a SENDING-recovery nem ismeri az „úton van" fogalmát, és a
   per-sor claim a determinisztikus alap-runId miatt pont azt az egy versenyt nem szerializálja,
   amire épült.
4. **Fél-megépített, alvó alrendszerek**, amelyeket auditok teljesítettnek számolhatnak: a
   send-kvóta rétegnek nincs éles hívója, a Gmail history-guard halott kód, a fokozat-létra
   előléptetési gépezetének nincs éles írója, és a progression 7 „kemény biztonsági állítása"
   szerkezetileg nem tud elsülni, miközben minden futás azt naplózza, hogy kiértékelte őket.

**Fontos keret:** a HIGH találatok többsége MA nem éles kockázat, mert a konfiguráció inert (gmail
READ_ONLY, a tick-hurok nem kap kimenő adaptert, a progression shadow/internal módban jár). De pont
azok az utak érintettek, amelyek a write-consent, illetve a `progression_mode='live'` napján
élesednek. A javítási sorrendet ez diktálja — lásd az utolsó szakaszt.

---

## KRITIKUS

### C1 — A céges küldőajtó UNKNOWN case-típussal kéri a fokozatot → vagy halott, vagy közös-létra workaroundon fut
`src/web/routes/cos.ts:1113-1118` + `src/cos/zst-send.ts:209` — *bug/safety*

A `DispatchZstSendInput.caseType` mezőt a dokumentáció szerint „a hívó olvassa a store-ból", de az
egyetlen éles hívó (`approveAndDispatchZst`) soha nem olvassa és nem adja át — a SQL-je csak a
`sensitivity`-t joinolja. Az `evaluateZstSendGate` így `permits(db, 'UNKNOWN', 'SEND')`-et futtat;
az ismeretlen típus alapból PREPARE fokozat, ami nem küldhet. Élő teszttel igazolva: a case valódi
típusának (`CONTRACT`) EXECUTE_WITH_APPROVAL-ra emelése után az ajtó továbbra is elutasít
(„UNKNOWN fokozata PREPARE"). Két lehetőség: (a) minden céges küldés halott az F-9 fokozat-check
(2026-08-10) óta, vagy (b) élesben az `'UNKNOWN'` literál fokozatát emelték meg a **közös**
`cos_autonomy_ladder` táblában — ami a privát úton is (`approveOutbound`, cos.ts:981 szintén
`'UNKNOWN'`-ra esik vissza) minden ismeretlen típusú küldést felold. A tesztkészlet ezt elfedi: a
`cos-zst-outbound-door.test.ts` **egyetlen esete sem állítja, hogy `sent === true`** — minden ajtóteszt
elutasítást tesztel.

**Javítás:** az `approveAndDispatchZst` meglévő joinjába a `c.case_type` beolvasása és átadása —
vagy jobb: a `dispatchZstSend` olvassa a ledger-sorból, ahogy a privát `dispatchApprovedSend` teszi
(`caseTypeOf`). Plusz egy ajtóteszt, ami sikeres küldést állít.

---

## MAGAS

### Autonómia — a tulajdonosi válasz-hurok (egy gyökérhiba, három arca)

**A1 — Bármilyen nem-„NEM" válasz jóváhagyásnak számít AWAITING_APPROVAL-ban.**
`src/cos/progression-pipeline.ts:844-867` + `355-427` — *safety.* A fogyasztási elágazás:
`if (OWNER_DECISION && choice==='NO') → BLOCKED; else if (status==='AWAITING_APPROVAL') → READY
("Owner approved")`. Az else-if **nem nézi sem az esemény típusát, sem a choice-ot**. Egy
`OWNER_INFORMATION` (szabad szöveg), egy `OWNER_CONFIRMATION`, egy null-choice-os OWNER_DECISION
(a JSON.parse-hiba lenyelve null-t ad) — mind jóváhagyás. A Telegram-úton konkrét: a
`recordOwnerAnswer` a YES/NO regexre nem illő szöveget OWNER_INFORMATION-nek osztályozza, tehát
„A vízdíjról: holnap utánanézek" válasz READY-be viszi a jóváhagyásra váró ügyet. A YES-regex maga
is túlillik (a „Jó kérdés, még gondolkodom" = IGEN). A tesztek csak a YES/NO OWNER_DECISION-t fedik.
**Javítás:** az AWAITING_APPROVAL-ág követelje meg az `eventType==='OWNER_DECISION' && choice==='YES'`
feltételt; minden más rögzüljön információként, átmenet nélkül.

**A2 — A válasz sosem fogy el: régi jóváhagyás visszajátszik egy későbbi kérésre.**
`src/cos/progression-pipeline.ts:355-427` — *safety.* A `consumeOwnerAnswer` a legutolsó OWNER_*
eseményt a kérdés tartalma `(decision, nbaStep)` szerint párosítja — időkorlát, elfogyasztás-jelölő
és lejárat nélkül. Ha egy ügy hónapokkal később **másik** jóváhagyási kéréssel újra AWAITING_APPROVAL-ba
kerül és a kérdező futás ugyanarra a `(REQUEST_APPROVAL, nbaStep)` párra stabilizálódik, az egy évvel
korábbi IGEN újra elfogy — az új kérést a tulajdonos sosem látta. A terv-körbefordulás
(`completed_plan_step` nullázása, pipeline:1054) miatt a `(decision, nbaStep)` párok visszatérése
design szerint garantált. **Javítás:** a válasz-esemény legyen egyszer fogyasztható (consumed
run-id tárolása), vagy a párosítás legyen időben korlátos (csak a kérdező állapotba lépés utáni
események).

**A3 — A többutas válaszszókincs fogyasztó nélkül: minden nem-NEM „mehet".**
`src/cos/progression-pipeline.ts:821, 869-876` vs `src/cos/answer-options.ts` — *bug.* Az
`answer-options.ts` valódi alternatívákat épít (`DROP`, `CANCEL`, `KEEP_WAITING`, `POSTPONE`,
`REPAIR`, `REPLACE`, …), a Mission Control ezeket `choice`-ként be is küldi — de greppel igazolva
**semmi nem olvassa** ezeket az értékeket a modulon kívül. A pipeline csak `choice==='NO'`-t néz;
a „Lemondjuk" ugyanúgy lépteti a tervet, mint az „Igen, mehet". **Javítás:** a szókincs leképezése
a `consumeOwnerAnswer`-ben (minimum: DROP/CANCEL/KEEP_WAITING ne léptessen), vagy a choice tárolása
a case-en a tervező számára.

### A4 — Az önjóváhagyás-őr önbevallásos identitáson áll
`src/web/routes/approvals.ts:158-168` — *safety.* A `PATCH /api/approvals/:id` a `resolved_by`-t a
request bodyból veszi; az egyetlen őr a `resolved_by === target.agent_id` összevetés. A közös bearer
tokennel bármely flotta-agens jóváhagyja a saját kérését, ha `resolved_by: "istvan"`-t ír. Ugyanez a
kódbázis a hard-gated eszkalációnál már megoldotta ezt a formát (cos.ts:1018: a lépés eltávolítása a
bemondott szereplő elhitelezése helyett). **Javítás:** az érzékeny kategóriák feloldása kötődjön
autentikált principálhoz (device-kulcsok léteznek az `auth-gate`-ben), vagy menjen a csak-tulajdonosi
csatornán.

### A5 — A letiltott-progresszió ág az ENGINE számára is „szabad az út"
`src/cos/progression-completion.ts:471-474` + `progression-pipeline.ts:1038,1089` — *bug/safety.*
A `canCompleteCase(..., 'ENGINE')` `allowed:true`-t ad, ha `progression_enabled=0` („legacy close
path") — de ezt a kaput a pipeline **saját maga** hívja terv-kimerüléskor és a downgrade-őrben. Egy
`enabled=0` állapotsorral megpörgetett ügy GENERIC_STATUS_TEMPLATE DoD-vel átcsúszik, és a motor
COMPLETED-be teszi — a 2026-08-09-i „72 hamis lezárás" hibája, újra beengedve a letiltott ágon.
Ma latens (az intake `enabled=1`-gyel seedel), de egy refaktornyira az élestől. **Javítás:** az
ENGINE-út számára a „nem motor-vezérelt" jelentsen *elutasítást* — a jogos zárásokat az OWNER-út fedi.

### Core engine — konkurencia a kimenő állapotgépben

**E1 — A SENDING-recovery versenyezhet egy úton lévő küldéssel → dupla kézbesítés.**
`src/cos/executor-core.ts:297, 484-503, 456-459` + `scheduler.ts:84-95` — *bug/race.* A
`reconcileOutbound` korhatár nélkül kínálja fel a SENDING sorokat, a `recoverAction` nem nézi sem a
claimet, sem a kort. A SENDING az `await adapter.send()` **előtt** íródik, tehát amíg a küldés a
szolgáltatónál jár, egy párhuzamos tick readbacket futtat, a markert (még) nem találja, és a sort
PLANNED-re állítja vissza (500. sor). Minden `setStatus` feltétel nélküli UPDATE (nincs
compare-and-swap), így az eredeti küldés visszatérve vakon felülír. Forgatókönyv: küldés úton →
tick PLANNED-re állít → új dispatch → **második `send()` egy már kézbesített üzenetre.** Pont az az
invariáns sérül, amit a modul fejléce véd („soha kétszer send() readback-bizonyíték nélkül") — itt a
readback semmit nem bizonyít, mert az úton lévő kísérlettel versenyzett. **Javítás:** (a)
türelmi ablak a SENDING-recovery előtt (pl. `sending_at <= now - 15 perc`); (b) az állapotátmenetek
legyenek feltételesek (`WHERE status=?`), 0 változás = konfliktus.

**E2 — A per-sor dispatch-claim nem szerializálja a dupla kattintást.**
`src/cos/send-flow.ts:276-280` + `case-engine-core.ts:306-325`; a route (cos.ts:1151) nem ad
runId-t — *bug/race.* Az alap-runId determinisztikus (`dispatch-${ledgerId}`), az `acquireClaim`
pedig azonos ownerre újrabelépő: élő claimnél az upsert no-op, de a SELECT `acquired:true`-t ad
**ugyanazzal a fence-szel** — igazolva a forrásból. Két átfedő HTTP-dispatch mindkettője átmegy,
mindkettő ticketet vált, a második pont az E1-es recovery-versenyt üti be; ráadásul a második
`finally`-je felszabadítja a claimet, míg az első küldés még úton van. A 272-275. sor kommentje
(„a claim a dupla kattintást szerializálja") jelenleg nem igaz. **Javítás:** hívásonként egyedi
alap-runId (`randomUUID()`), vagy az `acquireClaim` utasítsa el az élő claim újrafelvételét.

**E3 — A titkosított mentés élő WAL-módú SQLite-fájlt bájtmásol.**
`src/cos/backup.ts:66-74` (+ `db.ts:71`: `journal_mode = WAL`) — *bug.* A `readFileSync(dbPath)` WAL
alatt a checkpointolatlan commitokat kihagyja, és futó írás mellett belül szakadt másolatot adhat. A
„restore-teszt" csak a titkosítás oda-visszáját ellenőrzi — sosem nyitja meg az eredményt
adatbázisként. **Javítás:** better-sqlite3 `db.backup()` vagy `VACUUM INTO`, és a restore-tesztbe
`PRAGMA integrity_check`.

### ZST (céges) ág — a privát javítások nem lettek átportolva

**Z1 — Egy céges jóváhagyás örökre és korlátlanul érvényes (F-16 csak priváton javítva).**
`src/cos/zst-send.ts:115-126` — *safety.* Az `approveZstSend` nyers INSERT-je se `valid_until`-t, se
`max_total_outbound`-ot nem ír — az `authorizeSend` a NULL-t „sosem jár le / korlátlan"-ként kezeli.
A privát `approveSend` szándékosan 7 nap TTL-t és max 1 küldést ad alapból, hosszú magyarázó
kommenttel. **Élő teszttel igazolva: egy jóváhagyás után ugyanannak a payloadnak egy egy évvel
későbbi új draftja új jóváhagyás nélkül kiment.** A tulajdonos egyetlen IGEN-je állandó engedély —
pontosan az, amit a send-flow saját kommentje szerint a §3.2 tilt. A meglévő lejárat-teszt kézi
UPDATE-tel hamisítja a borítékot, ezért nem látszik. **Javítás:** az `approveZstSend` menjen a
`zstApprovals.recordApproval`-on át, a privát TTL/plafon-alapértékekkel; teszt, hogy a második draft
`quota_exhausted`-dal utasít el.

**Z2 — A ZST a saját küldött leveleit új ügyként veszi fel (a 2026-08-10-i fix csak priváton él).**
`src/cos/zst-intake.ts:82-86` vs `intake.ts:104-112` — *safety/bug.* A feeder mindkét fiók `in:sent`
mappáját is lekéri és `headers` nélkül posztol, így a ZST-intake egyetlen szűrője (az idempotencia-
fejléc) sosem sül el. A privát oldal ezt az `outbound_ledger.external_ref` és `thread_ref`
ellenőrzéssel kompenzálja; a ZST-nek egyik sincs a `zst_outbound_ledger` ellen. Egy új szálat nyitó
céges küldés Sent-példánya 4 napon belül visszajön, ügyet nem talál, és WAITING_EXTERNAL-ban új
`zst_case`-t nyit follow-uppal — duplikált munka, potenciális ön-follow-up hurok céges levelezésen.
**Javítás:** mindkét privát ellenőrzés portolása.

**Z3 — A `dispatchZstSend`-nek nincs claimje és eldobja a boríték-plafonokat (F-4/N-2 nincs portolva).**
`src/cos/zst-send.ts:230-268, 158-162` — *safety.* Se claim, se `campaignLimit`, se `quota` nem megy
az `executeAction`-be; az `authorizeZstSend` a közös motor `limits`/`approvalId` kimenetét eldobja.
A céges úton így a fence-ellenőrzés és a tranzakción belüli atomikus plafon-számlálás halott — a
dupla-dispatch verseny (E1/E2) itt védelem nélkül áll. **Javítás:** a privát minta tükrözése az
exportált `acquireZstClaim`/`releaseZstClaim`-mel, és a limits/approvalId továbbadása.

**Z4 — NBSP-ezres-elválasztós összegek csendben rossz számot adnak.**
`src/cos/zst-invoice-extract.ts:26` + `zst-contract-extract.ts:51` — *bug (pénz).* A `HUF_AMOUNT`
ezres-csoportja csak ASCII szóközt/pontot fogad, miközben a Gmail-snippetek rendszeresen U+00A0-val
jönnek: az `1 234 567 Ft` (NBSP-kkel) **567**-ként kerül kinyerésre, és a `Math.max` miatt egy NBSP-s
szám elrontja a `gross_amount`-ot, a duplikátum-hasht és a bank-párosítást. A bank-oldali
`parseAmount` immunis — a két oldal ugyanarról az összegről mást állapíthat meg. **Javítás:**
` `/` ` a szeparátor-osztályba + normalizálás; NBSP-s tesztesettel.

**Z5 — A `bankszámlaszám` szót az invoice-szám regex számlaszám-cue-nak olvassa.**
`src/cos/zst-invoice-extract.ts:47` — *bug.* Az alternáció `\b` nélkül illeszkedik, így a
„Bankszámlaszám: 11711003-20003983" a **bankszámlaszámot** rögzíti `invoice_number`-ként HIGH
konfidenciával — a magyar számlalevelek zöme pedig tartalmaz fizetési adatokat. A dedup-hash rossz
kulcson áll, a valódi számlaszám későbbi beérkezése második sort nyit ugyanarra a számlára.
**Javítás:** `\b` horgony és a `bankszámlaszám` explicit kizárása.

### Privát domain

**P1 — A radar-találat riasztása elveszhet: a `markNotified` a riasztás ELŐTT fut.**
`src/cos/tick.ts:80` + `runtime.ts:66-69`, kontraktus: `radar.ts:204-206` — *bug.* A radar.ts
kimondja: a markNotified csak a riasztás tényleges kiposztolása UTÁN hívható. A `cosTick` mégis a
cikluson belül hívja, a riasztás pedig csak a runtime `.then()`-jében megy ki. Crash vagy
`alertRadarHit`-hiba esetén a tétel már „értesítve", és amíg az ár a cél alatt marad, a
`decideNotify` minden ága `should:false` — a tulajdonos sosem hall a megtalált akcióról.
**Javítás:** a notify-döntés perzisztálás nélkül menjen ki a tickből, és a markNotified csak a
sikeres riasztás után fusson (vagy outbox-sor a markNotified-dal egy tranzakcióban).

**P2 — Az eMAG-adapter minden hálózati/HTTP-hibát „0 találatnak" nyel el.**
`src/cos/adapters/emag.ts:111-119` → `radar-runner.ts:100-116` → `radar.ts:194` — *bug.* Egy 403,
timeout vagy DNS-hiba üres találati listaként jön vissza: (1) a null-áras megfigyelés HIT→ACTIVE-ra
billenti a tételt; (2) a következő sikeres ellenőrzésnél NEW_HIT-ágon **újra riaszt** ugyanarról a
változatlan ajánlatról — hálózati bibircsókonként egy re-ping; (3) a `connector_health` sosem
degradálódik. A DiscoverCars-adapter helyesen dob — az eMAG-nak is különböznie kell a „lekértem,
nincs termék" és a „nem tudtam lekérni" között. **Javítás:** dobás a fetch-hibákon.

**P3 — A goal-enrichment érzékenységi kapuja csak a szál-tartalmat osztályozza, de a cím+leírás is kimegy.**
`src/cos/goal-enrichment.ts:186-193` vs `progression-pipeline.ts:580-587` — *safety.* A `tierFor` a
tárolt e-mail-szálon (vagy üres stringen) fut, majd a hívás a `title`, `case_type`, `description`
mezőket IS elküldi a routolt szolgáltatónak. A feladó által írt cím/leírás ezen az úton sosem esik
tartalom-osztályozás alá. Az intake-születésű privát ügyeknél a declared-szint eszkalációja részben
véd, de a más úton született, átcímzett, illetve ZST-ügyekre nem áll. Egy `ZST_INTERNAL`-nak
deklarált ügy IBAN-os leírása THIRD_PARTY szolgáltatóhoz mehet. **Javítás:** a `tierFor` a
`${title}\n${description}\n${content}` felett fusson — a reader-út „azt osztályozd, amit küldesz"
szabálya szerint.

**P4 — A checkpoint-kurzor nem monoton, és a triage-batchek hamis értékekkel szennyezik.**
`src/cos/email-ingest.ts:156-175` + `triage-bridge.ts:60-64` + `source-commit.ts:196-206` — *bug.*
A `tryAdvanceCheckpoint` upsertje feltétel nélkül ír (a „never regresses" komment nincs kikényszerítve),
és minden lezáró triage-batch a szintetikus `triage-<unix>` stringet írja a valódi Gmail-fiók
checkpointjába — egy jövőbeli historyId-poller innen seedelve szemetet kap. Ráadásul a
reconcile CRITICAL-ellenőrzése (`reconcile.ts:320`) TEXT-ként hasonlít numerikus historyId-kat
('999' > '1000'), tehát fals pozitív és fals negatív is lehet. **Javítás:** a triage-batchek ne
érintsék a fiók-checkpointot (vagy source-kind szerinti checkpoint), numerikus monoton őr az upsertbe.

---

## KÖZEPES (területenként, tömören)

### Core engine
- **E4** `executor-core.ts:342,355,426` — kapu/vészleállító-elutasítás a FAILED_RETRYABLE sort
  PLANNED-re írja vissza → a retry-plafon és a backoff kikerülhető; elutasításnál a belépő státusz
  maradjon meg.
- **E5** `executor-core.ts:456-482` — sikeres küldés utáni első üres readback azonnal
  RECOVERY_REQUIRED-be eszkalál (indexelési késés = örök emberi vészjelzés); türelmi ablak +
  második megerősítés kell.
- **E6** `scheduler.ts:84-95` + `reconcile.ts` — a FAILED_RETRYABLE árva állapot: semmi nem
  próbálja újra és egyik reconcile-ellenőrzés sem jelenti; egy átmeneti szolgáltatóhiba csendben,
  örökre megfeneklteti a jóváhagyott küldést.
- **E7** `quota.ts` (egész modul) — az atomikus send-kvótát (`send_quotas`) kizárólag tesztek
  hívják; globális/napi ráta-plafon élesben nem létezik. Bekötés a dispatch-függvényekbe.
- **E8** `action-authorization.ts:148-150,196-213` + `kill-switch.ts:66-74` — a visszavonás
  `consumed_at`-ba írása miatt egy nem-egyszer-használatos ticketet a vészleállító nem tud
  érvényteleníteni (ma latens: minden kibocsátó single-use); külön `revoked_at` kell — az audit is
  olvashatóbb lesz (revoked ≠ consumed).
- **E9** `schema.ts:620-623` — a §17-es migráció minden bootnál újrafut: egy kézzel
  PERSONAL_CONFIRMED-re állított migrált ügyet a következő restart visszaminősít
  MIGRATED_UNVERIFIED-re. Egyszeri migrációs marker kell.
- **E10** `reconcile.ts:51-58 vs 80,108,119,132,160` — a `count()===null` (olvashatatlan tábla) a
  legtöbb ellenőrzésben „tisztának" számít, pont a fájl fejléce által tiltott csendes szűkülés;
  csak a `stuckLocalApplied` kezeli jól.

### Autonómia
- **A6** `progression-pipeline.ts:448-453` — a WAIT_EXTERNAL eszkaláció az ügy korát méri
  (`created_at`), nem a várakozásét: minden 7 napnál öregebb ügy az első ciklusban
  RECOVERY_REQUIRED-be esik. Az állapotváltás-esemény idejétől kell mérni.
- **A7** — a vészleállítót a progression-motor nem nézi (greppel igazolva: csak az executor és a
  `permits()` út ellenőrzi): engaged kapcsoló mellett a motor tovább fogyaszt válaszokat és
  transitionöl. `killSwitchRefusal`-check a `runProgressionCycle` tetejére.
- **A8** `cos.ts:682` + `web/coscontrol.js` — a REQUEST_APPROVAL kérdés Mission Controlból nem
  megválaszolható (404), csak Telegramon — azon a felületen, amelynek a válasz-szemantikája laza
  (A1/A2). A szigorú felület nem tud válaszolni, a laza túl-válaszol.
- **A9** `progression-eval.ts:100-180` + `pipeline:937-966` — a „7 kemény biztonsági állítás"
  bemenete szintetikus (`status:'COMPLETED'`, `error_code:null`), így öt állítás szerkezetileg nem
  tud elsülni, miközben minden futás `safety_assertions_json`-ja kiértékeltként naplózza őket —
  az audit többet állít a valóságnál. Valós futás-tényeken értékelni, vagy `not_applicable`-t írni.
- **A10** — a fokozat-létra előléptetési gépezete (`setLadder`, `recordCampaignOutcome`,
  `promotionEligibility`) éles hívó nélküli; minden típus örökre PREPARE-en ül, a fokozatemelés
  kézi SQLite-szerkesztés. Biztonságos irányú, de a „graduated autonomy" a checken túl nincs
  megépítve — tulajdonosi végpont + kampány-kimenet bekötés, vagy explicit dokumentálás.
- **A11** `cos.ts:1098` — az `approveAndDispatchZst` a request bodyból fogad `allowedRecipients`
  listát; a hívó szélesítheti a borítékra rögzített címzett-allowlistet. Eldobni vagy a draftolt
  címzettre metszeni.
- **A12** — kereszt-processz dupla futás: az owner-action route (cos.ts:733) és a migrate-út
  claim nélkül futtatja a ciklust a heartbeat-cron mellett; a `runProgressionCycle` nincs
  tranzakcióban → részleges állapot crashnél.
- **A13** `docs/heartbeat-autonomy.md:44` + `routes/autonomy.ts` — két párhuzamos
  autonómia-rendszer ellentétes defaulttal: a JSON-configos hiányzó kulcsa **3-as (teljesen
  autonóm)** szintet ad, a SQLite-létra PREPARE-t; a szint-betartatás ott prompt-szintű. Hiányzó
  kulcs → 1-es szint, és ki kell mondani, melyik rendszer az irányadó.
- **A14** — a státusz-vezérelt kérdésekre (INFORMATION_REQUIRED, CALL_REQUIRED, …) adott válasz
  a motoron át sosem mozdítja az ügyet (a decide() ugyanarra a státuszra ugyanazt adja) —
  jelöletlen megfeneklő állapot GATE 2-nél.

### ZST (céges)
- **Z6** `zst-send.ts:84-101` — F-1/F-2 nincs portolva: `COUNT(*)+1` szekvencia-verseny retry
  nélkül (nyers SqliteError), a `planAction` a campaign/recipient/hash/caseVersion mezők nélkül fut
  (a per-kind kvóta ZST-sort sosem számol), a campaign_id utólagos UPDATE.
- **Z7** `zst-finance.ts:108-116` — a bank-párosítás javaslata devizát és irányt nem néz: 100 EUR
  terhelés 100 HUF számlára illik, jóváírás bejövő számlára; egy hamis javaslat a jót is blokkolja
  (`usedInvoices`).
- **Z8** `zst-bank-import.ts:165-168` — a dedup-hash az egy kivonaton belüli jogos ikertételeket
  (két azonos kártyaterhelés egy napon) csendben eldobja; kivonaton belüli előfordulás-index kell.
- **Z9** `zst-bank-import.ts:104-105` — minden összeg egészre kerekül devizától függetlenül
  (EUR/USD centek elvesznek — a fejléc a Wise-t nevesíti); minor-unit + currency tárolás.
- **Z10** `zst-finance.ts:135-149` — az `unmatched_transaction_count` globális, nem periódusra
  szűrt: minden csomagot minden későbbi rendezetlen tétel „újranyit".
- **Z11** `zst-bank-import.ts:39-47,120-130` — az oszloptérkép tud félrekötni (generikus
  `datum` cue az értéknapra; külön Terhelés/Jóváírás oszlopos bankoknál a fél kivonat összege
  NULL) — a fejléc „inkább null, mint félrekötött" ígérete ellenére.
- **Z12** `scripts/zst-import-bank-statement.ts:43` — csak UTF-8 beolvasás; a magyar banki
  CSV-k gyakori ISO-8859-2/CP1250 kódolása szétesik és a térképezés degradálódik.
- **Z13** `zst-intake.ts:134,144` — a kinyerők a 300 karakteres snippeten futnak, nem a törzsön;
  a „később újra-kinyerjük" ígéretnek nincs végrehajtója.
- **Z14** — bizonyítottan driftelő duplikáció: `EmailDraft`/payload-hash byte-duplikátum a
  send-flow és zst-send között; `parseHufAmounts`/`parseDates` duplikálva a két extractor között
  (már most eltérő regexszel); a progression-seed blokk szó szerint duplikálva a két intake között.
  Közös helperbe — az NBSP-fixet (Z4) így csak egyszer kell letenni.
- **Z15** `zst-finance.ts:122-124` — determinisztikus `recon_id` sima INSERT-tel: egy elutasított
  javaslat újra-felmerülése PK-ütközéssel az egész javaslat-menetet elhasalja; upsert kell.

### Privát domain
- **P5** `gmail-history-guard.ts` — az egész P1.2/AC-28 modul halott kód: a `content_hash`-t
  semmi nem írja, a `classifyHistoryEvent`-et semmi nem hívja élesben — az auditok ne számolják
  teljesítettnek; bekötni vagy „a jövőbeli pollerhez előre megépített" jelölést kap.
- **P6** `case-link.ts:166-181` — a `linkCases` nem nézi az optimista-verzió UPDATE `changes`
  értékét, és feltétel nélkül ír CASE_LINKED audit-eseményt — az audit olyan linket állíthat,
  ami nem jött létre (és féloldalas link is lehet).
- **P7** `case-link.ts:55` + `intake.ts:165-169` — bármely közös 6+ jegyű szám (telefonszám,
  dátum, végösszeg) STRONG matchként automatikusan összeköt ügyeket, és a szkennelt szöveg idegen
  levele — a feladó szándékosan is összeköthet ügyeket (case-graph poisoning). Telefon/dátum-alak
  kizárása, megbízható mező megkövetelése.
- **P8** `poison-quarantine.ts:102-117` — részlegesen elbukott karantén-kísérlet után a
  kanban-kártya PK-ütközése örökre meghiúsítja a karantént, és minden sweep új CRITICAL sort
  szúr be; `INSERT OR IGNORE` + meglévő nyitott kártya = teljesült feltétel.
- **P9** `email-ingest.ts:84-91,137-143` — átfedő batchek közti újra-felfedezésnél a kurzor
  túlhaladhat egy feldolgozatlan üzeneten (latens P0.2-sértés; a jelenlegi triage-flow-ban nem
  érhető el, de a valódi history-poller pont ilyen deltákat ad).
- **P10** `scripts/cos-channel-poll.ts:56-83` — a „kérdésnek kinéző" tulajdonosi üzenet és a
  falsy `recordOwnerAnswer`-es match csak számlálódik: a szöveg elvész, az offset túllép rajta —
  ugyanúgy hold kellene, mint az ambiguous ágnak (a poll saját fejléce is ezt érvel).
- **P11** `reader-cycle.ts:94-120` + `goal-enrichment.ts:52-72` — mindkét sweep a personal
  domaint teljesen felsorolja a zst előtt, majd vág: privát backlog mellett a céges ügyek
  kiéhezhetnek; round-robin kell. Plusz a `validateEvidencePacket` nem-objektum tömbelemre dob.

---

## ALACSONY (válogatás — a teljes lista az egyes területi szakaszok szerint)

- `dispatch-gate.ts:98-102` — a privát kapu nem ad `channel`/`usedVariables`-t az `authorizeSend`-nek,
  így a boríték csatorna- és változó-korlátai priváton elérhetetlenek (a ZST-út átadja a channelt).
- `approval-core.ts:328-361` — a REPLY-plafon csak check-then-act: a `limits.maxPerKind` a REPLY-ra
  null-t ad, a tranzakción belüli számlálás sosem látja; két párhuzamos reply átmehet.
- `backup.ts:94-98` — a retenció mtime alapján öregít a fájlnévbe kódolt időbélyeg helyett.
- `retention.ts:75-80`, `store-security.ts:40`, `case-link.ts:96-102` és társai — széles
  `catch`-ek, amelyek a „tábla nincs még" és a valódi korrupció/diszkhiba között nem tesznek
  különbséget.
- `send-flow.ts:321` + `cos.ts:1162-1169` — admission-elutasításnál a UI `sent:false`-t kap
  indoklás nélkül (a reasons csak `!decision.allowed`-nál megy ki).
- `schema.ts:355-356` — hiányzó `(campaign_id, status)` index a forró plafon-számlálásokon
  (ma ártalmatlan, kampányvolumen előtt pótolandó).
- `followup-autodraft.ts:175,128` — a levél „a megkeresés óta eltelt N nap"-ot állít, de a szám a
  `follow_up_at`-tól számolódik (rossz szám egy valódi címzettnek); `Re:` kis/nagybetű-érzékeny.
- `gmail-thread-read.ts:91-96` — LIFO MIME-bejárás: testvér text/plain részek fordított sorrendben
  konkatenálódnak.
- `adapters/gmail-api-transport.ts:70-119` — a `to` és a melléklet-fájlnév CR/LF-sanitizálása
  hiányzik (header-injection ellen ma csak a felsőbb kapu véd) — mélységi védelem.
- `adapters/discovercars.ts:110-112` — a `rentalDayCount<=0` ellenőrzés a create-search és a
  polling UTÁN fut; 1–5 valódi ajánlatos lokáció mindig végigpörgeti mind a 12 poll-kört.
- `adapters/emag.ts:38-42` vs `radar-runner.ts:72-76` — a `CURRENCY_MINOR_EXPONENT` két fájlban
  duplikálva: fél helyre felvett deviza 100×-os ár-félreskálázás.
- `zst-watch.ts:37-59` — `date('now')` UTC-ben: budapesti estéken a határidő-átfordulás ~2 órát
  késik; `zst-bank-import.ts:109-116` — a `normalizeDate` nem validál (mm/dd export érvénytelen
  ISO-t ad); `zst-contract-extract.ts:143` — a `contractType` mindig kap defaultot a „maradjon
  null" kontraktus ellenére.
- `routes/autonomy.ts:52-83` — a level nem egész-validált (2.5 átmegy), a JSON read-modify-write
  lockolatlan; `routes/cos.ts:97` — kill-switch POST JSON-parse try/catch-en kívül (500 a 400
  helyett).
- `progression-heartbeat.ts:114-119` — hamis komment („push the next check out") + minden enabled
  ügy örökké esedékes: sweepenként 2 írás/ügy; `progression-pipeline.ts` — halott `resolveContext`,
  producer nélküli `WAIT_TIME` döntés, írótlan `wait_version` oszlop, a fejléc-invariánsok a
  Checkpoint B-t írják le, nem a jelen fájlt; a run-sorok `case_version_before/after` mezői fikciók.
- `evidence-planner.ts:131` vs `reader-arbitration.ts:37-44` — 0.6 vs 0.7 konfidencia-küszöb két
  helyen, driftre ítélve.
- `routes/cos.ts:148` — `input as unknown as ZstTriagedEmail` kettős cast validálás nélkül: a
  privát alakú payload ZST-intake-be routolva minden ügyet fail-closed max-restrikcióra kényszerít,
  és a privát caseType-stringek miatt a számla-extractor sosem indul routolt ügyön.
- `cos.ts:754-759` — `progressionRan:true` akkor is, ha a ciklus dobott; a válasz-esemény
  legutolsó-kiválasztása másodperc-felbontású `created_at`-on tiebreak nélkül.

---

## Keresztmetszeti minták (a hibák mögötti négy visszatérő alak)

1. **Komment-kontraktus kikényszerítés nélkül.** A modulok kontraktusai kommentben élnek, és a
   hívó megszegi őket: „markNotified csak a riasztás után" (P1), „adapter-hibák propagálnak" (P2),
   „a kurzor sosem regresszál" (P4), „a claim szerializálja a dupla kattintást" (E2), „caseType-ot
   a hívó olvassa a store-ból" (C1). Ahol az invariáns kódban él (gate-permit WeakSet, egyszer
   használatos ticket, DB CHECK-ek), ott tartja is magát — ez a minta érdemes általánosításra.
2. **Privát→ZST portolási adósság.** A privát oldal minden dátumozott, öntudatos javító kommentje
   (F-1, F-2, F-4, F-16, N-2, a 08-10-i Sent-szűrés) egyben checklist arról, mi hiányzik a céges
   oldalról (Z1, Z2, Z3, Z6). A Z14-es duplikáció-konszolidáció után a következő javítás már csak
   egyszer landolna.
3. **Fél-megépített rendszerek, amelyeket a papír késznek mutat.** Kvóta-réteg hívó nélkül (E7),
   history-guard hívó nélkül (P5), létra-előléptetés író nélkül (A10), 7 biztonsági állítás
   szintetikus bemenettel, „kiértékelve" naplózva (A9), két autonómia-rendszer ellentétes
   defaulttal (A13). Ezek auditkor teljesítettnek látszanak — vagy be kell fejezni, vagy explicit
   „előre megépített, nincs bekötve" jelölést adni nekik.
4. **Mellékhatás a feltétel-ellenőrzés előtt.** Karantén-kártya a feltételsor kiértékelése előtt
   (P8), audit-esemény a nem-ellenőrzött UPDATE után (P6), markNotified a riasztás előtt (P1) —
   az audit-nyom olyat állít, amit a store nem tart.

## Teszt-lefedettségi hiányok (a legfontosabbak)

- **Egyetlen teszt sem visz sikeres küldést az éles ZST-ajtón át** — minden ajtóteszt elutasítást
  állít; ezért láthatatlan a C1. A lejárat-teszt kézi UPDATE-tel hamisítja a borítékot (ezért a Z1).
- Nincs teszt: SENDING-sor recovery vs. úton lévő küldés interleaving (E1); azonos-owner
  claim-újrabelépés (E2); ZST dupla-dispatch (Z3); markNotified-sorrend (P1); eMAG hálózati hiba
  végig a `recordObservation`-ig (P2); triage-batch → checkpoint (P4).
- Az A1/A2/A3 válasz-szemantika: csak a YES/NO OWNER_DECISION fedett, az info/confirmation/egyéb-
  choice utak és a második-epizódos visszajátszás nem.
- Bank-import: nincs nem-HUF sor, NBSP-szeparátor, kétoszlopos terhelés/jóváírás, kivonaton belüli
  jogos duplikátum, kódolási eset.
- A `cos-gmail-history-guard.test.ts` alaposan tesztel egy modult, amit élesben semmi nem hív (P5).
- Pozitívum: a gate-permit standing-checkek (`cos-gate-permit.test.ts`) valóban kikényszerítik a
  két-kibocsátó szabályt a teljes `src/` és `scripts/` felett — ez a minta másutt is megérné.

## Javasolt javítási sorrend

**Mielőtt a Gmail-konnektor READ_WRITE-ra vált (küldési út):**
1. C1 (ZST-ajtó caseType) + Z1 (ZST TTL/plafon) — mindkettő kicsi, a privát oldali minta kész.
2. E1 + E2 (SENDING-türelmi ablak, feltételes állapotátmenetek, egyedi runId) és Z3 (ZST claim+limits).
3. E7 (kvóta bekötése) és E8 (revoked_at).

**Mielőtt a progression `live` módba lép (autonómia):**
4. A1 + A2 + A3 együtt — a válasz-esemény kapjon típus- és choice-szigorú, egyszer fogyasztható,
   időben korlátos szemantikát; ez a review egyetlen legnagyobb értékű változtatása.
5. A5 (letiltott-ág lezárási kiskapu), A7 (vészleállító a motorba), A4 (jóváhagyás-identitás).

**Pénzügyi pontosság (a céges könyvelést már ma torzítja):**
6. Z4 + Z5 (NBSP-összegek, bankszámlaszám-capture) — közönséges magyar számlaleveleken hibáznak,
   nem szélsőséges eseteken; majd Z7–Z9 (deviza/irány, ikertételek, kerekítés).

**Megbízhatóság/higiénia:** P1, P2, P4, E3 (WAL-mentés), E5/E6 (readback-eszkaláció és árva
FAILED_RETRYABLE), majd a Z14-es konszolidáció, hogy a további javítások csak egyszer landoljanak.
