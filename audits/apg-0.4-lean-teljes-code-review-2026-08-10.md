# APG 0.4 Lean — teljes funkcionális és minőségi code review a repóbeli specifikációval szemben

**Dátum:** 2026-08-10 · **Ág:** `claude/marveen-cos-code-review-qe1z7m`
**Repók:** `marveen-private` (`develop` HEAD `106c813`) + `marveen-apg-kernel` (HEAD `152b99d`)
**Kérte:** Istvan — „teljes code review a marveen APG 0.4 lean funkcióján a repóban található specifikációval szemben, teljes funkcionális és quality review".

**Mérce (a repóban található specifikációk):**

- `docs/apg/apg-0.4-lean-ui-integration-spec.md` — az owner-spec, 28 szakasz + 24 elfogadási kritérium + verdikt-követelmény (ez a „0.4 lean funkció")
- `design/apg-v0.4-pilot-kernel-implementation-spec.md` + `-component-contracts.yaml` + `-store-schema.sql` + `-work-items.yaml` — a sidecar kernel
- Kontextus: `audits/apg-1.8-gap-map.md` (a kernel már az 1.8 spec felé mozdult — ez a review egyik központi találása)

**Amit ténylegesen futtattam (nem állítás, mérés):**

| Kapu | Eredmény |
|---|---|
| `npx tsc --noEmit` (marveen-private) | **zöld** |
| `npx vitest run` a 3 APG teszt-fájlon | **41/41 zöld** (11 projection + 28 route + 2 epoch-bug) |
| `python3 -m unittest discover -s tests` (kernel, tiszta checkout) | 432 teszt, **131 nem fut le**: 122 error + 9 fail. 115 közülük `FileNotFoundError` a `/home/iszzu/marveen-local/...` beégetett útvonalakra |
| Hívó-követés `grep`-pel `src/`, `web/`, `src/web/routes/` fákon | lásd a halott-kapcsoló szakaszt |

---

## 0. Verdikt

A spec §151 három verdiktet enged. Az enyém: **`APG_0_4_LEAN_UI_RETURN_FOR_FIX`**.

Nem azért, mert a munka gyenge — a felépítés jó, a határok tiszták, az off-mód valódi no-op, az XSS-fegyelem következetes, és a scope-override precedencia helyesen van megírva. Hanem mert a §24 huszonnégy elfogadási kritériumából **legalább nyolc bizonyíthatóan nem teljesül**, és kettő olyan §27-es stop-conditiont érint, amire a spec kifejezetten azt mondja: állj meg és jelents RETURN_FOR_FIX-et.

A kép egy mondatban: **a kontrollréteg felülete kész, a kontroll maga nagyrészt nem.** Négy enforcement kapcsolóból három semmit nem csinál, a „független elfogadás" fogalma sehol nem létezik az adatmodellben, a döntési végpont nem ír receiptet a sidecarba, és az egyetlen valóban blokkoló kapu (archiválás) a sidecar kiesésekor **kinyílik** ahelyett, hogy zárva maradna.

Emellett a két repó időközben szétcsúszott: a kernel átnevezte a `NOT_APPLICABLE` checkpoint-eredményt `EXCLUDED`-ra és bevezette az `ERROR`-t (`b2dafc5`), a UI-projekció viszont még a régi nevet ismeri — így egy „nem alkalmazható" kapu ma **„Végrehajtás alatt"-ként** jelenik meg a felületen.

---

## 1. Funkcionális megfelelés — szakaszonként

### 1.1 Architektúra és határok (§1, §2, §22, §25, §26)

| Követelmény | Állapot | Bizonyíték |
|---|---|---|
| §1.1 Nincs új APG főmenüpont | **IGEN** | `web/index.html`: 20 `data-page` érték, egyik sem APG; három additív, `hidden` div a mount-pontokhoz |
| §1.2 Nincs második Kanban | **IGEN** | badge + quick filter a meglévő kártyákon, nincs új oszlop |
| §1.3 Nincs második approval-rendszer | **RÉSZBEN** | a generikus `approvals` táblát használja (`category='apg_decision'`), az enumot nem bővíti — jó. **De** a spec ugyanitt azt kéri, hogy „az APG-specifikus döntés részletes jelentése az APG sidecarban legyen receiptként"; ilyen receipt nem születik (lásd F-4) |
| §1.4 A sidecar az authority, a UI csak projekció | **IGEN** | `openApgKernelReadonly()` `readonly: true, fileMustExist: true`; a UI sehol nem ír a sidecarba; a scope-override store külön fájl, és a fejléce ki is mondja, hogy nem domain-igazság |
| §1.5 A módszertan nem változik | **IGEN** | a UI nem definiál új lifecycle-t/taxonómiát |
| §2 Fájlhatárok | **IGEN** | pontosan a preferált fájllista épült meg (`src/apg/ui-*.ts`, `src/web/routes/apg.ts`, `web/apg.{js,css}`, `docs/apg-ui.md` + `docs/en/apg-ui.md`) |
| §2.1 Frontend-hook, nem DOM-scraping | **IGEN, a preferált módon** | a hat generikus esemény tényleg dispatch-elődik az `app.js`-ből (`800`, `1229`, `2388`, `11540`, `12923`, `13467`), az `apg.js` ezekre iratkozik fel; **nincs MutationObserver** |
| §2.2 Vanilla stack | **IGEN** | nincs új dependency |
| §22 Backward compat / `APG_MODE=off` | **IGEN** | `default: 'off'`, minden mount-pont `hidden`, az approvals-blokk külön ellenőrzi az off-módot, hogy üres szekció se rendereljen |
| §25 Rollback konfigurációval | **IGEN** | `APG_MODE=off` elég; a scope-override és a sidecar megmarad |
| §26 Upstream/lokális szétválasztás | **IGEN** | a generikus események tiszta upstream-jelöltek, az APG-domain a saját moduljaiban van |

Ez a rész **jól van megcsinálva** — a spec legnehezebben tartható elve (updateability, minimális core-diff) teljesül.

### 1.2 Üzemmódok és kikapcsolhatóság (§3, §4)

| Követelmény | Állapot | Bizonyíték / hiány |
|---|---|---|
| §3 négy üzemmód a registryben | **IGEN** | `config-registry.ts:467`, `valueSet: ['off','observe','assisted','enforced']`, `requiresRestart: false` |
| §3.4 Kötelező kapuk viselkedése | **NEM** | a négy megígért szabályból (receipt nélküli `VERIFIED_CURRENT` tilos; producer nem lehet saját accepter; owner-döntés nélkül nem nyílik a kapu; nincs auto-deploy) **egyik sincs implementálva**. A `deriveDisplayState` és a `claimStatus` nem ismeri a módot; az enforced és az observe mód ugyanazt a projekciót adja, egyetlen kivétellel (archiválás) |
| §3 Store elérhetetlen: off/observe fail-open, assisted „nem elérhető", enforced **fail-closed** | **RÉSZBEN, és a fontos fele fordítva** | a *megjelenítés* jól kezeli (`unavailableSummary` megőrzi a valódi módot, és ezt egy szép komment indokolja is). **De** az egyetlen tényleges blokkoló út — az archiválás-kapu — a lekérés hibájánál `catch { return /* fail-open */ }` (`web/apg.js:1077`), **enforced módban is**. A sidecar kiesése tehát pont a kötelező kapu módban nyitja ki a kaput |
| §4.1 Master toggle, default off | **IGEN** | |
| §4.2 Hat UI surface toggle | **RÉSZBEN** | öt megvan és hat is a summaryben; **`APG_OWNER_NOTIFICATIONS`-nak nulla fogyasztója van** — owner-értesítés soha nem megy ki |
| §4.3 Négy enforcement toggle | **1/4** | csak az `APG_BLOCK_UNACCEPTED_ARCHIVE`-ot olvassa bárki (`web/apg.js:1068+`). `APG_REQUIRE_CLAIM_RECEIPT`, `APG_REQUIRE_INDEPENDENT_ACCEPTANCE`, `APG_REQUIRE_OWNER_DECISION` a summaryben megjelenik, az `enforcementState`-be be is másolódik — és **soha nem olvassa senki** (`grep`: a 105-121. sorokon kívül nincs hivatkozás) |
| §4.4 Pending owner-döntés nem válhat láthatatlanná | **VALÓSZÍNŰLEG IGEN** | az APG döntések generikus `approvals` sorok, tehát a generikus lista mutatja őket akkor is, ha az enhancement ki van kapcsolva — de erre nincs teszt, és a §12.7 sidebar-badge számolást sem találtam |
| §4.5 Scope override precedencia + „globális off abszolút master off" | **IGEN a rezolverben, NEM a végpontokon** | `resolveEffectiveApgMode` helyes és tesztelt. **De** (a) a `requestedMode` (`routes/apg.ts:97`) engedi, hogy a hívó `?mode=enforced`-dal felülírja az egészet, globális off mellett is; (b) a detail/claims/receipts/events útvonalak a **work item id-t adják át kanban-kártya id-ként** — egy valódi, 8 hexes kártyára rögzített override sosem talál; (c) a `summaryFor` minden elemre beégeti a `mode_source: 'global'`-t (`ui-projection.ts:644`), tehát a §4.5 által kért „honnan öröklődött" tooltip minden munkaelemen hamis |

### 1.3 Read model és API (§5, §6, §7)

| Követelmény | Állapot | Megjegyzés |
|---|---|---|
| §5 Nyolc display state + HU/EN/ikon/CSS/leírás/severity | **IGEN** | `ui-types.ts` `APG_DISPLAY_STATE_META` — teljes, egy helyen, ahogy a spec kéri |
| §6.1 `ApgUiSummary` | **IGEN** | minden mező megvan |
| §6.2 `ApgUiWorkItemSummary` 18 mezője | **RÉSZBEN — 6 mező konstans** | `project: null` (`:641`), `mode_source: 'global'` (`:644`), `risk: 'unknown'` (`:647`), `producer_agent: null` (`:650`), `accepter_agent: null` (`:651`), és `internal_state = display_state` — vagyis a spec által megkülönböztetni kért kanonikus belső állapot és a megjelenített állapot **ugyanaz az érték**. A `title` a logikai azonosító, nem cím |
| §6.3 Work item detail | **RÉSZBEN** | `goal: ''`, `scope: ''`, `rollback_info: null`, producer/accepter null. A `receipts` tömb valójában ugyanaz az `evidence_references` halmaz, mint a `claims` — a `/claims` és a `/receipts` végpont ugyanazt az adatot adja vissza két néven |
| §6.4 Determinisztikus, replay-azonos projekció; hiányos record ne dobja el az oldalt; **sérült elem külön `projection_error`-t kapjon**; unknownból ne legyen implicit success | **RÉSZBEN, egy fontos hibával** | a determinizmus rendben (nincs `now()` a projekcióban, minden rendezés stabil). **De** a `rowsOrEmpty` (`:228`) **minden** olvasási hibát üres tömbre nyel: ha pl. az `assisted_recommendations` olvashatatlan, az összes munkaelem elveszti a javaslatát, a display state csendben átbillen, a válasz mégis `enabled: true` és `projection_error` nélkül érkezik. Ez pont az, amit a §6.4 és a §8.3 tilt |
| §7.1 Read végpontok | **IGEN** | mind a hét megvan, limit default 50 / max 500 helyesen |
| §7.2 Scope override write + actor + reason + audit | **IGEN** | `setScopeOverride` az enforced-ből lefelé váltásnál kötelező indokot kér — pontosan a spec szerint |
| §7.3 Owner decision végpont | **RÉSZBEN** | a mapping (accept→approved, a másik három→rejected) és a `resolved_by: 'dashboard'` helyes. **Hiányzik**: az APG decision receipt appendelése, a projekció frissítése és az „új effective state" visszaadása. A válasz a nyers approval sor + `apg_action` |
| §7.4 Idempotencia + 409 | **IGEN** | fájl-alapú replay store, a 409 szövege és a teszt is megvan. Két apró gond: a read-modify-write nem atomikus (két párhuzamos, *különböző* approval-döntés egyike elveszhet a store-ból), és a fájl korlátlanul nő |
| §7.5 Részleges write failure → repair-needed event | **NEM** | nincs receipt-írás, tehát nincs mit félbehagyni — de a spec által kért `repair_needed` esemény és a degraded figyelmeztetés így sem létezik |

### 1.4 Felületek (§8–§15)

| Követelmény | Állapot | Megjegyzés |
|---|---|---|
| §8 Áttekintés strip + max 5 figyelemelem + empty + degraded | **IGEN** | a rendezés a spec prioritási sorrendjét követi (`attentionPriority`), az empty és a degraded szöveg külön van |
| §9.1 Kanban badge | **IGEN** | kétsoros, kompakt, tooltipes |
| §9.2 „Elkészült ≠ elfogadva" | **IGEN a megjelenítésben, NEM a tartalomban** | a UI helyesen külön kezeli a két címkét (`apg.js:465-472`) — de az „elfogadva" mögött nincs független elfogadó (lásd F-2) |
| §9.3 Öt quick filter | **IGEN** | |
| §9.4 Nincs új oszlop | **IGEN** | |
| §9.5 Archiválás-kapu | **RÉSZBEN** | enforced → `window.alert` + `preventDefault`. **Hiányzik** a spec által kért manuális owner-override (megerősítés + kötelező indok + audit receipt) — az enforced blokk ma feloldhatatlan a felületről. És a fail-open hiba-ág (fent) |
| §10.2 Folyamat-stepper | **NEM** | a kártya-részlet egy modal, benne állapot-pill + next action + claim-lista + esemény-lista. Stepper nincs |
| §10.4 Öt belső tab (Áttekintés / Bizonyítékok / Végrehajtás / Döntések / Audit) | **NEM** | egyetlen lapos nézet |
| §10.5 Progressive disclosure | **IGEN** | `<details>` „Technikai részletek" blokk, az evidence toggle mögé kötve |
| §11 Claim sor mezői + hét státusz | **RÉSZBEN** | a hét státuszból **hármat (`VERIFIED_HISTORICAL`, `CONFLICTING_EVIDENCE`, `STALE_OR_SUPERSEDED`) a `claimStatus` sosem ad vissza** — csak a szöveg-táblában szerepelnek. A `claim_counts.conflicting` ezért szerkezetileg mindig 0. A `verifier` és a `superseded_by` mindig `null` |
| §11.1 „Ne legyen hamis zöld" | **NEM** | lásd F-1 |
| §11.2 Replay eredmény a receipt-részletben | **NEM** | nincs replay-információ a UI-ban |
| §12.1 APG filter a Jóváhagyásokon | **RÉSZBEN** | külön APG-blokk van, a spec által kért hatállású filtersor (Összes/APG/Műveleti/Függő/Lezárt/Lejárt) nincs |
| §12.2–12.3 Döntési kártya kötelező információ-sorrendje | **NEM** | a kártya: állapot-pill + `action_description` + `agent_id` + négy gomb. Hiányzik az APG-ajánlás, a bizonyított tények, az unknown/conflict, a kockázat, és **az elfogadás/elutasítás következménye** — a spec ezt „mindig"-nek jelöli |
| §12.4 Kötelező note | **1/3** | csak a `block` kér indokot (`window.prompt`). A `return_for_fix` („kötelező indok") és a `request_evidence` („kötelező mi hiányzik") indok nélkül elmegy. Az accept high/critical kockázatnál kötelező note-ja elérhetetlen, mert a `risk` mindig `unknown` |
| §12.5 Megerősítő ablak konkrét szöveggel | **NEM** | `window.confirm` / `window.prompt`. A spec kifejezetten felsorolja, mit kell tartalmaznia (munkaelem, döntés, következő állapot, várható side effect, visszavonhatóság, note mező) — natív dialógusban ez nem fér el, és a §17 fókusz-csapda/ARIA követelményei sem értelmezhetők rá |
| §12.6 Már eldöntött | **IGEN** | 409 + a helyes üzenet |
| §12.7 Sidebar pending badge számolja az APG-t is | **NEM TALÁLTAM** | nincs erre kód és nincs teszt |
| §13 Aktivitás feed | **A FŐ FEED NEM MŰKÖDIK** | lásd F-3 — a `/api/apg/events` végpont produkcióban mindig hibát ad |
| §14 Beállítások UI | **RÉSZBEN** | a registry-alapú kapcsolók megjelennek, a scope-override tábla és form is. A §14.6 diagnosztika (sidecar elérhető / projection verzió / utolsó sikeres frissítés / projection hibák / repair-needed) nem külön blokk |
| §15 Mode chip mindenhol + öröklés-tooltip | **RÉSZBEN** | a chip megvan, a tooltip forrása viszont a hibás `mode_source` miatt mindig „globális" |

### 1.5 Keresztmetsző követelmények (§16–§21, §23)

| Követelmény | Állapot | Megjegyzés |
|---|---|---|
| §16 Mobil (390/768/1440) | **GYENGE** | egyetlen `@media (max-width: 520px)` breakpoint az `apg.css`-ben; a döntési akciók sticky alsó sávja, a tabok vízszintes scrollja és a rövidített+másolható receipt ID nincs meg (utóbbi kettő tárgytalan is, mert tabok nincsenek) |
| §17 Accessibility | **GYENGE** | 1100 sorban **két** `aria-` attribútum. Az Escape-zárás megvan (`apg.js:1093`), fókusz-csapda, fókusz-visszaállítás, ikon-only gombok ARIA-címkéje és live region nincs |
| §18 I18N, nincs hardcoded magyar a JS-ben, a backend enumot adjon | **NEM** | 90 `apg.*` kulcs mindkét nyelvi fájlban — ez a jó hír. A rossz: a **backend magyar prózát ad vissza** (`attentionReason`, `nextActionFor`, `allowedWordingFor` a `ui-projection.ts`-ben), és a frontend ezt hat helyen nyersen kirakja (`apg.js:152,153,271,482,583,837`). Ezen felül `formatAge` magyar szavakat ad (`apg.js:67`) és `formatDate` `'hu-HU'` locale-ra van drótozva (`:79`). EN nyelven a felület magyarul beszél |
| §19.1 Redaction | **NINCS IMPLEMENTÁLVA** | nulla `redact`/allowlist a `src/apg/`-ben. A `ref_locator` nyersen megy ki `source`-ként. Ma valószínűleg ártalmatlan (a kernel digest+locator fegyelme jó), de a spec ezt a UI oldalán kéri, és nincs teszt rá (§23.1 kifejezetten felsorolja) |
| §19.2 XSS | **IGEN, következetesen** | minden beszúrás `html()`/`attr()` escape-en megy át, nincs nyers `innerHTML` adatra |
| §19.3 Döntési jogosultság | **RÉSZBEN — lásd F-5** | `resolved_by: 'dashboard'` helyes, de az önjóváhagyás-ellenőrzés kimarad |
| §19.4 Audit | **RÉSZBEN** | `apg-ui-audit.jsonl`: mode/toggle-változás nincs benne, scope override és owner decision igen; projection error és archive override nincs |
| §20 Performance | **RÉSZBEN** | a summary 10 s TTL + mtime-invalidáció mögött van (jó). **De** a lista- és detail-végpont **nem cache-elt**, és mindegyik hívás **hat tábla teljes tartalmát** beolvassa `LIMIT` nélkül, majd memóriában lapoz. Polling egyáltalán nincs (sem 30 s, sem 10–15 s), tehát a „page hidden → ne polloljon" tárgytalan; a kérés-átfedést sorszám-őrök kezelik AbortController helyett |
| §21 Empty/loading/error/degraded | **IGEN** | végig kezelt, és hiba esetén sosem vált zöldre |
| §23.1 Backend unit (13 nevesített eset) | **~5/13** | megvan: display-state mapping, mode-precedencia, global off master, pagináció, idempotens döntés, 409. **Nincs**: claim count projekció, gate progress projekció, done-not-accepted, sérült record kezelése, secret redaction, approval/receipt részleges hiba, enforced fail-closed, observe fail-open |
| §23.2 API contract (13 eset) | **~8/13** | hiányzik: invalid action egy része, missing note (mert nincs is követelmény), off mode, unavailable sidecar detail-oldalon |
| §23.3 Frontend contract (11 állítás) | **0** | nincs `apg.js`-re néző contract teszt |
| §23.4 Hét integrációs fixture | **0** | egyik forgatókönyv sincs lefedve |
| §23.5 Nyolc képernyőkép | **nem találtam** a repóban |
| §24 Elfogadási kritériumok | **≥8 nem teljesül** | lásd alább |

### 1.6 A §24 lista — ami bizonyíthatóan nem teljesül

1. „**enforcement toggle-ok működnek**" — háromból három inert (F-6).
2. „**effective mode mindenhol látszik**" — a `mode_source` minden munkaelemen hamis (F-7).
3. „**producer nem tudja magát elfogadni**" — nincs accepter-fogalom az adatmodellben, a toggle inert, és a döntési végpont kihagyja az önjóváhagyás-ellenőrzést (F-2, F-5, F-6).
4. „**claim status + allowed wording megjelenik**" — megjelenik, de a hét státuszból három elérhetetlen, és a zöld hamis lehet (F-1).
5. „**unknownból nem success**" — a kernel `EXCLUDED`/`ERROR` eredménye „Végrehajtás alatt"-ra képződik (F-8); a sérült tábla üres tábla lesz `projection_error` nélkül (F-9).
6. „**enforced store outage fail-closed**" — az egyetlen blokkoló kapu ilyenkor kinyílik (F-10).
7. „**HU/EN teljes**" — a backend magyar prózát ad, a dátum/kor formázás magyarra van drótozva (F-11).
8. „**minden releváns teszt zöld**" — a UI-tesztek zöldek, de a §23 által kért három tesztosztályból kettő nem létezik; a kernel oldalán 131 teszt nem futtatható a tulajdonos gépén kívül (K-1).

---

## 2. Találások súlyosság szerint

### F-1 · P0 · Hamis zöld: egy `spec_ready` PASS „aktuális, igazolt ténnyé" minősít egy bizonyítékot

`src/apg/ui-projection.ts:561`

```ts
if (receipt && candidate.checkpoints.some(cp =>
      cp.replay_run_id === receipt.replay_run_id && cp.result === 'PASS')) {
  return 'VERIFIED_CURRENT'
}
```

Egy `evidence_references` sor `VERIFIED_CURRENT`-et (→ „Aktuális, igazolt tényként idézhető", zöld) kap, ha a státusza `PRESENT` **és ugyanabban a replay futásban bármelyik** checkpoint PASS-ra ment. A `spec_ready` PASS-nak semmi köze ahhoz, hogy a bizonyíték futásidőben igazolt-e. A §11.1 hat tiltott esetet sorol fel a hamis zöldre, és ezek közül kettő (hiányzó runtime verification; „csak fájl létezik") pontosan így áll elő.

**Javaslat.** A `VERIFIED_CURRENT` kösse magát a `runtime_acceptance` (vagy legalább a `verification_ready`) checkpointhoz és a receipt `runtime_status`-ához; minden más `PRESENT` sor `SUPPORTED_BUT_NOT_RUNTIME_VERIFIED`.

### F-2 · P0 · Az „elfogadva" nem elfogadás, hanem egy kapu-eredmény

`ui-projection.ts:170` (`deriveDisplayState`) + `:651` (`accepter_agent: null`)

`accepted` akkor áll elő, ha az utolsó checkpoint `PASS` és a neve `release_ready` vagy `runtime_acceptance`. Nincs elfogadó személy/ügynök, nincs elfogadási esemény, és az `accepter_agent` szerkezetileg `null`. A Kanban ezek után „Függetlenül elfogadva" címkét ír ki (`apg.js:466`).

A spec két helyen is pont ezt tiltja: §9.2 „SOHA ne mutasd acceptance-ként pusztán a done státuszt" (itt: pusztán a kapu státuszát), és a §24 „producer nem tudja magát elfogadni" — amit nem lehet betartani, ha nincs rögzítve, ki fogadott el.

Ugyanez az `acceptanceStatusFor` (`:542`): a `clarification` és az `evidence_needed` állapotból `returned` lesz, vagyis „visszaküldve javításra" — olyan esemény, ami sosem történt meg.

### F-3 · P0 · Az Aktivitás-végpont produkcióban mindig hibát ad

`ui-projection.ts:920`

```ts
const BetterSqlite3 = (globalThis as Record<string, unknown>).BetterSqlite3 as ...
if (!BetterSqlite3) return { error: 'BetterSqlite3 binding not available' }
```

A modul **tetején importált** `Database` helyett egy globálisra vár. `grep -rn "BetterSqlite3" src web` az egész repóban négy találatot ad — mind ebben a négy sorban. **Senki, sehol nem állítja be ezt a globált**, még a tesztek sem. A `GET /api/apg/events` tehát mindig `{ events: [], total: 0, error: 'BetterSqlite3 binding not available' }`-t ad, a §13 Aktivitás-feed központi végpontja halott. (A kártya-szintű `/work-items/:id/events` működik — az a `buildApgWorkItemDetail`-en megy.)

Egysoros javítás: használd az importált `Database`-t, ahogy az `openApgKernelReadonly()` teszi.

### F-4 · P0 · A döntés nem hagy nyomot a sidecarban

`src/web/routes/apg.ts:426-448`

A §7.3 öt lépést ír elő; a kód négyet csinál meg, és az ötödiket — „appendelj APG decision receiptet" — nem. Ami készül, az egy sor a `store/apg-ui-audit.jsonl`-ben, amiről a saját modulja (`apg-scope-overrides.ts` fejléc) mondja ki, hogy **nem** APG domain-igazság.

Következmények: (a) a négy döntés-altípus (`accept`/`return_for_fix`/`request_evidence`/`block`) a generikus approvalban `approved`/`rejected`-re olvad, és a spec által kért megkülönböztetés csak egy naplófájlban él; (b) a §7.5 részleges-írás-hiba forgatókönyv és a `repair_needed` esemény tárgytalan, mert nincs második írás; (c) a válasz nem adja vissza az „új effective state"-et, tehát a UI a döntés után nem tudja, mi lett a következő állapot.

### F-5 · P1 · A döntési végpont kihagyja az önjóváhagyás-ellenőrzést (§27 stop condition)

`routes/apg.ts:426` közvetlenül `resolveApproval(...)`-t hív. A generikus úton (`routes/approvals.ts:164`) ott van a guard:

```ts
if (target && resolved_by.trim() === target.agent_id) → 403
```

Az APG úton nincs megfelelője. Igaz, hogy a `resolved_by` beégetve `'dashboard'`, tehát a *hazug* kliens ellen a generikus guard sem véd (a saját kommentje is „best-effort"-nak nevezi, mert minden flotta-ügynök ugyanazt a bearer tokent használja). De az a naiv/véletlen önjóváhagyás, aminek az elkapására a guard készült, ezen az úton **ellenőrzés nélkül átmegy**. A §27 explicit stop-conditionje: „self-approval guardot gyengíteni kellene → állj meg, RETURN_FOR_FIX".

Egy sor javítja: `if (approval.agent_id && requesterIsSame) → 403`, vagy egyszerűen hívd a meglévő approvals-resolution utat.

### F-6 · P1 · Négy enforcement kapcsolóból három semmit nem csinál

`config-registry.ts:531/540/549` — a kapcsolók léteznek, a `/api/apg/summary` visszaadja őket, az `apg.js:105-121` beteszi az `enforcementState`-be, és **ott véget is ér**. A `grep` szerint a `require_claim_receipt`, `require_independent_acceptance` és `require_owner_decision` mezőt sehol nem olvassa senki.

A gyakorlati következmény ugyanaz, mint amit a COS-review a jóváhagyási boríténál írt: bekapcsolod a „Független acceptance megkövetelése" kapcsolót, a felület sikert jelez, és a korlát nem létezik. Ehhez jön az `APG_OWNER_NOTIFICATIONS`, aminek szintén nulla fogyasztója van.

### F-7 · P1 · A `mode_source` minden munkaelemen hamis, és a kártya-override a detail-úton nem talál

- `ui-projection.ts:644` — `mode_source: 'global'` beégetve minden `ApgUiWorkItemSummary`-be, akkor is, ha a route projekt- vagy kártya-override-ból oldotta fel a módot.
- `routes/apg.ts` a detail/claims/receipts/events útvonalakon `requestedMode(url, null, workItemId)`-t hív — a **work item logikai azonosítóját** adja át kanban-kártya azonosítóként. A `resolveEffectiveApgMode` egy 8 hexes kártya-id-t keres, tehát a valódi kártya-override sosem illeszkedik ezeken az útvonalakon.

A §4.5 utolsó mondata („a UI mindenhol mutassa az effective mode-ot + tooltip honnan öröklődött") és a §15 chip-tooltip emiatt félrevezet.

### F-8 · P1 · Két repó, egy szerződés, két igazság: `NOT_APPLICABLE` → `EXCLUDED`

- Kernel `b2dafc5` (`src/checkpoints.py:16`): `RESULT_VALUES = ["PASS","FAIL","UNKNOWN","ERROR","EXCLUDED"]`.
- UI `ui-projection.ts:174`: még mindig `input.latestCheckpointResult === 'NOT_APPLICABLE'`.

Egy `EXCLUDED` (gate-profil alapján nem alkalmazható) vagy `ERROR` (a végrehajtó nem adott érvényes kimenetet) eredmény tehát átesik minden ágon és a `return 'executing'`-re fut — a felületen **„Végrehajtás alatt"**. Egy nem futtatott és egy hibára futott kapu úgy néz ki, mint egy dolgozó folyamat. Ezen felül a `gate_progress.total` beleszámolja az `EXCLUDED` kapukat is, tehát a haladás-arány alábecsül.

Ehhez tartozik, hogy a kernel migrációja (`0001_initial_schema.sql:79`) a `result` oszlopra **nem tesz CHECK constraintet**, csak egy kommentet ír — ami ma már a régi enumot dokumentálja. Az elírt eredményérték csendben tárolódna.

**Javaslat.** Egy közös, verziózott eredmény-enum és egy szerződés-teszt, ami mindkét oldalon ugyanabból a listából dolgozik. A §1.4 („a sidecar az authority, a UI projekció") csak akkor tartható, ha a projekció szerződése tesztelt.

### F-9 · P1 · Egy sérült tábla „nincs adat"-ként jelenik meg, `projection_error` nélkül

`ui-projection.ts:228` — `rowsOrEmpty` minden kivételt üres tömbre nyel. A §6.4 kifejezetten azt kéri, hogy a sérült elem **külön `projection_error` jelzést** kapjon, a §8.3 pedig azt, hogy „ne írja »minden rendben«, ha a projection hibás". Ma egy olvashatatlan `assisted_recommendations` vagy `checkpoint_results` tábla mellett a summary `enabled: true`, nulla számlálókkal és üres figyelem-listával tér vissza — vagyis „az APG nem talált figyelmet igénylő folyamatot".

### F-10 · P1 · Az egyetlen valódi kapu a sidecar kiesésekor kinyílik (enforced fail-open)

`web/apg.js:1077` — `catch { return /* fail-open */ }` a munkaelem-lekérés köré, **mód-megkülönböztetés nélkül**. A §3 táblázata és a §24 („enforced store outage fail-closed") ennek az ellenkezőjét kéri: enforced módban az APG-kontrollált továbblépésnek zárva kell maradnia.

Ugyanitt hiányzik a §9.5 által kért manuális owner-override (megerősítés + kötelező indok + audit receipt) — az enforced blokk ma feloldhatatlan, ami a másik irányba téved.

### F-11 · P1 · A backend magyar prózát ad vissza, a frontend nyersen kirakja

`ui-projection.ts` `attentionReason` / `nextActionFor` / `allowedWordingFor` teljes magyar mondatokat ad; a `routes/apg.ts:416` 409-es hibaüzenete szintén magyar. A frontend hat helyen (`apg.js:152,153,271,482,583,837`) escape-eli és kiírja. Ezen felül `formatAge` (`:67`) magyar szavakat ad („most", „perc", „óra", „nap"), `formatDate` (`:79`) `'hu-HU'`-ra drótozva.

A §18 két mondata: „Ne legyen hardcoded magyar a JS-ben" és „A backend enumot adjon, ne lokalizált stringet". A 90 `apg.*` kulcs mindkét nyelvi fájlban megvan és jól használt — a hiba nem a hiányzó infrastruktúra, hanem hogy a szöveg egy része megkerüli.

### F-12 · P2 · Minden lista- és detail-hívás hat tábla teljes tartalmát beolvassa

`loadProjectionData` (`:286`) `LIMIT` nélkül olvassa a `canonical_artifact_versions`, `assisted_recommendations`, `change_delivery_transitions`, `checkpoint_results`, `execution_receipts` és `evidence_references` táblákat, majd a lapozás memóriában történik (`:819`). A summary mögött van 10 s cache; a lista és a detail mögött **nincs**. A §20 első mondata: „Summary ne scan-elje újra a teljes append-only store-t minden kérésnél" — a summary rendben, de a többi végpont pont ezt csinálja, egy append-only store-on, ami definíció szerint csak nő.

### F-13 · P2 · A `?mode=` query paraméter felülírja a globális off-ot

`routes/apg.ts:97` — `requestedMode` explicit `mode` paramétert fogad el, és ilyenkor **meg sem hívja** a `resolveEffectiveApgMode`-ot. A §4.5 „Globális off ABSZOLÚT master off (alacsonyabb scope ne kapcsolhassa vissza)" mondata a rezolverben teljesül, az API-n nem: `GET /api/apg/work-items?mode=assisted` globális off mellett is teljes projekciót ad. A summary-végpont immunis (nem használja a `requestedMode`-ot) — az aszimmetria mutatja, hogy ez elmaradás.

### F-14 · P2 · A döntési UI natív dialógusokat használ, és háromból egy kötelező indokot kér

`apg.js:649-658` — `window.prompt` a `block` indokához, `window.confirm` a többihez. A §12.5 pontosan felsorolja, mit kell a megerősítő ablaknak tartalmaznia, és külön kiköti: „Konkrét szöveg, ne »Biztos?«". A §12.4 három kötelező indokot ír elő (`block`, `return_for_fix`, `request_evidence`); kettő hiányzik. A §17 fókusz-csapda / fókusz-visszaállítás követelménye natív dialóguson nem értelmezhető.

### F-15 · P2 · Az idempotencia-store read-modify-write versenyzik és korlátlanul nő

`routes/apg.ts:59-81` — `readIdempotencyStore()` majd teljes fájl újraírása. Két párhuzamos, **különböző** approvalra vonatkozó döntés közül az egyik rekordja elveszhet (a második írás a régi olvasáson alapul), ami egy későbbi retry-t 409-re futtat a 200-as replay helyett. Nincs prune sem: a fájl minden döntéssel nő.

### F-16 · P3 · Accessibility és mobil a spec alatt

Két `aria-` attribútum 1100 sorban; nincs fókusz-csapda, fókusz-visszaállítás, live region, és az ikon-only gomboknak nincs címkéje. Az `apg.css`-ben egy breakpoint (520px) a §16 három viewportjára. Az Escape-zárás megvan — az egyetlen implementált §17-es elem.

---

## 3. A sidecar kernel (marveen-apg-kernel)

A kernel a `design/apg-v0.4-pilot-kernel-implementation-spec.md`-hez mérve **erős**. Amit ellenőriztem és rendben van:

- **Determinizmus (§7).** `time.time()` az egész `src/`-ben három helyen fordul elő: a backup címkéjében, a migrációkövetésben és a health-észlelés időbélyegében. A domain-írások időbélyege kívülről jön — pontosan ahogy a spec kéri.
- **Append-only (§4).** A `0003_append_only_guards.sql` mind a kilenc táblára `BEFORE UPDATE`/`BEFORE DELETE` triggert tesz, tehát az invariáns SQLite-szinten él, nem csak a hívási úton. Ez jobb, mint amit a spec kért.
- **Őszinte forrásadapterek (§13).** `render_source` kulcs nélkül `None`-t ad, `git_source` hibára kivételt dob, `health_source` csak valódi 200-ra ad bizonyítékot. Sehol nincs kitalált érték.
- **Migráció-keményítés (W11).** A `schema_version` a fájlnév prefixéből jön, nem `enumerate()` sorszámból; az `init()` hangosan elbukik, ha a DB újabb, mint a migrációs könyvtár. A `check_integrity()` read-only.
- **Backup/uninstall (W14).** Natív SQLite backup API, metadata-only manifest, checksum- és séma-verzió-ellenőrzés visszaállításkor.

### K-1 · P1 · A kernel forrása és tesztjei a tulajdonos gépéhez vannak drótozva

- `src/profiles.py:12` — `METHODOLOGY_PACK_ROOT = "/home/iszzu/marveen-local/apg-methodology-v0.4-lean"`
- `src/receipt_chain.py:162` — `marveen_suite_path: str = "/home/iszzu/marveen-suite"`

Tiszta checkouton **432 tesztből 131 nem fut le** (122 error + 9 fail), ebből 115 `FileNotFoundError` ezekre az útvonalakra. A `audits/apg-1.8-gap-map.md` „432 teszt, 426 pass" állítása tehát pontosan egy gépen igaz.

Ez két spec-követelményt érint: a §15 „removable sidecar" (a kernel törölhető, de a működéséhez szükséges pack egy abszolút úton kívül él, verziókötés nélkül), és a work-items.yaml `deterministic-tests` pontja — egy teszt, amit csak a szerző gépén lehet lefuttatni, nem determinisztikus bizonyíték. Egy `APG_METHODOLOGY_PACK` környezeti változó alapértelmezéssel megoldaná.

### K-2 · P2 · Az eredmény-oszlopnak nincs CHECK constraintje, és a kommentje a régi enumot dokumentálja

`migrations/0001_initial_schema.sql:79` — `result TEXT NOT NULL, -- PASS | FAIL | UNKNOWN | NOT_APPLICABLE`. Az érték azóta `EXCLUDED`/`ERROR` is lehet. Egy `CHECK (result IN (...))` a séma szintjén tartaná a kanonikus halmazt, és a rename-et lehetetlen lett volna csendben elvégezni (lásd F-8).

### K-3 · P3 · Két kisebb pontatlanság a forrásadapterekben

- `health_source.check_health`: a nem-200 válasz és az elérhetetlen szolgáltatás **ugyanazt** (`None` → UNKNOWN) adja. A spec §8.3 megkülönbözteti a „hiányzik/ismeretlen" és a „jelen van, de inkonzisztens" esetet — utóbbi FAIL. Egy 500-as `/health` ma ismeretlenként megy tovább.
- `git_source.find_commits_by_grep`: a `needle` interpolálva megy a `git log --grep=` regexébe; regex-metakarakteres keresőkifejezés csendben mást talál.

---

## 4. Amit jónak találtam

- **A határok betartása.** A spec legszigorúbb elve — sidecar az authority, a UI csak olvas — kód szinten kikényszerítve (`readonly: true, fileMustExist: true`), és a scope-override store fejléce külön kimondja, hogy az nem domain-igazság. Ez ritka fegyelem.
- **A frontend-integráció módja.** A hat generikus `marveen:*` esemény a spec preferencia-sorrendjének a *legjobb* opciója, és tényleg így épült meg — nincs MutationObserver, nincs CSS-selector scraping. Ez az, ami miatt az APG egy Marveen-frissítést túlél.
- **Az off-mód valódi no-op.** Nem csak a render van kikapcsolva: az approvals-blokk külön ellenőrzi, hogy üres szekció se maradjon a DOM-ban. A §22 pontosan ezt kérte.
- **`deriveDisplayState` tesztkultúrája.** 11 teszt, köztük egy, ami azt bizonyítja, hogy semmilyen bemenet-kombinációra nem keletkezik kilencedik állapot — és a 2026-08-09-i owner-döntés (PARTIAL ≠ evidence_needed) indoklása bent van a kódban, azzal együtt, hogy miért volt rossz a régi viselkedés.
- **Az epoch-sentinel javítás.** A `created_at=1` őrszem-értékek kezelése két rétegben (adatréteg szűrés + `ageSeconds` saját padló), mindkettő megindokolva, plusz egy külön regressziós teszt-fájl. Így kell defenzív javítást írni.
- **A kernel append-only és migráció-keményítése** a spec fölé megy, és az `unittest`-csomag valóban a viselkedést méri, nem a szerkezetet.

---

## 5. Javasolt sorrend

**Most (egysoros vagy közel egysoros, és mind a §24-ből vesz vissza egy nemet):**

1. **F-3** — használd az importált `Database`-t. Az Aktivitás-feed ettől az egy sortól működik.
2. **F-8** — `EXCLUDED` és `ERROR` felvétele a `deriveDisplayState`-be (mindkettő `clarification`, nem `executing`), és `EXCLUDED` kivétele a `gate_progress.total`-ból.
3. **F-10** — a fail-open ág mód-függővé tétele: enforced módban a lekérés hibája blokkoljon.
4. **F-13** — a `?mode=` paraméter ne kerülhesse meg a globális off-ot.
5. **F-5** — önjóváhagyás-ellenőrzés a döntési végpontra.

**Rövid távon:**

6. **F-1 + F-2** — a `VERIFIED_CURRENT` kötése a runtime-bizonyítékhoz, és az `accepted`/`acceptance_status` kötése egy valódi elfogadási eseményhez (accepter identitással). Amíg nincs elfogadó, a helyes címke „kapu teljesült", nem „függetlenül elfogadva".
7. **F-4** — APG decision receipt a sidecarba, és az új effective state visszaadása.
8. **F-6** — a három inert enforcement kapcsoló bekötése, vagy — ha a mögöttes kontroll még nem létezik — a beállítás-UI-ban jelezni, hogy még nem hatnak. A jelenlegi állapot (kapcsoló, ami sikert jelez és nem hat) a legrosszabb a három közül.
9. **F-7, F-9, F-11** — `mode_source` valós értéke, `projection_error` a részleges hibára, és a magyar próza kiváltása enumra + i18n kulcsra.

**Középtávon:**

10. **F-12** — indexelt/lapozott lekérdezések a lista- és detail-úton, cache mindkettő mögé.
11. **F-14, F-16** — saját megerősítő modal a §12.5 tartalmával, a két hiányzó kötelező indok, és az accessibility-minimum (fókusz-csapda, ARIA-címkék, live region).
12. **§23.3/§23.4** — frontend contract tesztek és a hét integrációs fixture. A jelenlegi 41 teszt jó, de a spec tesztpiramisának a felső két szintje hiányzik, és pont az fogta volna el az F-3-at és az F-8-at.
13. **K-1** — a metodológiai pack útvonala környezeti változóból, hogy a kernel tesztjei bárhol futtathatók legyenek.

---

## 6. Egy megjegyzés a két repó szerződéséről

Az F-8 nem egyszeri elírás, hanem szerkezeti következmény. A `marveen-apg-kernel` a 1.x spec felé fejlődik (`audits/apg-1.8-gap-map.md`), a `marveen-private` UI-projekciója viszont a 0.4-es szerződésre készült, és **semmi nem köti össze a kettőt** — nincs közös enum-forrás, nincs szerződés-teszt, nincs verziószám a sidecar sémán, amit a projekció ellenőrizne. A `projection_version: 1` konstans a UI oldalon van, és nem a store-ból jön.

A legolcsóbb védelem: a kernel írjon egy `schema_contract` sort (kanonikus eredmény-halmaz + séma-verzió) a store-ba, a projekció olvassa be, és ismeretlen érték esetén adjon `projection_error`-t — ahelyett, hogy csendben „Végrehajtás alatt"-ra képezné. Ez a §1.4 „sidecar az authority" elvét abból, ami ma egy jóhiszemű megállapodás, futásidőben ellenőrzött szerződéssé teszi.

*Marveen-review, 2026-08-10 — a spec a mérce, a kapcsoló akkor kapcsoló, ha valaki olvassa.*
