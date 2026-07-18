# CostOps -- teljes AS-IS állapot- és befejezési gap-audit

Készült: 2026-07-11 (Marveen, read-only audit)
Módszer: bizonyíték-alapú -- élő DB (`store/claudeclaw.db`), élő dashboard API (`/api/costs/*`), collector-kód (`src/costops/`), config/pricing fájlok, `import_runs` végrehajtási napló. Semmi nem lett módosítva (lásd Guardrails + git status a végén).
Hatókör: `local/costops-live-dashboard` branch, live dashboard `http://localhost:3420`.

Fontos keret: NEM az a kérdés, hogy a KÓD jó-e (az nagyrészt jó), hanem hogy a rendszer ELÉG VALÓS ADATOT lát-e a tényleges költségkontrollhoz. A kettő szétválik, és a fő probléma az adat, nem a szerkezet.

---

## 1. Executive összefoglaló

| Kérdés | Válasz (élő adat) |
|---|---|
| Előző teljes hónap (2026-06) költése | **8 990 HUF** -- de ez CSAK 1 db line item (Claude Pro, actual_invoice). Nem valós teljes hónap, csak 1 rögzített számla. |
| Aktuális hónap (2026-07) tényleges MTD | **122 458 HUF** (operational_spend) |
| Jelenlegi hó végi becslés (forecast) | **122 458 HUF** -- azonos az MTD-vel |
| Mi alapján a becslés | Statikus: a forecast a legtöbb sornál = a havi összeg, mert csak `tier>=4 && category='usage'` sor kap run-rate extrapolációt, és ILYEN sor jelenleg 0 van (lásd 5. szakasz). Tehát a forecast NEM valódi extrapoláció. |
| Actual/API vs manual/estimate arány | actual_invoice: **4 014** (3,3%) / manual: **58 339** (47,6%) / estimate: **60 105** (49,1%). Valós mért adat (API/invoice) = **1 provider** (Render, 4014). A többi manuális config vagy becslés. |
| Hány provider nincs megfelelően lefedve | A 9 aktív ledger-providerből **8-nak nincs valós automata adatforrása** (csak Render-nek van, az is részben). Istvan listájából teljesen hiányzik: Google Workspace (külön a Google AI-tól), PostHog, Wispr Flow, Twilio, Barion. |
| A dashboard alkalmas valódi költségkontrollra? | **RÉSZBEN, inkább NEM.** Indoklás: a plumbing (ledger, forrás-prioritás, no-double-count, warnings, no_data állapot, token-monitor) jól megépített és helyes. DE az ADAT ~96%-a manuális/becsült: egyetlen provider sem ad automata valós számlaadatot (a Render-invoice is kézzel bevitt), a forecast statikus, a history 2 hónap, a token-becslés csak opus-t áraz. Így ez jelenleg egy jól strukturált MANUÁLIS költségnyilvántartó, nem automata kontroll-eszköz. |

**A számítás összetevői (nem egy globális szám):**

```
operational_spend (2026-07 MTD) = 122 458 HUF
  = anthropic 67 004   (manual)      [Claude Max 40 359 + Claude API 17 655 + Claude Pro 8 990]
  + other    27 000    (estimate)    [Monitoring 5 000 + Other SaaS 10 000 + Manual other 10 000 + Domain 2 000]
  + deepseek 15 450    (estimate)
  + openai    8 990    (manual)       [ChatGPT]
  + render    4 014    (actual_invoice)  <-- az EGYETLEN valós mért tétel
  + github/google/vercel/cloudflare 0
```

A token-cost becslés (327 697 HUF MTD) EGY KÜLÖN nézet, NEM része az operational_spend-nek (helyesen -- lásd 6. szakasz).

---

## 2. Provider-lefedettségi mátrix

Jelmagyarázat: adatforrás-prioritás elvárt sorrendje = **provider API/actual > email/invoice > manual > local estimate**. A "tényleges elsődleges forrás" oszlop mutatja, MI van MOST.

