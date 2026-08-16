# Marveen CoS v4.4 + ZST v1.2 + ACP v1.4.5 — teljes gap-analízis

**Dátum:** 2026-08-16  
**Audit tárgya:** `develop` aktuális implementáció összevetése az új target baseline-okkal  
**Target specifikációk:**
- `docs/marveen-personal-chief-of-staff-v4.4.md`
- `docs/zst/marveen-zst-radio-chief-of-staff-v1.2.md`
- `docs/marveen-autonomous-case-progression-spec-v1.4.5-hardening.md`

**Aktuális implementált baseline:** Personal CoS v4.3 + ACP v1.4.4 implemented baseline.  
**Módszer:** kód- és wiring-audit, meglévő live state-spec és acceptance/reconcile mechanizmusok ellenőrzése. Ahol a production wiring vagy a live adatállapot ebből nem bizonyítható, az eredmény `MÉRENDŐ`, nem feltételezett FAIL.

---

# 1. Executive verdict

A Marveen jelenlegi CoS/ACP rendszere **nem újraírandó**. A shared engine nagy része alkalmas alap az új specifikációkhoz:

- optimistic concurrency + append-only event log;
- claim/fencing;
- trigger-driven, bounded heartbeat;
- `WAIT_SYSTEM` + capability recovery;
- kill switch;
- Reader/evidence separation;
- approval-gated outbound;
- ZST outbound production route;
- Product Lab escalation production route;
- runnable Personal és ZST acceptance gate;
- daily reconcile;
- wake consumer;
- deadline ontology/index;
- document store + namespace isolation;
- read-only ZST bank parser/importer.

A gap **nem elsősorban infrastruktúra**, hanem a következő három rendszer-szintű hiány:

1. **semantic correctness** — a rendszer tud dátumot, de nem mindig tudja, minek a dátuma;
2. **operational completeness** — különösen ZST-ben a case létrejön, de nem feltétlenül lesz működő következő lépése;
3. **proof of effect** — több helyen megvan a producer/reader, de a teljes producer→consumer→receipt lánc nincs közös release gate-ként kikényszerítve.

## 1.1 Prioritási összkép

- **P0:** a jelen kódvizsgálat alapján új, bizonyított P0 nincs.
- **P1:** 8 release-blocking gap.
- **P2:** 9 hardening / domain-operational gap.
- **MÉRENDŐ:** 3 olyan terület, ahol production/live bizonyíték kell a korrekt státuszhoz.

## 1.2 Becsült reuse-arány — nem acceptance score

Ez implementációs újrahasznosítási becslés, nem „készültségi százalék”:

- **ACP v1.4.5:** a szükséges substrate többsége már létezik; az új munka főleg shared hardening gate.
- **Personal v4.4:** a jelenlegi v4.3-ra jól ráépíthető; a fő új munka semantic time, extraction-state, repair controls és readiness.
- **ZST v1.2:** az engine és több domain-modul már megvan, de az operational projection + legacy migration + adatok feltöltése miatt itt a legnagyobb az új munka.

---

# 2. Státuszjelölések

- **MEGVAN** — a target követelményt a production kód lényegében teljesíti; csak regression/acceptance frissítés kellhet.
- **RÉSZBEN** — jó alap létezik, de a targethez bővíteni/általánosítani kell.
- **HIÁNY** — a target szerinti capability nincs meg.
- **MÉRENDŐ** — kódból nem bizonyítható korrektül a production/live állapot; futtatható mérés kell.

---

# 3. Shared ACP v1.4.5 gap-mátrix

