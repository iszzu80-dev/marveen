# Marveen fejlesztési és Product Lifecycle Management (Product LCM) — AS-IS AUDIT

**Dátum:** 2026-07-13 | **Típus:** kizárólag AS-IS audit (nincs TO-BE terv, nincs implementáció, nincs módosítás) | **Kérte:** Istvan (indok: több hiba + korábbi megegyezés elfelejtése a fejlesztési folyamattal kapcsolatban)

**Módszer:** 5 párhuzamos read-only vizsgálat (dev-process/kanban/gates; automatizmusok/continuity; Product LCM; source→build→deploy; context/token) + a fő-orchestrator (marveen) közvetlen működés-közbeni megfigyelései a 2026-07-12 éjszaka → 07-13 délelőtt session-ből. Minden token-szám determinisztikus (char/4). A bizonytalanságok UNCERTAIN-nel jelölve.

---

## 1. Executive summary

Marveennek van egy **valós, működő, evidence-alapú fejlesztési FRONT-fele** (igény → kanban → dispatch → build → deploy Renderre) és egy **erős automatizmus-réteg** ami mozgásban tartja a munkát. De három strukturális igazság magyarázza a "hibák + elfelejtett megegyezések" tapasztalatot:

1. **A folyamat majdnem teljes egésze KONVENCIÓ, nem kikényszerített kód.** A 19-lépéses dev-láncból mindössze **3 link determinisztikus** (kártya→agent dispatch, inter-agent üzenet-kézbesítés, post-hoc fájl-létezés-ellenőrzés). Az acceptance-criteria-tól a runtime-verifikációig minden LLM-agentek által követett szokás, amit semmi kód nem tud blokkolni. A "done" **önbevallott** (`db.ts:1426` feltétel nélkül elfogadja; a dispatch-instrukció szó szerint azt mondja az executornak: "a done-t TE jelezd").

2. **A teljes előre- és hátrahaladás EGYETLEN LLM-döntésen áll.** Minden "következő fázis létrehozása", "QA/build/deploy-hiba utáni visszairányítás", és "visszalépés research/business/design fázisba" a `maestro-backlog-review` 30-percenkénti LLM-promptjában él (deliverylead agent), nem determinisztikus kódban. Ha ez az egy agent leáll, saturálódik, vagy félreítél, semmi nem történik; az egyetlen determinisztikus háló egy 90-perces teljes-csend nudge, aminek ugyanaz az agent kell hogy reagáljon rá.

3. **A Product LCM hát-fele (measure → optimize → reprice → kill) lényegében HIÁNYZIK.** A CostOps kiválóan méri a KÖLTSÉGET, de semmi nem méri az ÉRTÉKET: nincs business-KPI-gyűjtés (signup/activation/conversion/retention/revenue), nincs kill/sunset/pivot mechanizmus, a pricing nem cost-aware. A "build→launch→measure→optimize" hurok a MÉRÉS lépésnél nyitott.

**Mai élő megerősítés (a session-ből):** ezen a délelőttön a proto-floor gate visszaállítása után a gate **valós, prototípus-alatti hiányokat fogott** (MK bevétel-lista backend van/frontend nincs bekötve = FM-06; QQ ÁFA-választó 4→2 vágva; QQ ügyfél-directory teljesen hiányzik), amiket a korábbi (megcsúszott) folyamat CSENDBEN átengedett — plusz egy "done" false-green (MK gate CLOSED landing-hez mérve, majd visszavonva proto-fájlhoz mérve = FM-10), és egy sign-off nélküli nav-drift (sidebar→top-tabs, nincs rekord = FM-01). Ezek nem hipotézisek: ma történtek.

**Kritikus problémák száma: 17** (5 dev-process + 5 continuity + 5 Product-LCM + 2 keresztmetsző: bus-sender-auth + token-duplikáció). Részletek a 32. szekcióban.

---

## 2. Audit hatóköre és vizsgált források

- **Kód/config:** `src/web/schedule-runner.ts`, `src/web/channel-monitor.ts` (:1474 reconcile), `src/kanban-dispatch.ts`, `src/web/routes/kanban.ts` (:63 dispatch), `src/web/routes/messages.ts`, `src/web/message-router.ts`, `src/web/agent-message-wrap.ts`, `src/db.ts` (:1426 moveKanbanCard, :436 origin_note).
- **Scheduler:** `~/.claude/scheduled-tasks/*/{task-config.json,SKILL.md}`; host crontab (3 untracked script); 2 systemd user timer.
- **Scriptek:** `scripts/{fleet-memory-gate,dispatch-guard,fleet-resume-guard,fleet-context-guard,inter-agent-evidence-gate,stale-instructions-detect/guard}.*`, `store/autonomy-config.json`.
- **Termék-repo:** `/home/iszzu/marveen-suite` (`render.yaml`, `apps/web`, `apps/api`, `packages/core`), Render API (read-only GET, 8 suite-szolgáltatás).
- **Adat:** `store/claudeclaw.db` (kanban_cards 964 kártya, agent_messages, memories 1,445 sor, daily_logs, task_runs), `~/.claude-personal/.../memory/` (140 fájl).
- **Skillek:** `~/.claude/skills/` (86 skill), `fleet-product-build-playbook`.
- **Nem csak dokumentáció alapján:** a tényleges kód/config/ütemezés/DB/runtime is ellenőrizve a dokumentált folyamattal szemben.

---

## 3. A tényleges AS-IS end-to-end folyamat (áttekintés)

