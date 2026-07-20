# Kanban done-archive export (>7 nap, status=done)

Kartyak szama: 113 (NEM archivalva -- level-2 config + Istvan a donteseket a sweep utanra halasztotta; export-only, semmi nem vesz el).

## #e1f6ecde [2026-07-03] (fullstackfejleszto)
**QQ P0: Phase 2a build - quote accepted + waitlist export**
Atlas tech spec #2 (agents/architect/deliverables/2026-07-03-phase2-technical-architecture-spec.md).

Scope (Phase 2a):
- quote accepted flow (S, 1d): acceptance endpoint, status update, notification
- waitlist export (S, 0.5d): CSV/JSON export endpoint
- Uncommitted server.ts acceptance endpoints commit-olasa

Prioritas: P0 (azonnali). QQ a legmagasabb prioritasu termek.

DB migraciok: Atlas spec szerint (0006-0013 kozott).

## #2f6f2cfe [2026-07-03] (frontendfejleszto)
**ZST landing deploy: index.html frissites + Render static site deploy**
Marketing copy/spec KESZ (452954c0). Publikacios engedely megvan (9d7e98bf, Istvan jovahagyta).

TENDO:
1. Frissiteni a zstradio-landing/index.html-ben a 6 product kartya linkjet a design spec-ben megadott elo URL-ekre (QQ, MK, Bolcsi, Eskuvo, DORA)
2. Statusz-taxonomia atiras: "Hamarosan" -> "EloJelentkezes" (bolcsi/eskuvo/MK), QuickQuote + DORA = "Demo + EloJelentkezes"
3. Cim ellenorzese: 1037 Kisbojtar utca 35
4. Deploy a Render static site-re (zstradio-landing)

A HTML mar tartalmazza a 6 t

## #6e73106e [2026-07-03] (fullstackfejleszto)
**MK-FX: agazati potlek Excel tamogatas**
Agazati potlek szamitasi modul Excel export/import tamogatassal. Sorban QQ es DORA mogott.

## #49347caa [2026-07-03] (fullstackfejleszto)
**Bolcsi: agazati potlek ugyintezes-segito (bolcsodei dolgozok)**
SCOPE ATMOZGATVA MK -> Bolcsi (Istvan dontes, 24eb89b4). Research (Sonar) kesz, jogi-verify (Aegis) kesz -- CONDITIONAL GO: szamitas-only MVP standalone, 3 kotott keretfeltetel. A leggyakoribb agazattal inditva.

Kovetkezo lepes: build (fullstackfejleszto). Fuggosegek: nincs hard gate. A compliance keretfelteteleket be kell tartani a build soran.

Felelos: fullstackfejleszto.

## #37d0bb63 [2026-07-03] (business)
**Eskuvo: Feature-scope definicio + priorizalas (tovabbfejlesztesi kor)**
Tovabbfejlesztesi kor Phase 2 -- BUSINESS (Compass).

Termek: Eskuvo
Kontextus: eskuvoi szolgaltatasok, ulesrend, ajanlat

INPUT: Sonar research deliverable (agents/research/deliverables/2026-07-03-versenytars-piackutatas-mind-5-termek.md)

FELADAT:
1. A research alapjan DEFINIALD a termekenkenti prioritizalt funkcio-scope-ot
2. Mit epitunk, milyen sorrendben
3. Mi a value/positioning
4. Ar-implikacio
5. S/M/L/XL sizing validalasa a business szempontbol

KIMENET: buildhez keszen allo, definialt 

## #332d0d5f [2026-07-03] (research)
**NET-NEW: eRecept/eNyugta compliance tool - evaluation**
NAV VALIDACIO EREDMENYE (Sonar, 2026-07-03): NO-GO standalone.

A NAV mar biztosít INGYENES ePenztargep + eNyugta appokat (2025 julius ota). A standalone fizetos micro-SaaS nem versenykepes.

SCOPE VALTAS: OCR nyugta-szkenner komponens az MK-ba epitve GO. A NAV app nyugta KIBOCSATASRA van, nem SZKENNELESRE es konyvelesi kategorizalasra - ez a differencialo.

Kovetkezo lepes: uj kartya az MK OCR receipt-scannerre.

## #0d113675 [2026-07-03] (frontendfejleszto)
**MK: PostHog key bedrotozasa a landingre (PH_KEY_PLACEHOLDER csere)**
A marketing GTM card (61e15f76) kesz, de a PH_KEY_PLACEHOLDER meg mindig a landingben van. A PostHog EU account mar letezik (da156ea0). A valos PostHog key-t kell behuzni a placeholder helyere.

Fugg: a PostHog project key-t ki kell nyerni a meglevo accountbol.
Felelos: frontendfejleszto.

## #ea18817f [2026-07-03] (architect)
**Eskuvo: roomAnalysis fizikai-korlat motor**
Forras: agents/business/deliverables/2026-06-28-eskuvo-proto-elemzes-MVP-first.md + 2026-06-28-eskuvo-feature-tiers.md (Istvan protojabol elemezve, de eddig NEM volt build-backlogban). Istvan GO 2026-07-03. Architect: technikai spec, utana build. A seating-AI proto roomAnalysis.ts motorja: szek-kihuzas kapacitascsokkentes (CHAIR_DEPTH), szerviz-folyoso clearance (SERVICE_CLEARANCE), veszkijarat CRITICAL blokkolas, nevleges vs valos ferohely. Elemezve (elemzes 1.1), de nincs build-kartya. Ez a te

## #2b8dccf4 [2026-07-03] (architect)
**Eskuvo: AiProposal auto-atrendezo/rebalance motor**
Forras: agents/business/deliverables/2026-06-28-eskuvo-proto-elemzes-MVP-first.md + 2026-06-28-eskuvo-feature-tiers.md (Istvan protojabol elemezve, de eddig NEM volt build-backlogban). Istvan GO 2026-07-03. Architect: technikai spec, utana build. A proto AiProposal auto-move/rebalance algoritmusa (nem csak a generikus 'AI seating explain', ami a Phase-2-ben van). Az elemzes 'partialis'-kent jelzi. Ez a valodi javaslat-motor.

## #8a1bd8da [2026-07-03] (istvan)
**ISTVAN-DONTES: KATA v2 figyelo landing publikacio (go-live)**
Mi a dontes: KATA v2 figyelo landing elo publikacio (public deploy).

Miert kell Istvan: public deploy, public weboldal elesites.

Javasolt default: GO - a landing draft kesz, a copy atment Herald review-n, a build kesz (Pixel). A landing NEM iger biztosat ("Visszajon a KATA?" varakozas-alapu), footer disclaimer van, GDPR consent van.

Alternativak: deploy halasztasa a reszletszabalyok megjeleneseig, vagy csak staging deploy.

Mit blokkol: KATA v2 figyelo landing waitlist gyujtes (70055f22).

Mi

## #70055f22 [2026-07-03] (frontendfejleszto)
**MK: KATA v2 figyelo landing + waitlist (ACTION NOW)**
BUILD KESZ (Pixel, 2026-07-03). Deliverable: agents/frontendfejleszto/deliverables/kata-v2-landing/ (index.html + server.js + package.json).

Scope teljesitve: Hero, 3 card explainer, atalanyado vs KATA v2 tabla, kalkulator preview, email waitlist, MK CTA, footer disclaimer, PostHog 4 event, cookie consent.

KOVETKEZO: PUBLIKALAS - Istvan-dontes queue.

## #04216fe6 [2026-07-03] (architect)
**MK: KATA v2 tervezo (2027 reform-ready) - URGENT**
Architect update: KATA v2 reform reszletszabalyok meg NEM publikusak (2026 vege).

AMIT MOST LEHET:
- KATA kalkulator a JELENLEGI szabalyokkal
- KATA vs atalanyado osszehasonlito engine
- Ceges szamlazas szimulacio

Az MK atalanyado engine (engine.ts) mar kesz. KATA = uj engine modul (kata-calc.ts), becsles: 1-2 het.

Kovetkezo: technikai spec (kata-calc.ts engine design, osszehasonlito keret, company invoicing szimulacio).

## #17adee72 [2026-07-03] (architect)
**NET-NEW: ÁNYK->ONYA migracios asszisztens - evaluation**
Architect elozetes eval: MEGVALOSITHATO.

MVP scope: ANYK->ONYA atallas asszisztens mint standalone micro-SaaS.

Piaci helyzet: NINCS meg a HU piacon.

Becsult MVP ido: 1-2 het.

Kovetkezo lepes: reszletes spec + scope definicio.

## #1e330f28 [2026-07-03] (fullstackfejleszto)
**Eskuvo P3: Phase 2a build - landing copy fix + seating export/share**
Atlas tech spec #4.

Scope (Phase 2a):
- landing copy fix S (0.25d): a static HTML JS+PostHog mar kesz (aaab7a3f), csak copy frissites
- seating export+share S (1d): ulesrend export (PDF/PNG) + share link generalas

Prioritas: P3. Frontend: Pixel, Backend (export): Mason.

DB migraciok: 1 uj migracio (Atlas spec).

## #66d90b14 [2026-07-03] (architect)
**Eskuvo: teremtervezo (floorplan-AI / DXF import) + v3 multi-asztal + terem-objektumok**
Architect technikai irany KESZ (agents/architect/deliverables/2026-07-03-eskuvo-svg-canvas-gap-direction.md).