| ID | Követelmény | Státusz | Prió | Jelenlegi bizonyíték | Gap / szükséges változás |
|---|---|---:|---:|---|---|
| ACP-01 | Trigger-driven bounded progression | MEGVAN | — | `progression-heartbeat.ts`, `progression-trigger.ts`, remaining/truncation | Megtartani; semantic deadline priorityval bővíteni. |
| ACP-02 | Claim/fencing + concurrency | MEGVAN | — | progression lease + `case_claims` fence | Megtartani, mutation regression. |
| ACP-03 | Kill switch | MEGVAN | — | `kill-switch.ts`, ticket revoke, CLI/HTTP | Megtartani. |
| ACP-04 | Capability preflight + WAIT_SYSTEM | MEGVAN/RÉSZBEN | P2 | `capability-preflight.ts` | Connector health/mode erős; actual OAuth-scope mérés hiányzik. |
| ACP-05 | Typed Temporal Fact store | HIÁNY | **P1** | van `deadline-index.ts`, de derived columnsból | Új provenance-bound fact layer kell; a deadline ontology adapterként újrahasználandó. |
| ACP-06 | Temporal Semantic Consistency Gate | HIÁNY | **P1** | prose detector csak „nincs dátum” esetet lát | Hertz/Sixt osztály: van dátum, de rossz eseményt jelent. Shared TSCG kell progression/owner-facing gate előtt. |
| ACP-07 | Actionability Gate | HIÁNY | **P1** | külön status/next-action mezők vannak | Shared classifier kell ACTIONABLE/WAITING*/SCHEDULED/BLOCKED/PARENT_ONLY/ORPHAN kimenettel. |
| ACP-08 | Orphan open case release finding | HIÁNY | **P1** | current acceptance részben vizsgál hiányos mezőt, nem runtime invariáns | `ORPHAN_OPEN_CASE` közös acceptance + reconcile finding. |
| ACP-09 | CPP / consumer manifest | HIÁNY | **P1** | Reader/wake történeti javítások bizonyítják a problémát, de nincs registry | Minden periodic/normative feature explicit producer/storage/consumer/effect/receipt/dedup/recovery/zero manifestet kapjon. |
| ACP-10 | Built-but-not-invoked gate | RÉSZBEN | **P1** | `cos-acceptance.py` / `zst-acceptance.py` már tud caller searchöt | Általánosítani minden normatív v1.4.5 capabilityre, nem csak kézzel felsorolt régi elemekre. |
| ACP-11 | Standard zero telemetry vocabulary | RÉSZBEN | P2 | több runner explicit 0-t és examined-et ad; cycle egyedi shape-eket merge-el | Egységes `NO_DATA/NO_MATCH/NO_ACTION/ACTED/FAILED/UNKNOWN`. |
| ACP-12 | Evidence watermark | HIÁNY | P2 | Reader prompt lát `case_version`, packet nem tárol közös event/source watermarkot | `evidence_max_event_seq`, built_at, source versions/fingerprint. |
| ACP-13 | Generic stale-evidence gate | RÉSZBEN | P2 | owner-question út már védi a friss owner replyt | Ugyanaz a gate approval/external candidate és minden owner-facing Consumer előtt. |
| ACP-14 | Pre-existing backlog proof | RÉSZBEN | P2 | wake fix élő backloggal lett bizonyítva, de nincs reusable harness | Általános fixture queue/cursor/wake/question/recovery/Reader featurekre. |
| ACP-15 | Wake delivery guarantee | MEGVAN | — | wake consumer + post-before-clear | Regisztrálni CPP-ben, regression megtartani. |
| ACP-16 | Critical semantic deadline delivery guarantee | HIÁNY | **P1** | wake/follow-up consumer létezik, semantic critical fact nincs | `UNCONSUMED_DEADLINE`: VERIFIED critical fact delivery path nélkül. |
| ACP-17 | Reader structurally cannot act | MEGVAN | — | Readernek nincs writer/send capabilityje | Megtartani. |
| ACP-18 | Sensitivity-before-egress | MEGVAN | — | Reader routing + fail-closed blocked path | Credential policyval együtt regresszálni. |
| ACP-19 | Progression mode has real behavior | MEGVAN | — | `outbound-mode-gate.ts` | Megtartani. |
| ACP-20 | Mode ≠ permission | MEGVAN | — | send approval, finance/legal hard limits | Explicit acceptance fixture-ekkel v1.4.5-re emelni. |
| ACP-21 | Promotion readiness gate | HIÁNY | P2 | mode állítható, de readiness nem kapuzza | Domain+feature eligibility report, 7 nap stability; ne auto-promote-oljon. |
| ACP-22 | 7-day stability window | HIÁNY | P2 | nincs readiness ledger/window | P1 silent failure reseteli az ablakot. |
| ACP-23 | v1.5 unlock gate | HIÁNY | P2 | v1.5 külön spec, de nincs gépi unlock | Readiness reportból explicit LOCKED/ELIGIBLE. |
| ACP-24 | Bounded backlog visibility | MEGVAN | — | `findDuePage.totalDue/remaining` | Semantic deadline priority hozzáadása. |
| ACP-25 | Domain fairness | MEGVAN/RÉSZBEN | P2 | Reader fair interleave, progression per-domain bound | Critical verified deadline determinisztikus prioritás hiányzik. |