| Provider/source | Kategória | Tényl. adat? | Elsődleges forrás MOST | Provider API impl.? | Provider API MŰKÖDIK? | Email ingest? | Manual fallback? | 2026-06 actual | 2026-07 MTD | Forecast | Forecast basis | Orig. currency? | Token adat? | Quota/limit? | Frissesség | Ismert gap | Következő lépés |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Anthropic Max | AI sub | Részben | **manual** (config 40 359) | Usage/token igen (token_usage) | Token igen, $ nem | Nem | Igen | 0 | 40 359 | 40 359 | full monthly | Nem | Igen (token) | weekly_pct manual 2% | config | Nem | Valós számla/usage-cost forrás |
| Anthropic Pro | AI sub | Igen (invoice) | **actual_invoice** (8 990) | Nem | Nem | Nem (kézi) | Igen | 8 990 | 8 990 | 8 990 | full monthly | Nem | Részben | session 16% / weekly 2% manual | subscriptions.json | Nem | Renewal-dátum hiányzik |
| Anthropic API | AI usage | Becslés | **estimate** (17 655) | Van collector | **Nem futott** | Nem | Igen | 0 | 17 655 | 17 655 | full monthly | Nem | Igen (token) | Nem | anthropic.ts | Nem | Anthropic Usage/Cost API bekötés |
| OpenAI ChatGPT | AI sub | Igen | **manual** (8 990) | Nem | Nem | Kézi (email) | Igen | 0 | 8 990 | 8 990 | full monthly | Nem | Nem | Nem | subscription | Nem | Renewal-dátum |
| OpenAI API | AI usage | Nincs (0) | **estimate** (0) | openai.ts van | **Nem futott** | Nem | Igen | 0 | 0 | 0 | full monthly | Nem | Nem | Nem | openai.ts impl., nem hív | Nem | OpenAI Usage API + kulcs |
| DeepSeek | AI usage | Becslés | **estimate** (15 450) | deepseek.ts van | **Nem futott** | Nem | Igen | 0 | 15 450 | 15 450 | full monthly | Nem | Nem | prepaid balance NINCS (0 snapshot) | deepseek.ts | Nem | Balance API + prepaid snapshot |
| Google AI (Gemini) | AI usage | Nincs (0) | **estimate** (0) | google-ai source | **Nem futott** | Nem | Igen | 0 | 0 | 0 | full monthly | Nem | Nem | Nem | nincs collector | Nem | Google AI usage forrás |
| Render | Hosting | Igen (részben) | **actual_invoice** (4 014) kézi + **provider_plan_estimate** (30 600) API | render.ts + render-plan-recorder | **Igen** (csak plan) | Nem | Igen | 0 | 4 014 | 4 014 | full monthly | Nem | Nem | build minutes nem | 04:15 napi | Render-nek nincs publikus billing API (csak plan-becslés); a valós 4014 kézi | Email-invoice ingest a valós összegre |
| AWS | Cloud | Nincs | **pending_permission** (0) | Nem | Nem | Nem | Igen | 0 | 0 | 0 | - | Nem | Nem | Nem | jogosultság hiányzik | Nem | Cost Explorer IAM (ha lesz AWS) |
| Vercel | Hosting | Nincs (0) | **estimate** (0) | Nem | Nem | Nem | Igen | 0 | 0 | 0 | full monthly | Nem | Nem | Nem | nincs collector | Nem | Csak ha használatban |
| Cloudflare | SaaS/CDN | Nincs (0) | **estimate** (0) | Nem | Nem | Nem | Igen | 0 | 0 | 0 | full monthly | Nem | Nem | Nem | nincs collector | Nem | Csak ha fizetős |
| GitHub | SaaS | Nincs (0) | **manual** (0) | github.ts van | **Nem futott** | Nem | Igen | 0 | 0 | 0 | full monthly | Nem | Nem | Actions percek nem | github.ts impl. | Nem | Billing API (ha fizetős) |
| Google Workspace | SaaS | Nincs | **workspace_alert** (payment/suspension) | workspace-alerts.ts | Alert-only | Nem | Manual alert | - | - | - | - | Nem | Nem | suspension-dátum ha van | csak alert, nincs $ | Nem | Havi díj mint fix cost |
| Domain(ek) | Domain | Becslés | **estimate** (2 000) | RDAP expiry (expiry-checks.ts) | Expiry igen, $ nem | Nem | Igen | 0 | 2 000 | 2 000 | full monthly | Nem | Nem | renewal-dátum (RDAP) | config | Nem | Valós renewal-díj |
| Egyéb SaaS (Aware/Monitoring/Other) | SaaS | Becslés | **estimate** (25 000) | Nincs | Nem | Nem | Igen | 0 | 25 000 | 25 000 | full monthly | Nem | Nem | Nem | gyűjtő tételek | Nem | Nevesíteni + valós díj |
| **PostHog** | Analytics | **NINCS SOR** | -- | Nem | Nem | Nem | Nem | - | - | - | - | - | - | - | nincs trackelve | Külön source kell |
| **Wispr Flow** | SaaS | **NINCS SOR** | -- | Nem | Nem | Nem | Nem | - | - | - | - | - | - | - | nincs trackelve | Külön source kell |
| **Twilio** | Comms | **NINCS SOR** | -- | Nem | Nem | Nem | Nem | - | - | - | - | - | - | - | nincs trackelve | Külön source (ha használt) |
| **Barion** | PSP | **NINCS SOR** | -- | Nem | Nem | Nem | Nem | - | - | - | - | - | - | - | nincs trackelve | PSP-díj mint cost (ha releváns) |

