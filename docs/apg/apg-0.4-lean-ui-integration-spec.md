# APG 0.4 LEAN – TELJES MARVEEN UI-INTEGRÁCIÓ — implementációs utasítás

> Owner spec, Istvan, 2026-07-30 (Telegram 7408-7416). Reprodukálva verbatim a producer számára.
> Ez a task 2 a "két dolog egymás után" éjszakai munkából. Task 1 = optimization-dashboard-implementation-spec.md. SORRENDBEN: task 1 ELŐBB, mert mindkettő ugyanazokat a dashboard integrációs fájlokat érinti (web/index.html, web/app.js, web/lang/*.js, src/web.ts) → párhuzamosan konfliktálnának.

Implementáld az APG 0.4 Lean teljes, production-quality Marveen UI-integrációját egyetlen end-to-end work itemként. A cél nem új projektmenedzsment-rendszer, hanem könnyű, bizonyítékvezérelt kontrollréteg a meglévő Marveen felületekhez.

A felület tegye egyszerűvé, hogy a tulajdonos egy pillantással megértse: mi folyik; mi áll; miért áll; mi bizonyított; miben kell döntenie; mi a következő lépés; elkészült-e a munka; függetlenül el is fogadták-e.

Az egész APG legyen: globálisan kikapcsolható; részenként kikapcsolható; projektenként felülírható; kártyánként felülírható; progressive disclosure alapú; mobilon is használható; HU+EN teljes; alapállapotban nem tolakodó; hibánál egyértelműen fail-safe; Marveen-frissítésekkel fenntartható; külön Marveen-core fork nélkül vagy a lehető legkisebb generikus core hookkal.

## 1. KÖTELEZŐ ARCHITEKTURÁLIS ELVEK
- **1.1 Ne készüljön külön APG főmenüpont.** Ne hozz létre új „APG”/„Governance”/„Workflow”/„Artifacts” főoldalt. Az APG a meglévő felületekbe épüljön: Áttekintés; Kanban; Kanban-kártya részletei; Jóváhagyások; Aktivitás; Beállítások. Normál működésben vékony, háttérben lévő réteg.
- **1.2 Ne készüljön második Kanban.** A meglévő Kanban státuszai változatlanok. Az APG-állapot: külön metadata; külön display state; nem új Kanban-oszlop; nem írja át automatikusan a Kanban státuszt; nem hoz létre párhuzamos feladatlistát.
- **1.3 Ne készüljön második approval-rendszer.** Használd a meglévő Marveen approval API-t és viselkedését (pending; approved; rejected; timeout; first-decision-wins; self-approval guard). Az APG-specifikus döntés részletes jelentése az APG sidecarban legyen receiptként. Ne bővítsd szükségtelenül a generikus approval státusz enumot.
- **1.4 Az APG sidecar az authority. A UI csak projection/read model.** A UI ne találjon ki APG-állapotot; ne számítson acceptance-et pusztán Kanban-státuszból; ne tekintsen egy kártyát elfogadottnak csak mert done; ne módosítsa közvetlenül a claim-/receipt-/gate-rekordokat; ne hozzon létre második APG-adatbázist. Használd a meglévő APG v0.4 append-only sidecar store-ját; artifact/claim recordjait; execution receiptjeit; checkpoint/gate eredményeit; producer/accepter adatait; decision receiptjeit. Ha a store contract nem elég egy mezőhöz, készíts determinisztikus UI-projekciót — ne vezess be párhuzamos truth source-ot.
- **1.5 Ne változtasd meg az APG módszertanát.** UI- és adapter-implementáció. NEM része: új APG lifecycle; új artifact-taxonómia; új checkpoint; Product LCM áttervezés; Change Delivery FSM áttervezés; teljes autonóm dispatch; automatikus production deploy; automatikus owner-döntés; product_id általános bevezetése; CostOps/model-routing; virtuális product pod; WIP-limit újratervezés. A canonical APG domain model változatlan.

## 2. UPDATEABILITY ÉS FÁJLHATÁROK
APG-specifikus implementáció külön modulokban. Preferált: `src/apg/ui-read-model.ts`; `src/apg/ui-types.ts`; `src/apg/ui-projection.ts`; `src/web/routes/apg.ts`; `web/apg.js`; `web/apg.css`; `src/__tests__/apg-ui-*.test.ts`; `docs/apg-ui.md`; `docs/en/apg-ui.md`. Igazítsd a meglévő lokális APG modul struktúrájához; ne hozz létre duplikált APG rootot. Meglévő fájlokban csak minimális integrációs pont: `src/web.ts`; `src/config-registry.ts`; `web/index.html`; `web/app.js`; `web/lang/hu.js`; `web/lang/en.js`.
- **2.1 Frontend-integráció** preferált sorrend: létező frontend extension/hook; kis generikus event/hook; minimális explicit APG hook; DOM mutation observer csak végső esetben. Ne építsd törékeny CSS selector scrapingre vagy folyamatos MutationObserverre. Ha nincs megfelelő hook, adj generikus eseményeket: `marveen:overview-rendered`; `marveen:kanban-rendered`; `marveen:kanban-card-opened`; `marveen:approvals-rendered`; `marveen:activity-rendered`; `marveen:settings-rendered`. A generikus hook ne tartalmazzon APG-domainlogikát; jelöld upstream candidate-ként, de a helyi implementációt ne blokkolja.
- **2.2 Frontend technológia**: maradj vanilla HTML/CSS/JS + jelenlegi theme változók + komponensminták. Ne adj Reactet, Vue-t, új bundlert, új nagy UI dependencyt.

## 3. APG ÜZEMMÓDOK
Settings Registry-be: `APG_MODE` értékei: off / observe / assisted / enforced. HU: Kikapcsolva / Megfigyelés / Segített / Kötelező kapuk.
- **3.1 Kikapcsolva**: nincs új APG workflow-indítás; nincs blocking; nincs owner notification; nincs widget; nincs badge; nincs APG activity a feedben; a history/sidecar NEM törlődik; Kanban/Approvals/Activity tovább működik; generic approval rekordokat ne töröld/írd át. Újraengedélyezéskor elavult pending APG-döntést ne aktiválj automatikusan — a motor currentness review után új approvalt készít ha kell.
- **3.2 Megfigyelés**: APG-projekció/evidence/gate/recommendation látható; semmit nem blokkol; nem dispatchol; nem módosít Kanbant; nem kér kötelező owner-döntést. Jelezze: „Megfigyelési mód – az APG nem állít meg műveletet”.
- **3.3 Segített**: előkészíti a következő lépést; evidence hiánynál figyelmeztet; owner decision requestet készíthet; független acceptance-et kérhet; automatikus production-művelet nincs; owner döntése egyszerű UI-akcióval továbbítható; a munkát csak a kijelölt APG lépésen belül vezeti; user felülírhatja/kikapcsolhatja.
- **3.4 Kötelező kapuk**: APG-controlled progression nem haladhat sikertelen kötelező gate mellett; receipt nélküli VERIFIED_CURRENT nem engedhető; producer nem lehet saját végső accepter; kötelező owner-döntés nélkül a gate nem nyílhat; Kanban tovább megtekinthető/szerkeszthető; nincs automatikus production deploy; nem válhat teljes autonóm végrehajtóvá.
- **Store/projection elérhetetlen**: off+observe → fail-open, degraded bannerrel; assisted → ne állíts tévesen zöldet, „APG állapot nem elérhető”; enforced → APG-controlled progression fail-closed, de a teljes dashboard ne álljon le.

## 4. BEÁLLÍTÁSOK ÉS RÉSZLEGES KIKAPCSOLÁS
Registry `module:"apg"` csoport, hot-reload (requiresRestart:false).
- **4.1 Master**: `APG_MODE`, disztribúció default `off` (backward compat). Helyi aktiválás owner-döntésből a UI-n.
- **4.2 UI surface toggles** (0/1, requiresRestart:false): `APG_UI_OVERVIEW` (summary+attention az Áttekintésen); `APG_UI_KANBAN` (badge+filter+kártyarészlet); `APG_UI_ACTIVITY` (APG eventek); `APG_UI_EVIDENCE` (claim/receipt panelek); `APG_UI_APPROVAL_ENHANCEMENTS` (APG döntési kártya a Jóváhagyásokon); `APG_OWNER_NOTIFICATIONS` (csatornás értesítések). A UI surface kikapcsolása NE kapcsolja ki a mögöttes kontrollt.
- **4.3 Enforcement toggles** (0/1, restart nélkül): `APG_REQUIRE_CLAIM_RECEIPT`; `APG_REQUIRE_INDEPENDENT_ACCEPTANCE`; `APG_REQUIRE_OWNER_DECISION`; `APG_BLOCK_UNACCEPTED_ARCHIVE`. Csak akkor blokkoljanak, ha az effective mode enforced; assisted módban ugyanaz a figyelmeztetés, nem hard block.
- **4.4 Kritikus láthatósági szabály**: assisted/enforced módban pending owner-döntés nem válhat láthatatlanná. Ha az approval enhancement ki van kapcsolva: a generic Approvals lista mutassa a kérést; sidebar pending badge maradjon; owner kapjon fallback döntési lehetőséget; ne maradjon rejtett APG-block.
- **4.5 Scope override** store/record: `scope_type: project|kanban_card`; `scope_id`; `mode: inherit|off|observe|assisted|enforced`; `updated_at`; `updated_by`; `reason`. Feloldás: card override > project override > global APG_MODE. Globális off ABSZOLÚT master off (alacsonyabb scope ne kapcsolhassa vissza). Minden módosítás append-only audit event. A UI mindenhol mutassa az effective mode-ot + tooltip honnan öröklődött (pl. „Segített – projektbeállításból”).

## 5. EGYSÉGES FELHASZNÁLÓI APG-ÁLLAPOTOK
Canonical internal state → display-state mapping (backend read modelben, egy helyen; a canonical belső state ne változzon): clarification→Tisztázás; evidence_needed→Bizonyíték szükséges; executing→Végrehajtás alatt; verifying→Ellenőrzés alatt; decision_needed→Döntésre vár; blocked→Blokkolt; accepted→Elfogadva; off→APG kikapcsolva. Minden állapothoz: HU címke; EN címke; ikon; semantic CSS class; rövid leírás; attention severity. Ne csak szín különböztesse meg.
- **5.1 Semantic megjelenés** (meglévő theme tokenek): kék/info folyamatban; sárga/warning evidence/döntés szükséges; piros/danger blokkolt/konfliktus; zöld/success elfogadott; szürke/muted kikapcsolt/nincs adat. Minden badge szöveggel vagy accessible labellel.

## 6. BACKEND UI READ MODEL (determinisztikus projection)
- **6.1 `ApgUiSummary`**: `{mode, enabled, as_of, projection_version, counts:{active, evidence_needed, verifying, decision_needed, blocked, accepted_today, done_not_accepted}, attention_items:[]}`.
- **6.2 `ApgUiWorkItemSummary`**: `{id, kanban_card_id(nullable), project, title, effective_mode(observe|assisted|enforced|off), mode_source(global|project|card), display_state, internal_state, risk(low|medium|high|critical|unknown), attention_reason(nullable), next_action, producer_agent(nullable), accepter_agent(nullable), gate_progress:{passed,total,blocking_gate(nullable)}, claim_counts:{total,verified_current,conflicting,unknown,blocked}, acceptance_status(not_started|produced|verifying|accepted|returned|blocked), updated_at}`.
- **6.3 Work item detail**: cél; scope; effective mode; canonical state; display state; risk; current gate; next action; claims; evidence; receipts; producer; accepter; owner decisions; events; rollback info; side-effect státusz; timestamps; source receipt/event ID-k.
- **6.4 Projection követelmények**: append-only rekordokból determinisztikusan újraépíthető; replay ugyanazt adja; unknownból NE legyen implicit success; hiányos record ne dobja el a teljes oldalt; sérült elem külön `projection_error` jelzést kapjon; timestamp mindig abszolút ISO (frontend lokalizál); ne tartalmazzon credentialt/titkot.

## 7. API-K (APG UI route modul)
- **7.1 Read**: `GET /api/apg/summary`; `/api/apg/work-items`; `/api/apg/work-items/:id`; `/:id/claims`; `/:id/receipts`; `/:id/events`; `/api/apg/scope-overrides`. Query: project; state; attention; mode; kanban_card_id; limit; offset. Limit default 50, max 500.
- **7.2 Scope override**: `PUT /api/apg/scope-overrides`; `DELETE /api/apg/scope-overrides/:scopeType/:scopeId`. Kötelező: actor; reason (enforcedből lazább módba váltáskor); input validation; path/id sanitation; audit event.
- **7.3 Owner decision**: `POST /api/apg/approvals/:approvalId/decision` body `{action: accept|return_for_fix|request_evidence|block, note, idempotency_key}`. Működés: olvasd az approvalt; csak pending-ből; ellenőrizd az APG action payloadot; használd a meglévő approval resolutiont; resolved_by mindig `dashboard`; appendelj APG decision receiptet; frissítsd a projectiont; add vissza az új effective state-et. Mapping: accept→approved; return_for_fix→rejected; request_evidence→rejected; block→rejected (a receipt különböztesse meg a rejected altípusokat; ne változtasd a generikus approval enumot).
- **7.4 Idempotencia**: ugyanaz az idempotency key ugyanazt adja; lezárt approval → 409; a UI 409-et ne általános hibaként (töltse újra a végleges döntést, „Ezt a kérést már eldöntötték.”).
- **7.5 Részleges write failure**: ha a generic approval lezárult de az APG receipt append sikertelen: ne nyisd vissza az approvalt; írj repair-needed eventet; owner-facing degraded figyelmeztetés; idempotens repair út; ne mutass hamis success-t.

## 8. ÁTTEKINTÉS OLDAL
APG szekció ha `APG_MODE != off` ÉS `APG_UI_OVERVIEW = 1`.
- **8.1 Felső summary strip**: effective global mode; active; evidence needed; decision needed; blocked; verifying; accepted today. Desktop egy strip, mobil vízszintes scroll vagy 2×2. Ne túl sok nullás stat külön kártyában.
- **8.2 Figyelmet igényel lista** (max 5), rendezés: critical blocked; owner decision needed; conflicting evidence; overdue verification; done but not accepted. Elem: projekt; cím; display state; egy mondatos ok; következő lépés; age; deep link.
- **8.3 Empty**: „Az APG nem talált figyelmet igénylő folyamatot.” Ne írja „minden rendben” ha a projection hibás/nem elérhető.
- **8.4 Degraded**: „Az APG állapota jelenleg nem olvasható. A Marveen többi funkciója működik.” [Újrapróbálás][Státusz részletei].

## 9. KANBAN INTEGRÁCIÓ
- **9.1 Kártyabadge** linked APG work itemnél: „APG · <állapot>”; effective mode chip; gate progress ha értelmezhető; attention ikon; acceptance jelzés. Ne legyen öt badge egymás mellett. Kompakt: első sor APG állapot; második sor következő lépés/blokkoló ok; tooltip/detail további adatok.
- **9.2 Elkészült kontra elfogadott**: done kártya APG acceptance nélkül → „Elkészült · még nincs elfogadva”; acceptance után „Függetlenül elfogadva”. SOHA ne mutasd acceptance-ként pusztán a done státuszt.
- **9.3 Quick filters** (a meglévő sorba, kombinálható projekt/státusz filterrel): APG: Figyelmet kér; APG: Döntésre vár; APG: Blokkolt; APG: Ellenőrzés alatt; APG: Kész, nincs elfogadva.
- **9.4 Ne legyen új oszlop** (nincs APG queue/Evidence/Acceptance/Owner decision oszlop).
- **9.5 Archiválás**: ha `APG_MODE=enforced` ÉS `APG_BLOCK_UNACCEPTED_ARCHIVE=1`, linked work item acceptance nélkül ne kerüljön auto-archívumba; „Archiválás blokkolva: nincs független acceptance”. Manuális owner override: confirmation; kötelező indok; audit receipt. Más módban csak warning.

## 10. KANBAN-KÁRTYA APG RÉSZLET (külön „APG” fül/összecsukható panel, ne új teljes oldal)
- **10.1 Header**: „APG 0.4 Lean / Állapot / Mód (öröklés forrásával) / Kockázat / Frissítve”.
- **10.2 Folyamat-stepper** (canonical gate projectionből, nem kattintva teljesíthető): pl. 1. Cél ✓; 2. Állítások ellenőrzése ✓; 3. Végrehajtás ✓; 4. Független ellenőrzés folyamatban; 5. Owner-döntés nem szükséges.
- **10.3 Következő lépés panel** (mindig látható), blokkolt állapotban az okkal.
- **10.4 Belső tabok**: Áttekintés (cél; scope; state; next action; producer; accepter; gate progress; side-effect; rollback); Bizonyítékok (claim lista; verification status; allowed wording; source type; observed at; receipt; konfliktus); Végrehajtás (melyik agent; context packet; mikor indult; mit adott vissza; tesztek; diff/artifact link; side effects); Döntések (owner decision request; recommendation; options; döntés; indok; időpont; receipt); Audit (append-only event timeline; setting/mode override; state transitions; repair events; receipt IDs).
- **10.5 Progressive disclosure**: alapból közérthető összegzés; technikai részletek „Technikai részletek megjelenítése” alatt. Ne mutass alapból teljes JSON-t/hosszú fájlutakat/stack trace-t/tokeneket/credential patht/teljes agent promptot.

## 11. BIZONYÍTÉK UI
Claim sor: claim text; státusz; allowed wording; source; observed at; verified at; verifier; receipt; supersede info. Státusz-címkék: VERIFIED_CURRENT→Aktuális, igazolt; VERIFIED_HISTORICAL→Történetileg igazolt; SUPPORTED_BUT_NOT_RUNTIME_VERIFIED→Forrás támogatja, runtime-ban nem igazolt; CONFLICTING_EVIDENCE→Ellentmondó bizonyíték; STALE_OR_SUPERSEDED→Elavult vagy felülírt; UNKNOWN→Ismeretlen; BLOCKED_FROM_USE→Aktuális tényként nem használható.
- **11.1 Ne legyen hamis zöld**: ne kapjon zöldet ha nincs receipt; csak fájl létezik; csak komment; csak régi owner-döntés; hiányzó runtime verification amikor szükséges; conflicting evidence; túl régi source; projection error.
- **11.2 Replay**: receipt részletben replay eredmény (siker/azonos/utolsó replay). Replay failure: assisted→warning, enforced→a releváns gate-et blokkolja.

## 12. JÓVÁHAGYÁSOK OLDAL (bővítsd a meglévőt, ne új inbox)
- **12.1 APG filter**: Összes; APG-döntések; Műveleti jóváhagyások; Függő; Lezárt; Lejárt.
- **12.2 APG decision card** és **12.3 információs sorrend** (mindig): mit kell eldönteni; APG ajánlás; bizonyított tények; unknown/conflict; kockázat; elfogadás következménye; elutasítás következménye; gombok.
- **12.4 Döntési gombok**: Elfogadom (primary; pontos következmény; high/critical risknél note kötelező); További bizonyíték kell (kötelező mi hiányzik; code request_evidence; evidence-needed állapot); Visszaküldöm javításra (kötelező indok; code return_for_fix; producer konkrét javítási igény); Blokkolom (danger; kötelező indok; confirmation modal; code block).
- **12.5 Confirmation modal**: work item; választott döntés; következő állapot; várható side effect; visszavonhatóság; note mező; végleges gomb. Konkrét szöveg, ne „Biztos?”.
- **12.6 Már eldöntött** (409/közben történt): „Ezt a kérést már eldöntötték. Döntés/Döntő/Időpont”. Ne írd felül.
- **12.7 Pending badge**: a meglévő sidebar badge APG pendingeket is számoljon; NE külön második APG badge.

## 13. AKTIVITÁS OLDAL
APG eventek a meglévő activity feedbe; filter: Minden; Ügynökaktivitás; APG események; Döntések; Hibák. Event: tömör; timestampelt; agenthez kötött; work itemhez linkelt; receipt ID-val kinyitható; error esetén actionable. Ne duplikáld a teljes agent conversationt.

## 14. BEÁLLÍTÁSOK UI (külön „APG 0.4 Lean” szekció; a registry a persistence authority)
- **14.1 Mode selector**: négy kompakt választókártya/segmented control (Kikapcsolva/Megfigyelés/Segített/Kötelező kapuk); mindig mutassa az effective globális módot.
- **14.2 Teljes kikapcsolás** confirmation: megszünteti az új kontrollokat; nem blokkol; elrejti a UI-t; nem törli az előzményeket; nem oldja fel/írja át a generic approval rekordokat. Gombok: Mégse / APG kikapcsolása.
- **14.3 Felület-toggle lista** (egy mondat magyarázattal): Áttekintés összefoglaló; Kanban jelzések; Bizonyítékpanelek; APG események az Aktivitásban; APG döntési kártyák; Owner értesítések.
- **14.4 Kontroll-toggle lista** (jelezve „csak Kötelező kapuk módban blokkol”): Claim receipt megkövetelése; Független acceptance megkövetelése; Owner-döntés megkövetelése; Elfogadás nélküli archiválás blokkolása.
- **14.5 Scope override tábla**: Scope; Projekt/kártya; Mód; Öröklés forrása; Utolsó módosítás; Művelet. „Felülírás hozzáadása” form: Scope (Projekt/Kanban-kártya); Cél (kereshető select); Mód (Öröklés/Ki/Megfigyelés/Segített/Kötelező); Indok.
- **14.6 Diagnosztika** (összecsukott): sidecar elérhető; projection verzió; utolsó sikeres frissítés; projection hibák; repair-needed események. Ne jeleníts credentialt/titkot.

## 15. APG MODE CHIP MINDEN RELEVÁNS HELYEN
„APG: Segített/Megfigyelés/Kötelező/Ki” + tooltip (Globális/Projekt/Kártyafelülírás). Kattintásra owner megnyithatja a scope override-ot. Ne legyen véletlen egykattintásos kikapcsolás.

## 16. MOBIL ÉS RESZPONZÍV UX
Viewportok: 390×844; 768×1024; 1440×900. Mobil: summary statok 2 oszlop; attention cardok egy oszlop; APG detail drawer teljes szélesség; tabok vízszintes scroll; decision actionök sticky alsó sáv; danger action ne primary helyen; hosszú receipt ID rövidített+másolható; modal ne lógjon ki; nincs vízszintes oldal-scroll.

## 17. ACCESSIBILITY
Billentyűzetes navigáció; látható focus; ARIA label minden ikon-only gombon; status nem csak színnel; form error mező mellett; dialog focus trap; Escape bezárás; confirmation után focus visszaállítás; screen reader értelmes státusz; live region csak fontos async döntési eredményhez; reduced-motion; legalább WCAG AA kontraszt.

## 18. I18N
Minden új felirat `web/lang/hu.js` + `web/lang/en.js`. Ne legyen hardcoded magyar a JS-ben. Kulcscsoportok: apg.mode.*; apg.state.*; apg.risk.*; apg.overview.*; apg.kanban.*; apg.evidence.*; apg.approval.*; apg.activity.*; apg.settings.*; apg.errors.*; apg.empty.*. A backend enumot adjon, ne lokalizált stringet.

## 19. SECURITY ÉS ADATVÉDELEM
- **19.1 Redaction**: tilos visszaadni API key; OAuth/bearer token; access code; credential value; titkos env; magas entrópiájú secret; teljes tenant PII. A source locator redaktálható.
- **19.2 XSS**: minden text content escaped; action payload JSON ne innerHTML-be; markdown csak meglévő biztonságos rendererrel; raw HTML tilos.
- **19.3 Döntési jogosultság**: requesting agent nem döntheti el saját approvalját; frontend mindig resolved_by:dashboard; generic self-approval guard marad; owner channel döntés senderId-ellenőrzött; ugyanazon approval több csatornás döntésénél az első nyer.
- **19.4 Audit**: mode change; toggle change; scope override; owner decision; archive override; repair; projection error; emergency off.

## 20. PERFORMANCE
Summary ne scan-elje újra a teljes append-only store-t minden kérésnél; cache-elt/projektált read model; invalidáció append vagy mtime/version alapján; detail lazy; claims/receipts/events paginálható; overview polling alap 30s; nyitott detail 10–15s; page hidden → ne polloljon; request overlap abortálható; APG outage ne lassítsa a Kanban alaprenderét.

## 21. EMPTY/LOADING/ERROR STATE-EK
Minden komponensnek: skeleton/loading; empty; disabled; degraded; error; partial data. Soha ne váltson hiba esetén automatikusan zöldre/elfogadottra.

## 22. BACKWARD COMPATIBILITY
`APG_MODE=off` esetén: DOM/vizuál lényegében a jelenlegi Marveen; Kanban/generic approvals/settings működése változatlan; page load ne kapjon kötelező APG-függőséget; APG sidecar hiánya ne okozzon startup hibát. Frissítéskor: nincs destruktív migráció; default off; korábbi sidecar adatok olvashatók; hiányzó UI projection rebuildelhető.

## 23. TESZTEK
- **23.1 Backend unit**: display-state mapping; global/project/card mode precedence; global off master; claim count projection; gate progress projection; done-not-accepted; corrupted record handling; secret redaction; pagination; idempotent owner decision; already-resolved 409; approval/receipt partial failure; enforced fail-closed; observe fail-open.
- **23.2 API contract**: summary; list; detail; claims; receipts; events; scope override; decision; invalid action; missing note; invalid scope; off mode; unavailable sidecar.
- **23.3 Frontend contract** (a meglévő string-contract minta szerint): nincs új APG nav item; APG overview mount; Kanban badge hook; quick filterek; card APG panel; APG approvals filter; négy döntési action; resolved_by:dashboard; mode settings; i18n mindkét nyelven; badge+banner; no-secret rendering; off mode hide.
- **23.4 Integration fixture-ek**: Happy path (executing→verifying→accepted); Evidence block (SUPPORTED_BUT_NOT_RUNTIME_VERIFIED→evidence needed); Conflict (CONFLICTING_EVIDENCE→blocked); Owner decision (decision needed→accept→next gate); Return for fix (decision needed→return_for_fix→producer); Global off (APG UI hidden, Kanban unchanged, no block); Done but unaccepted (Kanban done, APG produced, not accepted).
- **23.5 Visual acceptance** screenshotok: desktop Overview; desktop Kanban; card APG detail; APG owner decision; Settings; mobile decision; dark mode; APG off.
- **23.6 Regression**: futtasd a repo releváns unit/API/UI contract/approvals/settings/Kanban/i18n/build/typecheck tesztjeit. Ne találj ki parancsot — előbb olvasd a package scriptet és a repo dokumentációját.

## 24. ACCEPTANCE KRITÉRIUMOK (csak ha MIND)
Nincs új APG főmenüpont; nincs második Kanban; nincs második approval-rendszer; APG master off működik; részleges UI kikapcsolás működik; enforcement toggle-ok működnek; projekt- és kártyaoverride működik; effective mode mindenhol látszik; done és accepted külön; claim status+allowed wording megjelenik; pending owner decision nem rejtett; producer nem tudja magát elfogadni; decision idempotens; 409 helyesen; unknownból nem success; enforced store outage fail-closed; observe store outage fail-open; APG off mellett nincs regresszió; mobil használható; dark/light működik; HU/EN teljes; nincs secret leak; sidecar marad authority; nincs destruktív migráció; a helyi core diff minimális; upstream frissíthetőség nem romlik érdemben; minden releváns teszt zöld.

## 25. ROLLBACK (dokumentált; elsődlegesen konfigurációs, ne kódvisszavonás)
`APG_MODE=off`; APG frontend modul nem renderel; APG route-ok read-only maradhatnak vagy biztonságosan lekapcsolhatók; scope override-ok megmaradnak; sidecar history megmarad; generic approvals megmarad; Kanban nem veszít adatot; core módosítás visszaállítható APG-adatvesztés nélkül.

## 26. UPSTREAM STRATÉGIA
Különítsd el: Generikus upstream candidate (frontend extension eventek; settings registry fejlesztés; generic approval UI decision-note ha valóban kell; Kanban card extension slot; generic status badge slot) vs Lokális APG-domain (APG state mapping; claim/receipt display; sidecar adapter; workflow-specifikus döntési kártyák). Ne küldj upstreambe lokális termék-/owner-policy részletet. Ne nyiss issue-t/PR-t automatikusan; adj upstream javaslatot + minimális patch scope owner-döntésre.

## 27. STOP CONDITIONÖK (állj meg, jelents RETURN_FOR_FIX)
Csak második APG-adatbázissal menne; destructive migration kellene; APG canonical state-et át kellene tervezni; secretet kellene UI-ba adni; frontend csak törékeny DOM scrapinggel menne; self-approval guardot gyengíteni kellene; az off mode nem lenne valódi no-op; APG outage az egész dashboardot leállítaná; teljes autonóm deployt vezetne be; az updateability jelentősen romlana.

## 28. VÉGSŐ ÁTADÁS
Add vissza: upstream base ref; helyi branch+commitok; APG UI architektúra; létrehozott fájlok; módosított meglévő fájlok; core hookok; read model; API endpointok; settings registry kulcsok; globális off bizonyíték; részleges off bizonyíték; project override bizonyíték; card override bizonyíték; Overview/Kanban/card detail/Approvals/Settings/mobil/dark mode screenshotok; APG off állapot; decision idempotency teszt; self-approval teszt; secret-redaction teszt; fail-open/fail-closed teszt; regression tesztek; build/typecheck; APG side effects; production változtatások; migration; rollback; upstream candidate; updateability értékelés; ismert korlátok; végleges verdict.
Verdict: **APG_0_4_LEAN_UI_ACCEPTED** / **APG_0_4_LEAN_UI_RETURN_FOR_FIX** / **APG_0_4_LEAN_UI_BLOCKED**.
Az implementáció után NE aktiváld automatikusan az assisted/enforced módot. Alapállapot: `APG_MODE=off`. A tulajdonos a kész UI-ból külön döntéssel aktiválja először observe, majd sikeres használat után assisted módban.
