# APG 0.4 Lean UI — As-Built

> Card `0f75d35d`. Owner spec (verbatim, Hungarian): `docs/apg/apg-0.4-lean-ui-integration-spec.md`
> (sections 1–28). Task 2 of 2, sequenced after the optimization dashboard (task 1, merged
> `1d10ba1`, sibling card `12d5c98d`).
> Branch `feat/apg-0.4-lean-ui-integration`, worktree `~/marveen-worktrees/apg-0.4-lean-ui`, off `develop@1d10ba1`.
> Producer: buildfejleszto. Heavy scaffolding delegated to Codex CLI (`gpt-5.6-sol`,
> `model_reasoning_effort=high`), every file reviewed, tested, and in several cases fixed by the
> producer before commit — see "Codex-run evidence and bugs found" below. **Owner acceptance
> against section 24 + stop-conditions section 27 belongs to marveen; this document is the
> producer's self-report, not a self-declared verdict.**

## 1. Goal

A light, evidence-driven APG control layer inside existing Marveen surfaces (Overview, Kanban, card
detail, Approvals, Activity, Settings) — no new APG main menu, no second Kanban, no second approval
system. The APG kernel sidecar (`~/marveen-local/apg-kernel`, Python, its own SQLite store) stays the
sole authority; everything built here is a read-only projection plus a thin UI-side layer for mode/scope
config and owner decisions. Ships `APG_MODE=off` by default.

## 2. Architecture

```
src/apg/
  ui-types.ts          -- wire contract (ApgUiSummary, ApgUiWorkItemSummary, ApgWorkItemDetail,
                           ApgClaim, ApgEvent, ApgScopeOverride) + the 8-state canonical
                           display-state -> HU/EN label/icon/severity mapping
  ui-projection.ts      -- read-only deterministic projection over the APG kernel sidecar SQLite,
                           opened `{readonly:true, fileMustExist:true}`, degrading per-table on a
                           missing table instead of throwing. deriveDisplayState() is a pure,
                           directly-unit-tested function.
  ui-read-model.ts       -- TTL(10s) + mtime-invalidated cache over the summary build

src/web/
  apg-scope-overrides.ts -- Marveen's OWN UI-side config: which mode a project/kanban_card scope
                            shows (store/apg-scope-overrides.json) + a UI action audit trail
                            (store/apg-ui-audit.jsonl, append-only) -- explicitly NOT sidecar
                            domain truth. resolveEffectiveApgMode() enforces the absolute-master-
                            off rule (a global off cannot be raised by any scope override).
  routes/apg.ts           -- GET summary/work-items/:id(/claims|/receipts|/events)/scope-overrides,
                            PUT/DELETE scope-overrides, POST approvals/:id/decision. Decision reuses
                            the EXISTING generic approval store (getApproval/resolveApproval);
                            resolved_by is always the literal 'dashboard' (spec 19.3), never an
                            agent name. Idempotency replay store
                            (store/apg-decision-idempotency.json) so a retried identical decision
                            request returns the ORIGINAL response instead of a false 409.

config-registry.ts       -- 11 new `module:'apg'` settings (APG_MODE + 6 UI toggles + 4 enforcement
                            toggles), all requiresRestart:false, APG_MODE default 'off'. Renders as
                            a free, auto-generated Settings tab (the settings page is already
                            generic over SETTINGS_REGISTRY modules -- no new frontend code needed
                            for the toggle UI itself, spec 14.1-14.4).

web/apg.js (window.Apg)  -- additive-only, ~750 lines. Every existing render function's own output
                            is untouched; each hook fires a NEW `marveen:*` CustomEvent (no prior
                            precedent in this codebase -- see "Frontend hook contract" below) at the
                            true end of its function, apg.js listens and populates its OWN
                            containers. Overview (summary strip + attention list), Kanban (per-card
                            badge + 5 quick-filter chips), card-detail (collapsible APG panel),
                            Approvals (decision cards for the 4 owner actions), Activity
                            (supplementary, explicitly labelled as attention-derived not a full log).
web/apg.css               -- page-scoped, only existing theme --variables, light/dark automatic.
web/lang/{hu,en}.js        -- ~60 `apg.*` i18n keys; every apg.js string routes through t() except
                            formatAge()'s relative-time units (documented exception).
```