**Eltérés az elvárt prioritástól:** a KÓD prioritása helyes (lásd 4. szakasz), de a GYAKORLATBAN egyetlen provider sem szolgáltat automata valós $ adatot: az egyetlen élő provider-API (Render plan-recorder) `provider_plan_estimate` = ADVISORY, kizárva a headline-ból; a Render valós 4014-e kézzel bevitt actual_invoice; minden más manual/estimate config. Az email-fallback implementálva, de 0 sort termelt.

---

## 3. Havi idősor és történeti adatok

A `/api/costs/period` végpont 6 hónapot ad vissza, és HELYESEN külön `no_data` állapotot használ (nem 0-t):

| Hónap | Állapot | operational_spend | Forecast | actual/invoice | estimate | manual | no_data providerek | Adatminőség |
|---|---|---|---|---|---|---|---|---|
| 2026-02 | **no_data** | -- | -- | -- | -- | -- | mind | nincs adat |
| 2026-03 | **no_data** | -- | -- | -- | -- | -- | mind | nincs adat |
| 2026-04 | **no_data** | -- | -- | -- | -- | -- | mind | nincs adat |
| 2026-05 | **no_data** | -- | -- | -- | -- | -- | mind | nincs adat |
| 2026-06 | van adat | 8 990 | 8 990 | 8 990 | 0 | 0 | 8/9 | 1 sor -- csak Claude Pro invoice |
| 2026-07 | van adat (MTD) | 122 458 | 122 458 | 4 014 | 60 105 | 58 339 | 4/9 | 18 sor, ~96% manual/estimate |

- **Ténylegesen hány hónap valós adat:** gyakorlatilag **2** (2026-06 és 2026-07), de 2026-06 mindössze 1 tétel. Tehát 1 valódi működő hónap (2026-07) + 1 tört-adat hónap.
- **Backfill megtörtént-e:** **NEM.** Régi email-számlák / korábbi hónapok nem lettek visszatöltve. Az email-ingest 0 sort termelt összesen.
- **Hol lenne visszatölthető history:** Anthropic (invoice emailek), OpenAI/ChatGPT (számlák), Render (havi számlák email), DeepSeek (top-up nyugták) -- mind email/invoice alapon backfillelhető, ha az email-ingest sweep valóban lefut a Gmail-en.
- Helyes: a no_data KÜLÖN állapot, nem nulla. Ez jól van megoldva.

---

## 4. Actual-spend számítás (operational selection)

Forrás: `src/costops/ledger.ts` `resolveOperational()`. A logika bizonyítottan helyes és NINCS dupla számolás:

**Prioritás-létra (OPERATIONAL_TIER):** `actual_invoice = provider_api = billing_export = 4` (REAL_ACTUAL) > `provider_plan_estimate = 3` (PROVIDER_DERIVED) > `local_usage/estimate/manual` (alacsonyabb). A `provider_plan_estimate` a headline `current_spend`-ből teljesen KIZÁRT (ADVISORY -- csak összehasonlításra).

**Kiválasztás:**
1. Source-onként a legmagasabb-confidence sor nyer.
2. Ha egy providernek van VALÓS actual-ja (tier>=4), akkor ugyanannak a providernek a manual/estimate sorai KIZÁRÓDNAK az operationalból (fallback/comparison-only) -> nincs dupla számolás.
3. A `provider_plan_estimate` supersede-elődik, ha a providernek van valós actualja.

**Bizonyíték (Render, élő):** 3 sor létezik -- hosting 40 000 (estimate), render-plan 30 600 (provider_plan_estimate/provider_api), invoice 4 014 (actual_invoice). Az operational a **4 014-et választja**, a 30 600 és 40 000 comparison-only lesz. -> a létra MŰKÖDIK.

- Mi kerül az operational_spend-be: source-onként a legjobb tier, providerenként az actual ha van.
- Mi NEM: provider_plan_estimate (advisory), superseded manual/estimate ott ahol van actual, a token-cost becslés (külön nézet).
- Dupla számolás kockázata: **nincs** (a supersede-logika kezeli).
- **Eltérés az elvárt prioritástól: nincs a logikában.** A gyakorlati probléma nem a logika, hanem hogy a tier>=4 valós adat majdnem sehol nincs (csak Render 4014).

---

## 5. Forecast jelenlegi működése

Forrás: `ledger.ts` 159. sor: `forecast += (tier >= 4 && category === 'usage') ? billed_cost / fractionElapsed : billed_cost`.

| Forecast-típus | Használt? | Hol |
|---|---|---|
| provider saját forecast | Nem | -- |
| provider usage run-rate (÷ eltelt hónaprész) | Igen, DE csak `tier>=4 && category='usage'` sorra | jelenleg 0 ilyen sor van |
| invoice / fix subscription (full havi) | Igen (minden subscription/manual/estimate) | ez adja a teljes 122 458-at |
| token-runrate | Igen, KÜLÖN (limits.ts, token-monitor) | marveen 327 022 -> 972 595 forecast |
| manuális forecast | Nem | -- |
| no_forecast | -- | -- |

