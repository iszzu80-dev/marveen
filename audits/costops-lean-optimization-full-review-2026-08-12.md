# CostOps + Lean Optimization — teljes code review (funkcionális + kódminőség)

**Dátum:** 2026-08-12 · **Ág:** `claude/costops-agp-lean-review-mksxlj`
**Kérte:** Istvan — „nézd át a costops, AGP 1.8 és a lean optimization funkcionalitást, teljes code review funkcionális és kódminőségi szempontból"
**Módszer:** négy párhuzamos mély-review (CostOps core domain; CostOps collectors/riasztás; lean optimization; APG 1.8 kernel — utóbbi külön dokumentumban: `marveen-apg-kernel/audits/apg-1.8-wp1-review-2026-08-12.md`). Minden találat forráskódra hivatkozik (fájl:sor), a legsúlyosabbakat in-memory DB-vel empirikusan reprodukáltuk. A marveen-suite repót ellenőriztük és kizártuk: a három terület nem érinti.

---

## 0. Tesztbázis (a review kiindulópontja)

- **marveen-private (vitest):** 5901 tesztből **5890 zöld**, 4 skip, 7 bukás. Mind a 7 bukás a sandbox-környezet műterméke: a konténer rootként fut, és a bukó tesztek `chmod`-dal írásvédett könyvtárat szimulálnak — root alatt az írás a 0o500-as könyvtárba is sikerül, így a tesztelt hibaág elérhetetlen (pl. `optimization-master-and-emergency.test.ts:76`, O-7). Normál fejlesztői gépen a teljes suite zöld.
- **marveen-apg-kernel (unittest):** 441 tesztből 124 error + 9 fail — **mind környezeti csatolás** (`/home/iszzu/...` beégetett útvonalak: methodology pack YAML-ok, core DB, dashboard token). Ez önmagában HIGH súlyú lelet, részletek a kernel-auditban.

## 1. Összkép