SVG viewBox strategia: SCALE=40 SVG unit/meter, 20x15m default terem.
GAP: SVG koordinatas asztal render, DXF import seam, meter-alapu meretezes.
Migracio: Sprint 1 (SVG hatter+venue) -> Sprint 2 (asztalok SVG-ben+constraint overlay) -> Sprint 3 (DXF import).

## #508f163a [2026-07-03] (architect)
**Eskuvo: Drag-and-drop seating canvas (interaktiv SVG/Canvas) - URGENT**
Architect technikai irany KESZ (agents/architect/deliverables/2026-07-03-eskuvo-svg-canvas-gap-direction.md).

HTML5 DnD mar mukodik. GAP: asztal render SVG-be (circle/rect x/y/width/height-al), constraint overlay (chair pull zone+emergency exit), AiProposal vizualizacio (mozgasi nyilak).
Migracio: DOM-SVG hibrid (vendeglista DOM, asztalok SVG), mobile tap-to-assign fallback.

## #40388634 [2026-07-03] (istvan)
**ISTVAN-DONTES: DORA pricing modell (seat+workspace SaaS)**
Mi a dontes: DORA Phase 2a pricing endpoint implementaciojahoz kell a vegleges pricing modell.

Miert kell Istvan: pricing veglegesites = penzugyi dontes.

Javasolt default: seat+workspace SaaS model (felhasznalo-alapu, workspace alapu).

Alternativak: flat fee, tiered, usage-based.

Mit blokkol: DORA P4 Phase 2a pricing endpoint (762419c3).

Mi tortenik automatikusan jovahagyas UTAN: fullstack implementalja a pricing endpointot a valasztott modell szerint.

## #befe9960 [2026-07-03] (fullstackfejleszto)
**ÁNYK->ONYA migracios asszisztens MVP build (MK acquisition channel)**
Business (Compass) GO: mint MK ACQUISITION CSATORNA, nem revenue termek.

MVP scope (1-2 het):
- ÁNYK urlap-katalogus: melyik urlap → hova megy ONYA/eÁFA/M2M
- Urlap-kereso UI: beirod az ÁNYK urlap nevet → megmutatja hova megy
- MK signup CTA: ingyenes kereso → MK elofizetes

Launch target: 2026 augusztus.

Strategiai cel: 200-500 uj MK elofizeto. Az ingyenes verzio lead-generator.

Forras: agents/business/deliverables/2026-07-03-phase2+-scouting-uzleti-ertekeles.md