---

# 4. Personal CoS v4.4 gap-mátrix

| ID | Követelmény | Státusz | Prió | Gap / megjegyzés |
|---|---|---:|---:|---|
| PRI-01 | Case engine / event / concurrency | MEGVAN | — | Erős shared substrate. |
| PRI-02 | Intake dedup, thread handling, self-send suppression | MEGVAN | — | `intake.ts` erős. |
| PRI-03 | New case immediate visibility | MEGVAN | — | inbound `follow_up_at=now` jelenleg Today visibilityt ad. |
| PRI-04 | Typed temporal truth | HIÁNY | **P1** | scalar `due_at/follow_up/wake` nem elég. |
| PRI-05 | Hertz/Sixt semantic conflict gate | HIÁNY | **P1** | jelenlegi prose detector szándékosan nem látja. |
| PRI-06 | Actionability invariant | HIÁNY | **P1** | runtime gate nincs. |
| PRI-07 | Consumer completeness | RÉSZBEN | **P1** | sok consumer ma már él, de nincs közös contract/release gate. |
| PRI-08 | Document content store | MEGVAN | — | sha256, atomic write, namespace, share gate. |
| PRI-09 | Per-field extraction state/provenance | HIÁNY | P2 | issuer/amount/due_date egyszerű nullable mező. |
| PRI-10 | Invoice structured extraction completeness | HIÁNY/RÉSZBEN | P2 | ismert live gap: több invoice PDF strukturált mező nélkül. |
| PRI-11 | Calendar identity-first dedup | RÉSZBEN/MÉRENDŐ | P2 | calendar IDs write-side létezik; source-identity + create-readback production bizonyítékot külön mérni kell. |
| PRI-12 | Calendar duplicate conflict | HIÁNY/MÉRENDŐ | P2 | v4.4 target szerinti explicit conflict semantics nem bizonyított. |
| PRI-13 | Owner question dedup/capacity/freshness | MEGVAN/RÉSZBEN | P2 | jó lokalizált védelem; generic evidence freshnessre emelendő. |
| PRI-14 | Owner attention metrics | RÉSZBEN | P3 | kapacitás és kérdésállapot van; teljes v4.4 KPI-készlet nincs. |
| PRI-15 | Mission Control read surfaces | MEGVAN | — | case/outbound/monitoring/kill-switch felületek vannak. |
| PRI-16 | Mission Control repair commands | RÉSZBEN | P2 | next_action edit, temporal confirm/reject, parent unlink, calendar conflict stb. target szerint nem teljes. |
| PRI-17 | Outbound exact approval + receipt | MEGVAN | — | erős shared executor. |
| PRI-18 | No autonomous payment/investment | MEGVAN | — | nincs ilyen execution surface. |
| PRI-19 | No autonomous legal commitment | MEGVAN | — | outbound approval + policy boundary. |
| PRI-20 | Actual credential scope as truth | HIÁNY/MÉRENDŐ | P2 | capability registry módot mér, de token scope introspection kódban nem bizonyított. |
| PRI-21 | Daily reconcile UNKNOWN≠0 | MEGVAN/RÉSZBEN | P2 | `reconcile.ts` jó null/unreadable elvvel; új v4.4 metrikákkal bővítendő. |
| PRI-22 | Unattended production gate | HIÁNY | P2 | 7 nap + v4.4 fixture gate szükséges. |