**A "static actual = forecast" pontosan itt van:** mivel az összes operational sor `subscription`/manual/estimate kategória (VAGY a Render actual `invoice` kategória, nem `usage`), EGYETLEN sor sem esik a run-rate ágba -> a forecast = a billed összegek szimpla összege = az MTD. Ezért `forecast_month_end == current_spend == 122 458`. Ez nem hiba a kódban (a subscription full-havi forecastja korrekt), de a felhasználó számára FÉLREVEZETŐ: úgy néz ki mintha lenne valódi hó végi extrapoláció, holott a usage-alapú providereknél (Anthropic API, DeepSeek, OpenAI API) nincs valós run-rate, mert azok estimate/manual sorok, nem actual usage.

A token-forecast (limits.ts) VISZONT valódi run-rate (`token_runrate`, confidence alapú) -- de az a not_billed opportunity-cost nézet, nem az operational.

---

## 6. Tokenadatok auditja

Forrás: `token_usage` tábla (64 763 sor) + `/api/costs/limits` `token_by_agent` + `src/costops/pricing.ts` + `store/costops-pricing.json`.

- **Ágensek:** marveen (17 616), fullstackfejleszto (15 668), deliverylead (10 642), architect (4 367), qa (4 151), buildfejleszto (2 352), ba, business, research, jogasz, uxuidesigner, frontendfejleszto. Per-agent bontás VAN.
- **Providerek/modellek:** provider: `None` **36 939 (57%)**, anthropic 27 723, unknown 101. model: `None` 36 939, claude-sonnet-5 23 616, claude-opus-4-8 3 688, claude-sonnet-4-6 419, `<synthetic>` 101.
- **Időszak:** 2026-06-16 -> 2026-07-11 (folyamatos).
- **Input/output/cache:** rögzítve (input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens). Pl. marveen: input 1,19M, output 4,95M, cache_read 1,60**milliárd**, cache_creation 20,8M.
- **Max/Pro subscription alatti tokenek:** a marveen + qa opus-sorok `billed_status = not_billed` -> subscription usage-equivalent (Max/Pro alatt). Nincs explicit "melyik session Max vs Pro" flag; a billed_status=not_billed jelzi az elszámolás-mentességet.
- **Tényleges API-billed tokenek:** jelenleg **egy sem** jelölt API-billedként (nincs Claude API-kulcs alapú usage-sor a token_usage-ben; minden not_billed).
- **Eldönthetetlen:** a `None` provider/model sorok (57%) -- ezeknél sem a provider, sem a billed-státusz nem meghatározható -> se árazni, se besorolni nem lehet őket.
- **Token-cost estimate készítése:** `pricing.ts` szoroz a `costops-pricing.json` per-model rátáival (input/output/cache_read/cache_write per 1M token, HUF, fx 308.91).
- **Pricing tábla:** **CSAK `claude-opus-4-8` van benne** (input 1544.55 / output 7722.75 / cache_read 154.46 / cache_write 1930.69 per 1M tok). **A sonnet-5 (23 616 sor, a token-tömeg zöme) NINCS árazva** -> nem kap cost-estimate-et. Ezért a token_by_agent csak **2 ágenst** ad vissza (marveen, qa -- a két opus-használó).
- **Havi run-rate forecast:** `estimated_cost_mtd / fractionElapsed` -> `token_runrate` basis. Pl. marveen 327 022 -> 972 595.
- **Bekerül-e tévesen az operational_spend-be:** **NEM.** A token-becslés külön nézet (limits/token-monitor), `not_billed`, nincs az operational ledgerben. Ez helyes.

**A "182 422 HUF MTD" tétel:** a jelenlegi élő érték **327 697 HUF** (marveen 327 022 + qa 675), NEM 182 422 -- az adat azóta nőtt (a 182 422 egy korábbi pillanatkép). Mindkettő természete azonos:
- milyen tokenekből: opus-4-8 input/output/cache (csak a priced modell).
- árazás: costops-pricing.json opus-ráták.
- API-billed? **Nem.** subscription usage-equivalent (Max/Pro alatt), `not_billed`.
- opportunity cost? **Igen** -- ennyibe kerülne API-n, de valójában a Max/Pro fix díj alatt van.
- operational_spend-be beleszámít? **NEM.**
- dashboardon: külön "Token Usage / limit monitor" szekcióban jelenik meg, nem a headline költségben.

**provider -> model -> agent bontás (ahol van adat):** anthropic -> opus-4-8 -> {marveen 327 022, qa 675}; anthropic -> sonnet-5 -> {fullstack, deliverylead, architect... = NINCS cost, mert nincs ráta}; None -> None -> 57% (besorolhatatlan).

---

## 7. Előfizetés- és kvótalefedettség

Forrás: `subscriptions.ts`, `limits.ts` (0.8 warning / 0.9 critical létra), `expiry-checks.ts`, `provider_balance_snapshots` (üres).