```
[Istvan TG / ötlet]
   │  (DOC: "vedd fel a kanbanra" — semmi nem kényszeríti ki → FM-01)
   ▼
[kanban_cards: planned]  ── PUT status bypass-olja a dispatch+event-log-ot
   │  move→in_progress  ⇒ fireKanbanDispatch (CODE, single-shot, silent-drop ha agent down)
   ▼
[assignee agent tmux-be injektált prompt]  ←── inter-agent bus (CODE delivery, NO sender-auth)
   │  business→ba→architect(spec)→uxui(design)→Mason/Pixel(impl)  (mind DOC/skill, nem gate)
   ▼
[impl] → code-review(DOC) → QA(DOC) → build(DOC) → deploy(CODE: Render autoDeploy main) → runtime(DOC/ad-hoc)
   │  ⇧ NINCS kód-gate ami blokkolná az előrehaladást hiányzó AC/teszt/runtime esetén
   ▼
[status=done]  ── ÖNBEVALLOTT (db.ts:1426 feltétel nélkül)
   │  post-hoc: done-evidence-gate (CODE, csak fájl-név-létezés, 30-perc késés, reopen)
   ▼
[deploy után]  ── NINCS automatikus runtime-reachability check; NINCS business-KPI mérés
   │
   ▼
[következő lépés]  ── maestro-backlog-review (LLM prompt, */30, deliverylead) dönti el MINDET:
                       next-phase-card létrehozás / QA-fail-return / research-business-visszalépés
                       determinisztikus háló: csak 90-perc-csend nudge + done-evidence reopen
```

**A lánc három determinisztikus pontja:** (1) `move→in_progress` → dispatch; (2) bus üzenet-kézbesítés; (3) post-hoc fájl-létezés-ellenőrzés. Minden más LLM-konvenció.

---

## 4. A fejlesztési folyamat fázisonként (enforced vs documented)

Jelölés: **CODE** = determinisztikus kód/script gate; **DOC** = CLAUDE.md/skill konvenció, csak agent-követett; **NONE** = nincs artefaktum.

| Fázis | Létezik | Kikényszerítés | Felelős |
|---|---|---|---|
| Igény-rögzítés | igen | **DOC** (CLAUDE.md "vedd fel a kanbanra") | marveen/Istvan |
| Business/igény-pontosítás | igen | **DOC** (playbook §1) | business/ba |
| Acceptance criteria (AC/DoR) | igen | **DOC**; nincs kártya-mező, nincs check | ba |
| UX/UI design | igen | **DOC** (playbook §4 design-gate) | uxui/Muse |
| Technikai/arch spec | igen | **DOC** (spec-to-build-handoff skill) | architect/Atlas |
| Task-breakdown | igen | **DOC** + parent_id epic/child | deliverylead |
| Kanban create + delegate | igen | **CODE** részben (assignee + fireKanbanDispatch) | kód |
| Inter-agent handoff | igen | **CODE** (message-router tmux inject) | kód |
| Backend/frontend impl | igen | **DOC** | Mason/Pixel |
| Code review | igen | **DOC** (pre-pr-review.sh, /security-review skill; nem gated) | architect |
| QA/teszt | igen | **DOC** (playbook §5); nincs kód-gate a státuszon | QA/Falcon |
| Build | igen | **DOC** | build agent |
| Source-vs-build check | részben | **DOC** (memória-nehéz); 1 kód-mező (check-kata-sync) | ad-hoc |
| Deploy/restart | igen | **CODE** (Render autoDeploy main, pre-authorized) | marveen/devops |
| Runtime-verifikáció | igen | **DOC/ad-hoc** (Playwright on-request, UAT skillek) | ad-hoc |
| **Done státusz** | igen | **ÖNBEVALLOTT** (db.ts:1426) | maga az executor |
| Docs/memória/retro | igen | **DOC** (retrospective skill) | minden agent |
| Következő-lépés trigger | részben | **DOC/LLM** (maestro prompt) | deliverylead |

**Kulcs:** csak 3 link CODE; minden az AC-től a runtime-ig konvenció. `kanban_cards` séma státuszai: planned/in_progress/**testing**/waiting/done — a `testing` a sémában van de a CLAUDE.md-ben NINCS dokumentálva (doc-vs-séma drift, UNCERTAIN használják-e).

---

## 5. Folyamatfolytonosságot biztosító automatizmusok

Három független ütemezési réteg:
- **L1 dashboard schedule-runner** (`schedule-runner.ts`, 60s interval): `~/.claude/scheduled-tasks/*` cron-match; command-scriptet futtat VAGY LLM-promptot injektál agent tmux-be. Restart-kor 30-perc catch-up. Busy-skip → `pending_task_retries` DB, soha nem hagyja el.
- **L2 host crontab** (dashboard-tól független, túléli a dashboard halálát): `fleet-resume-guard.sh` (*/3), `fleet-context-guard.sh` (*/5), `suite-checkout-ff-guard.sh` (*/5) + 2 systemd timer (costops-sync 06:15, morning). **Mindhárom cron-script UNTRACKED** (`.git/info/exclude`) — lokális, git-láthatatlan.
- **L3 channel-monitor reconcile** (`channel-monitor.ts:1474`, 60s): halott desired-agent session-öket újraindít, 15s staggered, `fleet-memory-gate.sh`-gated (fail-open).