### Frontend hook contract (new, established in this pass)

| Existing render function | Event dispatched (end of function) | Listener |
|---|---|---|
| `loadOverview()` | `marveen:overview-rendered` | `Apg.renderOverview()` |
| `renderKanban()` | `marveen:kanban-rendered` | `Apg.onKanbanRendered()` |
| `_renderApprovalsTable()` | `marveen:approvals-rendered` | `Apg.onApprovalsRendered()` |
| `renderActivity(entries)` | `marveen:activity-rendered` | `Apg.onActivityRendered()` |
| `showCardDetail(card)` | `marveen:kanban-card-opened` (detail: `{cardId}`) | `Apg.onKanbanCardOpened(cardId)` |

Total upstream-shared-file diff: `src/web.ts` +2 lines, `web/app.js` +8 lines (6 event dispatches +
1 guarded `Apg.mount()` call + 1 `known`-map entry), `web/index.html` +6 lines (2 asset tags + 4
hidden container divs). `config-registry.ts`'s +101 lines are a pure append (11 new objects), no
existing entry touched.

## 3. Codex-run evidence and bugs found

All heavy scaffolding delegated to `codex exec -m gpt-5.6-sol -c model_reasoning_effort=high`, run
from the worktree, `-s workspace-write`, prompt piped via stdin (backtick-safe). 4 runs:

1. **Backend read model** (`ui-types.ts`/`ui-projection.ts`/`ui-read-model.ts` + config-registry
   entries). Completed, self-reported `tsc` clean. Producer review found **2 real bugs**: (a)
   `unavailableSummary`/`errorSummary` collapsed `mode` to `'off'` on any store-read failure, which
   would have silently defeated `enforced` mode's fail-closed requirement (spec 3) downstream —
   fixed to preserve the real configured mode; (b) `buildApgWorkItemSummaries`/
   `buildApgWorkItemDetail` excluded `kind='work_item'` canonical rows while `buildApgUiSummary`'s
   counts included them — a summary `attention_item` could point its `deep_link` at a detail id the
   list/detail endpoints would then report `not_found`. Fixed for consistency.
2. **API routes** (`apg-scope-overrides.ts`/`routes/apg.ts` + `web.ts` wiring). Completed, self-
   reported `tsc` clean. Producer review found **1 real gap**: `idempotency_key` was accepted,
   validated, and logged to the audit trail, but never actually used to REPLAY a prior response —
   spec 7.4 requires "same key → same result", and the generated code would instead hit the
   generic "already resolved" 409 path on a legitimate retry, indistinguishable from a genuinely
   conflicting second decision with a different key. Added a small idempotency-replay store
   (`store/apg-decision-idempotency.json`) and wired it in; a route-smoke test now asserts the
   replay-vs-conflict distinction directly.
3. **Frontend** (`apg.js`/`apg.css` + `index.html`/`app.js` hooks). **Hit a real 10-minute
   foreground timeout (exit 143) on its own final self-report** — the largest single-run scope of
   the four. All file edits had already landed completely and consistently BEFORE the kill;
   verified independently rather than trusting the (absent) self-report: `node --check` and
   `tsc --noEmit` both clean, and every DOM id / global apg.js references
   (`#kanbanQuickFilters`, `_approvalsAll`, `kanbanCards`, `.kanban-card-footer`,
   `.kanban-card[data-id]`) confirmed to actually exist in `web/app.js`/`web/index.html` by direct
   grep, not assumed from the prompt.
