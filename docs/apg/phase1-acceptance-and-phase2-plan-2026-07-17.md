# APG Phase 1 Acceptance Report + Phase 2 (Assisted Pilot) PLAN

Date: 2026-07-17 · Owner ratification: Istvan (TG 6095) · Prepared by: marveen
Status markers ratified: `PHASE0_COMPLETE`, `PHASE1_COMPLETE`, `A1_CONFIRMATION_PILOT_ACCEPTED`, `READY_FOR_PHASE2_OWNER_DECISION`

---

## PART 1 — PHASE 1 ACCEPTANCE (immutable baseline)

### What Phase 1 was
A1 = **observe-only** autonomy. The APG kernel (sidecar `~/marveen-local/apg-kernel`, own `apg-kernel.db`, append-only) reads real fleet sources (kanban dashboard GET, git show/grep, bus messages GET, token_usage read-only) and produces **provenance receipts** for a change. It never writes to any fleet system, never dispatches, never changes status. Phase 1 comprised two hardening increments + one live confirmation pilot.

### Accepted commits (sidecar `master`, all in HEAD ancestry)
| Commit | Content | Acceptance |
|--------|---------|-----------|
| `37cda0c` | a1-hardening: minimal live receipt + checkpoint refresh (card a2d1477d) | accepted: official receipt immutable, append-only structurally enforced, receipt_chain.py 0-diff, core 0/0, 330/330 |
| `48873a8` | a1-hardening: kanban-comment read-only evidence-locator adapter (card 2bb55214) | accepted: read-only, decode-not-execute, same test bar |
| `7099fab` | a1-pilot: parameterize confirmation-pilot adapter + close change 68c3420c (card 6aadb67c) | accepted: see confirmation-pilot verification below |

### Confirmation pilot — independent verification (not self-accepted)
Change observed: **68c3420c** (DORA assurance-pack render), commit `5038f2ea` in dora repo, built normally by architect post-watermark = genuinely LIVE_OBSERVED. Marveen verified buildfejleszto's closing report **directly against apg-kernel.db**, not the self-report:

- Envelopes: **114** total = 112 ACCEPTED + 2 ACCEPTED_POTENTIAL_GAP (benign kanban sequence-gap), **0 rejections**. Source spread 101 token_usage + 7 agent_message + 4 kanban_card_event + 1 git_commit + 1 build_test_author_assertion.
- **LIVE == REPLAY identical** (final live receipt signature == final replay receipt signature).
- Receipts genuinely incremental (early receipt commit_chain_status MISSING → later UNKNOWN as commit/test/message evidence arrived).
- Checkpoints (spec_ready / verification_ready / release_ready / runtime_acceptance): **all deterministic UNKNOWN** across 8 evaluations — honest (no real CI/deploy/runtime consumer for this backlog feature), **0 false PASS/FAIL**.
- The single author-asserted build claim **never promoted past MISSING** (author-assertion-is-not-evidence held).
- Read-only boundary held; the only mutable free-text read (kanban comment content) never persisted past local scope. Locator VERIFIED_COMMIT_LOCATOR resolved to `5038f2ea`, cross-verified against the independent git-grep adapter.
- Only sanctioned change-correlations present in the DB (no contamination); duplicate re-ingest delta = 0.

Verdict: **A1 CONFIRMATION PILOT ACCEPTED.**

### Immutable baseline + rollback
- **Baseline tag:** `A1_STABLE_BASELINE` (annotated) → `7099fab` (contains all 3 accepted commits in ancestry). Sidecar-only, reversible reference.
- **Rollback target name:** `A1_STABLE_BASELINE`
- **Return mode:** `A0` (full stop — kernel does nothing; sidecar dormant). A1 = observe-only baseline. Rollback path: `git -C ~/marveen-local/apg-kernel checkout A1_STABLE_BASELINE` (to pin the accepted state) or disable the kernel entirely for A0.
- **Core impact:** NONE. Everything is sidecar; marveen core (`claudeclaw.db`) sha256 verified UNCHANGED across the full observation.