Determinisztikus vs LLM megoszlás: lásd 6. szekció táblázata. **A momentum-motor (a "mi következik" válasza) egyetlen LLM-prompt:** `maestro-backlog-review` (deliverylead, */30, 621 fire/24h a task_runs szerint). Ez dispatch-el minden planned/in_progress-t, WAITING-AUDIT-ol (a 6h-éjszakai-stall fixe), LIFECYCLE-előretol (hiányzó next-stage kártya létrehozása), és kétirányú feedbacket csinál (QA/analytics/market jel → research/business/UX re-entry kártya, Istvan-jóváhagyás nélkül). **Mind LLM-értelmezett, semmi kódban.**

---

## 6. Heartbeat / scheduled-task / watchdog / agent-autonómia térkép

| Név | Impl | Cron | Runner | Determ/LLM | Kanban-t módosít | Agentet aktivál | Visszalép fázisba | Emberi jóváhagyás |
|---|---|---|---|---|---|---|---|---|
| maestro-backlog-review | SKILL.md | */30 | deliverylead | **LLM** | igen (create+dispatch) | igen | **igen (prompt)** | nem (önvezérlő) |
| kanban-audit | SKILL.md | 0 8,12,16,20 | marveen | LLM | archive/nudge | nudge | nem | config-gated (level 2) |
| fleet-stall-detector | check.py | */20 | command | **Determ** | csak olvas + 1 nudge | nudge deliverylead | nem | nem (90-min csend) |
| done-evidence-gate | check.py | 10,40 | command | **Determ** | **auto-reopen done→waiting** ha fájl hiányzik | nudge | reopen only | triage |
| build-done-monitor | check.py | 15,45 | command | Determ | comment | TG notify | nem | notify only |
| context-watchdog | check.sh | 20,50 | command | Determ | nem | **restart agent** | nem | quarantine only |
| limit-revive | check.sh | */30 | command | Determ | nem | unpark usage-limit modal | nem | ping ha ≥3 parked |
| night-patrol | SKILL.md | 0 2 | marveen | LLM | olvas | /clear idle saturated | nem | skip ha nincs state |
| dream-engine | SKILL.md | 7 2 | marveen | LLM | hot→cold memória | nem | nem | DREAM.md only |
| memoria-heartbeat | SKILL.md | */30 | marveen | LLM | nem | nem | nem | csendes default |
| fleet-resume-guard | .sh | */3 (host cron) | host | Determ | olvas in_progress | nudge idle w/ open card | nem | nem |
| fleet-context-guard | .sh | */5 (host cron) | host | Determ | nem | **fresh-restart near-saturation** | nem | nem |
| memGate reconcile | channel-monitor | 60s | dashboard | Determ | nem | restart dead desired | nem | nem |
| kanban-dispatcher | SKILL.md | 5,35 | marveen | LLM | — | — | — | **DISABLED** (49/49 skip) |

Fire-evidencia (task_runs, 24h): maestro 621, health-watchdog 616, build-done 606, context-watchdog/done-evidence 561, memoria-heartbeat 512, fleet-stall 274, night-patrol 11, dream 22.

**Dedup/idempotency (FM-18 védelem — ERŐS, determinisztikus):** scheduleLastRun map + catch-up (dupla-fire ellen), pending_task_retries (soha-nem-hagyd-el, per-attempt stamp), fleet-stall egy-nudge-per-episode marker, done-evidence `evidence-check:` comment-marker, fleet-resume per-card cap + 15-min rate-limit, stuck-Enter resubmit ladder (max 6).

---

## 7. A deployment utáni folyamat

**Ami VAN:** (1) Render `/health` liveness-gate a suite-api-n (migration preDeploy után promotál); (2) CostOps napi infra-költség-sync + threshold-alert (*/30 TG push); (3) marketing auto-draft launch-anyagokra (maestro "MARKETING AUTO-INVOLVE"). 

**Ami NINCS:** (1) automatikus post-deploy runtime/feature-reachability check (a suite-web static-site-nak NINCS health-check egyáltalán; a feature-elérhetőség manuális Playwright/UAT on-request); (2) 24h/7d/30d follow-up review; (3) business-KPI gyűjtés (lásd 14.); (4) automatikus bug-triage a runtime-adatból (nincs runtime-adat); (5) feature-adoption review. A post-deploy lánc (monitoring → feedback → KPI → új hipotézis → új ciklus) a MÉRÉS lépésnél megszakad.

---

## 8. A teljes Product LCM folyamat

Ciklus: market-scout → opportunity → business-def → validation → product-def → design → build → launch → measure → optimize → reprice → further-dev/pivot/sunset.

**Front-fél (scout→define→build→launch-draft): VAN, evidence-backed, de front-loaded + prompt-fragile.** A scout/business/product-def/GTM-draft automatizmusok a maestro-promptban élnek + a júniusi front-load artefaktumokban.

**Hát-fél (measure→optimize-from-data→reprice→kill): lényegében HIÁNYZIK.** Részletek 9-17.

---

## 9. Market és competitor scouting
**PARTIAL, esemény-triggered, nem naptár-recurring.** Ami van: (a) phase-end market-revision (maestro prompt, Istvan 2026-07-04) — bármely fázis-done → research(Sonar)+business(Compass) kártya; (b) termék-kész differentiator-scout (Istvan 2026-07-09) — teljes termék-kész → research+business kör. Evidencia hogy fut: kártyák 889b5f49 (MK), 6d28689f (QQ) done + deliverables. **Ami NINCS:** naptár-recurring market-scan (semmi periodikus). A dream-engine Bucket-4 (02:07) Claude-skill-repókat scoutol, NEM termék-piacot. Nincs delta-alapú competitor-tudásbázis; teljes re-research minden alkalommal. **Fragilitás:** az egész egy 39-soros promptban él a deliverylead tmux-session-jén.

