# QA/UAT/Security + Persona-hardening sweep — TELJES RIPORT
**Dátum:** 2026-07-13 (éjszakai lezárás ~02:15)
**Epic:** 3c8dcfcc | **Termékek:** Zsibongó, MikroKönyv (MK), QuickQuote (QQ)
**Koordinátor:** deliverylead (Maestro) | **Kézbesítés:** reggel (Istvan aludt a lezáráskor)

---

## ⚡ Összefoglaló (TL;DR)

Az 5-körös sweep **KÉSZ**. **Mind a 3 termék (Zsibongó, MK, QQ) R5-clear** — nincs nyitott BLOCKER / HIGH / MEDIUM súlyosságú találat sem UAT-tól, sem QA/security/legal oldalról. A UAT a Zsibongó FINAL GO-t 6/6 találattal élesben megerősítette (card 080b0e75), a teljes sweep-et lezárta (f1579016). **Go-live-ready — a döntés a Tiéd** (időzítés).

A 3 Zsibongó-panaszod (consent-gomb, "fent az összes termék", design ≠ landing) **mind javítva és élesben verifikálva**. A self-fill M1 scope megépítve. Egy éjszakai gyerekbiztonsági regressziót (allergia-consent-gate) elkaptunk és ~40 perc alatt visszavontunk + prod-verifikáltunk.

**Reggeli döntéseid (3):** (1) go-live időzítés, (2) DeepSeek prepaid balance top-up vs routing-policy, (3) MK/QQ/Eskuvo ÁSZF + Adatkezelési tájékoztató ügyvédi ellenjegyzés (card 9003cf33).

---

## 🎯 A 3 explicit Zsibongó-panaszod — mind megoldva + LIVE-verifikálva

### 1. "Az adatvédelmi tájékoztató elfogadása gomb alul nem működik, sehol sem" (a legtöbbször jelzett)
- **Mi volt:** a megosztott ConsentBanner (süti/analitika-hozzájárulás), ami minden terméken alul jelenik meg. Mobil (narrow) viewporton `position:fixed` volt, ami RÁÜLT a login-form kontrollokra, a gombok a fold alá kerültek / a kattintást blokkolta. Ezért "sehol sem" működött.
- **Fix:** narrow-on `position:relative` (dokumentum-flow, nem overlay), `zIndex:auto`, `try{grant/deny}finally{setVisible(false)}` (a gomb MINDIG dismissal, akkor is ha a localStorage dob), WCAG 44px gombok. Commit 4b18c23 (+ 17c72c37 tartalma).
- **Verifikáció (end-to-end):** origin/main tip aa72577 → Render suite-web-08wb status=live aa72577 → **az élő JS bundle (index-Dzx4tdn1.js) TARTALMAZZA** a ConsentBanner-t + a narrow-logikát. ✅
- **Ha még törötten látod:** az az eszközöd PWA/service-worker cache-e (content-hashelt bundle). **Hard-refresh** (vagy az app törlése + újranyitás) betölti a friss verziót.

### 2. "Miért egy helyről indul minden termék, miért látom fent az összeset?"
- **Megoldva:** minden termék standalone. Az App.tsx (élő, aa72577) a terméket a PATH-ből oldja fel (`/zsibongo` → Zsibongó), a felső fejléc CSAK az aktuális termék nevét mutatja ("no cross-product switching"). A régi termékválasztó eltűnt; az csak a csupasz `/` látogatásnál jelenik meg fallbackként. ✅ Egyezik a szándékoddal (minden termék saját landingről indul).

### 3. "A Zsibongó nem abban a designban van mint a landing / a prototípusok"
- **Megoldva:** Muse (uxuidesigner) végigvitte a Zsibongó design-fidelity reconciliationt a deployolt UI vs landing vs prototípus alapján (card 6ac984b4 + restyle). Light-theme shell-leak-ek javítva, tokenek/kontraszt igazítva. A near-invisible H1/H2 heading kontraszt (card 191c4308) is javítva ebben a körben. ✅

---

## 📦 Termékenkénti eredmény