---

# 5. ZST CoS v1.2 gap-mátrix

## 5.1 Legfontosabb megállapítás

A jelenlegi ZST rendszer **már több, mint a korábbi 2026-08-10-i audit állapota**:

- a ZST outboundnak ma production endpointja van;
- a Product Lab gateway production útvonalon elérhető;
- a ZST acceptance gate létezik;
- a reconcile ma már néz ZST állapotokat;
- invoice/contract extractor production intake-ből hívódik;
- a bank statement importer érdemi, read-only implementációként létezik.

Ezért ezeket **nem szabad újraépíteni**.

A fő ZST gap most az, hogy az intake az ügyet **rögzíti**, de nem állít elő teljes operational contractot.

## 5.2 Mátrix

| ID | Követelmény | Státusz | Prió | Gap / megjegyzés |
|---|---|---:|---:|---|
| ZST-01 | Separate case/event/claim namespace | MEGVAN | — | Shared engine külön táblákon. |
| ZST-02 | ZST connector identity security boundary | **ELTÉR A TARGETTŐL** | **P1** | current route content alapján privát inputot is ZST intake-be tehet; current acceptance ezt marked crossingként elfogadja. v1.2 ezt tiltja. |
| ZST-03 | Explicit human-approved bridge | HIÁNY | **P1** | strict cutoverhoz quarantine/bridge command kell. |
| ZST-04 | Intake dedup/thread/self-send | MEGVAN | — | erős. |
| ZST-05 | Intake operational projection | HIÁNY | **P1** | új inbound ZST case nem kap kötelező `next_action`, owner, closure semantics, typed temporal state-et. |
| ZST-06 | ZST Actionability invariant | HIÁNY | **P1** | közös gate kell. |
| ZST-07 | Existing 42-case operational migration | HIÁNY | **P1** | dry→2→5→10→remainder tooling és audit event nincs. |
| ZST-08 | Migration-safe completion guard | RÉSZBEN | **P1** | generic completion guard van; migration-triggerre külön „no terminal close from backfill” rule kell. |
| ZST-09 | Invoice extractor production caller | MEGVAN | — | `zst-intake.ts` hívja. |
| ZST-10 | Invoice field extraction-state/provenance | HIÁNY | P2 | best-effort extractor exception jelenleg elnyelődhet; explicit FAILED/AMBIGUOUS kell. |
| ZST-11 | Contract extractor production caller | MEGVAN | — | `zst-intake.ts` hívja. |
| ZST-12 | Contract expiry vs termination semantics | MEGVAN/RÉSZBEN | P2 | deadline ontology helyesen külön kezeli; temporal fact provenance rétegre emelendő. |
| ZST-13 | License watcher | RÉSZBEN | P2 | 30/60/90d megvan; 14/7d, trial end, price increase, unused-paid és adatbetöltés hiányos. |
| ZST-14 | Subscription registry populated | HIÁNY / live state szerint | P2 | korábbi állapotban `zst_licenses` üres; input/extraction a gap. |
| ZST-15 | Bank statement parser/importer | MEGVAN | — | robust read-only CSV importer. |
| ZST-16 | Bank import production entrypoint | MÉRENDŐ | P2 | parser létezik; aktuális production caller/controlled upload ajtót élő acceptance-szel igazolni kell. |
| ZST-17 | Bank match read-only safety | MEGVAN | — | import UNMATCHED, reconciliation suggestion only. |
| ZST-18 | Accounting-package full lifecycle | RÉSZBEN/HIÁNY | P2 | schema/alaplogika létezik, v1.2 lifecycle + ACK/closure flow proof kell. |
| ZST-19 | Vendor/procurement operational flow | RÉSZBEN | P2 | struktúrák/radar elemek vannak; v1.2 kritérium + operational case integration hiányos. |
| ZST-20 | Opportunity lifecycle | RÉSZBEN | P2 | due watcher státuszokat olvas; target pipeline nem teljesen bizonyított. |
| ZST-21 | Product Lab gateway | MEGVAN | — | state machine + production HTTP route; CPP registrybe integrálni. |
| ZST-22 | ZST outbound production caller | MEGVAN | — | draft/approve/reject route létezik. |
| ZST-23 | ZST exact-payload approval safety | MEGVAN | — | strong shared approval/executor. |
| ZST-24 | ZST daily reconcile | RÉSZBEN | P2 | ma már néz ZST-t, de v1.2 orphan/temporal/extraction/business metrics hiányoznak. |
| ZST-25 | ZST acceptance v1.2 | RÉSZBEN | **P1** | runnable gate megvan; target operational/temporal/CPP/security-cutover criteria hiányoznak. |
| ZST-26 | 5 diverse real E2E proof | HIÁNY/MÉRENDŐ | P2 | új target release gate; implementáció után live proof kell. |
| ZST-27 | 7-day unattended corporate stability | HIÁNY | P2 | readiness layer része. |

