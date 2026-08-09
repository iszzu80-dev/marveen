# CostOps v0.1 PR1 — Local Cost Ledger MVP: repo-audit + plan

Author: marveen (Opus) · Date: 2026-07-04 · Status: PLAN (no source changed)
Scope: read-only, deterministic, FOCUS-inspired local cost-tracking base layer for Marveen.
Related: `audits/upstream-capacity-aware-model-routing-design.md` (#517 capacity-aware routing — future integration, NOT a prerequisite).

---

## 0. Rövid verdikt

**A PR1 kicsi, biztonságos és megéri.** A Marveen már ma is gyűjt per-agent token-használatot (`token_usage` tábla, 36 790 sor) egy determinisztikus, óránként futó ingesztorral — ez kész `usage_events` alapréteg. A CostOps v0.1 ehhez tesz egy vékony, FOCUS-ihletésű **cost** réteget (3 új tábla + 1 lokális config + 1 read-only API végpont), model-routing / fallback / agent-stop / provider-probe NÉLKÜL. A hiányzó egyetlen érdemi mező a `token_usage.model` (a token→forint árazáshoz kell) — ez viszont NEM PR1-blokkoló: a PR1 a kézi/fix költségeket (Claude Max, ChatGPT, hosting, domain, SaaS) és a token-VOLUMENT összesíti, a token→cost árazás a v0.2 enrichmentje.

**Javaslom a PR1 implementációt** — de a spec szerint source-módosítást csak külön jóváhagyásod után kezdek. A legkisebb-biztonságos vágás: **backend-only** (séma + config + read-only `GET /api/costs/summary`), a dashboard Costs-tab egy triviális fast-follow (a frontend nem fordított, nincs build-kockázat).

---

## 1. Repo-audit — a kérdéseidre a konkrét válaszok

### 1.1 Melyik SQLite DB / migrációs pattern illik ehhez?
- DB: `store/claudeclaw.db`, `better-sqlite3@^11`, WAL mód. Megnyitás: `initDatabase()` — `src/db.ts:40,67-68`; startupkor hívva `src/index.ts:407`. `STORE_DIR` exportálva `src/config.ts`-ből.
- **Nincs formális migrációs framework** (nincs migrations/ mappa, nincs schema_version, nincs runner). A séma teljes egészében `initDatabase()`-ben inline, minden induláskor idempotensen lefut. Két bevett idióma:
  - **Új tábla**: `CREATE TABLE IF NOT EXISTS ...` (+ `CREATE INDEX IF NOT EXISTS`). Minta: `token_usage` — `src/db.ts:445-466`.
  - **Új oszlop meglévő táblán**: `try { db.exec('ALTER TABLE x ADD COLUMN ...') } catch {}` (mert a CREATE IF NOT EXISTS no-op a régi installokon). Minták: `src/db.ts:80-85, 162-166, 401-402`.
- **CostOps-nak**: 3 `CREATE TABLE IF NOT EXISTS` blokk az `initDatabase()`-be. Nincs runner/registráció, a következő process-startkor él (és a tesztekben `initDatabase(':memory:')` alatt).

### 1.2 Hol vannak a dashboard/API route-ok?
- Plain Node `http.createServer` (nincs Express), `src/web.ts:80`. Moduláris "try-handler chain": route-modulok `src/web/routes/*.ts`-ben, mind exportál egy `tryHandleX(ctx): Promise<boolean>`-t; a dispatcher sorban végigmegy rajtuk (`src/web.ts:154-183`), `RouteContext` típus `src/web/routes/types.ts:7-13`, `json()` helper `src/web/http-helpers.ts`.
- Meglévő minta-végpont (read-only summary): `GET /api/token-usage/summary` — `src/web/routes/token-usage.ts:27-36`.
- Új végpont: új `src/web/routes/costs.ts` (`tryHandleCosts`) + 2 sor `src/web.ts`-ben (import + egy dispatch sor), majd `npm run build`. Az auth automatikusan öröklődik (lásd 1.6).

### 1.3 Hol vannak a scheduled task / heartbeat / command minták?
- Helyük: `~/.claude/scheduled-tasks/<név>/task-config.json` (+ LLM-tasknál `SKILL.md`). Séma: `src/web/scheduled-tasks-io.ts` (`ScheduledTask`, `type: 'task' | 'heartbeat' | 'command'`).
- **`command` típus = RAW SHELL, non-LLM, determinisztikus** — pontosan ez kell a collectorhoz. Minta: `~/.claude/scheduled-tasks/build-done-monitor/task-config.json` (`"type":"command","command":"python3 .../check.py","timeoutMs":30000,"failThreshold":2`). Runner: `src/web/schedule-runner.ts` (60s tick, `:449-454` command-ág — se tmux, se agent, se LLM). Executor: `src/web/command-task.ts` → `spawnSync("bash",["-lc",cmd],...)`, consecutive-fail streak + Telegram alert `store/command-task-health.json`-ban.
- Heartbeat minták (LLM prompt-injekció): `memoria-heartbeat` (`*/30 * * * *`), `kanban-audit` (`0 8,12,16,20`).

### 1.4 Hol van a Vault használati minta?
- `src/web/vault.ts`: AES-256-GCM, master key `store/.vault-key` (0600, Linux-on file, macOS-en Keychain), titkok `store/vault.json`-ban (`base64(salt+iv+tag+ciphertext)`). API: `setSecret/getSecret/deleteSecret/listSecrets` (a list CSAK metaadat, sosem érték) + `getSecretsForEnv()` (env-var → vault-id injekció agent-process-be). Kötések: `src/web/vault-bindings.ts`, `src/web/routes/settings.ts`.
- Laza 0600 titok-fájlok `store/`-ban (nem vault-on át): `.dashboard-token`, `.deepseek-key`, `.github-token`, `.posthog-key`, `.google-*`. (`store/.kms-key-ids` a suite-é, a marveen source nem olvassa.)

### 1.5 Hol tartsam a lokális cost configot úgy, hogy update-kor ne törjön?
- **`store/costops-config.json`** (mint `store/autonomy-config.json`). A teljes `store/` gitignore-olt → egy upstream `git pull` SOSEM írja felül vagy törli. Backup + audit automatikus (`scripts/backup.sh`, `store-watcher.ts`). Ugyanaz az olvasási minta: `readFileSync(join(STORE_DIR, 'costops-config.json'))`.
- Ellenpélda: a `.claude/settings.json` skip-worktree (tracked-de-ignorált), ott upstream változásnál lehet konfliktus — a CostOps confignak NE ott legyen a helye. A `store/` a helyes.
- Érzékeny mező (pl. SaaS billing API kulcs live-pullhoz): az ÉRTÉK a **vaultba**, a config CSAK a vault-id referenciát tartalmazza.

### 1.6 Auth
- `src/web/dashboard-auth.ts`: `checkBearerToken()` timing-safe, token `store/.dashboard-token`-ből (`loadOrCreateDashboardToken()`). A gate minden `/api/*`-ra öröklődik (`src/web.ts:132-140`), egy kis public allowlist kivételével. Új `/api/costs/*` automatikusan védett.

### 1.7 Van-e meglévő token/run history, ami usage_events forrás?
- **IGEN — `token_usage` (36 790 sor)** a kész usage_events forrás. Oszlopok: `id, agent, session_id, timestamp(epoch sec), input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, content_preview, tool_name, task_title, project`. Ingesztor: `collectTokenUsage()` `src/web/token-usage.ts:195` (Claude Code JSONL transcriptekből, `INSERT OR IGNORE`, cursor-alapú, óránként `src/web.ts:350-356`). Agg API: `getTokenSummary/Timeline/Details`.
- **KRITIKUS HIÁNY**: nincs `model` oszlop (`token-usage.ts:147-149` csak `message.usage`-öt olvas, `message.model`-t nem). Model nélkül a token→cost árazás nem pontos → a token-cost a v0.2 (model-oszlop ALTER + ingesztor-bővítés).
- Kiegészítő jelek: `task_runs` (2 684 sor, futás-history), `tool_call_log` (0 sor, infra kész), `conversation_log` (1 416, üzenet-volumen), `agent_messages` (5 715, inter-agent volumen).

### 1.8 Provider account ID-k, invoice refek, billing azonosítók hash/ref formában
- A DB-be **soha nem nyers azonosító**: `account_ref = sha256(install_salt || raw)` (első 16 hex byte elég a joinhoz), a nyers érték ha kell a vaultban. `install_salt` a vaultban (`costops.id_salt`) vagy egy `store/.costops-salt` 0600 fájlban. Így az audit/log/API-response csak hash-t lát, korreláció mégis lehetséges.

### 1.9 Kell-e seed default budget/autonomy?
- **NEM v0.1-ben.** A config maradjon teljesen lokális: első futáskor egy `store/costops-config.json.example` jön létre (nem az éles), az operátor tölti ki. Nincs shippelt budget-seed, és **nincs CostOps autonomy-kategória** v0.1-ben (mert nincs autonóm akció — csak megjelenítés). Egy `costops_budget_alert` autonomy-kategória (mint `kanban_archive_done`) majd a v0.2-ben, ha egyáltalán kell jelzés-szint.

---

## 2. Pontos PR1 scope

**BENNE (v0.1 PR1):**
1. 3 új read-mostly tábla `src/db.ts` `initDatabase()`-ben: `cost_sources`, `cost_line_items`, `budgets` (CREATE IF NOT EXISTS + indexek).
2. Lokális config: `store/costops-config.json` betöltő + validáló (`src/costops/config.ts`), kézi/fix költségekhez (Claude Max/Pro, ChatGPT, Aware, GitHub, hosting, domain, SaaS, manual_other) és budget-definíciókhoz.
3. Determinisztikus, tiszta függvények (`src/costops/ledger.ts`): a config kézi-költségeit idempotensen a `cost_line_items`-be írja az aktuális hónapra (upsert), és read-only havi összesítést számol.
4. Read-only API: `GET /api/costs/summary` (`src/web/routes/costs.ts` + 2 sor `src/web.ts`).
5. Unit tesztek in-memory DB-vel (a meglévő `initDatabase(':memory:')` mintával).

**KIMONDOTTAN NINCS BENNE (a döntésed szerint):**
- Nincs model routing, fallback, provider probe, agent leállítás, budget-aware switching.
- Nincs payment / top-up / előfizetés-módosítás / provider hard-stop / agent stop — semmi visszafordíthatatlan vagy kifelé menő autonóm művelet.
- Nincs live provider billing-API pull (a `provider_usage`/`provider_cost`/`invoice_reconciled`/`focus_import` maturity-szintek később).
- Nincs `token_usage.model` migráció és nincs token→cost árazás (v0.2 enrichment). A PR1 a tokent VOLUMENként mutatja (nem forintosítva), külön a fix-költségektől.
- Nincs autonóm budget-akció; a warning/hard threshold CSAK megjelenítés.
- Nincs #517 kód — csak dokumentációs hook (8. szekció).

**Kisebb-biztonságosabb vágás (a te "dashboard tab VAGY API summary" döntésedhez):** a PR1 magja a **backend + `GET /api/costs/summary`** (nulla frontend-kockázat). A Costs-tab (web/index.html + web/app.js, nem fordított) egy triviális, önálló fast-follow PR — nem teszem a v0.1 PR1 kritikus útjába.

---

## 3. Javasolt DB séma (FOCUS-inspirált, determinisztikus)

FOCUS-illesztés: a FOCUS (FinOps Open Cost & Usage Specification) a cloud/AI/SaaS billing normalizálására való; a séma az ő fogalmait veszi át egyszerűsítve (ProviderName, ChargeCategory, ChargePeriodStart/End, ConsumedQuantity/Unit, BilledCost vs EffectiveCost, BillingAccountId).

```sql
-- 3.1 cost_sources: honnan jön a költség (provider / előfizetés / szolgáltatás)
CREATE TABLE IF NOT EXISTS cost_sources (
  id            TEXT PRIMARY KEY,              -- pl. 'anthropic-max', 'openai-chatgpt', 'render-hosting'
  name          TEXT NOT NULL,                 -- ember-olvasható ('Claude Max')
  provider      TEXT NOT NULL,                 -- 'anthropic'|'openai'|'github'|'render'|'namecheap'|'aware'|'other' (FOCUS: ProviderName)
  source_type   TEXT NOT NULL,                 -- 'subscription'|'usage'|'hosting'|'domain'|'saas'|'manual'
  account_ref   TEXT,                          -- HASH-elt billing account id (sosem nyers)
  currency      TEXT NOT NULL DEFAULT 'HUF',
  active        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 3.2 cost_line_items: egy-egy költségsor (becsült vagy providerből jött) - FOCUS ChargeRow
CREATE TABLE IF NOT EXISTS cost_line_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id           TEXT NOT NULL REFERENCES cost_sources(id),
  charge_period_start INTEGER NOT NULL,        -- epoch sec (FOCUS ChargePeriodStart)
  charge_period_end   INTEGER NOT NULL,        -- epoch sec (FOCUS ChargePeriodEnd)
  charge_category     TEXT NOT NULL,           -- 'usage'|'subscription'|'purchase'|'tax'|'credit'|'adjustment'
  service_name        TEXT,                    -- 'Claude Opus', 'Render web', 'Domain renewal'
  usage_type          TEXT,                    -- NULLABLE v0.1; később: input_tokens|output_tokens|... (7. szekció táblázat)
  consumed_quantity   REAL,                    -- NULLABLE v0.1 (FOCUS ConsumedQuantity)
  consumed_unit       TEXT,                    -- 'tokens'|'minutes'|'gb-days'|'calls'|'month'
  billed_cost         REAL NOT NULL,           -- amit fizetsz/becsülsz (FOCUS BilledCost)
  effective_cost      REAL,                    -- amortizált, ha van (FOCUS EffectiveCost); v0.1 = NULL
  currency            TEXT NOT NULL DEFAULT 'HUF',
  confidence          TEXT NOT NULL,           -- 'actual_invoice'|'provider_api'|'billing_export'|'local_usage'|'estimate'|'manual'
  data_freshness      INTEGER NOT NULL,        -- epoch sec: az alap-adat "as of" ideje (provider cost nem real-time!)
  source_ref          TEXT,                    -- HASH-elt invoice/usage referencia
  dedup_key           TEXT UNIQUE,             -- pl. source_id|period|service|usage_type -> idempotens upsert
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cli_period ON cost_line_items(charge_period_start, charge_period_end);
CREATE INDEX IF NOT EXISTS idx_cli_source ON cost_line_items(source_id);

-- 3.3 budgets: csak jelzés (v0.1 display-only)
CREATE TABLE IF NOT EXISTS budgets (
  id                  TEXT PRIMARY KEY,        -- 'global-monthly', 'anthropic-monthly'
  name                TEXT NOT NULL,
  scope               TEXT NOT NULL,           -- 'global'|'source'|'provider'|'product'|'agent'
  scope_ref           TEXT,                    -- a scope célja (source_id / provider / product)
  period              TEXT NOT NULL DEFAULT 'monthly',
  amount              REAL NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'HUF',
  warning_threshold   REAL NOT NULL DEFAULT 0.8,  -- 80%
  hard_threshold      REAL NOT NULL DEFAULT 1.0,  -- 100% (v0.1: CSAK megjelenítés, action nélkül)
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
```

- **`confidence` és `data_freshness`** minden line itemen (a kérésed szerint): `confidence` = adat-forrás megbízhatóság enumja (sorrend: actual_invoice > provider_api > billing_export > local_usage > estimate > manual); `data_freshness` = az alapadat kelte (mert a provider-cost nem real-time, csak figyelmeztetünk, nem állítunk le).
- **usage_events**: NEM hozunk létre új táblát v0.1-ben — a meglévő `token_usage` (36 790 sor) a usage_events forrás; a `cost_line_items` később ebből derivál (v0.2, model-oszlop után). A `usage_type` oszlop most nullable, a 7. szekció bővítéséhez előkészítve.
- **invoice_artifacts**: out of scope v0.1-ben (a te opciód szerint), a `source_ref` hash-mező elég a későbbi egyeztetés-hookhoz.

---

## 4. Javasolt API végpontok (mind read-only, GET)

Egyetlen új modul `src/web/routes/costs.ts` (`tryHandleCosts`), Bearer-védett:

- `GET /api/costs/summary?month=YYYY-MM` (default: aktuális hó) →
  ```json
  {
    "month": "2026-07",
    "currency": "HUF",
    "current_spend": 48250,
    "forecast_month_end": 51900,
    "budget": { "amount": 60000, "used_pct": 0.80, "status": "warning" },
    "top_sources": [{ "source_id": "anthropic-max", "name": "Claude Max", "spend": 22000 }],
    "confidence_breakdown": { "actual_invoice": 0, "manual": 45000, "estimate": 3250 },
    "breakdown": { "unreconciled": 0, "manual": 45000, "provider_estimate": 3250 },
    "usage_volume": { "input_tokens": 4200000, "output_tokens": 31000000, "note": "not priced in v0.1 (no model column)" },
    "generated_at": 1783177237
  }
  ```
- `GET /api/costs/sources` → cost_sources lista (aktív).
- `GET /api/costs/budgets` → budgets lista + aktuális used_pct + status (ok/warning/hard) — CSAK számított jelzés.
- (Opcionális) `GET /api/costs/line-items?month=YYYY-MM` → nyers sorok (debughoz).

Minden aggregáció determinisztikus SQL + tiszta TS függvény (a `token-usage.ts:261 getTokenSummary` mintájára). Írás NINCS az API-n (a line-item upsertet a collector/config-loader végzi, nem HTTP request).

---

## 5. Javasolt dashboard minimál nézet

A frontend NEM fordított (`web/index.html` + `web/app.js` közvetlenül, nincs build) → alacsony kockázat, de akkor is külön, kisebb PR2-nek javaslom (a PR1 magja backend). A minimál Costs-tab:
1. `web/index.html`: egy `<a class="sb-link" data-page="costs">Költségek</a>` nav-link (klón az "ideas" blokkból, `index.html:135-138`) + egy `<div class="page" id="costsPage" hidden>` konténer (klón `tokenUsagePage`, `index.html:1266`).
2. `web/app.js`: egy sor a `switchPage`-be (`app.js:288` mellé): `if (pageId === 'costs') loadCosts()` + egy `async function loadCosts()` ami `fetch('/api/costs/summary')`-ot renderel (minta: `loadTokenUsage`). Az auth a globális fetch-wrapper miatt (`app.js:97-114`) automatikus.

Nézet-tartalom: aktuális hó spend, forecast, budget %-sáv (zöld/sárga/piros — CSAK szín, semmi akció), top források, confidence-bontás, "manuális vs provider-estimate vs unreconciled" sáv, alul a token-VOLUMEN (nem forintosítva, "v0.2: model-alapú árazás" jelöléssel).

---

## 6. Lokális config / Vault szabály

- **Config helye**: `store/costops-config.json` (gitignore-olt `store/` → update-safe; backup + audit automatikus). Első futáskor `store/costops-config.json.example` generálódik, az operátor tölti.
- **Config alak** (kézi/fix költségek + budgetek, semmi titok):
  ```json
  {
    "version": 1,
    "currency": "HUF",
    "fixed_costs": [
      { "source_id": "anthropic-max", "name": "Claude Max", "provider": "anthropic", "source_type": "subscription", "amount": 22000, "period": "monthly", "charge_category": "subscription", "confidence": "manual" },
      { "source_id": "openai-chatgpt", "name": "ChatGPT Plus", "provider": "openai", "source_type": "subscription", "amount": 8000, "period": "monthly", "confidence": "manual" },
      { "source_id": "render-hosting", "name": "Render hosting", "provider": "render", "source_type": "hosting", "amount": 12000, "period": "monthly", "confidence": "manual" }
    ],
    "budgets": [
      { "id": "global-monthly", "scope": "global", "amount": 60000, "warning_threshold": 0.8, "hard_threshold": 1.0 }
    ]
  }
  ```
- **Vault szabály (kötelező)**: billing/admin API-kulcsok és provider-tokenek CSAK a vaultban (`src/web/vault.ts` / `store/vault.json`), a configban legfeljebb egy `secret_ref` vault-id. Git-be, transcriptbe, logba, audit-fájlba, dashboard-response-ba nyers titok SOHA. A summary API csak aggregált forintot/tokent ad vissza, azonosítót csak hash-elve.

---

## 7. Security guardrails

1. **Read-only kifelé**: az API kizárólag GET; írni csak a lokális collector/config-loader ír a DB-be (nem HTTP-ből).
2. **Nincs autonóm visszafordíthatatlan/kifelé menő művelet**: se payment, top-up, előfizetés-módosítás, provider hard-stop, agent stop, budget-aware switching. A hard_threshold v0.1-ben CSAK szín/jelzés.
3. **Titkok csak vaultban**; nyers secret sehol (git/log/transcript/audit/dashboard-response). A meglévő `sanitize.ts` / `store-watcher.ts` SENSITIVE_NAMES mechanizmus érvényes.
4. **Azonosító-hash**: provider account id / invoice ref / billing id csak `sha256(install_salt || raw)` formában a DB-ben; nyers érték ha kell, vaultban.
5. **Determinisztikus collector**: `type:"command"` scheduled task (raw shell/python, nulla LLM-token), nem folyton futó LLM-monitor. Fail-streak Telegram-alert a meglévő `command-task.ts` mintával.
6. **Idempotencia**: a séma `CREATE TABLE IF NOT EXISTS`, a line-item írás `dedup_key`-re upsert → többszöri futás nem duplikál, upstream-installon nem tör.
7. **Confidence-kényszer**: minden becslés `confidence`+`data_freshness`-szel jelölt; a provider-cost nem-real-time voltát a UI kimondja.

---

## 8. #517 future hook (CSAK dokumentáció, most NE implementáld)

- Testvér-doksi: `audits/upstream-capacity-aware-model-routing-design.md`. Ott a `capacityState = available|degraded|limited|blocked|unknown` és `confidence = observed|inferred|manual|unknown` (§5.4-5.5).
- **CostOps v0.2** adhat majd budget/cost jeleket a #517 capacity-layernek `reasonCode` formában:
  - spend ≥ `warning_threshold` → `reasonCode: "budget_near_limit"` → a capacity-layer ezt `capacityState: "limited"` irányba súlyozhatja;
  - spend ≥ `hard_threshold` → `reasonCode: "budget_hard_limit"` → `capacityState: "blocked"` jelöltként — **de** a hard-stop a #517 safety-szabálya szerint sem autonóm; a jel advisory, a döntés a capacity-layeré, operator-approvallal.
  - a CostOps `confidence` (adat-forrás) → #517 `confidence` (jel-megbízhatóság) fordítás: actual_invoice/provider_api → `observed`; billing_export/local_usage → `inferred`; estimate → `inferred`(low); manual → `manual`.
- v0.1-ben ebből SEMMI kód — csak a `reasonCode` enum és e mapping dokumentálva, hogy a #517 majd ráköthessen.

---

## 9. Provider adapter maturity modell (későbbre)

Forrásonként külön érik, a `confidence` ezt tükrözi:

| Szint | Jelentés | confidence | CostOps verzió |
|---|---|---|---|
| `manual_only` | operátor kézzel adja a fix költséget | manual | **v0.1** |
| `usage_estimate` | lokális usage (token_usage) × ártábla becslés | estimate/local_usage | v0.2 (model-oszlop után) |
| `provider_usage` | provider usage-API (mennyiség, nem $) | provider_api | v0.2+ |
| `provider_cost` | provider cost/billing-API ($) | provider_api | v0.3 |
| `invoice_reconciled` | tényleges számlához egyeztetve | actual_invoice | v0.3+ |
| `focus_import` | FOCUS-konform billing export beolvasva | billing_export/actual_invoice | v0.4 |

---

## 10. Fájllista, amit módosítani KELLENE (PR1)

SOURCE (jóváhagyásod után, `npm run build` szükséges):
- `src/db.ts` — 3 `CREATE TABLE IF NOT EXISTS` blokk (+ indexek) az `initDatabase()`-be. (kb. 40 sor)
- `src/costops/config.ts` — ÚJ: `store/costops-config.json` betöltő + validáló + `.example` generátor.
- `src/costops/ledger.ts` — ÚJ: determinisztikus tiszta függvények (config→cost_line_items upsert; `getCostSummary(month)`; budget-status; hash-ref helper). Nulla I/O a tesztelhető magban.
- `src/web/routes/costs.ts` — ÚJ: `tryHandleCosts` (GET summary/sources/budgets).
- `src/web.ts` — 2 sor: import + egy dispatch sor a chainbe.
- `src/costops/ledger.test.ts` (+ `config.test.ts`) — ÚJ tesztek.

NEM source (biztonságos, nem igényel build/jóváhagyást a source-értelemben):
- `store/costops-config.json` (+ `.example`) — lokális, gitignore-olt config.
- `~/.claude/scheduled-tasks/costops-collector/{task-config.json,check.py}` — determinisztikus `command`-task a periodikus frissítéshez (opcionális a PR1-ben; a config→ledger upsert kézzel is hívható egyszer).

Frontend (külön, kisebb PR2, nincs build):
- `web/index.html` (nav-link + page-div), `web/app.js` (`switchPage` sor + `loadCosts()`).

---

## 11. Tesztterv

A meglévő minta: in-memory DB `initDatabase(':memory:')`, tiszta függvények unit-teszttel (Node test runner / a repo bevett tesztkerete).
1. **Schema smoke**: `initDatabase(':memory:')` létrehozza a 3 táblát + indexeket, idempotens (kétszeri init nem hibázik).
2. **Config parse/validate**: jó config betöltése; hibás (hiányzó amount, ismeretlen source_type) elutasítása; `.example` generálás üres állapotban.
3. **Ledger upsert idempotencia**: ugyanaz a hó kétszer futtatva → nincs duplikátum (`dedup_key`), az összeg stabil.
4. **Summary aggregáció** (determinisztikus fixture sorokból): current_spend, top_sources sorrend, confidence_breakdown, manual/estimate/unreconciled bontás — kézzel levezetett golden értékek ellen (nem LLM-mel becsülve, futtatva).
5. **Forecast**: hó eleji részleges költségből lineáris hó-végi becslés (naive proration) — pontos golden.
6. **Budget-status klasszifikáció**: used_pct < warning → ok; ≥ warning → warning; ≥ hard → hard (határérték-tesztek 0.799/0.8/0.999/1.0).
7. **Hash-ref**: `account_ref` determinisztikus és NEM visszafejthető; azonos raw → azonos hash, más salt → más hash.
8. **API summary**: `GET /api/costs/summary` Bearer nélkül 401; Bearerrel a summary-JSON alakja stabil; nyers titok/azonosító nincs a válaszban.
9. **Determinizmus-garancia**: a summary/forecast nem hív LLM-et, nincs `Date.now()`-függő nem-tesztelhető ág (a "most" injektálható paraméter).

---

## 12. Kockázatok

- **token_usage.model hiánya** → v0.1-ben a token nem forintosítható pontosan. Mitigáció: v0.1 a tokent VOLUMENként mutatja (nem cost), a fix-költségektől külön; a model-oszlop + árazás explicit v0.2. (Alacsony kockázat, tudatos scope-vágás.)
- **`src/db.ts` minden startupkor fut** → a séma-blokknak KÖTELEZŐEN idempotensnek (IF NOT EXISTS) kell lennie, különben egy meglévő installon tör. Mitigáció: a bevett idióma pontos követése + smoke-teszt.
- **Forecast naivitás** (lineáris proration) félrevezethet → confidence/`estimate` jelölés + UI-disclaimer.
- **Provider-cost nem real-time** → `data_freshness` mező + "csak figyelmeztet, nem állít le" elv (a te szabályod).
- **Secret-szivárgás** a legnagyobb tétel → vault-only + hash-ref + a meglévő sanitize/store-watcher; a summary sose adjon vissza nyers azonosítót.
- **Scope-kúszás** (valaki budget-aware switchinget kérne) → a guardrails (7. szekció) explicit tiltja v0.1-ben.
- **Upstream-divergencia**: a source-módosítás (`src/db.ts`, `src/web.ts`) a hivatalos marveen fájlokat érinti → ha upstream-be szánjuk, PR-ként (mint a capacity-aware doksi), nem lokális fork-patchként; a `store/costops-config.json` lokális marad (gitignore).

---

## 13. Javasolt következő lépés

1. **Jóváhagyásodra várok a source-módosításhoz** (a spec szerint addig nem nyúlok forráshoz).
2. Ha GO: PR1 = a 10. szekció SOURCE-listája, backend-only (séma + config + ledger + `GET /api/costs/summary` + tesztek), egyetlen commit, `npm run build` + tesztek zöld, majd upstream-kompatibilis PR-ként (Szotasz/marveen) VAGY lokális branch — ahogy döntöd.
3. A Costs-tab (frontend) és a determinisztikus `command`-collector külön, kis fast-follow PR.
4. v0.2 külön döntés: `token_usage.model` enrichment → token→cost árazás → `usage_estimate` maturity → #517 reasonCode-hook.

---

## Záró ellenőrzés (a kérésed szerint)

- **Módosítottál-e source fájlt?** NEM. Egyetlen `src/`, `web/`, `dist/` vagy más forrás/kód fájlt sem érintettem. Csak elemeztem (read-only) és egy dokumentumot írtam.
- **Van-e git diff?** A tracked forrásban NINCS. Az egyetlen új fájl ez a terv az `audits/` alatt, ami **untracked** (a session eleji `git status` is `?? audits/`-ként mutatja) — nem tracked source, nem generál diffet a kódban.
- **Pontosan milyen fájlt hoztál létre?** `audits/costops-v0.1-pr1-local-ledger-plan.md` (ez a fájl).
- **Javaslod-e a PR1 implementációt?** IGEN. A PR1 kicsi, izolált, read-only, determinisztikus, idempotens, és a meglévő mintákra ül (token_usage, command-task, vault, store-config). Javaslom a backend-only vágást elsőként. Source-módosítást a külön jóváhagyásodra kezdek.
