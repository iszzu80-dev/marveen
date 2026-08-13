# Marveen ACP — v1.4 / v1.5 Release Split Handoff

**Dátum:** 2026-08-13  
**Forrás:** a korábbi általános proaktív v1.4.1 modell review-ja  
**Cél:** implementation boundary, value gate és trust-boundary go/no-go egyértelmű rögzítése

---

# 1. Döntés

A korábbi v1.4.1 koncepcionális proaktív modellje megmarad, de két release-re válik:

```text
v1.4 = Proactive Core
v1.5 = External Research & Browser Autonomy
```

A split oka nem terméklogikai, hanem **trust-boundary és maturity** alapú:

```text
Proactive Core = brownfield / existing COS progression foundations
Browser + external research = separate external execution surface
```

---

# 1.1 Review-integrated release rule

A split után három további kötelező gate van:

```text
v1.4 mechanism health != v1.4 success
v1.4 success requires pre-registered incremental value
v1.5 requires both v1.4 value proof and G0 target-set existence proof
```

A v1.4 shadow success contract **historical-volume calibrated és pre-registered**:

```text
90-day replay first
→ measure eligible volume
→ choose measurable 30/60/90-day shadow window
→ freeze minimum eligible observations + required incremental catches + false-positive ceiling
→ blind adjudication against independently persisted reactive control
```

Default candidate csak akkor, ha a replay volumene támogatja: `>=5` validated incremental material catch / 30 nap és `<=2` false-positive interruption candidate / 7 nap. A küszöbök, adjudicatorok, cadence és timeliness rubric shadow indulás előtt rögzítendők; utólagos success-preserving átírás tilos. Low-volume vagy degraded adjudication külön non-PASS kimenet.

---

# 2. v1.4 ownership

A v1.4 kizárólag:

- ProactiveSignal;
- ProactiveInitiative;
- qualification/materiality;
- duplicate/novelty suppression;
- Case matching/promotion;
- Desired Outcome / Gap;
- deadline inventory + normalization/index as derived read model;
- Scheduled Proactive Sweep;
- sweep fairness;
- cursor monotonicity;
- no silent truncation;
- due-state advancement;
- stall detection;
- anomaly detection;
- Resolve-before-ask;
- internal Autonomous Preparation Planner + code-level action/import standing boundary tests;
- PreparedInitiative artifact;
- interruption cooldown/backpressure;
- separate approval-load rate limiting/coalescing;
- proactive draft factual-quality gate;
- capability preflight / WAIT_SYSTEM;
- replay/shadow/eval;
- historical-volume calibration + pre-registered value gate;
- blind adjudication + independent reactive control;
- deadline-aware approval escape hatch.

**v1.4 stop gate:** nulla új külső execution surface.

---

# 3. v1.5 ownership

A v1.5 kizárólag v1.4-re építve:

- ExternalEvidenceGap;
- ResearchJob;
- source quality policy;
- external research orchestration;
- browser adapter/runtime;
- BrowserResearchSession;
- checkpoints;
- resume/recovery;
- CAPTCHA/login human takeover;
- external disclosure policy;
- external submit idempotency;
- OUTCOME_UNKNOWN/readback;
- evidence normalization/freshness;
- apples-to-apples comparison;
- Decision Assessment;
- optional commercial comparison specialization.

---

# 4. Old v1.4.1 → new release mapping

| Korábbi v1.4.1 terület | Új hely |
|---|---|
| Proactive Initiative | v1.4 |
| Signal Detection | v1.4 |
| Qualification Policy | v1.4 |
| Initiative → Case | v1.4 |
| Desired State / Gap | v1.4 |
| Safe internal deadline | v1.4 |
| Scheduled Proactive Sweep | v1.4 |
| Resolve-before-ask | v1.4 |
| Autonomous Preparation | v1.4, internal-only |
| Stall Detection | v1.4 |
| Anomaly Detection | v1.4 |
| Interruption Budget | v1.4, execution mechanism required |
| Capability Preflight | split: internal v1.4, external v1.5 |
| Generic Research Orchestrator | v1.5 |
| Research Source Quality | v1.5 |
| Controlled Browser Executor | v1.5 |
| Resumable Browser Workflow | v1.5 |
| Human Takeover | v1.5 |
| Data Disclosure | v1.5 |
| Commercial Baseline/Comparison | v1.5 specialization |
| Decision Assessment | v1.5 for external comparison; existing internal decision prep remains v1.4 |
| Mission Control browser/research UI | v1.5, not v1.4 blocker |

---

# 5. Mandatory v1.4 audit additions

A review alapján a v1.4 live auditnak explicit bizonyítania kell:

```text
sweep fairness
cursor monotonicity
no silent truncation
due-state advancement
priority fairness
claim idempotency
starvation observability
existing cooldown/backpressure reuse
explicit cooldown-exception inheritance decision for approval channel
question-queue deadline ordering prerequisite / reported open item `0d2121a9`
```

Reported codebase findings live repo/DB/runtime audittal kell validálni.

---

# 6. Interruption policy change

A korábbi KPI-only Interruption Budget nem elég.

A v1.4 kötelező execution path:

```text
candidate
→ priority
→ dedupe/coalesce
→ existing per-Case cooldown
→ global/user backpressure
→ SEND / DEFER / BUNDLE / SUPPRESS
```

A reported 6h per-Case cooldown újrahasználandó, ha live audit validálja.

---

# 7. Acceptance split

Fixture IDs release-namespaced, hogy későbbi bővítésnél ne legyen számozási ütközés.

