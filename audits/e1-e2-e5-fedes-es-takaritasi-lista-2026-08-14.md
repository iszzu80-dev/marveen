# E.1 / E.2 / E.5 fedés-bizonyíték + ág- és worktree-takarítási lista

**Dátum:** 2026-08-14 · **Készítette:** Marveen · **Kérés:** bizonyíték, nem döntés — a döntés Istvané

Az összevetés a `cos-gate0-eval-89c5e317` (E.1, E.2) és a `cos-e5-escalation` (E.5) ágak
elfogadási pontjai, valamint a `develop` `progression-pipeline.ts` 3./4./6. stage-e között.

---

## 0. A legerősebb egyetlen bizonyíték

A `develop` checkpoint-teszt sorozata: `a`, `b`, `c`, `d`, **`e3`**, **`e4`**.
Nincs `e1`, nincs `e2`, nincs `e5`.

Vagyis az E-sorozat **átugrotta** az E.1/E.2/E.5-öt és folytatódott E.3-mal és E.4-gyel.
Ez kizárja azt az olvasatot, hogy egy másik design-vonal váltotta le őket: ugyanaz a
sorozat ment tovább nélkülük.

---

## 1. E.1 — Rolling planner + Next Best Action (kártya `1ef39b00`, done)

| # | Elfogadási pont | `develop` | Bizonyíték |
|---|---|---|---|
| 1 | Azonos bemenetre azonos terv (determinisztikus) | **RÉSZBEN** | `buildRollingPlan()` determinisztikus, de **állapot-sablonból**: a docstring szó szerint „deterministic plan template per case status — no replanning triggers, no LLM planner". Az ág a **cél szövegéből** vezeti le a tervet |
| 2 | Domain-scoped (domainGuard minden olvasás előtt) | **FEDVE** | `progression-resolver.domainGuard` + `resolveContextDeep`, a pipeline importálja |
| 3 | Csak PLAN objektum, sosem hajt végre | **FEDVE** | `buildRollingPlan()` `RollingPlanStep[]`-et ad vissza; a fájl fejléce tiltja az e-mailt/dispatch-et/fizetést |
| 4 | RED: ZST-ügy terve nem olvas PRI-t (`CrossDomainReadError`) | **FEDVE** | `CrossDomainReadError` létezik és exportált a resolverből |
| 5 | RED: a tervező kimenete nem hordoz végrehajtható mellékhatást | **FEDVE** | strukturálisan: a lépés csak `label` + `kind` + `needsExternal` |
| 6 | Next Best Action | **FEDVE** | pipeline 296–311: „Pick the Next Best Action from the rolling plan, skipping steps that…" |
| 7 | Cél-dekompozíció (≥2 lépés többtagú célra, „és"/„majd" bontás, GATHER_INFO/EXECUTE osztályozás) | **NINCS FEDVE** | `buildGoalDrivenPlan` a `develop`-en 0 találat, az ágon 4 |
| 8 | `derivedFromGoalHash` szemantika (cél-szöveg hash, nem ügyállapot) | **NINCS FEDVE** | `derivedFromGoalHash` a `develop`-en 0 találat, az ágon 4 |