---

# 6. Külön P1: namespace policy drift

Ez az audit legfontosabb, korábbi összefoglalóban még nem teljesen látható eltérése.

## Current implementation

A jelenlegi intake/scope logika a „**content decides**” elvet ismeri: ha egy privát forrásból érkező tartalom cégesnek minősül, a route ZST intake-be viheti, és a ZST acceptance a marked crossingot elfogadhatja.

## New v1.2 target

A v1.2 szerint:

> ZST operational store-ba csak a ZST connector identityből érkező adat írhat automatikusan.

Personal→ZST csak explicit, ember által jóváhagyott bridge lehet.

## Döntés

Az új specifikáció legyen az autoritatív target. A migration módja:

1. történeti crossing sorokat nem írjuk át és nem töröljük;
2. cutover timestamp után a privát connector nem írhat közvetlenül ZST store-ba;
3. corporate-looking private mail → Personal `SCOPE_REVIEW` / quarantine;
4. külön explicit bridge command mozgat/csatol owner approval után;
5. a ZST acceptance a cutover utáni silent foreign crossingot FAIL-nek tekinti.

Ez **security + correctness P1**, de nem indokolja a teljes Scope Gate kidobását: a classifier továbbra is hasznos a quarantine jelzéshez, csak nem lehet automatikus cross-namespace writer.

---

# 7. A deadline/TSCG gap pontos alakja

A rendszerben már van fejlett `deadline-index.ts`, és ez jó alap. Külön kezeli például:

- `TERMINATION_DEADLINE`;
- `CONTRACT_EXPIRY`;
- `PAYMENT_DUE`;
- case due;
- follow-up;
- wake;
- initiative decision deadline.

A jelenlegi index azonban **derived read model** a meglévő oszlopokból. Nem tudja megmondani:

- ki/mi bizonyította a factet;
- VERIFIED vagy UNVERIFIED;
- melyik source locatorból jött;
- melyik factet supersede-elte;
- hogy `due_at` és a `next_action` ugyanazt a szemantikai eseményt jelentik-e.

Ezért a helyes fejlesztési irány **nem a deadline-index lecserélése**, hanem:

```text
legacy columns + domain tables
        ↓ adapter
case_temporal_facts
        ↓
TSCG
        ↓
projection/read models (deadline index, Today, wake, digest)
```

Átmenetben dual-read/parity mérés kell; destructive migration nem javasolt.

---

# 8. A consumer-completeness gap pontos alakja

A Marveenben a probléma már többször konkrétan előjött:

- Reader chain megépült, de először nem volt production caller;
- `next_wake_at` írva és olvasva volt, de az ID-k elvesztek a consumer előtt;
- planned/radar outputokhoz utólag kellett surfaced digest;
- deadline prose detector csak akkor ér valamit, ha a cycle futtatja és az eredménye owner/action surface-re jut.

A jelenlegi acceptance már tud production caller searchöt, ami erős alap. A v1.4.5 viszont ennél többet kér: **receipt + recovery + zero semantics** is kell.

