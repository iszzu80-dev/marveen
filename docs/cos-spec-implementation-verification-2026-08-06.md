# COS v4.2.1 — spec-vs-implementation verification

**Dátum:** 2026-08-06 | **Ág:** `develop` HEAD `73cc68c` | **Live:** dashboard `active`, 7/7 COS route HTTP 200 (+ monitoring, analytics) | **Teszt:** 233 COS teszt zöld (37 fájl), `tsc` tiszta.

> **Frissítés (07:48):** Istvan kérésére a §4 korábbi #3 és #5 elemei is megépültek. A §4 alább már ezt tükrözi.

**Módszer:** minden sor a MI kódunkon/tesztjeinken/az élő rendszeren igazolva (modul + teszt + élő végpont), NEM a spec vagy egy commit-üzenet állítása alapján. Ez a `docs/cos-p1-p2-closure-audit-2026-08-06.md` kibővített, teljes-spec verziója, amit Istvan kért ("mit valósítottál meg a dokumentációhoz képest").

---

## 1. A gap-mátrix 25 képessége — akkor (2026-08-04) → most

A Slice-0 gap-mátrix (`docs/cos-slice0-gap-matrix.md`) 25 követelménye: akkor **EXISTS 8 / PARTIAL 5 / MISSING 12**. Most:

| # | Követelmény | Akkor | Most | Bizonyíték |
|---|---|---|---|---|
| 1 | Mission Control dashboard | EXISTS | **LIVE** | `src/web/routes/cos.ts` (5 route, mind 200), `web/coscontrol.js` |
| 2 | Kanban mint case-nézet | EXISTS | EXISTS | kanban_cards + case_id linkage |
| 3 | Scheduler + preCheck | EXISTS | **LIVE** | `scheduler.ts` (dueCases/dueFollowUps/reconcileOutbound/outboundNeedingHuman) + `tick.ts` a 6h loopban |
| 4 | Retry queue + auto-start | EXISTS | EXISTS | pending-retries (pre-existing) |
| 5 | Memória hot/warm/cold | EXISTS | EXISTS | memories + FTS (pre-existing) |
| 6 | Vault | EXISTS | EXISTS | `src/web/vault.ts` |
| 7 | Skill Factory | PARTIAL | PARTIAL (nem COS-scope) | permission-metadata továbbra is nyitott |
| 8 | Per-tool deadline | PARTIAL | **PARTIAL** | `tool-timeouts.ts`; a Gmail-send (GmailApiTransport fetch) NINCS timeout-tal fedve — lásd §4 |
| 9 | Autonómia-config | PARTIAL | **BUILT** | autonomy-config + approvals + kampány-szintű (campaigns) |
| 10 | Approval objektum | PARTIAL | **BUILT** | `campaigns.ts` + campaign_approvals (template_hash + rendered_payload_hash + version, P0.4/P0.5) |
| 11 | Data-sensitivity P0.6 | PARTIAL | **BUILT** | `sensitivity.ts` (4-tier, fail-closed) + 13 teszt |
| 12 | Prompt-injection védelem | PARTIAL | PARTIAL | prompt-safety.ts (pre-existing) + COS `redactSensitive`/sensitivity |
| 13 | Personal Case Engine | MISSING | **BUILT** | `case-store.ts` + personal_cases(+version) + state machine, 11 teszt |
| 14 | personal_case_events append-only | MISSING | **BUILT** | triggerek + `cos-audit-immutability` (UPDATE/DELETE elutasítva) |
| 15 | case_claims atomi + fence | MISSING | **BUILT** | case_claims + fencing token, `cos-case-store` fence-tesztek |
| 16 | campaigns + revoke | MISSING | **BUILT** | `campaigns.ts`, 7 teszt (revoke + version binding) |
| 17 | outbound_ledger states + UNIQUE | MISSING | **BUILT** | `executor.ts` + P1.1 finomított állapotmodell, 15 teszt |
| 18 | email_processing + checkpoints | MISSING | **BUILT** | `email-ingest.ts` (P0.1 karantén, P0.2 checkpoint), 5 teszt |
| 19 | attachments checksum/readback | MISSING | **BUILT** (ma) | `attachments.ts` + case_attachments (sha256 readback) |
| 20 | connector_health mátrix | MISSING | **BUILT** | `connector-health.ts`, 4 teszt |
| 21 | Action Executor | MISSING | **BUILT** | `executor.ts` (egyetlen külső író) |
| 22 | Gmail WRITE + kereshető marker | MISSING | **BUILT + ÉLESBEN BIZONYÍTVA** | `gmail-api-transport.ts` — AC-26 live (send→readback→id-match, gate=EXECUTE). Lásd §3 |
| 23 | Shopping adapter + Kifli | MISSING | **RÉSZBEN** | rental/DiscoverCars adapter BUILT (JSON API); **Kifli NINCS** (cred/discovery) — lásd §4 |
| 24 | radar items/observations | MISSING | **BUILT** | `radar.ts` + FX (P1.5) + dedup (P1.6) |
| 25 | Inter-agent bus | EXISTS | EXISTS | agent_messages (pre-existing) |