| Tétel | Adatforrás | Típus | Usage | Limit | Usage% | Reset/renewal/expiry | Forecast kimerülés | Alert threshold | 80/90/100 alert működik? |
|---|---|---|---|---|---|---|---|---|---|
| Claude Max heti/5h limit | subscriptions.json | manual (local_observed) | weekly 2% | 100% | 2% | Wed 06:00 (weekly_reset) | -- | 80% | Igen, DE csak manuálisan bevitt weekly_pct-re |
| Claude Pro lifecycle | subscriptions.json | manual/invoice | session 16% / weekly 2% | -- | -- | next_renewal **NINCS** (kézzel nem adva) | -- | 80% | Részben (renewal-dátum hiányzik) |
| ChatGPT előfizetés | config | manual | -- | -- | -- | renewal NINCS | -- | -- | Nem (nincs usage-adat) |
| Render build minutes | -- | **nincs** | unknown | unknown | -- | -- | -- | -- | Nem |
| Render spend/plan usage | render-plan-recorder | provider_api (plan) | 30 600 becslés | -- | -- | -- | full monthly | -- | Nem (csak advisory) |
| DeepSeek prepaid balance | -- | **nincs** (0 snapshot) | unknown | unknown | -- | -- | -- | -- | Nem |
| Google Workspace payment/suspension | workspace-alerts.ts | alert-only | -- | -- | -- | suspension-dátum ha van | -- | -- | Alert igen, $ nem |
| Domain renewal | expiry-checks.ts (RDAP) | local_observed | -- | -- | -- | RDAP expiry (1 domain configolva) | igen | tiered | Igen (expiry-alapú) |
| SSL expiry | expiry-checks.ts (TLS notAfter) | local_observed | -- | -- | -- | 5 host configolva | igen | tiered | Igen |

- Az alert-létra (0.8/0.9) implementálva és általános minden limit_type-ra.
- A `provider_balance_snapshots` tábla **üres (0 sor)** -> DeepSeek prepaid, Render build-minutes: nincs élő adat -> helyesen `unknown`/`pending`, nem kitalált limit. Ez megfelel az elvárásnak ("ahol nincs adat, legyen unknown").
- A 80/90/100% alert CSAK a manuálisan bevitt Claude weekly-usage%-ra + az expiry-checkekre működik automatikusan; automata quota-polling nincs.

---

## 8. Dashboard jelenlegi állapota

Dashboard HTTP 200, tartalmazza a "Költség" + "Token Usage" szekciókat. Az `app.js` rendereli: operational_spend, forecast_month, previous_month, no_data, forecast_basis, actual_source, token_by_agent mezőket.

FONTOS korlát: **böngészővel NEM tudtam megnézni** (nekem, mint fő-agentnek, nincs headless chromium a saját eszközkészletemben -- a fleet-ben csak deliverylead/Muse tud userland-chromiummal screenshotot csinálni). Ezt őszintén jelzem, ahogy kérted. A lenti értékelés a served HTML/JS + az API-válaszok alapján készült, nem pixel-inspekcióval.

| Szekció | Állapot | Megjegyzés |
|---|---|---|
| Executive summary | működik | current/forecast/operational megjelenik |
| Előző hónap | **részben félreérthető** | 2026-06 = 8 990 megjelenik, DE ez csak 1 tétel -- könnyen valós teljes hónapnak tűnhet |
| Aktuális MTD | működik | 122 458 |
| Hó végi forecast | **félreérthető** | = MTD (122 458), statikus; úgy néz ki mint valódi extrapoláció (5. szakasz) |
| Kategóriák | működik | charge_category szerint |
| Provider bontás | működik | provider_breakdown confidence-szel |
| Source bontás | működik | 18 source |
| Original currency | **hiányzik** | oszlop létezik, adat mind None -> nem jelenik meg |
| Actual source | részben | actual_source mező renderelve, de a legtöbb "manual_entry" |
| Forecast basis | működik | forecast_basis megjelenik (token oldalon token_runrate) |
| Token és limit monitor | működik (részben) | token_by_agent + limits; DE csak 2 opus-ágens jelenik meg (sonnet nincs árazva) |
| Warnings | működik | manual-fallback + plan-variance warning élő |
| Trend | részben | period 6 hónap van, de csak 2-ben adat |
| Diagnostics | részben | import_runs létezik, de csak render fut |

Külön ellenőrzések:
- Előző havi actual jól látszik-e: **részben** (látszik, de félrevezetően teljesnek tűnhet 1 tételből).
- MTD és forecast külön érték-e: technikailag két mező, de **azonos érték** -> vizuálisan nem különül el a statikus forecast.
- Forecast alapja látszik-e: a token oldalon igen (basis), az operational oldalon nincs kiemelve hogy "full monthly, nincs run-rate".
- API/email/manual forrás azonnal érthető-e: **részben** -- confidence látszik, de az actual_source ("manual_entry") nem magyarázza el, hogy melyik providernek van egyáltalán automata forrása.
- Token estimate nem néz-e ki számlázott költségnek: **kockázat** -- külön szekcióban van (jó), de a nagy szám (327k/972k) `not_billed` címke nélkül félreérthető lehet a headline mellett.
- Tétellista egységes-e: igen, egy `cost_line_items` séma.

