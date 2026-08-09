# APG v0.4 — Teljes kiépítés döntési kártya

**Dátum:** 2026-07-16 · **Készítette:** marveen (Opus 4.8) · **Owner:** Istvan
**Típus:** DÖNTÉSI DOKUMENTUM — nincs implementáció, nincs core/sidecar módosítás, nincs dispatch, nincs kanban-írás, nincs deploy, nincs upstream issue/PR.
**Forrás-alapok:** `design/2026-07-13-marveen-autonomous-product-graph-architecture.md` (teljes v0.4 vízió), `design/apg-v0.4-pilot-kernel-*` (pilot spec + acceptance plan), `audits/apg-v0.4-local-capability-map.md`, `audits/apg-v0.4-upstream-candidates.md`, `audits/apg-v0.4-token-baseline.md`, W9 zárójelentés (`~/marveen-local/apg-kernel/src/report.py`, post_pilot_recommendations).

---

## 1. Executive summary

A v0.4-lean Pilot Kernel (W1–W9) **teljes pilot-scope-ja kész és bizonyított**: 103 determinisztikus teszt, két historical shadow replay, evidencia-lánc / test-identity / token-mérés / LLM-mentes checkpoint mind igazolva, Marveen-core érintés nélkül. Ez azonban a v0.4 víziónak tudatosan a **legkisebb bizonyító szelete**: az autonóm Lifecycle Runner, az élő dispatch, a Kanban-visszaírás, a deploy-integráció és a teljes Product LCM nem épült meg (explicit non-goal volt).

A capability gap matrix szerint: **7 PROVEN_BY_PILOT, 7 PARTIALLY_PROVEN, 13 NOT_IMPLEMENTED, 3 LIVE_PILOT_PREREQUISITE, 3 LATER_OPTIONAL, 4 REJECT/v0.5**. A Marveen-szubsztrát (kanban API, bus, scheduler, CostOps, git/Render/health) készen áll — a hiány nem greenfield, hanem vékony adapterek + néhány valódi upstream-gap.

**Ajánlás: OPTION B — CONDITIONAL_GO.** Phase 0 (pilot hardening) + Phase 1 (observe-only live pilot) + Phase 2 (assisted workflow) megépítése, fázisonkénti go/no-go kapuval; a Phase 3–5 (supervised dispatch → delivery → full LCM) elköteleződés **nélkül**, azok csak a Phase 2 MÉRT eredménye alapján nyílhatnak. Következő egyetlen lépés: Phase 0 scope-fagyasztás és munkacsomagokra bontás (W10–W14) jóváhagyásra.

---

## 2. Pontos jelenlegi állapot

**KÉSZ (v0.4-lean Pilot Kernel, 2026-07-16):**
- W1–W9: 100%, minden kapu egyenként elfogadva (marveen acceptance-gate, függetlenül verifikálva)
- 103 determinisztikus teszt zöld; a checkpoint-evaluator kétszeri futása azonos eredményt ad (determinizmus bizonyítva)
- 2 historical shadow replay: S1 (LumaSeat brand-token landing change), S2 (JWT-tenant-migráció)
- Evidence/provenance chain: execution_receipt mindkét replayen, mind a 7 link PRESENT/UNKNOWN/MISSING besorolással, **nulla kitalált evidencia**
- Test-identity: 6 kötelező check S2-n, PASS/FAIL/UNKNOWN/MISSING; a történelmileg nem-rekonstruálható mező helyesen MISSING
- Token/context mérés: MEASURED/ESTIMATED/UNKNOWN becsületes címkézéssel; reduction-claim baseline nélkül nem született (a token-hipotézis PARTIALLY UNKNOWN maradt — az acceptance plan szerint ez elfogadott kimenet)
- Ceremony-fegyelem: minden létrehozott rekordnak megnevezett fogyasztója van
- Marveen core módosítás: **0**; a sidecar (`~/marveen-local/apg-kernel`) törléssel maradéktalanul eltávolítható

**FELTÁRT HIÁNY (a pilot saját, első-osztályú ajánlása):**
- A nyers per-check identity-státusz (PASS/FAIL/UNKNOWN/MISSING, fold előtt) **nincs store-natívan perzisztálva** — a checkpoints.py checkpoint-szintű UNKNOWN-ba hajtja, a store önmagából nem tudja utólag újra-bizonyítani a Goal 2-t (a W9 a saját teszt-suite-ra citálással zárta, ami helyes E PILOTRA, de élő pilot előtt store-natívvá kell tenni).

**NEM ÉPÜLT MEG (explicit non-goal):** autonóm Lifecycle Runner; élő agent-dispatch; Kanban-visszaírás; production deploy integráció; progresszív rollout; teljes Product LCM; automatikus product review → roadmap → delivery ciklus; autonóm visszalépés research/business/design fázisba; post-release mérésből change-generálás; marketing/GTM lifecycle; teljes live identity + event-ingestion.

---

## 3. A Pilot Kernel által bizonyított képességek

