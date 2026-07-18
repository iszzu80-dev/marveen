# CostOps + v1.19.0 integrációs checkpoint

**Dátum:** 2026-07-05 20:38 CEST
**Készítette:** Marveen
**Cél:** stabil, lokális safety-checkpoint az elfogadott CostOps (v0.1–v0.5) + upstream v1.19.0 integrációs állapotról. Nincs push, nincs PR, nincs provider-oldali módosítás.

---

## 1. Upstream base

- **Tag:** `v1.19.0`
- **Commit:** `c396514` — `chore(release): v1.19.0 -- SSH Vault (#521), owner-gated terminal-input toggle (#522), Messages BOT_NAME fix (#520), kanban card-event audit trail (#518)`
- **origin/main == main == c396514** (a checkpoint pillanatában szinkronban)

## 2. Merge commit

- **Merge commit:** `e7d5502` — `Merge branch 'main' into feat/costops-ledger-token-estimates`
- **Szülők:** `6789f9c` (CostOps feature-ág HEAD) + `c396514` (v1.19.0 main)
- **HEAD:** `e7d5502` a `feat/costops-ledger-token-estimates` ágon

## 3. CostOps commitok (v0.1 → v0.5)

| Commit | Verzió | Leírás |
|--------|--------|--------|
| `c93060d` | v0.1 | local ledger and token estimates |
| `bb0206f` | v0.2 | provider collector framework |
| `5896a3c` | v0.3 | offline dry-run mode for provider collectors |
| `15d8d7a` | v0.4a | Render plan-based infra cost collector |
| `0768dc5` | v0.4 | provider-preferred operational spend |
| `6789f9c` | v0.5 | API sync spine — Render sync endpoint + freshness/sync-state |
| `e7d5502` | merge | main (v1.19.0) beolvasztva a CostOps ágba |

## 4. Konfliktus és feloldás

- **Konfliktusos fájl:** `src/db.ts` (egyetlen fájl — a merge commit üzenete is `# Conflicts: src/db.ts`).
- **Ok:** a v1.19.0 SSH Vault + kanban audit-trail sémabővítései és a CostOps ledger/collector sémái ugyanabban a `db.ts` migrációs/schema szekcióban módosítottak.
- **Feloldás:** mindkét oldal sémabővítései megtartva (union), nem drop/felülírás — a v1.19.0 vault/kanban táblák ÉS a CostOps ledger/sync-state táblák egyaránt jelen vannak. A merge utáni `src/db.ts` +188 sort tartalmaz a main oldalról, a CostOps oldali séma sértetlen.
- Más fájlban NEM volt konfliktus (web.ts, web/app.js, index.html az upstream oldalon tisztán olvadt).

## 5. Build / test / smoke

> Az alábbiak az Istvan által elfogadott checkpoint-állapotot rögzítik (a session-ben nem lettek újrafuttatva — ez dokumentációs checkpoint, nem re-verifikáció).

- **Build:** zöld
- **Tesztek:** 66/66 zöld
- **CostOps smoke:** zöld
- **v1.19.0 smoke:** zöld
- **Mission Control:** active

CostOps teszt-lefedettség a diff alapján (élő tesztfájlok a HEAD-en):
`costops-api`, `costops-collectors`, `costops-collectors-dryrun`, `costops-ledger`, `costops-operational`, `costops-pricing`, `costops-render`, `costops-sync` (8 CostOps teszt-suite).

## 6. CostOps aktuális operational_spend (élő API — `/api/costs/summary`)

- **Hónap:** 2026-07, pénznem: HUF
- **operational_spend:** **153 004 HUF**
- **operational_forecast_month_end:** 153 004 HUF
- **manual_spend:** 158 444 HUF
- **provider_derived_spend:** 34 560 HUF
- **manual vs provider variancia:** −5 440 HUF