## 10. Opportunity management
**EGYSZERI, csak június.** Opportunity brief-ek/scored shortlist-ek/TAM-becslés = júniusi artefaktumok (research/business/deliverables 2026-06-2x). Nincs karbantartott opportunity-pipeline, nincs újralátogatott go/no-go. A discovery→build-auth manuális Istvan-döntés-gate (discovery-items-need-istvan-dontes memória).

## 11. Business definition
**EGYSZERI per-termék, NEM folyamatosan karbantartott.** Gazdag business-doksik léteznek de majdnem mind 2026-06-2x dátumú (koncepció/üzleti-modell/árazás). NINCS egyetlen authoritative, élő business-brief per termék (value-prop + unit-economics + GTM + success/kill kritérium ami frissül). Point-in-time koncepció-doksik. **FM-22 (business-def-stale) = az alapállapot, nem edge-case.**

## 12. Product definition és roadmap
**VAN, előre-feed, de nem runtime-adatból.** MVP-scope/M1-M2-M3/must-have léteznek; a proto a FLOOR és kikényszerített (standing-gate-proto-market-check memória — nagyon részletes feature-completeness + graphics-parity gate). Lifecycle-forward mechanizmus VAN (maestro AUTO-ADVANCE). **Gap:** a roadmap QA/proto/market-ből frissül, NEM runtime/usage-ből — mert nincs runtime-adat (14.). A feedback-hurok kódolva van olyan analytics fogyasztására ami még nem létezik.

## 13. Design, build, launch és go-to-market
**Drafting automatizált, nincs launch-readiness gate, publish Istvan-gated.** Marketing (Herald) auto-draftol landing/copy/FAQ/changelog/launch-post/social/GTM-checklist (evidencia: marketing/deliverables 2026-07-02). Publish/send = Istvan-döntés (helyesen). **Ami NINCS:** launch-readiness gate ami blokkolná a launchot amíg nincs measurement-plan. **FM-19 (launch-w/o-measurement): LEHETSÉGES és vitathatóan MEGTÖRTÉNT** — a termékek deploylva, a PostHog CSP-blokkolt volt a launch-nál (d12930e8/db19dffe), a landingek PostHog IIFE-je tört (landing-posthog-loader memória) = mérés-törötten launcholva.

## 14. Analytics és piaci eredmények értékelése — A LEGGYENGÉBB
**Költség-oldal VAN:** CostOps (render/openai/github/deepseek), threshold-alert */30. **Business-KPI: NINCS gyűjtve.** Nincs visits/signups/activation/conversion/retention/churn/adoption/revenue/MRR/CAC/LTV/margin mechanizmus. PostHog capture-re bekötve de holt (első read 2026-07-03 = 2 event, ~0 valós látogató; regisztráció rejtve, 0 valós user). NINCS recurring analytics-gyűjtő scheduled-task. Nincs revenue/MRR ingestion (bursar/broker cég+személyes pénzügy, nem termék-P&L). **FM-20 (data-collected-not-evaluated): LEHETSÉGES** — még a szórványos PostHog-capture-nek sincs kiértékelő hurokja.

## 15. Pricing és packaging újraértékelése
**AD-HOC, nem cost-linked, nem recurring.** Árak Istvan-set (MK 3500, QQ 4900). A competitor-pricing-check egyszeri (Istvan tg4359 triggerelte, 2026-07-11), nem recurring. **NINCS mechanizmus** ami competitor-pricing/WTP/margin-t figyel, és **NINCS link CostOps-hoz** — nincs per-termék COGS/margin, tehát a pricing nem lehet cost-aware. **FM-24 (pricing-not-cost-aware): IGAZ konstrukció szerint.** **FM-25 (pricing-drift): latent** — pricing-cross-product-contamination memória valós drift-incidenst rögzít (Zsibongó 1990 az MK-ra), nincs standing guard.

## 16. Product optimization loop
**Mechanizmus VAN, INPUT HIÁNYZIK.** A maestro kétirányú feedback-szabály auto-kártyáz research/business/UX-et "analytics/piaci jel/usability" szignálra. **De nincs KPI-gap detector** — nincs baseline/target/threshold egyetlen business-KPI-n sem (csak költségen). A "KPI-gap → hipotézis" soha nem triggerel adatból; csak QA/usability/market-találatból, amit ember/agent felszínre hoz. A hurok KVALITATÍV jeleken fut, nem MÉRT-eken.

## 17. Pivot, sunset és archiválás — HIÁNYZIK
**Nincs kill-kritérium, nincs sunset-folyamat, nincs pivot-döntés** sehol (0 kanban-kártya kill/sunset/repric-re). **Zombie-service detekció: PARTIAL, csak-költség + manuális** (render-dependency-map memória cost-tudatos, de nincs automatikus "X szolgáltatás 0 user / $Y költség → sunset-javaslat"). **FM-27 (zombie-service) + FM-28 (no-kill/pivot): mindkettő nyitva, nincs védelem.**

---

## 18. Szerepek és ágensek felelősségi mátrixa

