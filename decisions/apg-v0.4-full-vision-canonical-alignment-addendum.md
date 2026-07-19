# APG v0.4 — Kanonikus alignment addendum a full-vision expansion decision-höz

**Dátum:** 2026-07-16 · **Készítette:** marveen (Opus 4.8) · **Owner:** Istvan
**Típus:** ADDENDUM — a `decisions/apg-v0.4-full-vision-expansion-decision.md` NEM módosul, ez a dokumentum korrigálja annak a korábbi (2026-07-13-as) részletes architektúrából átszivárgott elemeit a Lean v0.4 kanonikus modelljére. Nincs implementáció, nincs kártya, nincs dispatch, nincs core/sidecar-módosítás, nincs commit/deploy, nincs upstream issue/PR.

**Kanonikus forrássorrend (eltérés esetén ez dönt):**
1. Lean APG v0.4 methodology pack + schemas (`~/marveen-local/apg-methodology-v0.4-lean/` — methodology.yaml v0.4.0, artifact.schema.json, kind-contracts.yaml, transitions/, policies/)
2. Validált Pilot Kernel component contracts (`design/apg-v0.4-pilot-kernel-component-contracts.yaml`)
3. W1–W9 tényleges implementáció + tesztek (`~/marveen-local/apg-kernel/`)
4. Full-vision expansion decision (`decisions/apg-v0.4-full-vision-expansion-decision.md`)
5. `design/2026-07-13-marveen-autonomous-product-graph-architecture.md` — HÁTTÉRANYAG, a lean egyszerűsítéseit nem írhatja felül.

---

## 1. Eltérések listája és kanonikus döntés mindegyiknél

