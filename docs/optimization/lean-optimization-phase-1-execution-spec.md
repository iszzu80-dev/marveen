# Lean Optimization Phase 1 — Execution Spec (owner GO 2026-07-29)

Card: c755f4b2 "Lean Optimization Phase 1 — Privacy Gate & Neutral Model Profiles".
Owner GO: full execution authority, implementation → production acceptance. Do NOT stop for plan
approval. Stop ONLY for a real security/data-loss blocker: contradictory newer owner decision;
non-reversible DB migration; risk of real PII/secret leak; the live dispatch path cannot be
unambiguously identified; unrelated dirty state prevents safe isolation. Normal impl detail / test
failure / fixable compat issue → fix, retest, proceed (no interim approval).

## Producer/gate split (marveen decision)
fullstackfejleszto = PRODUCER: implements Block A + Block B, writes tests, runs the 4 canaries,
reports per block for marveen's independent gate. Does NOT flip ENFORCE and does NOT close the card.
marveen = GATE + owner of the security-critical steps: independent acceptance per block, canary
verification, the OBSERVE→ENFORCE flip (only after acceptance), production acceptance, docs review,
card closure, final report.

## Canonical sources + precedence (live source is truth)
1. live source + current DB schema  2. umbrella card + linked decisions  3. src/data-sensitivity-gate.ts
4. the two gate commits 0e9759d + 97aaf3c  5. docs/optimization/lean-optimization-phase-1-corrected-plan.md (2026-07-20)
6. docs/optimization/marveen-lean-optimization-audit-2026-07-17.md  7. #517 provider-agnostic routing = LATER upstream direction only.
If the 07-17 audit and live source differ, LIVE SOURCE WINS; document the delta in the as-built report.

## BASELINE (recorded by marveen 2026-07-29)
branch develop @ 2ad7e91, v1.25.1, clean tree. Gate mode=observe-only, enabled=true
(store/data-sensitivity-gate.json live with restricted patterns email/api_key_header/jwt_token/...).
Gate commits 0e9759d + 97aaf3c. Services dashboard+channels active. 3 agents (architect, deliverylead,
fullstackfejleszto) resolved=claude-opus-5. Card c755f4b2 → in_progress.

# BLOCK A — Privacy gate finalization + enforcement
REUSE the existing src/data-sensitivity-gate.ts (already wired into message-router.ts). Do NOT build a
second gate / parallel classifier / new audit-log system / LLM classifier. Extend + clean the existing one.
First map exactly: exported types/fns, regex families, public/internal/restricted resolution, unknown
handling, feature flag/mode, provider-trust decision, message-router integration, sensitivity_audit_log
schema, existing unit+integration tests, and EVERY dispatch path that could bypass the gate. Every normal
agent-dispatch path must go through the ONE authoritative gate; wire any bypassing internal/API paths in,
or prove they send no user/task content to a provider.

## 3.2 Four-state classification: public | internal | restricted | unknown
unknown is its OWN state (NOT stored as restricted). But for PROVIDER-ELIGIBILITY treat unknown fail-closed
(>= restricted strictness). Audit must distinguish an actual restricted hit from missing/uncertain classification.

## 3.3 Metadata-first data path
Add OPTIONAL `dataSensitivity` field to relevant Kanban card / dispatch / API schemas (public|internal|
restricted|unknown). Optional + backward-compatible; NO invented backfill of old cards; missing → unknown;
bad value → validation error; NO silent fallback to public; field persists end-to-end; dispatch INHERITS the
card's explicit value unless dispatch gives a STRICTER explicit value; dispatch may only escalate UP, never down.
Data path: Kanban dataSensitivity → API/schema validation → dispatch payload → workflow/task policy →
content detector → effective sensitivity → provider trust check → PASS/ASK/BLOCK → metadata-only audit event.

## 3.4 Classification precedence
1. explicit dispatch metadata  2. explicit Kanban card metadata  3. optional predefined task/workflow policy
4. existing deterministic content detector  5. unknown.
Policy is NOT agent-role blanket-deny (e.g. jogasz is NOT auto-restricted on every task). V1 policy minimal:
default only for clear workflows; concrete project/account/provider data stays local; missing policy != public.