## v1.4 mandatory

- V4-F1 renewal/deadline opportunity
- V4-F2 stalled home repair
- V4-F3 warranty/deadline scheduled discovery
- V4-F4 ZST admin obligation
- V4-F5 invoice anomaly
- V4-F6 unanswered follow-up
- V4-F7 duplicate suppression
- V4-F8 sweep fairness / no truncation
- V4-F9 stale evidence replacement
- V4-F10 low-materiality suppression
- V4-F11 proactive approval-fatigue backpressure
- V4-F12 temporal derivation correctness in proactive draft
- V4-F13 blind incremental-value adjudication
- V4-F14 low-volume value-gate calibration

## v1.5 mandatory

- V5-F1 browser interruption/resume
- V5-F2 external capability failure → WAIT_SYSTEM
- V5-F3 disclosure gate
- V5-F4 binding action blocked
- V5-F5 cross-release end-to-end
- V5-F6 provider failure isolation
- V5-F7 non-comparable cheap option
- V5-F8 stale quote
- V5-F9 duplicate external submit / OUTCOME_UNKNOWN
- V5-F10 minimal human takeover

---

# 8. Delivery order

```text
v1.4 audit
→ v1.4 replay
→ [G0 target-set feasibility may run in parallel as cheap discovery]
→ v1.4 shadow + §1.4.1 szerint kalibrált és befagyasztott value/blinding evaluation window
→ v1.4 internal preparation canary
→ v1.4 production validation only if value gate passes
→ confirm G0 result
→ explicit v1.5 go/no-go
→ egress/security/legal/privacy gate
→ v1.5 browser/research build
→ v1.5 shadow/read-only
→ narrow allowlisted canary
```

A v1.5 semmilyen része nem lehet implicit blocker a v1.4 Definition of Done-ban.

---

# 8.1 Code-enforced v1.4 release boundary

A `zero new external execution surface` nem lehet csak DoD checkbox. Standing testsnek kell fail-elniük tiltott action class, browser/fetch/egress import vagy unauthorized permit path esetén.

# 8.2 Deadline consolidation rule

A deadline index nem negyedik source of truth. Minden meglévő deadline-fogalom `SUBSUMED`, `ADAPTED_TO_INDEX`, `INTENTIONALLY_DISTINCT` vagy `DEPRECATED` státuszt kap explicit ownership/rationale mellett.

# 8.3 Approval fatigue is a separate risk channel

A proaktív draftolás approval-terhelést termelhet akkor is, ha interruption rate alacsony. Emiatt külön approval budget, factual-quality gate és approval telemetry szükséges. Initial canary cap: max 2 proactive approval presentation / user / 24h és max 1 / Case / 24h.

# 8.4 v1.5 G0 rule

A browser/runtime audit előtt kézzel bizonyítani kell, hogy az adott rollout stage authority/disclosure szabályaival kompatibilis valós target set létezik. Ha nincs, a stage-et módosítani vagy elhagyni kell.

---

# 8.5 Value adjudication rule

A proactive value gate csak akkor érvényes, ha a proactive és reactive output ugyanazon frozen korpuszon, egymástól függetlenül rögzül, majd azonos canonical adjudication schema-ban, origin label és implementation-specific metadata nélkül, pre-registered timeliness rubric szerint kerül elbírálásra. A primary és backup adjudicator nevesített, független **ember**; nem lehet LLM/agent, ugyanazon modellcsalád újabb futása vagy a Proactive Core outputjának előállítója. Minden judgment előtt kötelező `origin_guess`; a blinding tesztet előre power-qualify kell (`p0=0.50`, default `p1=0.70`, one-sided `alpha=0.05`, target power `>=0.80`, default minimum 40 unique packet). Az `origin_guess_accuracy` nem lehet szignifikánsan 50% fölött; ellenkező esetben `VALUE_GATE_ADJUDICATION_CAPABILITY_GAP`. Elmaradt adjudication vagy elégtelen blinding minta külön degraded/inconclusive státuszt okoz, nem hamis PASS-t.

# 8.6 Volume-calibrated measurement rule

A 90 napos replay még a shadow előtt meghatározza az eligible volume és a blinding-validation mintaigény nagyságrendjét. A befagyasztott shadow ablak a kettő közül a hosszabb szükséges ablak: `max(value_gate_required_window, blinding_required_window)`. A blinding minimum minta power-derived, nem tetszőleges integer. `NO_EVIDENCE_DUE_TO_LOW_VOLUME` és `BLINDING_EVIDENCE_INSUFFICIENT` nem PASS, de nem mechanikai FAIL.

# 8.7 Approval deadline escape and inheritance rule

A normal approval cap nem okozhat határidő-mulasztást: `latest_present_by` / `internal_safe_deadline` közeledése deadline escape-et indít, amely presentation override, nem authority override. A meglévő interruption cooldown kivételei nem öröklődnek automatikusan approvalra; defaultként user/owner response **nem** oldja fel az approval budgetet.

# 8.8 Acceptance fixture artifact rule

A v1.4 acceptance checklist külön normatív artifact: `marveen-acp-v1.4-acceptance-fixtures.md`. A fő spec nem tart fenn duplikált fixture-szöveget; `V4-F1`–`V4-F14` változtatása verziózott acceptance-artifact módosítás.

---

# 9. Final engineering rule

> **A proaktivitás magját előbb bizonyítsuk olyan felületen, ahol már van brownfield infrastruktúránk. Külső research/browser authority csak ezután, külön trust boundaryként épüljön rá.**