---

## 9. API- és adatséma-inventory

| Elem | Implementálva | Élőben működik | Részleges | Nincs használva |
|---|---|---|---|---|
| **DB táblák** | | | | |
| `cost_line_items` (20 sor; mezők: charge_period_start/end, charge_category, billed_cost, confidence, actual_source, original_amount/currency, fx_rate, dedup_key) | ✓ | ✓ | orig_currency/fx mezők üresek | |
| `cost_sources` (18 sor) | ✓ | ✓ | | |
| `import_runs` (15 sor) | ✓ | csak render | | |
| `token_usage` (64 763 sor) | ✓ | ✓ | provider None 57% | |
| `token_usage_cursors` (321) | ✓ | ✓ | | |
| `budgets` | ✓ | | | **0 sor -- nincs budget** |
| `provider_balance_snapshots` | ✓ | | | **0 sor -- nincs balance** |
| **Endpointok** (`src/web/routes/costs.ts`) | | | | |
| GET /api/costs/summary | ✓ | ✓ | | |
| POST /api/costs/sync | ✓ | ✓ (manuális) | nincs timer | |
| POST /api/costs/email-ingest | ✓ | | **0 sort termelt** | |
| GET /api/costs/sources | ✓ | ✓ | | |
| GET /api/costs/budgets | ✓ | | | budgets üres |
| GET /api/costs/period | ✓ | ✓ | | |
| GET /api/costs/subscriptions | ✓ | ✓ | | |
| GET /api/costs/limits | ✓ | ✓ | csak opus árazva | |
| GET /api/costs/warnings | ✓ | ✓ | | |
| POST /api/costs/workspace-alerts | ✓ | ✓ | | |
| GET /api/costs/export | ✓ | ? | | |
| **Collectorok** (`src/costops/collectors/`) | | | | |
| render.ts (render-plan-recorder) | ✓ | ✓ (napi 04:15) | csak plan-estimate (advisory) | |
| anthropic.ts | ✓ | | | **nem futott (0 import_run)** |
| openai.ts | ✓ | | | **nem futott** |
| deepseek.ts | ✓ | | | **nem futott** |
| github.ts | ✓ | | | **nem futott** |
| **Email ingest** (`email-ingest.ts`) | ✓ (HUF/USD/EUR fx, hash-only, no PII) | | **0 sor** | agent-sweep nem fut |
| **Timerek** | | | | |
| `costops-alert-monitor` (scheduled-task, */30, enabled) | ✓ | ✓ | csak threshold-alert push, nem provider-sync | |
| render-plan napi 04:15 | ✓ | ✓ | | |
| costops sync automata timer | | | | **nincs -- csak manuális /api/costs/sync** |
| **Config fájlok** | | | | |
| store/costops-config.json (fixed_costs) | ✓ | ✓ | | |
| store/costops-pricing.json | ✓ | ✓ | csak opus | |
| store/costops-render-pricing.json | ✓ | ✓ | | |
| store/costops-domains.json (5 ssl + 1 domain) | ✓ | ✓ | | |
| subscriptions config | ✓ | ✓ | renewal-dátumok hiányoznak | |
| **Egyéb** | | | | |
| expiry-checks (TLS + RDAP) | ✓ | ✓ (kulcs nélkül) | | |
| workspace-alerts | ✓ | ✓ | alert-only | |
| export.ts | ✓ | ? | | |

---

## 10. Éles adatok pillanatképe (2026-07-11)

(Nincs raw secret / account ID / teljes email / számla ebben a fájlban.)

```
Előző hónap (2026-06) actual:      8 990 HUF  (1 tétel: Claude Pro invoice)
Aktuális hónap (2026-07) MTD:      122 458 HUF
current operational_spend:         122 458 HUF
current forecast (month-end):      122 458 HUF  (= MTD, statikus)
budget:                            NINCS beállítva (budgets tábla üres)
month-over-month delta:            +113 468 HUF

Bontás confidence szerint:
  actual_invoice:  4 014   (3,3%)   <- csak Render, kézi
  manual:          58 339  (47,6%)
  estimate:        60 105  (49,1%)
  provider API valós $:  0

Provider bontás (operational):
  anthropic  67 004  (manual)
  other      27 000  (estimate)
  deepseek   15 450  (estimate)
  openai      8 990  (manual)
  render      4 014  (actual_invoice)
  github/google/vercel/cloudflare  0

Category bontás:  subscription (túlnyomó) + 1 invoice (render) + advisory usage (render-plan, kizárva)

Warningok (élő):
  - high_cost_manual_fallback: Claude Max 33% manual (küszöb 15%), severity low
  - plan_estimate_variance: Render plan 30 600 vs manual 4 014, severity low

no_data / pending providerek:  AWS (pending_permission), Google AI (0), OpenAI API (0),
  Vercel (0), Cloudflare (0), GitHub (0); teljesen hiányzó: PostHog, Wispr Flow, Twilio, Barion, Google Workspace ($)

Token cost estimate (KÜLÖN, not_billed, NEM operational):
  TOTAL MTD:       327 697 HUF   (marveen 327 022 + qa 675)
  TOTAL forecast:  974 378 HUF   (token_runrate)
  csak opus-4-8 árazva; sonnet-5 + 57% None besorolatlan
```