## 3.5 Regex content detector = second layer
Keep the regex families as a second layer. Deterministic, zero-LLM, can only ESCALATE, cannot override an
explicit classification DOWN, cannot auto-declare uncertain content public, emits REASON CODES (not prompt
excerpts), never logs the concrete matched PII/secret. Resolution rules:
- explicit restricted → restricted
- explicit internal + restricted signal → restricted (reason metadata_content_escalation)
- explicit public + restricted signal → restricted or conflict; ENFORCE → ASK/BLOCK (reason metadata_content_conflict)
- explicit public + internal signal → >= internal (reason metadata_content_escalation)
- no metadata + restricted signal → restricted
- no metadata + internal signal → internal
- no metadata + only public signal → NOT auto public; stays unknown unless an explicit workflow policy set public
- no metadata + no reliable signal → unknown
The detector must NEVER auto-mark an unlabeled task safe for a non-trusted provider.

## 3.6 Provider trust map
Separate generic gate logic from concrete trust policy. Trust map: deployment-local, gitignored/local-override,
NO secrets, may grant up-to-a-level per provider/account/runtime, default-DENY. Semantics:
`provider/runtime: allowedSensitivity: [public, internal, restricted]` (or simpler equivalent).
Missing map → fail-closed; bad map → fail-closed + clear health/error event; unknown provider → not trusted;
concrete local account/provider/jurisdiction policy NOT in the generic core default; repo may ship a safe
example/schema but real mapping stays deployment-local.

## 3.7 PASS / ASK / BLOCK
PASS only if: provider allowed for the effective sensitivity AND no unresolved metadata/content conflict AND
valid gate config. ASK (interactive dispatch): unknown + not-adequately-trusted provider; metadata/content
conflict; explicit-owner-override case. ASK MUST NOT forward the task content to the provider. BLOCK: restricted +
non-privacy-approved provider; ANY ask in unattended/background; bad/missing trust policy; unknown provider;
explicit-forbidden provider/runtime; gate internal error when provider not proven trusted. NO automatic
cross-provider privacy downgrade. Gate does NOT auto-pick another provider in Phase 1; no auto-fallback after ASK/BLOCK.

## 3.8 Modes: OFF | OBSERVE | ENFORCE (single authoritative flag)
OFF: no dispatch-decision change, minimal health diag, emergency rollback. OBSERVE: full classification +
provider-eligibility run, log would_pass/would_ask/would_block, dispatch NOT blocked, no prompt content in log.
ENFORCE: PASS proceeds; ASK needs interactive approval; unattended ASK blocks; BLOCK actually stops dispatch
BEFORE the provider call. Mode change needs NO source edit; safely configurable + reversible. Phase 1 end state = ENFORCE.

## 3.9 Audit log
Use/extend sensitivity_audit_log. Store metadata: timestamp, dispatch/card/task ID, agent, target provider/runtime,
explicit-metadata source, explicit sensitivity, policy sensitivity, detector sensitivity, effective sensitivity,
mode, action (pass/ask/block or would_*), reason codes, conflict flag, feature/config version. NEVER store: full
prompt, prompt excerpt, PII, credential, token, secret, the concrete regex-matched value, full file content. Migration
if needed: idempotent, forward-compatible, no fake backfill, new fields nullable/unknown, rollback needs no lossy downgrade.

## 4 Block A tests + canaries
4.1 Unit matrix (>= these): explicit public+no signal; explicit internal+no signal; explicit restricted; no-meta+restricted
signal; no-meta+internal signal; no-meta+public signal; no-meta+no signal; explicit public+restricted signal; explicit
internal+restricted signal; explicit restricted+public signal; bad metadata; missing trust map; bad trust map; unknown
provider; trusted provider; non-trusted provider; interactive ASK; unattended ASK→BLOCK; OFF/OBSERVE/ENFORCE semantics;
audit log contains NO input content; detector reason code contains NO matched value.
4.2 Integration: decision happens BEFORE the real provider call; BLOCK → no provider call; ASK → no provider call without
approval; OBSERVE logs would_block but test dispatch proceeds; ENFORCE blocks the same dispatch; Kanban dataSensitivity
reaches the gate; dispatch explicit escalation works; explicit down-relax does NOT work; NO bypassing agent-dispatch path
beside the normal message-router.
4.3 Canaries (KEEP fleet hold; do NOT release backlog; do NOT switch agents to DeepSeek for canary). If no live
non-trusted provider, a stub/fixture on the ACTUAL production dispatch code path is acceptable IF it provably runs the same
gate+eligibility code before the real provider call. NEVER send data to a real external API for a canary.
 C1 public-research NEGATIVE: fully public synthetic research task, explicit public, real dispatch/gate path, non-trusted
   provider modeled by fixture → expect PASS, 0 false positive, metadata-only log.
 C2 restricted-legal POSITIVE: synthetic-only (no real personal/customer data), explicit restricted, legal/jogász task,
   non-trusted provider → expect ASK or BLOCK, 0 provider call, no real restricted data leaves the machine.
 C3 metadata/content conflict: explicit public + content carrying synthetic restricted sample → expect escalation/conflict;
   ENFORCE → ASK/BLOCK; 0 provider call.
 C4 unattended unknown: no metadata + no reliable signal + unattended/background + non-trusted provider → expect BLOCK, 0 provider call.
