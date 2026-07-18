# CostOps v0.1 -- activation note

The build (`dist/`) is already compiled. Activation = one Mission Control restart.
No real cost data goes in any tracked file; amounts live in the gitignored
`store/costops-config.json`.

## 1. Restart Mission Control (one time, to load the new route + tables)

The dashboard runs under a **systemd user service** (`marveen-dashboard.service`,
serving port 3420). Restart ONLY that service -- atomic stop->start, no duplicate
process, no port conflict:

```bash
systemctl --user restart marveen-dashboard
```

Do NOT use `scripts/start.sh` / `scripts/stop.sh` here -- those also touch the
separate `marveen-channels` service (the fleet's channel process), which we must
leave alone. `systemctl --user restart marveen-dashboard` restarts the dashboard
ONLY; `marveen-channels` and the fleet agents are untouched.

On boot, `initDatabase()` creates the 3 CostOps tables (idempotent) and the
`/api/costs/*` routes + "Költségek" tab go live.

## 2. Verify the API is live

```bash
cd ~/marveen
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  http://localhost:3420/api/costs/summary | head -c 400
```
Expect HTTP 200 JSON with `month`, `current_spend`, `forecast_month_end`,
`budget`, `top_sources`, `confidence_breakdown`, `breakdown`, `token_usage`.

## 3. Verify the Költségek tab

Open http://localhost:3420 and click **Költségek** in the sidebar. You should see
month spend, forecast, budget bar, top sources, confidence breakdown, and token
activity (volume only). With placeholder amounts (0) everything reads 0 until you
fill in real values.

## 4. Edit the config (real fixed costs)

Edit `store/costops-config.json` (gitignored, local-only). Fields:

- `fixed_costs[]`:
  - `source_id` -- stable id (e.g. `anthropic-max`)
  - `name` -- display name (e.g. `Claude Max`)
  - `provider` -- `anthropic` | `openai` | `github` | `render` | `other`
  - `source_type` -- `subscription` | `hosting` | `domain` | `saas` | `manual`
  - `amount` -- **per-month** cost in `currency`
  - `confidence` -- keep `manual` for hand-entered costs
- `budgets[]`:
  - `id` -- keep `global-monthly` for the main budget
  - `amount` -- monthly budget cap
  - `warning_threshold` / `hard_threshold` -- fractions (0.8 / 1.0). Display-only.

Never put an API key / secret / billing account id here -- those belong in the
Vault. This file stays local (gitignored).

## 5. Refresh WITHOUT restart

After a one-time restart, config edits need **no** further restart: the summary
endpoint re-reads `store/costops-config.json` on every request. Just re-open (or
reload) the Költségek tab -- `loadCosts()` re-fetches `/api/costs/summary`, which
re-reads the config and reconciles it into the ledger. New amounts show
immediately.

## Safe copy-paste config skeleton (placeholder / 0 amounts, no real data)

```json
{
  "version": 1,
  "currency": "HUF",
  "fixed_costs": [
    { "source_id": "anthropic-max", "name": "Claude Max", "provider": "anthropic", "source_type": "subscription", "amount": 0, "period": "monthly", "confidence": "manual" },
    { "source_id": "openai-chatgpt", "name": "ChatGPT", "provider": "openai", "source_type": "subscription", "amount": 0, "period": "monthly", "confidence": "manual" },
    { "source_id": "github", "name": "GitHub", "provider": "github", "source_type": "saas", "amount": 0, "period": "monthly", "confidence": "manual" },
    { "source_id": "render-hosting", "name": "Render hosting", "provider": "render", "source_type": "hosting", "amount": 0, "period": "monthly", "confidence": "manual" },
    { "source_id": "domain", "name": "Domain", "provider": "other", "source_type": "domain", "amount": 0, "period": "monthly", "confidence": "manual" }
  ],
  "budgets": [
    { "id": "global-monthly", "name": "Global monthly", "scope": "global", "amount": 0, "warning_threshold": 0.8, "hard_threshold": 1.0 }
  ]
}
```
(This is exactly what `store/costops-config.json.example` contains.)
