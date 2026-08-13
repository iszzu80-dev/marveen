# COS — ötödik code review: a #4 kör remediációja, és ami a Reader kimenetével történik

**Alap:** `develop` @ `e0bb1bb` (a review-ág `af17388` merge-e).
**Előzmény:** review #1 (18 találás), #2 (13/18 javítva + N-1..N-5), #3 (Ú-1..Ú-5), #4 (N4-1, N4-2).
**Spec:** COS v4.2.1, progression v1.3.1 (§10.1, §10.2, §10.3, §10.5, §10.8, §13.1, §22.1, §22.2, §C).

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` | **zöld** |
| `npx vitest run` a COS teszt-fájlokon | **802/802 zöld, 96 fájl** (#4-ben 770 / 92) |
| A #4 kör két találása | **mindkettő javítva**, kódból visszamérve |
| A #3 kör két nyitva maradt találása (Ú-4, Ú-5) | **mindkettő javítva** |
| `grep` a `case_evidence_packets` olvasóira | **nulla produkciós olvasó** — lásd Ö-1 |
| `grep` a `goal-enrichment.ts` érzékenységi kapujára | **nincs** — lásd Ö-2 |

---

## 0. Rövid álláspont

Ez a kör négyből négy találást javított, és mindegyiket **jól**: nem a hiba tüneteire, hanem az okára. A `provider-data-policy.ts` nem egy `if` a Reader elé, hanem egy külön tengely (szolgáltató, nem árkategória), aminek a fejlécében le van írva, miért volt rossz a régi szabály és mikor tört el. A `gate-permit.ts` őszintén megmondja, mit *nem* tud kikényszeríteni egyprocesszes TypeScriptben, és a maradékot egy standing check teszttel fedi le. A trigger-szótárnál a javítás **részben visszautasította a javaslatomat**, indoklással (`INTAKE` ≠ `NEW_RELEVANT_EVENT`) — ez a helyes viselkedés, és ritkább, mint a javítás maga.

Amit viszont a kód mutat: **a Reader-lánc a bemenetére van bekötve, a kimenetére nem.** Naponta legfeljebb 432 modellhívás (3 ügy / ciklus × 144 ciklus) készít evidence packetet, arbitrációt és tervet, és ezeket egyetlen produkciós olvasó sem olvassa vissza — a `progression-pipeline` ma is `buildRollingPlan`-t hív. 90 nap múlva a retention (helyesen) kinullázza a tartalmukat. Ez pontosan az a hibaosztály, amit mind a négy előző review a rendszer fő problémájaként nevezett meg — csak most egy szinttel feljebb: nem a kapu maradt ki a forgalomból, hanem a *válasza*.

És egy második, konkrétabb: az érzékenységi kapu megépült a Reader elé, de **a testvér-útra, a `goal-enrichment`-re nem** — ami ugyanabban a `try` blokkban, harminc sorral feljebb, ugyanabból az e-mail szálból küld ki 12 000 karaktert, kapu nélkül.

---

## 1. A #4 és #3 kör négy nyitott találása

| # | Találás | Állapot | Bizonyíték |
|---|---|---|---|
| **N4-1** | A Reader érzékenységi kapu nélkül küld ki teljes ügy-tartalmat | **JAVÍTVA, jól** | lásd 1.1 |
| **N4-2** | A `case_evidence_packets` tartalmára nincs retention | **JAVÍTVA** | `retention.ts:40` (`evidencePacketDays: 90`), `:61` `purgeExpiredEvidencePackets`, hívó: `scripts/cos-maintenance.ts:63`; standing check: `cos-evidence-packet-retention.test.ts:78` |
| **Ú-4** | A jogosítás-jegyet bárki kiállíthatja, aki importálni tudja a modult | **JAVÍTVA** | lásd 1.2 |
| **Ú-5** | A trigger-szótár duplikátumai | **JAVÍTVA, indokolt részleges visszautasítással** | lásd 1.3 |

### 1.1 N4-1 — a kapu ott van, ahol lennie kell

`src/cos/provider-data-policy.ts` (új, 74 sor). A döntés tengelye megváltozott: nem az árkategória, hanem az adatkezelési viszony. `CONTRACTED_ONLY = {SENSITIVE_PERSONAL, HIGHLY_SENSITIVE}`, `PROVIDER_DATA_CLASS = {anthropic: CONTRACTED, deepseek: THIRD_PARTY}`, és **kétszeresen fail-closed**: ismeretlen tier a `coerceSensitivity`-n át HIGHLY_SENSITIVE, ismeretlen szolgáltató THIRD_PARTY. Új szolgáltató kimaradással lesz THIRD_PARTY, nem egy bejegyzéssel, amire emlékezni kell.

A bekötés helye a lényeg: `reader-cycle.ts:226-247` — a kapu az **utolsó dolog, mielőtt a tartalom elhagyja a gépet**, a kommentje ezt szó szerint ki is mondja. A blokkolás nem néma:

- külön számláló (`sensitivityBlocked`), mert „read: 2" és „read: 2, sensitivityBlocked: 1" nem nézhet ki egyformán;
- `byProvider` bontás — az útválasztás a lényeg, tehát a bontás a bizonyíték;
- tárolt sor `decidedBy: 'SENSITIVITY_BLOCKED'`-kal és olyan `refusal_reason`-nel, ami megmondja, **mi lett volna** megengedve.

`routeFor` (`:191`) az olcsót próbálja először, és csak akkor a kontraktáltat — vagyis tényleg útválasztás, nem „mindent a drágának". Ehhez jár egy átgondolt melléktalálás is: a `context-builder.ts:81` `docSensitivity` méréssel indokolt (mind a 92 élő dokumentum `UNKNOWN`, a fail-closed coerce 40-ből 36 ügyet blokkolt volna **adathiányra, nem tartalomra**), és nem lazítás: a dokumentum saját érvényes tierje továbbra is *eszkalál*, a tartalom-osztályozó pedig mindkettő fölé.

A tesztek (`cos-reader-sensitivity-gate.test.ts`, 11 eset) tartalmazzák az ellenpróbát is („a PERSONAL ügy az OLCSÓ szolgáltatóhoz megy — útválasztás, nem általános felminősítés"), ami nélkül a kapu csak egy mindent tiltó `return false` lenne.

### 1.2 Ú-4 — a WeakSet, és ami mellette áll

`src/cos/gate-permit.ts:30` modul-privát `MINTED = new WeakSet()`. Egy permit **nem írható kézzel objektum-literálként**, mert a tagságot csak ez a modul adja — a teszt ezt a strukturális klónnal és a JSON round-trippel is kimutatja. `issueAuthorization` (`action-authorization.ts:87-96`) először `gatePermitRefusal(permit)`-et hív, és **két** feltételt néz, nem egyet: legyen kaputól való ÉS a kapu mondjon igent. A második a „lefuttattam a kaput és figyelmen kívül hagytam a válaszát" eset — pontosan az, amit egy elszánt hívó a kezében tartana.

Két mintázó van, mindkettő valódi kapu: `dispatch-gate.ts:109`, `zst-send.ts:221`. Két fogyasztó, mindkettő átadja: `send-flow.ts:298`, `zst-send.ts:255`.

A modul fejléce megmondja, mit **nem** tud: egyprocesszes TypeScriptben nincs olyan capability-határ, amit egy elszánt hívó ne lépne át, tehát ez nem lehetetlenné teszi a hamisítást, hanem *három átgondolt, review-zható lépéssé*. Ez a fajta önkorlátozás többet ér, mint egy „megoldva" felirat. A maradékot két standing check fedi (`cos-gate-permit.test.ts:76` és `:88`).

### 1.3 Ú-5 — és a visszautasított fele

`progression-trigger.ts:54-65`: `TRIGGER_SYNONYMS` (`WAKE→WAIT_WAKE_DUE`, `MANUAL→MANUAL_REVIEW_REQUEST`, `RECOVERY→CAPABILITY_RECOVERED`) + `canonicalTriggerType`, bekötve az **írás határán** (`progression-pipeline.ts:730, 770, 984`) — a régi sorok érintetlenek, a történelem nincs átírva, és ezt teszt is rögzíti.

Amit **nem** fogadott el a javaslatomból, indoklással: `INTAKE` nem `NEW_RELEVANT_EVENT` (az egyik azt válaszolja meg, honnan jönnek az ügyek, a másik azt, mi ébreszti őket — és 101 élő sor az elsőt jelenti), `ESCALATION_RESOLVED`-nek pedig nincs §10.8-as párja, összevonása kitalált megkülönböztetés lenne. Ez helyes.

Ehhez jár egy olyan javítás, amit nem kértem, és ami a legjobb ebben a körben: `progression-heartbeat.ts:127`. A régi kód `trig.trigger ?? 'SCHEDULED'`-ot írt. Az új **hibaként rögzíti** a névtelen triggert (`cycleErrors++`, elengedett claim), mert §10.8 szerint „eljött az idő" nem indok — és egy default érték pont visszacsempészte volna az órát a rekordba, más néven. Egy elsimító default hibává minősítése ritka és jó irány.

---

## 2. Új találások

### Ö-1 · P1 · A Reader kiolvas, arbitrál, tervet készít — és a kimenetét egyetlen produkciós kód sem olvassa vissza

**Amit mértem.** A `case_evidence_packets` táblát a teljes produkciós kódbázisban három hely érinti:

| Hely | Mit csinál |
|---|---|
| `reader-cycle.ts:136` | **ír** (INSERT) |
| `reader-cycle.ts:109` | olvassa a saját `MAX(created_at)`-jét — „mikor néztem ezt az ügyet utoljára" |
| `retention.ts:67` | 90 nap után **kinullázza** a `packet_json`/`plan_json` mezőt |

Sem a `progression-pipeline.ts`, sem a `src/web/routes/`, sem a `cos-cycle.ts` riport, sem a Mission Control progression view nem olvassa. A `final_decision`, `conflict_reason`, `reader_candidate`, `safe_fallback_decision`, `decided_by` és `plan_json` **írás-only oszlopok**.

Közben a valódi döntés útja változatlan: `runProgressionCycle` ma is `buildRollingPlan`-t hív (`progression-pipeline.ts:786, 835, 859`), és a `planFromEvidence` kimenete (`reader-cycle.ts:270`) nem éri el.

**Miért hiba.** A `task-config.json` szerint a ciklus `*/10 * * * *`, tehát napi 144 futás; `COS_READ_PER_CYCLE ?? 3` (`progression-heartbeat-runner.ts:59`), és a `casesNeedingReading` **nem** ejti ki véglegesen az ügyet (a `:109` lekérdezés az utolsó olvasás óta történt haladást nézi) — ez tehát ismétlődő költség, nem egyszeri. Napi legfeljebb 432 modellhívás, mindegyik egy teljes ügy-kontextussal, aminek a teljes hozadéka egy tábla, amit 90 nap múlva kinullázunk.

Ez nem biztonsági hiba, hanem a rendszer legdrágább no-op-ja. És pontosan az a mintázat, amit a #1–#4 review a fő problémának nevezett — most a lánc *kimeneti* oldalán: a #3 kör azt találta, hogy a Reader-láncnak nincs hívója, a #4 azt, hogy már van; ebben a körben az derül ki, hogy a hívó *bemenetet* adott neki, olvasót nem.

**Javaslat.** Két lépés, sorrendben:
1. **Láthatóság most.** A `Reader:` JSON már közli az aggregátumokat; a Mission Controlban egy ügynél mutatni kellene a legutolsó packet `final_decision` + `decided_by` + `conflict_reason` hármasát. Ez egy `SELECT`, és attól a naptól kezdve valaki *látja*, mit talált a Reader.
2. **Bekötés utána.** A `final_decision` beengedése a pipeline-ba §13.1 arbitrációs kérdés, nem egy `if` — de amíg 1. nincs meg, a 2.-höz nincs is bizonyíték arról, hogy a Reader javaslatai jók-e. Az 1. lépés a 2. DoD-je.

---

### Ö-2 · P1 · A `goal-enrichment` ugyanazt a tartalmat küldi ki, ugyanabban a ciklusban, érzékenységi kapu nélkül

**Amit mértem.**

```
$ grep -n "provider\|sensitivity\|isProviderAllowed" src/cos/goal-enrichment.ts
(nincs találat)
```

A hívási lánc (`scripts/progression-heartbeat-runner.ts`):

| sor | mit hív | kapu |
|---|---|---|
| `:65` | `resolveInterpreter(getSecret)` — **egy** kliens, tier nélkül | — |
| `:80` | `enrichPendingGoals(db, interp.client, ENRICH_PER_CYCLE)` — `?? 5` ügy/ciklus | **nincs** |
| `:106` | `resolveReaderInterpreters(...)` — két útvonal | — |
| `:112` | `runReaderPass(...)` — `?? 3` ügy/ciklus | **§10 kapu** |

A `goal-enrichment.ts:73` `bestContentFor` a `cos_documents` `email_thread` rekordból **12 000 karakterig nyers levélszálat** ad át; az `enrichCaseGoal` (`progression-pipeline.ts:545`) ezt továbbadja az `interpretGoal`-nak. A `domainGuard` ott van (`:567`), az érzékenységi kapu nincs — a `domainGuard` azt védi, hogy a *rossz ügy* tartalmát ne olvassuk, nem azt, hogy a jó ügyé hova megy ki.

**Miért hiba ma is, nem csak elvben.** A `resolveInterpreter` (`interpreter-provider.ts:69`) sorrendje: env Anthropic kulcs → env auth token → **vault** `ANTHROPIC_API_KEY` → **vault `DEEPSEEK_API_KEY`**. Ma Anthropicra esik, mert van vault-kulcs. Ha az a kulcs lejár vagy kikerül, a függvény **csendben** DeepSeekre vált — és ugyanaz a HIGHLY_SENSITIVE levélszál, amit a Reader ugyanebben a ciklusban `SENSITIVITY_BLOCKED`-dal visszatartott volna, harminc sorral feljebb kimegy. A rendszer ilyenkor nem hibát ír, hanem `provider: "deepseek"`-et — egy mezőt egy JSON sorban, amit senki nem néz szolgáltatóváltásként.

Ez N4-1 pontos alakja a testvér-úton, ugyanabban a `try` blokkban, a javítás mellett.

**Javaslat.** A kapu már létezik és pontosan ide illik. Az `enrichPendingGoals` kapjon `{general, contracted}` útvonalpárt a `resolveReaderInterpreters`-től, és ügyenként — a `bestContentFor` tartalmán `effectiveSensitivity`-vel, vagy egyszerűbben az ügy deklarált tierjén `escalateSensitivity`-vel — válasszon utat; ami nem fér el, az legyen kihagyva és **megszámolva**, ugyanúgy, ahogy a Reader teszi. Nagyságrendileg tíz sor, és a `provider-data-policy.ts` minden szükséges függvénye exportált.

---

### Ö-3 · P2 · Az `/api/cos/interpret-answer` végpont nem látja a vaultot — és a hibája „nem elérhető"-nek látszik

**Amit mértem.** `src/web/routes/cos.ts:563`: `const client = new AnthropicLlmClient()`, argumentum nélkül. A konstruktor (`progression-interpreter.ts:84-90`) ilyenkor `apiKey: undefined`-et tárol, a `getClient()` pedig `this.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN`-t ad az SDK-nak. **A vault nincs benne.**

Az `e17e710` commit indoklása szó szerint az, hogy a kulcs a vaultba került, és az env-only keresés nem látta — „egy kulcs, amit senki nem olvas, ugyanaz, mint a nincs kulcs". A javítás a `resolveInterpreter`-be ment; ez a végpont nem kapta meg. A `README.md:283` ráadásul kifejezetten azt írja, hogy OAuth token mellé **ne** állítsunk be `ANTHROPIC_API_KEY`-t — vagyis a javasolt telepítésben az env pont üres.

**Miért nem látszik.** A `catch` ág `{ ok: false, reason: 'az értelmező nem érhető el: ...' }`-t ad vissza, a felület pedig „visszaesik sima szövegbevitelre, ami mindig működött". Ez jó UX és rossz diagnosztika: egy soha nem működő végpont megkülönböztethetetlen egy időnként túlterhelt modelltől. Ugyanaz az „ismétlődő hiba, amit senki nem lát" eset, amit a `personal-case-wake/SKILL.md` maga tilt.

**Mellékesen.** Ezen az úton sincs érzékenységi kapu (ügycím + a tulajdonos válasza megy ki), de a kitettség kisebb: egy hívás, Istvan a képernyő előtt, nem ír állapotot. Elég, ha a kliens ugyanonnan jön, mint máshol.

**Javaslat.** `resolveInterpreter(getSecret)` itt is, `null` esetén pedig a `reason` mondja meg, hogy **nincs konfigurált értelmező**, ne azt, hogy „nem érhető el".

---

### Ö-4 · P2 · Két érzékenységi tábla, két válasz ugyanarra a tartalomra — és egy mező, ami a régit állítja

**Amit mértem.** `sensitivity.ts:107-112` `PROFILE_ALLOWLIST` szerint `SENSITIVE_PERSONAL` csak `premium_reasoning`/`build_strong`, `HIGHLY_SENSITIVE` csak `premium_reasoning` profilba mehet. Az olvasási út ezeket a tiereket ma a `claude-haiku-4-5-20251001`-re küldi, aminek a deklarált profilja `INTERPRETER_PROFILE.anthropic = 'analysis_efficient'` (`interpreter-provider.ts:49-52`) — egy profil, amit az allowlist ezekre a tierekre **tilt**.

**Ez nem a döntés kritikája.** A `provider-data-policy.ts` fejléce világosan levezeti, miért volt a régi szabály az árkategória és a szolgáltató egybeesésére építve, és hogy a döntés Istváné. Egy Anthropic Haikutól sensitive ügyet megtagadni tényleg nem véd semmit, ha ugyanaz a szolgáltató ugyanazon feltételekkel kapja meg Opus-szal.

**A hiba a maradék.** A `ResolvedInterpreter.profile` mező négy helyen fel van töltve (`:88`, `:103`, `:144`, `:163`) és **sehol nincs kiolvasva** — `grep -rn "INTERPRETER_PROFILE" src/ scripts/` csak a definíciót és a négy értékadást adja. Egy mező, ami egy policy-állítást hordoz, amit senki nem ellenőriz, pontosan az, amit a következő ember ellenőrizni fog: elég egyszer átadni az `isProfileAllowedForSensitivity`-nek, és a Reader minden sensitive ügye elakad — vagy fordítva, valaki a jelenlétéből arra következtet, hogy a profil-kapu itt is fut.

**Javaslat.** Vagy tűnjön el a mező az olvasási útról, vagy a `PROFILE_ALLOWLIST` fejléce mondja ki, hogy az olvasási útra a `provider-data-policy` a mérvadó. A két táblának egy helyről kell hivatkoznia egymásra, különben a következő olvasó az egyiket találja meg.

---

### Ö-5 · P3 · A két standing check csak a `src/cos` könyvtárat pásztázza

`cos-gate-permit.test.ts:76` és `:88` `readdirSync(join(process.cwd(), 'src/cos'))`-t használ. Egy `issueAuthorization` hívás `src/web/routes/`-ból vagy `scripts/`-ből ma **átcsúszna** mindkét ellenőrzésen. Ellenőriztem: ilyen hívó jelenleg nincs (`grep -rn "issueAuthorization(" src/ scripts/` → két hívó, mindkettő a `src/cos`-ban), tehát ez latens.

Viszont a standing check egész értelme a *holnapi* hívó, és a kódbázis már bizonyította, hogy a hívók rétegek között mozognak (a kill-switchnek pont azért kellett CLI is, mert „egy kapcsoló, ami csak a dashboardon van…"). A `readdirSync` cserélje le a `src` + `scripts` rekurzív bejárására — a `test` fájl már használ `readFileSync`-et, tehát nem új függőség.

---

## 3. Ami régről nyitva van (nem romlott, nem javult)

| # | Találás | Állapot | Bizonyíték |
|---|---|---|---|
| **N-4** | Az `approval_version` a `campaign_version` másolata | **VÁLTOZATLAN** | `approval-core.ts:354` — `approvalVersion: appr.campaign_version` |
| **N-5** | A marker-kapu hívó nélküli függvényen ül | **VÁLTOZATLAN** | `connector-health.ts:96` `setMode` az egyetlen út, produkciós hívó nélkül |
| §12/§4.2 | `evidence-planner.ts` bekötése | **RÉSZBEN JAVULT** | `planFromEvidence` már hívva van (`reader-cycle.ts:270`) — de a kimenete az Ö-1 zsákutcába fut |

---

## 4. Minőség — ami kiemelkedő ebben a körben

Nem a javítások száma, hanem a fajtájuk:

- **A saját kimenet elolvasása.** A `progression-heartbeat-runner.ts:113-118` kommentje egy olyan hibát dokumentál, amit úgy találtak meg, hogy elolvasták a saját első éles JSON-jukat, és nem tudták megmondani, hogy a `remaining: 98` melyik alrendszeré. A javítás (beágyazott `reader` objektum) kicsi; a megtalálás módja nem.
- **Az élő eset visszavezetése a formátumig.** `context-builder.ts:224-233`: egy valódi ügy (PRI-HOME-2026-002) packetje elbukott, mert a provenance-referencia `doc-abc (chatgpt-cos-drive)` volt, a modell pedig — helyesen — `doc-abc`-t idézett. A javítás a *formátumot* változtatta, nem az ellenőrzést lazította, és a komment megindokolja, miért: a prefix-egyezés pont azt az egy őrt gyengítené, ami a nem létező forrásra hivatkozó packetet fogja meg.
- **A tünet kezelésének elutasítása.** `interpreter-provider.ts:110-119`: a `READER_MAX_TOKENS = 16384` mellett ott áll, hogy a bemeneti oldalt *ugyanakkor* korlátozták, mert „ennek az emelése önmagában a tünet kezelése lett volna".
- **Ellenpróbás tesztek.** Mindhárom új teszt-fájl tartalmaz olyan esetet, ami *átmegy* a kapun (a PERSONAL ügy az olcsó útra, a mintázott-és-engedélyezett permit jegyet kap, az ablakon belüli packet érintetlen). Egy kapu, ami mindent tilt, nem kapu — és ez itt mérve van, nem feltételezve.

---

## 5. Javasolt sorrend

1. **Ö-2** — tíz sor, egy nyitott adat-kimeneti út zárása. A kapu már megvan, csak a testvér-útra nincs rákötve.
2. **Ö-1 első fele** — a legutolsó packet `final_decision`/`decided_by`/`conflict_reason` megjelenítése a Mission Controlban. Ez egy `SELECT`, és ettől kezdve a napi 432 hívásnak van olvasója.
3. **Ö-3** — `resolveInterpreter` a végponton, és a `reason` mondja meg a különbséget „nincs konfigurálva" és „nem válaszol" között.
4. **Ö-4** — a `profile` mező vagy tűnjön el, vagy a két tábla hivatkozzon egymásra.
5. **Ö-5**, **N-4**, **N-5** — amikor sorra kerülnek.

Az **Ö-1 második fele** (a Reader döntésének beengedése a pipeline-ba) nem ebbe a sorrendbe tartozik: annak a DoD-je a 2. pont, és az arbitráció §13.1 szerinti kérdés, nem beillesztési feladat.

---

## 6. A minta állása öt kör után

Négy körön át ugyanaz a mondat írta le a rendszer fő hibáját: *a kapu megépül, és nem kerül a forgalomba.* Az ötödik kör után ez a mondat még mindig igaz, de már nem ugyanazon a helyen: a kapuk **bekerültek** a forgalomba — az érzékenységi kapu az utolsó sor a hívás előtt, a permit-ellenőrzés az `issueAuthorization` első sora, a retention a karbantartási ciklusban. Ami kimaradt, az a lánc *túlsó* vége: a Reader válaszát senki nem kérdezi vissza (Ö-1), és a mellette futó testvér-út nem kapta meg a kaput (Ö-2).

Ez előrelépés, és érdemes kimondani: a hibaosztály a bemenetről a kimenetre költözött, ami azt jelenti, hogy a bemeneti oldal megoldódott. A következő kör kérdése egyetlen mondat: **ki olvassa el, amit a Reader írt?**