4.4 Enforcement GO (OBSERVE→ENFORCE) only when: unit+integration green; all 4 canaries pass; public-canary false positive 0;
restricted/conflict/unknown provider-call 0; log-redaction test green; rollback test green; service health green. THEN flip
ENFORCE (marveen does this). P0 hole is closed ONLY after ENFORCE.

# BLOCK B — Neutral model-profile layer
5.1 Conflict pre-check: inspect templates/profiles/*.json, src/web/profiles.ts, every profile/agentProfile/templateProfile/
modelProfile ref, agent creation/onboarding/profile UI, agent-config.json schema, readAgentModel()/resolveModelId(),
/api/agents output. Decide by EVIDENCE whether existing profile infra is agent-template/role-persona/actual model-routing.
If different semantics, do NOT overload/rename fragilely — introduce a SEPARATE explicit `modelProfile` concept+config.
Do NOT build a parallel full agent-profile system.
5.2 Profiles: premium_reasoning, build_strong, analysis_efficient, routine_lowcost. Core knows only the profile IDs + the
resolver schema; concrete model/account/provider resolution is deployment-local. Since all 21 agents may be on Claude Opus 5,
do NOT use the 07-17 old model assignment; build the neutral map from the CURRENT live snapshot so canary agents' resolved
model+account do NOT change. The four profiles MAY temporarily resolve to the same concrete model — Phase 1 goal is abstraction,
not re-tiering.
5.3 Resolver precedence: 1. explicit model  2. modelProfile resolution  3. current default model. legacy model field still
works; explicit model unchanged; modelProfile optional; unknown modelProfile → validation error; bad profile map → validation
error; missing profile map → NO silent model change; account/CLAUDE_CONFIG_DIR resolution unchanged; NO auto provider/account
switch; NO capacity routing; NO task-by-task routing; NO sticky-card routing in Phase 1.
5.4 Config: generic resolver upstream-compatible. Deployment-local: profile→model mapping, account mapping, provider mapping,
price, privacy trust map. Local map gitignored/isolated + validated; safe example/schema in repo; missing/bad map → no silent
model fallback. Change minimal + additive; do NOT touch 21 agent configs unnecessarily.
5.5 Canary agents: buildfejleszto→build_strong, research→analysis_efficient. Record before: configured model, resolved model,
active model, account/config-dir, run state, relevant env routing. Measure the same after. REQUIRED: resolved model before==after;
account/config-dir before==after; provider routing before==after; /api/agents before/after behavioral diff empty except the new
modelProfile metadata field.
5.6 Model-profile tests (>=): legacy explicit model; valid modelProfile; explicit model + modelProfile → explicit wins; unknown
profile → error; bad map → error; missing map + legacy model → legacy works; missing map + only modelProfile → fail-safe error;
account resolution unchanged; API output configured-vs-resolved clearly separated; canary agent restart → same model boots;
rollback → legacy state restored.

# BLOCK C — Integrated acceptance + closure
6.1 Full gate: build, typecheck, unit, integration, lint, schema/migration tests, relevant security/prompt-safety tests, UI/API
tests if schema or /api/agents changed, service smoke. NOT green if any known relevant failure. Unrelated pre-existing failure:
prove pre-existing, run targeted tests, document separately, do not hide. (NOTE: run the full suite from a WORKTREE — the live
install has assert-not-live-install gate that throws `npm test` in ~/marveen.)
6.2 Rollback proof: gate ENFORCE→OBSERVE→OFF works by flag, then restore to ENFORCE. Model-profile: remove canary modelProfile →
legacy explicit model still works, resolved model unchanged, then restore accepted Phase-1 config. DB: rollback needs no lossy
schema downgrade; new nullable fields/table may stay inactive.
6.3 Services/fleet: restart only what is needed, canary-first, verify clean boot, KEEP fleet hold, no normal backlog dispatch,
Phase 2 does NOT start, no auto fallback, no package/account change. End state: gate ENFORCE; public task proceeds per trusted
policy; restricted/unknown → non-trusted provider blocked/ASK; model-profile resolver active; two canary agents on neutral profile;
all other agents unchanged; fleet stays held unless a separate owner decision released it.
6.4 Status hygiene: card in_progress during work, done ONLY after full acceptance. Close card with a tight evidence-based summary
(scope done, commits, tests, canaries, enforcement, model diff, rollback, remaining out-of-scope). Do NOT create a new card for the
same Phase 1 scope.
6.5 Docs: A) docs/optimization/lean-optimization-phase-1-as-built.md (starting state; changes since audit; final architecture; data
path; precedence; provider-trust handling; feature flags; DB/schema changes; model-profile resolver; test+canary evidence;
before/after diff; rollback evidence; known limits; Phase 2 prerequisites). B) Audit status addendum — do NOT rewrite the 07-17 audit
historically; short addendum: G4 no longer MISSING, IMPLEMENTED after ENFORCE; extent G1 IMPLEMENTED; which gaps remain Phase 2/3/4.
6.6 Commits: few, well-separated. Suggested max: `feat(security): enforce metadata-first data-sensitivity gate`;
`feat(models): add behavior-neutral model profiles`; `docs(optimization): close lean optimization phase 1`. Separate migration commit
if warranted. Each commit clear, revertible, NO local secret/trust-map values, no Phase 2 scope, no unrelated cleanup. Separate generic
from local parts for upstream-updatability.
6.7 Upstream boundary: do NOT auto-open an upstream issue/PR now. In the closing report mark: Upstream candidate = generic modelProfile
schema+resolver, generic sensitivity metadata, generic dispatch-guard interface+reason codes, provider-agnostic trust-policy adapter.
Local only = concrete provider trust map, concrete accounts, concrete model mapping, local privacy policy, current feature-flag state.
Check #517 + relevant existing upstream PRs to avoid proposing duplication. After Phase 1 closure, only RECOMMEND upstream packaging;
do not publish without a separate owner GO.

# 7 STRICT scope boundary — do NOT implement in Phase 1
task-by-task dynamic model optimization; per-agent 1-3 task-profile actual routing; sticky card→runtime routing; capacity-state
registry; automatic provider fallback; primary retry TTL; CostOps schema/outcome extension; cost_per_accepted_task metric; package
upgrade/downgrade advisor; market screening; context-budget Phase-2 changes; automatic package/credit/account change; releasing the
fleet hold. Do NOT re-activate the old Claude-only banner-scraper fallback.

# 8 Acceptance criteria (Phase 1 DONE only if ALL hold)
Privacy: 4-state works; metadata end-to-end to gate; regex escalate-only; unknown NOT to non-trusted; restricted NOT to non-trusted;
unattended ASK blocks; no auto privacy downgrade; gate zero-LLM; audit metadata-only; trust-map missing/bad fail-closed; mode ENFORCE.
Canary: public PASS; restricted ASK/BLOCK; conflict ASK/BLOCK; unattended-unknown BLOCK; 0 false positive; 0 external provider call on
restricted/conflict/unknown. Profiles: 4 generic profiles; resolver precedence correct; legacy explicit model compatible; unknown profile
errors; buildfejleszto+research canary resolved model unchanged; account/config-dir unchanged; no fleet-wide model change. Quality:
build/typecheck/test/lint green; migration safe; rollback proven; services healthy; no secret/PII in commits or logs; deployment
upstream-updatable. Governance: card DONE; as-built doc; audit addendum; Phase 2 not started; upstream only documented as recommendation.

# 9 Final report (marveen): card status; branch+commit SHAs; changed files; gate final mode; classification precedence; provider trust
fail-safe; 4 canary results; false-positive/false-negative; provider-call evidence on blocked tests; audit redaction evidence; model-profile
before/after diff; account/config-dir before/after diff; full gate; rollback evidence; service/fleet health; as-built path; audit addendum
path; upstream candidates; remaining Phase 2-4 scope; verdict PHASE 1 DONE or NO-GO. If acceptance holds → close card, report DONE. If not →
NOT done; set documented blocked/in_progress, fix all safely-fixable, return only on a real hard blocker.