Provider bontás:
| Provider | Spend (HUF) | Confidence |
|----------|-------------|------------|
| anthropic | 67 004 | manual |
| render | 34 560 | provider_plan_estimate |
| other | 27 000 | estimate |
| deepseek | 15 450 | estimate |
| openai | 8 990 | manual |
| github | 0 | manual |
| google / vercel / cloudflare | 0 | estimate |

Confidence-összesítés: manual 58 339 / estimate 60 105 / provider_plan_estimate 34 560.

## 7. Render sync timer állapota

- **Sync spine (v0.5):** élő. Végpont: `POST /api/costs/sync` (API-triggerelt), read-only Render plan-collector.
- **Bizonyíték hogy lefutott:** a `render` provider-derived spend **34 560 HUF** `provider_plan_estimate` confidence-szel jelen van a summary-ban (nem placeholder/estimate) — a Render plan-alapú collector sikeresen szinkronizált.
- **data_freshness:** friss (a summary-lekérés pillanatában recompute-olt, 2026-07-05 20:37 CEST).
- **Megjegyzés:** nincs külön háttér-`setInterval` a fő szolgáltatásban a CostOps sync-hez — a v0.5 spine API-triggerelt (freshness/sync-state a ledgerben perzisztálva). Ez szándékos a jelenlegi verzióban.

## 8. v1.19.0 funkciók smoke-ja

Elfogadott állapot (upstream release funkciók, a merge után jelen):
- **SSH Vault (#521):** vault-ssh + vault-ssh-keys route-ok mergelve (`docs/vault.md`, `src/web/routes/vault-ssh*.ts`).
- **Owner-gated terminal-input toggle (#522):** `terminal-input-store.ts` + agent-terminal route, per-call audit.
- **Messages BOT_NAME fix (#520):** fő agent BOT_NAME helyes megjelenítése.
- **Kanban card-event audit trail (#518):** `kanban-move-audit.test.ts` + kanban route audit.

## 9. Ismert lokális-only elemek

Nem trackelt / lokális-only munkakönyvtár-tartalom (git status --short):
```
?? audits/                                  (ez a checkpoint mappa)
?? scripts/inter-agent-evidence-gate.py
?? scripts/inter-agent-evidence-gate.sh
?? scripts/stale-instructions-detect.sh
?? scripts/stale-instructions-guard.sh
?? shared-dev/
```
Ezek untracked helper-ek / audit-artifactok, nem részei a CostOps commit-stacknek.

## 10. Biztonsági megerősítések

- **Nincs push.** A `feat/costops-ledger-token-estimates` és a `backup/costops-v1.19.0-integrated` csak lokális.
- **Nincs PR.**
- **Nincs provider / DNS / Render-oldali módosítás.** A Render collector kizárólag read-only plan-lekérdezés.
- **Nincs trackelt secret / account / service-ID / cost-invoice adat** a commit-stackben — a collectorok sanitized breakdown-t adnak (service_count, plan-tier), nem nyers számla/ID-adatot. A CostOps számértékek a runtime SQLite-ban élnek, nem a repóban.
- A `collectors-config.example.json` és `render-pricing.example.json` csak példa-sablonok, valós kulcs nélkül.

## 11. Javasolt következő lépés

1. **Hagyd a jelenlegi állapotot pihenni** stabil checkpointként (backup branch + ez a doksi biztosítja a visszaállást).
2. Amikor Istvan élesíteni akarja: **külön PR** a `feat/costops-ledger-token-estimates` → `develop`/`main` irányba, `src/db.ts` merge-feloldás review-jával.
3. Push előtt: `.dashboard-token` és bármely runtime store fájl gitignore-ellenőrzése (jelenleg nem trackelt — rendben).
4. Opcionális: a CostOps sync-hez háttér-`setInterval` (napi/óránkénti auto-sync) hozzáadása külön kártyán, ha az API-triggerelt spine helyett automatizált freshness kell.

---

*Checkpoint artifactok: `audits/costops-v1.19.0-checkpoint/git-log.txt`, `git-status.txt`, `diff-stat.txt`.*