| Szerep | Agent | Fő felelősség (AS-IS) |
|---|---|---|
| Orchestrator | marveen | Istvan-interfész, döntések, deploy/Render self-serve, send-keys unstick (nem self-pace-gated) |
| Koordinátor / momentum-motor | deliverylead (Maestro) | **a teljes forward/backward progression** (LLM prompt */30); dispatch, WAITING-audit, lifecycle-forward, feedback |
| Architektúra/spec | architect (Atlas) | technikai spec, proto-check |
| Business analyst | ba (Lens) | AC/DoR, feature-completeness (reverse-AC) |
| Business | business (Compass) | business-def, market-check, feature-completeness |
| Research | research (Sonar) | competitor/market scout |
| Marketing | marketing (Herald) | GTM-draft, landing/copy |
| UX/UI | uxuidesigner (Muse) | design, graphics-parity (proto-file) |
| Jog | jogasz (Aegis) | ÁSZF/GDPR/Art.9 |
| Frontend | frontendfejleszto (Pixel), (2) Vecta | UI impl |
| Fullstack | fullstackfejleszto (Mason) | backend+frontend impl |
| Build | buildfejleszto (Anvil) | build/migration |
| QA | qa (Falcon, opus) | teszt, security-pass |
| UAT | uat (Scout) | élő verifikáció |
| DevOps | devops (Helm) | Render, DB, provision, CostOps |
| Költség | CostOps (cron+alert) | infra-költség |
| Személyes/cég pénzügy | bursar/broker/steward/thrinintee/sentinel | NEM termék-LCM |

**Kulcs-koncentráció:** a deliverylead egyetlen agent hordozza a teljes folyamat-folytonosságot. Ez a legnagyobb single-point-of-failure.

---

