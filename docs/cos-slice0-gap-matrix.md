# COS Slice 0 — Repo-audit + Capability-to-Requirement gap-mátrix

**Projekt:** Personal Chief of Staff (v4.2.1) | **Slice:** 0 (WP0) | **Dátum:** 2026-08-04
**Ág:** `develop` (élő, ellenőrzött) | **Módszer:** minden állítás a MI `develop` águnkon verifikálva, NEM a spec állítása alapján.

> Ez a spec által kötelezővé tett gate-artifact: fejlesztés nem indul, amíg a gap-mátrix nincs kész.

---

## 1. A spec névleg hivatkozott elemeinek verifikációja (§30)

| Hivatkozás | Állapot a mi develop-unkon |
|---|---|
| docs/agent-fleet.md, heartbeat-autonomy.md, scheduled-tasks.md, background-tasks.md, memory-system.md, kanban.md, skill-factory.md, vault.md, connectors-hu.md, conversation-continuity.md | **MIND EXISTS** (10/10) |
| src/tool-timeouts.ts (per-tool deadline, #560/#561) | **EXISTS** (google-calendar/telegram/github/slack/ollama fedve; Gmail-send/Drive-write NINCS -> PARTIAL coverage) |
| model-profile routing (#517) | **PARTIAL**: `model-profiles.ts`, `model-fallback.ts`, `capacity-routing.ts` létezik; a dinamikus sensitivity-routing nyitott (a COS statikus policyt használ) |

Egy hivatkozott repo-elem sem bizonyult hamisnak — a spec repo-baseline-je valós.

---

## 2. Connector write capability audit (§20 — a hipotézis MOST tény)

**A Google MCP-szerverek (google-private-mcp.py, google-zst-mcp.py) IGAZOLTAN READ-ONLY.** Scope: `gmail.readonly + calendar.readonly + drive.readonly`. Nincs send/draft/label-write/calendar-create/drive-upload függvény.

**Következmény:** a Slice 1 (ajánlatkérő küldés) Gmail-WRITE-ot igényel -> az MCP-szervert ki kell egészíteni write-scope-okkal + Istvan böngészős consentje (MÁR jóváhagyva). Addig a rendszer `OBSERVE`/`PREPARE`. Ez a v4.2.1 §19 audit-first állítását igazolja.

**Kifli:** nincs integráció; a Slice 0 discovery külön feladata (API/MCP/izolált browser). Addig csak bevásárlólista.

---

## 3. Capability-to-requirement gap-mátrix

| # | v4.2.1 követelmény | Státusz | Bizonyíték / meglévő alap | Slice |
|---|---|---|---|---|
| 1 | Mission Control dashboard (bővítés) | EXISTS | src/web/, web.ts | 0/5 |
| 2 | Kanban mint feladatnézet (`case_id`) | EXISTS | kanban_cards/+events/+labels/+comments | 0 |
| 3 | Scheduler + preCheck (case-wake, gmail-delta, reconcile) | EXISTS | scheduled_tasks, heartbeat.ts | 5 |
| 4 | Retry queue + auto-start | EXISTS | pending_task_retries, pending-retries.ts | 5 |
| 5 | Memória hot/warm/cold/shared + FTS+vektor | EXISTS | memories, memories_fts | - |
| 6 | Vault (credential) | EXISTS | src/web/vault.ts | 1/3 |
| 7 | Skill Factory (szigorúbb kapu) | PARTIAL | skill_usage; permission-metadata hiányzik | 4/5 |
| 8 | Per-tool deadline (connector reliability) | PARTIAL | tool-timeouts.ts; Gmail-send/Drive-write coverage hiányzik | 1 |
| 9 | Autonómia-config (Personal kategóriák) | PARTIAL | autonomy-config + approvals; per-action/kampány hiányzik | 1 |
| 10 | Approval objektum | PARTIAL | `approvals` tábla (per-action); campaign/template/rendered/reply-policy/version hiányzik | 1 |
| 11 | **Data-sensitivity statikus policy + fail-closed (P0.6)** | **PARTIAL (erős alap!)** | `data-sensitivity-gate.ts` MÁR: public/internal/restricted, unknown->restricted fail-safe, observe/enforce, `sensitivity_audit_log`. Kell: 4. tier (SENSITIVE_PERSONAL/HIGHLY_SENSITIVE finomítás) + model-profile allowlist wiring | 0 |
| 12 | Prompt-injection / untrusted-data védelem (§10) | PARTIAL | `prompt-safety.ts` | 0/1 |
| 13 | Personal Case Engine (personal_cases + version + state machine) | MISSING | — | 0 |
| 14 | personal_case_events (append-only) | MISSING | — | 0 |
| 15 | case_claims (atomikus + fencing token) | MISSING | — | 0 |
| 16 | campaigns + campaign_approvals (+lifecycle, revoke) | MISSING | — | 1 |
| 17 | outbound_ledger (SENDING-flow, DB UNIQUE, states) | MISSING | — | 1 |
| 18 | email_processing + batches + source_checkpoints (P0.1/P0.2) | MISSING | — | 1 |
| 19 | attachments (checksum/readback) | MISSING | — | 1 |
| 20 | connector_health mátrix | MISSING | — | 1/5 |
| 21 | Action Executor (egyetlen külső író) | MISSING | — | 1 |
| 22 | Gmail WRITE adapter + kereshető idempotencia-marker | MISSING (consent jóváhagyva) | MCP read-only -> write-scope + consent kell | 1 |
| 23 | Shopping adapter (API/MCP/browser) + Kifli | MISSING (discovery) | — | 0(disc)/3 |
| 24 | shopping_radar_items/offers/checks/status_events | MISSING | — | 4 |
| 25 | Inter-agent bus (kontextus, delegálás) | EXISTS | agent_messages | - |

**Összegzés:** EXISTS 8, PARTIAL 5, MISSING 12. A biztonsági/sensitivity réteg jobb állapotban van a vártnál (a P0.6 fail-closed lényegében kész); a COS-core (cases, campaigns, ledgerek, Action Executor) a tényleges új építés.

---

## 4. Kulcs-leletek

1. **A P0.6 statikus data-sensitivity nagyrészt MÁR MEGVAN.** A `data-sensitivity-gate.ts` pontosan a review-kérte dizájn (task/content-alapú osztályozás, fail-safe unknown->restricted, observe/enforce mód, audit-log). A COS-nak csak a 4-tieres finomítást + a model-profile allowlist bekötést kell hozzáadnia — nem nulláról épül.
2. **A Gmail-write az egyetlen kemény külső előfeltétel**, és igazoltan hiányzik (MCP read-only). Istvan jóváhagyta a consentet -> a Slice 1 elején kell a write-scope + böngészős consent.
3. **Az approval-alap létezik** (per-action `approvals` tábla + Telegram-integráció), de a kampány-szintű, verziózott, template+rendered-payload approval új.
4. **A COS-core 12 új tábla + az Action Executor** a tényleges fejlesztési súly; ezek tiszta zöldmezős munkák, nem ütköznek meglévővel.

---

## 5. Következő Slice 0 lépések (ebben a szeletben, külső jog nélkül)
- [ ] `personal_cases`(+version) + `personal_case_events` + `case_claims`(+fence) migráció + state machine + domain-command réteg (optimista concurrency, tranzakciós határ).
- [ ] Statikus data-sensitivity policy KITERJESZTÉSE a meglévő gate-re (4 tier + allowlist), enforce a COS-scope-ban.
- [ ] Kifli capability discovery (API/MCP/browser eldöntése).
- [ ] Mission Control "Ma" + "Ügyek" olvasó nézet.
- [ ] Az összes DB UNIQUE constraint (P0.3) a séma-migrációba.

## 6. Slice 1 előfeltételek (a következő szeletig Istvantól/tesztből)
- Gmail write-scope + böngészős consent (jóváhagyva).
- Adapter-contract + marker-persistence teszt (P1.3): bizonyítani hogy az `X-Marveen-Idempotency-Key` visszaolvasható a Sentből, KÜLÖNBEN a Gmail `EXECUTE` nem aktiválható.

---

*Slice 0 gate-artifact. A repo-baseline valós, a biztonsági réteg erősebb a vártnál, a COS-core tiszta zöldmező. Nincs blokkoló ellentmondás — a séma-migráció indulhat.*