| # | Eltérés a decision-dokumentumban | Forrása | Kanonikus döntés |
|---|---|---|---|
| D1 | „19 canonical objektumtípus + legalEdges" (§4 hivatkozás, v0.5 extension-igazolás) | 2026-07-13 architektúra | **12 top-level artifact type** + profile-specifikus fogalmak `resource`/`evidence`/`review` KINDOK alatt (lásd §2). A Pilot Kernel store MÁR a 12-es modellen fut — a decision-doc szövege volt kontaminált, nem az implementáció. Nincs migráció, nincs compatibility projection. |
| D2 | „16 lifecycle-fázis" Product LCM-ként (§4 célállapot-leírás, Phase 5 scope) | 2026-07-13 architektúra | Product LCM = **7 makroállapot** (§3). A Change Delivery **KÜLÖN FSM** (11 állapot, 5 checkpoint). A 16-fázisú monolit NEM kanonikus v0.4; a Phase 5 a `product_lcm` FSM-et implementálja, nem a 16-lépcsőst. Nincs breaking schema/FSM-igény. |
| D3 | „minden fázis-kilépésen … szemantikus LLM-verifier MÁSIK agenttel" (univerzálisan) | 2026-07-13 architektúra | **Risk-alapú semantic gate** (§4): deterministic first; egy producer agent az alapértelmezés; semantic verifier CSAK a kockázati profil által indokolt checkpointon; legfeljebb EGY független verifier; low-risknél tipikusan NOT_REQUIRED. |
| D4 | Upstream/local besorolások: overclaim-gate „P0-prio upstream", intel registry „UPSTREAM_GAP / LO", staging-canary „upstream candidate P2" | capability-map + upstream-candidates audit | Korrigált kanonikus besorolás (§6): intel registry **AVAILABLE**; APG↔intel bridge **későbbi ADAPTER**; overclaim-review **OPTIONAL_IMPROVEMENT**; staging/canary **provider-/product-local**; generikus upstream candidate: **release-strategy-and-deployment-evidence-adapter-interface**. Phase 0 alatt semmilyen upstream issue nem nyílik. |
| D5 | `identity_assertions` mint „tábla" közelebbi típus-besorolás nélkül | decision-doc W10 | Az identity assertion **NEM új top-level artifact type** (§5/W10): sidecar-store-natív, append-only mérési tábla + kanonikus felszínre vetítéskor a meglévő **`evidence` típus `identity_isolation` kindja** alatt él. A 12-es típuslista változatlan. |
| D6 | Owner-approval bucket-lista a régi architektúra §14-éből | 2026-07-13 architektúra | A kanonikus `policies/autonomy.yaml` bucket-lista érvényes, amely TÖBB: + `first_public_go_live`, + `public_registration_enable`, + `critical_release` (a mai reg-zárási döntésekkel összhangban). |
| D7 | Komponens-nevek („Graph Runner", „Approval Broker", „Context Router") a régi architektúrából | 2026-07-13 architektúra | Elnevezés-szintű: a kanonikus egység a lean pack contract-készlete (receipt adapter, checkpoint evaluator, profile registry, token-origin adapter stb.). A régi nevek háttér-terminológiaként érthetők, de a fázis-tervek a lean contractokra hivatkoznak. |

---

## 2. A pontos 12 top-level artifact type (kanonikus)

Forrás: `schemas/artifact.schema.json` (enum, mind a 12 oneOf-ágban azonos) + `methodology.yaml: canonical_artifact_types: 12`.

```
product · change · requirement · decision · work_item · implementation
· resource · evidence · release · metric · review · approval
```

**Kindok a három konténer-típus alatt** (`schemas/kind-contracts.yaml` v0.4.0):
- **resource** (10): business_definition, market_fact, external_ui, snapshot, data_contract, test_identity, demo_dataset, product_surface_manifest, environment, design_system
- **evidence** (11): test_run, build, deployment, runtime, visual, accessibility, security, **identity_isolation**, analytics, dependency_license, release_health
- **review** (9): semantic_acceptance, code_audit, maturity_assessment, reuse_decision, parity_assessment, product_review, gap_assessment, security_review, architecture_review

**A Pilot Kernel store tényleges támogatása:** `canonical_artifact_versions.kind` — kommentben explicit: „one of the 12 APG kinds"; az edge-írás az `edge-policy.yaml` ellen validál. **Eltérés a kernel és a lean séma közt: NINCS** — a kernel a lean modellen épült. A régi 19-es típuslista (market_fact, build, deployment, product_review stb. top-levelként) a lean-ben kindokká olvadt: `market_fact`/`business_definition` → resource-kind, `build`/`deployment`/`runtime_evidence` → evidence-kind, `product_review` → review-kind, `task` → `work_item`, `scenario` → a requirement acceptance/scenario-mezői. Migráció/compatibility projection: **nem szükséges**.

**Phase 0 nem ad hozzá új top-level típust.** Az `identity_assertions` (lásd §5/W10) store-belső tábla, kanonikus vetülete evidence/identity_isolation.

---

## 3. Kanonikus Product LCM ↔ Change Delivery kapcsolat

**Product LCM = 7 makroállapot** (`transitions/product-lcm.yaml`):
`concept → validating → active → scaling → pivoting → sunsetting → archived`
(pivoting: owner_approval=product_pivot; sunsetting: owner_approval=product_sunset; archived terminális). Kanonikus szabály a fájlból: *„Multiple changes may run concurrently while the product remains active; product state is not change-delivery state."*

**Change Delivery = KÜLÖN FSM** (`transitions/change-delivery.yaml`, 11 állapot):
`proposed → specified → ready → implementing → verifying → release_ready → releasing → observing → accepted` (+ `returned` javító-hurok, + `cancelled`), 5 checkpointtal: `spec_ready, implementation_ready, verification_ready, release_ready, runtime_acceptance`. Kanban-done = `work_item.state=produced`, soha nem elfogadás.

**Research/business/design megjelenése:** NEM lifecycle-állapotok, hanem (a) **artefaktumok** — resource/market_fact, resource/business_definition, review/architecture_review, requirement + design-jellegű resource-ok (design_system, external_ui); (b) **work itemek** a change-delivery `specified` szakaszához kötve; (c) **visszatérési döntések** — `decision` típusú artefakt, amely a change-et `returned`-be, a hipotézist a `hypothesis` FSM-be, terméket szükség esetén `validating`/`pivoting` felé lépteti. A 16-lépcsős monolit így strukturálisan elkerült: a régi 16 fázisból a termék-szintűek a 7 makroállapotba, a szállítás-szintűek a change-delivery FSM-be, a tevékenység-jellegűek artefakt+work-item+decision hármasba képződnek le.

**Phase 5 pontosan a `product_lcm` FSM-et implementálná** (7 állapot + product_review checkpoint-kör + hypothesis FSM), NEM a 16 fázist. Mivel a kernel-séma és a contractok már lean-konformak, a 16-fázisú modell megtartása lett volna a breaking változás — ezt az addendum kizárja.

---

## 4. Risk-based semantic gate szabály (kanonikus)

Forrás: `policies/gate-profiles.yaml` + methodology principles (`deterministic_before_llm`, `single_agent_by_default`, `multi_agent_only_for_measured_parallel_value`).

- **Deterministic first, mindig:** minden checkpoint determinisztikus check-listája LLM nélkül fut (schema/referencia-integritás, teszt-mátrix, commit-lánc-konzisztencia, rollback-ready, smoke, metric-kizárások stb.).
- **Egy producer agent az alapértelmezés.** Többagent-munka csak mért párhuzamossági értékre.
- **Semantic verifier CSAK kockázat szerint**, checkpointonként (a profilfájl szó szerint):
  - `spec_ready`: low=none · standard=only_when_ambiguity_flagged · high/critical=one_independent_review
  - `implementation_ready`: low/standard=none · high/critical=one_independent_review
  - `verification_ready`: low=none · standard=one_change_level_review · high/critical=one_independent_diverse_verifier
  - `release_ready`: low/standard=none · high/critical=one_independent_release_review
  - `runtime_acceptance`: low/standard=none · high/critical=only_for_unresolved_experience_or_intent
  - `product_review`: low=none · standard=only_for_recommendation_synthesis · high/critical=recommendation_synthesis
- **Legfeljebb EGY független verifier** — homogén többagent-szavazás nincs (v0.5-ben is kérdéses).
- **Human approval kizárólag explicit bucketnél** (autonomy.yaml owner_approval lista, D6 szerinti teljes változat).
- A decision-doc „minden fázishoz külön semantic verifier MÁSIK agenttel" megfogalmazása ezzel **korrigált**: az a high/critical eset, nem az alapértelmezés.
- **Phase 0 LLM/agent-overhead: 0** — a P0 minden work iteme determinisztikus kód+teszt; semmilyen semantic verifier, dispatch vagy LLM-hívás nem része.

---

## 5. Kanonikus W10–W14 felosztás (Phase 0, 5 work item)

**W10 — Native identity assertion persistence**
Nyers, PRE-FOLD per-check státusz (PASS/FAIL/UNKNOWN/MISSING) perzisztálása a sidecar store-ban: `actor_class`, `tenant_class`, `data_class`, `test_run_id`, `environment`, treatment-mezők (analytics/billing/communication — a resource/test_identity kind-contract mezőivel összhangban), source digest/locator (soha raw payload/secret), replay- és evidence-kapcsolat (replay_run_id + evidence_reference link), append-only + idempotens írás. Kanonikus tárolás: **store-natív tábla; kanonikus vetülete evidence/identity_isolation kind — NEM új top-level típus.**

**W11 — Schema és migration hardening**
Az identity-assertion migráció; schema_version tábla; migration checksum; integritás-check (FK/edge-policy/append-only invariánsok); historical replay compatibility (S1/S2 változatlan eredmény az új sémán); az idempotens retry/recovery-hez szükséges store-primitívek (attempt/lease/resume-mezők) — **live runner NÉLKÜL**.

**W12 — Live ingestion boundary contract**
Envelope-definíció; source event ID; dedup/idempotencia-kulcs; out-of-order kezelés; loss/sequence-gap számlálás; conflict-szabály; quarantine/reject út. **Contract + tesztek — élő connector vagy loop MÉG NINCS.**

**W13 — Credential és PII boundary**
Allowlist/denylist az adapter-inputokra; JWT/bearer token/cookie/API key/szükségtelen PII tiltás; digest/locator-only evidence elv enforce-olva; product-local adapter privacy contract forma; determinisztikus NEGATÍV tesztek (tiltott mező írási kísérlete → reject).

**W14 — Backup/recovery/uninstall és Phase 0 baseline acceptance**
Backup/restore próba checksummal; schema-kompatibilitás ellenőrzés; teljes uninstall-próba; Marveen-core változatlanság igazolása; S1/S2 replay újrafuttatás; baseline freeze (S1/S2 + AS-IS token-baseline); Phase 0 acceptance összeállítás; **A1-re való jogosultsági VERDIKT kiadása** (maga az A1-indítás külön Phase 1 owner-döntés).

---

## 6. Korrigált local/upstream besorolás (kanonikus)

| Elem | Kanonikus besorolás |
|---|---|
| Intel registry | **AVAILABLE** (a meglévő research/business deliverable-ök + idea_box + memories mint forrás-anyag; a lean market_fact resource-kind ebből táplálható) |
| APG ↔ intel bridge | **későbbi ADAPTER** (nem Phase 0–2 tétel) |
| claim-provenance-and-overclaim-review | **OPTIONAL_IMPROVEMENT** (nem P0-prioritású upstream candidate) |
| Konkrét staging/canary infrastruktúra | **provider-/product-local** (nem generikus upstream) |
| Generikus upstream candidate | **release-strategy-and-deployment-evidence-adapter-interface** |
| Minden további, a decision-docban felsorolt candidate (token-origin contract, CostOps capacity-resolver interfész, execution-receipt contract, checkpoint event interface, test-identity contract forma, profile registry) | candidate-státuszban marad, de **Phase 0 alatt semmilyen upstream issue nem nyílik**, és a P0 semmit nem függeszt rájuk |

---

## 7. Kanonikus függőségi gráf (Phase 0)

```
W10 ──► W11 ──┬──► W12 ─┐
              ├──► W13 ─┤
              └──► W14 (backup/recovery ELŐKÉSZÍTÉS) ─┤
                                                       ▼
                        W14 ZÁRÓ RÉSZ: minden hardening-teszt
                        → baseline freeze → Phase 0 acceptance
```

Kötelező sorrend-szabály: **a W14 végső acceptance NEM záródhat le a W12 és W13 elfogadása előtt** (a W14 előkészítő része — backup/recovery próbák — párhuzamosan futhat a W12/W13-mal, de a baseline freeze + acceptance-verdikt mindhármuk zöldjét megköveteli).

---

## 8. OPTION B változatlanságának igazolása

Az addendum a stratégiai döntést **nem változtatja meg**:
- **OPTION B marad** — Phase 0–2, fázisonkénti go/no-go kapukkal;
- Phase 3–5 kizárólag a Phase 2 MÉRT eredménye + külön owner-döntés után nyílhat;
- **Phase 0 alatt az autonómiaszint A0 marad** — a W14 csak a jogosultsági verdiktet adja ki;
- **A1 (observe-only live) csak külön Phase 1 owner-döntéssel indul**;
- v0.5 extensionök (Ralph loop, frontend/backend lane-ek, új top-level artefaktumtípusok, többagent-szavazás) **továbbra is out of scope**;
- a §9 stop-conditionök és a komplexitás/költség-kapuk változatlanul érvényesek.
A korrekciók a P0-t egyszerűsítik vagy pontosítják (12 típus már adott, 0 LLM-overhead megerősítve, identity-tábla nem típusbővítés) — egyik sem növeli a scope-ot vagy a kockázatot.

---

## 9. Phase 0 kártyázás előtti readiness verdict

**READY_FOR_PHASE0_CARDING.**

Indoklás: (1) minden D1–D7 eltérés kanonikus döntéssel zárult, egyik sem igényel kód- vagy séma-migrációt (a kernel eleve lean-konform); (2) a W10–W14 scope a kanonikus modellre igazítva, függőségi gráffal; (3) a Phase 0 LLM/agent-overheadje nulla, core-érintése nulla, teljes uninstall-lal fedett; (4) az OPTION B stratégiai keret érintetlen. A kártyázás (W10–W14 kanban-kártyák elkészítése) a KÖVETKEZŐ lépés, és Istvan explicit GO-jára vár — ez az addendum maga NEM hozott létre kártyát.