## 19. Jelenlegi artefaktumok jegyzéke
- **Kanban:** store/claudeclaw.db kanban_cards (964, ebből 584 aktív-done <7nap) — a fő munka-artefaktum.
- **Memória:** SQLite memories (1,445 sor, ~254K tok) + file-memória (140 fájl, ~102K tok) — kettős, átfedő.
- **Deliverables:** agents/*/deliverables/ (business/research/marketing június-front-loaded; costops; floor-gate) + /home/iszzu/marveen/deliverables/ (5 md + 1 competitor-pricing).
- **Skillek:** ~/.claude/skills/ (86).
- **Protók:** /mnt/c/Users/iszzu/OneDrive/Documents/marveen-protos/*-thick/ — a TERMÉK-igazság (Folyamat 2.0).
- **Daily logs, task_runs, DREAM.md.**

## 20. Jelenlegi source-of-truth hierarchia (AS-IS)
1. **Istvan (TG)** — a végső döntés; DE nem mindig kerül tartós artefaktumba (FM-01, ma: nav-drift).
2. **A thick proto** (Folyamat 2.0, tg561 2026-06-22) — a termék-igazság; DE csak opcionális skill kényszeríti (megcsúszott, ma visszaállítva).
3. **A repo/DB** (source, kanban, schema) — a technikai igazság.
4. **Memória** (MEMORY.md + SQLite) — visszakereshető, DE néha source-of-truth helyett használva (FM-12 kockázat).
**Probléma:** nincs egyértelmű, kikényszerített hierarchia; agentek néha memóriából/landingből dolgoznak a proto/repo helyett (ma: Muse landinghez mért proto helyett → false-green).

## 21. Jelenlegi fejlesztési és Product LCM alapelvek (AS-IS)
Lásd 4. + 6. Kulcs: minden elv (kanban-first, no-impl-before-spec, orchestrator-review, build+test-mandatory, runtime-verify, proto-floor, continuous-discovery, evidence-based-decisions) **DOKUMENTÁLT skillekben/memóriában, de KÓD nem kényszeríti ki.** A "sub-agent-cannot-accept-own-work" elv **sehol nincs kimondva, sőt az ELLENKEZŐJE van bekötve** (az executor maga zárja done-ra).

## 22. Dokumentált szabályok és tényleges működés eltérései
- **"done = bizonyítottan kész"** (playbook) vs **done = önbevallott** (db.ts:1426). ELTÉR.
- **"proto a floor, mindig visszamérés"** (Folyamat 2.0) vs a proto-check megcsúszott a go-live hajrában (ma). ELTÉR (visszaállítva).
- **"minden igény kanbanra"** vs sign-off nélküli döntések (nav-drift). ELTÉR.
- **"graphics-parity a protóhoz"** vs Muse a landinghez mért (ma). ELTÉR (korrigálva).
- **inter-agent-evidence-gate.py + stale-instructions-*.sh** dokumentált védelmek, de **git-untracked + nincs caller → DORMANT** (nem aktívak).
- **kanban-dispatcher** dokumentált, de DISABLED.

## 23. Failure mode elemzés (FM-01 … FM-28)

| FM | Lehetséges most | Védelem (determ/LLM/nincs) | Helyi példa |
|---|---|---|---|
| FM-01 agreed-not-recorded | **IGEN** | NINCS (DOC) | **MA: nav sidebar→top-tabs, 0 sign-off rekord (79736009)** |
| FM-02 recorded-not-in-design | IGEN | NINCS | proto-floor slip (shell/login) |
| FM-03 designed-not-tasked | IGEN | DOC (uxui-verdict-not-posted) | — |
| FM-04 tasked-not-implemented | részben | LLM kanban-audit 4h; dispatch single-shot silent-drop | — |
| FM-05 partially-implemented | **IGEN** | NINCS determ | launched-product-missing-login memória |
| FM-06 implemented-not-integrated | **IGEN** | NINCS determ | **MA: MK bevétel-lista backend van/frontend nincs (08dec762)** |
| FM-07 implemented-not-built | LOW prod / MOD lokál | determ tsc-b + 1 mező (check-kata-sync) | stale-dist rebuild pattern; orphaned stash 4eba155 |
| FM-08 built-not-deployed | latent | autoDeploy determ, de nincs commit-verify | held commits (Eskuvo, JWT-secret) |
| FM-09 deployed-not-reachable | **LEGMAGASABB** | csak manuális UAT | **render.yaml: /aszf,/rsvp,/self-fill rewrites retroaktívan** (SPA-shadow) |
| FM-10 done-without-evidence | **IGEN (strukturális)** | done-evidence-gate csak fájl-név | **MA: MK false-green (landing-mért gate CLOSED → retract)** |
| FM-11 stale-downstream | **IGEN** | dormant script (stale-instructions nem wired) | **MA: "6 valós QQ tenant" stale-claim Aegis brief-jébe propagált** |
| FM-12 memory-as-source-of-truth | IGEN | DOC | Muse landing-vs-proto (ma) |
| FM-13 completed-no-next-action | IGEN | LLM (maestro auto-advance); determ háló csak 90-min-csend | — |
| FM-14 idle-despite-work | IGEN (megtörtént) | LLM maestro WAITING-audit; **fleet-resume-guard CSAK in_progress-t nudge-ol, waiting-et NEM** | **MA: éjszakai stand-down 2:45-6:31 (Istvan flagelte)** |
| FM-15 waiting-without-escalation | részben | LLM konszolidáció; **nincs determ escalation-clock** (kanban-audit stuck-nudge level 2 = csak javasol) | — |
| FM-16 failure-without-return | vegyes | **CSAK done-evidence-gate (missing-file) determ**; QA/build/deploy/runtime-fail LLM-only | proto-graphics-parity reaktív (ma) |
| FM-17 wrong-phase-continuation | IGEN | LLM-only | — |
| FM-18 automation-loop/duplicate | **JÓL VÉDETT** (determ dedup) | — | legalacsonyabb kockázat |
| FM-19 launch-w/o-measurement | IGEN (megtörtént) | NINCS readiness-gate | PostHog CSP-blocked launch-nál |
| FM-20 data-collected-not-evaluated | IGEN | NINCS eval-loop | PostHog 2 event, csak manuális read |
| FM-21 market→roadmap | részben védett | maestro auto-card | de nincs recurring market-scan |
| FM-22 business-def-stale | **IGEN** | NINCS | doksik 2026-06-2x fagyva |
| FM-23 result→next-cycle | védett (kártya-oldal) | maestro auto-advance | de runtime-adat híján éhezik |
| FM-24 pricing-not-cost-aware | **IGEN (strukturális)** | NINCS | nincs per-termék margin |
| FM-25 pricing-drift | IGEN | csak lecke, nincs guard | pricing-cross-product-contamination |
| FM-26 marketing-product-drift | részben | ad-hoc copy-audit | nincs standing sync |
| FM-27 zombie-service | **IGEN** | csak cost-hygiene manuális | render-dependency-map |
| FM-28 no-kill/pivot | **IGEN** | NINCS | 0 kill/sunset kártya |

## 24. Jelenlegi quality gate-ek és kikényszeríthetőségük
- **done-evidence-gate** (CODE, aktív): csak fájl-név-létezés; comment-nélküli done-kártya CSENDBEN átugorva; FLOOR/FINAL-gate kártyák skip; suite-repo/bare-filename INCONCLUSIVE.
- **build /health** (CODE): liveness, nem feature-reachability; suite-web-nek nincs.
- **check-kata-sync.mjs** (CODE): 1 hand-maintained mező (KATA scenario) regex source-text-en.
- **proto-floor + FINAL FLOOR GATE** (DOC/skill, ma re-instated): feature-completeness (business/ba) + graphics-parity a proto-fájlhoz (Muse). Kikényszeríthetőség: **csak amíg valaki futtatja** — megcsúszott, ma vissza. NEM kód.
- **fleet-stall-detector** (CODE): 90-min teljes-csend nudge.
- Minden más gate DOC/LLM.

## 25. Build / dist / deploy / runtime lánc
- **Blueprint:** marveen-suite/render.yaml, 8 szolgáltatás **autoDeploy=YES main-en**. Build: api+cronok `pnpm -r build` (recursive); **suite-web FILTERED** `pnpm --filter @suite/web build` (packages/core/dist nem garantált — check-kata-sync komment megerősíti). suite-api preDeploy migration-gate + /health.
- **Source=build a prod-on:** Render mindig clean origin/main-ből rebuildel → nincs lokálisan-buildelt dist szállítva. Lokál marveen-suite main 0/0, clean.
- **Source-vs-build verify: gyakorlatilag NINCS** (csak a check-kata-sync 1 mező). Nincs általános "dist == source" / "a futó bundle tartalmazza a merge-elt változást" check.
- **Runtime-verify: NINCS automatikus.** Manuális Playwright on-request. suite-web-nek nincs health-check.
- **Monorepo autoDeploy burn:** minden main-commit mind a 8 szolgáltatást rebuildeli; egy rossz commit blokkolja az egész flottát; a cronok nem kaptak autoDeploy:no-t.
- **marveen-suite MÉG shared checkout** (a DORA per-agent worktree-t kapott, a suite nem) — orphaned stash 4eba155 a bizonyíték a WIP-felhalmozódásra.
- **Korrekció:** a brief "#577 stash-incidens" valójában tg577 (LLM-provider döntés), NEM stash; a "commit-before-merge-ships-held-wip" nincs diszkrét logolt eseményként (bár a shared-checkout WIP-kockázat valós, és ma élőben megtörtént az MK-skin ship af62f2a-val — ez maga FM-01: megtörtént de nem logolva). UNCERTAIN-jelölt.

## 26. Deployment utáni feedback- és továbbfejlesztési lánc
Lásd 7. + 14. + 16. **Megszakad a MÉRÉS lépésnél:** deploy → (nincs runtime-reachability check) → (nincs business-KPI) → (nincs KPI-gap detector) → az optimization-loop kártya-generáló fele működik de éhezik. A visszacsatolás (piac→business→roadmap→fejlesztés) csak KVALITATÍV jelen fut.

## 27. Context-loading térkép
| Forrás | ~tok | Betöltés | Duplikált | Kell? |
|---|---|---|---|---|
| root CLAUDE.md | 3,827 | **minden session, minden agent** (cwd-ancestry) | **igen** (agent-tail ismétli) | részben |
| agent CLAUDE.md | ~3,300 | minden session az agentnél | tail ~5,750 char dup root | szerep-rész igen, tail nem |
| SOUL.md | ~1,125 | spawn/persona (UNCERTAIN cadence) | nem | alacsony érték |
| level-0 skills (86) | **8,396** | minden session | nem | **broadcast, legtöbb irreleváns szerep szerint** |
| .skill-index.md | 3,406 | UNCERTAIN | átfed level-0 | UNCERTAIN dupla |
| MEMORY.md index | 4,407 | csak fő-cwd session | nem | igen (fő) |
| 140 memória-fájl | ~98,300 | explicit read (d) | átfed SQLite | on-demand OK |
| SQLite memories | ~254,300 | /api/memories search (d) | átfed file-mem | on-demand OK |

## 28. Becsült tokenfelhasználás fázisonként/agentenként
Statikus context egy dev-agent session-ben MUNKA ELŐTT: root 3,827 + agent 3,300 + SOUL 1,125 + level-0 skills 8,396 + per-cwd memória ~200 = **≈ 16,850 tok statikus**. + dispatch-üzenet ~300-1,000 + keresett memóriák ~1,500 + aktivált skill-body 3,000-15,000. **A statikus ~16,850-ből ~7,500-8,500 (~45-50%) vitathatóan dead-weight** az adott feladatra (agent-tail dup ~1,437 + szerep-irreleváns skillek ~5,000-6,000 + SOUL ~1,125).

## 29. Tokenpazarlási pontok (rangsorolva mért hatással)
1. **Agent-tail duplikáció 19 agent CLAUDE.md-jében: 114,320 char ≈ 28,580 tok flotta-szinten** — a root CLAUDE.md tartalmát ismétli amit az agentek úgyis örökölnek (Memória/Ütemezés/Skill/Idő/ARANYSZABÁLY blokk). Egy `fleet-descriptor-slim` skill LÉTEZIK erre, de nincs alkalmazva. **A legnagyobb kinyerhető pazarlás.**
2. **Mind-86 level-0 skill-leírás broadcast minden agentnek: 8,396 tok/session/agent**, nincs szerep-scoping (egy jogász viszi a render-deploy/chromium leírásokat).
3. **Hosszú descriptorok:** top agentek ~3,900 tok + root + SOUL = ~12,700 statikus munka előtt.
4. **Lehetséges dupla skill-index** (.skill-index.md 3,406 tok átfed level-0). UNCERTAIN.
5. **Két átfedő memória-store** (file ~102K + SQLite ~254K tok) — broad search duplikatív recall-t húzhat.
6. **LLM ott ahol determinisztikus elég:** a folyamat-continuity kritikus döntései (next-phase, failure-return) LLM-promptban vannak determinisztikus kód helyett — nem csak token, hanem megbízhatóság-kérdés is.
- UNCERTAIN: ismételt teljes market-research (a research-agent 134 memóriát/101K char-t tart; delta-vs-full nem konfirmálható a filesystem-ből, transcript kellene).

## 30. Local és official eltérések
- **Untracked lokális gépezet:** 3 host-cron script (fleet-resume/context/suite-checkout-ff-guard), inter-agent-evidence-gate.py, stale-instructions-*.sh, dispatch-guard.sh, deliverables/, audits/, shared-dev/ — mind git-láthatatlan. Egy `git`-alapú vagy dashboard-only audit a gépezet felét NEM látja.
- **Fő marveen-worker lokálisan Sonnet** (szándékos override).
- **RENDER_API_KEY** nem a .env-ben (devops/.env.render, hardening).
- Ezek lokál-only, official-update-kompatibilitás megőrzendő (a root CLAUDE.md ancestor-inherited minden agentnek — ezért került ki a konkrét titok-útvonal).

## 31. Jelenlegi erősségek
- **Determinisztikus dedup/idempotency/retry** (FM-18 jól védett): pending_task_retries, catch-up, per-card nudge-cap, stuck-Enter ladder.
- **A momentum-motor VALÓBAN önvezérel** amikor a deliverylead fut — a fleet ledarálja a backlogot (ma: 10 kártya/óra a gate-munkában).
- **A proto-floor gate, AMIKOR kikényszerítve, MŰKÖDIK** — ma valós hiányokat fogott (MK income-list, QQ VAT/directory).
- **Multi-layer recovery** (schedule-runner + host-cron + reconcile) túléli a dashboard halálát.
- **CostOps: valós, működő költség-mérés + alert.**
- **Élő-verifikáció mint kultúra** (ma: bundle-grep a shellre, prod-verify az allergia-revertre, independent live-check a self-reportok helyett).
- **Explicit retraction** (ma: false-green azonnal visszavonva Istvannak).
- **Security-instinct** (ma: devops default-deny a spoof-gyanús provision go-ahead-re).

## 32. Kritikus hiányosságok (17 kritikus probléma)
**Dev-process (5):** (1) done önbevallott, nincs kód-szintű független sign-off; (2) az egyetlen determ done-gate csak fájl-nevet ellenőriz (FM-05/06 vak); (3) dispatch single-shot silent-drop + PUT bypass-olja a dispatch+event-log-ot; (4) nincs bus-sender-auth + 2 safety-script (inter-agent-evidence, stale-instructions) nem wired; (5) minden igény→design→task→test→runtime link konvenció, nincs AC-mező.
**Continuity (5):** (6) single LLM point-of-failure MINDEN progression-re; (7) nincs determ failure-return kivéve missing-file; (8) waiting-but-workable determ-védtelen; (9) nincs determ escalation-clock istvan-dontes/stale-waiting-ra; (10) két láthatatlan (untracked) ütemezési réteg.
**Product-LCM (5):** (11) nincs business-KPI mérés (a kulcs-gap — minden downstream éhezik); (12) nincs kill/sunset/pivot; (13) pricing nem cost-aware + nem monitorozott; (14) business-def egyszeri júniusi, sose frissül; (15) a meglévő scout prompt-fragile + event-only.
**Keresztmetsző (2):** (16) bus-sender-auth hiánya (spoofolható from); (17) agent-tail token-duplikáció (~28,580 tok flotta-szinten).

## 33. Bizonytalan / nem igazolható területek
- SOUL.md betöltési kadenciája (spawn-only vs minden session) — UNCERTAIN.
- .skill-index.md ténylegesen betöltődik-e a level-0 lista MELLETT — UNCERTAIN (runtime-prompt inspection kell).
- Research/business ismételt full-vs-delta market-research — UNCERTAIN (transcript-analízis kell).
- `testing` kanban-státusz tényleges használata — UNCERTAIN.
- "#577 stash-incidens" és "commit-before-merge-ships-held-wip" mint diszkrét logolt esemény — NEM igazolt (a brief konfláció; a valós FM-07 evidencia a stale-dist pattern + orphaned stash 4eba155).

## 34. Rövid AS-IS verdikt
Marveennek **erős, determinisztikusan-hardened FRONT-fele van** (dispatch, retry, recovery, deploy) és egy **valódi, de KONVENCIÓ-alapú és egyetlen-LLM-en-függő folyamat-gerince**. A "hibák + elfelejtett megegyezések" nem véletlenek: **strukturálisak** — a done önbevallott, a proto-floor csak akkor él ha valaki futtatja, a progression egyetlen LLM-prompton áll, és a Product LCM hát-fele (mérés→optimalizálás→árazás→kill) hiányzik. A rendszer **épít és növel, de nem mér, nem árazza újra, és nem zár le** terméket. A legnagyobb egyszeri kockázat: minden minőség- és folytonosság-garancia LLM-ítéleten múlik, determinisztikus háló nélkül a leggyakoribb failure-osztályokra (FM-05/06/09/10).

---

### VÉGSŐ VISSZATÉRÉS
1. **Auditfájl:** `audits/2026-07-13-development-and-product-lifecycle-as-is-audit.md`
2. **Kritikus problémák száma:** 17
3. **Top-5 dev AS-IS:** (a) done önbevallott, nincs független sign-off (db.ts:1426); (b) az egyetlen determ done-gate csak fájl-nevet néz, a legfontosabb failure-osztályokra (FE-only/BE-only/not-wired) vak; (c) dispatch single-shot silent-drop + PUT-bypass; (d) nincs bus-sender-auth, 2 safety-script dormant; (e) minden AC→runtime link konvenció, nincs kód-gate.
4. **Top-5 continuity AS-IS:** (a) single LLM point-of-failure (maestro-prompt) MINDEN forward/backward progression-re; (b) nincs determ failure-return kivéve missing-file (QA/build/deploy/runtime-fail LLM-only); (c) waiting-but-workable determ-védtelen (fleet-resume-guard csak in_progress); (d) nincs determ escalation-clock a döntés-queue-ra (kanban-audit level 2 = csak javasol); (e) két untracked ütemezési réteg — nincs egyetlen hely ami mindet felsorolja.
5. **Top-5 Product LCM AS-IS:** (a) nincs business-KPI mérés (a keystone-gap, minden downstream éhezik); (b) nincs kill/sunset/pivot/zombie-detekció; (c) pricing nem cost-aware (nincs per-termék margin) + nem monitorozott; (d) business-def egyszeri júniusi artefaktum, sose frissül; (e) a meglévő scout/market-automatizmus prompt-fragile (39-soros prompt egy tmux-session-ön) + event-only, nincs recurring market-scan.
6. **Legnagyobb token-pazarlási területek:** (1) agent-tail duplikáció ~28,580 tok flotta-szinten (a root CLAUDE.md-t ismétli, `fleet-descriptor-slim` létezik de nincs alkalmazva); (2) mind-86 level-0 skill-leírás broadcast minden agentnek 8,396 tok/session, nincs szerep-scoping; (3) hosszú descriptorok + SOUL ~12,700 statikus tok munka előtt; (4) lehetséges dupla skill-index 3,406 tok; (5) a statikus context ~45-50%-a dead-weight az adott feladatra.