A rendszer alapfilozófiája („sose találj ki számot", confidence-proveniencia, idempotens dedup, append-only javítás törlés helyett) következetesen jelen van, a tiszta számító rétegek (alerts, capacity, dispatch, capacity-routing, session-saturation, context-packet) kifejezetten erősek és jól teszteltek. A hibák szinte kivétel nélkül a **modulok közötti varratokon** ülnek:

1. **CostOps core:** a számla→korrekció→config-sync hármas kölcsönhatása két kritikus pénzintegritási hibát ad (dupla könyvelés + konvertálatlan deviza), és a period-close írásvédelem nem minden írási ajtón van rajta.
2. **CostOps collectors:** hat kézzel másolt sync-boilerplate, amelyben a javítások (fx=0 guard) csak az egyik példányra landoltak; egy determinisztikus, ~90 nap után beélesedő UNIQUE-sértés a teljes ajánlás-pipeline-t megöli.
3. **Lean optimization:** a megfigyelő oldal megbízható, de a **vezérlő oldal részben dekoratív** — a vészleállító nem hozza vissza a flottát a primary modellre, több hirdetett config-kapcsolónak nincs olvasója, és az `isPackageOpen` a domináns dispatch-típusokra örökre nyitva ragad.

**Prioritási javaslat:** először COS-CORE-C1/C2/H1/H2/H3 együtt (egy folyamathoz tartoznak), párhuzamosan OPT-C1 és COS-OPS-C1 (mindkettő determinisztikusan beélesedő üzemi hiba), utána a HIGH-ok, végül a MEDIUM-ok a close-readiness kapu körül (COS-CORE-M1/M2).

---

## 2. CostOps core domain (`src/costops/` — schema, ledger, invoice, correction, period, forecast, kpi, reconciliation, export, subscriptions…)

### KRITIKUS

**COS-CORE-C1 — Számlakorrekció + summary-olvasáskori re-sync feltámasztja a javított sort → tartós dupla könyvelés.** *(empirikusan reprodukálva)*
`correction.ts:82-87` átnevezi a voidolt sor `dedup_key`-ét; `ledger.ts:340` a `fixed|<source>|<hónap>` kulcsra upsertel; `web/routes/costs.ts:52` minden `GET /api/costs/summary` előtt lefuttatja a `syncFixedCostsToLedger`-t. Forgatókönyv: 22 000 Ft fix költség → számla (23 500) korrigálja → a **következő dashboard-olvasás** újra beszúrja a 22 000-et (a kulcs felszabadult) → `current_spend = 45 500`, és így is marad. Javítás: a sync hagyja ki azt a forrás+hónapot, amelyre `fixed|…` sort korrigáló lánc létezik, és/vagy a korrekció vigye tovább az eredeti dedup_key-t (partial unique index `WHERE voided_at IS NULL`).

**COS-CORE-C2 — `recordInvoice` nem konvertál devizát: az idegen pénznem nyersen összegződik a HUF-ledgerbe.** *(reprodukálva)*
`invoice.ts:198-204` a `net`-et és a `currency`-t változatlanul szúrja be; minden aggregátor a `billed_cost`-ot pénznem-vakon összegzi. 11,15 USD számla → 11,15 „forint" a headline-ban (~360× alulmérés). Kontraszt: `email-ingest.ts:55-59` és `manual-entry.ts:70` helyesen konvertál/elutasít. Javítás: `toHuf`/`convertToHufWithProvenance` a számla-ajtón is, proveniencia-oszlopokkal, nem konvertálható pénznemre 400.

### HIGH

**COS-CORE-H1 — A `GET /api/costs/summary?month=` lezárt hónapba ír (GAP-13 freeze bypass).** *(reprodukálva)* `ledger.ts:299-347` (`syncFixedCostsToLedger`) nem hívja a `checkPeriodWritable`-t; a lezárás utáni config-módosítás puszta *megtekintésre* átírja a lezárt hónap sorát. A manual-entry/email-ingest/invoice ajtók mind őrzik a guardot, ez az írási út nem.

**COS-CORE-H2 — `invoice.ts` részleges állapotot commitol, ha a beágyazott korrekció elbukik.** `invoice.ts:195,265`: a tranzakción belüli `return null` **commitol** (better-sqlite3 csak throw-ra rollbackel). Egy legális 409-es korrekció-elutasításnál a `costops_invoices` INSERT bent marad `ledger_line_id NULL`-lal → az újrapróbálás örök „duplicate invoice" 409. Javítás: throw a tranzakción belül, kívül mappelés a result-alakra.

**COS-CORE-H3 — A korrekció az eredeti sor confidence-ét másolja: a rögzített számla `manual` marad.** *(reprodukálva)* `correction.ts:104-105` + `invoice.ts:194`. Következmény: a számlázott összeg sosem előzi meg a manual sorokat (ez táplálja C1-et), a reconcile `ACT_CONF` szűrője (`ledger.ts:517`) és a `buildReconciliation` (`reconciliation.ts:90`) nem látja. Javítás: a `createCorrection` fogadjon `confidence`/`actual_source` felülírást, az invoice adja át az `actual_invoice`/`email_invoice` értéket.

**COS-CORE-H4 — A forecast-capture USD balance-delta előrejelzést kever HUF összegekbe.** `forecast-capture.ts:100-103` a nyers USD snapshotokat adja tovább; a per-forrás USD forecast a HUF TOTAL-ba összegződik (`:108-117`); a `buildReconciliation` (`reconciliation.ts:97-107`) HUF tényt hasonlít USD tervhez, ami `variance` státuszt és close-blokkot okozhat (`period-close.ts:107-108,130`). Javítás: konverzió HUF-ra (a deepseek collector ismeri az `fxUsdHuf`-ot) vagy pénznem a `forecast_snapshots`-on + keresztdeviza-összevetés tiltása.

**COS-CORE-H5 — Hónapokon átnyúló számlázási periódus mindkét hónapban teljes értéken számolódik.** Az átfedés-predikátum (`ledger.ts:472-477,663-666`, `period.ts:31-35`, `reconciliation.ts:64-68`, `export.ts:83`, `forecast-capture.ts:28-33`) arányosítás nélküli; egy júl. 20.–aug. 20. ciklusú előfizetés-számla (a repo saját Claude Max példája) júliusban ÉS augusztusban is teljes értéken van benne a spend/trend/budget/exportban. Javítás: domináns hónapra normalizálás vagy napi arányosítás.

### MEDIUM

**COS-CORE-M1 — Az egyenlő-confidence több-soros feloldás (dec9ae64 kártya) csak a ledger.ts-ben javult; három testvérmásolat drift-el:** `reconciliation.ts:94`, `forecast-capture.ts:38-42`, `export.ts:208-215` továbbra is „egyet választ" összegzés helyett — a reconciliation fejléce hamisan állítja, hogy egyezik a dashboarddal. Javítás: `resolveSourceWinners` exportálása és újrahasznosítása.

**COS-CORE-M2 — `import_runs` státusz-szótár drift: `dry_run`/`skipped`/`locked` hibaként olvasódik.** `ledger.ts:736`, `period-close.ts:104,130`, `inventory.ts:192`, `lifecycle.ts:64`: egy dry-run előnézet vagy `skipped` tick „failed" providert, `blocked` lifecycle-t és close-blokkot okoz. Csak `error`/`partial`/`rate_limited` legyen hiba (a `ledger.ts:728` `lastFailStmt`-je ráadásul nemlétező `'failed'` státuszra szűr).

**COS-CORE-M3 — Budget-scope-ok inkonzisztens bázison:** `budgets.ts:61-87` — a `global` az `operational_spend`-et, a `provider`/`category`/`source` az `all_sources` headline-feloldást használja; a per-provider budgetek nem adják ki a globálisat.

**COS-CORE-M4 — `charge_category: 'invoice'` nem érvényes `ChargeCategory`:** `email-ingest.ts:92`, `manual-entry.ts:90` vs. a union `config.ts:33-39`; továbbá `invoice.ts:202` minden első számlasorra `'usage'`-t éget, így előfizetés-számla run-rate-forecastot kap (hónap eleji számlánál túlbecslés).

**COS-CORE-M5 — `ingestEmailCosts` tetszőleges `confidence` stringet elfogad:** `email-ingest.ts:129` — egy elírás (`'actual-invoice'`) 0-prioritással landol, a valódi számlát a `manual` alá fokozza le, jelzés nélkül. Whitelist kell a `CostConfidence` unionra.

**COS-CORE-M6 — `period.ts` 0-t fabrikál pending-only hónapra:** `period.ts:37-38` — a `no_data` a `PENDING_CONF` szűrő *előtt* számolódik; egy csak-pending hónap `no_data:false, operational_spend:0`-t jelent — pont az a kitalált nulla, amit a modul fejléce kizár.

**COS-CORE-M7 — Nem atomi config-írás:** `config.ts:162-164`, `fx-config.ts:86` — közvetlen `writeFileSync` az egyetlen példányra; félbeszakadt írás után a lap üres configként töltődik, minden fix költség/budget definíció elvész. Temp-fájl + `renameSync`.

**COS-CORE-M8 — Ajánlás accept/dismiss státusz-guard nélkül:** `recommendations-store.ts:147-164` + `optimization.ts:454-461` — lezárt/elutasított rekord némán visszabillenthető, a korábbi emberi döntés elvész (a domain minden más átmenete 409-cel őrzött).

### LOW (rövid lista)

- **L1** `ledger.ts:26` — hibás `monthKey` (pl. `2026-8`) némán aktuális hónapra esik, 200-zal.
- **L2** `invoice.ts:155` — `noref-<source_id>` dedup-fallback: második ref-nélküli számla hamis 409.
- **L3** `email-ingest.ts:104` — `skipped` számláló sosem nő (halott mező); `:115` typo.
- **L4** `email-ingest.ts:134,144` — `fx_date` = ingest-idő, miközben a `conversion_method` `invoice_date_rate`-et állít.
- **L5** `monthly-portfolio-review.ts:44-48` + `ledger.ts:570` — soft-disabled forrás sorai a spendben igen, az `all_sources`-ban nem → hamis eltérés-riasztás; round2 per-forrás vs. összeg-után ±0,01 hamis riasztás.
- **L6** `subscriptions.ts:214` — `past_due` csak `active` státuszra; lejárt-de-cancelled előfizetés sosem jelződik.
- **L7** `email-ingest.ts:55` — `toHuf` két pénznemet pozicionálisan égetett, pedig `FxRateTable` létezik.
- **L8** `monthWindow` és `round2` több fájlban duplikálva (kpi.ts már 4 tizedesre kerekít saját helperrel).
- **L9** `ledger.ts:37` — jövőbeli hónapra `fractionElapsed` ~1 mp-re clampel → csillagászati forecast.
- **L10** `invoice.ts:361-363` — fölösleges dinamikus import miatti async-fertőzés.
- **L11** `period-close.ts:112` — a close-readiness a riasztásokat globálisan számolja, nem a zárandó hónapra szűrve.

### Tesztlefedettségi rések (core)

1. sync-utáni-korrekció interplay (C1); 2. lezárt hónap védelme a summary-olvasási úton (H1); 3. devizás számla az invoice-ajtón (C2); 4. korrekció-bukás rollback (H2); 5. balance-snapshotos forecast-capture pénzneme (H4); 6. több-számlás összegzés a reconciliation/export/forecast felületeken (M1); 7. `recommendations-store` dedikált teszt; 8. `schema.ts` dupla-init idempotencia.

---

## 3. CostOps collectors + riasztás (`src/costops/collectors/`, alerts*, limits, capacity, market-watch, ops scheduled-tasks)

### KRITIKUS

**COS-OPS-C1 — Lejárt ajánlás újra-észlelése UNIQUE-sértéssel örökre kiüti a capture-t.** `optimization.ts:420-425` a lejárt sorhoz illeszkedő jelöltet `toInsert`-be teszi („friss rekordot kap"), de `optimization-capture.ts:236-249` sima `INSERT`-et futtat (`dedup_key UNIQUE`, `optimization.ts:479`), tranzakció nélkül. ~90 nap (`DEFAULT_EXPIRY_SECONDS`) után az első újra-észlelés `SQLITE_CONSTRAINT_UNIQUE`-ot dob; mivel az insertek futnak először, a többi ajánlás touch/resolve/expire ága sem fut le; a `captureNowSafely` (`reliability-observation.ts:84-89`) naponta újra ugyanígy bukik. Javítás: `INSERT … ON CONFLICT(dedup_key) DO UPDATE` (status→open, first_seen/expires_at reset) + `db.transaction()`; teszt: expire → re-detect → harmadik capture.

### HIGH

**COS-OPS-H1 — `costops-daily-sync` a dashboardot deadlockolja és sosem szinkronizál.** `ops/scheduled-tasks/costops-daily-sync/check.py:15-35` szinkron HTTP-t hív a saját dashboardra, miközben a `command-task.ts:68` `spawnSync`-kel blokkolja az event loopot — pontosan az a deadlock, amit a testvér-szkript (`costops-alert-monitor/check.py:14-31`) dokumentál és detach-guarddal javít (15 egymás utáni éles bukás után). Ráadásul minden kivételt lenyel és 0-val lép ki → a health „success"-t rögzít. Javítás: `COSTOPS_WORKER` detach-guard átvétele, vagy a task törlése (a `scheduled-sync.ts` in-process már lefedi ugyanazokat a providereket).

**COS-OPS-H2 — DeepSeek: hibás-de-200 balance-válasz $0-ként parseolódik és tartósan mérgezi az MTD spend-et.** `deepseek.ts:63-70` (`parseDeepSeekBalanceUsd` 0-t ad hiányzó/parseolhatatlan `balance_infos`-ra; `is_available` sosincs ellenőrizve) → `:116` valós snapshotként landol → `deriveMtdSpend` (`:24-31`) a nullára-esést teljes egészében elköltésként könyveli, és a következő jó olvasat „feltöltésként" ignorálódik — a fantomköltés a hónapban marad; az entitlement `critical`-ra vált, a kimerülés-előrejelzés minden későbbi hónapra torzul. Javítás: felismerhetetlen alak / `is_available:false` → `null` + `error` run, snapshot-írás nélkül.

**COS-OPS-H3 — Jóindulatú import-státuszok (`skipped`/`locked`/`dry_run`) bukott sync-ként riasztanak → örökké égő / flapelő alertek.** `alerts-capture.ts:196` és `ledger.ts:736` `status !== 'ok' → failed`; a `types.ts:57-64` explicit kimondja, hogy a `skipped` nem hiba. Alapértelmezett configgal az óránkénti `anthropic-usage-snapshot` `skipped` sora örökös `failed_sync|anthropic` riasztást ad; mivel az anthropic providerhez **két** collector fut eltérő ütemben (`scheduled-sync.ts:101,133`), a „legutóbbi run" óránként váltakozik → flapping + `recurrence_count`-infláció. Javítás: `('ok','skipped','dry_run','locked')` nem-hibás, és/vagy a legutóbbi-run kulcsa `collector_name` legyen.

**COS-OPS-H4 — Az fx=0 guard (23912ca4 kártya) csak az OpenAI-ra landolt; az Anthropic és GitHub collector 0 Ft-os `provider_api` sort fabrikál.** `openai.ts:60,139-144` őrzött; `anthropic.ts:68` és `github.ts:59` nem — fx=0 defaultnál (`|| 0` fallback, `anthropic.ts:155-161`, `github.ts:133-139`) `usd*0=0` HUF landol `provider_api` confidence-szel, ami **felülírja a valós manual becslést** a reconcile-ban (a `provider_api` rangban a `manual` felett áll). Javítás: a kétszintű guard replikálása mindkét collectorba + `fxUsdHuf:0` tesztek.

**COS-OPS-H5 — Anthropic cost-report lapozás némán elveszik → havi alulmérés.** `anthropic.ts:40` deklarálja a `has_more`-t, de sem a mapper (`:52-66`), sem a `collectRaw` (`:92-108`) nem követi; a cost_report napi bucketekben lapoz, így egy sok-napos hónapból csak az első lap összege importálódik `provider_api` tényként — ami aztán megnyeri a reconcile-t a helyes manual becslés ellen. (OpenAI: `limit=31` kifér, de a cursor ott sincs követve — `openai.ts:25,85`.) Javítás: cursor-követés vagy run-bukás `has_more:true`-nál.

### MEDIUM

**COS-OPS-M1 — A „peak" balance mindenkori maximum, nem az utolsó feltöltés:** `limits.ts:126-131`, `warnings.ts:274-276` — egykori $50 után $4-es cirkálásnál `usage_pct=0.92` → örök `critical`. Az utolsó emelkedés (top-up) óta mért csúcs kell.

**COS-OPS-M2 — Elavult manual/codex capacity snapshot korhatár nélkül riaszt:** `limits.ts:100-108,145-165` — 3 hetes 85%-os heti olvasat örökké `high`-t tart (vagy valós 100%-ot rejt); a `capacity.ts` staleness-fegyelme (`:39`) erre az útra nincs bekötve.

**COS-OPS-M3 — `alerts-capture.ts` nagyban duplikálja az `alerts-store.ts`-t és elveszti a tranzakcionalitást:** `alerts-capture.ts:353-381,398-429` vs. `alerts-store.ts:65-108`; két eltérő szemantikájú exportált `listAlerts`. A `captureAlerts` hívja a `reconcileAndPersist`-et.

**COS-OPS-M4 — DeepSeek és Codex sync a közös runnert és a per-provider import-lockot megkerüli:** `deepseek.ts:79-147`, `codex.ts:138-178` vs. `import-durability.ts:1-4` állítása; kézi `/api/costs/sync` versenyezhet az ütemezett tickkel lock nélkül; `upsertLine`/`recordRun` duplikátumok.

**COS-OPS-M5 — `costops-alert-monitor` bármely valid-JSON választ elhisz; a `blocked` súlyosság sosem pusholódik:** `check.py:87-98` (401/500 JSON body → `ok=True`, state-drop → visszatéréskor duplikált push), `:106` a `('high','critical')` szűrőből kimarad a `warnings.ts:20` szerinti `blocked` — a legsúlyosabb szint. Holt `covered_prefixes`, nem atomi state-írás.

**COS-OPS-M6 — Inkonzisztens fx-forrás a collectorok közt:** `openai.ts:130-134` fx-config; `anthropic.ts:155-161`, `github.ts:133-139`, `deepseek.ts:99-102` a Render plan-pricing fájl `fx_usd_huf`-ját olvassa — amit a `routes/costs.ts` kommentje maga minősít nem-fx-ténynek; a Render-config kitakarítása némán nullázza három collector fx-ét (→ H4).

**COS-OPS-M7 — `GITHUB_BILLING_USER` import-időben, validálás nélkül:** `github.ts:78,86,106` — üres env → `GET /users//settings/...` és generikus 404; a többi collector precíz blockert ad.

**COS-OPS-M8 — Render sync futásonként kétszer hívja a provider API-t:** `render.ts:258-263` — `collectRaw` a detailhez + még egyszer a runneren át; a `detail_json` és az importált sor széttarthat.

### LOW (rövid lista)

- **L1** `import-durability.ts:110-126` `withRetry` halott kód; egyik collector sem retry-ol, a `partial`/`rate_limited` státuszokat semmi sem termeli.
- **L2** Beégetett id-salt-ok trackelt forrásban (`anthropic.ts:168` stb.); `hashRef` 4× másolva, pedig `ledger.ts:46` exportálja; a validált `collectors/config.ts` wiring használatlan.
- **L3** Két küszöb-létra egy fogalomra: `warnings.ts:69-71` (0.7/0.8/0.9/1.0) vs. `limits.ts:46-52` (0.7/0.9/1.0) — 0,85-nél `warning` státusz + `high` figyelmeztetés egyszerre.
- **L4** `anthropic.ts:62` — halott ternary: nem-USD összeg USD-ként összegződik.
- **L5** `dispatch.ts:611-620` — duplikált `accepted` sor ellen csak írói fegyelem véd; partial unique index kellene.
- **L6** `render.ts:41-46` — a loader olvasási mellékhatásként example fájlt ír a `src/` fába.
- **L7** `alerts.ts:324-327` — jel-forrás kiesésekor (üres config-olvasat) az élő riasztások auto-resolve-olódnak, majd „recurrence"-ként nyílnak újra.
- **L8** `warnings.ts:285` felhasználónak látszó typo; `scheduled-sync.ts:212-224` másodperc-azonos runoknál duplán rögzít; alert-monitor state-írás nem temp+rename.

### Tesztlefedettségi rések (ops)

1. expired→re-detected ajánlás harmadik capture-je (C1); 2. `skipped`/`locked`/`dry_run` a riasztás-gyűjtőben (H3); 3. `fxUsdHuf:0` az anthropic/github mapperekre (H4); 4. hibás-de-200 DeepSeek fixture (H2); 5. `has_more:true` fixture (H5); 6. több-collector-per-provider „latest run" szemantika; 7. az ops Python szkriptekre nulla teszt (legalább source-scan a detach-guardra).

**Titokkezelés:** összességében erős (Vault-only refek, `sanitizeError`, shape-only dry-run); kivétel a trackelt salt-ok (L2) és a dokumentált plaintext `.env.render` fallback (`render.ts:204-220`).

---

## 4. Lean Optimization (`src/optimization/`, `src/capacity-routing.ts`, `src/web/capacity-routing-*`, `context-packet`, dispatch-admission)

### KRITIKUS

**OPT-C1 — A vészleállító nem hozza vissza a flottát a primary-re; a routing-nézet ezután hazudik róla.**
A lánc: `routes/optimization.ts:303-314` (emergency-disable ír `runtimeRouting:false`-t, de a `store/runtime-model-overlay.json`-hoz nem nyúl) → `capacity-routing-runner.ts:306-307` (`enabled:false` → a sweep azonnal kilép, **climb-back soha többé nem fut**) → `capacity-routing-store.ts:212-222` (`resolveRuntimeModel` a `config.enabled`-et nem nézi) → `agent-process.ts:919,1047` (minden respawn a túlélő overlay-ből indít) → `optimization-routing.ts:61-71` (`static_mode`-ban `runtime_model = configured_primary` az overlay olvasása nélkül — és az `optimization-routing.test.ts:57-63` ezt a félrejelentést **pinneli**). Forgatókönyv: fallback X-re → vészleállítás → „leállt" válasz → az agent újraindul **X-en, örökre**, miközben az API primary-t mutat. Javítás: (a) `resolveRuntimeModel` kapuzzon `config.enabled`-re is; (b) az emergency-disable / OFF-propagáció törölje az overlay-eket routing-eseménnyel; (c) a static_mode-ág is olvassa az overlay-t és a valóságot jelentse. Teszt: „emergency-disable után a respawn a configured primary-t indítja."

### HIGH

**OPT-H1 — `isPackageOpen`: a „nincs terminális outcome" = „folyamatban" azonosítás a sweepet szinte tartósan fogva tartja.** `capacity-routing-runner.ts:98-105` csak {accepted, failed, cancelled}-et tekint zártnak; a `resolveOutcome` defaultja `unknown` (`dispatch.ts:327-332`); a sikeres üzenetkézbesítés és a schedule-runner (`schedule-runner.ts:681`) semmilyen outcome-ot nem ír. A domináns dispatch-származások (Phase 2 canary: 16/20) így örökre „nyitottak": sosem történik fallback blokkolt primary-nál, és overlay-en lévő agent TTL után sem mászik vissza (`runner:234-235`). Javítás: időkorlát (pl. `maxWindowSeconds` újrahasznosítása) a nyitottságra, mindkét irányra teszttel.

**OPT-H2 — A `routing.automaticFallback` (és a többi `routing.*` kapcsoló) semmit sem vezérel.** Az `automaticFallback` olvasói: csak a summary `system_state` (`optimization-summary.ts:393`) és az emergency-írás; `trustedProvidersOnly`, `maxFallbacksPerProfile`, `maxAutomaticFallbacksPerDispatch` olvasója **nulla**. `automaticFallback:false` mellett a sweep tovább ír overlay-t, miközben a summary `observation`-t jelent (`:391-395`) — az O-1 hibaosztály újra, egy kapcsolóval arrébb. A committolt example (`config-examples/optimization-config.example.json:16-19`) mind a négyet funkcionálisként hirdeti. Javítás: bekötés a runner set-ágába vagy a mezők törlése.

**OPT-H3 — A frontend eldobja a 66cc28f-fix `partial` jelzését.** `web/optimization/optimization-controls.js:201-209` HTTP 200-ra feltétel nélküli `emergency_success` alertet mutat; a `partial`/`warning`/`stillRunning` mezőket (amiket `optimization-api.js:29-33` visszaad) sosem olvassa — a félig-leállt rendszert az operátor sikernek látja, pont a commit-üzenetben narrált hibamód. Javítás: branch a `response.body.partial`-ra.

### MEDIUM

**OPT-M1 — Elavult túllimit-olvasat örökre `blocked`-ot pinnel; a provider-adta reset-idő ignorálva:** `capacity-routing.ts:70-77` a staleness csak az available-ágat fokozza le; a `resets_at` perzisztált és a codex collector tölti (`schema.ts:205`, `capacity-snapshots.ts:107,144`), de a `usageFigure` (`capacity.ts:176-204`) nem olvassa, a runner pedig `providerStatedResetAtMs: null`-t éget (`runner:239`) hamis komment mellett. Reset után járt snapshot → `unknown`; a climb-back kapja meg a valós reset-időt (phase-3 spec §4).

**OPT-M2 — `limitedThreshold` halott kapcsoló, a komment nemlétező útra hivatkozik:** `capacity-routing-store.ts:99,142-146` tárolja, semmi sem adja át a `deriveCapacityState`-nek; `runner:192` kommentje fantom-útvonalat említ.

**OPT-M3 — A modul-togglék és a master a jelentést kapuzzák, nem a viselkedést; a configváltozás auditálatlan:** a collectorok, a P2-B admission (`kanban.ts:120`), a dispatch-stampelés és a context-guard feltétel nélkül futnak — a togglék csak a summary-szekciókat kapcsolják (`optimization-summary.ts:217-364`). `PATCH /settings` és emergency-disable nem ír audit-eseményt, pedig a dashboard-spec (§8.1, acceptance: „minden configváltozás auditált") megköveteli; kézzel szerkesztett `optimization-config.json` bootkor nem propagálódik (az O-1 divergencia visszacsempészhető).

**OPT-M4 — `lastEnabledConfiguration` restore sosem épült meg:** írása `optimization-config.ts:313-319`, olvasója nulla; a spec §8.1/§9 és az as-built (`optimization-dashboard-as-built.md:83`) állítja a funkciót.

**OPT-M5 — Döntés-életciklus zsákutcák:** `optimization-decisions.ts:71-75` — az `insufficient_evidence` nincs a reopen-halmazban, így később actionable verdicttel is örökre ott ragad (`:149-161` csak a verdictet frissíti); `deferred_until`-t semmi sem veszi elő; `expired`-nek nincs írója.

**OPT-M6 — P2-B a 4 ígért dispatch-origóból 1-en van bekötve:** `phase2-p2b-context-packet.md:25-27` vs. `recordPacketMetadataSafe`/`evaluateDispatchAdmissionSafe` egyetlen éles hívója `routes/kanban.ts:120,175` — `large` csomag üzeneten/schedule-ön át kapuzatlan.

**OPT-M7 — Packet-méret megkerülhető az `ArtifactRef.note`-on át:** `context-packet.ts:388-398` az excerptet és a szabad szekciókat (`:475-483`) korlátozza, a `note`-ot nem — teljes dokumentum beilleszthető validan (`:158,227`). `MAX_SECTION_CHARS` a note-ra is.

**OPT-M8 — Hiányzó committolt `capacity-routing-config.example.json`; az example-scaffoldok halott kód:** `capacity-routing-store.ts:228,232`, `optimization-config.ts:388` — hívó nélkül, tartalom-duplikációval.

### LOW (rövid lista)

- **L1** A ceiling-könyvelés dekoratív: `resolveRuntimeRouting` mindig `fallbacksUsedThisPackage: 0`-val hívódik (`runner:252`), a `ceiling_reached` élesben elérhetetlen, a spec „második degradáció eszkalál" mechanizmusa sehol.
- **L2** A primary-vel közös capacity-kulcsú jelölt a banner-blokkot nem látja (`runner:219-221`) — kimerült fiókra is „vissza lehet esni".
- **L3** Summary-holtág: a `routing.blocker` ág halott (a két olvasó sosem dob); az `observation` preset mindig `partially_disabled`-öt jelent; a `data_freshness` a most-számolt reportok `generated_at`-maximuma — semmit sem mér.
- **L4** Névtér-inkonzisztencia a két config-sík közt (`maxFallbacksPerProfile` vs. `MAX_FALLBACK_CANDIDATES` stb.); `trusted_candidate_count` valójában `enabledForRouting`-ot számol; literál `.slice(0, 2)` konstans helyett (`capacity-routing-store.ts:141`).
- **L5** `initOptimizationDecisionsSchema` minden requestre fut (`routes/optimization.ts:70-72`); char-vs-byte összevetés (`context-packet.ts:395`); `previewRuntimeRouting` `packageOpen:false`-t éget (`optimization-routing.ts:162`) — a preview olyan váltást ígérhet, amit a runner visszatartana.

### Tesztlefedettség (lean opt)

Erős: a tiszta capacity-registry (34 teszt, mutáció-bizonyított), overlay-store + rollback-proof, a kill-switch lánc (O-1/O-2/O-7) az injektálható bukó-propagációval, saturation/admission/kanban wiring, packet builder/validator/secret-scan.
Hiányzik: a `capacity-routing-runner.checkAgent` end-to-end (a sweepre **nulla** teszt — `isPackageOpen`, banner→blocked, overlay set/clear, `limitedThreshold`); a vészleállítás-utáni respawn út (C1 — a meglévő static_mode teszt a félrejelentést pinneli); a frontend partial-kezelése (nincs frontend-harness); döntés-életciklus kiutak; a `note`-bypass.

**Spec-konformancia pozitívumok (ellenőrizve):** a Phase 1 Block B additivitás állításai egyeznek a kóddal; nincs kumulatív token-sapka; a becslés-confidence strukturálisan `estimated`; a `configuredPrimary`-t a routing-út sosem írja (default-deny allowlist-teszt); a P2-C auth-profil finomítás a fejléc-narratívával egyezik; a DeepSeek $0,50 balance-padló a dokumentált owner-döntéssel egyezik.

---

## 5. Összefoglaló prioritás

| # | Találat | Súly | Miért először |
|---|---------|------|---------------|
| 1 | COS-CORE-C1 + C2 + H1 + H2 + H3 | CRITICAL/HIGH | Egy folyamat (számla→korrekció→sync) négy interaktáló hibája; a pénzintegritás jelenleg nem megbízható vegyes hónapokra |
| 2 | OPT-C1 | CRITICAL | A vészleállító a nevével ellentétes állapotot hagy hátra, és a rendszer hazudik róla |
| 3 | COS-OPS-C1 | CRITICAL | Determinisztikus, ~90 napra időzített pipeline-halál |
| 4 | COS-OPS-H2 + H4 + H5 | HIGH | Mindhárom „fabrikált vagy csonka szám nyeri a reconcile-t" osztályú |
| 5 | OPT-H1 + H2 | HIGH | A Phase 3 routing élesben nagyrészt inert / a kapcsolók dekoratívak |
| 6 | COS-OPS-H3 + COS-CORE-M2 | HIGH/MED | Ugyanaz a státusz-szótár drift két helyen; riasztás-zaj + close-blokk |
| 7 | Kernel: ERROR→PASS aggregáció + pack-root csatolás | CRITICAL/HIGH | Külön dokumentumban (kernel audit) |