4. **i18n** was NOT delegated to Codex — done directly by the producer (mechanical but precision-
   sensitive: had to match every literal string Codex had hardcoded in stage 3, including several
   that were accidentally hardcoded in ENGLISH — "APG state unavailable" — inside an otherwise
   Hungarian-primary UI). Cross-checked programmatically that every `apg.*` key `apg.js` references
   exists in both `hu.js` and `en.js`.

### Post-hoc manual audit (not Codex, producer-only)

A systematic off-mode DOM audit (spec 22: `APG_MODE=off` must leave the DOM "essentially" as if this
module didn't exist) found **2 of 5 surfaces did not honor it**: `onApprovalsRendered` had no mode
check at all (would show an empty-but-visible "APG decisions" section even fully off, the moment any
approval carried `category='apg_decision'`); `onActivityRendered` checked mode but rendered a visible
"APG is disabled" block instead of hiding, plus flashed a loading placeholder before knowing the
mode. Both fixed (stage 6 commit); the other 3 surfaces (Overview, Kanban, card-detail) were re-read
and confirmed already correct.

## 4. Verification

- `npx tsc --noEmit`: clean, re-run after every stage's fixes (not just Codex's own report).
- `node --check web/apg.js web/app.js web/lang/*.js web/sw.js`: clean.
- New tests: `src/__tests__/apg-ui-routes.test.ts` (13 route-smoke tests — off-mode default,
  absolute-master-off across a card override, mode precedence card>project>global once not off,
  enforced-downgrade reason requirement, sidecar-unavailable degrading to 200 not 500, idempotency
  replay vs genuine-conflict, limit/offset clamping + 400s, corrupted-scope-overrides-file
  resilience, unknown mode/scope_type rejection) + `src/__tests__/apg-ui-projection.test.ts`
  (9 tests, `deriveDisplayState` precedence rules + an exhaustive sweep over every input
  combination asserting the result is always one of the 8 valid states).
- Full repo suite re-run after every stage: **300 files, 4071 passed, 1 skipped (pre-existing),
  0 failed** — no regressions at any point.
- **Real browser render check (light/dark, desktop/tablet/mobile, keyboard/screen-reader) was NOT
  performed in this pass.** This repo's dashboard must never be live-booted in a sandboxed worktree
  — a known fleet-wide bug (`DASHBOARD_BINARY_PATTERN` matching by trailing path segment, no
  worktree scoping) can SIGTERM the live production instance regardless of port. This is exactly
  why sibling card `727965ce` exists as an explicit pre-go-live gate for BOTH the optimization
  dashboard and this card, to be run with `headless-viewport-verify`/`headless-chromium-no-root`
  once merged. Everything above is `tsc`/`node --check`/`vitest` evidence, which proves the code
  parses, typechecks, and its logic is covered — it cannot see a blank page or a CSS overflow.
- This worktree's install (`npm install`) was isolated; nothing was built/booted from the shared
  `~/marveen` checkout that serves the live `marveen-dashboard.service`.

## 5. Section 24 acceptance criteria — producer self-check

Spec 24 is conjunctive (ACCEPTED only if ALL hold). Self-assessment, for marveen's gate:

**Satisfied:**
no new APG main menu · no second Kanban · no second approval system · APG master off works
(tested) · project/card override works (tested, precedence + absolute-off) · done vs. accepted
shown distinctly · claim status + allowed_wording shown · pending owner decision not hidden
(untouched generic mechanism) · producer cannot self-accept (structural: `resolved_by` is always
the literal `'dashboard'`, never an agent id) · decision is idempotent (tested) · 409 handled
correctly (tested) · unknown never renders as success · observe-mode store outage fails open
(tested) · APG off causes no regression (300/4071 green + 5-surface DOM audit) · HU/EN complete
(programmatically verified) · no secret leak (spot-checked) · sidecar remains authority (read-only
throughout, zero write paths) · no destructive migration · local core diff is minimal (16 lines
across 3 shared files) · upstream updatability not meaningfully degraded · all tests added this
pass are green.

