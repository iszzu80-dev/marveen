# APG v0.4-lean — Shadow Replay Plan (side-effect-free)

Date: 2026-07-16 · Mode: SHADOW (no mutation, no dispatch, no build, no deploy)

## Chosen change
**LumaSeat couple-facing landing** — Istvan directive "Couple facing legyen a pandingen": reframe the LumaSeat (Eskuvo/wedding-seating) landing from organizer-facing to couple-facing, keeping the hybrid direction (elegant app / funky landing, dark suite-shell + gold). A real, already-shipped change I coordinated (marketing copy + frontend landing edit on the standalone landing repo). Good replay candidate: contained UI change, public surface, reversible.

## Complexity classification
- Signals present: `external_publication` (public landing), `external_ui_code` (standalone landing repo). Not present: auth, tenant-isolation, payments, PII, db-migration, new-recurring-cost.
- Class: **S1** (normal change, clear requirement), NOT S2 — the blast radius is one landing's copy/layout, no data/auth/migration. The two external signals bump specific SUB-STEPS to owner-approval per `autonomy.yaml`, not the whole change:
  - deploy of the edit → `deploy_to_preapproved_environment` = automatic (landing is already live, not first-go-live).
  - any NEW public CLAIM in the copy → `external_publish` / `legal_privacy_commitment` = **owner-approval** (this is exactly the political-claim + overclaim lesson from tonight's landings — APG would gate it deterministically).
- Agent budget: **default 1, max 1** (S1, single producer; semantic review only if ambiguity flagged). No multi-agent, no verifier-per-artifact.

## 12-type minimal trace (reconstructed, references not full docs)
1. **product** — LumaSeat (base Eskuvoter, brand LumaSeat; consolidation decision on record).
2. **requirement** — "landing addresses the couple (end customer), not the organizer" + AC: hero/CTA/copy couple-facing; no new unverifiable claim.
3. **decision** — hybrid brand direction retained (elegant app / funky landing); couple-facing framing (Istvan owner decision).
4. **change** — landing copy + hero + CTA reframe (scope: standalone landing repo only).
5. **work_item** — edit hero + section copy + CTA; output-contract = served landing shows couple-facing copy, no overclaim.
6. **implementation** — frontend/marketing landing edit (commit on the *-landing repo).
7. **review** — S1 semantic review = none-unless-ambiguity; DETERMINISTIC gate = overclaim/political-claim lint (the standing red-flag list) + served-copy check.
8. **evidence** — served-bundle grep of the live landing shows the new copy; no forbidden-claim terms.
9. **release** — deploy to the landing's Render service (autoDeploy); rollback = redeploy prior commit (reversible).
10. **metric** — landing conversion signal (waitlist/registration) as the KPI to watch post-change.
11. **approval** — owner-approval ONLY on the external_publish sub-step if a new claim is introduced (else automatic).
12. **resource** — the *-landing Render service + repo.

## Profiles activated
- `ui-fullstack` (landing UI change) + its reuse-matrix.
- `product-surface-launch` (public surface, launch-state = already-live landing).
- NOT `identity-test-data` (no test-tenant needed for a shadow copy-read) and `safe-release` only at its low-risk tier (smoke + rollback, no canary).

## Context Packet (assembled, budget-checked)
- Stable cacheable prefix: methodology + ui-fullstack profile + LumaSeat product ref.
- Fresh APG-packet input (variable): the requirement + change scope + the overclaim lint list. Target ≤ **3000** fresh-input tokens (S1). Estimated actual for this change: ~1200–1800 fresh tokens (small, single-surface) — WELL under budget. See token-baseline.
- References-first: LumaSeat brand decision + prior landing copy pulled by id/just-in-time, not loaded whole.

## AS-IS vs APG fresh input (summary; detail in token-baseline)
- AS-IS (tonight's ad-hoc flow): the change rode inside my long fleet session — inherited-context heavy (the whole conversation), no bounded packet. Fresh-input for the decision was small but sat on a very large inherited context.
- APG: a bounded ~1500-fresh-token packet with references, independent of the mega-session. Big inherited-context saving; same decision quality.

## Missing evidence (what a REAL APG run would lack today)
- No linked commit→build→deploy→runtime **execution-receipt** for the landing change (GAP-APG-02) — the deploy evidence exists in Render but is not chained to the tested commit.
- No **token-origin decomposition** to prove the 3000-budget was met (GAP-APG-01) — measured only in aggregate.
- No structured **identity marker** on the change trace (GAP-APG-03) — origin_note only.
- Overclaim lint is a HUMAN standing-rule tonight, not a deterministic gate artifact — APG would formalize it as a `review` deterministic check (cheap, high value).

## Shadow verdict
The LumaSeat couple-facing change maps cleanly onto APG S1 with a single producer agent and a bounded packet. Nothing about the change is BLOCKED. The only real deltas vs today are the 4 adapter-level evidence/measurement gaps above — none of which stop the shadow, all of which a real run would want. The most valuable immediate formalization surfaced: turning the ad-hoc **overclaim/political-claim red-flag list into a deterministic `review` gate** (S1-cheap, and it would have caught tonight's MK-KATA political claim + DORA overclaims automatically).