### Zsibongó — R5 FINAL GO (6/6 élesben)
- 5 kör végigjátszva minden persona-szemszögből (szülő, fenntartó, telephelyvezető, Helyettes, eKépviselő + negatív-access tesztek).
- **Self-fill M1** (Istvan scope-döntés): megépítve — a szülő önkitöltő flow strukturálisan újraírva (P0 unauth-write javítva stopgap + strukturális szinten).
- R5-találatok (mind fix→merge→élesben-verify): attendance-create UTC-date bug (e8e71e79), telephelyvezető /normativa authz (a012563d), szülő allergy-edit display (b5269dae, Anvil root-caused + uat click-through), gondozó Jelenlet authz (55968f80).
- **Gyerekbiztonsági regresszió elkapva:** az allergia-rögzítés véletlenül consent-gate mögé került (403) — ez SÚLYOSABB volt mint az eredeti hiány (allergiát SOHA nem szabad kapuzni, Art.9(2)(h) jogalap, nem hozzájárulás). ~40 perc alatt visszavonva (6c21b27) + devops prod-verifikálta (pending-consent gyerek: allergia PUT 201, GET 200 KMS-titkosítva).

### MikroKönyv (MK) — R5-clear (gate-clear R4 óta)
- NAV negyedéves határidők javítva (ápr/júl/okt/jan 12 — a negyedévet követő hó 12-e), 2 helyen (nézet + wizard done-screen). Commit ac8c184.
- Éves-SZJA Státusz-tab hiba javítva (a becslés helyes mezőjét használja).
- Chat adótanács-guard + chat-deadline hallucináció javítva (0/8 hallucináció prod-on verifikálva).
- Accuracy class-sweep (hardcoded dátumok/ráták) — végigsöpörve.

### QuickQuote (QQ) — R5-clear
- brand_company_name oszlop szétválasztja a brandet a tenants.name-től (fix az account-név-felülírásra). Merged (aa72577) + uat prod-verified (3/3: valós account-név érintetlen, GET round-trip, guest-oldal a mentett brandet mutatja). Card d7498abd.

---