Felelos: fullstack (backend 

## #762419c3 [2026-07-03] (fullstackfejleszto)
**DORA P4: Phase 2a build - pricing endpoint + S3 provision + waitlist fix**
Atlas tech spec #5 (2026-07-03 phase2-technical-architecture-spec.md, section 5.1-5.3).

PROGRESS 2026-07-03 20:50:

✅ Waitlist fix KESZ (0.25d):
  - server.js: role + product fields, DORA role validation, CSV export + dashboard updated

✅ S3 provision KESZ (1d):
  - apps/api/src/s3-store.ts: shared S3 wrapper (DORA evidence + QQ photo + Bolcsi Excel)
  - AWS S3 eu-central-1 support (lazy-loaded @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner)
  - Local filesystem fallback for dev/testing (S3

## #dbe05b6a [2026-07-03] (istvan)
**ISTVAN-DONTES: quickquote-api Render service DB + env + deploy trigger**
Mi a dontes: A quickquote-api (DORA RoI + Bolcsi P2 endpointok) Render deploy-hoz 2 dolog kell Istvan Render dashboard hozzáféréssel:

1. PostgreSQL DB URL: vagy uj Render Postgres service provision a quickquote-api-hoz (frankfurt region), vagy egy meglevo DB URL megadasa. Szukseges env var: DATABASE_URL=<postgres_url>
2. JWT_SECRET env var beallitasa a quickquote-api service-en
3. Manual deploy trigger a Render dashboardon (a render.yaml mar pushrolva: iszzu80-dev/quickquote-landing main 6442f7

## #fef840fd [2026-07-04] (fullstackfejleszto)
**Eskuvo: teremtervezo + AI room-analysis implementacio (Atlas spec)**
Architect spec kesz: 2026-07-03-eskuvo-deep-feature-tech-specs.md. Scope: DXF parser (room boundaries -> SVG overlay), AI room-analysis integration (OpenAI Vision), v3 multi-table model (table capacity + shape variants), component architecture. Atlas direction megvan fullstackfejlesztónak.

## #74fe2239 [2026-07-04] (fullstackfejleszto)
**Eskuvo: drag-and-drop seating canvas implementacio (Atlas SVG spec)**
Architect spec kesz: 2026-07-03-eskuvo-seating-canvas-feasibility.md + 2026-07-03-eskuvo-svg-canvas-gap-direction.md. Scope: SVG viewBox SCALE=40, HTML5 DnD (native, no lib), table-render architecture, gap-filled implementacio Atlas direction szerint.

## #c65e2459 [2026-07-04] (fullstackfejleszto)
**Eskuvo: DXF teremrajz import + room geometry parser**
Atlas spec: 2026-07-03-eskuvo-deep-feature-tech-specs.md. A room-assessment motor (fef840fd, bb15a60) explicit koordinatakat var. A DXF import kiegesziti: felhasznalo feltolti a terem .dxf rajzat, az API visszaadja a room geometriat (falak, ajtak, veszkijarat poziciok, mertekek) amelyet az assessTablesAdvanced() felhasznalhat. Scope: POST /api/eskuvo/room/import-dxf (multipart), DXF parser (LINE/LWPOLYLINE/ARC entityk -> room boundary polygon), meter koordinata extrakció SCALE=40-hez, emergencyE

## #1c509307 [2026-07-04] (fullstackfejleszto)
**Eskuvo SVG canvas: mockup delta implementacio (8 technikai delta)**
Atlas feldolgozta Istvan 05-06-lumaseat-canvas mockup-jat. 8 delta a meglevo spec-hez kepest (bb15a60 alapra epul):
1. Sidebar icon-nav: 5 view state machine (Alaprajz/Vendegek/Asztalok/Objektumok/Beallitasok) - NEM URL-routing
2. Objektumok data model: RoomObject{id,type,x,y,width,height,rotation}, 5 drag-tile tipus
3. Retegek: 5 SVG <g> csoport, CSS visibility togglek
4. AI OptimizationResult: 3 metrika + suggestions[] + bulk-apply
5. Guest relationship enum: 7 tipus, kliens szuro
6. Near-full

## #3bd283c7 [2026-07-04] (fullstackfejleszto)
**BUG-ROI-EXPORT-METHOD: POST vs GET method delta /api/roi/export**
QA lelet [060128fc]. Dispatch POST /api/roi/export de live route GET -> POST 404. Spec vagy method korrekcio szukseges: vagy spec-be GET, vagy route-ba POST handler. quickquote-api (quickquote-landing-ph/apps/api).

## #b065745c [2026-07-04] (fullstackfejleszto)
**BUG-REG-TAXID: validateTaxId(undefined).trim() crash register-nel**
QA lelet [060128fc]. POST /api/auth/register 500 ha taxId hianyzik a request body-ban. validateTaxId(undefined).trim() TypeError. Javitas: quickquote-landing-ph/packages/core/src/validation.ts validateTaxId() elejere null/undefined check (return false ha hianyzik).

## #3a18ee58 [2026-07-04] (fullstackfejleszto)
**QQ: Photo->estimate AI computer vision takeoff - URGENT**
ARCHITECT FEASIBILITY (Atlas, 2026-07-03): MEGVALOSITHATO. GPT-4V API mint MVP (3-4 het), kesobb YOLOv8 sajat model. GDPR: auto face blur + EXIF strip KOTELEZO. Phase-0 spike (1 het) az elso lepes: GPT-4V prompt engineering + latency/pontossag benchmark.

Kovetkezo: Phase-0 spike -> fullstack.

## #43ba153e [2026-07-04] (architect)
**MK: OCR nyugta-szkenner AI kategorizalassal (eRecept kompatibilis)**
Architect statusz (2026-07-03): Alacsonyabb prioritas a KATA v2 es ONYA mogott. A QQ Photo->estimate AI (3a18ee58) analiziseben mar reszben fedve (computer vision architektura). A nyugta OCR hasonlo CV pipeline-t igenyel. Reszletes spec a KATA es ONYA utan.

## #2b9912ca [2026-07-04] (fullstackfejleszto)
**MK P1: NAV auto-pull elesites**
MK Phase 2a build: NAV szamla auto-pull (mk-f1 ujrahasznositas) elesitese. MEGJEGYZES: az "agazati potlek" levalasztva errol a kartyarol es Bolcsi ala kerult (Istvan ismetelt scope-korrekcioja: az agazati potlek bolcsodei dolgozok / fenntarto+MAK feature, nem MK). Lasd Bolcsi kartya 49347caa.

## #f461cc92 [2026-07-04] (fullstackfejleszto)
**MK OCR: confirm endpoint JSON body override nem mukodik multipart scope-ban**
Buildfejleszto lelet: POST /api/mk/receipts/:id/confirm JSON body mezoi (receiptType, totalAmount, issueDate) nem ernek el a handler-hez, mert @fastify/multipart ugyanabban a plugin scope-ban fogyasztja el a body stream-et. D-OCR-3 auto-trigger OCR-parselt revenue_evidence eseten igy is mukodik. Fix: kulonvalasztani a multipart plugin scope-jat a confirm endpoint-tol, vagy kulon route-ra tenni.

## #7f53dcc5 [2026-07-04] (fullstackfejleszto)
**MK OCR nyugta-szkenner implementacio (Tesseract MVP + GDPR pipeline)**
Atlas spec: agents/architect/deliverables/2026-07-04-mk-ocr-spec.md. D-OCR dontesek lezarva (lasd 43ba153e komment). Scope: upload->Sharp->Tesseract->PiiScrubber->ReceiptParser->LLM kategorizer->draft->confirm flow. mk_receipts tabla + RLS. API: POST /upload (async), GET poll, POST confirm, GET list, DELETE GDPR. GDPR: PII scrub mielott LLM, kep S3 eu-central-1 KMS 30nap TTL, nyers OCR szoveg NEM tarolodik. UI disclaimer kotelezo: atalanyados kiadasok NEM adoalap-csokkentok.

## #0078a252 [2026-07-04] (architect)
**DORA: onboarding/demo trial wizard Mason-spec (Architect task)**
14 napos trial flow spec: POST /api/dora/demo + GET /api/dora/demo/status + onboarding wizard UI. Architect irja a Mason-spec-et, utana Mason implementalja. Revenue-potencial legmagasabb.

## #6d8a0a20 [2026-07-04] (fullstackfejleszto)
**Eskuvo: canvas delta build (sidebar nav, table states, layers, guest filter, objects, AI panel, autosave)**
7 delta implementacio az Architect spec alapjan. Spec: 2026-07-04-eskuvo-canvas-mockup-delta.md + 2026-07-03-eskuvo-svg-canvas-gap-direction.md + 2026-07-03-eskuvo-deep-feature-tech-specs.md. Mockup: uxuidesigner/deliverables/2026-07-04-istvan-brand-visuals/05-06-lumaseat-canvas-*.jpg. ~4.5 nap.

## #9b90a9fe [2026-07-04] (ba)
**Eskuvo: guest filter taxonomia AC pontositas (Bride/Groom/Mutual/Kids/Vendor vs Csalad/Baratok/Kollegak)**
GAP-LOW [6d8a0a20-G1]: a jelenlegi implementacio wedding-domain cimkeket hasznal (Bride/Groom/Mutual/Kids/Vendor). A dispatch spec Csalad/Baratok/Kollegak cimkeket irt. Megvitatando: melyik illik jobban az Eskuvo user-nek? Dontes: BA/UX.

## #d39f018d [2026-07-04] (fullstackfejleszto)
**Fix: migrate.js pre-deploy idempotency (Render pre_deploy_failed on already-run migrations)**
Migration 0014 mar lefutott, de a Render pre_deploy_failed-et jelez minden redeploy-nal. migrate.js nem kezeli gracefully a mar alkalmazott migracioakat. Fix: idempotent migracio check (CREATE TABLE IF NOT EXISTS / ALTER TABLE IF NOT EXISTS, vagy migrations table-based tracking). Erinti: minden marveen-suite deploy.

## #0871d892 [2026-07-04] (architect)
**Integration scope: quickquote-landing -> marveen-suite (ROI + Bolcsi endpoints)**
Buildfejleszto (2026-07-04) leleplezte: a DORA RoI (b3de488) es Bolcsi P2 (3f60be5) route-ok a iszzu80-dev/quickquote-landing repoban landoltak, NEM marveen-suite-ban. A production suite-api-08wb nem szolgalja ezeket az endpointokat.

Portolashoz szukseges:
- @quickquote/core -> @suite/core (Bolcsi) / @dora/core (DORA) type system mig
- SupplierRepo, ContractRepo, EirSupplierRepo, RoiBundle, BolcsiImportType adaptacio
- Auth middleware adaptacio (mindket service)
- 42 untracked file a quickquote

## #61e15f76 [2026-07-04] (marketing)
**MK: GTM - landing/onboarding + user-feedback + PostHog tracking**
GTM package: (1) landing/onboarding flow, (2) user-feedback channel, (3) PostHog usage-tracking. Coordinate with business + ux.

## #fbc038e2 [2026-07-04] (fullstackfejleszto)
**MK: F6 export (PDF + CSV/XLSX) -- 4 endpoint + pdfkit/exceljs implementacio**
Spec: agents/architect/deliverables/2026-06-28-mk-f6-export-spec.md. 4 endpoint: GET /api/mk/export/monthly, /annual, /invoices, /revenue. PDF: pdfkit/puppeteer, HU formatum, tenantProfile fejlec. XLSX: exceljs. CSV: BOM-os UTF-8. ~2 nap.

## #4b981688 [2026-07-04] (frontendfejleszto)
**Eskuvo: GTM - landing/onboarding + user-feedback + PostHog tracking**
Eskuvo GTM KESZ (Pixel, 2026-07-02 19:01). Landing LIVE (eskuvo-landing.onrender.com). Onboarding kesz. User-feedback kesz. PostHog tracking consent-gated ph() wrapper kesz. STATIKUS landing tracking nelkul. Fugg: PostHog eles kulcs (e54de18e), Compass privacy URL.

## #91df60eb [2026-07-04] (fullstackfejleszto)
**Eskuvo: guest taxonomy refactor (Csalad/Barat/Kollega + vendor flag, migration 0015)**
Spec: agents/architect/deliverables/2026-07-04-eskuvo-guest-taxonomy-migration-spec.md. 4 file: 0015_eskuvo_guest_taxonomy.sql + types.ts + eskuvo-routes.ts + seating-solver.ts. ~1.5 nap. QA: solver regression + group affinity + default=Barat.

## #3cfba158 [2026-07-04] (istvan)
**ISTVAN-DONTES: Render suite-api-08wb deploy failures -- dashboard log hozzaferes szukseges**
Mi a dontes: Istvan nezze meg a Render dashboard deploy log-jat (suite-api-08wb service), vagy adjon hozzaferest Buildfejlesztőnek. Miert kell Istvan: Render dashboard = infrastruktura hozzaferes, csak Istvan latja. Mit blokkol: marveen-suite osszes uj feature deploy-ja le van allva d953c16 ota -- Eskuvo taxonomy (f4c4733), MK F6 export (f9f4fcd), migrate idempotency fix (b284fb3) mind NINCS LIVE. Javasolt default: Istvan megnyitja a Render dashboard-ot, masolja a legjobb deploy log-ot es kuldi 

## #e1db7a30 [2026-07-04] (istvan)
**ISTVAN-DONTES: quickquote-api uj Render service manual deploy trigger (0990771)**
Mi a dontes: Triggereld manuálisan a quickquote-api Render service deploy-jat (commit 0990771).

Miert kell Istvan: uj Render service (quickquote-api) = publikus deploy = gate. Marveen provizionaltta a servicet (~01:05) + quickquote-db + JWT_SECRET. A kod kesz, de a deploy meg nem indult automatikusan.

Javasolt default: Deploy.

Mit blokkol: DORA RoI modul + Bolcsi P2 LIVE deploy (ezek a quickquote-api-n futnak az architecture dontes (Option 3) alapjan).

Mi tortenik jovahagyas utan: Buildfejle

## #854c1817 [2026-07-04] (istvan)
**ISTVAN-DONTES: dora-api-drov Render source repo visszaallitas (iszzu80-dev/dora-app)**
Mi a dontes: A dora-api-drov Render service jelenleg marveen-suite/landing-deploy-t koveti (regi kod, 262a5a2). Az interview wizard (7778c30) az iszzu80-dev/dora-app repoban van. Render service-t kell atkonifguralni: source=iszzu80-dev/dora-app, branch=main.

Miert kell Istvan: Render service konfiguraciocsere = production deployment change = gate.

Javasolt default: Allitsd vissza a dora-api-drov source-t iszzu80-dev/dora-app/main-re a Render dashboardon, majd triggereld a deploy-t.

Mit blokko

## #cf5ab92e [2026-07-04] (fullstackfejleszto)
**Bolcsi P2: Phase 2a build - Excel import + GDPR UI attr**
Atlas tech spec #3 (2026-07-03 phase2-technical-architecture-spec.md, section 3.1-3.2).

PROGRESS 2026-07-03 20:15:
✅ Excel import backend KESZ:
  - apps/api/src/excel-import.ts: shared CSV/XLSX parser (zero-dep CSV + lazy-loaded xlsx)
  - apps/api/src/bolcsi/routes.ts: POST /api/bolcsi/import (multipart upload, 3 template: children/attendance/costs)
  - Template validation: required columns, TAJ format, time format, cost category enum
  - Bolcsi types added to packages/core/src/types.ts + barre

## #060128fc [2026-07-04] (fullstackfejleszto)
**DORA: RoI (Register of Information) management modul - URGENT**
ARCHITECT FEASIBILITY (Atlas): MEGVALOSITHATO. Zero-dep xBRL-CSV serializer, 6 het.

RESEARCH VALIDACIO (Sonar): Standard ESA ITS 2024/2956 template elegendo, NINCS HU-specifikus extra mezo.

SONAR QUALITY NOTE (2026-07-03): 3 beepitett validacio hozzaadva:
1. LEI validity (GLEIF API) - format + registry check, soft-fail network errors
2. ICT provider ID missing detection - HU tax ID / company reg format check, empty field detection
3. CIF flag propagation - CTPP→critical EIR link, audit+termina

## #caa4bcb2 [2026-07-04] (frontendfejleszto)
**Bolcsi: GTM - landing/onboarding + user-feedback + PostHog tracking**
Bolcsi GTM KESZ (Pixel, 2026-07-02 19:01). Landing LIVE (bolcsi-landing.onrender.com). Onboarding kesz. User-feedback kesz. PostHog tracking consent-gated ph() wrapper kesz. STATIKUS landing tracking nelkul. Fugg: PostHog eles kulcs (e54de18e), Compass privacy URL.

## #f77460f4 [2026-07-04] (marketing)
**DORA: GTM - landing/onboarding + user-feedback + PostHog + compliance-launch**
DORA GTM (Herald, 2026-07-02 19:03): Landing LIVE (dora-landing.onrender.com). GTM content draft KESZ: agents/marketing/deliverables/2026-07-02-gtm-content-drafts-batch1.md (LinkedIn post, email, changelog, demo script, one-pager). PUBLIKALAS: Istvan-dontes. Content batch 1 tartalmazza mind a 4 termeket (QQ, Bolcsi, Eskuvo, DORA).

## #fade7c08 [2026-07-04] (istvan)
**ISTVAN-DONTES: AWS KMS IAM policy -- kms:GenerateDataKey hianyzik (MK NAV credential)**
Mi a dontes: AWS IAM user marveen-bedrock-eu kapjon kms:GenerateDataKey jogot a b2de6e4b KMS kulcson.
Miert kell Istvan: production AWS IAM policy valtozas (jogosultsag-kitegesz).
Javasolt default: GO -- minimalis hataskor, csak a NAV credential titkositashoz kell.
Alternativak: (1) Marveen kezeli ha van AWS IAM hozzaferese, (2) KMS helyett env-var alapu titkositas (arch valtoztatas).
Mit blokkol: POST /api/tenant/nav-credential 500 -- NAV-belepesi adatok tarolasa nem mukodik. A NAV auto-pull te

## #24eb89b4 [2026-07-04] (istvan)
**ISTVAN-DONTES: forceSend + CTX_SAT Phase 2 policy (5 kerdes)**
Miert kell Istvan dontese: Mason 5 Phase 2 policy kerdest tett fel a forceSend + CTX_SAT policy hardeninghez. Phase 1 instrumentation kesz (1521 PASS).

Kerdesek: Mason kanban kommentjeben (42694645)

Blokkolt kovetkezo lepes: forceSend + CTX_SAT Phase 2 implementacio

Surgosseg: LOW - marveen infra, nem product feature, nem blokkol launch-ot

## #83c8bba1 [2026-07-04] (istvan)
**ISTVAN-DONTES: Buildfejleszto GitHub collaborator hozzaadas (marveen-suite, dora-app, quickquote-landing)**
Mi a dontes: Buildfejleszto GitHub tokenjenet hozzaadasa collaborator-kent az iszzu80-dev private repokhoz (marveen-suite, dora-app, quickquote-landing). Settings -> Collaborators.
Miert kell Istvan: privat repo jogosultsag-kitegesz, csak a repo tulajdonos (iszzu80-dev) teheti meg.
Javasolt default: GO -- Buildfejleszto most code-search alapu verifikaciot hasznal, ami cache-lagot mutat privat repokon. Endpoint-teszteles igy is mukodik, de a GitHub API hozzaferes pontosabb verifikaciot tesz lehet

## #5619e1fd [2026-07-04] (fullstackfejleszto)
**QQ: Photo->estimate AI Phase-0 spike (GPT-4V prompt engineering + benchmark)**
ARCHITECT (Atlas) ajanlasa: Phase-0 spike, 1 het GPT-4V prompt engineering + benchmark.

PROGRESS 2026-07-03 21:15:

✅ Multi-model photo analysis KESZ (server.js):
  - /api/photo-structure?engine=claude|gpt4v (default: claude)
  - GPT-4V support (OpenAI gpt-4o, OPENAI_API_KEY env)
  - Claude Vision support (ANTHROPIC_API_KEY env) - existing
  - EXIF strip before AI API call (GDPR: strip GPS+camera metadata from JPEG)
  - Cost/latency tracking: ai-cost.jsonl log (model, latency_ms, input_bytes, o

## #6e00899a [2026-07-04] (fullstackfejleszto)
**QQ benchmark fotok gyujtese a netrol [Istvan GO, research-nek delegalva]**
Mi a dontes: A QQ Photo->estimate AI Phase-0 spike pipeline kesz (commit 27a36f4, GPT-4o Vision + EXIF strip + face blur + cost log). A benchmark futtatáshoz real Magyar epitkezesi fotok kellenek - ezek nelkul nem adható GO/NO-GO a computer vision takeoff-ra ([3a18ee58]).

Miert kell Istvan: csak Istvan fér hozzá valós projektfotókhoz vagy tudja kijelölni a forrást.

Javasolt default: Istvan ad 5-10 db representatív epitkezesi fotot (bármilyen felbontás, GDPR-szempontból nem publikus képek) a be

## #180aadf6 [2026-07-04] (fullstackfejleszto)
**DORA: onboarding wizard + demo trial flow implementacio (Mason, Eskuvo canvas utan)**
Spec: agents/architect/deliverables/2026-07-04-dora-onboarding-wizard-mason-spec.md. 5 file: interview-types.ts, interview-questions.ts, interview-service.ts, interview-routes.ts, demo-routes.ts. 2 DB tabla (0005_dora_interview.sql). ~2.5 nap. Post-MVP: kerdesfa HU szovegei jogasz sign-off szukseges.

## #ca9a2c32 [2026-07-04] (marketing)
**ISTVAN-DONTES: MK GTM content publikacio (changelog + FB poszt)**
DONTESI QUEUE (istvan-dontes / needs_istvan)

**Termek/projekt:** MikroKonyv
**Mi a dontes:** Herald READY-TO-POST csomag kesz: MK changelog + FB poszt. A landing LIVE (mikrokonyv-landing.onrender.com, 200 OK). Publikalhato?
**Miért kell Istvan:** Public content kikuldes (FB post, changelog).
**Javasolt default:** Igen, mehet.
**Alternativak:** Varjunk, modositas.
**Mit blokkol:** MK GTM launch utolso lepese.
**Mi tortenik automatikusan jovahagyas UTAN:** Herald kikuldi a posztokat, 61e15f76 don

## #d311f960 [2026-07-04] (marketing)
**ISTVAN-DONTES: Bolcsi P2 Excel import + GDPR UI GTM publikacio**
Herald draft kesz: agents/marketing/deliverables/2026-07-04-bolcsi-excel-import-gdpr-ui-draft.md

Mi a dontes: changelog bovites + Trust & compliance block bovites + social post + onboarding email draft + 5 FAQ publikalasa.
Miert kell Istvan: nyilvanos tartalom + onboarding email kikuldes.
Javasolt default: GO -- QA PASS, LIVE.
Alternativak: halaszt amig Bolcsi Phase 3 is kesz.
Mit blokkol: Bolcsi P2 GTM, uj bolcsodei admin felhasznalok onboardingja.
Automatikusan jovahagyas utan: Herald publika

## #ec9ec507 [2026-07-04] (marketing)
**ISTVAN-DONTES: MK OCR nyugta-szkenner GTM publikacio**
Herald draft kesz: agents/marketing/deliverables/2026-07-04-mk-ocr-scanner-draft.md

Mi a dontes: changelog + landing highlight (4. feature block) + 7 FAQ + onboarding email tip + FB social post publikalasa.
Miert kell Istvan: nyilvanos tartalom, onboarding email kikuldes.
Javasolt default: GO -- deploy gate folyamatban, QA utan azonnal mehet.
FIGYELEM (Herald guardian): ADOALAP DISCLAIMER KOTELEZO a publikacioban (atalanyados kiadasok NEM adoalap-csokkentok). Herald beleepitette a draft-ba.
Alt

## #b1d977c8 [2026-07-04] (research)
**MK: Piac+versenytars elemzes -- F6 export utan (upsell/retention)**
Fázis-végi automatikus piac-revízió (Istvan 2026-07-04 szabály). MK F6 export (PDF/CSV/ZIP) LIVE + QA GO.

Kutatási kérdések:
1. Milyen export/könyvelési integrációkat kínálnak a konkurensek (Billingo, Számlázz.hu, Billr)? Van-e NAV XML export, Számlák.hu connector, vagy automata könyvelői beküldés?
2. Milyen export-feature iránt érdeklődnek az átalányadós vállalkozók fórumokon/FB-csoportokban?
3. Van-e upsell lehetőség (pl. NAV XML export, recurring export email, könyvelői megosztás link)?

Out

## #b10a4d51 [2026-07-04] (research)
**Eskuvo: Piac+versenytars elemzes -- guest taxonomy + canvas utan (upsell/retention)**
Fázis-végi automatikus piac-revízió (Istvan 2026-07-04 szabály). Eskuvo guest taxonomy (Család/Barát/Kolléga + vendor flag) + canvas delta LIVE + QA GO.

Kutatási kérdések:
1. Mit kínálnak a versenytársak (Zola, Bridebook, Joy.com, HU-specifikus) vendéglistában és ültetési tervben? Van-e RSVP-kezelés, ételallergia tracking, plus-one kezelés?
2. Milyen esküvőszervező-specifikus feature-ök hiányoznak a piacról (blue ocean)?
3. Upsell lehetőség: e-meghívó, RSVP link, wedding website integráció?

Ou

## #94ca89b0 [2026-07-04] (research)
**Bolcsi: Piac+versenytars elemzes -- P2 Excel import + GDPR UI utan**
Fázis-végi piac-revízió. Bolcsi P2 (Excel import + GDPR consent UI) LIVE.
Kérdések: Milyen adatimport/GDPR feature-öket kínálnak versenytársak (Coachhub, Moodle, stb.)? Bulk client import, consent management, data export kérés? Upsell lehetőség.

## #25843e14 [2026-07-04] (research)
**DORA: Piac+versenytars elemzes -- RoI modul + onboarding utan**
Fázis-végi piac-revízió. DORA RoI (Register of Information) + onboarding wizard LIVE (deploy pending).
Kérdések: Milyen DORA-compliance tool-ok léteznek (Riskonnect, OneTrust, Archer)? Automatikus supplier kockázat scoring, API-alapú supplier adatlekérés, dashboard export? Upsell lehetőség.

## #217e44a8 [2026-07-04] (research)
**MK: Piac+versenytars elemzes -- OCR nyugta-szkenner utan (upsell/retention)**
Fázis-végi piac-revízió. MK OCR nyugta-szkenner QA 7/7 PASS.
Kérdések: Milyen OCR/receipt-scanning megoldásokat kínálnak versenytársak (Dext/Receipt Bank, AutoEntry, Hubdoc)? Van-e automatikus NAV-összepárosítás, bank statement import, category prediction AI? Milyen upsell lehetőség az átalányadós EV szegmensben (pl. havi korlát → unlimited tier)?

## #e7080925 [2026-07-04] (marketing)
**DORA landing: FAQ szekcio magyar ékezetek hiánya**
A DORA landing FAQ szekciójában (~20+ szo) teljesen hianyoznak a magyar ékezetek. Erintett szavak: kerdesek, toltom, kerdeset, valaszokat, ertekekkel, szabvany, nyelvu, mezoihez, vegen, elore, kitoltott, elokeszitve, szemelyre, kezdo, utmutato, altal, eloirt, informacios, nyilvantartas, eszkozoket, beszallitoit, szolgaltatasait, besorolasat, elerheto, nyilvantartassal, validacioval. A feature-kartya szovegeben is: "mostantol elerheto". Ez egy compliance-termek, egy IT-biztonsagi vezeto szamara a

## #e24483e0 [2026-07-04] (fullstackfejleszto)
**MK: NAV credential storage -- KMS envelope-encryption implementacio (MK-F1)**
KMS IAM UNBLOCKED (fade7c08 done). SUITE_KMS_ARN a store/.kms-key-ids-ben.

Pattern: GenerateDataKey -> plaintext data key -> NAV credential titkositas (AES-256) -> encrypted data key + ciphertext tarolasa DB-ben. Decrypt: KMS Decrypt(encrypted_data_key) -> plaintext key -> NAV cred visszafejtese.

Architect: gyors spec (melyik tabla/mezok, melyik service, key rotation terv). Mason: implemental.

SUITE_KMS_ARN env var szukseges a suite-api-08wb-n (Marveen allitja be).

## #a3714f1d [2026-07-04] (buildfejleszto)
**QQ landing: /app CTA 404**
A fo landing oldal CTA gombjai ("Kezdd el ingyen — 4 hetes trial" es "Regisztralok — 4 hetes trial") a /app URL-re mutatnak, ami 404-et ad a quickquote-landing.onrender.com szerveren. A server.js-ben nincs /app route. A quickquote-api.onrender.com/app szinten 404. A /demo mukodik (200). Blokkolja a regisztraciot.

## #dd96afa1 [2026-07-04] (fullstackfejleszto)
**QQ: Photo classifier hardening -- rate limit + MIME check + PNG EXIF (post-deploy)**
Post-deploy QA medium notes a 2842b44 code review-bol:

1. Rate limit: IP-alapu throttling (pl. 20 req/perc) a POST /api/estimate/photo-ra -- vedelem API cost abuse ellen
2. MIME type check: Content-Type validalas upload-nal (nem-kep feltoltes jelenleg 500-at dob Claude API error-ra)
3. PNG EXIF strip: stripExif() jelenlegi implementacio csak JPEG-et kezel -- PNG tEXt chunk GPS-t tartalmazhat (GDPR kis valoszinusegu gap)

Fuggeseg: [165c9955] ANTHROPIC_API_KEY Istvan GO utan deployolni kell az a

## #6fcf2fb4 [2026-07-04] (research)
**DORA STEP-1a: SMB/supplier/consultant differentiator research (re-anchor)**
MEGBÍZÓ: deliverylead (Maestro) -- Istvan GO + re-anchor direktíva alapján.

Kontextus: Az eddigi DORA anyagok enterprise-GRC (OneTrust/Archer/Riskonnect) versenytárshoz képest pozicionáltak -- ez ROSSZ CÉLPONT. Istvan direktíva: PRIMARY audience:
1. Kötelezett kkv-k (közvetlenül NIS2/DORA hatálya alatt)
2. Kötelezett entitások BESZÁLLÍTÓI (supply-chain pressure)
3. Magyar tanácsadó cégek (channel/B2B2B)

Kérdések:
1. A kkv/tanácsadó szegmensben mi a tényleges DORA compliance piac? Melyik HU esz

## #0a9c28a5 [2026-07-04] (research)
**MK OCR NAV STEP-1a: differentiator research -- OCR vs NAV app + pénztárgép vendorok**
MEGBÍZÓ: deliverylead (Maestro) -- Istvan GO alapján.

Feladat: Versenypiaci differenciátor-validáció.

Kérdések:
1. Mi a MikroKönyv OCR/receipt-capture SPECIFIKUS előnye a NAV ingyenes e-nyugta app-pal szemben?
2. A pénztárgép/e-pénztárgép vendorok (PROAB, arhivix, stb.) pontosan mit csinálnak? Mi hiányzik náluk?
3. Melyik persona/szegmens nyerhető meg OCR-alapú megközelítéssel: fodrász/személyi-szolgáltató, kis-kereskedő, más?
4. Van-e olyan szegmens ahol a NAV ingyenes app nem segít (pl. több

## #6871d22d [2026-07-04] (business)
**DORA STEP-1b: SMB/supplier/consultant pozicionálás + RoI frame (Compass értékelés)**
DONE 2026-07-05. Deliverable: agents/business/deliverables/2026-07-04-dora-smb-pozicionalas.md. GO ítélet: Scope Checker freemium belépő -> RoI Generator -> Evidence Pack Wizard. Incident Pipeline MVP+. Vegyes modell: self-serve SaaS + B2B2B tanácsadói portal. Differenciáló: evidence pack speed + am-I-in-scope automation. Herald eaadd8d3 kész indulni.

## #8a37e731 [2026-07-04] (architect)
**Zsibongó: spec + v1 slice-határ meghatározás (FULL GO, URGENT)**
MEGBÍZÓ: deliverylead (Maestro) -- Istvan direktíva (tg2790) MAX PRIORITY.

FELADAT: NE találj fel semmit. Az Istvan thick protóból nyerd ki a spec-et, és abból hozz létre egy teljes architektúra-dokumentumot ami alapján Mason (fullstack) le tudja fejleszteni.

PROTO HELYE:
- /mnt/c/Users/iszzu/OneDrive/Documents/marveen-protos/bolcsi-proto-thick/index.html
- /mnt/c/Users/iszzu/OneDrive/Documents/marveen-review/bolcsi-proto.html
- Pozicionálási jelek: /mnt/c/Users/iszzu/OneDrive/Documents/család

## #eaadd8d3 [2026-07-04] (marketing)
**DORA landing + anyagok re-anchor: SMB/supplier/consultant (enterprise-drift javítás)**
MEGBÍZÓ: deliverylead -- Istvan direktíva (tg2779-2782).

Probléma: A dora-landing copy és az eddigi GTM anyagok enterprise-GRC versenytárs ellen pozicionáltak (OneTrust/Archer/Riskonnect). Ez rossz célpont.

Alapközönség (re-anchor):
- PRIMARY: kötelezett kkv-k, kkv-BESZÁLLÍTÓK kötelezettekhez, HU tanácsadók
- SECONDARY (lehetséges): enterprise saját munkájának egyszerűsítése

Teendő (Compass STEP-1b deliverable UTÁN):
1. dora-landing hero/CTA copy re-írás: kkv/tanácsadó fókusz, self-serve, meg

## #94ba9950 [2026-07-04] (qa)
**[ff6b22aa] Zsibongó QA -- tesztterv + slice-tesztelés**
Zsibongó bölcsőde menedzsment QA: tesztterv készítés + slice-ok tesztelése ahogy Mason buildelé.
Slice sorrend: Foundation→Core→KENYSZI→HR→Safety→Intelligence→Multi-site.
Prioritások: deriváció invariancia, KENYSZI reportability, RATIO_RULE, deadline, Art.9 allergy RBAC, AuditLog append-only, rule-pack.

## #91421e23 [2026-07-04] (istvan)
**ISTVAN-DÖNTÉS: Zsibongó fee-split (délelőtt bölcsőde / délután gyermekfelügyelet) -- v1 scope?**
Mi a döntés: A leaders.txt alapján valós fenntartói igény: ugyanaz a helyszín délelőtt bölcsődeként, délután gyermekfelügyeletként működik, eltérő díjszabással. A thick proto ezt NEM tartalmazza. Ha v1 scope: service_type mező az attendance + payments táblákba, kettős díjszabás logika.

Miért kell Istvan: Scope-bővítés a thick protón és az eredeti v1 listán túl.

Javasolt default: NEM v1 scope -- a proto nem tartalmazza, az adatmodell service_type mezővel Phase 2-ben hozzáadható visszamenőleges 

## #9838b671 [2026-07-04] (istvan)
**ISTVAN-DÖNTÉS: Zsibongó multi-telephely -- v1 teljes feature VAGY Phase 2?**
Mi a döntés: Az architect javasolja a multi-telephely full feature-t Phase 2-be tolni, de a site_id nullable oszlopot most felvenni (cost: nulla). Istvan tg2800-ban a multi-telephely v1 scope-ba sorolódott.

Miért kell Istvan: Istvan explicit v1 scope-ot mondott, az architect Phase 2-t javasol.

Javasolt default: Architect javaslatát fogadjuk el -- site_id nullable most, full feature (telephely-váltó UI, per-site dashboard, telephelyvezető JWT claim) Phase 2. Indok: a v1 single-telephely esetén 

## #ff6b22aa [2026-07-04] (qa)
**Zsibongó: QA -- v1 build acceptance (6 szerepkör, derivációs gráf, Auth/RBAC, Art.9)**
Függ: build kártya DONE.
Acceptance criteria: architect spec alapján.
Kiemelten: Art.9 adatkezelés, Auth/RBAC 6 szerepkör, derivációs gráf fan-out auditálhatóság, KENYSZI motor.

## #38537dab [2026-07-05] (fullstackfejleszto)
**ANYK->ONYA asszisztens deploy (Render free) [Istvan GO]**
Mi a dontes: Az ANYK->ONYA Migracios Asszisztens MVP kesz (single-file HTML, 17KB, zero-dep). Publikusan elerheto kell MK acquisition channelkent.

Miert kell Istvan: public deploy.

Javasolt default: mikrokonyv-landing.onrender.com/anyk-onya aloldalkent (0 pluszköltseg, meglevo landing). Alternativa: kulon Render static site (ingyenes tier).

Mit blokkol: tool erhetosege -> MK lead-generacias.

Mi tortenik jovahagyas utan: buildfejleszto deployolja, marketing CTA a MK landingre, PostHog hozzaad

## #c4599c08 [2026-07-05] (marketing)
**Zsibongo GTM draft -- landing/feature/launch-post/onboarding**
MEGBÍZÓ: deliverylead -- Zsibongó Build+QA DONE, production deploy folyamatban.

Feladat: landing page draft, feature copy (6 feature: KENYSZI portal-kitoltesi segedlet, attendance+etkezes, multi-telephely, pickup-auth, allergy KMS, eszkoz-nyilvantartas), launch post draft (Telegram + Facebook + LinkedIn + changelog), onboarding checklist draft (6 lepes + email sorozat + AHA momentumok).

Output: agents/marketing/deliverables/2026-07-05-zsibongo-gtm-draft.md

Publikálás: Istvan-dontes (NEM autom

## #a0969ac0 [2026-07-05] (marketing)
**DORA landing re-anchor publish [6ca96ee5]**
Istvan GO, deliverylead brief. Publikalas: landing frissites (SMB/supplier/consultant pozicionalas) + launch copy.

DONE 2026-07-05: dora-landing.onrender.com LIVE uj copy-val. Scope checker, evidence pack, KKV ar. Telegram ertesitve.

## #7016de51 [2026-07-05] (istvan)
**ISTVAN-DONTES: Zsibongo GTM publikalas (landing + feature copy + launch post TG/FB/LI + onboarding)**
Marketing GTM draft kesz [c4599c08]: agents/marketing/deliverables/2026-07-05-zsibongo-gtm-draft.md. Outward-facing -> Istvan-dontes a publikalasrol. Zsibongo v1 build DONE + QA GO + afa3342 LIVE (deploy gate PASS 2026-07-05).

## #6ca96ee5 [2026-07-05] (istvan)
**ISTVAN-DÖNTÉS: DORA landing + anyagok re-anchor publikálása**
Mi a döntés: A DORA marketing re-anchor draft elkészült. Publikálható-e a landing page frissítés + GTM anyagok?

Miért kell Istvan: Publikus poszt / külső tartalom publikálás = Istvan-gate.

Draft: agents/marketing/deliverables/2026-07-05-dora-reanchor-draft.md
Tartalom: 3-door landing hero (kkv/supplier/consultant), FAQ, GTM útmutató (LinkedIn, email, one-pager, demo), pricing szekció, mérési terv.
Differenciátor: "From Am-I-in-scope to a complete DORA evidence pack in one day -- not enterprise

## #74d42337 [2026-07-05] (marketing)
**ISTVAN-DONTES: Eskuvo teremtervezo + SVG canvas GTM publikacio**
Herald draft kesz: agents/marketing/deliverables/2026-07-04-eskuvo-room-analysis-canvas-update.md

Mi a dontes: changelog + landing highlight (AI teremtervezo + SVG drag-and-drop canvas) + vendor FB poszt + 5-kereses FAQ bovites publikalasa.
Miert kell Istvan: nyilvanos tartalom publikalas (landing, social).
Javasolt default: GO, kiszallas ma -- mindket feature LIVE, QA folyamatban.
Alternativak: (1) var QA vege utan, (2) canvas poszt halasztas amig DXF import is kesz (egy nagyobb feature releas

## #3bd9489d [2026-07-05] (istvan)
**ISTVAN-DONTES: Zsibongo v1.1+ build roadmap jovahagyasa**
Javasolt sorrend (Compass 2026-07-05): v1.1 KENYSZI auto-export 1-2 het -> v1.2 Penzugyi modul +1990 Ft/ho upsell 3-4 het ~10.7M Ft ARR -> v1.3 Magan ovoda extension 2-3 het -> v2.0 Szuloi mobilapp. Jovahagyas utan: Mason v1.1 + Architect v1.2 spec parhuzamosan. Business case: agents/business/deliverables/2026-07-05-zsibongo-v1-post-deploy-business-case.md

## #f204f4c8 [2026-07-05] (fullstackfejleszto)
**Bolcsi v1.1: KENYSZI auto-export (CSV/Excel, portal-formatumu)**
Istvan GO 2026-07-05. A KENYSZI motor kesz [f635e802], de manualis kitoltes kell. Cel: GET /api/zsibongo/kenyszi-export endpoint (Content-Disposition: attachment), kenysziRows() -> KENYSZI portal mezo mapping, RBAC: KENYSZI-felelos + intezmenyvezeto. 1-2 het (S). Mason buildeli, Falcon QA-zza.

## #bd9110b5 [2026-07-05] (fullstackfejleszto)
**Bolcsi: KENYSZI portal-kitoltesi segedlet (verify-and-click) - URGENT**
Phase-2+ scouting #3 URGENT: PRIORITAST EMELNI. A KENYSZI motor (f635e802) kesz, de a portal-kitoltesi segedlet (verify-and-click) - "melyik mezobe mit irj, kattintas-sorrendben" - meg NINCS kesz. Ez A wedge.

Forras: agents/research/deliverables/2026-07-03-phase2+-scouting-uj-otletek.md

Scope: KENYSZI portal UI asszisztens a meglevo motorra epitve. Verify-and-click workflow.

## #5984e72e [2026-07-05] (marketing)
**Bolcsi v1.1 KENYSZI GTM -- changelog + feature announcement (draft)**
KENYSZI CSV auto-export elesben (9653eda, 2026-07-05). Herald draftol: changelog entry, feature announcement intezmenyvezeto/fenntarto szegmensnek, bolcsi-landing.onrender.com frissites (KENYSZI szekcio). Publikalas Istvan-dontes.

## #a095278c [2026-07-05] (deliverylead)
**Bolcsi (Zsibongó) re-anchor: 3-oldalú modell + Istvan thick proto alapján spec (URGENT)**
Re-anchor a Bolcsi build+landing az Istvan-korrigalt celcsoportra/hatokorre (7+1/csoport, 1 csoport=1 csaladi bolcsode, multi-telephely) es a 3 user-oldalra: (1) adminisztracio (fenntarto: normativa/MAK, teritesi dij, agazati potlek, KENYSZI), (2) gondozok (rogzites+sajat adat), (3) SZULOK (adatmegadas, FIZETES, info). SPEC-IGAZSAG = Istvan thick protoja: /mnt/c/Users/iszzu/OneDrive/Documents/marveen-protos/bolcsi-proto-thick/index.html -- funkcioi: Attekinto, Gyerekek(roster), Csoport+arany, Je

## #11573cde [2026-07-05] (business)
**MK OCR NAV STEP-1b: pozicionálás + business case -- Compass értékelés**
MEGBIZO: deliverylead (Maestro) -- Istvan GO alapjan.

EREDMENY: GO -- szuk scope-pal (Szint 1: bejovo papirnyugta OCR + konyveloi export). NEM ajanlott: sajat kimeno nyugtakiallitas/ePenztargep-alternativa (szabalyozasi teher, felesleges verseny NAV ingyenes appal).

Uzleti modell: MK Pro upsell (freemium 50 nyugta/ho -> 1990 Ft/ho korlatlan), NEM standalone.
Persona fokusz: epitoipari/szakipari vallalkozok + fodrasz/kozmetikus szegmens.
Piaci meret: 25000-40000 vallalkozas a celresben, becsult

## #649bacd9 [2026-07-05] (deliverylead)
**DORA -- RoI Generator STEP-1: SMB/supplier/consultant re-anchor + differentiator validáció (Istvan GO)**
Mi a dontes: DORA platform kovetkezo feature-set: RoI Generator (ROI szamitas + benchmark riport PDF) + Incident Pipeline (incidens ruzin workflow). Mid-market gap: 86% nem compliant, enterprise EUR 5-15k/ho, mi beleferunk.

Miert kell Istvan: uj feature build (M+L, 6-8 het), strategiai DORA roadmap dontese.

Javasolt default: GO -- 86% non-compliant mid-market, kek ocean, arverseny nyer az enterprise ellen.

Alternativa: CSAK RoI Generator (M, 3-4 het) -- Incident Pipeline kesobb.

Mit blokkol:

## #8f3b94df [2026-07-05] (fullstackfejleszto)
**BUILD: DORA belepo funnel backend (szegmens-specifikus hook + pillar assessment)**
Spec: agents/architect/deliverables/2026-07-05-dora-spec.md Section 4b + 5/6/8/9. Tartalom: dora_hook_sessions (segment kkv/supplier) + dora_pillar_assessments tabla, hook-routes.js (HOOK_QUESTION_SETS config), interview seed a claim utan, TTL cleanup job. Build estimate: ~1.5 het (Slice A resze). Fugg: Herald veglegesiti a kerdes-szoveget parhuzamosan, nem blokkolo.

## #033becb1 [2026-07-05] (buildfejleszto)
**BUILD: MK OCR NAV kvota-gate + konyveloi export (STEP-3)**
Spec: agents/architect/deliverables/2026-07-05-mk-ocr-nav-step2-spec.md. FONTOS: az OCR motor mar LIVE (0013 migracio), ez CSAK a monetizacios reteg. Tartalom: migracio 0015 (tenants.mk_ocr_tier + mk_ocr_usage_monthly), kvota-middleware upload elott (402 free tier felett), GET /api/mk/receipts/export (CSV kotelezo, PDF fazis-2). Queue: 8f3b94df (DORA hook backend) mogott, mert Mason 1 aktiv build-et kezel parhuzamosan.

## #819f8780 [2026-07-05] (research)
**Bolcsi (Zsibongo): Piac+versenytars elemzes -- v1 GTM + v1.1 KENYSZI export utan (upsell/retention)**
FAZIS-VEGI PIAC-REVIZIO (automatikus szabaly, Istvan-dontes nelkul). Zsibongo v1 build+QA+GTM lezarult [282,275,276,281 done], v1.1 KENYSZI auto-export build+QA kesz [287 done], GTM draft var Istvan publikalasi dontesre [dcac04d9]. v1.2 Penzugyi modul spec mar folyamatban [683f1829] egy korabbi roadmap-jovahagyas alapjan [283], DE ehhez nem elozte meg friss piac/versenytars-elemzes -- ezt potolja ez a kartya.

Feladat: van-e uj feature amivel erdemes tovabbfejleszteni a Zsibongot -> UPSELL-lehet

## #fb19a8ba [2026-07-05] (marketing)
**MK OCR NAV STEP-3 GTM: kvota-gate + MK Pro upsell (50 nyugta/ho -> 1990 Ft/ho)**
Build+QA GO [033becb1, Falcon live-verify]. Mar elesben fut (suite-api-08wb), Falcon elo teszttel verifikalta.

Feladat Heraldnak: changelog + feature announcement draft a meglevo MK-felhasznaloknak -- uj kvota-gate (50 nyugta/ho ingyenes, felette 1990 Ft/ho korlatlan MK Pro), konyveloi CSV/PDF(kesobb) export. Pricing-kommunikacio draftja is (mennyiért, hogyan valt at, upgrade flow).

PUBLIKALAS Istvan-dontes lesz (pricing/public content) -- ezt kulon kartyaval kerem majd be, ha a draft kesz.

## #0b438309 [2026-07-05] (architect)
**MK OCR NAV STEP-2: architect spec (bejovo papirnyugta OCR + NAV export, MK Pro upsell scope)**
MEGBIZO: deliverylead (Maestro) -- Compass STEP-1b GO alapjan [11573cde].

Scope (Compass GO, szuk): CSAK bejovo papirnyugta OCR + NAV-kompatibilis export (Szint 1). NE sajat kimeno nyugtakiallitas/ePenztargep-alternativa (szabalyozasi teher, felesleges verseny NAV app-al).

Uzleti modell: MK Pro upsell, NEM standalone. Freemium 50 nyugta/ho ingyenes -> 1990 Ft/ho korlatlan.

Persona: epitoipari/szakipari vallalkozok (bejovo anyagkoltseg/uzemanyag OCR), fodrasz/kozmetikus (reszleges NAV app lefe

## #e499276e [2026-07-05] (architect)
**DORA: publikus hook-kerdoiv vs teljes assessment -- funnel design dontes**
Istvan 2026-07-05: kell egy roviddebb publikus hook-kerdoiv (login nelkul). DONTENDO: (A) ket-szintu -- rovid publikus hook (3-5 kerdes, erintett vagy-e) KULON a hosszabb post-signup eligibility+system_scope assessment-tol, a hook adatai atviheto/pre-fill; VAGY (B) egyseges -- ugyanaz a kerdoiv szolgalja mindketto. Workflow: Research (versenytars: Vanta/Drata/OneTrust hogyan csinaljak a scope-hook-ot) + Marketing (celcsoport uzenet/konverzio) kor KOTELEZO, majd architect specelje. Marveen-ajanla

## #ea6a0f26 [2026-07-05] (marketing)
**DORA post-signup piller-felmeres TARTALOM: kerdes-szoveg (Herald) + DORA cikk-mapping (Aegis)**
Elofeltetel: 8f3b94df (hook backend + dora_pillar_assessments SEMA) kesz. A sema uresen all -- a tenyleges 20-40 kerdes (5 DORA piller: ICT Governance, Incident Management, Resilience Testing/TLPT, Third-Party Risk, Information Sharing) + framework-mapping (ISO27001/SOC2/NIS2 overlap) adatok hianyoznak. Herald irja a kerdes-szoveget, Aegis ellenorzi a DORA cikk-hivatkozasokat jogi pontossagra. Csak ez utan tudja Mason a route-logikat (kerdesfeldolgozas, gap-analysis, action plan) megepiteni a ma

## #c8eeb729 [2026-07-05] (frontendfejleszto)
**BUILD: DORA 3-door hero + HookWizard frontend (KKV/Beszallito/Tanacsado)**
Frontend Slice A (Section 4b) kesz. TypeScript + Vite build hiba nelkul (53 modul, ~232KB JS bundle). Leszallitott fajlok: lib/hookApi.ts, components/HookWizard.tsx, components/HookResult.tsx, views/Landing.tsx, views/Signup.tsx, App.tsx (react-router-dom atiras). Nincs blokkolo.

## #4b3ce6d6 [2026-07-05] (marketing)
**Bolcsi v1.2 GTM: Penzugyi modul (szamlazas+befizetes+agazati potlek) draft**
Build+QA GO [993fd540]. Uj add-on: szamlazas, befizetes-tracking, gyermek-egyenleg, agazati potlek szamfejtes, havi penzugyi riport (CSV+PDF). ~1990 Ft/ho.

Feladat Heraldnak: changelog + feature announcement + arazas-kommunikacio draft a meglevo Bolcsi-felhasznaloknak. Draftolas mehet, tenyleges publikalas Istvan-dontes lesz.

## #dcac04d9 [2026-07-05] (istvan)
**ISTVAN-DONTES: Bolcsi v1.1 KENYSZI GTM publikalas**
Mi a dontes: changelog + feature announcement + outreach publikalas (bolcsi-landing.onrender.com + email). Miert kell Istvan: publikus landing frissites + kulso email kikuldes. Javasolt default: IGEN, azonnal -- KENYSZI export elesben, fenntartok ezt varjak. Alternativa: csak landing, outreach kesobb. Mit blokkol: intezmenyek nem tudnak az uj exportrol. Jovahagyas utan: Herald publishol landingre + elküldi az outreach emailt. Draft: agents/marketing/deliverables/2026-07-05-bolcsi-v11-kenyszi-csv

## #a3649a8c [2026-07-05] (istvan)
**ISTVAN-DONTES: MK OCR NAV STEP-3 (kvota-gate + MK Pro upsell) GTM publikalas**
Mi a dontes: changelog + feature announcement (email+in-app) + landing feature card update publikalasa a meglevo MK-felhasznaloknak. Herald draft kesz: agents/marketing/deliverables/2026-07-05-mk-ocr-nav-step3-draft.md.

Tartalom: 50 nyugta/ho ingyenes -> 1990 Ft/ho MK Pro korlatlan (uj kvota-gate elesben), + konyveloi CSV export. Ar-tabla Free vs Pro. Guardrail: 50 igazolhato szam, atalanyado adoalap disclaimer a Pro-ban is, nincs auto fizetesse alakitas.

Miert kell Istvan: pricing-kommunikaci

## #0a551c4f [2026-07-05] (istvan)
**ISTVAN-DONTES: Bolcsi v1.2 Penzugyi modul GTM publikalas**
Mi a dontes: changelog + landing feature card + pricing update (+1990 Ft/ho add-on) + feature announcement (intezmenyvezetoknek) + FAQ bovites publikalasa. Herald draft kesz: agents/marketing/deliverables/2026-07-05-bolcsi-v12-penzugyi-modul-draft.md.

Miert kell Istvan: pricing-kommunikacio + nyilvanos tartalom (landing, in-app).

Javasolt default: GO -- build+QA teljesen lezarult (Falcon vegso GO [993fd540]), guardrail-ok bent vannak (nem szamlazo program, nem penzugyi tanacsadas, agazati potl

## #326d7c40 [2026-07-05] (marketing)
**Eskuvo marketplace presale outreach (10+ venue validacio)**
Istvan GO [5cb2b113]. Marketplace (v3.0) CSAK 10+ venue presale utan epul -- eloszor kereslet-validacio kell. Herald keszitse el a presale outreach anyagot (venue/vendor celzott kimeno uzenet, mi az ajanlat, hogyan lehet presale-re jelentkezni).

## #7dc247ca [2026-07-05] (architect)
**Eskuvo uj arazas: event-based par + venue/vendor B2B tier -- business+architect spec**
Istvan GO [5cb2b113]. Uj arazasi modell: event-based dijazas a paroknak (nem havidijas), kulon venue/vendor B2B tier. Compass definialja a konkret arakat/tiereket, Atlas beepiti a specbe (billing logika, ha kell).

## #26bfd904 [2026-07-05] (buildfejleszto)
**BUILD: Eskuvo v1.1 guest import/export**
Istvan GO [5cb2b113] 2026-07-05. Guest import (1-2 het, S meret). Compass business case: agents/business/deliverables (2026-07-05-eskuvo-post-gtm-business-case.md).

## #2396c4a6 [2026-07-05] (buildfejleszto)
**BUILD: Eskuvo payment scaffold (provider-agnosztikus, NEM blokkolt resz)**
Spec: agents/architect/deliverables/2026-07-05-eskuvo-payment-architecture-spec.md. Csak a nem-blokkolo resz: PaymentProvider interfesz + route-vaz (checkout/venue-subscription/webhook), migraciok (eskuvo_couple_purchases, eskuvo_venue_accounts, eskuvo_venue_subscriptions, payment_events, nav_issuer_credentials + tenants ALTER), nav-issuer-client.ts NAV TEST kornyezetben validalva. TILOS: tenyleges provider API-kulcs bekotes (Stripe/SimplePay/Barion) amig az Istvan-dontes kartya nincs jovahagyva

## #d30e95a4 [2026-07-05] (istvan)
**ISTVAN-DONTES: Anthropic API kredit feltoltes/plan upgrade szukseges (QQ Vision blokkolva)**
Mi a dontes: a suite-api-08wb ANTHROPIC_API_KEY-hez tartozo Anthropic fiok kredit-egyenlege tul alacsony -- a QQ Vision photo-estimate endpoint (POST /api/estimate/photo) minden hivasa bukik "credit balance is too low" hibaval. Falcon fuggetlenul verifikalta: a wiring/kod HELYES (kulcs jelen, API-hivas megtortenik, hibakezeles korrekt), tisztan fioke-szintu penzugyi kerdes.

Miert kell Istvan: fizetos szolgaltatas egyenlegenek feltoltese/csomag-valasztas -- penzugyi dontes.

Javasolt default: to

## #165c9955 [2026-07-05] (istvan)
**ISTVAN-DONTES: QQ Vision -- ANTHROPIC_API_KEY beallitasa suite-api-08wb-n (uj paid API call)**
Mi a dontes: A QQ Photo->estimate Phase-1 endpoint (POST /api/estimate/photo) Claude Vision-t hiv a suite-api szerveren. Ehhez ANTHROPIC_API_KEY kell a suite-api-08wb Render service env var-jaba.

Miert kell Istvan: uj paid API credential bekotese production Render service-re (minden foto-elemzes Anthropic API-t hiv -> koltseggel jar).

Javasolt default: GO -- a Vision call per-request, nincs subscription, Claude Sonnet 4.6 arfolyamon kb. $0.003/foto. Volumenel Istvan kontrollalja.

Mit blokkol:

## #5b0512f6 [2026-07-05] (fullstackfejleszto)
**QQ: Photo->estimate Phase-1 -- prompt engineering + taxonomy + dataset fix**
Benchmark GO (5619e1fd). Phase-1 implementacio:

1. Dataset: relabel/replace 4 flagged photos (07:bontas, 08:padloburkotas, 09:tetofedes, 12:hoszigetes)
2. Taxonomy: base 4 category + tetofedes + acs munka + hoszigetes hozzaadasa
3. Multi-label output: primary + secondary work type (pl. bontas+burkolas egyszerre)
4. Room-overview guidance: UI hint hogy room-overview fotot kerjunk, ne tool close-up-ot
5. Prompt engineering: glettelés/vakolás + burkolas/bontas ambiguity pairs kezelese
6. Claude Vi

## #42694645 [2026-07-05] (fullstackfejleszto)
**forceSend + CTX_SAT policy hardening**
ASSESSMENT COMPLETE (Atlas, 2026-07-01). Deliverable: agents/architect/deliverables/2026-07-01-forcesend-ctxsat-policy-assessment.md

Three-layer design:
1. DETECTION (P1, 2-3h): Periodic scan + creation-time log. Dashboard filter endpoint.
2. MINIMUM HANDLING (P1, 3-4h): CTX_SAT check before forceSend inject -> log + Telegram alert + dispatch-guard.sh parallel. Injection proceeds (contract preserved).
3. SAFE MODE (P2, 5-7h): Queue as pending retry on CTX_SAT, fire recovery, inject after agent 

## #42ec238f [2026-07-05] (istvan)
**ISTVAN-DONTES: Eskuvo vendeg-consent kikuldo szolgaltatas valasztasa**
Mi a dontes: a vendeg-oldali consent-megerosito flow-hoz [cec728f7, Muse spec] kimeno ertesites kell a vendegeknek, tokenes linkkel. JELENLEG NINCS ilyen szolgaltatas konfiguralva a suite-ban -- Anvil governance-szabaly miatt nem allithatja be sajat hataskorben (uj kulso szolgaltatas + credential).

Miert kell Istvan: uj fizetos/kulso szolgaltatas bekotese, production credential.

Javasolt default: elsokent csak egy csatorna (masodlagos csatorna kesobbre) -- egy egyszeru tranzakcios kikuldo-szol

## #a69f4e3d [2026-07-05] (jogász)
**ISTVAN-DONTES: DORA regisztralt ugyved-review kell-e production launch elott?**
Mi a dontes: Aegis (jogasz-agens) DORA onboarding kerdesfa (securityClass besorolas) review soran 3 hibat talalt (2 rossz DORA-cikk hivatkozas, 1 hianyzo jogaszi-megerosites disclaimer) -- fix folyamatban [c101338a]. Aegis SAJAT MAGA javasolja: regisztralt (human) ugyved altali review production launch elott, mivel ez hatarozza meg az ugyfeleknek mutatott jogi scope/besorolast (DORA compliance-kategoria).

Miert kell Istvan: jogi/compliance koltseg+idozites dontes, kulso fel bevonasa.

Javasolt 

## #dea621a3 [2026-07-05] (frontendfejleszto)
**ZST Radio landing: termek-linkek atirasa uj zstradio.com subdomainekre**
Istvan feladat (Marveen via, pre-authorizalt git push/deploy). zstradio-landing repo (Render static_site, srv-d90ln15ckfvc73dihi9g). Termek-linkek cseréje a regi .onrender.com URL-ekrol az uj subdomainekre: MikroKonyv->https://mikrokonyv.zstradio.com, QuickQuote->https://quickquote.zstradio.com, LumaSeat/Eskuvo->https://lumaseat.zstradio.com, Zsibongo/Bolcsi->https://zsibongo.zstradio.com, DORA->https://dora.zstradio.com. Commit+push, auto-deploy. Verifikalni: mind az 5 subdomain HTTPS 200 (Marv

## #58272ce7 [2026-07-05] (buildfejleszto)
**BUILD: Eskuvo vendeg-consent automatikus kikuldes (email-szolgaltatas)**
Spec: agents/architect/deliverables/2026-07-05-eskuvo-ses-guest-consent-spec.md. Tartalom: level-kuldo kliens modul (uj csomagfuggoseg), migracio (eskuvo_guests.email, eskuvo_consent_tokens 3 uj oszlop, level-naplo tabla), ensureConsentToken() utani automatikus kuldes-hivas. Fuggoseg (nem build-feladat, Istvan/adminisztrativ): hitelesito-adat dontes, domain-DNS hozzaferes, szolgaltatoi kvota-emeles kerelem elore beadva.

## #c101338a [2026-07-05] (jogász)
**DORA: jogasz sign-off -- onboarding kerdesfa HU szovegei (biztonsagi osztaly meghatarozas)**
Post-MVP compliance: a dora_interview_questions.ts-ben levo biztonsagi osztaly meghatározó kerdesek HU szövegei jogász review + sign-off hatálya alá esnek. Nem blokkolja az MVP buildet, de eles launch elott szukseges.

## #9ecb424b [2026-07-05] (buildfejleszto)
**P1 GDPR fix: Eskuvo guest dietary/access-needs consent -- pending-state + retroaktiv remediacio**
Aegis (jogasz) P1: agents/jogasz/deliverables/2026-07-05-eskuvo-guest-csv-import-art9-consent-verdikt.md.

Problema: CSV import auto-true-ra allitja a dietary/access-needs consent mezoket (Art.9 specialis kategoria adat), pedig az adatot a planner tolti fel, nem maga az erintett -- ervenytelen jogalap (GDPR Art.9(2)(a)+Art.4(11)).

Fix: (1) dietary_consent_status enum (pending/guest_confirmed/guest_declined/expired), CSV import mindig pending-re allitja. (2) Vendeg-megerosito lepes (email/SMS) a