| # | Képesség | Bizonyíték |
|---|---|---|
| P1 | Append-only sidecar store + migrációk (apg-kernel.db) | W1; minden későbbi W rá épült; core-DB write: 0 |
| P2 | Profile Registry (profiles/*.yaml determinisztikus betöltés) | W2; replay-futások konzisztensen fogyasztották |
| P3 | Execution Receipt chain HISTORICAL forrásokból (git+Render+health+kanban), 7 link, honest gap-labeling | W3 + S1/S2 replayek; zéró invented evidence |
| P4 | Token-origin mérési MODELL (measured/estimated/unknown szeparáció, unattributed_input soha nem "inherited") | W4; reduction-claim baseline nélkül nem született |
| P5 | Test-identity contract kiértékelés (6 check, 4-állapotú eredmény, zéró termék-hardcode) | W5 + S2 replay |
| P6 | Determinisztikus, LLM-MENTES checkpoint-evaluator, reprodukálható | W6; ismételt futás == azonos eredmény |
| P7 | Ceremónia-elszámolás (records_written + consumer-attribúció) és teljes uninstall-képesség | W9 riport + sidecar-izoláció |

Ezek együtt a v0.4 **bizonyítási magját** adják: a "honest evidence" tézis működik, determinisztikusan, LLM és core-érintés nélkül.

---

## 4. Teljes v0.4 célállapot (end-to-end)

A methodology pack + architektúra-doksi szerinti teljes működés, egyetlen összefüggő körben:

```
product signal / owner intent
  → market_fact + opportunity (research; intel-registry-ből delta-alapon)
  → business_definition (business; accepted_intent_hash owner-kapuval)
  → change + requirement-ek (delta-egység; traces_to a business_definition-re)
  → work item / task (Kanban Bridge: kanban = dispatch+vizualizáció, APG = igazság)
  → implementation + test (producer agent ≠ accepter agent; Context Packet-tel)
  → build (commit_sha + artifact_digest) → release
  → deployment (rollback_ref kötelező) + runtime evidence (feature_reachable probe)
  → measurement (PostHog / revenue / CostOps adapterek → metric_observation)
  → product review (determinisztikus KPI-gap → verdikt)
  → következő change-javaslat VAGY decision.steps_back_to (visszalépés
    research/business/design fázisba) → és a kör újraindul
```

**A nevesített alrendszerek szerepe a célállapotban:**

- **Product LCM FSM** — a 16 lifecycle-fázis állapotgépe a `product`/`change` objektumokon; a Graph Runner determinisztikusan lépteti, az LLM csak tartalmat termel, soha nem routol.
- **Change Delivery FSM** — a change-szintű szállítási lánc (requirement → task → build → deploy → runtime_evidence) saját entry/exit-kapukkal; a lifecycle-fázistól független tengely (a 4 státusz-tengely egyike).
- **Profile activation** — a Profile Registry (W2-ben már él) élesben: fázis+szerep → gate-profil + kontextus-szabály determinisztikus kiválasztása.
- **Deterministic gate engine** — minden fázis-kilépésen: (1) determinisztikus check-ek (schema, hash, edges, tsc/test/reachability), (2) csak pass után szemantikus LLM-verifier MÁSIK agenttel, (3) csak owner-gated fázisnál human gate.
- **Context Packet** — szerep+fázis-szkópolt, hash/delta-tudatos 3–5k tokenes csomag; változatlan upstream = id+hash stub. A token-baseline kulcsbelátása: nem a fresh input a nagy tétel, hanem a mega-session inherited context leváltása.
- **Execution Receipt** — minden side-effect execution_id-vel, append-only ledgerben; replay + idempotencia + audit egyben (W3 historical formája élesítve).
- **CostOps/model-routing kapcsolat** — a methodology capability-class-t mond (deterministic/cheap/mid/high), a provider-feloldás a CostOps capacity-resolverben él (peak-valley, balance, kvóta-tudatosan); vendor-hardcode a methodology-ban tilos.
- **Kanban- és agentkapcsolat** — Kanban Bridge (meglévő HTTP API-n, kétirányú tükrözés, kanban-done = input-jel, nem lifecycle-tény) + dispatch-adapter a meglévő /api/messages buszon, readiness a /api/agents-ből.
- **Release és runtime evidence** — build→deployment→runtime_evidence típusos lánc; csak passzoló feature_reachable probe után léphet a change measurement-be.
- **Measurement és product-review loop** — metric_definition/observation adapterekből; determinisztikus KPI-gap → product_review → auto-change-javaslat (optimize/reprice/scale/pivot/sunset).
- **Human approval bucketek** — AUTOMATIC oszlop emberi kapu nélkül fut; USER-APPROVAL bucket (új/növekvő költség, pricing go-live, external publish, legal/privacy, destruktív törlés, pivot/sunset, elfogadott üzleti intent materiális változása) Approval Brokeren + eszkalációs órával.
- **Rollback és recovery** — deployment.rollback_ref kötelező; checkpoint+lease alapú resume agent-halál/VM-reboot után; idempotens retry dedup_key-jel.

---

## 5. Capability Gap Matrix

Kategóriák: **PROVEN_BY_PILOT** (PBP) · **PARTIALLY_PROVEN** (PP) · **NOT_IMPLEMENTED** (NI) · **LIVE_PILOT_PREREQUISITE** (LPP) · **LATER_OPTIONAL** (LO) · **REJECT_AS_EXCESS_COMPLEXITY** (REJ, v0.5 extension-határ).

Oszlopok: cél; jelenlegi bizonyíték; hiányzó rész; kell-e a teljes v0.4-hez; fázis; local/upstream; overhead (agent/token/runtime); haszon-mérőszám.

| Capability | Kat. | Cél | Bizonyíték ma | Hiányzó | v0.4-hez kell? | Fázis | Local/Upstream | Overhead | Haszon-metrika |
|---|---|---|---|---|---|---|---|---|---|
| Sidecar store + migráció | PBP | append-only igazságtár | W1, 103 teszt | schema-hardening élő terheléshez | igen | P0 | local runtime, séma-forma upstream-képes | ~0 LLM; ms-ek | 0 core-write mellett teljes lekérdezhetőség |
| Profile registry (read) | PBP | fázis/szerep→szabály | W2 + replayek | — | igen | kész | upstream candidate (generic) | ~0 | profil-találati arány |
| Execution receipt (historical) | PBP | evidencia-lánc | W3, 7 link, S1+S2 | — | igen | kész | contract upstream, adapter local | ~0 LLM | % link PRESENT vs UNKNOWN, 0 invented |
| Token-mérés modell | PBP | honest költség-attribúció | W4 (replay) | élő origin-tagging (lásd PP sor) | igen | kész (modell) | contract upstream | ~0 | unattributed_input arány csökkenése |
| Test-identity contract | PBP | ki/mivel futtatta | W5 + S2 | store-natív persistence (LPP sor) | igen | kész (contract) | contract-forma upstream | ~0 | 4-állapot helyes címkézés |
| Determinisztikus checkpoint-evaluator | PBP | LLM-mentes kapuzás | W6, reprodukálható | élő event-feldolgozás (PP sor) | igen | kész (mag) | engine upstream-képes | 0 LLM | determinizmus: ismételt futás == |
| Ceremony-elszámolás + uninstall | PBP | overhead-kontroll | W9 + sidecar-izoláció | élő üzemben folyamatos mérés | igen | kész (modell) | local | ~0 | consumer-nélküli rekord = 0 |
| Raw identity-status native persistence | **LPP** | Goal 2 store-only újra-bizonyíthatóság | W9 ajánlás (gap nevesítve) | identity_assertions tábla (pre-fold, replay_run_id-vel) | igen — élő pilot ELŐFELTÉTELE | **P0** | local (séma-forma upstreamelhető) | kicsi (1 tábla + írás) | Goal 2 citation nélkül záródik |
| Live-adapter idempotencia + event-loss/duplicate kezelés | **LPP** | élő ingest megbízhatóság | core-primitívek léteznek (dedup/lease), APG-oldal nincs | ingest-boundary: dedup-key, at-least-once + idempotens write, loss-számláló | igen — élő pilot előfeltétele | **P0** | local | kicsi | duplicate-arány ~0, loss explicit számolt |
| Credential/PII boundary az adaptereken | **LPP** | vault-kulcsok, PII a store-ból kizárva | vault él; APG-adapter-policy nincs leírva/enforce-olva | read-only token-scope-ok, PII-mezőtiltás, redakció | igen — élő pilot előfeltétele | **P0** | local | ~0 | 0 secret/PII a sidecar-store-ban |
| Live event ingestion (kanban_card_events, bus, deploy-history, health tick) | NI | élő change követése | források AVAILABLE (capability map #1–3,#6) | maga az ingest-loop + normalizálás | igen | **P1** | local adapterek | scheduled tick, ~0 LLM | esemény-lefedettség % egy valós change-en |
| Execution receipt LIVE capture | PP | élő lánc-építés | historical forma bizonyított | élő trigger + inkrementális link-építés | igen | P1 | contract upstream, capture local | ~0 LLM | receipt-teljesség élő change-en |
| Token-origin LIVE instrumentation | PP | budget-enforcement alapja (GAP-APG-01) | aggregát dimenziók élnek (token_usage) | fresh/inherited/packet/on-demand origin-split tagging | igen | P1 | **upstream P0 candidate** | kicsi | 3000/5000 budget dekomponálva mérhető |
| Checkpoint event processing (élő) | PP | kapuk élő eseményekre | evaluator kész (W6) | event→checkpoint kötés, NOT_APPLICABLE kezelés élőben | igen | P1 | engine upstream-képes | 0 LLM | élő replay==utólagos replay egyezés |
| Kanban READ adapter | PP | board-állapot beolvasás | replayek olvasták a kártya-evidenciát | folyamatos, esemény-vezérelt olvasás | igen | P1 | local (API generic) | ~0 | kártya-esemény lefedettség |
| Recommendation-készítés (gate-verdikt + javaslat) | NI | emberi döntés-előkészítés | — | packet-alapú javaslat-generálás (LLM, bounded) | igen | **P2** | local | ≤3k fresh/javaslat | javaslat-elfogadási arány |
| Kanban WRITE adapter (approval után) | NI | státusz/kártya-írás jóváhagyással | API AVAILABLE | write-path + approval-kötés + actor-jelölés | igen | P2 | local | ~0 LLM | írás CSAK approval-lal: 100% |
| Context Packet injection valós tasknál | NI | 3–5k szkópolt kontextus | contract kész (design) | assembler + dispatch-integráció | igen | P2 | assembler upstream-képes | csökkenti a tokent | fresh_input/dispatch ≤5k mérve |
| Owner approval handling (Approval Broker) | NI | human-gate bucketek + eszkalációs óra | bucket-mátrix designban | approval-objektum, TG/dashboard eszkaláció, clock | igen | P2 (ajánlás-szint), P3 (kapu-szint) | local | ~0 | átlag approval-latencia, lejárt clock=0 |
| Agent dispatch adapter | NI | jóváhagyott work item kiadása | /api/messages AVAILABLE | dispatch + origin_note/identity kötés | igen | **P3** | local | ~0 LLM | dispatch→pickup arány |
| Agent readiness + completion ingestion | NI | ki szabad, ki végzett | /api/agents + bus AVAILABLE | readiness-poll + completion-normalizálás (verdict-not-posted osztály ellen!) | igen | P3 | local | ~0 | silent-finish incidens=0 |
| Lifecycle Runner (bounded, change-szint) | NI | determinisztikus tovább-léptetés | Graph Runner designban | runner-loop, lease, bounded retry | igen | P3 (change-szint), P5 (product-szint) | engine upstream-képes | tick-enkénti ms-ek | zero-touch transition arány |
| Idempotent retry + recovery | NI | agent-halál/VM-reboot túlélés | core lease/dedup primitívek léteznek | APG-szintű checkpoint-resume + attempt-cap | igen | P0 (séma) + P3 (élesben) | local | ~0 | resume-siker %, duplikált side-effect=0 |
| Profile registry LIVE activation | PP | élő szabály-aktiválás | read-path kész | aktiválás dispatch-hoz kötve | igen | P2–P3 | upstream-képes | ~0 | profil-eltérés incidens=0 |
| CostOps + capacity-aware routing | PP | capability-class→provider feloldás | CostOps él (collectorok, peak-policy, limits) | a resolver-interfész (class→model) formálisan | igen | P3 | **upstream P0 candidate** | ~0 | routing-döntés auditálható %, peak-költés ↓ |
| Build/deploy/runtime evidence adapter (élő lánc) | PP | commit→build→deploy→runtime egy láncban | források olvashatók, historical láncolás kész | élő láncoló + rollback_ref kötelezővé tétele | igen | P4 | interface upstream, provider-adapter local | ~0 LLM | lánc-teljesség %, rollback_ref=100% |
| Non-production deployment integráció | NI | preview/staging evidence + smoke | Render preview létezik | APG-vezérelt non-prod deploy + smoke-probe | igen | **P4** | local (Render-specifikus) | deploy-időn kívül ~0 | smoke-catch arány pre-prod |
| Production release integráció | NI | low-risk prod release támogatás | autoDeploy él (APG-n kívül) | APG-kapuzott release CSAK külön owner-döntés után | igen (végállapot), de külön kapu | P4-vég/P5 | local | — | 0 APG-okozta prod-incidens |
| Rollback integráció | NI | egy-lépéses visszaállás | Render manuális rollback él | rollback_ref automata rögzítés + trigger-út | igen | P4 | local | ~0 | rollback-idő, sikeres visszaállás % |
| Product metrics ingestion | NI | value-mérés (a keystone gap) | PostHog phx él, CostOps él, revenue-forrás részleges | metric_definition/observation + adapterek | igen | **P5** | adapter local, contract upstream | scheduled, ~0 LLM | KPI-lefedettség termékenként |
| Product Review evaluator | NI | determinisztikus KPI-gap → verdikt | design kész | evaluator + threshold-ek | igen | P5 | engine upstream-képes | ~0 LLM | review-ből származó valós change-ek |
| Automatic next-change proposal | NI | mérésből következő javaslat | design (§12, §15) | proposal-generátor (LLM, bounded) owner-kapuval | igen | P5 | local | ≤3k fresh/javaslat | javaslat→elfogadás arány |
| Backward transition (research/business/design felé) | NI | steps_back_to első-osztályú | transition-table designban | decision-objektum + routing | igen | P5 | engine upstream-képes | ~0 | téves-irányú visszaküldés=0 |
| Full Product LCM (16 fázis, product-szint) | NI | teljes életciklus-vezérlés | FSM designban | a teljes runner + minden adapter együtt | igen (végállapot) | **P5** | mag upstream-képes | lásd §9 kapuk | zero-touch fázis-átmenet %, érték-metrikák |
| Marketing / go-to-market handoff | LO | GTM-előkészítés lifecycle-ból | — | draft-generálás + publish-approval bucket | nem kritikus a maghoz | P5-vég | local | LLM-draft költség | kampány-előkészítési átfutás |
| Intel registry (market_fact store) | LO | delta-alapú piaci tudás | deliverable-fájlok vannak, registry nincs | registry + bridge | nem előfeltétel (P5-höz hasznos) | P5 (vagy előbb ha research igényli) | **upstream candidate** | kicsi | re-research token ↓ |
| Staging/canary release stage | LO | kockázat-alapú release-út | nincs (Render preview van) | canary-infra | nem; csak high-risk change-eknek | P4+ igény szerint | upstream candidate P2 | közepes | high-risk change hibaszűrés |
| Ralph loop (bounded iterative execution) | REJ | iteratív végrehajtási policy | — | — | **NEM** — v0.5 extension | v0.5 | — | — | extension-point megléte elég |
| Frontend/backend külön delivery lane-ek | REJ | lane-specifikus szállítás | — | — | **NEM** — v0.5 extension | v0.5 | — | — | extension-point megléte elég |
| Új top-level artefaktumtípusok | REJ | séma-bővítés | 19 típus + legalEdges zárt | — | **NEM** — v0.5 | v0.5 | — | — | schema_version bump-út igazolt |
| Többagent-szavazás (homogeneous voting) | REJ | konszenzus-verifikáció | — | — | **NEM** — a v0.4 egy-független-verifier elvű | v0.5-ben is kérdéses | — | drága (N× token) | — |

**Számszerű összegzés:** PROVEN_BY_PILOT **7** · PARTIALLY_PROVEN **7** · NOT_IMPLEMENTED **13** · LIVE_PILOT_PREREQUISITE **3** · LATER_OPTIONAL **3** · REJECT/v0.5 **4**.

**v0.5 extension-pont igazolás (nem építjük, csak igazoljuk):** a Ralph loop a Lifecycle Runner retry-policy pontjára additívan felcsatolható (attempt-cap → policy-objektum); a FE/BE lane-ek a `requirement.surface` mező + gate-profil szinten válnak szét (már ma is létező mező); az integration contract lane a legalEdges bővítésével (schema_version bump, supersedes-úton) additív; új artefaktumtípus a séma `objectType` enum bővítésével jön, meglévő objektumok érintése nélkül. Mindegyik ADDITÍV — egyik sem v0.4-completion feltétel.

---

## 6. Fázisos kiépítési terv

Istvan 0–5 fázis-struktúrája átvéve — a vizsgálat alapján a sorrend HELYES, egy módosítással: a Phase 4 production-részét külön belső kapu mögé tettem (P4a non-prod / P4b prod), mert a kettő kockázati osztálya különbözik.

### PHASE 0 — Pilot hardening
- **Scope:** (1) `identity_assertions` tábla: nyers, fold-előtti per-check státusz perzisztálás replay_run_id-vel; (2) schema/migration hardening (idempotens migrációk, verzió-tábla, integritás-checkek); (3) live input adapter boundary ELŐKÉSZÍTÉS: ingest-interfész definíció dedup-kulccsal, at-least-once + idempotens write szemantikával, event-loss/duplicate számlálókkal (adapter MÉG nem élesedik); (4) credential/PII boundary policy: adapter-szintű mezőtiltás + redakció, secret soha a store-ba; (5) backup/recovery/uninstall próba: store-mentés, visszaállítás, teljes eltávolítás verifikálva; (6) baseline-fagyasztás: az S1/S2 replay-eredmények + AS-IS token-baseline rögzítése összehasonlítási alapnak.
- **Out of scope:** bármilyen élő eseményfogyasztás; kanban/bus/deploy érintés; LLM-hívás.
- **Előfeltétel:** nincs (minden anyag megvan).
- **Work itemek:** W10 identity-persistence, W11 schema-hardening, W12 ingest-boundary-contract, W13 PII/credential-policy + teszt, W14 backup/uninstall próba + baseline-fagyasztás. Függés: W10→W11 után; W12–W14 párhuzamos.
- **Acceptance:** Goal 2 store-only újra-bizonyítható (citation nélkül); mindkét replay változatlan eredménnyel újrafut az új sémán; uninstall-próba 0 maradékkal; 103+új teszt zöld.
- **Mérés:** replay-determinizmus diff=0; teszt-darabszám; store-méret.
- **Ceremony/token/runtime (ESTIMATED):** 0 élő LLM; build-agent munka ~1–2 nap; futásidő változatlan (ms-ek).
- **Stop/go gate:** minden acceptance zöld → GO P1; bármely replay-eredmény változik → STOP, ok-feltárás.
- **Rollback/uninstall:** sidecar-törlés, 0 core-hatás (P0-ban próbával igazolva).
- **Feloldott autonómiaszint:** A0 → **A1 belépésre jogosult**.

### PHASE 1 — Observe-only live pilot
- **Scope:** EGY valós change kiválasztása (normál fleet-munka, az APG csak FIGYELI); élő event-ingest (kanban_card_events, bus-üzenetek metaadatai, git-commitok, Render deploy-history, /health tickek, token_usage) a P0-ban definiált boundary-n át; élő execution receipt lánc-építés; token-origin élő tagging (legalább az APG-attribútálható rész + unattributed maradék); checkpoint-kiértékelés élő eseményeken; zárásként RECOMMENDATION-riport (mit kapott volna el, mit javasolt volna — de semmit nem tett).
- **Out of scope:** dispatch; kanban-írás; source/deploy-írás; BÁRMILYEN külső side effect; a megfigyelt change menetének befolyásolása.
- **Előfeltétel:** P0 acceptance zöld.
- **Work itemek:** W15 kanban/bus ingest-adapter, W16 git/Render/health ingest, W17 élő receipt-builder, W18 token-origin tagger, W19 élő checkpoint-kötés, W20 observe-riport. Függés: W15–W16 → W17 → W19; W18 párhuzamos; W20 zár.
- **Acceptance:** a megfigyelt change receipt-teljessége riportált (PRESENT/UNKNOWN/MISSING); 0 side effect (audit: a sidecar-folyamat write-ei kizárólag a saját store-ba); duplicate-arány ~0, event-loss explicit számolt; a checkpoint-eredmények utólagos replay-jel egyeznek.
- **Mérés:** esemény-lefedettség %; receipt-link PRESENT-arány; kernel-token (most már MEASURED); runtime/tick.
- **Ceremony/token/runtime (ESTIMATED):** LLM ~0 (determinisztikus út) + max 1 kis riport-összeállítás; scheduled tick <60s gyakoriságú, tickenként <1s; ceremónia: rekord/consumer arány riportban.
- **Stop/go gate:** 0 side effect ÉS lefedettség elfogadható ÉS overhead < haszon → GO P2. Ha a rekordok jelentős része fogyasztó nélküli marad → STOP (§9).
- **Rollback:** ingest-loop leállítása (scheduled task ki), store megmarad auditnak.
- **Feloldott autonómiaszint:** A1 → **A2 belépésre jogosult**.

### PHASE 2 — Assisted workflow
- **Scope:** az APG JAVASOL: work-item-javaslat, státuszváltás-javaslat, gate-verdikt-javaslat; Context Packet használata valós tasknál (a dispatcholó — ember vagy marveen főagent — kéri le és adja át); explicit jóváhagyás (Istvan vagy marveen főagent) UTÁN Kanban-write az APG actor-jelölésével; Approval Broker ajánlás-szinten (javaslat-objektum + TG/dashboard felület).
- **Out of scope:** önálló production action; agent-dispatch; deploy; bármely write jóváhagyás nélkül.
- **Előfeltétel:** P1 acceptance zöld; a P1-riport javaslat-minősége szúrópróbával igazolt.
- **Work itemek:** W21 recommendation-generátor (bounded LLM, packet ≤3k fresh), W22 kanban-write-path approval-kötéssel, W23 Context Packet assembler + kézi dispatch-integráció, W24 approval-felület (TG + kártya-komment), W25 mérési riport (javaslat-elfogadási arány, token).
- **Acceptance:** MINDEN write mögött approval-rekord (100%); javaslat-elfogadási arány mért; fresh_input/javaslat ≤3k MEASURED; a normál fleet-flow nem lassult (átfutás-összevetés).
- **Mérés:** elfogadott/összes javaslat; false-PASS/false-FAIL javaslatok száma; token/javaslat; koordinációs üzenetek száma AS-IS vs P2.
- **Ceremony/token/runtime (ESTIMATED):** LLM-költség megjelenik: ~1–3k fresh token/javaslat, napi néhány javaslat → napi <15k fresh token nagyságrend; runtime változatlan.
- **Stop/go gate (ez a B/C válaszvonal):** javaslat-elfogadás magas, false-verdikt alacsony, koordináció NEM nőtt → ITT ÁLL MEG az OPTION B, és CSAK mért eredmény alapján, külön owner-döntéssel nyílik P3.
- **Rollback:** write-path kikapcsolása → vissza tiszta observe-be.
- **Feloldott autonómiaszint:** A2 → **A3** (approved kanban-write), P3-belépési jogosultság owner-döntéssel.

### PHASE 3 — Supervised agent orchestration
- **Scope:** jóváhagyott work item dispatcholása agenthez (meglévő buszon, identity-jelöléssel); readiness + completion ingest (a verdict-not-posted osztály strukturális megfogása); determinisztikus gate-pass után automatikus tovább-léptetés a change-láncon; visszaküldés javításra; bounded retry (attempt-cap + lease).
- **Out of scope:** production deploy APG-vezérléssel; nem-preapproved change-classok; costos műveletek approval nélkül.
- **Előfeltétel:** P2 mért eredménye + explicit owner GO; preapproved change-class lista definiálva (low/standard risk).
- **Work itemek:** W26 dispatch-adapter, W27 readiness/completion ingest, W28 change-szintű Lifecycle Runner (bounded), W29 return-for-fix út, W30 retry/lease élesítés, W31 mérési riport.
- **Acceptance:** zero-touch transition arány mért; silent-finish incidens=0 a felügyelt change-eken; minden dispatch visszavezethető approval-ra vagy preapproved-classra.
- **Mérés:** zero-touch %; kézi felülírások száma; retry-siker; token/change vs baseline.
- **Ceremony/token/runtime (ESTIMATED):** LLM: a packet-alapú dispatch inkább CSÖKKENTI a tokent (3–5k vs mega-session); runner-tick overhead kicsi.
- **Stop/go gate:** kézi gate-felülírás gyakori (>20%) vagy koordináció nő → STOP/vissza P2-be.
- **Rollback:** dispatch-adapter ki; a folyamatban lévő change-ek kézi átvétele (lease-lejárat automatikusan felszabadít).
- **Feloldott autonómiaszint:** A3 → **A4**, majd mért eredménnyel **A5** (autonomous low-risk delivery a preapproved classokon).

### PHASE 4 — Safe delivery integration
- **Scope (P4a, non-prod):** build/deploy/runtime lánc élő kezelése non-production célra: preview/staging deploy indítás, deployment-objektum rollback_ref-fel, smoke/feature_reachable probe, evidence a láncban. **(P4b, prod — KÜLÖN owner-döntés):** low-risk production release támogatás (autoDeploy-kompatibilisen), rollback-readiness kötelező.
- **Out of scope:** high-risk prod release; infra-átalakítás; canary-építés (LATER_OPTIONAL, igény szerint).
- **Előfeltétel:** P3 acceptance + owner GO; provider-adapter (Render) local rétegben.
- **Work itemek:** W32 build/deploy evidence-adapter élő láncolással, W33 non-prod deploy-integráció + smoke, W34 rollback-integráció, W35 (P4b, külön kapu) low-risk prod release út, W36 mérési riport.
- **Acceptance (P4a):** minden APG-vezérelt non-prod deploynak teljes evidence-lánca + rollback_ref-je van; smoke-catch működik (legalább 1 valós hibát pre-prod fog VAGY 0 hibás átengedés). **(P4b):** első prod-release csak owner-jelenléttel, 0 incidens.
- **Mérés:** lánc-teljesség %; smoke-catch; rollback-idő próbán; deploy-átfutás.
- **Ceremony/token/runtime (ESTIMATED):** LLM ~0 (determinisztikus); deploy-időt a meglévő Render adja; adapter-fenntartás kicsi.
- **Stop/go gate:** P4a zöld → P4b owner-döntésre terjeszthető; bármely APG-okozta deploy-incidens → STOP.
- **Rollback:** deploy-integráció ki, minden visszaáll a mai autoDeploy-ra.
- **Feloldott autonómiaszint:** A5 → **A6** (non-prod release control); P4b után → **A7** (controlled production release).

### PHASE 5 — Full Product LCM
- **Scope:** metric ingestion (PostHog/revenue/CostOps adapterek); product review evaluator (determinisztikus KPI-gap); automatikus gap/opportunity-felismerés; következő change-javaslat generálás; visszalépés research/business/design fázisba (steps_back_to); teljes lifecycle progression product-szinten; marketing/GTM-előkészítés (draft-szint); owner approval minden kritikus bucketnél (pricing go-live, pivot/sunset, publish, költség).
- **Out of scope:** v0.5 extensionök (Ralph, lane-ek, új artefaktumok, szavazás); autonóm pricing-élesítés/pivot/sunset (mindig owner).
- **Előfeltétel:** P0–P4 MÉRT eredményei igazolják az értéket; metric-adapterek forrásai élnek (PostHog kulcs már van).
- **Work itemek:** W37 metric-adapterek, W38 product review evaluator, W39 next-change proposal + owner-kapu, W40 backward-transition routing, W41 product-szintű runner, W42 GTM-draft handoff, W43 záró mérési kör.
- **Acceptance:** legalább 1 termék teljes körön át (measure → review → javaslat → owner-döntés → change) fut; minden kritikus döntés owner-approval mögött; zero-touch arány + érték-metrikák riportálva.
- **Mérés:** KPI-lefedettség; review→valós change konverzió; a methodology teljes token/koordináció-mérlege vs P0-baseline.
- **Ceremony/token/runtime (ESTIMATED):** scheduled adapterek ~0 LLM; review determinisztikus; javaslat-generálás bounded LLM (napi nagyságrend: <20k fresh token).
- **Stop/go gate:** §9 kapuk folyamatosan; az LCM csak addig terjeszkedik, amíg a mért érték igazolja.
- **Rollback:** LCM-runner ki, a P4-ig elért képességek megmaradnak.
- **Feloldott autonómiaszint:** A7 → **A8** (full Product LCM).

---

## 7. Autonómia-lépcső (a rendszer szintet SOHA nem ugrik át)

| Szint | Engedélyezett | Tiltott | Szükséges evidence | Emberi approval | Rollback | Előrelépés feltétele |
|---|---|---|---|---|---|---|
| **A0** historical replay only | replay, teszt, riport | minden élő olvasáson túli művelet | replay-determinizmus | nem kell | törlés | P0 acceptance zöld |
| **A1** live observe-only | élő READ-ingest saját store-ba | bármilyen write a sidecaron kívül; befolyásolás | 0-side-effect audit + lefedettség-riport | nem kell | ingest ki | P1 acceptance + overhead<haszon |
| **A2** recommendation+approval | javaslat-generálás, felület | bármilyen végrehajtás | javaslat-minőség mérve (elfogadási arány) | minden akcióhoz | javaslat-út ki | P2 részeredmény |
| **A3** approved Kanban write | kártya/státusz-írás APPROVAL UTÁN, actor-jelölve | bármely write approval nélkül; dispatch | approval-rekord 100% | minden write-hoz | write-path ki | P2 acceptance + owner GO P3-ra |
| **A4** supervised agent dispatch | dispatch preapproved change-classon, felügyelt | prod-deploy; nem-preapproved class | dispatch→approval/class trace | class-jóváhagyás + kivételek | dispatch ki, lease-felszabadulás | P3 részeredmény (silent-finish=0) |
| **A5** autonomous low-risk delivery | teljes change-lánc low-risk classon deploy-ig NEM | production release | zero-touch riport + 0 incidens | csak bucket-esetek | runner ki | P3 acceptance |
| **A6** non-production release control | preview/staging deploy + smoke + evidence | production | lánc-teljesség + rollback_ref 100% | nem (preapproved env) | deploy-integráció ki | P4a acceptance |
| **A7** controlled production release | low-risk prod release, rollback-readiness-szel | high-risk prod; költség/pricing/publish bucketök | első release owner-jelenléttel; 0 incidens | release-class jóváhagyás | rollback_ref + integráció ki | P4b acceptance + owner GO |
| **A8** full Product LCM | teljes kör: mérés→review→javaslat→(owner)→change | autonóm pivot/sunset/pricing-élesítés/publish | teljes mérleg-riport | minden USER-APPROVAL bucket él | LCM-runner ki | P5 acceptance |

---

## 8. Live pilot helye — DÖNTÉS

**Az observe-only live pilot KÖZVETLENÜL Phase 0 után indokolt, további kernelbővítés nélkül.** Indoklás a kért szempontok szerint:

- **Raw identity-status persistence:** ez az egyetlen valódi kernel-hiány élő pilothoz — a P0 pontosan ezt pótolja. Utána nincs ok várni.
- **Credential/PII boundary:** P0-ban policy-vé és teszté válik; az observe-adapterek read-only, már-vaultolt tokenekkel dolgoznak.
- **Live event availability:** a capability map szerint minden forrás MA elérhető (kanban_card_events, bus, /api/agents, git, Render deploy-history, /health, token_usage) — nincs mire várni.
- **Idempotency + event loss/duplicate:** a P0 ingest-boundary contract kezeli (dedup-key, at-least-once, számlálók); observe-módban egy elvesztett esemény = riport-hiány, nem kár.
- **Token-origin mérhetőség:** az aggregát dimenziók ma is mérhetők; az origin-split pont az élő pilotban VALIDÁLÓDIK — ezért kell élő pilot, nem több replay.
- **Marveen core érintetlenség:** observe-only = kizárólag read + saját store-write; a pilot-mintázat már bizonyított.
- **Ceremony overhead:** observe-módban LLM~0; ha az overhead mégis nagynak bizonyul, az PONT az az adat, amiért a pilot fut.

**Fogalmi elhatárolás (nem keverendő):** (1) Lean Pilot Kernel validáció = KÉSZ (historical replay); (2) observe-only live pilot = P1, a KÖVETKEZŐ lépés; (3) teljes v0.4 implementáció = P0–P5 összesen, fázisonként kapuzva; (4) production autonómia = A7+, legkorábban P4b után, mindig külön owner-döntéssel.

---

## 9. Komplexitás- és költségkapu

**Minden fázisindítás előfeltétele, hogy az előző fázis MÉRTEN bizonyította:**
- kevesebb vagy azonos emberi koordináció (üzenetszám/change, AS-IS baseline-hoz képest);
- nincs jelentős false PASS (átengedett hibás munka) és nincs jelentős false FAIL (jó munka indokolatlan blokkolása);
- nincs kitalált evidence (invented-evidence számláló = 0, ez azonnali NO-GO);
- a ceremony overhead elfogadható (rekord/consumer arány riportált, consumer-nélküli rekord ~0);
- a token- és runtime-költség mérhető ÉS a keretben van;
- a normál Marveen-flow nem lassult (change-átfutás nem nőtt);
- a capability valóban fogyasztott, nem spekulatív (minden megépült adapter/rekordtípus mögött valós consumer).

**STOP CONDITION-ök (bármelyik → az adott fázis leáll, visszalépés egy szinttel, ok-feltárás):**
1. A sidecar-rekordok >30%-a egy fázis-ablakon át fogyasztó nélkül marad.
2. Az APG több tokent VAGY több koordinációs üzenetet fogyaszt ugyanarra a change-osztályra, mint az AS-IS baseline.
3. Az agentek mérhető munkaidejének nagyobb része methodology-kezelés, mint termékfejlesztés (task-mix riport).
4. A determinisztikus gate-verdiktek >20%-a kézi felülírást igényel egy fázis-ablakban.
5. A profile/adapter-rendszer termékenként ismétlődően product-local kivételeket igényel (kivétel-számláló küszöb felett) — a genericitás megtört.

---

## 10. Local vs upstream határ

**UPSTREAM GENERIC CANDIDATE** (vendor/termék-hardcode nélkül; issue/PR MOST NEM nyílik):
methodology/profile registry · execution receipt contract · checkpoint event interface · authenticated work-event adapter · context/token-origin contract (token-origin dekompozíció — P0-prioritású candidate) · test-identity contract forma · release-strategy + deployment-evidence adapter interface · CostOps↔capacity-resolver interfész · overclaim/claim-lint determinisztikus review-check · intel registry (később).

**LOCAL** (Marveen-példány-specifikus):
az APG sidecar runtime maga · konkrét Marveen-adapterek (kanban/bus/agents/token_usage) · Render provider-adapter · termékspecifikus identity propagation · konkrét analytics adapter (PostHog-kötés) · konkrét rollout-küszöbök · product surface manifestek · minden credential/vault-kötés.

Szabály: upstreamelhető réteg SOHA nem tartalmaz provider/model/termék-hardcode-ot; a vendor-döntés a CostOps capacity-resolverben él.

---

## 11. v0.5 extension-határ

A v0.4 scope-ba NEM épül be előre: **Ralph loop**, **frontend/backend külön delivery lane-ek**, **új top-level artefaktumtípusok**, **többagent-szavazás**. Az extension-pontok additivitása igazolt (lásd matrix-alatti bekezdés): retry-policy pont (bounded iterative execution policy), `requirement.surface`+gate-profil (frontend journey lane / backend domain lane), legalEdges+schema_version bump (integration contract lane). Ezek v0.5 extensionök, nem v0.4-completion feltételek.

---

## 12. Opció-összehasonlítás

| Szempont | **OPTION A** — Stop a Pilot Kernelnél | **OPTION B** — Observe + Assisted (P0–P2) | **OPTION C** — Full staged v0.4 (P0–P5) |
|---|---|---|---|
| Üzleti/operációs érték | audit/replay-eszköz marad; a mai fájdalmakra (false-done, silent-finish, mega-context) NEM hat | a fleet valós fájdalmait célozza: evidencia-alapú javaslatok, kontrollált kanban-írás, bounded kontextus — a napi koordinációt tehermentesíti | a teljes vízió: zero-touch delivery + value-mérés + LCM; a legnagyobb potenciál, de a P3–P5 érték-hipotézise ma MÉG nem mért |
| Implementációs scope | 0 | P0 (~5 WI) + P1 (~6 WI) + P2 (~5 WI) ≈ 16 work item | ≈ 34 work item, 6 fázis |
| Működési költség | 0 | P1: ~0 LLM; P2: napi <15k fresh token nagyságrend (ESTIMATED) | + P3–P5 runner/adapter fenntartás; LLM-költség nettó akár negatív (packet vs mega-session), de ez BIZONYÍTANDÓ |
| Tokenhatás | nincs | mérhetővé teszi a budget-enforcement alapját (GAP-APG-01) | a ≥60% dispatch-kontextus csökkentés itt realizálódna — de csak mért P2/P3 adat után hihető |
| Kockázat | elsüllyedt tanulás; a bizonyított mag nem termel | alacsony: A3-ig minden írás approval mögött; 0 prod-érintés | közepes: az autonómia-lépcső védi, de a fenntartási/komplexitás-kockázat valós (stop-conditionök kellenek) |
| Visszafordíthatóság | teljes | teljes (write-path/ingest kikapcsolható, sidecar törölhető) | fázisonként teljes; A7 után a prod-út is rollback_ref-fel fedett |
| Várható idő | 0 | P0: napok; P1: ~1 hét megfigyelés; P2: ~1-2 hét → ~3-4 hét összesen | +P3–P5: több hét/hónap, mérési ablakokkal |
| Ajánlás | ✗ — a pilot értékét parlagon hagyja | **✓ AJÁNLOTT** — a lean-elv szerint minden további képesség itt "keresi meg a helyét" | (✓) mint IRÁNY igen, de elköteleződésként korai: a P3+ csak P2 mért adata után nyíljon |

---

## 13. Javasolt döntés

**OPTION B — CONDITIONAL_GO.** P0→P1→P2 megépítése fázisonkénti go/no-go kapukkal és a §9 stop-conditionökkel; a P2 zárómérése UTÁN külön owner-döntés a P3-ról (az OPTION C effektíve ekkor válik elérhetővé, már adatokkal). Ez tartja a lean-elvet ("minden komplexitás mérhető haszonnal igazolandó"), miközben a bizonyított kernel azonnal értéket kezd termelni a fleet valódi fájdalompontjain.

---

## 14. Következő egyetlen lépés

**Phase 0 scope-fagyasztás:** a W10–W14 munkacsomagok kikártyázása jóváhagyásra (marveen készíti elő, Istvan hagyja jóvá a P0-indítást). Semmi más nem indul, amíg a P0-elfogadás nincs meg.

---

## OWNER DECISION BLOKK

- **Javasolt opció:** OPTION B (P0–P2), fázisonkénti kapukkal
- **Indok:** a pilot bizonyította a mechanizmust; a P0–P2 a fleet mért fájdalmaira hat (false-done, silent-finish, mega-context, koordinációs teher), minden írás approval mögött, prod-érintés nulla; a P3+ érték-hipotézise csak P2-mérés után ítélhető meg felelősen
- **Következő fázis:** PHASE 0 — Pilot hardening
- **Következő fázis pontos scope-ja:** identity_assertions store-natív perzisztálás (pre-fold) · schema/migration hardening · live ingest-boundary contract (dedup/idempotencia/loss-számláló, MÉG nem élesítve) · credential/PII boundary policy+teszt · backup/recovery/uninstall próba · S1/S2 + AS-IS baseline fagyasztás (W10–W14)
- **Előfeltételek:** nincsenek külső előfeltételek; minden forrás és anyag rendelkezésre áll
- **Out of scope (P0-ban):** minden élő eseményfogyasztás, minden write a sidecaron kívül, minden LLM-hívás, dispatch, kanban-írás, deploy
- **Autonómiaszint előtte → utána:** A0 (historical replay only) → A0 marad; a P0-acceptance az A1-be lépés JOGOSULTSÁGÁT adja meg (az A1 maga a P1-gyel indul)
- **Fő kockázat:** a sémamódosítás megtöri a replay-determinizmust (mitigáció: acceptance-feltétel az azonos replay-eredmény); túl-építés a boundary-contractnál (mitigáció: contract-only, élesítés P1-ben)
- **Cost/complexity limit:** P0: 0 élő LLM-token; ~1–2 nap build-agent munka; ha a P0 egy hétnél tovább csúszik vagy a replay-determinizmus nem áll helyre → STOP és újratervezés
- **Rollback:** sidecar-törlés = teljes eltávolítás (P0-ban próbával újra-igazolva); core-érintés nincs
- **Döntés:** ☐ GO ☐ **CONDITIONAL_GO (javasolt: GO a P0-ra, P1/P2 a saját kapuik mögött)** ☐ NO_GO