---

## 11. Finish-gap prioritás

### P0 -- alapfunkcionalitás (enélkül nem valódi költségkontroll)

**P0-1: Provider-API valós-billing elsődlegesség kiéheztetve.**
- Jelen: csak a render-plan-recorder fut (15/15 import_run), az is advisory plan. anthropic/openai/deepseek/google/github collector SOHA nem futott. Nincs automata valós $.
- Kell: a meglévő collectoreket ténylegesen ütemezni + bekötni a valós usage/cost API-kat (Anthropic Usage&Cost API, OpenAI Usage API, DeepSeek balance).
- Fájlok: `collectors/anthropic.ts, openai.ts, deepseek.ts, github.ts`, `runner.ts`, egy sync-timer (`src/index.ts`).
- Külső API/jog: provider API-kulcsok (Anthropic API-kulcs a Max helyett usage-hez; OpenAI/DeepSeek kulcs).
- Kockázat: közepes (kulcs-kezelés, rate-limit). Méret: **közepes-nagy** (collectorenként).
- Upstream: jelölt (a collector-váz általános).

**P0-2: Email-invoice ingest 0 sort termel.**
- Jelen: `email-ingest.ts` kész (HUF/USD/EUR, hash-only, no-PII), de agent-sweep nem fut -> 0 sor.
- Kell: a Gmail-sweep tényleges beütemezése (marveen/heartbeat), a kinyert összegek -> actual_invoice line-ok.
- Fájlok: `email-ingest.ts`, scheduled-task, google MCP.
- Külső: google-private MCP (jelenleg token-lejárat gyanú -- re-auth kellhet).
- Kockázat: alacsony (read-only, hash-only). Méret: **közepes**.
- Upstream: local-only (Gmail-specifikus).

**P0-3: Statikus/kamu forecast a usage-providereknél.**
- Jelen: forecast = MTD (122 458=122 458), mert nincs actual usage-sor; a usage-providerek (Anthropic API, DeepSeek) estimate/manual -> full havi, nem run-rate.
- Kell: valós usage-adat (P0-1) VAGY a subscription vs usage forecast vizuális szétválasztása + a "full monthly, nincs run-rate" explicit jelölése.
- Fájlok: `ledger.ts` (forecast policy már ott van), dashboard (`app.js`).
- Kockázat: alacsony. Méret: **kicsi** (jelölés) / a valós run-rate a P0-1-en múlik.

**P0-4: Vékony history + nincs backfill.**
- Jelen: ~2 hónap, 2026-06 = 1 sor.
- Kell: email-backfill a korábbi hónapokra (Anthropic/OpenAI/Render/DeepSeek számlák).
- Fájlok: email-ingest + egy backfill-futtatás.
- Kockázat: alacsony. Méret: **közepes**.

**P0-5: Token/billing szemantika hiányos.**
- Jelen: token-cost helyesen KÜLÖN + not_billed (jó), DE pricing csak opus-4-8; sonnet-5 (token-tömeg) + 57% None besorolatlan.
- Kell: sonnet-5 (+ egyéb aktív modellek) ráták a pricing.json-ba; a token_usage provider/model attribúció javítása (miért None 57%).
- Fájlok: `store/costops-pricing.json`, `token-usage.ts` (attribúció).
- Kockázat: alacsony. Méret: **kicsi-közepes**.

**P0-6: Original currency / fx nem rögzül.**
- Jelen: original_amount/original_currency/fx_rate oszlopok üresek (mind None), pedig EUR/USD számla valós eset.
- Kell: a collector/email-ingest töltse az eredeti pénznemet + fx-et.
- Fájlok: `email-ingest.ts`, `ledger.ts` upsert.
- Kockázat: alacsony. Méret: **kicsi**.

**P0-7: Nincs budget.**
- Jelen: budgets tábla üres -> nincs budget-vs-actual kontroll.
- Kell: havi budget beállítás (per provider vagy globális) + budget-warning.
- Fájlok: `budgets` tábla, summary, warnings.
- Kockázat: alacsony. Méret: **kicsi**.

**P0 gapek száma: 7.**