**Partial / known gaps, disclosed rather than silently cut:**
- **Per-surface UI toggles** (`APG_UI_KANBAN`/`APG_UI_ACTIVITY`/`APG_UI_EVIDENCE`/
  `APG_UI_APPROVAL_ENHANCEMENTS`) exist in the registry and are settable, but only
  `APG_UI_OVERVIEW` is actually read and enforced (`apg_ui_overview_enabled` on the summary
  response). The other four surfaces currently gate only on `mode !== 'off'`, not their own
  individual toggle. A documented simplification from the stage-3 build prompt, not caught later.
- **Enforcement toggles** (`APG_REQUIRE_CLAIM_RECEIPT`/`APG_REQUIRE_INDEPENDENT_ACCEPTANCE`/
  `APG_REQUIRE_OWNER_DECISION`/`APG_BLOCK_UNACCEPTED_ARCHIVE`) exist in the registry but are
  currently **inert** — no code path reads or enforces them yet. Per spec 1.5 the actual gate
  methodology belongs to the sidecar, not this UI layer, so this may be intentional scope, but it
  means "enforcement toggles work" is not literally true yet — there is nothing to toggle.
- **"Effective mode visible everywhere"**: shown on the Overview mode chip, the work-item detail
  overlay, and the card-detail panel; NOT shown on the Approvals decision cards.
- **Scope-override Settings UI** (spec 14.5's table + "add override" form): API-only
  (`PUT`/`DELETE /api/apg/scope-overrides` both work and are tested); no dedicated widget in the
  Settings page yet.
- **Mobile/dark-mode/keyboard/screen-reader verification**: not performed this pass (see
  Verification section above — deferred by design to sibling gate card `727965ce`).
- **Approvals↔APG linkage** is the documented convention `category === 'apg_decision'`; nothing in
  this pass creates an approval with that category, since spec section 7 covers APG *deciding* on
  an existing approval, not a distinct APG-decision-creation flow.
- **Activity block** surfaces `attention_items` reframed as "recent activity", not a genuine
  event/decision timeline — there is no dedicated events-feed endpoint yet.
- `apg-severity-warning` reuses `--accent` (no dedicated `--warning` CSS variable exists in this
  repo's `style.css`) — states remain text/label-distinguished (spec 5.1), just not a true amber hue.

## 6. Section 27 stop-conditions — none triggered

No second APG database (the scope-override/audit stores are Marveen's own UI config, explicitly
not domain truth). No destructive migration. No change to the APG canonical state model. No secret
in the UI. Frontend built on named `marveen:*` events, not DOM scraping. Self-approval guard not
weakened (structurally strengthened via the fixed `resolved_by:'dashboard'`). Off mode is a real
no-op (verified + 2 gaps found and fixed). No sidecar outage takes down the rest of the dashboard
(every read path degrades locally). No autonomous deploy introduced. Updatability: all new code
lives in new files; the touched upstream files carry small, easily-diffable insertions.

## 7. Rollback

Config-only: set `APG_MODE=off` (already the shipped default). The frontend module hides every
container it owns; no data is deleted; `store/apg-scope-overrides.json` / `store/apg-ui-audit.jsonl`
/ `store/apg-decision-idempotency.json` persist untouched and are additive-only. No core file
requires a code revert to fully disable — this is the same rollback story as the config layer
implies by construction (spec 25).

## 8. Final status

**Not self-declared.** Per the dispatching instructions (card `0f75d35d`), marveen holds the owner
acceptance gate against section 24 + stop-conditions section 27; this producer does not self-merge.
The gaps in section 5 are real and itemized above for that decision — none of them are section-27
stop conditions, and the core architecture (sidecar-as-authority, no second Kanban/approval system,
off-by-default, additive-only diff) is intact and tested.