Ezért egy normatív feature manifest szükséges; enélkül ugyanaz a hibacsalád új névvel visszatérhet.

---

# 9. Meglévő erős komponensek — „do not rebuild” lista

A fejlesztés során ezeket újrahasznosítani kell, nem második implementációt írni:

1. `case-engine-core` + Personal/ZST binding;
2. `case_claims` fencing + progression lease;
3. `progression-heartbeat` bounded runner;
4. `progression-trigger` effective-state dedup;
5. `capability-preflight` + WAIT_SYSTEM;
6. `kill-switch`;
7. Reader + Context Builder + sensitivity routing;
8. owner-question channel + dedup/capacity;
9. shared executor / approval core;
10. Personal/ZST outbound mode gate;
11. `deadline-index` ontology;
12. wake consumer;
13. `cos-cycle` orchestration/error isolation;
14. `cos-acceptance.py` measurement helpers;
15. `zst-acceptance.py` framework;
16. `reconcile.ts` UNKNOWN/unreadable discipline;
17. content-addressed document store;
18. ZST bank CSV parser/importer;
19. ZST Product Lab gateway;
20. ZST outbound endpoints.

Második párhuzamos implementáció ezekre új drift-forrás lenne.

---

# 10. Acceptance gap — a fejlesztést ezzel kell kezdeni

Az új target csak akkor fejleszthető biztonságosan, ha **először a mérőeszköz lesz piros**.

Kötelező új vagy bővített gate-ek:

- TSCG exists + Hertz/Sixt fixture;
- orphan case counts Personal/ZST;
- temporal conflict / unconsumed verified deadline;
- CPP manifest completeness;
- production caller + receipt source;
- standardized zero telemetry;
- Reader evidence watermark;
- stale evidence owner/external gate;
- pre-existing backlog fixture;
- strict connector identity after cutover;
- ZST operational projection;
- migration canary evidence;
- extraction-state completeness;
- credential scope introspection / UNKNOWN;
- promotion readiness + stability window.

**Mutation proof:** minden kritikus protection célzott kivétele tegye pirossá a hozzá rendelt nevesített tesztet.

---

# 11. Release-gate összefoglaló

## Personal v4.4 supervised GO

Csak akkor zöld, ha:

- TSCG működik;
- orphan=0 az aktív supported scope-ban;
- CPP kritikus feature-ekre teljes;
- document extraction-state nem silent null;
- reconcile nem állít UNKNOWN-ból 0-t;
- outbound/payment/legal safety regression zöld.

## Personal unattended eligibility

Ezen felül:

- Hertz/Sixt fixture;
- stale 37s fixture;
- unconsumed deadline/wake = 0;
- 7 nap P1 silent failure nélkül.

## ZST v1.2 operational GO

Csak akkor:

- strict connector boundary él;
- új intake operational projectiont ad;
- new-case orphan=0;
- temporal fact + TSCG él;
- 2+5 canary legacy migration hibamentes;
- legal/finance/email hard gates változatlanul zöldek;
- legalább 5 különböző valós ZST E2E ügy bizonyított.

## ACP v1.5 unlock

Továbbra is **LOCKED**, amíg a v1.4.5 readiness gate nem zöld az érintett domain/scope-on.

---

# 12. Végső minősítés

**Personal v4.4:** jó brownfield upgrade; fő blokk a semantic time + shared completeness.  
**ACP v1.4.5:** az engine substrate erős; a hiány főleg enforceable release hardening.  
**ZST v1.2:** a technikai alap jelentős része létezik, de az operational CoS jelleg még nincs végigvezetve az intake→next_action→temporal→ACP→brief láncon.

A helyes stratégia:

> **measure first → shared semantic core → shared actionability/CPP → security boundary → Personal hardening → ZST operational migration → readiness promotion.**

Nem javasolt a ZST domain-features tömeges továbbépítése addig, amíg az operational projection, Actionability Gate és strict namespace boundary nincs kész, mert az új adatok ugyanabba az „iktat, de nem hajt” állapotba kerülnének.