**Összegzés:** a *keret* megvan (terv-objektum, NBA, domain-guard), a *tartalom* nem. A `develop`
terve az ügy STÁTUSZÁBÓL jön, generikus címkékkel („Classify and prioritize the case"), az ágé a
CÉL SZÖVEGÉBŐL. Ez nem átnevezés, hanem másik bemenet.

---

## 2. E.2 — Progression Controller (kártya `ff0ee545`, done)

| # | Elfogadási pont | `develop` | Bizonyíték |
|---|---|---|---|
| 1 | Tickenként idempotens | **FEDVE** | `acquireClaim`/`releaseClaim` + `runId`, és van `cos-progression-claim-fence.test.ts` |
| 2 | Tiszteli a `progression_mode`-ot (off/shadow/internal) | **NINCS FEDVE** | a `develop`-en **egyetlen** `mode === 'off'` ág sincs; a mód csak íródik (seed/intake/migrate/scheduler), nem olvasódik döntéshez. A `progression_enabled = 1` szűrés két helyen van (`goal-enrichment`, `owner-question`), ez nem ugyanaz |
| 3 | Csak legális átmenettel lép | **FEDVE** | kizárólag `transitionCase`, három nevesített helyzetben (BLOCKED / READY / COMPLETED) |
| 4 | RED: `mode=off` ügy sosem lép | **NINCS FEDVE** | nincs `off`-ág, tehát nincs mit bizonyítani — és nincs teszt sem |
| 5 | RED: félbeszakadt tick konzisztens állapotot hagy | **RÉSZBEN** | a claim-fence teszt ezt a szomszédos tulajdonságot fedi, de nem a részleges írást |

**Összegzés:** a vezérlő létezik és fut. A **kikapcsolhatósága** nem: egy `progression_mode='off'`
ügyet ma semmi nem állítana meg a pipeline szintjén.

---

## 3. E.5 — Strukturált eszkaláció (kártya `59c06cbc`, done)

| # | Elfogadási pont | `develop` | Bizonyíték |
|---|---|---|---|
| 1 | `case_escalations` tábla strukturált rekordokkal | **NINCS FEDVE** | `case_escalations` a `develop`-en 0 találat. Ami van: `zst_product_escalations` (a §23 Product Lab híd, más cél) és egy `escalation_id` oszlop a run-soron |
| 2 | Az eszkaláció naplózódik, sosem kerül kézbesítésre | **NINCS FEDVE** | eszkaláció csak DÖNTÉS-értékként létezik: `RECOVERY_REQUIRED`, „External wait exceeded 7 days; escalation needed". Rekord nem keletkezik |
| 3 | Prompt-injektált tartalom nem gyárthat akciót hordozó eszkalációt (EXECUTE/SEND/CALL tiltás, hosszkorlát, injection-marker) | **NINCS FEDVE** | az ág `progression-escalation.ts`-e négy védelmi réteget ír le; a `develop`-en a modul nem létezik |

**Összegzés:** az E.5-ből semmi nem landolt. Ami a `develop`-en „eszkaláció", az egy státusz-döntés,
nem egy rekord, és nincs rajta injekció-védelem.

---

## 4. Amit ebből a döntéshez érdemes tudni

- A három kártya `done`, a kód hat napja ágon áll. **Egyik sem superseded**, mert a sorozat
  E.3/E.4-gyel folytatódott nélkülük.
- A leglényegesebb hiány nem a tervező, hanem a **`mode='off'` nem létezik**: egy „kapcsold ki
  ezt az ügyet" utasításnak ma nincs helye a pipeline-ban.
- A második az **E.5 injekció-védelme**: az eszkalációs szöveg ma nem megy sehova, de amint
  menni fog, védelem nélkül indul.

---

## 5. Takarítási lista — ELŐKÉSZÍTVE, NEM VÉGREHAJTVA

### 5.a Ágak, amelyeknek nulla saját commitjuk van (patch-id szerint) — 32 db

`backup/before-costops-live-dashboard`, `backup/costops-dashboard-clean-v1.19.0`,
`backup/costops-v1.19.0-integrated`, `cos-e3-wait-wake`, `cos-progression-mc-view`,
`cos-progression-thin-slice`, `cos-toggle-layout-db707fcf`, `cos-wp0-audit-b12e79f2`,
`cos-zst-mission-control-e237797d`, `costops-decommission-retry`,
`feat/apg-0.4-lean-ui-followup`, `feat/apg-0.4-lean-ui-integration`,
`feat/cos-reader-live-wire`, `feat/cos-sheet-projection`, `feat/costops-fx-usd-guard`,
`feat/lean-opt-phase2-p2a`, `feat/lean-opt-phase2-p2b`, `feat/lean-opt-phase2-p2c`,
`feat/lean-opt-phase2-stamp`, `fix/apg-age-seconds-epoch-bug`,
`fix/costops-data-freshness-320c477a`, `fix/costops-multi-invoice-sum-dec9ae64`,
`fix/evidence-gate-absence-predicate-9682c5ee`,
`fix/evidence-gate-comma-conjunction-clause-bc6b2b98`,
`fix/evidence-gate-gitignore-filter-dc0fb6f0`, `fix/monitor-release-local-deps`,
`fix/wsl-host-stability`, `frontendfejleszto/mc-tiles-3d9d62b1`,
`pr/context-saturation-dispatch-guard`, `preserve/item3-6358d59`, `zst-reconcile-coverage`

**Kivétel:** a `main` ág is ebbe a halmazba esett, de **nem törlendő**.

### 5.b Ágak, amelyek „unmerged"-nek látszanak, de a tartalmuk bent van — 6 db

| Ág | Látszó commit | Valóság |
|---|---|---|
| `pr/costops-ui-command-center` | 17 | 0 olyan fájl, ami a `develop`-en ne lenne |
| `rb/costops-660` | 16 | ugyanaz a verem |
| `upstream/costops-pr-f-ui-command-center` | 12 | ugyanaz |
| `costops-rebased` | 11 | ugyanaz |
| `rb/costops-prb` | 11 | ugyanaz |
| `upstream/costops-pr-b-forecast-fx` | 8 | ugyanaz |

### 5.c Worktree-k — 31 db a főcheckouton kívül

**Törölhető (0 saját commit, tiszta munkafa) — 14 db:**
`cos-e3-wait-wake`, `cos-progression-thin-slice`, `cos-toggle-layout`,
`costops-decommission-retry`, `marveen-suite-worktrees/mc-tiles-3d9d62b1`,
`marveen-worktrees/apg-0.4-lean-ui`, `marveen-worktrees/apg-age-seconds-fix`,
`marveen-wt/cos-reader-wire`, `marveen-wt/costops-fx-guard`, `marveen-wt/p2a`,
`marveen-wt/p2b`, `marveen-wt/p2c-collect`, `marveen-wt/p2c-stamp`, `zst-reconcile-wt`

**Törölhető, de PISZKOS munkafával (előbb nézd meg, mi van benne) — 3 db:**
`cos-wp0-audit` (1 fájl), `marveen-wt/sheet-proj` (1), `.claude/worktrees/cos-progression-mc-view` (4)

**MEGTARTANDÓ (valódi, nem landolt munka) — 14 db:**
`cos-e4-completion-hotfix` (1), `cos-e5-escalation` (1), `cos-gate0-eval` (3, +1 piszkos),
`cos-review-fixes` (2, +10 piszkos), `marveen-costops-slices` (8),
`marveen-worktrees/pr-mem` (3), `marveen-worktrees/pr-procl` (1),
`marveen-worktrees/pr-ui` (17), `marveen-wt/costops-rebase` (11),
`marveen-wt/lean-opt-phase1` (3), `.claude/worktrees/agent-adbdd0eef2198575f` (4),
`.claude/worktrees/cos-stagnation-fix` (2), `.claude/worktrees/monitor-cd-rework` (1),
`.claude/worktrees/p0-monitor-cd-clean` (1, +2 piszkos)

**Sorrend, ha törlésre kerül a sor:** előbb `git worktree remove`, csak utána `git branch -d`.
Egy ághoz kötött worktree megakadályozza az ág törlését, és a fordított sorrend árva
worktree-bejegyzést hagy.