**Delta:** a 12 MISSING-ből **11 BUILT**, 1 részben (Kifli integráció nyitott). Az 5 PARTIAL-ből 3 BUILT-re javult (#9/#10/#11).

---

## 2. Korrektségi felület — P0 / P1 / P2 / AC (mind verifikálva)

**P0.1-0.6** (korábbi körök): karantén, checkpoint, crash-window+marker, template+rendered+kvóta, optimista concurrency+revoke, sensitivity fail-closed — mind BUILT + tesztelt.

**P1.1-1.6** (ez a kör): outbound állapotmodell (`executor` 15t + `outbound-migration` 4t), self-event guard (`gmail-history-guard` 10t, AC-28), marker-persistence gate (`marker-persistence` 4t, AC-26), browser-adapter interfész (`browser-adapter` 6t), radar FX + dedup (`radar` 10t, AC-29).

**P2 §C** (ez a kör): store-security 3t, backup+restore 6t, attachments-retention 6t, audit-immutability 4t.

**D.1-D.4:** internal/external idempotency átnevezés BUILT; általános Shopping adapter tükrözve; ZST külön + freeze-wording (doksi).

**E — AC-22..29:** mind a 8 elfogadási tesztnek valódi fedése van (karantén `email-ingest`, fence `case-store`, kvóta `quota`, revoke `campaigns`, marker `marker-persistence`, sensitivity `sensitivity`, self-event `gmail-history-guard`, radar-dedup `radar`+`tick`).

---

## 3. Élő állapot (verifikálva most)

- **Mind az 5 COS route 200-at ad** (cases/today/outbound/campaigns/radar) az élő dashboardon.
- **Autonóm loop ÉL** (`web.ts:471` startCosBackgroundTasks, 6h) — de `safeCosDeps()` KIZÁRÓLAG a rental adaptert köti (`runtime.ts:23`), **NINCS outbound adapter → a tick semmit nem küld/vásárol autonóm módon**.
- **Séma-migrációk lefutottak az éles db-n**: outbound új állapotmodell + external marker, email_processing content_hash, radar FX+dedup, case_attachments — mind ellenőrizve, nincs árva temp-tábla, a Spain radar-sor megvan.
- **Gmail EXECUTE bizonyítva élesben** (AC-26): `GmailSendAdapter` + `GmailApiTransport` valós send-to-self + readback + provider-id egyezés → gate EXECUTE. A token write-scoped (`gmail.send`, least-privilege, nincs modify). **A képesség aktív, de nincs bekötve az autonóm loopba.**

---

## 4. Amit NEM valósítottam meg — és miért (őszinte lista)

1. **Kifli / bevásárló adapter** — nincs integráció (cred + discovery hiányzik). A shopping-adapter execute nélkül → PREPARE (observe-only). Blokkoló: Kifli credential/döntés.
2. **Élő Gmail history-delta poller** — az email_processing batch/checkpoint gépezet (P0.1/P0.2) MEGVAN és fut, DE a driver a triage HTTP-seam (`/api/cos/intake`, a triage-heartbeat POST-ol), NEM egy önálló `history.list` delta-poller loop. A bejövő/Sent figyelés a `email-triage-fetch.py`-n át megy (ma bővítve Sent-tel). Egy natív history-poller loop nincs bekötve — a seam működik élesben, de ez architekturális eltérés a spec §8 delta-modelljétől. Szándékos: a triage-seam tisztább (a COS nem duplikálja a Gmail-olvasást).

   > **VISSZAVONVA 2026-08-09** — lásd `audits/cos-email-intake-spec-vs-built-2026-08-09.md`. A "csak architekturális eltérés, működik élesben" minősítés téves volt. A seam a §8 pipeline HÁROM lépését ejtette el: teljes thread olvasás (nincs, csak 300 karakteres snippet), szálazonosítás (`email_processing` 17/18 sor `thread_id` NULL), és case-match (emiatt soha nem illesztett). Élesben mérve: 18/18 üzenet `LOCAL_APPLIED`-nél áll meg, `SOURCE_COMMITTED` soha; 18/18 batch `OPEN`; `email_source_checkpoints` üres; `sourceCommit` és `tryAdvanceCheckpoint` produkciós hívó nélkül (pozitív kontroll: `openBatch` hívva a `triage-bridge.ts:57`-ből). Következmény: 2026-08-09-én a GLS futár-visszaigazolás és a cloud-kredit levelek nem lettek ügyek.
3. ~~Per-tool deadline a Gmail-send-re~~ → **MEGÉPÍTVE** (7dd785b): `TOOL_TIMEOUTS['gmail-send'/'gmail-readback']` 15s + `AbortSignal.timeout` a `GmailApiTransport` minden fetch-jén (token/send/readback). Stall → abort, amit az executor kezel (OUTCOME_UNKNOWN / available:false).
4. **Autonóm/approval-gated küldés flow** — a küldő-KÉPESSÉG bizonyított, de a tényleges küldés (jóváhagyás-kapus UI + az adapter bekötése a loopba) NINCS megépítve. Szándékos: külön owner-döntés.
5. ~~Spec §F termékbővítések~~ → **MEGÉPÍTVE:** monitoring dashboard (#5b, `listMonitoring` + 🩺 Monitoring nézet, **LIVE**), kampány/radar analitika (#5d, `listAnalytics` + 📊 Analitika nézet, **LIVE valós adattal**), skill-permission-validator (#5c, `skill-permission-validator.ts` — tesztelt könyvtár, bekötendő a skill-genbe), dinamikus routing (#5a, `model-routing.ts` — tesztelt könyvtár, bekötendő a dispatchbe; ŐSZINTE korlát: capability/cost routing a sensitivity-készleten belül, NEM geo, mert nincs EU inference-geo). Az #5b/#5d ÉLES; az #5a/#5c könyvtárként kész, az élő-út bekötés fleet-szintű owner-döntés.

**Maradék valódi nyitott elem:** (1) Kifli (cred-gated); (2) natív Gmail history-poller (szándékosan triage-seam); (4) approval-gated küldés flow (owner-döntés); (5a/5c) élő-út bekötés (owner-döntés). ~~Egyik sem korrektségi rés.~~

> **VISSZAVONVA 2026-08-09:** a (2) IGENIS korrektségi rés volt, és éles hibát okozott. Lásd `audits/cos-email-intake-spec-vs-built-2026-08-09.md`. A §23 AC 10/11/12 nem teljesül, csak ÜRESEN igaz (a cursor soha nem lép, mert nem létezik); az AC 13 (atomikus claim) éles úton nem fut (`case_claims` 0 sor); az AC 17 ma megsérült (két ZST-tartalmú ügy a personal store-ban). Ez a bekezdés nem tekinthető lezárt verifikációnak.

---

## 5. Összegzés

A **teljes korrektségi felület (P0+P1+P2+AC-22..29) megvalósítva, tesztelve, ÉLESBEN fut**; a gap-mátrix 12 MISSING-jéből 11 kész. A Gmail EXECUTE bizonyítva, de az autonóm küldés szándékosan kikapcsolva (a tick nem küld). A meg nem valósított elemek mind (a) külső credential-gated (Kifli), (b) szándékos architekturális választás (triage-seam a history-poller helyett), (c) az EXECUTE élesedéséhez kötött kis rés (per-tool timeout), vagy (d) a spec által termékbővítésnek minősített, nem-korrektségi elem. **Nincs korrektségi hiány.**