### P1 -- kontroll és megbízhatóság
- **Limits/quotas élő adat:** provider_balance_snapshots üres -> DeepSeek prepaid, Render build-minutes automata polling. (közepes)
- **Alert-lefedettség:** jelenleg csak manuális weekly% + expiry; a 80/90/100 automatizálása a valós usage-hez kötve. (közepes)
- **Subscription lifecycle:** next_renewal dátumok hiányoznak (Pro/ChatGPT). (kicsi)
- **Staleness felszínre hozása:** data_freshness van, de a dashboardon nem hangsúlyos "X napja nem frissült". (kicsi)
- **Data-quality jelzés:** a manual/estimate arány (96%) legyen látható minőség-indikátor. (kicsi)

### P2 -- későbbi kényelmi
- Mobil-nézet, export-polish, több chart (trend-vizualizáció), további upstreamelés a Szotasz/marveen ledgerbe.

---

## 12. Javasolt végső célállapot -- "CostOps Finished v1.0"

Nem végtelen feature-lista, hanem konkrét lezárási kritérium:

**Mit kell tudnia:**
1. Havi actual + legalább 3 hónap history (backfillel), no_data külön állapottal.
2. Aktuális MTD ÉS valódi (nem statikus) hó végi forecast, ahol a usage-providereknél run-rate, a subscriptionoknél full-havi -- vizuálisan szétválasztva.
3. Forrás-prioritás betartva ÉS táplálva: provider API/actual > email/invoice > manual > local estimate.
4. Egységes tétellista + confidence + actual_source, a data-quality (manual-arány) látható.
5. Token-cost KÜLÖN, `not_billed` címkével, teljes modell-lefedettséggel (opus + sonnet), soha nem az operational_spend-ben.

**Minimum lefedendő providerek (valós vagy email-alapú $-ral):**
Anthropic (Max/Pro/API), OpenAI (ChatGPT/API), DeepSeek, Render, + Domain/SSL expiry. (Google AI, AWS, Vercel, Cloudflare, PostHog, Wispr, Twilio, Barion: csak ha ténylegesen fizetős -- addig explicit "nincs adat/nem használt".)

**Milyen havi nézet:** min. 3-6 hónap, no_data állapottal, per provider + per confidence bontással.

**Milyen forecast:** usage-providernél run-rate (÷ eltelt hónaprész), subscriptionnél full-havi, mindkettő címkézve; a token-forecast külön.

**Milyen forrásprioritás:** a 4. szakasz létrája, VALÓS adattal táplálva (nem csak elméletben).

**Milyen tokenintegráció:** teljes pricing-lefedettség (minden aktív modell), provider/model attribúció >90% (a None 57% lecsökkentve), not_billed vs api_billed egyértelmű.

**Acceptance tesztek (befejezettnek tekinthető, ha):**
1. Min. 2 providernek van AUTOMATA valós $ adata (nem kézi) egymást követő 2 hónapban.
2. Az email-ingest legalább 1 valós invoice-t behúz és actual_invoice line-t készít (0 -> >0).
3. A forecast egy usage-providernél ténylegesen run-rate (forecast != MTD, amikor van usage-actual).
4. A pricing minden aktív modellt áraz (opus + sonnet); a token_by_agent >2 ágenst ad.
5. A history >=3 hónapot mutat valós adattal, no_data külön.
6. Van beállított budget, és a budget-warning kilő teszt-küszöbön.
7. Original currency + fx rögzül egy nem-HUF számlán.
8. A dashboard egyértelműen megkülönbözteti: actual vs estimate vs token-opportunity-cost.

---

## Éles verifikáció (elvégezve)

| Ellenőrzés | Eredmény |
|---|---|
| Live endpointok curllel | ✓ summary/sources/subscriptions/limits/warnings/period mind válaszol |
| Served app.js | ✓ tartalmazza a costops + token mezőket (operational_spend, forecast_month, no_data, forecast_basis, actual_source, token_by_agent, previous_month) |
| DB-adatok aggregációja | ✓ cost_line_items 20, cost_sources 18, token_usage 64 763, import_runs 15 |
| Timer státusz | ✓ costops-alert-monitor */30 enabled; render-plan napi 04:15; costops-sync automata timer NINCS |
| Email ingest állapot | ✓ implementálva, de 0 sort termelt |
| Provider sync állapot | ✓ csak render futott valaha (15/15 import_run) |
| Dashboard HTTP 200 | ✓ |
| Böngészős nézet | **NEM elvégezve -- őszintén jelezve: a fő-agentnek nincs headless böngészője; csak served HTML/JS + API alapján** |

## Guardrails betartva
- Nincs implementáció / source / DB / config / provider módosítás.
- Nincs service restart, nincs push/PR, PR1 érintetlen.
- Nincs scraping / private API (csak a saját bearer-védett dashboard API + lokális DB olvasás).
- Nincs raw PII / secret / account ID / teljes email / számla ebben a fájlban.