---

## PART 2 — PHASE 2 (ASSISTED) PILOT PLAN — **PLANNED ONLY, NOT ACTIVATED**

Phase 2 = **A-assist**: the kernel may *propose* a next step, *prepare* a kanban comment or status-suggestion, *flag* missing evidence, *produce* a recommendation artifact — but **executes nothing without human approval**. This is a plan only. No activation occurs without a separate owner GO.

### Candidate changes (≤3)
- **Candidate A — MK price revert (card 5f39d7f0)** — RECOMMENDED (low-risk): tiny, single-file landing copy change (3490→3500), clear evidence chain (1 commit + served-bytes verify + card close), near-zero blast radius. Ideal first assisted subject.
- **Candidate B — Zsibongo segito-cert live-deploy verify (card daca1e3b)**: moderate — migration + gating already landed, the assisted task is an evidence-completeness draft ("is the deploy verified live?"). Medium complexity.
- **Candidate C — DORA RESTRICTIVE workspace-RLS migration (card 2f797752)**: high-risk/security (the 4-cross-tenant-leak fix). Excellent later stress test for assisted evidence-gap flagging, but NOT the starter — too consequential for a first assisted pilot.

### Recommended pilot: **Candidate A** (MK price revert).

### Exact assisted capability (what A2 may do)
Observe the change's evidence chain (as A1 does), then assemble a **DRAFT recommendation artifact** containing: (1) evidence-completeness assessment; (2) a *suggested* card status (e.g. ready-to-close vs missing-evidence) — **draft text only**; (3) explicit missing-evidence flags. That's it.

### Which outputs are drafts (all of them)
Every A2 output is a draft artifact in the sidecar: the recommendation, the suggested comment text, the suggested status. **None is applied by the kernel.**

### Where owner approval is required
Before ANY of: kanban write, status change, acting on the recommendation, dispatch, or any fleet-visible effect. A human (marveen/deliverylead) reads the draft artifact and manually applies it if they agree.

### Side-effect boundary
Read-only on all fleet sources (identical to A1) **plus** append-only writes to the kernel's **own recommendation-artifact store** in `apg-kernel.db` (sidecar). NEVER writes `claudeclaw.db`, NEVER writes any repo, NEVER dispatches, NEVER changes status.

### Rollback
- To **A1**: disable draft-generation → back to pure observe-only (baseline `A1_STABLE_BASELINE`).
- To **A0**: full stop.

### Success criteria
On the recommended candidate: draft recommendation is accurate; **0 false "ready-to-close" on incomplete evidence**; **0 unauthorized writes** (claudeclaw/repo untouched, verified by checksum); human agrees with the draft's evidence assessment; live==replay still holds for the underlying observation.

### Stop conditions
Any unauthorized write attempt; any draft that — had it been auto-applied — would have caused a wrong action; any credential-scope drift; any core-DB checksum change; any receipt-chain break.

### Needed new adapters / write-scopes
- ONE new component: an **append-only recommendation-artifact writer** (sidecar-only).
- NO new read-scope beyond A1's existing GET/read-only reads.
- NO `claudeclaw.db` write scope. NO repo write. NO dispatch capability.

### Core-modification need
**NONE.** Sidecar-only, same as A1.

### Expected ceremony / runtime overhead
Small: one extra artifact-assembly + persistence step per observed change; no change to the observation path itself.

### Confirmation + acceptance process (same discipline as A1)
Producer shows the diff/plan first → owner GO → run on the recommended candidate only → marveen independent acceptance (verify drafts against DB, verify zero unauthorized writes) → consolidated verdict before any expansion. Canary-gated, ≤2 fix-retest.

---

## Guardrails still in force (no owner GO given for any of these)
Phase 2 activation · A2 autonomy · kanban write from APG · agent dispatch from APG · status change from APG suggestion · auto-execution of a recommendation · source/build/deploy · credential-scope expansion · new core integration · upstream issue/PR. **Normal already-approved product-dev work continues at its current autonomy level, unaffected.**