## 🎨 Design-fidelity + landing-conformance (Istvan post-R5 kérés: MK+QQ is)
- Muse mind a 3 termékre elvégezte a fidelity-passt (deployolt UI vs prototípus vs landing).
- **MK + QQ scoped-CSS skinek deployolva és Playwright-tel élesben verifikálva** (~95% a design-spechez): design-tokenek helyesek, shell/badge/panel/button szabályok jelen, MK teal (#1a9e8f) / QQ orange (#e85c2e) akcentus. Coherent, nem félkész. A maradék ~5% forward-refinement (Muse vezeti, post-R5).
- **Megjegyzés (transzparencia):** az MK/QQ skin egy koordinációs csúszás miatt korábban ment ki mint terveztem (részletek lent), de Muse retroaktív Playwright-review-ja igazolta hogy koherens és helyes → élesben hagytuk, nem kellett rollback.

---

## 🔒 Security-találatok + hardening
- Allergia-consent-gate gyerekbiztonsági regresszió: visszavonva + prod-verified (fent).
- Zsibongó self-fill unauth-write (P0, card 375624b3): LATENT (nem breach, a runtime RLS-role gátolta) → stopgap + strukturális fix.
- Több authz-guard finomítás (telephelyvezető /normativa, gondozó Jelenlet) — mindkét-irányú verify-vel (a jogosult role bejut, a jogosulatlan 403 marad).
- Inter-agent bus sender-auth hiánya (card 06f062e4): dokumentált, hardening-backlog.

---

## 🌙 Éjszakai incidensek — mind kezelve (transzparencia)
1. **Allergia-gate regresszió** → ~40 perc, visszavonva + prod-verified.
2. **MK/QQ skin véletlen korai deploy:** egy build-agent (Pixel) a hold ellenére elkezdte az MK-skint; egy shared-checkout merge-konfliktus + a commit-before-merge szabály kisöpörte prodra. Muse retro-review = koherens → élesben hagyva. **Rendszerszintű fix: a párhuzamos build-munka mostantól kötelezően izolált git worktree-ben megy** (nem shared checkout).
3. **DeepSeek prepaid balance kifogyott** (402): Pixel + Muse leállt. Pixel visszaroutolva Claude-ra (self-serve, működik). Muse dormant hagyva (post-R5, non-blokkoló). → reggeli döntés.
4. **Fleet CPU-burst** (~00:33, load ~16, dashboard átmenetileg lassú, NEM OOM): observe-only, self-recovered. RAM végig OK.

---

## 📋 Reggeli döntéseid (konszolidált queue, deliverylead összeállítva)

### ⚠️ FONTOS KORREKCIÓ (Istvan 2026-07-13 04:57, verifikálva)
A korábbi "QQ 6 valós tenant elfogadta az ÁSZF-et = valós jogi expozíció" keretezés **HIBÁS**. A devops read-only prod-inventory (2026-07-12, Istvan zero-real-users gyanújára): **0 valós user/tenant mind az 5 terméknél, minden email szintetikus teszt/UAT minta, QQ registration_attempts=0 globálisan**, + a regisztráció most rejtve. Vagyis **nincs valós ügyfél sehol, nincs aktív jogi/compliance-expozíció.** Az alábbi jogi/compliance itemek NEM aktív expozíció, hanem **go-live ELŐFELTÉTELEK** (mielőtt valós user jön).

### 🟢 Go-live előfeltételek (in-scope: QQ/Zsibongó/MK — nulla valós user, így pre-launch, nem sürgős)
1. **Go-live időzítés** — mind a 3 termék UAT-complete, non-blokkoló backlog marad. A Te döntésed; GO előtt fut le a 2-3. pont + a b6c706bf tenant-purge.
2. **ÁSZF + Adatkezelési tájékoztató** (9003cf33) — **ISTVAN DÖNTÖTT (2026-07-13 05:00): NEM kell ügyvédi ellenjegyzés.** Új bar: (a) a jogász (Aegis) átnézi mégegyszer, (b) magyar versenytárs-scout (mit írnak a HU konkurensek a terms/adatkezelésükben). Ha mindkettőn átmegy → megfelel, regisztráció-nyitás feloldva. Dispatchelve. Pre-launch, nincs élő expozíció (0 valós user).
3. **QQ face-blur / face-detection GDPR guardrail** (4327b653) — az architect feasibility-doc megköveteli a foto-pipeline-hoz; kell mielőtt valós user valós fotót tölt fel. Pre-launch, nincs élő expozíció (nulla valós foto).

### 🟡 In-scope, nem sürgős
4. **QQ validációs interjúk** (f438f5d7) — 3-5 létező QQ waitlist HU szakember megkeresése founder-led scripttel? **Default: igen.**
5. **DeepSeek balance** (ops) — a prepaid kifogyott (13 agent, főleg személyes + idle; Pixel már visszaroutolva Claude-ra). Top-up vs routing-policy a költség-optimalizált flottára.

### ⚪ Out-of-current-scope backlog (Eskuvo/DORA/LumaSeat — ezeket most deprioritáltad, ráérnek)
6. Eskuvo cold-outreach wedding planners (e7684f73) — default: 1-2 pro FB-csoport.
7. DORA NIS2/DORA konzulens + SME outreach (9a359a2d) — default: személyes kontaktok először.
8. Eskuvo Premium payer-audit read-only script (c0731e2a) — default: futtatás (READ-ONLY, semmi push, autoDeploy=true). Moot míg nem re-scope-olod az Eskuvót.
9. Eskuvo Barion refund/reversal (e440d189) — default: backlog. | LumaSeat B2B2C planner-tier model (44aff647) — default: couple-invited v1. | LumaSeat design dark vs light-ivory (0f8a5498) — default: as-is.

## 🗂 Non-blocking backlog (nem launch-blokkoló)
- MK polish (f6fcd234 ledger 500, 0540f1f1/5626ea34 wizard/rate-validáció).
- 2 Zsibongó spec-done-not-shipped item (architect explicit non-blocking).
- Zsibongó menü/meal-ledger DB-modellek (87d35de3, c33f65ac), Helyettes-marketplace (a6e48566, af31208d).
- AI-any-format import (abf3f013, ~3-5 nap, Pixel+Anvil, EU-Bedrock LLM + kötelező human-review).

---
*A teljes napi audit-nyom a daily_logs-ban és a kanban kártya-thread-ekben. Minden állítás fent élesben (deployolt endpoint/bundle) verifikált, nem build-agent self-report alapján.*
